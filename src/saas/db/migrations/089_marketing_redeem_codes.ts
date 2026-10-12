import type { SaasMigration } from './001_initial_schema.js';

/**
 * Track G1 redeem codes (design: docs/marketing-domain-design-2026-10-11.md,
 * contract C-6 / migration ledger 089). Codes are stored irreversibly
 * (sha256 of the normalized code plus a short display prefix); the plaintext
 * exists only in the generation response. A code is redeemed exactly once:
 * the service performs a locked CAS active -> redeemed in the same
 * transaction as the redemption row and the ledger posting, and the UNIQUE
 * (code_id) on the redemption table is the database-level backstop. Status
 * transitions are one-way (active -> redeemed|disabled, both terminal) and
 * both tables reject deletes, so the audit trail is the only history.
 */
const marketingRedeemCodesSql = `
CREATE TABLE saas_marketing_redeem_codes (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL,
  code_prefix text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('balance', 'subscription')),
  amount_minor_units text,
  currency text,
  service_plan_version_id uuid,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'redeemed', 'disabled')),
  batch_ref text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  redeemed_by_tenant_id uuid REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  redeemed_by_user_id uuid REFERENCES saas_users (id) ON DELETE RESTRICT,
  redeemed_at timestamptz,
  disabled_at timestamptz,
  CONSTRAINT saas_marketing_redeem_codes_hash_format
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT saas_marketing_redeem_codes_prefix_format
    CHECK (code_prefix ~ '^[A-Z2-9]{4,8}$'),
  CONSTRAINT saas_marketing_redeem_codes_amount_format
    CHECK (amount_minor_units IS NULL
      OR (amount_minor_units ~ '^[0-9]{1,20}$' AND amount_minor_units !~ '^0+$')),
  CONSTRAINT saas_marketing_redeem_codes_currency_format
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT saas_marketing_redeem_codes_kind_shape
    CHECK (
      (kind = 'balance'
        AND amount_minor_units IS NOT NULL AND currency IS NOT NULL AND service_plan_version_id IS NULL)
      OR (kind = 'subscription'
        AND service_plan_version_id IS NOT NULL AND amount_minor_units IS NULL AND currency IS NULL)
    ),
  CONSTRAINT saas_marketing_redeem_codes_batch_ref_nonempty
    CHECK (btrim(batch_ref) <> '' AND batch_ref = btrim(batch_ref) AND char_length(batch_ref) <= 128),
  CONSTRAINT saas_marketing_redeem_codes_redeemed_shape
    CHECK ((status = 'redeemed')
      = (redeemed_at IS NOT NULL AND redeemed_by_tenant_id IS NOT NULL AND redeemed_by_user_id IS NOT NULL)),
  CONSTRAINT saas_marketing_redeem_codes_disabled_shape
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  CONSTRAINT saas_marketing_redeem_codes_hash_unique UNIQUE (code_hash),
  CONSTRAINT saas_marketing_redeem_codes_plan_version_fk
    FOREIGN KEY (service_plan_version_id) REFERENCES saas_service_plan_versions (id) ON DELETE RESTRICT
);

CREATE TABLE saas_marketing_redeem_redemptions (
  id uuid PRIMARY KEY,
  code_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  ledger_transaction_id uuid REFERENCES saas_ledger_transactions (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_marketing_redeem_redemptions_code_unique UNIQUE (code_id),
  CONSTRAINT saas_marketing_redeem_redemptions_code_fk
    FOREIGN KEY (code_id) REFERENCES saas_marketing_redeem_codes (id) ON DELETE RESTRICT
);

CREATE FUNCTION saas_marketing_redeem_code_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
    OR NEW.code_prefix IS DISTINCT FROM OLD.code_prefix
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.service_plan_version_id IS DISTINCT FROM OLD.service_plan_version_id
    OR NEW.batch_ref IS DISTINCT FROM OLD.batch_ref
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Marketing redeem code identity is immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'active' AND NEW.status IN ('redeemed', 'disabled'))
  THEN
    RAISE EXCEPTION 'Marketing redeem code status transitions are one-way'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.status = 'redeemed'
    AND (NEW.redeemed_by_tenant_id IS DISTINCT FROM OLD.redeemed_by_tenant_id
      OR NEW.redeemed_by_user_id IS DISTINCT FROM OLD.redeemed_by_user_id
      OR NEW.redeemed_at IS DISTINCT FROM OLD.redeemed_at)
  THEN
    RAISE EXCEPTION 'Marketing redeem code redemption facts are immutable'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.status = 'disabled' AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
    RAISE EXCEPTION 'Marketing redeem code disable timestamp is immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.status = 'active'
    AND (NEW.redeemed_at IS NOT NULL OR NEW.redeemed_by_tenant_id IS NOT NULL
      OR NEW.redeemed_by_user_id IS NOT NULL OR NEW.disabled_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'An active marketing redeem code cannot carry terminal facts'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_marketing_redeem_code_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_redeem_codes_guard
  BEFORE UPDATE ON saas_marketing_redeem_codes
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_redeem_code_guard();

CREATE FUNCTION saas_marketing_redeem_redemption_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing redeem redemptions are append-only'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_redeem_redemption_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_redeem_redemptions_no_update
  BEFORE UPDATE ON saas_marketing_redeem_redemptions
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_redeem_redemption_guard();

CREATE FUNCTION saas_marketing_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing redeem records cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_reject_delete()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_redeem_codes_no_delete
  BEFORE DELETE ON saas_marketing_redeem_codes
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_reject_delete();

CREATE TRIGGER saas_marketing_redeem_redemptions_no_delete
  BEFORE DELETE ON saas_marketing_redeem_redemptions
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_reject_delete();
`;

export const MARKETING_REDEEM_CODES_SAAS_MIGRATION: SaasMigration = {
  version: 89,
  name: 'marketing_redeem_codes',
  sql: marketingRedeemCodesSql,
};
