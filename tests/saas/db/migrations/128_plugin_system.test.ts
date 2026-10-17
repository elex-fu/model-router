import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PLUGIN_SYSTEM_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/128_plugin_system.js';

// Static candidate/source assertions only (the 121 pattern).
const migration = PLUGIN_SYSTEM_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('128 registers directly after the 126 brand-settings tail', () => {
  assert.equal(migration.version, 128);
  assert.equal(migration.name, 'plugin_system');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.ok(registered.includes(128));
  assert.ok(registered.indexOf(128) > registered.indexOf(126));
  assert.equal(SAAS_MIGRATIONS[registered.indexOf(128)], migration);
});

test('128 creates the bounded plugin installation registry', () => {
  assert.match(commands, /CREATE TABLE saas_plugin_installations \(/);
  assert.match(commands, /id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
  assert.match(commands, /plugin_key varchar\(160\) NOT NULL UNIQUE/);
  assert.match(commands, /manifest jsonb NOT NULL/);
  assert.match(commands, /manifest_sha256 varchar\(64\) NOT NULL/);
  assert.match(commands, /entrypoint_path text NOT NULL/);
  assert.match(commands, /binary_sha256 varchar\(64\) NOT NULL/);
  assert.match(commands, /signature_status text NOT NULL CHECK \(signature_status IN \('trusted', 'unsigned'\)\)/);
  assert.match(
    commands,
    /state text NOT NULL DEFAULT 'disabled'\s+CHECK \(state IN \('disabled', 'starting', 'enabled', 'error', 'incompatible'\)\)/,
  );
  assert.match(commands, /config_json jsonb/);
  assert.match(commands, /artifact_data bytea NOT NULL/);
  assert.match(commands, /artifact_sha256 varchar\(64\) NOT NULL/);
  // installed_by references the platform admin user (migration 001); an
  // anonymized admin must not pin installation rows.
  assert.match(commands, /installed_by uuid REFERENCES saas_users \(id\) ON DELETE SET NULL/);
  // Shape CHECKs: nonempty/trim identifiers, hex-64 digests, bounded text.
  for (const constraint of [
    /saas_plugin_installations_plugin_key_shape CHECK \(\s*char_length\(plugin_key\) BETWEEN 1 AND 160 AND plugin_key = btrim\(plugin_key\)/,
    /saas_plugin_installations_name_shape CHECK \(\s*char_length\(name\) BETWEEN 1 AND 160 AND name = btrim\(name\)/,
    /saas_plugin_installations_version_shape CHECK \(\s*char_length\(version\) BETWEEN 1 AND 64 AND version = btrim\(version\)/,
    /saas_plugin_installations_description_bounded CHECK \(char_length\(description\) <= 2000\)/,
    /saas_plugin_installations_manifest_object CHECK \(jsonb_typeof\(manifest\) = 'object'\)/,
    /saas_plugin_installations_manifest_sha256_hex CHECK \(manifest_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    /saas_plugin_installations_entrypoint_shape CHECK \(\s*char_length\(entrypoint_path\) BETWEEN 1 AND 1024 AND entrypoint_path = btrim\(entrypoint_path\)/,
    /saas_plugin_installations_binary_sha256_hex CHECK \(binary_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/,
    /saas_plugin_installations_config_object CHECK \(\s*config_json IS NULL OR jsonb_typeof\(config_json\) = 'object'\s*\)/,
    /saas_plugin_installations_last_error_bounded CHECK \(char_length\(last_error\) <= 4000\)/,
    /saas_plugin_installations_artifact_sha256_hex CHECK \(artifact_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/,
  ]) {
    assert.match(commands, constraint);
  }
});

test('128 creates the capability-scope binding table with the one-enabled guarantee', () => {
  assert.match(commands, /CREATE TABLE saas_plugin_bindings \(/);
  assert.match(
    commands,
    /installation_id bigint NOT NULL REFERENCES saas_plugin_installations \(id\) ON DELETE CASCADE/,
  );
  assert.match(commands, /capability varchar\(100\) NOT NULL/);
  assert.match(commands, /platform varchar\(50\) NOT NULL/);
  assert.match(commands, /account_type varchar\(50\) NOT NULL/);
  assert.match(commands, /enabled boolean NOT NULL DEFAULT false/);
  assert.match(commands, /rollout_percent integer NOT NULL DEFAULT 100 CHECK \(rollout_percent BETWEEN 0 AND 100\)/);
  assert.match(
    commands,
    /CONSTRAINT saas_plugin_bindings_scope_unique UNIQUE \(installation_id, capability, platform, account_type\)/,
  );
  for (const column of ['capability', 'platform', 'account_type']) {
    assert.match(
      commands,
      new RegExp(
        `saas_plugin_bindings_${column}_shape CHECK \\(\\s*char_length\\(${column}\\) BETWEEN 1 AND (?:100|50) AND ${column} = btrim\\(${column}\\)`,
      ),
    );
  }
  // The DB-level one-enabled-plugin-per-capability-scope guarantee.
  assert.match(
    commands,
    /CREATE UNIQUE INDEX saas_plugin_bindings_one_enabled_scope\s+ON saas_plugin_bindings \(capability, platform, account_type\) WHERE enabled/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_plugin_bindings_installation_idx ON saas_plugin_bindings \(installation_id\)/,
  );
  assert.match(
    commands,
    /CREATE INDEX saas_plugin_bindings_scope_idx\s+ON saas_plugin_bindings \(platform, account_type, capability\) WHERE enabled/,
  );
});

test('128 creates the host-service KV table with the charset rule', () => {
  assert.match(commands, /CREATE TABLE saas_plugin_kv \(/);
  assert.match(commands, /plugin_key varchar\(160\) NOT NULL/);
  assert.match(commands, /namespace varchar\(128\) NOT NULL/);
  assert.match(commands, /key varchar\(256\) NOT NULL/);
  assert.match(commands, /value text NOT NULL/);
  assert.match(commands, /expires_at timestamptz/);
  assert.match(commands, /PRIMARY KEY \(plugin_key, namespace, key\)/);
  assert.match(commands, /saas_plugin_kv_namespace_charset CHECK \(namespace ~ '\^\[A-Za-z0-9._-\]\+\$'\)/);
  assert.match(commands, /saas_plugin_kv_key_charset CHECK \(key ~ '\^\[A-Za-z0-9._-\]\+\$'\)/);
});

test('128 stays a plain data migration (no grants, drops, triggers or credential material)', () => {
  assert.doesNotMatch(commands, /GRANT|REVOKE/i);
  assert.doesNotMatch(commands, /DROP/i);
  assert.doesNotMatch(commands, /CREATE (OR REPLACE )?FUNCTION/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER/i);
  assert.doesNotMatch(commands, /authz_version/i);
  assert.doesNotMatch(commands, /ciphertext|wrapped_dek|private key/i);
  // The migration source is registered from the migrations directory.
  const source = readFileSync(
    new URL('../../../../src/saas/db/migrations/128_plugin_system.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('saas_plugin_kv'), true);
});
