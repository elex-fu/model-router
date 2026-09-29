import type { SaasMigration } from './001_initial_schema.js';

const projectMembershipBackfillSql = `
INSERT INTO saas_project_memberships
  (tenant_id, project_id, user_id, role, status, revoked_at, created_at, updated_at)
SELECT membership.tenant_id,
       project.id,
       membership.user_id,
       membership.role,
       membership.status,
       membership.revoked_at,
       membership.created_at,
       membership.updated_at
FROM saas_memberships AS membership
JOIN saas_projects AS project
  ON project.tenant_id = membership.tenant_id
ON CONFLICT (tenant_id, project_id, user_id) DO NOTHING;
`;

export const PROJECT_MEMBERSHIP_BACKFILL_SAAS_MIGRATION: SaasMigration = {
  version: 3,
  name: 'project_membership_backfill',
  sql: projectMembershipBackfillSql,
};
