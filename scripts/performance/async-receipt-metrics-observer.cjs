'use strict';
// Supported production observer option only. No SQL, network, queue method,
// journal method or returned Promise is wrapped. Summary mode is constant-size.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const NUMBERS = [
  'pending', 'bytes', 'running', 'receiptRunning', 'reconciliationRunning',
  'oldestAgeMs', 'undurable', 'oldestUndurableAgeMs', 'accepted', 'durable',
  'completed', 'retries', 'reconciliationRetries', 'fallbacks', 'conflicts',
  'lastDurableLagMs', 'maxDurableLagMs',
];
const COUNTERS = ['accepted', 'durable', 'completed', 'retries', 'reconciliationRetries', 'fallbacks', 'conflicts'];
const PEAKS = ['pending', 'bytes', 'running', 'receiptRunning', 'reconciliationRunning', 'oldestAgeMs', 'undurable', 'oldestUndurableAgeMs'];
const LAG_BOUNDS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, Infinity];
const PHASES = ['receiptQueueWait', 'receiptAwait', 'reconciliationQueueWait', 'reconciliationAwait', 'residence'];
const PHASE_NUMBERS = PHASES.flatMap((phase) => ['Count', 'SumMs', 'LastMs', 'MaxMs'].map((suffix) => phase + suffix));

function emptyPhases() {
  return Object.fromEntries(PHASES.map((phase) => [phase, {
    observedCount: 0, observedSumMs: 0, observedMaxMs: 0,
    missedTransitions: 0, counterResets: 0, buckets: LAG_BOUNDS.map(() => 0),
  }]));
}

function sanitize(input) {
  const safe = { accepting: input.accepting === true };
  for (const key of NUMBERS) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('ASYNC_RECEIPT_METRIC_INVALID');
    safe[key] = value;
  }
  // Older durable/queue controls remain readable, but absent phase telemetry
  // is unknown rather than fabricated zero-duration work. Partial schemas fail.
  safe.phaseMetricsAvailable = [...PHASE_NUMBERS, 'completedWithoutReconciliation'].some((key) => key in input);
  if (safe.phaseMetricsAvailable) {
    for (const key of [...PHASE_NUMBERS, 'completedWithoutReconciliation']) {
      const value = input[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
          ((key.endsWith('Count') || key === 'completedWithoutReconciliation') && !Number.isSafeInteger(value))) {
        throw new Error('ASYNC_RECEIPT_PHASE_METRIC_INVALID');
      }
      safe[key] = value;
    }
  }
  safe.undurableLiabilityByCurrency = {};
  for (const [currency, amount] of Object.entries(input.undurableLiabilityByCurrency ?? {})) {
    if (!/^[A-Z]{3}$/.test(currency) || typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,99})$/.test(amount)) {
      throw new Error('ASYNC_RECEIPT_METRIC_CURRENCY_INVALID');
    }
    if (Object.keys(safe.undurableLiabilityByCurrency).length >= 16) throw new Error('ASYNC_RECEIPT_METRIC_CURRENCY_BOUND');
    safe.undurableLiabilityByCurrency[currency] = amount;
  }
  return safe;
}
function createMetrics({ now = () => performance.now(), eventLimit = 0 } = {}) {
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 0 || eventLimit > 10000) throw new Error('ASYNC_RECEIPT_METRIC_EVENT_BOUND');
  let latest = null;
  let baseline = null;
  let observations = 0;
  let invalidObservations = 0;
  let events = [];
  let dropped = 0;
  let epoch = 0;
  let startedAtMs = now();
  let peaks = {};
  let currencyPeaks = {};
  let lag = { count: 0, sumMs: 0, maxMs: 0, missedDurableTransitions: 0, buckets: LAG_BOUNDS.map(() => 0) };
  let phases = emptyPhases();
  function observe(raw) {
    try {
      const item = sanitize(raw);
      const previous = latest;
      latest = item;
      observations++;
      for (const key of PEAKS) peaks[key] = Math.max(peaks[key] ?? 0, item[key]);
      for (const [currency, amount] of Object.entries(item.undurableLiabilityByCurrency)) {
        if (BigInt(amount) > BigInt(currencyPeaks[currency] ?? '0')) currencyPeaks[currency] = amount;
      }
      const durableDelta = item.durable - (previous?.durable ?? baseline?.durable ?? 0);
      if (durableDelta === 1) {
        lag.count++; lag.sumMs += item.lastDurableLagMs;
        lag.maxMs = Math.max(lag.maxMs, item.lastDurableLagMs);
        lag.buckets[LAG_BOUNDS.findIndex((bound) => item.lastDurableLagMs <= bound)]++;
      } else if (durableDelta !== 0) lag.missedDurableTransitions += Math.abs(durableDelta);
      if (item.phaseMetricsAvailable) {
        for (const phase of PHASES) {
          const delta = item[phase + 'Count'] - (previous?.[phase + 'Count'] ?? 0);
          const stats = phases[phase];
          if (delta === 1) {
            const duration = item[phase + 'LastMs'];
            stats.observedCount++; stats.observedSumMs += duration;
            stats.observedMaxMs = Math.max(stats.observedMaxMs, duration);
            stats.buckets[LAG_BOUNDS.findIndex((bound) => duration <= bound)]++;
          } else if (delta > 1) stats.missedTransitions += delta;
          else if (delta < 0) stats.counterResets++;
        }
      }
      if (eventLimit) {
        if (events.length < eventLimit) events.push({ monotonicMs: now(), ...item });
        else dropped++;
      }
    } catch { invalidObservations++; }
  }
  function reset() {
    epoch++; baseline = latest; observations = 0; invalidObservations = 0;
    events = []; dropped = 0; peaks = {}; currencyPeaks = {}; startedAtMs = now();
    lag = { count: 0, sumMs: 0, maxMs: 0, missedDurableTransitions: 0, buckets: LAG_BOUNDS.map(() => 0) };
    phases = emptyPhases();
  }
  function snapshot() {
    return {
      schemaVersion: 2, epoch, startedAtMs, observedAtMs: now(), observations,
      invalidObservations, latest, baseline,
      counterDeltas: Object.fromEntries(COUNTERS.map((key) => [key, latest ? latest[key] - (baseline?.[key] ?? 0) : 0])),
      observedPeaks: peaks, undurableLiabilityPeaksByCurrency: currencyPeaks,
      receiptAckLag: { ...lag, upperBoundsMs: LAG_BOUNDS.map((value) => Number.isFinite(value) ? value : 'overflow') },
      phaseMetrics: {
        available: latest?.phaseMetricsAvailable === true,
        completedWithoutReconciliationDelta: latest?.phaseMetricsAvailable
          ? latest.completedWithoutReconciliation - (baseline?.completedWithoutReconciliation ?? 0) : null,
        groups: latest?.phaseMetricsAvailable ? Object.fromEntries(PHASES.map((phase) => [phase, {
          ...phases[phase], buckets: [...phases[phase].buckets],
          counterCountDelta: latest[phase + 'Count'] - (baseline?.[phase + 'Count'] ?? 0),
          counterSumMsDelta: latest[phase + 'SumMs'] - (baseline?.[phase + 'SumMs'] ?? 0),
          preWindowLifetimeMaxMs: baseline?.[phase + 'MaxMs'] ?? null,
          postWindowLifetimeMaxMs: latest[phase + 'MaxMs'],
          upperBoundsMs: LAG_BOUNDS.map((value) => Number.isFinite(value) ? value : 'overflow'),
        }])) : {},
      },
      eventLimit, dropped, events,
      qualifications: {
        source: 'supported synchronous fastReceiptQueueObserver option',
        occupancy: 'peaks at observed production notification transitions, not a periodic sampler',
        age: 'maximum age seen at notification; not a continuous-time upper bound',
        lag: 'queue acceptance to appendReceipt successful resolution; bucketed, not exact percentile samples',
        phases: 'settled attempt durations only, including failed attempts; hanging work has no duration sample; count/sum deltas are independent of observed histograms',
        phaseWait: 'queue waits include retry backoff; reconciliation wait starts at durable ACK; residence samples completed removals only',
        phaseMax: 'observedMaxMs resets with warm boundary; production lifetime maxima are separately labeled and never used as window maxima',
        clientCompletion: 'not measured here; use external client EOF and separately durable financial drain',
        absentQueue: 'zero observations may mean durable mode; never infer a drained async queue from absence',
      },
    };
  }
  return { observe, reset, snapshot };
}
function wrapComposition(original, metrics) {
  return function (database, options) {
    const prior = options?.fastReceiptQueueObserver;
    return original.call(this, database, { ...options, fastReceiptQueueObserver(snapshot) {
      metrics.observe(snapshot);
      if (prior) prior(snapshot);
    } });
  };
}
function install() {
  const output = process.env.ASYNC_RECEIPT_METRICS_OUTPUT;
  const dist = process.env.R9_TEST_DIST;
  if (!path.isAbsolute(output ?? '') || !path.isAbsolute(dist ?? '')) throw new Error('ASYNC_RECEIPT_METRIC_ABSOLUTE_PATHS_REQUIRED');
  const metrics = createMetrics({ eventLimit: Number(process.env.ASYNC_RECEIPT_METRICS_EVENT_LIMIT ?? 0) });
  const module = require(path.join(dist, 'server/managed-saas-gateway.js'));
  if (typeof module.createManagedSaasGatewayProductionComposition !== 'function') throw new Error('ASYNC_RECEIPT_METRIC_FACTORY_REQUIRED');
  module.createManagedSaasGatewayProductionComposition = wrapComposition(module.createManagedSaasGatewayProductionComposition, metrics);
  function dump() {
    fs.writeFileSync(`${output}.tmp`, `${JSON.stringify(metrics.snapshot())}\n`, { mode: 0o600 });
    fs.renameSync(`${output}.tmp`, output);
  }
  process.on('SIGUSR2', dump);
  // Dedicated metrics-only signal: the historical fixture's SIGUSR2 handler
  // also queries prepared-statement diagnostics. Pilot telemetry must not.
  process.on('SIGHUP', dump);
  process.on('SIGWINCH', () => { metrics.reset(); dump(); });
  process.on('exit', dump);
  return metrics;
}
if (process.env.ASYNC_RECEIPT_METRICS_ENABLE === '1') install();
module.exports = { createMetrics, sanitize, wrapComposition };
