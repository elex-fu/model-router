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
    [
      ...Array.from({ length: 60 }, (_, index) => index + 1),
      63,
      80,
      81,
      82,
      83,
      84,
      85,
      87,
      88,
      89,
      90,
      91,
      92,
      93,
      94,
      95,
      96,
      97,
      98,
      99,
      100,
      101,
      102,
      103,
      104,
      105,
      106,
      107,
      108,
      109,
      110,
      111,
      112,
      113,
      114,
      115,
      116,
      // Batch-3 category scheduling tails (117 bedrock / 118 vertex /
      // 119 grok / 120 zhipu+minimax).
      117,
      118,
      119,
      120,
      // Batch-4 §4.4 composite model routing (task #18).
      121,
      // Batch-4 §4.1 multimodal billing dimensions (task #15).
      122,
      // Batch-4 §4.2 async image tasks (task #16).
      123,
      // Batch-4 §4.3 async video tasks (task #17) — create-time
      // snapshot + binding + billing claim.
      124,
      // Batch-5 §5.4 content risk control (task #19).
      125,
      // Batch-5 §5.2 public brand settings (task #20).
      126,
      // Batch-5 §5.6 alert silences/report state (task #23).
      127,
      // Batch-5 §5.1 plugin system (task #24).
      128,
      // K2 durable fault classification (renumbered from main's 112).
      129,
      130,
      131,
      132,
      // Core-plan 9.1: 133 provider account model cooldowns — the
      // durable (account, model) cooldown registry (multi-instance).
      133,
      // Current operations/runtime forwards: compact, Kimi quota, media requeue, validation requeue.
      134,
      135,
      136,
      137,
      138,
      139,
      140,
      141,
      142,
      143,
      144,
      145,
      146,
      147,
      148,
      149,
    ],
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
