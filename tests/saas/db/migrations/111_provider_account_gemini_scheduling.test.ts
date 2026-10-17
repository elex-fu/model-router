import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_GEMINI_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/111_provider_account_gemini_scheduling.js';

// Static candidate/source assertions only, mirroring the 100/108 mirror-test
// family. No mock database, SQL evaluator, or claim of managed PostgreSQL
// acceptance.
const migration = PROVIDER_ACCOUNT_GEMINI_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('111 registers directly after 110 as the applied head (the slot 110 documented)', () => {
  assert.equal(migration.version, 111);
  assert.equal(migration.name, 'provider_account_gemini_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(111);
  assert.ok(index > 0, '111 is registered');
  assert.equal(registered[index - 1], 110, '111 lands directly after 110');
  // Batch-3 (117 bedrock / 119 grok) tails registered after 116; 111's
  // direct-predecessor contract above is what pins the ordering.
  // K2: 129 (provider_account_durable_fault_classification, renumbered from
  // main's 112 in this merge) is the applied head; 111 still lands directly
  // after 110 (the direct-predecessor contract above).
  assert.equal(registered.at(-1), 129, 'the K2 durable fault classification tail is the applied head');
  assert.equal(SAAS_MIGRATIONS[index], migration);
  // The assert-count guard: exactly one registration for the version.
  assert.equal(SAAS_MIGRATIONS.filter((m) => m.version === 111).length, 1);
});

test('111 adds nullable gemini scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN gemini_shared_daily_used integer,\\s+ADD COLUMN gemini_shared_daily_limit integer,`,
      ),
    );
    assert.match(commands, /ADD COLUMN gemini_pro_daily_used integer,\s+ADD COLUMN gemini_pro_daily_limit integer,/);
    assert.match(
      commands,
      /ADD COLUMN gemini_flash_daily_used integer,\s+ADD COLUMN gemini_flash_daily_limit integer,/,
    );
    assert.match(commands, /ADD COLUMN gemini_minute_used integer,\s+ADD COLUMN gemini_minute_limit integer,/);
    assert.match(commands, /ADD COLUMN gemini_daily_reset_at timestamptz,/);
    assert.match(commands, /ADD COLUMN gemini_usage_updated_at timestamptz,/);
    assert.match(commands, /ADD COLUMN gemini_rate_limited_until timestamptz,/);
    assert.match(commands, /ADD COLUMN gemini_tier_id text,/);
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_gemini_daily_used_range\\s+CHECK \\(\\s+\\(gemini_shared_daily_used IS NULL OR gemini_shared_daily_used >= 0\\)\\s+AND \\(gemini_pro_daily_used IS NULL OR gemini_pro_daily_used >= 0\\)\\s+AND \\(gemini_flash_daily_used IS NULL OR gemini_flash_daily_used >= 0\\)\\s+AND \\(gemini_minute_used IS NULL OR gemini_minute_used >= 0\\)\\s+\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_gemini_daily_limit_range\\s+CHECK \\(\\s+\\(gemini_shared_daily_limit IS NULL OR gemini_shared_daily_limit >= -1\\)\\s+AND \\(gemini_pro_daily_limit IS NULL OR gemini_pro_daily_limit >= -1\\)\\s+AND \\(gemini_flash_daily_limit IS NULL OR gemini_flash_daily_limit >= -1\\)\\s+AND \\(gemini_minute_limit IS NULL OR gemini_minute_limit >= -1\\)\\s+\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_gemini_tier_id_shape\\s+CHECK \\(\\s+gemini_tier_id IS NULL\\s+OR \\(btrim\\(gemini_tier_id\\) = gemini_tier_id AND gemini_tier_id <> '' AND length\\(gemini_tier_id\\) <= 64\\)\\s+\\)`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-F4 scheduling behavior.
    assert.doesNotMatch(commands, /ADD COLUMN gemini_\w+ \w+ NOT NULL/);
  }
});

test('111 rewrites the probe-monitors category constraint to admit the gemini category', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_probe_monitors\s+DROP CONSTRAINT saas_probe_monitors_provider_category_check,\s+ADD CONSTRAINT saas_probe_monitors_provider_category_check\s+CHECK \(provider_category IN \('claude', 'codex', 'opencode-go', 'api-key', 'gemini'\)\);/,
  );
});

test('111 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|secret|api_key/i);
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
  assert.doesNotMatch(commands, /current_version|authz_version/i);
});
