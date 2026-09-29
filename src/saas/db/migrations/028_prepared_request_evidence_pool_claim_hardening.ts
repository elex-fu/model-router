import type { SaasMigration } from './001_initial_schema.js';

/*
 * 027 closed the claim-side pool fence, but it still left three unsafe edges:
 * registration did not require a verified pool, pool lifecycle writes did not
 * own a monotonic epoch, and the attempt fence rechecked the pool for terminal
 * bookkeeping.  Keep this migration forward-only: replace the already
 * installed trigger functions and add guards; do not rewrite migrations 001-027.
 *
 * The authority comparison below keeps the existing attempt-trigger evidence
 * read.  The new immutability trigger is local-only, so 028 adds no new
 * attempt -> evidence lock edge.  The evidence-side pool fence remains the
 * same evidence -> pool lock order used by 026.
 */
const preparedRequestEvidencePoolClaimHardeningSql = `
CREATE OR REPLACE FUNCTION saas_prepared_request_evidence_platform_pool_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pool_record record;
BEGIN
  IF NEW.account_owner_kind IS DISTINCT FROM 'platform' THEN
    RETURN NEW;
  END IF;

  SELECT provider_id, product_id, status, validation_state, authz_version
    INTO pool_record
    FROM saas_platform_provider_pools
   WHERE id = NEW.pool_id
   FOR SHARE;

  IF NOT FOUND
    OR pool_record.status IS DISTINCT FROM 'active'
    OR pool_record.validation_state IS DISTINCT FROM 'verified'
    OR pool_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR pool_record.product_id IS DISTINCT FROM NEW.product_id
    OR pool_record.authz_version IS DISTINCT FROM NEW.pool_authz_version
  THEN
    RAISE EXCEPTION 'Prepared-request evidence platform pool is missing, inactive, unverified, or stale'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

/*
 * A pool epoch is owned by the pool row.  Lifecycle and validation changes
 * consume exactly one epoch, and an epoch cannot be advanced independently by
 * more than one step or rolled back.  Member/grant epochs remain independent
 * relationship facts; this trigger deliberately does not update those rows.
 */
CREATE FUNCTION saas_platform_provider_pool_authz_epoch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'revoked'
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.validation_state IS DISTINCT FROM OLD.validation_state
      OR NEW.authz_version IS DISTINCT FROM OLD.authz_version
    )
  THEN
    RAISE EXCEPTION 'Revoked provider pools are terminal and cannot reuse authority'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.authz_version IS DISTINCT FROM OLD.authz_version
    AND NEW.authz_version IS DISTINCT FROM OLD.authz_version + 1
  THEN
    RAISE EXCEPTION 'Provider pool authz_version must advance exactly one step'
      USING ERRCODE = '23514';
  END IF;

  IF (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.validation_state IS DISTINCT FROM OLD.validation_state
    )
    AND NEW.authz_version IS DISTINCT FROM OLD.authz_version + 1
  THEN
    RAISE EXCEPTION 'Provider pool lifecycle or validation changes require one epoch advance'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_platform_provider_pools_authz_epoch_guard
  BEFORE UPDATE OF status, validation_state, authz_version ON saas_platform_provider_pools
  FOR EACH ROW EXECUTE FUNCTION saas_platform_provider_pool_authz_epoch_guard();

/*
 * Bind and new dispatch must use the complete signed authority snapshot.  A
 * terminal update after dispatch has started intentionally does not read the
 * pool: revocation must not prevent sent/unknown bookkeeping.
 */
CREATE OR REPLACE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  evidence_record record;
  pool_record record;
  should_fence boolean := false;
BEGIN
  IF NEW.account_owner_kind IS DISTINCT FROM 'platform'
    OR NEW.dispatch_authority_state IS DISTINCT FROM 'bound'
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    should_fence := true;
  ELSIF OLD.prepared_evidence_id IS DISTINCT FROM NEW.prepared_evidence_id
    AND NEW.prepared_evidence_id IS NOT NULL
  THEN
    should_fence := true;
  ELSIF OLD.dispatch_state = 'not_sent'
    AND NEW.dispatch_state = 'dispatching'
  THEN
    should_fence := true;
  END IF;

  IF NOT should_fence THEN
    RETURN NEW;
  END IF;

  IF NEW.prepared_evidence_id IS NOT NULL THEN
    SELECT e.request_id, e.attempt_id, e.attempt_ordinal,
           e.account_owner_kind, e.account_id, e.upstream_id, e.provider_id, e.product_id,
           e.resolved_model, e.protocol, e.endpoint, e.dispatch_profile_id,
           e.supply_profile_authz_version, e.credential_id, e.credential_version,
           e.credential_authz_version, e.account_authz_version, e.profile_account_authz_version,
           e.pool_id, e.pool_authz_version, e.pool_member_account_authz_version,
           e.pool_member_authz_version, e.pool_grant_authz_version,
           e.pool_grant_profile_authz_version, e.pool_grant_pool_authz_version,
           e.route_config_id, e.route_config_version, e.route_public_model_id,
           e.route_public_model_version, e.route_protocol, e.route_target_mode,
           e.project_policy_version, e.customer_metering_policy_id,
           e.customer_metering_policy_version, e.provider_metering_policy_id,
           e.provider_metering_policy_version, e.contract_attestation_id,
           e.customer_price_version, e.supplier_cost_version
      INTO evidence_record
      FROM saas_prepared_request_evidence AS e
     WHERE e.tenant_id = NEW.tenant_id
       AND e.id = NEW.prepared_evidence_id
     FOR SHARE;

    IF NOT FOUND
      OR evidence_record.request_id IS DISTINCT FROM NEW.request_id
      OR evidence_record.attempt_id IS DISTINCT FROM NEW.id
      OR evidence_record.attempt_ordinal IS DISTINCT FROM NEW.ordinal
      OR evidence_record.account_owner_kind IS DISTINCT FROM NEW.account_owner_kind
      OR evidence_record.account_id IS DISTINCT FROM NEW.account_id
      OR evidence_record.upstream_id IS DISTINCT FROM NEW.upstream_id
      OR evidence_record.provider_id IS DISTINCT FROM NEW.provider_id
      OR evidence_record.product_id IS DISTINCT FROM NEW.product_id
      OR evidence_record.resolved_model IS DISTINCT FROM NEW.resolved_model
      OR evidence_record.protocol IS DISTINCT FROM NEW.protocol
      OR evidence_record.endpoint IS DISTINCT FROM NEW.endpoint
      OR evidence_record.dispatch_profile_id IS DISTINCT FROM NEW.dispatch_profile_id
      OR evidence_record.supply_profile_authz_version IS DISTINCT FROM NEW.supply_profile_authz_version
      OR evidence_record.credential_id IS DISTINCT FROM NEW.credential_id
      OR evidence_record.credential_version IS DISTINCT FROM NEW.credential_version
      OR evidence_record.credential_authz_version IS DISTINCT FROM NEW.credential_authz_version
      OR evidence_record.account_authz_version IS DISTINCT FROM NEW.account_authz_version
      OR evidence_record.profile_account_authz_version IS DISTINCT FROM NEW.profile_account_authz_version
      OR evidence_record.pool_id IS DISTINCT FROM NEW.pool_id
      OR evidence_record.pool_authz_version IS DISTINCT FROM NEW.pool_authz_version
      OR evidence_record.pool_member_account_authz_version IS DISTINCT FROM NEW.pool_member_account_authz_version
      OR evidence_record.pool_member_authz_version IS DISTINCT FROM NEW.pool_member_authz_version
      OR evidence_record.pool_grant_authz_version IS DISTINCT FROM NEW.pool_grant_authz_version
      OR evidence_record.pool_grant_profile_authz_version IS DISTINCT FROM NEW.pool_grant_profile_authz_version
      OR evidence_record.pool_grant_pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version
      OR evidence_record.route_config_id IS DISTINCT FROM NEW.route_config_id
      OR evidence_record.route_config_version IS DISTINCT FROM NEW.route_config_version
      OR evidence_record.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
      OR evidence_record.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
      OR evidence_record.route_protocol IS DISTINCT FROM NEW.route_protocol
      OR evidence_record.route_target_mode IS DISTINCT FROM NEW.route_target_mode
      OR evidence_record.project_policy_version IS DISTINCT FROM NEW.project_policy_version
      OR evidence_record.customer_metering_policy_id IS DISTINCT FROM NEW.customer_metering_policy_id
      OR evidence_record.customer_metering_policy_version IS DISTINCT FROM NEW.customer_metering_policy_version
      OR evidence_record.provider_metering_policy_id IS DISTINCT FROM NEW.provider_metering_policy_id
      OR evidence_record.provider_metering_policy_version IS DISTINCT FROM NEW.provider_metering_policy_version
      OR evidence_record.contract_attestation_id IS DISTINCT FROM NEW.contract_attestation_id
      OR evidence_record.customer_price_version IS DISTINCT FROM NEW.customer_price_version
      OR evidence_record.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
    THEN
      RAISE EXCEPTION 'SaaS attempt prepared-evidence authority snapshot is incomplete or mismatched'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT provider_id, product_id, status, validation_state, authz_version
    INTO pool_record
    FROM saas_platform_provider_pools
   WHERE id = NEW.pool_id
   FOR SHARE;

  IF NOT FOUND
    OR pool_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR pool_record.product_id IS DISTINCT FROM NEW.product_id
    OR pool_record.status IS DISTINCT FROM 'active'
    OR pool_record.validation_state IS DISTINCT FROM 'verified'
    OR pool_record.authz_version IS DISTINCT FROM NEW.pool_authz_version
  THEN
    RAISE EXCEPTION 'SaaS attempt prepared-evidence claim platform pool is missing, inactive, unverified, or stale'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

/* Once evidence is bound, its authority columns cannot be edited independently. */
CREATE FUNCTION saas_attempts_guard_prepared_evidence_authority_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.prepared_evidence_id IS NOT NULL
    AND (
      OLD.request_id IS DISTINCT FROM NEW.request_id
      OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
      OR OLD.upstream_id IS DISTINCT FROM NEW.upstream_id
      OR OLD.resolved_model IS DISTINCT FROM NEW.resolved_model
      OR OLD.protocol IS DISTINCT FROM NEW.protocol
      OR OLD.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
      OR OLD.binding_state IS DISTINCT FROM NEW.binding_state
      OR OLD.account_owner_kind IS DISTINCT FROM NEW.account_owner_kind
      OR OLD.tenant_account_id IS DISTINCT FROM NEW.tenant_account_id
      OR OLD.platform_account_id IS DISTINCT FROM NEW.platform_account_id
      OR OLD.provider_id IS DISTINCT FROM NEW.provider_id
      OR OLD.product_id IS DISTINCT FROM NEW.product_id
      OR OLD.endpoint IS DISTINCT FROM NEW.endpoint
      OR OLD.dispatch_authority_state IS DISTINCT FROM NEW.dispatch_authority_state
      OR OLD.dispatch_profile_id IS DISTINCT FROM NEW.dispatch_profile_id
      OR OLD.supply_profile_authz_version IS DISTINCT FROM NEW.supply_profile_authz_version
      OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
      OR OLD.credential_version IS DISTINCT FROM NEW.credential_version
      OR OLD.credential_authz_version IS DISTINCT FROM NEW.credential_authz_version
      OR OLD.account_authz_version IS DISTINCT FROM NEW.account_authz_version
      OR OLD.pool_id IS DISTINCT FROM NEW.pool_id
      OR OLD.pool_authz_version IS DISTINCT FROM NEW.pool_authz_version
      OR OLD.pool_member_account_authz_version IS DISTINCT FROM NEW.pool_member_account_authz_version
      OR OLD.pool_member_authz_version IS DISTINCT FROM NEW.pool_member_authz_version
      OR OLD.pool_grant_authz_version IS DISTINCT FROM NEW.pool_grant_authz_version
      OR OLD.pool_grant_profile_authz_version IS DISTINCT FROM NEW.pool_grant_profile_authz_version
      OR OLD.pool_grant_pool_authz_version IS DISTINCT FROM NEW.pool_grant_pool_authz_version
      OR OLD.profile_account_authz_version IS DISTINCT FROM NEW.profile_account_authz_version
      OR OLD.project_policy_version IS DISTINCT FROM NEW.project_policy_version
      OR OLD.route_config_id IS DISTINCT FROM NEW.route_config_id
      OR OLD.route_config_version IS DISTINCT FROM NEW.route_config_version
      OR OLD.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
      OR OLD.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
      OR OLD.route_protocol IS DISTINCT FROM NEW.route_protocol
      OR OLD.route_target_mode IS DISTINCT FROM NEW.route_target_mode
      OR OLD.customer_price_version IS DISTINCT FROM NEW.customer_price_version
      OR OLD.customer_metering_policy_id IS DISTINCT FROM NEW.customer_metering_policy_id
      OR OLD.customer_metering_policy_version IS DISTINCT FROM NEW.customer_metering_policy_version
      OR OLD.provider_metering_policy_id IS DISTINCT FROM NEW.provider_metering_policy_id
      OR OLD.provider_metering_policy_version IS DISTINCT FROM NEW.provider_metering_policy_version
      OR OLD.contract_attestation_id IS DISTINCT FROM NEW.contract_attestation_id
    )
  THEN
    RAISE EXCEPTION 'SaaS attempt authority is immutable after prepared evidence binding'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_prepared_evidence_authority_immutable
  BEFORE UPDATE OF request_id, ordinal, upstream_id, resolved_model, protocol, supplier_cost_version,
    binding_state, account_owner_kind, tenant_account_id, platform_account_id, provider_id, product_id,
    endpoint, dispatch_authority_state, dispatch_profile_id, supply_profile_authz_version, credential_id,
    credential_version, credential_authz_version, account_authz_version, pool_id, pool_authz_version,
    pool_member_account_authz_version, pool_member_authz_version, pool_grant_authz_version,
    pool_grant_profile_authz_version, pool_grant_pool_authz_version, profile_account_authz_version,
    project_policy_version, route_config_id, route_config_version, route_public_model_id,
    route_public_model_version, route_protocol, route_target_mode, customer_price_version,
    customer_metering_policy_id, customer_metering_policy_version, provider_metering_policy_id,
    provider_metering_policy_version, contract_attestation_id ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_prepared_evidence_authority_immutable();

/*
 * Keep evidence identity checks for bind/new-dispatch, but do not re-check
 * evidence expiry during dispatching -> sent/unknown terminal bookkeeping.
 */
CREATE OR REPLACE FUNCTION saas_attempts_guard_prepared_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  evidence_record record;
  locked_at timestamptz;
  is_new_dispatch boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.dispatch_state <> 'not_sent' THEN
      IF OLD.prepared_evidence_id IS DISTINCT FROM NEW.prepared_evidence_id
        OR NEW.prepared_evidence_id IS NULL
      THEN
        RAISE EXCEPTION 'Prepared-request evidence reference is immutable once dispatch starts'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;

    is_new_dispatch := NEW.dispatch_state = 'dispatching';
  ELSIF TG_OP = 'INSERT' THEN
    is_new_dispatch := NEW.dispatch_state = 'dispatching';
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
    IF is_new_dispatch THEN
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
`;

export const PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION: SaasMigration = {
  version: 28,
  name: 'prepared_request_evidence_pool_claim_hardening',
  sql: preparedRequestEvidencePoolClaimHardeningSql,
};
