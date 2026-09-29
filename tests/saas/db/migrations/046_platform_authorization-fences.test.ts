import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/024_prepared_request_evidence.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import {
  SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS,
  SAAS_GATEWAY_RUNTIME_READ_TABLES,
} from '../../../../src/saas/db/runtime-privileges.js';

const migration = PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION;

function migrationTextConstant(name: string): string {
  const marker = `${name} constant text := $${name}$`;
  const start = migration.sql.indexOf(marker);
  assert.notEqual(start, -1, `migration must declare ${name}`);
  const contentStart = start + marker.length;
  const end = migration.sql.indexOf(`$${name}$;`, contentStart);
  assert.notEqual(end, -1, `migration must terminate ${name}`);
  return migration.sql.slice(contentStart, end);
}

function replaceExactlyOnce(source: string, before: string, after: string, description: string): string {
  assert.equal(source.split(before).length - 1, 1, `expected one ${description} in migration 024`);
  return source.replace(before, after);
}

test('migration 046 installs transaction-scoped per-user authorization fences', () => {
  assert.equal(migration.version, 46);
  assert.equal(migration.name, 'platform_authorization_fences');
  assert.match(migration.sql, /pg_advisory_xact_lock\(hashtextextended\(target_user_id::text, 0\)\)/);
  assert.match(migration.sql, /pg_advisory_xact_lock\(1396788563, 46\)/);
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_platform_role_assignments_authorization_writer\s+BEFORE INSERT OR UPDATE OR DELETE ON saas_platform_role_assignments\s+FOR EACH STATEMENT/,
  );
  assert.match(migration.sql, /ORDER BY candidate\.user_id/);
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_platform_role_assignments_authorization_fence\s+AFTER INSERT OR UPDATE OR DELETE ON saas_platform_role_assignments/,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_platform_sessions_authorization_fence\s+AFTER INSERT OR UPDATE OF id, user_id, credential_id, token_hash, csrf_token_hash, expires_at, revoked_at OR DELETE\s+ON saas_platform_sessions/,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_users_platform_authorization_fence\s+AFTER UPDATE OF disabled_at, anonymized_at, email, password_hash ON saas_users/,
  );
  assert.match(
    migration.sql,
    /CREATE TRIGGER saas_mfa_credentials_platform_authorization_fence\s+AFTER INSERT OR DELETE OR UPDATE OF id, user_id, kind, credential_id,[\s\S]*?verified_at, revoked_at/,
  );
  assert.doesNotMatch(migration.sql, /BEFORE INSERT OR DELETE OR UPDATE OF[\s\S]*?last_used_step/);
  assert.match(migration.sql, /PERFORM set_config\('lock_timeout', '2s', TRUE\)/);
  assert.match(migration.sql, /PERFORM set_config\('statement_timeout', '10s', TRUE\)/);
  assert.doesNotMatch(migration.sql, /GRANT\s+UPDATE\s+ON\s+(?:TABLE\s+)?saas_platform_role_assignments/i);
  assert.doesNotMatch(migration.sql, /GRANT\s+UPDATE\s+ON\s+(?:TABLE\s+)?saas_project_inference_policy_versions/i);
});

test('migration 046 narrows project-service proof and removes only immutable history row locking', () => {
  assert.match(migration.sql, /pg_get_functiondef\(function_oid\)/);
  assert.match(migration.sql, /policy_history_lock_pattern constant text/);
  assert.match(migration.sql, /history_lock_count <> 1/);
  assert.match(migration.sql, /member_principal_guard constant text/);
  assert.match(migration.sql, /conditional_member_guard constant text/);
  assert.match(migration.sql, /key_record\.principal_user_id IS DISTINCT FROM NEW\.principal_id/);
  assert.match(migration.sql, /key_record\.principal_user_id IS NOT NULL/);
  assert.match(migration.sql, /NEW\.principal_id IS DISTINCT FROM NEW\.project_id/);
  assert.match(migration.sql, /regexp_replace\([\s\S]*?'g'\s*\);/);
  assert.match(migration.sql, /AND version = NEW\[\.\]project_policy_version\[\[:space:\]\]\+FOR SHARE;/);
  assert.match(migration.sql, /installed_source IS DISTINCT FROM expected_source/);
  assert.match(migration.sql, /Prepared-request evidence guard rewrite changed an unapproved clause/);

  const originalMatch = PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION.sql.match(
    /CREATE FUNCTION saas_prepared_request_evidence_guard\(\) RETURNS trigger\nLANGUAGE plpgsql AS \$\$([\s\S]*?)\n\$\$;/,
  );
  assert.ok(originalMatch, 'migration 024 must define the prepared-evidence guard');
  const original = originalMatch[1];
  const oldUnsupportedService = migrationTextConstant('unsupported_project_service_guard');
  const newProjectServiceGuard = migrationTextConstant('project_service_guard_replacement');
  const oldMemberGuard = migrationTextConstant('member_principal_guard');
  const conditionalMemberGuard = migrationTextConstant('conditional_member_guard');
  const oldKeyPrincipalMatch = migrationTextConstant('key_principal_match');
  const newKeyPrincipalGuard = migrationTextConstant('key_principal_replacement');
  const historyLockPattern = /AND version = NEW\.project_policy_version\s+FOR SHARE;/g;

  let expected = replaceExactlyOnce(
    original,
    oldUnsupportedService,
    newProjectServiceGuard,
    'project-service principal rejection',
  );
  expected = replaceExactlyOnce(expected, oldMemberGuard, conditionalMemberGuard, 'member identity proof');
  expected = replaceExactlyOnce(expected, oldKeyPrincipalMatch, newKeyPrincipalGuard, 'execution-principal proof');
  assert.equal([...expected.matchAll(historyLockPattern)].length, 1);
  expected = expected.replace(historyLockPattern, 'AND version = NEW.project_policy_version;');

  // Migration 046 uses these exact replacements and compares the installed full
  // function source to this expected source. Thus every other 024 guard clause
  // (including mutable project-head locking and key/entitlement/supply/mode
  // bindings) remains byte-for-byte identical.
  assert.match(migration.sql, /expected_source := replace\([\s\S]*?function_source/);
  assert.match(migration.sql, /installed_source IS DISTINCT FROM expected_source/);
  assert.match(expected, /FROM saas_tenants WHERE id = NEW\.tenant_id AND status = 'active' FOR SHARE/);
  assert.match(expected, /FROM saas_projects p[\s\S]*?FOR SHARE;/);
  assert.match(expected, /key_record\.entitlement_id IS DISTINCT FROM NEW\.entitlement_id/);
  assert.match(expected, /key_record\.supply_mode IS DISTINCT FROM NEW\.supply_mode/);
  assert.match(expected, /Prepared-request evidence request is missing/);
  assert.match(expected, /NEW\.principal_id IS DISTINCT FROM NEW\.project_id/);
  assert.match(expected, /NEW\.principal_kind = 'member'[\s\S]*?saas_memberships[\s\S]*?saas_project_memberships/);
  assert.doesNotMatch(expected, /project_policy_version\s+FOR SHARE/);
  assert.doesNotMatch(expected, /Project-service prepared-request evidence is unsupported/);
});

test('migration 046 leaves SELECT-only member row locks for the ordered 047 fence replacement', () => {
  assert.match(
    migration.sql,
    /Forward-migration dependency:[\s\S]*Migration 047 installs the matching tenant,[\s\S]*project, and per-user authorization writer fences/,
  );

  const originalGuard = PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION.sql.match(
    /CREATE FUNCTION saas_prepared_request_evidence_guard\(\) RETURNS trigger\nLANGUAGE plpgsql AS \$\$([\s\S]*?)\n\$\$;/,
  );
  assert.ok(originalGuard, 'migration 024 must define the prepared-evidence guard');
  const mutableHeadTables = ['saas_tenants', 'saas_projects'];
  for (const table of mutableHeadTables) {
    assert.match(originalGuard[1], new RegExp(`FROM ${table}[\\s\\S]*?FOR SHARE;`));
    assert.ok(
      SAAS_GATEWAY_RUNTIME_READ_TABLES.some((readTable) => readTable === table),
      `${table} must remain readable by the gateway runtime role`,
    );
    assert.equal(
      SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
        ([grantTable, , privilege]) => grantTable === table && privilege === 'UPDATE',
      ),
      false,
      `${table} must not gain gateway UPDATE merely to satisfy a row-lock clause`,
    );
  }

  const memberGuard = migrationTextConstant('conditional_member_guard');
  const customerIdentityTables = ['saas_users', 'saas_memberships', 'saas_project_memberships'];
  for (const table of customerIdentityTables) {
    assert.match(memberGuard, new RegExp(`FROM ${table}[\\s\\S]*?FOR SHARE;`));
    assert.ok(
      SAAS_GATEWAY_RUNTIME_READ_TABLES.some((readTable) => readTable === table),
      `${table} must remain readable by the gateway runtime role`,
    );
    assert.equal(
      SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
        ([grantTable, , privilege]) => grantTable === table && privilege === 'UPDATE',
      ),
      false,
      `${table} must not gain gateway UPDATE merely to satisfy a row-lock clause`,
    );
  }
  assert.doesNotMatch(originalGuard[1], /SECURITY DEFINER/i);
});
