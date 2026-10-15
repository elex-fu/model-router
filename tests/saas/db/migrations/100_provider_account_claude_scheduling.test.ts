import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_CLAUDE_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/100_provider_account_claude_scheduling.js';

// Static candidate/source assertions only, mirroring the 099 mirror-test
// family. No mock database, SQL evaluator, or claim of managed PostgreSQL
// acceptance.
const migration = PROVIDER_ACCOUNT_CLAUDE_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('100 registers directly after 099 in forward order (the slot 099 reserved)', () => {
  assert.equal(migration.version, 100);
  assert.equal(migration.name, 'provider_account_claude_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(100);
  assert.ok(index > 0, '100 is registered');
  assert.equal(registered[index - 1], 99, '100 lands directly after 099');
  assert.equal(registered[index + 1], 101, '100 lands directly before 101');
  assert.equal(SAAS_MIGRATIONS[index], migration);
});

test('100 adds nullable claude scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN claude_5h_utilization real,\\s+ADD COLUMN claude_5h_reset_at timestamptz,`,
      ),
    );
    assert.match(commands, /ADD COLUMN claude_7d_utilization real,\s+ADD COLUMN claude_7d_reset_at timestamptz,/);
    assert.match(
      commands,
      /ADD COLUMN claude_7d_sonnet_utilization real,\s+ADD COLUMN claude_7d_sonnet_reset_at timestamptz,/,
    );
    assert.match(commands, /ADD COLUMN claude_7d_oi_utilization real,\s+ADD COLUMN claude_7d_oi_reset_at timestamptz,/);
    assert.match(commands, /ADD COLUMN claude_usage_updated_at timestamptz,/);
    assert.match(
      commands,
      /ADD COLUMN claude_session_window_start timestamptz,\s+ADD COLUMN claude_session_window_end timestamptz,/,
    );
    assert.match(commands, /ADD COLUMN claude_cli_version_override text/);
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_claude_5h_utilization_range\\s+CHECK \\(claude_5h_utilization IS NULL OR claude_5h_utilization >= 0\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_claude_session_window_order\\s+CHECK \\(\\s+claude_session_window_start IS NULL\\s+OR claude_session_window_end IS NULL\\s+OR claude_session_window_start < claude_session_window_end\\s+\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_claude_cli_version_shape\\s+CHECK \\(\\s+claude_cli_version_override IS NULL\\s+OR claude_cli_version_override ~ '\\^\\[0-9\\]\\+\\\\\\.\\[0-9\\]\\+\\\\\\.\\[0-9\\]\\+\\$'\\s+\\)`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-R5 scheduling behavior.
    assert.doesNotMatch(commands, /ADD COLUMN claude_\w+ \w+ NOT NULL/);
  }
});

test('100 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|secret|api_key/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /current_version|authz_version/i);
});
