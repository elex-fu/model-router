import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/015_provider_supply_accounts.js';

test('migration 015 is standalone and defines split owner-family supply storage', () => {
  const migration = PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION;
  assert.equal(migration.version, 15);
  assert.equal(migration.name, 'provider_supply_accounts_and_credentials');
  assert.doesNotMatch(migration.sql, /001_initial_schema|SAAS_MIGRATIONS/);

  for (const table of [
    'saas_tenant_provider_accounts',
    'saas_platform_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_platform_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_platform_provider_credential_versions',
  ]) {
    assert.match(migration.sql, new RegExp(`CREATE TABLE ${table} \\(`));
  }
  assert.match(migration.sql, /REFERENCES saas_provider_products/);
  assert.match(migration.sql, /REFERENCES saas_provider_rights/);
  assert.match(migration.sql, /REFERENCES saas_provider_capabilities/);
  assert.match(migration.sql, /kms_key_id text NOT NULL/);
  assert.match(migration.sql, /wrapped_dek text NOT NULL/);
  assert.match(migration.sql, /ciphertext text NOT NULL/);
  assert.match(migration.sql, /CREATE UNIQUE INDEX saas_tenant_provider_credential_versions_one_active_idx/);
  assert.match(migration.sql, /CREATE TRIGGER saas_tenant_provider_credential_versions_immutable/);
  assert.match(migration.sql, /CREATE TRIGGER saas_platform_provider_credential_versions_immutable/);
  assert.match(migration.sql, /NEW\.tenant_id IS DISTINCT FROM OLD\.tenant_id/);
  assert.doesNotMatch(migration.sql, /plaintext|raw_secret|secret_value/i);
});

test('platform tables do not declare a tenant scope and lifecycle constraints are explicit', () => {
  const sql = PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION.sql;
  const platformAccount = sql.match(/CREATE TABLE saas_platform_provider_accounts \(([\s\S]*?)\n\);/i)?.[1] ?? '';
  const platformCredential = sql.match(/CREATE TABLE saas_platform_provider_credentials \(([\s\S]*?)\n\);/i)?.[1] ?? '';
  assert.doesNotMatch(platformAccount, /tenant_id/i);
  assert.doesNotMatch(platformCredential, /tenant_id/i);
  assert.match(sql, /status IN \('pending', 'active', 'disabled', 'revoked'\)/);
  assert.match(sql, /validation_state IN \('unverified', 'verified', 'failed'\)/);
  assert.match(sql, /authz_version bigint NOT NULL DEFAULT 1/);
  assert.match(sql, /saas_provider_supply_validate_rights/);
});
