-- Dedicated least-privilege grants for the credential-validation worker.
--
-- Run as a PostgreSQL administrator after migrations include version 039 and
-- after deploy/managed-saas-postgres-roles.sql. The database must be dedicated
-- to this SaaS deployment. This script does not set credentials; manage the
-- role password through the deployment secret manager.

BEGIN;

DO $create_worker_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_validation_worker'
  ) THEN
    CREATE ROLE model_router_saas_validation_worker
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$create_worker_role$;

ALTER ROLE model_router_saas_validation_worker
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $membership_guard$
DECLARE
  v_role_oid oid;
BEGIN
  SELECT oid INTO STRICT v_role_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_validation_worker';

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_role_oid
  ) THEN
    RAISE EXCEPTION 'validation worker role must not be a member of another role';
  END IF;
END;
$membership_guard$;

DO $database_acl$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM model_router_saas_validation_worker',
    v_database_name
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO model_router_saas_validation_worker',
    v_database_name
  );
END;
$database_acl$;

REVOKE ALL PRIVILEGES ON SCHEMA model_router_saas
  FROM model_router_saas_validation_worker;
GRANT USAGE ON SCHEMA model_router_saas
  TO model_router_saas_validation_worker;

DO $worker_search_path$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'ALTER ROLE model_router_saas_validation_worker IN DATABASE %I SET search_path TO model_router_saas',
    v_database_name
  );
END;
$worker_search_path$;

-- Remove any pre-existing direct privileges across user schemas before the
-- exact managed-schema column grants below are applied.
DO $revoke_worker_acl$
DECLARE
  v_schema record;
  v_relation record;
  v_columns text;
BEGIN
  FOR v_schema IN
    SELECT nspname
    FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg_toast%'
      AND nspname NOT LIKE 'pg_temp_%'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM model_router_saas_validation_worker',
      v_schema.nspname
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM model_router_saas_validation_worker',
      v_schema.nspname
    );
    EXECUTE format(
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM model_router_saas_validation_worker',
      v_schema.nspname
    );
  END LOOP;

  FOR v_relation IN
    SELECT relation.oid, namespace.nspname, relation.relname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
  LOOP
    SELECT string_agg(pg_catalog.quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum)
      INTO v_columns
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = v_relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped;
    IF v_columns IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL (%s) ON TABLE %I.%I FROM model_router_saas_validation_worker',
        v_columns,
        v_relation.nspname,
        v_relation.relname
      );
    END IF;
  END LOOP;
END;
$revoke_worker_acl$;

GRANT SELECT (
  id, tenant_id, account_id, credential_id, credential_version, provider_id,
  product_id, credential_type, allowed_models, target_model, target_endpoint,
  capability_version, idempotency_key, status, attempt_count, available_at,
  lease_until, lease_generation, last_error_code, completed_at, created_at, updated_at
) ON TABLE model_router_saas.saas_tenant_provider_credential_validation_jobs
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  status, attempt_count, available_at, lease_until, lease_generation,
  last_error_code, completed_at, updated_at
) ON TABLE model_router_saas.saas_tenant_provider_credential_validation_jobs
  TO model_router_saas_validation_worker;

GRANT SELECT (provider_id, product_id, status)
  ON TABLE model_router_saas.saas_provider_products
  TO model_router_saas_validation_worker;
GRANT SELECT (
  rights_id, version, provider_id, product_id, credential_type, supply_mode,
  region, purpose, model_scope, endpoint_scope, effective_at, expires_at, status
) ON TABLE model_router_saas.saas_provider_rights
  TO model_router_saas_validation_worker;
GRANT SELECT (
  provider_id, product_id, model, endpoint, protocol, version, support_level,
  validation_state
) ON TABLE model_router_saas.saas_provider_capabilities
  TO model_router_saas_validation_worker;
GRANT SELECT (
  tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version
) ON TABLE model_router_saas.saas_tenant_provider_account_capabilities
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, tenant_id, provider_id, product_id, credential_type, region, purpose,
  rights_id, rights_version, status, validation_state, authz_version
) ON TABLE model_router_saas.saas_tenant_provider_accounts
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  status, validation_state, validation_error_code, last_validated_at,
  updated_at, authz_version
) ON TABLE model_router_saas.saas_tenant_provider_accounts
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, tenant_id, account_id, provider_id, product_id, credential_type, status,
  validation_state, current_version, expires_at, authz_version
) ON TABLE model_router_saas.saas_tenant_provider_credentials
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  status, validation_state, validation_error_code, last_validated_at,
  updated_at, authz_version
) ON TABLE model_router_saas.saas_tenant_provider_credentials
  TO model_router_saas_validation_worker;

GRANT SELECT (
  tenant_id, account_id, credential_id, version, status, schema_version,
  context_version, algorithm, kms_purpose, kms_key_id, wrapping_revision,
  wrapped_dek, nonce, ciphertext, auth_tag, expires_at
) ON TABLE model_router_saas.saas_tenant_provider_credential_versions
  TO model_router_saas_validation_worker;

GRANT SELECT (
  tenant_id, account_id, credential_id, credential_version,
  wrapping_revision, kms_key_id, wrapped_dek
) ON TABLE model_router_saas.saas_tenant_provider_credential_wrappings
  TO model_router_saas_validation_worker;

COMMIT;
