import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CustomerSaleBillingIdentity,
  resolvedSupplyBillingIdentityDigestMaterial,
  resolvedSupplyBillingIdentityFromInput,
  sameResolvedSupplyBillingIdentity,
} from '../../../src/saas/gateway/resolved-supply-billing-identity.js';

/*
 * R3 §8.1 identity freeze/drift matrix: the PUBLIC sale identity (alias,
 * customer price, request idempotency) stays bound to the route while each
 * attempt freezes its own ACTUAL supply identity — a cross-platform fallback
 * regenerates the supplier side, never the customer side.
 */

const CUSTOMER_IDENTITY: CustomerSaleBillingIdentity = {
  providerId: 'anthropic',
  productId: 'claude-subscription',
  endpoint: '/v1/messages',
};

function identity(overrides: Partial<Parameters<typeof resolvedSupplyBillingIdentityFromInput>[0]> = {}) {
  return resolvedSupplyBillingIdentityFromInput({
    providerId: 'anthropic',
    productId: 'claude-subscription',
    upstreamModel: 'claude-sonnet-5',
    providerOperation: 'messages',
    supplierCostVersion: 'cost-anthropic-v1',
    meteringPolicyVersion: '7',
    ...overrides,
  });
}

test('an internal platform switch keeps the customer identity and regenerates the supplier identity', () => {
  const attemptOnAnthropic = identity();
  const attemptOnCodex = identity({
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    upstreamModel: 'gpt-5.3-codex',
    supplierCostVersion: 'cost-codex-v1',
  });
  // The supplier side drifts (a new attempt, a new frozen cost identity)...
  assert.equal(sameResolvedSupplyBillingIdentity(attemptOnAnthropic, attemptOnCodex), false);
  // ...while the customer sale identity never moves.
  const secondCustomerIdentity: CustomerSaleBillingIdentity = { ...CUSTOMER_IDENTITY };
  assert.deepEqual(CUSTOMER_IDENTITY, secondCustomerIdentity);
});

test('identities are equal only when all six frozen fields agree', () => {
  const base = identity();
  for (const override of [
    { providerId: 'google-gemini' },
    { productId: 'gemini-subscription' },
    { upstreamModel: 'claude-opus-5' },
    { providerOperation: null },
    { supplierCostVersion: 'cost-anthropic-v2' },
    { meteringPolicyVersion: '8' },
  ] as const) {
    assert.equal(
      sameResolvedSupplyBillingIdentity(base, identity(override)),
      false,
      `expected drift for ${JSON.stringify(override)}`,
    );
  }
  assert.equal(sameResolvedSupplyBillingIdentity(base, identity()), true);
  assert.equal(sameResolvedSupplyBillingIdentity(base, { ...base }), true);
});

test('the digest material is canonical: field order and null sentinels are stable', () => {
  const material = resolvedSupplyBillingIdentityDigestMaterial(identity());
  assert.equal(
    material,
    [
      'provider=anthropic',
      'product=claude-subscription',
      'model=claude-sonnet-5',
      'operation=messages',
      'supplierCostVersion=cost-anthropic-v1',
      'meteringPolicyVersion=7',
    ].join('|'),
  );
  assert.equal(resolvedSupplyBillingIdentityDigestMaterial(identity()), material);
  assert.equal(
    resolvedSupplyBillingIdentityDigestMaterial(identity({ providerOperation: undefined })),
    material.replace('operation=messages', 'operation=null'),
  );
  // A supplier-cost switch alone changes the digest (no silent cost drift).
  assert.notEqual(
    resolvedSupplyBillingIdentityDigestMaterial(identity({ supplierCostVersion: 'cost-anthropic-v2' })),
    material,
  );
});
