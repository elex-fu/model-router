'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const launcher = path.join(__dirname, 'c200-single-worker-acceptor.cjs');
const root = path.resolve(__dirname, '../..');

async function until(read, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`test timeout: ${description}`);
}
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
async function portReleased(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => server.close(resolve));
}
async function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/unchanged?x=1', agent: false }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(JSON.parse(data))); res.on('error', reject);
    }); req.on('error', reject);
  });
}
async function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(root, '.c200-acceptor-test-'));
  const fixture = path.join(directory, 'fixture.cjs'), stateFile = path.join(directory, 'state.json');
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, `require('node:fs').appendFileSync(process.env.C200_TEST_PRELOAD, process.pid+'\\n');`);
  fs.writeFileSync(fixture, `
const fs=require('node:fs'),http=require('node:http');
fs.appendFileSync(process.env.C200_TEST_STARTS,process.pid+'\\n');
if(process.env.C200_TEST_MODE==='startup_failure')process.exit(23);
if(process.env.C200_TEST_MODE==='startup_wait'){setInterval(()=>{},1000);return;}
const server=http.createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,url:req.url,remote:req.socket.remoteAddress,args:process.argv.slice(2)})));
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.env.C200_TEST_READY,JSON.stringify({pid:process.pid,port:server.address().port})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{
 fs.writeFileSync(process.env.C200_TEST_SIGNAL,signal);
 if(process.env.C200_TEST_MODE==='ignore_stop')return;
 setTimeout(()=>server.close(),100);
 // Match the actual gateway: no process.exit(0), and asynchronous resource
 // drain may outlive listener.close(). The IPC shim must not skip this work.
 setTimeout(()=>fs.writeFileSync(process.env.C200_TEST_DRAINED,'drained'),175);
});
`);
  const env = { ...process.env, NODE_OPTIONS: '', C200_CLUSTER_DIAGNOSTIC: '1',
    C200_CLUSTER_STATE_FILE: stateFile, C200_CLUSTER_SHUTDOWN_MS: '1500',
    C200_CLUSTER_WORKER_NODE_OPTIONS: `--require=${preload}`,
    C200_TEST_READY: path.join(directory, 'ready.json'), C200_TEST_STARTS: path.join(directory, 'starts'),
    C200_TEST_SIGNAL: path.join(directory, 'signal'), C200_TEST_DRAINED: path.join(directory, 'drained'),
    C200_TEST_PRELOAD: path.join(directory, 'preloads'), ...overrides };
  const child = spawn(process.execPath, [launcher, fixture, 'original', '--argument'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(2500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const state = json(stateFile);
    if (state?.workerPid && !gone(state.workerPid)) {
      process.kill(state.workerPid, 'SIGKILL');
      await until(() => gone(state.workerPid), 'cleanup worker');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { child, exited, directory, stateFile, env, output: () => output };
}

test('one original worker, observer only in worker, native socket and graceful SIGTERM', async t => {
  const run = await setup(t);
  const ready = await until(() => json(run.env.C200_TEST_READY), 'ready');
  const reply = await request(ready.port);
  assert.equal(reply.pid, ready.pid); assert.equal(reply.remote, '127.0.0.1');
  assert.equal(reply.url, '/unchanged?x=1'); assert.deepEqual(reply.args, ['original', '--argument']);
  assert.equal(fs.readFileSync(run.env.C200_TEST_STARTS, 'utf8'), `${ready.pid}\n`);
  assert.equal(fs.readFileSync(run.env.C200_TEST_PRELOAD, 'utf8'), `${ready.pid}\n`);
  assert.notEqual(ready.pid, run.child.pid);
  run.child.kill('SIGTERM');
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  const state = json(run.stateFile);
  assert.equal(state.businessWorkersStarted, 1); assert.equal(state.restartEnabled, false);
  assert.equal(state.workerPid, ready.pid); assert.equal(state.primaryPid, run.child.pid);
  assert.equal(state.phase, 'exited'); assert.equal(state.eventDrops, 0);
  assert.equal(fs.readFileSync(run.env.C200_TEST_SIGNAL, 'utf8'), 'SIGTERM');
  assert.equal(fs.readFileSync(run.env.C200_TEST_DRAINED, 'utf8'), 'drained');
  assert.equal(state.events.some(e => e.kind === 'shutdown_timeout'), false);
  assert.ok(gone(ready.pid)); await portReleased(ready.port);
});

test('SIGINT reaches original shutdown handler and releases listener', async t => {
  const run = await setup(t); const ready = await until(() => json(run.env.C200_TEST_READY), 'ready');
  run.child.kill('SIGINT'); assert.equal((await run.exited).code, 0);
  assert.equal(fs.readFileSync(run.env.C200_TEST_SIGNAL, 'utf8'), 'SIGINT');
  assert.equal(fs.readFileSync(run.env.C200_TEST_DRAINED, 'utf8'), 'drained');
  assert.ok(gone(ready.pid)); await portReleased(ready.port);
});

test('worker startup failure remains failure and never respawns', async t => {
  const run = await setup(t, { C200_TEST_MODE: 'startup_failure' });
  assert.equal((await run.exited).code, 23);
  assert.equal(fs.readFileSync(run.env.C200_TEST_STARTS, 'utf8').trim().split('\n').length, 1);
  assert.equal(json(run.stateFile).businessWorkersStarted, 1);
});

test('signal before application handlers preserves abrupt startup failure', async t => {
  const run = await setup(t, { C200_TEST_MODE: 'startup_wait' });
  await until(() => fs.existsSync(run.env.C200_TEST_STARTS), 'entrypoint started');
  run.child.kill('SIGTERM'); assert.equal((await run.exited).code, 143);
  const state = json(run.stateFile);
  assert.equal(state.events.at(-1).workerSignal, 'SIGTERM');
  assert.equal(state.events.some(e => e.kind === 'shutdown_timeout'), false);
  assert.equal(fs.existsSync(run.env.C200_TEST_READY), false);
  assert.ok(gone(state.workerPid));
});

test('worker crash closes primary listener without respawn', async t => {
  const run = await setup(t); const ready = await until(() => json(run.env.C200_TEST_READY), 'ready');
  process.kill(ready.pid, 'SIGKILL'); assert.equal((await run.exited).code, 137);
  assert.equal(json(run.stateFile).businessWorkersStarted, 1);
  assert.ok(gone(ready.pid)); await portReleased(ready.port);
});

test('primary crash disconnects and terminates its only worker', async t => {
  const run = await setup(t); const ready = await until(() => json(run.env.C200_TEST_READY), 'ready');
  run.child.kill('SIGKILL'); assert.equal((await run.exited).signal, 'SIGKILL');
  await until(() => gone(ready.pid), 'orphan worker exit'); await portReleased(ready.port);
});

test('bounded shutdown timeout is visible failure and cleans up worker', async t => {
  const run = await setup(t, { C200_TEST_MODE: 'ignore_stop', C200_CLUSTER_SHUTDOWN_MS: '150' });
  const ready = await until(() => json(run.env.C200_TEST_READY), 'ready');
  run.child.kill('SIGTERM'); assert.equal((await run.exited).code, 1);
  assert.ok(json(run.stateFile).events.some(e => e.kind === 'shutdown_timeout'));
  assert.ok(gone(ready.pid)); await portReleased(ready.port);
});

test('missing diagnostic opt-in cannot start a business worker', async t => {
  const run = await setup(t, { C200_CLUSTER_DIAGNOSTIC: '' });
  assert.equal((await run.exited).code, 1);
  assert.equal(fs.existsSync(run.env.C200_TEST_STARTS), false);
  assert.match(run.output(), /C200_ACCEPTOR_INVALID_DIAGNOSTIC_SETUP/);
});
