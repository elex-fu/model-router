import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { FAST_GATEWAY_RETENTION_SAAS_MIGRATION as migration } from '../../../../src/saas/db/migrations/149_fast_gateway_retention.js';

test('149 narrows ledger triggers to UPDATE-only and gates DELETEs behind the retention flag', () => {
  assert.equal(SAAS_MIGRATIONS.at(-1), migration);
  assert.equal(migration.version, 149);
  assert.equal(migration.name, 'fast_gateway_retention');
  // The DELETE guard refuses every runtime role unless the transaction-local
  // retention flag is set by the retention task itself.
  assert.match(migration.sql, /CREATE FUNCTION saas_fast_retention_delete_guard\(\) RETURNS trigger/);
  assert.match(
    migration.sql,
    /current_setting\('model_router_saas\.fast_retention', true\) IS DISTINCT FROM 'on'/,
    'the guard must check the transaction-local GUC the retention task sets',
  );
  assert.match(migration.sql, /'Fast ledger rows are append-only; use the retention task' USING ERRCODE='55000'/);
  // UPDATE immutability is preserved by re-creating the original immutable
  // triggers as BEFORE UPDATE only (the originals were UPDATE OR DELETE).
  for (const table of ['saas_fast_gateway_intents', 'saas_fast_gateway_receipts', 'saas_fast_gateway_resolutions']) {
    assert.match(
      migration.sql,
      new RegExp(
        `DROP TRIGGER saas_fast_${table === 'saas_fast_gateway_intents' ? 'intents' : table === 'saas_fast_gateway_receipts' ? 'receipts' : 'resolutions'}_immutable ON ${table}`,
      ),
    );
    assert.match(
      migration.sql,
      new RegExp(
        `CREATE TRIGGER saas_fast_${table === 'saas_fast_gateway_intents' ? 'intents' : table === 'saas_fast_gateway_receipts' ? 'receipts' : 'resolutions'}_immutable BEFORE UPDATE ON ${table}\\s+FOR EACH ROW EXECUTE FUNCTION saas_billing_reject_ledger_mutation\\(\\)`,
      ),
      `${table} immutable trigger must be narrowed to BEFORE UPDATE only`,
    );
  }
  assert.doesNotMatch(migration.sql, /BEFORE UPDATE OR DELETE/, 'no immutable trigger may keep DELETE coverage');
  // Every ledger table gains an explicit retention DELETE guard.
  for (const event of ['intents', 'receipts', 'resolutions']) {
    assert.match(
      migration.sql,
      new RegExp(
        `CREATE TRIGGER saas_fast_${event}_retention_guard BEFORE DELETE ON saas_fast_gateway_${event}\\s+FOR EACH ROW EXECUTE FUNCTION saas_fast_retention_delete_guard\\(\\)`,
      ),
    );
  }
  // Retention sweep indexes: tenant-scoped time index plus the global cutoff
  // index used by the eligibility query.
  assert.match(
    migration.sql,
    /CREATE INDEX saas_fast_gateway_intents_tenant_time ON saas_fast_gateway_intents\(tenant_id, created_at DESC\)/,
  );
  assert.match(
    migration.sql,
    /CREATE INDEX saas_fast_gateway_intents_created_at ON saas_fast_gateway_intents\(created_at\)/,
  );
  // The migration only touches trigger surfaces and adds indexes: it must not
  // rewrite tables, drop data, or widen the truncate guards.
  assert.doesNotMatch(migration.sql, /\bTRUNCATE\b/);
  assert.doesNotMatch(migration.sql, /\bALTER\s+TABLE\b|\bDROP\s+TABLE\b|\bUPDATE\s+saas_|\bDELETE\s+FROM\s+saas_/i);
  assert.doesNotMatch(migration.sql, /\bGRANT\s+|\bSECURITY\s+DEFINER\b/);
});
