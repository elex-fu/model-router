import type { SqlExecutor } from './types.js';

export class SaasCredentialValidationWorkerPrivilegeError extends Error {
  readonly code = 'SAAS_VALIDATION_WORKER_PRIVILEGES_UNSAFE' as const;

  constructor() {
    super('Managed SaaS credential-validation worker PostgreSQL privileges do not satisfy the worker policy');
    this.name = 'SaasCredentialValidationWorkerPrivilegeError';
  }
}

interface WorkerPrivilegeProbeRow {
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
  readonly any_table_level_privilege: boolean;
  readonly missing_column_privilege: boolean;
  readonly extra_column_privilege: boolean;
  readonly any_sequence_privilege: boolean;
  readonly any_function_privilege: boolean;
  readonly out_of_schema_object_privilege: boolean;
}

/**
 * The worker receives column-level SELECT on its immutable job/credential
 * snapshot and live provider authority rows, plus column-level UPDATE on job
 * leases and credential health state. It has no table-level grants, DML on
 * catalog tables, sequence access, or application function execution.
 */
export const SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL = `
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
    ('saas_tenant_provider_credential_validation_jobs', 'id', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'tenant_id', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'account_id', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'credential_id', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'credential_version', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'provider_id', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'product_id', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'credential_type', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'allowed_models', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'target_model', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'target_endpoint', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'capability_version', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'idempotency_key', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'status', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'attempt_count', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'available_at', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'lease_until', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'lease_generation', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'last_error_code', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'completed_at', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'created_at', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'updated_at', 'SELECT'),
    ('saas_tenant_provider_credential_validation_jobs', 'status', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'attempt_count', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'available_at', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'lease_until', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'lease_generation', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'last_error_code', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'completed_at', 'UPDATE'),
    ('saas_tenant_provider_credential_validation_jobs', 'updated_at', 'UPDATE'),
    ('saas_provider_products', 'provider_id', 'SELECT'),
    ('saas_provider_products', 'product_id', 'SELECT'),
    ('saas_provider_products', 'status', 'SELECT'),
    ('saas_provider_rights', 'rights_id', 'SELECT'),
    ('saas_provider_rights', 'version', 'SELECT'),
    ('saas_provider_rights', 'provider_id', 'SELECT'),
    ('saas_provider_rights', 'product_id', 'SELECT'),
    ('saas_provider_rights', 'credential_type', 'SELECT'),
    ('saas_provider_rights', 'supply_mode', 'SELECT'),
    ('saas_provider_rights', 'region', 'SELECT'),
    ('saas_provider_rights', 'purpose', 'SELECT'),
    ('saas_provider_rights', 'model_scope', 'SELECT'),
    ('saas_provider_rights', 'endpoint_scope', 'SELECT'),
    ('saas_provider_rights', 'effective_at', 'SELECT'),
    ('saas_provider_rights', 'expires_at', 'SELECT'),
    ('saas_provider_rights', 'status', 'SELECT'),
    ('saas_provider_capabilities', 'provider_id', 'SELECT'),
    ('saas_provider_capabilities', 'product_id', 'SELECT'),
    ('saas_provider_capabilities', 'model', 'SELECT'),
    ('saas_provider_capabilities', 'endpoint', 'SELECT'),
    ('saas_provider_capabilities', 'protocol', 'SELECT'),
    ('saas_provider_capabilities', 'version', 'SELECT'),
    ('saas_provider_capabilities', 'support_level', 'SELECT'),
    ('saas_provider_capabilities', 'validation_state', 'SELECT'),
    ('saas_provider_capabilities', 'evidence_sha256', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'tenant_id', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'account_id', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'provider_id', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'product_id', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'model', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'endpoint', 'SELECT'),
    ('saas_tenant_provider_account_capabilities', 'capability_version', 'SELECT'),
    ('saas_tenant_provider_accounts', 'id', 'SELECT'),
    ('saas_tenant_provider_accounts', 'tenant_id', 'SELECT'),
    ('saas_tenant_provider_accounts', 'provider_id', 'SELECT'),
    ('saas_tenant_provider_accounts', 'product_id', 'SELECT'),
    ('saas_tenant_provider_accounts', 'credential_type', 'SELECT'),
    ('saas_tenant_provider_accounts', 'region', 'SELECT'),
    ('saas_tenant_provider_accounts', 'purpose', 'SELECT'),
    ('saas_tenant_provider_accounts', 'rights_id', 'SELECT'),
    ('saas_tenant_provider_accounts', 'rights_version', 'SELECT'),
    ('saas_tenant_provider_accounts', 'status', 'SELECT'),
    ('saas_tenant_provider_accounts', 'validation_state', 'SELECT'),
    ('saas_tenant_provider_accounts', 'authz_version', 'SELECT'),
    ('saas_tenant_provider_accounts', 'status', 'UPDATE'),
    ('saas_tenant_provider_accounts', 'validation_state', 'UPDATE'),
    ('saas_tenant_provider_accounts', 'validation_error_code', 'UPDATE'),
    ('saas_tenant_provider_accounts', 'last_validated_at', 'UPDATE'),
    ('saas_tenant_provider_accounts', 'updated_at', 'UPDATE'),
    ('saas_tenant_provider_accounts', 'authz_version', 'UPDATE'),
    ('saas_tenant_provider_credentials', 'id', 'SELECT'),
    ('saas_tenant_provider_credentials', 'tenant_id', 'SELECT'),
    ('saas_tenant_provider_credentials', 'account_id', 'SELECT'),
    ('saas_tenant_provider_credentials', 'provider_id', 'SELECT'),
    ('saas_tenant_provider_credentials', 'product_id', 'SELECT'),
    ('saas_tenant_provider_credentials', 'credential_type', 'SELECT'),
    ('saas_tenant_provider_credentials', 'status', 'SELECT'),
    ('saas_tenant_provider_credentials', 'validation_state', 'SELECT'),
    ('saas_tenant_provider_credentials', 'current_version', 'SELECT'),
    ('saas_tenant_provider_credentials', 'expires_at', 'SELECT'),
    ('saas_tenant_provider_credentials', 'authz_version', 'SELECT'),
    ('saas_tenant_provider_credentials', 'status', 'UPDATE'),
    ('saas_tenant_provider_credentials', 'validation_state', 'UPDATE'),
    ('saas_tenant_provider_credentials', 'validation_error_code', 'UPDATE'),
    ('saas_tenant_provider_credentials', 'last_validated_at', 'UPDATE'),
    ('saas_tenant_provider_credentials', 'updated_at', 'UPDATE'),
    ('saas_tenant_provider_credentials', 'authz_version', 'UPDATE'),
    ('saas_tenant_provider_credential_versions', 'tenant_id', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'account_id', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'credential_id', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'version', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'status', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'schema_version', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'context_version', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'algorithm', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'kms_purpose', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'kms_key_id', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'wrapping_revision', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'wrapped_dek', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'nonce', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'ciphertext', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'auth_tag', 'SELECT'),
    ('saas_tenant_provider_credential_versions', 'expires_at', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'tenant_id', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'account_id', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'credential_id', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'credential_version', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'wrapping_revision', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'kms_key_id', 'SELECT'),
    ('saas_tenant_provider_credential_wrappings', 'wrapped_dek', 'SELECT')
)
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
  ) AS any_table_level_privilege,
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

function isProbeRow(value: unknown): value is WorkerPrivilegeProbeRow {
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
    'any_table_level_privilege',
    'missing_column_privilege',
    'extra_column_privilege',
    'any_sequence_privilege',
    'any_function_privilege',
    'out_of_schema_object_privilege',
  ].every((key) => typeof row[key] === 'boolean');
}

export async function verifyCredentialValidationWorkerRuntimePrivileges(
  database: Pick<SqlExecutor, 'query'>,
): Promise<void> {
  try {
    const result = await database.query<WorkerPrivilegeProbeRow>(SAAS_CREDENTIAL_VALIDATION_WORKER_PRIVILEGE_PROBE_SQL);
    if (result.rows.length !== 1 || !isProbeRow(result.rows[0])) {
      throw new SaasCredentialValidationWorkerPrivilegeError();
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
      row.any_table_level_privilege ||
      row.missing_column_privilege ||
      row.extra_column_privilege ||
      row.any_sequence_privilege ||
      row.any_function_privilege ||
      row.out_of_schema_object_privilege
    ) {
      throw new SaasCredentialValidationWorkerPrivilegeError();
    }
  } catch (error) {
    if (error instanceof SaasCredentialValidationWorkerPrivilegeError) throw error;
    throw new SaasCredentialValidationWorkerPrivilegeError();
  }
}
