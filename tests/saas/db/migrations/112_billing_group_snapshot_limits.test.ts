import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { BILLING_GROUP_SNAPSHOT_LIMITS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/112_billing_group_snapshot_limits.js';

// Static candidate/source assertions only.
const migration = BILLING_GROUP_SNAPSHOT_LIMITS_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('112 registers as the applied head after the 111 Gemini forward', () => {
  assert.equal(migration.version, 112);
  assert.equal(migration.name, 'billing_group_snapshot_limits');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.at(-1), 133);
  assert.equal(registered.includes(migration.version), true);
});

test('112 freezes the R1 enforcement terms onto the customer price snapshot', () => {
  for (const [column, kind] of [
    ['group_rpm_limit', 'integer'],
    ['group_daily_limit_minor_units', 'bigint'],
    ['group_weekly_limit_minor_units', 'bigint'],
    ['group_monthly_limit_minor_units', 'bigint'],
  ] as const) {
    assert.match(
      commands,
      new RegExp(`ADD COLUMN ${column} ${kind}\\s+CHECK \\(${column} IS NULL OR ${column} >= 0\\)`),
    );
  }
  assert.match(commands, /ADD COLUMN group_supported_model_scopes text\[\]/);
  assert.match(
    commands,
    /ADD COLUMN group_fallback_group_id text\s+CHECK \(group_fallback_group_id IS NULL OR \(\s*char_length\(group_fallback_group_id\) BETWEEN 1 AND 128\s*AND group_fallback_group_id = btrim\(group_fallback_group_id\)\s*\)\)/,
  );
});

test('112 adds only nullable columns so existing snapshots backfill to no-limit', () => {
  assert.doesNotMatch(commands, /NOT NULL/);
  assert.doesNotMatch(commands, /DEFAULT/);
  // No foreign keys: the frozen copies are evidence validated at composition
  // time by the live group row's own constraints.
  assert.doesNotMatch(commands, /REFERENCES/);
});

test('112 grants no privileges and changes no trigger or lifecycle shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /DROP /i);
});
