import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../../../src/saas/db/advisory-lock-keys.js';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  PostgresBulkImportStore,
  PostgresBulkImportStoreError,
} from '../../../src/saas/supply/postgres-bulk-import-store.js';

type Row = Record<string, unknown>;
type Handler = (sql: string, values: readonly unknown[]) => SqlResult<Row> | Promise<SqlResult<Row>>;
const NOW = '2026-11-02T03:04:05.000Z';
const JOB = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const FINGERPRINT = 'a'.repeat(64);

function result(rows: Row[] = []): SqlResult<Row> {
  return { rows, rowCount: rows.length };
}

function jobRow(overrides: Row = {}): Row {
  return {
    id: JOB,
    status: 'running',
    total_count: 1,
    success_count: 0,
    failure_count: 0,
    created_by: ACTOR,
    error_summary: {},
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

function itemRow(overrides: Row = {}): Row {
  return {
    job_id: JOB,
    item_index: 0,
    provider: 'codex',
    credential_fingerprint: FINGERPRINT,
    status: 'pending',
    account_ref: null,
    error_reason: null,
    display_name: null,
    egress_proxy_id: null,
    validation_state: 'pending_validation',
    option_warnings: [],
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  };
}

class FakeDatabase {
  readonly calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  commits = 0;
  rollbacks = 0;
  inTransaction = false;

  constructor(private readonly handler: Handler) {}

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    this.calls.push({ sql, values });
    for (const match of sql.matchAll(/\$(\d+)/g)) {
      assert.ok(Number(match[1]) <= values.length, `missing binding ${match[0]}`);
    }
    return (await this.handler(sql, values)) as unknown as SqlResult<Row>;
  }

  async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    assert.equal(this.inTransaction, false);
    this.inTransaction = true;
    try {
      const value = await work({ query: this.query.bind(this) });
      this.commits += 1;
      return value;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function generic(sql: string): SqlResult<Row> | undefined {
  if (sql === SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL || sql === SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL) {
    return result();
  }
  if (sql.includes('pg_advisory_xact_lock(hashtextextended')) return result();
  return undefined;
}

test('createJob is fenced, parameterized and committed in one transaction', async () => {
  const database = new FakeDatabase((sql, values) => {
    const common = generic(sql);
    if (common) return common;
    assert.match(sql, /INSERT INTO saas_bulk_import_job/);
    assert.deepEqual(values, [JOB, 1, ACTOR, NOW]);
    return result([jobRow()]);
  });
  const store = new PostgresBulkImportStore(database);
  const job = await store.createJob({ id: JOB, totalCount: 1, createdBy: ACTOR, createdAt: NOW });
  assert.equal(job.status, 'running');
  assert.equal(database.commits, 1);
  assert.equal(database.rollbacks, 0);
  assert.equal(database.inTransaction, false);
  assert.equal(database.calls[0]?.sql, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
  assert.equal(database.calls[1]?.sql, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
});

test('a new claim takes the provider/fingerprint lock and inserts only a pending item', async () => {
  const database = new FakeDatabase((sql) => {
    const common = generic(sql);
    if (common) return common;
    if (sql.includes('FROM saas_bulk_import_job')) return result([jobRow()]);
    if (sql.includes("status IN ('pending', 'succeeded')")) return result();
    assert.match(sql, /INSERT INTO saas_bulk_import_item/);
    return result([itemRow()]);
  });
  const store = new PostgresBulkImportStore(database);
  const claim = await store.claimItem({
    jobId: JOB,
    itemIndex: 0,
    provider: 'codex',
    credentialFingerprint: FINGERPRINT,
    displayName: null,
    egressProxyId: null,
    optionWarnings: [],
    createdAt: NOW,
  });
  assert.deepEqual(claim, { kind: 'claimed' });
  assert.equal(database.commits, 1);
  assert.equal(
    database.calls.some((call) => call.sql.includes('hashtextextended')),
    true,
  );
  assert.equal(
    database.calls.some((call) => call.sql.includes('UPDATE saas_bulk_import_job')),
    false,
  );
});

test('deduplicated item insertion and job success counter commit atomically', async () => {
  const existing = itemRow({
    job_id: '33333333-3333-4333-8333-333333333333',
    status: 'succeeded',
    account_ref: 'platform-account-original',
    validation_state: 'queued',
    completed_at: NOW,
  });
  const database = new FakeDatabase((sql, values) => {
    const common = generic(sql);
    if (common) return common;
    if (sql.includes('FROM saas_bulk_import_job') && sql.startsWith('SELECT')) return result([jobRow()]);
    if (sql.includes("status IN ('pending', 'succeeded')")) return result([existing]);
    if (sql.includes('INSERT INTO saas_bulk_import_item')) {
      assert.equal(values[4], 'platform-account-original');
      return result([
        itemRow({
          status: 'deduplicated',
          account_ref: 'platform-account-original',
          validation_state: 'not_requested',
          completed_at: NOW,
        }),
      ]);
    }
    assert.match(sql, /UPDATE saas_bulk_import_job/);
    assert.deepEqual(values.slice(1), [1, 0, NOW]);
    return result([jobRow({ success_count: 1, updated_at: NOW })]);
  });
  const store = new PostgresBulkImportStore(database);
  const claim = await store.claimItem({
    jobId: JOB,
    itemIndex: 0,
    provider: 'codex',
    credentialFingerprint: FINGERPRINT,
    displayName: null,
    egressProxyId: null,
    optionWarnings: [],
    createdAt: NOW,
  });
  assert.equal(claim.kind, 'deduplicated');
  if (claim.kind === 'deduplicated') assert.equal(claim.item.accountRef, 'platform-account-original');
  assert.equal(database.commits, 1);
  assert.equal(database.rollbacks, 0);
});

test('an in-flight equal fingerprint fails closed instead of permitting a second sink call', async () => {
  const database = new FakeDatabase((sql) => {
    const common = generic(sql);
    if (common) return common;
    if (sql.includes('FROM saas_bulk_import_job')) return result([jobRow()]);
    if (sql.includes("status IN ('pending', 'succeeded')")) return result([itemRow()]);
    throw new Error('an in-flight claim must not insert');
  });
  const store = new PostgresBulkImportStore(database);
  await assert.rejects(
    store.claimItem({
      jobId: JOB,
      itemIndex: 0,
      provider: 'codex',
      credentialFingerprint: FINGERPRINT,
      displayName: null,
      egressProxyId: null,
      optionWarnings: [],
      createdAt: NOW,
    }),
    (error: unknown) =>
      error instanceof PostgresBulkImportStoreError && error.code === 'BULK_IMPORT_CREDENTIAL_IN_PROGRESS',
  );
  assert.equal(database.rollbacks, 1);
  assert.equal(database.commits, 0);
});

test('success and failure each couple the item terminal update to exactly one job counter', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const updates: string[] = [];
    const database = new FakeDatabase((sql, values) => {
      const common = generic(sql);
      if (common) return common;
      if (sql.includes('FROM saas_bulk_import_job') && sql.startsWith('SELECT')) return result([jobRow()]);
      if (sql.includes('UPDATE saas_bulk_import_item')) {
        updates.push('item');
        return result([
          itemRow(
            outcome === 'success'
              ? {
                  status: 'succeeded',
                  account_ref: 'platform-account-new',
                  validation_state: 'queued',
                  completed_at: NOW,
                }
              : {
                  status: 'failed',
                  error_reason: 'CREDENTIALS_JSON_INVALID',
                  validation_state: 'not_requested',
                  completed_at: NOW,
                },
          ),
        ]);
      }
      assert.match(sql, /UPDATE saas_bulk_import_job/);
      updates.push('job');
      assert.deepEqual(values.slice(1, 3), outcome === 'success' ? [1, 0] : [0, 1]);
      return result([jobRow(outcome === 'success' ? { success_count: 1 } : { failure_count: 1 })]);
    });
    const store = new PostgresBulkImportStore(database);
    if (outcome === 'success') {
      const item = await store.succeedItem({
        jobId: JOB,
        itemIndex: 0,
        accountRef: 'platform-account-new',
        validationState: 'queued',
        errorReason: null,
        completedAt: NOW,
      });
      assert.equal(item.status, 'succeeded');
    } else {
      const item = await store.failItem({
        jobId: JOB,
        itemIndex: 0,
        errorReason: 'CREDENTIALS_JSON_INVALID',
        completedAt: NOW,
      });
      assert.equal(item.status, 'failed');
    }
    assert.deepEqual(updates, ['item', 'job']);
    assert.equal(database.commits, 1);
  }
});

test('completeJob rolls back when a pending item remains', async () => {
  const database = new FakeDatabase((sql) => {
    const common = generic(sql);
    if (common) return common;
    if (sql.includes('FROM saas_bulk_import_job') && sql.startsWith('SELECT')) return result([jobRow()]);
    if (sql.includes('SELECT EXISTS')) return result([{ exists: true }]);
    throw new Error('a pending job must not complete');
  });
  const store = new PostgresBulkImportStore(database);
  await assert.rejects(store.completeJob({ jobId: JOB, errorSummary: {}, completedAt: NOW }), {
    code: 'BULK_IMPORT_JOB_HAS_PENDING_ITEMS',
  });
  assert.equal(database.rollbacks, 1);
  assert.equal(
    database.calls.some((call) => call.sql.includes('UPDATE saas_bulk_import_job')),
    false,
  );
});

test('completeJob persists the safe error summary only after counters are complete', async () => {
  const database = new FakeDatabase((sql, values) => {
    const common = generic(sql);
    if (common) return common;
    if (sql.includes('FROM saas_bulk_import_job') && sql.startsWith('SELECT')) {
      return result([jobRow({ success_count: 1 })]);
    }
    if (sql.includes('SELECT EXISTS')) return result([{ exists: false }]);
    assert.match(sql, /UPDATE saas_bulk_import_job/);
    assert.equal(values[1], JSON.stringify({ CREDENTIALS_JSON_INVALID: 1 }));
    return result([
      jobRow({
        status: 'completed',
        success_count: 1,
        error_summary: { CREDENTIALS_JSON_INVALID: 1 },
        completed_at: NOW,
      }),
    ]);
  });
  const store = new PostgresBulkImportStore(database);
  const job = await store.completeJob({
    jobId: JOB,
    errorSummary: { CREDENTIALS_JSON_INVALID: 1 },
    completedAt: NOW,
  });
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.errorSummary, { CREDENTIALS_JSON_INVALID: 1 });
  assert.equal(database.commits, 1);
});
