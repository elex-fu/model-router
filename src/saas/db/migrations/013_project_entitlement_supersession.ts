import type { SaasMigration } from './001_initial_schema.js';

const projectEntitlementSupersessionSchemaSql = `
/*
 * A renewal must be able to become the one binding eligible for new Keys
 * while an older binding remains usable by Keys that already store it.  The
 * old binding is therefore explicit and existing-keys-only, rather than a
 * second active entitlement that would violate migration 005's uniqueness
 * rule.
 */
ALTER TABLE saas_project_entitlements
  ADD COLUMN superseded_at timestamptz;

ALTER TABLE saas_project_entitlements
  DROP CONSTRAINT IF EXISTS saas_project_entitlements_status_check,
  DROP CONSTRAINT IF EXISTS saas_project_entitlements_status_timestamp,
  ADD CONSTRAINT saas_project_entitlements_status_timestamp
    CHECK (
      (status = 'active' AND disabled_at IS NULL AND superseded_at IS NULL)
      OR
      (status = 'disabled' AND disabled_at IS NOT NULL AND superseded_at IS NULL)
      OR
      (status = 'superseded' AND disabled_at IS NULL AND superseded_at IS NOT NULL)
    ),
  ADD CONSTRAINT saas_project_entitlements_superseded_window
    CHECK (superseded_at IS NULL OR superseded_at >= effective_at);

/* Reassert the new-Key boundary explicitly: superseded rows are excluded. */
DROP INDEX IF EXISTS saas_project_entitlements_one_active_per_project_mode_idx;
CREATE UNIQUE INDEX saas_project_entitlements_one_active_per_project_mode_idx
  ON saas_project_entitlements (tenant_id, project_id, supply_mode)
  WHERE status = 'active';

CREATE INDEX saas_project_entitlements_superseded_lookup_idx
  ON saas_project_entitlements
    (tenant_id, project_id, supply_mode, superseded_at, expires_at)
  WHERE status = 'superseded';
`;

export const PROJECT_ENTITLEMENT_SUPERSESSION_SAAS_MIGRATION: SaasMigration = {
  version: 13,
  name: 'project_entitlement_existing_keys_only_supersession',
  sql: projectEntitlementSupersessionSchemaSql,
};
