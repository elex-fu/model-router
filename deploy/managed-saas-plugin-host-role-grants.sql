-- Dedicated least-privilege grants for the plugin-host workload
-- (batch-5 §5.1 plugin system; the credential-validation-worker template
-- applied to the standalone plugin-host process that owns the plugin child
-- processes, the 1s reconcile loop and the host-service KV).
--
-- Run as a PostgreSQL administrator after migrations include version 128 and
-- after deploy/managed-saas-postgres-roles.sql. The database must be
-- dedicated to this SaaS deployment. This script does not set credentials;
-- manage the role password through the deployment secret manager.
--
-- The role receives column-level SELECT on the FULL plugin installation
-- rows (artifact_data included — any replica re-verifies the signature chain
-- and re-extracts the entrypoint from the stored package bytes), the four
-- reconcile CAS UPDATE columns (state, last_error, enabled_at, updated_at),
-- the binding read surface, the host-service KV table with its single
-- table-level DELETE (the TTL prune), and the account/credential catalog +
-- sealed envelope columns needed for the restricted unseal (the exact
-- envelope surface the credential-validation worker already holds). It never
-- receives installation/binding writes (control-plane owned), sequence
-- access, migration-ledger access or routine EXECUTE — the plugin tables'
-- CHECK constraints use built-ins only.

BEGIN;

DO $create_plugin_host_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'model_router_saas_plugin_host'
  ) THEN
    CREATE ROLE model_router_saas_plugin_host
      LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$create_plugin_host_role$;

ALTER ROLE model_router_saas_plugin_host
  WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $membership_guard$
DECLARE
  v_role_oid oid;
BEGIN
  SELECT oid INTO STRICT v_role_oid
  FROM pg_catalog.pg_roles
  WHERE rolname = 'model_router_saas_plugin_host';

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = v_role_oid
  ) THEN
    RAISE EXCEPTION 'plugin host role must not be a member of another role';
  END IF;
END;
$membership_guard$;

DO $database_acl$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'REVOKE CREATE, TEMPORARY ON DATABASE %I FROM model_router_saas_plugin_host',
    v_database_name
  );
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO model_router_saas_plugin_host',
    v_database_name
  );
END;
$database_acl$;

REVOKE ALL PRIVILEGES ON SCHEMA model_router_saas
  FROM model_router_saas_plugin_host;
GRANT USAGE ON SCHEMA model_router_saas
  TO model_router_saas_plugin_host;

DO $plugin_host_search_path$
DECLARE
  v_database_name text := current_database();
BEGIN
  EXECUTE format(
    'ALTER ROLE model_router_saas_plugin_host IN DATABASE %I SET search_path TO model_router_saas',
    v_database_name
  );
END;
$plugin_host_search_path$;

-- Remove any pre-existing direct privileges across user schemas before the
-- exact managed-schema column grants below are applied.
DO $revoke_plugin_host_acl$
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
      'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM model_router_saas_plugin_host',
      v_schema.nspname
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM model_router_saas_plugin_host',
      v_schema.nspname
    );
    EXECUTE format(
      'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA %I FROM model_router_saas_plugin_host',
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
        'REVOKE ALL (%s) ON TABLE %I.%I FROM model_router_saas_plugin_host',
        v_columns,
        v_relation.nspname,
        v_relation.relname
      );
    END IF;
  END LOOP;
END;
$revoke_plugin_host_acl$;

-- 128 (batch-5 §5.1) plugin system: the reconcile loop reads the complete
-- installation row (the artifact bytes are the replica re-verify input) and
-- CAS-writes only the four runtime-health columns. Installation and binding
-- lifecycle writes stay on the control-plane role.
GRANT SELECT (
  id, plugin_key, name, version, description, author, manifest, manifest_sha256,
  entrypoint_path, binary_sha256, signature_status, state, config_json, last_error,
  artifact_data, artifact_sha256, installed_by, installed_at, updated_at, enabled_at
) ON TABLE model_router_saas.saas_plugin_installations
  TO model_router_saas_plugin_host;
GRANT UPDATE (
  state, last_error, enabled_at, updated_at
) ON TABLE model_router_saas.saas_plugin_installations
  TO model_router_saas_plugin_host;

GRANT SELECT (
  id, installation_id, capability, platform, account_type, enabled,
  rollout_percent, created_at, updated_at
) ON TABLE model_router_saas.saas_plugin_bindings
  TO model_router_saas_plugin_host;

-- Host-service KV: full column DML plus the role's single table-level
-- DELETE (expired TTL rows are pruned on the read path).
GRANT SELECT (
  plugin_key, namespace, key, value, expires_at, updated_at
) ON TABLE model_router_saas.saas_plugin_kv
  TO model_router_saas_plugin_host;
GRANT INSERT (
  plugin_key, namespace, key, value, expires_at, updated_at
) ON TABLE model_router_saas.saas_plugin_kv
  TO model_router_saas_plugin_host;
GRANT UPDATE (
  value, expires_at, updated_at
) ON TABLE model_router_saas.saas_plugin_kv
  TO model_router_saas_plugin_host;
GRANT DELETE ON TABLE model_router_saas.saas_plugin_kv
  TO model_router_saas_plugin_host;

-- Account catalog (metadata only — identity, provider/product, credential
-- type, status, display name; never quota, validation or scheduling state).
GRANT SELECT (
  id, tenant_id, provider_id, product_id, credential_type, status, display_name
) ON TABLE model_router_saas.saas_tenant_provider_accounts
  TO model_router_saas_plugin_host;
GRANT SELECT (
  id, provider_id, product_id, credential_type, status, display_name
) ON TABLE model_router_saas.saas_platform_provider_accounts
  TO model_router_saas_plugin_host;

-- Credential heads: exactly the account→credential→version join keys.
GRANT SELECT (
  id, tenant_id, account_id, provider_id, product_id, credential_type,
  current_version, status
) ON TABLE model_router_saas.saas_tenant_provider_credentials
  TO model_router_saas_plugin_host;
GRANT SELECT (
  id, account_id, provider_id, product_id, credential_type,
  current_version, status
) ON TABLE model_router_saas.saas_platform_provider_credentials
  TO model_router_saas_plugin_host;

-- Sealed envelope read for the restricted unseal — the exact column surface
-- the credential-validation worker already holds (the envelope-read
-- precedent; no plaintext credential column exists on these tables).
GRANT SELECT (
  tenant_id, account_id, credential_id, version, status, schema_version,
  context_version, algorithm, kms_purpose, kms_key_id, wrapping_revision,
  wrapped_dek, nonce, ciphertext, auth_tag, expires_at
) ON TABLE model_router_saas.saas_tenant_provider_credential_versions
  TO model_router_saas_plugin_host;
GRANT SELECT (
  account_id, credential_id, version, status, schema_version,
  context_version, algorithm, kms_purpose, kms_key_id, wrapping_revision,
  wrapped_dek, nonce, ciphertext, auth_tag, expires_at
) ON TABLE model_router_saas.saas_platform_provider_credential_versions
  TO model_router_saas_plugin_host;

COMMIT;
