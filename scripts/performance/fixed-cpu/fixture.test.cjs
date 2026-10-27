'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateInput, validateFinance, FINANCE_SQL } = require('./fixture.cjs');
const input = { arm: 'bounded', httpInFlight: 64, creditCap: '67133440', pgPort: 55432, redisPort: 56379, mockPort: 58443, appPort: 58080 };
function facts() {
  return { intents: '2', receipts: '2', succeeded: '2', completed: '2', postings: '2', releases: '2',
    unresolved: '0', unbalanced: '0', invalid_releases: '0', invalid_bounds: '0', legacy_requests: '0', legacy_attempts: '0', legacy_evidence: '0', legacy_reservations: '0', legacy_usage: '0',
    charge: '70', posted: '70', input: '20', output: '10', released: '1048890', wallet: '99999999930', cap: '67133440', allocated: '0', backing: '0', available: '0', gateway_sessions: '0', gateway_role_limit: '16', business_owners: '2', active_allocations: '0', active_slots: '0' };
}
test('input accepts only two known matched money profiles and distinct loopback ports', () => {
  validateInput(input);
  validateInput({ ...input, httpInFlight: 256, creditCap: '268533760' });
  for (const change of [{ arm: 'auto' }, { httpInFlight: 128 }, { creditCap: '999999999' }, { pgPort: 5432.1 }, { redisPort: 55432 }]) assert.throws(() => validateInput({ ...input, ...change }));
});
test('financial proof conserves every request, immutable release and exact wallet charge', () => {
  validateFinance(facts(), 2, input, true);
  for (const key of ['intents', 'receipts', 'succeeded', 'completed', 'postings', 'releases', 'charge', 'posted', 'input', 'output', 'released', 'wallet', 'cap']) assert.throws(() => validateFinance({ ...facts(), [key]: '1' }, 2, input, true), key);
  for (const key of ['unresolved', 'unbalanced', 'invalid_releases', 'invalid_bounds', 'legacy_requests', 'backing', 'allocated', 'active_allocations', 'gateway_sessions']) assert.throws(() => validateFinance({ ...facts(), [key]: '1' }, 2, input, true), key);
});
test('live balance is capped, all owner backing and native PG sessions remain counted', () => {
  validateFinance({ ...facts(), backing: '60', available: '60', allocated: '60', active_allocations: '8', active_slots: '2', gateway_sessions: '16' }, 2, input, false);
  assert.throws(() => validateFinance({ ...facts(), backing: '67133441', available: '67133441', allocated: '67133441' }, 2, input, false));
  assert.throws(() => validateFinance({ ...facts(), gateway_sessions: '17' }, 2, input, false));
  assert.throws(() => validateFinance(facts(), 2, { ...input, arm: 'single' }, false));
  assert.match(FINANCE_SQL, /allocations AS \(SELECT \* FROM saas_fast_credit_allocations WHERE tenant_id=\$1\)/);
  assert.match(FINANCE_SQL, /invalid_releases/);
  assert.match(FINANCE_SQL, /maxInputTokens' IS DISTINCT FROM '262144'/);
  assert.match(FINANCE_SQL, /maxOutputTokens' IS DISTINCT FROM '64'/);
  assert.match(FINANCE_SQL, /estimatorVersion' IS DISTINCT FROM 'builtin-local-text-byte-bound\/v2'/);
});

test('closed state requires native validation, exact budgets and two graceful child exits', () => {
  const { validateState } = require('./process-proof.cjs');
  const state = { phase: 'closed', deploymentId: 'r9-current-test', creditCapMinorUnits: '67133440', primary: { pid: 1 },
    totals: { httpInFlight: 64, databasePoolMax: 16, receiptEntries: 256, receiptBytes: 2097152, receiptPerTenant: 64, receiptWorkers: 8, creditStripes: 8 },
    slots: [0, 1].map(slot => ({ slot, process: { pid: 10 + slot }, phase: 'exited', forced: false, signal: null, exitCode: 0 })) };
  let nativeCalls = 0;
  validateState(state, input, 'closed', () => nativeCalls++);
  assert.equal(nativeCalls, 1);
  assert.throws(() => validateState({ phase: 'closed' }, input, 'closed', () => {}));
  for (const change of [{ forced: true }, { signal: 'SIGKILL' }, { exitCode: 1 }, { process: null }])
    assert.throws(() => validateState({ ...state, slots: [{ ...state.slots[0], ...change }, state.slots[1]] }, input, 'closed', () => {}));
});

test('single stopped finance still requires inactive seed slots and zero resources', () => {
  const single = { ...input, arm: 'single' };
  const value = { ...facts(), business_owners: '1' };
  validateFinance(value, 2, single, true);
  for (const key of ['active_slots', 'gateway_sessions', 'backing', 'available', 'allocated', 'active_allocations'])
    assert.throws(() => validateFinance({ ...value, [key]: '1' }, 2, single, true), key);
});
