import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_BEDROCK_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/117_provider_account_bedrock_scheduling.js';

// Static candidate/source assertions only, mirroring the 111 mirror-test
// family. No mock database, SQL evaluator, or claim of managed PostgreSQL
// acceptance.
const migration = PROVIDER_ACCOUNT_BEDROCK_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('117 registers directly after 116 (the applied head; 119 is the parallel grok tail)', () => {
  assert.equal(migration.version, 117);
  assert.equal(migration.name, 'provider_account_bedrock_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(117);
  assert.ok(index > 0, '117 is registered');
  assert.equal(registered[index - 1], 116, '117 lands directly after 116');
  assert.equal(registered[index + 1], 118, 'the parallel vertex 118 follows 117');
  assert.equal(SAAS_MIGRATIONS[index], migration);
  // The assert-count guard: exactly one registration for the version.
  assert.equal(SAAS_MIGRATIONS.filter((m) => m.version === 117).length, 1);
});

test('117 adds nullable bedrock scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN bedrock_rate_limited_until timestamptz,\\s+ADD COLUMN bedrock_usage_updated_at timestamptz;`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-batch-3 scheduling behavior.
    assert.doesNotMatch(commands, /ADD COLUMN bedrock_\w+ \w+ NOT NULL/);
    // The minimal-family scope decision: no quota-window columns (Bedrock
    // responses expose no windows) and no tier/percent columns.
    for (const forbidden of [
      'bedrock_daily_',
      'bedrock_minute_',
      'bedrock_tier_',
      'bedrock_used_percent',
      'bedrock_shared_',
    ]) {
      assert.ok(!commands.includes(forbidden), `no ${forbidden} column family`);
    }
  }
});

test('117 rewrites the probe-monitors category constraint to admit the bedrock category', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_probe_monitors\s+DROP CONSTRAINT saas_probe_monitors_provider_category_check,\s+ADD CONSTRAINT saas_probe_monitors_provider_category_check\s+CHECK \(provider_category IN \('claude', 'codex', 'opencode-go', 'api-key', 'gemini', 'bedrock'\)\);/,
  );
});

test('117 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|secret|api_key|aws_/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  // The only DROP is the same-table constraint rewrite asserted above.
  assert.doesNotMatch(commands, /DROP TABLE/i);
  assert.equal(
    (commands.match(/DROP CONSTRAINT/g) ?? []).length,
    1,
    'exactly one constraint rewrite: the probe-monitors category check',
  );
});
