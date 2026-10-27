import type { SaasMigration } from './001_initial_schema.js';

/** Opt-in global wallet escrow ceiling; no history rewrite and no expiry-based release. */
export const BOUNDED_FAST_GATEWAY_BUDGET_SAAS_MIGRATION: SaasMigration = {
  version: 147,
  name: 'bounded_fast_gateway_global_budget',
  sql: `
CREATE TABLE saas_fast_gateway_deployments (
  deployment_id text PRIMARY KEY CHECK (deployment_id ~ '^[a-zA-Z0-9_:-]{1,128}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  credit_cap_minor_units bigint NOT NULL CHECK (credit_cap_minor_units > 0)
);
ALTER TABLE saas_fast_gateway_owners ADD CONSTRAINT saas_fast_bounded_owner_epoch_unique UNIQUE (owner,epoch);
CREATE TABLE saas_fast_gateway_owner_slots (
  owner text PRIMARY KEY REFERENCES saas_fast_gateway_owners(owner),
  deployment_id text NOT NULL REFERENCES saas_fast_gateway_deployments(deployment_id),
  slot smallint NOT NULL CHECK (slot IN (0,1)),
  epoch uuid NOT NULL,
  active boolean NOT NULL DEFAULT false,
  retired_epoch uuid,
  UNIQUE (deployment_id,slot),
  FOREIGN KEY (owner,epoch) REFERENCES saas_fast_gateway_owners(owner,epoch) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE saas_fast_gateway_owner_activations (
  owner text NOT NULL REFERENCES saas_fast_gateway_owner_slots(owner),
  epoch uuid NOT NULL UNIQUE,
  PRIMARY KEY (owner,epoch)
);
CREATE TABLE saas_fast_gateway_credit_budgets (
  tenant_id uuid NOT NULL,
  currency text NOT NULL,
  deployment_id text NOT NULL REFERENCES saas_fast_gateway_deployments(deployment_id),
  credit_cap_minor_units bigint NOT NULL CHECK (credit_cap_minor_units > 0),
  allocated_minor_units numeric(40,0) NOT NULL CHECK (allocated_minor_units >= 0),
  PRIMARY KEY (tenant_id,currency),
  FOREIGN KEY (tenant_id,currency) REFERENCES saas_wallets(tenant_id,currency)
);
CREATE FUNCTION saas_fast_bounded_slot_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner IS DISTINCT FROM OLD.owner OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.slot IS DISTINCT FROM OLD.slot
    OR NEW.epoch = OLD.epoch OR NEW.active = OLD.active
    OR (NEW.active AND NEW.retired_epoch IS DISTINCT FROM OLD.retired_epoch)
    OR (NOT NEW.active AND NEW.retired_epoch IS DISTINCT FROM OLD.epoch) THEN
    RAISE EXCEPTION 'Bounded slot identity or epoch transition is invalid' USING ERRCODE='55000';
  END IF;
  IF NEW.active THEN
    /* The transition itself consumes a never-used epoch. Merely finding an old
     * history row would let direct supported-role SQL resurrect a stale fence. */
    INSERT INTO saas_fast_gateway_owner_activations(owner,epoch) VALUES(NEW.owner,NEW.epoch);
  END IF;
  IF NOT NEW.active AND EXISTS (SELECT 1 FROM saas_fast_gateway_owner_activations WHERE epoch=NEW.epoch) THEN
    RAISE EXCEPTION 'Bounded idle fence cannot reuse an activation epoch' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_fast_bounded_slot_identity BEFORE UPDATE ON saas_fast_gateway_owner_slots
  FOR EACH ROW EXECUTE FUNCTION saas_fast_bounded_slot_identity();
CREATE FUNCTION saas_fast_bounded_owner_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM saas_fast_gateway_owner_slots s WHERE s.owner=OLD.owner AND s.epoch<>NEW.epoch) THEN
    RAISE EXCEPTION 'Bounded owner requires explicit slot activation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_fast_bounded_owner_epoch BEFORE UPDATE OF epoch ON saas_fast_gateway_owners
  FOR EACH ROW EXECUTE FUNCTION saas_fast_bounded_owner_epoch();
CREATE FUNCTION saas_fast_global_budget_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_cap bigint; actual_backing numeric;
BEGIN
  IF TG_OP='INSERT' THEN
    /* Initialization takes the wallet fence BEFORE observing any allocation.
     * The AFTER allocation counter trigger must never acquire this lock. */
    PERFORM pg_advisory_xact_lock(hashtextextended('model-router:wallet-fence:'
      ||encode(convert_to(NEW.tenant_id::text,'UTF8'),'hex')||':'
      ||encode(convert_to(NEW.currency,'UTF8'),'hex'),0));
    SELECT credit_cap_minor_units INTO expected_cap FROM saas_fast_gateway_deployments WHERE deployment_id=NEW.deployment_id;
    SELECT COALESCE(SUM(backing_minor_units),0) INTO actual_backing FROM saas_fast_credit_allocations
      WHERE tenant_id=NEW.tenant_id AND currency=NEW.currency;
    IF NEW.credit_cap_minor_units IS DISTINCT FROM expected_cap OR NEW.allocated_minor_units<>actual_backing THEN
      RAISE EXCEPTION 'Global credit budget must include every existing owner and epoch' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.deployment_id IS DISTINCT FROM OLD.deployment_id
    OR NEW.credit_cap_minor_units IS DISTINCT FROM OLD.credit_cap_minor_units
    OR pg_trigger_depth()<>2 THEN
    RAISE EXCEPTION 'Global credit policy is immutable and its counter is trigger-owned' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER saas_fast_global_budget_identity BEFORE INSERT OR UPDATE ON saas_fast_gateway_credit_budgets
  FOR EACH ROW EXECUTE FUNCTION saas_fast_global_budget_identity();
/* Counter changes are serialized by the budget row. No advisory lock is taken
 * after an allocation row lock. Existing wallet-fenced backing writers retain
 * their lock order; reserve/receipt available-only writes do not fire this trigger. */
CREATE FUNCTION saas_fast_global_budget_backing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO pg_catalog, model_router_saas, pg_temp AS $$
DECLARE delta bigint;
BEGIN
  IF TG_TABLE_SCHEMA<>'model_router_saas' OR TG_TABLE_NAME<>'saas_fast_credit_allocations' OR TG_LEVEL<>'ROW'
    OR TG_WHEN<>'AFTER' OR TG_OP NOT IN ('INSERT','UPDATE') OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'Invalid global budget trigger binding' USING ERRCODE='55000';
  END IF;
  delta := CASE WHEN TG_OP='INSERT' THEN NEW.backing_minor_units ELSE NEW.backing_minor_units-OLD.backing_minor_units END;
  IF delta=0 THEN RETURN NULL; END IF;
  UPDATE model_router_saas.saas_fast_gateway_credit_budgets
    SET allocated_minor_units=allocated_minor_units+delta
    WHERE tenant_id=NEW.tenant_id AND currency=NEW.currency;
  RETURN NULL;
END; $$;
REVOKE ALL ON FUNCTION saas_fast_global_budget_backing() FROM PUBLIC;
CREATE TRIGGER saas_fast_global_budget_backing AFTER INSERT OR UPDATE OF backing_minor_units ON saas_fast_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION saas_fast_global_budget_backing();
/* A stripe rebalance may temporarily increase one row before decreasing another.
 * The transaction is the money boundary: deferred validation checks the latest
 * trigger-owned total, not an intermediate NEW record. Row locks serialize it. */
CREATE FUNCTION saas_fast_global_budget_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM saas_fast_gateway_credit_budgets
    WHERE tenant_id=NEW.tenant_id AND currency=NEW.currency AND allocated_minor_units>credit_cap_minor_units) THEN
    RAISE EXCEPTION 'Global fast credit ceiling exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER saas_fast_global_budget_limit AFTER INSERT OR UPDATE ON saas_fast_gateway_credit_budgets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION saas_fast_global_budget_limit();
CREATE TRIGGER saas_fast_deployment_no_mutation BEFORE UPDATE OR DELETE ON saas_fast_gateway_deployments
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_deployment_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_deployments
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_slots_no_delete BEFORE DELETE ON saas_fast_gateway_owner_slots
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_slots_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_owner_slots
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_activations_no_mutation BEFORE UPDATE OR DELETE ON saas_fast_gateway_owner_activations
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_activations_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_owner_activations
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_budgets_no_delete BEFORE DELETE ON saas_fast_gateway_credit_budgets
  FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
CREATE TRIGGER saas_fast_budgets_no_truncate BEFORE TRUNCATE ON saas_fast_gateway_credit_budgets
  FOR EACH STATEMENT EXECUTE FUNCTION saas_billing_reject_ledger_mutation();
`,
};
