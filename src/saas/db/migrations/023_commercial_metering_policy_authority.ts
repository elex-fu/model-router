import type { SaasMigration } from './001_initial_schema.js';

/*
 * Commercial metering is an authority, not a copy of the pricing calculator.
 * The policy rows point at the immutable price/cost versions from migration
 * 017 and only add the usage semantics which the gateway must bind before it
 * can create a dispatchable request.  No row in this migration backfills an
 * existing request, attempt, or route version.
 */
const commercialMeteringPolicyAuthoritySchemaSql = `
CREATE FUNCTION saas_metering_valid_dimensions(dimensions text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  dimension text;
BEGIN
  IF dimensions IS NULL OR cardinality(dimensions) < 1 THEN
    RETURN FALSE;
  END IF;
  FOREACH dimension IN ARRAY dimensions LOOP
    IF dimension IS NULL
      OR btrim(dimension) <> dimension
      OR dimension NOT IN (
        'input_total', 'input_uncached', 'cache_read', 'cache_write',
        'cache_write_5m', 'cache_write_1h', 'output_total', 'reasoning_output'
      )
    THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

CREATE TABLE saas_customer_metering_policy_heads (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_id text NOT NULL,
  current_version bigint NOT NULL CHECK (current_version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, policy_id),
  CONSTRAINT saas_customer_metering_policy_heads_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE saas_customer_metering_policy_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  endpoint text NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  target_mode text NOT NULL,
  customer_price_version text,
  usage_dimensions text[] NOT NULL,
  token_source text NOT NULL CHECK (token_source IN ('upstream', 'local-estimate', 'legacy')),
  rounding_version text NOT NULL,
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('floor', 'ceil', 'half_up', 'half_even')),
  rounding_boundary text NOT NULL CHECK (rounding_boundary = 'total'),
  commercial_policy_version text NOT NULL,
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, policy_id, version),
  CONSTRAINT saas_customer_metering_policy_versions_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_customer_metering_policy_versions_public_model_fk
    FOREIGN KEY (public_model_id, public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_customer_metering_policy_versions_price_fk
    FOREIGN KEY (customer_price_version)
    REFERENCES saas_customer_price_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_customer_metering_policy_versions_target_mode_check CHECK (
    (supply_mode = 'byok' AND target_mode = 'tenant_account' AND customer_price_version IS NULL)
    OR (supply_mode = 'platform' AND target_mode = 'platform_pool' AND customer_price_version IS NOT NULL)
  ),
  CONSTRAINT saas_customer_metering_policy_versions_dimensions_check CHECK (
    saas_metering_valid_dimensions(usage_dimensions)
  ),
  CONSTRAINT saas_customer_metering_policy_versions_text_nonempty CHECK (
    btrim(policy_id) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(rounding_version) <> ''
    AND btrim(commercial_policy_version) <> ''
  )
);

ALTER TABLE saas_customer_metering_policy_heads
  ADD CONSTRAINT saas_customer_metering_policy_heads_version_fk
    FOREIGN KEY (tenant_id, project_id, policy_id, current_version)
    REFERENCES saas_customer_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT;

CREATE INDEX saas_customer_metering_policy_versions_lookup_idx
  ON saas_customer_metering_policy_versions
    (tenant_id, project_id, public_model_id, public_model_version, protocol, supply_mode, version DESC);

CREATE TRIGGER saas_customer_metering_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_customer_metering_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_customer_metering_policy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  price_record record;
BEGIN
  IF (NEW.supply_mode = 'byok' AND NEW.target_mode <> 'tenant_account')
    OR (NEW.supply_mode = 'platform' AND NEW.target_mode <> 'platform_pool')
  THEN
    RAISE EXCEPTION 'Customer metering policy target mode does not match supply mode'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.customer_price_version IS NOT NULL THEN
    SELECT public_model_id, public_model_version, protocol, endpoint,
           rounding_version, rounding_mode, rounding_boundary
      INTO price_record
      FROM saas_customer_price_versions
     WHERE id = NEW.customer_price_version;
    IF NOT FOUND
      OR price_record.public_model_id IS DISTINCT FROM NEW.public_model_id
      OR price_record.public_model_version IS DISTINCT FROM NEW.public_model_version
      OR price_record.protocol IS DISTINCT FROM NEW.protocol
      OR price_record.endpoint IS DISTINCT FROM NEW.endpoint
      OR price_record.rounding_version IS DISTINCT FROM NEW.rounding_version
      OR price_record.rounding_mode IS DISTINCT FROM NEW.rounding_mode
      OR price_record.rounding_boundary IS DISTINCT FROM NEW.rounding_boundary
    THEN
      RAISE EXCEPTION 'Customer metering policy does not match its exact customer price version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_customer_metering_policy_guard
  BEFORE INSERT ON saas_customer_metering_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_customer_metering_policy_guard();

CREATE FUNCTION saas_customer_metering_policy_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_record record;
BEGIN
  SELECT status
    INTO version_record
    FROM saas_customer_metering_policy_versions
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND policy_id = NEW.policy_id
     AND version = NEW.current_version;
  IF NOT FOUND OR version_record.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Customer metering policy head does not match its immutable version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_customer_metering_policy_head_guard
  BEFORE INSERT OR UPDATE OF current_version, status ON saas_customer_metering_policy_heads
  FOR EACH ROW EXECUTE FUNCTION saas_customer_metering_policy_head_guard();

CREATE TABLE saas_provider_metering_policy_heads (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_id text NOT NULL,
  current_version bigint NOT NULL CHECK (current_version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, policy_id),
  CONSTRAINT saas_provider_metering_policy_heads_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE saas_provider_metering_policy_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  policy_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  provider_id text NOT NULL,
  product_id text NOT NULL,
  resolved_model text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  endpoint text NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  target_mode text NOT NULL,
  supplier_cost_version text,
  usage_dimensions text[] NOT NULL,
  token_source text NOT NULL CHECK (token_source IN ('upstream', 'local-estimate', 'legacy')),
  rounding_version text NOT NULL,
  rounding_mode text NOT NULL CHECK (rounding_mode IN ('floor', 'ceil', 'half_up', 'half_even')),
  rounding_boundary text NOT NULL CHECK (rounding_boundary = 'total'),
  commercial_policy_version text NOT NULL,
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, policy_id, version),
  CONSTRAINT saas_provider_metering_policy_versions_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_metering_policy_versions_public_model_fk
    FOREIGN KEY (public_model_id, public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_metering_policy_versions_product_fk
    FOREIGN KEY (provider_id, product_id)
    REFERENCES saas_provider_products (provider_id, product_id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_metering_policy_versions_cost_fk
    FOREIGN KEY (supplier_cost_version)
    REFERENCES saas_supplier_cost_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_provider_metering_policy_versions_target_mode_check CHECK (
    (supply_mode = 'byok' AND target_mode = 'tenant_account' AND supplier_cost_version IS NULL)
    OR (supply_mode = 'platform' AND target_mode = 'platform_pool' AND supplier_cost_version IS NOT NULL)
  ),
  CONSTRAINT saas_provider_metering_policy_versions_dimensions_check CHECK (
    saas_metering_valid_dimensions(usage_dimensions)
  ),
  CONSTRAINT saas_provider_metering_policy_versions_text_nonempty CHECK (
    btrim(policy_id) <> ''
    AND btrim(provider_id) <> ''
    AND btrim(product_id) <> ''
    AND btrim(resolved_model) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(rounding_version) <> ''
    AND btrim(commercial_policy_version) <> ''
  )
);

ALTER TABLE saas_provider_metering_policy_heads
  ADD CONSTRAINT saas_provider_metering_policy_heads_version_fk
    FOREIGN KEY (tenant_id, project_id, policy_id, current_version)
    REFERENCES saas_provider_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT;

CREATE INDEX saas_provider_metering_policy_versions_lookup_idx
  ON saas_provider_metering_policy_versions
    (tenant_id, project_id, public_model_id, public_model_version, protocol, supply_mode, version DESC);

CREATE TRIGGER saas_provider_metering_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_provider_metering_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_provider_metering_policy_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cost_record record;
BEGIN
  IF (NEW.supply_mode = 'byok' AND NEW.target_mode <> 'tenant_account')
    OR (NEW.supply_mode = 'platform' AND NEW.target_mode <> 'platform_pool')
  THEN
    RAISE EXCEPTION 'Provider metering policy target mode does not match supply mode'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supplier_cost_version IS NOT NULL THEN
    SELECT public_model_id, public_model_version, provider_id, product_id, resolved_model,
           protocol, endpoint, rounding_version, rounding_mode, rounding_boundary
      INTO cost_record
      FROM saas_supplier_cost_versions
     WHERE id = NEW.supplier_cost_version;
    IF NOT FOUND
      OR cost_record.public_model_id IS DISTINCT FROM NEW.public_model_id
      OR cost_record.public_model_version IS DISTINCT FROM NEW.public_model_version
      OR cost_record.provider_id IS DISTINCT FROM NEW.provider_id
      OR cost_record.product_id IS DISTINCT FROM NEW.product_id
      OR cost_record.resolved_model IS DISTINCT FROM NEW.resolved_model
      OR cost_record.protocol IS DISTINCT FROM NEW.protocol
      OR cost_record.endpoint IS DISTINCT FROM NEW.endpoint
      OR cost_record.rounding_version IS DISTINCT FROM NEW.rounding_version
      OR cost_record.rounding_mode IS DISTINCT FROM NEW.rounding_mode
      OR cost_record.rounding_boundary IS DISTINCT FROM NEW.rounding_boundary
    THEN
      RAISE EXCEPTION 'Provider metering policy does not match its exact supplier cost version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_provider_metering_policy_guard
  BEFORE INSERT ON saas_provider_metering_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_provider_metering_policy_guard();

CREATE FUNCTION saas_provider_metering_policy_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_record record;
BEGIN
  SELECT status
    INTO version_record
    FROM saas_provider_metering_policy_versions
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND policy_id = NEW.policy_id
     AND version = NEW.current_version;
  IF NOT FOUND OR version_record.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Provider metering policy head does not match its immutable version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_provider_metering_policy_head_guard
  BEFORE INSERT OR UPDATE OF current_version, status ON saas_provider_metering_policy_heads
  FOR EACH ROW EXECUTE FUNCTION saas_provider_metering_policy_head_guard();

CREATE TABLE saas_contract_test_attestations (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  id text NOT NULL,
  provider_policy_id text NOT NULL,
  provider_policy_version bigint NOT NULL CHECK (provider_policy_version >= 1),
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  endpoint text NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  target_mode text NOT NULL CHECK (target_mode IN ('tenant_account', 'platform_pool')),
  contract_digest text NOT NULL CHECK (contract_digest ~ '^[0-9a-f]{64}$'),
  suite_version text NOT NULL,
  test_vector_digest text NOT NULL CHECK (test_vector_digest ~ '^[0-9a-f]{64}$'),
  verifier_key_id text NOT NULL,
  signature_base64 text NOT NULL,
  verification_result text NOT NULL CHECK (verification_result IN ('verified', 'failed')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, id),
  CONSTRAINT saas_contract_test_attestations_policy_fk
    FOREIGN KEY (tenant_id, project_id, provider_policy_id, provider_policy_version)
    REFERENCES saas_provider_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_contract_test_attestations_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_contract_test_attestations_verification_shape CHECK (
    (verification_result = 'verified' AND verified_at IS NOT NULL)
    OR (verification_result = 'failed' AND verified_at IS NULL)
  ),
  CONSTRAINT saas_contract_test_attestations_text_nonempty CHECK (
    btrim(id) <> ''
    AND btrim(provider_policy_id) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(suite_version) <> ''
    AND btrim(verifier_key_id) <> ''
    AND btrim(signature_base64) <> ''
  )
);

CREATE TRIGGER saas_contract_test_attestations_immutable
  BEFORE UPDATE OR DELETE ON saas_contract_test_attestations
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_contract_test_attestation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_record record;
BEGIN
  SELECT public_model_id, public_model_version, protocol, endpoint, supply_mode, target_mode
    INTO policy_record
    FROM saas_provider_metering_policy_versions
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND policy_id = NEW.provider_policy_id
     AND version = NEW.provider_policy_version;
  IF NOT FOUND
    OR policy_record.public_model_id IS DISTINCT FROM NEW.public_model_id
    OR policy_record.public_model_version IS DISTINCT FROM NEW.public_model_version
    OR policy_record.protocol IS DISTINCT FROM NEW.protocol
    OR policy_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR policy_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR policy_record.target_mode IS DISTINCT FROM NEW.target_mode
  THEN
    RAISE EXCEPTION 'Contract attestation does not match its provider policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_contract_test_attestation_guard
  BEFORE INSERT ON saas_contract_test_attestations
  FOR EACH ROW EXECUTE FUNCTION saas_contract_test_attestation_guard();

CREATE TABLE saas_route_config_commercial_authorities (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  route_id text NOT NULL,
  route_version bigint NOT NULL CHECK (route_version >= 1),
  customer_policy_id text NOT NULL,
  customer_policy_version bigint NOT NULL CHECK (customer_policy_version >= 1),
  provider_policy_id text NOT NULL,
  provider_policy_version bigint NOT NULL CHECK (provider_policy_version >= 1),
  contract_attestation_id text NOT NULL,
  customer_price_version text,
  supplier_cost_version text,
  created_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, route_id, route_version),
  CONSTRAINT saas_route_config_commercial_authorities_route_fk
    FOREIGN KEY (tenant_id, project_id, route_id, route_version)
    REFERENCES saas_route_config_versions (tenant_id, project_id, route_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_commercial_authorities_customer_policy_fk
    FOREIGN KEY (tenant_id, project_id, customer_policy_id, customer_policy_version)
    REFERENCES saas_customer_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_commercial_authorities_provider_policy_fk
    FOREIGN KEY (tenant_id, project_id, provider_policy_id, provider_policy_version)
    REFERENCES saas_provider_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_commercial_authorities_attestation_fk
    FOREIGN KEY (tenant_id, project_id, contract_attestation_id)
    REFERENCES saas_contract_test_attestations (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_commercial_authorities_customer_price_fk
    FOREIGN KEY (customer_price_version)
    REFERENCES saas_customer_price_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_commercial_authorities_supplier_cost_fk
    FOREIGN KEY (supplier_cost_version)
    REFERENCES saas_supplier_cost_versions (id)
    ON DELETE RESTRICT
);

CREATE TRIGGER saas_route_config_commercial_authorities_immutable
  BEFORE UPDATE OR DELETE ON saas_route_config_commercial_authorities
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_route_config_commercial_authority_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  route_record record;
  customer_record record;
  provider_record record;
  attestation_record record;
  price_record record;
  cost_record record;
  locked_at timestamptz;
BEGIN
  SELECT rv.public_model_id, rv.public_model_version, rv.protocol, rv.supply_mode,
         rv.target_mode, rv.endpoint, rv.status AS route_status,
         h.current_version, h.status AS head_status
    INTO route_record
    FROM saas_route_config_versions rv
    JOIN saas_route_config_heads h
      ON h.tenant_id = rv.tenant_id
     AND h.project_id = rv.project_id
     AND h.route_id = rv.route_id
   WHERE rv.tenant_id = NEW.tenant_id
     AND rv.project_id = NEW.project_id
     AND rv.route_id = NEW.route_id
     AND rv.version = NEW.route_version
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commercial authority route version is missing' USING ERRCODE = '23514';
  END IF;

  SELECT cp.public_model_id, cp.public_model_version, cp.protocol, cp.endpoint, cp.supply_mode,
         cp.target_mode, cp.customer_price_version, cp.status,
         ch.current_version AS head_version, ch.status AS head_status
    INTO customer_record
    FROM saas_customer_metering_policy_versions cp
    JOIN saas_customer_metering_policy_heads ch
      ON ch.tenant_id = cp.tenant_id
     AND ch.project_id = cp.project_id
     AND ch.policy_id = cp.policy_id
   WHERE cp.tenant_id = NEW.tenant_id
     AND cp.project_id = NEW.project_id
     AND cp.policy_id = NEW.customer_policy_id
     AND cp.version = NEW.customer_policy_version
   FOR SHARE;
  SELECT pp.public_model_id, pp.public_model_version, pp.protocol, pp.endpoint, pp.supply_mode,
         pp.target_mode, pp.supplier_cost_version, pp.resolved_model, pp.status,
         ph.current_version AS head_version, ph.status AS head_status
    INTO provider_record
    FROM saas_provider_metering_policy_versions pp
    JOIN saas_provider_metering_policy_heads ph
      ON ph.tenant_id = pp.tenant_id
     AND ph.project_id = pp.project_id
     AND ph.policy_id = pp.policy_id
   WHERE pp.tenant_id = NEW.tenant_id
     AND pp.project_id = NEW.project_id
     AND pp.policy_id = NEW.provider_policy_id
     AND pp.version = NEW.provider_policy_version
   FOR SHARE;
  SELECT provider_policy_id, provider_policy_version, verification_result,
         public_model_id, public_model_version, protocol, endpoint, supply_mode, target_mode
    INTO attestation_record
    FROM saas_contract_test_attestations
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND id = NEW.contract_attestation_id
   FOR SHARE;

  IF NOT FOUND
    OR route_record.route_status IS DISTINCT FROM 'active'
    OR route_record.head_status IS DISTINCT FROM 'active'
    OR route_record.current_version IS DISTINCT FROM NEW.route_version
    OR customer_record.status IS DISTINCT FROM 'active'
    OR customer_record.head_status IS DISTINCT FROM 'active'
    OR customer_record.head_version IS DISTINCT FROM NEW.customer_policy_version
    OR provider_record.status IS DISTINCT FROM 'active'
    OR provider_record.head_status IS DISTINCT FROM 'active'
    OR provider_record.head_version IS DISTINCT FROM NEW.provider_policy_version
    OR attestation_record.verification_result IS DISTINCT FROM 'verified'
    OR route_record.public_model_id IS DISTINCT FROM customer_record.public_model_id
    OR route_record.public_model_version IS DISTINCT FROM customer_record.public_model_version
    OR route_record.protocol IS DISTINCT FROM customer_record.protocol
    OR route_record.endpoint IS DISTINCT FROM customer_record.endpoint
    OR route_record.supply_mode IS DISTINCT FROM customer_record.supply_mode
    OR route_record.target_mode IS DISTINCT FROM customer_record.target_mode
    OR route_record.public_model_id IS DISTINCT FROM provider_record.public_model_id
    OR route_record.public_model_version IS DISTINCT FROM provider_record.public_model_version
    OR route_record.protocol IS DISTINCT FROM provider_record.protocol
    OR route_record.endpoint IS DISTINCT FROM provider_record.endpoint
    OR route_record.supply_mode IS DISTINCT FROM provider_record.supply_mode
    OR route_record.target_mode IS DISTINCT FROM provider_record.target_mode
    OR attestation_record.provider_policy_id IS DISTINCT FROM NEW.provider_policy_id
    OR attestation_record.provider_policy_version IS DISTINCT FROM NEW.provider_policy_version
    OR attestation_record.public_model_id IS DISTINCT FROM provider_record.public_model_id
    OR attestation_record.public_model_version IS DISTINCT FROM provider_record.public_model_version
    OR attestation_record.protocol IS DISTINCT FROM provider_record.protocol
    OR attestation_record.endpoint IS DISTINCT FROM provider_record.endpoint
    OR attestation_record.supply_mode IS DISTINCT FROM provider_record.supply_mode
    OR attestation_record.target_mode IS DISTINCT FROM provider_record.target_mode
    OR NEW.customer_price_version IS DISTINCT FROM customer_record.customer_price_version
    OR NEW.supplier_cost_version IS DISTINCT FROM provider_record.supplier_cost_version
  THEN
    RAISE EXCEPTION 'Commercial route authority does not match active route, policies, and attestation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.customer_price_version IS NOT NULL THEN
    SELECT effective_at, expires_at
      INTO price_record
      FROM saas_customer_price_versions
     WHERE id = NEW.customer_price_version
     FOR SHARE;
  END IF;
  IF NEW.supplier_cost_version IS NOT NULL THEN
    SELECT effective_at, expires_at
      INTO cost_record
      FROM saas_supplier_cost_versions
     WHERE id = NEW.supplier_cost_version
     FOR SHARE;
  END IF;
  locked_at := clock_timestamp();
  IF NEW.customer_price_version IS NOT NULL
    AND (price_record.effective_at IS NULL OR price_record.effective_at > locked_at
      OR (price_record.expires_at IS NOT NULL AND price_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Customer price version is not effective at authority binding'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.supplier_cost_version IS NOT NULL
    AND (cost_record.effective_at IS NULL OR cost_record.effective_at > locked_at
      OR (cost_record.expires_at IS NOT NULL AND cost_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Supplier cost version is not effective at authority binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_route_config_commercial_authority_guard
  BEFORE INSERT ON saas_route_config_commercial_authorities
  FOR EACH ROW EXECUTE FUNCTION saas_route_config_commercial_authority_guard();

CREATE VIEW saas_route_config_dispatchable AS
SELECT rv.tenant_id, rv.project_id, rv.route_id, rv.version,
       rv.public_model_id, rv.public_model_version, rv.protocol,
       rv.supply_mode, rv.target_mode, rv.upstream_id, rv.endpoint,
       a.customer_policy_id, a.customer_policy_version,
       a.provider_policy_id, a.provider_policy_version,
       a.contract_attestation_id, a.customer_price_version, a.supplier_cost_version
  FROM saas_route_config_versions rv
  CROSS JOIN LATERAL (SELECT clock_timestamp() AS checked_at) database_clock
  JOIN saas_route_config_heads h
    ON h.tenant_id = rv.tenant_id
   AND h.project_id = rv.project_id
   AND h.route_id = rv.route_id
   AND h.current_version = rv.version
  JOIN saas_route_config_commercial_authorities a
    ON a.tenant_id = rv.tenant_id
   AND a.project_id = rv.project_id
   AND a.route_id = rv.route_id
   AND a.route_version = rv.version
  JOIN saas_customer_metering_policy_versions cp
    ON cp.tenant_id = a.tenant_id
   AND cp.project_id = a.project_id
   AND cp.policy_id = a.customer_policy_id
   AND cp.version = a.customer_policy_version
  JOIN saas_customer_metering_policy_heads cph
    ON cph.tenant_id = cp.tenant_id
   AND cph.project_id = cp.project_id
   AND cph.policy_id = cp.policy_id
   AND cph.current_version = cp.version
  JOIN saas_provider_metering_policy_versions pp
    ON pp.tenant_id = a.tenant_id
   AND pp.project_id = a.project_id
   AND pp.policy_id = a.provider_policy_id
   AND pp.version = a.provider_policy_version
  JOIN saas_provider_metering_policy_heads pph
    ON pph.tenant_id = pp.tenant_id
   AND pph.project_id = pp.project_id
   AND pph.policy_id = pp.policy_id
   AND pph.current_version = pp.version
  JOIN saas_contract_test_attestations ca
    ON ca.tenant_id = a.tenant_id
   AND ca.project_id = a.project_id
   AND ca.id = a.contract_attestation_id
  LEFT JOIN saas_customer_price_versions cpv
    ON cpv.id = a.customer_price_version
  LEFT JOIN saas_supplier_cost_versions scv
    ON scv.id = a.supplier_cost_version
 WHERE h.status = 'active'
   AND rv.status = 'active'
   AND cp.status = 'active'
   AND cph.status = 'active'
   AND pp.status = 'active'
   AND pph.status = 'active'
   AND ca.verification_result = 'verified'
   AND (
     a.customer_price_version IS NULL
     OR (cpv.effective_at <= database_clock.checked_at
       AND (cpv.expires_at IS NULL OR cpv.expires_at > database_clock.checked_at))
   )
   AND (
     a.supplier_cost_version IS NULL
     OR (scv.effective_at <= database_clock.checked_at
       AND (scv.expires_at IS NULL OR scv.expires_at > database_clock.checked_at))
   );

ALTER TABLE saas_requests
  ADD COLUMN customer_metering_policy_id text,
  ADD COLUMN customer_metering_policy_version bigint
    CHECK (customer_metering_policy_version IS NULL OR customer_metering_policy_version >= 1),
  ADD COLUMN provider_metering_policy_id text,
  ADD COLUMN provider_metering_policy_version bigint
    CHECK (provider_metering_policy_version IS NULL OR provider_metering_policy_version >= 1),
  ADD COLUMN contract_attestation_id text,
  ADD CONSTRAINT saas_requests_commercial_policy_shape CHECK (
    (customer_metering_policy_id IS NULL
      AND customer_metering_policy_version IS NULL
      AND provider_metering_policy_id IS NULL
      AND provider_metering_policy_version IS NULL
      AND contract_attestation_id IS NULL)
    OR (customer_metering_policy_id IS NOT NULL
      AND customer_metering_policy_version IS NOT NULL
      AND provider_metering_policy_id IS NOT NULL
      AND provider_metering_policy_version IS NOT NULL
      AND contract_attestation_id IS NOT NULL)
  ),
  ADD CONSTRAINT saas_requests_customer_metering_policy_fk
    FOREIGN KEY (tenant_id, project_id, customer_metering_policy_id, customer_metering_policy_version)
    REFERENCES saas_customer_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_requests_provider_metering_policy_fk
    FOREIGN KEY (tenant_id, project_id, provider_metering_policy_id, provider_metering_policy_version)
    REFERENCES saas_provider_metering_policy_versions (tenant_id, project_id, policy_id, version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_requests_contract_attestation_fk
    FOREIGN KEY (tenant_id, project_id, contract_attestation_id)
    REFERENCES saas_contract_test_attestations (tenant_id, project_id, id)
    ON DELETE RESTRICT;

ALTER TABLE saas_attempts
  ADD COLUMN customer_price_version text,
  ADD COLUMN customer_metering_policy_id text,
  ADD COLUMN customer_metering_policy_version bigint
    CHECK (customer_metering_policy_version IS NULL OR customer_metering_policy_version >= 1),
  ADD COLUMN provider_metering_policy_id text,
  ADD COLUMN provider_metering_policy_version bigint
    CHECK (provider_metering_policy_version IS NULL OR provider_metering_policy_version >= 1),
  ADD COLUMN contract_attestation_id text,
  ADD CONSTRAINT saas_attempts_commercial_policy_shape CHECK (
    (customer_metering_policy_id IS NULL
      AND customer_metering_policy_version IS NULL
      AND provider_metering_policy_id IS NULL
      AND provider_metering_policy_version IS NULL
      AND contract_attestation_id IS NULL)
    OR (customer_metering_policy_id IS NOT NULL
      AND customer_metering_policy_version IS NOT NULL
      AND provider_metering_policy_id IS NOT NULL
      AND provider_metering_policy_version IS NOT NULL
      AND contract_attestation_id IS NOT NULL)
  ),
  /* Attempts intentionally do not gain a project_id column.  Their request
   * trigger below revalidates the scoped policy and attestation references in
   * one statement, so a historical attempt cannot be made to point at a
   * different project's authority by a partial nullable FK. */
  ADD CONSTRAINT saas_attempts_customer_price_fk
    FOREIGN KEY (customer_price_version)
    REFERENCES saas_customer_price_versions (id)
    ON DELETE RESTRICT;

CREATE FUNCTION saas_requests_guard_commercial_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  authority_record record;
  price_record record;
  locked_at timestamptz;
BEGIN
  IF NEW.route_config_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_metering_policy_id IS NULL
    OR NEW.customer_metering_policy_version IS NULL
    OR NEW.provider_metering_policy_id IS NULL
    OR NEW.provider_metering_policy_version IS NULL
    OR NEW.contract_attestation_id IS NULL
  THEN
    RAISE EXCEPTION 'New SaaS requests require an exact commercial metering authority snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.customer_policy_id, a.customer_policy_version,
         a.provider_policy_id, a.provider_policy_version,
         a.contract_attestation_id, a.customer_price_version,
         a.supplier_cost_version, cp.status AS customer_status,
         cph.status AS customer_head_status,
         pp.status AS provider_status, pph.status AS provider_head_status,
         ca.verification_result
    INTO authority_record
    FROM saas_route_config_commercial_authorities a
    JOIN saas_customer_metering_policy_versions cp
      ON cp.tenant_id = a.tenant_id
     AND cp.project_id = a.project_id
     AND cp.policy_id = a.customer_policy_id
     AND cp.version = a.customer_policy_version
    JOIN saas_customer_metering_policy_heads cph
      ON cph.tenant_id = cp.tenant_id
     AND cph.project_id = cp.project_id
     AND cph.policy_id = cp.policy_id
     AND cph.current_version = cp.version
    JOIN saas_provider_metering_policy_versions pp
      ON pp.tenant_id = a.tenant_id
     AND pp.project_id = a.project_id
     AND pp.policy_id = a.provider_policy_id
     AND pp.version = a.provider_policy_version
    JOIN saas_provider_metering_policy_heads pph
      ON pph.tenant_id = pp.tenant_id
     AND pph.project_id = pp.project_id
     AND pph.policy_id = pp.policy_id
     AND pph.current_version = pp.version
    JOIN saas_contract_test_attestations ca
      ON ca.tenant_id = a.tenant_id
     AND ca.project_id = a.project_id
     AND ca.id = a.contract_attestation_id
   WHERE a.tenant_id = NEW.tenant_id
     AND a.project_id = NEW.project_id
     AND a.route_id = NEW.route_config_id
     AND a.route_version = NEW.route_config_version
     AND a.customer_policy_id = NEW.customer_metering_policy_id
     AND a.customer_policy_version = NEW.customer_metering_policy_version
     AND a.provider_policy_id = NEW.provider_metering_policy_id
     AND a.provider_policy_version = NEW.provider_metering_policy_version
     AND a.contract_attestation_id = NEW.contract_attestation_id
   FOR SHARE;

  IF NOT FOUND
    OR authority_record.customer_status IS DISTINCT FROM 'active'
    OR authority_record.customer_head_status IS DISTINCT FROM 'active'
    OR authority_record.provider_status IS DISTINCT FROM 'active'
    OR authority_record.provider_head_status IS DISTINCT FROM 'active'
    OR authority_record.verification_result IS DISTINCT FROM 'verified'
    OR NEW.customer_price_version IS DISTINCT FROM authority_record.customer_price_version
    OR NEW.customer_price_version IS DISTINCT FROM (CASE
      WHEN NEW.supply_mode = 'platform' THEN authority_record.customer_price_version
      ELSE NULL
    END)
  THEN
    RAISE EXCEPTION 'SaaS request commercial authority snapshot is not dispatchable'
      USING ERRCODE = '23514';
  END IF;

  IF authority_record.customer_price_version IS NOT NULL THEN
    SELECT effective_at, expires_at
      INTO price_record
      FROM saas_customer_price_versions
     WHERE id = authority_record.customer_price_version
     FOR SHARE;
  END IF;
  locked_at := clock_timestamp();
  IF authority_record.customer_price_version IS NOT NULL
    AND (price_record.effective_at IS NULL OR price_record.effective_at > locked_at
      OR (price_record.expires_at IS NOT NULL AND price_record.expires_at <= locked_at))
  THEN
    RAISE EXCEPTION 'Customer price version is not effective for this request'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_requests_guard_commercial_authority
  BEFORE INSERT OR UPDATE OF route_config_id, route_config_version,
    customer_price_version, customer_metering_policy_id, customer_metering_policy_version,
    provider_metering_policy_id, provider_metering_policy_version, contract_attestation_id
  ON saas_requests
  FOR EACH ROW EXECUTE FUNCTION saas_requests_guard_commercial_authority();

CREATE FUNCTION saas_attempts_guard_commercial_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  authority_record record;
  locked_at timestamptz;
  cost_record record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (OLD.customer_price_version IS DISTINCT FROM NEW.customer_price_version
      OR OLD.customer_metering_policy_id IS DISTINCT FROM NEW.customer_metering_policy_id
      OR OLD.customer_metering_policy_version IS DISTINCT FROM NEW.customer_metering_policy_version
      OR OLD.provider_metering_policy_id IS DISTINCT FROM NEW.provider_metering_policy_id
      OR OLD.provider_metering_policy_version IS DISTINCT FROM NEW.provider_metering_policy_version
      OR OLD.contract_attestation_id IS DISTINCT FROM NEW.contract_attestation_id)
  THEN
    IF OLD.customer_metering_policy_id IS NULL AND NEW.customer_metering_policy_id IS NOT NULL THEN
      RAISE EXCEPTION 'Historical SaaS attempts cannot be assigned commercial authority'
        USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'SaaS attempt commercial authority snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT r.project_id, r.supply_mode, r.customer_price_version,
         r.customer_metering_policy_id, r.customer_metering_policy_version,
         r.provider_metering_policy_id, r.provider_metering_policy_version,
         r.contract_attestation_id
    INTO request_record
    FROM saas_requests r
   WHERE r.tenant_id = NEW.tenant_id
     AND r.id = NEW.request_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt commercial authority request is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.customer_price_version, a.supplier_cost_version,
         cp.status AS customer_status, cph.status AS customer_head_status,
         pp.status AS provider_status, pph.status AS provider_head_status,
         ca.verification_result
    INTO authority_record
    FROM saas_route_config_commercial_authorities a
    JOIN saas_customer_metering_policy_versions cp
      ON cp.tenant_id = a.tenant_id
     AND cp.project_id = a.project_id
     AND cp.policy_id = a.customer_policy_id
     AND cp.version = a.customer_policy_version
    JOIN saas_customer_metering_policy_heads cph
      ON cph.tenant_id = cp.tenant_id
     AND cph.project_id = cp.project_id
     AND cph.policy_id = cp.policy_id
     AND cph.current_version = cp.version
    JOIN saas_provider_metering_policy_versions pp
      ON pp.tenant_id = a.tenant_id
     AND pp.project_id = a.project_id
     AND pp.policy_id = a.provider_policy_id
     AND pp.version = a.provider_policy_version
    JOIN saas_provider_metering_policy_heads pph
      ON pph.tenant_id = pp.tenant_id
     AND pph.project_id = pp.project_id
     AND pph.policy_id = pp.policy_id
     AND pph.current_version = pp.version
    JOIN saas_contract_test_attestations ca
      ON ca.tenant_id = a.tenant_id
     AND ca.project_id = a.project_id
     AND ca.id = a.contract_attestation_id
   WHERE a.tenant_id = NEW.tenant_id
     AND a.project_id = request_record.project_id
     AND a.route_id = NEW.route_config_id
     AND a.route_version = NEW.route_config_version
     AND a.customer_policy_id = NEW.customer_metering_policy_id
     AND a.customer_policy_version = NEW.customer_metering_policy_version
     AND a.provider_policy_id = NEW.provider_metering_policy_id
     AND a.provider_policy_version = NEW.provider_metering_policy_version
     AND a.contract_attestation_id = NEW.contract_attestation_id
   FOR SHARE;

  IF NOT FOUND
    OR authority_record.customer_status IS DISTINCT FROM 'active'
    OR authority_record.customer_head_status IS DISTINCT FROM 'active'
    OR authority_record.provider_status IS DISTINCT FROM 'active'
    OR authority_record.provider_head_status IS DISTINCT FROM 'active'
    OR authority_record.verification_result IS DISTINCT FROM 'verified'
    OR request_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR authority_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR (request_record.supply_mode = 'platform'
      AND authority_record.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version)
    OR (request_record.supply_mode = 'byok' AND NEW.supplier_cost_version IS NOT NULL)
  THEN
    RAISE EXCEPTION 'SaaS attempt commercial authority snapshot is not exact'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supplier_cost_version IS NOT NULL THEN
    SELECT effective_at, expires_at
      INTO cost_record
      FROM saas_supplier_cost_versions
     WHERE id = NEW.supplier_cost_version
     FOR SHARE;
  END IF;
  locked_at := clock_timestamp();
  IF NEW.supplier_cost_version IS NOT NULL
    AND (cost_record.effective_at IS NULL OR cost_record.effective_at > locked_at
      OR (cost_record.expires_at IS NOT NULL AND cost_record.expires_at <= locked_at)
    )
  THEN
    RAISE EXCEPTION 'Supplier cost version is not effective at attempt binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_commercial_authority
  BEFORE INSERT OR UPDATE OF route_config_id, route_config_version,
    customer_price_version, customer_metering_policy_id, customer_metering_policy_version,
    provider_metering_policy_id, provider_metering_policy_version, contract_attestation_id,
    supplier_cost_version
  ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_commercial_authority();

CREATE FUNCTION saas_attempts_guard_commercial_dispatch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.dispatch_state = 'not_sent'
    AND NEW.dispatch_state <> 'not_sent'
  THEN
    IF NOT EXISTS (
      SELECT 1
        FROM saas_route_config_dispatchable d
        JOIN saas_requests r
          ON r.tenant_id = d.tenant_id
         AND r.project_id = d.project_id
         AND r.route_config_id = d.route_id
         AND r.route_config_version = d.version
       WHERE d.tenant_id = NEW.tenant_id
         AND d.project_id = r.project_id
         AND d.route_id = NEW.route_config_id
         AND d.version = NEW.route_config_version
         AND r.id = NEW.request_id
         AND r.customer_metering_policy_id = NEW.customer_metering_policy_id
         AND r.customer_metering_policy_version = NEW.customer_metering_policy_version
         AND r.provider_metering_policy_id = NEW.provider_metering_policy_id
         AND r.provider_metering_policy_version = NEW.provider_metering_policy_version
         AND r.contract_attestation_id = NEW.contract_attestation_id
    ) THEN
      RAISE EXCEPTION 'SaaS attempt has no current dispatchable commercial authority'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_commercial_dispatch
  BEFORE UPDATE OF dispatch_state ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_commercial_dispatch();
`;

export const COMMERCIAL_METERING_POLICY_AUTHORITY_SAAS_MIGRATION: SaasMigration = {
  version: 23,
  name: 'commercial_metering_policy_authority',
  sql: commercialMeteringPolicyAuthoritySchemaSql,
};
