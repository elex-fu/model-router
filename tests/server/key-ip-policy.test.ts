import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProxyKey } from '../../src/config/types.js';
import { keyIpAllowed } from '../../src/server/key-ip-policy.js';

/*
 * O3 (docs/standalone-relay-capability-plan-2026-10-30.md): per-proxy-key IP
 * policy unit coverage. Integration coverage (forged headers, 403 shape) lives
 * in tests/integration/key-ip-policy.test.ts.
 */

function key(policy: { ipAllowlist?: string[]; ipDenylist?: string[] }): ProxyKey {
  return {
    name: 'k',
    key: 'mrk_test',
    enabled: true,
    createdAt: '2026-05-02T00:00:00Z',
    ...policy,
  };
}

test('no policy allows any address', () => {
  assert.equal(keyIpAllowed(key({}), '203.0.113.9'), true);
  assert.equal(keyIpAllowed(key({ ipAllowlist: [], ipDenylist: [] }), '203.0.113.9'), true);
});

test('allowlist admits members and rejects non-members', () => {
  const k = key({ ipAllowlist: ['10.0.0.0/8', '192.0.2.1'] });
  assert.equal(keyIpAllowed(k, '10.1.2.3'), true);
  assert.equal(keyIpAllowed(k, '192.0.2.1'), true);
  assert.equal(keyIpAllowed(k, '203.0.113.9'), false);
});

test('denylist rejects members and admits non-members', () => {
  const k = key({ ipDenylist: ['203.0.113.0/24'] });
  assert.equal(keyIpAllowed(k, '203.0.113.7'), false);
  assert.equal(keyIpAllowed(k, '198.51.100.7'), true);
});

test('denylist wins over allowlist', () => {
  const k = key({ ipAllowlist: ['0.0.0.0/0'], ipDenylist: ['10.0.0.5'] });
  assert.equal(keyIpAllowed(k, '10.0.0.5'), false);
  assert.equal(keyIpAllowed(k, '10.0.0.6'), true);
});

test('IPv6 addresses and IPv4-mapped forms match', () => {
  const k = key({ ipAllowlist: ['2001:db8::/32'] });
  assert.equal(keyIpAllowed(k, '2001:db8::1'), true);
  assert.equal(keyIpAllowed(k, '2001:db9::1'), false);
  // Node represents v4 peers as ::ffff:a.b.c.d; the policy normalizes.
  const v4 = key({ ipAllowlist: ['10.0.0.0/8'] });
  assert.equal(keyIpAllowed(v4, '::ffff:10.0.0.9'), true);
});

test('single-IP entries behave as full CIDRs', () => {
  const k = key({ ipDenylist: ['198.51.100.2'] });
  assert.equal(keyIpAllowed(k, '198.51.100.2'), false);
  assert.equal(keyIpAllowed(k, '198.51.100.3'), true);
});

test('invalid entries are ignored; unparseable peer addresses fail closed', () => {
  const k = key({ ipAllowlist: ['not-an-ip', '10.0.0.0/99', '10.0.0.0/8'] });
  assert.equal(keyIpAllowed(k, '10.2.3.4'), true);
  assert.equal(keyIpAllowed(k, '203.0.113.1'), false);
  assert.equal(keyIpAllowed(key({ ipDenylist: ['10.0.0.0/8'] }), 'internal:playground'), false);
});
