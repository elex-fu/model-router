import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_OPENCODE_GO_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/108_provider_account_opencode_go_scheduling.js';

// Static candidate/source assertions only.
const migration = PROVIDER_ACCOUNT_OPENCODE_GO_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('108 registers after 105/106 in forward order and leaves 107 unoccupied', () => {
  assert.equal(migration.version, 108);
  assert.equal(migration.name, 'provider_account_opencode_go_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  // Stable append position: 108 follows the 105/106 forwards directly; the
  // R4 registration-admission migration (106) landed after 108 was reserved
  // and slots in ahead of it. 107 stays available for the next workstream.
  assert.equal(registered.includes(105), true);
  assert.equal(registered.includes(106), true);
  assert.equal(registered.indexOf(108), registered.lastIndexOf(108));
  assert.equal(registered.indexOf(108) > registered.indexOf(106), true);
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(108)], migration);
  assert.equal(registered.includes(107), false);
});

test('108 adds nullable OpenCode Go scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN opencode_go_rolling_5h_used_percent real,\\s+ADD COLUMN opencode_go_rolling_5h_reset_at timestamptz,`,
      ),
    );
    assert.match(
      commands,
      /ADD COLUMN opencode_go_weekly_used_percent real,\s+ADD COLUMN opencode_go_weekly_reset_at timestamptz,/,
    );
    assert.match(
      commands,
      /ADD COLUMN opencode_go_monthly_used_percent real,\s+ADD COLUMN opencode_go_monthly_reset_at timestamptz,/,
    );
    assert.match(commands, /ADD COLUMN opencode_go_usage_updated_at timestamptz,/);
    assert.match(commands, /ADD COLUMN opencode_go_usage_next_due_at timestamptz,/);
    assert.match(commands, /ADD COLUMN opencode_go_usage_failure_count integer,/);
    assert.match(commands, /ADD COLUMN opencode_go_rate_limited_until timestamptz,/);
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_opencode_go_percent_range\\s+CHECK \\(\\s+\\(opencode_go_rolling_5h_used_percent IS NULL OR opencode_go_rolling_5h_used_percent >= 0\\)\\s+AND \\(opencode_go_weekly_used_percent IS NULL OR opencode_go_weekly_used_percent >= 0\\)\\s+AND \\(opencode_go_monthly_used_percent IS NULL OR opencode_go_monthly_used_percent >= 0\\)\\s+\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_opencode_go_failure_count_range\\s+CHECK \\(opencode_go_usage_failure_count IS NULL OR opencode_go_usage_failure_count >= 0\\)`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-R5b scheduling behavior.
    assert.doesNotMatch(commands, /ADD COLUMN opencode_go_\w+ \w+ NOT NULL/);
  }
});

test('108 adds the protocol_rules jsonb column with the R5b-2 documented shape', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(commands, new RegExp(`ALTER TABLE ${table}\\s+[^;]*ADD COLUMN opencode_go_protocol_rules jsonb`));
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_opencode_go_protocol_rules_shape\\s+CHECK \\(\\s+opencode_go_protocol_rules IS NULL\\s+OR \\(\\s+jsonb_typeof\\(opencode_go_protocol_rules\\) = 'array'\\s+AND jsonb_array_length\\(opencode_go_protocol_rules\\) <= 64\\s+\\)\\s+\\)`,
      ),
    );
  }
});

test('108 creates the R5b-3 due index on both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `CREATE INDEX ${table}_opencode_go_usage_due_idx\\s+ON ${table} \\(opencode_go_usage_next_due_at, id\\)\\s+WHERE status = 'active';`,
      ),
    );
  }
});

test('108 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|secret|password|private_key/i);
  assert.doesNotMatch(commands, /api_key/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /current_version/i);
  // The admin mutation path bumps authz_version through the repository CAS
  // SQL (047/082 pattern), never inside the migration itself.
  assert.doesNotMatch(commands, /authz_version/i);
});
