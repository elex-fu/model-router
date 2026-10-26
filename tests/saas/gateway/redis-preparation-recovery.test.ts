import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RedisQuotaState } from '../../../src/quota/redis-state.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { RedisPreparationCapacity } from '../../../src/saas/gateway/redis-preparation-capacity.js';

test('capacity recovery scans terminal and orphan records, not live expired rows that can starve the batch', async () => {
  let sql = '';
  const database = {
    query: async (statement: string) => {
      sql = statement;
      return { rows: [], rowCount: 0 };
    },
  } as unknown as SaasDatabase;
  const capacity = new RedisPreparationCapacity({} as RedisQuotaState, database, 'test');
  await (capacity as unknown as { recover(): Promise<void> }).recover();
  assert.match(sql, /q\.execution_state IN \('succeeded','failed'\)/);
  assert.match(sql, /q\.id IS NULL AND \(s\.value->>'deadlineMs'\)::bigint<=\$2/);
});

test('close drains the in-flight recovery mutation before quota flush and is idempotent', async () => {
  const events: string[] = [];
  let releaseQuery!: () => void;
  const delayed = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  let reads = 0;
  const database = {
    query: async () => {
      reads++;
      events.push('recovery-query');
      await delayed;
      return { rows: [{ id: 'request' }], rowCount: 1 };
    },
  } as unknown as SaasDatabase;
  const state = {
    close: async () => {
      events.push('state-close');
    },
  } as unknown as RedisQuotaState;
  const capacity = new RedisPreparationCapacity(state, database, 'test');
  capacity.complete = async () => {
    events.push('recovery-mutation');
  };
  const recovery = (capacity as unknown as { recover(): Promise<void> }).recover();
  const duplicate = (capacity as unknown as { recover(): Promise<void> }).recover();
  assert.equal(duplicate, recovery);
  const closing = capacity.close();
  assert.equal(capacity.close(), closing);
  await Promise.resolve();
  assert.deepEqual(events, ['recovery-query']);
  releaseQuery();
  await closing;
  assert.deepEqual(events, ['recovery-query', 'recovery-mutation', 'state-close']);
  await (capacity as unknown as { recover(): Promise<void> }).recover();
  capacity.startRecovery();
  assert.equal(reads, 1, 'closing prevents a new scan or timer');
});

test('failed recovery still drains the quota state and preserves flush failures', async () => {
  let closeCalls = 0;
  const database = {
    query: async () => {
      throw new Error('scan failure');
    },
  } as unknown as SaasDatabase;
  const state = {
    close: async () => {
      closeCalls++;
      throw new Error('flush failure');
    },
  } as unknown as RedisQuotaState;
  const capacity = new RedisPreparationCapacity(state, database, 'test');
  const recovery = (capacity as unknown as { recover(): Promise<void> }).recover();
  await assert.rejects(recovery, /scan failure/);
  await assert.rejects(capacity.close(), /flush failure/);
  await assert.rejects(capacity.close(), /flush failure/);
  assert.equal(closeCalls, 1);
});
