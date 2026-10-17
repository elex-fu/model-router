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
            AND relation.relname NOT IN ('saas_billing_spending_freezes', 'saas_image_tasks')
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
          AND relation.relname NOT IN ('saas_billing_spending_freezes', 'saas_image_tasks')
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
-- DEPLOYMENT NOTE (migration 093, Track D4): the quota snapshot columns on
-- both provider account tables are covered by the control-plane manifest
-- below and by the gateway's dynamic all-current-columns read grants, but
-- only after this template AND deploy/managed-saas-validation-worker-role-grants.sql
-- are re-applied on a database that already ran an older revision. Until
-- then the gateway/worker runtime privilege probes fail closed by design.
-- DEPLOYMENT NOTE (migration 108, R5b): the control plane owns the
-- opencode_go_protocol_rules column on both provider account tables (the
-- adaptive-routing rule table; admin mutation bumps authz_version).
-- DEPLOYMENT NOTE (migration 120, batch-3 cn-providers): the control plane
-- likewise owns the zhipu/minimax account_mode + api_protocol columns on
-- both provider account tables (the dual-mode configuration; admin mutation
-- bumps authz_version through the platform/cn-providers config store). The
-- CN-provider quota snapshot/worker columns are worker-written only: they
-- are granted in deploy/managed-saas-validation-worker-role-grants.sql (the
-- quota worker shares the credential-validation-worker role) and are
-- readable by the gateway through the dynamic all-current-columns grants
-- below. Re-apply both templates after 120.
-- DEPLOYMENT NOTE (migration 100, R5): the control plane likewise owns the
-- claude_cli_version_override column on both provider account tables (the
-- operator's CLI pin override; admin mutation bumps authz_version). The
-- claude usage snapshot/session-window columns are worker-written only:
-- they are granted in deploy/managed-saas-validation-worker-role-grants.sql
-- (the usage worker's role). The
-- opencode-go usage scheduling columns are worker-written only: they are
-- granted in deploy/managed-saas-validation-worker-role-grants.sql (the
-- usage worker shares the credential-validation-worker role like the quota
-- sync worker) and are readable by the gateway through the dynamic
-- all-current-columns grants below. Re-apply both templates after 108.
-- DEPLOYMENT NOTE (migration 105, R1 billing groups): the gateway reads
-- saas_billing_groups at admission through the dynamic all-current-columns
-- read grant below, and inserts the six new customer price snapshot
-- multiplier columns through the fixed column manifest; the control plane
-- manages the group and account-pool relations. Re-apply this template after
-- running migration 105 on a database that predates it — until then the
-- gateway runtime privilege probe fails closed by design.
-- DEPLOYMENT NOTE (F2, scheduler consumption of 105): the gateway account
-- scheduler additionally reads saas_billing_group_account_pools (the group
-- pool narrowing and per-group priority) through the dynamic all-current-
-- columns read grant below. Re-apply this template after the F2 change on a
-- database that predates it — until then the gateway runtime privilege probe
-- fails closed by design.
-- DEPLOYMENT NOTE (migration 121, composite model routing): the control
-- plane owns the composite route registry saas_composite_model_routes and
-- the composite marker column on saas_billing_groups; the gateway scheduler
-- reads the registry (and the marker through the existing group read grant)
-- while resolving composite-group requests. Re-apply this template after
-- running migration 121 on a database that predates it — until then the
-- gateway runtime privilege probe fails closed by design.
-- DEPLOYMENT NOTE (migration 128, batch-5 §5.1 plugin system): the control
-- plane owns the plugin installation registry and every binding edit; the
-- gateway reads routing truth only (the full saas_plugin_bindings row set
-- through the dynamic read-table grant, and the seven routing columns of
-- saas_plugin_installations through the fixed column manifest — never
-- artifact_data, the manifest blob or config_json). The standalone
-- plugin-host workload uses its own template
-- (deploy/managed-saas-plugin-host-role-grants.sql — apply it after the
-- migrate). Re-apply this template after running migration 128 on a
-- database that predates it — until then the runtime privilege probes fail
-- closed by design.
-- DEPLOYMENT NOTE (migration 106, R4 registration admission): the identity
-- control plane owns saas_email_verification_codes exclusively (issue,
-- verify-and-consume, attempt counting, expiry pruning); the gateway has no
-- grant on it. Re-apply this template after running migration 106 on a
-- database that predates it — until then the control-plane runtime privilege
-- probe fails closed by design.
-- DEPLOYMENT NOTE (migration 107, R3 egress proxies): the control plane
-- manages saas_egress_proxies and the accounts' egress binding columns
-- (including the probe/sweep worker's last_probe_* and expiry-migration
-- writes); the gateway and the OAuth refresh worker read the proxy table
-- through the dynamic all-current-columns read grant below. Re-apply this
-- template after running migration 107 on a database that predates it —
-- until then the runtime privilege probes fail closed by design.
-- DEPLOYMENT NOTE (migration 115, R-dormant activation batch 2.2): the
-- scheduling-threshold pause columns on both provider account tables are
-- gateway-written only (the scheduler's lazy candidate-collection
-- evaluation; the sub2api account_scheduling_threshold port). They are
-- granted through the fixed column manifest in the gateway block below and
-- read through the dynamic all-current-columns grants; the control plane
-- owns no threshold-pause column. The quota-snapshot writer (the 099/100
-- codex/claude columns) and the gemini usage worker's saas_attempts read
-- surface are granted in deploy/managed-saas-validation-worker-role-grants.sql.
-- Re-apply both templates after running migration 115 on a database that
-- predates it — until then the runtime privilege probes fail closed by
-- design.
-- DEPLOYMENT NOTE (migration 109, R6a active probing): the control plane
-- owns the saas_probe_monitors registry and reads saas_probe_runs (the
-- admin trigger/list surface); the probe monitor worker — which runs on the
-- credential-validation-worker workload like the R3 proxy probe worker —
-- claims due monitors, appends run history, prunes the 30-day retention
-- window and writes the accounts' probe_temp_unschedulable_until signal
-- through deploy/managed-saas-validation-worker-role-grants.sql. Re-apply
-- both templates after running migration 109 on a database that predates
-- it — until then the runtime privilege probes fail closed by design.
-- DEPLOYMENT NOTE (migration 111, F4 Gemini): the gemini usage/quota
-- scheduling columns on both provider account tables are worker-written
-- only (the tier-shaped daily/minute snapshots, the 429 cooldown deadline
-- and the loadCodeAssist tier id): they are granted in
-- deploy/managed-saas-validation-worker-role-grants.sql (the usage worker's
-- role) and are readable by the gateway through the dynamic
-- all-current-columns grants below; the control plane owns no gemini
-- column. Migration 111 also rewrites saas_probe_monitors'
-- provider_category CHECK to admit the 'gemini' probe category (same
-- control-plane surface, no grant change). Re-apply both templates after
-- running migration 111 on a database that predates it.
-- DEPLOYMENT NOTE (migration 117, batch-3 Bedrock): the bedrock scheduling
-- columns on both provider account tables (bedrock_rate_limited_until —
-- the ThrottlingException cooldown deadline — and
-- bedrock_usage_updated_at — the observation stamp) are worker-written
-- only (the quota-snapshot store's bedrock rate-limit sink): they are
-- granted in deploy/managed-saas-validation-worker-role-grants.sql and are
-- readable by the gateway through the dynamic all-current-columns grants
-- below; the control plane owns no bedrock column. Migration 117 also
-- rewrites saas_probe_monitors' provider_category CHECK to admit the
-- 'bedrock' probe category (same control-plane surface, no grant change).
-- Re-apply both templates after running migration 117 on a database that
-- predates it.
-- DEPLOYMENT NOTE (migration 110, F1 platform settings): the control plane
-- owns saas_platform_settings exclusively (admin settings surface plus the
-- registration-admission and topup-tier read paths, all control-plane
-- workloads); the gateway and the credential-validation worker have no
-- grant — secret settings values (KMS sealed envelopes) must never be
-- readable outside the control plane. Rows are never DELETEd; every
-- mutation is an audited version-CAS UPDATE. Re-apply this template after
-- running migration 110 on a database that predates it — until then the
-- control-plane runtime privilege probe fails closed by design.
-- DEPLOYMENT NOTE (migration 114, R1 billing-group limit enforcement
-- phase 3): the gateway owns the new saas_billing_group_spend_counters and
-- saas_billing_group_spend_reservations relations (the KEY-BUD counters
-- pattern at group scope), UPDATEs the settled amount on
-- saas_api_key_budget_reservations (the rolling 5h/7d window evidence), and
-- reads the new charge_5h/charge_7d policy columns through the dynamic
-- all-current-columns grant; the control plane manages the new policy
-- columns through its manifest above. Re-apply this template after running
-- migration 114 on a database that predates it — until then the runtime
-- privilege probes fail closed by design.
-- DEPLOYMENT NOTE (migration 113, R1 billing-group limit enforcement
-- phase 2): the gateway owns the new saas_billing_group_rate_counters table
-- (per-group per-second admission counters, the 098 account-counter pattern
-- at group scope). It is granted through the dynamic all-current-columns
-- read list plus the fixed column manifest below; the control plane and the
-- validation worker have no grant. Re-apply this template after running
-- migration 113 on a database that predates it — until then the gateway
-- runtime privilege probe fails closed by design.
-- DEPLOYMENT NOTE (migration 112, R1 billing-group limit enforcement
-- phase 1): the customer price snapshot gains the frozen group enforcement
-- columns (group RPM/spend ceilings, supported model scopes, fallback
-- group id). The gateway inserts them through the fixed column manifest
-- below and reads them back through the dynamic all-current-columns read
-- grant. Re-apply this template after running migration 112 on a database
-- that predates it — until then the gateway runtime privilege probe fails
-- closed by design.
-- DEPLOYMENT NOTE (migration 125, content risk control): the control plane
-- owns the single-row JSONB config (saas_risk_control_config), the admin log
-- surface and the retention cleanup (DELETE on the log and flagged-hash
-- tables); the gateway moderation seam reads the config and blocklist, writes
-- decision logs and flagged hashes, and flips saas_users.disabled_at for
-- auto-ban (the same column the governance service uses). Re-apply this
-- template after running migration 125 on a database that predates it —
-- until then both runtime privilege probes fail closed by design.
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
      -- F1 (110) platform settings: the control plane owns the settings store
      -- exclusively (admin read/write surface, registration admission and
      -- topup tier resolution). No DELETE — settings rows are never removed;
      -- a reset is an audited UPDATE. The gateway and the credential
      -- validation worker have no grant: secret settings values must never be
      -- readable outside the control plane (fail-closed posture).
      ('saas_platform_settings', 'SELECT', 'key value version updated_by_user_id created_at updated_at'),
      ('saas_platform_settings', 'INSERT', 'key value version updated_by_user_id created_at updated_at'),
      ('saas_platform_settings', 'UPDATE', 'value version updated_by_user_id updated_at'),
      -- F1 (110) settings audit details: append-only facts written in the
      -- same transaction as the settings mutation; immutability triggers make
      -- UPDATE and DELETE structurally impossible, so the control plane gets
      -- no such grant.
      ('saas_platform_settings_audit_details', 'SELECT', 'audit_event_id settings_key before_version after_version change_summary created_at'),
      ('saas_platform_settings_audit_details', 'INSERT', 'audit_event_id settings_key before_version after_version change_summary created_at'),
      ('saas_users', 'SELECT', 'id email email_canonical display_name password_hash disabled_at anonymized_at email_verified_at created_at'),
      ('saas_users', 'INSERT', 'id email password_hash display_name email_verified_at disabled_at created_at updated_at'),
      ('saas_users', 'UPDATE', 'password_hash disabled_at updated_at'),
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
      ('saas_mfa_credentials', 'SELECT', 'id user_id kind credential_id public_key encrypted_secret sign_count created_at verified_at revoked_at last_used_step'),
      ('saas_mfa_credentials', 'INSERT', 'id user_id kind credential_id public_key encrypted_secret sign_count created_at verified_at revoked_at'),
      ('saas_mfa_credentials', 'UPDATE', 'verified_at revoked_at last_used_step sign_count'),
      ('saas_customer_passkey_ceremonies', 'SELECT', 'id user_id session_id ceremony challenge_hash credential_id password_digest attempt_count created_at expires_at consumed_at closed_at'),
      ('saas_customer_passkey_ceremonies', 'INSERT', 'id user_id session_id ceremony challenge_hash credential_id password_digest created_at expires_at'),
      ('saas_customer_passkey_ceremonies', 'UPDATE', 'credential_id attempt_count consumed_at closed_at'),
      ('tenant_oauth_identities', 'SELECT', 'id provider_type provider_subject tenant_user_id email created_at updated_at'),
      ('tenant_oauth_identities', 'INSERT', 'id provider_type provider_subject tenant_user_id email created_at updated_at'),
      ('tenant_oauth_identities', 'UPDATE', 'email updated_at'),
      ('saas_obs_channel_metrics_1m', 'SELECT', 'bucket_at provider_id route_id model error_category requests errors upstream_affected'),
      ('saas_obs_channel_metrics_1m', 'INSERT', 'bucket_at provider_id route_id model error_category requests errors upstream_affected'),
      ('saas_obs_channel_metrics_1m', 'UPDATE', 'requests errors upstream_affected'),
      ('saas_obs_channel_metrics_hourly', 'SELECT', 'bucket_at provider_id route_id model error_category requests errors upstream_affected'),
      ('saas_obs_channel_metrics_hourly', 'INSERT', 'bucket_at provider_id route_id model error_category requests errors upstream_affected'),
      ('saas_obs_channel_metrics_hourly', 'UPDATE', 'requests errors upstream_affected'),
      ('saas_obs_channel_metrics_watermark', 'SELECT', 'watermark_key last_bucket_at'),
      ('saas_obs_channel_metrics_watermark', 'INSERT', 'watermark_key last_bucket_at'),
      ('saas_obs_channel_metrics_watermark', 'UPDATE', 'last_bucket_at'),
      ('saas_obs_alert_rules', 'SELECT', 'id name enabled metric operator threshold window_minutes sustained_minutes cooldown_minutes notify_email webhook_url last_triggered_at created_at'),
      ('saas_obs_alert_rules', 'INSERT', 'id name enabled metric operator threshold window_minutes sustained_minutes cooldown_minutes notify_email webhook_url'),
      ('saas_obs_alert_rules', 'UPDATE', 'name enabled metric operator threshold window_minutes sustained_minutes cooldown_minutes notify_email webhook_url last_triggered_at'),
      ('saas_obs_alert_events', 'SELECT', 'id rule_id triggered_at resolved_at payload'),
      ('saas_obs_alert_events', 'INSERT', 'id rule_id triggered_at payload'),
      -- Batch-5 §5.6 (migration 127): alert auto-resolve (the evaluator
      -- closes a rule's open events when a cycle does not violate), the
      -- operator silence registry, and the report scheduler's last_run rows.
      ('saas_obs_alert_events', 'UPDATE', 'resolved_at'),
      ('saas_obs_alert_silences', 'SELECT', 'id rule_id platform group_id region until reason created_by created_at'),
      ('saas_obs_alert_silences', 'INSERT', 'id rule_id platform group_id region until reason created_by'),
      ('saas_obs_report_state', 'SELECT', 'report_type last_run_at updated_at'),
      ('saas_obs_report_state', 'INSERT', 'report_type last_run_at'),
      ('saas_obs_report_state', 'UPDATE', 'last_run_at updated_at'),
      ('saas_platform_mfa_enrollment_tokens', 'SELECT', 'id user_id token_hash created_at expires_at consumed_at'),
      ('saas_platform_mfa_enrollment_tokens', 'INSERT', 'id user_id token_hash created_at expires_at consumed_at'),
      ('saas_platform_mfa_enrollment_tokens', 'UPDATE', 'consumed_at'),
      ('saas_platform_mfa_setup_tokens', 'SELECT', 'id user_id credential_id token_hash attempt_count attempt_limit created_at expires_at consumed_at locked_at'),
      ('saas_platform_mfa_setup_tokens', 'INSERT', 'id user_id credential_id token_hash attempt_count attempt_limit created_at expires_at consumed_at locked_at'),
      ('saas_platform_mfa_setup_tokens', 'UPDATE', 'attempt_count locked_at consumed_at'),
      ('saas_tenants', 'SELECT', 'id name slug slug_canonical status created_at updated_at capacity_policy_revision requests_per_minute tokens_per_minute max_concurrent_requests default_billing_group_id'),
      ('saas_tenants', 'INSERT', 'id name slug status created_at updated_at'),
      ('saas_tenants', 'UPDATE', 'status requests_per_minute tokens_per_minute max_concurrent_requests capacity_policy_revision updated_at default_billing_group_id'),
      -- R1 (105) billing groups: the control plane manages group heads and
      -- account-pool bindings; the gateway reads groups at admission only.
      ('saas_billing_groups', 'SELECT', 'id display_name rate_multiplier_num rate_multiplier_den topup_multiplier_num topup_multiplier_den peak_enabled peak_start peak_end peak_multiplier_num peak_multiplier_den model_pricing rpm_limit daily_limit_minor_units weekly_limit_minor_units monthly_limit_minor_units profit_min_margin_num profit_min_margin_den profit_safety_buffer_num profit_safety_buffer_den claude_code_only fallback_group_id supported_model_scopes composite status created_at updated_at'),
      ('saas_billing_groups', 'INSERT', 'id display_name rate_multiplier_num rate_multiplier_den topup_multiplier_num topup_multiplier_den peak_enabled peak_start peak_end peak_multiplier_num peak_multiplier_den model_pricing rpm_limit daily_limit_minor_units weekly_limit_minor_units monthly_limit_minor_units profit_min_margin_num profit_min_margin_den profit_safety_buffer_num profit_safety_buffer_den claude_code_only fallback_group_id supported_model_scopes composite status created_at updated_at'),
      ('saas_billing_groups', 'UPDATE', 'display_name rate_multiplier_num rate_multiplier_den topup_multiplier_num topup_multiplier_den peak_enabled peak_start peak_end peak_multiplier_num peak_multiplier_den model_pricing rpm_limit daily_limit_minor_units weekly_limit_minor_units monthly_limit_minor_units profit_min_margin_num profit_min_margin_den profit_safety_buffer_num profit_safety_buffer_den claude_code_only fallback_group_id supported_model_scopes composite status updated_at'),
      ('saas_billing_group_account_pools', 'SELECT', 'group_id account_id priority created_at'),
      ('saas_billing_group_account_pools', 'INSERT', 'group_id account_id priority'),
      ('saas_billing_group_account_pools', 'UPDATE', 'priority'),
      -- 125 (batch-5 §5.4) risk control: the control plane owns the
      -- single-row JSONB config (admin PUT), reads the moderation decision
      -- log for the admin surface, and runs the retention cleanup; the
      -- flagged-hash blocklist deletes ride the table-level DELETE manifest.
      ('saas_risk_control_config', 'SELECT', 'id config updated_at'),
      ('saas_risk_control_config', 'INSERT', 'id config updated_at'),
      ('saas_risk_control_config', 'UPDATE', 'config updated_at'),
      ('saas_content_moderation_logs', 'SELECT', 'id request_id tenant_id user_id api_key_id api_key_name model protocol mode action flagged highest_category highest_score matched_keyword category_scores threshold_snapshot input_excerpt input_hash upstream_latency_ms error violation_count auto_banned email_sent created_at'),
      ('saas_content_moderation_flagged_hashes', 'SELECT', 'input_hash created_at'),
      -- (121) composite model routes: the control plane manages the composite
      -- route registry; the gateway reads it during composite-group resolution
      -- (the dynamic read-table grant below).
      ('saas_composite_model_routes', 'SELECT', 'id group_id public_model match_type target_platform upstream_model endpoint priority enabled notes created_at updated_at'),
      ('saas_composite_model_routes', 'INSERT', 'group_id public_model match_type target_platform upstream_model endpoint priority enabled notes created_at updated_at'),
      ('saas_composite_model_routes', 'UPDATE', 'public_model match_type target_platform upstream_model endpoint priority enabled notes updated_at'),
      -- 126 (batch-5 §5.2) OEM white-label: the control plane materializes
      -- the public brand snapshot (the non-secret saas.brand.* settings
      -- subset) into the single-row table the gateway and the
      -- console-serving workloads read. No DELETE: the row is never removed.
      ('saas_public_brand_settings', 'SELECT', 'singleton snapshot version materialized_at'),
      ('saas_public_brand_settings', 'INSERT', 'singleton snapshot version materialized_at'),
      ('saas_public_brand_settings', 'UPDATE', 'snapshot version materialized_at'),
      -- R3 (107) egress proxies: the control plane manages the proxy registry
      -- and runs the probe/sweep worker; the gateway and the OAuth refresh
      -- worker read through the dynamic read-table grant below.
      ('saas_egress_proxies', 'SELECT', 'id name protocol host port auth_sealed_envelope status expires_at fallback_mode backup_proxy_id last_probe_at last_probe_latency_ms last_probe_ip last_probe_quality created_at updated_at'),
      ('saas_egress_proxies', 'INSERT', 'id name protocol host port auth_sealed_envelope status expires_at fallback_mode backup_proxy_id created_at updated_at'),
      ('saas_egress_proxies', 'UPDATE', 'name protocol host port auth_sealed_envelope status expires_at fallback_mode backup_proxy_id last_probe_at last_probe_latency_ms last_probe_ip last_probe_quality updated_at'),
      -- Batch-2 §2.4 (116) TLS fingerprint profiles: control-plane registry.
      ('saas_tls_fingerprint_profiles', 'SELECT', 'id name description enable_grease cipher_suites curves point_formats signature_algorithms alpn_protocols supported_versions key_share_groups psk_modes extensions created_at updated_at'),
      ('saas_tls_fingerprint_profiles', 'INSERT', 'id name description enable_grease cipher_suites curves point_formats signature_algorithms alpn_protocols supported_versions key_share_groups psk_modes extensions created_at updated_at'),
      ('saas_tls_fingerprint_profiles', 'UPDATE', 'name description enable_grease cipher_suites curves point_formats signature_algorithms alpn_protocols supported_versions key_share_groups psk_modes extensions updated_at'),
      -- R6a (109) probe monitors: the control plane owns the monitor registry
      -- (admin trigger/list surface) and reads the run history; the probe
      -- monitor worker claims and writes through the validation-worker grants.
      ('saas_probe_monitors', 'SELECT', 'id owner_scope_key owner_kind owner_tenant_id account_id provider_category probe_interval_seconds challenge_prompt challenge_answer failure_threshold consecutive_failures last_result last_result_detail last_run_at next_due_at probe_requested_at enabled created_at updated_at'),
      ('saas_probe_monitors', 'INSERT', 'id owner_scope_key owner_kind owner_tenant_id account_id provider_category probe_interval_seconds challenge_prompt challenge_answer failure_threshold next_due_at probe_requested_at enabled created_at updated_at'),
      ('saas_probe_monitors', 'UPDATE', 'probe_interval_seconds challenge_prompt challenge_answer failure_threshold enabled next_due_at probe_requested_at updated_at'),
      -- R6a (109) probe run history is append-only: SELECT + INSERT only;
      -- retention cleanup rides the table-level DELETE manifest below.
      ('saas_probe_runs', 'SELECT', 'id monitor_id triggered_by result detail http_status latency_ms created_at'),
      ('saas_probe_runs', 'INSERT', 'id monitor_id triggered_by result detail http_status latency_ms created_at'),
      -- R4 (106) registration admission: the identity control plane issues,
      -- verifies, consumes and prunes email verification codes. No gateway
      -- access — the table is never read outside the control plane.
      ('saas_email_verification_codes', 'SELECT', 'id email_canonical purpose code_hash attempts expires_at consumed_at created_ip created_at'),
      ('saas_email_verification_codes', 'INSERT', 'id email_canonical purpose code_hash expires_at created_ip created_at'),
      ('saas_email_verification_codes', 'UPDATE', 'attempts consumed_at'),
      ('saas_memberships', 'SELECT', 'tenant_id user_id role status revoked_at'),
      ('saas_memberships', 'INSERT', 'tenant_id user_id role created_at updated_at'),
      ('saas_memberships', 'UPDATE', 'role status revoked_at updated_at'),
      ('saas_projects', 'SELECT', 'tenant_id id name slug slug_canonical is_default created_at updated_at inference_policy_version inference_policy_status'),
      ('saas_projects', 'INSERT', 'tenant_id id name slug is_default created_at updated_at'),
      ('saas_projects', 'UPDATE', 'inference_policy_version inference_policy_status updated_at'),
      ('saas_project_memberships', 'SELECT', 'tenant_id project_id user_id role status revoked_at'),
      ('saas_project_memberships', 'INSERT', 'tenant_id project_id user_id role created_at updated_at'),
      ('saas_project_memberships', 'UPDATE', 'status revoked_at updated_at'),
      ('saas_invitations', 'SELECT', 'tenant_id id invited_email invited_email_canonical role token_hash created_by_user_id accepted_by_user_id created_at expires_at accepted_at revoked_at'),
      ('saas_invitations', 'INSERT', 'tenant_id id invited_email role token_hash created_by_user_id created_at expires_at accepted_at revoked_at'),
      ('saas_invitations', 'UPDATE', 'accepted_by_user_id accepted_at revoked_at'),
      ('saas_project_inference_policy_versions', 'SELECT', 'tenant_id project_id version status changed_by_user_id created_at requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_project_inference_policy_versions', 'INSERT', 'tenant_id project_id version status changed_by_user_id created_at requests_per_minute tokens_per_minute max_concurrent_requests'),
      ('saas_api_keys', 'SELECT', 'id tenant_id project_id principal_user_id execution_principal_type execution_principal_id created_by_user_id rotated_by_user_id revoked_by_user_id entitlement_id supply_profile_id supply_mode name prefix key_hash model_scopes status created_at expires_at revoked_at last_used_at authz_version model_scope_version entitlement_authz_version supply_profile_authz_version requests_per_minute tokens_per_minute max_concurrent_requests billing_group_id'),
      ('saas_api_keys', 'INSERT', 'id tenant_id project_id principal_user_id execution_principal_type execution_principal_id created_by_user_id entitlement_id supply_profile_id supply_mode name prefix key_hash model_scopes status created_at expires_at revoked_at last_used_at authz_version model_scope_version entitlement_authz_version supply_profile_authz_version billing_group_id'),
      ('saas_api_keys', 'UPDATE', 'status revoked_at revoked_by_user_id rotated_by_user_id last_used_at authz_version model_scope_version entitlement_authz_version supply_profile_authz_version requests_per_minute tokens_per_minute max_concurrent_requests billing_group_id'),
      ('saas_api_key_ip_policies', 'SELECT', 'tenant_id project_id key_id version mode rules created_at updated_at'),
      ('saas_api_key_ip_policies', 'INSERT', 'tenant_id project_id key_id version mode rules created_at updated_at'),
      ('saas_api_key_ip_policies', 'UPDATE', 'version mode rules updated_at'),
      ('saas_api_key_budget_policies', 'SELECT', 'tenant_id project_id key_id lineage_id version token_daily token_lifetime charge_daily charge_lifetime charge_5h charge_7d created_at updated_at'),
      ('saas_api_key_budget_policies', 'INSERT', 'tenant_id project_id key_id lineage_id version token_daily token_lifetime charge_daily charge_lifetime charge_5h charge_7d created_at updated_at'),
      ('saas_api_key_budget_policies', 'UPDATE', 'version token_daily token_lifetime charge_daily charge_lifetime charge_5h charge_7d updated_at'),
      ('saas_api_key_budget_counters', 'SELECT', 'tenant_id project_id lineage_id window_kind day token_settled token_outstanding_reserved charge_settled charge_outstanding_reserved charge_currency created_at updated_at'),
      ('saas_api_key_budget_counters', 'UPDATE', 'token_settled charge_settled updated_at'),
      ('saas_api_key_budget_reservations', 'SELECT', 'tenant_id project_id lineage_id request_id day token_units charge_minor_units charge_currency state created_at updated_at'),
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
      ('saas_tenant_provider_accounts', 'SELECT', 'owner_kind tenant_id supply_mode id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state validation_error_code last_validated_at revalidation_interval_seconds authz_version priority weight quota_state quota_remaining_minor_units quota_currency quota_checked_at opencode_go_protocol_rules zhipu_account_mode zhipu_api_protocol minimax_account_mode minimax_api_protocol claude_cli_version_override quarantine_entered_at quarantine_reason_code rpm_limit tpm_limit created_at updated_at disabled_at revoked_at egress_proxy_id proxy_fallback_origin_id tls_fingerprint_profile_id probe_temp_unschedulable_until'),
      ('saas_tenant_provider_accounts', 'INSERT', 'tenant_id id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state revalidation_interval_seconds priority weight rpm_limit tpm_limit egress_proxy_id tls_fingerprint_profile_id created_at updated_at'),
      ('saas_tenant_provider_accounts', 'UPDATE', 'status validation_state validation_error_code last_validated_at revalidation_interval_seconds authz_version priority weight quota_state quota_remaining_minor_units quota_currency quota_checked_at opencode_go_protocol_rules zhipu_account_mode zhipu_api_protocol minimax_account_mode minimax_api_protocol claude_cli_version_override rpm_limit tpm_limit egress_proxy_id proxy_fallback_origin_id tls_fingerprint_profile_id probe_temp_unschedulable_until updated_at disabled_at revoked_at'),
      ('saas_platform_provider_accounts', 'SELECT', 'owner_kind supply_mode id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state validation_error_code last_validated_at revalidation_interval_seconds authz_version priority weight quota_state quota_remaining_minor_units quota_currency quota_checked_at opencode_go_protocol_rules zhipu_account_mode zhipu_api_protocol minimax_account_mode minimax_api_protocol claude_cli_version_override quarantine_entered_at quarantine_reason_code rpm_limit tpm_limit created_at updated_at disabled_at revoked_at egress_proxy_id proxy_fallback_origin_id tls_fingerprint_profile_id probe_temp_unschedulable_until'),
      ('saas_platform_provider_accounts', 'INSERT', 'id display_name provider_id product_id credential_type region purpose rights_id rights_version status validation_state revalidation_interval_seconds priority weight rpm_limit tpm_limit egress_proxy_id tls_fingerprint_profile_id created_at updated_at'),
      ('saas_platform_provider_accounts', 'UPDATE', 'status validation_state validation_error_code last_validated_at revalidation_interval_seconds authz_version priority weight quota_state quota_remaining_minor_units quota_currency quota_checked_at opencode_go_protocol_rules zhipu_account_mode zhipu_api_protocol minimax_account_mode minimax_api_protocol claude_cli_version_override rpm_limit tpm_limit egress_proxy_id proxy_fallback_origin_id tls_fingerprint_profile_id probe_temp_unschedulable_until updated_at disabled_at revoked_at'),
      ('saas_tenant_provider_account_capabilities', 'SELECT', 'tenant_id account_id provider_id product_id model endpoint capability_version'),
      ('saas_tenant_provider_account_capabilities', 'INSERT', 'tenant_id account_id provider_id product_id model endpoint capability_version'),
      ('saas_platform_provider_account_capabilities', 'SELECT', 'account_id provider_id product_id model endpoint capability_version'),
      ('saas_platform_provider_account_capabilities', 'INSERT', 'account_id provider_id product_id model endpoint capability_version'),
      ('saas_customer_price_versions', 'SELECT', 'id version public_model_id public_model_version provider_id product_id protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units per_unit_rate_numerator_minor_units per_unit_rate_denominator_units per_unit_tier_rates token_multipliers effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_customer_price_versions', 'INSERT', 'id version public_model_id public_model_version provider_id product_id protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units per_unit_rate_numerator_minor_units per_unit_rate_denominator_units per_unit_tier_rates token_multipliers effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_supplier_cost_versions', 'SELECT', 'id version public_model_id public_model_version provider_id product_id resolved_model protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units per_unit_rate_numerator_minor_units per_unit_rate_denominator_units per_unit_tier_rates token_multipliers effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_supplier_cost_versions', 'INSERT', 'id version public_model_id public_model_version provider_id product_id resolved_model protocol endpoint currency commercial_policy_version calculator_version rounding_version rounding_mode rounding_boundary input_rate_numerator_minor_units input_rate_denominator_units cache_read_rate_numerator_minor_units cache_read_rate_denominator_units cache_write_rate_numerator_minor_units cache_write_rate_denominator_units cache_write_5m_rate_numerator_minor_units cache_write_5m_rate_denominator_units cache_write_1h_rate_numerator_minor_units cache_write_1h_rate_denominator_units output_rate_numerator_minor_units output_rate_denominator_units per_unit_rate_numerator_minor_units per_unit_rate_denominator_units per_unit_tier_rates token_multipliers effective_at expires_at idempotency_key definition_digest created_at'),
      ('saas_tenant_provider_credentials', 'SELECT', 'owner_kind tenant_id supply_mode id account_id provider_id product_id credential_type status validation_state validation_error_code last_validated_at current_version expires_at authz_version created_at updated_at disabled_at revoked_at oauth_refresh_state oauth_next_refresh_at oauth_last_refresh_at oauth_force_refresh_requested oauth_refresh_error_code'),
      ('saas_tenant_provider_credentials', 'INSERT', 'tenant_id id account_id provider_id product_id credential_type status validation_state expires_at created_at updated_at oauth_refresh_state oauth_next_refresh_at'),
      ('saas_tenant_provider_credentials', 'UPDATE', 'status validation_state validation_error_code last_validated_at current_version expires_at authz_version updated_at disabled_at revoked_at oauth_refresh_state oauth_next_refresh_at oauth_last_refresh_at oauth_force_refresh_requested oauth_refresh_error_code'),
      ('saas_platform_provider_credentials', 'SELECT', 'owner_kind supply_mode id account_id provider_id product_id credential_type status validation_state validation_error_code last_validated_at current_version expires_at authz_version created_at updated_at disabled_at revoked_at oauth_refresh_state oauth_next_refresh_at oauth_last_refresh_at oauth_force_refresh_requested oauth_refresh_error_code'),
      ('saas_platform_provider_credentials', 'INSERT', 'id account_id provider_id product_id credential_type status validation_state expires_at created_at updated_at oauth_refresh_state oauth_next_refresh_at'),
      ('saas_platform_provider_credentials', 'UPDATE', 'status validation_state validation_error_code last_validated_at current_version expires_at authz_version updated_at disabled_at revoked_at oauth_refresh_state oauth_next_refresh_at oauth_last_refresh_at oauth_force_refresh_requested oauth_refresh_error_code'),
      ('saas_tenant_provider_credential_versions', 'SELECT', 'owner_kind tenant_id supply_mode account_id credential_id version status schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at retired_at revoked_at'),
      ('saas_tenant_provider_credential_versions', 'INSERT', 'tenant_id account_id credential_id version schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at'),
      ('saas_tenant_provider_credential_versions', 'UPDATE', 'status retired_at revoked_at'),
      ('saas_platform_provider_credential_versions', 'SELECT', 'owner_kind supply_mode account_id credential_id version status schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at retired_at revoked_at'),
      ('saas_platform_provider_credential_versions', 'INSERT', 'account_id credential_id version schema_version context_version algorithm kms_purpose kms_key_id wrapping_revision wrapped_dek nonce ciphertext auth_tag created_at expires_at'),
      ('saas_platform_provider_credential_versions', 'UPDATE', 'status retired_at revoked_at'),
      ('saas_tenant_provider_credential_wrappings', 'SELECT', 'owner_kind tenant_id account_id credential_id credential_version expected_wrapping_revision wrapping_revision operation_id source_kms_key_id kms_key_id wrapped_dek context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
      ('saas_tenant_provider_credential_wrappings', 'INSERT', 'tenant_id account_id credential_id credential_version wrapping_revision expected_wrapping_revision operation_id source_kms_key_id kms_key_id wrapped_dek context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
      ('saas_platform_provider_credential_wrappings', 'SELECT', 'owner_kind account_id credential_id credential_version expected_wrapping_revision wrapping_revision operation_id source_kms_key_id kms_key_id wrapped_dek context_sha256 actor_kind actor_user_id actor_workload_id request_id reason_code created_at'),
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
      ('saas_platform_provider_credential_validation_jobs', 'SELECT', 'id account_id credential_id credential_version provider_id product_id credential_type allowed_models target_model target_endpoint capability_version idempotency_key status attempt_count available_at lease_until lease_generation last_error_code completed_at created_at updated_at'),
      ('saas_platform_provider_credential_validation_jobs', 'INSERT', 'account_id credential_id credential_version provider_id product_id credential_type allowed_models target_model target_endpoint capability_version idempotency_key'),
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
      ('saas_payment_orders', 'SELECT', 'id tenant_id order_type provider_key merchant_id client_request_id local_order_ref funding_reference amount_minor_units currency state provider_order_id provider_attempts provider_failure_code funding_transaction_id created_at updated_at paid_at fulfilled_at checkout_kind checkout_url checkout_text checkout_expires_at provider_submission_state provider_submission_lease_token provider_submission_lease_expires_at original_amount_minor_units'),
      ('saas_payment_orders', 'INSERT', 'id tenant_id order_type provider_key merchant_id client_request_id local_order_ref funding_reference amount_minor_units currency state provider_attempts created_at updated_at original_amount_minor_units'),
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
      ('saas_requests', 'SELECT', 'id tenant_id project_id public_model protocol supply_mode endpoint supply_profile_id execution_state financial_status reconciliation_state created_at updated_at state_version'),
      ('saas_requests', 'UPDATE', 'execution_state reconciliation_state financial_status updated_at state_version'),
      ('saas_attempts', 'SELECT', 'id tenant_id request_id ordinal result_state response_started response_started_at result_http_status created_at updated_at'),
      -- Observability channel-status aggregation (P3): the per-attempt error
      -- taxonomy and attribution columns the 1m rollup reads under this role.
      ('saas_attempts', 'SELECT', 'provider_id upstream_id route_config_id resolved_model dispatch_state unknown_reason'),
      -- R9 P7/P9/P10: unknown-outcome recovery worker attempt snapshots,
      -- operator resolution coverage and guard-enforced CAS transitions.
      ('saas_attempts', 'SELECT', 'state_version account_owner_kind account_id product_id'),
      ('saas_attempts', 'UPDATE', 'dispatch_state result_state unknown_reason updated_at state_version'),
      ('saas_gateway_capacity_reservations', 'SELECT', 'tenant_id request_id state'),
      ('saas_gateway_capacity_reservations', 'UPDATE', 'state updated_at'),
      -- R9 P15: the live migration 024/028 prepared-evidence guard FOR SHAREs
      -- the claimed-evidence identity window on every saas_attempts UPDATE
      -- whose row carries prepared_evidence_id, including the recovery
      -- worker's CAS writes. FOR SHARE prices as UPDATE privilege on at least
      -- one column, so created_at carries a lock-only UPDATE grant (the
      -- migration 024 immutability trigger freezes it; no reachable write
      -- path). Payload/statement evidence columns stay gateway-only; the live
      -- migration 027 claim-pool guard never fences under this role's UPDATE
      -- shapes and adds no grants.
      ('saas_prepared_request_evidence', 'SELECT', 'tenant_id id request_id attempt_id attempt_ordinal claimed_attempt_id status expires_at dispatch_deadline'),
      ('saas_prepared_request_evidence', 'UPDATE', 'created_at'),
      ('saas_usage_events', 'SELECT', 'id tenant_id request_id attempt_id supply_mode event_digest input_total input_uncached cache_read cache_write cache_write_5m cache_write_1h output_total reasoning_output billing_mode units size_tier status source measurement_kind billable_basis created_at'),
      ('saas_usage_settlements', 'SELECT', 'id tenant_id usage_event_id'),
      ('saas_usage_correction_events', 'SELECT', 'id tenant_id corrected_usage_event_id corrected_settlement_id reason_code correction_usage amount_delta_minor_units currency operator_identity evidence_ref correction_digest created_at'),
      ('saas_usage_correction_events', 'INSERT', 'id tenant_id corrected_usage_event_id corrected_settlement_id reason_code correction_usage amount_delta_minor_units currency operator_identity evidence_ref correction_digest created_at'),
      ('saas_marketing_redeem_codes', 'SELECT', 'id code_hash code_prefix kind amount_minor_units currency service_plan_version_id status batch_ref created_by_user_id created_at updated_at redeemed_by_tenant_id redeemed_by_user_id redeemed_at disabled_at'),
      ('saas_marketing_redeem_codes', 'INSERT', 'id code_hash code_prefix kind amount_minor_units currency service_plan_version_id batch_ref created_by_user_id created_at updated_at'),
      ('saas_marketing_redeem_codes', 'UPDATE', 'status updated_at redeemed_by_tenant_id redeemed_by_user_id redeemed_at disabled_at'),
      ('saas_marketing_redeem_redemptions', 'SELECT', 'id code_id tenant_id user_id ledger_transaction_id created_at'),
      ('saas_marketing_redeem_redemptions', 'INSERT', 'id code_id tenant_id user_id ledger_transaction_id created_at'),
      ('saas_marketing_announcements', 'SELECT', 'id kind severity title body publish_at unpublish_at status version created_by_user_id created_at updated_at fanout_completed_at'),
      ('saas_marketing_announcements', 'INSERT', 'id kind severity title body publish_at unpublish_at created_by_user_id created_at updated_at'),
      ('saas_marketing_announcements', 'UPDATE', 'status unpublish_at version updated_at fanout_completed_at'),
      ('saas_marketing_promo_codes', 'SELECT', 'id code kind percent_bp amount_minor_units currency scope starts_at ends_at max_uses per_tenant_once status created_by_user_id created_at updated_at disabled_at'),
      ('saas_marketing_promo_codes', 'INSERT', 'id code kind percent_bp amount_minor_units currency scope starts_at ends_at max_uses per_tenant_once created_by_user_id created_at updated_at'),
      ('saas_marketing_promo_codes', 'UPDATE', 'status updated_at disabled_at'),
      ('saas_marketing_promo_usages', 'SELECT', 'id code_id tenant_id order_id discount_minor_units per_tenant_once created_at'),
      ('saas_marketing_promo_usages', 'INSERT', 'id code_id tenant_id order_id discount_minor_units per_tenant_once created_at'),
      ('saas_marketing_affiliate_attributions', 'SELECT', 'invitee_tenant_id inviter_tenant_id invite_code created_at'),
      ('saas_marketing_affiliate_attributions', 'INSERT', 'invitee_tenant_id inviter_tenant_id invite_code created_at'),
      ('saas_marketing_affiliate_policies', 'SELECT', 'id reward_bp enabled version updated_by_user_id created_at updated_at'),
      ('saas_marketing_affiliate_policies', 'INSERT', 'id reward_bp enabled version updated_by_user_id created_at updated_at'),
      ('saas_marketing_affiliate_policies', 'UPDATE', 'reward_bp enabled version updated_by_user_id updated_at'),
      ('saas_marketing_affiliate_rewards', 'SELECT', 'id inviter_tenant_id invitee_tenant_id source_funding_ref source_amount_minor_units reward_amount_minor_units currency reward_bp_snapshot ledger_transaction_id created_at'),
      ('saas_marketing_affiliate_rewards', 'INSERT', 'id inviter_tenant_id invitee_tenant_id source_funding_ref source_amount_minor_units reward_amount_minor_units currency reward_bp_snapshot ledger_transaction_id created_at'),
      ('saas_marketing_announcement_reads', 'SELECT', 'announcement_id user_id tenant_id read_at'),
      ('saas_marketing_announcement_reads', 'INSERT', 'announcement_id user_id tenant_id read_at'),
      ('saas_unknown_outcome_reconciliation_cases', 'SELECT', 'id tenant_id project_id request_id supply_mode case_state scan_attempt_count next_attempt_at lease_token lease_expires_at last_error_code created_at resolution_idempotency_key resolution_digest resolution_support_ticket_ref'),
      ('saas_unknown_outcome_reconciliation_cases', 'INSERT', 'id tenant_id project_id request_id supply_mode case_state scan_attempt_count next_attempt_at created_at updated_at'),
      ('saas_unknown_outcome_reconciliation_cases', 'UPDATE', 'case_state scan_attempt_count next_attempt_at lease_token lease_expires_at last_error_code resolution_idempotency_key resolution_digest resolution_support_ticket_ref resolution_actor_user_id resolution_reason resolution_evidence_digest resolution_audit_event_id resolved_at updated_at'),
      ('saas_unknown_outcome_reconciliation_observations', 'SELECT', 'id tenant_id case_id observation_kind observed_at attempt_id usage_event_id supply_mode execution_state reconciliation_state financial_status request_state_version dispatch_state result_state response_started attempt_state_version upstream_id account_owner_kind account_id provider_id product_id resolved_model attempt_unknown_reason usage_event_digest provider_status provider_operation_id provider_identity_digest provider_usage evidence_reference operator_outcome actor_user_id reason audit_event_id support_ticket_ref'),
      ('saas_unknown_outcome_reconciliation_observations', 'INSERT', 'id tenant_id case_id request_id attempt_id usage_event_id observation_kind supply_mode execution_state reconciliation_state financial_status request_state_version dispatch_state result_state response_started attempt_state_version upstream_id account_owner_kind account_id provider_id product_id resolved_model attempt_unknown_reason usage_event_digest evidence_reference operator_outcome actor_user_id reason audit_event_id support_ticket_ref observed_at provider_status provider_operation_id provider_identity_digest provider_usage'),
      ('saas_customer_webhook_tenant_policies', 'SELECT', 'tenant_id enabled max_active_endpoints allowed_event_types max_events_per_minute max_pending_deliveries low_balance_threshold_minor_units revision updated_by_user_id audit_event_id updated_at'),
      ('saas_customer_webhook_tenant_policies', 'UPDATE', 'enabled max_active_endpoints max_events_per_minute max_pending_deliveries revision updated_by_user_id audit_event_id updated_at'),
      ('saas_customer_webhook_tenant_policies', 'INSERT', 'tenant_id enabled max_active_endpoints max_events_per_minute max_pending_deliveries revision updated_by_user_id audit_event_id'),
      ('saas_customer_webhook_endpoints', 'SELECT', 'tenant_id id current_version state created_at updated_at'),
      ('saas_customer_webhook_endpoints', 'INSERT', 'tenant_id id current_version state created_by_user_id'),
      ('saas_customer_webhook_endpoints', 'UPDATE', 'current_version state updated_at'),
      ('saas_customer_webhook_endpoint_versions', 'SELECT', 'tenant_id endpoint_id version target_url event_types'),
      ('saas_customer_webhook_endpoint_versions', 'INSERT', 'tenant_id endpoint_id version target_url event_types created_by_user_id audit_event_id'),
      ('saas_customer_webhook_signing_secrets', 'SELECT', 'tenant_id endpoint_id secret_version state overlap_expires_at encrypted_envelope created_at'),
      ('saas_customer_webhook_signing_secrets', 'INSERT', 'tenant_id endpoint_id secret_version state encrypted_envelope audit_event_id'),
      ('saas_customer_webhook_signing_secrets', 'UPDATE', 'state overlap_expires_at'),
      ('saas_customer_webhook_events', 'SELECT', 'tenant_id event_id event_type schema_version occurred_at payload idempotency_key'),
      ('saas_customer_webhook_events', 'INSERT', 'tenant_id event_id idempotency_key event_type schema_version occurred_at payload api_key_id service_plan_order_id refund_id request_id project_id request_supply_mode'),
      ('saas_customer_webhook_deliveries', 'SELECT', 'tenant_id id event_id endpoint_id endpoint_version secret_version overlap_secret_version payload_version state attempt_count attempt_sequence replay_count last_http_status last_latency_ms last_error_code available_at lease_token lease_expires_at fencing_token created_at updated_at'),
      ('saas_customer_webhook_deliveries', 'INSERT', 'tenant_id id event_id endpoint_id endpoint_version secret_version overlap_secret_version payload_version'),
      ('saas_customer_webhook_deliveries', 'UPDATE', 'state attempt_count attempt_sequence replay_count available_at lease_token lease_expires_at fencing_token last_http_status last_latency_ms last_error_code delivered_at updated_at'),
      ('saas_customer_webhook_delivery_attempts', 'SELECT', 'tenant_id delivery_id fencing_token lease_token state'),
      ('saas_customer_webhook_delivery_attempts', 'INSERT', 'tenant_id delivery_id attempt_sequence fencing_token lease_token state'),
      ('saas_customer_webhook_delivery_attempts', 'UPDATE', 'state http_status latency_ms error_code finished_at'),
      ('saas_customer_webhook_tenant_usage', 'SELECT', 'tenant_id pending_deliveries minute_bucket events_in_bucket'),
      ('saas_customer_webhook_tenant_usage', 'INSERT', 'tenant_id minute_bucket events_in_bucket pending_deliveries'),
      ('saas_customer_webhook_tenant_usage', 'UPDATE', 'pending_deliveries minute_bucket events_in_bucket updated_at'),
      -- 128 (batch-5 §5.1) plugin system: the control plane owns the
      -- installation registry CRUD (upload/replace, state admin, config)
      -- and every binding edit; the plugin-host workload runs its own role
      -- template and the gateway reads routing truth only.
      ('saas_plugin_installations', 'SELECT', 'id plugin_key name version description author manifest manifest_sha256 entrypoint_path binary_sha256 signature_status state config_json last_error artifact_data artifact_sha256 installed_by installed_at updated_at enabled_at'),
      ('saas_plugin_installations', 'INSERT', 'plugin_key name version description author manifest manifest_sha256 entrypoint_path binary_sha256 signature_status state config_json last_error artifact_data artifact_sha256 installed_by'),
      ('saas_plugin_installations', 'UPDATE', 'name version description author manifest manifest_sha256 entrypoint_path binary_sha256 signature_status state config_json last_error artifact_data artifact_sha256 updated_at enabled_at'),
      ('saas_plugin_bindings', 'SELECT', 'id installation_id capability platform account_type enabled rollout_percent created_at updated_at'),
      ('saas_plugin_bindings', 'INSERT', 'installation_id capability platform account_type enabled rollout_percent'),
      ('saas_plugin_bindings', 'UPDATE', 'enabled rollout_percent updated_at')
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
      ('saas_refund_wallet_freezes', 'DELETE'),
      ('saas_platform_role_assignments', 'DELETE'),
      ('saas_customer_webhook_deliveries', 'DELETE'),
      ('saas_customer_webhook_delivery_attempts', 'DELETE'),
      ('saas_obs_channel_metrics_1m', 'DELETE'),
      ('saas_obs_channel_metrics_hourly', 'DELETE'),
      ('saas_obs_alert_rules', 'DELETE'),
      -- Batch-5 §5.6 (127): operator silence lifecycle (expired-row pruning
      -- rides the same DELETE).
      ('saas_obs_alert_silences', 'DELETE'),
      ('saas_billing_group_account_pools', 'DELETE'),
      ('saas_email_verification_codes', 'DELETE'),
      -- R3 (107): proxy registry lifecycle; in-use proxies are protected by
      -- the egress_proxy_id FK (ON DELETE RESTRICT).
      ('saas_egress_proxies', 'DELETE'),
      ('saas_tls_fingerprint_profiles', 'DELETE'),
      -- R6a (109): probe monitor lifecycle (runs cascade with the monitor)
      -- and the 30-day probe run retention cleanup.
      ('saas_probe_monitors', 'DELETE'),
      ('saas_probe_runs', 'DELETE'),
      -- (121) composite model routes: registry row lifecycle (group rows
      -- cascade with the group head; this is the per-row admin delete).
      ('saas_composite_model_routes', 'DELETE'),
      -- 125 (batch-5 §5.4) risk control: moderation log retention
      -- (hit/non-hit windows) and the flagged-hash blocklist lifecycle
      -- (admin delete/clear).
      ('saas_content_moderation_logs', 'DELETE'),
      ('saas_content_moderation_flagged_hashes', 'DELETE'),
      -- 128 (batch-5 §5.1) plugin system: installation lifecycle (bindings
      -- cascade via the FK) and the binding-set replacement DELETE inside
      -- upsertInstallation/replaceBindings.
      ('saas_plugin_installations', 'DELETE'),
      ('saas_plugin_bindings', 'DELETE')
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
      ('saas_api_key_ip_policies'),
      ('saas_api_key_budget_policies'), ('saas_api_key_budget_counters'), ('saas_api_key_budget_reservations'),
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
      ('saas_usage_events'), ('saas_usage_settlements'),
      ('saas_billing_groups'),
      -- F2 (105): the account scheduler narrows the platform candidate domain
      -- to the request's billing-group account pool.
      ('saas_billing_group_account_pools'),
      -- R3 (107): the dispatch profile resolves the account's egress proxy.
      ('saas_egress_proxies'),
      ('saas_tls_fingerprint_profiles'),
      -- R1 (113, roadmap 1.3): the gateway writes and reads the billing-group
      -- RPM admission counters (capacity-side rate evidence, never billing).
      ('saas_billing_group_rate_counters'),
      -- R1 (114, roadmap 1.3): the gateway reserves and resolves the billing
      -- group spend windows (the KEY-BUD counters pattern at group scope).
      ('saas_billing_group_spend_counters'),
      ('saas_billing_group_spend_reservations'),
      -- (121) composite model routing: the gateway scheduler reads the
      -- composite route registry while resolving a composite-group request.
      ('saas_composite_model_routes'),
      -- (123) batch-4 §4.2 async image tasks: the gateway owns the task
      -- lifecycle (create/finish/read plus the expiry purge).
      ('saas_image_tasks'),
      -- 126 (batch-5 §5.2) OEM white-label: the gateway serves the public
      -- brand snapshot (GET /settings/public + custom page content)
      -- read-only; materialization writes run on the control plane only.
      ('saas_public_brand_settings'),
      -- 125 (batch-5 §5.4) risk control: the moderation seam reads the
      -- JSONB config snapshot (short TTL) and the flagged-hash blocklist,
      -- and counts the auto-ban violation window over its own log rows.
      ('saas_risk_control_config'),
      ('saas_content_moderation_logs'),
      ('saas_content_moderation_flagged_hashes'),
      -- 128 (batch-5 §5.1) plugin routing read (gateway decorator): the
      -- routing snapshot for a capability comes from the enabled binding
      -- row; no sensitive column exists on the table.
      ('saas_plugin_bindings')
      -- (124) batch-4 §4.3 async video tasks: the gateway owns the
      -- snapshot + binding + claim lifecycle (plus the expiry purge).
      ('saas_video_tasks')
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
      -- Fixed pricing-service INSERT projections; no snapshot mutations or price-version writes.
      ('saas_request_customer_price_snapshots', 'id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'tenant_id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'request_id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'customer_price_version', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'public_model_id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'public_model_version', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'provider_id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'product_id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'protocol', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'endpoint', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'currency', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'commercial_policy_version', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'calculator_version', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'rounding_version', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'rounding_mode', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'rounding_boundary', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_total', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_uncached', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_cache_read', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_cache_write', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_cache_write_5m', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_cache_write_1h', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_output_total', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_reasoning_output', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_per_unit_units', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_input_size_tier', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'hold_amount_minor_units', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'wallet_hold_required', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'admission_expires_at', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'idempotency_key', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'snapshot_digest', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'created_at', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'billing_group_id', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'rate_multiplier_num', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'rate_multiplier_den', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'peak_applied', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'model_pricing_override_digest', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'model_pricing_override', 'INSERT'),
      -- R1 enforcement terms (112, roadmap 1.3): the frozen group RPM/spend
      -- ceilings, scopes and fallback group id ride the same snapshot row.
      ('saas_request_customer_price_snapshots', 'group_rpm_limit', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'group_daily_limit_minor_units', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'group_weekly_limit_minor_units', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'group_monthly_limit_minor_units', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'group_supported_model_scopes', 'INSERT'),
      ('saas_request_customer_price_snapshots', 'group_fallback_group_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'tenant_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'request_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'attempt_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'supplier_cost_version', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'platform_account_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'public_model_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'public_model_version', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'provider_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'product_id', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'resolved_model', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'protocol', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'endpoint', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'currency', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'commercial_policy_version', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'calculator_version', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'rounding_version', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'rounding_mode', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'rounding_boundary', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'idempotency_key', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'snapshot_digest', 'INSERT'),
      ('saas_attempt_supplier_cost_snapshots', 'created_at', 'INSERT'),
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
      ('saas_provider_account_runtime_health', 'health_score', 'SELECT'),
      ('saas_provider_account_runtime_health', 'half_open_probe_at', 'SELECT'),
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
      ('saas_provider_account_runtime_health', 'health_score', 'INSERT'),
      ('saas_provider_account_runtime_health', 'half_open_probe_at', 'INSERT'),
      ('saas_provider_account_runtime_health', 'state', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'failure_count', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'observed_at', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'cooldown_until', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'last_outcome', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'source_fencing_token', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'revision', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'health_score', 'UPDATE'),
      ('saas_provider_account_runtime_health', 'half_open_probe_at', 'UPDATE'),
      -- R6: admission upsert + eligibility window read, PG-authoritative.
      ('saas_provider_account_rate_counters', 'account_scope', 'SELECT'),
      ('saas_provider_account_rate_counters', 'account_id', 'SELECT'),
      ('saas_provider_account_rate_counters', 'window_start', 'SELECT'),
      ('saas_provider_account_rate_counters', 'requests', 'SELECT'),
      ('saas_provider_account_rate_counters', 'tokens', 'SELECT'),
      ('saas_provider_account_rate_counters', 'account_scope', 'INSERT'),
      ('saas_provider_account_rate_counters', 'account_id', 'INSERT'),
      ('saas_provider_account_rate_counters', 'window_start', 'INSERT'),
      ('saas_provider_account_rate_counters', 'requests', 'INSERT'),
      ('saas_provider_account_rate_counters', 'tokens', 'INSERT'),
      ('saas_provider_account_rate_counters', 'requests', 'UPDATE'),
      ('saas_provider_account_rate_counters', 'tokens', 'UPDATE'),
      -- R-dormant (115, batch 2.2): the scheduler's lazy scheduling-threshold
      -- pause write at candidate-collection time — the only account-table DML
      -- the gateway role owns (the 109 probe pause is worker-written).
      ('saas_tenant_provider_accounts', 'scheduling_threshold_pause_until', 'UPDATE'),
      ('saas_tenant_provider_accounts', 'scheduling_threshold_pause_reason', 'UPDATE'),
      ('saas_platform_provider_accounts', 'scheduling_threshold_pause_until', 'UPDATE'),
      ('saas_platform_provider_accounts', 'scheduling_threshold_pause_reason', 'UPDATE'),
      -- R1 (113, roadmap 1.3): the capacity adapter upserts the billing-group
      -- RPM admission counter inside the admission transaction.
      ('saas_billing_group_rate_counters', 'group_id', 'SELECT'),
      ('saas_billing_group_rate_counters', 'window_start', 'SELECT'),
      ('saas_billing_group_rate_counters', 'requests', 'SELECT'),
      ('saas_billing_group_rate_counters', 'group_id', 'INSERT'),
      ('saas_billing_group_rate_counters', 'window_start', 'INSERT'),
      ('saas_billing_group_rate_counters', 'requests', 'INSERT'),
      ('saas_billing_group_rate_counters', 'requests', 'UPDATE'),
      -- R1 (114, roadmap 1.3): the gateway reserves the group spend windows at
      -- admission and resolves them at settlement/compensation/correction.
      ('saas_billing_group_spend_counters', 'billing_group_id', 'SELECT'),
      ('saas_billing_group_spend_counters', 'window_kind', 'SELECT'),
      ('saas_billing_group_spend_counters', 'window_start', 'SELECT'),
      ('saas_billing_group_spend_counters', 'charge_outstanding_reserved', 'SELECT'),
      ('saas_billing_group_spend_counters', 'charge_settled', 'SELECT'),
      ('saas_billing_group_spend_counters', 'charge_currency', 'SELECT'),
      ('saas_billing_group_spend_counters', 'billing_group_id', 'INSERT'),
      ('saas_billing_group_spend_counters', 'window_kind', 'INSERT'),
      ('saas_billing_group_spend_counters', 'window_start', 'INSERT'),
      ('saas_billing_group_spend_counters', 'charge_outstanding_reserved', 'INSERT'),
      ('saas_billing_group_spend_counters', 'charge_currency', 'INSERT'),
      ('saas_billing_group_spend_counters', 'charge_outstanding_reserved', 'UPDATE'),
      ('saas_billing_group_spend_counters', 'charge_settled', 'UPDATE'),
      ('saas_billing_group_spend_reservations', 'tenant_id', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'request_id', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'billing_group_id', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'window_kind', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'window_start', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'amount_minor_units', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'charge_currency', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'state', 'SELECT'),
      ('saas_billing_group_spend_reservations', 'tenant_id', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'request_id', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'billing_group_id', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'window_kind', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'window_start', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'amount_minor_units', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'charge_currency', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'state', 'INSERT'),
      ('saas_billing_group_spend_reservations', 'settled_amount_minor_units', 'UPDATE'),
      ('saas_billing_group_spend_reservations', 'state', 'UPDATE'),
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
      ('saas_api_key_budget_counters', 'tenant_id', 'INSERT'),
      ('saas_api_key_budget_counters', 'project_id', 'INSERT'),
      ('saas_api_key_budget_counters', 'lineage_id', 'INSERT'),
      ('saas_api_key_budget_counters', 'window_kind', 'INSERT'),
      ('saas_api_key_budget_counters', 'day', 'INSERT'),
      ('saas_api_key_budget_counters', 'token_settled', 'INSERT'),
      ('saas_api_key_budget_counters', 'token_outstanding_reserved', 'INSERT'),
      ('saas_api_key_budget_counters', 'charge_settled', 'INSERT'),
      ('saas_api_key_budget_counters', 'charge_outstanding_reserved', 'INSERT'),
      ('saas_api_key_budget_counters', 'charge_currency', 'INSERT'),
      ('saas_api_key_budget_counters', 'created_at', 'INSERT'),
      ('saas_api_key_budget_counters', 'updated_at', 'INSERT'),
      ('saas_api_key_budget_counters', 'token_settled', 'UPDATE'),
      ('saas_api_key_budget_counters', 'token_outstanding_reserved', 'UPDATE'),
      ('saas_api_key_budget_counters', 'charge_settled', 'UPDATE'),
      ('saas_api_key_budget_counters', 'charge_outstanding_reserved', 'UPDATE'),
      ('saas_api_key_budget_counters', 'charge_currency', 'UPDATE'),
      ('saas_api_key_budget_counters', 'updated_at', 'UPDATE'),
      ('saas_api_key_budget_reservations', 'tenant_id', 'INSERT'),
      ('saas_api_key_budget_reservations', 'project_id', 'INSERT'),
      ('saas_api_key_budget_reservations', 'lineage_id', 'INSERT'),
      ('saas_api_key_budget_reservations', 'request_id', 'INSERT'),
      ('saas_api_key_budget_reservations', 'day', 'INSERT'),
      ('saas_api_key_budget_reservations', 'token_units', 'INSERT'),
      ('saas_api_key_budget_reservations', 'charge_minor_units', 'INSERT'),
      ('saas_api_key_budget_reservations', 'charge_currency', 'INSERT'),
      ('saas_api_key_budget_reservations', 'created_at', 'INSERT'),
      ('saas_api_key_budget_reservations', 'updated_at', 'INSERT'),
      ('saas_api_key_budget_reservations', 'state', 'UPDATE'),
      -- R1 (114, roadmap 1.3): settle records the ACTUAL charge on the
      -- reservation row (the rolling 5h/7d windows read it back).
      ('saas_api_key_budget_reservations', 'settled_charge_minor_units', 'UPDATE'),
      ('saas_api_key_budget_reservations', 'updated_at', 'UPDATE'),
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
      ('saas_usage_events', 'reasoning_output', 'INSERT'),
      ('saas_usage_events', 'billing_mode', 'INSERT'), ('saas_usage_events', 'units', 'INSERT'),
      ('saas_usage_events', 'size_tier', 'INSERT'), ('saas_usage_events', 'status', 'INSERT'),
      ('saas_usage_events', 'source', 'INSERT'), ('saas_usage_events', 'semantics_version', 'INSERT'),
      ('saas_usage_events', 'measurement_kind', 'INSERT'), ('saas_usage_events', 'billable_basis', 'INSERT'),
      ('saas_usage_events', 'created_at', 'INSERT'), ('saas_usage_events', 'event_digest', 'UPDATE'),
      ('saas_usage_settlements', 'id', 'INSERT'), ('saas_usage_settlements', 'tenant_id', 'INSERT'),
      ('saas_usage_settlements', 'usage_event_id', 'INSERT'), ('saas_usage_settlements', 'request_id', 'INSERT'),
      ('saas_usage_settlements', 'attempt_id', 'INSERT'),
      ('saas_usage_settlements', 'settlement_key_digest', 'INSERT'),
      ('saas_usage_settlements', 'settlement_digest', 'INSERT'),
      ('saas_usage_settlements', 'kind', 'INSERT'), ('saas_usage_settlements', 'created_at', 'INSERT'),
      ('saas_usage_settlements', 'normal_success_evidence_ref', 'INSERT'),
      ('saas_usage_settlements', 'normal_success_evidence_ref', 'SELECT'),
      ('saas_usage_settlements', 'settlement_digest', 'UPDATE'),
      -- Exact dispatch claim-proof projection/filter/order columns only.
      -- Audit stays outside the dynamic all-column read-relation list.
      ('saas_audit_events', 'tenant_id', 'SELECT'), ('saas_audit_events', 'action', 'SELECT'),
      ('saas_audit_events', 'target_type', 'SELECT'), ('saas_audit_events', 'target_id', 'SELECT'),
      ('saas_audit_events', 'occurred_at', 'SELECT'), ('saas_audit_events', 'id', 'SELECT'),
      ('saas_audit_events', 'id', 'INSERT'), ('saas_audit_events', 'tenant_id', 'INSERT'),
      ('saas_audit_events', 'actor_user_id', 'INSERT'), ('saas_audit_events', 'action', 'INSERT'),
      ('saas_audit_events', 'target_type', 'INSERT'), ('saas_audit_events', 'target_id', 'INSERT'),
      ('saas_audit_events', 'occurred_at', 'INSERT'), ('saas_audit_events', 'source_ip', 'INSERT'),
      ('saas_audit_events', 'user_agent', 'INSERT'), ('saas_audit_events', 'entry_point', 'INSERT'),
      ('saas_audit_events', 'request_id', 'INSERT'),
      -- F3: settlement terminal commits enqueue customer webhook events inside
      -- the settlement transaction; no target_url/envelope/delivery columns.
      ('saas_customer_webhook_tenant_policies', 'tenant_id', 'SELECT'),
      ('saas_customer_webhook_tenant_policies', 'enabled', 'SELECT'),
      ('saas_customer_webhook_tenant_policies', 'allowed_event_types', 'SELECT'),
      ('saas_customer_webhook_tenant_policies', 'max_events_per_minute', 'SELECT'),
      ('saas_customer_webhook_tenant_policies', 'max_pending_deliveries', 'SELECT'),
      ('saas_customer_webhook_tenant_policies', 'updated_at', 'UPDATE'),
      ('saas_customer_webhook_endpoints', 'tenant_id', 'SELECT'),
      ('saas_customer_webhook_endpoints', 'id', 'SELECT'),
      ('saas_customer_webhook_endpoints', 'current_version', 'SELECT'),
      ('saas_customer_webhook_endpoints', 'state', 'SELECT'),
      ('saas_customer_webhook_endpoint_versions', 'tenant_id', 'SELECT'),
      ('saas_customer_webhook_endpoint_versions', 'endpoint_id', 'SELECT'),
      ('saas_customer_webhook_endpoint_versions', 'version', 'SELECT'),
      ('saas_customer_webhook_endpoint_versions', 'event_types', 'SELECT'),
      ('saas_customer_webhook_signing_secrets', 'tenant_id', 'SELECT'),
      ('saas_customer_webhook_signing_secrets', 'endpoint_id', 'SELECT'),
      ('saas_customer_webhook_signing_secrets', 'secret_version', 'SELECT'),
      ('saas_customer_webhook_signing_secrets', 'state', 'SELECT'),
      ('saas_customer_webhook_signing_secrets', 'overlap_expires_at', 'SELECT'),
      ('saas_customer_webhook_events', 'tenant_id', 'SELECT'),
      ('saas_customer_webhook_events', 'event_id', 'SELECT'),
      ('saas_customer_webhook_events', 'event_type', 'SELECT'),
      ('saas_customer_webhook_events', 'schema_version', 'SELECT'),
      ('saas_customer_webhook_events', 'occurred_at', 'SELECT'),
      ('saas_customer_webhook_events', 'payload', 'SELECT'),
      ('saas_customer_webhook_events', 'idempotency_key', 'SELECT'),
      ('saas_customer_webhook_events', 'tenant_id', 'INSERT'),
      ('saas_customer_webhook_events', 'event_id', 'INSERT'),
      ('saas_customer_webhook_events', 'idempotency_key', 'INSERT'),
      ('saas_customer_webhook_events', 'event_type', 'INSERT'),
      ('saas_customer_webhook_events', 'schema_version', 'INSERT'),
      ('saas_customer_webhook_events', 'occurred_at', 'INSERT'),
      ('saas_customer_webhook_events', 'payload', 'INSERT'),
      ('saas_customer_webhook_events', 'api_key_id', 'INSERT'),
      ('saas_customer_webhook_events', 'service_plan_order_id', 'INSERT'),
      ('saas_customer_webhook_events', 'refund_id', 'INSERT'),
      ('saas_customer_webhook_events', 'request_id', 'INSERT'),
      ('saas_customer_webhook_events', 'project_id', 'INSERT'),
      ('saas_customer_webhook_events', 'request_supply_mode', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'tenant_id', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'id', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'event_id', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'endpoint_id', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'endpoint_version', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'secret_version', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'overlap_secret_version', 'INSERT'),
      ('saas_customer_webhook_deliveries', 'payload_version', 'INSERT'),
      ('saas_customer_webhook_tenant_usage', 'tenant_id', 'SELECT'),
      ('saas_customer_webhook_tenant_usage', 'pending_deliveries', 'SELECT'),
      ('saas_customer_webhook_tenant_usage', 'minute_bucket', 'SELECT'),
      ('saas_customer_webhook_tenant_usage', 'events_in_bucket', 'SELECT'),
      ('saas_customer_webhook_tenant_usage', 'tenant_id', 'INSERT'),
      ('saas_customer_webhook_tenant_usage', 'minute_bucket', 'INSERT'),
      ('saas_customer_webhook_tenant_usage', 'events_in_bucket', 'INSERT'),
      ('saas_customer_webhook_tenant_usage', 'pending_deliveries', 'INSERT'),
      ('saas_customer_webhook_tenant_usage', 'pending_deliveries', 'UPDATE'),
      ('saas_customer_webhook_tenant_usage', 'minute_bucket', 'UPDATE'),
      ('saas_customer_webhook_tenant_usage', 'events_in_bucket', 'UPDATE'),
      ('saas_customer_webhook_tenant_usage', 'updated_at', 'UPDATE'),
      -- (123) batch-4 §4.2 async image tasks: the gateway owns the task
      -- lifecycle — create insert, finish transition, expiry purge.
      ('saas_image_tasks', 'id', 'INSERT'), ('saas_image_tasks', 'tenant_id', 'INSERT'),
      ('saas_image_tasks', 'proxy_key_id', 'INSERT'), ('saas_image_tasks', 'status', 'INSERT'),
      ('saas_image_tasks', 'http_status', 'INSERT'), ('saas_image_tasks', 'result', 'INSERT'),
      ('saas_image_tasks', 'error', 'INSERT'), ('saas_image_tasks', 'created_at', 'INSERT'),
      ('saas_image_tasks', 'completed_at', 'INSERT'), ('saas_image_tasks', 'expires_at', 'INSERT'),
      ('saas_image_tasks', 'status', 'UPDATE'), ('saas_image_tasks', 'http_status', 'UPDATE'),
      ('saas_image_tasks', 'result', 'UPDATE'), ('saas_image_tasks', 'error', 'UPDATE'),
      ('saas_image_tasks', 'completed_at', 'UPDATE'), ('saas_image_tasks', 'expires_at', 'UPDATE'),
      -- 125 (batch-5 §5.4) risk control: the moderation seam writes
      -- decision logs (identity columns only — id is the identity default)
      -- and records flagged input hashes; auto-ban flips the user's
      -- disabled_at through the same column the control-plane governance
      -- service uses.
      ('saas_content_moderation_logs', 'request_id', 'INSERT'),
      ('saas_content_moderation_logs', 'tenant_id', 'INSERT'),
      ('saas_content_moderation_logs', 'user_id', 'INSERT'),
      ('saas_content_moderation_logs', 'api_key_id', 'INSERT'),
      ('saas_content_moderation_logs', 'api_key_name', 'INSERT'),
      ('saas_content_moderation_logs', 'model', 'INSERT'),
      ('saas_content_moderation_logs', 'protocol', 'INSERT'),
      ('saas_content_moderation_logs', 'mode', 'INSERT'),
      ('saas_content_moderation_logs', 'action', 'INSERT'),
      ('saas_content_moderation_logs', 'flagged', 'INSERT'),
      ('saas_content_moderation_logs', 'highest_category', 'INSERT'),
      ('saas_content_moderation_logs', 'highest_score', 'INSERT'),
      ('saas_content_moderation_logs', 'matched_keyword', 'INSERT'),
      ('saas_content_moderation_logs', 'category_scores', 'INSERT'),
      ('saas_content_moderation_logs', 'threshold_snapshot', 'INSERT'),
      ('saas_content_moderation_logs', 'input_excerpt', 'INSERT'),
      ('saas_content_moderation_logs', 'input_hash', 'INSERT'),
      ('saas_content_moderation_logs', 'upstream_latency_ms', 'INSERT'),
      ('saas_content_moderation_logs', 'error', 'INSERT'),
      ('saas_content_moderation_logs', 'violation_count', 'INSERT'),
      ('saas_content_moderation_logs', 'auto_banned', 'INSERT'),
      ('saas_content_moderation_logs', 'email_sent', 'INSERT'),
      ('saas_content_moderation_logs', 'created_at', 'INSERT'),
      ('saas_content_moderation_flagged_hashes', 'input_hash', 'INSERT'),
      ('saas_content_moderation_flagged_hashes', 'created_at', 'INSERT'),
      ('saas_users', 'disabled_at', 'UPDATE'),
      ('saas_users', 'updated_at', 'UPDATE'),
      -- 125 auto-ban guard: the platform-role existence probe (SELECT-only,
      -- user_id alone).
      ('saas_platform_role_assignments', 'user_id', 'SELECT'),
decorator): routing
      -- columns only — never artifact_data, the manifest blob or
      -- config_json.
      ('saas_plugin_installations', 'id', 'SELECT'),
      ('saas_plugin_installations', 'plugin_key', 'SELECT'),
      ('saas_plugin_installations', 'version', 'SELECT'),
      ('saas_plugin_installations', 'state', 'SELECT'),
      ('saas_plugin_installations', 'binary_sha256', 'SELECT'),
      ('saas_plugin_installations', 'signature_status', 'SELECT'),
      ('saas_plugin_installations', 'updated_at', 'SELECT')
    ) AS manifest(table_name, column_name, privilege_type)
      -- (124) batch-4 §4.3 async video tasks: the gateway owns the
      -- create-time snapshot + binding insert, the one-shot billing-claim
      -- transitions, and the expiry purge. Settlement facts are frozen at
      -- create (INSERT only).
      ('saas_video_tasks', 'request_id', 'INSERT'), ('saas_video_tasks', 'tenant_id', 'INSERT'),
      ('saas_video_tasks', 'proxy_key_id', 'INSERT'), ('saas_video_tasks', 'provider_account_id', 'INSERT'),
      ('saas_video_tasks', 'credential_id', 'INSERT'), ('saas_video_tasks', 'credential_version', 'INSERT'),
      ('saas_video_tasks', 'gateway_request_id', 'INSERT'), ('saas_video_tasks', 'gateway_attempt_id', 'INSERT'),
      ('saas_video_tasks', 'model', 'INSERT'), ('saas_video_tasks', 'resolution', 'INSERT'),
      ('saas_video_tasks', 'duration_seconds', 'INSERT'), ('saas_video_tasks', 'video_count', 'INSERT'),
      ('saas_video_tasks', 'billing_state', 'INSERT'), ('saas_video_tasks', 'settlement_facts', 'INSERT'),
      ('saas_video_tasks', 'created_at', 'INSERT'), ('saas_video_tasks', 'expires_at', 'INSERT'),
      ('saas_video_tasks', 'billing_state', 'UPDATE'), ('saas_video_tasks', 'billed_at', 'UPDATE')
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
  -- (123) batch-4 §4.2 async image tasks + (124) batch-4 §4.3 async
  -- video tasks: the gateway owns the task rows' expiry purge.
  IF pg_catalog.to_regclass('model_router_saas.saas_image_tasks') IS NOT NULL THEN
    EXECUTE 'GRANT DELETE ON TABLE model_router_saas.saas_image_tasks TO model_router_saas_gateway';
  END IF;
  IF pg_catalog.to_regclass('model_router_saas.saas_video_tasks') IS NOT NULL THEN
    EXECUTE 'GRANT DELETE ON TABLE model_router_saas.saas_video_tasks TO model_router_saas_gateway';
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
