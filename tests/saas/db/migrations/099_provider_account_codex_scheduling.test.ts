import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_CODEX_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/099_provider_account_codex_scheduling.js';

// Static candidate/source assertions only.
const migration = PROVIDER_ACCOUNT_CODEX_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('099 registers after 098 in forward order and leaves 100 unoccupied', () => {
  assert.equal(migration.version, 99);
  assert.equal(migration.name, 'provider_account_codex_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  // Stable append position: 099 is the 80th registered migration, directly
  // after 098 (later phases may append further forwards).
  assert.equal(SAAS_MIGRATIONS[78]?.version, 98);
  assert.equal(SAAS_MIGRATIONS[79], migration);
  // No migration 100: the plan's account-plan metadata lives inside the
  // sealed credential envelope, so 100 stays available (no stranded numbers).
  assert.equal(registered.includes(100), false);
});

test('099 adds nullable codex scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN codex_5h_used_percent real,\\s+ADD COLUMN codex_5h_reset_at timestamptz,`,
      ),
    );
    assert.match(commands, /ADD COLUMN codex_7d_used_percent real,\s+ADD COLUMN codex_7d_reset_at timestamptz,/);
    assert.match(commands, /ADD COLUMN codex_usage_updated_at timestamptz,/);
    assert.match(commands, /ADD COLUMN auto_pause_5h_threshold real,\s+ADD COLUMN auto_pause_7d_threshold real,/);
    assert.match(commands, /ADD COLUMN codex_fingerprint_mode text DEFAULT 'off',/);
    assert.match(commands, /ADD COLUMN codex_fingerprint_seed text/);
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_codex_fingerprint_mode_values\\s+CHECK \\(codex_fingerprint_mode IS NULL OR codex_fingerprint_mode IN \\('off', 'device', 'session', 'full'\\)\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_codex_fingerprint_shape\\s+CHECK \\(\\s+\\(codex_fingerprint_mode = 'off' OR codex_fingerprint_mode IS NULL\\) = \\(codex_fingerprint_seed IS NULL\\)\\s+\\)`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-P1b scheduling behavior.
    assert.doesNotMatch(commands, /ADD COLUMN codex_\w+ \w+ NOT NULL/);
    assert.doesNotMatch(commands, /ADD COLUMN auto_pause_\w+ \w+ NOT NULL/);
  }
});

test('099 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|secret|api_key/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /current_version|authz_version/i);
});
