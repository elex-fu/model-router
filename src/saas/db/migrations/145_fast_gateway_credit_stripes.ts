import type { SaasMigration } from './001_initial_schema.js';

/** One conserved owner tranche, multiple independently locked credit rows. */
export const FAST_GATEWAY_CREDIT_STRIPES_SAAS_MIGRATION: SaasMigration = {
  version: 145,
  name: 'fast_gateway_conserved_credit_stripes',
  sql: `
ALTER TABLE saas_fast_credit_allocations ADD COLUMN stripe smallint NOT NULL DEFAULT 0 CHECK(stripe BETWEEN 0 AND 7);
DROP INDEX saas_fast_credit_active_owner_unique;
CREATE UNIQUE INDEX saas_fast_credit_active_owner_unique
  ON saas_fast_credit_allocations(tenant_id,currency,owner,epoch,stripe) WHERE state='active';
CREATE FUNCTION saas_fast_credit_guard_stripe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stripe IS DISTINCT FROM OLD.stripe THEN
    RAISE EXCEPTION 'Fast credit stripe identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_fast_credit_stripe_identity BEFORE UPDATE ON saas_fast_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION saas_fast_credit_guard_stripe();
`,
};
