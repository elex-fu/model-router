'use strict';
// Startup/lifecycle qualification only. No inference/SQL/driver promise is
// wrapped during measurement. This is NOT a production clustering entrypoint.
const cluster = require('node:cluster');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { workerBudget } = require('./bounded-business-cluster.cjs');

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function healthRequest(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/readyz', agent: false }, res => {
      let bytes = 0, body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 65536) { req.destroy(new Error('BOUNDED_READINESS_BODY_BOUND')); return; }
        body += chunk;
      });
      res.once('error', reject);
      res.once('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { reject(new Error('BOUNDED_READINESS_RESPONSE')); }
      });
    });
    req.setTimeout(1000, () => req.destroy(new Error('BOUNDED_READINESS_TIMEOUT')));
    req.once('error', reject);
  });
}
async function ownReadiness(gateway, startupMs) {
  if (typeof gateway?.handler !== 'function') throw new Error('BOUNDED_GATEWAY_HANDLER_REQUIRED');
  const server = http.createServer((req, res) => {
    // This private diagnostic listener cannot dispatch inference or expose the
    // rest of the application. The unchanged PUBLIC listener owns benchmark IO.
    if (req.method !== 'GET' || req.url !== '/readyz') { res.writeHead(404); res.end(); return; }
    try {
      Promise.resolve(gateway.handler(req, res)).catch(() => res.destroy());
    } catch { res.destroy(); }
  });
  let listening = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
    });
    listening = true;
    const port = server.address().port;
    const deadline = Date.now() + startupMs;
    while (Date.now() < deadline) {
      try {
        const result = await healthRequest(port);
        if (result.status === 200 && result.body.database === 'ok' &&
            result.body.dependencies?.['fast-data-plane'] === 'ok') return result.status;
      } catch { /* Startup failures remain unready; never manufacture health. */ }
      await delay(100);
    }
    throw new Error('BOUNDED_WORKER_READINESS_TIMEOUT');
  } finally {
    if (listening) {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}
function install() {
  const env = process.env;
  const slot = Number(env.BOUNDED_CLUSTER_SLOT);
  const workers = Number(env.BOUNDED_CLUSTER_WORKERS);
  const profile = env.BOUNDED_CLUSTER_PROFILE ?? 'c32';
  const budgets = workerBudget(workers, profile);
  const proofFile = env.BOUNDED_CLUSTER_BOOTSTRAP_PROOF;
  const snapshotFile = env.BOUNDED_CLUSTER_QUEUE_SNAPSHOT;
  const dist = env.R9_TEST_DIST;
  const startupMs = Number(env.BOUNDED_CLUSTER_STARTUP_MS ?? 90000);
  if (env.BOUNDED_CLUSTER_DIAGNOSTIC !== '1' || !cluster.isWorker ||
      typeof process.channel?.unref !== 'function' || !Number.isInteger(slot) || slot < 0 || slot >= workers ||
      !path.isAbsolute(proofFile ?? '') || !path.isAbsolute(snapshotFile ?? '') || !path.isAbsolute(dist ?? '') ||
      !Number.isSafeInteger(startupMs) || startupMs < 100 || startupMs > 180000 ||
      env.MODEL_ROUTER_FAST_OWNER !== `${env.MODEL_ROUTER_FAST_NAMESPACE}-bounded-slot-${slot}` ||
      env.MODEL_ROUTER_FAST_CREDIT_TRANCHE_MINOR_UNITS !== undefined) {
    throw new Error('BOUNDED_WORKER_INVALID_SETUP');
  }
  const expected = {
    MODEL_ROUTER_SAAS_DB_POOL_MAX: budgets.databasePoolMax,
    MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT: budgets.httpInFlight,
    MODEL_ROUTER_FAST_RECEIPT_MAX_ENTRIES: budgets.receiptEntries,
    MODEL_ROUTER_FAST_RECEIPT_MAX_BYTES: budgets.receiptBytes,
    MODEL_ROUTER_FAST_RECEIPT_MAX_PER_TENANT: budgets.receiptPerTenant,
    MODEL_ROUTER_FAST_RECEIPT_WORKERS: budgets.receiptWorkers,
    MODEL_ROUTER_FAST_RECEIPT_MAX_AGE_MS: 5000,
    MODEL_ROUTER_FAST_RECEIPT_DRAIN_TIMEOUT_MS: 10000,
    MODEL_ROUTER_FAST_CREDIT_STRIPES: budgets.creditStripes,
  };
  if (Object.entries(expected).some(([key, value]) => env[key] !== String(value)))
    throw new Error('BOUNDED_WORKER_BUDGET_MISMATCH');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    // As in the original single-worker diagnostic: never swallow a signal
    // arriving before application shutdown handlers exist, nor process.exit(0)
    // before its original handlers and durable work actually finish.
    if (process.listenerCount(signal) === 0) { process.kill(process.pid, signal); return; }
    process.channel?.unref();
  });

  const capacityDiagnostic = env.BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC === '1'
    ? require('./bounded-business-capacity-probe.cjs').install(dist, env) : null;
  const requireSource = createRequire(path.join(dist, '../package.json'));
  const pg = requireSource('pg');
  const OriginalPool = pg.Pool;
  if (typeof OriginalPool !== 'function' || Object.getOwnPropertyDescriptor(pg, 'Pool')?.writable !== true)
    throw new Error('BOUNDED_NATIVE_POOL_OBSERVER_UNAVAILABLE');
  const pools = [];
  // Constructor observation only; collect the REAL native options after pg's
  // constructor, without injecting a pool or changing query/connect behavior.
  const StartupObservedPool = new Proxy(OriginalPool, { construct(target, args, newTarget) {
    // Preserve the exact native prototype/constructor for ordinary Pool users.
    const pool = Reflect.construct(target, args, newTarget === StartupObservedPool ? target : newTarget);
    pools.push(pool); return pool;
  } });
  pg.Pool = StartupObservedPool;
  const restorePool = () => {
    if (pg.Pool === StartupObservedPool) pg.Pool = OriginalPool;
  };
  const receiptQueues = [], executorLocalCaps = [], compositionHttpCaps = [];
  let nativeQueue;
  let nativeFastPrototypes = true;
  const receiptModule = require(path.join(dist, 'saas/gateway/fast/receipt-queue.js'));
  const executorModule = require(path.join(dist, 'saas/gateway/fast/executor.js'));
  const compositionModule = require(path.join(dist, 'server/managed-saas-gateway.js'));
  const OriginalQueue = receiptModule.FastReceiptQueue;
  const OriginalExecutor = executorModule.FastGatewayExecutor;
  const OriginalComposition = compositionModule.createManagedSaasGatewayProductionComposition;
  if ([OriginalQueue, OriginalExecutor, OriginalComposition].some(value => typeof value !== 'function')) {
    restorePool(); throw new Error('BOUNDED_STARTUP_CONFIGURATION_SEAMS_REQUIRED');
  }
  const ObservedQueue = new Proxy(OriginalQueue, { construct(target, args, newTarget) {
    const queue = Reflect.construct(target, args, newTarget === ObservedQueue ? target : newTarget);
    nativeQueue = queue;
    const options = args[0];
    receiptQueues.push(Object.fromEntries(['maxEntries', 'maxBytes', 'maxPerTenant', 'workers', 'maxAgeMs',
      'drainTimeoutMs'].map(key => [key, options?.[key]])));
    nativeFastPrototypes = nativeFastPrototypes && Object.getPrototypeOf(queue) === OriginalQueue.prototype;
    return queue;
  } });
  const ObservedExecutor = new Proxy(OriginalExecutor, { construct(target, args, newTarget) {
    const executor = Reflect.construct(target, args, newTarget === ObservedExecutor ? target : newTarget);
    executorLocalCaps.push(args[0]?.maxLocalConcurrency);
    nativeFastPrototypes = nativeFastPrototypes && Object.getPrototypeOf(executor) === OriginalExecutor.prototype;
    return executor;
  } });
  const observedComposition = function (database, options) {
    compositionHttpCaps.push(options?.maxHttpInFlight);
    return OriginalComposition.call(this, database, options);
  };
  receiptModule.FastReceiptQueue = ObservedQueue;
  executorModule.FastGatewayExecutor = ObservedExecutor;
  compositionModule.createManagedSaasGatewayProductionComposition = observedComposition;
  const restoreStartup = () => {
    restorePool();
    if (receiptModule.FastReceiptQueue === ObservedQueue) receiptModule.FastReceiptQueue = OriginalQueue;
    if (executorModule.FastGatewayExecutor === ObservedExecutor) executorModule.FastGatewayExecutor = OriginalExecutor;
    if (compositionModule.createManagedSaasGatewayProductionComposition === observedComposition)
      compositionModule.createManagedSaasGatewayProductionComposition = OriginalComposition;
  };
  const module = require(path.join(dist, 'server/managed-saas.js'));
  const start = module.startManagedSaasServer;
  if (typeof start !== 'function') { restoreStartup(); throw new Error('BOUNDED_RUNTIME_READY_SEAM_REQUIRED'); }
  module.startManagedSaasServer = async function (deployment, options = {}) {
    module.startManagedSaasServer = start;
    try {
      return await start.call(this, deployment, { ...options, onReady: async runtime => {
        restorePool();
        const actualPools = pools.map(pool => ({ max: pool.options?.max }));
        const expectedMaxima = workers === 1 ? [2, 14] : [2, 6];
        if (JSON.stringify(actualPools.map(pool => pool.max).sort((a, b) => a - b)) !== JSON.stringify(expectedMaxima))
          throw new Error('BOUNDED_NATIVE_POOL_BUDGET_MISMATCH');
        await options.onReady?.(runtime);
        const readyStatus = await ownReadiness(runtime.gateway, startupMs);
        restoreStartup();
        capacityDiagnostic?.attachPublicServer(runtime.listeners?.gateway);
        const expectedQueue = { maxEntries: budgets.receiptEntries, maxBytes: budgets.receiptBytes,
          maxPerTenant: budgets.receiptPerTenant, workers: budgets.receiptWorkers, maxAgeMs: 5000,
          drainTimeoutMs: 10000 };
        if (JSON.stringify(receiptQueues) !== JSON.stringify([expectedQueue]) ||
            JSON.stringify(executorLocalCaps) !== JSON.stringify([budgets.httpInFlight]) ||
            JSON.stringify(compositionHttpCaps) !== JSON.stringify([budgets.httpInFlight]) || !nativeFastPrototypes)
          throw new Error('BOUNDED_ACTUAL_QUEUE_OR_HTTP_BUDGET_MISMATCH');
        const proof = { pid: process.pid, slot, owner: env.MODEL_ROUTER_FAST_OWNER, profile, budgets,
          pools: actualPools, readyStatus, readinessListenerClosed: true,
          poolObserverRemoved: pg.Pool === OriginalPool,
          nativePoolPrototypes: pools.every(pool => Object.getPrototypeOf(pool) === OriginalPool.prototype),
          receiptQueues, executorLocalCaps, compositionHttpCaps, nativeFastPrototypes,
          startupObserversRemoved: pg.Pool === OriginalPool && receiptModule.FastReceiptQueue === OriginalQueue &&
            executorModule.FastGatewayExecutor === OriginalExecutor &&
            compositionModule.createManagedSaasGatewayProductionComposition === OriginalComposition,
          readinessSource: 'exclusive_process_local_GET_readyz_real_gateway_handler',
          inferenceHooksInstalled: Boolean(capacityDiagnostic),
          ...(capacityDiagnostic ? { capacityDiagnostic: capacityDiagnostic.proof() } : {}),
          automaticCreditTargetBasis: '2 * fixture M524480 * trusted local concurrency; not a lifetime aggregate cap',
        };
        const temporary = `${proofFile}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, `${JSON.stringify(proof)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, proofFile);
        if (!process.connected) throw new Error('BOUNDED_PRIMARY_DISCONNECTED');
        // Explicit fixture requests only, outside measured request execution.
        // Native snapshot exposes aggregate counters; no observation callback,
        // histogram, reset, SQL query, or request/receipt wrapper is installed.
        process.on('message', message => {
          if (message?.type !== 'bounded-business-snapshot' ||
              !Number.isSafeInteger(message.sequence) || message.sequence < 1) return;
          try {
            const value = { pid: process.pid, slot, sequence: message.sequence,
              observedMonotonicNs: process.hrtime.bigint().toString(), snapshot: nativeQueue.snapshot(),
              ...(capacityDiagnostic ? { capacityDiagnostic: capacityDiagnostic.snapshot() } : {}) };
            const temporary = `${snapshotFile}.tmp-${process.pid}`;
            fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
            fs.renameSync(temporary, snapshotFile);
          } catch {
            if (process.connected) process.send({ type: 'bounded-business-observation-failed', slot });
          }
        });
        if (capacityDiagnostic) process.once('exit', () => {
          fs.writeFileSync(`${snapshotFile}.capacity-final.json`, JSON.stringify({ pid: process.pid, slot, final: true,
            capacityDiagnostic: capacityDiagnostic.snapshot() }) + '\n', { mode: 0o600 });
        });
        await new Promise((resolve, reject) => process.send(
          { type: 'bounded-business-ready', pid: process.pid, slot }, error => error ? reject(error) : resolve()));
      } });
    } finally { restoreStartup(); }
  };
}

module.exports = { healthRequest, ownReadiness };
if (process.env.BOUNDED_CLUSTER_DIAGNOSTIC === '1') install();
