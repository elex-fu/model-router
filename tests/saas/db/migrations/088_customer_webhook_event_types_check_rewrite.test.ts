import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import {
  CUSTOMER_WEBHOOK_EVENT_TYPES_CHECK_REWRITE_SAAS_MIGRATION,
  CUSTOMER_WEBHOOK_EVENT_TYPES_UNIQUE_CHECK_SQL,
} from '../../../../src/saas/db/migrations/088_customer_webhook_event_types_check_rewrite.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance; the Track F evidence test
// exercises this migration against the role-template database.
const migration = CUSTOMER_WEBHOOK_EVENT_TYPES_CHECK_REWRITE_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('088 registers after 087 with the 061/062 + retired 064-079 + 086 gaps intact', () => {
  assert.equal(migration.version, 88);
  assert.equal(migration.name, 'customer_webhook_event_types_check_rewrite');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false, `${skipped} stays a retired Track D-G gap`);
  }
  assert.equal(registered.includes(86), false, '086 stays a reserved Track E slot');
  assert.equal(SAAS_MIGRATIONS[68], migration);
});

test('088 rewrites the 043 event-types CHECK as equivalent pg_catalog-only SQL', () => {
  assert.match(commands, /DROP CONSTRAINT saas_customer_webhook_endpoint_versions_event_types/);
  assert.match(commands, /ADD CONSTRAINT saas_customer_webhook_endpoint_versions_event_types CHECK \(/);
  // The replacement keeps every historical conjunct and swaps only the
  // non-callable schema helper for per-value occurrence caps (056's pattern).
  assert.match(commands, /cardinality\(event_types\) BETWEEN 1 AND 7/);
  assert.match(commands, /array_position\(event_types, NULL\) IS NULL/);
  assert.match(commands, /event_types <@ ARRAY\[/);
  for (const eventType of [
    'wallet.low_balance',
    'api_key.expiring',
    'service_plan_order.status_changed',
    'refund.status_changed',
    'request.completed',
    'usage.completed',
    'platform.maintenance',
  ]) {
    assert.match(
      CUSTOMER_WEBHOOK_EVENT_TYPES_UNIQUE_CHECK_SQL,
      new RegExp(
        `pg_catalog\\.cardinality\\(pg_catalog\\.array_positions\\(event_types, '${eventType}'::text\\)\\) <= 1`,
      ),
      `occurrence cap for ${eventType}`,
    );
  }
  // The new constraint expression itself never calls the schema helper.
  assert.doesNotMatch(CUSTOMER_WEBHOOK_EVENT_TYPES_UNIQUE_CHECK_SQL, /saas_customer_webhook_text_array_is_unique/);
});

test('088 pins the exact historical constraint definition and its helper dependency before the swap', () => {
  assert.match(commands, /pg_get_constraintdef\(c\.oid, false\) = \$historical\$/);
  assert.match(commands, /conname = 'saas_customer_webhook_endpoint_versions_event_types'/);
  assert.match(commands, /c\.convalidated AND NOT c\.condeferrable AND NOT c\.condeferred/);
  assert.match(commands, /refobjid = helper_oid AND deptype = 'n'/);
  assert.match(
    commands,
    /to_regprocedure\('model_router_saas\.saas_customer_webhook_text_array_is_unique\(text\[\]\)'\)/,
  );
  // Existing rows must satisfy BOTH the historical helper and its replacement.
  assert.match(
    commands,
    /saas_customer_webhook_text_array_is_unique\(event_types\) IS NOT TRUE\s+OR \(\s*pg_catalog\.cardinality/,
  );
});

test('088 swaps the constraint atomically under a table lock and proves catalog/ACL stasis', () => {
  assert.match(
    commands,
    /LOCK TABLE model_router_saas\.saas_customer_webhook_endpoint_versions IN ACCESS EXCLUSIVE MODE/,
  );
  const alter =
    /ALTER TABLE model_router_saas\.saas_customer_webhook_endpoint_versions\s+DROP CONSTRAINT saas_customer_webhook_endpoint_versions_event_types,\s+ADD CONSTRAINT/;
  assert.match(commands, alter, 'one transactional ALTER drops and re-adds the constraint');
  assert.match(commands, /to_jsonb\(c\) - 'oid' - 'conbin' = check_shape AND c\.convalidated/);
  assert.match(commands, /function_catalog_after IS DISTINCT FROM function_catalog_before/);
  assert.match(commands, /table_acl_after IS DISTINCT FROM table_acl_before/);
  assert.match(commands, /column_catalog_after IS DISTINCT FROM column_catalog_before/);
  assert.match(commands, /constraint_catalog_after IS DISTINCT FROM constraint_catalog_before/);
  assert.match(commands, /trigger_catalog_after IS DISTINCT FROM trigger_catalog_before/);
  assert.match(
    commands,
    /has_function_privilege\(r\.oid, p\.oid, 'EXECUTE'\)[\s\S]*Migration 088 exceeded its one-CHECK catalog and unchanged ACL contract/,
  );
});

test('088 changes no roles, ACLs, functions, triggers, or data', () => {
  assert.doesNotMatch(commands, /\bGRANT\b|\bREVOKE\b|CREATE FUNCTION|DROP FUNCTION|ALTER FUNCTION|SECURITY DEFINER/i);
  assert.doesNotMatch(commands, /CREATE TRIGGER|DROP TRIGGER|INSERT INTO|UPDATE model_router_saas|DELETE FROM/i);
  assert.match(commands, /current_user IS DISTINCT FROM 'model_router_saas_migrator'/);
  assert.match(commands, /Migration 088 requires zero runtime application EXECUTE/);
});
