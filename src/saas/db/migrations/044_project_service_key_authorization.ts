import type { SaasMigration } from './001_initial_schema.js';

const projectServiceKeyAuthorizationSql = `
/*
 * Keep project policy authority in the existing versioned head. The outbox
 * and NOTIFY are emitted by the same row update that advances that head, so
 * consumers can recover missed notifications from durable rows. Gateway
 * authorization continues to read the authoritative head on every request,
 * replay, and evidence claim; it does not depend on a cache notification.
 */
CREATE TABLE saas_project_policy_invalidation_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  previous_version bigint NOT NULL CHECK (previous_version >= 1),
  previous_status text NOT NULL CHECK (previous_status IN ('active', 'suspended', 'disabled')),
  policy_version bigint NOT NULL CHECK (policy_version >= 1),
  policy_status text NOT NULL CHECK (policy_status IN ('active', 'suspended', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error_code text,
  CONSTRAINT saas_project_policy_invalidation_version_advance
    CHECK (policy_version > previous_version),
  CONSTRAINT saas_project_policy_invalidation_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_project_policy_invalidation_head_fk
    FOREIGN KEY (tenant_id, project_id, policy_version)
    REFERENCES saas_project_inference_policy_versions (tenant_id, project_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_project_policy_invalidation_delivery_shape CHECK (
    (delivered_at IS NULL) OR delivery_attempts > 0
  ),
  CONSTRAINT saas_project_policy_invalidation_error_shape CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  CONSTRAINT saas_project_policy_invalidation_once UNIQUE (tenant_id, project_id, policy_version)
);

CREATE INDEX saas_project_policy_invalidation_pending_idx
  ON saas_project_policy_invalidation_outbox (created_at, id)
  WHERE delivered_at IS NULL;

CREATE FUNCTION saas_projects_emit_inference_policy_invalidation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.inference_policy_version IS NOT DISTINCT FROM OLD.inference_policy_version
     AND NEW.inference_policy_status IS NOT DISTINCT FROM OLD.inference_policy_status THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.saas_project_policy_invalidation_outbox
    (tenant_id, project_id, previous_version, previous_status, policy_version, policy_status)
  VALUES
    (NEW.tenant_id, NEW.id, OLD.inference_policy_version, OLD.inference_policy_status,
     NEW.inference_policy_version, NEW.inference_policy_status)
  ON CONFLICT (tenant_id, project_id, policy_version) DO NOTHING;

  PERFORM pg_catalog.pg_notify(
    'saas_project_policy_invalidation',
    pg_catalog.json_build_object(
      'tenant_id', NEW.tenant_id,
      'project_id', NEW.id,
      'policy_version', NEW.inference_policy_version,
      'policy_status', NEW.inference_policy_status
    )::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_projects_policy_invalidation_outbox
  AFTER UPDATE OF inference_policy_version, inference_policy_status ON saas_projects
  FOR EACH ROW
  WHEN (OLD.inference_policy_version IS DISTINCT FROM NEW.inference_policy_version
     OR OLD.inference_policy_status IS DISTINCT FROM NEW.inference_policy_status)
  EXECUTE FUNCTION saas_projects_emit_inference_policy_invalidation();
`;

export const PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION: SaasMigration = {
  version: 44,
  name: 'project_service_key_authorization_and_policy_invalidation',
  sql: projectServiceKeyAuthorizationSql,
};
