import type { SqlExecutor } from './types.js';

export class SaasPluginHostPrivilegeError extends Error {
  readonly code = 'SAAS_PLUGIN_HOST_PRIVILEGES_UNSAFE' as const;

  constructor() {
    super('Managed SaaS plugin-host PostgreSQL privileges do not satisfy the plugin-host policy');
    this.name = 'SaasPluginHostPrivilegeError';
  }
}

export type SaasPluginHostColumnGrant = readonly [
  table: string,
  column: string,
  privilege: 'SELECT' | 'INSERT' | 'UPDATE',
];

/**
 * The plugin-host workload (batch-5 §5.1; the credential-validation-worker
 * least-privilege precedent applied to third-party plugin child processes)
 * receives:
 *
 * - column-level SELECT on the FULL installation rows (artifact_data
 *   included — any replica must be able to re-verify the signature chain
 *   and re-extract the entrypoint) and column-level UPDATE on exactly the
 *   four reconcile CAS columns (state, last_error, enabled_at, updated_at);
 * - SELECT on the binding rows (routing truth for the reconcile loop);
 * - full column DML on the host-service KV table plus its single
 *   table-level DELETE (expired TTL rows are pruned on the read path);
 * - the account/credential catalog and envelope columns needed for the
 *   restricted unseal: account metadata (never validation/quota state) and
 *   the sealed credential-version envelope (the exact column surface the
 *   credential-validation worker already holds — the established
 *   envelope-read precedent). No plaintext credential column exists on any
 *   of these tables; the unseal happens in-process through the
 *   decrypt-only KMS module.
 *
 * It has no other table-level grants, no sequence access and no routine
 * EXECUTE (the plugin tables' CHECK constraints use built-ins only). The
 * control plane owns installation/binding writes; the gateway reads routing
 * truth through its own manifest.
 */
export const SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS: readonly SaasPluginHostColumnGrant[] = [
  ['saas_plugin_installations', 'id', 'SELECT'],
  ['saas_plugin_installations', 'plugin_key', 'SELECT'],
  ['saas_plugin_installations', 'name', 'SELECT'],
  ['saas_plugin_installations', 'version', 'SELECT'],
  ['saas_plugin_installations', 'description', 'SELECT'],
  ['saas_plugin_installations', 'author', 'SELECT'],
  ['saas_plugin_installations', 'manifest', 'SELECT'],
  ['saas_plugin_installations', 'manifest_sha256', 'SELECT'],
  ['saas_plugin_installations', 'entrypoint_path', 'SELECT'],
  ['saas_plugin_installations', 'binary_sha256', 'SELECT'],
  ['saas_plugin_installations', 'signature_status', 'SELECT'],
  ['saas_plugin_installations', 'state', 'SELECT'],
  ['saas_plugin_installations', 'config_json', 'SELECT'],
  ['saas_plugin_installations', 'last_error', 'SELECT'],
  ['saas_plugin_installations', 'artifact_data', 'SELECT'],
  ['saas_plugin_installations', 'artifact_sha256', 'SELECT'],
  ['saas_plugin_installations', 'installed_by', 'SELECT'],
  ['saas_plugin_installations', 'installed_at', 'SELECT'],
  ['saas_plugin_installations', 'updated_at', 'SELECT'],
  ['saas_plugin_installations', 'enabled_at', 'SELECT'],
  // The reconcile loop's CAS writes: only the runtime-health columns. Every
  // content column (manifest, artifact bytes, signature chain) stays
  // control-plane-owned.
  ['saas_plugin_installations', 'state', 'UPDATE'],
  ['saas_plugin_installations', 'last_error', 'UPDATE'],
  ['saas_plugin_installations', 'enabled_at', 'UPDATE'],
  ['saas_plugin_installations', 'updated_at', 'UPDATE'],
  ['saas_plugin_bindings', 'id', 'SELECT'],
  ['saas_plugin_bindings', 'installation_id', 'SELECT'],
  ['saas_plugin_bindings', 'capability', 'SELECT'],
  ['saas_plugin_bindings', 'platform', 'SELECT'],
  ['saas_plugin_bindings', 'account_type', 'SELECT'],
  ['saas_plugin_bindings', 'enabled', 'SELECT'],
  ['saas_plugin_bindings', 'rollout_percent', 'SELECT'],
  ['saas_plugin_bindings', 'created_at', 'SELECT'],
  ['saas_plugin_bindings', 'updated_at', 'SELECT'],
  // Host-service KV: full column DML (the upsert writes every column and
  // the conflict-path UPDATE touches value/expires_at/updated_at).
  ['saas_plugin_kv', 'plugin_key', 'SELECT'],
  ['saas_plugin_kv', 'namespace', 'SELECT'],
  ['saas_plugin_kv', 'key', 'SELECT'],
  ['saas_plugin_kv', 'value', 'SELECT'],
  ['saas_plugin_kv', 'expires_at', 'SELECT'],
  ['saas_plugin_kv', 'updated_at', 'SELECT'],
  ['saas_plugin_kv', 'plugin_key', 'INSERT'],
  ['saas_plugin_kv', 'namespace', 'INSERT'],
  ['saas_plugin_kv', 'key', 'INSERT'],
  ['saas_plugin_kv', 'value', 'INSERT'],
  ['saas_plugin_kv', 'expires_at', 'INSERT'],
  ['saas_plugin_kv', 'updated_at', 'INSERT'],
  ['saas_plugin_kv', 'value', 'UPDATE'],
  ['saas_plugin_kv', 'expires_at', 'UPDATE'],
  ['saas_plugin_kv', 'updated_at', 'UPDATE'],
  // Account catalog: metadata only (identity, provider/product, credential
  // type, status, display name) — never quota, validation or scheduling
  // state, and never credential material.
  ['saas_tenant_provider_accounts', 'id', 'SELECT'],
  ['saas_tenant_provider_accounts', 'tenant_id', 'SELECT'],
  ['saas_tenant_provider_accounts', 'provider_id', 'SELECT'],
  ['saas_tenant_provider_accounts', 'product_id', 'SELECT'],
  ['saas_tenant_provider_accounts', 'credential_type', 'SELECT'],
  ['saas_tenant_provider_accounts', 'status', 'SELECT'],
  ['saas_tenant_provider_accounts', 'display_name', 'SELECT'],
  ['saas_platform_provider_accounts', 'id', 'SELECT'],
  ['saas_platform_provider_accounts', 'provider_id', 'SELECT'],
  ['saas_platform_provider_accounts', 'product_id', 'SELECT'],
  ['saas_platform_provider_accounts', 'credential_type', 'SELECT'],
  ['saas_platform_provider_accounts', 'status', 'SELECT'],
  ['saas_platform_provider_accounts', 'display_name', 'SELECT'],
  // Credential heads: exactly the account→credential→version join keys.
  ['saas_tenant_provider_credentials', 'id', 'SELECT'],
  ['saas_tenant_provider_credentials', 'tenant_id', 'SELECT'],
  ['saas_tenant_provider_credentials', 'account_id', 'SELECT'],
  ['saas_tenant_provider_credentials', 'provider_id', 'SELECT'],
  ['saas_tenant_provider_credentials', 'product_id', 'SELECT'],
  ['saas_tenant_provider_credentials', 'credential_type', 'SELECT'],
  ['saas_tenant_provider_credentials', 'current_version', 'SELECT'],
  ['saas_tenant_provider_credentials', 'status', 'SELECT'],
  ['saas_platform_provider_credentials', 'id', 'SELECT'],
  ['saas_platform_provider_credentials', 'account_id', 'SELECT'],
  ['saas_platform_provider_credentials', 'provider_id', 'SELECT'],
  ['saas_platform_provider_credentials', 'product_id', 'SELECT'],
  ['saas_platform_provider_credentials', 'credential_type', 'SELECT'],
  ['saas_platform_provider_credentials', 'current_version', 'SELECT'],
  ['saas_platform_provider_credentials', 'status', 'SELECT'],
  // Sealed envelope read for the restricted unseal — the exact column
  // surface the credential-validation worker already holds (migration 015
  // tables; the established envelope-read precedent).
  ['saas_tenant_provider_credential_versions', 'tenant_id', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'account_id', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'credential_id', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'version', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'status', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'schema_version', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'context_version', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'algorithm', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'kms_purpose', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'kms_key_id', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'wrapping_revision', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'wrapped_dek', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'nonce', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'ciphertext', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'auth_tag', 'SELECT'],
  ['saas_tenant_provider_credential_versions', 'expires_at', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'account_id', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'credential_id', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'version', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'status', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'schema_version', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'context_version', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'algorithm', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'kms_purpose', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'kms_key_id', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'wrapping_revision', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'wrapped_dek', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'nonce', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'ciphertext', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'auth_tag', 'SELECT'],
  ['saas_platform_provider_credential_versions', 'expires_at', 'SELECT'],
] as const;

/**
 * The plugin-host's single table-level privilege: the KV TTL prune DELETE.
 * Every other table-level privilege (and every other DELETE) is forbidden —
 * installation/binding lifecycle deletes stay on the control-plane role.
 */
export const SAAS_PLUGIN_HOST_RUNTIME_DELETE_TABLES = ['saas_plugin_kv'] as const;

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const pluginHostColumnValues = SAAS_PLUGIN_HOST_RUNTIME_COLUMN_GRANTS.map(
  ([table, column, privilege]) => `(${sqlText(table)}, ${sqlText(column)}, ${sqlText(privilege)})`,
).join(',\n    ');
const pluginHostDeleteValues = SAAS_PLUGIN_HOST_RUNTIME_DELETE_TABLES.map((table) => `(${sqlText(table)})`).join(', ');

interface PluginHostPrivilegeProbeRow {
  readonly role_exists: boolean;
  readonly server_version_supported: boolean;
  readonly managed_schema: boolean;
  readonly login_role: boolean;
  readonly session_role_unchanged: boolean;
  readonly superuser: boolean;
  readonly create_database: boolean;
  readonly create_role: boolean;
  readonly replication_role: boolean;
  readonly bypass_rls: boolean;
  readonly any_role_membership: boolean;
  readonly owns_database: boolean;
  readonly owns_schema: boolean;
  readonly owns_objects: boolean;
  readonly schema_create: boolean;
  readonly database_create: boolean;
  readonly database_temp: boolean;
  readonly no_database_connect: boolean;
  readonly unexpected_table_privilege: boolean;
  readonly missing_delete_privilege_count: number | string;
  readonly missing_column_privilege: boolean;
  readonly extra_column_privilege: boolean;
  readonly any_sequence_privilege: boolean;
  readonly any_function_privilege: boolean;
  readonly out_of_schema_object_privilege: boolean;
}

/**
 * Fail-closed catalog probe (the credential-validation-worker probe shape):
 * the role must exist as a plain login, keep the managed search_path, hold
 * every expected column privilege on every expected table, hold the single
 * expected table-level DELETE, and hold nothing else — no table-level DML,
 * no sequences, no routine EXECUTE, no ownership, no memberships, no
 * out-of-schema object access.
 */
export const SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL = `
WITH RECURSIVE runtime_role AS (
  SELECT oid, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
),
application_schema AS (
  SELECT oid, nspname FROM pg_catalog.pg_namespace WHERE nspname = 'model_router_saas'
),
role_closure(role_oid) AS (
  SELECT oid FROM runtime_role
  UNION
  SELECT membership.roleid
  FROM pg_catalog.pg_auth_members AS membership
  JOIN role_closure AS parent_role ON parent_role.role_oid = membership.member
),
expected_column_privileges(table_name, column_name, privilege_type) AS (
  VALUES
    ${pluginHostColumnValues}
),
expected_delete_tables(table_name) AS (VALUES ${pluginHostDeleteValues})
SELECT
  EXISTS (SELECT 1 FROM runtime_role) AS role_exists,
  pg_catalog.current_setting('server_version_num')::integer >= 150000 AS server_version_supported,
  (
    pg_catalog.current_schema() = 'model_router_saas'
    AND pg_catalog.current_setting('search_path') = 'model_router_saas'
    AND pg_catalog.current_schemas(false) = ARRAY['model_router_saas']::pg_catalog.name[]
    AND pg_catalog.current_schemas(true) = ARRAY['pg_catalog', 'model_router_saas']::pg_catalog.name[]
  ) AS managed_schema,
  coalesce((SELECT rolcanlogin FROM runtime_role), false) AS login_role,
  current_user = session_user AS session_role_unchanged,
  coalesce((SELECT rolsuper FROM runtime_role), true) AS superuser,
  coalesce((SELECT rolcreatedb FROM runtime_role), true) AS create_database,
  coalesce((SELECT rolcreaterole FROM runtime_role), true) AS create_role,
  coalesce((SELECT rolreplication FROM runtime_role), true) AS replication_role,
  coalesce((SELECT rolbypassrls FROM runtime_role), true) AS bypass_rls,
  EXISTS (SELECT 1 FROM role_closure WHERE role_oid <> (SELECT oid FROM runtime_role)) AS any_role_membership,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_database
    WHERE datname = pg_catalog.current_database() AND datdba = (SELECT oid FROM runtime_role)
  ) AS owns_database,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE oid = (SELECT oid FROM application_schema) AND nspowner = (SELECT oid FROM runtime_role)
  ) AS owns_schema,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend AS dependency
    JOIN pg_catalog.pg_database AS db ON db.datname = pg_catalog.current_database()
    WHERE dependency.dbid = db.oid
      AND dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = (SELECT oid FROM runtime_role)
      AND dependency.deptype = 'o'
  ) AS owns_objects,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema', 'model_router_saas')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(current_user, namespace.oid, 'CREATE')
  ) OR pg_catalog.has_schema_privilege(current_user, 'model_router_saas', 'CREATE') AS schema_create,
  coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE'), true) AS database_create,
  coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP'), true) AS database_temp,
  NOT coalesce(pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CONNECT'), false) AS no_database_connect,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.oid = (SELECT oid FROM application_schema)
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
        OR CASE
          WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
            THEN pg_catalog.has_table_privilege(current_user, relation.oid, 'MAINTAIN')
          ELSE false
        END
        OR (
          pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
          AND NOT EXISTS (
            SELECT 1 FROM expected_delete_tables AS expected
            WHERE expected.table_name = relation.relname
          )
        )
      )
  ) AS unexpected_table_privilege,
  (SELECT pg_catalog.count(*)::integer
   FROM expected_delete_tables AS expected
   LEFT JOIN pg_catalog.pg_class AS relation
     ON relation.relname = expected.table_name
    AND relation.relnamespace = (SELECT oid FROM application_schema)
    AND relation.relkind IN ('r', 'p')
   WHERE relation.oid IS NULL
      OR NOT pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE'))
    AS missing_delete_privilege_count,
  EXISTS (
    SELECT 1
    FROM expected_column_privileges AS expected
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.relname = expected.table_name
     AND relation.relnamespace = (SELECT oid FROM application_schema)
     AND relation.relkind IN ('r', 'p')
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE relation.oid IS NULL
       OR attribute.attnum IS NULL
       OR NOT pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attname, expected.privilege_type)
  ) AS missing_column_privilege,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS actual(privilege_type)
    WHERE namespace.oid = (SELECT oid FROM application_schema)
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attname, actual.privilege_type)
      AND NOT EXISTS (
        SELECT 1 FROM expected_column_privileges AS expected
        WHERE expected.table_name = relation.relname
          AND expected.column_name = attribute.attname
          AND expected.privilege_type = actual.privilege_type
      )
  ) AS extra_column_privilege,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind = 'S'
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND (
        pg_catalog.has_sequence_privilege(current_user, relation.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_sequence_privilege(current_user, relation.oid, 'UPDATE')
      )
  ) AS any_sequence_privilege,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_function_privilege(current_user, routine.oid, 'EXECUTE')
  ) AS any_function_privilege,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (
        pg_catalog.has_table_privilege(current_user, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'DELETE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(current_user, relation.oid, 'TRIGGER')
        OR CASE
          WHEN pg_catalog.current_setting('server_version_num')::integer >= 170000
            THEN pg_catalog.has_table_privilege(current_user, relation.oid, 'MAINTAIN')
          ELSE false
        END
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.oid <> (SELECT oid FROM application_schema)
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attname, 'SELECT')
        OR pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attname, 'INSERT')
        OR pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attname, 'UPDATE')
        OR pg_catalog.has_column_privilege(current_user, relation.oid, attribute.attname, 'REFERENCES')
      )
  ) AS out_of_schema_object_privilege
` as const;

function isProbeRow(value: unknown): value is PluginHostPrivilegeProbeRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return [
    'role_exists',
    'server_version_supported',
    'managed_schema',
    'login_role',
    'session_role_unchanged',
    'superuser',
    'create_database',
    'create_role',
    'replication_role',
    'bypass_rls',
    'any_role_membership',
    'owns_database',
    'owns_schema',
    'owns_objects',
    'schema_create',
    'database_create',
    'database_temp',
    'no_database_connect',
    'unexpected_table_privilege',
    'missing_delete_privilege_count',
    'missing_column_privilege',
    'extra_column_privilege',
    'any_sequence_privilege',
    'any_function_privilege',
    'out_of_schema_object_privilege',
  ].every((key) =>
    key === 'missing_delete_privilege_count'
      ? typeof row[key] === 'number' || typeof row[key] === 'string'
      : typeof row[key] === 'boolean',
  );
}

function deleteCountValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

export async function verifyPluginHostRuntimePrivileges(database: Pick<SqlExecutor, 'query'>): Promise<void> {
  try {
    const result = await database.query<PluginHostPrivilegeProbeRow>(SAAS_PLUGIN_HOST_PRIVILEGE_PROBE_SQL);
    if (result.rows.length !== 1 || !isProbeRow(result.rows[0])) {
      throw new SaasPluginHostPrivilegeError();
    }
    const row = result.rows[0];
    if (
      !row.role_exists ||
      !row.server_version_supported ||
      !row.managed_schema ||
      !row.login_role ||
      !row.session_role_unchanged ||
      row.superuser ||
      row.create_database ||
      row.create_role ||
      row.replication_role ||
      row.bypass_rls ||
      row.any_role_membership ||
      row.owns_database ||
      row.owns_schema ||
      row.owns_objects ||
      row.schema_create ||
      row.database_create ||
      row.database_temp ||
      row.no_database_connect ||
      row.unexpected_table_privilege ||
      deleteCountValue(row.missing_delete_privilege_count) !== 0 ||
      row.missing_column_privilege ||
      row.extra_column_privilege ||
      row.any_sequence_privilege ||
      row.any_function_privilege ||
      row.out_of_schema_object_privilege
    ) {
      throw new SaasPluginHostPrivilegeError();
    }
  } catch (error) {
    if (error instanceof SaasPluginHostPrivilegeError) throw error;
    throw new SaasPluginHostPrivilegeError();
  }
}
