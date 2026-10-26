import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calculateFastReceiptCharge,
  fastJournalCanonicalJson,
  fastJournalDigest,
} from '../../../../src/saas/gateway/fast/journal.js';
import { priceFixture } from './journal-fixture.js';

test('fast receipt money remains exact beyond Number.MAX_SAFE_INTEGER and survives JSON', () => {
  const snapshot = priceFixture('9007199254740993');
  const roundtrip = JSON.parse(fastJournalCanonicalJson(snapshot));
  assert.equal(
    calculateFastReceiptCharge(roundtrip, { inputTotal: '9007199254740993', outputTotal: '0' }),
    9007199254740993n,
  );
  assert.equal(fastJournalDigest({ b: 2n, a: 'x' }), fastJournalDigest({ a: 'x', b: '2' }));
  assert.throws(() => fastJournalCanonicalJson({ lossy: Number.MAX_SAFE_INTEGER + 1 }), /INVALID_JSON/);
});
test('incomplete, unsupported, over-bound and multiplier usage cannot settle', () => {
  const snapshot = priceFixture();
  const invalid: Readonly<Record<string, string | null>>[] = [
    { inputTotal: null, outputTotal: '1' },
    { inputTotal: '81', outputTotal: '0' },
    { inputTotal: '2', outputTotal: '0', cacheRead: '1' },
  ];
  for (const usage of invalid) assert.throws(() => calculateFastReceiptCharge(snapshot, usage));
  assert.throws(() =>
    calculateFastReceiptCharge(
      { ...snapshot, customerPrice: { ...snapshot.customerPrice, tokenMultipliers: {} } },
      { inputTotal: '1', outputTotal: '0' },
    ),
  );
});

test('cache aggregate plus TTL detail is priced once, reasoning remains included in output and mismatched aggregates fail', () => {
  const snapshot = priceFixture('20', '10');
  const usage = {
    inputTotal: '10',
    inputUncached: '2',
    cacheRead: '3',
    cacheWrite: '5',
    cacheWrite5m: '4',
    cacheWrite1h: '1',
    outputTotal: '7',
    reasoningOutput: '6',
  };
  assert.equal(calculateFastReceiptCharge(snapshot, usage), 17n);
  assert.throws(() => calculateFastReceiptCharge(snapshot, { ...usage, cacheWrite: '6' }), /INCONSISTENT_USAGE/);
  assert.throws(() => calculateFastReceiptCharge(snapshot, { ...usage, reasoningOutput: '8' }));
});
