import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import { CUSTOMER_WEBHOOK_TENANT_POLICY_ENTITLEMENT_SAAS_MIGRATION } from '../../../../src/saas/db/migrations/087_customer_webhook_tenant_policy_entitlement.js';

// Static candidate/source assertions only. No mock database, SQL evaluator,
// or claim of managed PostgreSQL acceptance.
const migration = CUSTOMER_WEBHOOK_TENANT_POLICY_ENTITLEMENT_SAAS_MIGRATION;
const sql = migration.sql;
const commands = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

test('087 registers after 085 with the 086 E-slot reserved and 061/062 + retired 064-079 gaps intact', () => {
  assert.equal(migration.version, 87);
  assert.equal(migration.name, 'customer_webhook_tenant_policy_entitlement');
  assert.deepEqual(Object.keys(migration).sort(), ['name', 'sql', 'version']);
  const registered = SAAS_MIGRATIONS.map(({ version }) => version);
  assert.equal(registered.includes(61), false);
  assert.equal(registered.includes(62), false);
  for (let skipped = 64; skipped <= 79; skipped += 1) {
    assert.equal(registered.includes(skipped), false, `${skipped} stays a retired Track D-G gap`);
  }
  assert.equal(registered.includes(86), false, '086 stays a reserved Track E slot');
  assert.equal(SAAS_MIGRATIONS[67], migration);
});

test('087 adds the entitlement whitelist with the full seven-type default preserving pre-087 behavior', () => {
  assert.match(
    commands,
    /ALTER TABLE saas_customer_webhook_tenant_policies\s+ADD COLUMN allowed_event_types text\[\] NOT NULL DEFAULT ARRAY\[/,
  );
  for (const eventType of [
    'wallet.low_balance',
    'api_key.expiring',
    'service_plan_order.status_changed',
    'refund.status_changed',
    'request.completed',
    'usage.completed',
    'platform.maintenance',
  ]) {
    assert.ok(commands.includes(`'${eventType}'`), `default and CHECK whitelist include ${eventType}`);
  }
  assert.match(
    commands,
    /CONSTRAINT saas_customer_webhook_policies_allowed_event_types_check CHECK \(\s*cardinality\(allowed_event_types\) BETWEEN 1 AND 7/,
  );
  assert.match(commands, /array_position\(allowed_event_types, NULL\) IS NULL/);
  assert.match(commands, /allowed_event_types <@ ARRAY\[/);
  // Uniqueness must be pg_catalog-only per-value occurrence caps: the runtime
  // role template revokes EXECUTE on every model_router_saas function and
  // CHECK expressions evaluate with the writer's privileges (056's pattern).
  assert.doesNotMatch(commands, /saas_customer_webhook_text_array_is_unique/);
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
      commands,
      new RegExp(
        `pg_catalog\\.cardinality\\(pg_catalog\\.array_positions\\(allowed_event_types, '${eventType}'::text\\)\\) <= 1`,
      ),
      `occurrence cap for ${eventType}`,
    );
  }
  // The default must be exactly the frozen seven-type set so existing enabled
  // policies observe no behavior change.
  const defaultMatch = /DEFAULT ARRAY\[([\s\S]*?)\]::text\[\]/.exec(commands);
  assert.ok(defaultMatch);
  const defaultTypes = [...defaultMatch[1].matchAll(/'([a-z_.]+)'/g)].map((match) => match[1]);
  assert.equal(defaultTypes.length, 7);
});

test('087 adds the nullable low-balance threshold with a positive bounded range', () => {
  assert.match(commands, /ADD COLUMN low_balance_threshold_minor_units bigint,/);
  assert.doesNotMatch(commands, /ADD COLUMN low_balance_threshold_minor_units bigint NOT NULL/);
  assert.match(
    commands,
    /CONSTRAINT saas_customer_webhook_policies_low_balance_threshold_range CHECK \(\s*low_balance_threshold_minor_units IS NULL/,
  );
  assert.match(commands, /low_balance_threshold_minor_units > 0/);
  assert.match(commands, /low_balance_threshold_minor_units <= 9007199254740991/);
});

test('087 has no trigger, ACL, epoch, or lifecycle shape changes', () => {
  assert.doesNotMatch(commands, /CREATE TRIGGER|DROP TRIGGER|GRANT |REVOKE |DROP COLUMN|DROP TABLE|CREATE TABLE/i);
  assert.doesNotMatch(commands, /NOT NULL DEFAULT clock_timestamp/);
});
