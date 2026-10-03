import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import { PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.js';
import {
  PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE, PLATFORM_AUTHORIZATION_ROW_BINDINGS,
  PREPARED_EVIDENCE_BUCKET_CHECK_SQL, RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION,
} from '../../../../src/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.js';

const sql = RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION.sql;

test('056 keeps its exact historical append after frozen 001-055', () => {
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 55).map(({ version }) => version),
    Array.from({ length: 55 }, (_, i) => i + 1));
  assert.equal(SAAS_MIGRATIONS[54], PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(55, 56), [RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION]);
});

test('056 uses no application helper in its exact finite-set equivalent CHECK', () => {
  const check = PREPARED_EVIDENCE_BUCKET_CHECK_SQL;
  assert.ok(check.startsWith('CASE\n  WHEN usage_feasible_input_buckets IS NULL THEN FALSE'));
  assert.ok(check.indexOf('cardinality(usage_feasible_input_buckets) < 1') < check.indexOf('array_position('));
  assert.ok(check.indexOf('array_position(') < check.indexOf('<@ ARRAY['));
  assert.ok(check.indexOf('<@ ARRAY[') < check.indexOf('ELSE '));
  assert.equal((check.match(/pg_catalog\.array_positions\(/g) ?? []).length, 5);
  for (const label of ['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']) {
    assert.ok(check.includes(`pg_catalog.cardinality(pg_catalog.array_positions(usage_feasible_input_buckets, '${label}'::text)) <= 1`));
  }
  assert.doesNotMatch(check, /saas_|array_lower|array_ndims|unnest|SELECT/);
  assert.match(sql, /LOCK TABLE model_router_saas\.saas_prepared_request_evidence IN ACCESS EXCLUSIVE MODE/);
  assert.match(sql, /model_router_saas\.saas_prepared_evidence_valid_input_buckets\(usage_feasible_input_buckets\) IS NOT TRUE/);
  assert.match(sql, /DROP CONSTRAINT saas_prepared_request_evidence_bucket_check,\s+ADD CONSTRAINT saas_prepared_request_evidence_bucket_check CHECK/);
  assert.match(sql, /to_jsonb\(c\) - 'oid' - 'conbin' = check_shape AND c\.convalidated/);
});

test('056 elevates only the byte-identical 046 row wrapper and retains all four exact bindings', () => {
  const marker = 'CREATE FUNCTION saas_platform_authorization_fence_row() RETURNS trigger';
  const historical = PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION.sql;
  const first = historical.indexOf('AS $$', historical.indexOf(marker)) + 'AS $$'.length;
  assert.equal(PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE,
    historical.slice(first, historical.indexOf('\n$$;', first) + 1));
  assert.ok(PLATFORM_AUTHORIZATION_FENCE_ROW_EXPECTED_SOURCE.includes('PERFORM saas_platform_authorization_fence_users(ARRAY[old_user_id, new_user_id]);'));
  assert.equal(PLATFORM_AUTHORIZATION_ROW_BINDINGS.length, 4);
  assert.deepEqual(PLATFORM_AUTHORIZATION_ROW_BINDINGS.map(([table]) => table),
    ['saas_platform_role_assignments', 'saas_platform_sessions', 'saas_users', 'saas_mfa_credentials']);
  assert.ok(!PLATFORM_AUTHORIZATION_ROW_BINDINGS[3][4].includes('last_used_step'));
  assert.equal((sql.match(/ALTER FUNCTION model_router_saas\.saas_platform_authorization_fence_row\(\)/g) ?? []).length, 2);
  assert.match(sql, /SET search_path TO pg_catalog, model_router_saas, pg_temp/);
  assert.match(sql, /count\(\*\) FROM pg_trigger WHERE tgfoid = wrapper_oid\) <> 4/);
  assert.match(sql, /t\.tgargs = decode\(binding\.arguments_hex, 'hex'\)/);
  assert.match(sql, /t\.tgattr::text = array_to_string/);
  assert.match(sql, /ORDER BY cols\.position/);
  assert.match(sql, /t\.tgfoid = statement_oid AND t\.tgtype = binding\.trigger_type \+ 1/);
});

test('056 proves all other function catalogs/ACLs, columns, constraints, triggers and ledger controls unchanged', () => {
  for (const target of ['function_catalog', 'table_acl', 'column_catalog', 'constraint_catalog', 'trigger_catalog']) {
    assert.ok(sql.includes(`${target}_after IS DISTINCT FROM ${target}_before`));
  }
  assert.equal((sql.match(/CASE WHEN p\.oid = wrapper_oid THEN to_jsonb\(p\) - 'prosecdef' - 'proconfig' ELSE to_jsonb\(p\) END/g) ?? []).length, 2);
  assert.match(sql, /current_user IS DISTINCT FROM 'model_router_saas_migrator'/);
  assert.match(sql, /routine\.prosrc IS DISTINCT FROM expected\.source/);
  assert.match(sql, /OR routine\.prosecdef OR routine\.proconfig IS NOT NULL/);
  assert.match(sql, /has_function_privilege\(r\.oid, p\.oid, 'EXECUTE'\)/);
  assert.match(sql, /has_any_column_privilege\(oid, 'model_router_saas\.saas_api_keys', 'UPDATE'\)/);
  const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(commands, /\b(?:GRANT|REVOKE|CREATE(?: OR REPLACE)? FUNCTION|ALTER ROLE|SET ROLE|DISABLE TRIGGER|NOT VALID)\b/i);
  assert.doesNotMatch(commands, /(?:ALTER|INSERT INTO|UPDATE|DELETE FROM) (?:TABLE )?(?:model_router_saas\.)?saas_(?:ledger|billing|wallet)/i);
  assert.doesNotMatch(commands, /(?:UPDATE|INSERT INTO|DELETE FROM).*saas_schema_migrations/i);
});
