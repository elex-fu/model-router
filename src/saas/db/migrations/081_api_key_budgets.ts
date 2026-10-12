import type { SaasMigration } from './001_initial_schema.js';

/**
 * Per-key budget policy heads, lineage counters and per-request budget
 * reservations (contract C-4 / Track A KEY-BUD). One policy row per key holds
 * the current caps revision; replacement is a CAS on the head version performed
 * by the key service under the existing authorization fences (expectedVersion
 * -> version + 1, atomically bumping saas_api_keys.authz_version so cached key
 * authorization is invalidated). A NULL cap is unlimited; a zero cap is finite.
 *
 * Counters attach to the budget LINEAGE, not an individual key: ordinary key
 * rotation inherits the predecessor's lineage_id and caps, so daily/lifetime
 * usage accumulates across rotations. The daily window is the server-selected
 * UTC calendar day; lifetime rows use the DATE '0001-01-01' sentinel because
 * primary key columns cannot be NULL. outstanding_reserved is conservative:
 * it includes retained unknown/reconciliation reservations and is never
 * released by age or TTL, only by an explicit settle/release transition.
 *
 * Per-request reservation rows record the exact reserved amounts and the
 * admission UTC day so settlement/compensation/reconciliation decrement the
 * ORIGINAL window's outstanding counter even when they commit on a later day.
 * Amounts and identity are immutable evidence; state may only move
 * outstanding -> settled/released.
 *
 * Every existing key is backfilled with an unlimited v1 policy whose lineage
 * is the key itself so the CAS expectedVersion always starts at '1' (the
 * frozen version parser rejects '0').
 */
const apiKeyBudgetsSql = `
CREATE TABLE saas_api_key_budget_policies (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  key_id uuid NOT NULL,
  lineage_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  token_daily bigint CHECK (token_daily IS NULL OR token_daily >= 0),
  token_lifetime bigint CHECK (token_lifetime IS NULL OR token_lifetime >= 0),
  charge_daily bigint CHECK (charge_daily IS NULL OR charge_daily >= 0),
  charge_lifetime bigint CHECK (charge_lifetime IS NULL OR charge_lifetime >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_api_key_budget_policies_pk PRIMARY KEY (tenant_id, project_id, key_id),
  CONSTRAINT saas_api_key_budget_policies_key_fk
    FOREIGN KEY (tenant_id, project_id, key_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_key_budget_policies_lineage_fk
    FOREIGN KEY (tenant_id, project_id, lineage_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT
);

INSERT INTO saas_api_key_budget_policies
  (tenant_id, project_id, key_id, lineage_id, version)
SELECT tenant_id, project_id, id, id, 1
FROM saas_api_keys;

CREATE TABLE saas_api_key_budget_counters (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lineage_id uuid NOT NULL,
  window_kind text NOT NULL CHECK (window_kind IN ('daily', 'lifetime')),
  day date NOT NULL,
  token_settled bigint NOT NULL DEFAULT 0 CHECK (token_settled >= 0),
  token_outstanding_reserved bigint NOT NULL DEFAULT 0 CHECK (token_outstanding_reserved >= 0),
  charge_settled bigint NOT NULL DEFAULT 0 CHECK (charge_settled >= 0),
  charge_outstanding_reserved bigint NOT NULL DEFAULT 0 CHECK (charge_outstanding_reserved >= 0),
  charge_currency text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_api_key_budget_counters_pk
    PRIMARY KEY (tenant_id, lineage_id, window_kind, day),
  CONSTRAINT saas_api_key_budget_counters_lineage_fk
    FOREIGN KEY (tenant_id, project_id, lineage_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_key_budget_counters_window_day CHECK (
    (window_kind = 'daily') OR (window_kind = 'lifetime' AND day = DATE '0001-01-01')
  )
);

CREATE TABLE saas_api_key_budget_reservations (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lineage_id uuid NOT NULL,
  request_id uuid NOT NULL,
  day date NOT NULL,
  token_units bigint NOT NULL CHECK (token_units >= 0),
  charge_minor_units bigint NOT NULL CHECK (charge_minor_units >= 0),
  charge_currency text,
  state text NOT NULL DEFAULT 'outstanding'
    CHECK (state IN ('outstanding', 'settled', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_api_key_budget_reservations_pk PRIMARY KEY (tenant_id, request_id),
  CONSTRAINT saas_api_key_budget_reservations_request_fk
    FOREIGN KEY (request_id) REFERENCES saas_requests (id) ON DELETE RESTRICT,
  CONSTRAINT saas_api_key_budget_reservations_lineage_fk
    FOREIGN KEY (tenant_id, project_id, lineage_id)
    REFERENCES saas_api_keys (tenant_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_api_key_budget_reservations_charge_pair CHECK (
    (charge_minor_units = 0 AND charge_currency IS NULL)
    OR (charge_minor_units > 0 AND btrim(charge_currency) <> '')
  )
);

CREATE FUNCTION saas_api_key_budget_reservation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.lineage_id IS DISTINCT FROM NEW.lineage_id
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.day IS DISTINCT FROM NEW.day
    OR OLD.token_units IS DISTINCT FROM NEW.token_units
    OR OLD.charge_minor_units IS DISTINCT FROM NEW.charge_minor_units
    OR OLD.charge_currency IS DISTINCT FROM NEW.charge_currency
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Key budget reservation facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IS DISTINCT FROM NEW.state
    AND NOT (OLD.state = 'outstanding' AND NEW.state IN ('settled', 'released'))
  THEN
    RAISE EXCEPTION 'Invalid key budget reservation state transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Key budget reservation timestamp must be monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_api_key_budget_reservations_guard
  BEFORE UPDATE ON saas_api_key_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION saas_api_key_budget_reservation_guard();

CREATE FUNCTION saas_api_key_budget_reservation_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Key budget reservations must be retained as conservative accounting evidence'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_api_key_budget_reservations_no_delete
  BEFORE DELETE ON saas_api_key_budget_reservations
  FOR EACH ROW EXECUTE FUNCTION saas_api_key_budget_reservation_no_delete();
`;

export const API_KEY_BUDGETS_SAAS_MIGRATION: SaasMigration = {
  version: 81,
  name: 'api_key_budgets',
  sql: apiKeyBudgetsSql,
};
