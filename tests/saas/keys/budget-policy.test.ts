import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MINOR_UNITS } from '../../../src/saas/billing/money.js';
import {
  type BudgetWindowUsage,
  evaluateProxyKeyBudgetAdmission,
  ProxyKeyBudgetError,
  type ProxyKeyBudgetPolicy,
  type ProxyKeyBudgetUsage,
} from '../../../src/saas/keys/budget-policy.js';

function byokPolicy(daily: bigint | number | string | null, lifetime: bigint | number | string | null) {
  return { supplyMode: 'byok', tokenCaps: { daily, lifetime } } as const;
}

function byokUsage(
  daily: BudgetWindowUsage,
  lifetime: BudgetWindowUsage = { settled: 0n, outstandingReserved: 0n, newReservation: 0n },
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

test('rolling 5h/7d charge caps deny on the trailing window and stay optional', () => {
  const policy = {
    supplyMode: 'platform' as const,
    tokenCaps: { daily: null, lifetime: null },
    customerChargeCaps: {
      currency: 'USD',
      daily: null,
      lifetime: null,
      fiveHour: '500' as const,
      sevenDay: '5000' as const,
    },
  };
  const usage = (fiveHour: string, sevenDay: string) => ({
    supplyMode: 'platform' as const,
    customerChargeUsage: {
      currency: 'USD',
      fiveHour: { settled: '0', outstandingReserved: fiveHour, newReservation: '0' },
      sevenDay: { settled: '0', outstandingReserved: sevenDay, newReservation: '0' },
    },
  });
  // Exactly at both rolling caps: admitted.
  assert.deepEqual(evaluateProxyKeyBudgetAdmission(policy, usage('500', '5000')), { allowed: true });
  // The 5h window exceeds: denied on charge_5h with the exact projection.
  const denied5h = evaluateProxyKeyBudgetAdmission(policy, usage('501', '5000'));
  assert.equal(denied5h.allowed, false);
  if (!denied5h.allowed) {
    assert.equal(denied5h.deniedDimension, 'charge_5h');
    assert.equal(denied5h.projectedTotal, 501n);
    assert.equal(denied5h.cap, 500n);
    assert.equal(denied5h.currency, 'USD');
  }
  // The 7d window exceeds: denied on charge_7d.
  const denied7d = evaluateProxyKeyBudgetAdmission(policy, usage('400', '5001'));
  assert.equal(denied7d.allowed, false);
  if (!denied7d.allowed) assert.equal(denied7d.deniedDimension, 'charge_7d');
  // Absent rolling caps are unlimited even when trailing totals are huge.
  const legacyPolicy = {
    supplyMode: 'platform' as const,
    tokenCaps: { daily: null, lifetime: null },
    customerChargeCaps: { currency: 'USD', daily: null, lifetime: null },
  };
  assert.deepEqual(
    evaluateProxyKeyBudgetAdmission(legacyPolicy, usage('999999999999', '999999999999')),
    { allowed: true },
  );
});
