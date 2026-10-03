import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/024_prepared_request_evidence.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';
import { TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/054_trigger_only_trusted_execution.js';
import { PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.js';

const sql = PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION.sql;
function constant(source: string, name: string): string {
  const tag = `$${name}$`;
  const start = source.indexOf(`${name} constant text := ${tag}`);
  assert.ok(start >= 0);
  const valueStart = source.indexOf(tag, start) + tag.length;
  const end = source.indexOf(tag, valueStart);
  assert.ok(end > valueStart);
  return source.slice(valueStart, end);
}
const before = constant(sql, 'expected_source');
const after = constant(sql, 'replacement_source');

test('055 preserves its exact append after the complete frozen 001-054 history', () => {
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 54).map(({ version }) => version),
    Array.from({ length: 54 }, (_, i) => i + 1));
  assert.equal(SAAS_MIGRATIONS[53], TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(54, 55), [PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION]);
});

test('055 reconstructs the exact 024/046/050 prepared reader, not the other 053 guards', () => {
  const historical = PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION.sql;
  const marker = 'CREATE FUNCTION saas_prepared_request_evidence_guard() RETURNS trigger\nLANGUAGE plpgsql AS $$';
  const start = historical.indexOf(marker) + marker.length;
  let body = historical.slice(start, historical.indexOf('\n$$;', start) + 1);
  const platform = PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION.sql;
  for (const [oldName, newName] of [
    ['unsupported_project_service_guard', 'project_service_guard_replacement'],
    ['member_principal_guard', 'conditional_member_guard'],
    ['key_principal_match', 'key_principal_replacement'],
  ] as const) body = body.replace(constant(platform, oldName), constant(platform, newName));
  body = body.replace(/AND version = NEW[.]project_policy_version\s+FOR SHARE;/, 'AND version = NEW.project_policy_version;');
  const advisory = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION.sql;
  body = body.replace(constant(advisory, 'target_fence_key_declaration_anchor'), constant(advisory, 'target_fence_key_declaration_replacement'));
  body = body.replace(constant(advisory, 'tenant_read_anchor'), constant(advisory, 'authorization_fence_preamble')
    + constant(advisory, 'supply_fence_preamble') + constant(advisory, 'tenant_read_anchor'));
  for (const kind of ['request', 'attempt']) {
    const anchor = constant(advisory, `${kind}_lock_anchor`);
    body = body.replace(anchor, anchor.replace('FOR SHARE;', `__${kind}__`));
  }
  body = body.replaceAll('FOR SHARE;', ';').replace('__request__', 'FOR SHARE;').replace('__attempt__', 'FOR SHARE;');
  assert.equal(before, body);
  assert.ok(before.endsWith('END;\n'));
});

test('055 changes only four optional date paths and fails closed on a missing named commercial version', () => {
  let approved = before;
  for (const kind of ['mapping', 'grant', 'price', 'cost']) {
    const declaration = `  ${kind}_record record;`;
    const scalar = `  ${kind}_effective_at timestamptz := NULL;\n  ${kind}_expires_at timestamptz := NULL;`;
    approved = approved.replace(declaration, ['mapping', 'grant'].includes(kind) ? `${declaration}\n${scalar}` : scalar);
    approved = approved.replace(
      `  IF ${kind}_record IS NOT NULL\n    AND (${kind}_record.effective_at > locked_at\n      OR (${kind}_record.expires_at IS NOT NULL AND ${kind}_record.expires_at <= locked_at))`,
      `  IF ${kind}_effective_at > locked_at\n    OR (${kind}_expires_at IS NOT NULL AND ${kind}_expires_at <= locked_at)`);
    assert.doesNotMatch(after, new RegExp(`IF ${kind}_record IS NOT NULL`));
    assert.match(after, new RegExp(`${kind}_effective_at > locked_at`));
    assert.match(after, new RegExp(`${kind}_expires_at <= locked_at`));
  }
  for (const [kind, error] of [['mapping', 'BYOK profile mapping'], ['grant', 'platform pool grant']] as const) {
    const anchor = `      RAISE EXCEPTION 'Prepared-request evidence ${error} is stale'\n        USING ERRCODE = '23514';\n    END IF;`;
    approved = approved.replace(anchor, `${anchor}\n    ${kind}_effective_at := ${kind}_record.effective_at;\n    ${kind}_expires_at := ${kind}_record.expires_at;`);
  }
  for (const [kind, version, table, error] of [
    ['price', 'customer_price_version', 'saas_customer_price_versions', 'customer price'],
    ['cost', 'supplier_cost_version', 'saas_supplier_cost_versions', 'provider cost'],
  ] as const) {
    approved = approved.replace(`    SELECT * INTO ${kind}_record FROM ${table}\n     WHERE id = NEW.${version} ;`,
      `    SELECT effective_at, expires_at INTO ${kind}_effective_at, ${kind}_expires_at\n      FROM ${table}\n     WHERE id = NEW.${version} ;\n    IF NOT FOUND THEN\n      RAISE EXCEPTION 'Prepared-request evidence ${error} is missing' USING ERRCODE = '23514';\n    END IF;`);
    assert.doesNotMatch(after, new RegExp(`${kind}_record`));
  }
  assert.equal(after, approved, 'no unapproved authorization or validity clause may change');
  assert.match(after, /IF NEW\.account_owner_kind = 'tenant' THEN[\s\S]*mapping_effective_at := mapping_record\.effective_at;[\s\S]*ELSIF NEW\.account_owner_kind = 'platform' THEN[\s\S]*grant_effective_at := grant_record\.effective_at;/);
});

test('055 preserves all fence/read ordering, request/attempt row locks and post-read wall clock', () => {
  assert.deepEqual(after.match(/PERFORM pg_advisory_xact_lock_shared\([\s\S]*?\);/g),
    before.match(/PERFORM pg_advisory_xact_lock_shared\([\s\S]*?\);/g));
  assert.equal((after.match(/FOR SHARE;/g) ?? []).length, 2);
  for (const identity of ['saas-authz:tenant:', 'saas-authz:project:', 'saas-authz:api-key:',
    'saas-authz:provider-rights', 'saas_public_model:', 'saas_platform_pool:', 'saas_supply_profile:']) {
    assert.ok(after.includes(identity));
  }
  assert.ok(after.indexOf('locked_at := clock_timestamp();') > after.indexOf('FROM saas_supplier_cost_versions'));
  assert.match(after, /IF NEW\.expires_at <= locked_at OR NEW\.dispatch_deadline <= locked_at THEN/);
  assert.match(after, /IF NEW\.attempt_ordinal > NEW\.retry_budget \+ 1 THEN/);
  assert.match(after, /pool_grant_pool_authz_version/);
  assert.match(after, /contract_attestation_id/);
});

test('055 validates exact owner/invoker body/binding and changes no execution metadata or ACLs', () => {
  assert.match(sql, /current_user IS DISTINCT FROM 'model_router_saas_migrator'/);
  assert.match(sql, /NOT p\.prosecdef AND p\.proconfig IS NULL/);
  assert.match(sql, /p\.prosrc = expected_source/);
  assert.match(sql, /t\.tgtype = 7/);
  assert.match(sql, /count\(\*\) FROM pg_trigger WHERE tgfoid = function_oid\) <> 1/);
  assert.match(sql, /has_function_privilege\(r\.oid, p\.oid, 'EXECUTE'\)/);
  assert.equal((sql.match(/to_jsonb\(p\) - 'prosrc'/g) ?? []).length, 2);
  for (const contract of ['function_catalog', 'table_acl', 'column_acl', 'trigger_catalog']) {
    assert.ok(sql.includes(`${contract}_after IS DISTINCT FROM ${contract}_before`));
  }
  assert.doesNotMatch(sql, /^\s*(?:GRANT|REVOKE|CREATE FUNCTION|CREATE OR REPLACE FUNCTION|ALTER FUNCTION|ALTER TABLE|ALTER ROLE|DROP)\b/im);
  assert.doesNotMatch(sql, /SECURITY DEFINER/);
  assert.doesNotMatch(sql, /(?:UPDATE|DELETE FROM|INSERT INTO) saas_schema_migrations/);
});
