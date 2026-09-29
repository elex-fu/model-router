import type { SaasMigration } from './001_initial_schema.js';

/*
 * Hosted wallet top-ups deliberately keep provider payloads out of the
 * database.  The order is an immutable tenant/amount/currency snapshot; the
 * inbox contains only the normalized fields required for dedupe, matching,
 * replay, and reconciliation.
 */
const paymentOrdersWalletTopupSql = `
CREATE TABLE saas_payment_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  order_type text NOT NULL
    CHECK (order_type = 'wallet_topup'),
  provider_key text NOT NULL
    CHECK (btrim(provider_key) <> ''),
  merchant_id text NOT NULL
    CHECK (btrim(merchant_id) <> ''),
  client_request_id text NOT NULL
    CHECK (btrim(client_request_id) <> ''),
  local_order_ref text NOT NULL
    CHECK (btrim(local_order_ref) <> ''),
  funding_reference text NOT NULL
    CHECK (btrim(funding_reference) <> ''),
  amount_minor_units bigint NOT NULL
    CHECK (amount_minor_units > 0),
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'created'
    CHECK (state IN (
      'created', 'pending', 'provider_failed', 'paid', 'fulfilling',
      'fulfilled', 'cancelled', 'reconciliation_pending'
    )),
  provider_order_id text,
  provider_attempts integer NOT NULL DEFAULT 0
    CHECK (provider_attempts >= 0),
  provider_failure_code text
    CHECK (provider_failure_code IS NULL OR provider_failure_code ~ '^[A-Z0-9_:-]{1,96}$'),
  funding_transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  fulfilled_at timestamptz,
  CONSTRAINT saas_payment_orders_tenant_client_request_unique
    UNIQUE (tenant_id, client_request_id),
  CONSTRAINT saas_payment_orders_local_order_ref_unique
    UNIQUE (local_order_ref),
  CONSTRAINT saas_payment_orders_funding_reference_unique
    UNIQUE (funding_reference),
  CONSTRAINT saas_payment_orders_provider_order_unique
    UNIQUE (provider_key, merchant_id, provider_order_id),
  CONSTRAINT saas_payment_orders_funding_transaction_fk
    FOREIGN KEY (funding_transaction_id, tenant_id, currency)
    REFERENCES saas_ledger_transactions (id, tenant_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT saas_payment_orders_paid_fields_check CHECK (
    (state IN ('paid', 'fulfilling', 'fulfilled') AND paid_at IS NOT NULL)
    OR (state NOT IN ('paid', 'fulfilling', 'fulfilled'))
  ),
  CONSTRAINT saas_payment_orders_fulfilled_fields_check CHECK (
    (state = 'fulfilled' AND fulfilled_at IS NOT NULL AND funding_transaction_id IS NOT NULL)
    OR (state <> 'fulfilled')
  )
);

CREATE INDEX saas_payment_orders_tenant_time_idx
  ON saas_payment_orders (tenant_id, created_at DESC);
CREATE INDEX saas_payment_orders_provider_lookup_idx
  ON saas_payment_orders (provider_key, merchant_id, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE TABLE saas_payment_inbox (
  id uuid PRIMARY KEY,
  provider_key text NOT NULL
    CHECK (btrim(provider_key) <> ''),
  merchant_id text NOT NULL
    CHECK (btrim(merchant_id) <> ''),
  provider_event_id text NOT NULL
    CHECK (btrim(provider_event_id) <> ''),
  event_type text NOT NULL
    CHECK (btrim(event_type) <> ''),
  provider_order_id text NOT NULL
    CHECK (btrim(provider_order_id) <> ''),
  event_tenant_id text NOT NULL
    CHECK (btrim(event_tenant_id) <> ''),
  tenant_id uuid,
  local_order_id uuid REFERENCES saas_payment_orders (id) ON DELETE RESTRICT,
  event_status text NOT NULL
    CHECK (event_status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  amount_minor_units bigint NOT NULL
    CHECK (amount_minor_units > 0),
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_outcome text NOT NULL
    CHECK (processing_outcome IN ('accepted', 'fulfilled', 'replayed', 'reconciliation', 'rejected')),
  outcome_code text
    CHECK (outcome_code IS NULL OR outcome_code ~ '^[A-Z0-9_:-]{1,96}$'),
  CONSTRAINT saas_payment_inbox_provider_event_unique
    UNIQUE (provider_key, merchant_id, provider_event_id)
);

CREATE INDEX saas_payment_inbox_order_idx
  ON saas_payment_inbox (provider_key, merchant_id, provider_order_id, received_at DESC);
CREATE INDEX saas_payment_inbox_tenant_time_idx
  ON saas_payment_inbox (tenant_id, received_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE FUNCTION saas_payment_orders_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.order_type IS DISTINCT FROM OLD.order_type
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
    OR NEW.local_order_ref IS DISTINCT FROM OLD.local_order_ref
    OR NEW.funding_reference IS DISTINCT FROM OLD.funding_reference
    OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR (OLD.provider_order_id IS NOT NULL AND NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id)
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Payment order identity and snapshot are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'created' AND NEW.state NOT IN ('created', 'pending', 'provider_failed', 'cancelled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid payment order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'provider_failed' AND NEW.state NOT IN ('provider_failed', 'created', 'pending', 'cancelled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid payment order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'paid', 'provider_failed', 'cancelled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid payment order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'paid' AND NEW.state NOT IN ('paid', 'fulfilling', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid payment order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'fulfilling' AND NEW.state NOT IN ('fulfilling', 'fulfilled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid payment order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'fulfilled' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Fulfilled payment orders are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'cancelled' AND NEW.state NOT IN ('cancelled', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Cancelled payment orders cannot be fulfilled' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'reconciliation_pending' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Reconciliation is required before changing a payment order' USING ERRCODE = '55000';
  END IF;

  IF OLD.provider_attempts > NEW.provider_attempts THEN
    RAISE EXCEPTION 'Payment provider attempts cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'fulfilled' AND NEW.funding_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Fulfilled payment orders require a funding transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_payment_orders_state_guard
  BEFORE UPDATE ON saas_payment_orders
  FOR EACH ROW EXECUTE FUNCTION saas_payment_orders_guard_change();

CREATE FUNCTION saas_payment_inbox_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
    OR NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id
    OR NEW.event_tenant_id IS DISTINCT FROM OLD.event_tenant_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.local_order_id IS DISTINCT FROM OLD.local_order_id
    OR NEW.event_status IS DISTINCT FROM OLD.event_status
    OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
    OR NEW.received_at IS DISTINCT FROM OLD.received_at
  THEN
    RAISE EXCEPTION 'Payment inbox normalized event is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER saas_payment_inbox_normalized_event_guard
  BEFORE UPDATE ON saas_payment_inbox
  FOR EACH ROW EXECUTE FUNCTION saas_payment_inbox_guard_change();
`;

export const PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION: SaasMigration = {
  version: 30,
  name: 'payment_orders_wallet_topup_fulfillment',
  sql: paymentOrdersWalletTopupSql,
};
