import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { OBS_ALERT_SILENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/127_obs_alert_silences_reports.js';

test('migration 127 creates the alert silences and report state tables with the pinned shape', () => {
  assert.equal(OBS_ALERT_SILENCES_SAAS_MIGRATION.version, 127);
  assert.equal(OBS_ALERT_SILENCES_SAAS_MIGRATION.name, 'obs_alert_silences_and_report_state');
  const sql = OBS_ALERT_SILENCES_SAAS_MIGRATION.sql;
  assert.match(sql, /CREATE TABLE saas_obs_alert_silences \(/);
  // The silence scope columns and their bounds.
  assert.match(sql, /rule_id uuid REFERENCES saas_obs_alert_rules \(id\) ON DELETE CASCADE/);
  for (const column of ['platform', 'group_id', 'region']) {
    assert.match(
      sql,
      new RegExp(
        `${column} text\\s+CHECK \\(${column} IS NULL OR \\(btrim\\(${column}\\) <> '' AND length\\(${column}\\) <= 100\\)\\)`,
      ),
    );
  }
  assert.match(sql, /until timestamptz NOT NULL/);
  assert.match(sql, /reason text\s+CHECK \(reason IS NULL OR \(btrim\(reason\) <> '' AND length\(reason\) <= 1000\)\)/);
  assert.match(sql, /created_by text NOT NULL\s+CHECK \(btrim\(created_by\) <> '' AND length\(created_by\) <= 200\)/);
  // A silence must carry at least one scope and end after its creation.
  assert.match(sql, /CONSTRAINT saas_obs_alert_silences_scope_not_empty/);
  assert.match(sql, /CONSTRAINT saas_obs_alert_silences_until_after_creation/);
  // The evaluator scans active silences by until; rule-scoped rows index too.
  assert.match(sql, /CREATE INDEX saas_obs_alert_silences_until_idx ON saas_obs_alert_silences \(until\)/);
  assert.match(
    sql,
    /CREATE INDEX saas_obs_alert_silences_rule_idx ON saas_obs_alert_silences \(rule_id\) WHERE rule_id IS NOT NULL/,
  );
  // The report state row: one per scheduled report type, holding last_run.
  assert.match(sql, /CREATE TABLE saas_obs_report_state \(/);
  assert.match(sql, /report_type text PRIMARY KEY/);
  assert.match(
    sql,
    /CHECK \(\s*report_type IN \('daily_summary', 'weekly_summary', 'error_digest', 'account_health'\)\s*\)/,
  );
  assert.match(sql, /last_run_at timestamptz NOT NULL/);
  assert.match(sql, /updated_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test('migration 127 registers in version order inside the parallel batch-5 tail', () => {
  const versions = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(versions.includes(127));
  assert.equal(SAAS_MIGRATIONS[versions.indexOf(127)], OBS_ALERT_SILENCES_SAAS_MIGRATION);
  // No duplicate versions or names across the registry.
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ name }) => name)).size, SAAS_MIGRATIONS.length);
});
