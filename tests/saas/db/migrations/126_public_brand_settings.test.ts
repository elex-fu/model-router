import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PUBLIC_BRAND_SETTINGS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/126_public_brand_settings.js';
import {
  SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
} from '../../../../src/saas/db/runtime-privileges.js';

/**
 * Batch 5 §5.2 OEM white-label (task #20): migration 126 static contract —
 * the single-row public brand snapshot table with its grants mirrored in the
 * runtime-privilege manifests and the roles template (the 121 pattern).
 */

const migration = PUBLIC_BRAND_SETTINGS_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('126 registers directly after the 125 risk-control tail', () => {
  assert.equal(migration.version, 126);
  assert.equal(migration.name, 'public_brand_settings');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(registered.includes(126));
  assert.ok(registered.indexOf(126) > registered.indexOf(125));
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(126)], migration);
});

test('126 creates the bounded single-row snapshot table and seeds the empty snapshot', () => {
  assert.match(commands, /CREATE TABLE saas_public_brand_settings \(/);
  assert.match(commands, /singleton boolean PRIMARY KEY/);
  assert.match(commands, /snapshot jsonb NOT NULL/);
  assert.match(commands, /version bigint NOT NULL DEFAULT 1\s+CHECK \(version >= 1\)/);
  assert.match(commands, /materialized_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(commands, /CONSTRAINT saas_public_brand_settings_singleton_only CHECK \(singleton = true\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_public_brand_settings_snapshot_object CHECK \(\s*jsonb_typeof\(snapshot\) = 'object'\s*\)/,
  );
  assert.match(
    commands,
    /CONSTRAINT saas_public_brand_settings_snapshot_bounded CHECK \(\s*pg_column_size\(snapshot\) <= 1048576\s*\)/,
  );
  // The deterministic seeded row: readers always find the singleton.
  assert.match(
    commands,
    /INSERT INTO saas_public_brand_settings \(singleton, snapshot\)\s*VALUES \(true, '\{\}'::jsonb\)/,
  );
});

test('126 stays a plain data migration (no grants, drops, triggers or credential material)', () => {
  assert.doesNotMatch(commands, /GRANT|REVOKE/i);
  assert.doesNotMatch(commands, /DROP/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /ciphertext|wrapped_dek|private key/i);
  const source = readFileSync(
    new URL('../../../../src/saas/db/migrations/126_public_brand_settings.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('saas_public_brand_settings'), true);
});

test('the authorization mirror: control-plane materialization grants, gateway read-only, no DELETE', () => {
  // Control plane: SELECT/INSERT/UPDATE on every column, singleton immutable.
  assert.deepEqual(
    SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS.filter(([table]) => table === 'saas_public_brand_settings'),
    [
      ['saas_public_brand_settings', 'singleton', 'SELECT'],
      ['saas_public_brand_settings', 'snapshot', 'SELECT'],
      ['saas_public_brand_settings', 'version', 'SELECT'],
      ['saas_public_brand_settings', 'materialized_at', 'SELECT'],
      ['saas_public_brand_settings', 'singleton', 'INSERT'],
      ['saas_public_brand_settings', 'snapshot', 'INSERT'],
      ['saas_public_brand_settings', 'version', 'INSERT'],
      ['saas_public_brand_settings', 'materialized_at', 'INSERT'],
      ['saas_public_brand_settings', 'snapshot', 'UPDATE'],
      ['saas_public_brand_settings', 'version', 'UPDATE'],
      ['saas_public_brand_settings', 'materialized_at', 'UPDATE'],
    ],
  );
  // Gateway: the dynamic read-table allowlist only (SELECT, never a write).
  assert.ok(SAAS_GATEWAY_RUNTIME_READ_TABLES.includes('saas_public_brand_settings'));
  // The roles template mirrors both sides (the auto-derived mirror test
  // enforces the full equality; this pins the brand rows explicitly).
  const roles = readFileSync(new URL('../../../../deploy/managed-saas-postgres-roles.sql', import.meta.url), 'utf8');
  assert.match(roles, /\('saas_public_brand_settings', 'SELECT', 'singleton snapshot version materialized_at'\)/);
  assert.match(roles, /\('saas_public_brand_settings', 'UPDATE', 'snapshot version materialized_at'\)/);
  assert.match(roles, /\('saas_public_brand_settings'\)/);
  assert.doesNotMatch(roles, /\('saas_public_brand_settings', 'DELETE'\)/);
});
