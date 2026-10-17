import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { COMPOSITE_MODEL_ROUTES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/121_composite_model_routes.js';

// Static candidate/source assertions only (the 120 pattern).
const migration = COMPOSITE_MODEL_ROUTES_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('121 registers directly after the 120 CN-providers tail', () => {
  assert.equal(migration.version, 121);
  assert.equal(migration.name, 'composite_model_routes');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(registered.includes(121));
  assert.ok(registered.indexOf(121) > registered.indexOf(120));
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(121)], migration);
});

test('121 marks billing groups composite and persists the evidence decision', () => {
  assert.match(commands, /ALTER TABLE saas_billing_groups\s+ADD COLUMN composite boolean NOT NULL DEFAULT false/);
  assert.match(commands, /ALTER TABLE saas_prepared_request_evidence\s+ADD COLUMN composite_route jsonb/);
  assert.match(
    commands,
    /CONSTRAINT saas_prepared_request_evidence_composite_route_shape\s+CHECK \(composite_route IS NULL OR jsonb_typeof\(composite_route\) = 'object'\)/,
  );
});

test('121 creates the bounded composite route registry', () => {
  assert.match(commands, /CREATE TABLE saas_composite_model_routes \(/);
  assert.match(commands, /id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(commands, /group_id text NOT NULL REFERENCES saas_billing_groups \(id\) ON DELETE CASCADE/);
  assert.match(commands, /public_model varchar\(200\) NOT NULL/);
  assert.match(commands, /match_type text NOT NULL DEFAULT 'exact' CHECK \(match_type IN \('exact', 'prefix'\)\)/);
  assert.match(commands, /target_platform varchar\(50\) NOT NULL/);
  assert.match(commands, /upstream_model varchar\(200\) NOT NULL DEFAULT ''/);
  assert.match(
    commands,
    /endpoint text NOT NULL DEFAULT 'any'\s+CHECK \(endpoint IN \('any', 'messages', 'responses', 'chat_completions', 'gemini'\)\)/,
  );
  assert.match(commands, /priority integer NOT NULL DEFAULT 100 CHECK \(priority >= 0 AND priority <= 100000\)/);
  assert.match(commands, /enabled boolean NOT NULL DEFAULT true/);
  assert.match(commands, /notes text NOT NULL DEFAULT ''/);
  // The five-level sort's shape uniqueness: one pattern per match type and
  // endpoint per group; the five-key sort arbitrates everything else.
  assert.match(
    commands,
    /CONSTRAINT saas_composite_model_routes_shape UNIQUE \(group_id, public_model, match_type, endpoint\)/,
  );
});

test('121 carries the documented covering indexes', () => {
  for (const statement of [
    'CREATE INDEX saas_composite_model_routes_group_idx ON saas_composite_model_routes \\(group_id\\)',
    'CREATE INDEX saas_composite_model_routes_group_enabled_idx\\s+ON saas_composite_model_routes \\(group_id, enabled\\)',
    'CREATE INDEX saas_composite_model_routes_group_endpoint_idx\\s+ON saas_composite_model_routes \\(group_id, endpoint\\)',
    'CREATE INDEX saas_composite_model_routes_group_platform_idx\\s+ON saas_composite_model_routes \\(group_id, target_platform\\)',
    'CREATE INDEX saas_composite_model_routes_priority_idx ON saas_composite_model_routes \\(priority\\)',
  ]) {
    assert.match(commands, new RegExp(statement));
  }
});

test('121 stays a plain data migration (no grants, drops, triggers or credential material)', () => {
  assert.doesNotMatch(commands, /GRANT|REVOKE/i);
  assert.doesNotMatch(commands, /DROP/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /ciphertext|wrapped_dek|private key/i);
  // The migration source is registered from the migrations directory.
  const source = readFileSync(
    new URL('../../../../src/saas/db/migrations/121_composite_model_routes.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('composite_route jsonb'), true);
});
