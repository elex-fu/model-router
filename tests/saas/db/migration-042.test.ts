import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/041_gateway_provider_account_affinity.js';
import { CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/042_capacity_policy_audit_details.js';

const migration = CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION;
const sql = migration.sql;

test('migration 042 follows gateway account affinity without editing the migration registry', () => {
  assert.equal(GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION.version, 41);
  assert.equal(migration.version, 42);
  assert.equal(migration.name, 'capacity_policy_audit_details');
});

test('tenant gets a positive monotonic capacity-policy revision for row CAS', () => {
  assert.match(sql, /ALTER TABLE saas_tenants\s+ADD COLUMN capacity_policy_revision bigint NOT NULL DEFAULT 1/i);
  assert.match(sql, /CHECK \(capacity_policy_revision >= 1\)/i);
});

test('capacity audit detail links to immutable event metadata and scopes identifiers', () => {
  assert.match(sql, /CREATE TABLE saas_capacity_policy_audit_details/i);
  assert.match(sql, /audit_event_id uuid PRIMARY KEY\s+REFERENCES saas_audit_events\(id\) ON DELETE RESTRICT/i);
  assert.match(sql, /scope IN \('tenant', 'project', 'api_key'\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, project_id\)\s+REFERENCES saas_projects\(tenant_id, id\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, project_id, api_key_id\)\s+REFERENCES saas_api_keys\(tenant_id, project_id, id\)/i,
  );
  assert.match(sql, /reason text NOT NULL/i);
  assert.match(sql, /reason IN \([\s\S]*'initial_provisioning'[\s\S]*'data_correction'/i);
  assert.match(sql, /char_length\(reason\) BETWEEN 3 AND 512/i);
  assert.match(sql, /octet_length\(reason\) <= 1024/i);
  assert.match(sql, /before_requests_per_minute bigint/i);
  assert.match(sql, /before_tokens_per_minute bigint/i);
  assert.match(sql, /before_max_concurrent_requests integer/i);
  assert.match(sql, /after_requests_per_minute bigint NOT NULL/i);
  assert.match(sql, /after_tokens_per_minute bigint NOT NULL/i);
  assert.match(sql, /after_max_concurrent_requests integer NOT NULL/i);
  assert.match(sql, /before_revision bigint NOT NULL/i);
  assert.match(sql, /after_revision bigint NOT NULL/i);
  assert.match(sql, /revision_kind text NOT NULL/i);
  assert.doesNotMatch(sql, /\bjsonb\b|\bpayload\b|\bmetadata_blob\b/i);
});

test('snapshots are all-unset or complete positive safe-integer sets with one-step revisions', () => {
  assert.match(
    sql,
    /before_requests_per_minute IS NULL\s+AND before_tokens_per_minute IS NULL\s+AND before_max_concurrent_requests IS NULL/i,
  );
  assert.match(sql, /before_requests_per_minute BETWEEN 1 AND 9007199254740991/i);
  assert.match(sql, /before_requests_per_minute IS NOT NULL/i);
  assert.match(sql, /before_tokens_per_minute BETWEEN 1 AND 9007199254740991/i);
  assert.match(sql, /before_tokens_per_minute IS NOT NULL/i);
  assert.match(sql, /before_max_concurrent_requests BETWEEN 1 AND 2147483647/i);
  assert.match(sql, /before_max_concurrent_requests IS NOT NULL/i);
  assert.match(sql, /after_requests_per_minute BETWEEN 1 AND 9007199254740991/i);
  assert.match(sql, /after_tokens_per_minute BETWEEN 1 AND 9007199254740991/i);
  assert.match(sql, /after_max_concurrent_requests BETWEEN 1 AND 2147483647/i);
  assert.match(sql, /after_revision = before_revision \+ 1/i);
  assert.match(sql, /scope = 'tenant' AND revision_kind = 'tenant_capacity_policy'/i);
  assert.match(sql, /scope = 'project' AND revision_kind = 'project_inference_policy'/i);
  assert.match(sql, /scope = 'api_key' AND revision_kind = 'api_key_authz'/i);
});

test('capacity audit details reject update, delete, and truncate', () => {
  assert.match(sql, /BEFORE UPDATE OR DELETE ON saas_capacity_policy_audit_details/i);
  assert.match(sql, /BEFORE TRUNCATE ON saas_capacity_policy_audit_details/i);
  assert.match(sql, /EXECUTE FUNCTION saas_reject_immutable_change\(\)/i);
});
