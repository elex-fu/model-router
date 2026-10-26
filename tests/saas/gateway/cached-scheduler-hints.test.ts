import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { CachedSchedulerHints } from '../../../src/saas/gateway/cached-scheduler-hints.js';
import { ProviderAccountModelRateLimit } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { ProviderAccountSchedulerInput } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import type { RedisRuntimeCache } from '../../../src/saas/runtime/redis-concurrency-slots.js';

const candidate = (id = 'a', model = 'm', tenant = 'tenant') =>
  ({
    tenantId: tenant,
    accountId: id,
    upstreamId: 'upstream',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    resolvedModel: model,
  }) as RequestPreparationCandidateAuthority;
const input = (...candidates: RequestPreparationCandidateAuthority[]) =>
  ({ candidates }) as ProviderAccountSchedulerInput;
function fixture(options: { redis?: RedisRuntimeCache; maxEntries?: number } = {}) {
  let now = 1_800_000_000_000;
  let fail = false;
  let advanceOnRead = 0;
  let cooldownRows: unknown[] = [];
  let windowRows: unknown[] = [];
  let costRows: unknown[] = [];
  const queries: string[] = [];
  const database = {
    query: async (sql: string) => {
      queries.push(sql);
      if (fail) throw new Error('unavailable');
      now += advanceOnRead;
      const rows = sql.includes('scheduler-hints:cooldowns-batch')
        ? cooldownRows
        : sql.includes('sum(cost.amount_minor_units)')
          ? costRows
          : windowRows;
      return { rows, rowCount: rows.length };
    },
  } as unknown as SaasDatabase;
  const local = new ProviderAccountModelRateLimit();
  const cache = new CachedSchedulerHints(database, local, { ...options, now: () => now });
  return {
    cache,
    local,
    queries,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    slow: (ms: number) => {
      advanceOnRead = ms;
    },
    cooldowns: (rows: unknown[]) => {
      cooldownRows = rows;
    },
    windows: (rows: unknown[]) => {
      windowRows = rows;
    },
    costs: (rows: unknown[]) => {
      costRows = rows;
    },
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function redisFixture() {
  const values = new Map<string, Buffer>();
  let gets = 0;
  let sets = 0;
  const redis = {
    get: async (key: string) => {
      gets++;
      return { state: values.has(key) ? 'hit' : 'miss', value: values.get(key) ?? null };
    },
    set: async (key: string, value: Buffer) => {
      sets++;
      values.set(key, value);
    },
  } as RedisRuntimeCache;
  return { redis, values, gets: () => gets, sets: () => sets };
}

test('four candidates use two batch queries and confirmed-empty L1 avoids subsequent DB reads', async () => {
  const f = fixture();
  const candidates = ['a', 'b', 'c', 'd'].map((id) => candidate(id));
  for (let i = 0; i < 2; i++)
    await f.cache.run(input(...candidates), async () => {
      for (const c of candidates) {
        assert.equal(f.cache.cooldown(c, c.resolvedModel, new Date(f.now())), false);
        assert.equal(f.cache.window(c.accountId), null);
      }
    });
  assert.equal(f.queries.length, 2);
  assert.equal(f.cache.window('a'), undefined, 'scope does not escape request');
});

test('candidate ordering normalizes, model changes miss, unknown candidate is not a confirmed negative', async () => {
  const f = fixture();
  await f.cache.run(input(candidate('a'), candidate('b')), async () => {});
  await f.cache.run(input(candidate('b'), candidate('a')), async () => {
    assert.equal(f.cache.window('unknown'), undefined);
    assert.equal(f.cache.cooldown(candidate('a', 'other'), 'other', new Date(f.now())), undefined);
  });
  assert.equal(f.queries.length, 2);
  await f.cache.run(input(candidate('a', 'other')), async () => {});
  assert.equal(f.queries.length, 4);
});

test('local new cooldown immediately overrides cached negative', async () => {
  const f = fixture();
  const c = candidate();
  await f.cache.run(input(c), async () => {});
  f.local.recordModelRateLimit({ candidate: c, model: 'm', nowMs: f.now() });
  await f.cache.run(input(c), async () => assert.equal(f.cache.cooldown(c, 'm', new Date(f.now())), true));
  assert.equal(f.queries.length, 2);
});

test('DB errors are not cached as empty; next request recovers', async () => {
  const f = fixture();
  f.fail(true);
  await f.cache.run(input(candidate()), async () => assert.equal(f.cache.window('a'), null));
  f.fail(false);
  await f.cache.run(input(candidate()), async () => assert.equal(f.cache.window('a'), null));
  assert.equal(f.queries.length, 4);
});

test('original expiry, slow PG and L1 eviction cannot renew old snapshots', async () => {
  const f = fixture({ maxEntries: 1 });
  await f.cache.run(input(candidate()), async () => {});
  f.advance(100);
  await f.cache.run(input(candidate()), async () => {});
  assert.equal(f.queries.length, 4);
  await f.cache.run(input(candidate('b')), async () => {});
  await f.cache.run(input(candidate()), async () => {});
  assert.equal(f.queries.length, 8);
  f.advance(100);
  f.slow(200);
  await f.cache.run(input(candidate()), async () => {});
  await f.cache.run(input(candidate()), async () => {});
  assert.equal(f.queries.length, 12);
});

test('same-key concurrent requests coalesce PG batch and retain exact bigint window facts', async () => {
  const f = fixture();
  f.windows([{ account_id: 'a', limit: '9007199254740993', reserve: '20', window_start: new Date(f.now()) }]);
  f.costs([{ account_id: 'a', total: '9007199254740992' }]);
  await Promise.all(
    Array.from({ length: 20 }, () =>
      f.cache.run(input(candidate()), async () => {
        assert.equal(f.cache.window('a')?.usageMinorUnits, 9007199254740992n);
        assert.equal(f.cache.window('a')?.limitMinorUnits, 9007199254740993n);
      }),
    ),
  );
  assert.equal(f.queries.length, 3);
});

test('new instance shares Redis snapshot without refreshing original expiry', async () => {
  const r = redisFixture();
  const first = fixture({ redis: r.redis });
  await first.cache.run(input(candidate()), async () => {});
  await tick();
  assert.equal(r.sets(), 1);
  const second = fixture({ redis: r.redis });
  second.advance(99);
  await second.cache.run(input(candidate()), async () => assert.equal(second.cache.window('a'), null));
  assert.equal(second.queries.length, 0);
  second.advance(1);
  await second.cache.run(input(candidate()), async () => {});
  assert.equal(second.queries.length, 2);
});

test('Redis timeout retains busy permit until actual command resolves; requests bypass queue', async () => {
  let release!: () => void;
  let gets = 0;
  const redis = {
    get: () => {
      gets++;
      return new Promise((resolve) => {
        release = () => resolve({ state: 'miss', value: null });
      });
    },
    set: async () => {},
  } as RedisRuntimeCache;
  const f = fixture({ redis });
  await f.cache.run(input(candidate()), async () => {});
  await f.cache.run(input(candidate('b')), async () => {});
  assert.equal(gets, 1);
  assert.equal(f.queries.length, 4);
  release();
  await tick();
  await f.cache.run(input(candidate('c')), async () => {});
  assert.equal(gets, 2);
  release();
  await tick();
});

test('malformed shared snapshot falls back to PG and a pending fill never blocks request', async () => {
  let gets = 0;
  const redis = {
    get: async () => {
      gets++;
      return { state: 'hit', value: Buffer.from('{bad') };
    },
    set: () => new Promise(() => {}),
  } as RedisRuntimeCache;
  const f = fixture({ redis });
  await f.cache.run(input(candidate()), async () => {});
  await f.cache.run(input(candidate('b')), async () => {});
  assert.equal(gets, 1, 'pending fill owns connection until actual completion');
  assert.equal(f.queries.length, 4);
});

test('snapshot expires at hour boundary and failed cooldown data cannot create empty cache', async () => {
  const f = fixture();
  f.advance(3_600_000 - (f.now() % 3_600_000) - 1);
  await f.cache.run(input(candidate()), async () => {});
  f.advance(1);
  await f.cache.run(input(candidate()), async () => {});
  assert.equal(f.queries.length, 4);
  const broken = fixture();
  broken.cooldowns([{ owner_scope_key: 'platform', account_id: 'a', model: 'm', cooled_until: 'bad' }]);
  await broken.cache.run(input(candidate()), async () => assert.equal(broken.cache.window('a'), null));
  await broken.cache.run(input(candidate()), async () => {});
  assert.equal(broken.queries.length, 4);
});

test('slow PG and mid-selection expiry fail open without per-candidate DB amplification', async () => {
  const slow = fixture();
  slow.slow(200);
  await slow.cache.run(input(candidate()), async () => {
    assert.equal(slow.cache.window('a'), null);
    assert.equal(slow.cache.cooldown(candidate(), 'm', new Date(slow.now())), false);
  });
  assert.equal(slow.queries.length, 2);
  const f = fixture();
  await f.cache.run(input(candidate()), async () => {
    assert.equal(f.cache.window('a'), null);
    f.advance(100);
    assert.equal(f.cache.window('a'), null);
    assert.equal(f.cache.cooldown(candidate(), 'm', new Date(f.now())), false);
  });
});

test('positive cooldown is scoped by owner/model and respects cooledUntil', async () => {
  const f = fixture();
  f.cooldowns([{ owner_scope_key: 'platform', account_id: 'a', model: 'm', cooled_until: new Date(f.now() + 10) }]);
  await f.cache.run(input(candidate()), async () => {
    assert.equal(f.cache.cooldown(candidate(), 'm', new Date(f.now())), true);
    f.advance(10);
    assert.equal(f.cache.cooldown(candidate(), 'm', new Date(f.now())), false);
  });
});

test('tenant/BYOK identities are isolated despite identical account and model', async () => {
  const f = fixture();
  const a = {
    ...candidate(),
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    accountOwnerTenantId: 'tenant-a',
    tenantId: 'tenant-a',
  } as RequestPreparationCandidateAuthority;
  const b = { ...a, tenantId: 'tenant-b', accountOwnerTenantId: 'tenant-b' };
  await f.cache.run(input(a), async () => {});
  await f.cache.run(input(b), async () => {});
  assert.equal(f.queries.length, 4);
});

test('well-formed shared payload with wrong scope or excessive bytes is not trusted', async () => {
  for (const mutate of [
    (value: Record<string, unknown>) => {
      value.cooldowns = [['wrong-scope', 1_800_000_000_099]];
    },
    (value: Record<string, unknown>) => {
      value.windows = [['unexpected-account', null, null, 0, '0']];
    },
    (value: Record<string, unknown>) => {
      value.padding = 'x'.repeat(4096);
    },
  ]) {
    const r = redisFixture();
    const f = fixture({ redis: r.redis });
    await f.cache.run(input(candidate()), async () => {});
    await tick();
    for (const [key, bytes] of r.values) {
      const decoded = JSON.parse(bytes.toString());
      mutate(decoded);
      r.values.set(key, Buffer.from(JSON.stringify(decoded)));
    }
    const next = fixture({ redis: r.redis });
    await next.cache.run(input(candidate()), async () => {});
    assert.equal(next.queries.length, 2);
  }
});

test('failed batch is never published as a confirmed-empty Redis snapshot', async () => {
  const r = redisFixture();
  const f = fixture({ redis: r.redis });
  f.fail(true);
  await f.cache.run(input(candidate()), async () => {
    assert.equal(f.cache.window('a'), null, 'unavailable optional hint fails open for this selection only');
  });
  await tick();
  assert.equal(r.sets(), 0);
  f.fail(false);
  await f.cache.run(input(candidate()), async () => {});
  await tick();
  assert.equal(f.queries.length, 4);
  assert.equal(r.sets(), 1);
});
