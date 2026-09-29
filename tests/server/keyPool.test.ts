import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyPool } from '../../src/server/keyPool.js';
import { retryAfterDelayMs } from '../../src/server/proxy.js';

test('pick returns first registered key by default (round-robin)', () => {
  const pool = new KeyPool();
  pool.register('up1', ['k1', 'k2', 'k3']);
  assert.equal(pool.pick('up1'), 'k1');
});

test('pick returns null for unregistered upstream', () => {
  const pool = new KeyPool();
  assert.equal(pool.pick('up1'), null);
});

test('pick round-robins through all keys', () => {
  const pool = new KeyPool();
  pool.register('up1', ['k1', 'k2', 'k3']);
  assert.equal(pool.pick('up1'), 'k1');
  assert.equal(pool.pick('up1'), 'k2');
  assert.equal(pool.pick('up1'), 'k3');
  assert.equal(pool.pick('up1'), 'k1');
});

test('markFailure 3 times cools key, pick skips it', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');

  for (let i = 0; i < 20; i++) {
    assert.equal(pool.pick('up1'), 'k2');
  }
});

test('reconcile preserves state by credential ID and key across entry reordering', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', [
    { credentialId: 'cred-a', key: 'k1' },
    { credentialId: 'cred-b', key: 'k2' },
  ]);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');

  pool.reconcile('up1', [
    { credentialId: 'cred-b', key: 'k2' },
    { credentialId: 'cred-a', key: 'k1' },
  ]);
  assert.deepEqual(pool.getAvailableKeys('up1'), ['k2']);
});

test('reconcile clears state when a credential ID keeps a replacement key', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', [{ credentialId: 'cred-a', key: 'old-key' }]);
  pool.markFailure('up1', 'old-key');
  pool.markFailure('up1', 'old-key');
  pool.markFailure('up1', 'old-key');

  pool.reconcile('up1', [{ credentialId: 'cred-a', key: 'new-key' }]);
  assert.deepEqual(pool.getAvailableKeys('up1'), ['new-key']);
});

test('a new credential ID reusing a key does not inherit its cooldown', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', [{ credentialId: 'cred-old', key: 'shared-key' }]);
  pool.markFailure('up1', 'shared-key');
  pool.markFailure('up1', 'shared-key');
  pool.markFailure('up1', 'shared-key');

  pool.reconcile('up1', [{ credentialId: 'cred-new', key: 'shared-key' }]);
  assert.deepEqual(pool.getAvailableKeys('up1'), ['shared-key']);
});

test('string array registration and reconcile retain key-based identity compatibility', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');

  pool.reconcile('up1', ['k2', 'k1']);
  assert.deepEqual(pool.getAvailableKeys('up1'), ['k2']);
});

test('all keys cooled returns null', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k2');
  pool.markFailure('up1', 'k2');
  pool.markFailure('up1', 'k2');

  assert.equal(pool.pick('up1'), null);
});

test('markSuccess resets failures and cooldown', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  assert.equal(pool.pick('up1'), 'k2');

  pool.markSuccess('up1', 'k1');
  assert.equal(pool.pick('up1'), 'k1');
});

test('cooldown expires after duration', async () => {
  const pool = new KeyPool({ cooldownMs: 50 });
  pool.register('up1', ['k1', 'k2']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  assert.equal(pool.pick('up1'), 'k2');

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(pool.pick('up1'), 'k1');
});

test('markFailure on different keys tracks independently', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2', 'k3']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');

  assert.equal(pool.pick('up1'), 'k2');
  assert.equal(pool.pick('up1'), 'k3');
  assert.equal(pool.pick('up1'), 'k2');
});

test('pick returns null when no keys registered', () => {
  const pool = new KeyPool();
  pool.register('up1', []);
  assert.equal(pool.pick('up1'), null);
});

test('getAvailableKeys returns all uncooled keys', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2', 'k3']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  assert.deepEqual(pool.getAvailableKeys('up1'), ['k2', 'k3']);
});

test('getAvailableKeys returns empty for unregistered upstream', () => {
  const pool = new KeyPool();
  assert.deepEqual(pool.getAvailableKeys('up1'), []);
});

test('markCooldown immediately isolates the rejected key and leaves another selectable', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2']);
  pool.markCooldown('up1', 'k1', 30_000);
  assert.deepEqual(pool.getAvailableKeys('up1'), ['k2']);
  assert.equal(pool.pick('up1'), 'k2');
});

test('entry-aware operations distinguish credentials sharing the same key', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  const credA = { credentialId: 'cred-a', key: 'shared' };
  const credB = { credentialId: 'cred-b', key: 'shared' };
  pool.register('up1', [credA, credB]);
  assert.deepEqual(pool.pickEntry('up1'), credA);
  pool.markCooldown('up1', credA, 60_000);
  assert.deepEqual(pool.getAvailableEntries('up1'), [credB]);
  assert.deepEqual(pool.pickEntry('up1'), credB);
  pool.markSuccess('up1', credB);
  assert.deepEqual(pool.getAvailableEntries('up1'), [credB]);
  pool.markFailure('up1', credB);
  assert.deepEqual(pool.getAvailableEntries('up1'), [credB]);
});

test('Retry-After parses delta seconds and HTTP dates', () => {
  const now = Date.parse('2026-09-24T00:00:00.000Z');
  assert.equal(retryAfterDelayMs('12', now), 12_000);
  assert.equal(retryAfterDelayMs('Thu, 24 Sep 2026 00:00:15 GMT', now), 15_000);
});

test('Retry-After applies a bounded default and caps excessive values', () => {
  assert.equal(retryAfterDelayMs(null), 1_000);
  assert.equal(retryAfterDelayMs('nonsense'), 1_000);
  assert.equal(retryAfterDelayMs('999999999'), 15 * 60_000);
  assert.equal(retryAfterDelayMs('Thu, 24 Sep 2026 00:00:00 GMT', Date.parse('2026-09-24T00:00:10Z')), 0);
});

test('strategy random varies over many calls', () => {
  const pool = new KeyPool({ strategy: 'random' });
  pool.register('up1', ['k1', 'k2', 'k3']);
  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const k = pool.pick('up1');
    if (k) seen.add(k);
  }
  assert.ok(seen.size > 1, 'random should vary');
});
