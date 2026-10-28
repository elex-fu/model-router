import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { runFastJournalRetention } from '../../../../src/saas/gateway/fast/retention.js';

interface RecordedCall {
  readonly sql: string;
  readonly values?: readonly unknown[];
}

interface BatchScript {
  readonly candidateIds: readonly string[];
}

function fakeDatabase(script: readonly BatchScript[]): { database: SaasDatabase; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let batchIndex = 0;
  const database: SaasDatabase = {
    async query(): Promise<SqlResult<never>> {
      throw new Error('retention must run every statement inside a transaction');
    },
    async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const step = script[Math.min(batchIndex, script.length - 1)];
      batchIndex += 1;
      const tx: SqlExecutor = {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
          calls.push({ sql, values });
          if (sql.startsWith('SELECT set_config')) return { rows: [], rowCount: null };
          if (sql.startsWith('SELECT i.id'))
            return { rows: step.candidateIds.map((id) => ({ id })) as Row[], rowCount: step.candidateIds.length };
          return { rows: [], rowCount: step.candidateIds.length };
        },
      };
      return work(tx);
    },
    async migrate() {},
    async verifySchema() {},
    async ping() {},
    async close() {},
  };
  return { database, calls };
}

test('runFastJournalRetention validates the window and batch options', async () => {
  const { database } = fakeDatabase([]);
  await assert.rejects(runFastJournalRetention(database, { retentionMs: 59_999 }), /FAST_RETENTION_INVALID_WINDOW/);
  await assert.rejects(runFastJournalRetention(database, { retentionMs: 60_000.5 }), /FAST_RETENTION_INVALID_WINDOW/);
  await assert.rejects(runFastJournalRetention(database, { batchSize: 0 }), /FAST_RETENTION_INVALID_BATCH/);
  await assert.rejects(runFastJournalRetention(database, { batchSize: 1001 }), /FAST_RETENTION_INVALID_BATCH/);
  await assert.rejects(runFastJournalRetention(database, { maxBatches: 0 }), /FAST_RETENTION_INVALID_BATCH/);
});

test('runFastJournalRetention arms the flag first, deletes children before intents, and reports counts', async () => {
  const { database, calls } = fakeDatabase([{ candidateIds: ['11111111-1111-1111-1111-111111111111'] }]);
  const before = Date.now();
  const result = await runFastJournalRetention(database, { retentionMs: 60_000, batchSize: 10 });
  const after = Date.now();
  assert.deepEqual(result, { deletedIntents: 1, batches: 1, exhausted: false });
  assert.equal(calls.length, 7);
  // The guard flag must be armed inside the same transaction before any
  // candidate scan or DELETE, and it must be transaction-local (is_local=true).
  assert.match(calls[0].sql, /^SELECT set_config\('model_router_saas\.fast_retention', 'on', true\)$/);
  // Candidates: cutoff window, terminal-settlement eligibility, bounded lock.
  assert.match(calls[1].sql, /FROM saas_fast_gateway_intents i/);
  assert.match(calls[1].sql, /j\.state = 'completed'/);
  assert.match(calls[1].sql, /saas_fast_gateway_resolutions x WHERE x\.intent_id = i\.id/);
  assert.match(calls[1].sql, /FOR UPDATE OF i SKIP LOCKED/);
  assert.equal(calls[1].values?.[1], 10);
  const cutoff = Date.parse(String(calls[1].values?.[0]));
  assert.ok(cutoff >= before - 60_000 - 1_000 && cutoff <= after - 60_000 + 1_000, 'cutoff = now - retentionMs');
  // Delete order: liability releases, resolutions, receipts, jobs, intents.
  const deleteTables = calls.slice(2).map(({ sql }) => /DELETE FROM (\S+)/.exec(sql)?.[1]);
  assert.deepEqual(deleteTables, [
    'saas_fast_receipt_liability_releases',
    'saas_fast_gateway_resolutions',
    'saas_fast_gateway_receipts',
    'saas_fast_billing_jobs',
    'saas_fast_gateway_intents',
  ]);
  for (const [index, call] of calls.slice(2).entries()) {
    const key = index === 4 ? 'id' : 'intent_id';
    assert.ok(call.sql.includes(`WHERE ${key} = ANY($1::uuid[])`), `delete ${index + 1} filters by ${key}`);
  }
});

test('runFastJournalRetention stops after one empty batch without exhausting', async () => {
  const { database } = fakeDatabase([{ candidateIds: [] }]);
  const result = await runFastJournalRetention(database);
  assert.deepEqual(result, { deletedIntents: 0, batches: 1, exhausted: false });
});

test('runFastJournalRetention loops full batches until dry and reports exhaustion only under the cap', async () => {
  const twoFullThenDry = fakeDatabase([
    { candidateIds: ['a', 'b'] },
    { candidateIds: ['c', 'd'] },
    { candidateIds: [] },
  ]);
  const drained = await runFastJournalRetention(twoFullThenDry.database, { batchSize: 2 });
  assert.deepEqual(drained, { deletedIntents: 4, batches: 3, exhausted: false });

  const endless = fakeDatabase([{ candidateIds: ['a', 'b'] }]);
  const capped = await runFastJournalRetention(endless.database, { batchSize: 2, maxBatches: 2 });
  assert.deepEqual(capped, { deletedIntents: 4, batches: 2, exhausted: true });
});
