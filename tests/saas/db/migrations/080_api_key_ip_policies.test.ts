import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { API_KEY_IP_POLICIES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/080_api_key_ip_policies.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = API_KEY_IP_POLICIES_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('080 registers after 063 with the documented 061/062 and 064-079 gaps', () => {
  assert.equal(migration.version, 80);
  assert.equal(migration.name, 'api_key_ip_policies');
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
  assert.equal(SAAS_MIGRATIONS[61], migration);
});

test('080 scopes the policy head to a key via a composite foreign key', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_api_keys\s+ADD CONSTRAINT saas_api_keys_scoped_id_unique UNIQUE \(tenant_id, project_id, id\)/,
  );
  assert.match(commands, /CREATE TABLE saas_api_key_ip_policies \(/);
  assert.match(commands, /CONSTRAINT saas_api_key_ip_policies_pk PRIMARY KEY \(tenant_id, project_id, key_id\)/);
  assert.match(
    commands,
    /FOREIGN KEY \(tenant_id, project_id, key_id\)\s+REFERENCES saas_api_keys \(tenant_id, project_id, id\)\s+ON DELETE RESTRICT/,
  );
});

test('080 pins the frozen mode/rule invariants and the bigint CAS head', () => {
  assert.match(commands, /version bigint NOT NULL CHECK \(version >= 1\)/);
  assert.match(commands, /mode IN \('disabled', 'allowlist', 'denyall'\)/);
  assert.match(commands, /jsonb_typeof\(rules\) = 'array' AND jsonb_array_length\(rules\) <= 256/);
  assert.match(
    commands,
    /\(mode IN \('disabled', 'denyall'\) AND rules = '\[\]'::jsonb\)\s+OR \(mode = 'allowlist' AND jsonb_array_length\(rules\) >= 1\)/,
  );
});

test('080 backfills every existing key with a disabled v1 head', () => {
  assert.match(
    commands,
    /INSERT INTO saas_api_key_ip_policies \(tenant_id, project_id, key_id, version, mode, rules\)\s+SELECT tenant_id, project_id, id, 1, 'disabled', '\[\]'::jsonb\s+FROM saas_api_keys/,
  );
});

test('080 never grants mutation paths beyond the forward schema change', () => {
  assert.doesNotMatch(commands, /\bGRANT\b/i);
  assert.doesNotMatch(commands, /\bDROP\s+(?:TABLE|COLUMN|TRIGGER|FUNCTION)\b/i);
  assert.doesNotMatch(commands, /CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRIGGER|RULE|FUNCTION)/i);
  assert.doesNotMatch(commands, /\bUPDATE\s+saas_/i);
});
