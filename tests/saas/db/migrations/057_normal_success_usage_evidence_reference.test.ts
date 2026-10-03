import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { GATEWAY_METERING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/010_gateway_metering.js';
import {
  NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_CHECK_SQL,
  NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION,
  USAGE_SETTLEMENT_IMMUTABLE_EXPECTED_SOURCE, USAGE_SETTLEMENT_SCOPE_EXPECTED_SOURCE,
} from '../../../../src/saas/db/migrations/057_normal_success_usage_evidence_reference.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// provider evidence fabrication, or claim of managed PostgreSQL acceptance.
const migration = NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('057 registers only after the exact historical 001-056 prefix', () => {
  assert.equal(migration.version, 57);
  assert.equal(migration.name, 'normal_success_usage_evidence_reference');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 56).map(({ version }) => version), Array.from({ length: 56 }, (_, i) => i + 1));
  assert.equal(SAAS_MIGRATIONS[56], migration);
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 58).map(({ version }) => version), Array.from({ length: 58 }, (_, i) => i + 1));
});

test('057 keeps the actual historical 010/054/055/056 source bytes frozen', () => {
  for (const [file, hash] of [
    ['010_gateway_metering.ts', '7e69a23e5279a96d5538b616a60c674c0da8938a27ff8cabff9daff84b9ebfcf'],
    ['054_trigger_only_trusted_execution.ts', '6375222a33353e1dafed61826e062024d8291e911ffb7cd173d1e3e0fa98f7a3'],
    ['055_prepared_evidence_optional_validity_scalars.ts', 'ed8ef3bfe1a3ddaa6d39111486429b3b86b193aee8dda01fe58e62634d8ba660'],
    ['056_restricted_role_check_and_platform_auth_execution.ts', '13e1e5330447ecfb78e137b7054d0ec384254e865e91e7e98004222fe450ac13'],
  ] as const) {
    const source = readFileSync(new URL(`../../../../src/saas/db/migrations/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, file);
  }
});

test('057 appends exactly one nullable no-default legacy column and validates the finite CHECK atomically', () => {
  assert.equal(NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_CHECK_SQL, `normal_success_evidence_ref IS NULL
  OR (kind = 'usage_recorded'
    AND pg_catalog.octet_length(normal_success_evidence_ref) = 64
    AND normal_success_evidence_ref COLLATE pg_catalog."C" ~ '^[0-9a-f]{64}$')`);
  assert.match(commands, /LOCK TABLE model_router_saas\.saas_usage_settlements IN ACCESS EXCLUSIVE MODE/);
  assert.equal((commands.match(/ALTER TABLE /g) ?? []).length, 1);
  assert.equal((commands.match(/ADD COLUMN /g) ?? []).length, 1);
  assert.equal((commands.match(/ADD CONSTRAINT /g) ?? []).length, 1);
  assert.match(commands, /ADD COLUMN normal_success_evidence_ref text,\s+ADD CONSTRAINT saas_usage_settlements_normal_success_evidence_ref_check/);
  assert.match(commands, /AND NOT attnotnull AND NOT atthasdef AND NOT atthasmissing AND attmissingval IS NULL/);
  assert.match(commands, /AND contype = 'c' AND convalidated/);
  assert.match(commands, /conkey @> ARRAY\[kind_column, reference_column\]::smallint\[\]/);
  assert.match(commands, /FROM model_router_saas\.saas_usage_settlements WHERE normal_success_evidence_ref IS NOT NULL/);
  assert.doesNotMatch(commands, /\b(?:NOT VALID|VALIDATE CONSTRAINT|SET NOT NULL|SET DEFAULT|DROP)\b/i);
  // Reject silent DDL adoption, not fail-closed PL/pgSQL catalog preconditions.
  assert.doesNotMatch(commands, /\bADD\s+(?:(?:COLUMN|CONSTRAINT)\s+)?IF\s+NOT\s+EXISTS\b/i);
  assert.doesNotMatch(NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_CHECK_SQL, /\b(?:SELECT|saas_|unnest)\b/i);
});

test('057 proves original whole-row immutability and scope bodies/bindings without replacing any function/trigger', () => {
  const historical = GATEWAY_METERING_SAAS_MIGRATION.sql;
  for (const [name, expected] of [
    ['saas_metering_reject_immutable_change', USAGE_SETTLEMENT_IMMUTABLE_EXPECTED_SOURCE],
    ['saas_metering_guard_settlement_scope', USAGE_SETTLEMENT_SCOPE_EXPECTED_SOURCE],
  ] as const) {
    const marker = `CREATE FUNCTION ${name}() RETURNS trigger\nLANGUAGE plpgsql AS $$`;
    const start = historical.indexOf(marker) + marker.length;
    assert.ok(start >= marker.length);
    assert.equal(expected, historical.slice(start, historical.indexOf('\n$$;', start) + 1));
    assert.ok(sql.includes(expected));
  }
  assert.match(USAGE_SETTLEMENT_IMMUTABLE_EXPECTED_SOURCE, /RAISE EXCEPTION 'SaaS metering facts are append-only' USING ERRCODE = '55000'/);
  assert.match(historical, /CREATE TRIGGER saas_usage_settlements_immutable\s+BEFORE UPDATE OR DELETE ON saas_usage_settlements\s+FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change\(\)/);
  assert.match(commands, /\('saas_usage_settlements_immutable', immutable_oid, 27\)/);
  assert.match(commands, /\('saas_usage_settlements_scope', scope_oid, 7\)/);
  assert.match(commands, /t\.tgattr::text = '' AND t\.tgqual IS NULL/);
  assert.match(commands, /t\.tgnargs = 0 AND t\.tgargs = pg_catalog\.decode\('', 'hex'\)/);
  assert.match(commands, /routine\.prosrc IS DISTINCT FROM expected\.source/);
  assert.match(commands, /OR routine\.prosecdef OR routine\.proconfig IS NOT NULL/);
  assert.doesNotMatch(commands, /\b(?:CREATE(?: OR REPLACE)? FUNCTION|ALTER FUNCTION|CREATE TRIGGER|ALTER TRIGGER|DISABLE TRIGGER|SECURITY DEFINER)\b/i);
});

test('057 preserves all existing catalog/ACL/ledger facts and leaves exact column grants to role integration', () => {
  for (const catalog of ['function_catalog', 'table_acl', 'column_catalog', 'constraint_catalog', 'trigger_catalog', 'index_catalog']) {
    assert.ok(commands.includes(`${catalog}_after IS DISTINCT FROM ${catalog}_before`));
  }
  assert.match(commands, /NOT \(a\.attrelid = settlement_table AND a\.attnum = reference_column\)/);
  assert.match(commands, /c\.connamespace = managed_schema AND c\.oid <> reference_check/);
  assert.match(commands, /AND attacl IS NULL/);
  assert.match(commands, /current_user IS DISTINCT FROM 'model_router_saas_migrator'/);
  assert.match(commands, /session_user IS DISTINCT FROM current_user/);
  assert.match(commands, /pg_catalog\.has_function_privilege\(r\.oid, p\.oid, 'EXECUTE'\)/);
  assert.match(commands, /pg_catalog\.has_any_column_privilege\(oid, 'model_router_saas\.saas_api_keys', 'UPDATE'\)/);
  assert.doesNotMatch(commands, /\b(?:GRANT|REVOKE|ALTER ROLE|CREATE ROLE|SET ROLE|TRUNCATE)\b/i);
  assert.doesNotMatch(commands, /(?:^|\n)\s*(?:UPDATE|INSERT INTO|DELETE FROM)\b/i);
  assert.doesNotMatch(commands, /(?:ALTER|UPDATE|INSERT INTO|DELETE FROM)\s+(?:TABLE\s+)?(?:model_router_saas\.)?saas_(?:schema_migrations|ledger|billing|wallet)/i);
});

test('057 is forward-only: no automatic down/drop/backfill or historical digest rewrite exists', () => {
  assert.match(sql, /there is no down migration/);
  assert.match(sql, /removing a populated reference would destroy\s+\* replay evidence/);
  assert.match(sql, /Historical rows remain NULL/);
  assert.match(sql, /no guessed backfill or\s+\* recomputation of their settlement_digest/);
  assert.doesNotMatch(commands, /\b(?:DROP COLUMN|DROP CONSTRAINT|UPDATE saas_usage_settlements|UPDATE model_router_saas\.saas_usage_settlements)\b/i);
});
