import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_CREDENTIAL_OAUTH_REFRESH_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/094_provider_credential_oauth_refresh_state.js';

// Static candidate/source assertions only.
const migration = PROVIDER_CREDENTIAL_OAUTH_REFRESH_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('094 registers after 093 with the documented gaps', () => {
  assert.equal(migration.version, 94);
  assert.equal(migration.name, 'provider_credential_oauth_refresh_state');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  assert.equal(SAAS_MIGRATIONS[74], migration);
});

test('094 adds nullable OAuth scheduling state to both credential owner families', () => {
  for (const table of ['saas_tenant_provider_credentials', 'saas_platform_provider_credentials']) {
    const alter = new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN oauth_refresh_state text,`);
    assert.match(commands, alter);
    assert.match(commands, /ADD COLUMN oauth_next_refresh_at timestamptz,/);
    assert.match(commands, /ADD COLUMN oauth_last_refresh_at timestamptz,/);
    assert.match(commands, /ADD COLUMN oauth_force_refresh_requested boolean NOT NULL DEFAULT false,/);
    assert.match(commands, /ADD COLUMN oauth_refresh_error_code text/);
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_oauth_state_check\\s+CHECK \\(oauth_refresh_state IS NULL OR oauth_refresh_state IN \\('idle', 'refreshing', 'failed'\\)\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_oauth_state_shape\\s+CHECK \\(\\(oauth_refresh_state IS NULL\\) = \\(oauth_next_refresh_at IS NULL AND oauth_last_refresh_at IS NULL\\)\\)`,
      ),
    );
    // Nullable on purpose: NULL = not an OAuth credential = pre-R4 behavior.
    assert.doesNotMatch(commands, /ADD COLUMN oauth_refresh_state text NOT NULL/);
  }
});

test('094 stores no secret material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|secret/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /current_version|authz_version/i);
});
