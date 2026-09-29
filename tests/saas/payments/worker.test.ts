import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPaymentWebhookWorker } from '../../../src/saas/payments/worker.js';

test('worker waits for its in-flight batch to stop and does not overlap work', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const worker = startPaymentWebhookWorker(
    {
      async processPendingWebhooks() {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        entered();
        await gate;
        active -= 1;
        return { claimed: 0, processed: 0, retrying: 0, exhausted: 0 };
      },
    },
    { intervalMs: 50 },
  );

  await started;
  const stopping = worker.stop();
  release();
  await stopping;
  await new Promise((resolve) => setTimeout(resolve, 75));

  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);
  assert.equal(active, 0);
});
