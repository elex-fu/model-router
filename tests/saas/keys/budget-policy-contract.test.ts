import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_MINOR_UNITS } from '../../../src/saas/billing/money.js';
import {
  evaluateProxyKeyBudgetAdmission,
  ProxyKeyBudgetError,
} from '../../../src/saas/keys/budget-policy.js';
import {
  assertKeyBudgetUtcDay,
  parseKeyBudgetVersion,
  parseReplaceKeyBudgetPolicyInput,
  type KeyBudgetPolicySnapshot,
} from '../../../src/saas/keys/budget-policy-contract.js';

const disabled = {
  expectedVersion: '1',
  tokenCaps: { daily: null, lifetime: null },
  customerChargeCaps: null,
} as const;

test('versions retain exact bigint text and reject numeric or noncanonical revisions', () => {
  for (const value of ['1', '9007199254740993', MAX_MINOR_UNITS.toString()]) {
    assert.equal(parseKeyBudgetVersion(value), value);
  }
  for (const value of [
    undefined, null, 0, 1, 1n, Number.MAX_SAFE_INTEGER + 1,
    '', '0', '01', '-1', '+1', ' 1', '1 ', '1.0', '1e3',
    (MAX_MINOR_UNITS + 1n).toString(), '1'.repeat(100),
  ]) {
    assert.throws(() => parseKeyBudgetVersion(value), TypeError);
  }
});

test('daily, lineage lifetime and explicit disabled caps remain independent', () => {
  for (const tokenCaps of [
    { daily: '0', lifetime: null },
    { daily: null, lifetime: '9007199254740993' },
    { daily: '10', lifetime: '20' },
    { daily: null, lifetime: null },
  ]) {
    assert.deepEqual(parseReplaceKeyBudgetPolicyInput({ ...disabled, tokenCaps }, 'byok'), {
      ...disabled, tokenCaps,
    });
  }
});

test('wire caps use canonical decimal strings only and retain the evaluator bigint bound', () => {
  assert.equal(parseReplaceKeyBudgetPolicyInput({
    ...disabled, tokenCaps: { daily: MAX_MINOR_UNITS.toString(), lifetime: '0' },
  }, 'byok').tokenCaps.daily, MAX_MINOR_UNITS.toString());
  for (const value of [
    undefined, 0, 1, 1n, -1, 0.5, Number.MAX_SAFE_INTEGER + 1,
    '', '-1', '+1', '01', '1.0', '1e3', ' 1', '1 ',
    (MAX_MINOR_UNITS + 1n).toString(),
  ]) {
    assert.throws(() => parseReplaceKeyBudgetPolicyInput({
      ...disabled, tokenCaps: { daily: value, lifetime: null },
    }, 'byok'), TypeError);
    assert.throws(() => parseReplaceKeyBudgetPolicyInput({
      ...disabled, customerChargeCaps: { daily: null, lifetime: value },
    }, 'platform'), TypeError);
  }
});

test('replacement requires every field and does not default a missing dimension to disabled', () => {
  for (const value of [
    undefined, null, [], {},
    { expectedVersion: '1', tokenCaps: disabled.tokenCaps },
    { expectedVersion: '1', customerChargeCaps: null },
    { tokenCaps: disabled.tokenCaps, customerChargeCaps: null },
    { ...disabled, tokenCaps: { daily: null } },
    { ...disabled, tokenCaps: { lifetime: null } },
    { ...disabled, customerChargeCaps: undefined },
    { ...disabled, customerChargeCaps: { daily: null } },
  ]) {
    assert.throws(() => parseReplaceKeyBudgetPolicyInput(value, 'platform'), TypeError);
  }
});

test('body cannot choose scope, lineage, counters, clock, currency, units or authority', () => {
  for (const field of [
    'tenantId', 'projectId', 'keyId', 'lineageId', 'version', 'authzVersion',
    'supplyMode', 'spent', 'settled', 'reserved', 'outstandingReserved',
    'currentWindow', 'timezone', 'clock', 'currency', 'unit', 'tokenCountingSemanticsVersion',
    'unknownTtlSeconds', 'credit', 'supplierCost', 'secret',
  ]) {
    assert.throws(() => parseReplaceKeyBudgetPolicyInput({
      ...disabled, [field]: 'untrusted',
    }, 'platform'), TypeError);
  }
  for (const field of ['currency', 'unit', 'spent', 'reserved', 'currentWindow', 'lineageId']) {
    assert.throws(() => parseReplaceKeyBudgetPolicyInput({
      ...disabled, tokenCaps: { daily: null, lifetime: null, [field]: 'untrusted' },
    }, 'platform'), TypeError);
    assert.throws(() => parseReplaceKeyBudgetPolicyInput({
      ...disabled, customerChargeCaps: { daily: null, lifetime: null, [field]: 'untrusted' },
    }, 'platform'), TypeError);
  }
});

test('BYOK forbids the charge dimension even if its submitted caps are disabled', () => {
  assert.deepEqual(parseReplaceKeyBudgetPolicyInput(disabled, 'byok'), disabled);
  for (const customerChargeCaps of [
    { daily: null, lifetime: null }, { daily: '0', lifetime: '10' },
  ]) {
    assert.throws(() => parseReplaceKeyBudgetPolicyInput({
      ...disabled, customerChargeCaps,
    }, 'byok'), /BYOK/);
  }
});

test('parsed caps remain compatible with the existing evaluator without a second admission implementation', () => {
  const input = parseReplaceKeyBudgetPolicyInput({
    ...disabled, tokenCaps: { daily: '10', lifetime: '20' },
  }, 'byok');
  const policy = { supplyMode: 'byok', tokenCaps: input.tokenCaps } as const;
  assert.deepEqual(evaluateProxyKeyBudgetAdmission(policy, {
    supplyMode: 'byok',
    tokenUsage: {
      daily: { settled: '2', outstandingReserved: '9', newReservation: '0' },
      lifetime: { settled: '2', outstandingReserved: '9', newReservation: '0' },
    },
  }), {
    allowed: false, deniedDimension: 'daily_tokens', projectedTotal: 11n, cap: 10n,
  });
  assert.throws(() => evaluateProxyKeyBudgetAdmission(policy, { supplyMode: 'byok' }),
    (error: unknown) => error instanceof ProxyKeyBudgetError && error.code === 'INVALID_INPUT');
});

test('platform charge caps bind to a server currency in existing evaluator minor units', () => {
  const input = parseReplaceKeyBudgetPolicyInput({
    ...disabled, customerChargeCaps: { daily: '100', lifetime: null },
  }, 'platform');
  assert.ok(input.customerChargeCaps !== null);
  const policy = {
    supplyMode: 'platform',
    tokenCaps: input.tokenCaps,
    customerChargeCaps: { currency: 'JPY', ...input.customerChargeCaps },
  } as const;
  assert.deepEqual(evaluateProxyKeyBudgetAdmission(policy, {
    supplyMode: 'platform',
    customerChargeUsage: {
      currency: 'JPY',
      daily: { settled: '40', outstandingReserved: '30', newReservation: '31' },
    },
  }), {
    allowed: false, deniedDimension: 'daily_customer_charge',
    projectedTotal: 101n, cap: 100n, currency: 'JPY',
  });
});

test('UTC day metadata uses exact half-open midnight boundaries through calendar rollovers', () => {
  for (const [startInclusive, endExclusive] of [
    ['2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z'],
    ['2028-02-29T00:00:00.000Z', '2028-03-01T00:00:00.000Z'],
    ['2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
  ]) {
    const day = { timezone: 'UTC', startInclusive, endExclusive };
    assert.doesNotThrow(() => assertKeyBudgetUtcDay(day));
  }
});

test('UTC metadata assertion rejects local zones, invalid dates and non-day windows', () => {
  const day = {
    timezone: 'UTC',
    startInclusive: '2026-10-03T00:00:00.000Z',
    endExclusive: '2026-10-04T00:00:00.000Z',
  };
  for (const candidate of [
    { ...day, timezone: 'Asia/Shanghai' },
    { ...day, startInclusive: '2026-10-03T00:00:00+00:00' },
    { ...day, startInclusive: '2026-10-03T01:00:00.000Z' },
    { ...day, startInclusive: '2026-02-30T00:00:00.000Z' },
    { ...day, endExclusive: day.startInclusive },
    { ...day, endExclusive: '2026-10-05T00:00:00.000Z' },
    { ...day, clock: 'untrusted' },
  ]) {
    assert.throws(() => assertKeyBudgetUtcDay(candidate), TypeError);
  }
});

test('snapshot keeps lineage and unknown authority separate from replacement inputs', () => {
  const snapshot = {
    tenantId: 'tenant', projectId: 'project', keyId: 'key', lineageId: 'lineage',
    version: '9007199254740993', authzVersion: 1,
    supplyMode: 'byok', tokenUnit: 'tokens', tokenCountingSemanticsVersion: null,
    currentWindow: null, tokenCaps: { daily: '10', lifetime: '20' },
    tokenUsage: { daily: { status: 'unverified' }, lifetime: { status: 'unverified' } },
    customerChargeBudget: null,
  } satisfies KeyBudgetPolicySnapshot;
  const replacement = parseReplaceKeyBudgetPolicyInput({
    ...disabled, expectedVersion: snapshot.version,
  }, snapshot.supplyMode);
  assert.deepEqual(Object.keys(replacement).sort(), ['customerChargeCaps', 'expectedVersion', 'tokenCaps']);
  assert.equal(snapshot.lineageId, 'lineage');
  assert.deepEqual(snapshot.tokenUsage.daily, { status: 'unverified' });
  assert.equal(snapshot.currentWindow, null);
});

test('replacement creates detached cap objects and requires own fields', () => {
  const input = { ...disabled, tokenCaps: { daily: '10', lifetime: '20' } };
  const parsed = parseReplaceKeyBudgetPolicyInput(input, 'byok');
  input.tokenCaps.daily = '100';
  assert.equal(parsed.tokenCaps.daily, '10');
  assert.throws(() => parseReplaceKeyBudgetPolicyInput(Object.create(disabled), 'byok'), TypeError);
  assert.throws(() => parseReplaceKeyBudgetPolicyInput({
    ...disabled, tokenCaps: Object.create(disabled.tokenCaps),
  }, 'byok'), TypeError);
});
