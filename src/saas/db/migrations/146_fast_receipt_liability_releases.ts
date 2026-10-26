import type { SaasMigration } from './001_initial_schema.js';

/** Durable receipt-time liability, with a fail-closed old-worker selection gate. */
export const FAST_RECEIPT_LIABILITY_RELEASES_SAAS_MIGRATION: SaasMigration = {
  version: 146,
  name: 'fast_receipt_durable_liability_releases',
  sql: `
CREATE TABLE saas_fast_receipt_liability_releases (
  intent_id uuid PRIMARY KEY REFERENCES saas_fast_gateway_receipts(intent_id),
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  allocation_epoch uuid NOT NULL,
  currency text NOT NULL,
  released_minor_units bigint NOT NULL CHECK (released_minor_units > 0),
  retained_minor_units bigint NOT NULL CHECK (retained_minor_units >= 0),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  protocol_version smallint NOT NULL CHECK (protocol_version = 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (intent_id,tenant_id,request_id) REFERENCES saas_fast_gateway_intents(id,tenant_id,request_id),
  FOREIGN KEY (allocation_id,tenant_id,currency) REFERENCES saas_fast_credit_allocations(id,tenant_id,currency)
);
CREATE TRIGGER saas_fast_receipt_releases_immutable BEFORE UPDATE OR DELETE ON saas_fast_receipt_liability_releases
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_receipt_releases_no_truncate BEFORE TRUNCATE ON saas_fast_receipt_liability_releases
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
ALTER TABLE saas_fast_billing_jobs DROP CONSTRAINT saas_fast_billing_jobs_state_check;
ALTER TABLE saas_fast_billing_jobs ADD CONSTRAINT saas_fast_billing_jobs_state_check
  CHECK (state IN ('pending','blocked','pending_v2','blocked_v2','completed'));
DROP INDEX saas_fast_billing_jobs_pending;
CREATE INDEX saas_fast_billing_jobs_pending ON saas_fast_billing_jobs(created_at,intent_id)
  WHERE state IN ('pending','pending_v2');
-- A new resolver must never downgrade a v2 job to the old worker protocol.
CREATE FUNCTION saas_fast_billing_guard_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('pending_v2','blocked_v2') AND NEW.state IN ('pending','blocked') THEN
    RAISE EXCEPTION 'Fast billing liability protocol cannot be downgraded' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_fast_billing_protocol BEFORE UPDATE ON saas_fast_billing_jobs
  FOR EACH ROW EXECUTE FUNCTION saas_fast_billing_guard_protocol();
`,
};
