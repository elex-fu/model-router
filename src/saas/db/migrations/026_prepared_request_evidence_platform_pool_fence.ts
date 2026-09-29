import type { SaasMigration } from './001_initial_schema.js';

const preparedRequestEvidencePlatformPoolFenceSql = `
CREATE FUNCTION saas_prepared_request_evidence_platform_pool_fence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pool_record record;
BEGIN
  IF NEW.account_owner_kind IS DISTINCT FROM 'platform' THEN
    RETURN NEW;
  END IF;

  SELECT provider_id, product_id, status, authz_version
    INTO pool_record
    FROM saas_platform_provider_pools
   WHERE id = NEW.pool_id
   FOR SHARE;

  IF NOT FOUND
    OR pool_record.status IS DISTINCT FROM 'active'
    OR pool_record.provider_id IS DISTINCT FROM NEW.provider_id
    OR pool_record.product_id IS DISTINCT FROM NEW.product_id
    OR pool_record.authz_version IS DISTINCT FROM NEW.pool_authz_version
  THEN
    RAISE EXCEPTION 'Prepared-request evidence platform pool is missing, inactive, or stale'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_prepared_request_evidence_platform_pool_fence
  BEFORE INSERT OR UPDATE ON saas_prepared_request_evidence
  FOR EACH ROW EXECUTE FUNCTION saas_prepared_request_evidence_platform_pool_fence();
`;

export const PREPARED_REQUEST_EVIDENCE_PLATFORM_POOL_FENCE_SAAS_MIGRATION: SaasMigration = {
  version: 26,
  name: 'prepared_request_evidence_platform_pool_fence',
  sql: preparedRequestEvidencePlatformPoolFenceSql,
};
