import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_QUOTA_SNAPSHOTS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/093_provider_account_quota_snapshots.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = PROVIDER_ACCOUNT_QUOTA_SNAPSHOTS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('093 registers after 092 with the documented 061/062, retired 064-079, 086 and 090/091 gaps', () => {
  assert.equal(migration.version, 93);
  assert.equal(migration.name, 'provider_account_quota_snapshots');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 60).map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false, `${skipped} stays a retired Track D-G gap`);
  }
  assert.equal(registered.includes(86), false);
  // 090/091 landed with R1/R2 (wave 3); 094/095 follow in landing order.
  assert.equal(SAAS_MIGRATIONS[73], migration);
});

test('093 adds nullable backward-compatible quota snapshot columns to both account tables', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    const block = commands.match(new RegExp(`ALTER TABLE ${table}([\\s\\S]*?);`))?.[1];
    assert.ok(block, `${table} must be altered`);
    assert.match(block, /ADD COLUMN quota_state text,/);
    assert.match(block, /ADD COLUMN quota_remaining_minor_units text,/);
    assert.match(block, /ADD COLUMN quota_currency text,/);
    assert.match(block, /ADD COLUMN quota_checked_at timestamptz,/);
    // Every column stays nullable: NULL means "never checked" and must not
    // change scheduling for existing rows (no backfill, no DEFAULT).
    assert.doesNotMatch(block, /quota_state text NOT NULL/);
    assert.doesNotMatch(block, /quota_state text[^,]*DEFAULT/);
    assert.doesNotMatch(block, /quota_checked_at timestamptz NOT NULL/);
    assert.match(
      block,
      new RegExp(
        `ADD CONSTRAINT ${table}_quota_state_values\\s+CHECK \\(quota_state IS NULL OR quota_state IN \\('unknown', 'ok', 'low', 'exhausted'\\)\\)`,
      ),
    );
    assert.match(
      block,
      new RegExp(
        `ADD CONSTRAINT ${table}_quota_remaining_format\\s+CHECK \\(quota_remaining_minor_units IS NULL OR quota_remaining_minor_units ~ '\\^\\[0-9\\]\\{1,20\\}\\$'\\)`,
      ),
    );
    assert.match(
      block,
      new RegExp(
        `ADD CONSTRAINT ${table}_quota_currency_format\\s+CHECK \\(quota_currency IS NULL OR quota_currency ~ '\\^\\[A-Z\\]\\{3\\}\\$'\\)`,
      ),
    );
  }
});

test('093 enforces the unknown-never-carries-an-amount shape invariant', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    const block = commands.match(new RegExp(`ALTER TABLE ${table}([\\s\\S]*?);`))?.[1];
    assert.ok(block);
    // state and checked_at always move together: a check exists iff attempted.
    assert.match(block, /\(quota_state IS NULL\) = \(quota_checked_at IS NULL\)/);
    // the amount and its currency always move together.
    assert.match(block, /\(quota_remaining_minor_units IS NULL\) = \(quota_currency IS NULL\)/);
    // an unknown (or never-checked) snapshot carries no amount: never guessed.
    assert.match(block, /\(quota_state IS NULL OR quota_state = 'unknown'\) = \(quota_remaining_minor_units IS NULL\)/);
  }
});

test('093 indexes the due scan for both owner dimensions without touching history', () => {
  assert.match(
    commands,
    /CREATE INDEX saas_tenant_provider_accounts_quota_due_idx\s+ON saas_tenant_provider_accounts \(quota_checked_at, tenant_id, id\)\s+WHERE status = 'active';/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_platform_provider_accounts_quota_due_idx\s+ON saas_platform_provider_accounts \(quota_checked_at, id\)\s+WHERE status = 'active';/,
  );
});

test('093 grants no privileges, adds no triggers and touches no other object', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /CREATE (?:OR REPLACE )?(?:FUNCTION|TRIGGER|VIEW|TABLE)\b/i);
  assert.doesNotMatch(commands, /\bDROP\b/i);
  assert.doesNotMatch(commands, /authz_version|priority|weight|validation_state|updated_at/i);
  // The snapshot is a mutable-in-place signal: no history or event tables.
  assert.doesNotMatch(commands, /CREATE TABLE/i);
  assert.doesNotMatch(commands, /INSERT INTO|DELETE FROM/i);
});
