import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPaymentRefundWorker } from '../../../src/saas/payments/refund-worker.js';

test('refund reconciliation worker stop drains its active batch without overlap', async () => {
  let releaseBatch: (() => void) | undefined;
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const batchGate = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  const worker = startPaymentRefundWorker(
    {
      async processPendingRefunds() {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await batchGate;
        active -= 1;
        return { claimed: 1, queried: 1, succeeded: 0, failed: 0, unresolved: 1 };
      },
    },
    { intervalMs: 50, batchSize: 1 },
  );

  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(stopped, false);
  if (!releaseBatch) throw new Error('expected active worker batch');
  releaseBatch();
  await stopping;

  assert.equal(stopped, true);
  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);
});
