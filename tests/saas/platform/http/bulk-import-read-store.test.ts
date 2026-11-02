import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlResult } from '../../../../src/saas/db/types.js';
import { PostgresBulkImportReadStore } from '../../../../src/saas/supply/postgres-bulk-import-read-store.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-02T03:04:05.000Z';

type Row = Record<string, unknown>;

function result(rows: Row[]): SqlResult<Row> {
  return { rows, rowCount: rows.length };
}

function jobRow(): Row {
  return {
    id: JOB_ID,
    status: 'completed',
    total_count: 3,
    success_count: 2,
    failure_count: 1,
    created_by: '22222222-2222-4222-8222-222222222222',
    error_summary: { CREDENTIALS_JSON_INVALID: 1 },
    created_at: NOW,
    updated_at: NOW,
    completed_at: NOW,
    pending_count: 0,
    succeeded_count: '1',
    deduplicated_count: 1,
    failed_count: 1,
  };
}

function itemRow(itemIndex: number): Row {
  return {
    job_id: JOB_ID,
    item_index: itemIndex,
    provider: 'codex',
    credential_fingerprint: 'a'.repeat(64),
    status: itemIndex === 1 ? 'failed' : 'succeeded',
    account_ref: itemIndex === 1 ? null : `account-${itemIndex}`,
    error_reason: itemIndex === 1 ? 'CREDENTIALS_JSON_INVALID' : null,
    display_name: null,
    egress_proxy_id: null,
    validation_state: itemIndex === 1 ? 'not_requested' : 'queued',
    option_warnings: [],
    created_at: NOW,
    updated_at: NOW,
    completed_at: NOW,
  };
}

test('PostgreSQL read store returns a job and every item-state count in one query', async () => {
  const calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  const store = new PostgresBulkImportReadStore({
    query: async <T>(sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      assert.match(sql, /FROM saas_bulk_import_job/);
      assert.deepEqual(values, [JOB_ID]);
      return result([jobRow()]) as unknown as SqlResult<T>;
    },
  });
  const snapshot = await store.getJobStatus(JOB_ID);
  assert.equal(snapshot?.job.id, JOB_ID);
  assert.deepEqual(snapshot?.counts, { pending: 0, succeeded: 1, deduplicated: 1, failed: 1 });
  assert.equal(calls.length, 1);
});

test('PostgreSQL item reads are parameterized, ordered and exclusively cursor-paginated', async () => {
  const store = new PostgresBulkImportReadStore({
    query: async <T>(sql: string, values: readonly unknown[] = []) => {
      assert.match(sql, /FROM saas_bulk_import_item/);
      assert.match(sql, /item_index > \$2/);
      assert.match(sql, /ORDER BY item_index/);
      assert.deepEqual(values, [JOB_ID, 0, 3]);
      return result([itemRow(1), itemRow(2)]) as unknown as SqlResult<T>;
    },
  });
  const items = await store.listItems({ jobId: JOB_ID, afterItemIndex: 0, limit: 3 });
  assert.deepEqual(
    items.map((item) => item.itemIndex),
    [1, 2],
  );
  assert.equal(items[0]?.errorReason, 'CREDENTIALS_JSON_INVALID');
  assert.equal('material' in (items[0] ?? {}), false);
});

test('PostgreSQL read store distinguishes missing jobs and rejects malformed rows', async () => {
  const missing = new PostgresBulkImportReadStore({ query: async () => result([]) });
  assert.equal(await missing.getJobStatus(JOB_ID), null);
  const malformed = new PostgresBulkImportReadStore({
    query: async <T>() => result([{ ...jobRow(), status: 'unknown' }]) as unknown as SqlResult<T>,
  });
  await assert.rejects(malformed.getJobStatus(JOB_ID), /BULK_IMPORT_READ_ROW_INVALID/);
});
