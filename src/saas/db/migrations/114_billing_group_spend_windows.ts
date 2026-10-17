import type { SaasMigration } from './001_initial_schema.js';

/**
 * R1 billing-group limit enforcement, phase 3 of 4 (roadmap
 * docs/capability-parity-roadmap-2026-10-16.md §1.3): the group
 * daily/weekly/monthly spend windows and the API key 5h/7d USD windows.
 *
 * Group spend (the KEY-BUD reserve-first-then-check pattern at group
 * scope): per-(group, window_kind, window_start) counters hold
 * outstanding_reserved and settled charge; per-request reservation rows
 * record the reserved amount and original window so settlement,
 * compensation, and corrections adjust the ORIGINAL window's counter even
 * when they commit later. Windows are UTC calendar buckets — daily
 * (UTC midnight), weekly (ISO Monday), monthly (UTC month start). NULL
 * limits are unlimited; zero is finite (KEY-BUD semantics). The limits
 * themselves are frozen on the customer price snapshot (migration 112) and
 * enforcement reads only the frozen values (the R1 red line).
 *
 * API key 5h/7d windows (the sub2api api_key.go RateLimitWindow5h/7d
 * analog): two nullable caps on the existing KEY-BUD policy head, evaluated
 * as true ROLLING windows — the trailing sum over the key lineage's
 * reservation ledger (outstanding + settled), so a burst cannot dodge the
 * cap across a bucket boundary. The reservation ledger gains the settled
 * amount column (the actual charge, recorded at settle) because settled
 * reservations must contribute their ACTUAL amount to the rolling sum, and
 * a lineage/created_at index to keep the trailing scan indexed.
 */
const billingGroupSpendWindowsSql = `
CREATE TABLE saas_billing_group_spend_counters (
  billing_group_id text NOT NULL,
  window_kind text NOT NULL
    CHECK (window_kind IN ('daily', 'weekly', 'monthly')),
  window_start date NOT NULL,
  charge_outstanding_reserved bigint NOT NULL DEFAULT 0
    CHECK (charge_outstanding_reserved >= 0),
  charge_settled bigint NOT NULL DEFAULT 0
    CHECK (charge_settled >= 0),
  charge_currency text
    CHECK (charge_currency IS NULL OR charge_currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_billing_group_spend_counters_pk
    PRIMARY KEY (billing_group_id, window_kind, window_start),
  CONSTRAINT saas_billing_group_spend_counters_group_nonempty
    CHECK (btrim(billing_group_id) <> '' AND billing_group_id = btrim(billing_group_id))
);

CREATE TABLE saas_billing_group_spend_reservations (
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  billing_group_id text NOT NULL,
  window_kind text NOT NULL
    CHECK (window_kind IN ('daily', 'weekly', 'monthly')),
  window_start date NOT NULL,
  amount_minor_units bigint NOT NULL
    CHECK (amount_minor_units >= 0),
  charge_currency text NOT NULL
    CHECK (charge_currency ~ '^[A-Z]{3}$'),
  settled_amount_minor_units bigint
    CHECK (settled_amount_minor_units IS NULL OR settled_amount_minor_units >= 0),
  state text NOT NULL DEFAULT 'outstanding'
    CHECK (state IN ('outstanding', 'settled', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_billing_group_spend_reservations_pk
    PRIMARY KEY (tenant_id, request_id, window_kind),
  CONSTRAINT saas_billing_group_spend_reservations_amount_shape CHECK (
    (state = 'outstanding' AND settled_amount_minor_units IS NULL)
    OR (state IN ('settled', 'released') AND settled_amount_minor_units IS NOT NULL)
  )
);

CREATE INDEX saas_billing_group_spend_reservations_group_idx
  ON saas_billing_group_spend_reservations (billing_group_id, window_kind, window_start);

ALTER TABLE saas_api_key_budget_policies
  ADD COLUMN charge_5h bigint CHECK (charge_5h IS NULL OR charge_5h >= 0),
  ADD COLUMN charge_7d bigint CHECK (charge_7d IS NULL OR charge_7d >= 0);

ALTER TABLE saas_api_key_budget_reservations
  ADD COLUMN settled_charge_minor_units bigint
    CHECK (settled_charge_minor_units IS NULL OR settled_charge_minor_units >= 0);

CREATE INDEX saas_api_key_budget_reservations_lineage_created_idx
  ON saas_api_key_budget_reservations (tenant_id, lineage_id, created_at);
`;

export const BILLING_GROUP_SPEND_WINDOWS_SAAS_MIGRATION: SaasMigration = {
  version: 114,
  name: 'billing_group_spend_windows',
  sql: billingGroupSpendWindowsSql,
};
