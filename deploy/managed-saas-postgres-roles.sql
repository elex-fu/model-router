-- Managed SaaS PostgreSQL roles for a dedicated database.
--
-- Purpose: configure object ownership for explicit SaaS migrations and give
-- the long-running control-plane and commercial gateway distinct data privileges.
-- Run with psql connected to the target database, as a PostgreSQL
-- superuser, before the first `saas:migrate`:
--   psql -X -v ON_ERROR_STOP=1 --dbname=your-dedicated-saas-database \
--     --file=deploy/managed-saas-postgres-roles.sql
--
-- The database must be dedicated to this SaaS deployment. This script revokes
-- database CREATE/TEMPORARY from PUBLIC and removes PUBLIC CREATE on the
-- standard `public` schema. It does not create a database, set credentials,
-- migrate data, or transfer ownership of existing application objects.
-- Existing application relations/functions/types must already be owned by
-- model_router_saas_migrator or the script aborts without changing ownership.
-- Do not use these reserved roles for unrelated databases or workloads.
--
-- Configure authentication/passwords outside this file. ALTER ROLE below
-- intentionally leaves any externally managed credentials unchanged.
-- Set MODEL_ROUTER_SAAS_DATABASE_URL to the migrator login when running
-- `node dist/cli/index.js saas:migrate`; migrations create objects as that
-- login. Use model_router_saas_control_plane for managed startup and mounted
-- customer/platform control-plane workflows.
-- Do not grant either login membership in other roles: NOINHERIT alone does
-- not prevent SET ROLE when membership exists.
-- Use model_router_saas_gateway only for the dedicated commercial gateway;
-- it is not a member of, and does not inherit, the control-plane role.
--
-- The control-plane receives only the explicit source-backed column/table
-- grants below. The gateway retains its separate request-processing manifest,
-- spending-freeze DELETE, and lease-fencing sequence usage.

BEGIN;

DO $postgres_version_guard$
BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'managed SaaS requires PostgreSQL 15 or later';
  END IF;
END;
$postgres_version_guard$;

DO $create_roles$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_migrator'
  ) THEN
    CREATE ROLE model_router_saas_migrator
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_control_plane'
  ) THEN
    CREATE ROLE model_router_saas_control_plane
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_gateway'
  ) THEN
    CREATE ROLE model_router_saas_gateway
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$create_roles$;

-- Reassert safe role attributes on every run; no password or validity setting
-- is supplied here.
ALTER ROLE model_router_saas_migrator
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE model_router_saas_control_plane
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE model_router_saas_gateway
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $membership_guard$
DECLARE
  v_migrator_oid oid;
  v_runtime_oid oid;
  v_gateway_oid oid;
BEGIN
  SELECT oid INTO STRICT v_migrator_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_migrator';

  SELECT oid INTO STRICT v_runtime_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_control_plane';

  SELECT oid INTO STRICT v_gateway_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_gateway';

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member IN (v_migrator_oid, v_runtime_oid, v_gateway_oid)
  ) THEN
    RAISE EXCEPTION
      'SaaS migrator/runtime roles must not be members of other roles; remove memberships before applying this template';
  END IF;
END;
$membership_guard$;

-- Resolve the database from the connection; no database name or password is
-- embedded in the file. Neither login needs database-level CREATE or TEMP.
DO $database_acl$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway',
    v_database_name
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway',
    v_database_name
  );
END;
$database_acl$;

-- Remove PUBLIC schema creation on the conventional schema in this dedicated
-- database. The application roles use only the managed schema below.
DO $public_schema_acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public'
  ) THEN
    REVOKE CREATE ON SCHEMA public
      FROM PUBLIC, model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway;
  END IF;
END;
$public_schema_acl$;

-- The migration login owns the app schema and every object created in it by
-- `saas:migrate`. IF NOT EXISTS never changes an existing schema's owner.
CREATE SCHEMA IF NOT EXISTS model_router_saas
  AUTHORIZATION model_router_saas_migrator;

REVOKE ALL PRIVILEGES ON SCHEMA model_router_saas
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;
GRANT USAGE ON SCHEMA model_router_saas
  TO model_router_saas_control_plane, model_router_saas_gateway;

-- Make unqualified SQL in the migration registry resolve to the app schema.
-- PostgreSQL implicitly searches pg_catalog before this path.
DO $role_search_paths$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'ALTER ROLE model_router_saas_migrator IN DATABASE %I SET search_path TO model_router_saas',
    v_database_name
  );
  EXECUTE format(
    'ALTER ROLE model_router_saas_control_plane IN DATABASE %I SET search_path TO model_router_saas',
    v_database_name
  );
  EXECUTE format(
    'ALTER ROLE model_router_saas_gateway IN DATABASE %I SET search_path TO model_router_saas',
    v_database_name
  );
END;
$role_search_paths$;

-- Refuse to adopt a legacy schema or objects owned by an unrelated principal.
-- A DBA can then plan an explicit, reviewed ownership migration separately.
DO $ownership_and_privilege_guards$
DECLARE
  v_database_oid oid;
  v_database_owner oid;
  v_schema_oid oid;
  v_migrator_oid oid;
  v_runtime_oid oid;
  v_gateway_oid oid;
BEGIN
  SELECT oid INTO STRICT v_database_oid
  FROM pg_catalog.pg_database
  WHERE datname = current_database();

  SELECT datdba INTO STRICT v_database_owner
  FROM pg_catalog.pg_database
  WHERE oid = v_database_oid;

  SELECT oid INTO STRICT v_schema_oid
  FROM pg_catalog.pg_namespace
  WHERE nspname = 'model_router_saas';

  SELECT oid INTO STRICT v_migrator_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_migrator';

  SELECT oid INTO STRICT v_runtime_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_control_plane';
  SELECT oid INTO STRICT v_gateway_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_gateway';

  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE oid = v_schema_oid)
       <> v_migrator_oid THEN
    RAISE EXCEPTION
      'schema model_router_saas is not owned by model_router_saas_migrator; no ownership was changed';
  END IF;

  IF v_database_owner IN (v_migrator_oid, v_runtime_oid, v_gateway_oid) THEN
    RAISE EXCEPTION
      'neither application login may own the database; create/use a separate database administrator';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.relnamespace = v_schema_oid
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND relation.relowner <> v_migrator_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = v_schema_oid
      AND routine.proowner <> v_migrator_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS app_type
    WHERE app_type.typnamespace = v_schema_oid
      AND app_type.typowner <> v_migrator_oid
  ) THEN
    RAISE EXCEPTION
      'model_router_saas contains objects not owned by model_router_saas_migrator; review and migrate ownership explicitly';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_shdepend AS dependency
    WHERE dependency.dbid = v_database_oid
      AND dependency.refclassid = 'pg_catalog.pg_authid'::regclass
      AND dependency.refobjid IN (v_runtime_oid, v_gateway_oid)
      AND dependency.deptype = 'o'
  ) THEN
    RAISE EXCEPTION
      'model_router_saas_control_plane already owns database objects; move ownership through a separately reviewed change';
  END IF;

  -- Existing functions may have been created before this template was
  -- applied, so remove the runtime-facing default/direct EXECUTE ACL before
  -- evaluating the SECURITY DEFINER boundary below. Trigger invocation does
  -- not require exposing the trigger function as a callable runtime API.
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA model_router_saas
    FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = v_schema_oid
      AND routine.prosecdef
      AND pg_catalog.has_function_privilege(v_runtime_oid, routine.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'model_router_saas must not contain SECURITY DEFINER routines executable by the runtime role';
  END IF;

  IF pg_catalog.has_database_privilege(v_runtime_oid, v_database_oid, 'CREATE')
     OR pg_catalog.has_database_privilege(v_runtime_oid, v_database_oid, 'TEMP')
     OR pg_catalog.has_database_privilege(v_gateway_oid, v_database_oid, 'CREATE')
     OR pg_catalog.has_database_privilege(v_gateway_oid, v_database_oid, 'TEMP')
     OR pg_catalog.has_database_privilege(v_migrator_oid, v_database_oid, 'CREATE')
     OR pg_catalog.has_database_privilege(v_migrator_oid, v_database_oid, 'TEMP') THEN
    RAISE EXCEPTION
      'an application role still has database CREATE/TEMP privilege; inspect database ownership and ACLs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS app_namespace
    WHERE app_namespace.nspname <> 'pg_catalog'
      AND app_namespace.nspname <> 'information_schema'
      AND app_namespace.nspname NOT LIKE 'pg_toast%'
      AND app_namespace.nspname NOT LIKE 'pg_temp_%'
      AND (
        (pg_catalog.has_schema_privilege(v_runtime_oid, app_namespace.oid, 'CREATE'))
        OR pg_catalog.has_schema_privilege(v_gateway_oid, app_namespace.oid, 'CREATE')
        OR (
          app_namespace.oid <> v_schema_oid
          AND pg_catalog.has_schema_privilege(v_migrator_oid, app_namespace.oid, 'CREATE')
        )
      )
  ) THEN
    RAISE EXCEPTION
      'runtime has schema CREATE or migrator can CREATE outside model_router_saas; inspect schema ACLs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS app_namespace
      ON app_namespace.oid = relation.relnamespace
    WHERE app_namespace.oid <> v_schema_oid
      AND app_namespace.nspname <> 'pg_catalog'
      AND app_namespace.nspname <> 'information_schema'
      AND app_namespace.nspname NOT LIKE 'pg_toast%'
      AND app_namespace.nspname NOT LIKE 'pg_temp_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND pg_catalog.has_schema_privilege(v_runtime_oid, app_namespace.oid, 'USAGE')
      AND (
        pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'TRIGGER')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'UPDATE')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'DELETE')
      )
      OR (
        app_namespace.oid <> v_schema_oid
        AND app_namespace.nspname <> 'pg_catalog'
        AND app_namespace.nspname <> 'information_schema'
        AND app_namespace.nspname NOT LIKE 'pg_toast%'
        AND app_namespace.nspname NOT LIKE 'pg_temp_%'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_schema_privilege(v_gateway_oid, app_namespace.oid, 'USAGE')
        AND (
          pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'TRUNCATE')
          OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'REFERENCES')
          OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'TRIGGER')
          OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'SELECT')
          OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'INSERT')
          OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'UPDATE')
          OR (
            pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'DELETE')
            AND relation.relname <> 'saas_billing_spending_freezes'
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'runtime has DDL/TRUNCATE or out-of-schema table privileges; inspect object ownership and ACLs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.relnamespace = v_schema_oid
      AND relation.relkind IN ('r', 'p')
      AND (
        pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'TRIGGER')
        OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'SELECT')
        OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'INSERT')
        OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'UPDATE')
        OR (
          pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'DELETE')
          AND relation.relname <> 'saas_billing_spending_freezes'
        )
        OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'TRUNCATE')
        OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'REFERENCES')
        OR pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'TRIGGER')
      )
  ) THEN
    RAISE EXCEPTION
      'runtime has extra table privileges inside model_router_saas; inspect application table ACLs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS column_acl
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND column_acl.grantee IN (0, v_runtime_oid, v_gateway_oid)
      AND (
        (relation.relnamespace = v_schema_oid AND column_acl.privilege_type = 'REFERENCES')
        OR relation.relnamespace <> v_schema_oid
      )
      AND (
        relation.relnamespace = v_schema_oid
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_namespace AS app_namespace
          WHERE app_namespace.oid = relation.relnamespace
            AND app_namespace.nspname <> 'pg_catalog'
            AND app_namespace.nspname <> 'information_schema'
            AND app_namespace.nspname NOT LIKE 'pg_toast%'
            AND app_namespace.nspname NOT LIKE 'pg_temp_%'
            AND (
              pg_catalog.has_schema_privilege(v_runtime_oid, app_namespace.oid, 'USAGE')
              OR pg_catalog.has_schema_privilege(v_gateway_oid, app_namespace.oid, 'USAGE')
            )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'runtime has column-level privileges outside the managed DML contract; inspect column ACLs';
  END IF;

  IF current_setting('server_version_num')::integer >= 170000 THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS app_namespace
        ON app_namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND app_namespace.nspname <> 'pg_catalog'
        AND app_namespace.nspname <> 'information_schema'
        AND app_namespace.nspname NOT LIKE 'pg_toast%'
        AND app_namespace.nspname NOT LIKE 'pg_temp_%'
        AND pg_catalog.has_schema_privilege(v_runtime_oid, app_namespace.oid, 'USAGE')
        AND pg_catalog.has_table_privilege(v_runtime_oid, relation.oid, 'MAINTAIN')
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS app_namespace
        ON app_namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND app_namespace.nspname <> 'pg_catalog'
        AND app_namespace.nspname <> 'information_schema'
        AND app_namespace.nspname NOT LIKE 'pg_toast%'
        AND app_namespace.nspname NOT LIKE 'pg_temp_%'
        AND pg_catalog.has_schema_privilege(v_gateway_oid, app_namespace.oid, 'USAGE')
        AND pg_catalog.has_table_privilege(v_gateway_oid, relation.oid, 'MAINTAIN')
    ) THEN
      RAISE EXCEPTION
        'runtime has PostgreSQL MAINTAIN privilege; inspect table ACLs';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS seq_object
    JOIN pg_catalog.pg_namespace AS app_namespace
      ON app_namespace.oid = seq_object.relnamespace
    WHERE seq_object.relkind = 'S'
      AND app_namespace.oid <> v_schema_oid
      AND app_namespace.nspname <> 'pg_catalog'
      AND app_namespace.nspname <> 'information_schema'
      AND app_namespace.nspname NOT LIKE 'pg_toast%'
      AND app_namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(v_runtime_oid, app_namespace.oid, 'USAGE')
      AND (
        pg_catalog.has_sequence_privilege(v_runtime_oid, seq_object.oid, 'UPDATE')
        OR pg_catalog.has_sequence_privilege(v_runtime_oid, seq_object.oid, 'USAGE')
        OR pg_catalog.has_sequence_privilege(v_runtime_oid, seq_object.oid, 'SELECT')
      )
      OR (
        seq_object.relkind = 'S'
        AND app_namespace.oid <> v_schema_oid
        AND app_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND app_namespace.nspname NOT LIKE 'pg_toast%'
        AND app_namespace.nspname NOT LIKE 'pg_temp_%'
        AND pg_catalog.has_schema_privilege(v_gateway_oid, app_namespace.oid, 'USAGE')
        AND (
          pg_catalog.has_sequence_privilege(v_gateway_oid, seq_object.oid, 'UPDATE')
          OR pg_catalog.has_sequence_privilege(v_gateway_oid, seq_object.oid, 'USAGE')
          OR pg_catalog.has_sequence_privilege(v_gateway_oid, seq_object.oid, 'SELECT')
        )
      )
  ) THEN
    RAISE EXCEPTION
      'runtime has sequence UPDATE or out-of-schema sequence access; inspect sequence ACLs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS app_namespace
      ON app_namespace.oid = routine.pronamespace
    WHERE app_namespace.oid <> v_schema_oid
      AND app_namespace.nspname <> 'pg_catalog'
      AND app_namespace.nspname <> 'information_schema'
      AND app_namespace.nspname NOT LIKE 'pg_toast%'
      AND app_namespace.nspname NOT LIKE 'pg_temp_%'
      AND pg_catalog.has_schema_privilege(v_runtime_oid, app_namespace.oid, 'USAGE')
      AND pg_catalog.has_function_privilege(v_runtime_oid, routine.oid, 'EXECUTE')
      OR (
        app_namespace.oid <> v_schema_oid
        AND app_namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND app_namespace.nspname NOT LIKE 'pg_toast%'
        AND app_namespace.nspname NOT LIKE 'pg_temp_%'
        AND pg_catalog.has_schema_privilege(v_gateway_oid, app_namespace.oid, 'USAGE')
        AND pg_catalog.has_function_privilege(v_gateway_oid, routine.oid, 'EXECUTE')
      )
  ) THEN
    RAISE EXCEPTION
      'runtime can execute out-of-schema routines; move required helpers into model_router_saas or explicitly review their ACLs';
  END IF;
END;
$ownership_and_privilege_guards$;

-- Normalize ACLs on existing migration-owned objects; future objects receive
-- the same boundaries through ALTER DEFAULT PRIVILEGES below.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA model_router_saas
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA model_router_saas
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;

-- Table REVOKE ALL does not remove column ACLs. Clear stale/public column
-- grants before installing the two independent runtime manifests.
DO $runtime_column_acl_normalization$
DECLARE
  v_relation record;
  v_columns text;
BEGIN
  FOR v_relation IN
    SELECT relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'model_router_saas'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
      INTO v_columns
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'model_router_saas'
      AND relation.relname = v_relation.relname
      AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    IF v_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%s) ON TABLE %I.%I FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway',
        v_columns, 'model_router_saas', v_relation.relname
      );
    END IF;
  END LOOP;
END;
$runtime_column_acl_normalization$;

-- Exact control-plane grants mirrored by SAAS_CONTROL_PLANE_RUNTIME_COLUMN_GRANTS,
-- SAAS_CONTROL_PLANE_RUNTIME_TABLE_GRANTS and the sequence manifest.
-- The set includes migration-registry startup reads and currently mounted
-- identity, tenant/project, key, catalog, supply, plan, billing/payment/refund,
-- usage, operations and audit SQL. Column grants intentionally follow the
-- source projections/write targets; only source-required DELETE operations use
-- table-level privileges, because PostgreSQL has no column-scoped DELETE.
-- This role does not receive UPDATE on immutable role assignments or policy
-- history merely to satisfy row-lock clauses. PostgreSQL row locking requires
-- UPDATE on at least one column of each locked relation; the mounted webhook
-- policy lock uses only column-scoped UPDATE(updated_at). ACL conformance is not
-- proof that mounted API SQL executes, and the documented immutable-row lock
-- conflicts remain unresolved.
-- The webhook set below covers the mounted endpoint API and delivery worker;
-- outbox production, replay, and retention are not included. Delivery history
-- reads only its safe outcome projection, without payload or target_url.
-- Migrations add some relations later, so reapply this template after the
-- registered migrations to install all expected grants.
DO $control_plane_runtime_grants$
DECLARE
  v_grant record;
  v_columns text;
  v_table record;
  v_sequence record;
BEGIN
  FOR v_grant IN
    SELECT manifest.table_name, manifest.privilege_type,
           pg_catalog.string_to_array(manifest.column_names, ' ') AS column_names
    FROM (VALUES
      ('saas_schema_migrations', 'SELECT', 'version name checksum'),
      ('saas_platform_state', 'SELECT', 'singleton initialized initialized_at'),
      ('saas_platform_state', 'UPDATE', 'initialized'),
      ('saas_users', 'SELECT', 'id email email_canonical display_name password_hash disabled_at anonymized_at email_verified_at created_at'),
      ('saas_users', 'INSERT', 'id email password_hash display_name email_verified_at disabled_at created_at updated_at'),
      ('saas_platform_role_assignments', 'SELECT', 'user_id role'),
      ('saas_platform_role_assignments', 'INSERT', 'user_id role granted_at granted_by_user_id'),
      ('saas_bootstrap_tokens', 'SELECT', 'token_hash expires_at consumed_at'),
      ('saas_bootstrap_tokens', 'INSERT', 'token_hash expires_at consumed_at created_by_user_id created_at'),
      ('saas_bootstrap_tokens', 'UPDATE', 'consumed_at'),
      ('saas_sessions', 'SELECT', 'id user_id token_hash csrf_token_hash created_at expires_at revoked_at'),
      ('saas_sessions', 'INSERT', 'id user_id token_hash csrf_token_hash created_at expires_at revoked_at'),
      ('saas_sessions', 'UPDATE', 'revoked_at'),
      ('saas_platform_sessions', 'SELECT', 'id user_id credential_id token_hash csrf_token_hash created_at expires_at revoked_at'),
      ('saas_platform_sessions', 'INSERT', 'id user_id credential_id token_hash csrf_token_hash created_at expires_at revoked_at'),
      ('saas_platform_sessions', 'UPDATE', 'revoked_at'),
      ('saas_mfa_credentials', 'SELECT', 'id user_id kind encrypted_secret created_at verified_at revoked_at last_used_step'),
      ('saas_mfa_credentials', 'INSERT', 'id user_id kind encrypted_secret created_at verified_at revoked_at'),
      ('saas_mfa_credentials', 'UPDATE', 'verified_at revoked_at last_used_step'),
      ('saas_platform_mfa_enrollment_tokens', 'SELECT', 'id user_id token_hash created_at expires_at consumed_at'),
      ('saas_platform_mfa_enrollment_tokens', 'INSERT', 'id user_id token_hash created_at expires_at consumed_at'),
      ('saas_platform_mfa_enrollment_tokens', 'UPDATE', 'consumed_at'),
      ('saas_platform_mfa_setup_tokens', 'SELECT', 'id user_id credential_id token_hash attempt_count attempt_limit created_at expires_at consumed_at locked_at'),
      ('saas_platform_mfa_setup_tokens', 'INSERT', 'id user_id credential_id token_hash attempt_count attempt_limit created_at expires_at consumed_at locked_at'),
      ('saas_platform_mfa_setup_tokens', 'UPDATE', 'attempt_count locked_at consumed_at'),
      ('saas_tenants', 'SELECT', 'id name slug slug_canonical status created_at updated_at capacity_policy_revision requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_tenants', 'INSERT', 'id name slug status created_at updated_at'),
      ('saas_tenants', 'UPDATE', 'requests_per_minute tokens_per_minute max_concurrent_requests capacity_policy_revision updated_at'),
      ('saas_memberships', 'SELECT', 'tenant_id user_id role status revoked_at'),
      ('saas_memberships', 'INSERT', 'tenant_id user_id role created_at updated_at'),
      ('saas_projects', 'SELECT', 'tenant_id id name slug slug_canonical is_default created_at updated_at inference_policy_version inference_policy_status'),
      ('saas_projects', 'INSERT', 'tenant_id id name slug is_default created_at updated_at'),
      ('saas_projects', 'UPDATE', 'inference_policy_version inference_policy_status updated_at'),
      ('saas_project_memberships', 'SELECT', 'tenant_id project_id user_id role status revoked_at'),
      ('saas_project_memberships', 'INSERT', 'tenant_id project_id user_id role created_at updated_at'),
      ('saas_invitations', 'SELECT', 'tenant_id id invited_email invited_email_canonical role token_hash created_by_user_id accepted_by_user_id created_at expires_at accepted_at revoked_at'),
      ('saas_invitations', 'INSERT', 'tenant_id id invited_email role token_hash created_by_user_id created_at expires_at accepted_at revoked_at'),
      ('saas_invitations', 'UPDATE', 'accepted_by_user_id accepted_at revoked_at'),
      ('saas_project_inference_policy_versions', 'SELECT', 'tenant_id project_id version status changed_by_user_id created_at requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_project_inference_policy_versions', 'INSERT', 'tenant_id project_id version status changed_by_user_id created_at requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_api_keys', 'SELECT', 'id tenant_id project_id principal_user_id execution_principal_type execution_principal_id created_by_user_id rotated_by_user_id revoked_by_user_id entitlement_id supply_profile_id supply_mode name prefix key_hash model_scopes status created_at expires_at revoked_at last_used_at authz_version model_scope_version entitlement_authz_version supply_profile_authz_version requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_api_keys', 'INSERT', 'id tenant_id project_id principal_user_id execution_principal_type execution_principal_id created_by_user_id entitlement_id supply_profile_id supply_mode name prefix key_hash model_scopes status created_at expires_at revoked_at last_used_at authz_version model_scope_version entitlement_authz_version supply_profile_authz_version'),
      ('saas_api_keys', 'UPDATE', 'status revoked_at revoked_by_user_id rotated_by_user_id last_used_at authz_version model_scope_version entitlement_authz_version supply_profile_authz_version requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_route_config_heads', 'SELECT', 'tenant_id project_id route_id current_version status'),
      ('saas_route_config_versions', 'SELECT', 'tenant_id project_id route_id version public_model_id public_model_version status supply_mode endpoint'),
      ('saas_audit_events', 'SELECT', 'id tenant_id actor_user_id action target_type target_id occurred_at source_ip user_agent entry_point request_id'),
      ('saas_audit_events', 'INSERT', 'id tenant_id actor_user_id action target_type target_id occurred_at source_ip user_agent entry_point request_id'),
      ('saas_capacity_policy_audit_details', 'SELECT', 'audit_event_id'),
      ('saas_capacity_policy_audit_details', 'INSERT', 'audit_event_id scope tenant_id project_id api_key_id reason revision_kind before_revision after_revision before_requests_per_minute before_tokens_per_minute before_max_concurrent_requests after_requests_per_minute after_tokens_per_minute after_max_concurrent_requests'),
      ('saas_provider_products', 'SELECT', 'provider_id product_id display_name status created_at'),
      ('saas_provider_products', 'INSERT', 'provider_id product_id display_name status created_at'),
      ('saas_public_models', 'SELECT', 'id alias display_name status created_at'),
      ('saas_public_models', 'INSERT', 'id alias display_name status created_at'),
      ('saas_public_model_versions', 'SELECT', 'public_model_id version provider_id product_id model endpoint_scope status created_at'),
      ('saas_public_model_versions', 'INSERT', 'public_model_id version provider_id product_id model endpoint_scope status created_at'),
      ('saas_provider_capabilities', 'SELECT', 'provider_id product_id model endpoint protocol version support_level validation_state evidence_version discovery_source evidence_ref evidence_sha256 created_at'),
      ('saas_provider_capabilities', 'INSERT', 'provider_id product_id model endpoint protocol version support_level validation_state evidence_version discovery_source evidence_ref evidence_sha256 created_at'),
      ('saas_provider_rights', 'SELECT', 'rights_id version provider_id product_id credential_type supply_mode region purpose model_scope endpoint_scope effective_at expires_at approval_ref status evidence_ref evidence_sha256 created_at'),
      ('saas_provider_rights', 'INSERT', 'rights_id version provider_id product_id credential_type supply_mode region purpose model_scope endpoint_scope effective_at expires_at approval_ref status evidence_ref evidence_sha256 created_at'),
      ('saas_provider_rights_events', 'INSERT', 'id rights_id rights_version from_status to_status event_type occurred_at'),
      ('saas_project_entitlements', 'SELECT', 'id tenant_id project_id supply_profile_id supply_mode status model_scopes authz_version effective_at expires_at superseded_at disabled_at updated_at last_audited_at source_type source_ref service_plan_snapshot_id'),
      ('saas_project_entitlements', 'INSERT', 'id tenant_id project_id supply_profile_id supply_mode status model_scopes authz_version created_at updated_at last_audited_at disabled_at effective_at expires_at superseded_at source_type source_ref service_plan_snapshot_id'),
      ('saas_project_entitlements', 'UPDATE', 'status disabled_at superseded_at authz_version updated_at last_audited_at'),
      ('saas_supply_profiles', 'SELECT', 'tenant_id id supply_mode status model_scopes authz_version'),
      ('saas_tenant_provider_accounts', 'SELECT', 'owner_kind tenant_id supply_mode id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state validation_error_code last_validated_at authz_version created_at updated_at disabled_at revoked_at'),
      ('saas_tenant_provider_accounts', 'INSERT', 'tenant_id id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state created_at updated_at'),
      ('saas_tenant_provider_accounts', 'UPDATE', 'status validation_state validation_error_code last_validated_at authz_version updated_at disabled_at revoked_at'),
      ('saas_platform_provider_accounts', 'SELECT', 'owner_kind supply_mode id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state validation_error_code last_validated_at authz_version created_at updated_at disabled_at revoked_at'),
      ('saas_platform_provider_accounts', 'INSERT', 'id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state created_at updated_at'),
      ('saas_platform_provider_accounts', 'UPDATE', 'status validation_state validation_error_code last_validated_at authz_version updated_at disabled_at revoked_at'),
      ('saas_tenant_provider_account_capabilities', 'SELECT', 'tenant_id account_id provider_id product_id model endpoint capability_version'),
      ('saas_tenant_provider_account_capabilities', 'INSERT', 'tenant_id account_id provider_id product_id model endpoint capability_version'),
      ('saas_platform_provider_account_capabilities', 'SELECT', 'account_id provider_id product_id model endpoint capability_version'),
      ('saas_platform_provider_account_capabilities', 'INSERT', 'account_id provider_id product_id model endpoint capability_version'),
      ('saas_customer_price_versions', 'SELECT', 'id version public_model_id public_model_version provider_id product_id protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_customer_price_versions', 'INSERT', 'id version public_model_id public_model_version provider_id product_id protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_supplier_cost_versions', 'SELECT', 'id version public_model_id public_model_version provider_id product_id resolved_model protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_supplier_cost_versions', 'INSERT', 'id version public_model_id public_model_version provider_id product_id resolved_model protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_tenant_provider_credentials', 'SELECT', 'owner_kind tenant_id supply_mode id account_id provider_id product_id credential_type status validation_state validation_error_code last_validated_at current_version expires_at authz_version created_at updated_at disabled_at revoked_at'),
      ('saas_tenant_provider_credentials', 'INSERT', 'tenant_id id account_id provider_id product_id credential_type status validation_state expires_at created_at updated_at'),
      ('saas_tenant_provider_credentials', 'UPDATE', 'status validation_state validation_error_code last_validated_at current_version expires_at authz_version updated_at disabled_at revoked_at'),
      ('saas_platform_provider_credentials', 'SELECT', 'owner_kind supply_mode id account_id provider_id product_id credential_type status validation_state validation_error_code last_validated_at current_version expires_at authz_version created_at updated_at disabled_at revoked_at'),
      ('saas_platform_provider_credentials', 'INSERT', 'id account_id provider_id product_id credential_type status validation_state expires_at created_at updated_at'),
      ('saas_platform_provider_credentials', 'UPDATE', 'status validation_state validation_error_code last_validated_at current_version expires_at authz_version updated_at disabled_at revoked_at'),
      ('saas_tenant_provider_credential_versions', 'SELECT', 'owner_kind tenant_id supply_mode account_id credential_id version status schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at retired_at revoked_at'),
      ('saas_tenant_provider_credential_versions', 'INSERT', 'tenant_id account_id credential_id version schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at'),
      ('saas_tenant_provider_credential_versions', 'UPDATE', 'status retired_at revoked_at'),
      ('saas_platform_provider_credential_versions', 'SELECT', 'owner_kind supply_mode account_id credential_id version status schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at retired_at revoked_at'),
      ('saas_platform_provider_credential_versions', 'INSERT', 'account_id credential_id version schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at'),
      ('saas_platform_provider_credential_versions', 'UPDATE', 'status retired_at revoked_at'),
      ('saas_tenant_provider_credential_wrappings', 'SELECT', 'owner_kind tenant_id account_id credential_id credential_version expected_wrapping_revision wrapping_revision operation_id source_kms_key_id kms_key_id context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
      ('saas_tenant_provider_credential_wrappings', 'INSERT', 'tenant_id account_id credential_id credential_version wrapping_revision expected_wrapping_revision operation_id source_kms_key_id kms_key_id wrapped_dek context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
      ('saas_platform_provider_credential_wrappings', 'SELECT', 'owner_kind account_id credential_id credential_version expected_wrapping_revision wrapping_revision operation_id source_kms_key_id kms_key_id context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
      ('saas_platform_provider_credential_wrappings', 'INSERT', 'account_id credential_id credential_version wrapping_revision expected_wrapping_revision operation_id source_kms_key_id kms_key_id wrapped_dek context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
      ('saas_platform_provider_pools', 'SELECT', 'owner_kind supply_mode id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state validation_error_code last_validated_at authz_version created_at updated_at disabled_at revoked_at'),
      ('saas_platform_provider_pools', 'INSERT', 'id owner_kind supply_mode display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state validation_error_code last_validated_at authz_version created_at updated_at disabled_at revoked_at'),
      ('saas_platform_provider_pool_members', 'SELECT', 'pool_id account_id provider_id product_id account_authz_version authz_version status created_at updated_at disabled_at revoked_at'),
      ('saas_platform_provider_pool_members', 'INSERT', 'pool_id account_id provider_id product_id account_authz_version authz_version status created_at updated_at'),
      ('saas_platform_provider_pool_members', 'UPDATE', 'status disabled_at revoked_at authz_version updated_at'),
      ('saas_platform_provider_pool_grants', 'SELECT', 'pool_id tenant_id supply_profile_id supply_mode profile_authz_version pool_authz_version status effective_at expires_at authz_version evidence_ref evidence_sha256 created_at updated_at disabled_at revoked_at'),
      ('saas_platform_provider_pool_grants', 'INSERT', 'pool_id tenant_id supply_profile_id supply_mode profile_authz_version pool_authz_version status effective_at expires_at authz_version evidence_ref evidence_sha256 created_at updated_at'),
      ('saas_platform_provider_pool_grants', 'UPDATE', 'status disabled_at revoked_at authz_version updated_at'),
      ('saas_tenant_provider_supply_profile_accounts', 'SELECT', 'tenant_id supply_profile_id supply_mode account_id provider_id product_id account_authz_version status effective_at expires_at authz_version evidence_ref evidence_sha256 created_at updated_at disabled_at revoked_at'),
      ('saas_tenant_provider_supply_profile_accounts', 'INSERT', 'tenant_id supply_profile_id supply_mode account_id provider_id product_id account_authz_version status effective_at expires_at authz_version evidence_ref evidence_sha256 created_at updated_at'),
      ('saas_tenant_provider_supply_profile_accounts', 'UPDATE', 'status disabled_at revoked_at authz_version updated_at'),
      ('saas_tenant_provider_credential_validation_jobs', 'SELECT', 'id tenant_id account_id credential_id credential_version provider_id product_id credential_type allowed_models target_model target_endpoint capability_version idempotency_key status attempt_count available_at lease_until lease_generation last_error_code completed_at created_at updated_at'),
      ('saas_tenant_provider_credential_validation_jobs', 'INSERT', 'tenant_id account_id credential_id credential_version provider_id product_id credential_type allowed_models target_model target_endpoint capability_version idempotency_key'),
      ('saas_service_plans', 'SELECT', 'id slug display_name status created_at updated_at'),
      ('saas_service_plan_versions', 'SELECT', 'id plan_id version supply_mode supply_profile_id allowed_provider_ids allowed_models price_version price_minor_units currency term_days policy_version status created_at published_at retired_at'),
      ('saas_service_plan_orders', 'SELECT', 'id tenant_id project_id plan_version_id operation renewal_of_subscription_id client_request_id state subscription_id verified_settlement_id verified_provider_key verified_merchant_id verified_amount_minor_units verified_currency fulfillment_reference fulfillment_evidence_sha256 verified_at created_at updated_at paid_at fulfilled_at provider_key merchant_id provider_order_id provider_attempts provider_failure_code checkout_kind checkout_url checkout_text checkout_expires_at provider_submission_state provider_submission_lease_token provider_submission_lease_expires_at'),
      ('saas_service_plan_orders', 'INSERT', 'id tenant_id project_id plan_version_id operation renewal_of_subscription_id client_request_id state created_at updated_at'),
      ('saas_service_plan_orders', 'UPDATE', 'state subscription_id verified_settlement_id verified_provider_key verified_merchant_id verified_amount_minor_units verified_currency fulfillment_reference fulfillment_evidence_sha256 verified_at paid_at fulfilled_at updated_at provider_key merchant_id provider_order_id provider_attempts provider_failure_code checkout_kind checkout_url checkout_text checkout_expires_at provider_submission_state provider_submission_lease_token provider_submission_lease_expires_at'),
      ('saas_service_plan_snapshots', 'SELECT', 'id tenant_id order_id plan_version_id plan_id plan_version allowed_provider_ids allowed_models supply_mode supply_profile_id price_version price_minor_units currency term_days policy_version snapshot_digest created_at'),
      ('saas_service_plan_snapshots', 'INSERT', 'id tenant_id order_id plan_version_id plan_id plan_version allowed_provider_ids allowed_models supply_mode supply_profile_id price_version price_minor_units currency term_days policy_version snapshot_digest created_at'),
      ('saas_service_plan_subscriptions', 'SELECT', 'id tenant_id project_id order_id snapshot_id entitlement_id previous_subscription_id operation status effective_at expires_at activated_at superseded_at expired_at cancelled_at created_at updated_at'),
      ('saas_service_plan_subscriptions', 'INSERT', 'id tenant_id project_id order_id snapshot_id entitlement_id previous_subscription_id operation status effective_at expires_at activated_at created_at updated_at'),
      ('saas_service_plan_subscriptions', 'UPDATE', 'status activated_at superseded_at expired_at cancelled_at updated_at'),
      ('saas_refund_service_plan_effects', 'SELECT', 'effect_ref tenant_id refund_order_id project_id source_service_plan_order_id source_subscription_id source_snapshot_id source_entitlement_id refund_policy_version service_plan_policy_version amount_minor_units currency cutoff_at requested_by_user_id reason_code state suspended_authz_version suspended_at suspension_released_at released_authz_version request_audit_event_id outcome_audit_event_id created_at updated_at completed_at'),
      ('saas_refund_service_plan_effects', 'INSERT', 'effect_ref tenant_id refund_order_id project_id source_service_plan_order_id source_subscription_id source_snapshot_id source_entitlement_id refund_policy_version service_plan_policy_version amount_minor_units currency cutoff_at requested_by_user_id reason_code state suspended_authz_version suspended_at request_audit_event_id created_at updated_at'),
      ('saas_refund_service_plan_effects', 'UPDATE', 'state suspension_released_at released_authz_version outcome_audit_event_id updated_at completed_at'),
      ('saas_payment_orders', 'SELECT', 'id tenant_id order_type provider_key merchant_id client_request_id local_order_ref funding_reference amount_minor_units currency state provider_order_id provider_attempts provider_failure_code funding_transaction_id created_at updated_at paid_at fulfilled_at checkout_kind checkout_url checkout_text checkout_expires_at provider_submission_state provider_submission_lease_token provider_submission_lease_expires_at'),
      ('saas_payment_orders', 'INSERT', 'id tenant_id order_type provider_key merchant_id client_request_id local_order_ref funding_reference amount_minor_units currency state provider_attempts created_at updated_at'),
      ('saas_payment_orders', 'UPDATE', 'state provider_order_id provider_attempts provider_failure_code funding_transaction_id paid_at fulfilled_at checkout_kind checkout_url checkout_text checkout_expires_at provider_submission_state provider_submission_lease_token provider_submission_lease_expires_at updated_at'),
      ('saas_payment_inbox', 'SELECT', 'id provider_key merchant_id provider_event_id event_type provider_order_id event_tenant_id tenant_id local_order_id event_status amount_minor_units currency occurred_at received_at processing_outcome outcome_code processing_state attempt_count next_attempt_at lease_token lease_expires_at processed_at last_error_code updated_at'),
      ('saas_payment_inbox', 'INSERT', 'id provider_key merchant_id provider_event_id event_type provider_order_id event_tenant_id tenant_id local_order_id event_status amount_minor_units currency occurred_at received_at next_attempt_at updated_at processing_outcome outcome_code'),
      ('saas_payment_inbox', 'UPDATE', 'processing_outcome outcome_code processing_state attempt_count next_attempt_at lease_token lease_expires_at processed_at last_error_code updated_at'),
      ('saas_refund_orders', 'SELECT', 'id tenant_id refund_type wallet_topup_order_id service_plan_order_id original_funding_transaction_id wallet_id provider_key merchant_id provider_order_id original_local_order_ref idempotency_namespace client_request_id requested_by_user_id authorization_ref reason_code amount_minor_units currency state provider_refund_id failure_code blocked_code wallet_refund_transaction_id provider_attempts lease_action service_plan_effect_ref lease_token lease_expires_at next_reconcile_at created_at updated_at completed_at'),
      ('saas_refund_orders', 'INSERT', 'id tenant_id refund_type wallet_topup_order_id service_plan_order_id original_funding_transaction_id wallet_id provider_key merchant_id provider_order_id original_local_order_ref idempotency_namespace client_request_id requested_by_user_id authorization_ref reason_code amount_minor_units currency state blocked_code service_plan_effect_ref provider_attempts lease_action lease_token lease_expires_at next_reconcile_at created_at updated_at'),
      ('saas_refund_orders', 'UPDATE', 'state provider_refund_id failure_code blocked_code wallet_refund_transaction_id provider_attempts lease_action lease_token lease_expires_at next_reconcile_at updated_at completed_at'),
      ('saas_refund_wallet_freezes', 'SELECT', 'refund_order_id tenant_id wallet_id currency amount_minor_units created_at'),
      ('saas_refund_wallet_freezes', 'INSERT', 'refund_order_id tenant_id wallet_id currency amount_minor_units created_at'),
      ('saas_wallets', 'SELECT', 'id tenant_id currency posted_balance_minor_units created_at updated_at'),
      ('saas_wallets', 'INSERT', 'id tenant_id currency posted_balance_minor_units created_at updated_at'),
      ('saas_wallets', 'UPDATE', 'posted_balance_minor_units updated_at'),
      ('saas_billing_spending_freezes', 'SELECT', 'tenant_id reason_ref frozen_at'),
      ('saas_billing_spending_freezes', 'INSERT', 'tenant_id reason_ref frozen_at'),
      ('saas_billing_reservations', 'SELECT', 'id tenant_id wallet_id currency request_id idempotency_namespace business_key amount_minor_units state price_snapshot_ref metadata_ref expires_at settlement_id settlement_amount_minor_units usage_evidence_ref reconciliation_reference reconciliation_evidence_ref release_id release_evidence_ref ledger_transaction_id created_at updated_at'),
      ('saas_billing_reservations', 'INSERT', 'id tenant_id wallet_id currency request_id idempotency_namespace business_key amount_minor_units state price_snapshot_ref metadata_ref expires_at created_at updated_at'),
      ('saas_billing_reservations', 'UPDATE', 'state settlement_id settlement_amount_minor_units usage_evidence_ref reconciliation_reference reconciliation_evidence_ref release_id release_evidence_ref ledger_transaction_id updated_at'),
      ('saas_ledger_transactions', 'SELECT', 'id tenant_id currency idempotency_namespace business_key source_type amount_minor_units metadata_ref source_order_ref price_snapshot_ref usage_evidence_ref created_at'),
      ('saas_ledger_transactions', 'INSERT', 'id tenant_id currency idempotency_namespace business_key source_type amount_minor_units metadata_ref source_order_ref price_snapshot_ref usage_evidence_ref created_at'),
      ('saas_ledger_entries', 'SELECT', 'id transaction_id tenant_id currency direction amount_minor_units account_type account_ref wallet_id created_at'),
      ('saas_ledger_entries', 'INSERT', 'id transaction_id tenant_id currency direction amount_minor_units account_type account_ref wallet_id created_at'),
      ('saas_provider_account_leases', 'SELECT', 'status lease_expires_at'),
      ('saas_provider_account_runtime_health', 'SELECT', 'owner_scope_key owner_kind state cooldown_until observed_at'),
      ('saas_requests', 'SELECT', 'id tenant_id project_id public_model protocol supply_mode execution_state financial_status created_at updated_at'),
      ('saas_attempts', 'SELECT', 'id tenant_id request_id ordinal result_state response_started response_started_at result_http_status created_at updated_at'),
      ('saas_usage_events', 'SELECT', 'id tenant_id request_id supply_mode input_total input_uncached cache_read cache_write cache_write_5m cache_write_1h output_total reasoning_output status source measurement_kind billable_basis created_at'),
      ('saas_unknown_outcome_reconciliation_cases', 'SELECT', 'id tenant_id project_id request_id supply_mode case_state scan_attempt_count next_attempt_at lease_token lease_expires_at last_error_code created_at resolution_idempotency_key resolution_digest resolution_support_ticket_ref'),
      ('saas_unknown_outcome_reconciliation_cases', 'INSERT', 'id tenant_id project_id request_id supply_mode case_state scan_attempt_count next_attempt_at created_at updated_at'),
      ('saas_unknown_outcome_reconciliation_cases', 'UPDATE', 'case_state scan_attempt_count next_attempt_at lease_token lease_expires_at last_error_code resolution_idempotency_key resolution_digest resolution_support_ticket_ref resolution_actor_user_id resolution_reason resolution_evidence_digest resolution_audit_event_id resolved_at updated_at'),
      ('saas_unknown_outcome_reconciliation_observations', 'SELECT', 'id tenant_id case_id observation_kind observed_at attempt_id usage_event_id supply_mode execution_state reconciliation_state financial_status request_state_version dispatch_state result_state response_started attempt_state_version upstream_id account_owner_kind account_id provider_id product_id resolved_model attempt_unknown_reason usage_event_digest provider_status provider_operation_id provider_identity_digest provider_usage evidence_reference operator_outcome actor_user_id reason audit_event_id support_ticket_ref'),
      ('saas_unknown_outcome_reconciliation_observations', 'INSERT', 'id tenant_id case_id request_id attempt_id usage_event_id observation_kind supply_mode execution_state reconciliation_state financial_status request_state_version dispatch_state result_state response_started attempt_state_version upstream_id account_owner_kind account_id provider_id product_id resolved_model attempt_unknown_reason usage_event_digest evidence_reference operator_outcome actor_user_id reason audit_event_id support_ticket_ref observed_at provider_status provider_operation_id provider_identity_digest provider_usage'),
      ('saas_customer_webhook_tenant_policies', 'SELECT', 'tenant_id enabled max_active_endpoints'),
      ('saas_customer_webhook_tenant_policies', 'UPDATE', 'updated_at'),
      ('saas_customer_webhook_endpoints', 'SELECT', 'tenant_id id current_version state created_at updated_at'),
      ('saas_customer_webhook_endpoints', 'INSERT', 'tenant_id id current_version state created_by_user_id'),
      ('saas_customer_webhook_endpoints', 'UPDATE', 'current_version state updated_at'),
      ('saas_customer_webhook_endpoint_versions', 'SELECT', 'tenant_id endpoint_id version target_url event_types'),
      ('saas_customer_webhook_endpoint_versions', 'INSERT', 'tenant_id endpoint_id version target_url event_types created_by_user_id audit_event_id'),
      ('saas_customer_webhook_signing_secrets', 'SELECT', 'tenant_id endpoint_id secret_version state overlap_expires_at encrypted_envelope created_at'),
      ('saas_customer_webhook_signing_secrets', 'INSERT', 'tenant_id endpoint_id secret_version state encrypted_envelope audit_event_id'),
      ('saas_customer_webhook_signing_secrets', 'UPDATE', 'state overlap_expires_at'),
      ('saas_customer_webhook_events', 'SELECT', 'tenant_id event_id event_type schema_version occurred_at payload'),
      ('saas_customer_webhook_deliveries', 'SELECT', 'tenant_id id event_id endpoint_id endpoint_version secret_version overlap_secret_version payload_version state attempt_count attempt_sequence last_http_status last_latency_ms last_error_code available_at lease_token lease_expires_at fencing_token created_at'),
      ('saas_customer_webhook_deliveries', 'UPDATE', 'state attempt_count attempt_sequence available_at lease_token lease_expires_at fencing_token last_http_status last_latency_ms last_error_code delivered_at updated_at'),
      ('saas_customer_webhook_delivery_attempts', 'SELECT', 'tenant_id delivery_id fencing_token lease_token state'),
      ('saas_customer_webhook_delivery_attempts', 'INSERT', 'tenant_id delivery_id attempt_sequence fencing_token lease_token state'),
      ('saas_customer_webhook_delivery_attempts', 'UPDATE', 'state http_status latency_ms error_code finished_at'),
      ('saas_customer_webhook_tenant_usage', 'SELECT', 'tenant_id pending_deliveries'),
      ('saas_customer_webhook_tenant_usage', 'UPDATE', 'pending_deliveries updated_at')
    ) AS manifest(table_name, privilege_type, column_names)
  LOOP
    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
      INTO v_columns
    FROM pg_catalog.unnest(v_grant.column_names) AS expected(column_name)
    JOIN pg_catalog.pg_class AS relation ON relation.relname = v_grant.table_name
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid AND attribute.attname = expected.column_name
    WHERE namespace.nspname = 'model_router_saas'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    IF v_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT %s (%s) ON TABLE %I.%I TO %I',
        v_grant.privilege_type, v_columns, 'model_router_saas',
        v_grant.table_name, 'model_router_saas_control_plane'
      );
    END IF;
  END LOOP;

  FOR v_table IN
    SELECT manifest.table_name, manifest.privilege_type
    FROM (VALUES
      ('saas_billing_spending_freezes', 'DELETE'),
      ('saas_refund_wallet_freezes', 'DELETE')
    ) AS manifest(table_name, privilege_type)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'model_router_saas' AND relation.relname = v_table.table_name
        AND relation.relkind IN ('r', 'p')
    ) THEN
      EXECUTE pg_catalog.format(
        'GRANT %s ON TABLE %I.%I TO %I',
        v_table.privilege_type, 'model_router_saas', v_table.table_name, 'model_router_saas_control_plane'
      );
    END IF;
  END LOOP;

  FOR v_sequence IN
    SELECT manifest.sequence_name, manifest.privilege_type
    FROM (SELECT NULL::text AS sequence_name, NULL::text AS privilege_type WHERE FALSE) manifest
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'model_router_saas' AND relation.relname = v_sequence.sequence_name
        AND relation.relkind = 'S'
    ) THEN
      EXECUTE pg_catalog.format(
        'GRANT %s ON SEQUENCE %I.%I TO %I',
        v_sequence.privilege_type, 'model_router_saas', v_sequence.sequence_name,
        'model_router_saas_control_plane'
      );
    END IF;
  END LOOP;
END;
$control_plane_runtime_grants$;

-- SELECT is column-scoped to this fixed relation allowlist. Several adapter
-- statements intentionally read complete immutable authority snapshots; the
-- encrypted credential envelope is readable, but no credential/admin relation
-- appears in the write manifest below.
-- The health relation is not on the broad read allowlist: its SELECT, INSERT,
-- and UPDATE columns are individually listed below. The gateway probe requires
-- migration 040's relation and exact column ACLs before startup can pass.
DO $gateway_runtime_grants$
DECLARE
  v_table text;
  v_columns text;
  v_grant record;
BEGIN
  FOR v_table IN
    SELECT read_relation.table_name
    FROM (VALUES
      ('saas_tenants'), ('saas_projects'), ('saas_project_inference_policy_versions'),
      ('saas_users'), ('saas_memberships'), ('saas_project_memberships'), ('saas_api_keys'),
      ('saas_requests'), ('saas_attempts'), ('saas_project_entitlements'), ('saas_supply_profiles'),
      ('saas_route_config_versions'), ('saas_route_config_heads'), ('saas_route_config_dispatchable'),
      ('saas_route_config_commercial_authorities'), ('saas_public_model_versions'), ('saas_public_models'),
      ('saas_customer_metering_policy_heads'), ('saas_customer_metering_policy_versions'),
      ('saas_provider_metering_policy_heads'), ('saas_provider_metering_policy_versions'),
      ('saas_contract_test_attestations'), ('saas_provider_products'), ('saas_provider_capabilities'),
      ('saas_provider_rights'), ('saas_tenant_provider_supply_profile_accounts'),
      ('saas_tenant_provider_accounts'), ('saas_tenant_provider_credentials'),
      ('saas_tenant_provider_credential_versions'), ('saas_tenant_provider_account_capabilities'),
      ('saas_platform_provider_pools'), ('saas_platform_provider_pool_members'),
      ('saas_platform_provider_pool_grants'), ('saas_platform_provider_accounts'),
      ('saas_platform_provider_credentials'), ('saas_platform_provider_credential_versions'),
      ('saas_platform_provider_account_capabilities'), ('saas_service_plan_subscriptions'),
      ('saas_service_plan_snapshots'), ('saas_customer_price_versions'), ('saas_supplier_cost_versions'),
      ('saas_request_customer_price_snapshots'), ('saas_attempt_supplier_cost_snapshots'),
      ('saas_billing_reservations'), ('saas_wallets'), ('saas_refund_wallet_freezes'),
      ('saas_billing_spending_freezes'), ('saas_ledger_transactions'),
      ('saas_gateway_request_idempotency_keys'), ('saas_prepared_request_evidence'),
      ('saas_provider_account_leases'), ('saas_gateway_capacity_reservations'),
      ('saas_usage_events'), ('saas_usage_settlements')
    ) AS read_relation(table_name)
  LOOP
    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
      INTO v_columns
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'model_router_saas'
      AND relation.relname = v_table
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    IF v_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT SELECT (%s) ON TABLE %I.%I TO %I',
        v_columns, 'model_router_saas', v_table, 'model_router_saas_gateway'
      );
    END IF;
  END LOOP;

  -- Exact column DML manifest mirrored by SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.
  FOR v_grant IN
    SELECT manifest.table_name, manifest.privilege_type,
           pg_catalog.array_agg(manifest.column_name ORDER BY manifest.column_name) AS column_names
    FROM (VALUES
      ('saas_schema_migrations', 'version', 'SELECT'),
      ('saas_schema_migrations', 'name', 'SELECT'),
      ('saas_schema_migrations', 'checksum', 'SELECT'),
      ('saas_idempotency_records', 'tenant_id', 'SELECT'),
      ('saas_idempotency_records', 'request_id', 'SELECT'),
      ('saas_idempotency_records', 'kind', 'SELECT'),
      ('saas_idempotency_records', 'key_digest', 'SELECT'),
      ('saas_provider_account_runtime_health', 'owner_scope_key', 'SELECT'),
      ('saas_provider_account_runtime_health', 'owner_kind', 'SELECT'),
      ('saas_provider_account_runtime_health', 'owner_tenant_id', 'SELECT'),
      ('saas_provider_account_runtime_health', 'account_id', 'SELECT'),
      ('saas_provider_account_runtime_health', 'state', 'SELECT'),
      ('saas_provider_account_runtime_health', 'failure_count', 'SELECT'),
      ('saas_provider_account_runtime_health', 'observed_at', 'SELECT'),
      ('saas_provider_account_runtime_health', 'cooldown_until', 'SELECT'),
      ('saas_provider_account_runtime_health', 'last_outcome', 'SELECT'),
      ('saas_provider_account_runtime_health', 'source_fencing_token', 'SELECT'),
      ('saas_provider_account_runtime_health', 'revision', 'SELECT'),
      ('saas_provider_account_runtime_health', 'owner_scope_key', 'INSERT'),
      ('saas_provider_account_runtime_health', 'owner_kind', 'INSERT'),
      ('saas_provider_account_runtime_health', 'owner_tenant_id', 'INSERT'),
      ('saas_provider_account_runtime_health', 'account_id', 'INSERT'),
      ('saas_provider_account_runtime_health', 'state', 'INSERT'),
      ('saas_provider_account_runtime_health', 'failure_count', 'INSERT'),
      ('saas_provider_account_runtime_health', 'observed_at', 'INSERT'),
      ('saas_provider_account_runtime_health', 'cooldown_until', 'INSERT'),
      ('saas_provider_account_runtime_health', 'last_outcome', 'INSERT'),
      ('saas_provider_account_runtime_health', 'source_fencing_token', 'INSERT'),
      ('saas_provider_account_runtime_health', 'revision', 'INSERT'),
      ('saas_provider_account_runtime_health', 'state', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'failure_count', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'observed_at', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'cooldown_until', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'last_outcome', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'source_fencing_token', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'revision', 'UPDATE'),
      ('saas_gateway_provider_account_affinity', 'tenant_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'project_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'supply_profile_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'supply_mode', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'account_owner_kind', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'route_config_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'route_config_version', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'public_model_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'public_model_version', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'public_model', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'protocol', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'target_mode', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'upstream_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'provider_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'product_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'reference_kind', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'hmac_key_version', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'key_digest', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'account_id', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'state', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'revision', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'fencing_token', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'expires_at', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'created_at', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'updated_at', 'INSERT'),
      ('saas_gateway_provider_account_affinity', 'tenant_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'project_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'supply_profile_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'supply_mode', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'account_owner_kind', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'route_config_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'route_config_version', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'public_model_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'public_model_version', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'public_model', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'protocol', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'target_mode', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'upstream_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'provider_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'product_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'reference_kind', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'hmac_key_version', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'key_digest', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'account_id', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'state', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'revision', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'fencing_token', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'expires_at', 'SELECT'),
      ('saas_gateway_provider_account_affinity', 'account_id', 'UPDATE'),
      ('saas_gateway_provider_account_affinity', 'state', 'UPDATE'),
      ('saas_gateway_provider_account_affinity', 'revision', 'UPDATE'),
      ('saas_gateway_provider_account_affinity', 'fencing_token', 'UPDATE'),
      ('saas_gateway_provider_account_affinity', 'expires_at', 'UPDATE'),
      ('saas_gateway_provider_account_affinity', 'updated_at', 'UPDATE'),
      ('saas_tenant_provider_credential_wrappings', 'tenant_id', 'SELECT'),
      ('saas_tenant_provider_credential_wrappings', 'account_id', 'SELECT'),
      ('saas_tenant_provider_credential_wrappings', 'credential_id', 'SELECT'),
      ('saas_tenant_provider_credential_wrappings', 'credential_version', 'SELECT'),
      ('saas_tenant_provider_credential_wrappings', 'wrapping_revision', 'SELECT'),
      ('saas_tenant_provider_credential_wrappings', 'kms_key_id', 'SELECT'),
      ('saas_tenant_provider_credential_wrappings', 'wrapped_dek', 'SELECT'),
      ('saas_platform_provider_credential_wrappings', 'account_id', 'SELECT'),
      ('saas_platform_provider_credential_wrappings', 'credential_id', 'SELECT'),
      ('saas_platform_provider_credential_wrappings', 'credential_version', 'SELECT'),
      ('saas_platform_provider_credential_wrappings', 'wrapping_revision', 'SELECT'),
      ('saas_platform_provider_credential_wrappings', 'kms_key_id', 'SELECT'),
      ('saas_platform_provider_credential_wrappings', 'wrapped_dek', 'SELECT'),
      ('saas_requests', 'id', 'INSERT'), ('saas_requests', 'tenant_id', 'INSERT'),
      ('saas_requests', 'project_id', 'INSERT'), ('saas_requests', 'project_policy_version', 'INSERT'),
      ('saas_requests', 'proxy_key_id', 'INSERT'), ('saas_requests', 'entitlement_id', 'INSERT'),
      ('saas_requests', 'supply_profile_id', 'INSERT'), ('saas_requests', 'supply_profile_version', 'INSERT'),
      ('saas_requests', 'model_scope_version', 'INSERT'), ('saas_requests', 'supply_mode', 'INSERT'),
      ('saas_requests', 'principal_kind', 'INSERT'), ('saas_requests', 'principal_id', 'INSERT'),
      ('saas_requests', 'authz_version', 'INSERT'), ('saas_requests', 'entitlement_version', 'INSERT'),
      ('saas_requests', 'config_version', 'INSERT'), ('saas_requests', 'customer_metering_policy_id', 'INSERT'),
      ('saas_requests', 'customer_metering_policy_version', 'INSERT'),
      ('saas_requests', 'provider_metering_policy_id', 'INSERT'),
      ('saas_requests', 'provider_metering_policy_version', 'INSERT'),
      ('saas_requests', 'contract_attestation_id', 'INSERT'), ('saas_requests', 'route_config_id', 'INSERT'),
      ('saas_requests', 'route_config_version', 'INSERT'), ('saas_requests', 'route_public_model_id', 'INSERT'),
      ('saas_requests', 'route_public_model_version', 'INSERT'), ('saas_requests', 'route_protocol', 'INSERT'),
      ('saas_requests', 'route_target_mode', 'INSERT'), ('saas_requests', 'route_upstream_id', 'INSERT'),
      ('saas_requests', 'public_model', 'INSERT'), ('saas_requests', 'protocol', 'INSERT'),
      ('saas_requests', 'endpoint', 'INSERT'), ('saas_requests', 'request_fingerprint', 'INSERT'),
      ('saas_requests', 'request_fingerprint_version', 'INSERT'), ('saas_requests', 'customer_price_version', 'INSERT'),
      ('saas_requests', 'execution_state', 'INSERT'), ('saas_requests', 'financial_status', 'INSERT'),
      ('saas_requests', 'reconciliation_state', 'INSERT'), ('saas_requests', 'created_at', 'INSERT'),
      ('saas_requests', 'updated_at', 'INSERT'), ('saas_requests', 'state_version', 'INSERT'),
      ('saas_requests', 'execution_state', 'UPDATE'), ('saas_requests', 'reconciliation_state', 'UPDATE'),
      ('saas_requests', 'financial_status', 'UPDATE'), ('saas_requests', 'updated_at', 'UPDATE'),
      ('saas_requests', 'state_version', 'UPDATE'),
      ('saas_attempts', 'id', 'INSERT'), ('saas_attempts', 'tenant_id', 'INSERT'),
      ('saas_attempts', 'request_id', 'INSERT'), ('saas_attempts', 'project_policy_version', 'INSERT'),
      ('saas_attempts', 'customer_price_version', 'INSERT'),
      ('saas_attempts', 'customer_metering_policy_id', 'INSERT'),
      ('saas_attempts', 'customer_metering_policy_version', 'INSERT'),
      ('saas_attempts', 'provider_metering_policy_id', 'INSERT'),
      ('saas_attempts', 'provider_metering_policy_version', 'INSERT'),
      ('saas_attempts', 'contract_attestation_id', 'INSERT'), ('saas_attempts', 'route_config_id', 'INSERT'),
      ('saas_attempts', 'route_config_version', 'INSERT'), ('saas_attempts', 'route_public_model_id', 'INSERT'),
      ('saas_attempts', 'route_public_model_version', 'INSERT'), ('saas_attempts', 'route_protocol', 'INSERT'),
      ('saas_attempts', 'route_target_mode', 'INSERT'), ('saas_attempts', 'ordinal', 'INSERT'),
      ('saas_attempts', 'upstream_id', 'INSERT'), ('saas_attempts', 'binding_state', 'INSERT'),
      ('saas_attempts', 'dispatch_authority_state', 'INSERT'), ('saas_attempts', 'account_owner_kind', 'INSERT'),
      ('saas_attempts', 'tenant_account_id', 'INSERT'), ('saas_attempts', 'platform_account_id', 'INSERT'),
      ('saas_attempts', 'provider_id', 'INSERT'), ('saas_attempts', 'product_id', 'INSERT'),
      ('saas_attempts', 'resolved_model', 'INSERT'), ('saas_attempts', 'protocol', 'INSERT'),
      ('saas_attempts', 'endpoint', 'INSERT'), ('saas_attempts', 'supplier_cost_version', 'INSERT'),
      ('saas_attempts', 'dispatch_profile_id', 'INSERT'), ('saas_attempts', 'supply_profile_authz_version', 'INSERT'),
      ('saas_attempts', 'credential_id', 'INSERT'), ('saas_attempts', 'credential_version', 'INSERT'),
      ('saas_attempts', 'credential_authz_version', 'INSERT'), ('saas_attempts', 'account_authz_version', 'INSERT'),
      ('saas_attempts', 'pool_id', 'INSERT'), ('saas_attempts', 'pool_authz_version', 'INSERT'),
      ('saas_attempts', 'pool_member_account_authz_version', 'INSERT'),
      ('saas_attempts', 'pool_member_authz_version', 'INSERT'), ('saas_attempts', 'pool_grant_authz_version', 'INSERT'),
      ('saas_attempts', 'pool_grant_profile_authz_version', 'INSERT'),
      ('saas_attempts', 'pool_grant_pool_authz_version', 'INSERT'),
      ('saas_attempts', 'profile_account_authz_version', 'INSERT'),
      ('saas_attempts', 'model_resolution_requested_model', 'INSERT'),
      ('saas_attempts', 'model_resolution_mapped_model', 'INSERT'),
      ('saas_attempts', 'model_resolution_mapping_source', 'INSERT'),
      ('saas_attempts', 'model_resolution_mapping_version', 'INSERT'),
      ('saas_attempts', 'provider_protocol', 'INSERT'), ('saas_attempts', 'client_operation', 'INSERT'),
      ('saas_attempts', 'provider_operation', 'INSERT'), ('saas_attempts', 'request_fingerprint', 'INSERT'),
      ('saas_attempts', 'request_fingerprint_version', 'INSERT'),
      ('saas_attempts', 'payload_compiler_version', 'INSERT'), ('saas_attempts', 'usage_estimator_version', 'INSERT'),
      ('saas_attempts', 'payload_sha256', 'INSERT'), ('saas_attempts', 'dispatch_state', 'INSERT'),
      ('saas_attempts', 'result_state', 'INSERT'), ('saas_attempts', 'response_started', 'INSERT'),
      ('saas_attempts', 'created_at', 'INSERT'), ('saas_attempts', 'updated_at', 'INSERT'),
      ('saas_attempts', 'state_version', 'INSERT'), ('saas_attempts', 'dispatch_state', 'UPDATE'),
      ('saas_attempts', 'result_state', 'UPDATE'), ('saas_attempts', 'response_started', 'UPDATE'),
      ('saas_attempts', 'response_started_at', 'UPDATE'), ('saas_attempts', 'result_http_status', 'UPDATE'),
      ('saas_attempts', 'unknown_reason', 'UPDATE'), ('saas_attempts', 'updated_at', 'UPDATE'),
      ('saas_attempts', 'state_version', 'UPDATE'), ('saas_attempts', 'prepared_evidence_id', 'UPDATE'),
      ('saas_gateway_request_idempotency_keys', 'tenant_id', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'project_id', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'proxy_key_id', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'key_digest', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'request_fingerprint', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'request_fingerprint_version', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'request_id', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'state', 'INSERT'),
      ('saas_gateway_request_idempotency_keys', 'state', 'UPDATE'),
      ('saas_gateway_request_idempotency_keys', 'updated_at', 'UPDATE'),
      ('saas_gateway_request_idempotency_keys', 'completed_at', 'UPDATE'),
      ('saas_gateway_request_idempotency_keys', 'unknown_at', 'UPDATE'),
      ('saas_request_admission_outbox', 'id', 'INSERT'), ('saas_request_admission_outbox', 'tenant_id', 'INSERT'),
      ('saas_request_admission_outbox', 'project_id', 'INSERT'), ('saas_request_admission_outbox', 'request_id', 'INSERT'),
      ('saas_request_admission_outbox', 'attempt_id', 'INSERT'), ('saas_request_admission_outbox', 'supply_mode', 'INSERT'),
      ('saas_request_admission_outbox', 'event_key', 'INSERT'), ('saas_request_admission_outbox', 'event_type', 'INSERT'),
      ('saas_request_admission_outbox', 'schema_version', 'INSERT'), ('saas_request_admission_outbox', 'payload', 'INSERT'),
      ('saas_request_admission_outbox', 'delivery_state', 'INSERT'),
      ('saas_request_admission_outbox', 'delivery_attempts', 'INSERT'),
      ('saas_request_admission_outbox', 'available_at', 'INSERT'), ('saas_request_admission_outbox', 'lease_token', 'INSERT'),
      ('saas_request_admission_outbox', 'lease_expires_at', 'INSERT'),
      ('saas_request_admission_outbox', 'last_error_code', 'INSERT'),
      ('saas_request_admission_outbox', 'delivered_at', 'INSERT'), ('saas_request_admission_outbox', 'created_at', 'INSERT'),
      ('saas_request_admission_outbox', 'updated_at', 'INSERT'),
      ('saas_prepared_request_evidence', 'status', 'UPDATE'),
      ('saas_prepared_request_evidence', 'claimed_at', 'UPDATE'),
      ('saas_prepared_request_evidence', 'claimed_attempt_id', 'UPDATE'),
      ('saas_gateway_capacity_reservations', 'tenant_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'project_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'proxy_key_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'request_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'attempt_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'supply_mode', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'project_policy_version', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'key_authz_version', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'idempotency_scope_key', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'request_fingerprint', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'request_fingerprint_version', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'token_units', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'quota_reservation_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'rate_reservation_id', 'INSERT'),
      ('saas_gateway_capacity_reservations', 'state', 'UPDATE'),
      ('saas_gateway_capacity_reservations', 'updated_at', 'UPDATE'),
      ('saas_provider_account_leases', 'id', 'INSERT'), ('saas_provider_account_leases', 'tenant_id', 'INSERT'),
      ('saas_provider_account_leases', 'owner_kind', 'INSERT'),
      ('saas_provider_account_leases', 'owner_tenant_id', 'INSERT'),
      ('saas_provider_account_leases', 'account_id', 'INSERT'), ('saas_provider_account_leases', 'upstream_id', 'INSERT'),
      ('saas_provider_account_leases', 'attempt_id', 'INSERT'), ('saas_provider_account_leases', 'slot', 'INSERT'),
      ('saas_provider_account_leases', 'fencing_token', 'INSERT'),
      ('saas_provider_account_leases', 'status', 'INSERT'),
      ('saas_provider_account_leases', 'lease_expires_at', 'INSERT'),
      ('saas_provider_account_leases', 'status', 'UPDATE'),
      ('saas_provider_account_leases', 'lease_expires_at', 'UPDATE'),
      ('saas_provider_account_leases', 'released_at', 'UPDATE'),
      ('saas_provider_account_leases', 'updated_at', 'UPDATE'),
      ('saas_billing_reservations', 'id', 'INSERT'), ('saas_billing_reservations', 'tenant_id', 'INSERT'),
      ('saas_billing_reservations', 'wallet_id', 'INSERT'), ('saas_billing_reservations', 'currency', 'INSERT'),
      ('saas_billing_reservations', 'request_id', 'INSERT'),
      ('saas_billing_reservations', 'idempotency_namespace', 'INSERT'),
      ('saas_billing_reservations', 'business_key', 'INSERT'),
      ('saas_billing_reservations', 'amount_minor_units', 'INSERT'),
      ('saas_billing_reservations', 'state', 'INSERT'),
      ('saas_billing_reservations', 'price_snapshot_ref', 'INSERT'),
      ('saas_billing_reservations', 'metadata_ref', 'INSERT'),
      ('saas_billing_reservations', 'expires_at', 'INSERT'),
      ('saas_billing_reservations', 'created_at', 'INSERT'), ('saas_billing_reservations', 'updated_at', 'INSERT'),
      ('saas_billing_reservations', 'state', 'UPDATE'),
      ('saas_billing_reservations', 'settlement_id', 'UPDATE'),
      ('saas_billing_reservations', 'settlement_amount_minor_units', 'UPDATE'),
      ('saas_billing_reservations', 'usage_evidence_ref', 'UPDATE'),
      ('saas_billing_reservations', 'reconciliation_evidence_ref', 'UPDATE'),
      ('saas_billing_reservations', 'ledger_transaction_id', 'UPDATE'),
      ('saas_billing_reservations', 'release_id', 'UPDATE'),
      ('saas_billing_reservations', 'release_evidence_ref', 'UPDATE'),
      ('saas_billing_reservations', 'reconciliation_reference', 'UPDATE'),
      ('saas_billing_reservations', 'updated_at', 'UPDATE'),
      ('saas_wallets', 'posted_balance_minor_units', 'UPDATE'), ('saas_wallets', 'updated_at', 'UPDATE'),
      ('saas_billing_spending_freezes', 'tenant_id', 'INSERT'),
      ('saas_billing_spending_freezes', 'reason_ref', 'INSERT'),
      ('saas_billing_spending_freezes', 'frozen_at', 'INSERT'),
      ('saas_ledger_transactions', 'id', 'INSERT'), ('saas_ledger_transactions', 'tenant_id', 'INSERT'),
      ('saas_ledger_transactions', 'currency', 'INSERT'),
      ('saas_ledger_transactions', 'idempotency_namespace', 'INSERT'),
      ('saas_ledger_transactions', 'business_key', 'INSERT'),
      ('saas_ledger_transactions', 'source_type', 'INSERT'),
      ('saas_ledger_transactions', 'amount_minor_units', 'INSERT'),
      ('saas_ledger_transactions', 'metadata_ref', 'INSERT'),
      ('saas_ledger_transactions', 'source_order_ref', 'INSERT'),
      ('saas_ledger_transactions', 'price_snapshot_ref', 'INSERT'),
      ('saas_ledger_transactions', 'usage_evidence_ref', 'INSERT'),
      ('saas_ledger_transactions', 'created_at', 'INSERT'),
      ('saas_ledger_entries', 'id', 'INSERT'), ('saas_ledger_entries', 'transaction_id', 'INSERT'),
      ('saas_ledger_entries', 'tenant_id', 'INSERT'), ('saas_ledger_entries', 'currency', 'INSERT'),
      ('saas_ledger_entries', 'direction', 'INSERT'), ('saas_ledger_entries', 'amount_minor_units', 'INSERT'),
      ('saas_ledger_entries', 'account_type', 'INSERT'), ('saas_ledger_entries', 'account_ref', 'INSERT'),
      ('saas_ledger_entries', 'wallet_id', 'INSERT'), ('saas_ledger_entries', 'created_at', 'INSERT'),
      ('saas_usage_events', 'id', 'INSERT'), ('saas_usage_events', 'tenant_id', 'INSERT'),
      ('saas_usage_events', 'request_id', 'INSERT'), ('saas_usage_events', 'attempt_id', 'INSERT'),
      ('saas_usage_events', 'supply_mode', 'INSERT'), ('saas_usage_events', 'dedupe_key_digest', 'INSERT'),
      ('saas_usage_events', 'event_digest', 'INSERT'), ('saas_usage_events', 'input_total', 'INSERT'),
      ('saas_usage_events', 'input_uncached', 'INSERT'), ('saas_usage_events', 'cache_read', 'INSERT'),
      ('saas_usage_events', 'cache_write', 'INSERT'), ('saas_usage_events', 'cache_write_5m', 'INSERT'),
      ('saas_usage_events', 'cache_write_1h', 'INSERT'), ('saas_usage_events', 'output_total', 'INSERT'),
      ('saas_usage_events', 'reasoning_output', 'INSERT'), ('saas_usage_events', 'status', 'INSERT'),
      ('saas_usage_events', 'source', 'INSERT'), ('saas_usage_events', 'semantics_version', 'INSERT'),
      ('saas_usage_events', 'measurement_kind', 'INSERT'), ('saas_usage_events', 'billable_basis', 'INSERT'),
      ('saas_usage_events', 'created_at', 'INSERT'), ('saas_usage_events', 'event_digest', 'UPDATE'),
      ('saas_usage_settlements', 'id', 'INSERT'), ('saas_usage_settlements', 'tenant_id', 'INSERT'),
      ('saas_usage_settlements', 'usage_event_id', 'INSERT'), ('saas_usage_settlements', 'request_id', 'INSERT'),
      ('saas_usage_settlements', 'attempt_id', 'INSERT'),
      ('saas_usage_settlements', 'settlement_key_digest', 'INSERT'),
      ('saas_usage_settlements', 'settlement_digest', 'INSERT'),
      ('saas_usage_settlements', 'kind', 'INSERT'), ('saas_usage_settlements', 'created_at', 'INSERT'),
      ('saas_usage_settlements', 'settlement_digest', 'UPDATE'),
      ('saas_audit_events', 'id', 'INSERT'), ('saas_audit_events', 'tenant_id', 'INSERT'),
      ('saas_audit_events', 'actor_user_id', 'INSERT'), ('saas_audit_events', 'action', 'INSERT'),
      ('saas_audit_events', 'target_type', 'INSERT'), ('saas_audit_events', 'target_id', 'INSERT'),
      ('saas_audit_events', 'occurred_at', 'INSERT'), ('saas_audit_events', 'source_ip', 'INSERT'),
      ('saas_audit_events', 'user_agent', 'INSERT'), ('saas_audit_events', 'entry_point', 'INSERT'),
      ('saas_audit_events', 'request_id', 'INSERT')
    ) AS manifest(table_name, column_name, privilege_type)
    GROUP BY manifest.table_name, manifest.privilege_type
  LOOP
    SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
      INTO v_columns
    FROM pg_catalog.unnest(v_grant.column_names) AS expected(column_name)
    JOIN pg_catalog.pg_class AS relation ON relation.relname = v_grant.table_name
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid AND attribute.attname = expected.column_name
    WHERE namespace.nspname = 'model_router_saas'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    IF v_columns IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT %s (%s) ON TABLE %I.%I TO %I',
        v_grant.privilege_type, v_columns, 'model_router_saas',
        v_grant.table_name, 'model_router_saas_gateway'
      );
    END IF;
  END LOOP;

  -- The evidence adapter inserts its complete fixed EVIDENCE_COLUMNS record.
  SELECT pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' ORDER BY attribute.attnum)
    INTO v_columns
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
  WHERE namespace.nspname = 'model_router_saas'
    AND relation.relname = 'saas_prepared_request_evidence'
    AND relation.relkind IN ('r', 'p')
    AND attribute.attnum > 0 AND NOT attribute.attisdropped;
  IF v_columns IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'GRANT INSERT (%s) ON TABLE %I.%I TO %I',
      v_columns, 'model_router_saas', 'saas_prepared_request_evidence', 'model_router_saas_gateway'
    );
  END IF;

  IF pg_catalog.to_regclass('model_router_saas.saas_billing_spending_freezes') IS NOT NULL THEN
    EXECUTE 'GRANT DELETE ON TABLE model_router_saas.saas_billing_spending_freezes TO model_router_saas_gateway';
  END IF;
  IF pg_catalog.to_regclass('model_router_saas.saas_provider_account_lease_fencing_seq') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SEQUENCE model_router_saas.saas_provider_account_lease_fencing_seq TO model_router_saas_gateway';
  END IF;
END;
$gateway_runtime_grants$;

-- Global REVOKEs are needed because per-schema default ACLs add to, rather
-- than subtract from, global defaults. Scoped grants then expose only objects
-- created by the migrator inside the managed schema.
ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator
  REVOKE ALL PRIVILEGES ON TABLES
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator
  REVOKE ALL PRIVILEGES ON SEQUENCES
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;

ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator
  IN SCHEMA model_router_saas
  REVOKE ALL PRIVILEGES ON TABLES
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator
  IN SCHEMA model_router_saas
  REVOKE ALL PRIVILEGES ON SEQUENCES
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;
ALTER DEFAULT PRIVILEGES FOR ROLE model_router_saas_migrator
  IN SCHEMA model_router_saas
  REVOKE EXECUTE ON FUNCTIONS
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway;

-- No runtime privileges are granted automatically to future objects. Review
-- each new control-plane requirement and add its exact columns explicitly.

COMMIT;
