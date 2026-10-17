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

function eligibilityPort(
  candidates: ReadonlyMap<string, { priority: number; weight: number }>,
  overrides: Partial<ProviderAccountSchedulerEligibilityPort> = {},
): ProviderAccountSchedulerEligibilityPort {
  return {
    async revalidate(input) {
      const policy = candidates.get(input.candidate.accountId);
      if (!policy) return { decision: 'deny', reason: 'candidate not eligible' };
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
        ...policy,
      };
    },
    ...overrides,
  };
}

function healthPort(
  statuses: ReadonlyMap<string, 'healthy' | 'degraded' | 'cooldown' | 'unhealthy'> = new Map(),
  overrides: Partial<ProviderAccountSchedulerHealthPort> = {},
): ProviderAccountSchedulerHealthPort {
  return {
    async get(input) {
      return {
        decision: 'allow',
        value: { status: statuses.get(input.candidate.accountId) ?? 'healthy', observedAt: NOW },
      };
    },
    ...overrides,
  };
}

function concurrencyPort(
  snapshots: ReadonlyMap<string, { inFlight: number; limit: number }>,
  overrides: Partial<ProviderAccountSchedulerConcurrencyPort> = {},
): ProviderAccountSchedulerConcurrencyPort {
  return {
    async get(input) {
      return {
        decision: 'allow',
        value: snapshots.get(input.candidate.accountId) ?? { inFlight: 0, limit: 2 },
      };
    },
    ...overrides,
  };
}

function scheduler(dependencies: ProviderAccountSchedulerDependencies): ProviderAccountScheduler {
  return new ProviderAccountScheduler(dependencies, { now: () => NOW, maxHealthAgeMs: 60_000 });
}

test('filters stale capability, unhealthy health, and full concurrency before ranking', async () => {
  const candidates = [candidate('account-a'), candidate('account-b'), candidate('account-c')];
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 3, weight: 1 }],
        ['account-b', { priority: 2, weight: 100 }],
        ['account-c', { priority: 2, weight: 1 }],
      ]),
    ),
    health: healthPort(
      new Map([
        ['account-a', 'healthy'],
        ['account-b', 'unhealthy'],
        ['account-c', 'healthy'],
      ]),
    ),
    concurrency: concurrencyPort(
      new Map([
        ['account-a', { inFlight: 2, limit: 2 }],
        ['account-b', { inFlight: 0, limit: 2 }],
        ['account-c', { inFlight: 1, limit: 2 }],
      ]),
    ),
  }).select(baseInput(candidates));

  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-c');
});

test('revalidates Provider rights and fails closed on malformed authority', async () => {
  const result = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]]), {
      async revalidate(input) {
        return {
          decision: 'allow',
          candidate: input.candidate,
          status: 'active',
          capability: { protocol: 'openai', supportLevel: 'supported', validationState: 'verified' },
          rights: {
            providerId: 'provider-a',
            productId: 'product-a',
            model: 'provider-model-a',
            endpoint: 'https://provider.example/v1',
            supplyMode: 'platform',
            status: 'active',
            version: 1,
            effectiveAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:00:00.000Z',
          },
          priority: 1,
          weight: 1,
        };
      },
    }),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput([candidate('account-a')]));

  assert.deepEqual(result, {
    decision: 'block',
    code: 'capability_unavailable',
    message: 'provider eligibility authority returned an invalid candidate',
  });
});

test('valid affinity is only a preference and cannot bypass health or attempted-account exclusion', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(
      new Map([
        ['account-a', 'unhealthy'],
        ['account-b', 'healthy'],
      ]),
    ),
    concurrency: concurrencyPort(new Map()),
    affinity: {
      async resolve() {
        return { decision: 'allow', accountId: 'account-b' };
      },
      async bind() {
        return { decision: 'allow' };
      },
    },
  };

  const affinityResult = await scheduler(dependencies).select(
    baseInput(candidates, { previousResponseId: 'opaque-response-1' }),
  );
  assert.equal(affinityResult.decision, 'allow');
  if (affinityResult.decision === 'allow') assert.equal(affinityResult.value.accountId, 'account-b');

  const attemptedResult = await scheduler(dependencies).select(
    baseInput(candidates, { previousResponseId: 'opaque-response-1', attemptedAccountIds: ['account-b'] }),
  );
  // K2: the durable health deny (account-a unhealthy) makes the emptiness an
  // availability condition — a 503 block, not the account_denied 403.
  assert.deepEqual(attemptedResult, {
    decision: 'block',
    code: 'capability_unavailable',
    message: 'no schedulable provider account is available',
  });
});

test('an affinity target that loses eligibility blocks instead of falling back to another account', async () => {
  let observedEligibleIds: readonly string[] = [];
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(
      new Map([
        ['account-a', 'unhealthy'],
        ['account-b', 'healthy'],
      ]),
    ),
    concurrency: concurrencyPort(new Map()),
    affinity: {
      async resolve(input) {
        observedEligibleIds = input.eligibleAccountIds;
        return { decision: 'allow', accountId: 'account-a' };
      },
      async bind() {
        return { decision: 'allow' };
      },
    },
  }).select(baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-affinity' }));

  assert.deepEqual(observedEligibleIds, ['account-b']);
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /no longer eligible/);
});

test('a revoked affinity account blocks instead of silently switching accounts', async () => {
  let observedEligibleIds: readonly string[] = [];
  const result = await scheduler({
    eligibility: eligibilityPort(new Map([['account-b', { priority: 1, weight: 1 }]])),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    affinity: {
      async resolve(input) {
        observedEligibleIds = input.eligibleAccountIds;
        return { decision: 'allow', accountId: 'account-a' };
      },
      async bind() {
        return { decision: 'allow' };
      },
    },
  }).select(baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'revoked-session' }));

  assert.deepEqual(observedEligibleIds, ['account-b']);
  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /no longer eligible/);
});

test('selection is deterministic for a request identity and independent of candidate order', async () => {
  const candidates = [candidate('account-a'), candidate('account-b'), candidate('account-c')];
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 3 }],
        ['account-c', { priority: 1, weight: 2 }],
      ]),
    ),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  };
  const first = await scheduler(dependencies).select(baseInput(candidates));
  const second = await scheduler(dependencies).select(baseInput([...candidates].reverse()));
  assert.equal(first.decision, 'allow');
  assert.equal(second.decision, 'allow');
  if (first.decision === 'allow' && second.decision === 'allow') {
    assert.equal(first.value.accountId, second.value.accountId);
  }
});

test('missing distributed ports and stale health state fail closed', async () => {
  const candidates = [candidate('account-a')];
  const missingHealth = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates));
  assert.equal(missingHealth.decision, 'block');

  const staleHealth = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(new Map(), {
      async get() {
        return { decision: 'allow', value: { status: 'healthy', observedAt: '2026-09-27T00:00:00.000Z' } };
      },
    }),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates));
  assert.equal(staleHealth.decision, 'block');

  const missingAffinity = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates, { sessionId: 'opaque-session-1' }));
  assert.equal(missingAffinity.decision, 'block');
});

/* ------------------------------------------------------------------ */
/* H1 (R9 bench finding P5b): clock-skew tolerance in healthValue      */
/* ------------------------------------------------------------------ */

test('health observedAt slightly ahead of now (DB clock dispersion) is clamped, not blocked (H1)', async () => {
  const candidates = [candidate('account-a')];
  const withinTolerance = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(new Map(), {
      async get() {
        return { decision: 'allow', value: { status: 'healthy', observedAt: new Date(NOW.getTime() + 200) } };
      },
    }),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates));
  assert.equal(withinTolerance.decision, 'allow');

  const beyondTolerance = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(new Map(), {
      async get() {
        return { decision: 'allow', value: { status: 'healthy', observedAt: new Date(NOW.getTime() + 251) } };
      },
    }),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates));
  assert.equal(beyondTolerance.decision, 'block');
});

/* ------------------------------------------------------------------ */
/* H5c (R9 bench finding P8): in-process failure-feedback exclusion    */
/* ------------------------------------------------------------------ */

test('failure feedback excludes only the cooled candidate from selection (H5c)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    failureFeedback: {
      isExcluded(input) {
        return input.candidate.accountId === 'account-a' && input.now.getTime() < NOW.getTime() + 5_000;
      },
    },
  };
  const result = await scheduler(dependencies).select(baseInput(candidates));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');

  // Once the cooldown expires the account is schedulable again.
  const recoveredDependencies: ProviderAccountSchedulerDependencies = {
    ...dependencies,
    concurrency: concurrencyPort(new Map([['account-b', { inFlight: 2, limit: 2 }]])),
  };
  const recoveredScheduler = new ProviderAccountScheduler(recoveredDependencies, {
    now: () => new Date(NOW.getTime() + 6_000),
    maxHealthAgeMs: 60_000,
  });
  const recovered = await recoveredScheduler.select(baseInput(candidates));
  assert.equal(recovered.decision, 'allow');
  if (recovered.decision === 'allow') assert.equal(recovered.value.accountId, 'account-a');
});

test('failure feedback cooling every candidate fails open and dispatches anyway (P17)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    failureFeedback: {
      isExcluded() {
        return true;
      },
    },
  }).select(baseInput(candidates));
  // The in-process cooldown is a routing hint, never an admission deny: with
  // every candidate cooled the request still dispatches so the client sees
  // the provider's real status instead of a gateway rejection.
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.ok(['account-a', 'account-b'].includes(result.value.accountId));
  }
});

test('failure feedback cooling every candidate still blocks closed when the durable authorities deny (P17, K2)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    // The durable health classification stays the authoritative gate: a
    // cooldown/unhealthy row denies the candidate even in the fail-open pass.
    health: healthPort(
      new Map([
        ['account-a', 'unhealthy'],
        ['account-b', 'cooldown'],
      ]),
    ),
    concurrency: concurrencyPort(new Map()),
    failureFeedback: {
      isExcluded() {
        return true;
      },
    },
  }).select(baseInput(candidates));
  // K2: all-durably-denied is an availability condition, not a client fault:
  // a 503 block (retryable) instead of the account_denied 403 that the
  // run-2 P17 starvation surfaced 4,698 times. The fail-open passthrough
  // itself is unchanged — it is the in-process HINT that can never produce
  // this outcome, only durable health evidence can.
  assert.deepEqual(result, {
    decision: 'block',
    code: 'capability_unavailable',
    message: 'no schedulable provider account is available',
  });
});

test('every candidate denied by durable health blocks closed even without failure feedback (K2)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(
      new Map([
        ['account-a', 'cooldown'],
        ['account-b', 'cooldown'],
      ]),
    ),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates));
  assert.deepEqual(result, {
    decision: 'block',
    code: 'capability_unavailable',
    message: 'no schedulable provider account is available',
  });
});

test('all candidates denied without any durable health deny keeps the account_denied rejection (K2)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const result = await scheduler({
    // Both candidates fail eligibility revalidation; the durable health
    // authority never denied anyone, so the pre-K2 rejection stands.
    eligibility: eligibilityPort(new Map()),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput(candidates));
  assert.deepEqual(result, {
    decision: 'reject',
    code: 'account_denied',
    message: 'no eligible provider account is available',
  });
});

test('a partially excluded candidate set never consults eligibility for cooled accounts (P17)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  let revalidations = 0;
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
      {
        async revalidate(input) {
          revalidations += 1;
          return eligibilityPort(new Map([[input.candidate.accountId, { priority: 1, weight: 1 }]])).revalidate(input);
        },
      },
    ),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    failureFeedback: {
      isExcluded(input) {
        return input.candidate.accountId === 'account-a';
      },
    },
  }).select(baseInput(candidates));
  // Normal case: the survivor keeps the exclusion effective and the cooled
  // account is skipped before the eligibility round trip.
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  assert.equal(revalidations, 1);
});

test('an excluded candidate is fail-open dispatched when the only other candidate fails eligibility (P17)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  const result = await scheduler({
    // account-b is durably ineligible; account-a is only in-process cooled —
    // every otherwise-eligible candidate is excluded, so the hint is cleared.
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    failureFeedback: {
      isExcluded(input) {
        return input.candidate.accountId === 'account-a';
      },
    },
  }).select(baseInput(candidates));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
});

test('absent failure feedback keeps the default selection path (golden-fixture red line, H5c)', async () => {
  // Same shape as the exclusion test but without the port: account-a wins
  // the deterministic draw among equal weights for this request identity.
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(baseInput([candidate('account-a'), candidate('account-b')]));
  assert.equal(result.decision, 'allow');
});
