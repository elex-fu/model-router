import type { SaasMigration } from './001_initial_schema.js';

/*
 * Route configuration is an authorization fact, not a copy of runtime
 * configuration.  A route head points at immutable versions; only an active
 * published version can be captured by a new request.  No request or attempt
 * rows are backfilled here, so pre-022 rows remain non-dispatchable until a
 * later, explicit migration supplies trustworthy authority.
 */
const routeConfigAuthoritySchemaSql = `
CREATE TABLE saas_route_config_heads (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  route_id text NOT NULL,
  current_version bigint NOT NULL CHECK (current_version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, route_id),
  CONSTRAINT saas_route_config_heads_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE saas_route_config_versions (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  route_id text NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
  public_model_id text NOT NULL,
  public_model_version integer NOT NULL CHECK (public_model_version >= 1),
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  target_mode text NOT NULL,
  upstream_id text NOT NULL,
  endpoint text NOT NULL,
  changed_by_user_id uuid REFERENCES saas_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, route_id, version),
  CONSTRAINT saas_route_config_versions_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_versions_public_model_fk
    FOREIGN KEY (public_model_id, public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT,
  CONSTRAINT saas_route_config_versions_target_mode_check CHECK (
    (supply_mode = 'byok' AND target_mode = 'tenant_account')
    OR (supply_mode = 'platform' AND target_mode = 'platform_pool')
  ),
  CONSTRAINT saas_route_config_versions_text_nonempty CHECK (
    btrim(route_id) <> ''
    AND route_id = btrim(route_id)
    AND btrim(upstream_id) <> ''
    AND upstream_id = btrim(upstream_id)
    AND btrim(endpoint) <> ''
    AND endpoint = btrim(endpoint)
  )
);

ALTER TABLE saas_route_config_heads
  ADD CONSTRAINT saas_route_config_heads_version_fk
    FOREIGN KEY (tenant_id, project_id, route_id, current_version)
    REFERENCES saas_route_config_versions (tenant_id, project_id, route_id, version)
    ON DELETE RESTRICT;

CREATE INDEX saas_route_config_versions_lookup_idx
  ON saas_route_config_versions
    (tenant_id, project_id, public_model_id, public_model_version, protocol, supply_mode, version DESC);

CREATE TRIGGER saas_route_config_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_route_config_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_route_config_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  model_record record;
BEGIN
  SELECT pm.status AS public_model_status,
         pmv.status AS public_model_version_status,
         pmv.endpoint_scope
    INTO model_record
    FROM saas_public_model_versions pmv
    JOIN saas_public_models pm ON pm.id = pmv.public_model_id
   WHERE pmv.public_model_id = NEW.public_model_id
     AND pmv.version = NEW.public_model_version;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Route config public model version is not present'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (NEW.endpoint = ANY(model_record.endpoint_scope)) THEN
    RAISE EXCEPTION 'Route config endpoint is outside the public model authority scope'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'active'
    AND (model_record.public_model_status IS DISTINCT FROM 'active'
      OR model_record.public_model_version_status IS DISTINCT FROM 'active')
  THEN
    RAISE EXCEPTION 'A route can be published only for an active public model version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_route_config_version_guard
  BEFORE INSERT ON saas_route_config_versions
  FOR EACH ROW EXECUTE FUNCTION saas_route_config_version_guard();

CREATE FUNCTION saas_route_config_head_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_record record;
BEGIN
  SELECT status
    INTO version_record
    FROM saas_route_config_versions
   WHERE tenant_id = NEW.tenant_id
     AND project_id = NEW.project_id
     AND route_id = NEW.route_id
     AND version = NEW.current_version;

  IF NOT FOUND OR version_record.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Route config head does not match its immutable version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_route_config_head_guard
  BEFORE INSERT OR UPDATE OF current_version, status ON saas_route_config_heads
  FOR EACH ROW EXECUTE FUNCTION saas_route_config_head_guard();

ALTER TABLE saas_requests
  ADD COLUMN route_config_id text,
  ADD COLUMN route_config_version bigint
    CHECK (route_config_version IS NULL OR route_config_version >= 1),
  ADD COLUMN route_public_model_id text,
  ADD COLUMN route_public_model_version integer
    CHECK (route_public_model_version IS NULL OR route_public_model_version >= 1),
  ADD COLUMN route_protocol text
    CHECK (route_protocol IS NULL OR route_protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  ADD COLUMN route_target_mode text
    CHECK (route_target_mode IS NULL OR route_target_mode IN ('tenant_account', 'platform_pool')),
  ADD COLUMN route_upstream_id text,
  ADD CONSTRAINT saas_requests_route_snapshot_shape CHECK (
    (route_config_id IS NULL
      AND route_config_version IS NULL
      AND route_public_model_id IS NULL
      AND route_public_model_version IS NULL
      AND route_protocol IS NULL
      AND route_target_mode IS NULL
      AND route_upstream_id IS NULL)
    OR (route_config_id IS NOT NULL
      AND route_config_version IS NOT NULL
      AND route_public_model_id IS NOT NULL
      AND route_public_model_version IS NOT NULL
      AND route_protocol IS NOT NULL
      AND route_target_mode IS NOT NULL
      AND route_upstream_id IS NOT NULL)
  ),
  ADD CONSTRAINT saas_requests_route_config_snapshot_fk
    FOREIGN KEY (tenant_id, project_id, route_config_id, route_config_version)
    REFERENCES saas_route_config_versions (tenant_id, project_id, route_id, version)
    ON DELETE RESTRICT,
  ADD CONSTRAINT saas_requests_route_public_model_snapshot_fk
    FOREIGN KEY (route_public_model_id, route_public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT;

CREATE FUNCTION saas_requests_guard_route_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  route_record record;
BEGIN
  IF NEW.route_config_id IS NULL
    OR NEW.route_config_version IS NULL
    OR NEW.route_public_model_id IS NULL
    OR NEW.route_public_model_version IS NULL
    OR NEW.route_protocol IS NULL
    OR NEW.route_target_mode IS NULL
    OR NEW.route_upstream_id IS NULL
  THEN
    RAISE EXCEPTION 'New SaaS requests require an exact active route authority snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT rv.status AS route_status,
         rv.public_model_id,
         rv.public_model_version,
         rv.protocol,
         rv.supply_mode,
         rv.target_mode,
         rv.upstream_id,
         rv.endpoint,
         h.current_version,
         h.status AS head_status,
         pm.status AS public_model_status,
         pmv.status AS public_model_version_status,
         pm.alias,
         pmv.model
    INTO route_record
    FROM saas_route_config_versions rv
    JOIN saas_route_config_heads h
      ON h.tenant_id = rv.tenant_id
     AND h.project_id = rv.project_id
     AND h.route_id = rv.route_id
    JOIN saas_public_model_versions pmv
      ON pmv.public_model_id = rv.public_model_id
     AND pmv.version = rv.public_model_version
    JOIN saas_public_models pm ON pm.id = pmv.public_model_id
   WHERE rv.tenant_id = NEW.tenant_id
     AND rv.project_id = NEW.project_id
     AND rv.route_id = NEW.route_config_id
     AND rv.version = NEW.route_config_version;

  IF NOT FOUND
    OR route_record.route_status IS DISTINCT FROM 'active'
    OR route_record.head_status IS DISTINCT FROM 'active'
    OR route_record.current_version IS DISTINCT FROM NEW.route_config_version
    OR route_record.public_model_status IS DISTINCT FROM 'active'
    OR route_record.public_model_version_status IS DISTINCT FROM 'active'
    OR route_record.public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR route_record.public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR route_record.protocol IS DISTINCT FROM NEW.route_protocol
    OR route_record.target_mode IS DISTINCT FROM NEW.route_target_mode
    OR route_record.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR route_record.upstream_id IS DISTINCT FROM NEW.route_upstream_id
    OR route_record.alias IS DISTINCT FROM NEW.public_model
    OR route_record.protocol IS DISTINCT FROM NEW.protocol
    OR route_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR NEW.config_version IS DISTINCT FROM NEW.route_config_version
  THEN
    RAISE EXCEPTION 'SaaS request route authority snapshot is not the active exact route head'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_requests_guard_route_snapshot
  BEFORE INSERT OR UPDATE OF tenant_id, project_id, route_config_id, route_config_version,
    route_public_model_id, route_public_model_version, route_protocol, route_target_mode,
    route_upstream_id, supply_mode, public_model, protocol, endpoint, config_version
  ON saas_requests
  FOR EACH ROW EXECUTE FUNCTION saas_requests_guard_route_snapshot();

ALTER TABLE saas_attempts
  ADD COLUMN route_config_id text,
  ADD COLUMN route_config_version bigint
    CHECK (route_config_version IS NULL OR route_config_version >= 1),
  ADD COLUMN route_public_model_id text,
  ADD COLUMN route_public_model_version integer
    CHECK (route_public_model_version IS NULL OR route_public_model_version >= 1),
  ADD COLUMN route_protocol text
    CHECK (route_protocol IS NULL OR route_protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  ADD COLUMN route_target_mode text
    CHECK (route_target_mode IS NULL OR route_target_mode IN ('tenant_account', 'platform_pool')),
  ADD CONSTRAINT saas_attempts_route_snapshot_shape CHECK (
    (route_config_id IS NULL
      AND route_config_version IS NULL
      AND route_public_model_id IS NULL
      AND route_public_model_version IS NULL
      AND route_protocol IS NULL
      AND route_target_mode IS NULL)
    OR (route_config_id IS NOT NULL
      AND route_config_version IS NOT NULL
      AND route_public_model_id IS NOT NULL
      AND route_public_model_version IS NOT NULL
      AND route_protocol IS NOT NULL
      AND route_target_mode IS NOT NULL)
  ),
  ADD CONSTRAINT saas_attempts_route_public_model_snapshot_fk
    FOREIGN KEY (route_public_model_id, route_public_model_version)
    REFERENCES saas_public_model_versions (public_model_id, version)
    ON DELETE RESTRICT;

CREATE FUNCTION saas_attempts_guard_route_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request_record record;
  route_record record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND (OLD.route_config_id IS DISTINCT FROM NEW.route_config_id
      OR OLD.route_config_version IS DISTINCT FROM NEW.route_config_version
      OR OLD.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
      OR OLD.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
      OR OLD.route_protocol IS DISTINCT FROM NEW.route_protocol
      OR OLD.route_target_mode IS DISTINCT FROM NEW.route_target_mode)
  THEN
    IF OLD.route_config_id IS NULL AND NEW.route_config_id IS NOT NULL THEN
      RAISE EXCEPTION 'Historical SaaS attempts cannot be assigned a route authority snapshot'
        USING ERRCODE = '55000';
    END IF;
    RAISE EXCEPTION 'SaaS attempt route authority snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.route_config_id IS NULL
    OR NEW.route_config_version IS NULL
    OR NEW.route_public_model_id IS NULL
    OR NEW.route_public_model_version IS NULL
    OR NEW.route_protocol IS NULL
    OR NEW.route_target_mode IS NULL
  THEN
    RAISE EXCEPTION 'New SaaS attempts require an exact route authority snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT r.project_id,
         r.route_config_id,
         r.route_config_version,
         r.route_public_model_id,
         r.route_public_model_version,
         r.route_protocol,
         r.route_target_mode,
         r.route_upstream_id,
         r.public_model,
         r.protocol AS request_protocol,
         r.endpoint
    INTO request_record
    FROM saas_requests r
   WHERE r.tenant_id = NEW.tenant_id
     AND r.id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS attempt route authority request is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT rv.status AS route_status,
         rv.public_model_id,
         rv.public_model_version,
         rv.protocol,
         rv.target_mode,
         rv.upstream_id,
         rv.endpoint,
         h.current_version,
         h.status AS head_status,
         pmv.model
    INTO route_record
    FROM saas_route_config_versions rv
    JOIN saas_route_config_heads h
      ON h.tenant_id = rv.tenant_id
     AND h.project_id = rv.project_id
     AND h.route_id = rv.route_id
    JOIN saas_public_model_versions pmv
      ON pmv.public_model_id = rv.public_model_id
     AND pmv.version = rv.public_model_version
   WHERE rv.tenant_id = NEW.tenant_id
     AND rv.project_id = request_record.project_id
     AND rv.route_id = NEW.route_config_id
     AND rv.version = NEW.route_config_version;

  IF NOT FOUND
    OR route_record.route_status IS DISTINCT FROM 'active'
    OR route_record.head_status IS DISTINCT FROM 'active'
    OR route_record.current_version IS DISTINCT FROM NEW.route_config_version
    OR route_record.public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR route_record.public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR route_record.protocol IS DISTINCT FROM NEW.route_protocol
    OR route_record.target_mode IS DISTINCT FROM NEW.route_target_mode
    OR route_record.upstream_id IS DISTINCT FROM NEW.upstream_id
    OR route_record.protocol IS DISTINCT FROM NEW.protocol
    OR route_record.endpoint IS DISTINCT FROM NEW.endpoint
    OR route_record.model IS DISTINCT FROM NEW.resolved_model
    OR request_record.route_config_id IS DISTINCT FROM NEW.route_config_id
    OR request_record.route_config_version IS DISTINCT FROM NEW.route_config_version
    OR request_record.route_public_model_id IS DISTINCT FROM NEW.route_public_model_id
    OR request_record.route_public_model_version IS DISTINCT FROM NEW.route_public_model_version
    OR request_record.route_protocol IS DISTINCT FROM NEW.route_protocol
    OR request_record.route_target_mode IS DISTINCT FROM NEW.route_target_mode
    OR request_record.route_upstream_id IS DISTINCT FROM NEW.upstream_id
    OR request_record.request_protocol IS DISTINCT FROM NEW.protocol
    OR request_record.endpoint IS DISTINCT FROM NEW.endpoint
  THEN
    RAISE EXCEPTION 'SaaS attempt route authority snapshot does not match its request and active route'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_route_snapshot
  BEFORE INSERT OR UPDATE OF tenant_id, request_id, route_config_id, route_config_version,
    route_public_model_id, route_public_model_version, route_protocol, route_target_mode,
    upstream_id, resolved_model, protocol, endpoint
  ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_route_snapshot();

CREATE FUNCTION saas_attempts_guard_route_dispatch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  /* A route replacement or disable must invalidate the old snapshot before
   * an attempt can begin dispatch.  The old attempt is never rewritten. */
  IF TG_OP = 'UPDATE'
    AND OLD.dispatch_state = 'not_sent'
    AND NEW.dispatch_state <> 'not_sent'
  THEN
    IF NOT EXISTS (
      SELECT 1
        FROM saas_requests r
        JOIN saas_route_config_heads h
          ON h.tenant_id = r.tenant_id
         AND h.project_id = r.project_id
         AND h.route_id = r.route_config_id
        JOIN saas_route_config_versions rv
          ON rv.tenant_id = h.tenant_id
         AND rv.project_id = h.project_id
         AND rv.route_id = h.route_id
         AND rv.version = h.current_version
        JOIN saas_public_model_versions pmv
          ON pmv.public_model_id = rv.public_model_id
         AND pmv.version = rv.public_model_version
        JOIN saas_public_models pm ON pm.id = pmv.public_model_id
       WHERE r.tenant_id = NEW.tenant_id
         AND r.id = NEW.request_id
         AND r.route_config_id = NEW.route_config_id
         AND r.route_config_version = NEW.route_config_version
         AND r.route_public_model_id = NEW.route_public_model_id
         AND r.route_public_model_version = NEW.route_public_model_version
         AND r.route_protocol = NEW.route_protocol
         AND r.route_target_mode = NEW.route_target_mode
         AND r.route_upstream_id = rv.upstream_id
         AND h.status = 'active'
         AND rv.status = 'active'
         AND pm.status = 'active'
         AND pmv.status = 'active'
         AND h.current_version = NEW.route_config_version
    ) THEN
      RAISE EXCEPTION 'SaaS attempt route authority is not the current active published route'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_guard_route_dispatch
  BEFORE UPDATE OF dispatch_state ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_guard_route_dispatch();
`;

export const ROUTE_CONFIG_AUTHORITY_SAAS_MIGRATION: SaasMigration = {
  version: 22,
  name: 'route_config_authority_versions_and_snapshots',
  sql: routeConfigAuthoritySchemaSql,
};
