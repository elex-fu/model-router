import type { SaasMigration } from './001_initial_schema.js';

/** Operator requests reschedule status polling only; accepted creates are never replayed. */
export const OPS_MEDIA_REQUEUE_REQUESTS_SAAS_MIGRATION: SaasMigration = {
  version: 136,
  name: 'ops_media_requeue_requests',
  sql: `
CREATE TABLE saas_ops_media_requeue_requests (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  actor_session_id uuid NOT NULL REFERENCES saas_platform_sessions (id) ON DELETE RESTRICT,
  tenant_id text NOT NULL CHECK (btrim(tenant_id) <> ''),
  task_id text NOT NULL CHECK (length(task_id) BETWEEN 1 AND 255),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  expected_lease_epoch bigint NOT NULL CHECK (expected_lease_epoch >= 0),
  result_lease_epoch bigint NOT NULL CHECK (result_lease_epoch = expected_lease_epoch + 1),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000 AND reason = btrim(reason)),
  audit_event_id uuid NOT NULL UNIQUE REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_user_id, idempotency_key)
);
CREATE INDEX saas_ops_media_requeue_task_idx ON saas_ops_media_requeue_requests (tenant_id, task_id, recorded_at);
CREATE FUNCTION saas_ops_media_requeue_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operations requeue receipts are append-only';
END;
$$;
CREATE TRIGGER saas_ops_media_requeue_no_update BEFORE UPDATE OR DELETE ON saas_ops_media_requeue_requests
  FOR EACH ROW EXECUTE FUNCTION saas_ops_media_requeue_immutable();
CREATE TRIGGER saas_ops_media_requeue_no_truncate BEFORE TRUNCATE ON saas_ops_media_requeue_requests
  FOR EACH STATEMENT EXECUTE FUNCTION saas_ops_media_requeue_immutable();
`,
};
