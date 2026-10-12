import type { SaasMigration } from './001_initial_schema.js';

/**
 * Append-only usage corrections (contract C-1.1) plus the ledger source type
 * required to post their wallet reversal entries. Corrections never modify the
 * original usage event or settlement; each correction carries a versioned
 * digest that doubles as the idempotency key for its ledger posting.
 */
const usageCorrectionsSql = `
ALTER TABLE saas_ledger_transactions
  DROP CONSTRAINT saas_ledger_transactions_source_type_check,
  ADD CONSTRAINT saas_ledger_transactions_source_type_check
    CHECK (source_type IN ('wallet_funding', 'billing_settlement', 'wallet_refund', 'usage_correction')),
  DROP CONSTRAINT saas_ledger_transactions_source_fields,
  ADD CONSTRAINT saas_ledger_transactions_source_fields CHECK (
    (source_type = 'wallet_funding'
      AND amount_minor_units > 0
      AND btrim(COALESCE(source_order_ref, '')) <> ''
      AND price_snapshot_ref IS NULL
      AND usage_evidence_ref IS NULL)
    OR
    (source_type = 'billing_settlement'
      AND btrim(COALESCE(price_snapshot_ref, '')) <> ''
      AND btrim(COALESCE(usage_evidence_ref, '')) <> ''
      AND source_order_ref IS NULL)
    OR
    (source_type = 'wallet_refund'
      AND amount_minor_units > 0
      AND btrim(COALESCE(source_order_ref, '')) <> ''
      AND price_snapshot_ref IS NULL
      AND usage_evidence_ref IS NULL)
    OR
    (source_type = 'usage_correction'
      AND amount_minor_units > 0
      AND btrim(COALESCE(source_order_ref, '')) <> ''
      AND btrim(COALESCE(metadata_ref, '')) <> ''
      AND price_snapshot_ref IS NULL
      AND usage_evidence_ref IS NULL)
  );

CREATE TABLE saas_usage_correction_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  corrected_usage_event_id uuid NOT NULL REFERENCES saas_usage_events (id) ON DELETE RESTRICT,
  corrected_settlement_id uuid REFERENCES saas_usage_settlements (id) ON DELETE RESTRICT,
  reason_code text NOT NULL
    CHECK (reason_code IN (
      'provider_reported_correction',
      'billing_dispute',
      'metering_fault',
      'operator_adjustment')),
  correction_usage jsonb NOT NULL,
  amount_delta_minor_units bigint NOT NULL,
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  operator_identity text NOT NULL CHECK (btrim(operator_identity) <> ''),
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[0-9a-f]{64}$'),
  correction_digest text NOT NULL UNIQUE CHECK (correction_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL
);

CREATE INDEX saas_usage_correction_events_tenant_event_idx
  ON saas_usage_correction_events (tenant_id, corrected_usage_event_id);

CREATE INDEX saas_usage_correction_events_tenant_created_idx
  ON saas_usage_correction_events (tenant_id, created_at, id);
`;

export const USAGE_CORRECTIONS_SAAS_MIGRATION: SaasMigration = {
  version: 63,
  name: 'usage_corrections',
  sql: usageCorrectionsSql,
};
