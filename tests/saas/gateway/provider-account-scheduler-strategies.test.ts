import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ProviderAccountSchedulerConcurrencyPort,
  ProviderAccountSchedulerDependencies,
  ProviderAccountSchedulerEligibilityPort,
  ProviderAccountSchedulerHealthPort,
  ProviderAccountSchedulerStrategiesOptions,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import { ProviderAccountScheduler } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
  RequestPreparationEntitlement,
} from '../../../src/saas/gateway/request-preparation-service.js';

/*
 * R7 scheduling-strategy tests (plan §R7, docs/token-resale-implementation-
 * plan-2026-10-15.md). The fixture mirrors the mock-port harness of
 * provider-account-scheduler.test.ts; every test drives the public select()
 * path so the strategy composition is exercised exactly as production runs
 * it.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;

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

interface CandidatePolicy {
  priority: number;
  weight: number;
  /** R7 soonest-reset signal; omitted means "no signal" (NULL columns). */
  soonestResetAt?: Date | null;
  soonestResetObservedAt?: Date | null;
  /** R7 blended supplier rate; null means unknown cost. */
  supplierCostRate?: { numeratorMinorUnits: bigint; denominatorUnits: bigint } | null;
}

function eligibilityPort(policies: ReadonlyMap<string, CandidatePolicy>): ProviderAccountSchedulerEligibilityPort {
  return {
    async revalidate(input) {
      const policy = policies.get(input.candidate.accountId);
      if (!policy) return { decision: 'deny', reason: 'candidate not eligible' };
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
          expiresAt: null,
        },
        priority: policy.priority,
        weight: policy.weight,
        ...(policy.soonestResetAt !== undefined || policy.supplierCostRate !== undefined
          ? {
              scheduling: {
                soonestResetAt: policy.soonestResetAt ?? null,
                soonestResetObservedAt: policy.soonestResetObservedAt ?? null,
                supplierCostRate: policy.supplierCostRate ?? null,
              },
            }
          : {}),
      };
    },
  };
}

function healthPort(
  observations: ReadonlyMap<string, { status?: 'healthy' | 'degraded'; observedAt?: Date; latencyMs?: number | null }>,
): ProviderAccountSchedulerHealthPort {
  return {
    async get(input) {
      const observed = observations.get(input.candidate.accountId);
      return {
        decision: 'allow',
        value: {
          status: observed?.status ?? 'healthy',
          observedAt: observed?.observedAt ?? NOW,
          ...(observed?.latencyMs !== undefined ? { latencyMs: observed.latencyMs } : {}),
        },
      };
    },
  };
}

function concurrencyPort(
  snapshots: ReadonlyMap<string, { inFlight: number; limit: number }>,
): ProviderAccountSchedulerConcurrencyPort {
  return {
    async get(input) {
      return { decision: 'allow', value: snapshots.get(input.candidate.accountId) ?? { inFlight: 0, limit: 4 } };
    },
  };
}

function input(candidates: readonly RequestPreparationCandidateAuthority[], requestId = 'request-a') {
  return {
    requestId,
    attemptId: 'attempt-a',
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
  };
}

function scheduler(
  dependencies: ProviderAccountSchedulerDependencies,
  strategies?: ProviderAccountSchedulerStrategiesOptions,
): ProviderAccountScheduler {
  return new ProviderAccountScheduler(dependencies, { now: () => NOW, maxHealthAgeMs: 60_000, strategies });
}

async function selectAccount(
  dependencies: ProviderAccountSchedulerDependencies,
  candidates: readonly RequestPreparationCandidateAuthority[],
  strategies?: ProviderAccountSchedulerStrategiesOptions,
  requestId = 'request-a',
): Promise<{ accountId: string | null; scheduling?: { strategy: string; reasons: readonly string[] } }> {
  const result = await scheduler(dependencies, strategies).select(input(candidates, requestId));
  if (result.decision !== 'allow') return { accountId: null };
  return { accountId: result.value.accountId, scheduling: result.scheduling };
}

/* ------------------------------------------------------------------ */
/* Default-behavior regression (plan §R7 red line)                     */
/* ------------------------------------------------------------------ */

/**
 * Golden fixture captured from the pre-R7 scheduler on 2026-10-15 (before
 * any R7 strategy code landed): six accounts, mixed priority (account-e
 * tier 2 is filtered), a degraded account-c (health filter), mixed
 * in-flight ratios and weights, 24 deterministic request ids. The default
 * path must keep producing exactly this sequence — byte-identical default
 * behavior is the R7 red line.
 */
const GOLDEN_DEFAULT_SELECTION = [
  'account-d',
  'account-b',
  'account-d',
  'account-b',
  'account-d',
  'account-a',
  'account-d',
  'account-f',
  'account-b',
  'account-b',
  'account-f',
  'account-d',
  'account-b',
  'account-b',
  'account-d',
  'account-a',
  'account-d',
  'account-d',
  'account-b',
  'account-f',
  'account-a',
  'account-b',
  'account-b',
  'account-d',
];

const REGRESSION_ACCOUNTS = ['account-a', 'account-b', 'account-c', 'account-d', 'account-e', 'account-f'];

const REGRESSION_DEPENDENCIES: ProviderAccountSchedulerDependencies = {
  eligibility: eligibilityPort(
    new Map([
      ['account-a', { priority: 5, weight: 1 }],
      ['account-b', { priority: 5, weight: 7 }],
      ['account-c', { priority: 5, weight: 3 }],
      ['account-d', { priority: 5, weight: 5 }],
      ['account-e', { priority: 2, weight: 10 }],
      ['account-f', { priority: 5, weight: 2 }],
    ]),
  ),
  health: healthPort(new Map([['account-c', { status: 'degraded' }]])),
  concurrency: concurrencyPort(
    new Map([
      ['account-a', { inFlight: 0, limit: 4 }],
      ['account-b', { inFlight: 2, limit: 4 }],
      ['account-c', { inFlight: 1, limit: 8 }],
      ['account-d', { inFlight: 3, limit: 4 }],
      ['account-e', { inFlight: 0, limit: 2 }],
      ['account-f', { inFlight: 5, limit: 6 }],
    ]),
  ),
};

test('default selection order is byte-identical to the pre-R7 golden fixture', async () => {
  for (let index = 0; index < GOLDEN_DEFAULT_SELECTION.length; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      REGRESSION_DEPENDENCIES,
      REGRESSION_ACCOUNTS.map(candidate),
      undefined,
      `request-${index}`,
    );
    assert.equal(accountId, GOLDEN_DEFAULT_SELECTION[index]);
    assert.equal(scheduling, undefined, 'the default path must not attach a scheduling trace');
  }
});

test('an explicitly empty strategies object keeps the default order and adds no trace', async () => {
  for (let index = 0; index < GOLDEN_DEFAULT_SELECTION.length; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      REGRESSION_DEPENDENCIES,
      REGRESSION_ACCOUNTS.map(candidate),
      {},
      `request-${index}`,
    );
    assert.equal(accountId, GOLDEN_DEFAULT_SELECTION[index]);
    assert.equal(scheduling, undefined);
  }
});

test('latency coefficient 0 keeps every selection identical to the default', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: REGRESSION_DEPENDENCIES.eligibility,
    health: healthPort(
      new Map([
        ['account-c', { status: 'degraded' }],
        ['account-b', { latencyMs: 25_000 }],
        ['account-d', { latencyMs: 5_000 }],
      ]),
    ),
    concurrency: REGRESSION_DEPENDENCIES.concurrency,
  };
  for (let index = 0; index < GOLDEN_DEFAULT_SELECTION.length; index += 1) {
    const { accountId } = await selectAccount(
      dependencies,
      REGRESSION_ACCOUNTS.map(candidate),
      { latencyWeightCoefficient: 0 },
      `request-${index}`,
    );
    assert.equal(accountId, GOLDEN_DEFAULT_SELECTION[index]);
  }
});

/* ------------------------------------------------------------------ */
/* Soonest-reset promotion (plan §R7 item 1)                           */
/* ------------------------------------------------------------------ */

function soonestResetDependencies(resetAt: Date | null, observedAt: Date | null): ProviderAccountSchedulerDependencies {
  return {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 10, soonestResetAt: resetAt, soonestResetObservedAt: observedAt }],
        ['account-b', { priority: 1, weight: 10 }],
      ]),
    ),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
}

test('soonest-reset promotes an account whose quota window resets inside the horizon', async () => {
  const dependencies = soonestResetDependencies(new Date(NOW.getTime() + 10 * MINUTE), NOW);
  // The weighted draw would need astronomical luck to always pick account-a;
  // the promotion filter makes it deterministic across every seed.
  for (let index = 0; index < 12; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      dependencies,
      [candidate('account-b'), candidate('account-a')],
      { soonestReset: { enabled: true } },
      `request-${index}`,
    );
    assert.equal(accountId, 'account-a');
    assert.deepEqual(scheduling?.reasons, ['soonest-reset']);
  }
});

test('a reset exactly at the 30-minute boundary is not promoted (strictly less than)', async () => {
  const dependencies = soonestResetDependencies(new Date(NOW.getTime() + 30 * MINUTE), NOW);
  const picks = new Set<string>();
  for (let index = 0; index < 12; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      dependencies,
      [candidate('account-b'), candidate('account-a')],
      { soonestReset: { enabled: true } },
      `request-${index}`,
    );
    picks.add(accountId as string);
    assert.equal(scheduling?.reasons.includes('soonest-reset'), false);
  }
  // Without promotion both accounts stay in the pool under equal weights.
  assert.equal(picks.size, 2);
});

test('a reset just inside the 30-minute boundary is promoted', async () => {
  const dependencies = soonestResetDependencies(new Date(NOW.getTime() + 30 * MINUTE - 1), NOW);
  const { accountId } = await selectAccount(
    dependencies,
    [candidate('account-b'), candidate('account-a')],
    { soonestReset: { enabled: true } },
    'request-a',
  );
  assert.equal(accountId, 'account-a');
});

test('a stale snapshot never promotes (stale-snapshot guard)', async () => {
  // Reset is imminent, but the snapshot family was last refreshed two hours
  // ago — past the default 30-minute staleness bound.
  const stale = new Date(NOW.getTime() - 2 * 60 * MINUTE);
  const dependencies = soonestResetDependencies(new Date(NOW.getTime() + 10 * MINUTE), stale);
  for (let index = 0; index < 12; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      dependencies,
      [candidate('account-b'), candidate('account-a')],
      { soonestReset: { enabled: true } },
      `request-${index}`,
    );
    assert.equal(scheduling?.reasons.includes('soonest-reset'), false, `iteration ${index}`);
    assert.notEqual(accountId, null);
  }
});

test('an already-past reset or a reset without a refresh stamp never promotes', async () => {
  const past = soonestResetDependencies(new Date(NOW.getTime() - MINUTE), NOW);
  const { scheduling: pastReasons } = await selectAccount(
    past,
    [candidate('account-b'), candidate('account-a')],
    { soonestReset: { enabled: true } },
    'request-a',
  );
  assert.equal(pastReasons?.reasons.includes('soonest-reset'), false);

  const unstamped = soonestResetDependencies(new Date(NOW.getTime() + 10 * MINUTE), null);
  const { scheduling: unstampedReasons } = await selectAccount(
    unstamped,
    [candidate('account-b'), candidate('account-a')],
    { soonestReset: { enabled: true } },
    'request-a',
  );
  assert.equal(unstampedReasons?.reasons.includes('soonest-reset'), false);
});

test('a custom window and snapshot horizon are honored', async () => {
  // Reset in 50 minutes: outside the default horizon, inside a custom 60.
  const resetAt = new Date(NOW.getTime() + 50 * MINUTE);
  const observed = new Date(NOW.getTime() - 45 * MINUTE);
  const dependencies = soonestResetDependencies(resetAt, observed);
  const { accountId } = await selectAccount(
    dependencies,
    [candidate('account-b'), candidate('account-a')],
    { soonestReset: { enabled: true, windowMs: 60 * MINUTE, snapshotMaxAgeMs: 60 * MINUTE } },
    'request-a',
  );
  assert.equal(accountId, 'account-a');
});

/* ------------------------------------------------------------------ */
/* Cost priority (plan §R7 item 2)                                     */
/* ------------------------------------------------------------------ */

test('cost priority orders the zero-cost subscription pool ahead of metered keys', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        [
          'subscription',
          { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 0n, denominatorUnits: 1n } },
        ],
        [
          'metered',
          { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 3n, denominatorUnits: 1000n } },
        ],
      ]),
    ),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
  for (let index = 0; index < 12; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      dependencies,
      [candidate('metered'), candidate('subscription')],
      { costPriority: { enabled: true }, lru: { enabled: true } },
      `request-${index}`,
    );
    assert.equal(accountId, 'subscription');
    assert.equal(scheduling?.reasons.includes('cost-priority'), true);
  }
});

test('cost priority without LRU filters to the cheapest tier before weighted selection', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['free-a', { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 0n, denominatorUnits: 1n } }],
        ['free-b', { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 0n, denominatorUnits: 1000n } }],
        [
          'expensive',
          { priority: 1, weight: 1000, supplierCostRate: { numeratorMinorUnits: 3n, denominatorUnits: 1000n } },
        ],
        ['unknown', { priority: 1, weight: 1000, supplierCostRate: null }],
      ]),
    ),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
  const selected = new Set<string>();
  for (let index = 0; index < 100; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      dependencies,
      ['unknown', 'expensive', 'free-b', 'free-a'].map(candidate),
      { costPriority: { enabled: true } },
      `cost-only-${index}`,
    );
    assert.ok(accountId === 'free-a' || accountId === 'free-b', `selected ${accountId}`);
    assert.equal(scheduling?.strategy, 'weighted-draw');
    assert.ok(scheduling?.reasons.includes('cost-priority'));
    selected.add(accountId);
  }
  assert.equal(selected.size, 2, 'equal-cost candidates retain weighted selection');
});

test('cost comparison is exact rational arithmetic, not floating point', async () => {
  // 1/3 vs 1000000000000000001/3000000000000000000: float-equal, rationally
  // the left is strictly cheaper. Only bigint cross-multiplication separates
  // them, and the cheaper account must win every seed.
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['exact', { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 1n, denominatorUnits: 3n } }],
        [
          'floatEqual',
          {
            priority: 1,
            weight: 10,
            supplierCostRate: {
              numeratorMinorUnits: 1_000_000_000_000_000_001n,
              denominatorUnits: 3_000_000_000_000_000_000n,
            },
          },
        ],
      ]),
    ),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
  for (const lruEnabled of [false, true]) {
    for (let index = 0; index < 12; index += 1) {
      const { accountId } = await selectAccount(
        dependencies,
        [candidate('floatEqual'), candidate('exact')],
        { costPriority: { enabled: true }, lru: { enabled: lruEnabled } },
        `request-${index}`,
      );
      assert.equal(accountId, 'exact');
    }
  }
});

test('unknown cost (no supplier cost version) sorts after every known rate', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['unpriced', { priority: 1, weight: 10, supplierCostRate: null }],
        ['priced', { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 999n, denominatorUnits: 1n } }],
      ]),
    ),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
  for (let index = 0; index < 12; index += 1) {
    const { accountId } = await selectAccount(
      dependencies,
      [candidate('unpriced'), candidate('priced')],
      { costPriority: { enabled: true }, lru: { enabled: true } },
      `request-${index}`,
    );
    assert.equal(accountId, 'priced');
  }
});

/* ------------------------------------------------------------------ */
/* LRU tie-break + seeded in-group shuffle (plan §R7 item 3)           */
/* ------------------------------------------------------------------ */

/*
 * The LRU signal is the health authority's observedAt (the last recorded
 * runtime outcome), which must stay inside the health freshness bound — so
 * the fixtures use second-scale differences.
 */
function lruDependencies(lastUsed: ReadonlyMap<string, Date | null>): ProviderAccountSchedulerDependencies {
  return {
    eligibility: eligibilityPort(
      new Map([
        ['account-a', { priority: 1, weight: 10 }],
        ['account-b', { priority: 1, weight: 10 }],
        ['account-c', { priority: 1, weight: 10 }],
      ]),
    ),
    health: healthPort(
      new Map([
        ['account-a', { observedAt: (lastUsed.get('account-a') ?? NOW) as Date }],
        ['account-b', { observedAt: (lastUsed.get('account-b') ?? NOW) as Date }],
        ['account-c', { observedAt: (lastUsed.get('account-c') ?? NOW) as Date }],
      ]),
    ),
    concurrency: concurrencyPort(new Map()),
  };
}

test('LRU picks the least recently used account', async () => {
  const dependencies = lruDependencies(
    new Map([
      ['account-a', new Date(NOW.getTime() - 10_000)],
      ['account-b', new Date(NOW.getTime() - 50_000)],
      ['account-c', new Date(NOW.getTime() - 30_000)],
    ]),
  );
  const { accountId, scheduling } = await selectAccount(
    dependencies,
    [candidate('account-a'), candidate('account-b'), candidate('account-c')],
    { lru: { enabled: true } },
    'request-a',
  );
  assert.equal(accountId, 'account-b');
  assert.equal(scheduling?.strategy, 'lru-order+seeded-shuffle');
  assert.equal(scheduling?.reasons.includes('lru'), true);
});

test('LRU selection is reproducible for a fixed request identity and candidate order independent', async () => {
  const dependencies = lruDependencies(
    new Map([
      ['account-a', new Date(NOW.getTime() - 10_000)],
      ['account-b', new Date(NOW.getTime() - 20_000)],
      ['account-c', new Date(NOW.getTime() - 30_000)],
    ]),
  );
  const candidates = [candidate('account-a'), candidate('account-b'), candidate('account-c')];
  const first = await selectAccount(dependencies, candidates, { lru: { enabled: true } }, 'request-fixed');
  const second = await selectAccount(dependencies, candidates, { lru: { enabled: true } }, 'request-fixed');
  const reversed = await selectAccount(
    dependencies,
    [...candidates].reverse(),
    { lru: { enabled: true } },
    'request-fixed',
  );
  // All three strictly ordered on LRU: the shuffle never moves a strict order.
  assert.equal(first.accountId, 'account-c');
  assert.equal(second.accountId, 'account-c');
  assert.equal(reversed.accountId, 'account-c');
});

test('seeded in-group shuffle distributes tied candidates roughly evenly and always within the tie group', async () => {
  // Three candidates identical on the whole chain (no cost, equal load,
  // equal LRU) form one tie group; the seeded shuffle must spread picks.
  const dependencies = lruDependencies(new Map());
  const members = ['account-a', 'account-b', 'account-c'];
  const counts = new Map<string, number>(members.map((id) => [id, 0]));
  const REQUESTS = 900;
  for (let index = 0; index < REQUESTS; index += 1) {
    const { accountId } = await selectAccount(
      dependencies,
      members.map(candidate),
      { lru: { enabled: true } },
      `request-${index}`,
    );
    assert.ok(accountId !== null && counts.has(accountId), 'shuffle must stay inside the tie group');
    counts.set(accountId as string, (counts.get(accountId) as number) + 1);
  }
  const expected = REQUESTS / members.length;
  for (const member of members) {
    const observed = counts.get(member) as number;
    // Binomial tolerance (±4 sigma for n=900, p=1/3 ≈ ±32).
    assert.ok(Math.abs(observed - expected) <= 40, `member ${member} observed ${observed}, expected ~${expected}`);
    assert.ok(observed > 0, 'every tie-group member must be reachable');
  }
});

/* ------------------------------------------------------------------ */
/* Latency awareness (plan §R7 item 4)                                 */
/* ------------------------------------------------------------------ */

test('a positive latency coefficient demotes slow accounts in the weighted draw', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        ['fast', { priority: 1, weight: 10 }],
        ['slow', { priority: 1, weight: 10 }],
      ]),
    ),
    health: healthPort(
      new Map([
        ['fast', { latencyMs: 100 }],
        ['slow', { latencyMs: 30_000 }],
      ]),
    ),
    concurrency: concurrencyPort(new Map()),
  };
  const members = ['fast', 'slow'];
  const counts = new Map<string, number>(members.map((id) => [id, 0]));
  const REQUESTS = 400;
  for (let index = 0; index < REQUESTS; index += 1) {
    const { accountId, scheduling } = await selectAccount(
      dependencies,
      members.map(candidate),
      { latencyWeightCoefficient: 1 },
      `request-${index}`,
    );
    assert.ok(accountId !== null);
    counts.set(accountId, (counts.get(accountId) as number) + 1);
    assert.equal(scheduling?.reasons.includes('latency-weight'), true);
  }
  // coefficient 1 and a saturated 30s latency floor the slow weight at 5%
  // of its base; it must be selected clearly less often than the fast one.
  assert.ok(
    (counts.get('slow') as number) < (counts.get('fast') as number),
    `fast=${counts.get('fast')} slow=${counts.get('slow')}`,
  );
});

test('a malformed health latency signal fails closed', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(new Map([['account-a', { latencyMs: Number.NaN }]])),
    concurrency: concurrencyPort(new Map()),
  };
  const result = await scheduler(dependencies, { latencyWeightCoefficient: 0.5 }).select(
    input([candidate('account-a')]),
  );
  assert.equal(result.decision, 'block');
});

/* ------------------------------------------------------------------ */
/* Trace shape and option validation                                   */
/* ------------------------------------------------------------------ */

test('the trace names the tail algorithm and discriminated dimensions', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(
      new Map([
        [
          'subscription',
          { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 0n, denominatorUnits: 1n } },
        ],
        ['metered', { priority: 1, weight: 10, supplierCostRate: { numeratorMinorUnits: 5n, denominatorUnits: 1n } }],
      ]),
    ),
    health: healthPort(new Map([['metered', { latencyMs: 20_000 }]])),
    concurrency: concurrencyPort(new Map()),
  };
  const { scheduling } = await selectAccount(
    dependencies,
    [candidate('metered'), candidate('subscription')],
    { costPriority: { enabled: true }, latencyWeightCoefficient: 0.5 },
    'request-a',
  );
  assert.equal(scheduling?.strategy, 'weighted-draw');
  assert.deepEqual(scheduling?.reasons, ['cost-priority', 'latency-weight']);
});

test('malformed strategy options fail fast at construction', () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(new Map()),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
  assert.throws(() => scheduler(dependencies, { latencyWeightCoefficient: 1.5 }), TypeError);
  assert.throws(() => scheduler(dependencies, { soonestReset: { enabled: true, windowMs: 0 } }), TypeError);
  assert.throws(() => scheduler(dependencies, { soonestReset: { enabled: true, snapshotMaxAgeMs: -5 } }), TypeError);
});

test('an empty attempt id is rejected like every other malformed input field', async () => {
  const dependencies: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(new Map()),
    concurrency: concurrencyPort(new Map()),
  };
  const result = await scheduler(dependencies).select({ ...input([candidate('account-a')]), attemptId: '' });
  assert.equal(result.decision, 'block');
});
