import type { SaasMigration } from './001_initial_schema.js';

/*
 * Batch 4 §4.1 (task #15): multimodal billing dimensions.
 *
 * Extends the commercial pricing family (017), the usage-event facts (010)
 * and the prepared-request evidence usage envelope (024) with the per-unit
 * (media) dimension:
 *
 * - Both price-version tables gain the per_unit rate pair (isomorphic to the
 *   cache_read pair: nullable, pair-CHECKed), the per-unit tier ladder
 *   `per_unit_tier_rates` (a single version row carries its whole
 *   tier→rate map — the 4.1 tier decision, option b), and the optional
 *   token-multiplier policy `token_multipliers` (service tier + long
 *   context, default null = off).
 * - Customer price snapshots gain the per-unit hold witness columns: the
 *   reserved unit-count upper bound and its tier ("images: request × unit
 *   price upper bound"). The supplier attempt snapshot table is NOT
 *   extended: it copies price identity only (its guard trigger compares
 *   identity columns, never rates or holds), and the per-unit facts it
 *   settles against ride the immutable supplier cost version row.
 * - Usage events gain the metering kind (billing_mode), the unit counter
 *   and the size tier. All three are digest-optional in the application's
 *   canonical usage form, so pre-122 rows replay unchanged.
 * - Prepared-request evidence gains the per-unit upper bound and tier; the
 *   024 immutability trigger family is recreated with the extended column
 *   list (the OLD/NEW column enumeration is hardcoded, so every new column
 *   must join the trigger's ROW shape).
 *
 * Everything is additive and defaulted: token-only rows keep their exact
 * pre-122 shapes and digests (the #14/#15 anti-drift policy).
 */

const PER_UNIT_TIER_REGISTRY = "('1k', '2k', '4k', '480p', '720p', '1080p', 'tts', 'stt', 'realtime')";

const multimodalBillingSchemaSql = `
CREATE FUNCTION saas_pricing_valid_per_unit_tier_rates(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  tier_key text;
  rate jsonb;
  tier_count bigint;
BEGIN
  IF value IS NULL THEN RETURN TRUE; END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  SELECT count(*) INTO tier_count FROM jsonb_object_keys(value);
  IF tier_count < 1 OR tier_count > 9 THEN RETURN FALSE; END IF;
  FOR tier_key IN SELECT jsonb_object_keys(value) LOOP
    IF tier_key NOT IN ${PER_UNIT_TIER_REGISTRY} THEN RETURN FALSE; END IF;
    rate := value -> tier_key;
    IF jsonb_typeof(rate) <> 'object'
      OR jsonb_typeof(rate -> 'numeratorMinorUnits') <> 'string'
      OR jsonb_typeof(rate -> 'denominatorUnits') <> 'string'
      OR (rate ->> 'numeratorMinorUnits') !~ '^(0|[1-9][0-9]{0,18})$'
      OR (rate ->> 'denominatorUnits') !~ '^[1-9][0-9]{0,18}$'
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION saas_pricing_valid_token_multipliers(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  tier_key text;
  multiplier jsonb;
BEGIN
  IF value IS NULL THEN RETURN TRUE; END IF;
  IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
  IF value ? 'serviceTiers' THEN
    IF jsonb_typeof(value -> 'serviceTiers') <> 'object' THEN RETURN FALSE; END IF;
    FOR tier_key IN SELECT jsonb_object_keys(value -> 'serviceTiers') LOOP
      IF tier_key NOT IN ('flex', 'default', 'standard', 'auto', 'scale', 'priority', 'fast') THEN
        RETURN FALSE;
      END IF;
      multiplier := (value -> 'serviceTiers') -> tier_key;
      IF jsonb_typeof(multiplier) <> 'object'
        OR jsonb_typeof(multiplier -> 'numerator') <> 'string'
        OR jsonb_typeof(multiplier -> 'denominator') <> 'string'
        OR (multiplier ->> 'numerator') !~ '^[1-9][0-9]{0,29}$'
        OR (multiplier ->> 'denominator') !~ '^[1-9][0-9]{0,29}$'
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
  END IF;
  IF value ? 'longContext' THEN
    IF jsonb_typeof(value -> 'longContext') <> 'object'
      OR jsonb_typeof(value -> 'longContext' -> 'inputThreshold') <> 'string'
      OR (value -> 'longContext' ->> 'inputThreshold') !~ '^[1-9][0-9]{0,18}$'
      OR jsonb_typeof(value -> 'longContext' -> 'thresholdInclusive') <> 'boolean'
      OR jsonb_typeof(value -> 'longContext' -> 'inputMultiplier') <> 'object'
      OR jsonb_typeof(value -> 'longContext' -> 'outputMultiplier') <> 'object'
      OR (value -> 'longContext' -> 'inputMultiplier' ->> 'numerator') !~ '^[1-9][0-9]{0,29}$'
      OR (value -> 'longContext' -> 'inputMultiplier' ->> 'denominator') !~ '^[1-9][0-9]{0,29}$'
      OR (value -> 'longContext' -> 'outputMultiplier' ->> 'numerator') !~ '^[1-9][0-9]{0,29}$'
      OR (value -> 'longContext' -> 'outputMultiplier' ->> 'denominator') !~ '^[1-9][0-9]{0,29}$'
    THEN
      RETURN FALSE;
    END IF;
  END IF;
  RETURN TRUE;
END;
$$;

${['saas_customer_price_versions', 'saas_supplier_cost_versions']
  .map(
    (table) => `
ALTER TABLE ${table}
  ADD COLUMN per_unit_rate_numerator_minor_units bigint,
  ADD COLUMN per_unit_rate_denominator_units bigint,
  ADD COLUMN per_unit_tier_rates jsonb,
  ADD COLUMN token_multipliers jsonb;

ALTER TABLE ${table}
  ADD CONSTRAINT ${table}_per_unit_rate_pair CHECK (
    (per_unit_rate_numerator_minor_units IS NULL) = (per_unit_rate_denominator_units IS NULL)
    AND (
      per_unit_rate_numerator_minor_units IS NULL
      OR (per_unit_rate_numerator_minor_units >= 0 AND per_unit_rate_denominator_units > 0)
    )
  ),
  ADD CONSTRAINT ${table}_per_unit_tier_rates_shape CHECK (
    saas_pricing_valid_per_unit_tier_rates(per_unit_tier_rates)
  ),
  ADD CONSTRAINT ${table}_token_multipliers_shape CHECK (
    saas_pricing_valid_token_multipliers(token_multipliers)
  );
`,
  )
  .join('')}

ALTER TABLE saas_request_customer_price_snapshots
  ADD COLUMN hold_input_per_unit_units bigint NOT NULL DEFAULT 0
    CHECK (hold_input_per_unit_units >= 0),
  ADD COLUMN hold_input_size_tier text
    CHECK (hold_input_size_tier IS NULL OR hold_input_size_tier IN ${PER_UNIT_TIER_REGISTRY});

ALTER TABLE saas_usage_events
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'token'
    CHECK (billing_mode IN ('token', 'per_request', 'image', 'video', 'audio')),
  ADD COLUMN units bigint CHECK (units IS NULL OR units >= 0),
  ADD COLUMN size_tier text
    CHECK (size_tier IS NULL OR size_tier IN ${PER_UNIT_TIER_REGISTRY});

ALTER TABLE saas_prepared_request_evidence
  ADD COLUMN usage_per_unit_units_upper_bound bigint NOT NULL DEFAULT 0
    CHECK (usage_per_unit_units_upper_bound >= 0),
  ADD COLUMN usage_size_tier text
    CHECK (usage_size_tier IS NULL OR usage_size_tier IN ${PER_UNIT_TIER_REGISTRY});

/*
 * 024 trigger family: the immutability FUNCTION enumerates every column in
 * its OLD/NEW ROW comparison (a hardcoded list — any new column must join
 * it or it becomes silently mutable). Recreated verbatim with the two new
 * evidence columns appended after the usage bound columns.
 */
CREATE OR REPLACE FUNCTION saas_prepared_request_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Prepared-request evidence is never deletable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    OLD.id, OLD.schema_version, OLD.tenant_id, OLD.project_id, OLD.request_id, OLD.attempt_id,
    OLD.attempt_ordinal, OLD.proxy_key_id, OLD.entitlement_id, OLD.entitlement_version,
    OLD.supply_profile_id, OLD.supply_profile_version, OLD.model_scope_version, OLD.supply_mode,
    OLD.principal_kind, OLD.principal_id, OLD.authz_version, OLD.config_version,
    OLD.project_policy_version, OLD.public_model, OLD.protocol, OLD.endpoint, OLD.route_config_id,
    OLD.route_config_version, OLD.route_public_model_id, OLD.route_public_model_version,
    OLD.route_protocol, OLD.route_target_mode, OLD.route_upstream_id, OLD.upstream_id,
    OLD.account_owner_kind, OLD.account_id, OLD.provider_id, OLD.product_id, OLD.resolved_model,
    OLD.dispatch_profile_id, OLD.supply_profile_authz_version, OLD.credential_id,
    OLD.credential_version, OLD.credential_authz_version, OLD.account_authz_version,
    OLD.profile_account_authz_version, OLD.pool_id, OLD.pool_authz_version,
    OLD.pool_member_account_authz_version, OLD.pool_member_authz_version, OLD.pool_grant_authz_version,
    OLD.pool_grant_profile_authz_version, OLD.pool_grant_pool_authz_version,
    OLD.customer_metering_policy_id, OLD.customer_metering_policy_version,
    OLD.provider_metering_policy_id, OLD.provider_metering_policy_version, OLD.contract_attestation_id,
    OLD.customer_price_version, OLD.supplier_cost_version, OLD.payload_sha256,
    OLD.usage_input_total_upper_bound, OLD.usage_input_uncached_upper_bound,
    OLD.usage_cache_read_upper_bound, OLD.usage_cache_write_upper_bound,
    OLD.usage_cache_write_5m_upper_bound, OLD.usage_cache_write_1h_upper_bound,
    OLD.usage_output_total_upper_bound, OLD.usage_reasoning_output_upper_bound,
    OLD.usage_per_unit_units_upper_bound, OLD.usage_size_tier,
    OLD.usage_feasible_input_buckets, OLD.max_hold_currency, OLD.max_hold_minor_units,
    OLD.dispatch_deadline, OLD.expires_at, OLD.retry_budget, OLD.verifier_key_id,
    OLD.signature_base64, OLD.statement_sha256, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.schema_version, NEW.tenant_id, NEW.project_id, NEW.request_id, NEW.attempt_id,
    NEW.attempt_ordinal, NEW.proxy_key_id, NEW.entitlement_id, NEW.entitlement_version,
    NEW.supply_profile_id, NEW.supply_profile_version, NEW.model_scope_version, NEW.supply_mode,
    NEW.principal_kind, NEW.principal_id, NEW.authz_version, NEW.config_version,
    NEW.project_policy_version, NEW.public_model, NEW.protocol, NEW.endpoint, NEW.route_config_id,
    NEW.route_config_version, NEW.route_public_model_id, NEW.route_public_model_version,
    NEW.route_protocol, NEW.route_target_mode, NEW.route_upstream_id, NEW.upstream_id,
    NEW.account_owner_kind, NEW.account_id, NEW.provider_id, NEW.product_id, NEW.resolved_model,
    NEW.dispatch_profile_id, NEW.supply_profile_authz_version, NEW.credential_id,
    NEW.credential_version, NEW.credential_authz_version, NEW.account_authz_version,
    NEW.profile_account_authz_version, NEW.pool_id, NEW.pool_authz_version,
    NEW.pool_member_account_authz_version, NEW.pool_member_authz_version, NEW.pool_grant_authz_version,
    NEW.pool_grant_profile_authz_version, NEW.pool_grant_pool_authz_version,
    NEW.customer_metering_policy_id, NEW.customer_metering_policy_version,
    NEW.provider_metering_policy_id, NEW.provider_metering_policy_version, NEW.contract_attestation_id,
    NEW.customer_price_version, NEW.supplier_cost_version, NEW.payload_sha256,
    NEW.usage_input_total_upper_bound, NEW.usage_input_uncached_upper_bound,
    NEW.usage_cache_read_upper_bound, NEW.usage_cache_write_upper_bound,
    NEW.usage_cache_write_5m_upper_bound, NEW.usage_cache_write_1h_upper_bound,
    NEW.usage_output_total_upper_bound, NEW.usage_reasoning_output_upper_bound,
    NEW.usage_per_unit_units_upper_bound, NEW.usage_size_tier,
    NEW.usage_feasible_input_buckets, NEW.max_hold_currency, NEW.max_hold_minor_units,
    NEW.dispatch_deadline, NEW.expires_at, NEW.retry_budget, NEW.verifier_key_id,
    NEW.signature_base64, NEW.statement_sha256, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Prepared-request evidence facts are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'claimed' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Prepared-request evidence cannot be reclaimed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'registered' AND NEW.status NOT IN ('registered', 'claimed') THEN
    RAISE EXCEPTION 'Prepared-request evidence status transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
`;

export const MULTIMODAL_BILLING_SAAS_MIGRATION: SaasMigration = {
  version: 122,
  name: 'multimodal_billing_dimensions',
  sql: multimodalBillingSchemaSql,
};
