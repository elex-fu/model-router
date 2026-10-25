import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/index.js';
import { CachedRequestPreparationEntitlement } from '../../../src/saas/gateway/cached-request-preparation-entitlement.js';
import type {
  RequestPreparationCaller,
  RequestPreparationDecision,
  RequestPreparationEntitlement,
  RequestPreparationEntitlementPort,
  RequestPreparationSqlOptions,
} from '../../../src/saas/gateway/request-preparation-service.js';

/*
 * §12.2 Phase A2a (D2): the version-keyed, allow-only cache around the
 * pre-dispatch entitlement resolution (CachedRequestPreparationEntitlement).
 * The admission guard remains the fail-closed defense line; these tests pin
 * the cache contract itself, mirroring the authority-cache test suite.
 */

function caller(overrides: Partial<RequestPreparationCaller> = {}): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'byok',
    modelScopes: ['public-model'],
    authzVersion: 4,
    entitlementVersion: 5,
    supplyProfileVersion: 6,
    modelScopeVersion: 7,
    ...overrides,
  };
}

function entitlementValue(overrides: Partial<RequestPreparationEntitlement> = {}): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 5,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 6,
    supplyMode: 'byok',
    modelScopeVersion: 7,
    allowedModels: ['public-model'],
    allowedProviderIds: ['provider-a'],
    projectPolicyVersion: 3,
    ...overrides,
  };
}

interface FakeAuthority extends RequestPreparationEntitlementPort {}

function fakeAuthority(decisions: RequestPreparationDecision<RequestPreparationEntitlement>[]): {
  port: FakeAuthority;
  calls: () => number;
} {
  let calls = 0;
  const port: FakeAuthority = {
    async resolve(_input, _options?: RequestPreparationSqlOptions) {
      calls++;
      const decision = decisions[Math.min(calls - 1, decisions.length - 1)];
      return decision.decision === 'allow' ? { decision: 'allow', value: { ...decision.value } } : decision;
    },
  };
  return { port, calls: () => calls };
}

const executor = { query: async () => ({ rows: [] }) } as unknown as SqlExecutor;

test('version-keyed entitlement cache reuses the allow decision while the version tuple is unchanged', async () => {
  const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
  const cached = new CachedRequestPreparationEntitlement(port);
  const first = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
  assert.equal(first.decision, 'allow');
  assert.equal(calls(), 1);
  // Fresh, structurally equal caller objects (the production path
  // re-validates the caller per request): the key is content-based.
  const second = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
  assert.equal(second.decision, 'allow');
  assert.equal(calls(), 1, 'a cache hit must not re-resolve the entitlement');
  assert.deepEqual(second, first);
  // Concurrent identical resolutions collapse into one underlying resolve.
  const [third, fourth] = await Promise.all([
    cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' }),
    cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' }),
  ]);
  assert.equal(third.decision, 'allow');
  assert.equal(fourth.decision, 'allow');
  assert.equal(calls(), 1, 'single-flight must not re-resolve');
  // Cross-request isolation: mutating a returned decision must not poison the cache.
  (fourth as unknown as { value: { allowedModels: string[] } }).value.allowedModels.push('mutated');
  const fifth = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
  assert.equal(fifth.decision, 'allow');
  if (fifth.decision !== 'allow') return;
  assert.deepEqual(fifth.value.allowedModels, ['public-model']);
  assert.equal(calls(), 1);
});

test('any version or identity change in the entitlement cache key forces a fresh resolution', async (t) => {
  const resolveOnce = async (
    overrides: Partial<RequestPreparationCaller>,
    publicModel: string = 'public-model',
  ): Promise<number> => {
    const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    await cached.resolve({ caller: caller(), publicModel, protocol: 'openai' });
    await cached.resolve({ caller: caller(overrides), publicModel, protocol: 'openai' });
    return calls();
  };
  await t.test('caller authz version (proxy key epoch)', async () => {
    assert.equal(await resolveOnce({ authzVersion: 40 }), 2, 'the bumped version key must miss');
  });
  await t.test('caller entitlement version', async () => {
    assert.equal(await resolveOnce({ entitlementVersion: 50 }), 2, 'the bumped version key must miss');
  });
  await t.test('caller supply profile version', async () => {
    assert.equal(await resolveOnce({ supplyProfileVersion: 60 }), 2, 'the bumped version key must miss');
  });
  await t.test('caller model scope version', async () => {
    assert.equal(await resolveOnce({ modelScopeVersion: 70 }), 2, 'the bumped version key must miss');
  });
  await t.test('caller identity (supply profile id)', async () => {
    assert.equal(await resolveOnce({ supplyProfileId: 'profile-b' }), 2, 'a moved binding must miss');
  });
  await t.test('caller model scopes content', async () => {
    assert.equal(await resolveOnce({ modelScopes: ['public-model', 'public-model-b'] }), 2, 'scope change must miss');
  });
  await t.test('public model', async () => {
    const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    await cached.resolve({ caller: caller(), publicModel: 'public-model-b', protocol: 'openai' });
    assert.equal(calls(), 2, 'a different model scope fact must miss');
  });
  await t.test('protocol', async () => {
    const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'anthropic' });
    assert.equal(calls(), 2, 'a different protocol must miss');
  });
});

test('an expired entitlement cache entry re-resolves', async () => {
  let clock = 1_000_000;
  const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
  const cached = new CachedRequestPreparationEntitlement(port, { ttlMs: 5000, now: () => clock });
  await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
  assert.equal(calls(), 1);
  clock += 5000; // at the boundary the entry is already expired
  const second = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
  assert.equal(second.decision, 'allow');
  assert.equal(calls(), 2, 'an expired entry must re-resolve');
});

test('rejected and blocked entitlement decisions are never cached', async (t) => {
  await t.test('reject (entitlement_denied)', async () => {
    const { port, calls } = fakeAuthority([{ decision: 'reject', code: 'entitlement_denied', message: 'denied' }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    const first = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(first.decision, 'reject');
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(calls(), 2, 'a rejection must be re-resolved every time');
  });
  await t.test('block (storage_failure)', async () => {
    const { port, calls } = fakeAuthority([{ decision: 'block', code: 'storage_failure', message: 'unavailable' }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    const first = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(first.decision, 'block');
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(calls(), 2, 'a block must be re-resolved every time');
  });
});

test('the entitlement cache evicts the least recently used entry at its size bound', async () => {
  const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
  const cached = new CachedRequestPreparationEntitlement(port, { maxEntries: 2 });
  const inputFor = (authzVersion: number) => ({
    caller: caller({ authzVersion }),
    publicModel: 'public-model',
    protocol: 'openai' as const,
  });
  assert.equal((await cached.resolve(inputFor(4))).decision, 'allow');
  assert.equal((await cached.resolve(inputFor(40))).decision, 'allow');
  assert.equal(calls(), 2);
  assert.equal((await cached.resolve(inputFor(400))).decision, 'allow');
  assert.equal(calls(), 3, 'the third distinct key evicts the least recently used entry');
  // authzVersion 4 was the least recently used and was evicted; 400 is the
  // most recent and must still be a hit.
  assert.equal((await cached.resolve(inputFor(400))).decision, 'allow');
  assert.equal(calls(), 3, 'the most recently used entry must still be a cache hit');
  // The evicted key misses and re-resolves (evicting 40 in turn).
  assert.equal((await cached.resolve(inputFor(4))).decision, 'allow');
  assert.equal(calls(), 4, 'an evicted key must miss and re-resolve');
});

test('executor-carrying (in-transaction) resolutions bypass the cache entirely', async (t) => {
  await t.test('an in-transaction resolve is never served from or written to the cache', async () => {
    const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    const sqlOptions: RequestPreparationSqlOptions = { executor, now: new Date(0) };
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' }, sqlOptions);
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' }, sqlOptions);
    assert.equal(calls(), 2, 'an in-transaction resolve must always hit the underlying port');
    // The bypassed results were not cached: a plain (no-executor) resolve
    // still resolves live instead of replaying a fenced snapshot.
    const plain = await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(plain.decision, 'allow');
    assert.equal(calls(), 3, 'a plain resolve after only bypassed calls must not hit a cache');
    // And the plain allow is cached from here on.
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(calls(), 3, 'the allow decision is now cached');
  });
  await t.test('an in-transaction resolve is never served a cached allow', async () => {
    const { port, calls } = fakeAuthority([{ decision: 'allow', value: entitlementValue() }]);
    const cached = new CachedRequestPreparationEntitlement(port);
    await cached.resolve({ caller: caller(), publicModel: 'public-model', protocol: 'openai' });
    assert.equal(calls(), 1);
    const fresh = await cached.resolve(
      { caller: caller(), publicModel: 'public-model', protocol: 'openai' },
      { executor },
    );
    assert.equal(fresh.decision, 'allow');
    assert.equal(calls(), 2, 'an in-transaction resolve must bypass even a warm cache');
  });
});
