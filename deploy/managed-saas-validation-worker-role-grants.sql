-- Dedicated least-privilege grants for the credential-validation worker.
--
-- Run as a PostgreSQL administrator after migrations include version 058 and
-- after deploy/managed-saas-postgres-roles.sql. The database must be dedicated
-- to this SaaS deployment. This script does not set credentials; manage the
-- role password through the deployment secret manager.
-- 058 only repairs two original row-trigger wrappers; this worker grant set
-- is unchanged. It never grants credential current_version/expires_at UPDATE,
-- job identity INSERT/UPDATE, migration-ledger access or routine EXECUTE —
-- with exactly one documented exception: EXECUTE on the IMMUTABLE CHECK
-- constraint validator saas_catalog_valid_scope(text[]) (see the G2 note
-- below).
-- R6a (109) widened INSERT to the append-only observation tables
-- saas_probe_runs (probe history) and saas_audit_events (best-effort alert
-- records). G2 (F6 openRouterModelPricingSync) further widened INSERT to the
-- append-only catalog/public-model/supplier-cost registration tables; every
-- other INSERT grant on this role remains forbidden.
-- DEPLOYMENT NOTE (migration 093, Track D4): the quota sync worker shares
-- this role and writes the account quota snapshot columns below. Re-apply
-- this template after 093 is migrated; until then the worker runtime
-- privilege probe fails closed by design.
-- DEPLOYMENT NOTE (migration 108, R5b): the OpenCode Go usage worker also
-- shares this role (same workload as the quota sync worker). It claims due
-- accounts through the opencode_go_usage_* scheduling columns — the due
-- predicate reads next_due_at/updated_at/rate_limited_until, and the claim,
-- snapshot, failure and cooldown writes cover every opencode_go_ column
-- below. The opencode_go_protocol_rules column is deliberately absent: the
-- control-plane role owns the adaptive-routing rule table. Re-apply this
-- template after 108 is migrated.
-- DEPLOYMENT NOTE (G2, F6 openRouterModelPricingSync): the OpenRouter
-- model-catalog/pricing sync loop also shares this role (the opt-in
-- managed-saas.ts `openRouterModelPricingSync` mount). Its service-backed
-- store appends catalog structure and supplier cost versions through the
-- existing SaasCatalogService / SaasPricingService registration methods, so
-- this role gains INSERT on the append-only catalog, public-model and
-- supplier-cost tables below — plus the SELECT columns those methods read,
-- including their RETURNING projections (RETURNING requires SELECT). The
-- saas_provider_rights / saas_public_model_versions CHECK constraints call
-- the IMMUTABLE validator saas_catalog_valid_scope(text[]) (migration 008);
-- PostgreSQL evaluates CHECK-constraint functions as the inserting role, so
-- this role also gains EXECUTE on that one routine (audited: it is the only
-- schema function any CHECK constraint on the granted tables calls — every
-- other CHECK uses built-ins, and trigger functions need no EXECUTE to
-- fire). No migration is involved (the 008/017 table shapes are unchanged);
-- re-apply this template on a database that predates this change — until
-- then the worker runtime privilege probe fails closed by design and
-- deployments must leave the openRouterModelPricingSync option unset.

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

-- G2 (F6 openRouterModelPricingSync): the saas_provider_rights and
-- saas_public_model_versions CHECK constraints (migration 008) call the
-- IMMUTABLE validator saas_catalog_valid_scope(text[]), and PostgreSQL
-- evaluates CHECK-constraint functions as the inserting role. This is the
-- only schema routine any CHECK constraint on a worker-granted table calls
-- (audited across all migrations; every other CHECK uses built-ins), so it
-- is the role's single EXECUTE exception. Granted after the blanket revoke
-- above so re-applying this template restores it.
GRANT EXECUTE ON FUNCTION model_router_saas.saas_catalog_valid_scope(text[])
  TO model_router_saas_validation_worker;

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
-- G2 (F6 mount): the OpenRouter pricing sync's product registration writes
-- the full row; the same methods' existence/fence reads also select
-- display_name and created_at, and the INSERT's RETURNING projection needs
-- SELECT on every inserted column.
GRANT SELECT (
  display_name, created_at
) ON TABLE model_router_saas.saas_provider_products
  TO model_router_saas_validation_worker;
GRANT INSERT (
  provider_id, product_id, display_name, status, created_at
) ON TABLE model_router_saas.saas_provider_products
  TO model_router_saas_validation_worker;
GRANT SELECT (
  rights_id, version, provider_id, product_id, credential_type, supply_mode,
  region, purpose, model_scope, endpoint_scope, effective_at, expires_at, status
) ON TABLE model_router_saas.saas_provider_rights
  TO model_router_saas_validation_worker;
-- G2 (F6 mount): rights-version registration RETURNING projection and the
-- append-only version write cover the remaining columns of the row.
GRANT SELECT (
  approval_ref, evidence_ref, evidence_sha256, created_at
) ON TABLE model_router_saas.saas_provider_rights
  TO model_router_saas_validation_worker;
GRANT INSERT (
  rights_id, version, provider_id, product_id, credential_type, supply_mode,
  region, purpose, model_scope, endpoint_scope, effective_at, expires_at,
  approval_ref, status, evidence_ref, evidence_sha256, created_at
) ON TABLE model_router_saas.saas_provider_rights
  TO model_router_saas_validation_worker;
GRANT SELECT (
  provider_id, product_id, model, endpoint, protocol, version, support_level,
  validation_state, evidence_sha256
) ON TABLE model_router_saas.saas_provider_capabilities
  TO model_router_saas_validation_worker;
-- G2 (F6 mount): capability-version registration RETURNING projection and
-- the append-only version write cover the remaining columns of the row.
GRANT SELECT (
  evidence_version, discovery_source, evidence_ref, created_at
) ON TABLE model_router_saas.saas_provider_capabilities
  TO model_router_saas_validation_worker;
GRANT INSERT (
  provider_id, product_id, model, endpoint, protocol, version, support_level,
  validation_state, evidence_version, discovery_source, evidence_ref,
  evidence_sha256, created_at
) ON TABLE model_router_saas.saas_provider_capabilities
  TO model_router_saas_validation_worker;
GRANT SELECT (
  tenant_id, account_id, provider_id, product_id, model, endpoint, capability_version
) ON TABLE model_router_saas.saas_tenant_provider_account_capabilities
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, tenant_id, provider_id, product_id, credential_type, region, purpose,
  rights_id, rights_version, status, validation_state, revalidation_interval_seconds,
  authz_version, quota_state, quota_remaining_minor_units, quota_currency, quota_checked_at,
  opencode_go_usage_next_due_at, opencode_go_usage_updated_at, opencode_go_rate_limited_until,
  claude_usage_updated_at, claude_5h_reset_at,
  gemini_usage_updated_at, gemini_daily_reset_at, gemini_rate_limited_until,
  quarantine_entered_at, quarantine_reason_code,
  egress_proxy_id, probe_temp_unschedulable_until
) ON TABLE model_router_saas.saas_tenant_provider_accounts
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  status, validation_state, validation_error_code, last_validated_at,
  updated_at, authz_version,
  quota_state, quota_remaining_minor_units, quota_currency, quota_checked_at,
  opencode_go_rolling_5h_used_percent, opencode_go_rolling_5h_reset_at,
  opencode_go_weekly_used_percent, opencode_go_weekly_reset_at,
  opencode_go_monthly_used_percent, opencode_go_monthly_reset_at,
  opencode_go_usage_updated_at, opencode_go_usage_next_due_at,
  opencode_go_usage_failure_count, opencode_go_rate_limited_until,
  claude_5h_utilization, claude_5h_reset_at,
  claude_7d_utilization, claude_7d_reset_at,
  claude_7d_sonnet_utilization, claude_7d_sonnet_reset_at,
  claude_7d_oi_utilization, claude_7d_oi_reset_at,
  claude_usage_updated_at, claude_session_window_start, claude_session_window_end,
  gemini_shared_daily_used, gemini_shared_daily_limit,
  gemini_pro_daily_used, gemini_pro_daily_limit,
  gemini_flash_daily_used, gemini_flash_daily_limit,
  gemini_minute_used, gemini_minute_limit,
  gemini_daily_reset_at, gemini_usage_updated_at,
  gemini_rate_limited_until, gemini_tier_id,
  quarantine_entered_at, quarantine_reason_code,
  probe_temp_unschedulable_until
) ON TABLE model_router_saas.saas_tenant_provider_accounts
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, tenant_id, account_id, provider_id, product_id, credential_type, status,
  validation_state, current_version, expires_at, authz_version,
  oauth_refresh_state, oauth_next_refresh_at, oauth_last_refresh_at,
  oauth_force_refresh_requested, oauth_refresh_error_code
) ON TABLE model_router_saas.saas_tenant_provider_credentials
  TO model_router_saas_validation_worker;
-- R4 #18 assembly A: the credential-validation worker is a pure signal
-- role. It keeps SELECT on the five oauth_* columns (claim visibility) and
-- UPDATE only on oauth_force_refresh_requested (the 401-class
-- credential_rejected force signal); the refresh chain itself runs on the
-- control-plane role, which owns every remaining oauth_* write.
GRANT UPDATE (
  status, validation_state, validation_error_code, last_validated_at,
  updated_at, authz_version,
  oauth_force_refresh_requested
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

-- Platform-owner queue (migration 083): identical worker surface minus the
-- tenant dimension. The worker polls the tenant queue first, then this one.
GRANT SELECT (
  id, account_id, credential_id, credential_version, provider_id,
  product_id, credential_type, allowed_models, target_model, target_endpoint,
  capability_version, idempotency_key, status, attempt_count, available_at,
  lease_until, lease_generation, last_error_code, completed_at, created_at, updated_at
) ON TABLE model_router_saas.saas_platform_provider_credential_validation_jobs
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  status, attempt_count, available_at, lease_until, lease_generation,
  last_error_code, completed_at, updated_at
) ON TABLE model_router_saas.saas_platform_provider_credential_validation_jobs
  TO model_router_saas_validation_worker;

GRANT SELECT (
  account_id, provider_id, product_id, model, endpoint, capability_version
) ON TABLE model_router_saas.saas_platform_provider_account_capabilities
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, provider_id, product_id, credential_type, region, purpose,
  rights_id, rights_version, status, validation_state, revalidation_interval_seconds,
  authz_version, quota_state, quota_remaining_minor_units, quota_currency, quota_checked_at,
  opencode_go_usage_next_due_at, opencode_go_usage_updated_at, opencode_go_rate_limited_until,
  claude_usage_updated_at, claude_5h_reset_at,
  gemini_usage_updated_at, gemini_daily_reset_at, gemini_rate_limited_until,
  quarantine_entered_at, quarantine_reason_code,
  egress_proxy_id, probe_temp_unschedulable_until
) ON TABLE model_router_saas.saas_platform_provider_accounts
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  status, validation_state, validation_error_code, last_validated_at,
  updated_at, authz_version,
  quota_state, quota_remaining_minor_units, quota_currency, quota_checked_at,
  opencode_go_rolling_5h_used_percent, opencode_go_rolling_5h_reset_at,
  opencode_go_weekly_used_percent, opencode_go_weekly_reset_at,
  opencode_go_monthly_used_percent, opencode_go_monthly_reset_at,
  opencode_go_usage_updated_at, opencode_go_usage_next_due_at,
  opencode_go_usage_failure_count, opencode_go_rate_limited_until,
  claude_5h_utilization, claude_5h_reset_at,
  claude_7d_utilization, claude_7d_reset_at,
  claude_7d_sonnet_utilization, claude_7d_sonnet_reset_at,
  claude_7d_oi_utilization, claude_7d_oi_reset_at,
  claude_usage_updated_at, claude_session_window_start, claude_session_window_end,
  gemini_shared_daily_used, gemini_shared_daily_limit,
  gemini_pro_daily_used, gemini_pro_daily_limit,
  gemini_flash_daily_used, gemini_flash_daily_limit,
  gemini_minute_used, gemini_minute_limit,
  gemini_daily_reset_at, gemini_usage_updated_at,
  gemini_rate_limited_until, gemini_tier_id,
  quarantine_entered_at, quarantine_reason_code,
  probe_temp_unschedulable_until
) ON TABLE model_router_saas.saas_platform_provider_accounts
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, account_id, provider_id, product_id, credential_type, status,
  validation_state, current_version, expires_at, authz_version,
  oauth_refresh_state, oauth_next_refresh_at, oauth_last_refresh_at,
  oauth_force_refresh_requested, oauth_refresh_error_code
) ON TABLE model_router_saas.saas_platform_provider_credentials
  TO model_router_saas_validation_worker;
-- R4 #18 assembly A: signal-only oauth surface, identical to the tenant
-- credential table above.
GRANT UPDATE (
  status, validation_state, validation_error_code, last_validated_at,
  updated_at, authz_version,
  oauth_force_refresh_requested
) ON TABLE model_router_saas.saas_platform_provider_credentials
  TO model_router_saas_validation_worker;

GRANT SELECT (
  account_id, credential_id, version, status, schema_version,
  context_version, algorithm, kms_purpose, kms_key_id, wrapping_revision,
  wrapped_dek, nonce, ciphertext, auth_tag, expires_at
) ON TABLE model_router_saas.saas_platform_provider_credential_versions
  TO model_router_saas_validation_worker;

GRANT SELECT (
  account_id, credential_id, credential_version,
  wrapping_revision, kms_key_id, wrapped_dek
) ON TABLE model_router_saas.saas_platform_provider_credential_wrappings
  TO model_router_saas_validation_worker;

-- R6a (migration 109) active probing: the probe monitor worker shares this
-- workload (R3 egress-proxy probe-worker precedent). It claims due
-- saas_probe_monitors rows, appends saas_probe_runs history, resolves the
-- account's egress proxy for the probe request, and writes the
-- probe_temp_unschedulable_until signal on both account owner tables.
-- Run-history retention DELETE stays on the control-plane role: this role
-- holds no table-level grants by contract. The audit INSERT below carries
-- the worker's best-effort unschedule/recovery alert records (the R3
-- sweep-audit precedent; a failed insert never rolls back probe results).
-- Re-apply this template after running migration 109 on a database that
-- predates it; until then the worker runtime privilege probe fails closed
-- by design.

GRANT SELECT (
  id, owner_scope_key, owner_kind, owner_tenant_id, account_id,
  provider_category, probe_interval_seconds, challenge_prompt, challenge_answer,
  failure_threshold, consecutive_failures, last_result, enabled,
  next_due_at, probe_requested_at
) ON TABLE model_router_saas.saas_probe_monitors
  TO model_router_saas_validation_worker;
GRANT UPDATE (
  consecutive_failures, last_result, last_result_detail, last_run_at,
  next_due_at, probe_requested_at, updated_at
) ON TABLE model_router_saas.saas_probe_monitors
  TO model_router_saas_validation_worker;

GRANT INSERT (
  id, monitor_id, triggered_by, result, detail, http_status, latency_ms, created_at
) ON TABLE model_router_saas.saas_probe_runs
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, name, protocol, host, port, auth_sealed_envelope, status, expires_at,
  fallback_mode, backup_proxy_id, last_probe_at, last_probe_latency_ms,
  last_probe_ip, last_probe_quality
) ON TABLE model_router_saas.saas_egress_proxies
  TO model_router_saas_validation_worker;

GRANT INSERT (
  id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point
) ON TABLE model_router_saas.saas_audit_events
  TO model_router_saas_validation_worker;

-- G2 (F6 openRouterModelPricingSync): the OpenRouter model-pricing sync
-- worker shares this workload (the 108 usage-worker precedent). Its
-- service-backed store appends catalog structure and supplier cost versions
-- through the existing SaasCatalogService / SaasPricingService registration
-- methods, so every grant below is exactly the INSERT column list those
-- methods' statements touch (plus the SELECT columns their reads and
-- RETURNING projections need — the catalog SELECT extensions above and the
-- public-model/supplier-cost reads here). saas_provider_rights_events is
-- INSERT-only history; the supplier-cost identity-guard trigger reads the
-- public-model-version identity columns as the inserting role, which the
-- SELECT grant on saas_public_model_versions already covers. The tables are
-- append-only and versioned: the worker never UPDATEs or DELETEs anything,
-- and no saas_audit_events columns are added because the store registers
-- rights without an audit context. Re-apply this template to enable the
-- opt-in openRouterModelPricingSync mount; until then the worker runtime
-- privilege probe fails closed by design.

GRANT INSERT (
  id, rights_id, rights_version, from_status, to_status, event_type, occurred_at
) ON TABLE model_router_saas.saas_provider_rights_events
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, alias, display_name, status
) ON TABLE model_router_saas.saas_public_models
  TO model_router_saas_validation_worker;
GRANT INSERT (
  id, alias, display_name, status, created_at
) ON TABLE model_router_saas.saas_public_models
  TO model_router_saas_validation_worker;

GRANT SELECT (
  public_model_id, version, provider_id, product_id, model, endpoint_scope, status
) ON TABLE model_router_saas.saas_public_model_versions
  TO model_router_saas_validation_worker;
GRANT INSERT (
  public_model_id, version, provider_id, product_id, model, endpoint_scope, status, created_at
) ON TABLE model_router_saas.saas_public_model_versions
  TO model_router_saas_validation_worker;

GRANT SELECT (
  id, version, public_model_id, public_model_version, provider_id, product_id,
  resolved_model, protocol, endpoint, currency,
  commercial_policy_version, calculator_version, rounding_version, rounding_mode,
  rounding_boundary,
  input_rate_numerator_minor_units, input_rate_denominator_units,
  cache_read_rate_numerator_minor_units, cache_read_rate_denominator_units,
  cache_write_rate_numerator_minor_units, cache_write_rate_denominator_units,
  cache_write_5m_rate_numerator_minor_units, cache_write_5m_rate_denominator_units,
  cache_write_1h_rate_numerator_minor_units, cache_write_1h_rate_denominator_units,
  output_rate_numerator_minor_units, output_rate_denominator_units,
  effective_at, expires_at, idempotency_key, definition_digest, created_at
) ON TABLE model_router_saas.saas_supplier_cost_versions
  TO model_router_saas_validation_worker;
GRANT INSERT (
  id, version, public_model_id, public_model_version, provider_id, product_id,
  resolved_model, protocol, endpoint, currency,
  commercial_policy_version, calculator_version, rounding_version, rounding_mode,
  rounding_boundary,
  input_rate_numerator_minor_units, input_rate_denominator_units,
  cache_read_rate_numerator_minor_units, cache_read_rate_denominator_units,
  cache_write_rate_numerator_minor_units, cache_write_rate_denominator_units,
  cache_write_5m_rate_numerator_minor_units, cache_write_5m_rate_denominator_units,
  cache_write_1h_rate_numerator_minor_units, cache_write_1h_rate_denominator_units,
  output_rate_numerator_minor_units, output_rate_denominator_units,
  effective_at, expires_at, idempotency_key, definition_digest, created_at
) ON TABLE model_router_saas.saas_supplier_cost_versions
  TO model_router_saas_validation_worker;

COMMIT;
