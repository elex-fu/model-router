import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SAAS_MIGRATIONS } from '../../../src/saas/db/migrations/001_initial_schema.js';
import { PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/027_prepared_request_evidence_claim_pool_fence.js';
import { PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/028_prepared_request_evidence_pool_claim_hardening.js';
import { MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/029_model_resolution_provenance.js';
import { PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION } from '../../../src/saas/db/migrations/030_payment_orders_wallet_topup.js';
import { BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/031_byok_service_plan_subscription_fulfillment.js';
import { PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION } from '../../../src/saas/db/migrations/032_payment_checkout_and_submission_fencing.js';
import { PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION } from '../../../src/saas/db/migrations/033_payment_webhook_durable_inbox.js';
import { PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/034_provider_catalog_product_write_fence.js';
import { CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/035_credential_validation_jobs.js';
import { GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/036_gateway_idempotency_keys.js';
import { PAYMENT_REFUNDS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/037_payment_refunds.js';
import { GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/038_gateway_request_capacity.js';
import { PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/039_provider_credential_wrapper_history.js';
import { GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION } from '../../../src/saas/db/migrations/040_gateway_provider_account_runtime_health.js';
import { GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/041_gateway_provider_account_affinity.js';
import { CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/042_capacity_policy_audit_details.js';
import { CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/043_customer_webhook_delivery.js';
import { PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/044_project_service_key_authorization.js';
import { BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/045_byok_refund_entitlement_effect.js';
import { PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/046_platform_authorization_fences.js';
import { IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/047_identity_key_authorization_fences.js';
import { RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/048_runtime_role_lock_fences.js';
import { UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/049_unknown_outcome_reconciliation.js';
import { PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/050_prepared_evidence_authorization_advisory_fences.js';
import { UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION } from '../../../src/saas/db/migrations/051_unknown_outcome_support_ticket.js';
import { COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION } from '../../../src/saas/db/migrations/052_commercial_authority_guard_rowtype_safety.js';

test('SaaS migration registry keeps a contiguous history and stable append order', () => {
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 33).map(({ version }) => version),
    Array.from({ length: 33 }, (_, index) => index + 1),
  );
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ version }) => version)).size, SAAS_MIGRATIONS.length);
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ name }) => name)).size, SAAS_MIGRATIONS.length);
  assert.equal(SAAS_MIGRATIONS[26], PREPARED_REQUEST_EVIDENCE_CLAIM_POOL_FENCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[27], PREPARED_REQUEST_EVIDENCE_POOL_CLAIM_HARDENING_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[28], MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[29], PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[30], BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[31], PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[32], PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[33], PROVIDER_CATALOG_PRODUCT_WRITE_FENCE_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[34], CREDENTIAL_VALIDATION_JOBS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[35], GATEWAY_REQUEST_IDEMPOTENCY_KEYS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[36], PAYMENT_REFUNDS_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[37], GATEWAY_REQUEST_CAPACITY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[38], PROVIDER_CREDENTIAL_WRAPPER_HISTORY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[39], GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[40], GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION);
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 52 }, (_, index) => index + 1),
  );
});

test('migrations 043-052 append in order', () => {
  const appendedMigrations = [
    CUSTOMER_WEBHOOK_DELIVERY_SAAS_MIGRATION,
    PROJECT_SERVICE_KEY_AUTHORIZATION_SAAS_MIGRATION,
    BYOK_REFUND_ENTITLEMENT_EFFECT_SAAS_MIGRATION,
    PLATFORM_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    IDENTITY_KEY_AUTHORIZATION_FENCES_SAAS_MIGRATION,
    RUNTIME_ROLE_LOCK_FENCES_SAAS_MIGRATION,
    UNKNOWN_OUTCOME_RECONCILIATION_SAAS_MIGRATION,
    PREPARED_EVIDENCE_AUTHORIZATION_ADVISORY_FENCES_SAAS_MIGRATION,
    UNKNOWN_OUTCOME_SUPPORT_TICKET_SAAS_MIGRATION,
    COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION,
  ];

  assert.equal(SAAS_MIGRATIONS.length, 52);
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(42).map(({ name }) => name),
    [
      'customer_webhook_delivery',
      'project_service_key_authorization_and_policy_invalidation',
      'byok_refund_entitlement_effect',
      'platform_authorization_fences',
      'identity_key_authorization_fences',
      'runtime_role_lock_fences',
      'unknown_outcome_reconciliation_cases_and_observations',
      'prepared_evidence_authorization_advisory_fences',
      'unknown_outcome_support_ticket',
      'commercial_authority_guard_rowtype_safety',
    ],
  );
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 52 }, (_, index) => index + 1),
  );
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ version }) => version)).size, 52);
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ name }) => name)).size, 52);
  appendedMigrations.forEach((migration, index) => {
    assert.equal(SAAS_MIGRATIONS[index + 42], migration);
  });
});

test('migration 041 appends after health without reordering the registered prefix', () => {
  assert.equal(SAAS_MIGRATIONS[39], GATEWAY_PROVIDER_ACCOUNT_RUNTIME_HEALTH_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[40], GATEWAY_PROVIDER_ACCOUNT_AFFINITY_SAAS_MIGRATION);
  assert.equal(SAAS_MIGRATIONS[41], CAPACITY_POLICY_AUDIT_DETAILS_SAAS_MIGRATION);
  assert.ok(SAAS_MIGRATIONS.slice(42).every(({ version }) => version > 42));
});

test('migrations 029-033 preserve append order without constraining later migrations', () => {
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 33).map(({ version }) => version),
    Array.from({ length: 33 }, (_, index) => index + 1),
  );
  assert.deepEqual(SAAS_MIGRATIONS[28], MODEL_RESOLUTION_PROVENANCE_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS[29], PAYMENT_ORDERS_WALLET_TOPUP_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS[30], BYOK_SERVICE_PLAN_SUBSCRIPTION_FULFILLMENT_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS[31], PAYMENT_CHECKOUT_AND_SUBMISSION_FENCING_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS[32], PAYMENT_WEBHOOK_DURABLE_INBOX_SAAS_MIGRATION);
  assert.ok(SAAS_MIGRATIONS.slice(33).every(({ version }) => version > 33));
});
