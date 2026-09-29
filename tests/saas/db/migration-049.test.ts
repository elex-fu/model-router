import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/049_unknown_outcome_reconciliation.js';

const migration = UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION;
const EXPECTED_CHECKSUM = '0e41fba20a5bda5ceb3247054cdbc9f28c145141ebd81322240625f008082508';

test('migration 049 is registered with its stable identity and SQL checksum', () => {
  assert.equal(migration.version, 49);
  assert.equal(migration.name, 'unknown_outcome_reconciliation_cases_and_observations');
  assert.equal(SAAS_MIGRATIONS[48], migration);
  assert.equal(
    createHash('sha256').update(migration.name).update('\0').update(migration.sql).digest('hex'),
    EXPECTED_CHECKSUM,
  );
});

test('migration 049 defines the durable scanner and operator evidence boundary', () => {
  assert.match(migration.sql, /CREATE TABLE saas_unknown_outcome_reconciliation_cases/);
  assert.match(migration.sql, /CREATE TABLE saas_unknown_outcome_reconciliation_observations/);
  assert.match(migration.sql, /saas_unknown_outcome_observations_immutable/);
  assert.match(migration.sql, /saas_guard_unknown_outcome_case_update/);
  assert.match(migration.sql, /observation_kind IN \(/);
  assert.match(migration.sql, /operator_resolution/);
  assert.match(migration.sql, /provider_evidence/);
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|TRIGGER|FUNCTION)\b/i);
  assert.doesNotMatch(migration.sql, /\bGRANT\s+/i);
});
