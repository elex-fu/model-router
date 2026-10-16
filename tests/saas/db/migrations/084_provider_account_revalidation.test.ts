import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_REVALIDATION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/084_provider_account_revalidation.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = PROVIDER_ACCOUNT_REVALIDATION_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('084 registers after 083 with the documented 061/062 and retired 064-079 gaps', () => {
  assert.equal(migration.version, 84);
  assert.equal(migration.name, 'provider_account_revalidation_interval');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 60).map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  // 064-079 can never apply on a database that already took 080/081 (the
  // fail-closed ordering rule); the ledger retires the block and Track D
  // consumes 082+.
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false, `${skipped} stays a retired Track D-G gap`);
  }
  assert.equal(SAAS_MIGRATIONS[65], migration);
});

test('084 adds the nullable account-level revalidation cadence to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    const alter = new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN revalidation_interval_seconds integer,`);
    assert.match(commands, alter);
    // NULL disables periodic revalidation (the default for every existing
    // row, i.e. byte-identical pre-D3 behavior); configured values are bounded
    // to 15 minutes .. 7 days.
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_revalidation_interval_range\\s+CHECK \\(revalidation_interval_seconds IS NULL\\s+OR \\(revalidation_interval_seconds >= 900 AND revalidation_interval_seconds <= 604800\\)\\)`,
      ),
    );
    // Nullable on purpose: NOT NULL or a default would flip existing accounts
    // into an unrequested revalidation cadence.
    assert.doesNotMatch(commands, /ADD COLUMN revalidation_interval_seconds integer NOT NULL/);
  }
});

test('084 changes no trigger, ACL, epoch, or lifecycle shape', () => {
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /DROP /i);
});
