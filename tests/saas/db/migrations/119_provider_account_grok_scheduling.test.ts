import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/119_provider_account_grok_scheduling.js';

// Static candidate/source assertions only, mirroring the 111/117 mirror-test
// family. No mock database, SQL evaluator, or claim of managed PostgreSQL
// acceptance.
const migration = PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('119 registers after the parallel batch-3 tails (117/118) and before the CN 120', () => {
  assert.equal(migration.version, 119);
  assert.equal(migration.name, 'provider_account_grok_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(119);
  assert.ok(index > 0, '119 is registered');
  assert.equal(registered[index - 1], 118, '119 lands after the parallel vertex 118');
  assert.equal(registered[index + 1], 120, 'the batch-3 CN-providers tail follows');
  assert.equal(SAAS_MIGRATIONS[index], migration);
  // The assert-count guard: exactly one registration for the version.
  assert.equal(SAAS_MIGRATIONS.filter((m) => m.version === 119).length, 1);
});

test('119 adds nullable grok scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN grok_5h_used_percent real,\\s+ADD COLUMN grok_5h_reset_at timestamptz,\\s+ADD COLUMN grok_requests_used_percent real,\\s+ADD COLUMN grok_requests_reset_at timestamptz,\\s+ADD COLUMN grok_rate_limited_until timestamptz,\\s+ADD COLUMN grok_usage_updated_at timestamptz,\\s+ADD COLUMN grok_subscription_tier text,\\s+ADD COLUMN grok_billing jsonb,\\s+ADD COLUMN grok_billing_updated_at timestamptz,`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-batch-3 scheduling behavior.
    assert.doesNotMatch(commands, /ADD COLUMN grok_\w+ \w+ NOT NULL/);
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_grok_5h_percent_range\\s+CHECK \\(grok_5h_used_percent IS NULL OR grok_5h_used_percent >= 0\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_grok_subscription_tier_shape\\s+CHECK \\(\\s+grok_subscription_tier IS NULL\\s+OR \\(btrim\\(grok_subscription_tier\\) = grok_subscription_tier AND grok_subscription_tier <> '' AND length\\(grok_subscription_tier\\) <= 64\\)\\s+\\)`,
      ),
    );
  }
});

test('119 admits the grok probe category on the migration-109 monitors table', () => {
  // The rewrite is cumulative: the parallel bedrock/vertex workstreams carry
  // their categories forward through this same statement (their migrations
  // land at 117/118 and rewrite the CHECK before this one), so the applied
  // list admits every batch-3 category.
  assert.match(
    commands,
    /ALTER TABLE saas_probe_monitors\s+DROP CONSTRAINT saas_probe_monitors_provider_category_check,\s+ADD CONSTRAINT saas_probe_monitors_provider_category_check\s+CHECK \(provider_category IN \('claude', 'codex', 'opencode-go', 'api-key', 'gemini', 'grok', 'bedrock', 'vertex'\)\);/,
  );
});
