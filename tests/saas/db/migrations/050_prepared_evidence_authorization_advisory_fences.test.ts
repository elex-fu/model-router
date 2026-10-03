import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool as PgPool, type PoolClient } from 'pg';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/024_prepared_request_evidence.js';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/028_prepared_request_evidence_pool_claim_hardening.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import { IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/047_identity_key_authorization_fences.js';
import { RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/048_runtime_role_lock_fences.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';
import {
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
} from '../../../../src/saas/db/runtime-privileges.js';

const migration = PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION;
const migration050TestUrl = process.env.MODEL_ROUTER_SAAS_MIGRATION_050_TEST_URL;

function migrationTextConstant(source: { sql: string }, name: string): string {
  const marker = `${name} constant text := $${name}$`;
  const start = source.sql.indexOf(marker);
  assert.notEqual(start, -1, `migration must declare ${name}`);
  const contentStart = start + marker.length;
  const end = source.sql.indexOf(`$${name}$;`, contentStart);
  assert.notEqual(end, -1, `migration must terminate ${name}`);
  return source.sql.slice(contentStart, end);
}

function triggerBody(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(
      'CREATE (?:OR REPLACE )?FUNCTION ' +
        name +
        '\\(\\) RETURNS trigger\\nLANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\n\\$\\$;',
    ),
  );
  assert.ok(match, `expected migration SQL to define ${name}`);
  if (!match?.[1]) {
    throw new Error(['expected migration SQL to define ', name].join(''));
  }
  return match[1];
}

function replaceExactlyOnce(source: string, before: string, after: string, description: string): string {
  assert.equal(source.split(before).length - 1, 1, `expected one ${description}`);
  return source.replace(before, after);
}

function final046PreparedEvidenceGuard(): string {
  const original = triggerBody(PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION.sql, 'saas_prepared_request_evidence_guard');
  const oldUnsupportedService = migrationTextConstant(
    PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    'unsupported_project_service_guard',
  );
  const newProjectServiceGuard = migrationTextConstant(
    PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    'project_service_guard_replacement',
  );
  const oldMemberGuard = migrationTextConstant(PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION, 'member_principal_guard');
  const conditionalMemberGuard = migrationTextConstant(
    PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    'conditional_member_guard',
  );
  const oldKeyPrincipalMatch = migrationTextConstant(
    PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    'key_principal_match',
  );
  const newKeyPrincipalGuard = migrationTextConstant(
    PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    'key_principal_replacement',
  );

  let expected = replaceExactlyOnce(
    original,
    oldUnsupportedService,
    newProjectServiceGuard,
    'project-service principal rejection',
  );
  expected = replaceExactlyOnce(expected, oldMemberGuard, conditionalMemberGuard, 'member identity proof');
  expected = replaceExactlyOnce(expected, oldKeyPrincipalMatch, newKeyPrincipalGuard, 'execution-principal proof');
  assert.equal([...expected.matchAll(/AND version = NEW\.project_policy_version\s+FOR SHARE;/g)].length, 1);
  return expected.replace(
    /AND version = NEW\.project_policy_version\s+FOR SHARE;/g,
    'AND version = NEW.project_policy_version;',
  );
}

function countForShare(source: string): number {
  return [...source.matchAll(/FOR SHARE;/g)].length;
}

const finalGuardBefore050 = final046PreparedEvidenceGuard();
const tenantReadAnchor = migrationTextConstant(migration, 'tenant_read_anchor');
const authorizationFencePreamble = migrationTextConstant(migration, 'authorization_fence_preamble');
const profileReadAnchor = migrationTextConstant(migration, 'profile_read_anchor');
const supplyFencePreamble = migrationTextConstant(migration, 'supply_fence_preamble');
const requestLockAnchor = migrationTextConstant(migration, 'request_lock_anchor');
const attemptLockAnchor = migrationTextConstant(migration, 'attempt_lock_anchor');
const poolReadAnchor = migrationTextConstant(migration, 'pool_read_anchor');
const poolFencePreamble = migrationTextConstant(migration, 'pool_fence_preamble');

function final050PreparedEvidenceGuard(): string {
  let expected = replaceExactlyOnce(
    finalGuardBefore050,
    tenantReadAnchor,
    authorizationFencePreamble + supplyFencePreamble + tenantReadAnchor,
    'tenant read anchor',
  );
  assert.equal(expected.split(profileReadAnchor).length - 1, 1, 'expected one profile read anchor');
  expected = replaceExactlyOnce(
    expected,
    requestLockAnchor,
    requestLockAnchor.replace('FOR SHARE;', '__SAAS_KEEP_REQUEST_FOR_SHARE__'),
    'request integrity lock',
  );
  expected = replaceExactlyOnce(
    expected,
    attemptLockAnchor,
    attemptLockAnchor.replace('FOR SHARE;', '__SAAS_KEEP_ATTEMPT_FOR_SHARE__'),
    'attempt integrity lock',
  );
  expected = expected.replace(/FOR SHARE;/g, ';');
  expected = expected.replace('__SAAS_KEEP_REQUEST_FOR_SHARE__', 'FOR SHARE;');
  expected = expected.replace('__SAAS_KEEP_ATTEMPT_FOR_SHARE__', 'FOR SHARE;');
  return expected;
}

const finalGuard = final050PreparedEvidenceGuard();

function final050PoolGuardSources(): { pool: string; claim: string } {
  const poolBefore = triggerBody(
    PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
    'saas_prepared_request_evidence_platform_pool_fence',
  );
  const claimBefore = triggerBody(
    PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
    'saas_attempts_guard_prepared_evidence_claim_pool',
  );
  const pool = replaceExactlyOnce(
    poolBefore,
    poolReadAnchor,
    poolFencePreamble + poolReadAnchor.replace('FOR SHARE;', ';'),
    'platform pool read anchor',
  );
  const claim = replaceExactlyOnce(
    claimBefore,
    poolReadAnchor,
    poolFencePreamble + poolReadAnchor.replace('FOR SHARE;', ';'),
    'claim pool read anchor',
  );
  return { pool, claim };
}

const finalPoolGuardSources = final050PoolGuardSources();

test('migration 050 is registered in append order and remains forward-only', () => {
  assert.equal(migration.version, 50);
  assert.equal(migration.name, 'prepared_evidence_authorization_advisory_fences');
  assert.equal(SAAS_MIGRATIONS[49], migration);
  assert.equal(SAAS_MIGRATIONS.filter(({ version }) => version === 50).length, 1);
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  assert.doesNotMatch(migration.sql, /\bGRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+ON\b/i);
  assert.doesNotMatch(migration.sql, /\bALTER\s+ROLE\b|\bSECURITY\s+DEFINER\b/i);
  assert.doesNotMatch(migration.sql, /\bDROP\s+(?:TABLE|TRIGGER|FUNCTION)\b/i);
});

test('migration 050 attests the already-installed 046 principal and policy guards', () => {
  assert.equal(
    migrationTextConstant(migration, 'project_service_guard'),
    migrationTextConstant(PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION, 'project_service_guard_replacement'),
  );
  assert.equal(
    migrationTextConstant(migration, 'conditional_member_guard'),
    migrationTextConstant(PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION, 'conditional_member_guard'),
  );
  assert.equal(
    migrationTextConstant(migration, 'key_principal_guard'),
    migrationTextConstant(PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION, 'key_principal_replacement'),
  );
  const declarationAnchor = migrationTextConstant(migration, 'target_fence_key_declaration_anchor');
  assert.equal(
    migrationTextConstant(migration, 'target_fence_key_declaration_replacement'),
    `${declarationAnchor.trimEnd()}\n  target_fence_key text;\n`,
  );
  assert.match(migration.sql, /OR history_lock_count <> 0/);
  assert.match(migration.sql, /target_fence_key_declaration_bytes <> length\(target_fence_key_declaration_anchor\)/);
  assert.match(migration.sql, /<> 2 \* length\('FOR SHARE;'\)/);
  assert.match(migration.sql, /length\(pool_read_anchor\)/);
  assert.match(migration.sql, /trigger_name := split_part\(trigger_spec, ':', 2\)/);
  assert.doesNotMatch(migration.sql, /history_lock_count <> 1|old_unsupported_service_guard|old_member_guard/);

  const createdTriggerNames = [...migration.sql.matchAll(/CREATE TRIGGER\s+([a-z0-9_]+)/g)].map((match) => match[1]);
  const expectedTriggerBlock = migration.sql.match(
    /expected_trigger constant text\[\] := ARRAY\[([\s\S]*?)\n {2}\];/,
  )?.[1];
  assert.ok(expectedTriggerBlock, 'migration must attest every installed writer trigger');
  const expectedTriggerNames = [...(expectedTriggerBlock ?? '').matchAll(/'[^']+:([^']+)'/g)].map((match) => match[1]);
  assert.ok(
    createdTriggerNames.every((name) => name.length <= 63),
    'all PostgreSQL trigger identifiers must fit NAMEDATALEN',
  );
  assert.deepEqual([...createdTriggerNames].sort(), [...expectedTriggerNames].sort());
});

test('migration 050 retains only the precise prepared-evidence integrity row locks', () => {
  assert.equal(countForShare(finalGuardBefore050), 22);
  assert.equal(countForShare(finalGuard), 2);
  assert.match(
    finalGuard,
    /FROM saas_requests[\s\S]*?WHERE tenant_id = NEW\.tenant_id AND id = NEW\.request_id\s+FOR SHARE;/,
  );
  assert.match(
    finalGuard,
    /FROM saas_attempts[\s\S]*?WHERE tenant_id = NEW\.tenant_id AND id = NEW\.attempt_id\s+FOR SHARE;/,
  );

  const authorityTablesWhoseLocksAreRemoved = [
    'saas_tenants',
    'saas_projects',
    'saas_project_inference_policy_versions',
    'saas_users',
    'saas_memberships',
    'saas_project_memberships',
    'saas_api_keys',
    'saas_project_entitlements',
    'saas_supply_profiles',
    'saas_route_config_versions',
    'saas_route_config_heads',
    'saas_public_model_versions',
    'saas_public_models',
    'saas_route_config_commercial_authorities',
    'saas_customer_metering_policy_heads',
    'saas_customer_metering_policy_versions',
    'saas_provider_metering_policy_heads',
    'saas_provider_metering_policy_versions',
    'saas_contract_test_attestations',
    'saas_tenant_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_tenant_provider_supply_profile_accounts',
    'saas_platform_provider_accounts',
    'saas_platform_provider_credentials',
    'saas_platform_provider_credential_versions',
    'saas_platform_provider_pools',
    'saas_platform_provider_pool_members',
    'saas_platform_provider_pool_grants',
    'saas_customer_price_versions',
    'saas_supplier_cost_versions',
  ];
  for (const table of authorityTablesWhoseLocksAreRemoved) {
    assert.doesNotMatch(
      finalGuard,
      new RegExp(`(?:FROM|JOIN) ${table}[\\s\\S]{0,1200}?FOR SHARE;`),
      `${table} must not retain a gateway-incompatible row lock`,
    );
  }

  const finalAttemptGuard = triggerBody(
    PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
    'saas_attempts_guard_prepared_evidence',
  );
  assert.equal(countForShare(finalAttemptGuard), 1);
  assert.match(finalAttemptGuard, /FROM saas_prepared_request_evidence[\s\S]*?FOR SHARE;/);

  assert.equal(
    countForShare(
      triggerBody(
        PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
        'saas_prepared_request_evidence_platform_pool_fence',
      ),
    ),
    1,
  );
  assert.equal(countForShare(finalPoolGuardSources.pool), 0);
  assert.equal(
    countForShare(
      triggerBody(
        PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION.sql,
        'saas_attempts_guard_prepared_evidence_claim_pool',
      ),
    ),
    2,
  );
  assert.equal(countForShare(finalPoolGuardSources.claim), 1);
  assert.match(finalPoolGuardSources.claim, /FROM saas_prepared_request_evidence[\s\S]*?FOR SHARE;/);
  assert.match(finalPoolGuardSources.pool, /saas_platform_pool:/);
  assert.match(finalPoolGuardSources.claim, /saas_platform_pool:/);
});

test('migration 050 acquires the matching advisory fences in caller-prelock order', () => {
  assert.match(migration.sql, /pg_advisory_xact_lock_shared\(/);
  assert.match(migration.sql, /'saas-authz:tenant:' \|\| NEW\.tenant_id::text/);
  assert.match(migration.sql, /'saas-authz:project:' \|\| NEW\.tenant_id::text \|\| ':' \|\| NEW\.project_id::text/);
  assert.match(migration.sql, /hashtextextended\(NEW\.principal_id::text, 0\)/);
  assert.match(migration.sql, /'saas_platform_pool:' \|\| encode\(convert_to\(NEW\.pool_id::text, 'UTF8'\), 'hex'\)/);
  assert.match(
    migration.sql,
    /'saas_supply_profile:'[\s\S]*?encode\(convert_to\(NEW\.tenant_id::text, 'UTF8'\), 'hex'\)/,
  );

  const fenceOrder = [
    "hashtextextended('saas-authz:tenant:'",
    "hashtextextended(\n      'saas-authz:project:'",
    'hashtextextended(NEW.principal_id::text, 0)',
    "'saas-authz:api-key:",
    "'saas-authz:commercial-customer:",
    "'saas-authz:commercial-provider:",
    "'saas-authz:provider-rights'",
    "'saas_public_model:",
    "'saas_platform_pool:'",
    "'saas_supply_profile:'",
    "'saas-authz:tenant-provider-account:",
    "'saas-authz:platform-provider-account:",
    "'saas-authz:tenant-provider-credential:",
    "'saas-authz:platform-provider-credential:",
    "'saas-authz:credential-version:",
    "'saas-authz:supply-profile-account:",
    "'saas-authz:member:",
    "'saas-authz:grant:",
  ].map((anchor) => finalGuard.indexOf(anchor));
  assert.ok(
    fenceOrder.every((position) => position >= 0),
    'every ordered fence anchor must remain present',
  );
  for (let index = 1; index < fenceOrder.length; index += 1) {
    const previous = fenceOrder[index - 1];
    const current = fenceOrder[index];
    if (previous === undefined || current === undefined) {
      throw new Error('prepared-evidence fence layer order is incomplete');
    }
    assert.ok(previous < current, 'prepared-evidence fence layer order must be monotonic');
  }

  const firstAuthorityRead = finalGuard.indexOf('FROM saas_tenants');
  const lastFence = fenceOrder.at(-1);
  if (lastFence === undefined) {
    throw new Error('prepared-evidence fence order is empty');
  }
  assert.ok(firstAuthorityRead > lastFence, 'all advisory fences must precede authority snapshots');
  const authorityReadOrder = [
    'FROM saas_tenants',
    'FROM saas_projects',
    'FROM saas_users',
    'FROM saas_memberships',
    'FROM saas_project_memberships',
    'FROM saas_requests',
    'FROM saas_attempts',
    'FROM saas_project_entitlements',
    'FROM saas_supply_profiles',
    'FROM saas_route_config_versions',
    'FROM saas_route_config_commercial_authorities',
  ].map((anchor) => finalGuard.indexOf(anchor));
  assert.ok(
    authorityReadOrder.every((position) => position >= 0),
    'every authority read anchor must remain present',
  );
  for (let index = 1; index < authorityReadOrder.length; index += 1) {
    const previous = authorityReadOrder[index - 1];
    const current = authorityReadOrder[index];
    if (previous === undefined || current === undefined) {
      throw new Error('prepared-evidence authority read order is incomplete');
    }
    assert.ok(previous < current, 'prepared-evidence authority read order must be monotonic');
  }
  assert.match(finalGuard, /IF NEW\.supply_mode = 'platform' THEN[\s\S]*?saas_platform_pool:/);
});

test('migration 050 preserves the 024/046 authority predicates and final integrity checks', () => {
  for (const clause of [
    'NEW.principal_id IS DISTINCT FROM NEW.project_id',
    'key_record.entitlement_id IS DISTINCT FROM NEW.entitlement_id',
    'key_record.supply_mode IS DISTINCT FROM NEW.supply_mode',
    'key_record.authz_version IS DISTINCT FROM NEW.authz_version',
    'request_record.project_id IS DISTINCT FROM NEW.project_id',
    "attempt_record.dispatch_state IS DISTINCT FROM 'not_sent'",
    "entitlement_record.status NOT IN ('active', 'superseded')",
    'route_record.head_version IS DISTINCT FROM NEW.route_config_version',
    'commercial_record.provider_head_version IS DISTINCT FROM NEW.provider_metering_policy_version',
    'authz_version = NEW.profile_account_authz_version',
    'grant_record.pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version',
    'credential_record.current_version IS DISTINCT FROM NEW.credential_version',
    'price_record.effective_at > locked_at',
    'cost_record.effective_at > locked_at',
    'NEW.expires_at <= locked_at OR NEW.dispatch_deadline <= locked_at',
    'NEW.attempt_ordinal > NEW.retry_budget + 1',
  ]) {
    assert.ok(finalGuard.includes(clause), `guard must preserve: ${clause}`);
  }
  assert.doesNotMatch(finalGuard, /Project-service prepared-request evidence is unsupported/);
  assert.doesNotMatch(finalGuard, /AND version = NEW\.project_policy_version\s+FOR SHARE;/);
  assert.match(finalGuard, /Prepared-request evidence request is missing/);
  assert.match(finalGuard, /Prepared-request evidence attempt is missing, stale, or already dispatching/);
  assert.match(finalGuard, /Prepared-request evidence entitlement is not currently valid/);
  assert.match(finalGuard, /Prepared-request evidence credential authority is stale or unverified/);
});

test('migration 050 stays within the existing gateway privilege contract', () => {
  const readableTables = new Set<string>(SAAS_GATEWAY_RUNTIME_READ_TABLES);
  const gatewayUpdateTables = new Set(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.filter(([, , privilege]) => privilege === 'UPDATE').map(([table]) => table),
  );
  const guardTables = [
    'saas_tenants',
    'saas_projects',
    'saas_project_inference_policy_versions',
    'saas_users',
    'saas_memberships',
    'saas_project_memberships',
    'saas_api_keys',
    'saas_requests',
    'saas_attempts',
    'saas_prepared_request_evidence',
    'saas_project_entitlements',
    'saas_supply_profiles',
    'saas_route_config_versions',
    'saas_route_config_heads',
    'saas_public_model_versions',
    'saas_public_models',
    'saas_route_config_commercial_authorities',
    'saas_customer_metering_policy_heads',
    'saas_customer_metering_policy_versions',
    'saas_provider_metering_policy_heads',
    'saas_provider_metering_policy_versions',
    'saas_contract_test_attestations',
    'saas_tenant_provider_supply_profile_accounts',
    'saas_tenant_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_platform_provider_pools',
    'saas_platform_provider_pool_members',
    'saas_platform_provider_pool_grants',
    'saas_platform_provider_accounts',
    'saas_platform_provider_credentials',
    'saas_platform_provider_credential_versions',
    'saas_customer_price_versions',
    'saas_supplier_cost_versions',
  ];
  for (const table of guardTables) {
    assert.equal(readableTables.has(table), true, `${table} must remain readable by the gateway runtime`);
  }

  for (const table of ['saas_requests', 'saas_attempts', 'saas_prepared_request_evidence']) {
    assert.equal(gatewayUpdateTables.has(table), true, `${table} must retain a precise gateway UPDATE column`);
  }
  for (const table of [
    'saas_tenants',
    'saas_projects',
    'saas_users',
    'saas_memberships',
    'saas_project_memberships',
    'saas_api_keys',
    'saas_project_entitlements',
    'saas_supply_profiles',
    'saas_route_config_versions',
    'saas_route_config_commercial_authorities',
    'saas_customer_metering_policy_heads',
    'saas_customer_metering_policy_versions',
    'saas_provider_metering_policy_heads',
    'saas_provider_metering_policy_versions',
    'saas_contract_test_attestations',
    'saas_tenant_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_tenant_provider_supply_profile_accounts',
    'saas_platform_provider_accounts',
    'saas_platform_provider_credentials',
    'saas_platform_provider_credential_versions',
    'saas_platform_provider_pools',
    'saas_platform_provider_pool_members',
    'saas_platform_provider_pool_grants',
    'saas_customer_price_versions',
    'saas_supplier_cost_versions',
  ]) {
    assert.equal(gatewayUpdateTables.has(table), false, `${table} must not receive UPDATE merely to support FOR SHARE`);
  }
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_tenants_prepared_evidence_authorization_fence\s+BEFORE INSERT OR UPDATE OR DELETE ON saas_tenants/,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_supply_profiles_prepared_evidence_authorization_fence\s+BEFORE INSERT OR UPDATE OR DELETE ON saas_supply_profiles/,
  );
  assert.match(IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION.sql, /saas-authz:tenant:/);
  assert.match(RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION.sql, /saas_supply_profile:/);
  assert.match(RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION.sql, /saas_platform_pool:/);
});

test('migration 050 writer fences use explicit resource layers and valid row contexts', () => {
  const writer = triggerBody(migration.sql, 'saas_prepared_evidence_authorization_writer_fence');
  assert.match(migration.sql, /The resource order is explicit and matches the evidence readers/);
  assert.match(writer, /IF TG_OP <> 'INSERT' THEN[\s\S]*old_row := to_jsonb\(OLD\)/);
  assert.match(writer, /IF TG_OP <> 'INSERT' AND cardinality\(old_all_keys\) = 0/);
  assert.doesNotMatch(writer, /IF old_key IS NULL/);

  const layerOrder = [
    'old_tenant_keys || new_tenant_keys',
    'old_project_keys || new_project_keys',
    'old_user_keys || new_user_keys',
    'old_business_keys || new_business_keys',
    'old_catalog_keys || new_catalog_keys',
    'old_pool_keys || new_pool_keys',
    'old_profile_keys || new_profile_keys',
    'old_account_keys || new_account_keys',
    'old_credential_keys || new_credential_keys',
    'old_version_keys || new_version_keys',
    'old_mapping_keys || new_mapping_keys',
    'old_member_keys || new_member_keys',
    'old_grant_keys || new_grant_keys',
  ].map((anchor) => writer.lastIndexOf(anchor));
  for (let index = 1; index < layerOrder.length; index += 1) {
    const previous = layerOrder[index - 1];
    const current = layerOrder[index];
    assert.ok(
      previous !== undefined && current !== undefined && previous < current,
      'writer lock layers must be acquired in explicit resource order',
    );
  }

  assert.match(
    migration.sql,
    /saas_supply_profiles_prepared_evidence_authorization_fence\s+BEFORE INSERT OR UPDATE OR DELETE ON saas_supply_profiles[\s\S]+?'profile', 'tenant_id', 'id'/,
  );
  assert.match(
    migration.sql,
    /saas_api_keys_prepared_evidence_authorization_fence\s+BEFORE INSERT OR UPDATE OR DELETE ON saas_api_keys[\s\S]+?'api_key', 'tenant_id', 'project_id', 'id', 'principal_user_id'/,
  );
  assert.match(
    migration.sql,
    /saas_tenant_provider_accounts_pe_authz_fence[\s\S]+?'provider_account', 'tenant', 'tenant_id', 'id'/,
  );
  assert.match(
    migration.sql,
    /saas_platform_provider_accounts_pe_authz_fence[\s\S]+?'provider_account', 'platform', 'id'/,
  );
  assert.doesNotMatch(writer, /account_owner_kind/);
  assert.match(writer, /current_user_id := saas_prepared_evidence_writer_require_value\(current_row, TG_ARGV\[4\]\)/);
  assert.doesNotMatch(writer, /execution_principal_/);
  assert.match(
    writer,
    /old_user_keys := old_user_keys \|\| ARRAY\[current_user_id\][\s\S]*old_business_keys := old_business_keys \|\| ARRAY\[current_key\]/,
  );
});

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function migrationSqlForSchema(sql: string, schemaName: string): string {
  return sql.replace(/\bmodel_router_saas\b/g, schemaName);
}

function migrationChecksum(name: string, sql: string): string {
  return createHash('sha256').update(name).update('\0').update(sql).digest('hex');
}

async function setMigration050SearchPath(client: PoolClient, schemaName: string): Promise<void> {
  await client.query(`SET search_path TO pg_temp, ${quoteIdentifier(schemaName)}, pg_catalog`);
}

async function replayMigrationsBefore050(client: PoolClient, schemaName: string): Promise<void> {
  const migrations = SAAS_MIGRATIONS.filter(({ version }) => version <= 49).sort(
    (left, right) => left.version - right.version,
  );
  assert.equal(migrations.length, 49, 'the disposable schema must replay exactly migrations 001–049');
  assert.deepEqual(
    migrations.map(({ version }) => version),
    Array.from({ length: 49 }, (_, index) => index + 1),
    'the registered migration history must be contiguous through version 49',
  );

  const schema = quoteIdentifier(schemaName);
  await client.query(
    `CREATE TABLE ${schema}.saas_schema_migrations (` +
      'version integer PRIMARY KEY, ' +
      'name text NOT NULL UNIQUE, ' +
      "checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'), " +
      'applied_at timestamptz NOT NULL DEFAULT now()' +
      ')',
  );

  for (const appliedMigration of migrations) {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
      await client.query(migrationSqlForSchema(appliedMigration.sql, schemaName));
      await client.query(`INSERT INTO ${schema}.saas_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`, [
        appliedMigration.version,
        appliedMigration.name,
        migrationChecksum(appliedMigration.name, appliedMigration.sql),
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Failed to replay SaaS migration ${String(appliedMigration.version).padStart(3, '0')}`, {
        cause: error,
      });
    }
  }
}

test('migration 050 executes and proves tenant-before-profile writer ordering in PostgreSQL', {
  skip: migration050TestUrl
    ? false
    : 'MODEL_ROUTER_SAAS_MIGRATION_050_TEST_URL is not configured; isolated PostgreSQL schedule test is skipped',
}, async () => {
  if (!migration050TestUrl) return;

  const configuredDatabaseUrl = new URL(migration050TestUrl);
  assert.ok(configuredDatabaseUrl.port, 'the isolated PostgreSQL URL must specify its dedicated port explicitly');
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  assert.ok(
    !loopbackHosts.has(configuredDatabaseUrl.hostname) || Number(configuredDatabaseUrl.port) > 1024,
    'loopback PostgreSQL tests must use a dedicated high port; CI service DNS may use its isolated 5432',
  );

  const pool = new PgPool({
    connectionString: migration050TestUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
  });
  const schemaName = `model_router_saas_m050_${randomUUID().replaceAll('-', '')}`;
  const schema = quoteIdentifier(schemaName);
  let migrationClient: PoolClient | undefined;
  let readerClient: PoolClient | undefined;
  let writerClient: PoolClient | undefined;
  let observerClient: PoolClient | undefined;
  let schemaCreated = false;
  let readerInTransaction = false;
  let writerInTransaction = false;
  let writerUpdate:
    | Promise<{
        rowCount: number | null;
      }>
    | undefined;

  const probeTenant = '00000000-0000-0000-0000-000000000050';
  const probeProfile = 'migration-050-profile-probe';
  const tenantFence = `saas-authz:tenant:${probeTenant}`;
  const profileFence =
    'saas_supply_profile:' +
    Buffer.from(probeTenant, 'utf8').toString('hex') +
    ':' +
    Buffer.from(probeProfile, 'utf8').toString('hex');

  try {
    migrationClient = await pool.connect();
    const serverInfo = await migrationClient.query<{
      server_version: string;
      server_version_num: string;
      port: string;
    }>(
      "SELECT current_setting('server_version') AS server_version, " +
        "current_setting('server_version_num') AS server_version_num, " +
        "current_setting('port') AS port",
    );
    const server = serverInfo.rows[0];
    assert.ok(
      Number(server?.server_version_num) >= 150000,
      'the live migration test requires PostgreSQL 15 or newer, matching the managed role template',
    );
    assert.ok(
      !loopbackHosts.has(configuredDatabaseUrl.hostname) || server?.port !== '5432',
      'the live test must never reach the shared/default loopback PostgreSQL port 5432',
    );

    await migrationClient.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    await replayMigrationsBefore050(migrationClient, schemaName);
    await setMigration050SearchPath(migrationClient, schemaName);

    const historyBefore = await migrationClient.query<{
      count: string;
      max_version: string;
      migration_050_count: string;
    }>(
      `SELECT count(*)::text AS count, max(version)::text AS max_version, ` +
        `count(*) FILTER (WHERE version = 50)::text AS migration_050_count ` +
        `FROM ${schema}.saas_schema_migrations`,
    );
    assert.equal(historyBefore.rows[0]?.count, '49', 'the disposable schema must contain exactly migrations 001–049');
    assert.equal(historyBefore.rows[0]?.max_version, '49', 'the disposable schema migration history must end at 049');
    assert.equal(historyBefore.rows[0]?.migration_050_count, '0', '050 must remain absent from migration history');

    const installedFenceSources = await migrationClient.query<{
      routine_name: string;
      source: string;
    }>(
      'SELECT procedure_record.proname AS routine_name, procedure_record.prosrc AS source ' +
        'FROM pg_proc procedure_record ' +
        'JOIN pg_namespace namespace_record ON namespace_record.oid = procedure_record.pronamespace ' +
        'WHERE namespace_record.nspname = $1 ' +
        'AND procedure_record.proname IN (' +
        "'saas_control_plane_authorization_fence_row', " +
        "'saas_runtime_supply_profile_update_fence', " +
        "'saas_platform_authorization_writer_statement')",
      [schemaName],
    );
    const sourceByName = new Map(installedFenceSources.rows.map(({ routine_name, source }) => [routine_name, source]));
    assert.match(
      sourceByName.get('saas_control_plane_authorization_fence_row') ?? '',
      /pg_advisory_xact_lock\(hashtextextended\(target_fence_key, 0\)\)/,
    );
    assert.match(sourceByName.get('saas_runtime_supply_profile_update_fence') ?? '', /saas_supply_profile:/);
    assert.match(
      sourceByName.get('saas_platform_authorization_writer_statement') ?? '',
      /pg_advisory_xact_lock\(1396788563, 46\)/,
    );

    await migrationClient.query('BEGIN');
    try {
      await migrationClient.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
      await migrationClient.query(migrationSqlForSchema(migration.sql, schemaName));
      await migrationClient.query('COMMIT');
    } catch (error) {
      await migrationClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      migrationClient.release();
      migrationClient = undefined;
    }

    const historyAfter = await pool.query<{
      count: string;
      max_version: string;
      migration_050_count: string;
    }>(
      `SELECT count(*)::text AS count, max(version)::text AS max_version, ` +
        `count(*) FILTER (WHERE version = 50)::text AS migration_050_count ` +
        `FROM ${schema}.saas_schema_migrations`,
    );
    assert.equal(historyAfter.rows[0]?.count, '49', 'migration 050 must not change the existing 049 history');
    assert.equal(
      historyAfter.rows[0]?.max_version,
      '49',
      'migration history must still end at 049 after executing 050',
    );
    assert.equal(
      historyAfter.rows[0]?.migration_050_count,
      '0',
      'the optional execution test must not record migration 050',
    );

    writerClient = await pool.connect();
    readerClient = await pool.connect();
    observerClient = await pool.connect();
    await setMigration050SearchPath(writerClient, schemaName);
    await setMigration050SearchPath(readerClient, schemaName);
    await setMigration050SearchPath(observerClient, schemaName);

    await writerClient.query(
      'CREATE TEMP TABLE migration_050_profile_probe (' +
        'tenant_id uuid NOT NULL, ' +
        'id text PRIMARY KEY, ' +
        'marker integer NOT NULL)',
    );
    await writerClient.query(
      'CREATE TRIGGER a047_global_authorization_writer ' +
        'BEFORE UPDATE ON migration_050_profile_probe ' +
        'FOR EACH STATEMENT ' +
        `EXECUTE FUNCTION ${schema}.saas_platform_authorization_writer_statement()`,
    );
    await writerClient.query(
      'CREATE TRIGGER a050_prepared_profile_fence ' +
        'BEFORE UPDATE ON migration_050_profile_probe ' +
        'FOR EACH ROW ' +
        `EXECUTE FUNCTION ${schema}.saas_prepared_evidence_authorization_writer_fence('profile', 'tenant_id', 'id')`,
    );
    await writerClient.query(
      'CREATE TRIGGER b048_runtime_profile_fence ' +
        'BEFORE UPDATE ON migration_050_profile_probe ' +
        'FOR EACH ROW ' +
        `EXECUTE FUNCTION ${schema}.saas_runtime_supply_profile_update_fence()`,
    );
    await writerClient.query(
      'CREATE TRIGGER c047_after_tenant_fence ' +
        'AFTER UPDATE ON migration_050_profile_probe ' +
        'FOR EACH ROW ' +
        `EXECUTE FUNCTION ${schema}.saas_control_plane_authorization_fence_row('tenant', 'tenant_id')`,
    );
    await writerClient.query('INSERT INTO migration_050_profile_probe (tenant_id, id, marker) VALUES ($1, $2, 0)', [
      probeTenant,
      probeProfile,
    ]);

    await readerClient.query('BEGIN');
    readerInTransaction = true;
    const readerPidResult = await readerClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid');
    const readerPid = readerPidResult.rows[0]?.pid;
    assert.equal(typeof readerPid, 'number');

    await readerClient.query(
      'SELECT pg_catalog.pg_advisory_xact_lock_shared(' + 'pg_catalog.hashtextextended($1, 0))',
      [tenantFence],
    );

    await writerClient.query('BEGIN');
    writerInTransaction = true;
    await writerClient.query("SET LOCAL statement_timeout = '5000ms'");
    const writerPidResult = await writerClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid');
    const writerPid = writerPidResult.rows[0]?.pid;
    assert.equal(typeof writerPid, 'number');

    writerUpdate = writerClient
      .query('UPDATE migration_050_profile_probe ' + 'SET marker = marker + 1 ' + 'WHERE tenant_id = $1 AND id = $2', [
        probeTenant,
        probeProfile,
      ])
      .then(({ rowCount }) => ({ rowCount }));

    let sawWriterWaitingOnReader = false;
    const waitDeadline = Date.now() + 5_000;
    while (Date.now() < waitDeadline) {
      const activity = await observerClient.query<{
        blockers: number[];
        wait_event_type: string | null;
      }>(
        'SELECT pg_catalog.pg_blocking_pids(activity.pid) AS blockers, activity.wait_event_type ' +
          'FROM pg_catalog.pg_stat_activity activity ' +
          'WHERE activity.pid = $1',
        [writerPid],
      );
      const wait = activity.rows[0];
      if (
        wait?.wait_event_type === 'Lock' &&
        Array.isArray(wait.blockers) &&
        wait.blockers.includes(readerPid as number)
      ) {
        sawWriterWaitingOnReader = true;
        break;
      }
      await delay(25);
    }
    assert.equal(
      sawWriterWaitingOnReader,
      true,
      'the writer must wait on the reader-held tenant fence before reaching profile',
    );

    await readerClient.query("SET LOCAL lock_timeout = '750ms'");
    await readerClient.query(
      'SELECT pg_catalog.pg_advisory_xact_lock_shared(' + 'pg_catalog.hashtextextended($1, 0))',
      [profileFence],
    );
    await readerClient.query('COMMIT');
    readerInTransaction = false;

    const updateResult = await writerUpdate;
    assert.equal(updateResult.rowCount, 1);
    await writerClient.query('COMMIT');
    writerInTransaction = false;
  } finally {
    if (readerClient && readerInTransaction) {
      await readerClient.query('ROLLBACK').catch(() => undefined);
    }
    if (writerUpdate) {
      await writerUpdate.catch(() => undefined);
    }
    if (writerClient && writerInTransaction) {
      await writerClient.query('ROLLBACK').catch(() => undefined);
    }
    migrationClient?.release();
    readerClient?.release();
    writerClient?.release();
    observerClient?.release();
    try {
      if (schemaCreated) {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    } finally {
      await pool.end();
    }
  }
});
