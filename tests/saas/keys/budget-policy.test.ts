import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MINOR_UNITS } from '../../../src/saas/billing/money.js';
import {
  evaluateProxyKeyBudgetAdmission,
  ProxyKeyBudgetError,
  type ProxyKeyBudgetPolicy,
  type ProxyKeyBudgetUsage,
} from '../../../src/saas/keys/budget-policy.js';

function byokPolicy(daily: bigint | number | string | null, lifetime: bigint | number | string | null) {
  return { supplyMode: 'byok', tokenCaps: { daily, lifetime } } as const;
}

function byokUsage(
  daily: {
    settled: bigint | number | string;
    outstandingReserved: bigint | number | string;
    newReservation: bigint | number | string;
  },
  lifetime = { settled: 0n, outstandingReserved: 0n, newReservation: 0n },
) {
  return { supplyMode: 'byok', tokenUsage: { daily, lifetime } } as const;
}

function expectBudgetError(action: () => unknown, code: ProxyKeyBudgetError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof ProxyKeyBudgetError && error.code === code);
}

test('admits exactly at daily and lifetime token caps', () => {
  const result = evaluateProxyKeyBudgetAdmission(
    byokPolicy(10, 20),
    byokUsage(
      { settled: 3, outstandingReserved: 4, newReservation: 3 },
      { settled: 5n, outstandingReserved: '7', newReservation: 8 },
    ),
  );

  assert.deepEqual(result, { allowed: true });
});

test('a zero cap permits zero usage and denies any positive projected usage', () => {
  const zeroUsage = byokUsage({ settled: 0, outstandingReserved: 0, newReservation: 0 });
  assert.deepEqual(evaluateProxyKeyBudgetAdmission(byokPolicy(0, 0), zeroUsage), { allowed: true });

  const denied = evaluateProxyKeyBudgetAdmission(
    byokPolicy(0, null),
    byokUsage({ settled: 0, outstandingReserved: 0, newReservation: 1 }),
  );
  assert.deepEqual(denied, {
    allowed: false,
    deniedDimension: 'daily_tokens',
    projectedTotal: 1n,
    cap: 0n,
  });
});

test('null caps are unlimited even when the exact aggregate exceeds the stored integer range', () => {
  const max = MAX_MINOR_UNITS;
  const result = evaluateProxyKeyBudgetAdmission(
    byokPolicy(null, null),
    byokUsage(
      { settled: max, outstandingReserved: max, newReservation: max },
      { settled: max, outstandingReserved: max, newReservation: max },
    ),
  );

  assert.deepEqual(result, { allowed: true });
});

test('returns a stable dimension and exact explanation for an over-limit admission', () => {
  const result = evaluateProxyKeyBudgetAdmission(
    byokPolicy(9, 1),
    byokUsage(
      { settled: 4, outstandingReserved: 3, newReservation: 3 },
      { settled: 1, outstandingReserved: 1, newReservation: 1 },
    ),
  );

  assert.deepEqual(result, {
    allowed: false,
    deniedDimension: 'daily_tokens',
    projectedTotal: 10n,
    cap: 9n,
  });
  assert.equal(
    JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)).includes(
      'provider',
    ),
    false,
  );
});

test('bigint summation preserves an overage beyond the maximum persisted integer', () => {
  const result = evaluateProxyKeyBudgetAdmission(
    byokPolicy(MAX_MINOR_UNITS, MAX_MINOR_UNITS),
    byokUsage(
      { settled: MAX_MINOR_UNITS, outstandingReserved: 1n, newReservation: 0n },
      { settled: 0n, outstandingReserved: 0n, newReservation: 0n },
    ),
  );

  assert.deepEqual(result, {
    allowed: false,
    deniedDimension: 'daily_tokens',
    projectedTotal: MAX_MINOR_UNITS + 1n,
    cap: MAX_MINOR_UNITS,
  });
});

test('rejects unsafe, fractional, negative, malformed, and overflowing exact integers', () => {
  const policy = byokPolicy(10, 10);
  const badValues: readonly unknown[] = [
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    -1,
    '-1',
    '01',
    '1.0',
    MAX_MINOR_UNITS + 1n,
    (MAX_MINOR_UNITS + 1n).toString(),
  ];

  for (const badValue of badValues) {
    const expectedCode =
      typeof badValue === 'bigint' ||
      (typeof badValue === 'string' && /^\d+$/.test(badValue) && BigInt(badValue) > MAX_MINOR_UNITS)
        ? 'AMOUNT_OVERFLOW'
        : 'INVALID_INPUT';
    const usage = byokUsage({ settled: badValue as bigint, outstandingReserved: 0n, newReservation: 0n });
    expectBudgetError(() => evaluateProxyKeyBudgetAdmission(policy, usage), expectedCode);
  }
});

test('rejects charge caps for BYOK keys without echoing supplied values', () => {
  const policy = {
    ...byokPolicy(10, 10),
    customerChargeCaps: { currency: 'USD', daily: 50, lifetime: null },
  } as unknown as ProxyKeyBudgetPolicy;

  assert.throws(
    () => evaluateProxyKeyBudgetAdmission(policy, byokUsage({ settled: 0, outstandingReserved: 0, newReservation: 0 })),
    (error: unknown) =>
      error instanceof ProxyKeyBudgetError &&
      error.code === 'BYOK_CHARGE_BUDGET_FORBIDDEN' &&
      !error.message.includes('USD') &&
      !error.message.includes('50'),
  );
});

test('platform charge caps enforce a single validated currency across charge usage', () => {
  const policy = {
    supplyMode: 'platform',
    tokenCaps: { daily: null, lifetime: 1000 },
    customerChargeCaps: { currency: 'USD', daily: 500, lifetime: 1000 },
  } as const;
  const usage = {
    supplyMode: 'platform',
    tokenUsage: {
      lifetime: { settled: 10, outstandingReserved: 20, newReservation: 30 },
    },
    customerChargeUsage: {
      currency: 'EUR',
      daily: { settled: 100, outstandingReserved: 100, newReservation: 100 },
      lifetime: { settled: 100, outstandingReserved: 100, newReservation: 100 },
    },
  } as const;

  expectBudgetError(
    () => evaluateProxyKeyBudgetAdmission(policy as ProxyKeyBudgetPolicy, usage as ProxyKeyBudgetUsage),
    'CURRENCY_MISMATCH',
  );
});

test('denied platform charge dimensions identify the customer currency only', () => {
  const result = evaluateProxyKeyBudgetAdmission(
    {
      supplyMode: 'platform',
      tokenCaps: { daily: null, lifetime: null },
      customerChargeCaps: { currency: 'USD', daily: 100, lifetime: null },
    },
    {
      supplyMode: 'platform',
      customerChargeUsage: {
        currency: 'USD',
        daily: { settled: 40, outstandingReserved: 30, newReservation: 31 },
      },
    },
  );

  assert.deepEqual(result, {
    allowed: false,
    deniedDimension: 'daily_customer_charge',
    projectedTotal: 101n,
    cap: 100n,
    currency: 'USD',
  });
});

test('validates currencies and rejects unsupported supplier-cost or wallet dimensions', () => {
  expectBudgetError(
    () =>
      evaluateProxyKeyBudgetAdmission(
        {
          supplyMode: 'platform',
          tokenCaps: { daily: null, lifetime: null },
          customerChargeCaps: { currency: 'usd', daily: null, lifetime: null },
        } as ProxyKeyBudgetPolicy,
        { supplyMode: 'platform' },
      ),
    'INVALID_CURRENCY',
  );

  const unsupportedPolicy = {
    supplyMode: 'platform',
    tokenCaps: { daily: null, lifetime: null },
    supplierCostCap: 10,
  } as unknown as ProxyKeyBudgetPolicy;
  expectBudgetError(
    () => evaluateProxyKeyBudgetAdmission(unsupportedPolicy, { supplyMode: 'platform' }),
    'UNSUPPORTED_DIMENSION',
  );
});
