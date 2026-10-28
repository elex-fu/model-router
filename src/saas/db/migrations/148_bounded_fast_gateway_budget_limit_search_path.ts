import type { SaasMigration } from './001_initial_schema.js';

/**
 * Migration 147's deferred constraint trigger function
 * saas_fast_global_budget_limit() lacks the SET search_path that
 * saas_fast_global_budget_backing() carries, so a session whose search_path
 * does not lead with model_router_saas (operator tooling, non-schema-qualified
 * pools) fails the trigger itself with "relation does not exist", masking the
 * real 23514 "Global fast credit ceiling exceeded" money-boundary error. This
 * only replaces the function body and search_path; the existing constraint
 * trigger binding and behavior are unchanged. Observed in the 2026-10-27
 * local bench incident (docs/performance/local-ab-sub2api-20261028.md).
 */
export const BOUNDED_FAST_GATEWAY_BUDGET_LIMIT_SEARCH_PATH_SAAS_MIGRATION: SaasMigration = {
  version: 148,
  name: 'bounded_fast_gateway_budget_limit_search_path',
  sql: `
CREATE OR REPLACE FUNCTION saas_fast_global_budget_limit() RETURNS trigger LANGUAGE plpgsql
  SET search_path TO pg_catalog, model_router_saas, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM saas_fast_gateway_credit_budgets
    WHERE tenant_id=NEW.tenant_id AND currency=NEW.currency AND allocated_minor_units>credit_cap_minor_units) THEN
    RAISE EXCEPTION 'Global fast credit ceiling exceeded' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
`,
};
