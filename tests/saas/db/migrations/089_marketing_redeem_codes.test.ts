import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { MARKETING_REDEEM_CODES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/089_marketing_redeem_codes.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = MARKETING_REDEEM_CODES_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('089 registers after 088 with the documented 061/062, retired 064-079 and 086 gaps', () => {
  assert.equal(migration.version, 89);
  assert.equal(migration.name, 'marketing_redeem_codes');
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
  assert.equal(SAAS_MIGRATIONS[69], migration);
});

test('089 stores codes irreversibly with the kind-shape and terminal-fact CHECKs', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_redeem_codes \(/);
  assert.match(commands, /code_hash text NOT NULL/);
  assert.match(commands, /CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(commands, /CHECK \(code_prefix ~ '\^\[A-Z2-9\]\{4,8\}\$'\)/);
  assert.match(commands, /CHECK \(kind IN \('balance', 'subscription'\)\)/);
  // kind/shape exclusivity: balance carries fixed-point amount + currency and
  // no plan; subscription carries a catalog plan version and no money.
  assert.match(
    commands,
    /CONSTRAINT saas_marketing_redeem_codes_kind_shape\s+CHECK \(\s+\(kind = 'balance'\s+AND amount_minor_units IS NOT NULL AND currency IS NOT NULL AND service_plan_version_id IS NULL\)\s+OR \(kind = 'subscription'\s+AND service_plan_version_id IS NOT NULL AND amount_minor_units IS NULL AND currency IS NULL\)\s+\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_marketing_redeem_codes_redeemed_shape\s+CHECK \(\(status = 'redeemed'\)\s+= \(redeemed_at IS NOT NULL AND redeemed_by_tenant_id IS NOT NULL AND redeemed_by_user_id IS NOT NULL\)\)/,
  );
  assert.match(commands, /CONSTRAINT saas_marketing_redeem_codes_hash_unique UNIQUE \(code_hash\)/);
  assert.match(
    commands,
    /FOREIGN KEY \(service_plan_version_id\) REFERENCES saas_service_plan_versions \(id\) ON DELETE RESTRICT/,
  );
  // The plaintext code is never a column.
  assert.doesNotMatch(commands, /\bcode text\b|\bplaintext\b|\bcode_value\b/i);
});

test('089 makes redemption exactly-once and append-only at the database level', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_redeem_redemptions \(/);
  assert.match(commands, /CONSTRAINT saas_marketing_redeem_redemptions_code_unique UNIQUE \(code_id\)/);
  assert.match(
    commands,
    /CREATE TRIGGER saas_marketing_redeem_redemptions_no_update\s+BEFORE UPDATE ON saas_marketing_redeem_redemptions/,
  );
  for (const table of ['saas_marketing_redeem_codes', 'saas_marketing_redeem_redemptions']) {
    assert.match(commands, new RegExp(`CREATE TRIGGER ${table}_no_delete\\s+BEFORE DELETE ON ${table}`));
  }
});

test('089 guards one-way status transitions with a pinned-search-path invoker guard', () => {
  assert.match(commands, /CREATE FUNCTION saas_marketing_redeem_code_guard\(\) RETURNS trigger/);
  assert.match(commands, /Marketing redeem code identity is immutable/);
  assert.match(commands, /Marketing redeem code status transitions are one-way/);
  assert.match(commands, /OLD\.status = 'active' AND NEW\.status IN \('redeemed', 'disabled'\)/);
  assert.match(
    commands,
    /ALTER FUNCTION saas_marketing_redeem_code_guard\(\)\s+SET search_path TO pg_catalog, model_router_saas, pg_temp/,
  );
  assert.match(
    commands,
    /CREATE TRIGGER saas_marketing_redeem_codes_guard\s+BEFORE UPDATE ON saas_marketing_redeem_codes/,
  );
});

test('089 grants no privileges and touches no existing object', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /ALTER TABLE(?! saas_marketing)/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.doesNotMatch(commands, /authz_version/i);
});
