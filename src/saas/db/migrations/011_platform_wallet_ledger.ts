import type { SaasMigration } from './001_initial_schema.js';

const platformWalletLedgerSchemaSql = `
CREATE TABLE saas_wallets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  posted_balance_minor_units bigint NOT NULL DEFAULT 0
    CHECK (posted_balance_minor_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_wallets_tenant_currency_unique UNIQUE (tenant_id, currency),
  CONSTRAINT saas_wallets_identity_unique UNIQUE (id, tenant_id, currency)
);

CREATE INDEX saas_wallets_tenant_idx
  ON saas_wallets (tenant_id, currency);

CREATE TABLE saas_billing_spending_freezes (
  tenant_id uuid PRIMARY KEY REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  reason_ref text NOT NULL
    CHECK (btrim(reason_ref) <> ''),
  frozen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saas_ledger_transactions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  idempotency_namespace text NOT NULL
    CHECK (btrim(idempotency_namespace) <> ''),
  business_key text NOT NULL
    CHECK (btrim(business_key) <> ''),
  source_type text NOT NULL
    CHECK (source_type IN ('wallet_funding', 'billing_settlement')),
  amount_minor_units bigint NOT NULL
    CHECK (amount_minor_units >= 0),
  metadata_ref text NOT NULL
    CHECK (btrim(metadata_ref) <> ''),
  source_order_ref text,
  price_snapshot_ref text,
  usage_evidence_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_ledger_transactions_identity_unique
    UNIQUE (tenant_id, idempotency_namespace, business_key),
  CONSTRAINT saas_ledger_transactions_scope_unique
    UNIQUE (id, tenant_id, currency),
  CONSTRAINT saas_ledger_transactions_source_fields CHECK (
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
  )
);

CREATE UNIQUE INDEX saas_ledger_transactions_source_order_unique
  ON saas_ledger_transactions (tenant_id, source_order_ref)
  WHERE source_order_ref IS NOT NULL;

CREATE INDEX saas_ledger_transactions_tenant_time_idx
  ON saas_ledger_transactions (tenant_id, created_at DESC);

CREATE TABLE saas_ledger_entries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  direction text NOT NULL
    CHECK (direction IN ('debit', 'credit')),
  amount_minor_units bigint NOT NULL
    CHECK (amount_minor_units > 0),
  account_type text NOT NULL
    CHECK (account_type IN ('wallet', 'funding_source', 'billing_revenue')),
  account_ref text NOT NULL
    CHECK (btrim(account_ref) <> ''),
  wallet_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_ledger_entries_transaction_fk
    FOREIGN KEY (transaction_id, tenant_id, currency)
    REFERENCES saas_ledger_transactions (id, tenant_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT saas_ledger_entries_wallet_fk
    FOREIGN KEY (wallet_id, tenant_id, currency)
    REFERENCES saas_wallets (id, tenant_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT saas_ledger_entries_wallet_account_check CHECK (
    (account_type = 'wallet' AND wallet_id IS NOT NULL)
    OR (account_type <> 'wallet' AND wallet_id IS NULL)
  ),
  CONSTRAINT saas_ledger_entries_wallet_ref_check CHECK (
    account_type <> 'wallet' OR account_ref = wallet_id::text
  )
);

CREATE INDEX saas_ledger_entries_transaction_idx
  ON saas_ledger_entries (transaction_id, direction);
CREATE INDEX saas_ledger_entries_wallet_idx
  ON saas_ledger_entries (wallet_id, created_at)
  WHERE wallet_id IS NOT NULL;

CREATE TABLE saas_billing_reservations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  currency text NOT NULL
    CHECK (currency ~ '^[A-Z]{3}$'),
  request_id text NOT NULL
    CHECK (btrim(request_id) <> ''),
  idempotency_namespace text NOT NULL
    CHECK (btrim(idempotency_namespace) <> ''),
  business_key text NOT NULL
    CHECK (btrim(business_key) <> ''),
  amount_minor_units bigint NOT NULL
    CHECK (amount_minor_units > 0),
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'settled', 'released', 'reconciliation_pending')),
  price_snapshot_ref text NOT NULL
    CHECK (btrim(price_snapshot_ref) <> ''),
  metadata_ref text NOT NULL
    CHECK (btrim(metadata_ref) <> ''),
  expires_at timestamptz NOT NULL,
  settlement_id text,
  settlement_amount_minor_units bigint
    CHECK (settlement_amount_minor_units IS NULL OR settlement_amount_minor_units >= 0),
  usage_evidence_ref text,
  reconciliation_reference text,
  reconciliation_evidence_ref text,
  release_id text,
  release_evidence_ref text,
  ledger_transaction_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_billing_reservations_wallet_fk
    FOREIGN KEY (wallet_id, tenant_id, currency)
    REFERENCES saas_wallets (id, tenant_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT saas_billing_reservations_transaction_fk
    FOREIGN KEY (ledger_transaction_id, tenant_id, currency)
    REFERENCES saas_ledger_transactions (id, tenant_id, currency)
    ON DELETE RESTRICT,
  CONSTRAINT saas_billing_reservations_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT saas_billing_reservations_terminal_fields_check CHECK (
    (state = 'settled'
      AND settlement_id IS NOT NULL
      AND settlement_amount_minor_units IS NOT NULL
      AND btrim(COALESCE(usage_evidence_ref, '')) <> ''
      AND (settlement_amount_minor_units = 0 OR ledger_transaction_id IS NOT NULL))
    OR
    (state = 'released'
      AND release_id IS NOT NULL
      AND btrim(COALESCE(release_evidence_ref, '')) <> '')
    OR
    state IN ('reserved', 'reconciliation_pending')
  )
);

CREATE UNIQUE INDEX saas_billing_reservations_tenant_request_business_unique
  ON saas_billing_reservations (tenant_id, request_id, business_key);
CREATE UNIQUE INDEX saas_billing_reservations_idempotency_unique
  ON saas_billing_reservations (tenant_id, idempotency_namespace, business_key);
CREATE UNIQUE INDEX saas_billing_reservations_settlement_unique
  ON saas_billing_reservations (tenant_id, settlement_id)
  WHERE settlement_id IS NOT NULL;
CREATE UNIQUE INDEX saas_billing_reservations_release_unique
  ON saas_billing_reservations (tenant_id, release_id)
  WHERE release_id IS NOT NULL;
CREATE INDEX saas_billing_reservations_active_holds_idx
  ON saas_billing_reservations (tenant_id, currency, state)
  WHERE state IN ('reserved', 'reconciliation_pending');
CREATE INDEX saas_billing_reservations_expiry_idx
  ON saas_billing_reservations (tenant_id, expires_at)
  WHERE state IN ('reserved', 'reconciliation_pending');

CREATE FUNCTION saas_billing_reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted ledger records are immutable' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION saas_billing_reject_reservation_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Billing reservations are retained for reconciliation' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION saas_billing_guard_wallet_projection() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  projection_write text;
  ledger_transaction_id text;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
  THEN
    RAISE EXCEPTION 'Wallet identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.posted_balance_minor_units IS DISTINCT FROM OLD.posted_balance_minor_units THEN
    projection_write := current_setting('saas.billing_ledger_projection_write', true);
    IF projection_write = 'rebuild' THEN
      RETURN NEW;
    END IF;
    IF projection_write IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Wallet balance may only change with a ledger transaction'
        USING ERRCODE = '55000';
    END IF;
    ledger_transaction_id := current_setting('saas.billing_ledger_transaction_id', true);
    IF ledger_transaction_id IS NULL OR ledger_transaction_id = '' THEN
      RAISE EXCEPTION 'Wallet balance change is missing its ledger transaction'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1
      FROM saas_ledger_transactions
      WHERE id::text = ledger_transaction_id
        AND tenant_id = OLD.tenant_id
        AND currency = OLD.currency;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Wallet balance change does not reference a tenant ledger transaction'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_billing_guard_reservation_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.idempotency_namespace IS DISTINCT FROM OLD.idempotency_namespace
    OR NEW.business_key IS DISTINCT FROM OLD.business_key
    OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
    OR NEW.price_snapshot_ref IS DISTINCT FROM OLD.price_snapshot_ref
    OR NEW.metadata_ref IS DISTINCT FROM OLD.metadata_ref
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Billing reservation identity and snapshot are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = 'reserved' AND NEW.state NOT IN ('reserved', 'settled', 'released', 'reconciliation_pending') THEN
    RAISE EXCEPTION 'Invalid billing reservation transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'reconciliation_pending' AND NEW.state NOT IN ('reconciliation_pending', 'settled', 'released') THEN
    RAISE EXCEPTION 'Reconciliation must finish before a reservation becomes terminal'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('settled', 'released') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'Terminal billing reservations cannot change state' USING ERRCODE = '55000';
  END IF;
  IF OLD.settlement_id IS NOT NULL AND NEW.settlement_id IS DISTINCT FROM OLD.settlement_id THEN
    RAISE EXCEPTION 'Settlement identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.settlement_amount_minor_units IS NOT NULL
    AND NEW.settlement_amount_minor_units IS DISTINCT FROM OLD.settlement_amount_minor_units
  THEN
    RAISE EXCEPTION 'Settlement amount is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.usage_evidence_ref IS NOT NULL AND NEW.usage_evidence_ref IS DISTINCT FROM OLD.usage_evidence_ref THEN
    RAISE EXCEPTION 'Usage evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.release_id IS NOT NULL AND NEW.release_id IS DISTINCT FROM OLD.release_id THEN
    RAISE EXCEPTION 'Release identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.release_evidence_ref IS NOT NULL
    AND NEW.release_evidence_ref IS DISTINCT FROM OLD.release_evidence_ref
  THEN
    RAISE EXCEPTION 'Release evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.reconciliation_reference IS NOT NULL
    AND NEW.reconciliation_reference IS DISTINCT FROM OLD.reconciliation_reference
  THEN
    RAISE EXCEPTION 'Reconciliation reference is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.reconciliation_evidence_ref IS NOT NULL
    AND NEW.reconciliation_evidence_ref IS DISTINCT FROM OLD.reconciliation_evidence_ref
  THEN
    RAISE EXCEPTION 'Reconciliation evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION saas_billing_assert_ledger_transaction_balanced(transaction_id_value uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  debit_total numeric;
  credit_total numeric;
  entry_count bigint;
  transaction_amount numeric;
BEGIN
  SELECT amount_minor_units
  INTO transaction_amount
  FROM saas_ledger_transactions
  WHERE id = transaction_id_value;

  SELECT
    COUNT(*),
    COALESCE(SUM(amount_minor_units) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(SUM(amount_minor_units) FILTER (WHERE direction = 'credit'), 0)
  INTO entry_count, debit_total, credit_total
  FROM saas_ledger_entries
  WHERE transaction_id = transaction_id_value;

  IF transaction_amount IS NULL
    OR entry_count < 2
    OR debit_total <= 0
    OR debit_total <> credit_total
    OR debit_total <> transaction_amount
  THEN
    RAISE EXCEPTION 'Posted ledger transaction is not balanced' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION saas_billing_check_ledger_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM saas_billing_assert_ledger_transaction_balanced(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION saas_billing_check_ledger_entry_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM saas_billing_assert_ledger_transaction_balanced(NEW.transaction_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER saas_wallets_projection_guard
  BEFORE UPDATE ON saas_wallets
  FOR EACH ROW EXECUTE FUNCTION saas_billing_guard_wallet_projection();

CREATE TRIGGER saas_ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON saas_ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_ledger_transactions_no_truncate
  BEFORE TRUNCATE ON saas_ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON saas_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_ledger_entries_no_truncate
  BEFORE TRUNCATE ON saas_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_billing_reservations_no_delete
  BEFORE DELETE ON saas_billing_reservations
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_reservation_delete();
CREATE TRIGGER saas_billing_reservations_state_guard
  BEFORE UPDATE ON saas_billing_reservations
  FOR EACH ROW EXECUTE FUNCTION saas_billing_guard_reservation_change();

CREATE CONSTRAINT TRIGGER saas_ledger_transactions_balanced
  AFTER INSERT ON saas_ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION saas_billing_check_ledger_transaction();
CREATE CONSTRAINT TRIGGER saas_ledger_entries_balanced
  AFTER INSERT ON saas_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION saas_billing_check_ledger_entry_transaction();
`;

export const PLATFORM_WALLET_LEDGER_SAAS_MIGRATION: SaasMigration = {
  version: 11,
  name: 'platform_wallet_billing_reservation_ledger',
  sql: platformWalletLedgerSchemaSql,
};

export const PLATFORM_WALLET_LEDGER_MIGRATION = PLATFORM_WALLET_LEDGER_SAAS_MIGRATION;
