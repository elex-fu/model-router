import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CN_PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/120_cn_provider_account_scheduling.js';

// Static candidate/source assertions only.
const migration = CN_PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('120 registers after the 117/119 batch-3 tails in forward order', () => {
  assert.equal(migration.version, 120);
  assert.equal(migration.name, 'cn_provider_account_scheduling');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  // Stable append position: 120 follows the parallel batch-3 bedrock (117)
  // and grok (119) tails; 118 stays reserved for the Vertex workstream.
  assert.equal(registered.includes(117), true);
  assert.equal(registered.includes(119), true);
  assert.equal(registered.indexOf(120), registered.lastIndexOf(120));
  assert.equal(registered.indexOf(120) > registered.indexOf(117), true);
  assert.equal(registered.indexOf(120) > registered.indexOf(119), true);
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(120)], migration);
});

test('120 adds nullable CN-provider scheduling signal and dual-mode config columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    for (const prefix of ['zhipu', 'minimax']) {
      // Each ALTER adds the full per-provider family in order; the zhipu
      // family leads, so the minimax match must not anchor on the table name.
      assert.match(
        commands,
        new RegExp(
          `ADD COLUMN ${prefix}_5h_used_percent real,\\s+ADD COLUMN ${prefix}_5h_reset_at timestamptz,\\s+ADD COLUMN ${prefix}_weekly_used_percent real,\\s+ADD COLUMN ${prefix}_weekly_reset_at timestamptz,`,
        ),
      );
      assert.match(
        commands,
        new RegExp(
          `ADD COLUMN ${prefix}_usage_updated_at timestamptz,\\s+ADD COLUMN ${prefix}_usage_next_due_at timestamptz,\\s+ADD COLUMN ${prefix}_usage_failure_count integer,\\s+ADD COLUMN ${prefix}_rate_limited_until timestamptz,`,
        ),
      );
      assert.match(commands, new RegExp(`ADD COLUMN ${prefix}_account_mode text,`));
      assert.match(commands, new RegExp(`ADD COLUMN ${prefix}_api_protocol text,`));
      // Percent + failure-count CHECKs and the account_mode / api_protocol
      // vocabulary CHECKs (the 108 percent/failure precedent; the per-element
      // 'responses is minimax-only' matrix stays application-layer).
      assert.match(commands, new RegExp(`${table}_${prefix}_percent_range`));
      assert.match(commands, new RegExp(`${table}_${prefix}_failure_count_range`));
      assert.match(
        commands,
        new RegExp(`${prefix}_account_mode IS NULL OR ${prefix}_account_mode IN \\('payg', 'coding'\\)`),
      );
      assert.match(
        commands,
        new RegExp(
          `${prefix}_api_protocol IS NULL\\s+OR ${prefix}_api_protocol IN \\('chat_completions', 'anthropic', 'responses', 'adaptive'\\)`,
        ),
      );
      // Partial due index per provider (the worker's SKIP LOCKED claim scan).
      assert.match(
        commands,
        new RegExp(
          `CREATE INDEX ${table}_${prefix}_usage_due_idx\\s+ON ${table} \\(${prefix}_usage_next_due_at, id\\)\\s+WHERE status = 'active';`,
        ),
      );
    }
  }
});

test('120 stores no credential material and changes no trigger, ACL or lifecycle shape', () => {
  assert.doesNotMatch(commands, /refresh_token|access_token|password|private_key/i);
  assert.doesNotMatch(commands, /api_key/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /current_version/i);
  // The admin mutation path bumps authz_version through the platform config
  // store's CAS SQL (047/082 pattern), never inside the migration itself.
  assert.doesNotMatch(commands, /authz_version/i);
});
