import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool } from '../../src/server/keyPool.js';

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
