import type { SaasMigration } from './001_initial_schema.js';

const apiKeyEntitlementBindingSchemaSql = `
/*
 * The entitlement id is the binding authority for new keys.  Keep the full
 * tuple in the referenced key so a key cannot mix a project, entitlement,
 * profile, or mode from different rows.
 */
ALTER TABLE saas_project_entitlements
  ADD CONSTRAINT saas_project_entitlements_key_binding_unique
  UNIQUE (tenant_id, project_id, id, supply_profile_id, supply_mode);

ALTER TABLE saas_api_keys
  ADD COLUMN entitlement_id uuid;

/*
 * v4/v5 historical keys have no entitlement mapping.  NOT VALID preserves
 * those rows while PostgreSQL still checks every new INSERT or UPDATE whose
 * composite key is non-null.
 */
ALTER TABLE saas_api_keys
  ADD CONSTRAINT saas_api_keys_entitlement_binding_fk
  FOREIGN KEY (tenant_id, project_id, entitlement_id, supply_profile_id, supply_mode)
  REFERENCES saas_project_entitlements
    (tenant_id, project_id, id, supply_profile_id, supply_mode)
  ON DELETE RESTRICT
  NOT VALID;

CREATE FUNCTION saas_reject_null_api_key_entitlement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.entitlement_id IS NULL THEN
      RAISE EXCEPTION 'New SaaS API keys require a project entitlement'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.entitlement_id IS DISTINCT FROM OLD.entitlement_id
    AND NEW.entitlement_id IS NULL THEN
    RAISE EXCEPTION 'SaaS API key entitlement cannot be cleared'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

/*
 * Column-specific UPDATE triggering is intentional: revoking or versioning a
 * legacy NULL-entitlement key must remain possible without inventing a grant.
 */
CREATE TRIGGER saas_api_keys_require_entitlement_binding
  BEFORE INSERT OR UPDATE OF entitlement_id ON saas_api_keys
  FOR EACH ROW EXECUTE FUNCTION saas_reject_null_api_key_entitlement();
`;

export const API_KEY_ENTITLEMENT_BINDING_SAAS_MIGRATION: SaasMigration = {
  version: 6,
  name: 'api_key_project_entitlement_binding',
  sql: apiKeyEntitlementBindingSchemaSql,
};
