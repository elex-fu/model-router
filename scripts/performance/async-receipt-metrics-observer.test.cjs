'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMetrics, sanitize, wrapComposition } = require('./async-receipt-metrics-observer.cjs');
const zero = {
  accepting: true, pending: 0, bytes: 0, running: 0, receiptRunning: 0,
  reconciliationRunning: 0, oldestAgeMs: 0, undurable: 0, oldestUndurableAgeMs: 0,
  undurableLiabilityByCurrency: {}, accepted: 0, durable: 0, completed: 0,
  retries: 0, reconciliationRetries: 0, fallbacks: 0, conflicts: 0,
  lastDurableLagMs: 0, maxDurableLagMs: 0,
};
const phaseNames = ['receiptQueueWait', 'receiptAwait', 'reconciliationQueueWait', 'reconciliationAwait', 'residence'];
function phaseSnapshot(count = 0, sum = 0, last = 0, max = 0) {
  return {
    ...zero, completedWithoutReconciliation: 0,
    ...Object.fromEntries(phaseNames.flatMap((phase) => [
      [phase + 'Count', count], [phase + 'SumMs', sum],
      [phase + 'LastMs', last], [phase + 'MaxMs', max],
    ])),
  };
}
test('sanitizer emits only fixed numeric fields and validated currency amounts', () => {
  const safe = sanitize({ ...zero, tenantId: 'secret', receipt: { arbitrary: 'secret' }, undurableLiabilityByCurrency: { USD: '524480' } });
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.deepEqual(safe.undurableLiabilityByCurrency, { USD: '524480' });
  assert.throws(() => sanitize({ ...zero, pending: NaN }));
  assert.throws(() => sanitize({ ...zero, undurableLiabilityByCurrency: { 'tenant-secret': '1' } }));
});
test('composition hook preserves original exact return and prior observer', () => {
  const metrics = createMetrics(); const receiver = {}; const database = {};
  const originalReturn = Promise.resolve('not changed'); let prior = 0;
  const wrapped = wrapComposition(function (db, options) {
    assert.equal(this, receiver); assert.equal(db, database); options.fastReceiptQueueObserver(zero); return originalReturn;
  }, metrics);
  assert.equal(wrapped.call(receiver, database, { fastReceiptQueueObserver: () => { prior++; } }), originalReturn);
  assert.equal(prior, 1); assert.equal(metrics.snapshot().observations, 1);
});
test('reset keeps baseline, excludes warmup and records bounded receipt lag histogram', () => {
  const metrics = createMetrics();
  metrics.observe({ ...zero, accepted: 10, durable: 10, completed: 10 });
  metrics.reset();
  metrics.observe({ ...zero, accepted: 11, durable: 10, completed: 10, pending: 1, undurable: 1, bytes: 500, undurableLiabilityByCurrency: { USD: '524480' } });
  metrics.observe({ ...zero, accepted: 11, durable: 11, completed: 11, lastDurableLagMs: 7 });
  const result = metrics.snapshot();
  assert.equal(result.counterDeltas.accepted, 1); assert.equal(result.counterDeltas.durable, 1);
  assert.equal(result.observedPeaks.pending, 1); assert.equal(result.observedPeaks.bytes, 500);
  assert.deepEqual(result.undurableLiabilityPeaksByCurrency, { USD: '524480' });
  assert.equal(result.receiptAckLag.count, 1); assert.equal(result.receiptAckLag.sumMs, 7);
  assert.equal(result.receiptAckLag.buckets[3], 1); assert.equal(result.receiptAckLag.missedDurableTransitions, 0);
  assert.equal(result.events.length, 0);
});
test('invalid/missed events are explicit, not fabricated exact lag observations', () => {
  const metrics = createMetrics({ eventLimit: 1 });
  metrics.observe({ ...zero, accepted: 2, durable: 2 });
  metrics.observe(zero); metrics.observe({ pending: 'secret' });
  const result = metrics.snapshot();
  assert.equal(result.invalidObservations, 1); assert.equal(result.events.length, 1); assert.equal(result.dropped, 1);
  assert.equal(result.receiptAckLag.count, 0); assert.equal(result.receiptAckLag.missedDurableTransitions, 4);
});
test('phase schema is all-or-none; old controls remain explicitly unavailable', () => {
  const metrics = createMetrics(); metrics.observe(zero);
  assert.deepEqual(metrics.snapshot().phaseMetrics, { available: false, completedWithoutReconciliationDelta: null, groups: {} });
  assert.throws(() => sanitize({ ...zero, receiptAwaitCount: 0 }));
  assert.throws(() => sanitize({ ...phaseSnapshot(), receiptAwaitCount: 0.5 }));
  assert.throws(() => sanitize({ ...phaseSnapshot(), reconciliationAwaitSumMs: Infinity }));
  assert.throws(() => sanitize({ ...phaseSnapshot(), completedWithoutReconciliation: -1 }));
  const safe = sanitize({ ...phaseSnapshot(), receiptId: 'secret', receiptAwaitSamples: ['secret'] });
  assert.equal(safe.phaseMetricsAvailable, true);
  assert.equal(JSON.stringify(safe).includes('secret'), false);
});
test('all five phase histograms reset independently of lifetime maxima and expose exact counter deltas', () => {
  const metrics = createMetrics();
  metrics.observe(phaseSnapshot(10, 1000, 500, 500)); metrics.reset();
  metrics.observe(phaseSnapshot(11, 1007, 7, 500));
  metrics.observe(phaseSnapshot(12, 1010, 3, 500));
  for (const stats of Object.values(metrics.snapshot().phaseMetrics.groups)) {
    assert.equal(stats.counterCountDelta, 2); assert.equal(stats.counterSumMsDelta, 10);
    assert.equal(stats.observedCount, 2); assert.equal(stats.observedSumMs, 10);
    assert.equal(stats.observedMaxMs, 7); assert.equal(stats.preWindowLifetimeMaxMs, 500);
    assert.equal(stats.postWindowLifetimeMaxMs, 500); assert.equal(stats.missedTransitions, 0);
    assert.equal(stats.counterResets, 0); assert.equal(stats.buckets[2], 1); assert.equal(stats.buckets[3], 1);
  }
  const frozenSnapshot = metrics.snapshot(); metrics.observe(phaseSnapshot(13, 1011, 1, 500));
  assert.equal(frozenSnapshot.phaseMetrics.groups.receiptAwait.buckets[0], 0);
  metrics.reset();
  assert.equal(metrics.snapshot().phaseMetrics.groups.receiptAwait.observedMaxMs, 0);
  assert.equal(metrics.snapshot().phaseMetrics.groups.receiptAwait.counterCountDelta, 0);
});
test('phase missed transitions and counter resets are explicit, never reconstructed from LastMs', () => {
  const metrics = createMetrics(); metrics.observe(phaseSnapshot()); metrics.reset();
  metrics.observe(phaseSnapshot(3, 100, 5, 90));
  let stats = metrics.snapshot().phaseMetrics.groups.receiptAwait;
  assert.equal(stats.counterCountDelta, 3); assert.equal(stats.counterSumMsDelta, 100);
  assert.equal(stats.observedCount, 0); assert.equal(stats.missedTransitions, 3);
  assert.equal(stats.buckets.reduce((a, b) => a + b, 0), 0);
  metrics.observe(phaseSnapshot()); stats = metrics.snapshot().phaseMetrics.groups.receiptAwait;
  assert.equal(stats.counterResets, 1); assert.equal(stats.observedCount, 0);
});
test('settled failed attempts are sampled but hanging work and no-reconciliation completions fabricate no await', () => {
  const metrics = createMetrics(); const initial = phaseSnapshot();
  metrics.observe(initial); metrics.reset();
  metrics.observe({ ...initial, accepted: 1, pending: 1, receiptRunning: 1, running: 1 });
  assert.equal(metrics.snapshot().phaseMetrics.groups.receiptAwait.observedCount, 0);
  const failed = { ...initial, accepted: 1, pending: 1, retries: 1,
    receiptQueueWaitCount: 1, receiptQueueWaitSumMs: 2, receiptQueueWaitLastMs: 2, receiptQueueWaitMaxMs: 2,
    receiptAwaitCount: 1, receiptAwaitSumMs: 5, receiptAwaitLastMs: 5, receiptAwaitMaxMs: 5 };
  metrics.observe(failed);
  metrics.observe({ ...failed, pending: 0, durable: 1, completed: 1, completedWithoutReconciliation: 1,
    receiptQueueWaitCount: 2, receiptQueueWaitSumMs: 12, receiptQueueWaitLastMs: 10, receiptQueueWaitMaxMs: 10,
    receiptAwaitCount: 2, receiptAwaitSumMs: 8, receiptAwaitLastMs: 3,
    residenceCount: 1, residenceSumMs: 20, residenceLastMs: 20, residenceMaxMs: 20 });
  const result = metrics.snapshot();
  assert.equal(result.phaseMetrics.groups.receiptAwait.observedCount, 2);
  assert.equal(result.phaseMetrics.groups.receiptAwait.counterSumMsDelta, 8);
  assert.equal(result.phaseMetrics.groups.reconciliationAwait.observedCount, 0);
  assert.equal(result.phaseMetrics.groups.reconciliationQueueWait.observedCount, 0);
  assert.equal(result.phaseMetrics.groups.residence.observedCount, 1);
  assert.equal(result.phaseMetrics.completedWithoutReconciliationDelta, 1);
  assert.equal(result.counterDeltas.retries, 1); assert.equal(result.counterDeltas.completed, 1);
});
