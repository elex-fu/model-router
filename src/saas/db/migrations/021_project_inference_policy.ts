import type { SaasMigration } from './001_initial_schema.js';

/*
 * Project existence is not execution authority.  Every project gets an
 * explicit, versioned suspended head during this migration, while the
 * nullable request/attempt snapshots preserve old rows without inventing a
 * policy version for them.  New request and attempt writes are rejected
 * unless they carry an exact active policy snapshot.
 */
const projectInferencePolicySchemaSql = `
ALTER TABLE saas_projects
  ADD COLUMN inference_policy_version bigint NOT NULL DEFAULT 1
    CHECK (inference_policy_version >= 1),
  ADD COLUMN inference_policy_status text NOT NULL DEFAULT 'suspended'
    CHECK (inference_policy_status IN ('active', 'suspended', 'disabled'));

CREATE TABLE saas_project_inference_policy_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'disabled')),
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, version),
  CONSTRAINT saas_project_inference_policy_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX saas_project_inference_policy_head_idx
  ON saas_project_inference_policy_versions (tenant_id, project_id, version DESC);

/* Existing projects are explicitly deny-by-default; no request/attempt rows
 * are updated and no historical authority is fabricated. */
INSERT INTO saas_project_inference_policy_versions
  (tenant_id, project_id, version, status, changed_by_user_id, created_at)
SELECT tenant_id, id, 1, 'suspended', NULL, clock_timestamp()
FROM saas_projects;

ALTER TABLE saas_projects
  ADD CONSTRAINT saas_projects_inference_policy_head_unique
    UNIQUE (tenant_id, id, inference_policy_version),
  ADD CONSTRAINT saas_projects_inference_policy_head_fk
    FOREIGN KEY (tenant_id, id, inference_policy_version)
    REFERENCES saas_project_inference_policy_versions (tenant_id, project_id, version)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER saas_project_inference_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_project_inference_policy_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_projects_inference_policy_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy_record record;
BEGIN
  /* New projects remain suspended until an explicit policy API transition. */
  IF TG_OP = 'INSERT' THEN
    INSERT INTO saas_project_inference_policy_versions
      (tenant_id, project_id, version, status, changed_by_user_id, created_at)
    VALUES (NEW.tenant_id, NEW.id, NEW.inference_policy_version,
            NEW.inference_policy_status, NULL, clock_timestamp())
    ON CONFLICT (tenant_id, project_id, version) DO NOTHING;
  END IF;

  SELECT version, status
    INTO policy_record
    FROM saas_project_inference_policy_versions
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.id
     AND version = NEW.inference_policy_version;

  IF NOT FOUND OR policy_record.status IS DISTINCT FROM NEW.inference_policy_status THEN
    RAISE EXCEPTION 'Project inference policy head does not match its versioned policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_projects_inference_policy_head_guard
  AFTER INSERT OR UPDATE OF inference_policy_version, inference_policy_status ON saas_projects
  FOR EACH ROW EXECUTE FUNCTION saas_projects_inference_policy_head_guard();

ALTER TABLE saas_requests
  ADD COLUMN project_policy_version bigint
    CHECK (project_policy_version IS NULL OR project_policy_version >= 1),
  ADD CONSTRAINT saas_requests_project_policy_snapshot_fk
    FOREIGN KEY (tenant_id, project_id, project_policy_version)
    REFERENCES saas_project_inference_policy_versions (tenant_id, project_id, version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_requests_project_policy_snapshot_unique
    UNIQUE (tenant_id, id, project_policy_version);

CREATE FUNCTION saas_requests_guard_project_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  project_record record;
  policy_record record;
BEGIN
  IF NEW.project_policy_version IS NULL THEN
    RAISE EXCEPTION 'New SaaS requests require an exact project inference policy version'
      USING ERRCODE = '23514';
  END IF;

  SELECT inference_policy_version, inference_policy_status
    INTO project_record
    FROM saas_projects
   WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id;
  IF NOT FOUND
    OR project_record.inference_policy_version IS DISTINCT FROM NEW.project_policy_version
    OR project_record.inference_policy_status IS DISTINCT FROM 'active'
  THEN
    RAISE EXCEPTION 'SaaS request project inference policy is not the active project head'
      USING ERRCODE = '23514';
  END IF;

  SELECT status
    INTO policy_record
    FROM saas_project_inference_policy_versions
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND version = NEW.project_policy_version;
  IF NOT FOUND OR policy_record.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'SaaS request project inference policy snapshot is not active'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_requests_guard_project_policy_snapshot
  BEFORE INSERT OR UPDATE OF tenant_id, project_id, project_policy_version ON saas_requests
  FOR EACH ROW EXECUTE FUNCTION saas_requests_guard_project_policy_snapshot();

ALTER TABLE saas_attempts
  ADD COLUMN project_policy_version bigint
    CHECK (project_policy_version IS NULL OR project_policy_version >= 1),
  ADD CONSTRAINT saas_attempts_project_policy_snapshot_fk
    FOREIGN KEY (tenant_id, request_id, project_policy_version)
    REFERENCES saas_requests (tenant_id, id, project_policy_version)
    ON DELETE RESTRICT;

CREATE FUNCTION saas_attempts_guard_project_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.project_policy_version IS DISTINCT FROM NEW.project_policy_version
  THEN
    RAISE EXCEPTION 'SaaS attempt project inference policy snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.project_policy_version IS NULL
    AND NEW.project_policy_version IS NOT NULL
  THEN
    RAISE EXCEPTION 'Historical SaaS attempts cannot be assigned a project policy version'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.project_policy_version IS NULL THEN
    RAISE EXCEPTION 'New SaaS attempts require an exact project inference policy version'
      USING ERRCODE = '23514';
  END IF;

  SELECT project_policy_version
    INTO request_record
    FROM saas_requests
   WHERE tenant_id = NEW.tenant_id AND id = NEW.request_id;
  IF NOT FOUND OR request_record.project_policy_version IS DISTINCT FROM NEW.project_policy_version THEN
    RAISE EXCEPTION 'SaaS attempt project inference policy snapshot does not match its request'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_project_policy_snapshot
  BEFORE INSERT OR UPDATE OF tenant_id, request_id, project_policy_version ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_project_policy_snapshot();
`;

export const PROJECT_INFERENCE_POLICY_SAAS_MIGRATION: SaasMigration = {
  version: 21,
  name: 'project_inference_policy_versions_and_snapshots',
  sql: projectInferencePolicySchemaSql,
};
