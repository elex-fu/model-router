'use strict';

// Evaluation-only preload. Never imported by the application, never sends SQL,
// and never logs SQL, parameters, tenant IDs, wallet keys, or credentials.
const { performance } = require('node:perf_hooks');

const DEFINITIONS = Object.freeze({
  acquiredToCommitAckMs: 'First successful matching acquisition-query completion on one pg.Client to successful COMMIT acknowledgement on that same client. The lock can be acquired before query completion and released before COMMIT acknowledgement. This client-observed proxy excludes intra-query hold time and includes acknowledgement latency; it is neither exact server hold time nor a strict bound.',
  acquisitionQueryElapsedMs: 'Client.query invocation to successful query completion; includes the client query queue, network, PostgreSQL execution/lock waiting and result decoding. This is NOT a pure PostgreSQL lock-wait measurement.',
  transactionDurationMs: 'Successful BEGIN acknowledgement to COMMIT or ROLLBACK acknowledgement on the same pg.Client, grouped by successful terminal outcome.',
  transactionQueryElapsedTotalMs: 'Sum of Client.query elapsed times completed inside a tracked transaction after BEGIN acknowledgement, including its terminal COMMIT/ROLLBACK but excluding BEGIN. Concurrently queued calls can overlap; this sum must not be assumed to equal server execution time or subtracted from transaction duration as an exact application-gap measurement.',
  allQueryElapsedMs: 'All observed Client.query invocation-to-completion durations in the measurement epoch, split successful/failed; includes queries outside explicit transactions. No SQL text, query class beyond fixed lock domains, or client identity is emitted.',
  overlap: 'Account-counter and wallet-fence windows overlap within one transaction and across concurrent transactions. Sums are contention exposure, not additive wall-clock or CPU time.',
  population: 'Only explicit transactions with successful BEGIN and COMMIT acknowledgements contribute committed windows. Failed acquisition queries, rollbacks, ambiguous COMMIT failures and transactions crossing a reset are counted separately.',
  selection: 'First successful account-counter INSERT and first successful wallet-fence query per explicit simple transaction; repeated calls in the same domain are counted but do not restart its window. Savepoint-controlled transactions are excluded because rollback-to-savepoint can release a lock early.',
  quantiles: 'Exact nearest-rank quantiles of the first sampleLimit observations (default100000). Count/sum/min/max include all observations. quantilesTruncated explicitly marks a capped prefix, not a representative sample.',
});
function distribution(limit) {
  return { count: 0, sumMs: 0, minMs: null, maxMs: null, samples: [], sampleLimit: limit };
}
function add(distribution, value) {
  if (!Number.isFinite(value) || value < 0) return;
  distribution.count++;
  distribution.sumMs += value;
  distribution.minMs = distribution.minMs === null ? value : Math.min(distribution.minMs, value);
  distribution.maxMs = distribution.maxMs === null ? value : Math.max(distribution.maxMs, value);
  if (distribution.samples.length < distribution.sampleLimit) distribution.samples.push(value);
}
function summarize(distribution) {
  const sorted = [...distribution.samples].sort((a, b) => a - b);
  const quantile = (fraction) => sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
  return {
    count: distribution.count, sumMs: distribution.sumMs,
    meanMs: distribution.count === 0 ? null : distribution.sumMs / distribution.count,
    minMs: distribution.minMs, maxMs: distribution.maxMs,
    p50Ms: quantile(0.5), p95Ms: quantile(0.95), p99Ms: quantile(0.99),
    quantileSampleCount: sorted.length, quantilesTruncated: sorted.length !== distribution.count,
  };
}
function classify(text, values) {
  if (typeof text !== 'string') return null;
  const sql = text.trim().replace(/;\s*$/, '');
  if (/^(?:BEGIN(?:\s|$)|START\s+TRANSACTION(?:\s|$))/i.test(sql)) return 'begin';
  if (/^COMMIT(?:\s+(?:WORK|TRANSACTION))?$/i.test(sql)) return 'commit';
  if (/^ROLLBACK(?:\s+(?:WORK|TRANSACTION))?$/i.test(sql)) return 'rollback';
  if (/^(?:SAVEPOINT\s|RELEASE(?:\s+SAVEPOINT)?\s|ROLLBACK(?:\s+(?:WORK|TRANSACTION))?\s+TO\s)/i.test(sql)) return 'savepoint';
  if (/^INSERT\s+INTO\s+saas_provider_account_rate_counters\b/i.test(sql)) return 'accountCounter';
  if (/^SELECT\s+pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*\$1(?:\s*::\s*text)?\s*,\s*0\s*\)\s*\)$/i.test(sql)
    && typeof values?.[0] === 'string' && values[0].startsWith('model-router:wallet-fence:')) return 'walletFence';
  return null;
}
function createLockWindowCollector({ now = () => performance.now(), sampleLimit = 100000 } = {}) {
  if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1) throw new TypeError('sampleLimit must be positive');
  const active = new WeakMap();
  let epoch = 0, activeTransactions = 0;
  const fresh = () => ({
    begun: 0, committed: 0, rolledBack: 0, beginFailures: 0, commitFailures: 0, rollbackFailures: 0,
    resetCrossingTransactions: 0, savepointTransactions: 0, repeatedBeginTransactions: 0,
    queries: { successfulElapsedMs: distribution(sampleLimit), failedElapsedMs: distribution(sampleLimit) },
    transactions: {
      committedDurationMs: distribution(sampleLimit), rolledBackDurationMs: distribution(sampleLimit),
      committedQueryElapsedTotalMs: distribution(sampleLimit), rolledBackQueryElapsedTotalMs: distribution(sampleLimit),
      committedQueryCount: 0, rolledBackQueryCount: 0,
    },
    domains: Object.fromEntries(['accountCounter', 'walletFence'].map((name) => [name, {
      successfulAcquisitionQueries: 0, failedAcquisitionQueries: 0, repeatedAcquisitionQueries: 0,
      acquisitionQueryElapsedMs: distribution(sampleLimit), acquiredToCommitAckMs: distribution(sampleLimit),
      acquiredToRollbackAckMs: distribution(sampleLimit),
    }])),
  });
  let totals = fresh();
  function start(client, text, values) {
    const kind = classify(text, values);
    const startedAt = now(), queryEpoch = epoch;
    let completed = false;
    return (error, result) => {
      if (completed) return;
      completed = true;
      const endedAt = now();
      if (queryEpoch === epoch) add(totals.queries[error ? 'failedElapsedMs' : 'successfulElapsedMs'], endedAt - startedAt);
      if (kind === 'begin') {
        if (error) { if (queryEpoch === epoch) totals.beginFailures++; return; }
        const previous = active.get(client);
        if (previous) { previous.unsupported = true; if (queryEpoch === epoch) totals.repeatedBeginTransactions++; return; }
        activeTransactions++;
        active.set(client, { epoch: queryEpoch, acquisitions: {}, unsupported: false, begunAt: endedAt, queryElapsedTotalMs: 0, queryCount: 0 });
        if (queryEpoch === epoch) totals.begun++;
        return;
      }
      const transaction = active.get(client);
      if (!transaction) return;
      if (transaction.epoch === epoch && queryEpoch === epoch) {
        transaction.queryElapsedTotalMs += endedAt - startedAt;
        transaction.queryCount++;
      }
      if (kind === null) return;
      if (kind === 'savepoint') {
        if (!error && !transaction.unsupported) {
          transaction.unsupported = true;
          if (transaction.epoch === epoch) totals.savepointTransactions++;
        }
        return;
      }
      if (kind === 'accountCounter' || kind === 'walletFence') {
        if (transaction.epoch !== epoch || queryEpoch !== epoch) return;
        const domain = totals.domains[kind];
        if (error) { domain.failedAcquisitionQueries++; return; }
        domain.successfulAcquisitionQueries++;
        add(domain.acquisitionQueryElapsedMs, endedAt - startedAt);
        if (transaction.acquisitions[kind] !== undefined) domain.repeatedAcquisitionQueries++;
        else transaction.acquisitions[kind] = endedAt;
        return;
      }
      active.delete(client); activeTransactions--;
      if (transaction.epoch !== epoch || queryEpoch !== epoch) { totals.resetCrossingTransactions++; return; }
      if (error) { totals[kind === 'commit' ? 'commitFailures' : 'rollbackFailures']++; return; }
      // PostgreSQL acknowledges COMMIT on an aborted transaction as ROLLBACK.
      const rolledBack = kind === 'rollback' || result?.command === 'ROLLBACK';
      if (!rolledBack && result?.command !== 'COMMIT') { totals.commitFailures++; return; }
      totals[rolledBack ? 'rolledBack' : 'committed']++;
      const outcome = rolledBack ? 'rolledBack' : 'committed';
      add(totals.transactions[`${outcome}DurationMs`], endedAt - transaction.begunAt);
      add(totals.transactions[`${outcome}QueryElapsedTotalMs`], transaction.queryElapsedTotalMs);
      totals.transactions[`${outcome}QueryCount`] += transaction.queryCount;
      if (transaction.unsupported) return;
      for (const [domain, acquiredAt] of Object.entries(transaction.acquisitions)) {
        add(totals.domains[domain][rolledBack ? 'acquiredToRollbackAckMs' : 'acquiredToCommitAckMs'], endedAt - acquiredAt);
      }
    };
  }
  return {
    start,
    reset() { epoch++; totals = fresh(); },
    snapshot() {
      return {
        schemaVersion: 1, instrumentedDiagnosticOnly: true, definitions: DEFINITIONS, epoch, activeTransactions,
        ...Object.fromEntries(Object.entries(totals).filter(([key]) => !['domains', 'queries', 'transactions'].includes(key))),
        queries: Object.fromEntries(Object.entries(totals.queries).map(([name, stats]) => [name, summarize(stats)])),
        transactions: Object.fromEntries(Object.entries(totals.transactions).map(([name, stats]) =>
          [name, typeof stats === 'number' ? stats : summarize(stats)])),
        domains: Object.fromEntries(Object.entries(totals.domains).map(([name, domain]) => [name, {
          ...domain,
          acquisitionQueryElapsedMs: summarize(domain.acquisitionQueryElapsedMs),
          acquiredToCommitAckMs: summarize(domain.acquiredToCommitAckMs),
          acquiredToRollbackAckMs: summarize(domain.acquiredToRollbackAckMs),
        }])),
      };
    },
  };
}
function installLockWindowObserver(Client, options) {
  const collector = createLockWindowCollector(options);
  const original = Client.prototype.query;
  function observedQuery(...args) {
    const selected = args[0];
    const text = typeof selected === 'string' ? selected : selected?.text;
    const values = typeof selected === 'string' ? (Array.isArray(args[1]) ? args[1] : undefined) : selected?.values;
    const finish = collector.start(this, text, values);
    const safelyFinish = (error, result) => { try { finish(error, result); } catch { /* Diagnostic only. */ } };
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === 'function') {
      const callback = args[callbackIndex];
      args[callbackIndex] = function (error, result) { safelyFinish(error, result); return callback.apply(this, arguments); };
      try { return original.apply(this, args); } catch (error) { safelyFinish(error); throw error; }
    }
    let returned;
    try { returned = original.apply(this, args); } catch (error) { safelyFinish(error); throw error; }
    if (returned && typeof returned.then === 'function') returned.then((result) => safelyFinish(null, result), safelyFinish);
    return returned;
  }
  Client.prototype.query = observedQuery;
  return { ...collector, uninstall() { if (Client.prototype.query === observedQuery) Client.prototype.query = original; } };
}
module.exports = { createLockWindowCollector, installLockWindowObserver };

if (process.env.MODEL_ROUTER_BENCH_LOCK_WINDOWS_FILE) {
  const { writeFileSync } = require('node:fs');
  const { Client } = require('pg');
  const observer = installLockWindowObserver(Client);
  const file = process.env.MODEL_ROUTER_BENCH_LOCK_WINDOWS_FILE;
  const dump = () => {
    try { writeFileSync(file, `${JSON.stringify(observer.snapshot(), null, 2)}\n`, { mode: 0o600 }); }
    catch { process.stderr.write('BENCH_LOCK_WINDOW_DUMP_FAILED\n'); }
  };
  process.on('SIGUSR2', dump);
  // SIGWINCH only resets measurements; transactions crossing it are excluded.
  process.on('SIGWINCH', () => observer.reset());
  process.on('exit', dump);
}
