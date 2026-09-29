import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/029_model_resolution_provenance.js';

const migration = MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION;
const sql = migration.sql;

test('migration 029 is appended after the immutable 028 history', () => {
  assert.equal(migration.version, 29);
  assert.equal(migration.name, 'model_resolution_provenance');
  assert.equal(SAAS_MIGRATIONS[28], migration);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 29).map(({ version }) => version),
    Array.from({ length: 29 }, (_, index) => index + 1),
  );
  assert.equal(
    SAAS_MIGRATIONS.find(({ version }) => version === 29),
    migration,
  );
  assert.doesNotMatch(sql, /DROP\s+(?:TABLE|TRIGGER|FUNCTION)/i);
  assert.doesNotMatch(sql, /(?:UPDATE|INSERT\s+INTO)\s+saas_(?:requests|attempts|prepared_request_evidence)/i);
});

test('029 adds nullable snapshots to attempts and prepared evidence for legacy compatibility', () => {
  assert.match(sql, /ALTER TABLE saas_attempts[\s\S]+ADD COLUMN model_resolution_requested_model text/i);
  assert.match(sql, /ADD COLUMN model_resolution_mapped_model text/i);
  assert.match(sql, /ADD COLUMN model_resolution_mapping_source text/i);
  assert.match(sql, /ADD COLUMN model_resolution_mapping_version bigint/i);
  assert.match(sql, /ADD COLUMN provider_protocol text/i);
  assert.match(sql, /ADD COLUMN client_operation text/i);
  assert.match(sql, /ADD COLUMN provider_operation text/i);
  assert.match(sql, /ADD COLUMN request_fingerprint text/i);
  assert.match(sql, /ADD COLUMN request_fingerprint_version text/i);
  assert.match(sql, /ADD COLUMN payload_compiler_version text/i);
  assert.match(sql, /ADD COLUMN usage_estimator_version text/i);
  assert.match(sql, /ADD COLUMN payload_sha256 text/i);
  assert.match(
    sql,
    /ALTER TABLE saas_prepared_request_evidence[\s\S]+ADD COLUMN model_resolution_requested_model text/i,
  );
  assert.match(sql, /saas_attempts_model_resolution_provenance_shape CHECK/i);
  assert.match(sql, /saas_prepared_request_evidence_model_resolution_provenance_shape CHECK/i);
  assert.match(sql, /model_resolution_requested_model IS NULL[\s\S]+model_resolution_mapping_version IS NULL/i);
  assert.doesNotMatch(sql, /ADD COLUMN model_resolution_requested_model text NOT NULL/i);
  assert.doesNotMatch(sql, /ADD COLUMN provider_protocol text NOT NULL/i);
});

test('029 validates identity and versioned non-identity model chains', () => {
  assert.match(
    sql,
    /model_resolution_mapping_source = 'none'[\s\S]+model_resolution_mapped_model = model_resolution_requested_model[\s\S]+model_resolution_mapping_version IS NULL[\s\S]+resolved_model = model_resolution_requested_model/i,
  );
  assert.match(
    sql,
    /model_resolution_mapping_source IN \('alias', 'wildcard'\)[\s\S]+model_resolution_mapping_version IS NOT NULL[\s\S]+model_resolution_mapping_version >= 1/i,
  );
  assert.match(sql, /model_resolution_mapping_source IN \('none', 'alias', 'wildcard'\)/i);
  assert.match(
    sql,
    /model_resolution_mapping_version bigint[\s\S]+CHECK \(model_resolution_mapping_version IS NULL OR model_resolution_mapping_version >= 1\)/i,
  );
});

test('029 binds provider transport and compiler fingerprint facts without making them authority', () => {
  assert.match(sql, /provider_protocol IN \('anthropic', 'openai', 'gemini', 'responses'\)/i);
  assert.match(sql, /client_operation = 'messages'/i);
  assert.match(sql, /client_operation = 'chat\.completions'/i);
  assert.match(sql, /client_operation = 'generateContent'/i);
  assert.match(sql, /client_operation = 'responses'/i);
  assert.match(sql, /provider_operation = 'messages'/i);
  assert.match(sql, /provider_operation = 'chat\.completions'/i);
  assert.match(sql, /provider_operation = 'generateContent'/i);
  assert.match(sql, /provider_operation = 'responses'/i);
  assert.match(sql, /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /btrim\(request_fingerprint_version\) <> ''/i);
  assert.match(sql, /btrim\(payload_compiler_version\) <> ''/i);
  assert.match(sql, /btrim\(usage_estimator_version\) <> ''/i);
  assert.match(sql, /payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(sql, /request_record\.request_fingerprint IS DISTINCT FROM NEW\.request_fingerprint/i);
  assert.match(sql, /attempt_record\.payload_sha256 IS DISTINCT FROM NEW\.payload_sha256/i);
  assert.doesNotMatch(sql, /saas_(?:customer|supplier)_price_versions|saas_wallet|billing/i);
});

test('029 rejects incomplete new snapshots and freezes persisted values on update', () => {
  assert.match(sql, /New bound SaaS attempts require complete model-resolution provenance/i);
  assert.match(sql, /New prepared-request evidence requires complete model-resolution provenance/i);
  assert.match(sql, /Unbound SaaS attempts cannot carry model-resolution provenance/i);
  assert.match(sql, /CREATE TRIGGER saas_attempts_guard_model_resolution_provenance/i);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF model_resolution_requested_model[\s\S]+ON saas_attempts/i);
  assert.match(sql, /SaaS attempt model-resolution provenance is immutable/i);
  assert.match(sql, /CREATE TRIGGER saas_prepared_request_evidence_guard_model_resolution_provenance/i);
  assert.match(sql, /BEFORE INSERT ON saas_prepared_request_evidence/i);
  assert.match(sql, /CREATE TRIGGER saas_prepared_request_evidence_model_resolution_immutable/i);
  assert.match(sql, /BEFORE UPDATE OF model_resolution_requested_model[\s\S]+ON saas_prepared_request_evidence/i);
  assert.match(sql, /Prepared-request evidence model-resolution provenance is immutable/i);
});

test('029 cross-checks request, attempt, and evidence identity before dispatch', () => {
  assert.match(sql, /FROM saas_requests[\s\S]+WHERE tenant_id = NEW\.tenant_id[\s\S]+FOR SHARE/i);
  assert.match(sql, /FROM saas_attempts[\s\S]+WHERE tenant_id = NEW\.tenant_id[\s\S]+FOR SHARE/i);
  assert.match(sql, /request_record\.public_model IS DISTINCT FROM NEW\.model_resolution_requested_model/i);
  assert.match(sql, /attempt_record\.resolved_model IS DISTINCT FROM NEW\.resolved_model/i);
  assert.match(
    sql,
    /attempt_record\.model_resolution_mapped_model IS DISTINCT FROM NEW\.model_resolution_mapped_model/i,
  );
  assert.match(sql, /attempt_record\.provider_protocol IS DISTINCT FROM NEW\.provider_protocol/i);
  assert.match(sql, /attempt_record\.client_operation IS DISTINCT FROM NEW\.client_operation/i);
  assert.match(sql, /attempt_record\.payload_compiler_version IS DISTINCT FROM NEW\.payload_compiler_version/i);
  assert.match(sql, /attempt_record\.usage_estimator_version IS DISTINCT FROM NEW\.usage_estimator_version/i);
  assert.match(sql, /Prepared-request evidence model-resolution provenance does not match request and attempt/i);
  assert.match(sql, /USING ERRCODE = '23514'/i);
});
