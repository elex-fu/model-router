import type { SaasMigration } from './001_initial_schema.js';

const projectAuthorizationSchemaSql = `
ALTER TABLE saas_projects
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

WITH first_projects AS (
  SELECT tenant_id,
         id,
         row_number() OVER (
           PARTITION BY tenant_id
           ORDER BY created_at ASC, id ASC
         ) AS project_rank
  FROM saas_projects
)
UPDATE saas_projects AS project
SET is_default = TRUE
FROM first_projects
WHERE project.tenant_id = first_projects.tenant_id
  AND project.id = first_projects.id
  AND first_projects.project_rank = 1;

CREATE UNIQUE INDEX saas_projects_one_default_per_tenant_idx
  ON saas_projects (tenant_id)
  WHERE is_default;

CREATE FUNCTION saas_assign_default_project() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM saas_projects
    WHERE tenant_id = NEW.tenant_id AND is_default
  ) THEN
    NEW.is_default := TRUE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_projects_assign_default
  BEFORE INSERT ON saas_projects
  FOR EACH ROW EXECUTE FUNCTION saas_assign_default_project();

ALTER TABLE saas_projects
  DROP CONSTRAINT IF EXISTS saas_projects_tenant_id_fkey;
ALTER TABLE saas_projects
  ADD CONSTRAINT saas_projects_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES saas_tenants (id)
  ON DELETE RESTRICT;

ALTER TABLE saas_invitations
  DROP CONSTRAINT IF EXISTS saas_invitations_tenant_id_fkey;
ALTER TABLE saas_invitations
  ADD CONSTRAINT saas_invitations_tenant_id_fkey
  FOREIGN KEY (tenant_id)
  REFERENCES saas_tenants (id)
  ON DELETE RESTRICT;

CREATE TABLE saas_project_memberships (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL
    CHECK (role IN ('owner', 'admin', 'developer', 'billing', 'viewer')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_project_memberships_revocation_status CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  ),
  PRIMARY KEY (tenant_id, project_id, user_id),
  CONSTRAINT saas_project_memberships_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_project_memberships_tenant_membership_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES saas_memberships (tenant_id, user_id)
    ON DELETE RESTRICT
);
CREATE INDEX saas_project_memberships_user_status_idx
  ON saas_project_memberships (tenant_id, user_id, status);
CREATE INDEX saas_project_memberships_project_status_idx
  ON saas_project_memberships (tenant_id, project_id, status);

CREATE FUNCTION saas_reject_project_membership_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS project memberships must be revoked instead of deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_project_memberships_no_delete
  BEFORE DELETE ON saas_project_memberships
  FOR EACH ROW EXECUTE FUNCTION saas_reject_project_membership_delete();

CREATE FUNCTION saas_reject_tenant_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS tenants must be closed instead of deleted'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_tenants_no_delete
  BEFORE DELETE ON saas_tenants
  FOR EACH ROW EXECUTE FUNCTION saas_reject_tenant_delete();
`;

export const PROJECT_AUTHORIZATION_SAAS_MIGRATION: SaasMigration = {
  version: 2,
  name: 'project_authorization_and_retention_constraints',
  sql: projectAuthorizationSchemaSql,
};
