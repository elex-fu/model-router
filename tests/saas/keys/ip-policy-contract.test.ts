import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeIpPolicy, isIpAllowed } from '../../../src/saas/keys/ip-policy.js';
import {
  parseKeyIpPolicyVersion,
  parseReplaceKeyIpPolicyInput,
} from '../../../src/saas/keys/ip-policy-contract.js';

test('explicit denyall stays distinct from disabled for both address families and mapped peers', () => {
  const denied = canonicalizeIpPolicy({ mode: 'denyall', rules: [] });
  assert.deepEqual(denied, { mode: 'denyall', rules: [] });
  for (const peer of ['192.0.2.7', '2001:db8::7', '::ffff:192.0.2.7']) {
    assert.equal(isIpAllowed(peer, denied), false);
    assert.equal(isIpAllowed(peer, { mode: 'disabled', rules: [] }), true);
  }
  assert.equal(isIpAllowed('not-an-ip', { mode: 'disabled', rules: [] }), false);
});

test('denyall requires explicit empty rules and does not reinterpret an empty allowlist', () => {
  for (const rules of [undefined, null, '192.0.2.7', ['192.0.2.7'], ['invalid']]) {
    assert.throws(() => canonicalizeIpPolicy({ mode: 'denyall', rules }), TypeError);
    assert.equal(isIpAllowed('192.0.2.7', { mode: 'denyall', rules }), false);
  }
  assert.throws(() => canonicalizeIpPolicy({ mode: 'allowlist', rules: [] }), /at least one rule/);
});

test('replace DTO canonicalizes through the existing CIDR implementation without widening networks', () => {
  const parsed = parseReplaceKeyIpPolicyInput({
    expectedVersion: '9007199254740993',
    policy: {
      mode: 'allowlist',
      rules: ['2001:0DB8::7/64', '::ffff:192.0.2.129/120', '192.0.2.7/24'],
    },
  });
  assert.deepEqual(parsed, {
    expectedVersion: '9007199254740993',
    policy: { mode: 'allowlist', rules: ['192.0.2.0/24', '2001:db8::/64'] },
  });
  assert.equal(isIpAllowed('192.0.3.7', parsed.policy), false);
  assert.equal(isIpAllowed('2001:db8:0:1::7', parsed.policy), false);
});

test('disabled draft rules are preserved and never replaced with implicit broad CIDRs', () => {
  assert.deepEqual(parseReplaceKeyIpPolicyInput({
    expectedVersion: '1',
    policy: { mode: 'disabled', rules: ['192.0.2.7'] },
  }), {
    expectedVersion: '1',
    policy: { mode: 'disabled', rules: ['192.0.2.7/32'] },
  });
  assert.deepEqual(parseReplaceKeyIpPolicyInput({
    expectedVersion: '2',
    policy: { mode: 'denyall', rules: [] },
  }), {
    expectedVersion: '2',
    policy: { mode: 'denyall', rules: [] },
  });
});

test('revision text is exact through PostgreSQL bigint max with no numeric coercion', () => {
  for (const value of ['1', '9007199254740993', '9223372036854775807']) {
    assert.equal(parseKeyIpPolicyVersion(value), value);
  }
  for (const value of [
    undefined, null, 1, 1n, Number.MAX_SAFE_INTEGER + 1, '', '0', '-1',
    '+1', '01', ' 1', '1 ', '1.0', '1e3', '9223372036854775808', '1'.repeat(100),
  ]) {
    assert.throws(() => parseKeyIpPolicyVersion(value), TypeError);
  }
});

test('replacement requires an explicit CAS revision and a complete policy', () => {
  for (const value of [
    undefined, null, [], {}, { policy: { mode: 'disabled', rules: [] } },
    { expectedVersion: '1' }, { expectedVersion: '1', policy: null },
    { expectedVersion: '1', policy: [] },
    { expectedVersion: '1', policy: { mode: 'disabled' } },
    { expectedVersion: '1', policy: { rules: [] } },
    { expectedVersion: '1', policy: { mode: 'allowlist', rules: [] } },
  ]) {
    assert.throws(() => parseReplaceKeyIpPolicyInput(value), TypeError);
  }
});

test('body cannot supply scope, a new version, Key authority, secrets or forwarding configuration', () => {
  const valid = { expectedVersion: '1', policy: { mode: 'disabled', rules: [] } };
  for (const field of [
    'tenantId', 'projectId', 'keyId', 'version', 'authzVersion', 'secret',
    'key_hash', 'trustedProxyCidrs', 'xForwardedFor', 'forwarded',
  ]) {
    assert.throws(() => parseReplaceKeyIpPolicyInput({ ...valid, [field]: 'untrusted' }), TypeError);
  }
  for (const field of ['version', 'trustedProxyCidrs', 'xForwardedFor', 'forwarded']) {
    assert.throws(() => parseReplaceKeyIpPolicyInput({
      ...valid, policy: { ...valid.policy, [field]: 'untrusted' },
    }), TypeError);
  }
});

test('required fields cannot be supplied only through the prototype', () => {
  assert.throws(() => parseReplaceKeyIpPolicyInput(Object.create({
    expectedVersion: '1', policy: { mode: 'disabled', rules: [] },
  })), TypeError);
  assert.throws(() => parseReplaceKeyIpPolicyInput({
    expectedVersion: '1', policy: Object.create({ mode: 'disabled', rules: [] }),
  }), TypeError);
});

test('DTO preserves the existing input-rule cap before deduplication', () => {
  assert.equal(parseReplaceKeyIpPolicyInput({
    expectedVersion: '1',
    policy: { mode: 'allowlist', rules: Array(256).fill('192.0.2.7') },
  }).policy.rules.length, 1);
  assert.throws(() => parseReplaceKeyIpPolicyInput({
    expectedVersion: '1',
    policy: { mode: 'allowlist', rules: Array(257).fill('192.0.2.7') },
  }), /at most 256/);
});

test('malformed literals stay rejected instead of becoming disabled or broad allow rules', () => {
  for (const rule of [
    'example.invalid', '192.000.2.7', '192.0.2.7:443', '[2001:db8::7]',
    'fe80::7%eth0', '192.0.2.7/33', '2001:db8::7/129', '::ffff:192.0.2.7/95',
  ]) {
    assert.throws(() => parseReplaceKeyIpPolicyInput({
      expectedVersion: '1', policy: { mode: 'allowlist', rules: [rule] },
    }), TypeError);
  }
});

test('canonical replacement owns a fresh rules array and leaves input ordering untouched', () => {
  const rules = ['2001:db8::7', '192.0.2.7'];
  const parsed = parseReplaceKeyIpPolicyInput({
    expectedVersion: '1', policy: { mode: 'allowlist', rules },
  });
  assert.deepEqual(rules, ['2001:db8::7', '192.0.2.7']);
  rules.push('0.0.0.0/0');
  assert.deepEqual(parsed.policy.rules, ['192.0.2.7/32', '2001:db8::7/128']);
});
