import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION } from '../../../src/saas/db/migrations/053_commercial_authority_read_fences.js';
import { TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/054_trigger_only_trusted_execution.js';
import { PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/055_prepared_evidence_optional_validity_scalars.js';
import { RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/056_restricted_role_check_and_platform_auth_execution.js';
import { NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION } from '../../../src/saas/db/migrations/057_normal_success_usage_evidence_reference.js';
import { CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/058_credential_validation_invalidation_trigger_execution.js';
import { PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION } from '../../../src/saas/db/migrations/059_pre_dispatch_terminal_cancellation.js';
import { PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION } from '../../../src/saas/db/migrations/060_prepared_evidence_claim_generated_account.js';

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
    SAAS_MIGRATIONS.slice(0, 52).map(({ version }) => version),
    Array.from({ length: 52 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
});

test('migrations 043-060 append in order', () => {
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
    COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION,
    TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION,
    PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION,
    RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION,
    NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION,
    CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
    PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION,
    PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION,
  ];

  assert.equal(SAAS_MIGRATIONS.length, 60);
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
      'commercial_authority_read_fences',
      'trigger_only_trusted_execution',
      'prepared_evidence_optional_validity_scalars',
      'restricted_role_check_and_platform_auth_execution',
      'normal_success_usage_evidence_reference',
      'credential_validation_invalidation_trigger_execution',
      'pre_dispatch_terminal_cancellation',
      'prepared_evidence_claim_generated_account',
    ],
  );
  assert.deepEqual(
    SAAS_MIGRATIONS.map(({ version }) => version),
    Array.from({ length: 60 }, (_, index) => index + 1),
  );
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ version }) => version)).size, 60);
  assert.equal(new Set(SAAS_MIGRATIONS.map(({ name }) => name)).size, 60);
  appendedMigrations.forEach((migration, index) => {
    assert.equal(SAAS_MIGRATIONS[index + 42], migration);
  });
});

test('migration 053 preserves its exact append after the complete 001-052 historical prefix', () => {
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 52).map(({ version }) => version),
    Array.from({ length: 52 }, (_, index) => index + 1),
  );
  assert.equal(SAAS_MIGRATIONS[51], COMMERCIAL_AUTHORITY_GUARD_ROWTYPE_SAFETY_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(52, 53), [COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION]);
  assert.equal(SAAS_MIGRATIONS[52]?.version, 53);
  assert.equal(SAAS_MIGRATIONS[52]?.name, 'commercial_authority_read_fences');
});

test('migration 054 preserves its exact append after the complete 001-053 historical prefix', () => {
  assert.deepEqual(
    SAAS_MIGRATIONS.slice(0, 53).map(({ version }) => version),
    Array.from({ length: 53 }, (_, index) => index + 1),
  );
  assert.equal(SAAS_MIGRATIONS[52], COMMERCIAL_AUTHORITY_READ_FENCES_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(53, 54), [TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION]);
  assert.equal(SAAS_MIGRATIONS[53]?.version, 54);
  assert.equal(SAAS_MIGRATIONS[53]?.name, 'trigger_only_trusted_execution');
});

test('migration 055 preserves its exact append after the complete frozen 001-054 prefix', () => {
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 54).map(({ version }) => version),
    Array.from({ length: 54 }, (_, index) => index + 1));
  assert.equal(SAAS_MIGRATIONS[53], TRIGGER_ONLY_TRUSTED_EXECUTION_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(54, 55), [PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION]);
  assert.equal(SAAS_MIGRATIONS[54]?.version, 55);
  assert.equal(SAAS_MIGRATIONS[54]?.name, 'prepared_evidence_optional_validity_scalars');
});

test('migration 056 preserves its exact append after the complete frozen 001-055 prefix', () => {
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 55).map(({ version }) => version),
    Array.from({ length: 55 }, (_, index) => index + 1));
  assert.equal(SAAS_MIGRATIONS[54], PREPARED_EVIDENCE_OPTIONAL_VALIDITY_SCALARS_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(55, 56), [RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION]);
  assert.equal(SAAS_MIGRATIONS[55]?.version, 56);
  assert.equal(SAAS_MIGRATIONS[55]?.name, 'restricted_role_check_and_platform_auth_execution');
});

test('057 FIN evidence and 058 trigger execution are the exact forwards after the frozen 001-056 prefix', () => {
  assert.equal(SAAS_MIGRATIONS.slice(0, 58).length, 58);
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 56).map(({ version }) => version),
    Array.from({ length: 56 }, (_, index) => index + 1));
  assert.equal(SAAS_MIGRATIONS[55], RESTRICTED_ROLE_CHECK_AND_PLATFORM_AUTH_EXECUTION_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(56, 58), [
    NORMAL_SUCCESS_USAGE_EVIDENCE_REFERENCE_SAAS_MIGRATION,
    CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION,
  ]);
  assert.deepEqual(SAAS_MIGRATIONS.slice(56, 58).map(({ version, name }) => [version, name]), [
    [57, 'normal_success_usage_evidence_reference'],
    [58, 'credential_validation_invalidation_trigger_execution'],
  ]);
});

test('059 preserves its exact forward after frozen 001-058 without changing the Singer source', () => {
  assert.equal(SAAS_MIGRATIONS.slice(0, 59).length, 59);
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 58).map(({ version }) => version),
    Array.from({ length: 58 }, (_, index) => index + 1));
  assert.equal(SAAS_MIGRATIONS[57], CREDENTIAL_VALIDATION_INVALIDATION_TRIGGER_EXECUTION_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(58, 59), [PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION]);
  assert.equal(SAAS_MIGRATIONS[58]?.version, 59);
  assert.equal(SAAS_MIGRATIONS[58]?.name, 'pre_dispatch_terminal_cancellation');
  const source = readFileSync(resolve(process.cwd(), 'src/saas/db/migrations/059_pre_dispatch_terminal_cancellation.ts'));
  assert.equal(createHash('sha256').update(source).digest('hex'),
    '7c86dc81ea1ddea6b0a46c2bcea4837c9a83e705ae817106e3cbae5ccdb8b5ed');
});

test('060 is the exact current forward after the complete frozen 001-059 prefix', () => {
  assert.equal(SAAS_MIGRATIONS.length, 60);
  assert.deepEqual(SAAS_MIGRATIONS.slice(0, 59).map(({ version }) => version),
    Array.from({ length: 59 }, (_, index) => index + 1));
  assert.equal(SAAS_MIGRATIONS[58], PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION);
  assert.deepEqual(SAAS_MIGRATIONS.slice(59), [PREPARED_EVIDENCE_CLAIM_GENERATED_ACCOUNT_SAAS_MIGRATION]);
  assert.equal(SAAS_MIGRATIONS[59]?.version, 60);
  assert.equal(SAAS_MIGRATIONS[59]?.name, 'prepared_evidence_claim_generated_account');
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
