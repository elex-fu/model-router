import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PLATFORM_SETTINGS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/110_platform_settings.js';

// Static candidate/source assertions only, mirroring the 106-109 migration
// test family. No mock database, SQL evaluator, or claim of managed
// PostgreSQL acceptance.
const migration = PLATFORM_SETTINGS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('110 registers directly after the applied 109 head as the F1 forward', () => {
  assert.equal(migration.version, 110);
  assert.equal(migration.name, 'platform_settings');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  const index = registered.indexOf(110);
  assert.ok(index > 0, '110 is registered');
  assert.equal(registered[index - 1], 109, '110 lands directly after the 109 head');
  assert.equal(registered.indexOf(110), registered.lastIndexOf(110));
  assert.equal(SAAS_MIGRATIONS[index], migration);
});

test('110 pins the settings row shape: keyed, versioned, CAS-ready', () => {
  assert.match(commands, /CREATE TABLE saas_platform_settings \(/);
  assert.match(commands, /key text PRIMARY KEY/);
  // Closed key namespace, bounded length (the registry's saas.* convention).
  assert.ok(commands.includes("key ~ '^saas\\.[a-z0-9_]+(\\.[a-z0-9_]+)+$' AND char_length(key) <= 128"));
  // The optimistic concurrency token (authz_version CAS pattern).
  assert.match(commands, /version bigint NOT NULL DEFAULT 1\s+CHECK \(version >= 1\)/);
  // Values are always jsonb objects; the audit actor is FK-bound.
  assert.match(commands, /value jsonb NOT NULL/);
  assert.match(commands, /updated_by_user_id uuid REFERENCES saas_users \(id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(commands, /DELETE FROM/i);
});

test('110 never allows a plaintext secret column or value', () => {
  // Secret-suffixed keys must carry the provider-credential KMS envelope
  // (the egress auth_sealed_envelope convention).
  assert.ok(commands.includes("key ~ '\\.(secret|password)$'"));
  assert.match(commands, /\(value ->> 'algorithm'\) = 'aes-256-gcm'/);
  for (const field of ['kmsKeyId', 'wrappedDek', 'nonce', 'ciphertext', 'authTag']) {
    assert.match(commands, new RegExp(`\\(value ->> '${field}'\\) IS NOT NULL`));
  }
  // Plain keys carry the {"value": ...} envelope only.
  assert.match(
    commands,
    /CONSTRAINT saas_platform_settings_plain_envelope CHECK \(\s+key ~ '\\\.\(secret\|password\)\$'\s+OR \(value \? 'value'\)\s+\)/,
  );
  // No secret-shaped property name may appear inside any stored value.
  for (const forbidden of ['secret', 'password', 'plaintext', 'credential']) {
    assert.match(commands, new RegExp(`NOT \\(value \\? '${forbidden}'\\)`));
  }
});

test('110 mirrors the 042 narrow immutable audit-details pattern', () => {
  assert.match(commands, /CREATE TABLE saas_platform_settings_audit_details \(/);
  assert.match(commands, /audit_event_id uuid PRIMARY KEY\s+REFERENCES saas_audit_events \(id\) ON DELETE RESTRICT/);
  assert.match(
    commands,
    /CONSTRAINT saas_platform_settings_audit_version_step CHECK \(\s+after_version >= 1\s+AND \(before_version IS NULL OR \(before_version >= 1 AND after_version = before_version \+ 1\)\)\s+\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_platform_settings_audit_summary_shape CHECK \(\s+jsonb_typeof\(change_summary\) = 'array'\s+AND jsonb_array_length\(change_summary\) BETWEEN 1 AND 64\s+\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_platform_settings_audit_key_created_idx\s+ON saas_platform_settings_audit_details \(settings_key, created_at DESC\);/,
  );
  assert.match(
    commands,
    /CREATE TRIGGER saas_platform_settings_audit_details_immutable\s+BEFORE UPDATE OR DELETE ON saas_platform_settings_audit_details\s+FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change\(\);/,
  );
});

test('110 changes no ACL, function, or other-table surface', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b/i);
  assert.doesNotMatch(commands, /SECURITY DEFINER/i);
  assert.doesNotMatch(commands, /\bDROP\b/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /INSERT INTO/i);
  assert.doesNotMatch(commands, /ALTER TABLE/i);
});
