import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisQuotaState } from '../../../src/quota/redis-state.js';
import { createSaasDatabase } from '../../../src/saas/db/database.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import {
  PostgresCapacityStatePersistence,
  RedisPreparationCapacity,
} from '../../../src/saas/gateway/redis-preparation-capacity.js';
import { managedQuotaPoolBudget } from '../../../src/server/managed-saas-quota-pool.js';

const connectionString = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_GATEWAY_URL;
const redisUrl = process.env.ROUTER_TEST_REDIS_URL;

test('real quota writeback progresses while all 14 business connections are held; recovery drains before close', {
  skip: !connectionString || !redisUrl,
  timeout: 30_000,
}, async () => {
  assert.ok(connectionString && redisUrl);
  const pg = new URL(connectionString);
  const redis = new URL(redisUrl);
  assert.equal(pg.hostname, '127.0.0.1');
  assert.ok(pg.port && pg.port !== '5432' && pg.pathname.startsWith('/model_router_test_'));
  assert.equal(redis.hostname, '127.0.0.1');
  assert.ok(redis.port && redis.port !== '6379');
  const budget = managedQuotaPoolBudget(16, true);
  const business = createSaasDatabase({ connectionString, max: budget.business });
  const quota = createSaasDatabase({ connectionString, max: budget.quota });
  const namespace = `isolated-lane-${randomUUID()}`;
  const state = await RedisQuotaState.open({
    url: redisUrl,
    namespace,
    persistence: new PostgresCapacityStatePersistence(quota, namespace),
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let count = 0;
  let ready!: () => void;
  const allHeld = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holds = Array.from({ length: budget.business }, () =>
    business.transaction(async () => {
      if (++count === budget.business) ready();
      await barrier;
    }),
  );
  let queued: Promise<unknown> | undefined;
  try {
    await allHeld;
    let businessCompleted = false;
    queued = business.query('SELECT 1').then(() => {
      businessCompleted = true;
    });
    const key = JSON.stringify(['lane-test', randomUUID()]);
    await state.mutate([key], 'save(keys[1], {kind="laneTest", n=1}); return true', {});
    await state.flush(1500);
    assert.equal(businessCompleted, false, 'the business pool is genuinely occupied, not merely configured smaller');
    const persisted = await quota.query<{ value: { n: number } }>(
      'SELECT value FROM saas_redis_quota_state WHERE namespace=$1 AND key=$2',
      [namespace, key],
    );
    assert.equal(persisted.rows[0]?.value.n, 1);

    let finishScan!: () => void;
    const scanBarrier = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    const recoveryDatabase = {
      ...quota,
      query: async () => {
        await scanBarrier;
        return { rows: [{ id: 'drain-test' }], rowCount: 1 };
      },
    } as unknown as SaasDatabase;
    const capacity = new RedisPreparationCapacity(state, recoveryDatabase, namespace);
    capacity.complete = async () => {
      await state.mutate([key], 'save(keys[1], {kind="laneTest", n=2}); return true', {});
    };
    const recovery = (capacity as unknown as { recover(): Promise<void> }).recover();
    const closing = capacity.close();
    finishScan();
    await Promise.all([recovery, closing]);
    const afterClose = await quota.query<{ value: { n: number } }>(
      'SELECT value FROM saas_redis_quota_state WHERE namespace=$1 AND key=$2',
      [namespace, key],
    );
    assert.equal(
      afterClose.rows[0]?.value.n,
      2,
      'close waits for the recovery mutation and persists it before its database closes',
    );
  } finally {
    release();
    await Promise.allSettled(holds);
    await queued;
    await state.close();
    await Promise.all([business.close(), quota.close()]);
  }
});
