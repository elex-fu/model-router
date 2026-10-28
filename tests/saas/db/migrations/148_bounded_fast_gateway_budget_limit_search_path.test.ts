import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { BOUNDED_FAST_GATEWAY_BUDGET_LIMIT_SEARCH_PATH_SAAS_MIGRATION as migration } from '../../../../src/saas/db/migrations/148_bounded_fast_gateway_budget_limit_search_path.js';

test('148 replaces only the deferred ceiling trigger function, binding it to a schema-qualified search_path', () => {
  assert.equal(SAAS_MIGRATIONS.at(-2), migration);
  assert.equal(migration.version, 148);
  assert.match(migration.sql, /CREATE OR REPLACE FUNCTION saas_fast_global_budget_limit\(\) RETURNS trigger/);
  assert.match(
    migration.sql,
    /SET search_path TO pg_catalog, model_router_saas, pg_temp/,
    'deferred ceiling validation must resolve the budgets table in any session search_path',
  );
  assert.match(migration.sql, /allocated_minor_units>credit_cap_minor_units/);
  assert.match(migration.sql, /Global fast credit ceiling exceeded' USING ERRCODE='23514'/);
  // The migration replaces the function body only: it must not recreate or
  // rebind the constraint trigger, touch the counter/identity triggers, or
  // rewrite any table (that would duplicate the deferred trigger).
  assert.doesNotMatch(migration.sql, /CREATE TRIGGER|DROP TRIGGER|DROP FUNCTION/);
  assert.doesNotMatch(migration.sql, /saas_fast_credit_allocations|allocated_minor_units=allocated_minor_units/);
  assert.doesNotMatch(migration.sql, /^UPDATE|^DELETE|^TRUNCATE/gm);
  assert.doesNotMatch(
    migration.sql,
    /SECURITY DEFINER/,
    'plain trigger stays invoker-rights like the identity trigger',
  );
});
