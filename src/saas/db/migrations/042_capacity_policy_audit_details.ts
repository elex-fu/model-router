import type { SaasMigration } from './001_initial_schema.js';

const capacityPolicyAuditDetailsSql = `
/* Tenant capacity edits need their own monotonic CAS token. */
ALTER TABLE saas_tenants
  ADD COLUMN capacity_policy_revision bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT saas_tenants_capacity_policy_revision_positive
    CHECK (capacity_policy_revision >= 1);

/*
 * Capacity policy audit facts are deliberately narrow and immutable. Actor,
 * action, tenant, and request ID remain authoritative in saas_audit_events.
 */
CREATE TABLE saas_capacity_policy_audit_details (
  audit_event_id uuid PRIMARY KEY
    REFERENCES saas_audit_events(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('tenant', 'project', 'api_key')),
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  project_id uuid,
  api_key_id uuid,
  reason text NOT NULL,
  revision_kind text NOT NULL,
  before_revision bigint NOT NULL,
  after_revision bigint NOT NULL,
  before_requests_per_minute bigint,
  before_tokens_per_minute bigint,
  before_max_concurrent_requests integer,
  after_requests_per_minute bigint NOT NULL,
  after_tokens_per_minute bigint NOT NULL,
  after_max_concurrent_requests integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT saas_capacity_policy_audit_reason_bounded CHECK (
    reason IN (
      'initial_provisioning',
      'customer_request',
      'capacity_adjustment',
      'incident_response',
      'risk_control',
      'data_correction'
    )
    AND btrim(reason) = reason
    AND char_length(reason) BETWEEN 3 AND 512
    AND octet_length(reason) <= 1024
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT saas_capacity_policy_audit_scope_shape CHECK (
    (scope = 'tenant' AND revision_kind = 'tenant_capacity_policy'
      AND project_id IS NULL AND api_key_id IS NULL)
    OR (scope = 'project' AND revision_kind = 'project_inference_policy'
      AND project_id IS NOT NULL AND api_key_id IS NULL)
    OR (scope = 'api_key' AND revision_kind = 'api_key_authz'
      AND project_id IS NOT NULL AND api_key_id IS NOT NULL)
  ),
  CONSTRAINT saas_capacity_policy_audit_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_capacity_policy_audit_api_key_fk
    FOREIGN KEY (tenant_id, project_id, api_key_id)
    REFERENCES saas_api_keys(tenant_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_capacity_policy_audit_revision_step CHECK (
    before_revision >= 1 AND after_revision = before_revision + 1
  ),
  CONSTRAINT saas_capacity_policy_audit_before_snapshot CHECK (
    (before_requests_per_minute IS NULL
      AND before_tokens_per_minute IS NULL
      AND before_max_concurrent_requests IS NULL)
    OR (before_requests_per_minute IS NOT NULL
      AND before_requests_per_minute BETWEEN 1 AND 9007199254740991
      AND before_tokens_per_minute IS NOT NULL
      AND before_tokens_per_minute BETWEEN 1 AND 9007199254740991
      AND before_max_concurrent_requests IS NOT NULL
      AND before_max_concurrent_requests BETWEEN 1 AND 2147483647)
  ),
  CONSTRAINT saas_capacity_policy_audit_after_snapshot CHECK (
    after_requests_per_minute BETWEEN 1 AND 9007199254740991
    AND after_tokens_per_minute BETWEEN 1 AND 9007199254740991
    AND after_max_concurrent_requests BETWEEN 1 AND 2147483647
  )
);

CREATE INDEX saas_capacity_policy_audit_tenant_created_idx
  ON saas_capacity_policy_audit_details(tenant_id, created_at DESC);
CREATE INDEX saas_capacity_policy_audit_project_created_idx
  ON saas_capacity_policy_audit_details(tenant_id, project_id, created_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX saas_capacity_policy_audit_api_key_created_idx
  ON saas_capacity_policy_audit_details(tenant_id, project_id, api_key_id, created_at DESC)
  WHERE api_key_id IS NOT NULL;

CREATE TRIGGER saas_capacity_policy_audit_details_immutable
  BEFORE UPDATE OR DELETE ON saas_capacity_policy_audit_details
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_capacity_policy_audit_details_no_truncate
  BEFORE TRUNCATE ON saas_capacity_policy_audit_details
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();
`;

export const CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION: SaasMigration = {
  version: 42,
  name: 'capacity_policy_audit_details',
  sql: capacityPolicyAuditDetailsSql,
};
