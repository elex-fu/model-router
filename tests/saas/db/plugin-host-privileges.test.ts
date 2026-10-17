import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL,
  SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS,
  SAAS_PLUGIN_HOST_RUNTIME_DELETE_TABLES,
  SaasPluginHostPrivilegeError,
  verifyPluginHostRuntimePrivileges,
} from '../../../src/saas/db/plugin-host-privileges.js';

const SAFE_PLUGIN_HOST_PRIVILEGE_ROW = {
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
  unexpected_table_privilege: false,
  missing_delete_privilege_count: 0,
  missing_column_privilege: false,
  extra_column_privilege: false,
  any_sequence_privilege: false,
  any_function_privilege: false,
  out_of_schema_object_privilege: false,
};

test('plugin-host privilege probe grants only the documented reconcile, KV and envelope surface', async () => {
  let queryCount = 0;
  await verifyPluginHostRuntimePrivileges({
    query: async <Row>(sql: string) => {
      queryCount += 1;
      assert.equal(sql, SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL);
      return { rows: [SAFE_PLUGIN_HOST_PRIVILEGE_ROW] as unknown as Row[], rowCount: 1 };
    },
  });
  assert.equal(queryCount, 1);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /expected_column_privileges/);
  // The replica re-verify needs the original signed package bytes: SELECT
  // on artifact_data, but never an UPDATE on any content column.
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_installations', 'artifact_data', 'SELECT'/);
  assert.doesNotMatch(
    SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL,
    /'saas_plugin_installations', '(?:artifact_data|manifest|binary_sha256|signature_status|config_json)', '(?:INSERT|UPDATE)'/,
  );
  // The reconcile CAS writes are exactly the four runtime-health columns.
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_installations', 'state', 'UPDATE'/);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_installations', 'last_error', 'UPDATE'/);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_installations', 'enabled_at', 'UPDATE'/);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_installations', 'updated_at', 'UPDATE'/);
  // Bindings are read-only (control plane owns every binding edit).
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_bindings', 'enabled', 'SELECT'/);
  assert.doesNotMatch(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /'saas_plugin_bindings', '[^']+', '(?:INSERT|UPDATE)'/);
  // The single table-level DELETE is the KV TTL prune.
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /expected_delete_tables/);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /\('saas_plugin_kv'\)/);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /extra_column_privilege/);
  assert.match(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL, /unexpected_table_privilege/);
});

test('plugin-host privilege probe rejects broad grants, unsafe roles and malformed probe responses', async () => {
  for (const unsafeRow of [
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, unexpected_table_privilege: true },
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, missing_delete_privilege_count: 1 },
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, missing_column_privilege: true },
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, extra_column_privilege: true },
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, any_role_membership: true },
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, any_function_privilege: true },
    { ...SAFE_PLUGIN_HOST_PRIVILEGE_ROW, out_of_schema_object_privilege: true },
    {},
  ]) {
    await assert.rejects(
      verifyPluginHostRuntimePrivileges({
        query: async <Row>() => ({ rows: [unsafeRow] as unknown as Row[], rowCount: 1 }),
      }),
      SaasPluginHostPrivilegeError,
    );
  }
});

test('plugin-host manifest covers only the plugin tables and the unseal catalog, never billing or identity', () => {
  const grantedTables = new Set(SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS.map(([table]) => table));
  assert.deepEqual([...grantedTables].sort(), [
    'saas_platform_provider_accounts',
    'saas_platform_provider_credential_versions',
    'saas_platform_provider_credentials',
    'saas_plugin_bindings',
    'saas_plugin_installations',
    'saas_plugin_kv',
    'saas_tenant_provider_accounts',
    'saas_tenant_provider_credential_versions',
    'saas_tenant_provider_credentials',
  ]);
  // Negative assertions: the role must hold nothing outside its manifest.
  for (const forbidden of [
    'saas_billing_groups',
    'saas_billing_group_spend_counters',
    'saas_usage_events',
    'saas_usage_settlements',
    'saas_prepared_request_evidence',
    'saas_users',
    'saas_api_keys',
    'saas_wallet_transactions',
    'saas_platform_settings',
    'saas_schema_migrations',
    'saas_audit_events',
  ]) {
    assert.equal(grantedTables.has(forbidden), false, `plugin-host must have no grant on ${forbidden}`);
  }
  // The envelope-read surface is SELECT-only (the validation-worker
  // precedent): no credential table receives INSERT or UPDATE.
  for (const table of [
    'saas_tenant_provider_accounts',
    'saas_platform_provider_accounts',
    'saas_tenant_provider_credentials',
    'saas_platform_provider_credentials',
    'saas_tenant_provider_credential_versions',
    'saas_platform_provider_credential_versions',
  ]) {
    assert.deepEqual(
      SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS.filter(
        ([relation, , privilege]) => relation === table && privilege !== 'SELECT',
      ),
      [],
      `${table} must be SELECT-only for the plugin host`,
    );
  }
  // The account catalog grants are metadata only — no quota, validation or
  // scheduling state.
  assert.deepEqual(
    SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS.filter(
      ([relation, , privilege]) => relation === 'saas_tenant_provider_accounts' && privilege === 'SELECT',
    )
      .map(([, column]) => column)
      .sort(),
    ['credential_type', 'display_name', 'id', 'product_id', 'provider_id', 'status', 'tenant_id'],
  );
  assert.deepEqual(SAAS_PLUGIN_HOST_RUNTIME_DELETE_TABLES, ['saas_plugin_kv']);
});

test('deployment plugin-host grant script mirrors the TS manifest exactly and grants nothing broad', () => {
  const sql = readFileSync(resolve(process.cwd(), 'deploy/managed-saas-plugin-host-role-grants.sql'), 'utf8');
  assert.match(sql, /model_router_saas_plugin_host/);
  assert.match(sql, /LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);

  const deployedColumnGrants = [
    ...sql.matchAll(
      /GRANT\s+(SELECT|INSERT|UPDATE)\s*\(([^)]*)\)\s*ON TABLE model_router_saas\.(\w+)\s+TO model_router_saas_plugin_host;/gs,
    ),
  ]
    .flatMap((match) =>
      (match[2] ?? '')
        .split(/\s*,\s*/)
        .map((column) => column.trim())
        .filter((column) => column !== '')
        .map((column) => `${match[3]}\t${column}\t${match[1]}`),
    )
    .sort();
  assert.deepEqual(
    deployedColumnGrants,
    SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS.map(
      ([table, column, privilege]) => `${table}\t${column}\t${privilege}`,
    ).sort(),
    'the plugin-host template must contain no missing, duplicate or excess column grant',
  );

  const deployedDeleteTables = [
    ...sql.matchAll(/GRANT\s+DELETE\s+ON TABLE model_router_saas\.(\w+)\s+TO model_router_saas_plugin_host;/g),
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(deployedDeleteTables, [...SAAS_PLUGIN_HOST_RUNTIME_DELETE_TABLES].sort());

  // No broad or default grants, no role mutations beyond the template.
  assert.doesNotMatch(sql, /GRANT\s+ALL\b/i);
  assert.doesNotMatch(sql, /GRANT[^;]*\bON\s+ALL\s+TABLES/is);
  assert.doesNotMatch(sql, /GRANT[^;]*\bON\s+ALL\s+SEQUENCES/is);
  assert.doesNotMatch(sql, /GRANT\s+EXECUTE\b/i);
  assert.doesNotMatch(sql, /ALTER DEFAULT PRIVILEGES/is);
  assert.doesNotMatch(sql, /\bDROP\s+OWNED|REASSIGN\s+OWNED\b/i);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS/);
  assert.match(sql, /migrations include version 128/);
  // Only column-scoped SELECT/INSERT/UPDATE plus the single KV DELETE: no
  // other statement form may grant this role anything.
  const grantStatements = [...sql.matchAll(/GRANT\b[^;]*;/gs)].map((match) => match[0].replace(/\s+/g, ' ').trim());
  for (const statement of grantStatements) {
    assert.match(
      statement,
      /^GRANT (?:SELECT|INSERT|UPDATE) \(|DELETE ON TABLE model_router_saas\.saas_plugin_kv|USAGE ON SCHEMA model_router_saas|CONNECT ON DATABASE/,
      `unexpected plugin-host grant statement: ${statement}`,
    );
  }
});
