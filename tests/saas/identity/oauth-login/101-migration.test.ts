import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { IDENTITY_OAUTH_IDENTITIES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/101_identity_oauth_identities.js';

// Static candidate/source assertions only, mirroring the 085/098 test family.
// No mock database, SQL evaluator, or claim of managed PostgreSQL acceptance.
const migration = IDENTITY_OAUTH_IDENTITIES_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('101 registers after the claude-family 100, ahead of later concurrent tracks', () => {
  assert.equal(migration.version, 101);
  assert.equal(migration.name, 'identity_oauth_identities');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(101);
  assert.ok(index > 0, '101 is registered');
  assert.equal(registered[index - 1], 100, '101 lands directly after 100');
  assert.equal(registered.includes(100), true, '100 holds the R5 claude scheduling family 099 reserved it for');
  assert.equal(SAAS_MIGRATIONS[index], migration);
});

test('101 binds provider identities to saas_users with a unique (provider, subject) key', () => {
  assert.match(commands, /CREATE TABLE tenant_oauth_identities \(/);
  assert.match(commands, /provider_type text NOT NULL\s+CHECK \(provider_type IN \('oidc', 'wechat'\)\)/);
  assert.match(
    commands,
    /provider_subject text NOT NULL\s+CHECK \(char_length\(btrim\(provider_subject\)\) BETWEEN 1 AND 512\)/,
  );
  // The FK target is the 001 identity user table; bindings never outlive accounts.
  assert.match(commands, /tenant_user_id uuid NOT NULL REFERENCES saas_users\(id\) ON DELETE RESTRICT/);
  assert.match(
    commands,
    /CONSTRAINT tenant_oauth_identities_provider_subject_unique UNIQUE \(provider_type, provider_subject\)/,
  );
  assert.match(commands, /created_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(commands, /updated_at timestamptz NOT NULL DEFAULT now\(\)/);
  // Login lookups are by the binding key; the user index only serves support queries.
  assert.match(
    commands,
    /CREATE INDEX tenant_oauth_identities_tenant_user_idx ON tenant_oauth_identities \(tenant_user_id\)/,
  );
});

test('101 changes no ACL, trigger, or existing table shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /SECURITY DEFINER/i);
  assert.doesNotMatch(commands, /\bDROP\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /ALTER TABLE (?!tenant_oauth_identities)/i);
  assert.doesNotMatch(commands, /INSERT INTO/i);
});
