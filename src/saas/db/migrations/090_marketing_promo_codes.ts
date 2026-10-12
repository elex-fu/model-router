import type { SaasMigration } from './001_initial_schema.js';

/**
 * R1/G2 promo codes (design: docs/remaining-capability-plan-2026-10-11.md).
 * Promo codes are public-by-design campaign tokens (not credentials), stored
 * as normalized plaintext — deliberately different from G1 redeem codes,
 * which are bearer secrets stored irreversibly. A promo code only feeds the
 * checkout pricing snapshot: the discounted amount is frozen on the order at
 * creation and never repriced afterwards. `original_amount_minor_units` on
 * the order keeps the pre-discount amount so client-request replay compares
 * the customer's original input, not the discounted snapshot; it is
 * insert-only and NULL for every pre-promo order.
 */
const marketingPromoCodesSql = `
ALTER TABLE saas_payment_orders
  ADD COLUMN original_amount_minor_units text;

ALTER TABLE saas_payment_orders
  ADD CONSTRAINT saas_payment_orders_original_amount_format
    CHECK (original_amount_minor_units IS NULL OR original_amount_minor_units ~ '^[0-9]{1,20}$');

CREATE TABLE saas_marketing_promo_codes (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('percent_off', 'amount_off')),
  percent_bp integer,
  amount_minor_units text,
  currency text,
  scope text NOT NULL DEFAULT 'wallet_topup'
    CHECK (scope IN ('wallet_topup')),
  starts_at timestamptz,
  ends_at timestamptz,
  max_uses integer,
  per_tenant_once boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_by_user_id uuid NOT NULL REFERENCES saas_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT saas_marketing_promo_codes_code_format
    CHECK (code ~ '^[A-Z0-9-]{4,32}$'),
  CONSTRAINT saas_marketing_promo_codes_code_unique UNIQUE (code),
  CONSTRAINT saas_marketing_promo_codes_kind_shape
    CHECK (
      (kind = 'percent_off'
        AND percent_bp IS NOT NULL AND percent_bp > 0 AND percent_bp < 10000
        AND amount_minor_units IS NULL AND currency IS NULL)
      OR (kind = 'amount_off'
        AND amount_minor_units IS NOT NULL AND amount_minor_units ~ '^[0-9]{1,20}$' AND amount_minor_units !~ '^0+$'
        AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$'
        AND percent_bp IS NULL)
    ),
  CONSTRAINT saas_marketing_promo_codes_max_uses_positive
    CHECK (max_uses IS NULL OR max_uses > 0),
  CONSTRAINT saas_marketing_promo_codes_window_order
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
  CONSTRAINT saas_marketing_promo_codes_disabled_shape
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE TABLE saas_marketing_promo_usages (
  id uuid PRIMARY KEY,
  code_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES saas_tenants (id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  discount_minor_units text NOT NULL
    CHECK (discount_minor_units ~ '^[0-9]{1,20}$'),
  per_tenant_once boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT saas_marketing_promo_usages_order_unique UNIQUE (order_id),
  CONSTRAINT saas_marketing_promo_usages_code_fk
    FOREIGN KEY (code_id) REFERENCES saas_marketing_promo_codes (id) ON DELETE RESTRICT
);

-- The flag is denormalized from the code row at insert (usages are
-- append-only, so it is a frozen copy); PG forbids subqueries in index
-- predicates.
CREATE UNIQUE INDEX saas_marketing_promo_usages_tenant_once
  ON saas_marketing_promo_usages (code_id, tenant_id)
  WHERE per_tenant_once;

CREATE FUNCTION saas_marketing_promo_orders_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original_amount_minor_units IS DISTINCT FROM OLD.original_amount_minor_units THEN
    RAISE EXCEPTION 'Payment order original amount is insert-only'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_marketing_promo_orders_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_payment_orders_original_amount_guard
  BEFORE UPDATE ON saas_payment_orders
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_promo_orders_guard();

CREATE FUNCTION saas_marketing_promo_code_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.code IS DISTINCT FROM OLD.code
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.percent_bp IS DISTINCT FROM OLD.percent_bp
    OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.max_uses IS DISTINCT FROM OLD.max_uses
    OR NEW.per_tenant_once IS DISTINCT FROM OLD.per_tenant_once
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Marketing promo code identity is immutable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'active' AND NEW.status = 'disabled')
  THEN
    RAISE EXCEPTION 'Marketing promo code status transitions are one-way'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.status = 'disabled' AND NEW.disabled_at IS DISTINCT FROM OLD.disabled_at THEN
    RAISE EXCEPTION 'Marketing promo code disable timestamp is immutable'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION saas_marketing_promo_code_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_promo_codes_guard
  BEFORE UPDATE ON saas_marketing_promo_codes
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_promo_code_guard();

CREATE FUNCTION saas_marketing_promo_usage_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing promo usages are append-only'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_promo_usage_guard()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_promo_usages_no_update
  BEFORE UPDATE ON saas_marketing_promo_usages
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_promo_usage_guard();

CREATE FUNCTION saas_marketing_promo_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Marketing promo records cannot be deleted'
    USING ERRCODE = '55006';
END;
$$;

ALTER FUNCTION saas_marketing_promo_reject_delete()
  SET search_path TO pg_catalog, model_router_saas, pg_temp;

CREATE TRIGGER saas_marketing_promo_codes_no_delete
  BEFORE DELETE ON saas_marketing_promo_codes
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_promo_reject_delete();

CREATE TRIGGER saas_marketing_promo_usages_no_delete
  BEFORE DELETE ON saas_marketing_promo_usages
  FOR EACH ROW EXECUTE FUNCTION saas_marketing_promo_reject_delete();
`;

export const MARKETING_PROMO_CODES_SAAS_MIGRATION: SaasMigration = {
  version: 90,
  name: 'marketing_promo_codes',
  sql: marketingPromoCodesSql,
};
