import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresRequestPreparationEntitlementAdapter } from '../../../src/saas/gateway/postgres-request-preparation-entitlement-adapter.js';
import {
  allowRequestPreparation,
  type RequestPreparationCaller,
  type RequestPreparationEntitlement,
} from '../../../src/saas/gateway/request-preparation-service.js';
import type { EffectiveByokEntitlement } from '../../../src/saas/plans/types.js';

const NOW = '2026-09-28T00:00:00.000Z';

function caller(supplyMode: 'byok' | 'platform' = 'byok'): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode,
    modelScopes: ['model-a'],
    authzVersion: 4,
    entitlementVersion: 5,
    supplyProfileVersion: 6,
    modelScopeVersion: 7,
  };
}

function delegatedEntitlement(supplyMode: 'byok' | 'platform' = 'byok'): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 5,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 6,
    supplyMode,
    modelScopeVersion: 7,
    allowedModels: ['model-a', 'model-overgrant'],
    allowedProviderIds: ['provider-overgrant'],
    projectPolicyVersion: 3,
  };
}

function effective(overrides: Partial<EffectiveByokEntitlement> = {}): EffectiveByokEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    entitlementId: 'entitlement-a',
    subscriptionId: 'subscription-a',
    snapshot: {
      id: 'snapshot-a',
      tenantId: 'tenant-a',
      orderId: 'order-a',
      planVersionId: 'plan-version-a',
      planId: 'plan-a',
      planVersion: 1,
      allowedProviderIds: ['provider-a'],
      allowedModels: ['model-a'],
      supplyMode: 'byok',
      supplyProfileId: 'profile-a',
      priceVersion: 'price-a',
      priceMinorUnits: '1',
      currency: 'USD',
      termDays: 30,
      policyVersion: 'policy-a',
      snapshotDigest: 'a'.repeat(64),
      createdAt: NOW,
    },
    allowedProviderIds: ['provider-a'],
    modelScopes: ['model-a'],
    entitlementAuthzVersion: 5,
    supplyProfileAuthzVersion: 6,
    modelScopeVersion: 7,
    ...overrides,
  };
}

function resolveInput(mode: 'byok' | 'platform' = 'byok') {
  return { caller: caller(mode), publicModel: 'model-a', protocol: 'openai' as const };
}

test('binds BYOK provider scope from the plan resolver instead of the delegated list', async () => {
  let lookup: { tenantId: string; projectId: string; entitlementId: string } | undefined;
  const adapter = new PostgresRequestPreparationEntitlementAdapter(
    { resolve: async () => allowRequestPreparation(delegatedEntitlement()) },
    {
      async resolveBoundForRequest(context, entitlementId) {
        lookup = { ...context, entitlementId };
        return effective();
      },
    },
  );

  const result = await adapter.resolve(resolveInput());
  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') return;
  assert.deepEqual(result.value.allowedProviderIds, ['provider-a']);
  assert.deepEqual(result.value.allowedModels, ['model-a']);
  assert.deepEqual(lookup, {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    entitlementId: 'entitlement-a',
  });
});

test('fails closed for a missing, stale, or cross-project plan entitlement', async (t) => {
  for (const [label, value] of [
    ['missing', null],
    ['stale', effective({ entitlementAuthzVersion: 4 })],
    ['cross-project', effective({ projectId: 'project-other' })],
  ] as const) {
    await t.test(label, async () => {
      const adapter = new PostgresRequestPreparationEntitlementAdapter(
        { resolve: async () => allowRequestPreparation(delegatedEntitlement()) },
        { resolveBoundForRequest: async () => value },
      );
      const result = await adapter.resolve(resolveInput());
      assert.deepEqual(result, {
        decision: 'reject',
        code: 'entitlement_denied',
        message: 'The current BYOK service-plan entitlement does not authorize this request.',
      });
    });
  }
});

test('does not consult BYOK plan scope for platform entitlements', async () => {
  let lookups = 0;
  const adapter = new PostgresRequestPreparationEntitlementAdapter(
    { resolve: async () => allowRequestPreparation(delegatedEntitlement('platform')) },
    {
      async resolveBoundForRequest() {
        lookups += 1;
        return null;
      },
    },
  );
  const result = await adapter.resolve(resolveInput('platform'));
  assert.equal(result.decision, 'allow');
  assert.equal(lookups, 0);
});
