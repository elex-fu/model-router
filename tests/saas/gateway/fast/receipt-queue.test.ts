import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastReceiptInput } from '../../../../src/saas/gateway/fast/executor.js';
import { fastJournalCanonicalJson } from '../../../../src/saas/gateway/fast/journal.js';
import { getPreparedFastReceipt, prepareFastReceipt } from '../../../../src/saas/gateway/fast/prepared-receipt.js';
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

test('duplicates and rejected receipts do not freeze evidence; pressure never bypasses validation', async (t) => {
  for (const pressure of ['entries', 'bytes', 'tenant', 'stopped', 'age'] as const) {
    await t.test(pressure, async (t) => {
      const ack = deferred();
      const original = receipt('intent-\u00e9');
      const bytes = Buffer.byteLength(fastJournalCanonicalJson(original)) * 2 + 256;
      let calls = 0;
      let now = 0;
      const queue = new FastReceiptQueue({
        maxEntries: pressure === 'entries' ? 1 : 2,
        maxBytes: pressure === 'bytes' ? bytes : bytes * 2,
        maxPerTenant: pressure === 'tenant' ? 1 : 2,
        maxAgeMs: 5,
        now: () => now,
        journal: {
          appendReceipt: async () => {
            calls++;
            await ack.promise;
          },
        },
      });
      const freeze = t.mock.method(Object, 'freeze');
      const frozenReceiptCount = () =>
        freeze.mock.calls.filter(
          ({ arguments: [value] }) => typeof value === 'object' && value !== null && Object.hasOwn(value, 'intentId'),
        ).length;
      try {
        assert.equal(queue.tryEnqueue(original, completion), true);
        assert.equal(frozenReceiptCount(), 1);
        assert.equal(queue.snapshot().bytes, bytes, 'canonical UTF-8 evidence is charged exactly twice plus envelope');
        if (pressure === 'stopped') queue.stopAccepting();
        if (pressure === 'age') now = 6;

        assert.equal(queue.tryEnqueue(original, completion), true);
        assert.throws(() => queue.tryEnqueue({ ...original, usageDigest: 'b'.repeat(64) }, completion), /CONFLICT/);
        assert.throws(
          () => queue.tryEnqueue(original, { ...completion, retainedLiabilityMinorUnits: '145' }),
          /CONFLICT/,
        );
        for (const input of [original, receipt('new')]) {
          assert.throws(() => queue.tryEnqueue({ ...input, chargeMinorUnits: '99' }, completion), /INVALID_PROOF/);
          assert.throws(() => queue.tryEnqueue({ ...input, usageDigest: 'invalid' }, completion), /INVALID/);
          assert.throws(
            () => queue.tryEnqueue({ ...input, usage: { ...input.usage, body: '0' } }, completion),
            /INVALID/,
          );
          assert.throws(() => queue.tryEnqueue(input, { ...completion, currency: 'JPY' }), /INVALID_COMPLETION/);
          assert.throws(
            () =>
              queue.tryEnqueue(input, { ...completion, actualTokenUnits: 10, reconcileDurableUsage: async () => {} }),
            /INVALID_COMPLETION/,
          );
        }
        assert.equal(queue.snapshot().fallbacks, 0, 'invalid or duplicate attempts do not count as fallback');
        assert.equal(queue.tryEnqueue(receipt('new'), completion), false);
        assert.equal(queue.snapshot().fallbacks, 1, 'one capacity rejection is one fallback');
        assert.equal(frozenReceiptCount(), 1, 'only accepted evidence requires recursive freezing');
        assert.equal(calls, 1, 'neither duplicate nor rejected evidence starts another append');
        assert.equal(queue.snapshot().accepted, 1);
        assert.equal(queue.snapshot().pending, 1);
        assert.equal(queue.snapshot().bytes, bytes);
        assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '144' });
      } finally {
        freeze.mock.restore();
        ack.resolve();
        await queue.close();
      }
      assert.equal(queue.snapshot().completed, 1);
      assert.equal(queue.snapshot().bytes, 0);
    });
  }
});

test('completion getters cannot change canonical evidence or tenant accounting before acceptance', async () => {
  const ack = deferred();
  const original = receipt();
  const captured = JSON.parse(fastJournalCanonicalJson(original)) as FastReceiptInput;
  const observed: FastReceiptInput[] = [];
  const queue = new FastReceiptQueue({
    maxPerTenant: 1,
    journal: {
      appendReceipt: async (value) => {
        observed.push(value);
        await ack.promise;
      },
    },
  });
  try {
    assert.equal(
      queue.tryEnqueue(original, {
        ...completion,
        get currency() {
          Object.assign(original, { intentId: 'mutated', tenantId: 'other' });
          Object.assign(original.usage, { inputTotal: '900' });
          assert.ok(original.verification);
          Object.assign(original.verification.priceSnapshot.customerPrice, { currency: 'JPY' });
          return 'USD';
        },
      }),
      true,
    );
    assert.deepEqual(observed, [captured]);
    assert.equal(queue.tryEnqueue(captured, completion), true, 'duplicate key comes from the canonical snapshot');
    assert.equal(queue.tryEnqueue(receipt('next'), completion), false, 'captured tenant still owns its capacity');
    assert.equal(queue.snapshot().accepted, 1);
    assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '144' });
  } finally {
    ack.resolve();
    await queue.close();
  }
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
        assert.ok(Object.isFrozen(value), 'accepted evidence is frozen before the first append');
        assert.ok(Object.isFrozen(value.usage));
        assert.ok(Object.isFrozen(value.verification));
        assert.ok(Object.isFrozen(value.verification?.priceSnapshot));
        assert.ok(Object.isFrozen(value.verification?.priceSnapshot.customerPrice));
        assert.ok(Object.isFrozen(value.verification?.priceSnapshot.customerPrice.rates.input));
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
  assert.ok(original.verification.priceSnapshot.customerPrice.rates.input);
  Object.assign(original.verification.priceSnapshot.customerPrice.rates.input, { numeratorMinorUnits: '900' });
  await queue.close();
  assert.equal(observed.length, 2);
  assert.equal(observed[0], observed[1]);
  assert.equal(observed[0].usage.inputTotal, '10');
  assert.equal(observed[0].verification?.priceSnapshot.customerPrice.currency, 'USD');
  assert.equal(observed[0].verification?.priceSnapshot.customerPrice.rates.input?.numeratorMinorUnits, '1');
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

test('ACK compaction preserves full-proof duplicate identity and all original capacity reservations', async (t) => {
  for (const pressure of ['entries', 'bytes', 'tenant'] as const) {
    await t.test(pressure, async () => {
      const redis = deferred();
      const original = receipt();
      const reservedBytes = Buffer.byteLength(fastJournalCanonicalJson(original)) * 2 + 256;
      let calls = 0;
      const queue = new FastReceiptQueue({
        maxEntries: pressure === 'entries' ? 1 : 2,
        maxBytes: pressure === 'bytes' ? reservedBytes : reservedBytes * 2,
        maxPerTenant: pressure === 'tenant' ? 1 : 2,
        journal: {
          appendReceipt: async () => {
            calls++;
          },
        },
      });
      const completed = { ...completion, actualTokenUnits: 15, reconcileDurableUsage: async () => redis.promise };
      try {
        assert.equal(queue.tryEnqueue(original, completed), true);
        await new Promise((resolve) => setImmediate(resolve));
        const compact = queue.snapshot();
        assert.equal(compact.durable, 1);
        assert.equal(compact.undurable, 0);
        assert.deepEqual(compact.undurableLiabilityByCurrency, {});
        assert.equal(compact.pending, 1);
        assert.equal(compact.reconciliationRunning, 1);
        assert.equal(compact.bytes, reservedBytes, 'physical compaction does not free admission budget');
        assert.equal(queue.tryEnqueue(original, completed), true);
        const changedProof = JSON.parse(fastJournalCanonicalJson(original)) as FastReceiptInput;
        assert.ok(changedProof.verification);
        Object.assign(changedProof.verification.priceSnapshot.customerPrice, { version: 2 });
        assert.throws(
          () => queue.tryEnqueue(changedProof, completed),
          /CONFLICT/,
          'proof is absent from journal v1 digest',
        );
        assert.throws(() => queue.tryEnqueue({ ...original, usageDigest: 'b'.repeat(64) }, completed), /CONFLICT/);
        assert.throws(() => queue.tryEnqueue({ ...original, httpStatus: 201 }, completed), /CONFLICT/);
        assert.throws(
          () => queue.tryEnqueue(original, { ...completed, retainedLiabilityMinorUnits: '145' }),
          /CONFLICT/,
        );
        assert.throws(
          () => queue.tryEnqueue(original, completion),
          /CONFLICT/,
          'completion token identity is preserved',
        );
        assert.equal(queue.tryEnqueue(receipt('next'), completion), false);
        assert.equal(calls, 1, 'neither duplicate nor conflicting/rejected work starts SQL');
        assert.equal(queue.snapshot().bytes, reservedBytes);
        assert.equal(queue.snapshot().fallbacks, 1);
      } finally {
        redis.resolve();
        await queue.close();
      }
      assert.equal(queue.snapshot().bytes, 0);
      assert.equal(queue.snapshot().pending, 0);
    });
  }
});

test('compacted running and retry-held reconciliation remain drain-owned after stop and timeout', async () => {
  const first = deferred(),
    second = deferred(),
    retried = deferred();
  let calls = 0;
  const queue = new FastReceiptQueue({
    drainTimeoutMs: 10,
    retryBaseMs: 1,
    retryMaxMs: 1,
    observe: () => {},
    journal: { appendReceipt: async () => {} },
  });
  queue.tryEnqueue(receipt(), {
    ...completion,
    actualTokenUnits: 15,
    reconcileDurableUsage: async () => {
      if (++calls === 1) {
        await first.promise;
        throw new Error('lost Redis ACK');
      }
      retried.resolve();
      await second.promise;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const bytes = queue.snapshot().bytes;
  await assert.rejects(queue.close(), /DRAIN_TIMEOUT/);
  assert.equal(queue.snapshot().pending, 1);
  assert.equal(queue.snapshot().bytes, bytes);
  assert.equal(queue.snapshot().undurable, 0);
  assert.equal(queue.canAdmit(), false);
  first.resolve();
  // A referenced timeout keeps this test alive while the retry timer is unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await retried.promise;
    assert.equal(queue.snapshot().reconciliationRetries, 1);
    assert.equal(queue.snapshot().receiptAwaitCount, 1);
    assert.equal(queue.snapshot().pending, 1);
    assert.equal(queue.snapshot().bytes, bytes);
    second.resolve();
    await queue.close();
  } finally {
    clearTimeout(keepAlive);
    second.resolve();
  }
  assert.equal(queue.snapshot().completed, 1);
  assert.equal(queue.snapshot().pending, 0);
  assert.equal(queue.snapshot().bytes, 0);
});

test('out-of-order ACKs and compaction preserve oldest ages and incremental currency ownership', async () => {
  let now = 0;
  const ack = [deferred(), deferred(), deferred()];
  const redis = deferred();
  let calls = 0;
  const queue = new FastReceiptQueue({
    workers: 3,
    maxAgeMs: 20,
    now: () => now,
    journal: { appendReceipt: async () => ack[calls++].promise },
  });
  queue.tryEnqueue(receipt('oldest'), {
    ...completion,
    actualTokenUnits: 15,
    reconcileDurableUsage: async () => redis.promise,
  });
  now = 5;
  const yen = receipt('yen');
  assert.ok(yen.verification);
  Object.assign(yen.verification.priceSnapshot.customerPrice, { currency: 'JPY' });
  queue.tryEnqueue(yen, { ...completion, currency: 'JPY' });
  now = 10;
  queue.tryEnqueue(receipt('newest'), completion);
  now = 15;
  ack[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '288' });
  assert.equal(queue.snapshot().oldestUndurableAgeMs, 15);
  now = 20;
  assert.equal(queue.canAdmit(), false);
  ack[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.snapshot().oldestAgeMs, 20, 'oldest total task is now compacted');
  assert.equal(queue.snapshot().oldestUndurableAgeMs, 10);
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '144' });
  assert.equal(queue.canAdmit(), true);
  now = 30;
  assert.equal(queue.canAdmit(), false, 'remaining undurable evidence owns the age bound');
  ack[2].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.snapshot().oldestUndurableAgeMs, 0);
  assert.equal(queue.snapshot().oldestAgeMs, 30);
  assert.equal(queue.canAdmit(), true);
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, {});
  redis.resolve();
  await queue.close();
  assert.equal(queue.snapshot().oldestAgeMs, 0);
});

test('same-turn completions coalesce one bounded pump without coalescing attempt observations', async (t) => {
  const ack = deferred(),
    tail = deferred();
  let calls = 0;
  const observed: number[] = [];
  const queue = new FastReceiptQueue({
    workers: 2,
    observe: (snapshot) => observed.push(snapshot.receiptAwaitCount),
    journal: { appendReceipt: async () => (++calls <= 2 ? ack.promise : tail.promise) },
  });
  for (let index = 0; index < 4; index++) queue.tryEnqueue(receipt(String(index)), completion);
  assert.equal(calls, 2);
  const schedule = t.mock.method(globalThis, 'queueMicrotask');
  ack.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(schedule.mock.callCount(), 1, 'two settled attempts request only one scheduler callback');
  schedule.mock.restore();
  assert.equal(calls, 4);
  assert.ok(observed.includes(1), 'the first settled attempt remains individually observable');
  assert.ok(observed.includes(2));
  tail.resolve();
  await queue.close();
  assert.equal(queue.snapshot().completed, 4);
});

test('readiness and snapshot do not scan pending tasks to compute age or liabilities', async (t) => {
  const ack = deferred();
  const queue = new FastReceiptQueue({ journal: { appendReceipt: async () => ack.promise } });
  for (let index = 0; index < 32; index++) queue.tryEnqueue(receipt(String(index)), completion);
  const original = Map.prototype.values;
  let nextCalls = 0;
  const values = t.mock.method(Map.prototype, 'values', function <K, V>(this: Map<K, V>) {
    const iterator = original.call(this) as MapIterator<V>;
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      nextCalls++;
      return next();
    };
    return iterator;
  });
  try {
    assert.equal(queue.canAdmit(), true);
    assert.equal(queue.snapshot().undurable, 32);
    assert.equal(nextCalls, 3, 'one oldest-undurable read plus two oldest snapshot reads');
  } finally {
    values.mock.restore();
    ack.resolve();
    await queue.close();
  }
});

test('ACK releases owned receipt, price and prepared metadata while compact reconciliation remains live', {
  skip: typeof global.gc !== 'function' ? 'run with --expose-gc for ownership verification' : false,
}, async () => {
  const redis = deferred();
  const queue = new FastReceiptQueue({ journal: { appendReceipt: async () => {} } });
  const references = (() => {
    const original = receipt();
    assert.ok(original.verification);
    const owned = prepareFastReceipt({
      intentId: original.intentId,
      requestId: original.requestId,
      tenantId: original.tenantId,
      httpStatus: 200,
      usage: original.usage,
      priceSnapshot: original.verification.priceSnapshot,
      maxCostMinorUnits: completion.retainedLiabilityMinorUnits,
    });
    queue.tryEnqueue(owned, { ...completion, actualTokenUnits: 15, reconcileDurableUsage: async () => redis.promise });
    const prepared = getPreparedFastReceipt(owned);
    assert.ok(prepared);
    assert.ok(owned.verification);
    return [new WeakRef(owned), new WeakRef(prepared), new WeakRef(owned.verification.priceSnapshot)];
  })();
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc?.();
      if (references.every((reference) => reference.deref() === undefined)) break;
    }
    assert.equal(queue.snapshot().durable, 1);
    assert.equal(queue.snapshot().pending, 1);
    assert.equal(queue.snapshot().reconciliationRunning, 1);
    assert.ok(
      references.every((reference) => reference.deref() === undefined),
      'no queue/worker closure may retain rich evidence after ACK',
    );
    assert.ok(queue.snapshot().bytes > 0, 'budget reservation survives physical reclamation');
  } finally {
    redis.resolve();
    await queue.close();
  }
});

test('zero-valued currency aggregates retain their entry count until the last ACK', async () => {
  const ack = [deferred(), deferred()];
  let calls = 0;
  const queue = new FastReceiptQueue({ workers: 2, journal: { appendReceipt: async () => ack[calls++].promise } });
  for (const id of ['zero-a', 'zero-b']) {
    const input = { ...receipt(id), outcome: 'failed' as const, chargeMinorUnits: '0', verification: undefined };
    queue.tryEnqueue(input, { retainedLiabilityMinorUnits: '0', currency: 'USD' });
  }
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '0' });
  ack[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, { USD: '0' });
  ack[0].resolve();
  await queue.close();
  assert.deepEqual(queue.snapshot().undurableLiabilityByCurrency, {});
});
