import type { SaasMigration } from './001_initial_schema.js';

/**
 * Durable unknown-outcome scanner claims, tenant-scoped operator cases, and
 * append-only observations. Runtime access is granted to the control-plane
 * workload; the commercial gateway has no access to these relations.
 */
const unknownOutcomeReconciliationSchemaSql = `
CREATE TABLE saas_unknown_outcome_reconciliation_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_id uuid NOT NULL,
  supply_mode text NOT NULL CHECK (supply_mode IN ('byok', 'platform')),
  case_state text NOT NULL DEFAULT 'open'
    CHECK (case_state IN ('open', 'operator_required', 'resolved', 'superseded')),
  scan_attempt_count integer NOT NULL DEFAULT 0
    CHECK (scan_attempt_count BETWEEN 0 AND 12),
  next_attempt_at timestamptz,
  lease_token text,
  lease_expires_at timestamptz,
  last_error_code text,
  resolution_idempotency_key text,
  resolution_digest text,
  resolution_actor_user_id uuid,
  resolution_reason text,
  resolution_evidence_digest text,
  resolution_audit_event_id uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_unknown_outcome_cases_tenant_request_unique UNIQUE (tenant_id, request_id),
  CONSTRAINT saas_unknown_outcome_cases_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT saas_unknown_outcome_cases_tenant_id_request_unique UNIQUE (tenant_id, id, request_id),
  CONSTRAINT saas_unknown_outcome_cases_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_cases_project_fk
    FOREIGN KEY (tenant_id, project_id) REFERENCES saas_projects (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_cases_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES saas_requests (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_cases_actor_fk
    FOREIGN KEY (resolution_actor_user_id) REFERENCES saas_users (id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_cases_audit_fk
    FOREIGN KEY (resolution_audit_event_id) REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_cases_lease_shape CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (case_state = 'open' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT saas_unknown_outcome_cases_due_shape CHECK (
    (case_state = 'open' AND next_attempt_at IS NOT NULL)
    OR (case_state <> 'open' AND next_attempt_at IS NULL)
  ),
  CONSTRAINT saas_unknown_outcome_cases_lease_token_check CHECK (
    lease_token IS NULL OR (char_length(lease_token) BETWEEN 1 AND 255 AND btrim(lease_token) = lease_token)
  ),
  CONSTRAINT saas_unknown_outcome_cases_error_code_check CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  CONSTRAINT saas_unknown_outcome_cases_resolution_shape CHECK (
    (case_state = 'resolved'
      AND resolution_idempotency_key IS NOT NULL
      AND resolution_digest IS NOT NULL
      AND resolution_digest ~ '^[0-9a-f]{64}$'
      AND resolution_actor_user_id IS NOT NULL
      AND btrim(COALESCE(resolution_reason, '')) <> ''
      AND resolution_evidence_digest IS NOT NULL
      AND resolution_evidence_digest ~ '^[0-9a-f]{64}$'
      AND resolution_audit_event_id IS NOT NULL
      AND resolved_at IS NOT NULL
      AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (case_state <> 'resolved'
      AND resolution_idempotency_key IS NULL
      AND resolution_digest IS NULL
      AND resolution_actor_user_id IS NULL
      AND resolution_reason IS NULL
      AND resolution_evidence_digest IS NULL
      AND resolution_audit_event_id IS NULL
      AND resolved_at IS NULL)
  ),
  CONSTRAINT saas_unknown_outcome_cases_resolution_key_check CHECK (
    resolution_idempotency_key IS NULL OR
    (char_length(resolution_idempotency_key) BETWEEN 1 AND 255
      AND btrim(resolution_idempotency_key) = resolution_idempotency_key)
  ),
  CONSTRAINT saas_unknown_outcome_cases_resolution_reason_check CHECK (
    resolution_reason IS NULL OR char_length(resolution_reason) <= 2000
  )
);

CREATE UNIQUE INDEX saas_unknown_outcome_cases_resolution_key_unique
  ON saas_unknown_outcome_reconciliation_cases (tenant_id, resolution_idempotency_key)
  WHERE resolution_idempotency_key IS NOT NULL;
CREATE INDEX saas_unknown_outcome_cases_due_idx
  ON saas_unknown_outcome_reconciliation_cases (next_attempt_at, created_at, id)
  WHERE case_state = 'open';
CREATE INDEX saas_unknown_outcome_cases_expired_lease_idx
  ON saas_unknown_outcome_reconciliation_cases (lease_expires_at, id)
  WHERE case_state = 'open' AND lease_token IS NOT NULL;
CREATE INDEX saas_unknown_outcome_cases_operator_queue_idx
  ON saas_unknown_outcome_reconciliation_cases (tenant_id, created_at, id)
  WHERE case_state = 'operator_required';

CREATE TABLE saas_unknown_outcome_reconciliation_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempt_id uuid,
  usage_event_id uuid,
  observation_kind text NOT NULL CHECK (
    observation_kind IN (
      'request_snapshot', 'attempt_snapshot', 'usage_snapshot',
      'operator_resolution', 'provider_evidence'
    )
  ),
  supply_mode text CHECK (supply_mode IN ('byok', 'platform')),
  execution_state text CHECK (execution_state IN ('pending', 'succeeded', 'failed', 'unknown')),
  reconciliation_state text CHECK (reconciliation_state IN ('none', 'pending', 'resolved')),
  financial_status text CHECK (
    financial_status IN ('not_applicable', 'pending', 'settled', 'released', 'reconciliation_pending')
  ),
  request_state_version bigint CHECK (request_state_version IS NULL OR request_state_version >= 1),
  dispatch_state text CHECK (dispatch_state IN ('not_sent', 'dispatching', 'sent', 'unknown')),
  result_state text CHECK (result_state IN ('pending', 'succeeded', 'failed', 'unknown')),
  response_started boolean,
  attempt_state_version bigint CHECK (attempt_state_version IS NULL OR attempt_state_version >= 1),
  upstream_id text,
  account_owner_kind text CHECK (account_owner_kind IS NULL OR account_owner_kind IN ('tenant', 'platform')),
  account_id text,
  provider_id text,
  product_id text,
  resolved_model text,
  attempt_unknown_reason text,
  usage_event_digest text CHECK (usage_event_digest IS NULL OR usage_event_digest ~ '^[0-9a-f]{64}$'),
  provider_status text CHECK (
    provider_status IS NULL OR provider_status IN ('completed', 'pending', 'ambiguous', 'provider_unavailable', 'not_found', 'invalid')
  ),
  provider_operation_id text,
  provider_identity_digest text CHECK (
    provider_identity_digest IS NULL OR provider_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  provider_usage jsonb,
  evidence_reference text,
  operator_outcome text CHECK (operator_outcome IS NULL OR operator_outcome = 'not_executed'),
  actor_user_id uuid,
  reason text,
  audit_event_id uuid,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_unknown_outcome_observations_tenant_case_fk
    FOREIGN KEY (tenant_id, case_id, request_id)
    REFERENCES saas_unknown_outcome_reconciliation_cases (tenant_id, id, request_id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_observations_request_fk
    FOREIGN KEY (tenant_id, request_id) REFERENCES saas_requests (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_observations_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id) REFERENCES saas_attempts (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_observations_usage_fk
    FOREIGN KEY (tenant_id, usage_event_id) REFERENCES saas_usage_events (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_observations_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES saas_users (id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_observations_audit_fk
    FOREIGN KEY (audit_event_id) REFERENCES saas_audit_events (id) ON DELETE RESTRICT,
  CONSTRAINT saas_unknown_outcome_observations_reference_check CHECK (
    evidence_reference IS NULL OR
    (char_length(evidence_reference) BETWEEN 1 AND 512 AND btrim(evidence_reference) = evidence_reference)
  ),
  CONSTRAINT saas_unknown_outcome_observations_reason_check CHECK (
    reason IS NULL OR (char_length(reason) BETWEEN 1 AND 2000 AND btrim(reason) = reason)
  ),
  CONSTRAINT saas_unknown_outcome_observations_attempt_reason_check CHECK (
    attempt_unknown_reason IS NULL OR char_length(attempt_unknown_reason) <= 1024
  ),
  CONSTRAINT saas_unknown_outcome_observations_provider_payload_check CHECK (
    (provider_status IS NULL AND provider_operation_id IS NULL
      AND provider_identity_digest IS NULL AND provider_usage IS NULL)
    OR (provider_status IS NOT NULL
      AND (provider_usage IS NULL OR jsonb_typeof(provider_usage) = 'object')
      AND octet_length(COALESCE(provider_usage::text, '')) <= 2048)
  ),
  CONSTRAINT saas_unknown_outcome_observations_kind_shape CHECK (
    (observation_kind = 'request_snapshot'
      AND attempt_id IS NULL AND usage_event_id IS NULL
      AND execution_state IS NOT NULL AND reconciliation_state IS NOT NULL
      AND financial_status IS NOT NULL AND supply_mode IS NOT NULL
      AND request_state_version IS NOT NULL)
    OR (observation_kind = 'attempt_snapshot'
      AND attempt_id IS NOT NULL AND usage_event_id IS NULL
      AND dispatch_state IS NOT NULL AND result_state IS NOT NULL
      AND response_started IS NOT NULL AND attempt_state_version IS NOT NULL)
    OR (observation_kind = 'usage_snapshot'
      AND attempt_id IS NOT NULL AND usage_event_id IS NOT NULL
      AND usage_event_digest IS NOT NULL)
    OR (observation_kind = 'operator_resolution'
      AND attempt_id IS NOT NULL AND usage_event_id IS NULL
      AND evidence_reference IS NOT NULL AND operator_outcome = 'not_executed'
      AND actor_user_id IS NOT NULL AND reason IS NOT NULL AND audit_event_id IS NOT NULL)
    OR (observation_kind = 'provider_evidence'
      AND attempt_id IS NOT NULL AND usage_event_id IS NULL AND provider_status IS NOT NULL)
  )
);

CREATE INDEX saas_unknown_outcome_observations_tenant_case_idx
  ON saas_unknown_outcome_reconciliation_observations (tenant_id, case_id, observed_at, id);
CREATE INDEX saas_unknown_outcome_observations_request_idx
  ON saas_unknown_outcome_reconciliation_observations (tenant_id, request_id, observed_at, id);

CREATE TRIGGER saas_unknown_outcome_observations_immutable
  BEFORE UPDATE OR DELETE ON saas_unknown_outcome_reconciliation_observations
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();

CREATE FUNCTION saas_guard_unknown_outcome_case_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.supply_mode IS DISTINCT FROM NEW.supply_mode
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Unknown-outcome case identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.case_state IN ('resolved', 'superseded') AND NEW.case_state IS DISTINCT FROM OLD.case_state THEN
    RAISE EXCEPTION 'Terminal unknown-outcome case cannot be reopened' USING ERRCODE = '55000';
  END IF;
  IF OLD.case_state = 'open' AND NEW.case_state NOT IN ('open', 'operator_required', 'superseded') THEN
    RAISE EXCEPTION 'Unknown-outcome case has an invalid transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.case_state = 'operator_required' AND NEW.case_state NOT IN ('operator_required', 'resolved') THEN
    RAISE EXCEPTION 'Operator-required unknown-outcome case cannot be rescanned' USING ERRCODE = '55000';
  END IF;
  IF NEW.scan_attempt_count < OLD.scan_attempt_count THEN
    RAISE EXCEPTION 'Unknown-outcome scan attempts cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF OLD.resolution_idempotency_key IS NOT NULL AND (
    NEW.resolution_idempotency_key IS DISTINCT FROM OLD.resolution_idempotency_key
    OR NEW.resolution_digest IS DISTINCT FROM OLD.resolution_digest
    OR NEW.resolution_actor_user_id IS DISTINCT FROM OLD.resolution_actor_user_id
    OR NEW.resolution_reason IS DISTINCT FROM OLD.resolution_reason
    OR NEW.resolution_evidence_digest IS DISTINCT FROM OLD.resolution_evidence_digest
    OR NEW.resolution_audit_event_id IS DISTINCT FROM OLD.resolution_audit_event_id
    OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
  ) THEN
    RAISE EXCEPTION 'Unknown-outcome resolution is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Unknown-outcome case timestamp cannot move backwards' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_unknown_outcome_cases_guard_update
  BEFORE UPDATE ON saas_unknown_outcome_reconciliation_cases
  FOR EACH ROW EXECUTE FUNCTION saas_guard_unknown_outcome_case_update();
`;

export const UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION: SaasMigration = {
  version: 49,
  name: 'unknown_outcome_reconciliation_cases_and_observations',
  sql: unknownOutcomeReconciliationSchemaSql,
};
