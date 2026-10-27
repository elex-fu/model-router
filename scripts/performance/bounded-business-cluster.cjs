#!/usr/bin/env node
'use strict';
// DIAGNOSTIC ONLY. Exactly one or two unchanged business entrypoints share one
// cluster RR listener. No automatic restart, production supervisor or claim
// that Node's internal socket-handoff backlog is a bounded receipt queue.
const cluster = require('node:cluster');
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_DATA = require('./bounded-business-profiles.json');
function totalBudgets(profile = 'c32') {
  if (!['c32', 'c200'].includes(profile)) throw new Error('BOUNDED_CLUSTER_INVALID_PROFILE');
  const httpInFlight = PROFILE_DATA.profiles[profile].httpInFlight;
  return Object.freeze({ ...PROFILE_DATA.fixedTotals, httpInFlight,
    automaticCreditTarget: 2 * PROFILE_DATA.maximum * httpInFlight });
}
// Preserve the original c32 API/default; opt-in c200 changes only HTTP and its
// automatically estimated credit target, never receipt/tenant/PG budgets.
const TOTALS = totalBudgets();

function processStartTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const value = Number(fields[19]); // /proc stat field22; fields starts at3.
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('BOUNDED_PROCESS_IDENTITY_UNAVAILABLE');
  return value;
}

function workerBudget(workers, profile = 'c32') {
  if (workers !== 1 && workers !== 2) throw new Error('BOUNDED_CLUSTER_WORKER_COUNT');
  return Object.fromEntries(Object.entries(totalBudgets(profile)).map(([key, value]) => [key, value / workers]));
}
function positive(raw, fallback, minimum, maximum) {
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('BOUNDED_CLUSTER_INVALID_DURATION');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('BOUNDED_CLUSTER_INVALID_DURATION');
  return value;
}
function configuration(env, argv, execArgv, primary) {
  const [entrypoint, ...args] = argv;
  const workers = Number(env.BOUNDED_CLUSTER_WORKERS);
  const profile = env.BOUNDED_CLUSTER_PROFILE ?? 'c32';
  const totals = totalBudgets(profile);
  const budgets = workerBudget(workers, profile);
  const directory = env.BOUNDED_CLUSTER_CHILD_DIRECTORY;
  const stateFile = env.BOUNDED_CLUSTER_STATE_FILE;
  const namespace = env.MODEL_ROUTER_FAST_NAMESPACE;
  if (env.BOUNDED_CLUSTER_DIAGNOSTIC !== '1' || !primary || env.NODE_OPTIONS || execArgv.length ||
      !['1', '2'].includes(env.BOUNDED_CLUSTER_WORKERS) ||
      !entrypoint || !path.isAbsolute(entrypoint) || !path.isAbsolute(directory ?? '') ||
      !path.isAbsolute(stateFile ?? '') || !path.isAbsolute(env.R9_TEST_DIST ?? '') ||
      !/^[a-zA-Z0-9_:-]{1,128}$/.test(namespace ?? '') ||
      env.MODEL_ROUTER_FAST_GATEWAY !== 'reserved-max' ||
      env.MODEL_ROUTER_FAST_RECEIPT_MODE !== 'memory-queue' ||
      env.MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS !== undefined ||
      env.MODEL_ROUTER_FAST_REDIS_DRAINED !== '1' ||
      !env.MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL ||
      (env.MODEL_ROUTER_FAST_REDIS_URL !== undefined &&
        env.MODEL_ROUTER_FAST_REDIS_URL !== env.MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL) ||
      env.MODEL_ROUTER_SAAS_WORKLOAD_ROLE !== 'gateway') {
    throw new Error('BOUNDED_CLUSTER_INVALID_DIAGNOSTIC_SETUP');
  }
  return { entrypoint, args, workers, profile, totals, budgets, namespace, directory, stateFile,
    shutdownMs: positive(env.BOUNDED_CLUSTER_SHUTDOWN_MS, 45000, 100, 60000),
    startupMs: positive(env.BOUNDED_CLUSTER_STARTUP_MS, 90000, 100, 180000) };
}
function childEnvironment(env, config, slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= config.workers) throw new Error('BOUNDED_CLUSTER_SLOT');
  const b = config.budgets;
  return { ...env, NODE_OPTIONS: '', BOUNDED_CLUSTER_SLOT: String(slot),
    BOUNDED_CLUSTER_PROFILE: config.profile,
    BOUNDED_CLUSTER_BOOTSTRAP_PROOF: path.join(config.directory, `worker-${slot}-bootstrap.json`),
    BOUNDED_CLUSTER_QUEUE_SNAPSHOT: path.join(config.directory, `worker-${slot}-queue.json`),
    MODEL_ROUTER_FAST_OWNER: `${config.namespace}-bounded-slot-${slot}`,
    MODEL_ROUTER_FAST_REDIS_DRAINED: slot === 0 ? '1' : '0',
    MODEL_ROUTER_SAAS_DB_POOL_MAX: String(b.databasePoolMax),
    MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: String(b.httpInFlight),
    MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES: String(b.receiptEntries),
    MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES: String(b.receiptBytes),
    MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT: String(b.receiptPerTenant),
    MODEL_ROUTER_FAST_RECEIPT_WORKERS: String(b.receiptWorkers),
    MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS: '5000',
    MODEL_ROUTER_FAST_RECEIPT_DRAIN_TIMEOUT_MS: '10000',
    MODEL_ROUTER_FAST_CREDIT_STRIPES: String(b.creditStripes),
  };
}
function verifyProof(proof, worker, config) {
  const expectedPools = config.workers === 1 ? [2, 14] : [2, 6];
  const b = config.budgets;
  const queue = { maxEntries: b.receiptEntries, maxBytes: b.receiptBytes, maxPerTenant: b.receiptPerTenant,
    workers: b.receiptWorkers, maxAgeMs: 5000, drainTimeoutMs: 10000 };
  return proof?.pid === worker.pid && proof.owner === worker.owner && proof.slot === worker.slot &&
    proof.profile === config.profile &&
    proof.readyStatus === 200 && proof.readinessListenerClosed === true &&
    proof.poolObserverRemoved === true && proof.inferenceHooksInstalled === false &&
    proof.nativePoolPrototypes === true &&
    proof.nativeFastPrototypes === true && proof.startupObserversRemoved === true &&
    JSON.stringify(proof.receiptQueues) === JSON.stringify([queue]) &&
    JSON.stringify(proof.executorLocalCaps) === JSON.stringify([b.httpInFlight]) &&
    JSON.stringify(proof.compositionHttpCaps) === JSON.stringify([b.httpInFlight]) &&
    JSON.stringify(proof.budgets) === JSON.stringify(config.budgets) &&
    Array.isArray(proof.pools) &&
    JSON.stringify(proof.pools.map(item => item.max).sort((a, b) => a - b)) === JSON.stringify(expectedPools);
}
function main() {
  const config = configuration(process.env, process.argv.slice(2), process.execArgv, cluster.isPrimary);
  fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  // Reusing a state path could mistake a prior run for this process's proof.
  if (fs.existsSync(config.stateFile) || [0, 1].some(slot =>
    fs.existsSync(path.join(config.directory, `worker-${slot}-bootstrap.json`))))
    throw new Error('BOUNDED_CLUSTER_REQUIRES_FRESH_OUTPUT');
  const state = { diagnosticOnly: true, topology: `cluster_rr_${config.workers}_business_workers`,
    primaryPid: process.pid, primaryStartTicks: processStartTicks(process.pid),
    primaryApplicationImports: false, businessWorkersStarted: 0,
    restartEnabled: false, profile: config.profile, totalBudgets: config.totals, perWorkerBudgets: config.budgets,
    pendingHandoffQueue: 'node_cluster_internal_not_production_bounded',
    phase: 'starting', workers: [], snapshotSequence: 0, events: [], eventDrops: 0 };
  const live = new Map();
  let stopping = false, failed = false, shutdownTimer;
  function record(kind, fields = {}) {
    state.phase = kind;
    if (state.events.length < 256) state.events.push({ kind, ...fields, monotonicNs: process.hrtime.bigint().toString() });
    else state.eventDrops++;
    const temporary = `${config.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, config.stateFile);
  }
  function safeRecord(kind, fields) {
    try { record(kind, fields); }
    catch { failed = true; process.stderr.write('BOUNDED_CLUSTER_STATE_WRITE_FAILED\n'); stop('SIGTERM'); }
  }
  function signalOne(item, signal) {
    if (item.row.exited) return;
    try { item.worker.process.kill(signal); } catch { failed = true; }
  }
  function finishIfExited() {
    if ([...live.values()].some(item => !item.row.exited)) return;
    clearTimeout(shutdownTimer);
    const usage = process.resourceUsage();
    state.allGraceful = !failed && stopping && state.workers.length === config.workers &&
      state.workers.every(row => row.ready && row.exitCode === 0 && row.signal === null && !row.forcedKill);
    state.primaryLifetimeUsage = { userCpuMicros: usage.userCPUTime, systemCpuMicros: usage.systemCPUTime,
      maxRssKiB: usage.maxRSS, voluntaryContextSwitches: usage.voluntaryContextSwitches,
      involuntaryContextSwitches: usage.involuntaryContextSwitches };
    safeRecord('exited');
    process.exitCode = state.allGraceful && !failed ? 0 : 1;
  }
  function stop(signal) {
    if (stopping) return;
    stopping = true;
    for (const item of live.values()) clearTimeout(item.startupTimer);
    safeRecord('stopping', { signal });
    // The original application's signal handler owns accepts, original handler
    // completion, receipts, journal retirement and dependency closure.
    for (const item of live.values()) signalOne(item, signal);
    shutdownTimer = setTimeout(() => {
      failed = true;
      for (const item of live.values()) if (!item.row.exited) {
        item.row.forcedKill = true; signalOne(item, 'SIGKILL');
      }
      safeRecord('shutdown_timeout');
    }, config.shutdownMs);
    finishIfExited();
  }
  function fork(slot) {
    if (stopping) return;
    const env = childEnvironment(process.env, config, slot);
    const worker = cluster.fork(env);
    let startTicks = null;
    try { startTicks = processStartTicks(worker.process.pid); } catch { failed = true; }
    const row = { slot, pid: worker.process.pid, startTicks,
      owner: env.MODEL_ROUTER_FAST_OWNER,
      ready: false, exited: false, exitCode: null, signal: null, forcedKill: false,
      bootstrapProofFile: env.BOUNDED_CLUSTER_BOOTSTRAP_PROOF,
      queueSnapshotFile: env.BOUNDED_CLUSTER_QUEUE_SNAPSHOT };
    state.workers.push(row); state.businessWorkersStarted++;
    const log = fs.createWriteStream(path.join(config.directory, `worker-${slot}.log`), { mode: 0o600 });
    log.on('error', () => { failed = true; safeRecord('worker_log_failed', { slot }); stop('SIGTERM'); });
    worker.process.stdout.pipe(log, { end: false }); worker.process.stderr.pipe(log, { end: false });
    worker.process.once('close', () => log.end());
    const item = { worker, row, startupTimer: setTimeout(() => {
      failed = true; safeRecord('worker_startup_timeout', { slot }); stop('SIGTERM');
    }, config.startupMs) };
    live.set(slot, item);
    safeRecord('forked', { slot });
    worker.on('message', message => {
      if (message?.type === 'bounded-business-observation-failed') {
        failed = true; safeRecord('worker_observation_failed', { slot }); stop('SIGTERM'); return;
      }
      if (message?.type !== 'bounded-business-ready' || row.ready || row.exited || stopping) return;
      try {
        if (message.pid !== row.pid || message.slot !== slot ||
            !verifyProof(JSON.parse(fs.readFileSync(row.bootstrapProofFile, 'utf8')), row, config))
          throw new Error('BOUNDED_CLUSTER_INVALID_WORKER_PROOF');
        row.ready = true; clearTimeout(item.startupTimer); safeRecord('worker_ready', { slot });
        // Fresh drained authority is initialized by slot0 before another slot
        // can conservatively initialize quarantine in the same Redis namespace.
        if (slot + 1 < config.workers) fork(slot + 1);
        else safeRecord('ready');
      } catch { failed = true; safeRecord('worker_proof_failed', { slot }); stop('SIGTERM'); }
    });
    worker.on('error', () => { failed = true; safeRecord('worker_error', { slot }); stop('SIGTERM'); });
    worker.on('exit', (code, signal) => {
      clearTimeout(item.startupTimer);
      row.exited = true; row.exitCode = code; row.signal = signal;
      if (!stopping || code !== 0 || signal !== null) failed = true;
      safeRecord('worker_exited', { slot });
      if (!stopping) stop('SIGTERM');
      finishIfExited();
    });
    if (startTicks === null) { safeRecord('worker_identity_failed', { slot }); stop('SIGTERM'); }
  }
  record('starting');
  cluster.schedulingPolicy = cluster.SCHED_RR;
  cluster.setupPrimary({ exec: config.entrypoint, args: config.args,
    execArgv: ['--require', path.join(__dirname, 'bounded-business-worker.cjs')], silent: true });
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGHUP', () => {
    if (stopping || state.phase !== 'ready') return;
    state.snapshotSequence++;
    safeRecord('ready', { snapshotRequested: state.snapshotSequence });
    for (const item of live.values()) if (item.row.ready && !item.row.exited) {
      item.worker.send({ type: 'bounded-business-snapshot', sequence: state.snapshotSequence }, error => {
        if (error) { failed = true; safeRecord('worker_observation_failed', { slot: item.row.slot }); stop('SIGTERM'); }
      });
    }
  });
  fork(0);
}

module.exports = { TOTALS, totalBudgets, workerBudget, configuration, childEnvironment, verifyProof, processStartTicks };
if (require.main === module) {
  try { main(); }
  catch { process.stderr.write('BOUNDED_CLUSTER_SETUP_FAILED\n'); process.exitCode = 1; }
}
