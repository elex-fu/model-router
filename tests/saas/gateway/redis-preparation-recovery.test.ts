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
