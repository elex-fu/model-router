import type { SaasMigration } from './001_initial_schema.js';

export const PAYMENT_MERCHANT_BINDINGS_SAAS_MIGRATION: SaasMigration = {
  version: 140,
  name: 'payment_merchant_bindings',
  sql: `
CREATE TABLE saas_payment_merchant_bindings (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  provider_key text NOT NULL CHECK (provider_key='alipay'),
  merchant_id text NOT NULL CHECK (length(merchant_id)>0),
  seller_id text NOT NULL CHECK (length(seller_id)>0),
  currency text NOT NULL CHECK (currency='CNY'),
  descriptor_digest text NOT NULL CHECK (descriptor_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER saas_payment_merchant_bindings_immutable BEFORE UPDATE OR DELETE ON saas_payment_merchant_bindings
  FOR EACH ROW EXECUTE FUNCTION saas_reject_immutable_change();
CREATE TABLE saas_payment_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  currency text NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
  purpose text NOT NULL DEFAULT 'wallet_and_byok_plan' CHECK(purpose='wallet_and_byok_plan'),
  mode text NOT NULL DEFAULT 'disabled' CHECK(mode IN ('disabled','draining','enabled')),
  active_binding_id text REFERENCES saas_payment_merchant_bindings(id),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_by_user_id uuid REFERENCES saas_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(mode<>'enabled' OR active_binding_id IS NOT NULL)
);
INSERT INTO saas_payment_control(singleton) VALUES(true);
ALTER TABLE saas_payment_orders ADD COLUMN binding_id text REFERENCES saas_payment_merchant_bindings(id);
ALTER TABLE saas_service_plan_orders ADD COLUMN binding_id text REFERENCES saas_payment_merchant_bindings(id);
ALTER TABLE saas_payment_inbox ADD COLUMN binding_id text REFERENCES saas_payment_merchant_bindings(id);
ALTER TABLE saas_refund_orders ADD COLUMN binding_id text REFERENCES saas_payment_merchant_bindings(id);
CREATE FUNCTION saas_payment_binding_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.binding_id IS NOT NULL AND NEW.binding_id IS DISTINCT FROM OLD.binding_id THEN
    RAISE EXCEPTION 'Payment merchant binding is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_payment_orders_binding_guard BEFORE UPDATE OF binding_id ON saas_payment_orders FOR EACH ROW EXECUTE FUNCTION saas_payment_binding_identity_guard();
CREATE TRIGGER saas_service_plan_orders_binding_guard BEFORE UPDATE OF binding_id ON saas_service_plan_orders FOR EACH ROW EXECUTE FUNCTION saas_payment_binding_identity_guard();
CREATE TRIGGER saas_payment_inbox_binding_guard BEFORE UPDATE OF binding_id ON saas_payment_inbox FOR EACH ROW EXECUTE FUNCTION saas_payment_binding_identity_guard();
CREATE TRIGGER saas_refund_orders_binding_guard BEFORE UPDATE OF binding_id ON saas_refund_orders FOR EACH ROW EXECUTE FUNCTION saas_payment_binding_identity_guard();
`,
};
