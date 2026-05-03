import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool } from '../../src/server/keyPool.js';

test('pick returns one of registered keys', () => {
  const pool = new KeyPool();
  pool.register('up1', ['k1', 'k2', 'k3']);
  const key = pool.pick('up1');
  assert.ok(key === 'k1' || key === 'k2' || key === 'k3');
});

test('pick returns null for unregistered upstream', () => {
  const pool = new KeyPool();
  assert.equal(pool.pick('up1'), null);
});

test('pick randomness covers all keys over many calls', () => {
  const pool = new KeyPool();
  pool.register('up1', ['k1', 'k2', 'k3']);
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const k = pool.pick('up1');
    if (k) seen.add(k);
  }
  assert.equal(seen.size, 3);
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
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const k = pool.pick('up1');
    if (k) seen.add(k);
  }
  assert.ok(seen.has('k1'));
});

test('cooldown expires after duration', async () => {
  const pool = new KeyPool({ cooldownMs: 50 });
  pool.register('up1', ['k1', 'k2']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  assert.equal(pool.pick('up1'), 'k2');

  await new Promise((r) => setTimeout(r, 80));
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const k = pool.pick('up1');
    if (k) seen.add(k);
  }
  assert.ok(seen.has('k1'));
});

test('markFailure on different keys tracks independently', () => {
  const pool = new KeyPool({ cooldownMs: 60_000 });
  pool.register('up1', ['k1', 'k2', 'k3']);
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');
  pool.markFailure('up1', 'k1');

  for (let i = 0; i < 20; i++) {
    const k = pool.pick('up1');
    assert.ok(k === 'k2' || k === 'k3');
  }
});

test('pick returns null when no keys registered', () => {
  const pool = new KeyPool();
  pool.register('up1', []);
  assert.equal(pool.pick('up1'), null);
});
