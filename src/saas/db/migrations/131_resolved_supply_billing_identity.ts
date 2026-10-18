import type { SaasMigration } from './001_initial_schema.js';

/**
 * R3 §8.1 (core-plan 2026-10-18 §8.1, ResolvedSupplyBillingIdentity).
 *
 * Migration 017 fenced BOTH commercial price identities to the public model
 * version's nominal provider/product/endpoint pin, and migration 022's
 * request guard required the request endpoint to equal the route-config
 * endpoint. Both are correct for nominal dispatches but wrong once composite
 * model routing (migration 121) exists: a composite dispatch serves on a
 * RESOLVED target platform whose provider/product/model/endpoint
 * deliberately differ from the route's nominal pin, and §8.1 requires each
 * attempt to freeze a supplier cost version resolved on that actual
 * identity, with the durable request carrying the composite serving
 * endpoint (the guard's composite branch and the signed evidence statement
 * both key on it).
 *
 * This migration replaces exactly five trigger FUNCTIONS (no table or
 * column changes, no new grants — the functions are migrator-owned and run
 * on existing gateway INSERT privileges):
 *
 * 1. `saas_pricing_guard_supplier_identity` — the supplier cost fence now
 *    accepts the public model version's nominal pin (every pre-composite
 *    registration keeps working unchanged) OR a full serving identity
 *    (provider_id, product_id, resolved_model, endpoint, protocol) that
 *    carries a VERIFIED provider capability — the composite target. This
 *    is the same fact the composite resolver (resolveCompositeTargetCapability)
 *    and the admission guard's capability recheck already demand. The
 *    CUSTOMER price guard is untouched — the customer sale identity never
 *    drifts on an internal switch.
 *
 * 2. `saas_attempts_guard_commercial_authority` — the supplier cost check
 *    now accepts the route authority's nominal version (nominal dispatch)
 *    or a supplier cost version that exactly matches THIS attempt's
 *    resolved serving identity (provider/product/model/endpoint/protocol)
 *    under the attempt's route public model version (composite dispatch).
 *    Every policy/attestation/customer-price equality is unchanged.
 *
 * 3. `saas_attempts_guard_route_snapshot` — the serving model/endpoint
 *    checks now accept the nominal route pins or a VERIFIED capability
 *    identity matching the attempt's provider/product/model/endpoint/
 *    protocol (composite dispatch). Every route/request equality is
 *    unchanged.
 *
 * 4. `saas_requests_guard_route_snapshot` — the endpoint check now accepts
 *    the route-config endpoint OR any endpoint covered by a verified
 *    provider capability for the request's protocol (the composite target's
 *    serving endpoint). Every other route-authority equality in the guard
 *    (route head, public model, protocol, target mode, upstream, alias,
 *    config version) is unchanged. The strong serving-identity fence stays
 *    where the identity actually lives: the attempt-level triggers verify
 *    the account/credential/pool against the attempt's resolved
 *    provider/product/model/endpoint, the admission guard re-resolves the
 *    supplier cost version on that identity, and the signed prepared
 *    evidence statement carries it.
 *
 * 5. `saas_pricing_guard_customer_snapshot` — the snapshot endpoint must
 *    match the request's serving endpoint or the request's own route-config
 *    endpoint (composite dispatch: the snapshot keeps the nominal customer
 *    endpoint). The immutable price-version identity equality is unchanged.
 */
const resolvedSupplyBillingIdentitySql = `CREATE OR REPLACE FUNCTION saas_pricing_guard_supplier_identity()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  model_record record;
  capability_verified boolean;
BEGIN
  -- R3 §8.1: the supplier cost identity is the ACTUAL serving platform. A
  -- registration is valid when it matches the public model version's
  -- nominal pin (every pre-composite flow) OR when its full serving
  -- identity is a VERIFIED provider capability (the composite target
  -- platform, which by construction differs from the nominal pin). The
  -- CUSTOMER price guard is unchanged — the customer identity never drifts.
  SELECT provider_id, product_id, NEW.endpoint = ANY(endpoint_scope) AS endpoint_allowed
    INTO model_record
    FROM saas_public_model_versions
   WHERE public_model_id = NEW.public_model_id
     AND version = NEW.public_model_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier cost identity does not reference a public model version'
      USING ERRCODE = '23514';
  END IF;

  IF model_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR model_record.product_id IS DISTINCT FROM NEW.product_id
    OR model_record.endpoint_allowed IS DISTINCT FROM TRUE
  THEN
    SELECT EXISTS (
      SELECT 1
        FROM saas_provider_capabilities
       WHERE provider_id = NEW.provider_id
         AND product_id = NEW.product_id
         AND model = NEW.resolved_model
         AND endpoint = NEW.endpoint
         AND protocol = NEW.protocol
         AND support_level IN ('supported', 'limited')
         AND validation_state = 'verified'
    )
      INTO capability_verified;
    IF capability_verified IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Supplier cost identity does not match a verified provider capability'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION saas_requests_guard_route_snapshot()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  route_record record;
  endpoint_allowed boolean;
BEGIN
  SELECT rv.status AS route_status,
         h.status AS head_status,
         h.current_version,
         rv.public_model_id,
         rv.public_model_version,
         rv.protocol,
         rv.target_mode,
         rv.supply_mode,
         rv.upstream_id,
         pm.alias,
         pm.status AS public_model_status,
         pmv.status AS public_model_version_status,
         rv.endpoint AS route_endpoint
    INTO route_record
    FROM saas_route_config_versions rv
    JOIN saas_route_config_heads h
      ON h.tenant_id = rv.tenant_id
     AND h.project_id = rv.project_id
     AND h.route_id = rv.route_id
    JOIN saas_public_model_versions pmv
      ON pmv.public_model_id = rv.public_model_id
     AND pmv.version = rv.public_model_version
    JOIN saas_public_models pm ON pm.id = pmv.public_model_id
   WHERE rv.tenant_id = NEW.tenant_id
     AND rv.project_id = NEW.project_id
     AND rv.route_id = NEW.route_config_id
     AND rv.version = NEW.route_config_version;

  -- R3 §8.1: a composite dispatch serves on the resolved target platform's
  -- endpoint. The request endpoint is valid when it is the route-config
  -- endpoint (nominal dispatch) or a verified provider capability endpoint
  -- for the request's protocol (composite dispatch). The attempt-level
  -- triggers and the admission guard verify the full serving identity.
  SELECT EXISTS (
    SELECT 1
      FROM saas_provider_capabilities cap
     WHERE cap.protocol = NEW.protocol
       AND cap.endpoint = NEW.endpoint
       AND cap.support_level IN ('supported', 'limited')
       AND cap.validation_state = 'verified'
  )
    INTO endpoint_allowed;

  IF NOT FOUND
    OR route_record.route_status IS DISTINCT FROM 'active'
    OR route_record.head_status IS DISTINCT FROM 'active'
    OR route_record.current_version IS DISTINCT FROM NEW.route_config_version
    OR route_record.public_model_status IS DISTINCT FROM 'active'
    OR route_record.public_model_version_status IS DISTINCT FROM 'active'
    OR route_record.public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR route_record.public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR route_record.protocol IS DISTINCT FROM NEW.route_protocol
    OR route_record.target_mode IS DISTINCT FROM NEW.route_target_mode
    OR route_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR route_record.upstream_id IS DISTINCT FROM NEW.route_upstream_id
    OR route_record.alias IS DISTINCT FROM NEW.public_model
    OR route_record.protocol IS DISTINCT FROM NEW.protocol
    OR NEW.config_version IS DISTINCT FROM NEW.route_config_version
    OR (
      route_record.route_endpoint IS DISTINCT FROM NEW.endpoint
      AND endpoint_allowed IS DISTINCT FROM TRUE
    )
  THEN
    RAISE EXCEPTION 'SaaS request route authority snapshot is not the active exact route head'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION saas_attempts_guard_commercial_authority()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  commercial_project_id uuid;
  authority_record record;
  locked_at timestamptz;
  cost_effective_at timestamptz;
  cost_expires_at timestamptz;
  resolved_cost_exact boolean;
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

  SELECT project_id INTO commercial_project_id FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt commercial authority request is missing'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tenant_id IS NULL OR commercial_project_id IS NULL THEN
    RAISE EXCEPTION 'Commercial authority fence identity is missing' USING ERRCODE = '23514';
  END IF;
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'Commercial authority reads require READ COMMITTED' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('saas-authz:tenant:' || NEW.tenant_id::text, 0));
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('saas-authz:project:' || NEW.tenant_id::text || ':' || commercial_project_id::text, 0)
  );

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
   ;

  -- R3 §8.1: on composite dispatches the attempt's supplier cost version is
  -- RESOLVED on the target-platform identity and deliberately differs from
  -- the route commercial authority's nominal version. The relaxed fence
  -- accepts the authority's version (nominal dispatch) or a cost version
  -- that exactly matches THIS attempt's resolved serving identity
  -- (provider/product/model/endpoint/protocol) under the attempt's route
  -- public model version.
  SELECT EXISTS (
    SELECT 1
      FROM saas_supplier_cost_versions cost
     WHERE cost.id = NEW.supplier_cost_version
       AND cost.public_model_id = NEW.route_public_model_id
       AND cost.public_model_version = NEW.route_public_model_version
       AND cost.provider_id = NEW.provider_id
       AND cost.product_id = NEW.product_id
       AND cost.resolved_model = NEW.resolved_model
       AND cost.endpoint = NEW.endpoint
       AND cost.protocol = NEW.protocol
  )
    INTO resolved_cost_exact;

  IF NOT FOUND
    OR authority_record.customer_status IS DISTINCT FROM 'active'
    OR authority_record.customer_head_status IS DISTINCT FROM 'active'
    OR authority_record.provider_status IS DISTINCT FROM 'active'
    OR authority_record.provider_head_status IS DISTINCT FROM 'active'
    OR authority_record.verification_result IS DISTINCT FROM 'verified'
    OR request_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR authority_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR (request_record.supply_mode = 'platform'
      AND NEW.supplier_cost_version IS NULL)
    OR (request_record.supply_mode = 'platform'
      AND authority_record.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
      AND resolved_cost_exact IS DISTINCT FROM TRUE)
    OR (request_record.supply_mode = 'byok' AND NEW.supplier_cost_version IS NOT NULL)
  THEN
    RAISE EXCEPTION 'SaaS attempt commercial authority snapshot is not exact'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.supplier_cost_version IS NOT NULL THEN
    SELECT effective_at, expires_at
      INTO cost_effective_at, cost_expires_at
      FROM saas_supplier_cost_versions
     WHERE id = NEW.supplier_cost_version
     ;
  END IF;
  locked_at := clock_timestamp();
  IF NEW.supplier_cost_version IS NOT NULL
    AND (cost_effective_at IS NULL OR cost_effective_at > locked_at
      OR (cost_expires_at IS NOT NULL AND cost_expires_at <= locked_at)
    )
  THEN
    RAISE EXCEPTION 'Supplier cost version is not effective at attempt binding'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION saas_attempts_guard_route_snapshot()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  route_record record;
  composite_capability_verified boolean;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (OLD.route_config_id IS DISTINCT FROM NEW.route_config_id
      OR OLD.route_config_version IS DISTINCT FROM NEW.route_config_version
      OR OLD.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
      OR OLD.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
      OR OLD.route_protocol IS DISTINCT FROM NEW.route_protocol
      OR OLD.route_target_mode IS DISTINCT FROM NEW.route_target_mode)
  THEN
    IF OLD.route_config_id IS NULL AND NEW.route_config_id IS NOT NULL THEN
      RAISE EXCEPTION 'Historical SaaS attempts cannot be assigned a route authority snapshot'
        USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'SaaS attempt route authority snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.route_config_id IS NULL
    OR NEW.route_config_version IS NULL
    OR NEW.route_public_model_id IS NULL
    OR NEW.route_public_model_version IS NULL
    OR NEW.route_protocol IS NULL
    OR NEW.route_target_mode IS NULL
  THEN
    RAISE EXCEPTION 'New SaaS attempts require an exact route authority snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT r.project_id,
         r.route_config_id,
         r.route_config_version,
         r.route_public_model_id,
         r.route_public_model_version,
         r.route_protocol,
         r.route_target_mode,
         r.route_upstream_id,
         r.public_model,
         r.protocol AS request_protocol,
         r.endpoint
    INTO request_record
    FROM saas_requests r
   WHERE r.tenant_id = NEW.tenant_id
     AND r.id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt route authority request is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT rv.status AS route_status,
         rv.public_model_id,
         rv.public_model_version,
         rv.protocol,
         rv.target_mode,
         rv.upstream_id,
         rv.endpoint,
         h.current_version,
         h.status AS head_status,
         pmv.model
    INTO route_record
    FROM saas_route_config_versions rv
    JOIN saas_route_config_heads h
      ON h.tenant_id = rv.tenant_id
     AND h.project_id = rv.project_id
     AND h.route_id = rv.route_id
    JOIN saas_public_model_versions pmv
      ON pmv.public_model_id = rv.public_model_id
     AND pmv.version = rv.public_model_version
   WHERE rv.tenant_id = NEW.tenant_id
     AND rv.project_id = request_record.project_id
     AND rv.route_id = NEW.route_config_id
     AND rv.version = NEW.route_config_version;

  -- R3 §8.1: a composite attempt serves on the resolved target platform's
  -- model and endpoint, which deliberately differ from the route's nominal
  -- pins. The relaxed fence keeps every route/request equality and accepts
  -- the differing serving model/endpoint only when the attempt's full
  -- identity is a VERIFIED provider capability.
  SELECT EXISTS (
    SELECT 1
      FROM saas_provider_capabilities cap
     WHERE cap.provider_id = NEW.provider_id
       AND cap.product_id = NEW.product_id
       AND cap.model = NEW.resolved_model
       AND cap.endpoint = NEW.endpoint
       AND cap.protocol = NEW.protocol
       AND cap.support_level IN ('supported', 'limited')
       AND cap.validation_state = 'verified'
  )
    INTO composite_capability_verified;

  IF NOT FOUND
    OR route_record.route_status IS DISTINCT FROM 'active'
    OR route_record.head_status IS DISTINCT FROM 'active'
    OR route_record.current_version IS DISTINCT FROM NEW.route_config_version
    OR route_record.public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR route_record.public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR route_record.protocol IS DISTINCT FROM NEW.route_protocol
    OR route_record.target_mode IS DISTINCT FROM NEW.route_target_mode
    OR route_record.upstream_id IS DISTINCT FROM NEW.upstream_id
    OR route_record.protocol IS DISTINCT FROM NEW.protocol
    OR (route_record.endpoint IS DISTINCT FROM NEW.endpoint
      AND composite_capability_verified IS DISTINCT FROM TRUE)
    OR (route_record.model IS DISTINCT FROM NEW.resolved_model
      AND composite_capability_verified IS DISTINCT FROM TRUE)
    OR request_record.route_config_id IS DISTINCT FROM NEW.route_config_id
    OR request_record.route_config_version IS DISTINCT FROM NEW.route_config_version
    OR request_record.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR request_record.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR request_record.route_protocol IS DISTINCT FROM NEW.route_protocol
    OR request_record.route_target_mode IS DISTINCT FROM NEW.route_target_mode
    OR request_record.route_upstream_id IS DISTINCT FROM NEW.upstream_id
    OR request_record.request_protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
  THEN
    RAISE EXCEPTION 'SaaS attempt route authority snapshot does not match its request and active route'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION saas_pricing_guard_customer_snapshot()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  price_record record;
  request_record record;
  route_endpoint text;
BEGIN
  SELECT supply_mode, protocol, endpoint, route_config_id, route_config_version
    INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer price snapshot request was not found'
      USING ERRCODE = '23514';
  END IF;
  IF request_record.supply_mode IS DISTINCT FROM 'platform' THEN
    RAISE EXCEPTION 'Customer price snapshots require a platform-supplied request'
      USING ERRCODE = '23514';
  END IF;

  -- R3 §8.1: on composite dispatches the request row carries the resolved
  -- target's serving endpoint while the customer price snapshot stays bound
  -- to the route's nominal endpoint (the customer sale identity never
  -- drifts). The snapshot endpoint must therefore match the request's
  -- serving endpoint or the request's own route-config endpoint.
  SELECT rv.endpoint INTO route_endpoint
    FROM saas_route_config_versions rv
   WHERE rv.tenant_id = NEW.tenant_id
     AND rv.route_id = request_record.route_config_id
     AND rv.version = request_record.route_config_version;

  IF request_record.protocol IS DISTINCT FROM NEW.protocol
    OR (request_record.endpoint IS DISTINCT FROM NEW.endpoint
      AND route_endpoint IS DISTINCT FROM NEW.endpoint)
  THEN
    RAISE EXCEPTION 'Customer price snapshot protocol or endpoint does not match its request'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO price_record
    FROM saas_customer_price_versions
   WHERE id = NEW.customer_price_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer price snapshot does not match its immutable price version'
      USING ERRCODE = '23514';
  END IF;
  IF price_record.public_model_id IS DISTINCT FROM NEW.public_model_id
    OR price_record.public_model_version IS DISTINCT FROM NEW.public_model_version
    OR price_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR price_record.product_id IS DISTINCT FROM NEW.product_id
    OR price_record.protocol IS DISTINCT FROM NEW.protocol
    OR price_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR price_record.currency IS DISTINCT FROM NEW.currency
    OR price_record.commercial_policy_version IS DISTINCT FROM NEW.commercial_policy_version
    OR price_record.calculator_version IS DISTINCT FROM NEW.calculator_version
    OR price_record.rounding_version IS DISTINCT FROM NEW.rounding_version
    OR price_record.rounding_mode IS DISTINCT FROM NEW.rounding_mode
    OR price_record.rounding_boundary IS DISTINCT FROM NEW.rounding_boundary
  THEN
    RAISE EXCEPTION 'Customer price snapshot does not match its immutable price version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
`;

export const RESOLVED_SUPPLY_BILLING_IDENTITY_SAAS_MIGRATION: SaasMigration = {
  version: 131,
  name: 'resolved_supply_billing_identity',
  sql: resolvedSupplyBillingIdentitySql,
};
