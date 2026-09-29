import type { SaasMigration } from './001_initial_schema.js';

const paymentRefundsSql = `
ALTER TABLE saas_payment_orders
  ADD CONSTRAINT saas_payment_orders_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE saas_ledger_transactions
  DROP CONSTRAINT saas_ledger_transactions_source_type_check,
  ADD CONSTRAINT saas_ledger_transactions_source_type_check
    CHECK (source_type IN ('wallet_funding', 'billing_settlement', 'wallet_refund')),
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
  );

CREATE TABLE saas_refund_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  refund_type text NOT NULL
    CHECK (refund_type IN ('wallet_topup', 'byok_service_plan')),
  wallet_topup_order_id uuid,
  service_plan_order_id uuid,
  original_funding_transaction_id uuid,
  wallet_id uuid,
  provider_key text NOT NULL CHECK (btrim(provider_key) <> ''),
  merchant_id text NOT NULL CHECK (btrim(merchant_id) <> ''),
  provider_order_id text NOT NULL CHECK (btrim(provider_order_id) <> ''),
  original_local_order_ref text NOT NULL CHECK (btrim(original_local_order_ref) <> ''),
  idempotency_namespace text NOT NULL CHECK (btrim(idempotency_namespace) <> ''),
  client_request_id text NOT NULL CHECK (btrim(client_request_id) <> ''),
  requested_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  authorization_ref text NOT NULL CHECK (btrim(authorization_ref) <> ''),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9][A-Z0-9._:-]{0,95}$'),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL CHECK (state IN ('submitting', 'pending', 'succeeded', 'failed', 'unknown', 'blocked')),
  provider_refund_id text,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z0-9_:-]{1,96}$'),
  blocked_code text CHECK (blocked_code IS NULL OR blocked_code ~ '^[A-Z0-9_:-]{1,96}$'),
  wallet_refund_transaction_id uuid,
  service_plan_effect_ref text,
  provider_attempts integer NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0),
  lease_action text,
  lease_token text,
  lease_expires_at timestamptz,
  next_reconcile_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT saas_refund_orders_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT saas_refund_orders_idempotency_unique
    UNIQUE (tenant_id, idempotency_namespace, client_request_id),
  CONSTRAINT saas_refund_orders_provider_refund_unique
    UNIQUE (provider_key, merchant_id, provider_refund_id),
  CONSTRAINT saas_refund_orders_wallet_order_fk
    FOREIGN KEY (tenant_id, wallet_topup_order_id)
    REFERENCES saas_payment_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_orders_service_plan_order_fk
    FOREIGN KEY (tenant_id, service_plan_order_id)
    REFERENCES saas_service_plan_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_orders_funding_transaction_fk
    FOREIGN KEY (original_funding_transaction_id, tenant_id, currency)
    REFERENCES saas_ledger_transactions (id, tenant_id, currency) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_orders_wallet_fk
    FOREIGN KEY (wallet_id, tenant_id, currency)
    REFERENCES saas_wallets (id, tenant_id, currency) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_orders_wallet_transaction_fk
    FOREIGN KEY (wallet_refund_transaction_id, tenant_id, currency)
    REFERENCES saas_ledger_transactions (id, tenant_id, currency) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_orders_source_shape CHECK (
    (refund_type = 'wallet_topup'
      AND wallet_topup_order_id IS NOT NULL
      AND service_plan_order_id IS NULL
      AND original_funding_transaction_id IS NOT NULL
      AND wallet_id IS NOT NULL)
    OR
    (refund_type = 'byok_service_plan'
      AND wallet_topup_order_id IS NULL
      AND service_plan_order_id IS NOT NULL
      AND original_funding_transaction_id IS NULL
      AND wallet_id IS NULL)
  ),
  CONSTRAINT saas_refund_orders_lease_shape CHECK (
    (state = 'submitting' AND lease_action = 'submit'
      AND lease_token IS NOT NULL AND char_length(lease_token) BETWEEN 1 AND 255
      AND lease_expires_at IS NOT NULL)
    OR
    (state IN ('pending', 'unknown') AND (
      (lease_action = 'query' AND lease_token IS NOT NULL
        AND char_length(lease_token) BETWEEN 1 AND 255 AND lease_expires_at IS NOT NULL)
      OR (lease_action IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    ))
    OR
    (state IN ('succeeded', 'failed', 'blocked')
      AND lease_action IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT saas_refund_orders_terminal_shape CHECK (
    (state = 'succeeded' AND completed_at IS NOT NULL
      AND ((refund_type = 'wallet_topup' AND wallet_refund_transaction_id IS NOT NULL)
        OR (refund_type = 'byok_service_plan' AND service_plan_effect_ref IS NOT NULL)))
    OR
    (state = 'failed' AND completed_at IS NOT NULL AND wallet_refund_transaction_id IS NULL)
    OR
    (state = 'blocked' AND completed_at IS NULL AND refund_type = 'byok_service_plan'
      AND blocked_code IS NOT NULL AND wallet_refund_transaction_id IS NULL)
    OR
    (state IN ('submitting', 'pending', 'unknown')
      AND completed_at IS NULL AND wallet_refund_transaction_id IS NULL)
  ),
  CONSTRAINT saas_refund_orders_provider_attempt_shape CHECK (
    (refund_type = 'wallet_topup' AND provider_attempts >= 1)
    OR (refund_type = 'byok_service_plan' AND provider_attempts = 0)
  )
);

CREATE INDEX saas_refund_orders_reconciliation_idx
  ON saas_refund_orders (next_reconcile_at, created_at)
  WHERE state IN ('submitting', 'pending', 'unknown');
CREATE INDEX saas_refund_orders_wallet_order_idx
  ON saas_refund_orders (tenant_id, wallet_topup_order_id, created_at)
  WHERE wallet_topup_order_id IS NOT NULL;
CREATE INDEX saas_refund_orders_service_plan_order_idx
  ON saas_refund_orders (tenant_id, service_plan_order_id, created_at)
  WHERE service_plan_order_id IS NOT NULL;

CREATE TABLE saas_refund_wallet_freezes (
  refund_order_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor_units bigint NOT NULL CHECK (amount_minor_units > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_refund_wallet_freezes_refund_fk
    FOREIGN KEY (tenant_id, refund_order_id)
    REFERENCES saas_refund_orders (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT saas_refund_wallet_freezes_wallet_fk
    FOREIGN KEY (wallet_id, tenant_id, currency)
    REFERENCES saas_wallets (id, tenant_id, currency) ON DELETE RESTRICT
);

CREATE INDEX saas_refund_wallet_freezes_wallet_idx
  ON saas_refund_wallet_freezes (tenant_id, currency, refund_order_id);

CREATE FUNCTION saas_refund_orders_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.refund_type IS DISTINCT FROM OLD.refund_type
    OR NEW.wallet_topup_order_id IS DISTINCT FROM OLD.wallet_topup_order_id
    OR NEW.service_plan_order_id IS DISTINCT FROM OLD.service_plan_order_id
    OR NEW.original_funding_transaction_id IS DISTINCT FROM OLD.original_funding_transaction_id
    OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
    OR NEW.provider_order_id IS DISTINCT FROM OLD.provider_order_id
    OR NEW.original_local_order_ref IS DISTINCT FROM OLD.original_local_order_ref
    OR NEW.idempotency_namespace IS DISTINCT FROM OLD.idempotency_namespace
    OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.authorization_ref IS DISTINCT FROM OLD.authorization_ref
    OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
    OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id)
  THEN
    RAISE EXCEPTION 'Refund order identity and payment snapshot are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.state IN ('succeeded', 'failed', 'blocked') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal refund orders are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'submitting' AND NEW.state NOT IN ('submitting', 'pending', 'unknown', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'Invalid refund order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'pending' AND NEW.state NOT IN ('pending', 'unknown', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'Invalid refund order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'unknown' AND NEW.state NOT IN ('unknown', 'pending', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'Invalid refund order transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_attempts > NEW.provider_attempts THEN
    RAISE EXCEPTION 'Refund provider attempts cannot decrease' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_refund_wallet_freezes_guard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  refund_state text;
BEGIN
  SELECT state INTO refund_state
  FROM saas_refund_orders
  WHERE tenant_id = OLD.tenant_id AND id = OLD.refund_order_id;
  IF refund_state NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'An unresolved refund wallet freeze cannot be released' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE FUNCTION saas_refund_wallet_freezes_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Refund wallet freezes are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION saas_refund_orders_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Refund orders are retained for financial reconciliation' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER saas_refund_orders_state_guard
  BEFORE UPDATE ON saas_refund_orders
  FOR EACH ROW EXECUTE FUNCTION saas_refund_orders_guard_change();
CREATE TRIGGER saas_refund_orders_no_delete
  BEFORE DELETE OR TRUNCATE ON saas_refund_orders
  FOR EACH STATEMENT EXECUTE FUNCTION saas_refund_orders_reject_delete();
CREATE TRIGGER saas_refund_wallet_freezes_no_update
  BEFORE UPDATE ON saas_refund_wallet_freezes
  FOR EACH ROW EXECUTE FUNCTION saas_refund_wallet_freezes_reject_mutation();
CREATE TRIGGER saas_refund_wallet_freezes_release_guard
  BEFORE DELETE ON saas_refund_wallet_freezes
  FOR EACH ROW EXECUTE FUNCTION saas_refund_wallet_freezes_guard_delete();
CREATE TRIGGER saas_refund_wallet_freezes_no_truncate
  BEFORE TRUNCATE ON saas_refund_wallet_freezes
  FOR EACH STATEMENT EXECUTE FUNCTION saas_refund_wallet_freezes_reject_mutation();
`;

export const PAYMENT_REFUNDS_SAAS_MIGRATION: SaasMigration = {
  version: 37,
  name: 'payment_refunds_and_wallet_freezes',
  sql: paymentRefundsSql,
};
