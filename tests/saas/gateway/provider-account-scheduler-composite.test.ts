import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ProviderAccountSchedulerCompositeContext,
  ProviderAccountSchedulerDependencies,
  ProviderAccountSchedulerEligibilityPort,
  ProviderAccountSchedulerInput,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import { ProviderAccountScheduler } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
} from '../../../src/saas/gateway/request-preparation-service.js';

/*
 * §4.4 composite model routing (task #18) — the core scheduler's composite
 * context. The context is server-owned (the authority adapter's resolved
 * decision), validated fail-closed, forwarded verbatim to the eligibility
 * port, and platform-only. With no context the selection path stays
 * byte-identical (the R7 golden-fixture red line covers that separately and
 * stays unmodified — the #5/F2 separate-file convention).
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');

function caller(supplyMode: 'byok' | 'platform' = 'platform'): RequestPreparationCaller {
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
    authzVersion: 1,
    entitlementVersion: 2,
    supplyProfileVersion: 3,
    modelScopeVersion: 4,
  };
}

function entitlement(supplyMode: 'byok' | 'platform' = 'platform'): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 2,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 3,
    supplyMode,
    modelScopeVersion: 4,
    allowedModels: ['model-a'],
    allowedProviderIds: ['provider-a', 'provider-b'],
    projectPolicyVersion: 5,
  };
}

function candidate(
  accountId: string,
  overrides: Partial<RequestPreparationCandidateAuthority> = {},
): RequestPreparationCandidateAuthority {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    upstreamId: 'upstream-a',
    accountId,
    credentialId: `credential-${accountId}`,
    credentialVersion: 1,
    credentialAuthzVersion: 2,
    accountAuthzVersion: 3,
    dispatchProfileId: 'dispatch-a',
    supplyProfileAuthzVersion: 3,
    resolvedModel: 'provider-model-a',
    protocol: 'openai',
    endpoint: 'https://provider.example/v1',
    supplierCostVersion: 'cost-v1',
    providerId: 'provider-a',
    productId: 'product-a',
    poolId: 'pool-a',
    poolAuthzVersion: 1,
    poolMemberAccountAuthzVersion: 1,
    poolGrantAuthzVersion: 1,
    poolGrantProfileAuthzVersion: 3,
    poolGrantPoolAuthzVersion: 1,
    ...overrides,
  };
}

const COMPOSITE: ProviderAccountSchedulerCompositeContext = {
  billingGroupId: 'composite-a',
  source: 'route',
  routeId: '5',
  targetPlatform: 'provider-b',
  productId: 'product-b',
  upstreamModel: 'provider-model-b',
  endpoint: 'https://provider-b.example/v1',
};

interface EligibilityObservation {
  readonly composite: unknown;
  readonly candidate: RequestPreparationCandidateAuthority;
}

function eligibilityPort(
  observations: EligibilityObservation[],
  allow = true,
): ProviderAccountSchedulerEligibilityPort {
  return {
    async revalidate(input) {
      observations.push({ composite: input.composite, candidate: input.candidate });
      if (!allow) return { decision: 'deny', reason: 'not eligible' };
      return {
        decision: 'allow',
        candidate: input.candidate,
        status: 'active',
        capability: { protocol: 'openai', supportLevel: 'supported', validationState: 'verified' },
        rights: {
          providerId: input.candidate.providerId,
          productId: input.candidate.productId,
          model: input.candidate.resolvedModel,
          endpoint: input.candidate.endpoint,
          supplyMode: 'platform',
          status: 'active',
          version: 1,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
        priority: 5,
        weight: 10,
        scheduling: {
          soonestResetAt: null,
          soonestResetObservedAt: null,
          supplierCostRate: null,
          groupPoolPriority: null,
        },
      };
    },
  };
}

function dependencies(eligibility: ProviderAccountSchedulerEligibilityPort): ProviderAccountSchedulerDependencies {
  return {
    eligibility,
    health: {
      async get() {
        return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
      },
    },
    concurrency: {
      async get() {
        return { decision: 'allow', value: { inFlight: 0, limit: 4 } };
      },
    },
  };
}

function input(
  candidates: readonly RequestPreparationCandidateAuthority[],
  composite?: ProviderAccountSchedulerCompositeContext,
  supplyMode: 'byok' | 'platform' = 'platform',
): ProviderAccountSchedulerInput {
  return {
    requestId: 'request-a',
    attemptId: 'attempt-a',
    caller: caller(supplyMode),
    entitlement: entitlement(supplyMode),
    candidates,
    publicModel: 'model-a',
    protocol: 'openai',
    ...(composite !== undefined ? { composite } : {}),
  };
}

test('the composite context is forwarded verbatim to the eligibility port', async () => {
  const observations: EligibilityObservation[] = [];
  const scheduler = new ProviderAccountScheduler(dependencies(eligibilityPort(observations)), {
    now: () => NOW,
    maxHealthAgeMs: 60_000,
  });
  const decision = await scheduler.select(input([candidate('account-a')], COMPOSITE));
  assert.equal(decision.decision, 'allow');
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0]?.composite, COMPOSITE);
});

test('a partial or malformed composite context blocks the whole selection', async () => {
  const observations: EligibilityObservation[] = [];
  const scheduler = new ProviderAccountScheduler(dependencies(eligibilityPort(observations)), {
    now: () => NOW,
    maxHealthAgeMs: 60_000,
  });
  for (const broken of [
    { ...COMPOSITE, targetPlatform: '' },
    { ...COMPOSITE, upstreamModel: '' },
    { ...COMPOSITE, endpoint: '' },
    { ...COMPOSITE, productId: '' },
    { ...COMPOSITE, billingGroupId: '' },
    { ...COMPOSITE, source: 'bogus' },
    { ...COMPOSITE, routeId: ' ' },
  ] as unknown as ProviderAccountSchedulerCompositeContext[]) {
    const decision = await scheduler.select(input([candidate('account-a')], broken));
    assert.equal(decision.decision, 'block', JSON.stringify(broken));
    if (decision.decision === 'block') {
      assert.equal(decision.message, 'scheduler composite route context is invalid');
    }
  }
  // A composite context can never ride a BYOK selection (composite groups
  // are platform pools, the F2 precedent).
  const byokDecision = await scheduler.select(input([candidate('account-a')], COMPOSITE, 'byok'));
  assert.equal(byokDecision.decision, 'block');
  if (byokDecision.decision === 'block') {
    assert.equal(byokDecision.message, 'scheduler composite route context is invalid');
  }
  assert.equal(observations.length, 0);
});

test('absent composite keeps the selection path unchanged', async () => {
  const observations: EligibilityObservation[] = [];
  const scheduler = new ProviderAccountScheduler(dependencies(eligibilityPort(observations)), {
    now: () => NOW,
    maxHealthAgeMs: 60_000,
  });
  const decision = await scheduler.select(input([candidate('account-a')]));
  assert.equal(decision.decision, 'allow');
  assert.equal(observations[0]?.composite, undefined);
});
