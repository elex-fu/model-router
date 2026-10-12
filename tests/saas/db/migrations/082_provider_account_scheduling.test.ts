import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/082_provider_account_scheduling.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = PROVIDER_ACCOUNT_SCHEDULING_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('082 registers after 081 with the documented 061/062 and retired 064-079 gaps', () => {
  assert.equal(migration.version, 82);
  assert.equal(migration.name, 'provider_account_scheduling_priority_weight');
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
  assert.equal(SAAS_MIGRATIONS[63], migration);
});

test('082 adds the contract C-7 scheduling columns to both account owner families', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    const alter = new RegExp(
      `ALTER TABLE ${table}\\s+ADD COLUMN priority integer NOT NULL DEFAULT 0,\\s+ADD COLUMN weight integer NOT NULL DEFAULT 1`,
    );
    assert.match(commands, alter);
    assert.match(
      commands,
      new RegExp(`CONSTRAINT ${table}_priority_range\\s+CHECK \\(priority >= 0 AND priority <= 1000\\)`),
    );
    assert.match(
      commands,
      new RegExp(`CONSTRAINT ${table}_weight_range\\s+CHECK \\(weight >= 1 AND weight <= 10000\\)`),
    );
  }
});

test('082 changes no trigger, ACL, epoch, or lifecycle shape', () => {
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /DROP /i);
});
