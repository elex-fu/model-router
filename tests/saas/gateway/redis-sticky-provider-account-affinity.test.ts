import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderAccountSchedulerAffinityPort } from '../../../src/saas/gateway/provider-account-scheduler.js';
import { createRedisStickyProviderAccountAffinity } from '../../../src/saas/gateway/redis-sticky-provider-account-affinity.js';
import type { RedisCacheEntry, RedisRuntimeCache } from '../../../src/saas/runtime/redis-concurrency-slots.js';

interface CacheCall {
  readonly kind: 'get' | 'get-refresh' | 'set' | 'delete';
  readonly key: string;
  readonly value?: Buffer;
  readonly ttlMs?: number;
}

function fakeCache(
  entries: Map<string, Buffer> = new Map(),
  behavior: { readonly failGets?: boolean; readonly failSets?: boolean; readonly failDeletes?: boolean } = {},
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
    async delete(key): Promise<void> {
      calls.push({ kind: 'delete', key });
      if (behavior.failDeletes) throw new Error('redis delete failed');
      entries.delete(key);
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

test('an inner stale decision clears the Redis mapping and degrades to load balancing', async () => {
  // Learn the sticky key through a miss + backfill.
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

  // PG says the binding is cleared (target unschedulable): the decorator
  // forwards 'stale' and DELETES the Redis copy (shouldClearStickySession).
  const staleCache = fakeCache(new Map([[key, Buffer.from('account-9')]]));
  const stale = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'stale' } as const;
      },
    },
    { cache: staleCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await stale.resolve(resolveInput() as never), { decision: 'stale' });
  const del = staleCache.calls.find((call) => call.kind === 'delete');
  assert.ok(del, 'a stale inner decision clears the Redis mapping');
  assert.equal(del.key, key);
  assert.equal(staleCache.calls.filter((call) => call.kind === 'set').length, 0, 'no backfill on stale');

  // A failed delete never fails the resolve: the decision is still stale and
  // the leftover row is re-checked against eligibility on every later read.
  const failedDeleteCache = fakeCache(new Map([[key, Buffer.from('account-9')]]), { failDeletes: true });
  const failedDelete = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'stale' } as const;
      },
    },
    { cache: failedDeleteCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await failedDelete.resolve(resolveInput() as never), { decision: 'stale' });

  // Stale without any Redis entry: forwarded unchanged. The clear is still
  // issued (idempotent DEL — a racing writer's row is stale by definition).
  const emptyCache = fakeCache();
  const emptyStale = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'stale' } as const;
      },
    },
    { cache: emptyCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await emptyStale.resolve(resolveInput() as never), { decision: 'stale' });
  assert.equal(emptyCache.calls.filter((call) => call.kind === 'delete').length, 1);
});

test('an ineligible hit over a PG miss clears the drifted Redis mapping', async () => {
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

  // The Redis row is ineligible AND PG holds no active binding (its row
  // expired first): the drift is deleted instead of resurrected.
  const driftCache = fakeCache(new Map([[key, Buffer.from('account-9')]]));
  const drift = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: null };
      },
    },
    { cache: driftCache.cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await drift.resolve(resolveInput() as never), { decision: 'allow', accountId: null });
  assert.ok(
    driftCache.calls.find((call) => call.kind === 'delete'),
    'drifted Redis row is cleared',
  );
  assert.equal(driftCache.calls.filter((call) => call.kind === 'set').length, 0);
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

test('bind forwards contention unchanged without backfilling or clearing the losing proposal', async () => {
  const entries = new Map<string, Buffer>();
  const { cache, calls } = fakeCache(entries);
  const input = {
    context: { sessionId: 'contended-session', previousResponseId: 'contended-response' },
    scope: { supplyProfileId: 'profile-1', accountOwnerKind: 'platform' },
    accountId: 'account-1',
  } as const;
  const seed = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: null };
      },
      async bind() {
        return { decision: 'allow' };
      },
    },
    { cache, keyPrefix: 'model-router:saas' },
  );
  assert.deepEqual(await seed.bind?.(input as never), { decision: 'allow' });
  assert.equal(calls.filter(({ kind }) => kind === 'set').length, 1);
  const before = [...entries.entries()].map(([key, value]) => [key, Buffer.from(value)]);
  calls.length = 0;

  const contention = Object.freeze({
    decision: 'block',
    reason: 'provider account affinity binding conflict',
    contention: Object.freeze({ kind: 'active_binding', accountId: 'account-1' }),
  } as const);
  const losingInput = { ...input, accountId: 'account-2' };
  let binds = 0;
  const decorator = createRedisStickyProviderAccountAffinity(
    {
      async resolve() {
        return { decision: 'allow', accountId: null };
      },
      async bind(actual) {
        binds += 1;
        assert.strictEqual(actual, losingInput);
        return contention;
      },
    },
    { cache, keyPrefix: 'model-router:saas' },
  );
  assert.strictEqual(await decorator.bind?.(losingInput as never), contention);
  assert.equal(binds, 1);
  assert.deepEqual(calls, [], 'a losing proposal performs no Redis reads, writes, TTL refreshes or deletes');
  assert.deepEqual([...entries.entries()], before);
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
