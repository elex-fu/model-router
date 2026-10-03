import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_SAAS_MIGRATION, SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/023_commercial_metering_policy_authority.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';
import { COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/052_commercial_authority_guard_rowtype_safety.js';
import { COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/053_commercial_authority_read_fences.js';

const sql = COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION.sql;
const names = [
  'saas_route_config_commercial_authority_guard',
  'saas_requests_guard_commercial_authority',
  'saas_attempts_guard_commercial_authority',
] as const;

function dollarBody(source: string, tag: string): string {
  const marker = `$${tag}$`;
  const start = source.indexOf(marker);
  const end = source.indexOf(marker, start + marker.length);
  assert.ok(start >= 0 && end > start, `missing ${tag} source contract`);
  return source.slice(start + marker.length, end);
}

function originalBody(source: string, name: string, signature = '() RETURNS trigger'): string {
  const marker = `FUNCTION ${name}${signature}\nLANGUAGE plpgsql AS $$`;
  const start = source.indexOf(marker);
  const end = source.indexOf('\n$$;', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start + marker.length, end + 1);
}

function guardSources(name: string) {
  const start = sql.indexOf(`DO $rewrite_${name}$`);
  const end = sql.indexOf(`$rewrite_${name}$;`, start);
  assert.ok(start >= 0 && end > start);
  const block = sql.slice(start, end);
  return { original: dollarBody(block, 'expected_source'), replacement: dollarBody(block, 'replacement_source') };
}

function assertNoPrivilegeDdl(source: string): void {
  // Keep dollar-quoted guard bodies visible, but do not treat ordinary SQL
  // string/identifier literals or comments (e.g. 050's scope = 'grant') as DDL.
  const code = source.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ');
  assert.doesNotMatch(code, /\b(?:GRANT|REVOKE)\b/i);
}

test('053 privilege DDL assertion ignores quoted scopes/comments but still rejects GRANT and REVOKE', () => {
  assertNoPrivilegeDdl(`DO $body$ BEGIN
    scope := 'grant'; message := 'can''t REVOKE this';
    -- GRANT EXECUTE ON FUNCTION helper() TO PUBLIC;
    /* REVOKE ALL ON TABLE authority FROM PUBLIC; */
  END; $body$;`);
  for (const statement of [
    'GRANT EXECUTE ON FUNCTION helper() TO PUBLIC;',
    'REVOKE ALL ON TABLE authority FROM PUBLIC;',
    'DO $body$ BEGIN gRaNt UPDATE ON TABLE authority TO gateway; END; $body$;',
    "DO $body$ BEGIN scope := 'grant'; REVOKE EXECUTE ON FUNCTION helper() FROM PUBLIC; END; $body$;",
  ]) {
    assert.throws(() => assertNoPrivilegeDdl(statement), assert.AssertionError);
  }
});

test('053 is a forward registration with no new callable function or privilege expansion', () => {
  assert.equal(COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION.version, 53);
  assert.equal(COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION.name, 'commercial_authority_read_fences');
  assert.equal(SAAS_MIGRATIONS[51], COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[52], COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION);
  assertNoPrivilegeDdl(sql);
  assert.doesNotMatch(sql, /\b(?:SECURITY DEFINER|CREATE FUNCTION|DROP|ALTER ROLE)\b/i);
  assert.doesNotMatch(sql, /saas_commercial_authority_read_fences\(/);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM|INSERT INTO) saas_schema_migrations/);
  assert.match(sql, /EXECUTE replace\(definition, expected_source, replacement_source\)/);
  assert.match(sql, /installed_source IS DISTINCT FROM replacement_source/);
});

test('053 attests exact matching 050 exclusive writers and actual immutable guard contracts', () => {
  const historical = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql;
  assert.equal(dollarBody(sql, 'expected_writer'), originalBody(historical, 'saas_prepared_evidence_authorization_writer_fence'));
  assert.equal(dollarBody(sql, 'expected_writer_layer'),
    originalBody(historical, 'saas_prepared_evidence_writer_lock_layer', '(fence_keys text[]) RETURNS void'));
  assert.equal(dollarBody(sql, 'expected_immutable'), originalBody(INITIAL_SAAS_MIGRATION.sql, 'saas_reject_immutable_change'));
  assert.match(sql, /tgenabled IN \('O', 'A'\)/);
  assert.match(sql, /tgtype = 31/); // BEFORE ROW INSERT/UPDATE/DELETE, not just UPDATE.
  assert.match(sql, /position\(expected_arguments IN pg_get_triggerdef\(oid\)\) > 0/);
  for (const table of ['saas_route_config_heads', 'saas_customer_metering_policy_heads', 'saas_provider_metering_policy_heads']) {
    assert.ok(sql.includes(`'${table}:`));
  }
  assert.ok(sql.includes("'(''project'', ''tenant_id'', ''project_id'')'"));
  assert.ok(sql.includes("'(''commercial'', ''customer'', ''tenant_id'', ''project_id'', ''policy_id'')'"));
  assert.ok(sql.includes("'(''commercial'', ''provider'', ''tenant_id'', ''project_id'', ''policy_id'')'"));
  assert.match(sql, /tgtype = 27/); // BEFORE ROW UPDATE/DELETE.
  assert.match(sql, /tgfoid = to_regprocedure\('model_router_saas.saas_reject_immutable_change\(\)'\)/);
  for (const table of ['saas_route_config_versions', 'saas_route_config_commercial_authorities',
    'saas_customer_metering_policy_versions', 'saas_provider_metering_policy_versions',
    'saas_contract_test_attestations', 'saas_customer_price_versions', 'saas_supplier_cost_versions']) {
    assert.ok(sql.includes(`'${table}'`));
  }
});

for (const name of names) {
  test(`053 ${name} changes only fencing, SELECT-only tuple locks and initialized optional dates`, () => {
    const { original, replacement } = guardSources(name);
    const canonical = name === names[0]
      ? COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION.sql
      : COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION.sql;
    assert.equal(original, originalBody(canonical, name), 'historical prosrc, including final newline, must match');
    assert.equal((replacement.match(/FOR SHARE;/g) ?? []).length, name === names[2] ? 1 : 0);
    const fenceStart = replacement.indexOf('  IF NEW.tenant_id IS NULL OR ');
    const fenceEnd = replacement.indexOf('\n  );', fenceStart) + '\n  );'.length;
    assert.ok(fenceStart >= 0 && fenceEnd > fenceStart);
    const fence = replacement.slice(fenceStart, fenceEnd);
    assert.match(fence, /transaction_isolation.*IS DISTINCT FROM 'read committed'/);
    assert.match(fence, /ERRCODE = '55000'/);
    assert.ok(fence.indexOf('saas-authz:tenant:') < fence.indexOf('saas-authz:project:'));
    assert.equal((fence.match(/pg_advisory_xact_lock_shared/g) ?? []).length, 2);
    assert.ok(replacement.indexOf('locked_at := clock_timestamp()') > fenceEnd);

    // Undo only the explicitly allowed transformations. Exact equality proves
    // every binding predicate, join, status/version check, error and clock
    // boundary remains, including BYOK NULL and platform exact price/cost.
    let restored = replacement.slice(0, fenceStart) + replacement.slice(fenceEnd + 2);
    if (name === names[2]) {
      restored = restored.replace('  commercial_project_id uuid;\n', '');
      restored = restored.replace(
        /  SELECT project_id INTO commercial_project_id FROM saas_requests\n   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;\n  IF NOT FOUND THEN\n    RAISE EXCEPTION 'SaaS attempt commercial authority request is missing'\n      USING ERRCODE = '23514';\n  END IF;\n/,
        '',
      );
      assert.ok(replacement.indexOf('saas-authz:project:') < replacement.indexOf('  SELECT r.project_id, r.supply_mode,'));
      assert.match(replacement, /AND r.id = NEW.request_id\n   FOR SHARE;/);
    }
    for (const kind of ['price', 'cost']) {
      if (!original.includes(`  ${kind}_record record;`)) continue;
      restored = restored.replace(`  ${kind}_effective_at timestamptz;\n  ${kind}_expires_at timestamptz;`, `  ${kind}_record record;`)
        .replace(`INTO ${kind}_effective_at, ${kind}_expires_at`, `INTO ${kind}_record`)
        .replaceAll(`${kind}_effective_at`, `${kind}_record.effective_at`)
        .replaceAll(`${kind}_expires_at`, `${kind}_record.expires_at`);
    }
    assert.equal(restored.replace(/FOR SHARE;/g, ';'), original.replace(/FOR SHARE;/g, ';'));
  });
}
