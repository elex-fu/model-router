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
} from '../../../src/saas/gateway/request-preparation-service.js';

/*
 * F2 (task #35) core-scheduler tests: the billing-group pool tier. The
 * eligibility `scheduling` block gains `groupPoolPriority`; when any candidate
 * carries one, a group tier runs BEFORE the priority/health tiers. With no
 * signal (the unrestricted default) the selection must stay byte-identical —
 * the R7 golden-fixture red line covers that separately and stays unmodified.
 */

const NOW = new Date('2026-10-15T12:00:00.000Z');

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
    providerId: 'provider-a',
    productId: 'product-a',
    poolId: 'pool-a',
    poolAuthzVersion: 1,
    poolMemberAccountAuthzVersion: 1,
    poolGrantAuthzVersion: 1,
    poolGrantProfileAuthzVersion: 3,
    poolGrantPoolAuthzVersion: 1,
  };
}

interface CandidatePolicy {
  readonly priority: number;
  readonly weight: number;
  /** F2 group-pool priority; omitted means "no signal" (unrestricted). */
  readonly groupPoolPriority?: number | null;
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
        scheduling: {
          soonestResetAt: null,
          soonestResetObservedAt: null,
          supplierCostRate: null,
          ...(policy.groupPoolPriority !== undefined ? { groupPoolPriority: policy.groupPoolPriority } : {}),
        },
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
      return { decision: 'allow', value: { inFlight: 0, limit: 4 } };
    },
  };
}

function dependencies(policies: ReadonlyMap<string, CandidatePolicy>): ProviderAccountSchedulerDependencies {
  return { eligibility: eligibilityPort(policies), health: healthPort(), concurrency: concurrencyPort() };
}

function scheduler(dep: ProviderAccountSchedulerDependencies): ProviderAccountScheduler {
  return new ProviderAccountScheduler(dep, { now: () => NOW, maxHealthAgeMs: 60_000 });
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
  };
}

async function selectAccount(
  dep: ProviderAccountSchedulerDependencies,
  candidates: readonly RequestPreparationCandidateAuthority[],
  requestId = 'request-a',
): Promise<string | null> {
  const result = await scheduler(dep).select(input(candidates, requestId));
  return result.decision === 'allow' ? result.value.accountId : null;
}

test('a higher group pool priority wins before the account priority tier', async () => {
  // account-a has the higher ACCOUNT priority but the lower GROUP priority;
  // the group tier runs first, so account-b must win every seed.
  const dep = dependencies(
    new Map([
      ['account-a', { priority: 9, weight: 10, groupPoolPriority: 10 }],
      ['account-b', { priority: 1, weight: 10, groupPoolPriority: 900 }],
    ]),
  );
  for (let index = 0; index < 12; index += 1) {
    assert.equal(
      await selectAccount(dep, [candidate('account-a'), candidate('account-b')], `request-${index}`),
      'account-b',
    );
  }
});

test('group pool priority ties fall through to the account priority tier', async () => {
  const dep = dependencies(
    new Map([
      ['account-a', { priority: 9, weight: 10, groupPoolPriority: 500 }],
      ['account-b', { priority: 1, weight: 10, groupPoolPriority: 500 }],
    ]),
  );
  for (let index = 0; index < 12; index += 1) {
    assert.equal(
      await selectAccount(dep, [candidate('account-a'), candidate('account-b')], `request-${index}`),
      'account-a',
    );
  }
});

test('an explicit null group priority is exactly the unrestricted default', async () => {
  const absent = dependencies(
    new Map([
      ['account-a', { priority: 5, weight: 9 }],
      ['account-b', { priority: 5, weight: 1 }],
    ]),
  );
  const explicitNull = dependencies(
    new Map([
      ['account-a', { priority: 5, weight: 9, groupPoolPriority: null }],
      ['account-b', { priority: 5, weight: 1, groupPoolPriority: null }],
    ]),
  );
  for (let index = 0; index < 12; index += 1) {
    const requestId = `request-${index}`;
    assert.equal(
      await selectAccount(explicitNull, [candidate('account-a'), candidate('account-b')], requestId),
      await selectAccount(absent, [candidate('account-a'), candidate('account-b')], requestId),
    );
  }
});

test('a group signal on only some candidates keeps the highest group tier (no guessing)', async () => {
  // Defensive shape: impossible under the narrowing SQL, but the ranking must
  // fail toward the enforced (signaled) domain rather than mixing tiers.
  const dep = dependencies(
    new Map([
      ['account-a', { priority: 9, weight: 10 }],
      ['account-b', { priority: 1, weight: 10, groupPoolPriority: 0 }],
    ]),
  );
  for (let index = 0; index < 8; index += 1) {
    assert.equal(
      await selectAccount(dep, [candidate('account-a'), candidate('account-b')], `request-${index}`),
      'account-b',
    );
  }
});

test('a malformed group pool priority signal fails closed', async () => {
  for (const malformed of [1001, -1, 0.5, '50', Number.NaN, true]) {
    const dep = dependencies(
      new Map([['account-a', { priority: 1, weight: 1, groupPoolPriority: malformed as number }]]),
    );
    const result = await scheduler(dep).select(input([candidate('account-a')]));
    assert.equal(result.decision, 'block', `group priority ${String(malformed)} must block`);
    if (result.decision === 'block') assert.match(result.message, /scheduler failed closed|invalid candidate/);
  }
});

test('an empty billing group id is rejected like every other malformed input field', async () => {
  const dep = dependencies(new Map([['account-a', { priority: 1, weight: 1 }]]));
  const result = await scheduler(dep).select({ ...input([candidate('account-a')]), billingGroupId: '' });
  assert.equal(result.decision, 'block');
});

test('the concurrency port receives the request identity for the slot pre-check seam', async () => {
  const seen: string[] = [];
  const dep: ProviderAccountSchedulerDependencies = {
    eligibility: eligibilityPort(new Map([['account-a', { priority: 1, weight: 1 }]])),
    health: healthPort(),
    concurrency: {
      async get(concurrencyInput) {
        seen.push(`${concurrencyInput.requestId}:${concurrencyInput.candidate.accountId}`);
        return { decision: 'allow', value: { inFlight: 0, limit: 4 } };
      },
    },
  };
  const result = await scheduler(dep).select(input([candidate('account-a')], 'request-slot'));
  assert.equal(result.decision, 'allow');
  assert.deepEqual(seen, ['request-slot:account-a']);
});
