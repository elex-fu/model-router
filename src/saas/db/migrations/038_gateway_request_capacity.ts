import type { SaasMigration } from './001_initial_schema.js';

const gatewayRequestCapacitySql = `
/* No quota defaults or historical policy backfill: absent limits deny admission. */
ALTER TABLE saas_tenants
  ADD COLUMN requests_per_minute bigint,
  ADD COLUMN tokens_per_minute bigint,
  ADD COLUMN max_concurrent_requests integer,
  ADD CONSTRAINT saas_tenants_capacity_limits_positive CHECK (
    (requests_per_minute IS NULL OR requests_per_minute > 0)
    AND (tokens_per_minute IS NULL OR tokens_per_minute > 0)
    AND (max_concurrent_requests IS NULL OR max_concurrent_requests > 0)
  );

ALTER TABLE saas_project_inference_policy_versions
  ADD COLUMN requests_per_minute bigint,
  ADD COLUMN tokens_per_minute bigint,
  ADD COLUMN max_concurrent_requests integer,
  ADD CONSTRAINT saas_project_inference_policy_capacity_limits_positive CHECK (
    (requests_per_minute IS NULL OR requests_per_minute > 0)
    AND (tokens_per_minute IS NULL OR tokens_per_minute > 0)
    AND (max_concurrent_requests IS NULL OR max_concurrent_requests > 0)
  );

ALTER TABLE saas_api_keys
  ADD COLUMN requests_per_minute bigint,
  ADD COLUMN tokens_per_minute bigint,
  ADD COLUMN max_concurrent_requests integer,
  ADD CONSTRAINT saas_api_keys_capacity_limits_positive CHECK (
    (requests_per_minute IS NULL OR requests_per_minute > 0)
    AND (tokens_per_minute IS NULL OR tokens_per_minute > 0)
    AND (max_concurrent_requests IS NULL OR max_concurrent_requests > 0)
  );

ALTER TABLE saas_requests
  ADD CONSTRAINT saas_requests_capacity_scope_unique
    UNIQUE (tenant_id, id, project_id, proxy_key_id, supply_mode);

ALTER TABLE saas_attempts
  ADD CONSTRAINT saas_attempts_capacity_scope_unique
    UNIQUE (tenant_id, request_id, id);

CREATE TABLE saas_gateway_capacity_reservations (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  proxy_key_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  project_policy_version bigint NOT NULL CHECK (project_policy_version >= 1),
  key_authz_version bigint NOT NULL CHECK (key_authz_version >= 1),
  idempotency_scope_key text NOT NULL CHECK (idempotency_scope_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint <> ''),
  request_fingerprint_version text NOT NULL CHECK (btrim(request_fingerprint_version) <> ''),
  token_units bigint NOT NULL CHECK (token_units > 0),
  quota_reservation_id uuid NOT NULL UNIQUE,
  rate_reservation_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'released', 'retained_for_reconciliation')),
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT saas_gateway_capacity_reservations_pk
    PRIMARY KEY (tenant_id, request_id),
  CONSTRAINT saas_gateway_capacity_reservations_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  CONSTRAINT saas_gateway_capacity_reservations_project_fk
    FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_gateway_capacity_reservations_project_policy_fk
    FOREIGN KEY (tenant_id, project_id, project_policy_version)
    REFERENCES saas_project_inference_policy_versions(tenant_id, project_id, version) ON DELETE RESTRICT,
  CONSTRAINT saas_gateway_capacity_reservations_key_fk
    FOREIGN KEY (tenant_id, project_id, proxy_key_id)
    REFERENCES saas_api_keys(tenant_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_gateway_capacity_reservations_request_fk
    FOREIGN KEY (tenant_id, request_id, project_id, proxy_key_id, supply_mode)
    REFERENCES saas_requests(tenant_id, id, project_id, proxy_key_id, supply_mode)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_gateway_capacity_reservations_attempt_fk
    FOREIGN KEY (tenant_id, request_id, attempt_id)
    REFERENCES saas_attempts(tenant_id, request_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX saas_gateway_capacity_reservations_tenant_window_idx
  ON saas_gateway_capacity_reservations (tenant_id, reserved_at DESC)
  WHERE state IN ('reserved', 'retained_for_reconciliation');
CREATE INDEX saas_gateway_capacity_reservations_project_window_idx
  ON saas_gateway_capacity_reservations (tenant_id, project_id, reserved_at DESC)
  WHERE state IN ('reserved', 'retained_for_reconciliation');
CREATE INDEX saas_gateway_capacity_reservations_key_window_idx
  ON saas_gateway_capacity_reservations (tenant_id, project_id, proxy_key_id, reserved_at DESC)
  WHERE state IN ('reserved', 'retained_for_reconciliation');

CREATE FUNCTION saas_gateway_capacity_reservation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.proxy_key_id IS DISTINCT FROM NEW.proxy_key_id
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR OLD.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR OLD.project_policy_version IS DISTINCT FROM NEW.project_policy_version
    OR OLD.key_authz_version IS DISTINCT FROM NEW.key_authz_version
    OR OLD.idempotency_scope_key IS DISTINCT FROM NEW.idempotency_scope_key
    OR OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
    OR OLD.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
    OR OLD.token_units IS DISTINCT FROM NEW.token_units
    OR OLD.quota_reservation_id IS DISTINCT FROM NEW.quota_reservation_id
    OR OLD.rate_reservation_id IS DISTINCT FROM NEW.rate_reservation_id
    OR OLD.reserved_at IS DISTINCT FROM NEW.reserved_at
  THEN
    RAISE EXCEPTION 'Gateway capacity reservation facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state
    AND NOT (OLD.state = 'reserved' AND NEW.state IN ('released', 'retained_for_reconciliation'))
  THEN
    RAISE EXCEPTION 'Invalid gateway capacity reservation state transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Gateway capacity reservation timestamp must be monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_gateway_capacity_reservations_guard
  BEFORE UPDATE ON saas_gateway_capacity_reservations
  FOR EACH ROW EXECUTE FUNCTION saas_gateway_capacity_reservation_guard();

CREATE FUNCTION saas_attempts_require_gateway_capacity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  requires_reservation boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    requires_reservation := NEW.dispatch_state <> 'not_sent';
  ELSE
    requires_reservation := OLD.dispatch_state = 'not_sent' AND NEW.dispatch_state <> 'not_sent';
  END IF;
  IF requires_reservation AND NOT EXISTS (
      SELECT 1
        FROM saas_gateway_capacity_reservations reservation
       WHERE reservation.tenant_id = NEW.tenant_id
         AND reservation.request_id = NEW.request_id
         AND reservation.state IN ('reserved', 'retained_for_reconciliation')
    )
  THEN
    RAISE EXCEPTION 'SaaS attempt cannot dispatch without an active request capacity reservation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_attempts_require_gateway_capacity
  BEFORE INSERT OR UPDATE OF dispatch_state ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_attempts_require_gateway_capacity();

CREATE FUNCTION saas_gateway_capacity_reservation_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Gateway capacity reservations must be retained as idempotency evidence'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_gateway_capacity_reservations_no_delete
  BEFORE DELETE ON saas_gateway_capacity_reservations
  FOR EACH ROW EXECUTE FUNCTION saas_gateway_capacity_reservation_no_delete();
`;

export const GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION: SaasMigration = {
  version: 38,
  name: 'gateway_request_capacity_reservations',
  sql: gatewayRequestCapacitySql,
};
