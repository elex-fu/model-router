import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROBE_MONITORS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/109_probe_monitors.js';

// Static candidate/source assertions only, mirroring the 106/107/108
// migration test family. No mock database, SQL evaluator, or claim of
// managed PostgreSQL acceptance.
const migration = PROBE_MONITORS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('109 registers directly after the applied 108 head as the R6a forward', () => {
  assert.equal(migration.version, 109);
  assert.equal(migration.name, 'probe_monitors');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(109);
  assert.ok(index > 0, '109 is registered');
  assert.equal(registered[index - 1], 108, '109 lands directly after the 108 head');
  assert.equal(registered.at(-1), 111, 'the F1 and Gemini forwards follow 109');
  assert.equal(registered.indexOf(109), registered.lastIndexOf(109));
  assert.equal(SAAS_MIGRATIONS[index], migration);
});

test('109 scopes monitors owner-first like the 040 runtime-health rows', () => {
  assert.match(commands, /CREATE TABLE saas_probe_monitors \(/);
  assert.match(commands, /owner_kind text NOT NULL CHECK \(owner_kind IN \('tenant', 'platform'\)\)/);
  assert.match(commands, /CONSTRAINT saas_probe_monitors_scope_unique UNIQUE \(owner_scope_key, account_id\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_probe_monitors_scope_shape CHECK \(\s+\(owner_kind = 'tenant' AND owner_tenant_id IS NOT NULL AND owner_scope_key = owner_tenant_id::text\)\s+OR \(owner_kind = 'platform' AND owner_tenant_id IS NULL AND owner_scope_key = 'platform'\)\s+\)/,
  );
  // Accounts are referenced by the owner-scoped text identity, never a
  // cross-family uuid FK.
  assert.match(
    commands,
    /account_id text NOT NULL CHECK \(btrim\(account_id\) <> '' AND account_id = btrim\(account_id\)\)/,
  );
  assert.doesNotMatch(commands, /REFERENCES saas_(tenant|platform)_provider_accounts/);
});

test('109 pins the probe categories, cadence bounds and challenge contract', () => {
  assert.match(
    commands,
    /provider_category text NOT NULL\s+CHECK \(provider_category IN \('claude', 'codex', 'opencode-go', 'api-key'\)\)/,
  );
  assert.match(
    commands,
    /probe_interval_seconds integer NOT NULL DEFAULT 300\s+CHECK \(probe_interval_seconds >= 60 AND probe_interval_seconds <= 86400\)/,
  );
  // The sub2api arithmetic few-shot contract: digits-only answer, exact
  // compare; the prompt is operator-visible configuration, never a secret.
  assert.match(
    commands,
    /CONSTRAINT saas_probe_monitors_challenge_answer_shape CHECK \(\s+challenge_answer ~ '\^\[0-9\]\{1,6\}\$'\s+\)/,
  );
  assert.match(
    commands,
    /failure_threshold integer NOT NULL DEFAULT 3\s+CHECK \(failure_threshold >= 1 AND failure_threshold <= 10\)/,
  );
  assert.match(
    commands,
    /last_result text\s+CHECK \(last_result IS NULL OR last_result IN \('ok', 'rate_limited', 'auth_revoked', 'banned', 'error'\)\)/,
  );
});

test('109 keeps run history append-only and detail payloads body-free', () => {
  assert.match(commands, /CREATE TABLE saas_probe_runs \(/);
  assert.match(commands, /monitor_id uuid NOT NULL\s+REFERENCES saas_probe_monitors \(id\) ON DELETE CASCADE/);
  assert.match(commands, /triggered_by text NOT NULL CHECK \(triggered_by IN \('manual', 'scheduled'\)\)/);
  assert.match(
    commands,
    /result text NOT NULL\s+CHECK \(result IN \('ok', 'rate_limited', 'auth_revoked', 'banned', 'error'\)\)/,
  );
  // No request/response bodies or credential fragments in any jsonb column.
  for (const column of ['last_result_detail', 'detail']) {
    assert.match(commands, new RegExp(`NOT \\(${column} \\? 'body'\\)`));
    assert.match(commands, new RegExp(`NOT \\(${column} \\? 'request'\\)`));
    assert.match(commands, new RegExp(`NOT \\(${column} \\? 'credential'\\)`));
  }
  assert.match(
    commands,
    /CREATE INDEX saas_probe_runs_monitor_created_idx\s+ON saas_probe_runs \(monitor_id, created_at DESC\);/,
  );
  assert.match(commands, /CREATE INDEX saas_probe_runs_created_idx\s+ON saas_probe_runs \(created_at\);/);
});

test('109 adds the probe unschedulable signal to both account families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN probe_temp_unschedulable_until timestamptz;`),
    );
  }
  // Scheduling signal only: no billing surface, no authz_version touch.
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /billing|price|cost|wallet/i);
});

test('109 changes no ACL, trigger, or function surface', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /SECURITY DEFINER/i);
  assert.doesNotMatch(commands, /\bDROP\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /INSERT INTO/i);
});
