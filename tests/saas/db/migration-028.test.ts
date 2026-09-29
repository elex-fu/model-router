import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/028_prepared_request_evidence_pool_claim_hardening.js';

const migration = PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION;
const sql = migration.sql;

test('migration 028 is appended after the confirmed 027 pool fence', () => {
  assert.equal(migration.version, 28);
  assert.equal(migration.name, 'prepared_request_evidence_pool_claim_hardening');
  assert.equal(SAAS_MIGRATIONS[27], migration);
});

test('028 requires an active verified pool on evidence registration and claim', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION saas_prepared_request_evidence_platform_pool_fence\(\)/i);
  assert.match(sql, /pool_record\.status IS DISTINCT FROM 'active'/i);
  assert.match(sql, /pool_record\.validation_state IS DISTINCT FROM 'verified'/i);
  assert.match(sql, /pool_record\.provider_id IS DISTINCT FROM NEW\.provider_id/i);
  assert.match(sql, /pool_record\.product_id IS DISTINCT FROM NEW\.product_id/i);
  assert.match(sql, /pool_record\.authz_version IS DISTINCT FROM NEW\.pool_authz_version/i);
  assert.match(sql, /FROM saas_platform_provider_pools[\s\S]+FOR SHARE/i);
});

test('028 makes pool lifecycle and validation epochs forward-only without touching member/grant epochs', () => {
  assert.match(sql, /CREATE FUNCTION saas_platform_provider_pool_authz_epoch_guard\(\)/i);
  assert.match(sql, /NEW\.authz_version IS DISTINCT FROM OLD\.authz_version \+ 1/i);
  assert.match(
    sql,
    /NEW\.status IS DISTINCT FROM OLD\.status[\s\S]+NEW\.validation_state IS DISTINCT FROM OLD\.validation_state/i,
  );
  assert.match(sql, /OLD\.status = 'revoked'[\s\S]+Revoked provider pools are terminal/i);
  assert.match(sql, /BEFORE UPDATE OF status, validation_state, authz_version ON saas_platform_provider_pools/i);
  assert.doesNotMatch(sql, /UPDATE saas_platform_provider_pool_(members|grants)/i);
});

test('028 binds the complete authority snapshot and freezes it after evidence binding', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool\(\)/i);
  assert.match(sql, /evidence_record\.credential_id IS DISTINCT FROM NEW\.credential_id/i);
  assert.match(sql, /evidence_record\.route_config_version IS DISTINCT FROM NEW\.route_config_version/i);
  assert.match(
    sql,
    /evidence_record\.pool_grant_pool_authz_version IS DISTINCT FROM NEW\.pool_grant_pool_authz_version/i,
  );
  assert.match(sql, /CREATE FUNCTION saas_attempts_guard_prepared_evidence_authority_immutable\(\)/i);
  assert.match(sql, /OLD\.prepared_evidence_id IS NOT NULL/i);
  assert.match(sql, /SaaS attempt authority is immutable after prepared evidence binding/i);
  assert.match(sql, /BEFORE UPDATE OF request_id, ordinal,[\s\S]+ON saas_attempts/i);
});

test('028 fences only a new dispatch and lets terminal bookkeeping finish after revocation', () => {
  assert.match(sql, /OLD\.dispatch_state = 'not_sent'[\s\S]+NEW\.dispatch_state = 'dispatching'/i);
  assert.match(sql, /IF NOT should_fence THEN\s+RETURN NEW;/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION saas_attempts_guard_prepared_evidence\(\)/i);
  assert.match(sql, /IF OLD\.dispatch_state <> 'not_sent'[\s\S]+RETURN NEW;/i);
  assert.match(sql, /is_new_dispatch := NEW\.dispatch_state = 'dispatching'/i);
  assert.doesNotMatch(sql, /IF NEW\.dispatch_state <> 'not_sent' THEN[\s\S]+expires_at <= locked_at/i);
});

test('028 is forward-only SQL and does not edit earlier migration definitions or service code', () => {
  assert.doesNotMatch(sql, /DROP\s+(?:TRIGGER|FUNCTION|TABLE)/i);
  assert.doesNotMatch(sql, /prepared-request-evidence-service/i);
});
