import type { SaasMigration } from './001_initial_schema.js';

const apiKeyExecutionPrincipalSchemaSql = `
/*
 * Keep v4-v11 keys member-bound.  The old principal_user_id is the only
 * historical execution identity available here; a migration must never
 * invent a project-service principal for an existing key.
 */
ALTER TABLE saas_api_keys
  ADD COLUMN execution_principal_type text,
  ADD COLUMN execution_principal_id uuid,
  ADD COLUMN created_by_user_id uuid,
  ADD COLUMN rotated_by_user_id uuid,
  ADD COLUMN revoked_by_user_id uuid,
  ADD COLUMN model_scope_version bigint NOT NULL DEFAULT 1,
  ADD COLUMN entitlement_authz_version bigint,
  ADD COLUMN supply_profile_authz_version bigint;

UPDATE saas_api_keys
SET execution_principal_type = 'member',
    execution_principal_id = principal_user_id,
    created_by_user_id = principal_user_id
WHERE execution_principal_type IS NULL
  AND execution_principal_id IS NULL
  AND created_by_user_id IS NULL;

/* Populate versions only from the exact server-owned binding already stored on a key. */
UPDATE saas_api_keys AS api_key
SET entitlement_authz_version = entitlement.authz_version,
    supply_profile_authz_version = profile.authz_version,
    model_scope_version = GREATEST(entitlement.authz_version, profile.authz_version)
FROM saas_project_entitlements AS entitlement
JOIN saas_supply_profiles AS profile
  ON profile.tenant_id = entitlement.tenant_id
 AND profile.id = entitlement.supply_profile_id
 AND profile.supply_mode = entitlement.supply_mode
WHERE api_key.entitlement_id = entitlement.id
  AND api_key.tenant_id = entitlement.tenant_id
  AND api_key.project_id = entitlement.project_id
  AND api_key.supply_profile_id = entitlement.supply_profile_id
  AND api_key.supply_mode = entitlement.supply_mode
  AND api_key.entitlement_authz_version IS NULL
  AND api_key.supply_profile_authz_version IS NULL;

ALTER TABLE saas_api_keys
  ALTER COLUMN principal_user_id DROP NOT NULL,
  ALTER COLUMN execution_principal_type SET NOT NULL,
  ALTER COLUMN execution_principal_id SET NOT NULL,
  ALTER COLUMN created_by_user_id SET NOT NULL;

ALTER TABLE saas_api_keys
  ADD CONSTRAINT saas_api_keys_execution_principal_type_check
    CHECK (execution_principal_type IN ('member', 'project_service')),
  ADD CONSTRAINT saas_api_keys_execution_principal_shape_check
    CHECK (
      (execution_principal_type = 'member'
        AND principal_user_id IS NOT NULL
        AND execution_principal_id = principal_user_id)
      OR
      (execution_principal_type = 'project_service'
        AND principal_user_id IS NULL
        AND execution_principal_id = project_id)
    ),
  ADD CONSTRAINT saas_api_keys_model_scope_version_check
    CHECK (model_scope_version >= 1),
  ADD CONSTRAINT saas_api_keys_entitlement_authz_version_check
    CHECK (entitlement_authz_version IS NULL OR entitlement_authz_version >= 1),
  ADD CONSTRAINT saas_api_keys_supply_profile_authz_version_check
    CHECK (supply_profile_authz_version IS NULL OR supply_profile_authz_version >= 1),
  ADD CONSTRAINT saas_api_keys_created_by_user_fk
    FOREIGN KEY (created_by_user_id)
    REFERENCES saas_users (id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_api_keys_created_by_tenant_member_fk
    FOREIGN KEY (tenant_id, created_by_user_id)
    REFERENCES saas_memberships (tenant_id, user_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_api_keys_rotated_by_user_fk
    FOREIGN KEY (rotated_by_user_id)
    REFERENCES saas_users (id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_api_keys_revoked_by_user_fk
    FOREIGN KEY (revoked_by_user_id)
    REFERENCES saas_users (id)
    ON DELETE RESTRICT;

CREATE INDEX saas_api_keys_execution_principal_idx
  ON saas_api_keys (tenant_id, project_id, execution_principal_type, execution_principal_id);

/*
 * The project-member FK is nullable for project-service keys.  This trigger
 * supplies the conditional part the FK cannot express: a member-bound key
 * must point at a currently active project membership when it is created or
 * its execution binding is changed.
 */
CREATE FUNCTION saas_validate_api_key_execution_principal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_principal_type = 'member' THEN
    IF NEW.principal_user_id IS NULL
      OR NEW.execution_principal_id IS DISTINCT FROM NEW.principal_user_id
    THEN
      RAISE EXCEPTION 'Member-bound SaaS API keys require their member as execution principal'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM saas_project_memberships AS membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.project_id = NEW.project_id
        AND membership.user_id = NEW.principal_user_id
        AND membership.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Member-bound SaaS API keys require an active project membership'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.execution_principal_type = 'project_service' THEN
    IF NEW.principal_user_id IS NOT NULL
      OR NEW.execution_principal_id IS DISTINCT FROM NEW.project_id
    THEN
      RAISE EXCEPTION 'Project-service SaaS API keys require the authorized project as execution principal'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.entitlement_id IS NOT NULL
    AND (NEW.model_scope_version IS NULL
      OR NEW.entitlement_authz_version IS NULL
      OR NEW.supply_profile_authz_version IS NULL)
  THEN
    RAISE EXCEPTION 'Bound SaaS API keys require authorization version snapshots'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_api_keys_validate_execution_principal
  BEFORE INSERT OR UPDATE OF principal_user_id, execution_principal_type,
    execution_principal_id, entitlement_id, model_scope_version,
    entitlement_authz_version, supply_profile_authz_version ON saas_api_keys
  FOR EACH ROW EXECUTE FUNCTION saas_validate_api_key_execution_principal();
`;

export const API_KEY_EXECUTION_PRINCIPALS_SAAS_MIGRATION: SaasMigration = {
  version: 12,
  name: 'api_key_execution_principals_and_authz_snapshots',
  sql: apiKeyExecutionPrincipalSchemaSql,
};
