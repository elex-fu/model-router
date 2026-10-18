import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/113_billing_group_rate_counters.js';

// Static candidate/source assertions only.
const migration = BILLING_GROUP_RATE_COUNTERS_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('113 registers as the applied head after the 112 snapshot freeze', () => {
  assert.equal(migration.version, 113);
  assert.equal(migration.name, 'billing_group_rate_counters');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.at(-1), 132);
  assert.equal(registered.includes(migration.version), true);
});

test('113 creates the per-group per-second RPM counter store mirroring 098', () => {
  assert.match(commands, /CREATE TABLE saas_billing_group_rate_counters \(/);
  assert.match(commands, /group_id text NOT NULL/);
  assert.match(commands, /window_start timestamptz NOT NULL/);
  assert.match(commands, /requests integer NOT NULL DEFAULT 0\s+CHECK \(requests >= 0\)/);
  assert.match(commands, /CONSTRAINT saas_billing_group_rate_counters_pk\s+PRIMARY KEY \(group_id, window_start\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_billing_group_rate_counters_group_nonempty\s+CHECK \(btrim\(group_id\) <> '' AND group_id = btrim\(group_id\)\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_billing_group_rate_counters_window_idx\s+ON saas_billing_group_rate_counters \(group_id, window_start DESC\)/,
  );
  // Group-scope only: no tokens column (no group TPM exists) and no tenant
  // dimension (the group id is the global commercial identity).
  assert.doesNotMatch(commands, /tokens/);
  assert.doesNotMatch(commands, /tenant/);
});

test('113 grants no privileges and changes no trigger or lifecycle shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /DROP /i);
});
