import type { SaasMigration } from './001_initial_schema.js';

const supplyProfilesAndEntitlementsSchemaSql = `
CREATE TABLE saas_supply_profiles (
  tenant_id uuid NOT NULL,
  id text NOT NULL,
  supply_mode text NOT NULL
    CHECK (supply_mode IN ('byok', 'platform')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  model_scopes text[] NOT NULL,
  authz_version bigint NOT NULL DEFAULT 1
    CHECK (authz_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_audited_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT saas_supply_profiles_id_nonempty CHECK (btrim(id) <> ''),
  CONSTRAINT saas_supply_profiles_model_scopes_nonempty CHECK (
    cardinality(model_scopes) > 0
    AND array_position(model_scopes, '') IS NULL
    AND array_position(model_scopes, NULL) IS NULL
  ),
  CONSTRAINT saas_supply_profiles_status_timestamp CHECK (
    (status = 'active' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
  ),
  CONSTRAINT saas_supply_profiles_tenant_fk
    FOREIGN KEY (tenant_id)
    REFERENCES saas_tenants (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_supply_profiles_identity_unique
    UNIQUE (tenant_id, id, supply_mode)
);

CREATE INDEX saas_supply_profiles_status_idx
  ON saas_supply_profiles (tenant_id, status, updated_at DESC);

CREATE TABLE saas_project_entitlements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  supply_profile_id text NOT NULL,
  supply_mode text NOT NULL
    CHECK (supply_mode IN ('byok', 'platform')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  model_scopes text[] NOT NULL,
  authz_version bigint NOT NULL DEFAULT 1
    CHECK (authz_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_audited_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT saas_project_entitlements_profile_id_nonempty
    CHECK (btrim(supply_profile_id) <> ''),
  CONSTRAINT saas_project_entitlements_model_scopes_nonempty CHECK (
    cardinality(model_scopes) > 0
    AND array_position(model_scopes, '') IS NULL
    AND array_position(model_scopes, NULL) IS NULL
  ),
  CONSTRAINT saas_project_entitlements_status_timestamp CHECK (
    (status = 'active' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
  ),
  CONSTRAINT saas_project_entitlements_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_project_entitlements_profile_fk
    FOREIGN KEY (tenant_id, supply_profile_id, supply_mode)
    REFERENCES saas_supply_profiles (tenant_id, id, supply_mode)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX saas_project_entitlements_one_active_per_project_mode_idx
  ON saas_project_entitlements (tenant_id, project_id, supply_mode)
  WHERE status = 'active';
CREATE INDEX saas_project_entitlements_lookup_idx
  ON saas_project_entitlements (tenant_id, project_id, status, updated_at DESC);
CREATE INDEX saas_project_entitlements_profile_idx
  ON saas_project_entitlements (tenant_id, supply_profile_id, status);

/*
 * MIGRATION COMPATIBILITY WARNING: migration 004 can contain API keys whose
 * supply profile has not been provisioned yet. Keep those historical keys
 * untouched: do not delete or rewrite them and do not auto-grant entitlements.
 * This FK intentionally remains NOT VALID until an operator has completed the
 * required profile mapping and audit; PostgreSQL still enforces it for every
 * new INSERT or UPDATE.
 */
ALTER TABLE saas_api_keys
  ADD CONSTRAINT saas_api_keys_supply_profile_fk
  FOREIGN KEY (tenant_id, supply_profile_id, supply_mode)
  REFERENCES saas_supply_profiles (tenant_id, id, supply_mode)
  ON DELETE RESTRICT
  NOT VALID;
`;

export const SUPPLY_PROFILES_AND_ENTITLEMENTS_SAAS_MIGRATION: SaasMigration = {
  version: 5,
  name: 'supply_profiles_and_project_entitlements',
  sql: supplyProfilesAndEntitlementsSchemaSql,
};
