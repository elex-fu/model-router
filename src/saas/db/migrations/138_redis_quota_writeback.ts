import type { SaasMigration } from './001_initial_schema.js';

export const REDIS_QUOTA_WRITEBACK_SAAS_MIGRATION: SaasMigration = {
  version: 138,
  name: 'redis_quota_writeback',
  sql: `
CREATE TABLE saas_redis_quota_metadata (
  namespace text PRIMARY KEY CHECK (length(namespace) BETWEEN 1 AND 200),
  identity uuid NOT NULL UNIQUE,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0)
);
CREATE TABLE saas_redis_quota_state (
  namespace text NOT NULL REFERENCES saas_redis_quota_metadata(namespace),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 512),
  generation bigint NOT NULL CHECK (generation > 0),
  version bigint NOT NULL CHECK (version > 0),
  value jsonb NOT NULL,
  projection_pending boolean NOT NULL DEFAULT false,
  PRIMARY KEY(namespace,key)
);
CREATE INDEX saas_redis_quota_request_recovery_idx ON saas_redis_quota_state
  (namespace, (value->>'state'), ((value->>'deadlineMs')::bigint))
  WHERE value->>'kind'='request' AND value->>'state'='active';
CREATE INDEX saas_redis_quota_projection_idx ON saas_redis_quota_state(namespace) WHERE projection_pending;

ALTER TABLE saas_requests ADD COLUMN capacity_backend text NOT NULL DEFAULT 'postgres'
  CHECK (capacity_backend IN ('postgres','redis')),
  ADD COLUMN redis_quota_reservation_id uuid,
  ADD COLUMN redis_rate_reservation_id uuid,
  ADD CONSTRAINT saas_requests_redis_quota_receipt CHECK (
    (capacity_backend='postgres' AND redis_quota_reservation_id IS NULL AND redis_rate_reservation_id IS NULL)
    OR (capacity_backend='redis' AND redis_quota_reservation_id IS NOT NULL AND redis_rate_reservation_id IS NOT NULL)
  );
CREATE FUNCTION saas_request_redis_quota_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.capacity_backend='redis' AND (NEW.capacity_backend IS DISTINCT FROM OLD.capacity_backend
    OR NEW.redis_quota_reservation_id IS DISTINCT FROM OLD.redis_quota_reservation_id
    OR NEW.redis_rate_reservation_id IS DISTINCT FROM OLD.redis_rate_reservation_id) THEN
    RAISE EXCEPTION 'Redis quota dispatch receipt is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.capacity_backend='postgres' AND NEW.capacity_backend='redis' AND
    (OLD.execution_state<>'pending' OR EXISTS (SELECT 1 FROM saas_attempts a
      WHERE a.tenant_id=OLD.tenant_id AND a.request_id=OLD.id AND a.dispatch_state<>'not_sent')) THEN
    RAISE EXCEPTION 'Redis quota receipt must precede dispatch' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_request_redis_quota_receipt_guard BEFORE UPDATE OF capacity_backend,redis_quota_reservation_id,redis_rate_reservation_id
  ON saas_requests FOR EACH ROW EXECUTE FUNCTION saas_request_redis_quota_receipt_guard();

CREATE OR REPLACE FUNCTION saas_attempts_require_gateway_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requires_reservation boolean;
BEGIN
  IF TG_OP='INSERT' THEN requires_reservation:=NEW.dispatch_state<>'not_sent';
  ELSE requires_reservation:=OLD.dispatch_state='not_sent' AND NEW.dispatch_state<>'not_sent'; END IF;
  IF requires_reservation AND NOT EXISTS (
    SELECT 1 FROM saas_gateway_capacity_reservations r WHERE r.tenant_id=NEW.tenant_id AND r.request_id=NEW.request_id
      AND r.state IN ('reserved','retained_for_reconciliation')
  ) AND NOT EXISTS (
    SELECT 1 FROM saas_requests q WHERE q.tenant_id=NEW.tenant_id AND q.id=NEW.request_id
      AND q.capacity_backend='redis' AND q.redis_quota_reservation_id IS NOT NULL AND q.redis_rate_reservation_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'SaaS attempt cannot dispatch without an active request capacity reservation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
`,
};
