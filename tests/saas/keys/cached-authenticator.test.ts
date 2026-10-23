import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CachedKeyAuthenticator } from '../../../src/saas/keys/cached-authenticator.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

function caller(expiresAt: string | null = null): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'key',
      tenantId: 'tenant',
      projectId: 'project',
      principalUserId: 'user',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user',
      createdByUserId: 'user',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement',
      supplyProfileId: 'profile',
      supplyMode: 'byok',
      name: 'test',
      prefix: 'mr_live_',
      modelScopes: ['model'],
      status: 'active',
      createdAt: new Date(0).toISOString(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'key',
      tenantId: 'tenant',
      projectId: 'project',
      principalKind: 'member',
      principalId: 'user',
      entitlementId: 'entitlement',
      supplyProfileId: 'profile',
      supplyMode: 'byok',
      modelScopes: ['model'],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
}

test('auth cache coalesces concurrent reads and isolates returned authorization snapshots', async () => {
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = new CachedKeyAuthenticator({
    authenticate: async () => {
      calls++;
      await wait;
      return caller();
    },
  });
  const results = Array.from({ length: 20 }, () => cache.authenticate('test-key'));
  release();
  const values = await Promise.all(results);
  assert.equal(calls, 1);
  (values[0]!.authorization.modelScopes as string[]).push('forged');
  assert.deepEqual((await cache.authenticate('test-key'))!.authorization.modelScopes, ['model']);
  assert.deepEqual(values[1]!.authorization.modelScopes, ['model']);
});

test('auth cache expires at the key expiry and never caches revocations or storage errors', async () => {
  let now = 1000;
  let calls = 0;
  let failure = false;
  const cache = new CachedKeyAuthenticator(
    {
      authenticate: async () => {
        calls++;
        if (failure) throw new Error('DB unavailable');
        return now < 1500 ? caller(new Date(1500).toISOString()) : null;
      },
    },
    { ttlMs: 5000, now: () => now },
  );
  assert.ok(await cache.authenticate('key'));
  now = 1499;
  assert.ok(await cache.authenticate('key'));
  assert.equal(calls, 1);
  now = 1500;
  assert.equal(await cache.authenticate('key'), null);
  assert.equal(calls, 2);
  assert.equal(await cache.authenticate('key'), null);
  assert.equal(calls, 3);
  failure = true;
  await assert.rejects(cache.authenticate('key'));
  await assert.rejects(cache.authenticate('key'));
  assert.equal(calls, 5);
});

test('auth TTL bounds cross-instance changes and LRU bounds key cardinality', async () => {
  let now = 0;
  let calls = 0;
  const cache = new CachedKeyAuthenticator(
    {
      authenticate: async () => {
        calls++;
        return caller();
      },
    },
    { maxEntries: 2, ttlMs: 1000, now: () => now },
  );
  await cache.authenticate('a');
  await cache.authenticate('b');
  await cache.authenticate('a');
  await cache.authenticate('c');
  assert.equal(calls, 3);
  await cache.authenticate('b');
  assert.equal(calls, 4);
  now = 1001;
  await cache.authenticate('b');
  assert.equal(calls, 5);
});
