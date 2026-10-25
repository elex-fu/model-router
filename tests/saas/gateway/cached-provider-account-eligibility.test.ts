import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CachedProviderAccountEligibility,
  wrapProviderAccountEligibilityCache,
} from '../../../src/saas/gateway/cached-provider-account-eligibility.js';
import type {
  ProviderAccountSchedulerCompositeContext,
  ProviderAccountSchedulerEligibilityDecision,
  ProviderAccountSchedulerEligibilityPort,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
  RequestPreparationRouteAuthority,
} from '../../../src/saas/gateway/request-preparation-service.js';

/*
 * §12.2 Phase A2a (D2): the version-keyed, allow-only cache around the
 * scheduler's static eligibility reads
 * (CachedProviderAccountEligibility). The admission guard remains the
 * fail-closed defense line; these tests pin the cache contract itself,
 * mirroring the authority-cache test suite.
 */

function caller(overrides: Partial<RequestPreparationCaller> = {}): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'member-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    modelScopes: ['public-model'],
    authzVersion: 4,
    entitlementVersion: 5,
    supplyProfileVersion: 6,
    modelScopeVersion: 7,
    ...overrides,
  };
}

function entitlementValue(overrides: Partial<RequestPreparationEntitlement> = {}): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 5,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 6,
    supplyMode: 'platform',
    modelScopeVersion: 7,
    allowedModels: ['public-model'],
    allowedProviderIds: [],
    projectPolicyVersion: 3,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<RequestPreparationCandidateAuthority> = {},
): RequestPreparationCandidateAuthority {
  const base: RequestPreparationCandidateAuthority = {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    upstreamId: 'upstream-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: 11,
    credentialAuthzVersion: 12,
    accountAuthzVersion: 13,
    dispatchProfileId: 'dispatch-profile-a',
    supplyProfileAuthzVersion: 6,
    resolvedModel: 'resolved-model',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    supplierCostVersion: 'cost-version-a',
    accountOwnerKind: 'platform',
    poolId: 'pool-a',
    poolAuthzVersion: 21,
    poolMemberAccountAuthzVersion: 22,
    poolMemberAuthzVersion: 23,
    poolGrantAuthzVersion: 24,
    poolGrantProfileAuthzVersion: 25,
    poolGrantPoolAuthzVersion: 26,
    providerId: 'provider-a',
    productId: 'product-a',
  };
  // Partial<T> of a discriminated union widens the discriminants, so the
  // merged literal is asserted back to the platform candidate it is.
  return { ...base, ...overrides } as RequestPreparationCandidateAuthority;
}

function routeAuthority(): RequestPreparationRouteAuthority {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    publicModel: 'public-model',
    publicModelId: 'public-model-id',
    publicModelVersion: 9,
    routeConfigId: 'route-a',
    routeConfigVersion: 8,
    protocol: 'openai',
    targetMode: 'platform_pool',
    upstreamId: 'upstream-a',
    endpoint: '/v1/chat/completions',
  };
}

function composite(): ProviderAccountSchedulerCompositeContext {
  return {
    billingGroupId: 'group-a',
    source: 'route',
    routeId: null,
    targetPlatform: 'provider-a',
    productId: 'product-a',
    upstreamModel: 'resolved-model',
    endpoint: '/v1/chat/completions',
  };
}

function allowDecision(): ProviderAccountSchedulerEligibilityDecision {
  return {
    decision: 'allow',
    authorityAt: new Date(1_000_000),
    candidate: candidate(),
    status: 'active',
    capability: { protocol: 'openai', supportLevel: 'supported', validationState: 'verified' },
    rights: {
      providerId: 'provider-a',
      productId: 'product-a',
      model: 'resolved-model',
      endpoint: '/v1/chat/completions',
      supplyMode: 'platform',
      status: 'active',
      version: '11',
      effectiveAt: new Date(0),
      expiresAt: null,
    },
    priority: 10,
    weight: 100,
    scheduling: {
      soonestResetAt: null,
      soonestResetObservedAt: null,
      supplierCostRate: { numeratorMinorUnits: 3n, denominatorUnits: 2n },
      groupPoolPriority: null,
    },
  };
}

function revalidateInput(
  overrides: {
    readonly caller?: RequestPreparationCaller;
    readonly entitlement?: RequestPreparationEntitlement;
    readonly candidate?: RequestPreparationCandidateAuthority;
    readonly billingGroupId?: string;
    readonly composite?: ProviderAccountSchedulerCompositeContext;
    readonly now?: Date;
    readonly publicModel?: string;
  } = {},
) {
  return {
    caller: overrides.caller ?? caller(),
    entitlement: overrides.entitlement ?? entitlementValue(),
    candidate: overrides.candidate ?? candidate(),
    publicModel: overrides.publicModel ?? 'public-model',
    protocol: 'openai' as const,
    route: routeAuthority(),
    billingGroupId: overrides.billingGroupId ?? 'group-a',
    ...(overrides.composite === undefined ? {} : { composite: overrides.composite }),
    now: overrides.now ?? new Date(2_000_000),
  };
}

function fakeEligibility(decisions: ProviderAccountSchedulerEligibilityDecision[]): {
  port: ProviderAccountSchedulerEligibilityPort;
  calls: () => number;
} {
  let calls = 0;
  const port: ProviderAccountSchedulerEligibilityPort = {
    async revalidate(_input) {
      calls++;
      const decision = decisions[Math.min(calls - 1, decisions.length - 1)];
      return structuredClone(decision);
    },
  };
  return { port, calls: () => calls };
}

test('version-keyed eligibility cache reuses the allow decision while the key tuple is unchanged', async () => {
  const { port, calls } = fakeEligibility([allowDecision()]);
  const cached = new CachedProviderAccountEligibility(port);
  const first = await cached.revalidate(revalidateInput());
  assert.equal(first.decision, 'allow');
  assert.equal(calls(), 1);
  // Fresh, structurally equal input objects (the production path rebuilds
  // caller/entitlement/candidate per request): the key is content-based.
  const second = await cached.revalidate(revalidateInput());
  assert.equal(second.decision, 'allow');
  assert.equal(calls(), 1, 'a cache hit must not re-run the eligibility SQL');
  assert.deepEqual(second, first);
  // Concurrent identical revalidations collapse into one underlying call.
  const [third, fourth] = await Promise.all([
    cached.revalidate(revalidateInput()),
    cached.revalidate(revalidateInput()),
  ]);
  assert.equal(third.decision, 'allow');
  assert.equal(fourth.decision, 'allow');
  assert.equal(calls(), 1, 'single-flight must not re-run the eligibility SQL');
  // Cross-request isolation: mutating a returned decision must not poison the cache.
  (fourth as { weight: number }).weight = 1;
  const fifth = await cached.revalidate(revalidateInput());
  assert.equal(fifth.decision, 'allow');
  if (fifth.decision !== 'allow') return;
  assert.equal(fifth.weight, 100);
  assert.equal(calls(), 1);
});

test('the scheduler clock is not part of the eligibility cache key', async () => {
  const { port, calls } = fakeEligibility([allowDecision()]);
  const cached = new CachedProviderAccountEligibility(port);
  await cached.revalidate(revalidateInput({ now: new Date(0) }));
  await cached.revalidate(revalidateInput({ now: new Date(999_999_999) }));
  assert.equal(calls(), 1, 'a different scheduler clock must still hit (authority_now is the SQL clock)');
});

test('version epochs spelled number/string/bigint share one eligibility cache key', async () => {
  const { port, calls } = fakeEligibility([allowDecision()]);
  const cached = new CachedProviderAccountEligibility(port);
  await cached.revalidate(revalidateInput({ caller: caller({ entitlementVersion: 5 }) }));
  await cached.revalidate(revalidateInput({ caller: caller({ entitlementVersion: '5' }) }));
  await cached.revalidate(revalidateInput({ caller: caller({ entitlementVersion: 5n }) }));
  assert.equal(calls(), 1, 'the same epoch in any spelling is the same key, mirroring bigint version equality');
});

test('any version or identity change in the eligibility cache key forces a fresh revalidation', async (t) => {
  const revalidateTwice = async (mutate: () => ReturnType<typeof revalidateInput>): Promise<number> => {
    const { port, calls } = fakeEligibility([allowDecision()]);
    const cached = new CachedProviderAccountEligibility(port);
    await cached.revalidate(revalidateInput());
    await cached.revalidate(mutate());
    return calls();
  };
  await t.test('candidate credential version', async () => {
    assert.equal(await revalidateTwice(() => revalidateInput({ candidate: candidate({ credentialVersion: 110 }) })), 2);
  });
  await t.test('candidate account authz version', async () => {
    assert.equal(
      await revalidateTwice(() => revalidateInput({ candidate: candidate({ accountAuthzVersion: 130 }) })),
      2,
    );
  });
  await t.test('candidate pool authz version', async () => {
    assert.equal(await revalidateTwice(() => revalidateInput({ candidate: candidate({ poolAuthzVersion: 210 }) })), 2);
  });
  await t.test('candidate account identity', async () => {
    assert.equal(await revalidateTwice(() => revalidateInput({ candidate: candidate({ accountId: 'account-b' }) })), 2);
  });
  await t.test('caller entitlement version', async () => {
    assert.equal(await revalidateTwice(() => revalidateInput({ caller: caller({ entitlementVersion: 50 }) })), 2);
  });
  await t.test('entitlement project policy version', async () => {
    assert.equal(
      await revalidateTwice(() => revalidateInput({ entitlement: entitlementValue({ projectPolicyVersion: 30 }) })),
      2,
    );
  });
  await t.test('billing group narrowing', async () => {
    assert.equal(await revalidateTwice(() => revalidateInput({ billingGroupId: 'group-b' })), 2);
  });
  await t.test('composite routing context presence', async () => {
    assert.equal(await revalidateTwice(() => revalidateInput({ composite: composite() })), 2);
  });
});

test('an expired eligibility cache entry re-revalidates', async () => {
  let clock = 1_000_000;
  const { port, calls } = fakeEligibility([allowDecision()]);
  const cached = new CachedProviderAccountEligibility(port, { ttlMs: 5000, now: () => clock });
  await cached.revalidate(revalidateInput());
  assert.equal(calls(), 1);
  clock += 5000; // at the boundary the entry is already expired
  const second = await cached.revalidate(revalidateInput());
  assert.equal(second.decision, 'allow');
  assert.equal(calls(), 2, 'an expired entry must re-run the eligibility SQL');
});

test('denied and blocked eligibility decisions are never cached', async (t) => {
  await t.test('deny (candidate-level)', async () => {
    const { port, calls } = fakeEligibility([{ decision: 'deny', reason: 'cooldown' }]);
    const cached = new CachedProviderAccountEligibility(port);
    const first = await cached.revalidate(revalidateInput());
    assert.equal(first.decision, 'deny');
    await cached.revalidate(revalidateInput());
    assert.equal(calls(), 2, 'a denial must be re-resolved every time');
  });
  await t.test('block (authority-level)', async () => {
    const { port, calls } = fakeEligibility([{ decision: 'block', reason: 'storage unavailable' }]);
    const cached = new CachedProviderAccountEligibility(port);
    const first = await cached.revalidate(revalidateInput());
    assert.equal(first.decision, 'block');
    await cached.revalidate(revalidateInput());
    assert.equal(calls(), 2, 'a block must be re-resolved every time');
  });
});

test('the eligibility cache evicts the least recently used entry at its size bound', async () => {
  const { port, calls } = fakeEligibility([allowDecision()]);
  const cached = new CachedProviderAccountEligibility(port, { maxEntries: 2 });
  const inputFor = (credentialVersion: number) => revalidateInput({ candidate: candidate({ credentialVersion }) });
  assert.equal((await cached.revalidate(inputFor(11))).decision, 'allow');
  assert.equal((await cached.revalidate(inputFor(110))).decision, 'allow');
  assert.equal(calls(), 2);
  assert.equal((await cached.revalidate(inputFor(1100))).decision, 'allow');
  assert.equal(calls(), 3, 'the third distinct key evicts the least recently used entry');
  // credentialVersion 11 was the least recently used and was evicted; 1100 is
  // the most recent and must still be a hit.
  assert.equal((await cached.revalidate(inputFor(1100))).decision, 'allow');
  assert.equal(calls(), 3, 'the most recently used entry must still be a cache hit');
  // The evicted key misses and re-resolves (evicting 110 in turn).
  assert.equal((await cached.revalidate(inputFor(11))).decision, 'allow');
  assert.equal(calls(), 4, 'an evicted key must miss and re-resolve');
});

test('the composition seam keeps non-production constructions byte-identical', () => {
  const { port } = fakeEligibility([allowDecision()]);
  assert.equal(wrapProviderAccountEligibilityCache(port), port, 'absent options must return the source unchanged');
  const wrapped = wrapProviderAccountEligibilityCache(port, {});
  assert.notEqual(wrapped, port, 'present options must wrap the source');
  assert.ok(wrapped instanceof CachedProviderAccountEligibility);
});
