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
