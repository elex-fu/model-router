import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_QUARANTINE_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/097_provider_account_quarantine_state.js';

// Static candidate/source assertions only.
const migration = PROVIDER_ACCOUNT_QUARANTINE_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('097 registers after 096 with the documented gaps', () => {
  assert.equal(migration.version, 97);
  assert.equal(migration.name, 'provider_account_quarantine_state');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  assert.equal(SAAS_MIGRATIONS[77], migration);
});

test('097 widens the validation_state enum and adds nullable quarantine columns to both account tables', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(commands, new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN quarantine_entered_at timestamptz`));
    assert.match(commands, new RegExp(`ADD COLUMN quarantine_reason_code text`));
    assert.match(
      commands,
      new RegExp(
        `ADD CONSTRAINT ${table}_validation_state_check\\s+CHECK \\(validation_state IN \\('unverified', 'verified', 'failed', 'quarantined'\\)\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `ADD CONSTRAINT ${table}_quarantine_shape\\s+CHECK \\(\\s+\\(validation_state = 'quarantined' AND quarantine_entered_at IS NOT NULL\\)\\s+OR \\(validation_state <> 'quarantined' AND quarantine_entered_at IS NULL AND quarantine_reason_code IS NULL\\)\\s+\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `ADD CONSTRAINT ${table}_quarantine_reason_length\\s+CHECK \\(quarantine_reason_code IS NULL OR \\(btrim\\(quarantine_reason_code\\) <> '' AND char_length\\(quarantine_reason_code\\) <= 128\\)\\)`,
      ),
    );
    assert.doesNotMatch(commands, new RegExp(`ADD COLUMN quarantine_entered_at timestamptz NOT NULL`));
  }
});

test('097 confines the quarantine transition graph with pinned-search-path guards on both tables', () => {
  for (const [fn, table] of [
    ['saas_tenant_provider_account_quarantine_guard', 'saas_tenant_provider_accounts'],
    ['saas_platform_provider_account_quarantine_guard', 'saas_platform_provider_accounts'],
  ] as const) {
    assert.match(commands, new RegExp(`CREATE FUNCTION ${fn}\\(\\) RETURNS trigger`));
    assert.match(commands, new RegExp(`ALTER FUNCTION ${fn}\\(\\)\\s+SET search_path TO pg_catalog, model_router_saas, pg_temp`));
    assert.match(commands, new RegExp(`CREATE TRIGGER ${table}_quarantine_guard\\s+BEFORE UPDATE ON ${table}`));
  }
  assert.match(commands, /Provider account quarantine may only be entered from failed/);
  assert.match(commands, /Provider account quarantine may only be left towards verified/);
  assert.match(commands, /Provider account quarantine entry facts are immutable/);
  assert.match(commands, /Quarantine facts must be cleared when leaving quarantine/);
});

test('097 grants no privileges and rewrites no data', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /\bINSERT INTO\b|\bUPDATE model_router_saas/i);
  assert.doesNotMatch(commands, /DROP TABLE/i);
  // The validation_error_shape invariant (failed carries the code, others do
  // not) is untouched: quarantine moves the reason to its own column.
  assert.doesNotMatch(commands, /validation_error_shape/i);
});
