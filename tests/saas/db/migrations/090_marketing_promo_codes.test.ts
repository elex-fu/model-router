import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { MARKETING_PROMO_CODES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/090_marketing_promo_codes.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = MARKETING_PROMO_CODES_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('090 registers after 089 with the documented gaps', () => {
  assert.equal(migration.version, 90);
  assert.equal(migration.name, 'marketing_promo_codes');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false);
  }
  assert.equal(registered.includes(86), false);
  assert.equal(SAAS_MIGRATIONS[70], migration);
});

test('090 keeps promo codes public-by-design with the kind exclusivity CHECKs', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_promo_codes \(/);
  assert.match(commands, /code text NOT NULL/);
  assert.match(commands, /CHECK \(code ~ '\^\[A-Z0-9-\]\{4,32\}\$'\)/);
  assert.match(commands, /CONSTRAINT saas_marketing_promo_codes_code_unique UNIQUE \(code\)/);
  assert.match(commands, /CHECK \(kind IN \('percent_off', 'amount_off'\)\)/);
  assert.match(commands, /CONSTRAINT saas_marketing_promo_codes_kind_shape\s+CHECK/);
  assert.match(commands, /percent_bp > 0 AND percent_bp < 10000/);
  // Promo codes are campaign tokens, not bearer secrets: no hash column.
  assert.doesNotMatch(commands, /code_hash/);
});

test('090 freezes the original order amount as insert-only for replay comparison', () => {
  assert.match(commands, /ALTER TABLE saas_payment_orders\s+ADD COLUMN original_amount_minor_units text/);
  assert.match(
    commands,
    /CHECK \(original_amount_minor_units IS NULL OR original_amount_minor_units ~ '\^\[0-9\]\{1,20\}\$'\)/,
  );
  assert.match(commands, /CREATE FUNCTION saas_marketing_promo_orders_guard\(\) RETURNS trigger/);
  assert.match(commands, /NEW\.original_amount_minor_units IS DISTINCT FROM OLD\.original_amount_minor_units/);
  assert.match(
    commands,
    /CREATE TRIGGER saas_payment_orders_original_amount_guard\s+BEFORE UPDATE ON saas_payment_orders/,
  );
});

test('090 makes usages append-only with the one-order-one-promo and per-tenant-once backstops', () => {
  assert.match(commands, /CREATE TABLE saas_marketing_promo_usages \(/);
  assert.match(commands, /CONSTRAINT saas_marketing_promo_usages_order_unique UNIQUE \(order_id\)/);
  assert.match(
    commands,
    /CREATE UNIQUE INDEX saas_marketing_promo_usages_tenant_once\s+ON saas_marketing_promo_usages \(code_id, tenant_id\)\s+WHERE per_tenant_once/,
  );
  assert.match(
    commands,
    /CREATE TRIGGER saas_marketing_promo_usages_no_update\s+BEFORE UPDATE ON saas_marketing_promo_usages/,
  );
  assert.doesNotMatch(commands, /\(SELECT per_tenant_once/, 'index predicates must not contain subqueries');
});

test('090 grants no privileges and keeps one-way status with pinned-search-path guards', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /DROP /i);
  assert.match(commands, /OLD\.status = 'active' AND NEW\.status = 'disabled'/);
  assert.match(commands, /SET search_path TO pg_catalog, model_router_saas, pg_temp/);
  for (const table of ['saas_marketing_promo_codes', 'saas_marketing_promo_usages']) {
    assert.match(commands, new RegExp(`CREATE TRIGGER ${table}_no_delete\\s+BEFORE DELETE ON ${table}`));
  }
});
