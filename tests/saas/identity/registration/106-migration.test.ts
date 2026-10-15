import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { REGISTRATION_ADMISSION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/106_registration_admission.js';

// Static candidate/source assertions only, mirroring the 101-migration test
// family. No mock database, SQL evaluator, or claim of managed PostgreSQL
// acceptance.
const migration = REGISTRATION_ADMISSION_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('106 registers between 105 and the concurrent 107/108 tracks', () => {
  assert.equal(migration.version, 106);
  assert.equal(migration.name, 'registration_admission');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(106);
  assert.ok(index > 0, '106 is registered');
  assert.equal(registered[index - 1], 105, '106 lands directly after 105');
  assert.equal(registered[index + 1], 107, '106 lands directly before the R3 egress-proxy track');
  assert.equal(SAAS_MIGRATIONS[index], migration);
});

test('106 creates the hash-only verification-code ledger with purpose isolation', () => {
  assert.match(commands, /CREATE TABLE saas_email_verification_codes \(/);
  assert.match(commands, /email_canonical text NOT NULL/);
  assert.match(commands, /purpose text NOT NULL\s+CHECK \(purpose IN \('register', 'password_reset'\)\)/);
  // Only the SHA-256 hash is stored; plaintext codes never reach the table.
  assert.match(commands, /code_hash text NOT NULL\s+CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(commands, /attempts integer NOT NULL DEFAULT 0\s+CHECK \(attempts >= 0 AND attempts <= 5\)/);
  assert.match(commands, /expires_at timestamptz NOT NULL/);
  assert.match(commands, /consumed_at timestamptz/);
  assert.match(commands, /created_ip inet/);
  assert.match(commands, /created_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test('106 indexes live-code lookups and expiry sweeps', () => {
  assert.match(
    commands,
    /CREATE INDEX saas_email_verification_codes_active_idx\s+ON saas_email_verification_codes \(purpose, email_canonical, created_at DESC\)\s+WHERE consumed_at IS NULL/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_email_verification_codes_sweep_idx\s+ON saas_email_verification_codes \(expires_at\)/,
  );
});

test('106 changes no ACL, trigger, or existing table shape', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /SECURITY DEFINER/i);
  assert.doesNotMatch(commands, /\bDROP\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /ALTER TABLE/i);
  assert.doesNotMatch(commands, /INSERT INTO/i);
  assert.doesNotMatch(commands, /\bUPDATE\b/i);
  assert.doesNotMatch(commands, /\bDELETE\b/i);
});
