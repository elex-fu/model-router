import type { SaasMigration } from './001_initial_schema.js';

export const PAYMENT_CREATE_REQUEST_FINGERPRINT_SAAS_MIGRATION: SaasMigration = {
  version: 142,
  name: 'payment_create_request_fingerprint',
  sql: `
ALTER TABLE saas_payment_orders ADD COLUMN create_request_fingerprint text
  CHECK(create_request_fingerprint IS NULL OR create_request_fingerprint ~ '^[0-9a-f]{64}$');
CREATE FUNCTION saas_payment_create_request_fingerprint_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.create_request_fingerprint IS DISTINCT FROM OLD.create_request_fingerprint THEN
    RAISE EXCEPTION 'Payment create request fingerprint is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_payment_orders_create_request_fingerprint_immutable
  BEFORE UPDATE OF create_request_fingerprint ON saas_payment_orders
  FOR EACH ROW EXECUTE FUNCTION saas_payment_create_request_fingerprint_immutable();
`,
};
