import type { SaasMigration } from './001_initial_schema.js';

/*
 * Migration 026 fences the evidence row itself on registration and claim.
 * The claim transaction first binds the evidence id to the attempt, though,
 * and a direct database writer can reach that UPDATE without the service
 * revalidation.  Keep this fence on the attempt side as well: lock the
 * current pool row with the same FOR SHARE semantics used by the existing
 * authority checks, then compare it with both the attempt and evidence
 * snapshots.
 *
 * The evidence row is locked before the pool row, matching the existing
 * prepared-evidence attempt guard.  This keeps the new cross-table checks in
 * the established evidence-then-pool order.
 */
const preparedRequestEvidenceClaimPoolFenceSql = `
CREATE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  evidence_record record;
  pool_record record;
BEGIN
  IF NEW.account_owner_kind IS DISTINCT FROM 'platform'
    OR NEW.dispatch_authority_state IS DISTINCT FROM 'bound'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.prepared_evidence_id IS NOT NULL THEN
    SELECT provider_id, product_id, pool_id, pool_authz_version
      INTO evidence_record
      FROM saas_prepared_request_evidence
     WHERE tenant_id = NEW.tenant_id AND id = NEW.prepared_evidence_id
     FOR SHARE;

    IF NOT FOUND
      OR evidence_record.provider_id IS DISTINCT FROM NEW.provider_id
      OR evidence_record.product_id IS DISTINCT FROM NEW.product_id
      OR evidence_record.pool_id IS DISTINCT FROM NEW.pool_id
      OR evidence_record.pool_authz_version IS DISTINCT FROM NEW.pool_authz_version
    THEN
      RAISE EXCEPTION 'SaaS attempt prepared-evidence authority snapshot is stale or mismatched'
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
    RAISE EXCEPTION 'SaaS attempt prepared-evidence claim platform pool is missing, inactive, or stale'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_prepared_evidence_claim_pool
  BEFORE INSERT OR UPDATE OF prepared_evidence_id, dispatch_state, dispatch_authority_state,
    provider_id, product_id, pool_id, pool_authz_version ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_prepared_evidence_claim_pool();
`;

export const PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION: SaasMigration = {
  version: 27,
  name: 'prepared_request_evidence_claim_pool_fence',
  sql: preparedRequestEvidenceClaimPoolFenceSql,
};
