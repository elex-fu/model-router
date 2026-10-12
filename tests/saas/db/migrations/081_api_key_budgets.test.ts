import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { API_KEY_BUDGETS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/081_api_key_budgets.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = API_KEY_BUDGETS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('081 registers after 080 with the documented 061/062 and 064-079 gaps', () => {
  assert.equal(migration.version, 81);
  assert.equal(migration.name, 'api_key_budgets');
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
  assert.equal(SAAS_MIGRATIONS[62], migration);
});

test('081 scopes policy heads and lineage counters to keys via composite foreign keys', () => {
  assert.match(commands, /CREATE TABLE saas_api_key_budget_policies \(/);
  assert.match(commands, /CONSTRAINT saas_api_key_budget_policies_pk PRIMARY KEY \(tenant_id, project_id, key_id\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_api_key_budget_policies_key_fk\s+FOREIGN KEY \(tenant_id, project_id, key_id\)\s+REFERENCES saas_api_keys \(tenant_id, project_id, id\)\s+ON DELETE RESTRICT/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_api_key_budget_policies_lineage_fk\s+FOREIGN KEY \(tenant_id, project_id, lineage_id\)\s+REFERENCES saas_api_keys \(tenant_id, project_id, id\)\s+ON DELETE RESTRICT/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_api_key_budget_counters_pk\s+PRIMARY KEY \(tenant_id, lineage_id, window_kind, day\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_api_key_budget_reservations_request_fk\s+FOREIGN KEY \(request_id\) REFERENCES saas_requests \(id\) ON DELETE RESTRICT/,
  );
});

test('081 pins the frozen cap/counter invariants and the UTC day window shape', () => {
  assert.match(commands, /version bigint NOT NULL CHECK \(version >= 1\)/);
  assert.match(commands, /token_daily bigint CHECK \(token_daily IS NULL OR token_daily >= 0\)/);
  assert.match(commands, /charge_lifetime bigint CHECK \(charge_lifetime IS NULL OR charge_lifetime >= 0\)/);
  assert.match(commands, /window_kind text NOT NULL CHECK \(window_kind IN \('daily', 'lifetime'\)\)/);
  assert.match(commands, /\(window_kind = 'daily'\) OR \(window_kind = 'lifetime' AND day = DATE '0001-01-01'\)/);
  assert.match(
    commands,
    /token_outstanding_reserved bigint NOT NULL DEFAULT 0 CHECK \(token_outstanding_reserved >= 0\)/,
  );
  assert.match(
    commands,
    /\(charge_minor_units = 0 AND charge_currency IS NULL\)\s+OR \(charge_minor_units > 0 AND btrim\(charge_currency\) <> ''\)/,
  );
});

test('081 retains reservations as guarded evidence with one-way state transitions', () => {
  assert.match(
    commands,
    /state text NOT NULL DEFAULT 'outstanding'\s+CHECK \(state IN \('outstanding', 'settled', 'released'\)\)/,
  );
  assert.match(commands, /CREATE FUNCTION saas_api_key_budget_reservation_guard\(\) RETURNS trigger/);
  assert.match(commands, /RAISE EXCEPTION 'Key budget reservation facts are immutable' USING ERRCODE = '55000'/);
  assert.match(commands, /NOT \(OLD\.state = 'outstanding' AND NEW\.state IN \('settled', 'released'\)\)/);
  assert.match(
    commands,
    /CREATE TRIGGER saas_api_key_budget_reservations_guard\s+BEFORE UPDATE ON saas_api_key_budget_reservations/,
  );
  assert.match(
    commands,
    /CREATE TRIGGER saas_api_key_budget_reservations_no_delete\s+BEFORE DELETE ON saas_api_key_budget_reservations/,
  );
});

test('081 backfills every existing key with an unlimited self-lineage v1 head', () => {
  assert.match(
    commands,
    /INSERT INTO saas_api_key_budget_policies\s+\(tenant_id, project_id, key_id, lineage_id, version\)\s+SELECT tenant_id, project_id, id, id, 1\s+FROM saas_api_keys/,
  );
});

test('081 never grants mutation paths beyond the forward schema change', () => {
  assert.doesNotMatch(commands, /\bGRANT\b/i);
  assert.doesNotMatch(commands, /\bDROP\s+(?:TABLE|COLUMN|TRIGGER|FUNCTION)\b/i);
  assert.doesNotMatch(commands, /CREATE\s+OR\s+REPLACE/i);
  assert.doesNotMatch(commands, /\bUPDATE\s+saas_/i);
});
