import type { SaasMigration } from './001_initial_schema.js';

/*
 * A prepared-request evidence row is the last durable authority before an
 * attempt may leave not_sent.  It contains only digests, immutable authority
 * references, bounded usage facts, and a signature statement.  It never
 * contains request content, headers, proxy-key material, or credentials.
 *
 * This migration is intentionally forward-only.  Existing attempts receive a
 * nullable proof reference and no historical row is synthesized for them.
 */
const preparedRequestEvidenceSchemaSql = `
CREATE FUNCTION saas_prepared_evidence_valid_input_buckets(buckets text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF buckets IS NULL
    OR cardinality(buckets) < 1
    OR array_position(buckets, NULL) IS NOT NULL
    OR buckets <@ ARRAY['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']::text[] IS NOT TRUE
  THEN
    RETURN FALSE;
  END IF;
  RETURN cardinality(buckets) = cardinality(ARRAY(SELECT DISTINCT unnest(buckets)));
END;
$$;

CREATE TABLE saas_prepared_request_evidence (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  attempt_ordinal integer NOT NULL CHECK (attempt_ordinal >= 1),

  proxy_key_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  entitlement_version bigint NOT NULL CHECK (entitlement_version >= 1),
  supply_profile_id text NOT NULL,
  supply_profile_version bigint NOT NULL CHECK (supply_profile_version >= 1),
  model_scope_version bigint NOT NULL CHECK (model_scope_version >= 1),
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  principal_kind text NOT NULL CHECK (principal_kind IN ('member', 'project_service')),
  principal_id uuid NOT NULL,
  authz_version bigint NOT NULL CHECK (authz_version >= 1),
  config_version bigint NOT NULL CHECK (config_version >= 1),
  project_policy_version bigint NOT NULL CHECK (project_policy_version >= 1),

  public_model text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  endpoint text NOT NULL,
  route_config_id text NOT NULL,
  route_config_version bigint NOT NULL CHECK (route_config_version >= 1),
  route_public_model_id text NOT NULL,
  route_public_model_version integer NOT NULL CHECK (route_public_model_version >= 1),
  route_protocol text NOT NULL CHECK (route_protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  route_target_mode text NOT NULL CHECK (route_target_mode IN ('tenant_account', 'platform_pool')),
  route_upstream_id text NOT NULL,

  upstream_id text NOT NULL,
  account_owner_kind text NOT NULL CHECK (account_owner_kind IN ('tenant', 'platform')),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  product_id text NOT NULL,
  resolved_model text NOT NULL,
  dispatch_profile_id text NOT NULL,
  supply_profile_authz_version bigint NOT NULL CHECK (supply_profile_authz_version >= 1),
  credential_id text NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version >= 1),
  credential_authz_version bigint NOT NULL CHECK (credential_authz_version >= 1),
  account_authz_version bigint NOT NULL CHECK (account_authz_version >= 1),
  profile_account_authz_version bigint,
  pool_id text,
  pool_authz_version bigint,
  pool_member_account_authz_version bigint,
  pool_member_authz_version bigint,
  pool_grant_authz_version bigint,
  pool_grant_profile_authz_version bigint,
  pool_grant_pool_authz_version bigint,

  customer_metering_policy_id text NOT NULL,
  customer_metering_policy_version bigint NOT NULL CHECK (customer_metering_policy_version >= 1),
  provider_metering_policy_id text NOT NULL,
  provider_metering_policy_version bigint NOT NULL CHECK (provider_metering_policy_version >= 1),
  contract_attestation_id text NOT NULL,
  customer_price_version text,
  supplier_cost_version text,

  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  usage_input_total_upper_bound bigint NOT NULL CHECK (usage_input_total_upper_bound >= 0),
  usage_input_uncached_upper_bound bigint NOT NULL CHECK (usage_input_uncached_upper_bound >= 0),
  usage_cache_read_upper_bound bigint NOT NULL CHECK (usage_cache_read_upper_bound >= 0),
  usage_cache_write_upper_bound bigint NOT NULL CHECK (usage_cache_write_upper_bound >= 0),
  usage_cache_write_5m_upper_bound bigint NOT NULL CHECK (usage_cache_write_5m_upper_bound >= 0),
  usage_cache_write_1h_upper_bound bigint NOT NULL CHECK (usage_cache_write_1h_upper_bound >= 0),
  usage_output_total_upper_bound bigint NOT NULL CHECK (usage_output_total_upper_bound >= 0),
  usage_reasoning_output_upper_bound bigint NOT NULL CHECK (usage_reasoning_output_upper_bound >= 0),
  usage_feasible_input_buckets text[] NOT NULL,
  max_hold_currency text CHECK (max_hold_currency IS NULL OR max_hold_currency ~ '^[A-Z]{3}$'),
  max_hold_minor_units bigint NOT NULL CHECK (max_hold_minor_units >= 0),
  dispatch_deadline timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  retry_budget integer NOT NULL CHECK (retry_budget BETWEEN 0 AND 1000),

  verifier_key_id text NOT NULL,
  signature_base64 text NOT NULL,
  statement_sha256 text NOT NULL CHECK (statement_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'claimed')),
  claimed_at timestamptz,
  claimed_attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT saas_prepared_request_evidence_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_key_fk
    FOREIGN KEY (tenant_id, project_id, proxy_key_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_entitlement_fk
    FOREIGN KEY (entitlement_id)
    REFERENCES saas_project_entitlements (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_profile_fk
    FOREIGN KEY (tenant_id, supply_profile_id, supply_mode)
    REFERENCES saas_supply_profiles (tenant_id, id, supply_mode)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_project_policy_fk
    FOREIGN KEY (tenant_id, project_id, project_policy_version)
    REFERENCES saas_project_inference_policy_versions (tenant_id, project_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_route_fk
    FOREIGN KEY (tenant_id, project_id, route_config_id, route_config_version)
    REFERENCES saas_route_config_versions (tenant_id, project_id, route_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_public_model_fk
    FOREIGN KEY (route_public_model_id, route_public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_customer_policy_fk
    FOREIGN KEY (tenant_id, project_id, customer_metering_policy_id, customer_metering_policy_version)
    REFERENCES saas_customer_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_provider_policy_fk
    FOREIGN KEY (tenant_id, project_id, provider_metering_policy_id, provider_metering_policy_version)
    REFERENCES saas_provider_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_attestation_fk
    FOREIGN KEY (tenant_id, project_id, contract_attestation_id)
    REFERENCES saas_contract_test_attestations (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_customer_price_fk
    FOREIGN KEY (customer_price_version)
    REFERENCES saas_customer_price_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_supplier_cost_fk
    FOREIGN KEY (supplier_cost_version)
    REFERENCES saas_supplier_cost_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_prepared_request_evidence_bucket_check
    CHECK (saas_prepared_evidence_valid_input_buckets(usage_feasible_input_buckets)),
  CONSTRAINT saas_prepared_request_evidence_usage_bounds_check
    CHECK (
      usage_input_uncached_upper_bound <= usage_input_total_upper_bound
      AND usage_cache_read_upper_bound <= usage_input_total_upper_bound
      AND usage_cache_write_upper_bound <= usage_input_total_upper_bound
      AND usage_cache_write_5m_upper_bound <= usage_input_total_upper_bound
      AND usage_cache_write_1h_upper_bound <= usage_input_total_upper_bound
      AND usage_reasoning_output_upper_bound <= usage_output_total_upper_bound
    ),
  CONSTRAINT saas_prepared_request_evidence_window_check
    CHECK (expires_at >= dispatch_deadline),
  CONSTRAINT saas_prepared_request_evidence_status_shape
    CHECK (
      (status = 'registered' AND claimed_at IS NULL AND claimed_attempt_id IS NULL)
      OR (status = 'claimed' AND claimed_at IS NOT NULL AND claimed_attempt_id = attempt_id)
    ),
  CONSTRAINT saas_prepared_request_evidence_mode_shape
    CHECK (
      (
        supply_mode = 'byok'
        AND route_target_mode = 'tenant_account'
        AND account_owner_kind = 'tenant'
        AND profile_account_authz_version IS NOT NULL
        AND pool_id IS NULL
        AND pool_authz_version IS NULL
        AND pool_member_account_authz_version IS NULL
        AND pool_member_authz_version IS NULL
        AND pool_grant_authz_version IS NULL
        AND pool_grant_profile_authz_version IS NULL
        AND pool_grant_pool_authz_version IS NULL
        AND supplier_cost_version IS NULL
        AND max_hold_currency IS NULL
        AND max_hold_minor_units = 0
      )
      OR (
        supply_mode = 'platform'
        AND route_target_mode = 'platform_pool'
        AND account_owner_kind = 'platform'
        AND profile_account_authz_version IS NULL
        AND pool_id IS NOT NULL
        AND pool_authz_version IS NOT NULL
        AND pool_member_account_authz_version IS NOT NULL
        AND pool_member_authz_version IS NOT NULL
        AND pool_grant_authz_version IS NOT NULL
        AND pool_grant_profile_authz_version IS NOT NULL
        AND pool_grant_pool_authz_version IS NOT NULL
        AND customer_price_version IS NOT NULL
        AND supplier_cost_version IS NOT NULL
        AND max_hold_currency IS NOT NULL
      )
    ),
  CONSTRAINT saas_prepared_request_evidence_text_shape CHECK (
    btrim(public_model) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(route_config_id) <> ''
    AND btrim(route_upstream_id) <> ''
    AND btrim(upstream_id) <> ''
    AND btrim(account_id) <> ''
    AND btrim(provider_id) <> ''
    AND btrim(product_id) <> ''
    AND btrim(resolved_model) <> ''
    AND btrim(dispatch_profile_id) <> ''
    AND btrim(credential_id) <> ''
    AND btrim(verifier_key_id) <> ''
    AND btrim(signature_base64) <> ''
  )
);

ALTER TABLE saas_prepared_request_evidence
  ADD CONSTRAINT saas_prepared_request_evidence_scope_unique UNIQUE (tenant_id, id),
  ADD CONSTRAINT saas_prepared_request_evidence_attempt_unique UNIQUE (tenant_id, attempt_id),
  ADD CONSTRAINT saas_prepared_request_evidence_claimed_attempt_fk
    FOREIGN KEY (tenant_id, claimed_attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT;

CREATE INDEX saas_prepared_request_evidence_claim_idx
  ON saas_prepared_request_evidence (tenant_id, status, expires_at);

ALTER TABLE saas_attempts
  ADD COLUMN prepared_evidence_id uuid;

ALTER TABLE saas_attempts
  ADD CONSTRAINT saas_attempts_prepared_evidence_fk
    FOREIGN KEY (tenant_id, prepared_evidence_id)
    REFERENCES saas_prepared_request_evidence (tenant_id, id)
    ON DELETE RESTRICT;

CREATE FUNCTION saas_prepared_request_evidence_immutable() RETURNS trigger
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

CREATE TRIGGER saas_prepared_request_evidence_immutable
  BEFORE UPDATE OR DELETE ON saas_prepared_request_evidence
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_request_evidence_immutable();

CREATE FUNCTION saas_prepared_request_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  attempt_record record;
  project_record record;
  policy_record record;
  entitlement_record record;
  profile_record record;
  route_record record;
  commercial_record record;
  key_record record;
  account_record record;
  credential_record record;
  mapping_record record;
  pool_record record;
  member_record record;
  grant_record record;
  price_record record;
  cost_record record;
  locked_at timestamptz;
BEGIN
  IF NEW.status IS DISTINCT FROM 'registered' THEN
    RAISE EXCEPTION 'New prepared-request evidence must start registered'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.principal_kind = 'project_service' THEN
    RAISE EXCEPTION 'Project-service prepared-request evidence is unsupported'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM saas_tenants WHERE id = NEW.tenant_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence tenant is not active' USING ERRCODE = '23514';
  END IF;

  SELECT p.inference_policy_version, p.inference_policy_status
    INTO project_record
    FROM saas_projects p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id
   FOR SHARE;
  IF NOT FOUND
    OR project_record.inference_policy_version IS DISTINCT FROM NEW.project_policy_version
    OR project_record.inference_policy_status IS DISTINCT FROM 'active'
  THEN
    RAISE EXCEPTION 'Prepared-request evidence project policy is not the active head'
      USING ERRCODE = '23514';
  END IF;
  SELECT status INTO policy_record
    FROM saas_project_inference_policy_versions
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
     AND version = NEW.project_policy_version
   FOR SHARE;
  IF NOT FOUND OR policy_record.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Prepared-request evidence project policy version is not active'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM saas_users
   WHERE id = NEW.principal_id AND disabled_at IS NULL AND anonymized_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence principal is disabled or anonymized'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM saas_memberships
   WHERE tenant_id = NEW.tenant_id AND user_id = NEW.principal_id
     AND status = 'active' AND revoked_at IS NULL
     AND role IN ('owner', 'admin', 'developer')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence tenant membership is not inference-capable'
      USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM saas_project_memberships
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND user_id = NEW.principal_id
     AND status = 'active' AND revoked_at IS NULL
     AND role IN ('owner', 'admin', 'developer')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence project membership is not inference-capable'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO key_record
    FROM saas_api_keys
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND id = NEW.proxy_key_id
   FOR SHARE;
  IF NOT FOUND
    OR key_record.execution_principal_type IS DISTINCT FROM NEW.principal_kind
    OR key_record.execution_principal_id IS DISTINCT FROM NEW.principal_id
    OR key_record.entitlement_id IS DISTINCT FROM NEW.entitlement_id
    OR key_record.supply_profile_id IS DISTINCT FROM NEW.supply_profile_id
    OR key_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR key_record.authz_version IS DISTINCT FROM NEW.authz_version
    OR key_record.entitlement_authz_version IS DISTINCT FROM NEW.entitlement_version
    OR key_record.supply_profile_authz_version IS DISTINCT FROM NEW.supply_profile_version
    OR key_record.model_scope_version IS DISTINCT FROM NEW.model_scope_version
    OR key_record.status IS DISTINCT FROM 'active'
    OR key_record.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Prepared-request evidence API key authority is stale or mismatched'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared-request evidence request is missing' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO attempt_record
    FROM saas_attempts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.attempt_id
   FOR SHARE;
  IF NOT FOUND
    OR attempt_record.request_id IS DISTINCT FROM NEW.request_id
    OR attempt_record.ordinal IS DISTINCT FROM NEW.attempt_ordinal
    OR attempt_record.dispatch_state IS DISTINCT FROM 'not_sent'
    OR attempt_record.dispatch_authority_state IS DISTINCT FROM 'bound'
  THEN
    RAISE EXCEPTION 'Prepared-request evidence attempt is missing, stale, or already dispatching'
      USING ERRCODE = '23514';
  END IF;

  IF request_record.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR request_record.project_id IS DISTINCT FROM NEW.project_id
    OR request_record.proxy_key_id IS DISTINCT FROM NEW.proxy_key_id
    OR request_record.entitlement_id IS DISTINCT FROM NEW.entitlement_id
    OR request_record.entitlement_version IS DISTINCT FROM NEW.entitlement_version
    OR request_record.supply_profile_id IS DISTINCT FROM NEW.supply_profile_id
    OR request_record.supply_profile_version IS DISTINCT FROM NEW.supply_profile_version
    OR request_record.model_scope_version IS DISTINCT FROM NEW.model_scope_version
    OR request_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR request_record.principal_kind IS DISTINCT FROM NEW.principal_kind
    OR request_record.principal_id IS DISTINCT FROM NEW.principal_id
    OR request_record.authz_version IS DISTINCT FROM NEW.authz_version
    OR request_record.config_version IS DISTINCT FROM NEW.config_version
    OR request_record.project_policy_version IS DISTINCT FROM NEW.project_policy_version
    OR request_record.public_model IS DISTINCT FROM NEW.public_model
    OR request_record.protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR request_record.route_config_id IS DISTINCT FROM NEW.route_config_id
    OR request_record.route_config_version IS DISTINCT FROM NEW.route_config_version
    OR request_record.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR request_record.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR request_record.route_protocol IS DISTINCT FROM NEW.route_protocol
    OR request_record.route_target_mode IS DISTINCT FROM NEW.route_target_mode
    OR request_record.route_upstream_id IS DISTINCT FROM NEW.route_upstream_id
    OR request_record.customer_metering_policy_id IS DISTINCT FROM NEW.customer_metering_policy_id
    OR request_record.customer_metering_policy_version IS DISTINCT FROM NEW.customer_metering_policy_version
    OR request_record.provider_metering_policy_id IS DISTINCT FROM NEW.provider_metering_policy_id
    OR request_record.provider_metering_policy_version IS DISTINCT FROM NEW.provider_metering_policy_version
    OR request_record.contract_attestation_id IS DISTINCT FROM NEW.contract_attestation_id
    OR request_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR attempt_record.upstream_id IS DISTINCT FROM NEW.upstream_id
    OR attempt_record.account_id IS DISTINCT FROM NEW.account_id
    OR attempt_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR attempt_record.product_id IS DISTINCT FROM NEW.product_id
    OR attempt_record.resolved_model IS DISTINCT FROM NEW.resolved_model
    OR attempt_record.protocol IS DISTINCT FROM NEW.protocol
    OR attempt_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR attempt_record.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
    OR attempt_record.dispatch_profile_id IS DISTINCT FROM NEW.dispatch_profile_id
    OR attempt_record.supply_profile_authz_version IS DISTINCT FROM NEW.supply_profile_authz_version
    OR attempt_record.credential_id IS DISTINCT FROM NEW.credential_id
    OR attempt_record.credential_version IS DISTINCT FROM NEW.credential_version
    OR attempt_record.credential_authz_version IS DISTINCT FROM NEW.credential_authz_version
    OR attempt_record.account_authz_version IS DISTINCT FROM NEW.account_authz_version
    OR attempt_record.pool_id IS DISTINCT FROM NEW.pool_id
    OR attempt_record.pool_authz_version IS DISTINCT FROM NEW.pool_authz_version
    OR attempt_record.pool_member_account_authz_version IS DISTINCT FROM NEW.pool_member_account_authz_version
    OR attempt_record.pool_member_authz_version IS DISTINCT FROM NEW.pool_member_authz_version
    OR attempt_record.pool_grant_authz_version IS DISTINCT FROM NEW.pool_grant_authz_version
    OR attempt_record.pool_grant_profile_authz_version IS DISTINCT FROM NEW.pool_grant_profile_authz_version
    OR attempt_record.pool_grant_pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version
    OR attempt_record.profile_account_authz_version IS DISTINCT FROM NEW.profile_account_authz_version
    OR attempt_record.route_config_id IS DISTINCT FROM NEW.route_config_id
    OR attempt_record.route_config_version IS DISTINCT FROM NEW.route_config_version
    OR attempt_record.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR attempt_record.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR attempt_record.route_protocol IS DISTINCT FROM NEW.route_protocol
    OR attempt_record.route_target_mode IS DISTINCT FROM NEW.route_target_mode
    OR attempt_record.project_policy_version IS DISTINCT FROM NEW.project_policy_version
    OR attempt_record.customer_metering_policy_id IS DISTINCT FROM NEW.customer_metering_policy_id
    OR attempt_record.customer_metering_policy_version IS DISTINCT FROM NEW.customer_metering_policy_version
    OR attempt_record.provider_metering_policy_id IS DISTINCT FROM NEW.provider_metering_policy_id
    OR attempt_record.provider_metering_policy_version IS DISTINCT FROM NEW.provider_metering_policy_version
    OR attempt_record.contract_attestation_id IS DISTINCT FROM NEW.contract_attestation_id
    OR attempt_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
  THEN
    RAISE EXCEPTION 'Prepared-request evidence does not match request and attempt authority'
      USING ERRCODE = '23514';
  END IF;

  SELECT e.status, e.effective_at, e.expires_at, e.superseded_at, e.authz_version,
         e.supply_profile_id, e.supply_mode, e.model_scopes
    INTO entitlement_record
    FROM saas_project_entitlements e
   WHERE e.id = NEW.entitlement_id
     AND e.tenant_id = NEW.tenant_id
     AND e.project_id = NEW.project_id
   FOR SHARE;
  SELECT p.status, p.authz_version, p.supply_mode, p.model_scopes
    INTO profile_record
    FROM saas_supply_profiles p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.supply_profile_id
     AND p.supply_mode = NEW.supply_mode
   FOR SHARE;
  IF NOT FOUND
    OR profile_record.status IS DISTINCT FROM 'active'
    OR profile_record.authz_version IS DISTINCT FROM NEW.supply_profile_version
  THEN
    RAISE EXCEPTION 'Prepared-request evidence supply profile is stale or disabled'
      USING ERRCODE = '23514';
  END IF;

  SELECT rv.*, h.current_version AS head_version, h.status AS head_status,
         pm.alias AS public_model_alias, pm.status AS public_model_status,
         pmv.status AS public_model_version_status
    INTO route_record
    FROM saas_route_config_versions rv
    JOIN saas_route_config_heads h
      ON h.tenant_id = rv.tenant_id AND h.project_id = rv.project_id AND h.route_id = rv.route_id
    JOIN saas_public_model_versions pmv
      ON pmv.public_model_id = rv.public_model_id AND pmv.version = rv.public_model_version
    JOIN saas_public_models pm ON pm.id = pmv.public_model_id
   WHERE rv.tenant_id = NEW.tenant_id AND rv.project_id = NEW.project_id
     AND rv.route_id = NEW.route_config_id AND rv.version = NEW.route_config_version
   FOR SHARE;
  IF NOT FOUND
    OR route_record.status IS DISTINCT FROM 'active'
    OR route_record.head_status IS DISTINCT FROM 'active'
    OR route_record.head_version IS DISTINCT FROM NEW.route_config_version
    OR route_record.public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR route_record.public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR route_record.protocol IS DISTINCT FROM NEW.route_protocol
    OR route_record.target_mode IS DISTINCT FROM NEW.route_target_mode
    OR route_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR route_record.upstream_id IS DISTINCT FROM NEW.route_upstream_id
    OR route_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR route_record.public_model_alias IS DISTINCT FROM NEW.public_model
    OR route_record.public_model_status IS DISTINCT FROM 'active'
    OR route_record.public_model_version_status IS DISTINCT FROM 'active'
  THEN
    RAISE EXCEPTION 'Prepared-request evidence route is not the active exact route head'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.customer_policy_id, a.customer_policy_version, a.provider_policy_id,
         a.provider_policy_version, a.contract_attestation_id, a.customer_price_version,
         a.supplier_cost_version, cp.status AS customer_status,
         cph.current_version AS customer_head_version, cph.status AS customer_head_status,
         pp.status AS provider_status, pph.current_version AS provider_head_version,
         pph.status AS provider_head_status, ca.verification_result
    INTO commercial_record
    FROM saas_route_config_commercial_authorities a
    JOIN saas_customer_metering_policy_versions cp
      ON cp.tenant_id = a.tenant_id AND cp.project_id = a.project_id
     AND cp.policy_id = a.customer_policy_id AND cp.version = a.customer_policy_version
    JOIN saas_customer_metering_policy_heads cph
      ON cph.tenant_id = cp.tenant_id AND cph.project_id = cp.project_id
     AND cph.policy_id = cp.policy_id AND cph.current_version = cp.version
    JOIN saas_provider_metering_policy_versions pp
      ON pp.tenant_id = a.tenant_id AND pp.project_id = a.project_id
     AND pp.policy_id = a.provider_policy_id AND pp.version = a.provider_policy_version
    JOIN saas_provider_metering_policy_heads pph
      ON pph.tenant_id = pp.tenant_id AND pph.project_id = pp.project_id
     AND pph.policy_id = pp.policy_id AND pph.current_version = pp.version
    JOIN saas_contract_test_attestations ca
      ON ca.tenant_id = a.tenant_id AND ca.project_id = a.project_id
     AND ca.id = a.contract_attestation_id
   WHERE a.tenant_id = NEW.tenant_id AND a.project_id = NEW.project_id
     AND a.route_id = NEW.route_config_id AND a.route_version = NEW.route_config_version
   FOR SHARE;
  IF NOT FOUND
    OR commercial_record.customer_policy_id IS DISTINCT FROM NEW.customer_metering_policy_id
    OR commercial_record.customer_policy_version IS DISTINCT FROM NEW.customer_metering_policy_version
    OR commercial_record.provider_policy_id IS DISTINCT FROM NEW.provider_metering_policy_id
    OR commercial_record.provider_policy_version IS DISTINCT FROM NEW.provider_metering_policy_version
    OR commercial_record.contract_attestation_id IS DISTINCT FROM NEW.contract_attestation_id
    OR commercial_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR commercial_record.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
    OR commercial_record.customer_status IS DISTINCT FROM 'active'
    OR commercial_record.customer_head_status IS DISTINCT FROM 'active'
    OR commercial_record.customer_head_version IS DISTINCT FROM NEW.customer_metering_policy_version
    OR commercial_record.provider_status IS DISTINCT FROM 'active'
    OR commercial_record.provider_head_status IS DISTINCT FROM 'active'
    OR commercial_record.provider_head_version IS DISTINCT FROM NEW.provider_metering_policy_version
    OR commercial_record.verification_result IS DISTINCT FROM 'verified'
  THEN
    RAISE EXCEPTION 'Prepared-request evidence commercial authority is stale or mismatched'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.account_owner_kind = 'tenant' THEN
    SELECT * INTO account_record
      FROM saas_tenant_provider_accounts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id
       AND provider_id = NEW.provider_id AND product_id = NEW.product_id
     FOR SHARE;
    SELECT c.authz_version, c.current_version, c.status, c.validation_state,
           c.expires_at AS credential_expires_at, v.status AS version_status,
           v.expires_at AS version_expires_at, v.account_id
      INTO credential_record
      FROM saas_tenant_provider_credentials c
      JOIN saas_tenant_provider_credential_versions v
        ON v.tenant_id = c.tenant_id AND v.credential_id = c.id
       AND v.version = NEW.credential_version
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.credential_id
       AND c.account_id = NEW.account_id
     FOR SHARE;
    SELECT * INTO mapping_record
      FROM saas_tenant_provider_supply_profile_accounts
     WHERE tenant_id = NEW.tenant_id AND supply_profile_id = NEW.dispatch_profile_id
       AND account_id = NEW.account_id AND provider_id = NEW.provider_id
       AND product_id = NEW.product_id AND authz_version = NEW.profile_account_authz_version
       AND account_authz_version = NEW.account_authz_version
     FOR SHARE;
    IF NOT FOUND OR mapping_record.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Prepared-request evidence BYOK profile mapping is stale'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_owner_kind = 'platform' THEN
    SELECT * INTO account_record
      FROM saas_platform_provider_accounts
     WHERE id = NEW.account_id AND provider_id = NEW.provider_id AND product_id = NEW.product_id
     FOR SHARE;
    SELECT c.authz_version, c.current_version, c.status, c.validation_state,
           c.expires_at AS credential_expires_at, v.status AS version_status,
           v.expires_at AS version_expires_at, v.account_id
      INTO credential_record
      FROM saas_platform_provider_credentials c
      JOIN saas_platform_provider_credential_versions v
        ON v.credential_id = c.id AND v.version = NEW.credential_version
     WHERE c.id = NEW.credential_id AND c.account_id = NEW.account_id
     FOR SHARE;
    SELECT * INTO pool_record
      FROM saas_platform_provider_pools
     WHERE id = NEW.pool_id AND provider_id = NEW.provider_id AND product_id = NEW.product_id
     FOR SHARE;
    SELECT * INTO member_record
      FROM saas_platform_provider_pool_members
     WHERE pool_id = NEW.pool_id AND account_id = NEW.account_id
       AND provider_id = NEW.provider_id AND product_id = NEW.product_id
     FOR SHARE;
    SELECT * INTO grant_record
      FROM saas_platform_provider_pool_grants
     WHERE pool_id = NEW.pool_id AND tenant_id = NEW.tenant_id
       AND supply_profile_id = NEW.dispatch_profile_id
     FOR SHARE;
    IF NOT FOUND OR grant_record.status IS DISTINCT FROM 'active'
      OR grant_record.authz_version IS DISTINCT FROM NEW.pool_grant_authz_version
      OR grant_record.profile_authz_version IS DISTINCT FROM NEW.pool_grant_profile_authz_version
      OR grant_record.pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version
    THEN
      RAISE EXCEPTION 'Prepared-request evidence platform pool grant is stale'
        USING ERRCODE = '23514';
    END IF;
    IF member_record IS NULL OR member_record.status IS DISTINCT FROM 'active'
      OR member_record.authz_version IS DISTINCT FROM NEW.pool_member_authz_version
      OR member_record.account_authz_version IS DISTINCT FROM NEW.pool_member_account_authz_version
    THEN
      RAISE EXCEPTION 'Prepared-request evidence platform pool member is stale'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Prepared-request evidence account owner kind is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF account_record IS NULL
    OR account_record.status IS DISTINCT FROM 'active'
    OR account_record.validation_state IS DISTINCT FROM 'verified'
    OR account_record.authz_version IS DISTINCT FROM NEW.account_authz_version
  THEN
    RAISE EXCEPTION 'Prepared-request evidence provider account is stale or unverified'
      USING ERRCODE = '23514';
  END IF;
  IF credential_record IS NULL
    OR credential_record.status IS DISTINCT FROM 'active'
    OR credential_record.validation_state IS DISTINCT FROM 'verified'
    OR credential_record.authz_version IS DISTINCT FROM NEW.credential_authz_version
    OR credential_record.current_version IS DISTINCT FROM NEW.credential_version
    OR credential_record.version_status IS DISTINCT FROM 'active'
    OR credential_record.account_id IS DISTINCT FROM NEW.account_id
  THEN
    RAISE EXCEPTION 'Prepared-request evidence credential authority is stale or unverified'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.customer_price_version IS NOT NULL THEN
    SELECT * INTO price_record FROM saas_customer_price_versions
     WHERE id = NEW.customer_price_version FOR SHARE;
  END IF;
  IF NEW.supplier_cost_version IS NOT NULL THEN
    SELECT * INTO cost_record FROM saas_supplier_cost_versions
     WHERE id = NEW.supplier_cost_version FOR SHARE;
  END IF;
  locked_at := clock_timestamp();

  IF entitlement_record IS NULL
    OR entitlement_record.supply_profile_id IS DISTINCT FROM NEW.supply_profile_id
    OR entitlement_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR entitlement_record.authz_version IS DISTINCT FROM NEW.entitlement_version
    OR entitlement_record.effective_at > locked_at
    OR (entitlement_record.status = 'active'
      AND (entitlement_record.expires_at IS NOT NULL AND entitlement_record.expires_at <= locked_at))
    OR (entitlement_record.status = 'superseded'
      AND (entitlement_record.superseded_at IS NULL OR entitlement_record.superseded_at > locked_at
        OR (entitlement_record.expires_at IS NOT NULL AND entitlement_record.expires_at <= locked_at)))
    OR entitlement_record.status NOT IN ('active', 'superseded')
  THEN
    RAISE EXCEPTION 'Prepared-request evidence entitlement is not currently valid'
      USING ERRCODE = '23514';
  END IF;
  IF key_record.expires_at IS NOT NULL AND key_record.expires_at <= locked_at THEN
    RAISE EXCEPTION 'Prepared-request evidence API key is expired' USING ERRCODE = '23514';
  END IF;
  IF mapping_record IS NOT NULL
    AND (mapping_record.effective_at > locked_at
      OR (mapping_record.expires_at IS NOT NULL AND mapping_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Prepared-request evidence profile mapping is outside its validity window'
      USING ERRCODE = '23514';
  END IF;
  IF grant_record IS NOT NULL
    AND (grant_record.effective_at > locked_at
      OR (grant_record.expires_at IS NOT NULL AND grant_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Prepared-request evidence pool grant is outside its validity window'
      USING ERRCODE = '23514';
  END IF;
  IF credential_record.credential_expires_at IS NOT NULL
    AND credential_record.credential_expires_at <= locked_at
  THEN
    RAISE EXCEPTION 'Prepared-request evidence credential is expired' USING ERRCODE = '23514';
  END IF;
  IF credential_record.version_expires_at IS NOT NULL
    AND credential_record.version_expires_at <= locked_at
  THEN
    RAISE EXCEPTION 'Prepared-request evidence credential version is expired' USING ERRCODE = '23514';
  END IF;
  IF NEW.expires_at <= locked_at OR NEW.dispatch_deadline <= locked_at THEN
    RAISE EXCEPTION 'Prepared-request evidence is expired' USING ERRCODE = '23514';
  END IF;
  IF NEW.attempt_ordinal > NEW.retry_budget + 1 THEN
    RAISE EXCEPTION 'Prepared-request evidence exceeds the signed retry budget'
      USING ERRCODE = '23514';
  END IF;
  IF price_record IS NOT NULL
    AND (price_record.effective_at > locked_at
      OR (price_record.expires_at IS NOT NULL AND price_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Prepared-request evidence customer price is expired' USING ERRCODE = '23514';
  END IF;
  IF cost_record IS NOT NULL
    AND (cost_record.effective_at > locked_at
      OR (cost_record.expires_at IS NOT NULL AND cost_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Prepared-request evidence provider cost is expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_prepared_request_evidence_guard
  BEFORE INSERT ON saas_prepared_request_evidence
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_request_evidence_guard();

CREATE FUNCTION saas_attempts_guard_prepared_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  evidence_record record;
  locked_at timestamptz;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.prepared_evidence_id IS DISTINCT FROM NEW.prepared_evidence_id
    AND (OLD.dispatch_state <> 'not_sent' OR NEW.prepared_evidence_id IS NULL)
  THEN
    RAISE EXCEPTION 'Prepared-request evidence reference is immutable once dispatch starts'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.dispatch_state <> 'not_sent' AND NEW.prepared_evidence_id IS NULL THEN
    RAISE EXCEPTION 'SaaS attempts require claimed prepared-request evidence before dispatch'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.prepared_evidence_id IS NOT NULL THEN
    SELECT status, request_id, attempt_id, attempt_ordinal, claimed_attempt_id, expires_at,
           dispatch_deadline
      INTO evidence_record
      FROM saas_prepared_request_evidence
     WHERE tenant_id = NEW.tenant_id AND id = NEW.prepared_evidence_id
     FOR SHARE;
    IF NOT FOUND
      OR evidence_record.request_id IS DISTINCT FROM NEW.request_id
      OR evidence_record.attempt_id IS DISTINCT FROM NEW.id
      OR evidence_record.attempt_ordinal IS DISTINCT FROM NEW.ordinal
    THEN
      RAISE EXCEPTION 'SaaS attempt prepared-request evidence does not match the attempt'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.dispatch_state <> 'not_sent' THEN
      locked_at := clock_timestamp();
      IF evidence_record.status IS DISTINCT FROM 'claimed'
        OR evidence_record.claimed_attempt_id IS DISTINCT FROM NEW.id
        OR evidence_record.expires_at <= locked_at
        OR evidence_record.dispatch_deadline <= locked_at
      THEN
        RAISE EXCEPTION 'SaaS attempt prepared-request evidence is not claimed or has expired'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_prepared_evidence
  BEFORE INSERT OR UPDATE ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_prepared_evidence();
`;

export const PREPARED_REQUEST_EVIDENCE_SAAS_MIGRATION: SaasMigration = {
  version: 24,
  name: 'prepared_request_evidence',
  sql: preparedRequestEvidenceSchemaSql,
};
