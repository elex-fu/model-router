import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
  SaasCredentialValidationWorkerPrivilegeError,
  verifyCredentialValidationWorkerRuntimePrivileges,
} from '../../../src/saas/db/credential-validation-worker-privileges.js';

const SAFE_WORKER_PRIVILEGE_ROW = {
  role_exists: true,
  server_version_supported: true,
  managed_schema: true,
  login_role: true,
  session_role_unchanged: true,
  superuser: false,
  create_database: false,
  create_role: false,
  replication_role: false,
  bypass_rls: false,
  any_role_membership: false,
  owns_database: false,
  owns_schema: false,
  owns_objects: false,
  schema_create: false,
  database_create: false,
  database_temp: false,
  no_database_connect: false,
  any_table_level_privilege: false,
  missing_column_privilege: false,
  extra_column_privilege: false,
  any_sequence_privilege: false,
  any_function_privilege: false,
  out_of_schema_object_privilege: false,
};

test('worker privilege probe grants only the documented column-level snapshot and health writes', async () => {
  let queryCount = 0;
  await verifyCredentialValidationWorkerRuntimePrivileges({
    query: async <Row>(sql: string) => {
      queryCount += 1;
      assert.equal(sql, SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL);
      return { rows: [SAFE_WORKER_PRIVILEGE_ROW] as unknown as Row[], rowCount: 1 };
    },
  });
  assert.equal(queryCount, 1);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /expected_column_privileges/);
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_rights', 'endpoint_scope', 'SELECT'/,
  );
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_provider_capabilities', 'validation_state', 'SELECT'/,
  );
  assert.match(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_tenant_provider_account_capabilities', 'capability_version', 'SELECT'/,
  );
  for (const column of [
    'tenant_id',
    'account_id',
    'credential_id',
    'credential_version',
    'wrapping_revision',
    'kms_key_id',
    'wrapped_dek',
  ]) {
    assert.match(
      SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
      new RegExp(`'saas_tenant_provider_credential_wrappings', '${column}', 'SELECT'`),
    );
  }
  assert.doesNotMatch(
    SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL,
    /'saas_tenant_provider_credential_wrappings', '[^']+', '(?:INSERT|UPDATE|REFERENCES)'/,
  );
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /extra_column_privilege/);
  assert.match(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL, /any_table_level_privilege/);
});

test('worker privilege probe rejects broad grants, unsafe roles and malformed probe responses', async () => {
  for (const unsafeRow of [
    { ...SAFE_WORKER_PRIVILEGE_ROW, any_table_level_privilege: true },
    { ...SAFE_WORKER_PRIVILEGE_ROW, extra_column_privilege: true },
    { ...SAFE_WORKER_PRIVILEGE_ROW, any_role_membership: true },
    { ...SAFE_WORKER_PRIVILEGE_ROW, any_function_privilege: true },
    {},
  ]) {
    await assert.rejects(
      verifyCredentialValidationWorkerRuntimePrivileges({
        query: async <Row>() => ({ rows: [unsafeRow] as unknown as Row[], rowCount: 1 }),
      }),
      SaasCredentialValidationWorkerPrivilegeError,
    );
  }
});

test('deployment grant script exposes only the worker role’s column-scoped permissions', () => {
  const sql = readFileSync(
    new URL('../../../deploy/managed-saas-validation-worker-role-grants.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /model_router_saas_validation_worker/);
  assert.match(sql, /GRANT SELECT \(/);
  assert.match(sql, /GRANT UPDATE \(/);
  assert.match(sql, /ON TABLE model_router_saas\.saas_provider_rights/);
  assert.match(sql, /ON TABLE model_router_saas\.saas_provider_capabilities/);
  assert.match(sql, /ON TABLE model_router_saas\.saas_tenant_provider_account_capabilities/);
  assert.match(
    sql,
    /GRANT SELECT \(\s*tenant_id, account_id, credential_id, credential_version,\s*wrapping_revision, kms_key_id, wrapped_dek\s*\) ON TABLE model_router_saas\.saas_tenant_provider_credential_wrappings\s+TO model_router_saas_validation_worker;/,
  );
  assert.doesNotMatch(sql, /GRANT UPDATE \([^)]*\) ON TABLE model_router_saas\.saas_provider_/s);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE)\b[^;]*saas_tenant_provider_credential_wrappings/is);
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)\s*,/i);
  assert.doesNotMatch(sql, /GRANT\s+DELETE\b/i);
  assert.doesNotMatch(sql, /GRANT\s+INSERT\b/i);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS/);
});
