'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateConstructor, validateSnapshot, verifyPins, requiredPins } = require('./checkpoint.cjs');
const identity = { pid: 42, startTicks: '1234' };
const input = { arm: 'single', httpInFlight: 64, creditCap: '67133440' };
function constructor() { return { schema: 1, role: 'business', identity, restored: true,
  modulePins: Object.fromEntries(requiredPins('business').map(key => [key, '0'.repeat(64)])), actual: { instanceIdentitiesPreserved: true, nativePools: [2, 14], httpInFlight: 64, executorMaxLocalConcurrency: 64,
    receipt: { maxEntries: 256, maxBytes: 2097152, maxPerTenant: 64, workers: 8, maxAgeMs: 5000, drainTimeoutMs: 10000 }, stripes: 8, tranche: null } }; }
function snapshot() { return { nonce: 'a'.repeat(32), identity, startupProofSha256: 'b'.repeat(64), observedAtUnixMs: 123,
  snapshot: { accepting: true, pending: 0, bytes: 0, running: 0, receiptRunning: 0, reconciliationRunning: 0, undurable: 0, accepted: 138, durable: 138, completed: 138, conflicts: 0, completedWithoutReconciliation: 0, undurableLiabilityByCurrency: {} } }; }
test('actual constructor scalars and known original identity are mandatory, not optional env echoes', () => {
  validateConstructor(constructor(), input, identity);
  for (const change of [{ restored: false }, { identity: { ...identity, startTicks: 'old' } }, { actual: { ...constructor().actual, stripes: undefined } }, { actual: { ...constructor().actual, receipt: { ...constructor().actual.receipt, maxEntries: undefined } } }])
    assert.throws(() => validateConstructor({ ...constructor(), ...change }, input, identity));
});
test('fresh nonce plus PID/startTicks and startup proof hash reject old or foreign files', () => {
  assert.equal(validateSnapshot(snapshot(), 'a'.repeat(32), identity, 'b'.repeat(64)), true);
  for (const change of [{ nonce: 'c'.repeat(32) }, { identity: { ...identity, pid: 43 } }, { identity: { ...identity, startTicks: '1235' } }, { startupProofSha256: 'old' }])
    assert.throws(() => validateSnapshot({ ...snapshot(), ...change }, 'a'.repeat(32), identity, 'b'.repeat(64)));
});
test('durable rows and TPM acknowledgement alone do not prove native queue zero', () => {
  assert.equal(validateSnapshot({ ...snapshot(), snapshot: { ...snapshot().snapshot, pending: 1 } }, 'a'.repeat(32), identity, 'b'.repeat(64)), false);
  assert.throws(() => validateSnapshot({ ...snapshot(), snapshot: { ...snapshot().snapshot, reconciliationRunning: undefined } }, 'a'.repeat(32), identity, 'b'.repeat(64)));
  assert.equal(validateSnapshot({ ...snapshot(), snapshot: { ...snapshot().snapshot, completed: 137 } }, 'a'.repeat(32), identity, 'b'.repeat(64)), false);
});

test('compiled pins use exact root-relative module set, never a duplicated dist path', () => {
  const { createHash } = require('node:crypto');
  const bytes = Buffer.from('native compiled module');
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const role of ['business', 'primary']) {
    const keys = requiredPins(role), seen = [];
    const pins = Object.fromEntries(keys.map(key => [key, hash]));
    verifyPins(pins, role, file => { seen.push(file); return bytes; }, '/app');
    assert.deepEqual(seen.sort(), keys.map(key => `/app/${key}`).sort());
    assert.throws(() => verifyPins({ 'dist/unrelated.js': hash }, role, () => bytes, '/app'));
    assert.throws(() => verifyPins({ ...pins, 'dist/extra.js': hash }, role, () => bytes, '/app'));
    assert.throws(() => verifyPins(pins, role, () => Buffer.from('different binary'), '/app'));
  }
});
