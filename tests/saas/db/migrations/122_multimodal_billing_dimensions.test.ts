import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { MULTIMODAL_BILLING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/122_multimodal_billing_dimensions.js';

/**
 * Batch 4 §4.1 (task #15) migration 122: static shape assertions. The live
 * PostgreSQL gate lives in the .postgres.integration twin.
 */
const migration = MULTIMODAL_BILLING_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('122 registers after the batch-3/4.4 tails in forward order', () => {
  assert.equal(migration.version, 122);
  assert.equal(migration.name, 'multimodal_billing_dimensions');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  // 121 is the composite workstream's number; 122 follows it.
  assert.equal(registered.includes(121), true);
  assert.equal(registered.indexOf(122), registered.lastIndexOf(122));
  assert.equal(registered.indexOf(122) > registered.indexOf(121), true);
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(122)], migration);
});

test('122 extends both price-version tables with the per-unit family and pair/tier/multiplier CHECKs', () => {
  for (const table of ['saas_customer_price_versions', 'saas_supplier_cost_versions']) {
    assert.match(
      commands,
      new RegExp(
        `ALTER TABLE ${table}\\s+ADD COLUMN per_unit_rate_numerator_minor_units bigint,\\s+` +
          'ADD COLUMN per_unit_rate_denominator_units bigint,\\s+' +
          'ADD COLUMN per_unit_tier_rates jsonb,\\s+' +
          'ADD COLUMN token_multipliers jsonb;',
      ),
    );
    // The per-unit pair CHECK is isomorphic to the cache_read pair CHECK.
    assert.match(
      commands,
      new RegExp(
        `ADD CONSTRAINT ${table}_per_unit_rate_pair CHECK \\(\\s+` +
          '\\(per_unit_rate_numerator_minor_units IS NULL\\) = \\(per_unit_rate_denominator_units IS NULL\\)',
      ),
    );
    // The jsonb shape CHECKs delegate to the IMMUTABLE validators.
    assert.match(
      commands,
      new RegExp(
        `${table}_per_unit_tier_rates_shape CHECK \\(\\s+saas_pricing_valid_per_unit_tier_rates\\(per_unit_tier_rates\\)`,
      ),
    );
    assert.match(
      commands,
      new RegExp(
        `${table}_token_multipliers_shape CHECK \\(\\s+saas_pricing_valid_token_multipliers\\(token_multipliers\\)`,
      ),
    );
  }
  // The tier registry is enforced in SQL (closed set).
  assert.match(commands, /tier_key NOT IN \('1k', '2k', '4k', '480p', '720p', '1080p', 'tts', 'stt', 'realtime'\)/);
  // The multiplier validator accepts only the known service-tier ladder.
  assert.match(commands, /tier_key NOT IN \('flex', 'default', 'standard', 'auto', 'scale', 'priority', 'fast'\)/);
});

test('122 adds the customer-snapshot hold witness, usage-event metering, and evidence envelope columns', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_request_customer_price_snapshots\s+ADD COLUMN hold_input_per_unit_units bigint NOT NULL DEFAULT 0\s+CHECK \(hold_input_per_unit_units >= 0\),\s+ADD COLUMN hold_input_size_tier text\s+CHECK \(hold_input_size_tier IS NULL OR hold_input_size_tier IN \('1k', '2k', '4k', '480p', '720p', '1080p', 'tts', 'stt', 'realtime'\)\);/,
  );
  assert.match(
    commands,
    /ALTER TABLE saas_usage_events\s+ADD COLUMN billing_mode text NOT NULL DEFAULT 'token'\s+CHECK \(billing_mode IN \('token', 'per_request', 'image', 'video', 'audio'\)\),\s+ADD COLUMN units bigint CHECK \(units IS NULL OR units >= 0\),\s+ADD COLUMN size_tier text/,
  );
  assert.match(
    commands,
    /ALTER TABLE saas_prepared_request_evidence\s+ADD COLUMN usage_per_unit_units_upper_bound bigint NOT NULL DEFAULT 0\s+CHECK \(usage_per_unit_units_upper_bound >= 0\),\s+ADD COLUMN usage_size_tier text/,
  );
  // The supplier attempt snapshot table is deliberately NOT extended: it
  // copies price identity only and settles against the immutable cost
  // version row (documented in the migration header).
  assert.doesNotMatch(commands, /ALTER TABLE saas_attempt_supplier_cost_snapshots/);
});

test('122 recreates the 024 immutability function with the new evidence columns in both ROW shapes', () => {
  // CREATE OR REPLACE keeps the trigger bound to the same function OID; the
  // OLD/NEW column enumeration gains exactly the two new columns.
  assert.match(commands, /CREATE OR REPLACE FUNCTION saas_prepared_request_evidence_immutable\(\) RETURNS trigger/);
  const occurrences = commands.match(/OLD\.usage_per_unit_units_upper_bound, OLD\.usage_size_tier/g);
  assert.equal(occurrences?.length, 1);
  const newOccurrences = commands.match(/NEW\.usage_per_unit_units_upper_bound, NEW\.usage_size_tier/g);
  assert.equal(newOccurrences?.length, 1);
  // The immutability and status-transition semantics are preserved verbatim.
  assert.match(commands, /RAISE EXCEPTION 'Prepared-request evidence facts are immutable'/);
  assert.match(commands, /RAISE EXCEPTION 'Prepared-request evidence cannot be reclaimed'/);
});

test('122 stays additive and defaulted (the #14/#15 anti-drift contract)', () => {
  // Every new column is either nullable or carries a neutral DEFAULT, so a
  // pre-122 row reads back with its exact pre-4.1 semantics.
  for (const column of [
    'per_unit_rate_numerator_minor_units',
    'per_unit_rate_denominator_units',
    'per_unit_tier_rates',
    'token_multipliers',
    'hold_input_size_tier',
    'units',
    'size_tier',
    'usage_size_tier',
  ]) {
    assert.doesNotMatch(commands, new RegExp(`ADD COLUMN ${column} [^,;]*NOT NULL(?! DEFAULT)`));
  }
  // The two NOT NULL columns both carry the neutral default.
  assert.match(commands, /ADD COLUMN hold_input_per_unit_units bigint NOT NULL DEFAULT 0/);
  assert.match(commands, /ADD COLUMN billing_mode text NOT NULL DEFAULT 'token'/);
  assert.match(commands, /ADD COLUMN usage_per_unit_units_upper_bound bigint NOT NULL DEFAULT 0/);
  // No data rewriting, no drops, no trigger removals besides the verbatim
  // function replacement.
  assert.doesNotMatch(commands, /\bDROP COLUMN\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE FROM\b/);
});
