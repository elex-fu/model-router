-- Compose first-boot bootstrap for the dedicated managed SaaS database
-- (Phase 4, sub2api parity plan).
--
-- Mounted into the postgres container as
-- /docker-entrypoint-initdb.d/00-init.sql; the postgres image runs it as the
-- database superuser exactly once, on an empty data volume.
--
-- What this file does:
--   * creates the four least-privilege login roles used by
--     src/saas/deployment.ts per-role database URLs (migrator,
--     control_plane, gateway, validation_worker);
--   * installs the database/schema ACL baseline and per-role search_path.
--
-- What this file deliberately does NOT do:
--   * passwords — role passwords are applied from container environment
--     variables by 10-role-passwords.sh (mirrors the repo convention that
--     deploy/managed-saas-postgres-roles.sql never embeds credentials);
--   * the full runtime grant manifests — they live verbatim in
--     deploy/managed-saas-postgres-roles.sql and
--     deploy/managed-saas-validation-worker-role-grants.sql (mounted at
--     /opt/templates/ inside the postgres container). Apply them before the
--     first `saas:migrate`, and re-apply them after every migration so the
--     manifests cover newly created tables. See deploy/compose/README.md.
--
-- Statements follow the style of deploy/managed-saas-postgres-roles.sql; the
-- authoritative grant manifests remain the single source of truth for
-- table/column privileges.

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

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_validation_worker'
  ) THEN
    CREATE ROLE model_router_saas_validation_worker
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$create_roles$;

-- Reassert safe role attributes on every run; passwords are set separately by
-- 10-role-passwords.sh and are never embedded here.
ALTER ROLE model_router_saas_migrator
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE model_router_saas_control_plane
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE model_router_saas_gateway
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE model_router_saas_validation_worker
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Refuse membership in other roles: NOINHERIT alone does not prevent SET ROLE
-- when a membership exists. Mirrors the guard in
-- deploy/managed-saas-postgres-roles.sql.
DO $membership_guard$
DECLARE
  v_migrator_oid oid;
  v_control_plane_oid oid;
  v_gateway_oid oid;
  v_validation_worker_oid oid;
BEGIN
  SELECT oid INTO STRICT v_migrator_oid
    FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_migrator';
  SELECT oid INTO STRICT v_control_plane_oid
    FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_control_plane';
  SELECT oid INTO STRICT v_gateway_oid
    FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_gateway';
  SELECT oid INTO STRICT v_validation_worker_oid
    FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_validation_worker';

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member IN (
      v_migrator_oid, v_control_plane_oid, v_gateway_oid, v_validation_worker_oid
    )
  ) THEN
    RAISE EXCEPTION
      'SaaS migrator/runtime roles must not be members of other roles; remove memberships before applying this template';
  END IF;
END;
$membership_guard$;

-- The database is dedicated to this SaaS deployment: no role (and not PUBLIC)
-- may create schemas or temporary tables, and only the four application
-- logins may connect. The superuser that owns the database stays outside the
-- application roles, matching the ownership guard in
-- deploy/managed-saas-postgres-roles.sql.
DO $database_acl$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway, model_router_saas_validation_worker',
    v_database_name
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO model_router_saas_migrator, model_router_saas_control_plane, model_router_saas_gateway, model_router_saas_validation_worker',
    v_database_name
  );
END;
$database_acl$;

-- Application roles never create objects in the conventional public schema.
DO $public_schema_acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public'
  ) THEN
    REVOKE CREATE ON SCHEMA public
      FROM PUBLIC, model_router_saas_migrator, model_router_saas_control_plane,
           model_router_saas_gateway, model_router_saas_validation_worker;
  END IF;
END;
$public_schema_acl$;

-- The migrator login owns the application schema and every object `saas:migrate`
-- creates in it. IF NOT EXISTS never changes an existing schema's owner.
CREATE SCHEMA IF NOT EXISTS model_router_saas
  AUTHORIZATION model_router_saas_migrator;

REVOKE ALL PRIVILEGES ON SCHEMA model_router_saas
  FROM PUBLIC, model_router_saas_control_plane, model_router_saas_gateway,
       model_router_saas_validation_worker;
GRANT USAGE ON SCHEMA model_router_saas
  TO model_router_saas_control_plane, model_router_saas_gateway,
       model_router_saas_validation_worker;

-- Unqualified SQL in the migration registry and the runtime privilege probes
-- resolves to the application schema; the probes assert this exact setting.
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
  EXECUTE format(
    'ALTER ROLE model_router_saas_validation_worker IN DATABASE %I SET search_path TO model_router_saas',
    v_database_name
  );
END;
$role_search_paths$;

COMMIT;
