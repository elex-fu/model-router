import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { CachedSchedulerHints } from '../../../src/saas/gateway/cached-scheduler-hints.js';
import { PostgresProviderAccountModelCooldownRegistry } from '../../../src/saas/gateway/postgres-provider-account-model-cooldowns.js';
import { ProviderAccountModelRateLimit } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type { ProviderAccountSchedulerInput } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';
import { createRedisProvider } from '../../../src/saas/runtime/redis-rate-limit-provider.js';
import {
  CANCELLATION_PG_REQUIRED,
  cancellationDatabases,
  cancellationPgConfigured,
} from './pre-dispatch-postgres-fixture.js';

const redisUrl = process.env.ROUTER_TEST_REDIS_URL;
test('scheduler hints: real gateway role batch reads and independent Redis instance cache hits', {
  skip: !redisUrl || (process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured),
  timeout: 120_000,
}, async (t) => {
  assert.ok(redisUrl);
  const target = new URL(redisUrl);
  assert.equal(target.hostname, '127.0.0.1');
  assert.ok(target.port && !['6379', '6380'].includes(target.port), 'disposable explicit Redis port required');
  const { databases, gateway, migrator } = await cancellationDatabases();
  const provider = await createRedisProvider({ url: redisUrl, keyPrefix: `test-hints:${randomUUID()}` });
  const redis = await provider.createCacheClient();
  const account = `hint-${randomUUID()}`;
  t.after(async () => {
    await migrator.query('DELETE FROM saas_provider_account_model_cooldowns WHERE account_id = $1', [account]);
    await provider.close();
    await Promise.all(databases.map((db) => db.close()));
  });
  const candidate = {
    tenantId: 'hint-tenant',
    accountId: account,
    upstreamId: 'hint-upstream',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    resolvedModel: 'hint-model',
  } as RequestPreparationCandidateAuthority;
  const input = { candidates: [candidate] } as ProviderAccountSchedulerInput;
  let calls = 0;
  const database = {
    query: (...args: Parameters<SaasDatabase['query']>) => {
      calls++;
      return gateway.query(...args);
    },
  } as unknown as SaasDatabase;
  let now = Date.now();
  const local = new ProviderAccountModelRateLimit();
  const make = () =>
    new CachedSchedulerHints(database, local, { redis, now: () => now, ttlMs: 1000, redisBudgetMs: 100 });
  const a = make();
  await a.run(input, async () => {
    assert.equal(a.cooldown(candidate, 'hint-model', new Date(now)), false);
    assert.equal(a.window(account), null);
  });
  assert.equal(calls, 2, 'one cooldown batch and one window policy batch');
  // Wait for dispensable asynchronous fill, not for a financial write.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const b = make();
  await b.run(input, async () => assert.equal(b.cooldown(candidate, 'hint-model', new Date(now)), false));
  assert.equal(calls, 2, 'independent L1 instance reads shared Redis without PG');
  const registry = new PostgresProviderAccountModelCooldownRegistry({ database: gateway, local });
  await registry.recordModelRateLimit({ candidate, model: 'hint-model', nowMs: now });
  await b.run(input, async () => assert.equal(b.cooldown(candidate, 'hint-model', new Date(now)), true));
  assert.equal(calls, 2, 'new local cooldown overrides a shared negative');

  const scope = JSON.stringify(['platform', account, 'hint-model']);
  const key = createHash('sha256')
    .update(JSON.stringify([scope]))
    .digest('hex');
  await redis.set(`scheduler-hints:v1:${key}`, Buffer.from('{malformed'), 1000);
  const c = make();
  await c.run(input, async () => assert.equal(c.cooldown(candidate, 'hint-model', new Date(now)), true));
  assert.equal(calls, 4, 'malformed Redis falls back to real PG');
  await new Promise((resolve) => setTimeout(resolve, 20));
  now += 1001;
  const d = make();
  await d.run(input, async () => assert.equal(d.cooldown(candidate, 'hint-model', new Date(now)), true));
  assert.equal(calls, 6, 'original snapshot expiry cannot be renewed by an instance');
});
