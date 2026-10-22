import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ProviderAccountSchedulerConcurrencyPort,
  ProviderAccountSchedulerDependencies,
  ProviderAccountSchedulerEligibilityAllowed,
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

function combinedAffinityHarness(
  options: {
    readonly hint?: unknown;
    readonly initialDecision?: unknown;
    readonly finalDecision?: unknown;
    readonly finalThrows?: boolean;
    readonly secondConflict?: boolean;
    readonly afterContention?: Partial<ProviderAccountSchedulerDependencies>;
    readonly winner?: RequestPreparationCandidateAuthority;
    readonly extraCandidates?: readonly RequestPreparationCandidateAuthority[];
  } = {},
) {
  let contended = false;
  const calls = {
    resolves: 0,
    binds: [] as string[],
    eligibility: [] as string[],
    health: [] as string[],
    concurrency: [] as string[],
  };
  const source = [options.winner ?? candidate('account-a'), candidate('account-b'), ...(options.extraCandidates ?? [])];
  const baseEligibility = eligibilityPort(
    new Map([
      ['account-a', { priority: 1, weight: 1 }],
      ['account-b', { priority: 10, weight: 1 }],
    ]),
  );
  const healthy = healthPort();
  const available = concurrencyPort(new Map());
  const afterWindow = options.afterContention?.windowCost;
  const instance = scheduler({
    eligibility: {
      async revalidate(input) {
        calls.eligibility.push(input.candidate.accountId);
        if (!contended && options.winner)
          return input.candidate.accountId === 'account-a' ? { decision: 'deny' } : baseEligibility.revalidate(input);
        return (contended ? (options.afterContention?.eligibility ?? baseEligibility) : baseEligibility).revalidate(
          input,
        );
      },
    },
    health: {
      async get(input) {
        calls.health.push(input.candidate.accountId);
        return (contended ? (options.afterContention?.health ?? healthy) : healthy).get(input);
      },
    },
    concurrency: {
      async get(input) {
        calls.concurrency.push(input.candidate.accountId);
        return (contended ? (options.afterContention?.concurrency ?? available) : available).get(input);
      },
    },
    windowCost: afterWindow
      ? {
          async resolveWindowCostSchedulability(input) {
            return contended ? afterWindow.resolveWindowCostSchedulability(input) : 'admit';
          },
        }
      : undefined,
    affinity: {
      async resolve() {
        calls.resolves++;
        return { decision: 'allow', accountId: null };
      },
      async bind(input) {
        calls.binds.push(input.accountId);
        if (!contended) {
          contended = true;
          if (options.initialDecision !== undefined) return options.initialDecision as never;
          return {
            decision: 'block',
            reason: 'provider account affinity binding conflict',
            contention: options.hint === undefined ? { kind: 'active_binding', accountId: 'account-a' } : options.hint,
          } as never;
        }
        if (options.finalThrows) throw new Error('private final affinity storage failure');
        if (options.finalDecision !== undefined) return options.finalDecision as never;
        return options.secondConflict
          ? {
              decision: 'block',
              reason: 'provider account affinity binding conflict',
              contention: { kind: 'active_binding', accountId: 'account-b' },
            }
          : { decision: 'allow' };
      },
    },
  });
  return { instance, calls, input: baseInput(source, { sessionId: 'combined-session' }) };
}

test('combined selection revalidates and binds the one typed winner without resolving affinity again', async () => {
  const harness = combinedAffinityHarness();
  const result = await harness.instance.selectAndBindCandidate(harness.input);
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
  assert.equal(harness.calls.resolves, 1);
  assert.deepEqual(harness.calls.binds, ['account-b', 'account-a']);
  for (const key of ['eligibility', 'health', 'concurrency'] as const) {
    assert.deepEqual(harness.calls[key], ['account-a', 'account-b', 'account-a']);
  }
});

test('combined uncontended and reference-free selection add no check-chain pass or affinity call', async () => {
  const events: string[] = [];
  const base = eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]]));
  const instance = scheduler({
    eligibility: {
      async revalidate(input) {
        events.push('eligibility');
        return base.revalidate(input);
      },
    },
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    affinity: {
      async resolve() {
        events.push('resolve');
        return { decision: 'allow', accountId: null };
      },
      async bind() {
        events.push('bind');
        return { decision: 'allow' };
      },
    },
  });
  assert.equal(
    (await instance.selectAndBindCandidate(baseInput([candidate('account-a')], { sessionId: 'combined' }))).decision,
    'allow',
  );
  assert.deepEqual(events, ['eligibility', 'resolve', 'bind']);
  events.length = 0;
  assert.equal((await instance.selectAndBindCandidate(baseInput([candidate('account-a')]))).decision, 'allow');
  assert.deepEqual(events, ['eligibility']);
});

for (const [name, hint] of [
  ['string-only block', null],
  ['unknown kind', { kind: 'other', accountId: 'account-a' }],
  ['inherited hint', Object.create({ kind: 'active_binding', accountId: 'account-a' })],
  ['empty winner', { kind: 'active_binding', accountId: '' }],
  ['same proposal', { kind: 'active_binding', accountId: 'account-b' }],
  ['outside source', { kind: 'active_binding', accountId: 'account-z' }],
] as const) {
  test(`combined binding keeps ${name} fail closed`, async () => {
    const harness = combinedAffinityHarness({ hint });
    assert.equal((await harness.instance.selectAndBindCandidate(harness.input)).decision, 'block');
    assert.deepEqual(harness.calls.binds, ['account-b']);
    assert.equal(harness.calls.resolves, 1);
    assert.equal(harness.calls.eligibility.length, 2);
  });
}

test('combined binding rejects inherited contention and malformed block reasons', async () => {
  const contention = { kind: 'active_binding', accountId: 'account-a' };
  for (const initialDecision of [
    Object.assign(Object.create({ contention }), { decision: 'block', reason: 'binding conflict' }),
    { decision: 'block', contention },
    { decision: 'block', reason: '', contention },
  ]) {
    const harness = combinedAffinityHarness({ initialDecision });
    assert.equal((await harness.instance.selectAndBindCandidate(harness.input)).decision, 'block');
    assert.deepEqual(harness.calls.binds, ['account-b']);
    assert.equal(harness.calls.eligibility.length, 2);
  }
});

test('combined binding never invokes accessor-backed decision or contention fields', async () => {
  let getterCalls = 0;
  const accessor = () => {
    getterCalls++;
    throw new Error('private affinity accessor');
  };
  const cases = [
    Object.defineProperty({ decision: 'block', reason: 'binding conflict' }, 'contention', { get: accessor }),
    Object.defineProperty(
      { decision: 'block', contention: { kind: 'active_binding', accountId: 'account-a' } },
      'reason',
      { get: accessor },
    ),
    Object.defineProperty(
      { reason: 'binding conflict', contention: { kind: 'active_binding', accountId: 'account-a' } },
      'decision',
      { get: accessor },
    ),
    {
      decision: 'block',
      reason: 'binding conflict',
      contention: Object.defineProperty({ accountId: 'account-a' }, 'kind', { get: accessor }),
    },
    {
      decision: 'block',
      reason: 'binding conflict',
      contention: Object.defineProperty({ kind: 'active_binding' }, 'accountId', { get: accessor }),
    },
    {
      decision: 'block',
      reason: 'binding conflict',
      contention: { kind: 'active_binding', accountId: 'account-a', extra: true },
    },
  ];
  for (const initialDecision of cases) {
    const harness = combinedAffinityHarness({ initialDecision });
    assert.equal((await harness.instance.selectAndBindCandidate(harness.input)).decision, 'block');
    assert.deepEqual(harness.calls.binds, ['account-b']);
    assert.equal(harness.calls.eligibility.length, 2);
  }
  assert.equal(getterCalls, 0);
});

test('combined winner cannot cross a binding scope or reuse an attempted account', async () => {
  const foreign = combinedAffinityHarness({ winner: { ...candidate('account-a'), providerId: 'foreign-provider' } });
  assert.equal((await foreign.instance.selectAndBindCandidate(foreign.input)).decision, 'block');
  assert.deepEqual(foreign.calls.binds, ['account-b']);
  const attempted = combinedAffinityHarness();
  const result = await attempted.instance.selectAndBindCandidate({
    ...attempted.input,
    scheduling: { ...attempted.input.scheduling, attemptedAccountIds: ['account-a'] },
  });
  assert.equal(result.decision, 'block');
  assert.deepEqual(attempted.calls.binds, ['account-b']);
  assert.deepEqual(attempted.calls.eligibility, ['account-b']);
});

for (const [name, afterContention, expected] of [
  [
    'revoked eligibility',
    {
      eligibility: {
        async revalidate() {
          return { decision: 'deny' as const };
        },
      },
    },
    'reject',
  ],
  [
    'unavailable eligibility',
    {
      eligibility: {
        async revalidate() {
          return { decision: 'block' as const, reason: 'authority unavailable' };
        },
      },
    },
    'block',
  ],
  ['unhealthy winner', { health: healthPort(new Map([['account-a', 'unhealthy']])) }, 'block'],
  [
    'unavailable health',
    {
      health: {
        async get() {
          return { decision: 'block' as const, reason: 'health unavailable' };
        },
      },
    },
    'block',
  ],
  ['busy winner', { concurrency: concurrencyPort(new Map([['account-a', { inFlight: 2, limit: 2 }]])) }, 'reject'],
  [
    'unavailable capacity',
    {
      concurrency: {
        async get() {
          return { decision: 'block' as const, reason: 'capacity unavailable' };
        },
      },
    },
    'block',
  ],
  [
    'paused window',
    {
      windowCost: {
        async resolveWindowCostSchedulability() {
          return 'paused' as const;
        },
      },
    },
    'reject',
  ],
] as const) {
  test(`combined binding rechecks ${name} before its final bind`, async () => {
    const harness = combinedAffinityHarness({ afterContention });
    const result = await harness.instance.selectAndBindCandidate(harness.input);
    assert.equal(result.decision, expected);
    if (result.decision === 'reject')
      assert.equal(result.code, name === 'busy winner' ? 'rate_limited' : 'account_denied');
    assert.deepEqual(harness.calls.binds, ['account-b']);
    assert.equal(harness.calls.resolves, 1);
  });
}

test('combined winner preserves the existing sticky-only window reserve band', async () => {
  const windowReads: boolean[] = [];
  const harness = combinedAffinityHarness({
    afterContention: {
      windowCost: {
        async resolveWindowCostSchedulability(input) {
          windowReads.push(input.isSticky);
          return 'sticky_only';
        },
      },
    },
  });
  const result = await harness.instance.selectAndBindCandidate(harness.input);
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-a');
  assert.deepEqual(windowReads, [false, true]);
  assert.deepEqual(harness.calls.binds, ['account-b', 'account-a']);
  assert.equal(harness.calls.resolves, 1);
});

test('combined binding rate limits a second authorized winner without another check or bind', async () => {
  const harness = combinedAffinityHarness({ secondConflict: true });
  const result = await harness.instance.selectAndBindCandidate(harness.input);
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') assert.equal(result.code, 'rate_limited');
  assert.equal(Object.hasOwn(result, 'retryAfterSeconds'), false);
  assert.deepEqual(harness.calls.binds, ['account-b', 'account-a']);
  assert.equal(harness.calls.resolves, 1);
  for (const key of ['eligibility', 'health', 'concurrency'] as const) {
    assert.deepEqual(harness.calls[key], ['account-a', 'account-b', 'account-a']);
  }
});

test('a second typed winner may be a third original authorized account without revalidating it', async () => {
  const harness = combinedAffinityHarness({
    extraCandidates: [candidate('account-c')],
    finalDecision: {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
      contention: { kind: 'active_binding', accountId: 'account-c' },
    },
  });
  const result = await harness.instance.selectAndBindCandidate(harness.input);
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') assert.equal(result.code, 'rate_limited');
  assert.equal(Object.hasOwn(result, 'retryAfterSeconds'), false);
  assert.deepEqual(harness.calls.binds, ['account-b', 'account-a']);
  assert.deepEqual(harness.calls.eligibility, ['account-a', 'account-b', 'account-c', 'account-a']);
  assert.deepEqual(harness.calls.health, ['account-a', 'account-b', 'account-a']);
  assert.deepEqual(harness.calls.concurrency, ['account-a', 'account-b', 'account-a']);
  assert.equal(harness.calls.resolves, 1);
});

test('second contention outside the original unique, unattempted route scope stays blocked', async () => {
  for (const mode of ['outside', 'attempted', 'scope', 'duplicate'] as const) {
    const extra =
      mode === 'scope' ? { ...candidate('account-c'), providerId: 'foreign-provider' } : candidate('account-c');
    const harness = combinedAffinityHarness({
      extraCandidates: mode === 'outside' ? [] : mode === 'duplicate' ? [extra, extra] : [extra],
      finalDecision: {
        decision: 'block',
        reason: 'provider account affinity binding conflict',
        contention: { kind: 'active_binding', accountId: 'account-c' },
      },
    });
    if (mode === 'duplicate')
      harness.instance.select = async () => ({ decision: 'allow', value: candidate('account-b') });
    const result = await harness.instance.selectAndBindCandidate({
      ...harness.input,
      scheduling: {
        ...harness.input.scheduling,
        ...(mode === 'attempted' ? { attemptedAccountIds: ['account-c'] } : {}),
      },
    });
    assert.equal(result.decision, 'block', mode);
    assert.deepEqual(harness.calls.binds, ['account-b', 'account-a'], mode);
    assert.equal(harness.calls.eligibility.filter((id) => id === 'account-a').length, mode === 'duplicate' ? 1 : 2);
    assert.equal(harness.calls.resolves, mode === 'duplicate' ? 0 : 1);
  }
});

test('second bind requires a strict own-data plain typed winner rather than a conflict message', async () => {
  let getterCalls = 0;
  const accessor = () => {
    getterCalls++;
    throw new Error('private final affinity accessor');
  };
  const contention = { kind: 'active_binding', accountId: 'account-b' };
  for (const finalDecision of [
    { decision: 'block', reason: 'provider account affinity binding conflict' },
    { decision: 'block', reason: 'affinity insert compare-and-swap failed' },
    {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
      contention: { kind: 'active_binding', accountId: 'account-a' },
    },
    {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
      contention: { kind: 'other', accountId: 'account-b' },
    },
    {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
      contention: { ...contention, extra: true },
    },
    { decision: 'block', reason: 'provider account affinity binding conflict', contention: Object.create(contention) },
    Object.assign(Object.create({ contention }), {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
    }),
    Object.assign(Object.create({ extra: true }), {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
      contention,
    }),
    { decision: 'block', reason: 'provider account affinity binding conflict', contention, extra: true },
    Object.defineProperty({ decision: 'block', reason: 'provider account affinity binding conflict' }, 'contention', {
      get: accessor,
    }),
    {
      decision: 'block',
      reason: 'provider account affinity binding conflict',
      contention: Object.defineProperty({ kind: 'active_binding' }, 'accountId', { get: accessor }),
    },
    { decision: 'block', contention },
  ]) {
    const harness = combinedAffinityHarness({ finalDecision });
    const result = await harness.instance.selectAndBindCandidate(harness.input);
    assert.equal(result.decision, 'block');
    assert.deepEqual(harness.calls.binds, ['account-b', 'account-a']);
    assert.equal(harness.calls.resolves, 1);
    for (const key of ['eligibility', 'health', 'concurrency'] as const) {
      assert.deepEqual(harness.calls[key], ['account-a', 'account-b', 'account-a']);
    }
  }
  assert.equal(getterCalls, 0);
});

test('a thrown final bind remains blocked after exactly one winner revalidation', async () => {
  const harness = combinedAffinityHarness({ finalThrows: true });
  const result = await harness.instance.selectAndBindCandidate(harness.input);
  assert.equal(result.decision, 'block');
  assert.deepEqual(harness.calls.binds, ['account-b', 'account-a']);
  assert.equal(harness.calls.resolves, 1);
  for (const key of ['eligibility', 'health', 'concurrency'] as const) {
    assert.deepEqual(harness.calls[key], ['account-a', 'account-b', 'account-a']);
  }
});

for (const decision of [
  { decision: 'allow', value: { inFlight: 2, limit: 2 } },
  { decision: 'allow', value: { inFlight: 3, limit: 2 } },
  { decision: 'deny', reason: 'advisory capacity precheck is full' },
] as const) {
  test(`capacity ${JSON.stringify(decision)} rate limits initial selection and a fresh affinity winner`, async () => {
    let initialReads = 0;
    const concurrency: ProviderAccountSchedulerConcurrencyPort = {
      async get() {
        initialReads++;
        return decision;
      },
    };
    const initial = await scheduler({
      eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
      health: healthPort(),
      concurrency,
    }).select(baseInput([candidate('account-a')]));
    assert.equal(initial.decision, 'reject');
    if (initial.decision === 'reject') assert.equal(initial.code, 'rate_limited');
    assert.equal(Object.hasOwn(initial, 'retryAfterSeconds'), false);
    assert.equal(initialReads, 1);
    const harness = combinedAffinityHarness({ afterContention: { concurrency } });
    const result = await harness.instance.selectAndBindCandidate(harness.input);
    assert.equal(result.decision, 'reject');
    if (result.decision === 'reject') assert.equal(result.code, 'rate_limited');
    assert.equal(Object.hasOwn(result, 'retryAfterSeconds'), false);
    assert.deepEqual(harness.calls.binds, ['account-b']);
    assert.deepEqual(harness.calls.concurrency, ['account-a', 'account-b', 'account-a']);
    assert.equal(harness.calls.resolves, 1);
  });
}

for (const [label, value] of [
  ['string in-flight', { inFlight: '2', limit: 2 }],
  ['string limit', { inFlight: 2, limit: '2' }],
  ['zero limit', { inFlight: 0, limit: 0 }],
  ['negative limit', { inFlight: 0, limit: -1 }],
  ['negative in-flight', { inFlight: -1, limit: 2 }],
  ['fractional in-flight', { inFlight: 2.5, limit: 2 }],
  ['fractional limit', { inFlight: 3, limit: 2.5 }],
  ['NaN in-flight', { inFlight: Number.NaN, limit: 2 }],
  ['NaN limit', { inFlight: 2, limit: Number.NaN }],
  ['infinite in-flight', { inFlight: Number.POSITIVE_INFINITY, limit: 2 }],
  ['unsafe in-flight', { inFlight: Number.MAX_SAFE_INTEGER + 1, limit: 2 }],
  ['unsafe limit', { inFlight: 0, limit: Number.MAX_SAFE_INTEGER + 1 }],
  ['null snapshot', null],
] as const) {
  test(`malformed capacity ${label} blocks initial and fresh winner checks before busy classification`, async () => {
    const concurrency: ProviderAccountSchedulerConcurrencyPort = {
      async get() {
        return { decision: 'allow', value } as never;
      },
    };
    const initial = await scheduler({
      eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
      health: healthPort(),
      concurrency,
    }).select(baseInput([candidate('account-a')]));
    assert.equal(initial.decision, 'block');
    const harness = combinedAffinityHarness({ afterContention: { concurrency } });
    const result = await harness.instance.selectAndBindCandidate(harness.input);
    assert.equal(result.decision, 'block');
    assert.deepEqual(harness.calls.binds, ['account-b']);
    assert.deepEqual(harness.calls.concurrency, ['account-a', 'account-b', 'account-a']);
  });
}

test('capacity classification preserves durable health priority and does not reopen denied candidates', async () => {
  for (const mode of ['health', 'eligibility', 'window'] as const) {
    const result = await scheduler({
      eligibility: eligibilityPort(
        new Map(
          mode === 'eligibility'
            ? [['account-a', { priority: 1, weight: 1 }]]
            : [
                ['account-a', { priority: 1, weight: 1 }],
                ['account-b', { priority: 1, weight: 1 }],
              ],
        ),
      ),
      health: healthPort(new Map(mode === 'health' ? [['account-b', 'unhealthy']] : [])),
      concurrency: concurrencyPort(new Map([['account-a', { inFlight: 2, limit: 2 }]])),
      windowCost:
        mode === 'window'
          ? {
              async resolveWindowCostSchedulability(input) {
                return input.candidate.accountId === 'account-b' ? 'paused' : 'admit';
              },
            }
          : undefined,
    }).select(baseInput([candidate('account-a'), candidate('account-b')]));
    assert.equal(result.decision, mode === 'health' ? 'block' : 'reject', mode);
    if (result.decision === 'reject') assert.equal(result.code, 'rate_limited', mode);
  }
});

test('capacity denied only in the transient-hint fallback is still rate limited', async () => {
  let capacityReads = 0;
  const result = await scheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(),
    concurrency: {
      async get() {
        capacityReads++;
        return { decision: 'allow', value: { inFlight: 2, limit: 2 } };
      },
    },
    failureFeedback: { isExcluded: () => true },
  }).select(baseInput([candidate('account-a')]));
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') assert.equal(result.code, 'rate_limited');
  assert.equal(capacityReads, 1);
});

test('a capacity refusal does not hide another malformed capacity authority', async () => {
  const result = await scheduler({
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    concurrency: {
      async get(input) {
        return input.candidate.accountId === 'account-a'
          ? { decision: 'deny' }
          : ({ decision: 'allow', value: { inFlight: '2', limit: 2 } } as never);
      },
    },
  }).select(baseInput([candidate('account-a'), candidate('account-b')]));
  assert.equal(result.decision, 'block');
});

test('legacy explicit binding strips the winner hint and does not advertise combined preparation', async () => {
  const harness = combinedAffinityHarness();
  const value = harness.input;
  assert.equal('selectAndBind' in harness.instance, false);
  const result = await harness.instance.bindAffinity({
    caller: value.caller,
    entitlement: value.entitlement,
    publicModel: value.publicModel,
    protocol: value.protocol,
    route: value.route,
    context: value.scheduling as RequestPreparationSchedulingContext,
    candidate: candidate('account-b'),
  });
  assert.deepEqual(result, { decision: 'block', reason: 'provider account affinity binding conflict' });
  assert.deepEqual(harness.calls.binds, ['account-b']);
  assert.equal(harness.calls.resolves, 0);
});

test('combined selection checks source and attempted identity before its first bind', async () => {
  for (const selected of [
    candidate('account-z'),
    { ...candidate('account-b'), credentialId: 'foreign-credential' },
    { ...candidate('account-b'), accountOwnerKind: 'tenant' as const },
    candidate('account-a'),
  ]) {
    const harness = combinedAffinityHarness();
    harness.instance.select = async () => ({
      decision: 'allow',
      value: selected as unknown as RequestPreparationCandidateAuthority,
    });
    const result = await harness.instance.selectAndBindCandidate({
      ...harness.input,
      scheduling: { ...harness.input.scheduling, attemptedAccountIds: ['account-a'] },
    });
    assert.equal(result.decision, 'block');
    assert.deepEqual(harness.calls.binds, []);
  }
});

test('native capability follows the trusted route while candidate and rights retain client scope', async () => {
  const base = eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]]));
  const input = baseInput([candidate('account-a')]);
  const bridged = {
    ...input,
    route: {
      ...input.route,
      providerProtocol: 'anthropic' as const,
      clientOperation: 'chat.completions',
      providerOperation: 'messages',
    },
  };
  const native: ProviderAccountSchedulerEligibilityPort = {
    async revalidate(facts) {
      assert.equal(facts.protocol, 'openai');
      assert.equal(facts.candidate.protocol, 'openai');
      assert.equal(facts.route?.providerProtocol, 'anthropic');
      assert.equal(facts.route?.providerOperation, 'messages');
      const result = await base.revalidate(facts);
      assert.equal(result.decision, 'allow');
      if (result.decision !== 'allow') return result;
      return { ...result, capability: { ...result.capability, protocol: 'anthropic' } };
    },
  };
  const result = await scheduler({
    eligibility: native,
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(bridged);
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.protocol, 'openai');

  const wrong = await scheduler({
    eligibility: base,
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(bridged);
  assert.equal(wrong.decision, 'block', 'a client-shaped capability cannot substitute for native support');

  const legacy = await scheduler({
    eligibility: base,
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  }).select(input);
  assert.equal(legacy.decision, 'allow', 'absence of a native protocol preserves legacy exact matching');
});

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

test('trusted eligibility time checks rights independently of health and scheduling time', async (t) => {
  for (const offset of [-86_400_000, 86_400_000]) {
    await t.test(`authority offset ${offset}ms`, async () => {
      const authorityAt = new Date(NOW.getTime() + offset);
      const base = eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]]));
      const result = await scheduler({
        eligibility: {
          async revalidate(input) {
            const value = await base.revalidate(input);
            assert.equal(value.decision, 'allow');
            if (value.decision !== 'allow') return value;
            return {
              ...value,
              authorityAt,
              rights: {
                ...value.rights,
                effectiveAt: new Date(authorityAt.getTime() - 1),
                expiresAt: new Date(authorityAt.getTime() + 1),
              },
            };
          },
        },
        health: healthPort(),
        concurrency: concurrencyPort(new Map()),
      }).select(baseInput([candidate('account-a')]));
      assert.equal(result.decision, 'allow', 'rights use authority time while health remains at scheduler NOW');
    });
  }

  for (const boundary of ['future', 'expired'] as const) {
    await t.test(`${boundary} at the authority clock`, async () => {
      const authorityAt = new Date(NOW.getTime() + (boundary === 'future' ? -100 : 100));
      const base = eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]]));
      const result = await scheduler({
        eligibility: {
          async revalidate(input) {
            const value = await base.revalidate(input);
            assert.equal(value.decision, 'allow');
            if (value.decision !== 'allow') return value;
            return {
              ...value,
              authorityAt: authorityAt.toISOString(),
              rights: {
                ...value.rights,
                effectiveAt: new Date(NOW.getTime() - 50),
                expiresAt: new Date(NOW.getTime() + 50),
              },
            };
          },
        },
        health: healthPort(),
        concurrency: concurrencyPort(new Map()),
      }).select(baseInput([candidate('account-a')]));
      assert.equal(result.decision, 'block', 'a host-active right cannot waive the authority window');
    });
  }
});

test('only truly absent eligibility authority time preserves the legacy clock', async (t) => {
  const cases = [
    { label: 'absent', present: false, inherited: false, value: undefined, allowed: true },
    { label: 'own undefined', present: true, inherited: false, value: undefined, allowed: false },
    { label: 'own null', present: true, inherited: false, value: null, allowed: false },
    { label: 'invalid string', present: true, inherited: false, value: 'not-a-date', allowed: false },
    { label: 'invalid Date', present: true, inherited: false, value: new Date(Number.NaN), allowed: false },
    { label: 'inherited valid time', present: false, inherited: true, value: NOW, allowed: false },
    { label: 'inherited undefined', present: false, inherited: true, value: undefined, allowed: false },
  ];
  for (const entry of cases) {
    await t.test(entry.label, async () => {
      let healthCalls = 0;
      const base = eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]]));
      const result = await scheduler({
        eligibility: {
          async revalidate(input) {
            const value = await base.revalidate(input);
            assert.equal(value.decision, 'allow');
            if (value.decision !== 'allow') return value;
            const changed: Record<string, unknown> = { ...value };
            if (entry.present) changed.authorityAt = entry.value;
            if (entry.inherited) Object.setPrototypeOf(changed, { authorityAt: entry.value });
            return changed as unknown as ProviderAccountSchedulerEligibilityAllowed;
          },
        },
        health: healthPort(new Map(), {
          async get() {
            healthCalls += 1;
            return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
          },
        }),
        concurrency: concurrencyPort(new Map()),
      }).select(baseInput([candidate('account-a')]));
      assert.equal(result.decision, entry.allowed ? 'allow' : 'block');
      assert.equal(healthCalls, entry.allowed ? 1 : 0);
    });
  }
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

test('health revalidation samples the injected clock after the asynchronous read', async (t) => {
  for (const [name, observedOffset, cooldownOffset, expected] of [
    ['a row refreshed while awaiting the read', 0, null, 'allow'],
    ['the unchanged future tolerance boundary', 250, null, 'allow'],
    ['a genuinely future row', 251, null, 'block'],
    ['the unchanged maximum age boundary', -60_000, null, 'allow'],
    ['an expired observation', -60_001, null, 'block'],
    ['a live cooldown', 0, 1, 'block'],
    ['an expired cooldown on a degraded row', 0, -1, 'allow'],
  ] as const) {
    await t.test(name, async () => {
      let current = NOW.getTime();
      const clock = () => new Date(current);
      const instance = new ProviderAccountScheduler(
        {
          eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
          health: {
            async get(input) {
              assert.equal(input.clock, clock);
              assert.equal(input.now.getTime(), NOW.getTime());
              await Promise.resolve();
              current += 1_000;
              return {
                decision: 'allow',
                value: {
                  status: cooldownOffset === null ? 'healthy' : 'degraded',
                  observedAt: new Date(current + observedOffset),
                  cooldownUntil: cooldownOffset === null ? null : new Date(current + cooldownOffset),
                },
              };
            },
          },
          concurrency: concurrencyPort(new Map()),
        },
        { now: clock, maxHealthAgeMs: 60_000 },
      );
      assert.equal((await instance.select(baseInput([candidate('account-a')]))).decision, expected);
    });
  }
});

test('an invalid or throwing final health clock fails closed', async (t) => {
  for (const failure of ['invalid-date', 'throw'] as const) {
    await t.test(failure, async () => {
      let sampled = false;
      const instance = new ProviderAccountScheduler(
        {
          eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
          health: {
            async get() {
              await Promise.resolve();
              sampled = true;
              return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
            },
          },
          concurrency: concurrencyPort(new Map()),
        },
        {
          now() {
            if (!sampled) return NOW;
            if (failure === 'throw') throw new Error('test-only clock failure');
            return new Date(Number.NaN);
          },
        },
      );
      assert.equal((await instance.select(baseInput([candidate('account-a')]))).decision, 'block');
    });
  }
});

test('the production default health clock is live after an asynchronous read', async () => {
  const instance = new ProviderAccountScheduler({
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: {
      async get(input) {
        assert.equal(typeof input.clock, 'function');
        await Promise.resolve();
        return { decision: 'allow', value: { status: 'healthy', observedAt: new Date() } };
      },
    },
    concurrency: concurrencyPort(new Map()),
  });
  assert.equal((await instance.select(baseInput([candidate('account-a')]))).decision, 'allow');
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

/* ------------------------------------------------------------------ */
/* Core-plan 9.1 (B06): model-level cooldown consumed by the scheduler  */
/* ------------------------------------------------------------------ */

test('model cooldown excludes the cooled (account, model) candidate before eligibility (9.1)', async () => {
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
    modelCooldown: {
      isModelExcluded(input) {
        // Only the (account-a, provider-model-a) pair is cooled; the model
        // passed to the seam is the candidate's resolved upstream model.
        assert.equal(input.model, 'provider-model-a');
        assert.ok(input.now instanceof Date);
        return input.candidate.accountId === 'account-a';
      },
    },
  }).select(baseInput(candidates));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  // The cooled pair is skipped before the eligibility authority is consulted.
  assert.equal(revalidations, 1);
});

test('model cooldown accepts a promise-returning durable read (9.1 multi-instance)', async () => {
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
    modelCooldown: {
      // The durable registry (migration 133) resolves the read from PG; the
      // candidate loop awaits it with the same P17 skip semantics.
      async isModelExcluded(input) {
        assert.equal(input.model, 'provider-model-a');
        assert.ok(input.now instanceof Date);
        return Promise.resolve(input.candidate.accountId === 'account-a');
      },
    },
  }).select(baseInput(candidates));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
  assert.equal(revalidations, 1);
});

test('model cooldown cooling every candidate fails open like the failure-feedback hint (9.1, P17)', async () => {
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
    modelCooldown: {
      isModelExcluded() {
        return true;
      },
    },
  }).select(baseInput(candidates));
  // The model cooldown is the same class of in-process hint: with every
  // candidate cooled the request still dispatches so the client observes the
  // provider's real status instead of a gateway rejection.
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.ok(['account-a', 'account-b'].includes(result.value.accountId));
  }
});

test('model cooldown still blocks closed when the durable authorities deny every candidate (9.1, K2)', async () => {
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
    modelCooldown: {
      isModelExcluded() {
        return true;
      },
    },
  }).select(baseInput(candidates));
  assert.deepEqual(result, {
    decision: 'block',
    code: 'capability_unavailable',
    message: 'no schedulable provider account is available',
  });
});

test('model cooldown AND failure feedback both emptying the set re-run the union fail-open (9.1, P17)', async () => {
  const candidates = [candidate('account-a'), candidate('account-b')];
  let sawFallback = false;
  const result = await scheduler({
    eligibility: eligibilityPort(new Map(), {
      async revalidate(input) {
        sawFallback = true;
        return eligibilityPort(new Map([[input.candidate.accountId, { priority: 1, weight: 1 }]])).revalidate(input);
      },
    }),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
    failureFeedback: {
      isExcluded(input) {
        return input.candidate.accountId === 'account-a';
      },
    },
    modelCooldown: {
      isModelExcluded(input) {
        return input.candidate.accountId === 'account-b';
      },
    },
  }).select(baseInput(candidates));
  // account-a is cooled by feedback, account-b by the model registry: the
  // union fallback re-runs BOTH with the hints cleared instead of starved.
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.ok(['account-a', 'account-b'].includes(result.value.accountId));
  }
  assert.ok(sawFallback, 'eligibility should have been consulted in the fallback pass');
});

test('a surviving candidate keeps the model-cooldown exclusion effective (9.1)', async () => {
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
    modelCooldown: {
      isModelExcluded(input) {
        return input.candidate.accountId === 'account-a';
      },
    },
  }).select(baseInput(candidates));
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') assert.equal(result.value.accountId, 'account-b');
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

/*
 * Core-plan 9.2 — the bounded sticky wait. The seam is default-OFF: every
 * pre-existing test in this file runs without `stickyWait` and therefore
 * keeps the byte-identical selection path (including the busy-skip and the
 * defensive block). These tests cover the enabled seam only.
 *
 * The clock is virtual and advances one fixed step per `now()` call, so the
 * wait loop terminates deterministically after ~maxWaitMs/step ticks while
 * the real sleeps (tickMs) stay sub-millisecond.
 */
function advancingClock(stepMs = 25): () => Date {
  let virtualMs = NOW.getTime();
  return () => {
    virtualMs += stepMs;
    return new Date(virtualMs);
  };
}

function stickyWaitScheduler(
  dependencies: ProviderAccountSchedulerDependencies,
  config: { readonly maxWaitMs: number; readonly maxQueueLength: number; readonly tickMs: number },
): ProviderAccountScheduler {
  return new ProviderAccountScheduler(dependencies, {
    now: advancingClock(),
    maxHealthAgeMs: 60_000,
    stickyWait: config,
  });
}

test('sticky wait: a busy target is held and selected when a lease slot frees', async () => {
  const observedDomains: (readonly string[])[] = [];
  let concurrencyCalls = 0;
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    concurrency: {
      async get(input) {
        concurrencyCalls += 1;
        if (input.candidate.accountId !== 'account-a') {
          return { decision: 'allow', value: { inFlight: 0, limit: 2 } };
        }
        // First pass busy → wait re-check frees the lease slot.
        return concurrencyCalls <= 1
          ? { decision: 'deny', reason: 'no free lease slot' }
          : { decision: 'allow', value: { inFlight: 0, limit: 2 } };
      },
    },
    affinity: {
      async resolve(input) {
        observedDomains.push(input.eligibleAccountIds);
        return { decision: 'allow', accountId: 'account-a' };
      },
    },
  };
  const result = await stickyWaitScheduler(dependencies, { maxWaitMs: 200, maxQueueLength: 2, tickMs: 5 }).select(
    baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-sticky-wait' }),
  );

  assert.equal(concurrencyCalls >= 2, true, 'the selection re-checked the busy target');
  // The resolution domain EXTENDED to the busy population, so the binding
  // holder sees the busy target as still-bound (no 'stale' invalidation).
  assert.deepEqual(observedDomains, [['account-b', 'account-a']]);
  assert.equal(result.decision, 'allow');
  if (result.decision === 'allow') {
    assert.equal(result.value.accountId, 'account-a');
  }
});

test('sticky wait: an exhausted budget answers 429 with a Retry-After hint', async () => {
  const observedDomains: (readonly string[])[] = [];
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    concurrency: {
      async get(input) {
        if (input.candidate.accountId !== 'account-a') {
          return { decision: 'allow', value: { inFlight: 0, limit: 2 } };
        }
        return { decision: 'deny', reason: 'no free lease slot' };
      },
    },
    affinity: {
      async resolve(input) {
        observedDomains.push(input.eligibleAccountIds);
        return { decision: 'allow', accountId: 'account-a' };
      },
    },
  };
  const result = await stickyWaitScheduler(dependencies, { maxWaitMs: 100, maxQueueLength: 2, tickMs: 5 }).select(
    baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-sticky-wait' }),
  );

  assert.deepEqual(observedDomains, [['account-b', 'account-a']]);
  assert.equal(result.decision, 'reject');
  if (result.decision === 'reject') {
    assert.equal(result.code, 'rate_limited');
    assert.match(result.message, /bounded wait budget expired/);
    assert.equal(result.retryAfterSeconds, 1);
  }
});

test('sticky wait: a full waiter queue degrades to the ranking chain immediately', { timeout: 5_000 }, async () => {
  let signalFirstRecheck!: () => void;
  const firstRecheck = new Promise<void>((resolve) => {
    signalFirstRecheck = resolve;
  });
  let releaseFirstRecheck!: () => void;
  const firstRecheckReleased = new Promise<void>((resolve) => {
    releaseFirstRecheck = resolve;
  });
  let virtualMs = NOW.getTime();
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 1 }],
        ['account-b', { priority: 1, weight: 1 }],
      ]),
    ),
    health: healthPort(),
    // Hold the first waiter's recheck while the second request observes
    // the occupied queue. No wall-clock delay establishes that ordering.
    concurrency: (() => {
      let aCalls = 0;
      return {
        async get(input: { candidate: { accountId: string } }) {
          if (input.candidate.accountId !== 'account-a') {
            return { decision: 'allow', value: { inFlight: 0, limit: 2 } };
          }
          if (++aCalls === 2) {
            signalFirstRecheck();
            await firstRecheckReleased;
          }
          return { decision: 'deny', reason: 'no free lease slot' };
        },
      };
    })(),
    affinity: {
      async resolve() {
        return { decision: 'allow', accountId: 'account-a' };
      },
    },
  };
  const instance = new ProviderAccountScheduler(dependencies, {
    now: () => new Date(virtualMs),
    maxHealthAgeMs: 60_000,
    stickyWait: { maxWaitMs: 250, maxQueueLength: 1, tickMs: 5 },
  });
  const first = instance.select(
    baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-sticky-wait' }),
  );
  try {
    assert.equal(await Promise.race([firstRecheck.then(() => true), first.then(() => false)]), true);
    const secondResult = await instance.select(
      baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-sticky-wait' }),
    );
    assert.equal(secondResult.decision, 'allow');
    if (secondResult.decision === 'allow') assert.equal(secondResult.value.accountId, 'account-b');
    virtualMs += 250;
    releaseFirstRecheck();
    const firstResult = await first;
    assert.equal(firstResult.decision, 'reject');
    if (firstResult.decision === 'reject') assert.equal(firstResult.code, 'rate_limited');
  } finally {
    virtualMs += 250;
    releaseFirstRecheck();
    await Promise.allSettled([first]);
  }
});

test('sticky wait: a target that died (neither eligible nor busy) still blocks defensively', async () => {
  const result = await stickyWaitScheduler(
    {
      eligibility: eligibilityPort(new Map([['account-b', { priority: 1, weight: 1 }]])),
      health: healthPort(),
      concurrency: concurrencyPort(new Map()),
      affinity: {
        async resolve() {
          return { decision: 'allow', accountId: 'account-a' };
        },
      },
    },
    { maxWaitMs: 100, maxQueueLength: 2, tickMs: 5 },
  ).select(baseInput([candidate('account-a'), candidate('account-b')], { sessionId: 'session-sticky-wait' }));

  assert.equal(result.decision, 'block');
  if (result.decision === 'block') assert.match(result.message, /no longer eligible/);
});

test('sticky wait: malformed budgets are a composition error', () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(new Map()),
    health: healthPort(),
    concurrency: concurrencyPort(new Map()),
  };
  const base: { readonly maxWaitMs: number; readonly maxQueueLength: number; readonly tickMs: number } = {
    maxWaitMs: 100,
    maxQueueLength: 2,
    tickMs: 5,
  };
  for (const field of ['maxWaitMs', 'maxQueueLength', 'tickMs'] as const) {
    assert.throws(() => new ProviderAccountScheduler(dependencies, { stickyWait: { ...base, [field]: 0 } }), TypeError);
  }
});
