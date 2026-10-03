import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalizeIpCidr,
  canonicalizeIpPolicy,
  isIpAllowed,
} from '../../../src/saas/keys/ip-policy.js';

test('canonicalizes IPv4 hosts and masks CIDR host bits', () => {
  assert.equal(canonicalizeIpCidr('192.0.2.9'), '192.0.2.9/32');
  assert.equal(canonicalizeIpCidr('192.0.2.129/24'), '192.0.2.0/24');
  assert.equal(canonicalizeIpCidr('0.0.0.0/0'), '0.0.0.0/0');
});

test('canonicalizes IPv6 with lowercase words, zero compression, and masked host bits', () => {
  assert.equal(canonicalizeIpCidr('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1/128');
  assert.equal(canonicalizeIpCidr('2001:db8:abcd:ffff::9/48'), '2001:db8:abcd::/48');
  assert.equal(canonicalizeIpCidr('::'), '::/128');
  assert.equal(canonicalizeIpCidr('2001:db8:0:1:0:0:1:1'), '2001:db8:0:1::1:1/128');
});

test('canonicalizes embedded IPv4 IPv6 literals using IPv6 notation', () => {
  assert.equal(canonicalizeIpCidr('2001:db8::192.0.2.1'), '2001:db8::c000:201/128');
});

test('canonicalizes policy rules, deduplicates, and sorts by family and numeric network', () => {
  assert.deepEqual(
    canonicalizeIpPolicy({
      mode: 'allowlist',
      rules: ['2001:db8::2/64', '192.0.2.8/24', '192.0.2.1/24', '2001:db8::/64'],
    }),
    { mode: 'allowlist', rules: ['192.0.2.0/24', '2001:db8::/64'] },
  );
});

test('normalizes IPv4-mapped IPv6 hosts and CIDRs to IPv4', () => {
  assert.equal(canonicalizeIpCidr('::ffff:192.0.2.9'), '192.0.2.9/32');
  assert.equal(canonicalizeIpCidr('::FFFF:C000:0209/120'), '192.0.2.0/24');
  assert.equal(canonicalizeIpCidr('::ffff:0:0/96'), '0.0.0.0/0');
  assert.equal(canonicalizeIpCidr('::ffff:192.0.2.9/128'), '192.0.2.9/32');
  assert.throws(() => canonicalizeIpCidr('::ffff:192.0.2.9/95'), /mapped IPv6 CIDRs/);
});

test('validates explicit policy modes and non-empty allowlists', () => {
  assert.deepEqual(canonicalizeIpPolicy({ mode: 'disabled', rules: [] }), { mode: 'disabled', rules: [] });
  assert.deepEqual(
    canonicalizeIpPolicy({ mode: 'disabled', rules: ['192.0.2.1'] }),
    { mode: 'disabled', rules: ['192.0.2.1/32'] },
  );
  assert.throws(() => canonicalizeIpPolicy({ mode: 'allowlist', rules: [] }), /at least one rule/);
  assert.throws(() => canonicalizeIpPolicy({ mode: 'enforce', rules: ['192.0.2.1'] }), /mode/);
  assert.throws(() => canonicalizeIpPolicy({ mode: 'disabled' }), /array/);
});

test('caps input rules at 256, including duplicates', () => {
  assert.equal(
    canonicalizeIpPolicy({ mode: 'allowlist', rules: Array(256).fill('192.0.2.1') }).rules.length,
    1,
  );
  assert.throws(
    () => canonicalizeIpPolicy({ mode: 'allowlist', rules: Array(257).fill('192.0.2.1') }),
    /at most 256/,
  );
});

test('rejects non-literals, ambiguous syntax, zones, ports, and invalid prefixes', () => {
  const invalidInputs = [
    '',
    'example.com',
    '192.0.2.1:443',
    '[2001:db8::1]',
    'fe80::1%eth0',
    '192.000.2.1',
    '256.0.0.1',
    '1.2.3',
    '1::2::3',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    '2001:db8::192.0.2.01',
    '192.0.2.1/',
    '192.0.2.1/024',
    '192.0.2.1/+24',
    '192.0.2.1/33',
    '192.0.2.1/24/1',
    ' 192.0.2.1',
  ];
  for (const input of invalidInputs) {
    assert.throws(() => canonicalizeIpCidr(input), input);
  }
});

test('matches IPv4 and IPv6 allowlist rules and rejects invalid peers', () => {
  const policy = canonicalizeIpPolicy({ mode: 'allowlist', rules: ['192.0.2.0/24', '2001:db8::/32'] });
  assert.equal(isIpAllowed('192.0.2.44', policy), true);
  assert.equal(isIpAllowed('192.0.3.44', policy), false);
  assert.equal(isIpAllowed('2001:db8:1::5', policy), true);
  assert.equal(isIpAllowed('2001:db9::5', policy), false);
  assert.equal(isIpAllowed('::ffff:192.0.2.44', policy), true);
  assert.equal(isIpAllowed('example.com', policy), false);
  assert.equal(isIpAllowed('192.0.2.44/32', policy), false);
});

test('disabled policy allows valid policy objects while malformed policy fails closed', () => {
  assert.equal(isIpAllowed('203.0.113.7', { mode: 'disabled', rules: [] }), true);
  assert.equal(isIpAllowed('not-an-ip', { mode: 'disabled', rules: [] }), false);
  assert.equal(isIpAllowed('203.0.113.7', { mode: 'allowlist', rules: [] }), false);
  assert.equal(isIpAllowed('203.0.113.7', { mode: 'unknown', rules: [] }), false);
});
