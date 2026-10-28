import type { SaasMigration } from './001_initial_schema.js';

/**
 * Bounded fast ledger retention. Intents/receipts/resolutions stay
 * append-only for every runtime role; only the retention task may delete,
 * and only through a transaction-local flag it sets itself. UPDATE
 * immutability is preserved by narrowing the original UPDATE OR DELETE
 * triggers to UPDATE only and adding an explicit DELETE guard.
 */
export const FAST_GATEWAY_RETENTION_SAAS_MIGRATION: SaasMigration = {
  version: 149,
  name: 'fast_gateway_retention',
  sql: `
CREATE FUNCTION saas_fast_retention_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $g$
BEGIN
  IF current_setting('model_router_saas.fast_retention', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Fast ledger rows are append-only; use the retention task' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END; $g$;
DROP TRIGGER saas_fast_intents_immutable ON saas_fast_gateway_intents;
CREATE TRIGGER saas_fast_intents_immutable BEFORE UPDATE ON saas_fast_gateway_intents
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_intents_retention_guard BEFORE DELETE ON saas_fast_gateway_intents
  FOR EACH ROW EXECUTE FUNCTION saas_fast_retention_delete_guard();
DROP TRIGGER saas_fast_receipts_immutable ON saas_fast_gateway_receipts;
CREATE TRIGGER saas_fast_receipts_immutable BEFORE UPDATE ON saas_fast_gateway_receipts
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_receipts_retention_guard BEFORE DELETE ON saas_fast_gateway_receipts
  FOR EACH ROW EXECUTE FUNCTION saas_fast_retention_delete_guard();
DROP TRIGGER saas_fast_resolutions_immutable ON saas_fast_gateway_resolutions;
CREATE TRIGGER saas_fast_resolutions_immutable BEFORE UPDATE ON saas_fast_gateway_resolutions
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_resolutions_retention_guard BEFORE DELETE ON saas_fast_gateway_resolutions
  FOR EACH ROW EXECUTE FUNCTION saas_fast_retention_delete_guard();
CREATE INDEX saas_fast_gateway_intents_tenant_time ON saas_fast_gateway_intents(tenant_id, created_at DESC);
CREATE INDEX saas_fast_gateway_intents_created_at ON saas_fast_gateway_intents(created_at);
`,
};
