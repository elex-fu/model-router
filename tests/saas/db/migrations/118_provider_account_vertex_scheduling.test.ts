import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_VERTEX_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/118_provider_account_vertex_scheduling.js';

// Static candidate/source assertions only, mirroring the 111/117 mirror-test
// family. No mock database, SQL evaluator, or claim of managed PostgreSQL
// acceptance.
const migration = PROVIDER_ACCOUNT_VERTEX_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('118 registers directly after 117 as the reserved Vertex slot', () => {
  assert.equal(migration.version, 118);
  assert.equal(migration.name, 'provider_account_vertex_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(118);
  assert.ok(index > 0, '118 is registered');
  assert.equal(registered[index - 1], 117, '118 lands directly after the bedrock 117');
  assert.equal(registered[index + 1], 119, 'the grok 119 follows the vertex 118');
  assert.equal(registered.at(-1), 146, 'fast receipt liability releases 146 is the applied head');
  assert.equal(SAAS_MIGRATIONS[index], migration);
  assert.deepEqual(registered.slice(-6), [141, 142, 143, 144, 145, 146]);
  // The assert-count guard: exactly one registration for the version.
  assert.equal(SAAS_MIGRATIONS.filter((m) => m.version === 118).length, 1);
});

test('118 adds nullable vertex scheduling signal columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN vertex_rate_limited_until timestamptz,\\s+ADD COLUMN vertex_usage_updated_at timestamptz;`,
      ),
    );
    // Scheduling signal only: every added column stays nullable so existing
    // rows keep byte-identical pre-batch-3 scheduling behavior (Vertex is
    // pay-as-you-go — no daily quota columns by design, the sub2api
    // adjudication documented in the migration comment).
    assert.doesNotMatch(commands, /ADD COLUMN vertex_\w+ \w+ NOT NULL/);
    assert.doesNotMatch(commands, new RegExp(`${table}[^;]*vertex_daily`));
  }
});

test('118 rewrites the probe-monitors category constraint to admit the vertex category', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_probe_monitors\s+DROP CONSTRAINT saas_probe_monitors_provider_category_check,\s+ADD CONSTRAINT saas_probe_monitors_provider_category_check\s+CHECK \(provider_category IN \('claude', 'codex', 'opencode-go', 'api-key', 'gemini', 'bedrock', 'vertex'\)\);/,
  );
});

test('118 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|private_key|secret|api_key/i);
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

test('119 carries the vertex category forward in the batch-3 CHECK chain', async () => {
  // Migration 119 (grok) lands AFTER 118 and rewrites the same constraint;
  // its CHECK must retain 'vertex' or the composed sequence would drop the
  // vertex probe category at migration time.
  const { PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION } = await import(
    '../../../../src/saas/db/migrations/119_provider_account_grok_scheduling.js'
  );
  assert.match(PROVIDER_ACCOUNT_GROK_SCHEDULING_SAAS_MIGRATION.sql, /CHECK \(provider_category IN \([^)]*'vertex'\)/);
});
