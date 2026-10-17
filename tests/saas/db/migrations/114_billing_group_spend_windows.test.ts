import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { BILLING_GROUP_SPEND_WINDOWS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/114_billing_group_spend_windows.js';

// Static candidate/source assertions only.
const migration = BILLING_GROUP_SPEND_WINDOWS_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('114 registers as the applied head after the 113 group rate counters', () => {
  assert.equal(migration.version, 114);
  assert.equal(migration.name, 'billing_group_spend_windows');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.at(-1), 116);
  assert.equal(SAAS_MIGRATIONS[SAAS_MIGRATIONS.length - 3], migration);
});

test('114 creates the KEY-BUD-shaped group spend counters and reservations', () => {
  assert.match(commands, /CREATE TABLE saas_billing_group_spend_counters \(/);
  assert.match(commands, /window_kind text NOT NULL\s+CHECK \(window_kind IN \('daily', 'weekly', 'monthly'\)\)/);
  assert.match(commands, /window_start date NOT NULL/);
  assert.match(
    commands,
    /charge_outstanding_reserved bigint NOT NULL DEFAULT 0\s+CHECK \(charge_outstanding_reserved >= 0\)/,
  );
  assert.match(commands, /charge_settled bigint NOT NULL DEFAULT 0\s+CHECK \(charge_settled >= 0\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_billing_group_spend_counters_pk\s+PRIMARY KEY \(billing_group_id, window_kind, window_start\)/,
  );
  assert.match(commands, /CREATE TABLE saas_billing_group_spend_reservations \(/);
  assert.match(
    commands,
    /CONSTRAINT saas_billing_group_spend_reservations_pk\s+PRIMARY KEY \(tenant_id, request_id, window_kind\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_billing_group_spend_reservations_amount_shape CHECK \(\s*\(state = 'outstanding' AND settled_amount_minor_units IS NULL\)\s*OR \(state IN \('settled', 'released'\) AND settled_amount_minor_units IS NOT NULL\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_billing_group_spend_reservations_group_idx\s+ON saas_billing_group_spend_reservations \(billing_group_id, window_kind, window_start\)/,
  );
});

test('114 adds the rolling 5h/7d key caps and the settled-amount evidence column', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_api_key_budget_policies\s+ADD COLUMN charge_5h bigint CHECK \(charge_5h IS NULL OR charge_5h >= 0\),/,
  );
  assert.match(commands, /ADD COLUMN charge_7d bigint CHECK \(charge_7d IS NULL OR charge_7d >= 0\)/);
  assert.match(commands, /ALTER TABLE saas_api_key_budget_reservations\s+ADD COLUMN settled_charge_minor_units bigint/);
  assert.match(
    commands,
    /CREATE INDEX saas_api_key_budget_reservations_lineage_created_idx\s+ON saas_api_key_budget_reservations \(tenant_id, lineage_id, created_at\)/,
  );
});

test('114 grants no privileges and changes no trigger or lifecycle shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /DROP /i);
});
