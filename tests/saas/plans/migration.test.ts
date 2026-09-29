import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/031_byok_service_plan_subscription_fulfillment.js';

const migration = BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION;

test('031 defines a forward-only BYOK plan/order/snapshot/subscription schema after 030', () => {
  assert.equal(migration.version, 31);
  assert.equal(migration.name, 'byok_service_plan_subscription_fulfillment');
  assert.equal(SAAS_MIGRATIONS[29]?.version, 30);
  assert.equal(SAAS_MIGRATIONS[30], migration);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 31).map(({ version }) => version),
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  assert.doesNotMatch(migration.sql, /DROP\s+(?:TABLE|COLUMN|TRIGGER|FUNCTION)/i);
  assert.doesNotMatch(migration.sql, /saas_(?:payment_orders|payment_inbox|wallets|ledger_)/i);

  assert.match(migration.sql, /CREATE TABLE saas_service_plans/i);
  assert.match(migration.sql, /CREATE TABLE saas_service_plan_versions/i);
  assert.match(migration.sql, /supply_mode text NOT NULL CHECK \(supply_mode = 'byok'\)/i);
  assert.match(migration.sql, /allowed_provider_ids text\[\] NOT NULL/i);
  assert.match(migration.sql, /allowed_models text\[\] NOT NULL/i);
  assert.match(migration.sql, /price_version text NOT NULL/i);
  assert.match(migration.sql, /price_minor_units bigint NOT NULL/i);
  assert.match(migration.sql, /currency text NOT NULL/i);
  assert.match(migration.sql, /term_days integer NOT NULL/i);
  assert.match(migration.sql, /policy_version text NOT NULL/i);

  assert.match(migration.sql, /CREATE TABLE saas_service_plan_orders/i);
  assert.match(migration.sql, /client_request_id text NOT NULL/i);
  assert.match(migration.sql, /UNIQUE \(tenant_id, client_request_id\)/i);
  assert.match(migration.sql, /UNIQUE \(verified_provider_key, verified_merchant_id, verified_settlement_id\)/i);
  assert.match(migration.sql, /state IN \(\s*'pending', 'paid', 'fulfilling', 'fulfilled', 'cancelled',/i);
  assert.match(migration.sql, /verified_settlement_id text/i);
  assert.match(migration.sql, /fulfillment_evidence_sha256 text/i);

  assert.match(migration.sql, /CREATE TABLE saas_service_plan_snapshots/i);
  assert.match(migration.sql, /saas_service_plan_snapshots_order_unique/i);
  assert.match(migration.sql, /snapshot_digest text NOT NULL/i);
  assert.match(migration.sql, /CREATE TABLE saas_service_plan_subscriptions/i);
  assert.match(migration.sql, /previous_subscription_id uuid/i);
  assert.match(migration.sql, /saas_service_plan_subscriptions_lifecycle_shape/i);
});

test('031 binds plan fulfillment to tenant/project entitlements and freezes lifecycle facts', () => {
  const { sql } = migration;
  assert.match(sql, /ADD COLUMN source_type text NOT NULL DEFAULT 'legacy'/i);
  assert.match(sql, /ADD COLUMN source_ref text/i);
  assert.match(sql, /ADD COLUMN service_plan_snapshot_id uuid/i);
  assert.match(sql, /saas_project_entitlements_service_plan_snapshot_fk/i);
  assert.match(sql, /saas_service_plan_subscriptions_entitlement_fk/i);
  assert.match(sql, /saas_service_plan_orders_renewal_fk/i);
  assert.match(sql, /saas_service_plan_orders_subscription_fk/i);
  assert.match(sql, /Service plan snapshots are immutable/i);
  assert.match(sql, /Service plan order identity and fulfillment evidence are immutable/i);
  assert.match(sql, /Service plan subscription identity and term are immutable/i);
  assert.match(sql, /Service plan entitlement authority facts are immutable/i);
  assert.match(sql, /Fulfilled service plan orders require verified settlement evidence/i);
  assert.match(sql, /Fulfilled service plan orders require a subscription/i);
});
