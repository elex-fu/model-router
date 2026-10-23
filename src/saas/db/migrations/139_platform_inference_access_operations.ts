import type { SaasMigration } from './001_initial_schema.js';

export const PLATFORM_INFERENCE_ACCESS_OPERATIONS_SAAS_MIGRATION: SaasMigration = {
  version: 139,
  name: 'platform_inference_access_operations',
  sql: `
CREATE TABLE saas_platform_inference_access_operations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL,
  profile_id text NOT NULL,
  entitlement_id uuid NOT NULL REFERENCES saas_project_entitlements(id),
  actor_user_id uuid NOT NULL REFERENCES saas_users(id),
  phase text NOT NULL CHECK (phase IN ('assembling','recheck','completed','failed','disabled')),
  receipts jsonb NOT NULL DEFAULT '{}',
  last_error_code text,
  runner_id uuid,
  runner_until timestamptz,
  CHECK ((runner_id IS NULL) = (runner_until IS NULL)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, operation_key),
  UNIQUE (tenant_id, profile_id),
  UNIQUE (entitlement_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects(tenant_id,id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES saas_supply_profiles(tenant_id,id)
);
`,
};
