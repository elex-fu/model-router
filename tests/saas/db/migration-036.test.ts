import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/035_credential_validation_jobs.js';
import { GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/036_gateway_idempotency_keys.js';
import { PAYMENT_REFUNDS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/037_payment_refunds.js';

const migration = GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION;
const sql = migration.sql;

test('migration 036 is registered immediately before subsequent append-only migrations', () => {
  assert.equal(migration.version, 36);
  assert.equal(migration.name, 'gateway_request_idempotency_keys');
  assert.equal(SAAS_MIGRATIONS[34], CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[35], migration);
  assert.equal(SAAS_MIGRATIONS[36], PAYMENT_REFUNDS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS.filter(({ version }) => version === 36).length, 1);
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
});

test('the key mapping stores only a digest and scopes its unique key across tenant, project, and proxy key', () => {
  assert.match(
    sql,
    /CREATE TABLE saas_gateway_request_idempotency_keys\s*\([\s\S]+key_digest text NOT NULL CHECK \(key_digest ~ '\^\[0-9a-f\]\{64\}\$'\)/i,
  );
  assert.match(sql, /UNIQUE \(tenant_id, project_id, proxy_key_id, key_digest\)/i);
  assert.match(sql, /request_fingerprint text NOT NULL CHECK \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(sql, /request_fingerprint_version text NOT NULL/i);
  assert.match(sql, /request_id uuid NOT NULL/i);
  assert.doesNotMatch(sql, /client_key\s+text|idempotency_key\s+text/i);
});

test('scope and canonical request foreign keys preserve tenant boundaries', () => {
  assert.match(sql, /FOREIGN KEY \(tenant_id, project_id\)\s+REFERENCES saas_projects \(tenant_id, id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id, proxy_key_id\)\s+REFERENCES saas_api_keys \(tenant_id, project_id, id\)/i,
  );
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, request_id\)\s+REFERENCES saas_requests \(tenant_id, id\)[\s\S]+DEFERRABLE INITIALLY DEFERRED/i,
  );
});

test('in-progress and unknown mappings never expire or become claimable again', () => {
  assert.match(sql, /state text NOT NULL DEFAULT 'in_progress'/i);
  assert.match(sql, /CHECK \(state IN \('in_progress', 'completed', 'unknown'\)\)/i);
  assert.match(sql, /\(state = 'completed'\) = \(completed_at IS NOT NULL\)/i);
  assert.match(sql, /\(state = 'unknown'\) = \(unknown_at IS NOT NULL\)/i);
  assert.match(sql, /CREATE TRIGGER saas_gateway_request_idempotency_guard_update/i);
  assert.match(sql, /OLD\.state <> 'in_progress' AND NEW\.state IS DISTINCT FROM OLD\.state/i);
  assert.match(sql, /BEFORE DELETE ON saas_gateway_request_idempotency_keys/i);
  assert.match(sql, /BEFORE TRUNCATE ON saas_gateway_request_idempotency_keys/i);
  assert.doesNotMatch(sql, /expires_at|ttl/i);
});
