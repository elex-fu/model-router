import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION } from '../../../src/saas/db/migrations/017_commercial_price_versions.js';
import { toPlatformPricingReferences, toPlatformRequestAdmissionTerms } from '../../../src/saas/pricing/index.js';
import type { CustomerPriceSnapshotRecord, SupplierCostSnapshotRecord } from '../../../src/saas/pricing/types.js';

const customerSnapshot: CustomerPriceSnapshotRecord = {
  id: 'customer-snapshot-1',
  tenantId: 'tenant-1',
  requestId: 'request-1',
  customerPriceVersion: 'customer-price-1',
  publicModelId: 'public-model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'USD',
  commercialPolicyVersion: 'policy-1',
  calculatorVersion: 'calculator-1',
  roundingVersion: 'rounding-1',
  roundingMode: 'half_up',
  roundingBoundary: 'total',
  holdInput: {
    inputTotal: 1n,
    inputUncached: 1n,
    cacheRead: 0n,
    cacheWrite: 0n,
    cacheWrite5m: 0n,
    cacheWrite1h: 0n,
    outputTotal: 1n,
    reasoningOutput: 0n,
  },
  holdAmountMinorUnits: 1n,
  walletHoldRequired: true,
  admissionExpiresAt: '2026-09-28T00:05:00.000Z',
  idempotencyKey: 'admission-1',
  snapshotDigest: 'a'.repeat(64),
  createdAt: '2026-09-28T00:00:00.000Z',
};

const supplierSnapshot: SupplierCostSnapshotRecord = {
  id: 'supplier-snapshot-1',
  tenantId: 'tenant-1',
  requestId: 'request-1',
  attemptId: 'attempt-1',
  supplierCostVersion: 'supplier-cost-1',
  platformAccountId: 'platform-account-1',
  publicModelId: 'public-model-1',
  publicModelVersion: 1,
  providerId: 'provider-1',
  productId: 'product-1',
  resolvedModel: 'provider-model-1',
  protocol: 'openai',
  endpoint: 'chat-completions',
  currency: 'CNY',
  commercialPolicyVersion: 'policy-1',
  calculatorVersion: 'calculator-1',
  roundingVersion: 'rounding-1',
  roundingMode: 'half_up',
  roundingBoundary: 'total',
  idempotencyKey: 'attempt-1',
  snapshotDigest: 'b'.repeat(64),
  createdAt: '2026-09-28T00:00:00.000Z',
};

test('exports migration 17 without changing the registry', () => {
  const migration = COMMERCIAL_PRICE_VERSIONS_SAAS_MIGRATION;
  assert.equal(migration.version, 17);
  assert.equal(migration.name, 'commercial_price_versions_and_request_snapshots');
  assert.match(migration.sql, /CREATE TABLE saas_customer_price_versions/);
  assert.match(migration.sql, /CREATE TABLE saas_supplier_cost_versions/);
  assert.match(migration.sql, /CREATE TABLE saas_request_customer_price_snapshots/);
  assert.match(migration.sql, /CREATE TABLE saas_attempt_supplier_cost_snapshots/);
  assert.match(migration.sql, /input_rate_numerator_minor_units bigint NOT NULL/);
  assert.match(migration.sql, /input_rate_denominator_units bigint NOT NULL/);
  assert.match(migration.sql, /rounding_boundary text NOT NULL[\s\S]*CHECK \(rounding_boundary = 'total'\)/);
  assert.match(migration.sql, /CREATE TRIGGER saas_customer_price_versions_immutable/);
  assert.match(migration.sql, /CREATE TRIGGER saas_supplier_cost_versions_immutable/);
  assert.match(migration.sql, /CREATE TRIGGER saas_request_customer_price_snapshots_immutable/);
  assert.match(migration.sql, /CREATE TRIGGER saas_attempt_supplier_cost_snapshots_immutable/);
  assert.match(migration.sql, /UNIQUE \(tenant_id, request_id\)/);
  assert.match(migration.sql, /UNIQUE \(tenant_id, request_id, attempt_id\)/);
  assert.match(migration.sql, /hold_amount_minor_units bigint NOT NULL CHECK \(hold_amount_minor_units > 0\)/);
  assert.match(migration.sql, /wallet_hold_required boolean NOT NULL CHECK \(wallet_hold_required\)/);
  assert.match(
    migration.sql,
    /FOREIGN KEY \(platform_account_id, provider_id, product_id\)\s+REFERENCES saas_platform_provider_accounts \(id, provider_id, product_id\)/,
  );
  assert.match(migration.sql, /supply_mode IS DISTINCT FROM 'platform'/);
  assert.match(migration.sql, /saas_attempts lacks platform_account_id\/provider_id\/product_id\/endpoint/);
});

test('maps immutable snapshots to existing admission terms and both version references', () => {
  const terms = toPlatformRequestAdmissionTerms(customerSnapshot);
  assert.deepEqual(terms, {
    currency: 'USD',
    amountMinorUnits: 1n,
    priceSnapshotRef: 'customer-snapshot-1',
    expiresAt: '2026-09-28T00:05:00.000Z',
  });

  const references = toPlatformPricingReferences(customerSnapshot, supplierSnapshot);
  assert.equal(references.customerPriceVersion, 'customer-price-1');
  assert.equal(references.supplierCostVersion, 'supplier-cost-1');
  assert.equal(references.customerPriceSnapshotRef, 'customer-snapshot-1');
  assert.equal(references.supplierCostSnapshotRef, 'supplier-snapshot-1');
  assert.equal(references.walletHoldRequired, true);
  assert.equal(references.zeroPrice, false);

  assert.throws(
    () =>
      toPlatformRequestAdmissionTerms({
        ...customerSnapshot,
        holdAmountMinorUnits: 0n,
        walletHoldRequired: false,
      }),
    (error: unknown) =>
      error instanceof Error && error.message === 'A zero-priced admission hold cannot be reserved by billing.',
  );
});
