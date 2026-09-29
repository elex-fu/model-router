import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/026_prepared_request_evidence_platform_pool_fence.js';

test('migration 026 registers the prepared-evidence platform pool fence', () => {
  const migration = PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION;

  assert.equal(migration.version, 26);
  assert.equal(migration.name, 'prepared_request_evidence_platform_pool_fence');
  assert.equal(SAAS_MIGRATIONS[25], migration);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 29).map(({ version }) => version),
    Array.from({ length: 29 }, (_, index) => index + 1),
  );
});

test('migration 026 fences platform evidence on insert and claim update without touching BYOK', () => {
  const sql = PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION.sql;

  assert.match(sql, /CREATE FUNCTION saas_prepared_request_evidence_platform_pool_fence\(\)/i);
  assert.match(sql, /IF NEW\.account_owner_kind IS DISTINCT FROM 'platform'/i);
  assert.match(sql, /FROM saas_platform_provider_pools\s+WHERE id = NEW\.pool_id\s+FOR SHARE/i);
  assert.match(sql, /pool_record\.status IS DISTINCT FROM 'active'/i);
  assert.match(sql, /pool_record\.provider_id IS DISTINCT FROM NEW\.provider_id/i);
  assert.match(sql, /pool_record\.product_id IS DISTINCT FROM NEW\.product_id/i);
  assert.match(sql, /pool_record\.authz_version IS DISTINCT FROM NEW\.pool_authz_version/i);
  assert.match(
    sql,
    /CREATE TRIGGER saas_prepared_request_evidence_platform_pool_fence\s+BEFORE INSERT OR UPDATE ON saas_prepared_request_evidence/i,
  );
  assert.match(sql, /FOR EACH ROW EXECUTE FUNCTION saas_prepared_request_evidence_platform_pool_fence\(\)/i);
  assert.doesNotMatch(sql, /saas_tenant_provider_accounts|saas_tenant_provider_supply_profile_accounts/i);
});
