import type { SaasMigration } from './001_initial_schema.js';

const projectEntitlementValiditySchemaSql = `
ALTER TABLE saas_project_entitlements
  ADD COLUMN effective_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN expires_at timestamptz,
  ADD CONSTRAINT saas_project_entitlements_validity_window CHECK (
    expires_at IS NULL OR expires_at > effective_at
  );

CREATE INDEX saas_project_entitlements_effective_idx
  ON saas_project_entitlements
    (tenant_id, project_id, supply_mode, effective_at, expires_at)
  WHERE status = 'active';
`;

export const PROJECT_ENTITLEMENT_VALIDITY_SAAS_MIGRATION: SaasMigration = {
  version: 9,
  name: 'project_entitlement_validity_window',
  sql: projectEntitlementValiditySchemaSql,
};
