import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import type { FastReceiptInput } from '../../../../src/saas/gateway/fast/executor.js';
import {
  calculateFastReceiptCharge,
  fastJournalCanonicalJson,
  fastJournalDigest,
  PostgresFastGatewayJournal,
} from '../../../../src/saas/gateway/fast/journal.js';
import {
  captureFastReceiptCustomerPrice,
  getPreparedFastReceipt,
  prepareFastReceipt,
  prepareFastReceiptPrice,
} from '../../../../src/saas/gateway/fast/prepared-receipt.js';
import { FastReceiptQueue } from '../../../../src/saas/gateway/fast/receipt-queue.js';
import { priceFixture } from './journal-fixture.js';

function facts() {
  return {
    intentId: 'intent-é',
    requestId: 'request-a',
    tenantId: 'tenant-a',
    httpStatus: 200,
    // Executor's historical order is intentionally different from sorted canonical JSON.
    usage: {
      inputTotal: '10',
      inputUncached: '10',
      cacheRead: '0',
      cacheWrite: '0',
      cacheWrite5m: '0',
      cacheWrite1h: '0',
      outputTotal: '5',
      reasoningOutput: '0',
    },
    priceSnapshot: priceFixture('80', '64'),
    maxCostMinorUnits: '144',
  };
}
function database(query: SaasDatabase['query']): SaasDatabase {
  return {
    query,
    transaction: async () => {
      throw new Error('unexpected settlement');
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
}
const completion = { retainedLiabilityMinorUnits: '144', currency: 'USD' };

test('prepared paid, BYOK and failed receipts preserve exact historical digests and SQL parameters', async () => {
  for (const mode of ['paid', 'byok', 'failed'] as const) {
    const input = facts();
    const status = mode === 'failed' ? 429 : 200;
    const usage = mode === 'failed' ? {} : input.usage;
    const price = mode === 'byok' ? null : prepareFastReceiptPrice(input.priceSnapshot);
    const receipt = prepareFastReceipt({ ...input, httpStatus: status, usage, priceSnapshot: price });
    const prepared = getPreparedFastReceipt(receipt);
    assert.ok(prepared);
    const charge = mode === 'paid' ? '15' : '0';
    const { verification, ...evidence } = receipt;
    assert.equal(receipt.chargeMinorUnits, charge);
    assert.equal(
      receipt.usageDigest,
      createHash('sha256').update(JSON.stringify({ status, usage, charge })).digest('hex'),
    );
    assert.equal(prepared.receiptDigest, fastJournalDigest(evidence));
    assert.equal(prepared.canonical, fastJournalCanonicalJson(receipt));
    assert.equal(verification?.priceSnapshot, mode === 'paid' ? price : undefined);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.usage));
    assert.ok(Object.isFrozen(prepared));
    assert.ok(Object.isFrozen(prepared.values));
    const calls: (readonly unknown[])[] = [];
    const journal = new PostgresFastGatewayJournal(
      database(async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
        if (sql.includes('fast-journal:append-receipt')) {
          calls.push(values ?? []);
          // Trusted preparation never replaces persisted identity/price/maximum equivalence.
          assert.match(sql, /i\.id=\$1 AND i\.tenant_id=\$2 AND i\.request_id=\$3/);
          assert.match(sql, /i\.price_snapshot=\$11::jsonb/);
          assert.match(sql, /\$5::bigint < i\.max_cost_minor_units/);
        }
        return { rows: [], rowCount: 1 };
      }),
      { allocationOwner: 'prepared-test' },
    );
    try {
      await journal.appendReceipt(receipt);
      await journal.appendReceipt(JSON.parse(JSON.stringify(receipt)));
      assert.equal(calls[0], prepared.values, 'exact owned SQL tuple is reused, not rebuilt');
      assert.notEqual(calls[1], prepared.values, 'deserialized receipt runs public validation');
      assert.deepEqual(calls[0], calls[1], 'public and owned paths have identical financial SQL facts');
    } finally {
      await journal.close({ drain: false });
    }
  }
});

test('prepared facts detach aliases, reject accessors/extensions and retain exact bigint pricing and maximum bounds', () => {
  const input = facts();
  const price = prepareFastReceiptPrice(input.priceSnapshot);
  const receipt = prepareFastReceipt({ ...input, priceSnapshot: price });
  input.usage.inputTotal = '900';
  Object.assign(input.priceSnapshot.customerPrice.rates.input ?? {}, { numeratorMinorUnits: '900' });
  assert.equal(receipt.usage.inputTotal, '10');
  assert.equal(receipt.verification?.priceSnapshot.customerPrice.rates.input?.numeratorMinorUnits, '1');
  assert.throws(() => Object.assign(receipt.usage, { inputTotal: '900' }));
  assert.throws(() => Object.assign(getPreparedFastReceipt(receipt)?.values ?? [], { 4: '0' }));
  assert.throws(() => prepareFastReceipt({ ...facts(), maxCostMinorUnits: '14' }), /exceeds frozen price bound/);
  assert.throws(
    () => prepareFastReceipt({ ...facts(), usage: { inputTotal: '81', outputTotal: '0' } }),
    /EXCEEDS_BOUND/,
  );
  assert.throws(
    () => prepareFastReceipt({ ...facts(), usage: { inputTotal: '10', outputTotal: '5', privateBody: '0' } }),
    /INVALID/,
  );
  for (const usage of [false, 0, '', null]) {
    assert.throws(
      () =>
        prepareFastReceipt({
          ...facts(),
          priceSnapshot: null,
          usage: usage as unknown as Record<string, string | null>,
        }),
      /INVALID/,
    );
  }
  assert.throws(
    () =>
      prepareFastReceipt({
        ...facts(),
        priceSnapshot: null,
        usage: { inputTotal: '9223372036854775808', outputTotal: '0' },
      }),
    { code: 'INVALID_AMOUNT' },
  );
  const getterPrice = facts();
  Object.defineProperty(getterPrice.priceSnapshot.customerPrice.rates, 'input', {
    enumerable: true,
    get: () => ({ numeratorMinorUnits: '1', denominatorUnits: '1' }),
  });
  assert.throws(() => prepareFastReceipt(getterPrice), /INVALID/);
  const secretPrice = facts();
  Object.assign(secretPrice.priceSnapshot.customerPrice, { credential: 'do-not-retain' });
  assert.throws(() => prepareFastReceipt(secretPrice), /INVALID_PROOF/);
  const symbolPrice = facts();
  Object.assign(symbolPrice.priceSnapshot, { [Symbol('forged')]: true });
  assert.throws(() => prepareFastReceipt(symbolPrice), /INVALID/);
  const large = prepareFastReceipt({
    ...facts(),
    usage: { inputTotal: '9007199254740993', outputTotal: '0' },
    priceSnapshot: priceFixture('9007199254740993'),
    maxCostMinorUnits: '9007199254740993',
  });
  assert.equal(large.chargeMinorUnits, '9007199254740993');
  assert.equal(calculateFastReceiptCharge(large.verification?.priceSnapshot, large.usage), 9007199254740993n);
});

test('frozen copies, prototypes, deserialization and proxy wrappers cannot forge ownership or skip proof validation', async () => {
  const receipt = prepareFastReceipt(facts());
  assert.deepEqual(Object.getOwnPropertySymbols(receipt), []);
  for (const untrusted of [
    Object.freeze({ ...receipt }),
    Object.create(receipt),
    JSON.parse(JSON.stringify(receipt)),
    new Proxy(receipt, {}),
  ])
    assert.equal(getPreparedFastReceipt(untrusted), undefined);
  const forged = Object.freeze({
    ...receipt,
    chargeMinorUnits: '0',
    validated: true,
    prepared: getPreparedFastReceipt(receipt),
  });
  const queue = new FastReceiptQueue({
    journal: { appendReceipt: async () => assert.fail('forged proof must not append') },
  });
  assert.throws(() => queue.tryEnqueue(forged, completion), /INVALID_PROOF/);
  assert.equal(queue.snapshot().accepted, 0);
  await queue.close();
  const calls: (readonly unknown[])[] = [];
  const journal = new PostgresFastGatewayJournal(
    database(async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
      if (sql.includes('fast-journal:append-receipt')) calls.push(values ?? []);
      return { rows: [], rowCount: 1 };
    }),
    { allocationOwner: 'untrusted-test' },
  );
  try {
    await journal.appendReceipt(forged);
    await journal.appendReceipt({
      ...receipt,
      get verification(): never {
        throw new Error('unreadable optional proof');
      },
    });
    await journal.appendReceipt({ ...receipt, chargeMinorUnits: '0', verification: { priceSnapshot: null } });
    assert.deepEqual(
      calls.map((v) => v[9]),
      ['pending', 'pending', 'pending'],
      'bad optional proof preserves durable evidence without compaction',
    );
    assert.deepEqual(
      calls.map((v) => v[10]),
      [null, null, null],
    );
    await assert.rejects(journal.appendReceipt({ ...receipt, usageDigest: 'bad' }), /INVALID_DIGEST/);
    await assert.rejects(journal.appendReceipt({ ...receipt, outcome: 'unknown' }), /UNKNOWN_CHARGE/);
    assert.equal(calls.length, 3);
  } finally {
    await journal.close({ drain: false });
  }
});

test('queue reuses owned evidence and cached payload budget through lost ACK retry and completion', async () => {
  const receipt = prepareFastReceipt(facts());
  const prepared = getPreparedFastReceipt(receipt);
  assert.ok(prepared);
  const expectedBytes =
    Buffer.byteLength(prepared.canonical) * 2 +
    Buffer.byteLength(String(prepared.values[5])) +
    Buffer.byteLength(String(prepared.values[10])) +
    Buffer.byteLength(prepared.receiptDigest) +
    512;
  assert.equal(prepared.retainedBytes, expectedBytes);
  let release!: () => void;
  const ack = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: FastReceiptInput[] = [];
  const order: string[] = [];
  const queue = new FastReceiptQueue({
    maxBytes: expectedBytes,
    retryBaseMs: 1,
    retryMaxMs: 1,
    journal: {
      appendReceipt: async (value) => {
        calls.push(value);
        order.push('receipt');
        await ack;
        if (calls.length === 1) throw new Error('lost ACK');
      },
    },
  });
  assert.equal(
    queue.tryEnqueue(receipt, {
      ...completion,
      actualTokenUnits: 15,
      reconcileDurableUsage: async (actual) => {
        assert.equal(actual, 15);
        order.push('reconcile');
      },
    }),
    true,
  );
  assert.equal(calls[0], receipt, 'queue takes the exact owned object before returning');
  assert.equal(queue.snapshot().bytes, expectedBytes);
  assert.equal(
    queue.tryEnqueue(receipt, { ...completion, actualTokenUnits: 15, reconcileDurableUsage: async () => {} }),
    true,
  );
  assert.throws(() => queue.tryEnqueue({ ...receipt, usageDigest: 'b'.repeat(64) }, completion), /CONFLICT/);
  assert.deepEqual(order, ['receipt']);
  release();
  await queue.close();
  assert.deepEqual(order, ['receipt', 'receipt', 'reconcile']);
  assert.equal(calls[1], receipt);
  assert.equal(getPreparedFastReceipt(calls[1]), prepared);
  assert.equal(queue.snapshot().bytes, 0);
  const full = new FastReceiptQueue({
    maxBytes: expectedBytes - 1,
    journal: { appendReceipt: async () => assert.fail('must fall back') },
  });
  assert.equal(full.tryEnqueue(receipt, completion), false);
  assert.equal(getPreparedFastReceipt(receipt), prepared, 'fallback does not discard reusable durable parameters');
  await full.close();
});

test('public journal snapshots getter-backed evidence once and retries identical values without trusting a proxy', async () => {
  const receipt = prepareFastReceipt(facts());
  let reads = 0;
  const publicReceipt = new Proxy(
    { ...receipt },
    {
      get(target, key, receiver) {
        if (key === 'chargeMinorUnits') return ++reads === 1 ? '15' : '0';
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const attempts: (readonly unknown[])[] = [];
  const journal = new PostgresFastGatewayJournal(
    database(async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
      if (sql.includes('fast-journal:append-receipt')) {
        attempts.push(values ?? []);
        if (attempts.length === 1) throw new Error('lost ACK');
        throw Object.assign(new Error('duplicate'), { code: '23505' });
      }
      if (sql.startsWith('SELECT receipt_digest'))
        return { rows: [{ receipt_digest: attempts[0][7] } as Row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }),
    { allocationOwner: 'getter-test' },
  );
  try {
    await journal.appendReceipt(publicReceipt);
    assert.equal(reads, 1);
    assert.equal(attempts[0], attempts[1]);
    assert.equal(attempts[0][4], '15');
    assert.deepEqual(attempts[0], getPreparedFastReceipt(receipt)?.values);
  } finally {
    await journal.close({ drain: false });
  }
});

test('native customer price is captured once and scalar envelopes reuse only exact private ownership', (t) => {
  const original = facts();
  const descriptor = t.mock.method(Object, 'getOwnPropertyDescriptor');
  const captured = captureFastReceiptCustomerPrice(original.priceSnapshot.customerPrice);
  const before = descriptor.mock.calls.length;
  const price = prepareFastReceiptPrice({ ...original.priceSnapshot, customerPrice: captured });
  const reads = descriptor.mock.calls.slice(before);
  assert.equal(price.customerPrice, captured);
  assert.notEqual(captured, original.priceSnapshot.customerPrice);
  assert.equal(reads.length, 4, 'only four wrapper fields are captured, never the owned price subtree again');
  assert.ok(reads.every(({ arguments: [value] }) => value !== captured && value !== captured.rates));
  assert.equal(captureFastReceiptCustomerPrice(captured), captured);
  descriptor.mock.restore();
  assert.notEqual(
    captureFastReceiptCustomerPrice(original.priceSnapshot.customerPrice),
    captured,
    'mutable/raw source identity is never memoized as trusted',
  );
  const bigintWrapper = prepareFastReceiptPrice({
    ...original.priceSnapshot,
    customerPrice: captured,
    maxInputTokens: 80n as unknown as string,
    maxOutputTokens: 64n as unknown as string,
  });
  assert.equal(bigintWrapper.maxInputTokens, '80');
  assert.equal(bigintWrapper.maxOutputTokens, '64');
  assert.equal(bigintWrapper.customerPrice, captured);
  const bigintReceipt = prepareFastReceipt({ ...original, priceSnapshot: bigintWrapper });
  assert.doesNotThrow(() => JSON.stringify(bigintReceipt));
  assert.equal(getPreparedFastReceipt(bigintReceipt)?.canonical, fastJournalCanonicalJson(bigintReceipt));

  const replay = prepareFastReceiptPrice({ ...price, customerPrice: { ...captured } });
  assert.notEqual(replay.customerPrice, captured, 'a copied caller price is not privately owned');
  assert.deepEqual(replay.customerPrice, captured);
  Object.assign(original.priceSnapshot.customerPrice.rates.input ?? {}, { numeratorMinorUnits: '900' });
  const receipt = prepareFastReceipt({ ...original, priceSnapshot: price });
  assert.equal(receipt.chargeMinorUnits, '15');
  assert.equal(receipt.verification?.priceSnapshot.customerPrice, captured);
  assert.equal(getPreparedFastReceipt(receipt)?.canonical, fastJournalCanonicalJson(receipt));
});

test('fixed usage capture rejects hidden, inherited, accessor and extension facts and reads input once', () => {
  for (const usage of [
    Object.assign(Object.create({ hidden: '1' }), facts().usage),
    Object.defineProperty({ ...facts().usage }, 'inputTotal', { get: () => '10', enumerable: true }),
    Object.defineProperty({ ...facts().usage }, 'hidden', { value: '1' }),
    { ...facts().usage, [Symbol('secret')]: '1' },
    { ...facts().usage, inputTotal: { valueOf: () => 10 } },
    { ...facts().usage, unexpected: '0' },
  ])
    assert.throws(() => prepareFastReceipt({ ...facts(), usage }), /INVALID/);
  const source = facts();
  let reads = 0;
  const receipt = prepareFastReceipt({
    ...source,
    get usage() {
      reads++;
      return source.usage;
    },
  });
  source.usage.inputTotal = '900';
  assert.equal(reads, 1);
  assert.equal(receipt.usage.inputTotal, '10');
  assert.equal(receipt.chargeMinorUnits, '15');
});

test('customer capture cannot turn injected __proto__ or copied ownership into trusted receipt evidence', () => {
  const input = facts();
  Object.defineProperty(input.priceSnapshot.customerPrice, '__proto__', {
    value: { injected: true },
    enumerable: true,
  });
  const captured = captureFastReceiptCustomerPrice(input.priceSnapshot.customerPrice);
  assert.equal(Object.getPrototypeOf(captured), Object.prototype);
  assert.ok(Object.hasOwn(captured, '__proto__'));
  assert.equal(Object.hasOwn(Object.prototype, 'injected'), false);
  assert.throws(() => prepareFastReceiptPrice({ ...input.priceSnapshot, customerPrice: captured }), /INVALID_PROOF/);
  for (const invalid of [
    Object.defineProperty({ ...facts().priceSnapshot.customerPrice }, 'id', { get: () => 'id', enumerable: true }),
    Object.assign(Object.create({ hidden: true }), facts().priceSnapshot.customerPrice),
  ])
    assert.throws(() => captureFastReceiptCustomerPrice(invalid), /INVALID/);
});
