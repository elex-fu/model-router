import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/039_provider_credential_wrapper_history.js';

test('migration 039 adds owner-scoped append-only Provider wrapper history without altering secret versions', () => {
  const { version, sql } = PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION;
  assert.equal(version, 39);
  assert.match(sql, /CREATE TABLE saas_tenant_provider_credential_wrappings/);
  assert.match(sql, /CREATE TABLE saas_platform_provider_credential_wrappings/);
  assert.match(sql, /expected_wrapping_revision/);
  assert.match(sql, /operation_id/);
  assert.match(sql, /source_kms_key_id/);
  assert.match(sql, /context_sha256/);
  assert.match(sql, /actor_kind/);
  assert.match(sql, /FOREIGN KEY \(tenant_id, credential_id, account_id, credential_version\)/);
  assert.match(sql, /FOREIGN KEY \(credential_id, account_id, credential_version\)/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON saas_tenant_provider_credential_wrappings/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON saas_platform_provider_credential_wrappings/);
  assert.match(sql, /BEFORE TRUNCATE ON saas_tenant_provider_credential_wrappings/);
  assert.match(sql, /BEFORE TRUNCATE ON saas_platform_provider_credential_wrappings/);
  assert.doesNotMatch(sql, /UPDATE saas_(tenant|platform)_provider_credential_versions/);
  assert.doesNotMatch(sql, /ALTER TABLE saas_(tenant|platform)_provider_credential_versions\s+DROP/i);
});
