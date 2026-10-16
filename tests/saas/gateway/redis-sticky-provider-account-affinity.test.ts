import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderAccountSchedulerAffinityPort } from '../../../src/saas/gateway/provider-account-scheduler.js';
import { createRedisStickyProviderAccountAffinity } from '../../../src/saas/gateway/redis-sticky-provider-account-affinity.js';
import type { RedisCacheEntry, RedisRuntimeCache } from '../../../src/saas/runtime/redis-concurrency-slots.js';

interface CacheCall {
  readonly kind: 'get' | 'get-refresh' | 'set';
  readonly key: string;
  readonly value?: Buffer;
  readonly ttlMs?: number;
}

function fakeCache(
  entries: Map<string, Buffer> = new Map(),
  behavior: { readonly failGets?: boolean; readonly failSets?: boolean } = {},
): { cache: RedisRuntimeCache; calls: CacheCall[] } {
  const calls: CacheCall[] = [];
  const cache: RedisRuntimeCache = {
    async get(key): Promise<RedisCacheEntry> {
      calls.push({ kind: 'get', key });
      if (behavior.failGets) return { state: 'unavailable', value: null };
      const value = entries.get(key);
      return value === undefined ? { state: 'miss', value: null } : { state: 'hit', value: Buffer.from(value) };
    },
    async getAndRefreshTtl(key, ttlMs): Promise<RedisCacheEntry> {
      calls.push({ kind: 'get-refresh', key, ttlMs });
      if (behavior.failGets) return { state: 'unavailable', value: null };
      const value = entries.get(key);
      return value === undefined ? { state: 'miss', value: null } : { state: 'hit', value: Buffer.from(value) };
    },
    async set(key, value, ttlMs): Promise<void> {
      calls.push({ kind: 'set', key, value: Buffer.from(value), ttlMs });
      if (behavior.failSets) throw new Error('redis set failed');
      entries.set(key, Buffer.from(value));
    },
  };
  return { cache, calls };
}

function resolveInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: { sessionId: 'session-1' },
    scope: { supplyProfileId: 'profile-1', accountOwnerKind: 'platform' },
    eligibleAccountIds: ['account-1', 'account-2'],
    ...overrides,
  };
}

test('a sticky hit whose account is still eligible short-circuits PG and slides the TTL', async () => {
  let innerResolves = 0;
  const inner = {
    async resolve() {
      innerResolves += 1;
      return { decision: 'allow', accountId: 'account-2' } as const;
    },
  };
  // First run with an empty cache to learn the sticky key the decorator
  // computes for this scope + session, and to observe the backfill.
  const missCache = fakeCache();
  const learn = createRedisStickyProviderAccountAffinity(inner as never, {
    cache: missCache.cache,
    keyPrefix: 'model-router:saas',
  });
  const missDecision = await learn.resolve(resolveInput() as never);
  assert.deepEqual(missDecision, { decision: 'allow', accountId: 'account-2' });
  // A miss is still a sliding-read miss: the lookup itself refreshes nothing.
  const missRead = missCache.calls.find((call) => call.kind === 'get-refresh');
  assert.ok(missRead);
  assert.equal(missRead.ttlMs, 3_600_000);
  const setCall = missCache.calls.find((call) => call.kind === 'set');
  assert.ok(setCall);
  assert.equal(setCall.ttlMs, 3_600_000);
  assert.equal(setCall.value?.toString('utf8'), 'account-2');

  // Seed the learned key with a still-eligible account: the Redis hit wins,
  // the PG source is never consulted, and the hit SLIDES the TTL window
  // (one get-refresh with the full 1h TTL, no rewrite of the mapping).
  const before = innerResolves;
  const hitCache = fakeCache(new Map([[setCall.key, Buffer.from('account-1')]]));
  const sticky = createRedisStickyProviderAccountAffinity(inner as never, {
    cache: hitCache.cache,
    keyPrefix: 'model-router:saas',
  });
  const hitDecision = await sticky.resolve(resolveInput() as never);
  assert.deepEqual(hitDecision, { decision: 'allow', accountId: 'account-1' });
  assert.equal(innerResolves, before, 'the PG affinity source is not consulted on a valid hit');
  const hitRead = hitCache.calls.find((call) => call.kind === 'get-refresh');
  assert.ok(hitRead, 'a hit is served through the sliding-TTL read');
  assert.equal(hitRead.key, setCall.key);
  assert.equal(hitRead.ttlMs, 3_600_000, 'the hit refreshes the full 1h sliding window');
  assert.equal(hitCache.calls.filter((call) => call.kind === 'set').length, 0, 'a hit does not rewrite the mapping');
  assert.equal(hitCache.calls.filter((call) => call.kind === 'get').length, 0, 'the sticky path never plain-GETs');

  // A custom ttlMs option drives the sliding refresh too (same window as set).
  const customTtlCache = fakeCache(new Map([[setCall.key, Buffer.from('account-1')]]));
  const customTtl = createRedisStickyProviderAccountAffinity(inner as never, {
    cache: customTtlCache.cache,
    keyPrefix: 'model-router:saas',
    ttlMs: 3_600_000 / 2,
  });
  await customTtl.resolve(resolveInput() as never);
  assert.equal(customTtlCache.calls.find((call) => call.kind === 'get-refresh')?.ttlMs, 1_800_000);
});

test('an ineligible hit, a miss and an unavailable Redis all fall back to the PG source', async () => {
  const learned = new Map<string, Buffer>();
  const learnCache = fakeCache(learned);
  const learn = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: 'account-1' };
      },
    },
    { cache: learnCache.cache, keyPrefix: 'model-router:saas' },
  );
  await learn.resolve(resolveInput() as never);
  const key = learnCache.calls.find((call) => call.kind === 'set')?.key;
  assert.ok(key);

  // Ineligible hit: the PG source decides (and its answer is backfilled over
  // the stale mapping only through set — the stale value is not returned).
  const ineligibleCache = fakeCache(new Map([[key, Buffer.from('account-9')]]));
  const ineligible = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: 'account-2' };
      },
    },
    { cache: ineligibleCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await ineligible.resolve(resolveInput() as never), { decision: 'allow', accountId: 'account-2' });
  const overwritten = ineligibleCache.calls.find((call) => call.kind === 'set');
  assert.equal(overwritten?.value?.toString('utf8'), 'account-2');

  // Miss: PG decides, result backfilled.
  const missCache = fakeCache();
  const miss = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: 'account-2' };
      },
    },
    { cache: missCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await miss.resolve(resolveInput() as never), { decision: 'allow', accountId: 'account-2' });
  assert.equal(missCache.calls.find((call) => call.kind === 'set')?.value?.toString('utf8'), 'account-2');

  // Unavailable Redis: pure-PG path, no crash, no set.
  const unavailableCache = fakeCache(new Map(), { failGets: true, failSets: true });
  const unavailable = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'block', reason: 'stale' };
      },
    },
    { cache: unavailableCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await unavailable.resolve(resolveInput() as never), { decision: 'block', reason: 'stale' });

  // No session reference at all: no Redis traffic, straight to PG.
  const noReference = fakeCache();
  const none = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: null };
      },
    },
    { cache: noReference.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await none.resolve(resolveInput({ context: {} }) as never), { decision: 'allow', accountId: null });
  assert.equal(noReference.calls.length, 0);
});

test('bind forwards to PG and backfills the mapping; previousResponseId ranks below sessionId', async () => {
  const { cache, calls } = fakeCache();
  let bound = 0;
  const inner: ProviderAccountSchedulerAffinityPort = {
    async resolve() {
      return { decision: 'allow', accountId: null };
    },
    async bind() {
      bound += 1;
      return { decision: 'allow' };
    },
  };
  const decorator = createRedisStickyProviderAccountAffinity(inner, { cache, keyPrefix: 'model-router:saas' });
  const bindDecision = await decorator.bind?.({
    context: { sessionId: 'session-2' },
    scope: { supplyProfileId: 'profile-1', accountOwnerKind: 'tenant' },
    accountId: 'account-7',
  } as never);
  assert.deepEqual(bindDecision, { decision: 'allow' });
  assert.equal(bound, 1);
  const setCall = calls.find((call) => call.kind === 'set');
  assert.ok(setCall);
  assert.equal(setCall.value?.toString('utf8'), 'account-7');
  assert.equal(setCall.ttlMs, 3_600_000);

  // A response reference still produces a (different) sticky key.
  const responseOnly = fakeCache();
  const decorator2 = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: 'account-1' };
      },
    },
    { cache: responseOnly.cache, keyPrefix: 'model-router:saas' },
  );
  await decorator2.resolve(resolveInput({ context: { previousResponseId: 'resp-1' } }) as never);
  const responseKey = responseOnly.calls.find((call) => call.kind === 'set')?.key;
  assert.ok(responseKey);
  assert.notEqual(responseKey, setCall.key);
  assert.ok(!responseKey.includes('resp-1'));
});

test('invalid construction fails closed', () => {
  const { cache } = fakeCache();
  assert.throws(() => createRedisStickyProviderAccountAffinity(null as never, { cache, keyPrefix: 'p' }));
  assert.throws(() => createRedisStickyProviderAccountAffinity({} as never, { cache, keyPrefix: 'p' }));
  assert.throws(() =>
    createRedisStickyProviderAccountAffinity(
      {
        async resolve() {
          return { decision: 'allow', accountId: null };
        },
      },
      null as never,
    ),
  );
  assert.throws(() =>
    createRedisStickyProviderAccountAffinity(
      {
        async resolve() {
          return { decision: 'allow', accountId: null };
        },
      },
      { cache, keyPrefix: '' },
    ),
  );
});
