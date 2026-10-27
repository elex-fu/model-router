'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { TOTALS, totalBudgets, workerBudget, childEnvironment, configuration, verifyProof } = require('./bounded-business-cluster.cjs');
const launcher = path.join(__dirname, 'bounded-business-cluster.cjs');

async function until(read, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result) return result; await delay(15); }
  throw new Error(`timeout: ${label}`);
}
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function gone(pid) { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }
async function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/unchanged?x=1', agent: false }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.once('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
      res.once('error', reject);
    }); req.once('error', reject);
  });
}
async function portReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
function validEnv(directory, workers = 2) {
  return { ...process.env, NODE_OPTIONS: '', BOUNDED_CLUSTER_DIAGNOSTIC: '1', BOUNDED_CLUSTER_PROFILE: 'c32',
    BOUNDED_CLUSTER_WORKERS: String(workers), BOUNDED_CLUSTER_STATE_FILE: path.join(directory, 'state.json'),
    BOUNDED_CLUSTER_CHILD_DIRECTORY: path.join(directory, 'children'),
    BOUNDED_CLUSTER_STARTUP_MS: '2500', BOUNDED_CLUSTER_SHUTDOWN_MS: '1500',
    R9_TEST_DIST: path.join(directory, 'dist'), MODEL_ROUTER_FAST_NAMESPACE: 'bounded_fixture',
    MODEL_ROUTER_FAST_GATEWAY: 'reserved-max', MODEL_ROUTER_FAST_RECEIPT_MODE: 'memory-queue',
    MODEL_ROUTER_FAST_REDIS_DRAINED: '1', MODEL_ROUTER_SAAS_WORKLOAD_ROLE: 'gateway',
    MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: 'redis://127.0.0.1:16379/1', BOUNDED_TEST_DIRECTORY: directory,
  };
}
async function setup(t, workers = 2, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-business-test-'));
  fs.mkdirSync(path.join(directory, 'dist/server'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'dist/saas/gateway/fast'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'node_modules/pg'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  fs.writeFileSync(path.join(directory, 'node_modules/pg/index.js'), `
class Pool { constructor(options) { this.options={...options}; } }
module.exports={Pool};
`);
  fs.writeFileSync(path.join(directory, 'dist/saas/gateway/fast/receipt-queue.js'), `
class FastReceiptQueue { constructor(options) { this.options=options; } snapshot(){return {pending:0,bytes:0};} }
module.exports={FastReceiptQueue};
`);
  fs.writeFileSync(path.join(directory, 'dist/saas/gateway/fast/executor.js'), `
class FastGatewayExecutor { constructor(options) { this.options=options; } }
module.exports={FastGatewayExecutor};
`);
  fs.writeFileSync(path.join(directory, 'dist/server/managed-saas-gateway.js'), `
exports.createManagedSaasGatewayProductionComposition=function(_database,options){
 const env=process.env;
 new (require('../saas/gateway/fast/receipt-queue.js').FastReceiptQueue)({
   maxEntries:Number(env.MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES)+(env.BOUNDED_TEST_BAD_QUEUE==='1'?1:0),
   maxBytes:Number(env.MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES),maxPerTenant:Number(env.MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT),
   workers:Number(env.MODEL_ROUTER_FAST_RECEIPT_WORKERS),maxAgeMs:Number(env.MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS),
   drainTimeoutMs:Number(env.MODEL_ROUTER_FAST_RECEIPT_DRAIN_TIMEOUT_MS)});
 new (require('../saas/gateway/fast/executor.js').FastGatewayExecutor)({maxLocalConcurrency:options.maxHttpInFlight});
};
`);
  fs.writeFileSync(path.join(directory, 'dist/server/managed-saas.js'), `
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const pg=require('pg');
exports.startManagedSaasServer=async function(_deployment,options={}) {
 const env=process.env,d=env.BOUNDED_TEST_DIRECTORY,slot=Number(env.BOUNDED_CLUSTER_SLOT);
 const started=Date.now(),total=Number(env.MODEL_ROUTER_SAAS_DB_POOL_MAX);
 new pg.Pool({max:env.BOUNDED_TEST_BAD_POOL==='1'?total:total-2}); new pg.Pool({max:2});
 require('./managed-saas-gateway.js').createManagedSaasGatewayProductionComposition({},
   {maxHttpInFlight:Number(env.MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT)});
 const server=http.createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,url:req.url,
   args:process.argv.slice(2),owner:env.MODEL_ROUTER_FAST_OWNER})));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 fs.writeFileSync(path.join(d,'listen-'+slot+'.json'),JSON.stringify({pid:process.pid,port:server.address().port}));
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
   fs.writeFileSync(path.join(d,'signal-'+slot),signal);
   if(env.BOUNDED_TEST_IGNORE_STOP==='1')return;
   setTimeout(()=>server.close(),50);
   setTimeout(()=>fs.writeFileSync(path.join(d,'drained-'+slot),'done'),175);
 });
 const runtime={gateway:{handler(req,res){
   const ready=env.BOUNDED_TEST_NEVER_READY_SLOT!==String(slot)&&!(env.BOUNDED_TEST_SLOW_SLOT===String(slot)&&Date.now()-started<400);
   res.writeHead(ready?200:503);res.end(JSON.stringify({database:'ok',dependencies:{'fast-data-plane':ready?'ok':'error'}}));
   return Promise.resolve(true);
 }}};
 try { await options.onReady?.(runtime); }
 catch(error) { await new Promise(resolve=>server.close(resolve)); throw error; }
 fs.writeFileSync(path.join(d,'observer-removed-'+slot),String(pg.Pool.name==='Pool'));
 return runtime;
};
`);
  const entrypoint = path.join(directory, 'fixture.cjs');
  fs.writeFileSync(entrypoint, `
const fs=require('node:fs'),path=require('node:path');
const env=process.env;fs.appendFileSync(path.join(env.BOUNDED_TEST_DIRECTORY,'starts'),process.pid+'\\n');
if(env.BOUNDED_TEST_FAIL_SLOT===env.BOUNDED_CLUSTER_SLOT)process.exit(23);
if(env.BOUNDED_TEST_STARTUP_WAIT==='1'){setInterval(()=>{},1000);return;}
// Match the unchanged production CLI's dynamic-import boundary, not only require().
import('./dist/server/managed-saas.js').then(module=>module.startManagedSaasServer({},{}))
 .catch(()=>{process.exitCode=1;process.channel?.unref();});
`);
  const env = { ...validEnv(directory, workers), ...overrides };
  delete env.MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS;
  if (env.BOUNDED_TEST_LOG_FAILURE === '1')
    fs.mkdirSync(path.join(directory, 'children/worker-0.log'), { recursive: true });
  const child = spawn(process.execPath, [launcher, entrypoint, 'start', '--role', 'gateway'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { output += value; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(2500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const state = json(env.BOUNDED_CLUSTER_STATE_FILE);
    for (const row of state?.workers ?? []) if (!gone(row.pid)) {
      process.kill(row.pid, 'SIGKILL'); await until(() => gone(row.pid), 'cleanup child');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, child, exited, env, output: () => output,
    state: () => json(env.BOUNDED_CLUSTER_STATE_FILE),
    ready: () => until(() => { const state = json(env.BOUNDED_CLUSTER_STATE_FILE); return state?.phase === 'ready' && state; }, 'all business workers ready') };
}

test('budget arithmetic preserves exact totals, stripes, phases and owner separation', () => {
  assert.deepEqual(totalBudgets(), totalBudgets('c32'));
  for (const profile of ['c32', 'c200']) for (const count of [1, 2]) {
    const cap = profile === 'c200' ? 256 : 64;
    const totals = totalBudgets(profile);
    assert.deepEqual(totals, { ...TOTALS, httpInFlight: cap, automaticCreditTarget: 2 * 524480 * cap });
    const budget = workerBudget(count, profile);
    for (const [key, total] of Object.entries(totals)) assert.equal(budget[key] * count, total);
    const env = { ...validEnv('/tmp/bounded-pure', count), BOUNDED_CLUSTER_PROFILE: profile };
    const config = configuration(env, ['/absolute/entry.js', 'start'], [], true);
    const children = Array.from({ length: count }, (_, slot) => childEnvironment(env, config, slot));
    assert.equal(new Set(children.map(child => child.MODEL_ROUTER_FAST_OWNER)).size, count);
    for (const child of children) {
      assert.equal(child.MODEL_ROUTER_FAST_NAMESPACE, env.MODEL_ROUTER_FAST_NAMESPACE);
      assert.equal(child.MODEL_ROUTER_SAAS_DB_POOL_MAX, String(16 / count));
      assert.equal(child.MODEL_ROUTER_FAST_CREDIT_STRIPES, String(8 / count));
      assert.equal(child.MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT, String(cap / count));
      assert.equal(child.MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT, String(64 / count));
      assert.equal(child.MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES, String(256 / count));
      assert.equal(child.MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES, String(2097152 / count));
      assert.equal(child.MODEL_ROUTER_FAST_RECEIPT_WORKERS, String(8 / count));
      assert.equal(child.BOUNDED_CLUSTER_PROFILE, profile);
      assert.equal(child.MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS, undefined);
    }
    assert.equal(config.profile, profile);
    assert.deepEqual(config.totals, totals);
    assert.equal(children[0].MODEL_ROUTER_FAST_REDIS_DRAINED, '1');
    if (count === 2) assert.equal(children[1].MODEL_ROUTER_FAST_REDIS_DRAINED, '0');
  }
  for (const count of [0, 3, 1.5, NaN]) assert.throws(() => workerBudget(count));
  for (const profile of ['', 'C200', 'c128', '__proto__', 200, null, {}]) {
    assert.throws(() => totalBudgets(profile), /INVALID_PROFILE/);
    assert.throws(() => workerBudget(2, profile), /INVALID_PROFILE/);
  }
});
test('serial profiles keep c32 totals, actual startup budgets and one business process', () => {
  for (const profile of ['serial-json', 'serial-sse']) {
    assert.deepEqual(totalBudgets(profile), totalBudgets('c32'));
    assert.deepEqual(workerBudget(1, profile), totalBudgets('c32'));
    assert.throws(() => workerBudget(2, profile), /SERIAL_REQUIRES_ONE_WORKER/);
    const env = { ...validEnv('/tmp/bounded-serial-pure', 1), BOUNDED_CLUSTER_PROFILE: profile };
    const config = configuration(env, ['/absolute/entry.js'], [], true);
    const child = childEnvironment(env, config, 0);
    assert.equal(child.BOUNDED_CLUSTER_PROFILE, profile);
    assert.equal(child.MODEL_ROUTER_SAAS_DB_POOL_MAX, '16');
    assert.equal(child.MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT, '64');
    assert.equal(child.MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT, '64');
    assert.equal(child.MODEL_ROUTER_FAST_RECEIPT_WORKERS, '8');
    assert.equal(child.MODEL_ROUTER_FAST_CREDIT_STRIPES, '8');
    assert.throws(() => configuration({ ...env, BOUNDED_CLUSTER_WORKERS: '2' }, ['/absolute/entry.js'], [], true), /SERIAL_REQUIRES_ONE_WORKER/);
  }
});
test('fail closed on implicit mode, explicit money, foreign preload and invalid setup', () => {
  const env = validEnv('/tmp/bounded-pure');
  for (const change of [{ BOUNDED_CLUSTER_DIAGNOSTIC: '' }, { BOUNDED_CLUSTER_WORKERS: '3' },
    { MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS: '33566720' }, { NODE_OPTIONS: '--require other' },
    { MODEL_ROUTER_FAST_REDIS_DRAINED: '0' }, { BOUNDED_CLUSTER_STATE_FILE: 'relative' },
    { MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL: '' }, { BOUNDED_CLUSTER_SHUTDOWN_MS: 'NaN' },
    { BOUNDED_CLUSTER_PROFILE: 'c128' }, { BOUNDED_CLUSTER_PROFILE: '' }])
    assert.throws(() => configuration({ ...env, ...change }, ['/absolute/entry.js'], [], true));
  assert.throws(() => configuration(env, ['/absolute/entry.js'], ['--inspect'], true));
  assert.throws(() => configuration(env, ['/absolute/entry.js'], [], false));
});
test('readiness proof rejects wrong PID, owner, pool budget and incomplete private drain', () => {
  const config = { workers: 2, profile: 'c32', budgets: workerBudget(2) };
  const row = { slot: 1, pid: 123, owner: 'fixture-slot-1' };
  const proof = { ...row, profile: config.profile, budgets: config.budgets, pools: [{ max: 6 }, { max: 2 }],
    readyStatus: 200, readinessListenerClosed: true, poolObserverRemoved: true,
    nativePoolPrototypes: true, inferenceHooksInstalled: false, nativeFastPrototypes: true,
    startupObserversRemoved: true, compositionHttpCaps: [32], executorLocalCaps: [32],
    receiptQueues: [{maxEntries:128,maxBytes:1048576,maxPerTenant:32,workers:4,maxAgeMs:5000,drainTimeoutMs:10000}] };
  assert.equal(verifyProof(proof, row, config), true);
  for (const change of [{ pid: 124 }, { owner: 'sibling' }, { readyStatus: 503 },
    { pools: [{ max: 8 }, { max: 2 }] }, { readinessListenerClosed: false },
    { nativePoolPrototypes: false }, { poolObserverRemoved: false }, { inferenceHooksInstalled: true },
    { startupObserversRemoved: false }, { nativeFastPrototypes: false }, { compositionHttpCaps: [64] },
    { executorLocalCaps: [64] }, { receiptQueues: [] }, { profile: 'c200' }, { profile: undefined }])
    assert.equal(verifyProof({ ...proof, ...change }, row, config), false);
});
test('c200 config proof scales actual local HTTP only, not tenant receipt or PG limits', () => {
  for (const workers of [1, 2]) {
    const config = { workers, profile: 'c200', budgets: workerBudget(workers, 'c200') };
    const row = { slot: 0, pid: 123, owner: 'fixture-slot-0' };
    const b = config.budgets;
    const proof = { ...row, profile: config.profile, budgets: b, pools: [{max:16/workers-2},{max:2}],
      readyStatus: 200, readinessListenerClosed: true, poolObserverRemoved: true,
      nativePoolPrototypes: true, inferenceHooksInstalled: false, nativeFastPrototypes: true,
      startupObserversRemoved: true, compositionHttpCaps: [256/workers], executorLocalCaps: [256/workers],
      receiptQueues: [{maxEntries:256/workers,maxBytes:2097152/workers,maxPerTenant:64/workers,
        workers:8/workers,maxAgeMs:5000,drainTimeoutMs:10000}] };
    assert.equal(verifyProof(proof, row, config), true);
    for (const change of [{profile:'c32'}, {executorLocalCaps:[64/workers]},
      {compositionHttpCaps:[64/workers]}, {budgets:workerBudget(workers)},
      {receiptQueues:[{...proof.receiptQueues[0],maxPerTenant:256/workers}]},
      {pools:[{max:16},{max:2}]}]) assert.equal(verifyProof({...proof,...change},row,config),false);
  }
});
test('capacity probe is explicit c200/two only and cannot forge an ordinary startup proof', () => {
  const env = { ...validEnv('/tmp/capacity-config'), BOUNDED_CLUSTER_PROFILE: 'c200',
    BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC: '1' };
  const config = configuration(env, ['/absolute/entry.js'], [], true);
  assert.equal(config.capacityDiagnostic, true);
  assert.equal(config.budgets.httpInFlight, 128);
  assert.equal(config.totals.httpInFlight, 256);
  for (const change of [{ BOUNDED_CLUSTER_PROFILE: 'c32' }, { BOUNDED_CLUSTER_WORKERS: '1' },
    { BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC: '0' }])
    assert.throws(() => configuration({ ...env, ...change }, ['/absolute/entry.js'], [], true));
  const row = { slot: 0, pid: 123, owner: 'fixture-slot-0' };
  const proof = { ...row, profile: 'c200', budgets: config.budgets, pools: [{ max: 6 }, { max: 2 }],
    readyStatus: 200, readinessListenerClosed: true, poolObserverRemoved: true,
    nativePoolPrototypes: true, inferenceHooksInstalled: true, nativeFastPrototypes: true,
    startupObserversRemoved: true, compositionHttpCaps: [128], executorLocalCaps: [128],
    receiptQueues: [{maxEntries:128,maxBytes:1048576,maxPerTenant:32,workers:4,maxAgeMs:5000,drainTimeoutMs:10000}],
    capacityDiagnostic: { enabled: true, compiledSha256: require('./bounded-business-capacity-probe.cjs').COMPILED_SHA256 } };
  assert.equal(verifyProof(proof, row, config), true);
  assert.equal(verifyProof(proof, row, { ...config, capacityDiagnostic: false }), false);
  assert.equal(verifyProof({ ...proof, inferenceHooksInstalled: false }, row, config), false);
  assert.equal(verifyProof({ ...proof, capacityDiagnostic: { enabled: true, compiledSha256: 'wrong' } }, row, config), false);
});
for (const profile of ['c32', 'c200']) for (const workers of [1, 2])
  test(`${profile}: ${workers} business fixture processes, per-PID health and natural resource-owner drain`, async t => {
  const run = await setup(t, workers, { BOUNDED_CLUSTER_PROFILE: profile, BOUNDED_TEST_SLOW_SLOT: String(workers - 1) });
  const state = await run.ready();
  assert.equal(state.primaryPid, run.child.pid); assert.equal(state.primaryApplicationImports, false);
  assert.equal(state.profile, profile); assert.deepEqual(state.totalBudgets, totalBudgets(profile));
  assert.equal(state.businessWorkersStarted, workers); assert.equal(state.restartEnabled, false);
  assert.equal(state.workers.every(row => row.ready), true);
  assert.equal(new Set(state.workers.map(row => row.owner)).size, workers);
  const listener = json(path.join(run.directory, 'listen-0.json'));
  const observed = new Set();
  for (let i = 0; i < workers * 6; i++) {
    const response = await request(listener.port); observed.add(response.pid);
    assert.equal(response.url, '/unchanged?x=1');
    assert.deepEqual(response.args, ['start', '--role', 'gateway']);
  }
  assert.deepEqual([...observed].sort(), state.workers.map(row => row.pid).sort());
  for (const row of state.workers) {
    const proof = json(row.bootstrapProofFile);
    const budget = workerBudget(workers, profile);
    assert.equal(proof.profile, profile); assert.deepEqual(proof.budgets, budget);
    assert.deepEqual(proof.executorLocalCaps, [budget.httpInFlight]);
    assert.deepEqual(proof.compositionHttpCaps, [budget.httpInFlight]);
    assert.deepEqual(proof.receiptQueues, [{maxEntries:budget.receiptEntries,maxBytes:budget.receiptBytes,
      maxPerTenant:budget.receiptPerTenant,workers:budget.receiptWorkers,maxAgeMs:5000,drainTimeoutMs:10000}]);
    assert.equal(proof.readinessListenerClosed, true); assert.equal(proof.poolObserverRemoved, true);
    assert.equal(proof.nativePoolPrototypes, true);
    assert.equal(proof.startupObserversRemoved, true); assert.equal(proof.nativeFastPrototypes, true);
    assert.equal(proof.inferenceHooksInstalled, false);
    assert.deepEqual(proof.pools.map(pool => pool.max).sort((a, b) => a - b), workers === 1 ? [2, 14] : [2, 6]);
    await until(() => fs.existsSync(path.join(run.directory, `observer-removed-${row.slot}`)), 'entrypoint after ready');
    assert.equal(fs.readFileSync(path.join(run.directory, `observer-removed-${row.slot}`), 'utf8'), 'true');
  }
  run.child.kill('SIGHUP');
  for (const row of state.workers) {
    const snapshot = await until(() => json(row.queueSnapshotFile), 'one-shot native queue snapshot');
    assert.equal(snapshot.pid, row.pid); assert.equal(snapshot.slot, row.slot); assert.equal(snapshot.sequence, 1);
    assert.deepEqual(snapshot.snapshot, {pending:0,bytes:0});
  }
  run.child.kill('SIGTERM'); assert.deepEqual(await run.exited, { code: 0, signal: null });
  const stopped = run.state(); assert.equal(stopped.phase, 'exited'); assert.equal(stopped.allGraceful, true);
  for (const row of stopped.workers) {
    assert.equal(row.exitCode, 0); assert.equal(row.signal, null); assert.equal(row.forcedKill, false);
    assert.equal(fs.readFileSync(path.join(run.directory, `drained-${row.slot}`), 'utf8'), 'done');
    assert.ok(gone(row.pid));
  }
  await portReleased(listener.port);
});
test('second child startup failure stops first child, fails run and never respawns', async t => {
  const run = await setup(t, 2, { BOUNDED_TEST_FAIL_SLOT: '1' });
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  const state = run.state(); assert.equal(state.businessWorkersStarted, 2); assert.equal(state.allGraceful, false);
  assert.equal(state.workers[1].exitCode, 23); assert.equal(state.workers[0].exitCode, 0);
  assert.equal(fs.readFileSync(path.join(run.directory, 'starts'), 'utf8').trim().split('\n').length, 2);
  assert.ok(state.workers.every(row => gone(row.pid)));
});
test('live child crash terminates sibling with no respawn and cannot be graceful', async t => {
  const run = await setup(t); const state = await run.ready();
  process.kill(state.workers[1].pid, 'SIGKILL');
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  const stopped = run.state(); assert.equal(stopped.workers[1].signal, 'SIGKILL');
  assert.equal(stopped.workers[0].exitCode, 0); assert.equal(stopped.businessWorkersStarted, 2);
  assert.equal(stopped.allGraceful, false); assert.ok(stopped.workers.every(row => gone(row.pid)));
});
test('actual PG pool maximum mismatch fails startup rather than trusting environment declaration', async t => {
  const run = await setup(t, 1, { BOUNDED_TEST_BAD_POOL: '1' });
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  assert.equal(run.state().workers[0].ready, false); assert.equal(run.state().allGraceful, false);
});
test('actual queue constructor mismatch fails startup rather than trusting child environment', async t => {
  const run = await setup(t, 1, { BOUNDED_TEST_BAD_QUEUE: '1' });
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  assert.equal(run.state().workers[0].ready, false); assert.equal(run.state().allGraceful, false);
});
test('shutdown timeout explicitly fails and kills all ignored children', async t => {
  const run = await setup(t, 2, { BOUNDED_TEST_IGNORE_STOP: '1', BOUNDED_CLUSTER_SHUTDOWN_MS: '150' });
  await run.ready(); run.child.kill('SIGTERM');
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  const state = run.state(); assert.equal(state.allGraceful, false);
  assert.ok(state.workers.every(row => row.forcedKill && row.signal === 'SIGKILL' && gone(row.pid)));
});
test('early stop is a visible failed startup, never an imaginary application drain', async t => {
  const run = await setup(t, 1, { BOUNDED_TEST_STARTUP_WAIT: '1' });
  await until(() => fs.existsSync(path.join(run.directory, 'starts')), 'worker entrypoint');
  run.child.kill('SIGINT'); assert.deepEqual(await run.exited, { code: 1, signal: null });
  assert.equal(run.state().workers[0].signal, 'SIGINT'); assert.equal(run.state().allGraceful, false);
});
test('primary crash does not leave the business children running', async t => {
  const run = await setup(t); const state = await run.ready(); run.child.kill('SIGKILL');
  assert.deepEqual(await run.exited, { code: null, signal: 'SIGKILL' });
  await until(() => state.workers.every(row => gone(row.pid)), 'orphan child exit');
});
test('only one healthy child cannot satisfy two-child readiness', async t => {
  const run = await setup(t, 2, { BOUNDED_TEST_NEVER_READY_SLOT: '1', BOUNDED_CLUSTER_STARTUP_MS: '350' });
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  const state = run.state();
  assert.equal(state.workers[0].ready, true); assert.equal(state.workers[1].ready, false);
  assert.equal(state.events.some(event => event.kind === 'ready'), false);
  assert.equal(state.allGraceful, false); assert.ok(state.workers.every(row => gone(row.pid)));
});
test('asynchronous child log write failure stops owned child instead of orphaning it', async t => {
  const run = await setup(t, 1, { BOUNDED_TEST_LOG_FAILURE: '1' });
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  const state = run.state();
  assert.equal(state.events.some(event => event.kind === 'worker_log_failed'), true);
  assert.equal(state.allGraceful, false); assert.ok(state.workers.every(row => gone(row.pid)));
});
test('state publication failure during stop is nonzero and still drains both children', async t => {
  const run = await setup(t); const state = await run.ready();
  fs.unlinkSync(run.env.BOUNDED_CLUSTER_STATE_FILE); fs.mkdirSync(run.env.BOUNDED_CLUSTER_STATE_FILE);
  run.child.kill('SIGTERM'); assert.deepEqual(await run.exited, { code: 1, signal: null });
  assert.match(run.output(), /BOUNDED_CLUSTER_STATE_WRITE_FAILED/);
  assert.ok(state.workers.every(row => gone(row.pid)));
});
