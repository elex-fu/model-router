import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { BOUNDED_FAST_GATEWAY_BUDGET_SAAS_MIGRATION as migration } from '../../../../src/saas/db/migrations/147_bounded_fast_gateway_budget.js';
import { SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS } from '../../../../src/saas/db/runtime-privileges.js';

test('147 appends a global wallet budget and immutable two-slot deployment without rewriting existing rows', () => {
  assert.equal(SAAS_MIGRATIONS.at(-1), migration);
  assert.equal(migration.version, 147);
  assert.match(migration.sql, /slot IN \(0,1\)/);
  assert.match(migration.sql, /UNIQUE \(deployment_id,slot\)/);
  assert.match(
    migration.sql,
    /FOREIGN KEY \(owner,epoch\) REFERENCES saas_fast_gateway_owners\(owner,epoch\) DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(migration.sql, /PRIMARY KEY \(tenant_id,currency\)/);
  assert.match(migration.sql, /PRIMARY KEY \(owner,epoch\)/);
  assert.match(
    migration.sql,
    /INSERT INTO saas_fast_gateway_owner_activations\(owner,epoch\) VALUES\(NEW.owner,NEW.epoch\)/,
  );
  assert.match(migration.sql, /epoch uuid NOT NULL UNIQUE/);
  assert.doesNotMatch(migration.sql, /^UPDATE saas_fast_credit_allocations|^DELETE|^TRUNCATE/gm);
  assert.doesNotMatch(migration.sql, /expires_at|lease_until|clock_timestamp\(\)/);
});

test('backing counter is trigger-only, atomic and deferred across stripe rebalance; available-only hot writes are unchanged', () => {
  const sql = migration.sql;
  assert.match(sql, /AFTER INSERT OR UPDATE OF backing_minor_units ON saas_fast_credit_allocations/);
  assert.match(sql, /IF delta=0 THEN RETURN NULL; END IF/);
  assert.match(sql, /SET allocated_minor_units=allocated_minor_units\+delta/);
  assert.match(
    sql,
    /allocated_minor_units numeric\(40,0\)/,
    'temporary exact stripe movement must not overflow bigint near its ceiling',
  );
  assert.match(sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /allocated_minor_units>credit_cap_minor_units/);
  assert.match(sql, /SECURITY DEFINER\s+SET search_path TO pg_catalog, model_router_saas, pg_temp/);
  assert.match(sql, /REVOKE ALL ON FUNCTION saas_fast_global_budget_backing\(\) FROM PUBLIC/);
  assert.match(sql, /TG_TABLE_SCHEMA<>'model_router_saas'/);
  const backingFunction = sql.slice(
    sql.indexOf('CREATE FUNCTION saas_fast_global_budget_backing()'),
    sql.indexOf('REVOKE ALL ON FUNCTION saas_fast_global_budget_backing()'),
  );
  assert.doesNotMatch(backingFunction, /pg_advisory/, 'allocation row locks must never invert the wallet fence');
  assert.match(sql, /PERFORM pg_advisory_xact_lock\(hashtextextended\('model-router:wallet-fence:'/);
  assert.equal(
    SAAS_GATEWAY_RUNTIME_COLUMN_GRANTS.some(
      ([table, column, privilege]) =>
        table === 'saas_fast_gateway_credit_budgets' && column === 'allocated_minor_units' && privilege === 'UPDATE',
    ),
    false,
  );
});
