import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  billingGroupSpendWindowStart,
  keyBudgetRollingCutoffs,
} from '../../../src/saas/billing/groups/spend-windows.js';

function utc(iso: string): Date {
  return new Date(iso);
}

test('daily windows bucket at UTC midnight', () => {
  assert.equal(billingGroupSpendWindowStart('daily', utc('2026-10-17T00:00:00.000Z')), '2026-10-17');
  assert.equal(billingGroupSpendWindowStart('daily', utc('2026-10-17T23:59:59.999Z')), '2026-10-17');
  assert.equal(billingGroupSpendWindowStart('daily', utc('2026-10-18T00:00:00.000Z')), '2026-10-18');
  // A local-timezone-hostile timestamp never shifts the bucket.
  assert.equal(billingGroupSpendWindowStart('daily', utc('2026-12-31T13:45:12.500Z')), '2026-12-31');
});

test('weekly windows bucket at ISO Monday', () => {
  // 2026-10-17 is a Saturday; its ISO week starts Monday 2026-10-12.
  assert.equal(billingGroupSpendWindowStart('weekly', utc('2026-10-17T12:00:00.000Z')), '2026-10-12');
  assert.equal(billingGroupSpendWindowStart('weekly', utc('2026-10-12T00:00:00.000Z')), '2026-10-12');
  assert.equal(billingGroupSpendWindowStart('weekly', utc('2026-10-11T23:59:59.999Z')), '2026-10-05');
  // Sunday belongs to the week starting the previous Monday.
  assert.equal(billingGroupSpendWindowStart('weekly', utc('2026-10-18T00:00:00.000Z')), '2026-10-12');
  // Year boundary: 2027-01-01 is a Friday; its week starts 2026-12-28.
  assert.equal(billingGroupSpendWindowStart('weekly', utc('2027-01-01T00:00:00.000Z')), '2026-12-28');
});

test('monthly windows bucket at UTC month start', () => {
  assert.equal(billingGroupSpendWindowStart('monthly', utc('2026-10-01T00:00:00.000Z')), '2026-10-01');
  assert.equal(billingGroupSpendWindowStart('monthly', utc('2026-10-31T23:59:59.999Z')), '2026-10-01');
  assert.equal(billingGroupSpendWindowStart('monthly', utc('2026-11-01T00:00:00.000Z')), '2026-11-01');
  assert.equal(billingGroupSpendWindowStart('monthly', utc('2028-02-29T12:00:00.000Z')), '2028-02-01');
});

test('invalid timestamps fail closed', () => {
  assert.throws(() => billingGroupSpendWindowStart('daily', new Date('not-a-date')), TypeError);
  assert.throws(() => keyBudgetRollingCutoffs(new Date('not-a-date')), TypeError);
});

test('rolling cutoffs are exact trailing intervals of the injected clock', () => {
  const at = utc('2026-10-17T12:34:56.789Z');
  const cutoffs = keyBudgetRollingCutoffs(at);
  assert.equal(cutoffs.fiveHour, '2026-10-17T07:34:56.789Z');
  assert.equal(cutoffs.sevenDay, '2026-10-10T12:34:56.789Z');
  // Exactly five hours earlier is still inside the window (>= semantics).
  assert.equal(keyBudgetRollingCutoffs(utc('2026-10-17T12:00:00.000Z')).fiveHour, '2026-10-17T07:00:00.000Z');
});
