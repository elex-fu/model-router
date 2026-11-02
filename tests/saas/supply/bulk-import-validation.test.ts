import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SqlResult } from '../../../src/saas/db/types.js';
import { CODEX_PRODUCT_ID, CODEX_PROVIDER_ID } from '../../../src/saas/gateway/codex/catalog-identity.js';
import type { BulkImportValidationRequest } from '../../../src/saas/supply/bulk-import-service.js';
import {
  BulkImportValidationError,
  PostgresBulkImportValidationQueue,
} from '../../../src/saas/supply/bulk-import-validation.js';

const ACCOUNT = 'platform-account-fixture';
const CREDENTIAL = 'platform-credential-fixture';

function automaticKey(version = 1): string {
  return createHash('sha256')
    .update(
      [
        'provider-credential-validation-v1',
        'platform',
        ACCOUNT,
        CREDENTIAL,
        String(version),
        CODEX_PROVIDER_ID,
        CODEX_PRODUCT_ID,
      ].join('\u0000'),
    )
    .digest('hex');
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'validation-job-fixture',
    account_id: ACCOUNT,
    credential_id: CREDENTIAL,
    credential_version: 1,
    provider_id: CODEX_PROVIDER_ID,
    product_id: CODEX_PRODUCT_ID,
    credential_type: 'oauth',
    idempotency_key: automaticKey(),
    status: 'queued',
    ...overrides,
  };
}

function request(): BulkImportValidationRequest {
  return {
    accountRef: ACCOUNT,
    provider: 'codex',
    importJobId: '11111111-1111-4111-8111-111111111111',
    itemIndex: 0,
    idempotencyKey: 'f'.repeat(64),
    reason: 'bulk_account_import',
    audit: { actorUserId: '22222222-2222-4222-8222-222222222222' },
  };
}

function database(rows: Record<string, unknown>[]) {
  const calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  return {
    calls,
    query: async <Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> => {
      calls.push({ sql, values });
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
}

test('first-validation callback acknowledges the automatic job without another enqueue', async () => {
  for (const status of ['queued', 'leased', 'verified', 'failed']) {
    const db = database([row({ status })]);
    const queue = new PostgresBulkImportValidationQueue(db);
    await queue.enqueue(request());
    assert.equal(db.calls.length, 1);
    assert.doesNotMatch(db.calls[0]?.sql ?? '', /INSERT|UPDATE|DELETE|FOR UPDATE/);
    assert.deepEqual(db.calls[0]?.values, [ACCOUNT, CODEX_PROVIDER_ID, CODEX_PRODUCT_ID, 'oauth']);
  }
});

test('missing, cancelled and mismatched automatic jobs fail closed and never requeue', async () => {
  for (const fixture of [
    { rows: [], code: 'BULK_IMPORT_VALIDATION_JOB_MISSING' },
    { rows: [row({ status: 'cancelled' })], code: 'BULK_IMPORT_VALIDATION_JOB_CANCELLED' },
    { rows: [row({ idempotency_key: '0'.repeat(64) })], code: 'BULK_IMPORT_VALIDATION_JOB_MISMATCH' },
    { rows: [row(), row({ id: 'another-job' })], code: 'BULK_IMPORT_VALIDATION_JOB_MISSING' },
  ]) {
    const db = database(fixture.rows);
    const queue = new PostgresBulkImportValidationQueue(db);
    await assert.rejects(queue.enqueue(request()), (error: unknown) => {
      return error instanceof BulkImportValidationError && error.code === fixture.code;
    });
    assert.equal(db.calls.length, 1);
    assert.doesNotMatch(db.calls[0]?.sql ?? '', /INSERT|UPDATE|DELETE/);
  }
});

test('validation lookup binds the current credential version and provider catalog identity', async () => {
  const db = database([row({ credential_version: '2', idempotency_key: automaticKey(2) })]);
  const queue = new PostgresBulkImportValidationQueue(db);
  await queue.enqueue(request());
  assert.match(db.calls[0]?.sql ?? '', /c.current_version = j.credential_version/);
  assert.match(db.calls[0]?.sql ?? '', /j.provider_id = \$2 AND j.product_id = \$3/);
  assert.match(db.calls[0]?.sql ?? '', /j.credential_type = \$4/);
});
