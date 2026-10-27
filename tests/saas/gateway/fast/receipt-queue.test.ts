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
const completion = { retainedLiabilityMinorUnits: '144', currency: 'USD' };

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
  assert.equal(queue.snapshot().undurableLiabilityByCurrency.USD, '288');
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
  assert.ok(original.verification);
  Object.assign(original.verification.priceSnapshot.customerPrice, { currency: 'changed' });
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
  assert.equal(queue.snapshot().undurableLiabilityByCurrency.USD, '144');
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
  assert.ok(unsafePrice.verification);
  Object.assign(unsafePrice.verification.priceSnapshot.customerPrice, { credential: 'private-fixture' });
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

test('hung reconciliation cannot starve receipt SQL slots or claim financial backlog', async () => {
  const redis = deferred();
  let now = 0;
  let receipts = 0;
  const queue = new FastReceiptQueue({
    workers: 1,
    now: () => now,
    maxAgeMs: 5,
    journal: {
      appendReceipt: async () => {
        receipts++;
      },
    },
  });
  queue.tryEnqueue(receipt(), {
    ...completion,
    actualTokenUnits: 15,
    reconcileDurableUsage: async () => redis.promise,
  });
  await delay(1);
  now = 6;
  assert.equal(queue.snapshot().undurable, 0);
  assert.equal(queue.canAdmit(), true);
  queue.tryEnqueue(receipt('b'), completion);
  await delay(1);
  assert.equal(receipts, 2);
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().undurable, 0);
  redis.resolve();
  await queue.close();
});

test('pending liabilities remain separated by currency and metadata cannot override frozen price', async () => {
  const ack = deferred();
  const queue = new FastReceiptQueue({ journal: { appendReceipt: async () => ack.promise } });
  queue.tryEnqueue(receipt(), completion);
  const yen = receipt('yen');
  assert.ok(yen.verification);
  Object.assign(yen.verification.priceSnapshot.customerPrice, { currency: 'JPY' });
  queue.tryEnqueue(yen, { ...completion, currency: 'JPY' });
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '144', JPY: '144' });
  assert.throws(() => queue.tryEnqueue(receipt('invalid'), { ...completion, currency: 'JPY' }), /COMPLETION/);
  ack.resolve();
  await queue.close();
});

test('phase counters separate slot waits, port awaits and total residence with exact monotonic durations', async () => {
  let now = 0;
  const receipts = [deferred(), deferred()];
  const reconciles = [deferred(), deferred()];
  let calls = 0;
  const observed: ReturnType<FastReceiptQueue['snapshot']>[] = [];
  const queue = new FastReceiptQueue({
    workers: 1,
    now: () => now,
    observe: (snapshot) => observed.push(snapshot),
    journal: { appendReceipt: async () => receipts[calls++].promise },
  });
  queue.tryEnqueue(receipt('first'), {
    ...completion,
    actualTokenUnits: 15,
    reconcileDurableUsage: async () => reconciles[0].promise,
  });
  now = 5;
  queue.tryEnqueue(receipt('second'), {
    ...completion,
    actualTokenUnits: 15,
    reconcileDurableUsage: async () => reconciles[1].promise,
  });
  assert.equal(queue.snapshot().receiptAwaitCount, 0, 'a pending attempt is not a completed duration sample');
  now = 10;
  receipts[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  now = 20;
  receipts[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  now = 30;
  reconciles[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  now = 40;
  reconciles[1].resolve();
  await queue.close();
  const result = queue.snapshot();
  for (const [prefix, count, sum, last, max] of [
    ['receiptQueueWait', 2, 5, 5, 5],
    ['receiptAwait', 2, 20, 10, 10],
    ['reconciliationQueueWait', 2, 10, 10, 10],
    ['reconciliationAwait', 2, 30, 10, 20],
    ['residence', 2, 65, 35, 35],
  ] as const) {
    assert.equal(result[`${prefix}Count`], count, prefix);
    assert.equal(result[`${prefix}SumMs`], sum, prefix);
    assert.equal(result[`${prefix}LastMs`], last, prefix);
    assert.equal(result[`${prefix}MaxMs`], max, prefix);
    let priorCount = 0,
      sampledSum = 0;
    for (const snapshot of observed) {
      const delta = snapshot[`${prefix}Count`] - priorCount;
      assert.ok(delta === 0 || delta === 1, 'every completion remains separately observable');
      if (delta === 1) sampledSum += snapshot[`${prefix}LastMs`];
      priorCount = snapshot[`${prefix}Count`];
    }
    assert.equal(sampledSum, sum, 'count deltas recover fixed-size adapter histogram samples');
  }
  assert.equal(result.completedWithoutReconciliation, 0);
});

test('retry phase samples include backoff wait but distinguish failed attempts from success', async () => {
  let now = 0;
  const firstAttempt = deferred();
  const secondAttempt = deferred();
  const retryObserved = deferred();
  const secondStarted = deferred();
  let calls = 0;
  const queue = new FastReceiptQueue({
    now: () => now,
    retryBaseMs: 1,
    retryMaxMs: 1,
    observe: (snapshot) => {
      if (snapshot.retries === 1) retryObserved.resolve();
    },
    journal: {
      appendReceipt: async () => {
        if (++calls === 1) {
          await firstAttempt.promise;
          throw new Error('lost ACK');
        }
        secondStarted.resolve();
        await secondAttempt.promise;
      },
    },
  });
  queue.tryEnqueue(receipt(), completion);
  now = 4;
  firstAttempt.resolve();
  await retryObserved.promise;
  assert.equal(queue.snapshot().receiptAwaitCount, 1);
  assert.equal(queue.snapshot().receiptAwaitSumMs, 4);
  assert.equal(queue.snapshot().durable, 0);
  now = 9;
  // A pending drain owns the otherwise unref'ed bounded retry timer.
  const drain = queue.close();
  await secondStarted.promise;
  now = 14;
  secondAttempt.resolve();
  await drain;
  const result = queue.snapshot();
  assert.equal(result.retries, 1);
  assert.equal(result.durable, 1);
  assert.equal(result.receiptQueueWaitCount, 2);
  assert.equal(result.receiptQueueWaitSumMs, 5);
  assert.equal(result.receiptAwaitCount, 2);
  assert.equal(result.receiptAwaitSumMs, 9);
  assert.equal(result.residenceSumMs, 14);
  assert.equal(result.completedWithoutReconciliation, 1);
  assert.equal(result.reconciliationQueueWaitCount, 0);
  assert.equal(result.reconciliationAwaitCount, 0);
});

test('phase counters work without an observer and never fabricate durations for hung or undefined TPM work', async () => {
  let now = 100;
  const ack = deferred();
  const queue = new FastReceiptQueue({ now: () => now, journal: { appendReceipt: async () => ack.promise } });
  queue.tryEnqueue(receipt(), completion);
  now = 105;
  assert.equal(queue.snapshot().receiptAwaitCount, 0);
  assert.equal(queue.snapshot().residenceCount, 0);
  ack.resolve();
  await queue.close();
  const result = queue.snapshot();
  assert.equal(result.receiptAwaitSumMs, 5);
  assert.equal(result.residenceSumMs, 5);
  assert.equal(result.completedWithoutReconciliation, 1);
  assert.equal(result.reconciliationAwaitCount, 0);
  assert.equal(result.reconciliationAwaitSumMs, 0);
  assert.doesNotMatch(JSON.stringify(result), /intent-a|tenant-a|request-/);
});

test('reconciliation retry timing never re-counts receipt ACK or completes residence early', async () => {
  let now = 0;
  const ack = deferred(),
    first = deferred(),
    second = deferred(),
    retryObserved = deferred(),
    restarted = deferred();
  let calls = 0;
  const observed: ReturnType<FastReceiptQueue['snapshot']>[] = [];
  const queue = new FastReceiptQueue({
    now: () => now,
    retryBaseMs: 1,
    retryMaxMs: 1,
    journal: { appendReceipt: async () => ack.promise },
    observe: (snapshot) => {
      observed.push(snapshot);
      if (snapshot.reconciliationRetries === 1) retryObserved.resolve();
    },
  });
  queue.tryEnqueue(receipt(), {
    ...completion,
    actualTokenUnits: 15,
    reconcileDurableUsage: async () => {
      if (++calls === 1) {
        await first.promise;
        throw new Error('Redis ACK unavailable');
      }
      restarted.resolve();
      await second.promise;
    },
  });
  now = 5;
  ack.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  now = 8;
  first.resolve();
  await retryObserved.promise;
  assert.equal(queue.snapshot().residenceCount, 0);
  now = 14;
  const drain = queue.close();
  await restarted.promise;
  now = 20;
  second.resolve();
  await drain;
  const result = queue.snapshot();
  assert.equal(result.receiptAwaitCount, 1);
  assert.equal(result.receiptAwaitSumMs, 5);
  assert.equal(result.reconciliationAwaitCount, 2);
  assert.equal(result.reconciliationAwaitSumMs, 9);
  assert.equal(result.reconciliationQueueWaitSumMs, 6);
  assert.equal(result.reconciliationRetries, 1);
  assert.equal(result.residenceSumMs, 20);
  for (const snapshot of observed) {
    assert.equal(snapshot.receiptAwaitCount, snapshot.durable + snapshot.retries + snapshot.conflicts);
    assert.equal(
      snapshot.reconciliationAwaitCount,
      snapshot.completed - snapshot.completedWithoutReconciliation + snapshot.reconciliationRetries,
    );
    assert.equal(snapshot.residenceCount, snapshot.completed);
  }
});
