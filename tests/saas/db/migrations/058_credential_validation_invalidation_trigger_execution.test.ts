import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/035_credential_validation_jobs.js';
import {
  CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS, CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS,
  CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION, CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS,
} from '../../../../src/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.js';

// Static/source assertions, not PostgreSQL execution or a financial/worker proof.
const migration = CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('058 is the exact second forward after frozen 001-056; 057 retains its FIN slot', () => {
  assert.equal(migration.version, 58);
  assert.equal(migration.name, 'credential_validation_invalidation_trigger_execution');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 56).map(({ version }) => version), Array.from({ length: 56 }, (_, i) => i + 1));
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 58).map(({ version }) => version), Array.from({ length: 58 }, (_, i) => i + 1));
  assert.equal(SAAS_MIGRATIONS[56]?.name, 'normal_success_usage_evidence_reference');
  assert.equal(SAAS_MIGRATIONS[57], migration);
  for (const [file, hash] of [
    ['035_credential_validation_jobs.ts', '5dce54853124a8bae3ff9f4e43ddd4787f1f77ac07e39fdab484279c8ad410d9'],
    ['054_trigger_only_trusted_execution.ts', '6375222a33353e1dafed61826e062024d8291e911ffb7cd173d1e3e0fa98f7a3'],
    ['055_prepared_evidence_optional_validity_scalars.ts', 'ed8ef3bfe1a3ddaa6d39111486429b3b86b193aee8dda01fe58e62634d8ba660'],
    ['056_restricted_role_check_and_platform_auth_execution.ts', '13e1e5330447ecfb78e137b7054d0ec384254e865e91e7e98004222fe450ac13'],
    ['057_normal_success_usage_evidence_reference.ts', 'f718700b39171675983af642dddc4135e4d236e930c758a77fd9bb7c2aa73ca1'],
  ] as const) {
    const source = readFileSync(new URL(`../../../../src/saas/db/migrations/${file}`, import.meta.url));
    assert.equal(createHash('sha256').update(source).digest('hex'), hash, file);
  }
});

test('058 pins both exact 035 invalidation bodies and leaves the identity/delete helpers unchanged', () => {
  assert.deepEqual(CREDENTIAL_VALIDATION_INVALIDATION_WRAPPERS, [
    'saas_invalidate_account_credential_validation_jobs()', 'saas_invalidate_credential_validation_jobs()',
  ]);
  assert.equal(CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS.length, 4);
  const historical = CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION.sql;
  for (const { signature, source } of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_FUNCTIONS) {
    const marker = `CREATE FUNCTION ${signature} RETURNS trigger\nLANGUAGE plpgsql AS $$`;
    const first = historical.indexOf(marker);
    assert.ok(first >= 0);
    assert.equal(historical.indexOf(marker, first + marker.length), -1);
    assert.equal(source, historical.slice(first + marker.length, historical.indexOf('\n$$;', first + marker.length) + 1));
    assert.ok(sql.includes(source));
    assert.doesNotMatch(source, /\b(?:PERFORM|SELECT)\b|\bsaas_[a-z_]+\s*\(/i, 'original wrappers/guards introduce no nested application helper');
  }
  assert.match(sql, /lease_generation = lease_generation \+ 1/);
  assert.match(sql, /NEW\.current_version IS DISTINCT FROM OLD\.current_version/);
  assert.match(sql, /tenant_id = NEW\.tenant_id\s+AND account_id = NEW\.id/);
  assert.match(sql, /tenant_id = NEW\.tenant_id\s+AND credential_id = NEW\.id/);
  assert.match(sql, /last_error_code = 'account_changed'/);
  assert.match(sql, /last_error_code = 'credential_changed'/);
});

test('058 binds exactly the two AFTER UPDATE wrappers and the original immutable/no-delete helpers', () => {
  assert.deepEqual(CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS.map(([, , , type, columns]) => [type, columns]),
    [[17, ['status']], [17, ['current_version', 'status']], [19, []], [11, []]]);
  for (const [, name] of CREDENTIAL_VALIDATION_INVALIDATION_EXPECTED_BINDINGS) assert.ok(sql.includes(`'${name.slice(0, 63)}'`));
  assert.match(commands, /t\.tgattr::text = pg_catalog\.array_to_string/);
  assert.match(commands, /ORDER BY cols\.position/);
  assert.match(commands, /t\.tgnargs = 0 AND t\.tgargs = pg_catalog\.decode\('', 'hex'\)/);
  assert.match(commands, /t\.tgqual IS NULL/);
  assert.match(commands, /t\.tgparentid = 0/);
  assert.match(commands, /t\.tgoldtable IS NULL AND t\.tgnewtable IS NULL/);
  assert.match(commands, /count\(\*\) FROM pg_catalog\.pg_trigger WHERE tgfoid = ANY\(checked_oids\)\) <> 4/);
  assert.match(commands, /tgrelid = jobs_table AND NOT tgisinternal\) <> 2/);
});

test('058 fails closed on original owner/source/invoker/role drift before its bounded metadata changes', () => {
  assert.match(commands, /current_user IS DISTINCT FROM 'model_router_saas_migrator' OR session_user IS DISTINCT FROM current_user/);
  assert.match(commands, /routine\.proowner IS DISTINCT FROM trusted_owner/);
  assert.match(commands, /routine\.prosrc IS DISTINCT FROM expected\.source/);
  assert.match(commands, /OR routine\.prosecdef OR routine\.proconfig IS NOT NULL/);
  assert.match(commands, /NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls/);
  assert.match(commands, /pg_catalog\.has_any_column_privilege\(oid, jobs_table, 'UPDATE'\)/);
  assert.match(commands, /pg_catalog\.has_function_privilege\(r\.oid, p\.oid, 'EXECUTE'\)/);
  assert.match(commands, /a\.grantee = 0 AND a\.privilege_type = 'EXECUTE'/);
  assert.match(commands, /a\.grantee <> trusted_owner AND a\.privilege_type = 'CREATE'/);
  assert.match(commands, /LOCK TABLE model_router_saas\.saas_tenant_provider_accounts,\s+model_router_saas\.saas_tenant_provider_credentials,\s+model_router_saas\.saas_tenant_provider_credential_validation_jobs IN ACCESS EXCLUSIVE MODE/);
  assert.match(commands, /'ALTER FUNCTION model_router_saas\.%s SECURITY DEFINER'/);
  assert.match(commands, /'ALTER FUNCTION model_router_saas\.%s SET search_path TO pg_catalog, model_router_saas, pg_temp'/);
  assert.match(commands, /pg_catalog\.cardinality\(target_oids\) <> 2/);
});

test('058 compares the whole managed catalog, exempting only target prosecdef/proconfig and no other function attributes', () => {
  assert.equal((commands.match(/CASE WHEN p\.oid = ANY\(target_oids\)/g) ?? []).length, 2);
  assert.equal((commands.match(/pg_catalog\.to_jsonb\(p\) - 'prosecdef' - 'proconfig' ELSE pg_catalog\.to_jsonb\(p\)/g) ?? []).length, 2);
  for (const catalog of ['function_catalog', 'table_acl', 'column_catalog', 'constraint_catalog', 'trigger_catalog', 'index_catalog']) {
    assert.ok(commands.includes(`${catalog}_after IS DISTINCT FROM ${catalog}_before`));
  }
  assert.match(commands, /p\.prosecdef IS DISTINCT FROM \(p\.oid = ANY\(target_oids\)\)/);
  assert.match(commands, /p\.proconfig IS DISTINCT FROM ARRAY\['search_path=pg_catalog, model_router_saas, pg_temp'\]/);
  assert.match(commands, /NOT p\.oid = ANY\(target_oids\) AND p\.proconfig IS NOT NULL/);
  assert.doesNotMatch(commands, /\b(?:CREATE(?: OR REPLACE)? FUNCTION|ALTER TABLE|CREATE TRIGGER|ALTER TRIGGER|DISABLE TRIGGER|GRANT|REVOKE|ALTER ROLE|CREATE ROLE|SET ROLE|DROP|TRUNCATE|OWNER TO)\b/i);
  assert.doesNotMatch(commands, /\b(?:ADD\s+(?:(?:COLUMN|CONSTRAINT)\s+)?IF\s+NOT\s+EXISTS|NOT VALID|VALIDATE CONSTRAINT)\b/i);
  // The only UPDATE text is the byte-identical body inside $source_0/1$;
  // the DO block never executes business DML or a historical/ledger rewrite.
  const outsideExpectedBodies = commands.replace(/\$source_\d+\$[\s\S]*?\$source_\d+\$/g, '');
  assert.doesNotMatch(outsideExpectedBodies, /(?:^|\n)\s*(?:UPDATE|INSERT INTO|DELETE FROM)\b/i);
  assert.doesNotMatch(outsideExpectedBodies, /saas_(?:ledger|billing|wallet|schema_migrations)/i);
});
