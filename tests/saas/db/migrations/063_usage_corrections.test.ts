import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { USAGE_CORRECTIONS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/063_usage_corrections.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = USAGE_CORRECTIONS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('063 registers after the frozen 001-060 prefix with 061/062 skipped by contract', () => {
  assert.equal(migration.version, 63);
  assert.equal(migration.name, 'usage_corrections');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 60).map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  assert.equal(SAAS_MIGRATIONS[60], migration);
});

test('063 extends the ledger source type without weakening the historical branches', () => {
  assert.match(commands, /DROP CONSTRAINT saas_ledger_transactions_source_type_check/);
  assert.match(
    commands,
    /CHECK \(source_type IN \('wallet_funding', 'billing_settlement', 'wallet_refund', 'usage_correction'\)\)/,
  );
  // Every historical branch stays byte-identical in the re-added constraint.
  assert.match(commands, /source_type = 'wallet_funding'\s+AND amount_minor_units > 0/);
  assert.match(commands, /source_type = 'billing_settlement'\s+AND btrim\(COALESCE\(price_snapshot_ref, ''\)\) <> ''/);
  assert.match(commands, /source_type = 'wallet_refund'\s+AND amount_minor_units > 0/);
  // The correction branch pins its own field contract.
  const correctionBranch =
    /source_type = 'usage_correction'\s+AND amount_minor_units > 0\s+AND btrim\(COALESCE\(source_order_ref, ''\)\) <> ''\s+AND btrim\(COALESCE\(metadata_ref, ''\)\) <> ''\s+AND price_snapshot_ref IS NULL\s+AND usage_evidence_ref IS NULL/;
  assert.match(commands, correctionBranch);
});

test('063 creates the append-only correction event table with the frozen contract shape', () => {
  assert.match(commands, /CREATE TABLE saas_usage_correction_events \(/);
  for (const column of [
    'id uuid PRIMARY KEY',
    'tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT',
    'corrected_usage_event_id uuid NOT NULL REFERENCES saas_usage_events (id) ON DELETE RESTRICT',
    'corrected_settlement_id uuid REFERENCES saas_usage_settlements (id) ON DELETE RESTRICT',
    'correction_usage jsonb NOT NULL',
    'amount_delta_minor_units bigint NOT NULL',
    'currency text NOT NULL',
    'correction_digest text NOT NULL UNIQUE',
  ]) {
    assert.ok(commands.includes(column), column);
  }
  assert.match(
    commands,
    /reason_code IN \(\s*'provider_reported_correction',\s*'billing_dispute',\s*'metering_fault',\s*'operator_adjustment'\s*\)/,
  );
  assert.match(commands, /correction_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(commands, /evidence_ref IS NULL OR evidence_ref ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test('063 never grants mutation paths on the correction table', () => {
  const tableRegion = commands.slice(commands.indexOf('CREATE TABLE saas_usage_correction_events'));
  assert.doesNotMatch(tableRegion, /UPDATE|DELETE FROM|TRUNCATE/i);
  // No trigger or rule rewrites corrections after insert.
  assert.doesNotMatch(tableRegion, /CREATE TRIGGER|CREATE RULE/i);
});
