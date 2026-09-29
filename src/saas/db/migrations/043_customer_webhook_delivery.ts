import type { SaasMigration } from './001_initial_schema.js';

const customerWebhookDeliverySql = `
/* Composite references make every customer webhook fact tenant-scoped. */
ALTER TABLE saas_requests
  ADD CONSTRAINT saas_requests_webhook_project_mode_unique
  UNIQUE (tenant_id, id, project_id, supply_mode);

CREATE FUNCTION saas_customer_webhook_text_array_is_unique(value text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(value) = count(DISTINCT item)::integer FROM unnest(value) AS values(item);
$$;

CREATE TABLE saas_customer_webhook_tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  max_active_endpoints smallint NOT NULL CHECK (max_active_endpoints BETWEEN 1 AND 100),
  max_events_per_minute integer NOT NULL CHECK (max_events_per_minute BETWEEN 1 AND 10000),
  max_pending_deliveries integer NOT NULL CHECK (max_pending_deliveries BETWEEN 1 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  audit_event_id uuid NOT NULL UNIQUE REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER saas_customer_webhook_tenant_policies_no_delete
  BEFORE DELETE ON saas_customer_webhook_tenant_policies
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_customer_webhook_tenant_policies_no_truncate
  BEFORE TRUNCATE ON saas_customer_webhook_tenant_policies
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();

CREATE TABLE saas_customer_webhook_tenant_usage (
  tenant_id uuid PRIMARY KEY REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  minute_bucket timestamptz NOT NULL,
  events_in_bucket integer NOT NULL DEFAULT 0 CHECK (events_in_bucket BETWEEN 0 AND 10000),
  pending_deliveries integer NOT NULL DEFAULT 0 CHECK (pending_deliveries BETWEEN 0 AND 100000),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE saas_customer_webhook_endpoints (
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  current_version integer NOT NULL CHECK (current_version >= 1),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'revoked')),
  created_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TRIGGER saas_customer_webhook_endpoints_no_delete
  BEFORE DELETE ON saas_customer_webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_customer_webhook_endpoints_no_truncate
  BEFORE TRUNCATE ON saas_customer_webhook_endpoints
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();

CREATE TABLE saas_customer_webhook_endpoint_versions (
  tenant_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  target_url text NOT NULL,
  event_types text[] NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  audit_event_id uuid NOT NULL UNIQUE REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, endpoint_id, version),
  CONSTRAINT saas_customer_webhook_endpoint_versions_endpoint_fk
    FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES saas_customer_webhook_endpoints (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_endpoint_versions_url_shape CHECK (
    octet_length(target_url) BETWEEN 9 AND 2048
    AND target_url = btrim(target_url)
    AND target_url ~ '^https://'
    AND target_url !~ '[[:cntrl:]]'
  ),
  CONSTRAINT saas_customer_webhook_endpoint_versions_event_types CHECK (
    cardinality(event_types) BETWEEN 1 AND 7
    AND array_position(event_types, NULL) IS NULL
    AND array_position(event_types, '') IS NULL
    AND event_types <@ ARRAY[
      'wallet.low_balance', 'api_key.expiring', 'service_plan_order.status_changed',
      'refund.status_changed', 'request.completed', 'usage.completed', 'platform.maintenance'
    ]::text[]
    AND saas_customer_webhook_text_array_is_unique(event_types)
  )
);

ALTER TABLE saas_customer_webhook_endpoints
  ADD CONSTRAINT saas_customer_webhook_endpoints_current_version_fk
  FOREIGN KEY (tenant_id, id, current_version)
  REFERENCES saas_customer_webhook_endpoint_versions (tenant_id, endpoint_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE saas_customer_webhook_signing_secrets (
  tenant_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  secret_version integer NOT NULL CHECK (secret_version >= 1),
  state text NOT NULL CHECK (state IN ('current', 'overlap', 'revoked')),
  overlap_expires_at timestamptz,
  encrypted_envelope bytea NOT NULL,
  audit_event_id uuid NOT NULL REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, endpoint_id, secret_version),
  CONSTRAINT saas_customer_webhook_secrets_endpoint_fk
    FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES saas_customer_webhook_endpoints (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_secrets_envelope_size
    CHECK (octet_length(encrypted_envelope) BETWEEN 1 AND 16384),
  CONSTRAINT saas_customer_webhook_secrets_overlap_shape CHECK (
    (state = 'overlap' AND overlap_expires_at IS NOT NULL)
    OR (state <> 'overlap' AND overlap_expires_at IS NULL)
  )
);
CREATE UNIQUE INDEX saas_customer_webhook_secrets_one_current_idx
  ON saas_customer_webhook_signing_secrets (tenant_id, endpoint_id)
  WHERE state = 'current';
CREATE UNIQUE INDEX saas_customer_webhook_secrets_one_overlap_idx
  ON saas_customer_webhook_signing_secrets (tenant_id, endpoint_id)
  WHERE state = 'overlap';

CREATE FUNCTION saas_customer_webhook_secret_envelope_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.encrypted_envelope IS DISTINCT FROM OLD.encrypted_envelope
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.secret_version IS DISTINCT FROM OLD.secret_version
     OR NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Customer webhook signing-secret envelope is immutable'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saas_customer_webhook_secrets_envelope_immutable
  BEFORE UPDATE ON saas_customer_webhook_signing_secrets
  FOR EACH ROW EXECUTE FUNCTION saas_customer_webhook_secret_envelope_immutable();
CREATE TRIGGER saas_customer_webhook_secrets_no_delete
  BEFORE DELETE ON saas_customer_webhook_signing_secrets
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_customer_webhook_secrets_no_truncate
  BEFORE TRUNCATE ON saas_customer_webhook_signing_secrets
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();

CREATE TABLE saas_customer_webhook_events (
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  api_key_id uuid,
  service_plan_order_id uuid,
  refund_id uuid,
  request_id uuid,
  project_id uuid,
  request_supply_mode text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT saas_customer_webhook_events_idempotency_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT saas_customer_webhook_events_idempotency_shape CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 255
    AND idempotency_key = btrim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
  ),
  CONSTRAINT saas_customer_webhook_events_type_check CHECK (event_type IN (
    'wallet.low_balance', 'api_key.expiring', 'service_plan_order.status_changed',
    'refund.status_changed', 'request.completed', 'usage.completed', 'platform.maintenance'
  )),
  CONSTRAINT saas_customer_webhook_events_payload_size CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192
  ),
  CONSTRAINT saas_customer_webhook_events_references_shape CHECK (COALESCE((
    (event_type = 'wallet.low_balance'
      AND api_key_id IS NULL AND service_plan_order_id IS NULL AND refund_id IS NULL
      AND request_id IS NULL AND project_id IS NULL AND request_supply_mode IS NULL)
    OR (event_type = 'api_key.expiring'
      AND api_key_id IS NOT NULL AND service_plan_order_id IS NULL AND refund_id IS NULL
      AND request_id IS NULL AND project_id IS NULL AND request_supply_mode IS NULL)
    OR (event_type = 'service_plan_order.status_changed'
      AND api_key_id IS NULL AND service_plan_order_id IS NOT NULL AND refund_id IS NULL
      AND request_id IS NULL AND project_id IS NULL AND request_supply_mode IS NULL)
    OR (event_type = 'refund.status_changed'
      AND api_key_id IS NULL AND service_plan_order_id IS NULL AND refund_id IS NOT NULL
      AND request_id IS NULL AND project_id IS NULL AND request_supply_mode IS NULL)
    OR (event_type IN ('request.completed', 'usage.completed')
      AND api_key_id IS NULL AND service_plan_order_id IS NULL AND refund_id IS NULL
      AND request_id IS NOT NULL AND project_id IS NOT NULL
      AND request_supply_mode IN ('byok','platform'))
    OR (event_type = 'platform.maintenance'
      AND api_key_id IS NULL AND service_plan_order_id IS NULL AND refund_id IS NULL
      AND request_id IS NULL AND project_id IS NULL AND request_supply_mode IS NULL)
  ), FALSE)),
  CONSTRAINT saas_customer_webhook_events_payload_contract CHECK (COALESCE((
    (event_type = 'wallet.low_balance'
      AND payload ?& ARRAY['supply_mode','balance_minor_units','threshold_minor_units','currency']
      AND payload - ARRAY['supply_mode','balance_minor_units','threshold_minor_units','currency'] = '{}'::jsonb
      AND payload ->> 'supply_mode' = 'platform'
      AND jsonb_typeof(payload -> 'balance_minor_units') = 'number'
      AND payload ->> 'balance_minor_units' ~ '^(0|[1-9][0-9]{0,15})$'
      AND jsonb_typeof(payload -> 'threshold_minor_units') = 'number'
      AND payload ->> 'threshold_minor_units' ~ '^[1-9][0-9]{0,15}$'
      AND (payload ->> 'balance_minor_units')::numeric <= (payload ->> 'threshold_minor_units')::numeric
      AND (payload ->> 'balance_minor_units')::numeric <= 9007199254740991
      AND (payload ->> 'threshold_minor_units')::numeric <= 9007199254740991
      AND payload ->> 'currency' ~ '^[A-Z]{3}$')
    OR (event_type = 'api_key.expiring'
      AND payload ?& ARRAY['api_key_id','expires_at']
      AND payload - ARRAY['api_key_id','expires_at'] = '{}'::jsonb
      AND payload ->> 'api_key_id' = api_key_id::text
      AND jsonb_typeof(payload -> 'expires_at') = 'string'
      AND payload ->> 'expires_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$')
    OR (event_type = 'service_plan_order.status_changed'
      AND payload ?& ARRAY['service_plan_order_id','status']
      AND payload - ARRAY['service_plan_order_id','status'] = '{}'::jsonb
      AND payload ->> 'service_plan_order_id' = service_plan_order_id::text
      AND payload ->> 'status' IN ('pending','paid','fulfilling','fulfilled','cancelled','reconciliation_pending'))
    OR (event_type = 'refund.status_changed'
      AND payload ?& ARRAY['refund_id','status','amount_minor_units','currency']
      AND payload - ARRAY['refund_id','status','amount_minor_units','currency'] = '{}'::jsonb
      AND payload ->> 'refund_id' = refund_id::text
      AND payload ->> 'status' IN ('submitting','pending','succeeded','failed','unknown','blocked')
      AND jsonb_typeof(payload -> 'amount_minor_units') = 'number'
      AND payload ->> 'amount_minor_units' ~ '^[1-9][0-9]{0,15}$'
      AND (payload ->> 'amount_minor_units')::numeric <= 9007199254740991
      AND payload ->> 'currency' ~ '^[A-Z]{3}$')
    OR (event_type = 'request.completed'
      AND payload ?& ARRAY['request_id','project_id','supply_mode','status','duration_ms']
      AND payload - ARRAY['request_id','project_id','supply_mode','status','duration_ms'] = '{}'::jsonb
      AND payload ->> 'request_id' = request_id::text AND payload ->> 'project_id' = project_id::text
      AND payload ->> 'supply_mode' IN ('byok','platform')
      AND payload ->> 'supply_mode' = request_supply_mode
      AND payload ->> 'status' IN ('succeeded','failed')
      AND jsonb_typeof(payload -> 'duration_ms') = 'number'
      AND payload ->> 'duration_ms' ~ '^(0|[1-9][0-9]{0,8})$'
      AND (payload ->> 'duration_ms')::numeric <= 86400000)
    OR (event_type = 'usage.completed'
      AND payload ?& ARRAY['request_id','project_id','supply_mode','input_tokens','output_tokens','total_tokens']
      AND payload - ARRAY['request_id','project_id','supply_mode','input_tokens','output_tokens','total_tokens'] = '{}'::jsonb
      AND payload ->> 'request_id' = request_id::text AND payload ->> 'project_id' = project_id::text
      AND payload ->> 'supply_mode' IN ('byok','platform')
      AND payload ->> 'supply_mode' = request_supply_mode
      AND jsonb_typeof(payload -> 'input_tokens') = 'number'
      AND payload ->> 'input_tokens' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (payload ->> 'input_tokens')::numeric <= 9007199254740991
      AND jsonb_typeof(payload -> 'output_tokens') = 'number'
      AND payload ->> 'output_tokens' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (payload ->> 'output_tokens')::numeric <= 9007199254740991
      AND jsonb_typeof(payload -> 'total_tokens') = 'number'
      AND payload ->> 'total_tokens' ~ '^(0|[1-9][0-9]{0,15})$'
      AND (payload ->> 'total_tokens')::numeric <= 9007199254740991
      AND (payload ->> 'input_tokens')::numeric + (payload ->> 'output_tokens')::numeric = (payload ->> 'total_tokens')::numeric)
    OR (event_type = 'platform.maintenance'
      AND payload ?& ARRAY['starts_at','ends_at','impact']
      AND payload - ARRAY['starts_at','ends_at','impact'] = '{}'::jsonb
      AND payload ->> 'starts_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
      AND payload ->> 'ends_at' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
      AND (payload ->> 'ends_at')::timestamptz > (payload ->> 'starts_at')::timestamptz
      AND payload ->> 'impact' IN ('none','degraded','outage'))
  ), FALSE)),
  CONSTRAINT saas_customer_webhook_events_api_key_fk
    FOREIGN KEY (tenant_id, api_key_id) REFERENCES saas_api_keys (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_events_service_order_fk
    FOREIGN KEY (tenant_id, service_plan_order_id) REFERENCES saas_service_plan_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_events_refund_fk
    FOREIGN KEY (tenant_id, refund_id) REFERENCES saas_refund_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_events_request_fk
    FOREIGN KEY (tenant_id, request_id, project_id, request_supply_mode)
    REFERENCES saas_requests (tenant_id, id, project_id, supply_mode) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_events_project_fk
    FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX saas_customer_webhook_events_tenant_time_idx
  ON saas_customer_webhook_events (tenant_id, occurred_at DESC, event_id);
CREATE TRIGGER saas_customer_webhook_events_immutable
  BEFORE UPDATE OR DELETE ON saas_customer_webhook_events
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_customer_webhook_events_no_truncate
  BEFORE TRUNCATE ON saas_customer_webhook_events
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_customer_webhook_endpoint_versions_immutable
  BEFORE UPDATE OR DELETE ON saas_customer_webhook_endpoint_versions
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TRIGGER saas_customer_webhook_endpoint_versions_no_truncate
  BEFORE TRUNCATE ON saas_customer_webhook_endpoint_versions
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();

CREATE TABLE saas_customer_webhook_deliveries (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  event_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  endpoint_version integer NOT NULL,
  secret_version integer NOT NULL,
  overlap_secret_version integer,
  payload_version integer NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','delivered','dead_lettered','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 12),
  attempt_sequence integer NOT NULL DEFAULT 0 CHECK (attempt_sequence BETWEEN 0 AND 120),
  replay_count integer NOT NULL DEFAULT 0 CHECK (replay_count BETWEEN 0 AND 9),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  last_http_status smallint CHECK (last_http_status BETWEEN 100 AND 599),
  last_latency_ms integer CHECK (last_latency_ms BETWEEN 0 AND 300000),
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT saas_customer_webhook_deliveries_event_endpoint_unique UNIQUE (tenant_id, event_id, endpoint_id),
  CONSTRAINT saas_customer_webhook_deliveries_event_fk
    FOREIGN KEY (tenant_id, event_id) REFERENCES saas_customer_webhook_events (tenant_id, event_id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_deliveries_endpoint_version_fk
    FOREIGN KEY (tenant_id, endpoint_id, endpoint_version)
    REFERENCES saas_customer_webhook_endpoint_versions (tenant_id, endpoint_id, version) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_deliveries_secret_fk
    FOREIGN KEY (tenant_id, endpoint_id, secret_version)
    REFERENCES saas_customer_webhook_signing_secrets (tenant_id, endpoint_id, secret_version) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_deliveries_overlap_secret_fk
    FOREIGN KEY (tenant_id, endpoint_id, overlap_secret_version)
    REFERENCES saas_customer_webhook_signing_secrets (tenant_id, endpoint_id, secret_version) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_deliveries_distinct_secret_versions
    CHECK (overlap_secret_version IS NULL OR overlap_secret_version <> secret_version),
  CONSTRAINT saas_customer_webhook_deliveries_attempt_shape
    CHECK (attempt_sequence >= attempt_count AND replay_count <= 9),
  CONSTRAINT saas_customer_webhook_deliveries_lease_shape CHECK (
    (state = 'leased' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND fencing_token > 0)
    OR (state <> 'leased' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT saas_customer_webhook_deliveries_delivered_shape CHECK (
    (state = 'delivered' AND delivered_at IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at IS NULL)
  )
);
CREATE INDEX saas_customer_webhook_deliveries_claim_idx
  ON saas_customer_webhook_deliveries (available_at, created_at, id)
  WHERE state IN ('pending','leased');
CREATE INDEX saas_customer_webhook_deliveries_tenant_history_idx
  ON saas_customer_webhook_deliveries (tenant_id, endpoint_id, created_at DESC);
CREATE INDEX saas_customer_webhook_deliveries_terminal_retention_idx
  ON saas_customer_webhook_deliveries (updated_at, tenant_id, id)
  WHERE state IN ('delivered','dead_lettered','cancelled');

CREATE FUNCTION saas_customer_webhook_delivery_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.endpoint_version IS DISTINCT FROM OLD.endpoint_version
     OR NEW.secret_version IS DISTINCT FROM OLD.secret_version
     OR NEW.overlap_secret_version IS DISTINCT FROM OLD.overlap_secret_version
     OR NEW.payload_version IS DISTINCT FROM OLD.payload_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Customer webhook delivery snapshots are immutable'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saas_customer_webhook_deliveries_snapshot_immutable
  BEFORE UPDATE ON saas_customer_webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION saas_customer_webhook_delivery_snapshot_immutable();

CREATE TABLE saas_customer_webhook_delivery_attempts (
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt_sequence integer NOT NULL CHECK (attempt_sequence BETWEEN 1 AND 120),
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  lease_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('started','delivered','retrying','dead_lettered')),
  http_status smallint CHECK (http_status BETWEEN 100 AND 599),
  latency_ms integer CHECK (latency_ms BETWEEN 0 AND 300000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (tenant_id, delivery_id, attempt_sequence),
  UNIQUE (tenant_id, delivery_id, fencing_token),
  CONSTRAINT saas_customer_webhook_attempts_delivery_fk
    FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES saas_customer_webhook_deliveries (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_customer_webhook_attempts_terminal_shape CHECK (
    (state = 'started' AND finished_at IS NULL)
    OR (state <> 'started' AND finished_at IS NOT NULL)
  ),
  CONSTRAINT saas_customer_webhook_attempts_result_shape CHECK (
    (state = 'delivered' AND http_status BETWEEN 200 AND 299 AND error_code IS NULL)
    OR (state IN ('retrying','dead_lettered') AND error_code IS NOT NULL)
    OR (state = 'started' AND http_status IS NULL AND latency_ms IS NULL AND error_code IS NULL)
  )
);
CREATE INDEX saas_customer_webhook_attempts_history_idx
  ON saas_customer_webhook_delivery_attempts (tenant_id, delivery_id, attempt_sequence DESC);

CREATE FUNCTION saas_customer_webhook_attempt_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     OR OLD.state <> 'started'
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
     OR NEW.attempt_sequence IS DISTINCT FROM OLD.attempt_sequence
     OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
     OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.state NOT IN ('delivered','retrying','dead_lettered')
     OR NEW.finished_at IS NULL THEN
    RAISE EXCEPTION 'Customer webhook delivery attempts are append-only'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER saas_customer_webhook_attempts_transition_guard
  BEFORE UPDATE ON saas_customer_webhook_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_customer_webhook_attempt_transition_guard();
CREATE TRIGGER saas_customer_webhook_attempts_no_truncate
  BEFORE TRUNCATE ON saas_customer_webhook_delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION saas_reject_immutable_change();
`;

export const CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION: SaasMigration = {
  version: 43,
  name: 'customer_webhook_delivery',
  sql: customerWebhookDeliverySql,
};
