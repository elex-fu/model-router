import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastReceiptInput } from '../../../../src/saas/gateway/fast/executor.js';
import { FastReceiptQueue } from '../../../../src/saas/gateway/fast/receipt-queue.js';
import { priceFixture } from './journal-fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function receipt(id = 'intent-a', tenant = 'tenant-a'): FastReceiptInput {
  return {
    intentId: id,
    requestId: `request-${id}`,
    tenantId: tenant,
    outcome: 'succeeded',
    chargeMinorUnits: '15',
    usage: {
      inputTotal: '10',
      inputUncached: '10',
      outputTotal: '5',
      cacheRead: '0',
      cacheWrite: '0',
      cacheWrite5m: '0',
      cacheWrite1h: '0',
      reasoningOutput: '0',
    },
    usageDigest: 'a'.repeat(64),
    httpStatus: 200,
    verification: { priceSnapshot: priceFixture('80', '64') },
  };
}
const completion = { retainedLiabilityMinorUnits: '144' };

test('queue bounds running + pending entries and per-tenant shares; drain owns in-flight work', async () => {
  const ack = deferred();
  let calls = 0;
  const queue = new FastReceiptQueue({
    journal: {
      appendReceipt: async () => {
        calls++;
        await ack.promise;
      },
    },
    maxEntries: 2,
    maxPerTenant: 1,
    workers: 1,
  });
  assert.equal(queue.tryEnqueue(receipt(), completion), true);
  assert.equal(queue.tryEnqueue(receipt('b'), completion), false);
  assert.equal(queue.tryEnqueue(receipt('c', 'other'), completion), true);
  assert.equal(queue.tryEnqueue(receipt('d', 'third'), completion), false);
  assert.equal(calls, 1);
  assert.equal(queue.snapshot().pending, 2);
  assert.equal(queue.snapshot().running, 1);
  assert.equal(queue.snapshot().undurableLiabilityMinorUnits, '288');
  assert.equal(queue.isReady(), false);
  let drained = false;
  const draining = queue.close().then(() => {
    drained = true;
  });
  await delay(5);
  assert.equal(drained, false);
  assert.equal(queue.tryEnqueue(receipt('e'), completion), false);
  ack.resolve();
  await draining;
  assert.equal(calls, 2);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().bytes, 0);
  assert.equal(queue.snapshot().completed, 2);
  await queue.close();
});

test('byte budget includes running work and oversize evidence falls back without starting SQL', async () => {
  let calls = 0;
  const queue = new FastReceiptQueue({
    maxBytes: 1,
    journal: {
      appendReceipt: async () => {
        calls++;
      },
    },
  });
  assert.equal(queue.tryEnqueue(receipt(), completion), false);
  assert.equal(calls, 0);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().fallbacks, 1);
  await queue.close();
});

test('lost ACK retries the identical frozen receipt; successful ACK alone unlocks usage reconciliation', async () => {
  const original = receipt();
  const observed: FastReceiptInput[] = [];
  const order: string[] = [];
  let reconciles = 0;
  const queue = new FastReceiptQueue({
    retryBaseMs: 1,
    retryMaxMs: 1,
    journal: {
      appendReceipt: async (value) => {
        observed.push(value);
        order.push('receipt');
        if (observed.length < 2) throw new Error('uncertain commit ACK');
      },
    },
  });
  assert.equal(
    queue.tryEnqueue(original, {
      ...completion,
      actualTokenUnits: 15,
      reconcileDurableUsage: async (actual) => {
        assert.equal(actual, 15);
        order.push('reconcile');
        if (++reconciles === 1) throw new Error('Redis unavailable');
      },
    }),
    true,
  );
  Object.assign(original.usage, { inputTotal: '900' });
  Object.assign(original.verification!.priceSnapshot.customerPrice, { currency: 'changed' });
  await queue.close();
  assert.equal(observed.length, 2);
  assert.equal(observed[0], observed[1]);
  assert.equal(observed[0].usage.inputTotal, '10');
  assert.equal(observed[0].verification?.priceSnapshot.customerPrice.currency, 'USD');
  assert.ok(Object.isFrozen(observed[0].verification?.priceSnapshot.customerPrice.rates));
  assert.deepEqual(order, ['receipt', 'receipt', 'reconcile', 'reconcile']);
  assert.equal(queue.snapshot().retries, 1);
  assert.equal(queue.snapshot().reconciliationRetries, 1);
  assert.equal(queue.snapshot().durable, 1);
});

test('duplicate pending evidence is idempotent; conflicting evidence never replaces it', async () => {
  const ack = deferred();
  let calls = 0;
  const queue = new FastReceiptQueue({
    journal: {
      appendReceipt: async () => {
        calls++;
        await ack.promise;
      },
    },
  });
  const original = receipt();
  assert.equal(queue.tryEnqueue(original, completion), true);
  assert.equal(queue.tryEnqueue(original, completion), true);
  assert.throws(() => queue.tryEnqueue({ ...original, usageDigest: 'b'.repeat(64) }, completion), /CONFLICT/);
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(calls, 1);
  ack.resolve();
  await queue.close();
});

test('conflict retains evidence and liability, fails readiness and drain without spinning', async () => {
  let calls = 0;
  const queue = new FastReceiptQueue({
    journal: {
      appendReceipt: async () => {
        calls++;
        throw new Error('FAST_JOURNAL_RECEIPT_CONFLICT');
      },
    },
  });
  queue.tryEnqueue(receipt(), completion);
  await assert.rejects(queue.close(), /DRAIN_CONFLICT/);
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().undurableLiabilityMinorUnits, '144');
  assert.equal(queue.canAdmit(), false);
  assert.equal(calls, 1);
});

test('drain timeout never discards a hung append or declares it durable; later ACK still drains', async () => {
  const ack = deferred();
  let now = 0;
  const queue = new FastReceiptQueue({
    drainTimeoutMs: 10,
    maxAgeMs: 5,
    now: () => now,
    journal: { appendReceipt: async () => ack.promise },
  });
  queue.tryEnqueue(receipt(), completion);
  now = 6;
  assert.equal(queue.isReady(), false);
  assert.equal(queue.canAdmit(), false);
  await assert.rejects(queue.close(), /DRAIN_TIMEOUT/);
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().undurable, 1);
  ack.resolve();
  await queue.close();
  assert.equal(queue.snapshot().pending, 0);
});

test('queue excludes arbitrary evidence extensions and request AsyncLocalStorage from workers/retries', async () => {
  const context = new AsyncLocalStorage<object>();
  const contexts: unknown[] = [];
  let serialized = '';
  let attempts = 0;
  const queue = new FastReceiptQueue({
    retryBaseMs: 1,
    retryMaxMs: 1,
    journal: {
      appendReceipt: async (value) => {
        contexts.push(context.getStore());
        serialized = JSON.stringify(value);
        if (++attempts === 1) throw new Error('retry');
      },
    },
  });
  const input = { ...receipt(), candidate: { credential: 'private-fixture' }, body: { text: 'private-body' } };
  context.run({ request: 'private-context' }, () => queue.tryEnqueue(input, completion));
  await queue.close();
  assert.deepEqual(contexts, [undefined, undefined]);
  assert.doesNotMatch(serialized, /private|candidate|credential|body/);
  assert.doesNotMatch(JSON.stringify(queue.snapshot()), /tenant|intent-a|request/);
  const unsafePrice = receipt('other');
  Object.assign(unsafePrice.verification!.priceSnapshot.customerPrice, { credential: 'private-fixture' });
  assert.throws(() => queue.tryEnqueue(unsafePrice, completion), /INVALID_PROOF/);
});

test('invalid proof, usage and reconciliation cannot be queued or observed as success', async () => {
  const queue = new FastReceiptQueue({
    journal: {
      appendReceipt: async () => {
        assert.fail('must not append');
      },
    },
  });
  const input = receipt();
  assert.throws(() => queue.tryEnqueue({ ...input, chargeMinorUnits: '99' }, completion), /INVALID_PROOF/);
  assert.throws(() => queue.tryEnqueue({ ...input, usage: { ...input.usage, body: '0' } }, completion), /INVALID/);
  assert.throws(
    () => queue.tryEnqueue(input, { ...completion, actualTokenUnits: 10, reconcileDurableUsage: async () => {} }),
    /COMPLETION/,
  );
  assert.equal(queue.snapshot().pending, 0);
  await queue.close();
});
