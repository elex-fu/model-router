import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ProviderAccountSchedulerConcurrencyPort,
  ProviderAccountSchedulerDependencies,
  ProviderAccountSchedulerEligibilityPort,
  ProviderAccountSchedulerHealthPort,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import { ProviderAccountScheduler } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
  RequestPreparationSchedulingContext,
} from '../../../src/saas/gateway/request-preparation-service.js';

/*
 * Roadmap batch 2 §2.1 (task #5): the sticky three-state gate in the
 * scheduler's affinity resolution branch. These tests live OUTSIDE the
 * provider-account-scheduler*.test.ts golden fixtures on purpose: the
 * golden files must stay byte-identical for the default (no affinity
 * reference) path; the stale-degradation behavior is new coverage.
 */

const NOW = new Date('2026-09-28T00:00:00.000Z');

function caller(): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    modelScopes: ['model-a'],
    authzVersion: 1,
    entitlementVersion: 2,
    supplyProfileVersion: 3,
    modelScopeVersion: 4,
  };
}

function entitlement(): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 2,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 3,
    supplyMode: 'platform',
    modelScopeVersion: 4,
    allowedModels: ['model-a'],
    allowedProviderIds: [],
    projectPolicyVersion: 5,
  };
}

function candidate(accountId: string): RequestPreparationCandidateAuthority {
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
    poolId: 'pool-a',
    poolAuthzVersion: 1,
    poolMemberAccountAuthzVersion: 1,
    poolGrantAuthzVersion: 1,
    poolGrantProfileAuthzVersion: 3,
    poolGrantPoolAuthzVersion: 1,
    providerId: 'provider-a',
    productId: 'product-a',
  };
}

function baseInput(
  candidates: readonly RequestPreparationCandidateAuthority[],
  scheduling?: RequestPreparationSchedulingContext,
) {
  return {
    requestId: 'request-a',
    caller: caller(),
    entitlement: entitlement(),
    candidates,
    publicModel: 'model-a',
    protocol: 'openai' as const,
    route: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      publicModel: 'model-a',
      publicModelId: 'public-model-a',
      publicModelVersion: 1,
      routeConfigId: 'route-a',
      routeConfigVersion: 1,
      protocol: 'openai' as const,
      targetMode: 'platform_pool' as const,
      upstreamId: 'upstream-a',
      endpoint: 'https://provider.example/v1',
    },
    scheduling,
  };
}

function eligibilityPort(): ProviderAccountSchedulerEligibilityPort {
  return {
    async revalidate(input) {
      return {
        decision: 'allow',
        candidate: input.candidate,
        status: 'active',
        capability: { protocol: 'openai', supportLevel: 'supported', validationState: 'verified' },
        route: {
          tenantId: input.caller.tenantId,
          projectId: input.caller.projectId,
          routeConfigId: String(input.route?.routeConfigId ?? 'route-a'),
          routeConfigVersion: String(input.route?.routeConfigVersion ?? 1),
          publicModelId: String(input.route?.publicModelId ?? 'public-model-a'),
          publicModelVersion: String(input.route?.publicModelVersion ?? 1),
          publicModel: input.publicModel,
          protocol: input.protocol,
          supplyMode: input.caller.supplyMode,
          targetMode: input.caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool',
          upstreamId: input.candidate.upstreamId,
          providerId: input.candidate.providerId,
          productId: input.candidate.productId,
        },
        rights: {
          providerId: 'provider-a',
          productId: 'product-a',
          model: 'provider-model-a',
          endpoint: 'https://provider.example/v1',
          supplyMode: 'platform',
          status: 'active',
          version: 1,
          effectiveAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
        priority: 1,
        weight: 1,
      };
    },
  };
}

function healthPort(): ProviderAccountSchedulerHealthPort {
  return {
    async get() {
      return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
    },
  };
}

function concurrencyPort(): ProviderAccountSchedulerConcurrencyPort {
  return {
    async get() {
      return { decision: 'allow', value: { inFlight: 0, limit: 2 } };
    },
  };
}

test('state 1: a sticky hit on a healthy, non-cooling account is selected directly', async () => {
  const result = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve() {
          return { decision: 'allow', accountId: 'account-b' };
        },
        async bind() {
          return { decision: 'allow' };
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-hash-1' }));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
});

test('state 2: a stale (cleared) binding degrades to load balancing instead of blocking', async () => {
  let observedEligibleIds: readonly string[] = [];
  const result = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve(input) {
          observedEligibleIds = input.eligibleAccountIds;
          // The authority cleared the binding (shouldClearStickySession):
          // the previous target lost eligibility against this snapshot.
          return { decision: 'stale' };
        },
        async bind() {
          return { decision: 'allow' };
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-hash-1' }));
  // The eligible snapshot was handed to the authority for revalidation.
  assert.deepEqual(observedEligibleIds, ['account-a', 'account-b']);
  // The selection degrades to the ranking chain: still allowed, one of the
  // eligible accounts, and NOT a capability_unavailable block.
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.ok(['account-a', 'account-b'].includes(result.value.accountId));
  }
});

test('state 2 stays fail-closed when the degraded selection would re-pick an attempted account', async () => {
  const result = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve() {
          return { decision: 'stale' };
        },
        async bind() {
          return { decision: 'allow' };
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(
    baseInput([candidate('account-a')], {
      sessionId: 'session-hash-1',
      attemptedAccountIds: ['account-a'],
    }),
  );
  assert.deepEqual(result, {
    decision: 'reject',
    code: 'account_denied',
    message: 'no eligible provider account is available',
  });
});

test('a defensive allow naming an ineligible account still blocks (unchanged golden semantics)', async () => {
  const result = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve() {
          // An authority that recommends an account WITHOUT validating it
          // against the eligible snapshot is inconsistent, not stale.
          return { decision: 'allow', accountId: 'account-z' };
        },
        async bind() {
          return { decision: 'allow' };
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-hash-1' }));
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /no longer eligible/);
});

test('an affinity block and an invalid decision shape stay fail-closed', async () => {
  const blocked = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve() {
          return { decision: 'block', reason: 'affinity storage is unavailable' };
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(baseInput([candidate('account-a')], { sessionId: 'session-hash-1' }));
  assert.equal(blocked.decision, 'block');
  if (blocked.decision === 'block') assert.match(blocked.message, /affinity storage is unavailable/);

  const invalid = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve() {
          return { decision: 'wat' } as never;
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(baseInput([candidate('account-a')], { sessionId: 'session-hash-1' }));
  assert.equal(invalid.decision, 'block');
  if (invalid.decision === 'block') assert.match(invalid.message, /invalid decision/);
});

test('state 3: without an affinity reference the affinity port is never consulted', async () => {
  let resolves = 0;
  const result = await new ProviderAccountScheduler(
    {
      eligibility: eligibilityPort(),
      health: healthPort(),
      concurrency: concurrencyPort(),
      affinity: {
        async resolve() {
          resolves += 1;
          return { decision: 'allow', accountId: 'account-a' };
        },
        async bind() {
          return { decision: 'allow' };
        },
      },
    },
    { now: () => NOW, maxHealthAgeMs: 60_000 },
  ).select(baseInput([candidate('account-a'), candidate('account-b')]));
  assert.equal(result.decision, 'allow');
  assert.equal(resolves, 0);
});
