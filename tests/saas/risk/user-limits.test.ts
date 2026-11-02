import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveStoredUserLimits } from '../../../src/saas/risk/postgres-user-limits.js';
import {
  capKeyLimitsByUser,
  normalizeUserLimitPatch,
  resolveUserLimitPolicy,
  UNLIMITED_USER_LIMITS,
} from '../../../src/saas/risk/user-limits.js';

const defaults = {
  requestsPerMinute: 100n,
  maxConcurrentRequests: 10n,
  dailyTokenUnits: 1000n,
  dailyChargeMinorUnits: 5000n,
  chargeCurrency: 'USD',
};

test('user limits inherit per dimension and key self-tuning can only tighten', () => {
  const resolved = resolveUserLimitPolicy(defaults, {
    requestsPerMinute: 20n,
    maxConcurrentRequests: null,
    dailyTokenUnits: 500n,
    dailyChargeMinorUnits: null,
    chargeCurrency: null,
  });
  assert.deepEqual(resolved, {
    requestsPerMinute: 20n,
    maxConcurrentRequests: 10n,
    dailyTokenUnits: 500n,
    dailyChargeMinorUnits: 5000n,
    chargeCurrency: 'USD',
  });
  assert.deepEqual(capKeyLimitsByUser({ requestsPerMinute: 50n, maxConcurrentRequests: 2n }, resolved), {
    requestsPerMinute: 20n,
    maxConcurrentRequests: 2n,
  });
  assert.deepEqual(capKeyLimitsByUser({ requestsPerMinute: 50n, maxConcurrentRequests: 2n }, UNLIMITED_USER_LIMITS), {
    requestsPerMinute: 50n,
    maxConcurrentRequests: 2n,
  });
  assert.deepEqual(resolveUserLimitPolicy(defaults, null), defaults);
});

test('stored null override fields inherit defaults and malformed rows fail closed', () => {
  const storedDefaults = {
    requests_per_minute: '100',
    max_concurrent_requests: null,
    daily_token_units: null,
    daily_charge_minor_units: '500',
    charge_currency: 'USD',
  };
  assert.deepEqual(
    resolveStoredUserLimits(storedDefaults, {
      requests_per_minute: null,
      max_concurrent_requests: '2',
      daily_token_units: null,
      daily_charge_minor_units: null,
      charge_currency: null,
    }),
    {
      requestsPerMinute: 100n,
      maxConcurrentRequests: 2n,
      dailyTokenUnits: null,
      dailyChargeMinorUnits: 500n,
      chargeCurrency: 'USD',
    },
  );
  assert.throws(() => resolveStoredUserLimits({ ...storedDefaults, requests_per_minute: '-1' }, null));
  assert.throws(() => resolveStoredUserLimits({ ...storedDefaults, charge_currency: null }, null));
});

test('operator patches reject unknown, fractional, negative and incomplete charge values', () => {
  assert.deepEqual(normalizeUserLimitPatch({ requestsPerMinute: '0', chargeCurrency: 'USD' }), {
    requestsPerMinute: 0n,
    chargeCurrency: 'USD',
  });
  for (const value of [
    { requestsPerMinute: -1 },
    { requestsPerMinute: 1.5 },
    { dailyChargeMinorUnits: null, chargeCurrency: 'USD' },
    { dailyChargeMinorUnits: 10, chargeCurrency: null },
    { unknown: true },
  ]) {
    assert.throws(() => normalizeUserLimitPatch(value));
  }
});
