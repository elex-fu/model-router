import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION } from '../../../src/saas/db/migrations/030_payment_orders_wallet_topup.js';
import { BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/031_byok_service_plan_subscription_fulfillment.js';
import { PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/032_payment_checkout_and_submission_fencing.js';
import { PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION } from '../../../src/saas/db/migrations/033_payment_webhook_durable_inbox.js';
import { PAYMENT_REFUNDS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/037_payment_refunds.js';
import { BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/045_byok_refund_entitlement_effect.js';

test('migration 030 defines forward-only hosted wallet payment orders and a normalized inbox', () => {
  const migration = PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION;
  assert.equal(migration.version, 30);
  assert.equal(migration.name, 'payment_orders_wallet_topup_fulfillment');
  assert.match(migration.sql, /CREATE TABLE saas_payment_orders/);
  assert.match(migration.sql, /amount_minor_units bigint NOT NULL\s+CHECK \(amount_minor_units > 0\)/);
  assert.match(migration.sql, /currency text NOT NULL\s+CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'/);
  assert.match(migration.sql, /saas_payment_orders_tenant_client_request_unique/);
  assert.match(migration.sql, /saas_payment_orders_provider_order_unique/);
  assert.match(migration.sql, /saas_payment_orders_local_order_ref_unique/);
  assert.match(migration.sql, /saas_payment_orders_funding_reference_unique/);
  assert.match(migration.sql, /CREATE TABLE saas_payment_inbox/);
  assert.match(migration.sql, /saas_payment_inbox_provider_event_unique/);
  assert.match(migration.sql, /processing_outcome text NOT NULL/);
  assert.match(migration.sql, /event_tenant_id text NOT NULL/);
  assert.doesNotMatch(migration.sql, /raw|payload|secret/i);
  assert.match(migration.sql, /saas_payment_orders_guard_change/);
  assert.match(migration.sql, /saas_payment_inbox_guard_change/);
});

test('migration 031 links BYOK plan orders to an immutable PSP snapshot before settlement', () => {
  const migration = BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION;
  assert.equal(migration.version, 31);
  assert.match(migration.sql, /provider_key text/i);
  assert.match(migration.sql, /merchant_id text/i);
  assert.match(migration.sql, /provider_order_id text/i);
  assert.match(migration.sql, /saas_service_plan_orders_provider_order_unique/i);
  assert.match(migration.sql, /saas_service_plan_orders_provider_lookup_idx/i);
  assert.match(migration.sql, /Service plan provider attempts cannot decrease/i);
  assert.match(migration.sql, /provider_order_id IS NOT NULL/i);
});

test('migration 032 adds scalar checkout storage and submission fencing to both payment-order tables', () => {
  const migration = PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION;
  assert.equal(migration.version, 32);
  assert.equal(migration.name, 'payment_checkout_and_submission_fencing');
  assert.match(migration.sql, /ALTER TABLE saas_payment_orders/);
  assert.match(migration.sql, /ALTER TABLE saas_service_plan_orders/);
  assert.match(migration.sql, /checkout_kind text/);
  assert.match(migration.sql, /checkout_expires_at timestamptz/);
  assert.match(migration.sql, /provider_submission_lease_token text/);
  assert.match(migration.sql, /provider_submission_state IN \('idle', 'submitting', 'failed', 'unknown'\)/);
  assert.match(migration.sql, /checkout_shape CHECK/);
  assert.doesNotMatch(migration.sql, /payload|raw_provider|jsonb/i);
});

test('migration 033 turns normalized payment webhooks into a leased durable worker queue', () => {
  const migration = PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION;
  assert.equal(migration.version, 33);
  assert.equal(migration.name, 'payment_webhook_durable_inbox_worker');
  assert.match(migration.sql, /processing_state text NOT NULL DEFAULT 'processed'/);
  assert.match(migration.sql, /ALTER COLUMN processing_state SET DEFAULT 'pending'/);
  assert.match(migration.sql, /attempt_count integer NOT NULL DEFAULT 0/);
  assert.match(migration.sql, /lease_token text/);
  assert.match(migration.sql, /lease_expires_at timestamptz/);
  assert.match(migration.sql, /saas_payment_inbox_worker_lease_shape/);
  assert.match(migration.sql, /CREATE INDEX saas_payment_inbox_worker_queue_idx/);
  assert.match(migration.sql, /CREATE INDEX saas_payment_inbox_worker_expired_lease_idx/);
  assert.doesNotMatch(migration.sql, /raw_payload|provider_payload|jsonb/i);
});

test('migration 037 adds immutable refund orders, wallet freezes and balanced refund ledger source', () => {
  const migration = PAYMENT_REFUNDS_SAAS_MIGRATION;
  assert.equal(migration.version, 37);
  assert.equal(migration.name, 'payment_refunds_and_wallet_freezes');
  assert.match(migration.sql, /DROP CONSTRAINT saas_ledger_transactions_source_type_check/);
  assert.match(migration.sql, /'wallet_funding', 'billing_settlement', 'wallet_refund'/);
  assert.match(migration.sql, /source_type = 'wallet_refund'[\s\S]*COALESCE\(source_order_ref/);
  assert.match(migration.sql, /CREATE TABLE saas_refund_orders/);
  assert.match(migration.sql, /UNIQUE \(tenant_id, idempotency_namespace, client_request_id\)/);
  assert.match(migration.sql, /provider_order_id text NOT NULL/);
  assert.match(migration.sql, /state IN \('submitting', 'pending', 'succeeded', 'failed', 'unknown', 'blocked'\)/);
  assert.match(migration.sql, /CREATE TABLE saas_refund_wallet_freezes/);
  assert.match(migration.sql, /FOREIGN KEY \(wallet_id, tenant_id, currency\)/);
  assert.match(migration.sql, /An unresolved refund wallet freeze cannot be released/);
  assert.match(migration.sql, /Terminal refund orders are immutable/);
  assert.doesNotMatch(migration.sql, /secret|credential|raw_payload|provider_payload/i);
});

test('migration 045 adds auditable BYOK cancellation effects without rewriting historical blocked refunds', () => {
  const migration = BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION;
  assert.equal(migration.version, 45);
  assert.equal(migration.name, 'byok_refund_entitlement_effect');
  assert.match(migration.sql, /CREATE TABLE saas_refund_service_plan_effects/);
  assert.match(migration.sql, /refund_policy_version text NOT NULL/);
  assert.match(migration.sql, /service_plan_policy_version text NOT NULL/);
  assert.match(migration.sql, /amount_minor_units bigint NOT NULL/);
  assert.match(migration.sql, /cutoff_at timestamptz NOT NULL/);
  assert.match(migration.sql, /requested_by_user_id uuid NOT NULL/);
  assert.match(migration.sql, /reason_code text NOT NULL/);
  assert.match(migration.sql, /source_service_plan_order_id/);
  assert.match(migration.sql, /source_subscription_id/);
  assert.match(migration.sql, /source_entitlement_id/);
  assert.match(migration.sql, /UNIQUE \(tenant_id, refund_order_id\)/);
  assert.match(migration.sql, /one_unresolved_byok_per_order_idx/);
  assert.match(migration.sql, /state IN \('submitting', 'pending', 'unknown'\)/);
  assert.match(migration.sql, /source_service_plan_order_id, source_subscription_id/);
  assert.match(migration.sql, /source_entitlement_id\)\s+REFERENCES saas_project_entitlements/);
  assert.match(migration.sql, /state IN \('provisionally_suspended', 'not_suspended', 'succeeded', 'failed'\)/);
  assert.match(
    migration.sql,
    /CONSTRAINT saas_refund_service_plan_effects_release_shape CHECK \(\s*suspension_released_at IS NULL\s+OR \(state = 'failed' AND suspended_authz_version IS NOT NULL AND released_authz_version > suspended_authz_version\)\s*\)\s*\);/,
  );
  assert.match(migration.sql, /service_plan_effect_ref IS NULL/);
  assert.match(migration.sql, /wallet_id IS NULL/);
  assert.match(migration.sql, /original_funding_transaction_id IS NULL/);
  assert.match(migration.sql, /wallet_refund_transaction_id IS NULL/);
  assert.match(migration.sql, /DROP CONSTRAINT saas_refund_orders_provider_attempt_shape/);
  assert.match(migration.sql, /state = 'blocked' AND provider_attempts = 0/);
  assert.match(migration.sql, /state <> 'blocked' AND provider_attempts >= 1/);
  assert.match(migration.sql, /Terminal service-plan refund effects are immutable/);
  assert.match(migration.sql, /NEW\.suspended_authz_version IS DISTINCT FROM OLD\.suspended_authz_version/);
  assert.match(migration.sql, /NEW\.suspended_at IS DISTINCT FROM OLD\.suspended_at/);
  assert.match(migration.sql, /Service-plan refund effect identity is immutable/);
  assert.doesNotMatch(migration.sql, /UPDATE\s+saas_refund_orders/i);
  assert.doesNotMatch(migration.sql, /DELETE\s+FROM\s+saas_refund_orders/i);
  assert.doesNotMatch(migration.sql, /saas_wallets|saas_ledger_transactions|saas_refund_wallet_freezes/);
});
