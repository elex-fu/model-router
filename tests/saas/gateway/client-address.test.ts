import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveClientAddress } from '../../../src/saas/gateway/client-address.js';

const TRUSTED_PROXIES = ['10.0.0.0/8'];

test('does not accept a spoofed leftmost XFF value past the nearest untrusted hop', () => {
  assert.deepEqual(
    resolveClientAddress('10.0.0.3', '203.0.113.200, 198.51.100.9, 10.2.3.4', TRUSTED_PROXIES),
    { status: 'resolved', address: '198.51.100.9', source: 'x-forwarded-for' },
  );
});

test('uses the validated socket peer when no proxy CIDRs are configured', () => {
  assert.deepEqual(resolveClientAddress('192.0.2.7', 'not an address', []), {
    status: 'resolved',
    address: '192.0.2.7',
    source: 'socket-peer',
  });
});

test('ignores XFF when the immediate socket peer is not trusted', () => {
  assert.deepEqual(resolveClientAddress('198.51.100.7', '203.0.113.9', TRUSTED_PROXIES), {
    status: 'resolved',
    address: '198.51.100.7',
    source: 'socket-peer',
  });
});

test('walks a trusted multi-proxy chain from right to left', () => {
  assert.deepEqual(
    resolveClientAddress('10.0.0.3', '203.0.113.7, 10.0.0.1, 10.0.0.2', TRUSTED_PROXIES),
    { status: 'resolved', address: '203.0.113.7', source: 'x-forwarded-for' },
  );
});

test('accepts a single XFF field value in array form and trims only OWS', () => {
  assert.deepEqual(resolveClientAddress('10.0.0.3', ['\t 203.0.113.7 \t'], TRUSTED_PROXIES), {
    status: 'resolved',
    address: '203.0.113.7',
    source: 'x-forwarded-for',
  });
});

test('returns unresolved for missing, empty, malformed, and duplicate XFF values from a trusted peer', () => {
  assert.deepEqual(resolveClientAddress('10.0.0.3', undefined, TRUSTED_PROXIES), {
    status: 'unresolved',
    reason: 'missing-forwarded-address',
  });
  assert.deepEqual(resolveClientAddress('10.0.0.3', '203.0.113.7,,10.0.0.1', TRUSTED_PROXIES), {
    status: 'unresolved',
    reason: 'malformed-forwarded-address',
  });
  assert.deepEqual(resolveClientAddress('10.0.0.3', '203.0.113.7, invalid', TRUSTED_PROXIES), {
    status: 'unresolved',
    reason: 'malformed-forwarded-address',
  });
  assert.deepEqual(
    resolveClientAddress('10.0.0.3', ['203.0.113.7', '203.0.113.7'], TRUSTED_PROXIES),
    { status: 'unresolved', reason: 'ambiguous-forwarded-header' },
  );
});

test('returns unresolved for oversized and overlong forwarded chains', () => {
  assert.deepEqual(resolveClientAddress('10.0.0.3', 'x'.repeat(2049), TRUSTED_PROXIES), {
    status: 'unresolved',
    reason: 'forwarded-header-too-large',
  });
  assert.deepEqual(
    resolveClientAddress('10.0.0.3', Array.from({ length: 21 }, () => '203.0.113.7').join(','), TRUSTED_PROXIES),
    { status: 'unresolved', reason: 'too-many-forwarded-hops' },
  );
});

test('returns unresolved rather than falling back when every forwarded hop is trusted', () => {
  assert.deepEqual(resolveClientAddress('10.0.0.3', '10.0.0.1, 10.0.0.2', TRUSTED_PROXIES), {
    status: 'unresolved',
    reason: 'all-forwarded-hops-trusted',
  });
});

test('returns unresolved for invalid trusted proxy CIDRs', () => {
  assert.deepEqual(resolveClientAddress('198.51.100.7', undefined, ['10.0.0.0/99']), {
    status: 'unresolved',
    reason: 'invalid-trusted-proxy-config',
  });
});

test('normalizes IPv4-mapped IPv6 peers, forwarded addresses, and proxy matches', () => {
  assert.deepEqual(
    resolveClientAddress('::ffff:10.0.0.3', '::ffff:203.0.113.7', TRUSTED_PROXIES),
    { status: 'resolved', address: '203.0.113.7', source: 'x-forwarded-for' },
  );
  assert.deepEqual(resolveClientAddress('::ffff:192.0.2.7', undefined, []), {
    status: 'resolved',
    address: '192.0.2.7',
    source: 'socket-peer',
  });
});
