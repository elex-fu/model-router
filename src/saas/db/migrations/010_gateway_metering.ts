import type { SaasMigration } from './001_initial_schema.js';

/*
 * This migration deliberately stores authorization snapshots on the request.
 * It does not join or foreign-key those snapshots to entitlement/profile/key
 * state that may be versioned by later migrations.  The only key relationship
 * is the baseline tenant/project/key ownership tuple, made unique here so the
 * request FK cannot cross tenant boundaries.
 */
const gatewayMeteringSchemaSql = `
ALTER TABLE saas_api_keys
  ADD CONSTRAINT saas_api_keys_tenant_project_id_unique
  UNIQUE (tenant_id, project_id, id);
ALTER TABLE saas_api_keys
  ADD CONSTRAINT saas_api_keys_tenant_id_unique
  UNIQUE (tenant_id, id);

CREATE TABLE saas_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL,
  proxy_key_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  supply_profile_id text NOT NULL,
  supply_profile_version bigint NOT NULL CHECK (supply_profile_version >= 1),
  model_scope_version bigint NOT NULL CHECK (model_scope_version >= 1),
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  principal_kind text NOT NULL CHECK (principal_kind IN ('member', 'project_service')),
  principal_id uuid NOT NULL,
  authz_version bigint NOT NULL CHECK (authz_version >= 1),
  entitlement_version bigint NOT NULL CHECK (entitlement_version >= 1),
  config_version bigint NOT NULL CHECK (config_version >= 1),
  public_model text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  endpoint text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_fingerprint_version text NOT NULL,
  customer_price_version text,
  execution_state text NOT NULL DEFAULT 'pending'
    CHECK (execution_state IN ('pending', 'succeeded', 'failed', 'unknown')),
  financial_status text NOT NULL
    CHECK (financial_status IN ('not_applicable', 'pending', 'settled', 'released', 'reconciliation_pending')),
  reconciliation_state text NOT NULL DEFAULT 'none'
    CHECK (reconciliation_state IN ('none', 'pending', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  CONSTRAINT saas_requests_project_fk
    FOREIGN KEY (tenant_id, project_id)
    REFERENCES saas_projects (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_requests_proxy_key_fk
    FOREIGN KEY (tenant_id, project_id, proxy_key_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_requests_text_nonempty CHECK (
    btrim(supply_profile_id) <> ''
    AND btrim(public_model) <> ''
    AND btrim(endpoint) <> ''
    AND btrim(request_fingerprint_version) <> ''
  ),
  CONSTRAINT saas_requests_financial_mode CHECK (
    (supply_mode = 'byok' AND financial_status = 'not_applicable')
    OR (supply_mode = 'platform' AND financial_status <> 'not_applicable')
  ),
  CONSTRAINT saas_requests_unknown_requires_reconciliation CHECK (
    (execution_state <> 'unknown' OR reconciliation_state = 'pending')
    AND (reconciliation_state <> 'resolved' OR execution_state <> 'unknown')
  ),
  CONSTRAINT saas_requests_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX saas_requests_tenant_created_idx
  ON saas_requests (tenant_id, created_at ASC, id ASC);
CREATE INDEX saas_requests_tenant_project_created_idx
  ON saas_requests (tenant_id, project_id, created_at ASC, id ASC);
CREATE INDEX saas_requests_tenant_proxy_created_idx
  ON saas_requests (tenant_id, proxy_key_id, created_at ASC, id ASC);

CREATE TABLE saas_idempotency_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id) ON DELETE RESTRICT,
  proxy_key_id uuid NOT NULL,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  request_fingerprint_version text NOT NULL,
  request_id uuid,
  kind text NOT NULL CHECK (kind IN ('active', 'tombstone')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_idempotency_proxy_key_fk
    FOREIGN KEY (tenant_id, proxy_key_id)
    REFERENCES saas_api_keys (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_idempotency_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_idempotency_kind_request CHECK (
    (kind = 'active' AND request_id IS NOT NULL)
    OR (kind = 'tombstone' AND request_id IS NULL)
  ),
  CONSTRAINT saas_idempotency_fingerprint_version_nonempty CHECK (btrim(request_fingerprint_version) <> ''),
  CONSTRAINT saas_idempotency_scope_unique UNIQUE (tenant_id, proxy_key_id, key_digest)
);

CREATE INDEX saas_idempotency_tenant_created_idx
  ON saas_idempotency_records (tenant_id, created_at ASC, id ASC);

CREATE TABLE saas_attempts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  upstream_id text NOT NULL,
  resolved_model text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai', 'gemini', 'responses')),
  supplier_cost_version text,
  dispatch_state text NOT NULL DEFAULT 'not_sent'
    CHECK (dispatch_state IN ('not_sent', 'dispatching', 'sent', 'unknown')),
  result_state text NOT NULL DEFAULT 'pending'
    CHECK (result_state IN ('pending', 'succeeded', 'failed', 'unknown')),
  response_started boolean NOT NULL DEFAULT false,
  response_started_at timestamptz,
  result_http_status integer,
  unknown_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  state_version bigint NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  CONSTRAINT saas_attempts_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempts_text_nonempty CHECK (
    btrim(upstream_id) <> '' AND btrim(resolved_model) <> ''
  ),
  CONSTRAINT saas_attempts_status_consistency CHECK (
    (dispatch_state = 'not_sent' AND result_state = 'pending' AND response_started = false)
    OR dispatch_state <> 'not_sent'
  ),
  CONSTRAINT saas_attempts_unknown_reason CHECK (
    ((dispatch_state = 'unknown' OR result_state = 'unknown') AND btrim(COALESCE(unknown_reason, '')) <> '')
    OR (dispatch_state <> 'unknown' AND result_state <> 'unknown' AND unknown_reason IS NULL)
  ),
  CONSTRAINT saas_attempts_response_started_at CHECK (
    (response_started = false AND response_started_at IS NULL)
    OR (response_started = true AND response_started_at IS NOT NULL)
  ),
  CONSTRAINT saas_attempts_http_status CHECK (
    result_http_status IS NULL OR result_http_status BETWEEN 100 AND 599
  ),
  CONSTRAINT saas_attempts_request_ordinal_unique UNIQUE (tenant_id, request_id, ordinal),
  CONSTRAINT saas_attempts_tenant_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX saas_attempts_tenant_request_ordinal_idx
  ON saas_attempts (tenant_id, request_id, ordinal ASC);

CREATE TABLE saas_usage_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  dedupe_key_digest text NOT NULL CHECK (dedupe_key_digest ~ '^[0-9a-f]{64}$'),
  event_digest text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  input_total bigint CHECK (input_total IS NULL OR input_total >= 0),
  input_uncached bigint CHECK (input_uncached IS NULL OR input_uncached >= 0),
  cache_read bigint CHECK (cache_read IS NULL OR cache_read >= 0),
  cache_write bigint CHECK (cache_write IS NULL OR cache_write >= 0),
  cache_write_5m bigint CHECK (cache_write_5m IS NULL OR cache_write_5m >= 0),
  cache_write_1h bigint CHECK (cache_write_1h IS NULL OR cache_write_1h >= 0),
  output_total bigint CHECK (output_total IS NULL OR output_total >= 0),
  reasoning_output bigint CHECK (reasoning_output IS NULL OR reasoning_output >= 0),
  status text NOT NULL CHECK (status IN ('reported', 'partial', 'missing', 'estimated')),
  source text NOT NULL CHECK (source IN ('upstream', 'local-estimate', 'legacy')),
  semantics_version text NOT NULL,
  measurement_kind text NOT NULL CHECK (measurement_kind IN ('snapshot', 'delta')),
  billable_basis text NOT NULL CHECK (billable_basis IN ('exact', 'estimated', 'unknown', 'not_billable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_usage_events_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_usage_events_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_usage_events_semantics_nonempty CHECK (btrim(semantics_version) <> ''),
  CONSTRAINT saas_usage_events_scope_unique UNIQUE (tenant_id, id),
  CONSTRAINT saas_usage_events_dedupe_unique UNIQUE (tenant_id, attempt_id, dedupe_key_digest)
);

CREATE INDEX saas_usage_events_tenant_request_created_idx
  ON saas_usage_events (tenant_id, request_id, created_at ASC, id ASC);

CREATE TABLE saas_usage_settlements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  usage_event_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  settlement_key_digest text NOT NULL CHECK (settlement_key_digest ~ '^[0-9a-f]{64}$'),
  settlement_digest text NOT NULL CHECK (settlement_digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('usage_recorded', 'platform_cost_observed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_usage_settlements_usage_fk
    FOREIGN KEY (tenant_id, usage_event_id)
    REFERENCES saas_usage_events (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_usage_settlements_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES saas_requests (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_usage_settlements_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_usage_settlements_usage_unique UNIQUE (tenant_id, usage_event_id),
  CONSTRAINT saas_usage_settlements_key_unique UNIQUE (tenant_id, settlement_key_digest),
  CONSTRAINT saas_usage_settlements_scope_unique UNIQUE (tenant_id, id)
);

CREATE FUNCTION saas_metering_reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SaaS metering facts are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION saas_metering_guard_request_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.proxy_key_id IS DISTINCT FROM NEW.proxy_key_id
    OR OLD.entitlement_id IS DISTINCT FROM NEW.entitlement_id
    OR OLD.supply_profile_id IS DISTINCT FROM NEW.supply_profile_id
    OR OLD.supply_profile_version IS DISTINCT FROM NEW.supply_profile_version
    OR OLD.model_scope_version IS DISTINCT FROM NEW.model_scope_version
    OR OLD.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR OLD.principal_kind IS DISTINCT FROM NEW.principal_kind
    OR OLD.principal_id IS DISTINCT FROM NEW.principal_id
    OR OLD.authz_version IS DISTINCT FROM NEW.authz_version
    OR OLD.entitlement_version IS DISTINCT FROM NEW.entitlement_version
    OR OLD.config_version IS DISTINCT FROM NEW.config_version
    OR OLD.public_model IS DISTINCT FROM NEW.public_model
    OR OLD.protocol IS DISTINCT FROM NEW.protocol
    OR OLD.endpoint IS DISTINCT FROM NEW.endpoint
    OR OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
    OR OLD.request_fingerprint_version IS DISTINCT FROM NEW.request_fingerprint_version
    OR OLD.customer_price_version IS DISTINCT FROM NEW.customer_price_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'SaaS request facts are immutable' USING ERRCODE = '55000';
  END IF;

  IF NOT (
    OLD.execution_state = NEW.execution_state
    OR (OLD.execution_state = 'pending' AND NEW.execution_state IN ('succeeded', 'failed', 'unknown'))
    OR (OLD.execution_state = 'unknown' AND NEW.execution_state IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Invalid SaaS request execution transition' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD.reconciliation_state = NEW.reconciliation_state
    OR (OLD.reconciliation_state = 'none' AND NEW.reconciliation_state = 'pending')
    OR (OLD.reconciliation_state = 'pending' AND NEW.reconciliation_state = 'resolved')
  ) THEN
    RAISE EXCEPTION 'Invalid SaaS request reconciliation transition' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD.financial_status = NEW.financial_status
    OR (OLD.financial_status = 'pending' AND NEW.financial_status IN ('settled', 'released', 'reconciliation_pending'))
    OR (OLD.financial_status = 'reconciliation_pending' AND NEW.financial_status IN ('settled', 'released'))
  ) THEN
    RAISE EXCEPTION 'Invalid SaaS request financial transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.execution_state = 'unknown' AND NEW.reconciliation_state <> 'pending' THEN
    RAISE EXCEPTION 'Unknown SaaS request execution requires reconciliation' USING ERRCODE = '55000';
  END IF;
  IF OLD.execution_state = 'unknown'
    AND NEW.execution_state <> 'unknown'
    AND NEW.reconciliation_state <> 'resolved' THEN
    RAISE EXCEPTION 'Resolving an unknown SaaS request requires reconciliation evidence'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'SaaS request state updates require a monotonic version and timestamp'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_metering_guard_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
    OR OLD.upstream_id IS DISTINCT FROM NEW.upstream_id
    OR OLD.resolved_model IS DISTINCT FROM NEW.resolved_model
    OR OLD.protocol IS DISTINCT FROM NEW.protocol
    OR OLD.supplier_cost_version IS DISTINCT FROM NEW.supplier_cost_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'SaaS attempt observations are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD.dispatch_state = NEW.dispatch_state
    OR (OLD.dispatch_state = 'not_sent' AND NEW.dispatch_state = 'dispatching')
    OR (OLD.dispatch_state = 'dispatching' AND NEW.dispatch_state IN ('not_sent', 'sent', 'unknown'))
    OR (OLD.dispatch_state = 'sent' AND NEW.dispatch_state = 'unknown')
    OR (OLD.dispatch_state = 'unknown' AND NEW.dispatch_state IN ('not_sent', 'sent'))
  ) THEN
    RAISE EXCEPTION 'Invalid SaaS attempt dispatch transition' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    OLD.result_state = NEW.result_state
    OR (OLD.result_state = 'pending' AND NEW.result_state IN ('succeeded', 'failed', 'unknown'))
    OR (OLD.result_state = 'unknown' AND NEW.result_state IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Invalid SaaS attempt result transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.response_started AND NOT NEW.response_started THEN
    RAISE EXCEPTION 'SaaS attempt response_started is monotonic' USING ERRCODE = '55000';
  END IF;
  IF OLD.response_started
    AND NEW.response_started_at IS DISTINCT FROM OLD.response_started_at THEN
    RAISE EXCEPTION 'SaaS attempt response_started_at is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.result_http_status IS NOT NULL
    AND NEW.result_http_status IS DISTINCT FROM OLD.result_http_status THEN
    RAISE EXCEPTION 'SaaS attempt result status is immutable once observed' USING ERRCODE = '55000';
  END IF;
  IF NEW.dispatch_state = 'not_sent' AND (NEW.result_state <> 'pending' OR NEW.response_started) THEN
    RAISE EXCEPTION 'A not-sent SaaS attempt cannot have a result or response' USING ERRCODE = '55000';
  END IF;
  IF NEW.result_state = 'unknown' AND NEW.dispatch_state = 'not_sent' THEN
    RAISE EXCEPTION 'Unknown SaaS attempt result requires a possibly-sent dispatch' USING ERRCODE = '55000';
  END IF;
  IF NEW.result_state IN ('succeeded', 'failed')
    AND NEW.dispatch_state NOT IN ('sent', 'unknown') THEN
    RAISE EXCEPTION 'A terminal SaaS attempt result requires sent or unknown dispatch evidence'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.response_started AND NEW.dispatch_state = 'not_sent' THEN
    RAISE EXCEPTION 'A SaaS attempt response requires dispatch evidence' USING ERRCODE = '55000';
  END IF;
  IF NEW.response_started AND NEW.dispatch_state NOT IN ('sent', 'unknown') THEN
    RAISE EXCEPTION 'A SaaS attempt response requires sent or unknown dispatch evidence'
      USING ERRCODE = '55000';
  END IF;
  IF (NEW.dispatch_state = 'unknown' OR NEW.result_state = 'unknown')
    AND btrim(COALESCE(NEW.unknown_reason, '')) = '' THEN
    RAISE EXCEPTION 'Unknown SaaS attempt states require a reason' USING ERRCODE = '55000';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'SaaS attempt state updates require a monotonic version and timestamp'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_metering_guard_usage_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attempt_request_id uuid;
  request_supply_mode text;
BEGIN
  SELECT a.request_id, r.supply_mode
    INTO attempt_request_id, request_supply_mode
    FROM saas_attempts a
    JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
   WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.attempt_id;
  IF attempt_request_id IS NULL
    OR attempt_request_id IS DISTINCT FROM NEW.request_id
    OR request_supply_mode IS DISTINCT FROM NEW.supply_mode THEN
    RAISE EXCEPTION 'SaaS usage event scope does not match its request and attempt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_metering_guard_settlement_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  usage_request_id uuid;
  usage_attempt_id uuid;
BEGIN
  SELECT request_id, attempt_id
    INTO usage_request_id, usage_attempt_id
    FROM saas_usage_events
   WHERE tenant_id = NEW.tenant_id AND id = NEW.usage_event_id;
  IF usage_request_id IS NULL
    OR usage_request_id IS DISTINCT FROM NEW.request_id
    OR usage_attempt_id IS DISTINCT FROM NEW.attempt_id THEN
    RAISE EXCEPTION 'SaaS usage settlement scope does not match its usage event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_requests_no_delete
  BEFORE DELETE ON saas_requests
  FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change();
CREATE TRIGGER saas_requests_guard_update
  BEFORE UPDATE ON saas_requests
  FOR EACH ROW EXECUTE FUNCTION saas_metering_guard_request_update();
CREATE TRIGGER saas_idempotency_records_immutable
  BEFORE UPDATE OR DELETE ON saas_idempotency_records
  FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change();
CREATE TRIGGER saas_attempts_no_delete
  BEFORE DELETE ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change();
CREATE TRIGGER saas_attempts_guard_update
  BEFORE UPDATE ON saas_attempts
  FOR EACH ROW EXECUTE FUNCTION saas_metering_guard_attempt_update();
CREATE TRIGGER saas_usage_events_immutable
  BEFORE UPDATE OR DELETE ON saas_usage_events
  FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change();
CREATE TRIGGER saas_usage_events_scope
  BEFORE INSERT ON saas_usage_events
  FOR EACH ROW EXECUTE FUNCTION saas_metering_guard_usage_scope();
CREATE TRIGGER saas_usage_settlements_immutable
  BEFORE UPDATE OR DELETE ON saas_usage_settlements
  FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change();
CREATE TRIGGER saas_usage_settlements_scope
  BEFORE INSERT ON saas_usage_settlements
  FOR EACH ROW EXECUTE FUNCTION saas_metering_guard_settlement_scope();
`;

export const GATEWAY_METERING_SAAS_MIGRATION: SaasMigration = {
  version: 10,
  name: 'gateway_request_attempt_usage_idempotency_metering',
  sql: gatewayMeteringSchemaSql,
};
