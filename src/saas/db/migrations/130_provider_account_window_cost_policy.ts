import type { SaasMigration } from './001_initial_schema.js';

/**
 * Core-plan 9.2 (window three-state, the sub2api CheckWindowCostSchedulability
 * surface): two additive pieces.
 *
 * 1. The per-account window-cost policy — `window_cost_limit_minor_units` and
 *    `window_cost_sticky_reserve_minor_units` on BOTH account tables (the
 *    exact-amount gate is scope-neutral; the control plane freezes these
 *    values, the gateway only reads them). NULL = the gate is OFF for that
 *    account (the unused-by-default red line: no row means every account
 *    schedules exactly as before, fully backward compatible, no backfill).
 *    `limit > 0` and `reserve > 0` are enforced (a zero limit is the same as
 *    OFF, so it is not representable; an empty sticky band is expressed by
 *    setting the limit only — the middle band then never admits).
 *
 * 2. The exact-amount fact the gate consumes — `saas_attempt_supplier_costs`,
 *    one append-only row per settled attempt: the attempt's supplier cost
 *    version, the EXACT computed amount in the supplier currency's minor
 *    units, and the currency. This is the missing half of the metering
 *    pipeline: the customer charge was durable (holds/settlements) but the
 *    supplier side existed only as rates (017) — `calculateUsageSettlement`
 *    computed it and dropped it. The normal-success settlement transaction is
 *    the sole writer (platform supply mode only): it computes the amount from
 *    the attempt's immutable supplier cost rates over the OBSERVED usage in
 *    the same transaction as the customer settlement, so the fact is exactly
 *    as durable as the billing-fact precedent. Append-only via the shared
 *    metering immutability trigger; replay-safe via the (tenant_id,
 *    attempt_id) unique constraint; never referenced by billing (011 ledger
 *    untouched). Account attribution rides saas_attempts' owner-neutral
 *    generated `account_id` (migration 018) — the same join the token
 *    aggregation and the scheduler's rate-window read use; window scoping is
 *    a read-time computation (`schedulingThresholdWindowStartMs`), so no
 *    window column is persisted.
 *
 * Gateway privileges: the account tables are already full-read via the
 * runtime read-table allowlist; the fact table needs INSERT (the settlement
 * writer) and SELECT (the scheduler's window cost aggregation) — added to
 * runtime-privileges.ts along with this migration (the 105/121 re-apply
 * precedent applies until the template is reconciled).
 *
 * Numbered 130: appends after the applied head 129.
 */
const providerAccountWindowCostPolicySql = `
ALTER TABLE saas_tenant_provider_accounts
  ADD COLUMN window_cost_limit_minor_units bigint,
  ADD COLUMN window_cost_sticky_reserve_minor_units bigint,
  ADD CONSTRAINT saas_tenant_provider_accounts_window_cost_limit_positive
    CHECK (window_cost_limit_minor_units IS NULL OR window_cost_limit_minor_units > 0),
  ADD CONSTRAINT saas_tenant_provider_accounts_window_cost_reserve_positive
    CHECK (window_cost_sticky_reserve_minor_units IS NULL OR window_cost_sticky_reserve_minor_units > 0);

ALTER TABLE saas_platform_provider_accounts
  ADD COLUMN window_cost_limit_minor_units bigint,
  ADD COLUMN window_cost_sticky_reserve_minor_units bigint,
  ADD CONSTRAINT saas_platform_provider_accounts_window_cost_limit_positive
    CHECK (window_cost_limit_minor_units IS NULL OR window_cost_limit_minor_units > 0),
  ADD CONSTRAINT saas_platform_provider_accounts_window_cost_reserve_positive
    CHECK (window_cost_sticky_reserve_minor_units IS NULL OR window_cost_sticky_reserve_minor_units > 0);

CREATE TABLE saas_attempt_supplier_costs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  supplier_cost_version text NOT NULL,
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_attempt_supplier_costs_tenant_scope_unique UNIQUE (tenant_id, id),
  CONSTRAINT saas_attempt_supplier_costs_attempt_unique UNIQUE (tenant_id, attempt_id),
  CONSTRAINT saas_attempt_supplier_costs_attempt_fk
    FOREIGN KEY (tenant_id, attempt_id)
    REFERENCES saas_attempts (tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempt_supplier_costs_version_fk
    FOREIGN KEY (supplier_cost_version)
    REFERENCES saas_supplier_cost_versions (id)
    ON DELETE RESTRICT,
  CONSTRAINT saas_attempt_supplier_costs_version_nonempty CHECK (
    btrim(supplier_cost_version) <> '' AND char_length(supplier_cost_version) <= 128
  )
);

CREATE INDEX saas_attempt_supplier_costs_created_idx
  ON saas_attempt_supplier_costs (created_at);

CREATE TRIGGER saas_attempt_supplier_costs_immutable
  BEFORE UPDATE OR DELETE ON saas_attempt_supplier_costs
  FOR EACH ROW EXECUTE FUNCTION saas_metering_reject_immutable_change();
`;

export const PROVIDER_ACCOUNT_WINDOW_COST_POLICY_SAAS_MIGRATION: SaasMigration = {
  version: 130,
  name: 'provider_account_window_cost_policy',
  sql: providerAccountWindowCostPolicySql,
};
