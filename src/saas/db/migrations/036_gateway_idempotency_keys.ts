import type { SaasMigration } from './001_initial_schema.js';

const gatewayIdempotencyKeysSchemaSql = `
CREATE TABLE saas_gateway_request_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  proxy_key_id uuid NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_fingerprint_version text NOT NULL,
  request_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'in_progress'
    CHECK (state IN ('in_progress', 'completed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  unknown_at timestamptz,
  CONSTRAINT saas_gateway_request_idempotency_scope_unique
    UNIQUE (tenant_id, project_id, proxy_key_id, key_digest),
  CONSTRAINT saas_gateway_request_idempotency_request_unique
    UNIQUE (tenant_id, request_id),
  CONSTRAINT saas_gateway_request_idempotency_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_gateway_request_idempotency_proxy_key_fk
    FOREIGN KEY (tenant_id, project_id, proxy_key_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_gateway_request_idempotency_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_gateway_request_idempotency_fingerprint_version_nonempty
    CHECK (request_fingerprint_version <> '' AND request_fingerprint_version = btrim(request_fingerprint_version)),
  CONSTRAINT saas_gateway_request_idempotency_terminal_timestamps
    CHECK (
      (state = 'completed') = (completed_at IS NOT NULL)
      AND (state = 'unknown') = (unknown_at IS NOT NULL)
    )
);

CREATE FUNCTION saas_gateway_request_idempotency_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.proxy_key_id IS DISTINCT FROM OLD.proxy_key_id
    OR NEW.key_digest IS DISTINCT FROM OLD.key_digest
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.request_fingerprint_version IS DISTINCT FROM OLD.request_fingerprint_version
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Gateway idempotency identity is immutable'
      USING ERRCODE = '55006';
  END IF;

  IF OLD.state <> 'in_progress' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Gateway idempotency terminal state is immutable'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_gateway_request_idempotency_guard_update
  BEFORE UPDATE ON saas_gateway_request_idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION saas_gateway_request_idempotency_guard_update();

CREATE FUNCTION saas_gateway_request_idempotency_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Gateway idempotency mappings cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

CREATE TRIGGER saas_gateway_request_idempotency_no_delete
  BEFORE DELETE ON saas_gateway_request_idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION saas_gateway_request_idempotency_reject_delete();

CREATE TRIGGER saas_gateway_request_idempotency_no_truncate
  BEFORE TRUNCATE ON saas_gateway_request_idempotency_keys
  FOR EACH STATEMENT EXECUTE FUNCTION saas_gateway_request_idempotency_reject_delete();
`;

export const GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION: SaasMigration = {
  version: 36,
  name: 'gateway_request_idempotency_keys',
  sql: gatewayIdempotencyKeysSchemaSql,
};
