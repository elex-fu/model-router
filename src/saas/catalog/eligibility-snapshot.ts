/**
 * One fresh READ COMMITTED snapshot, executed only AFTER the product fence
 * statement has completed. Never put the waiting lock and these reads in the
 * same statement: its snapshot could otherwise predate a concurrent revoke.
 * Project explicit columns only; int8 versions retain pg's decimal strings.
 */
export const CATALOG_ELIGIBILITY_SNAPSHOT_SQL = `/* catalog-eligibility-snapshot */
SELECT
  (SELECT row_to_json(product_row) FROM (
    SELECT provider_id, product_id, display_name, status, created_at
      FROM saas_provider_products WHERE provider_id = $1 AND product_id = $2 LIMIT 1
  ) product_row) AS product,
  (SELECT row_to_json(capability_row) FROM (
    SELECT protocol, version::text, support_level, validation_state
      FROM saas_provider_capabilities AS capability_source
     WHERE provider_id = $1 AND product_id = $2 AND model = $3 AND endpoint = $4
     ORDER BY capability_source.version DESC LIMIT 1
  ) capability_row) AS capability,
  (SELECT coalesce(json_agg(rights_row ORDER BY rights_row.rights_id, rights_row.version::bigint DESC), '[]'::json)
     FROM (
       SELECT rights_id, version::text, provider_id, product_id,
              credential_type, supply_mode, region, purpose, model_scope, endpoint_scope,
              effective_at, expires_at, approval_ref, status, evidence_ref, evidence_sha256, created_at
         FROM saas_provider_rights WHERE provider_id = $1 AND product_id = $2
     ) rights_row) AS rights`;
