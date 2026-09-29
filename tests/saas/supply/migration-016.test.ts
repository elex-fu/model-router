import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/015_provider_supply_accounts.js';
import { PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/016_provider_supply_credentials.js';

test('v15 remains the canonical account and credential migration with its release checksum', () => {
  const migration = PROVIDER_SUPPLY_ACCOUNTS_SAAS_MIGRATION;
  assert.equal(migration.version, 15);
  assert.equal(migration.name, 'provider_supply_accounts_and_credentials');
  assert.equal(
    createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex'),
    '83264c0d05039919363e257f5dfab2a8ce353495bca5697090eb9986cb47e6b4',
  );
});

test('v16 is a true pool/profile mapping delta over v15', () => {
  const migration = PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION;
  assert.equal(migration.version, 16);
  assert.equal(migration.name, 'provider_supply_pools_and_profile_grants');

  for (const duplicate of [
    'saas_tenant_provider_accounts',
    'saas_platform_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_platform_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_platform_provider_credential_versions',
  ]) {
    assert.doesNotMatch(migration.sql, new RegExp(`CREATE TABLE ${duplicate} \\(`));
  }

  for (const table of [
    'saas_platform_provider_pools',
    'saas_platform_provider_pool_members',
    'saas_platform_provider_pool_grants',
    'saas_tenant_provider_supply_profile_accounts',
  ]) {
    assert.match(migration.sql, new RegExp(`CREATE TABLE ${table} \\(`));
  }

  assert.match(migration.sql, /REFERENCES saas_platform_provider_accounts \(id, provider_id, product_id\)/);
  assert.match(migration.sql, /REFERENCES saas_tenant_provider_accounts \(tenant_id, id, provider_id, product_id\)/);
  assert.match(migration.sql, /REFERENCES saas_supply_profiles \(tenant_id, id, supply_mode\)/g);
  assert.match(migration.sql, /supply_mode text NOT NULL DEFAULT 'byok' CHECK \(supply_mode = 'byok'\)/);
  assert.match(migration.sql, /supply_mode text NOT NULL DEFAULT 'platform' CHECK \(supply_mode = 'platform'\)/);
});

test('v16 repairs the shared version trigger without assuming tenant_id on platform rows', () => {
  const sql = PROVIDER_SUPPLY_CREDENTIALS_SAAS_MIGRATION.sql;
  assert.match(sql, /CREATE OR REPLACE FUNCTION saas_provider_credential_version_immutable\(\)/);
  assert.match(sql, /TG_TABLE_NAME = 'saas_tenant_provider_credential_versions'/);
  assert.match(sql, /to_jsonb\(OLD\)/);
  assert.match(sql, /to_jsonb\(NEW\)/);
  assert.match(sql, /saas_platform_provider_pools_identity_immutable/);
  assert.match(sql, /saas_platform_provider_pools_no_delete/);
  assert.doesNotMatch(sql, /CREATE TABLE saas_.*provider_credential_wrappings/);
});
