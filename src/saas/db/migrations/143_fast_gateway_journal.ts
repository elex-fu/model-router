import type { SaasMigration } from './001_initial_schema.js';

/** Compact money authority. No TTL releases and no Redis-backed financial state. */
export const FAST_GATEWAY_JOURNAL_SAAS_MIGRATION: SaasMigration = {
  version: 143,
  name: 'fast_gateway_durable_credit_journal',
  sql: `
CREATE TABLE saas_fast_gateway_owners (
  owner text PRIMARY KEY CHECK (btrim(owner) <> ''),
  epoch uuid NOT NULL
);
CREATE TABLE saas_fast_credit_allocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  currency text NOT NULL,
  owner text NOT NULL REFERENCES saas_fast_gateway_owners(owner),
  epoch uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'retired')),
  backing_minor_units bigint NOT NULL CHECK (backing_minor_units >= 0),
  available_minor_units bigint NOT NULL CHECK (available_minor_units >= 0 AND available_minor_units <= backing_minor_units),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (wallet_id, tenant_id, currency) REFERENCES saas_wallets(id, tenant_id, currency),
  UNIQUE (id, tenant_id, currency)
);
CREATE UNIQUE INDEX saas_fast_credit_active_owner_unique
  ON saas_fast_credit_allocations(tenant_id, currency, owner, epoch) WHERE state = 'active';
CREATE INDEX saas_fast_credit_wallet_backing ON saas_fast_credit_allocations(tenant_id, currency)
  WHERE backing_minor_units > 0;
CREATE TABLE saas_fast_gateway_intents (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE,
  attempt_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES saas_tenants(id),
  project_id uuid NOT NULL,
  proxy_key_id uuid NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  account_id text NOT NULL CHECK (btrim(account_id) <> ''),
  currency text,
  max_cost_minor_units bigint NOT NULL CHECK (max_cost_minor_units >= 0),
  price_snapshot jsonb,
  authority_snapshot jsonb NOT NULL,
  allocation_id uuid,
  allocation_epoch uuid,
  send_deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, request_id),
  FOREIGN KEY (allocation_id, tenant_id, currency) REFERENCES saas_fast_credit_allocations(id, tenant_id, currency),
  CHECK ((currency IS NULL AND price_snapshot IS NULL AND max_cost_minor_units = 0 AND allocation_id IS NULL AND allocation_epoch IS NULL)
      OR (currency IS NOT NULL AND price_snapshot IS NOT NULL AND allocation_id IS NOT NULL AND allocation_epoch IS NOT NULL))
);
CREATE TABLE saas_fast_gateway_receipts (
  intent_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'unknown')),
  charge_minor_units bigint CHECK (charge_minor_units >= 0),
  usage jsonb NOT NULL,
  usage_digest text NOT NULL CHECK (usage_digest ~ '^[0-9a-f]{64}$'),
  receipt_digest text NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (intent_id, tenant_id, request_id) REFERENCES saas_fast_gateway_intents(id, tenant_id, request_id),
  CHECK (outcome <> 'unknown' OR charge_minor_units IS NULL)
);
CREATE TABLE saas_fast_billing_jobs (
  intent_id uuid PRIMARY KEY REFERENCES saas_fast_gateway_receipts(intent_id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'completed', 'blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  ledger_transaction_id uuid REFERENCES saas_ledger_transactions(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX saas_fast_billing_jobs_pending ON saas_fast_billing_jobs(created_at, intent_id) WHERE state = 'pending';
CREATE FUNCTION saas_fast_credit_guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.owner IS DISTINCT FROM OLD.owner OR NEW.epoch IS DISTINCT FROM OLD.epoch
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.state = 'retired' AND NEW.state <> 'retired') THEN
    RAISE EXCEPTION 'Fast credit identity and retirement are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_fast_credit_identity BEFORE UPDATE ON saas_fast_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION saas_fast_credit_guard_identity();
CREATE TRIGGER saas_fast_credit_no_delete BEFORE DELETE ON saas_fast_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_reservation_delete();
CREATE TRIGGER saas_fast_credit_no_truncate BEFORE TRUNCATE ON saas_fast_credit_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_intents_immutable BEFORE UPDATE OR DELETE ON saas_fast_gateway_intents
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_intents_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_intents
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_receipts_immutable BEFORE UPDATE OR DELETE ON saas_fast_gateway_receipts
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_receipts_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
`,
};
