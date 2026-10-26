import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { TLS_FINGERPRINT_PROFILES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/116_tls_fingerprint_profiles.js';

// Static candidate/source assertions only; the real-database gate lives in
// the disposable-loopback integration harness.
const migration = TLS_FINGERPRINT_PROFILES_SAAS_MIGRATION;
const commands = migration.sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('116 registers after the 115 threshold-pause tail with the next free slot', () => {
  assert.equal(migration.version, 116);
  assert.equal(migration.name, 'tls_fingerprint_profiles');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  // Batch-3 (117 bedrock / 118 vertex / 119 grok / 120 cn) tails registered
  // after 116.
  assert.equal(registered.at(-1), 146);
  const index = registered.indexOf(116);
  assert.ok(index > 0, '116 is registered');
  assert.equal(SAAS_MIGRATIONS[index], migration);
  assert.deepEqual(
    registered.slice(index + 1),
    [
      117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139,
      140, 141, 142, 143, 144, 145, 146,
    ],
  );
});

test('116 creates the bounded ClientHello profile registry', () => {
  assert.match(commands, /CREATE TABLE saas_tls_fingerprint_profiles \(/);
  assert.match(commands, /id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY/);
  assert.match(commands, /CONSTRAINT saas_tls_fingerprint_profiles_name_unique UNIQUE \(name\)/);
  for (const column of [
    'cipher_suites',
    'curves',
    'point_formats',
    'signature_algorithms',
    'alpn_protocols',
    'supported_versions',
    'key_share_groups',
    'psk_modes',
    'extensions',
  ]) {
    assert.match(commands, new RegExp(`${column} jsonb NOT NULL DEFAULT '\\[\\]'::jsonb`));
  }
  assert.match(commands, /enable_grease boolean NOT NULL DEFAULT false/);
});

test('116 bounds every profile list column (jsonb array length + element range)', () => {
  for (const column of ['cipher_suites', 'curves', 'point_formats', 'signature_algorithms', 'extensions']) {
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT saas_tls_fingerprint_profiles_${column}_shape[\\s\\S]*?jsonb_typeof\\(${column}\\) = 'array'[\\s\\S]*?jsonb_array_length\\(${column}\\) <= 64`,
      ),
    );
  }
  // The per-element range filter must use the jsonpath forms valid on PG 18
  // (no .length() — that method does not exist and is a syntax error).
  assert.doesNotMatch(commands, /\.length\(\)/);
  assert.match(
    commands,
    /jsonb_path_query_array\(cipher_suites, '\$\[\*\] \? \(@ < 0 \|\| @ > 65535 \|\| @\.type\(\) != "number"\)'\) = '\[\]'::jsonb/,
  );
  // ALPN entries are strings with a bounded serialized size (the per-entry
  // 255-byte wire bound is reader + sidecar enforced — documented).
  assert.match(
    commands,
    /CONSTRAINT saas_tls_fingerprint_profiles_alpn_protocols_shape[\s\S]*?octet_length\(alpn_protocols::text\) <= 2048/,
  );
  // TLS versions are pinned to 0x0301..0x0304 (769..772).
  assert.match(
    commands,
    /jsonb_path_query_array\(supported_versions, '\$\[\*\] \? \(@ < 769 \|\| @ > 772 \|\| @\.type\(\) != "number"\)'\) = '\[\]'::jsonb/,
  );
});

test('116 adds the tri-state account binding column on both owner tables', () => {
  for (const table of ['saas_tenant_provider_accounts', 'saas_platform_provider_accounts']) {
    assert.match(commands, new RegExp(`ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN tls_fingerprint_profile_id integer`));
    assert.match(
      commands,
      new RegExp(
        `CONSTRAINT ${table}_tls_fingerprint_profile_id_shape[\\s\\S]*?CHECK \\(tls_fingerprint_profile_id IS NULL OR tls_fingerprint_profile_id >= -1\\)`,
      ),
    );
  }
  // No FK: 0/-1 are sentinel bindings; referential integrity for >0 is
  // application-level (the resolver fails OPEN to the default profile).
  assert.doesNotMatch(commands, /FOREIGN KEY.*tls_fingerprint_profile_id/);
  // The dormant 099 codex fingerprint columns stay untouched (orthogonal
  // application-layer mechanism — the documented adjudication).
  assert.doesNotMatch(commands, /codex_fingerprint_mode/);
  assert.doesNotMatch(commands, /codex_fingerprint_seed/);
});

test('116 grants no privileges and mounts no trigger', () => {
  assert.equal(commands.includes('GRANT '), false);
  assert.equal(commands.includes('CREATE TRIGGER '), false);
  assert.equal(commands.includes('CREATE FUNCTION '), false);
  // The single new table carries no tenant scoping: profiles are a shared
  // registry (mirrors saas_egress_proxies).
  assert.equal(commands.includes('tenant_id'), false);
});
