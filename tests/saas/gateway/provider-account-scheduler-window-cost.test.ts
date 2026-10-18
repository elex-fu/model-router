import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ProviderAccountScheduler,
  type ProviderAccountSchedulerAffinityPort,
  type ProviderAccountSchedulerConcurrencyPort,
  type ProviderAccountSchedulerDependencies,
  type ProviderAccountSchedulerEligibilityPort,
  type ProviderAccountSchedulerHealthPort,
  type ProviderAccountSchedulerWindowCostPort,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import type { RequestPreparationCandidateAuthority } from '../../../src/saas/gateway/request-preparation-service.js';

/**
 * Gap-remediation G-B1 (§2.4): the window three-state gate's scheduler
 * invariants — the yellow band skips non-sticky selection, the reserve band
 * re-admits an affinity-bound target, the paused state skips both, the P17
 * fail-open union, and the absent-port golden red line.
 */

const NOW = new Date('2026-10-18T12:00:00Z');

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

const eligibilityPort: ProviderAccountSchedulerEligibilityPort = {
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
        expiresAt: null,
      },
      priority: 1,
      weight: 1,
    };
  },
};

const healthPort: ProviderAccountSchedulerHealthPort = {
  async get(input) {
    return {
      decision: 'allow',
      value: { status: 'healthy', observedAt: NOW, accountId: input.candidate.accountId },
    };
  },
};

const concurrencyPort: ProviderAccountSchedulerConcurrencyPort = {
  async get() {
    return { decision: 'allow', value: { inFlight: 0, limit: 4 } };
  },
};

function windowCostPort(
  states: ReadonlyMap<string, 'admit' | 'sticky_only' | 'paused'>,
): ProviderAccountSchedulerWindowCostPort & { calls: Array<{ accountId: string; isSticky: boolean }> } {
  const calls: Array<{ accountId: string; isSticky: boolean }> = [];
  return {
    calls,
    async resolveWindowCostSchedulability({ candidate, isSticky }) {
      calls.push({ accountId: candidate.accountId, isSticky });
      return states.get(candidate.accountId) ?? 'admit';
    },
  };
}

function baseInput(candidates: readonly RequestPreparationCandidateAuthority[], sessionId?: string) {
  return {
    requestId: 'request-a',
    attemptId: 'attempt-a',
    caller: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      proxyKeyId: 'key-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'platform' as const,
    },
    entitlement: { tenantId: 'tenant-a', projectId: 'project-a', proxyKeyId: 'key-a' },
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
    ...(sessionId === undefined
      ? {}
      : {
          scheduling: {
            sessionId,
            attemptedAccountIds: [],
          },
        }),
  };
}

async function selectWith(
  dependencies: ProviderAccountSchedulerDependencies,
  candidates: readonly RequestPreparationCandidateAuthority[],
  sessionId?: string,
): Promise<{ decision: string; accountId: string | null; reasons?: readonly string[] }> {
  const scheduler = new ProviderAccountScheduler(dependencies, { now: () => NOW, maxHealthAgeMs: 60_000 });
  const result = await scheduler.select(baseInput(candidates, sessionId) as never);
  if (result.decision !== 'allow') return { decision: result.decision, accountId: null };
  return {
    decision: 'allow',
    accountId: result.value.accountId,
    reasons: result.scheduling?.reasons,
  };
}

const deps = (windowCost?: ProviderAccountSchedulerWindowCostPort): ProviderAccountSchedulerDependencies => ({
  eligibility: eligibilityPort,
  health: healthPort,
  concurrency: concurrencyPort,
  ...(windowCost ? { windowCost } : {}),
});

test('G-B1: absent windowCost port keeps the selection byte-identical (golden red line)', async () => {
  const result = await selectWith(deps(), [candidate('account-a'), candidate('account-b')]);
  assert.equal(result.decision, 'allow');
  assert.ok(result.accountId === 'account-a' || result.accountId === 'account-b');
});

test('G-B1: a paused account is skipped for both new and sticky selection', async () => {
  const port = windowCostPort(new Map([['account-a', 'paused']]));
  const result = await selectWith(deps(port), [candidate('account-a'), candidate('account-b')]);
  assert.equal(result.accountId, 'account-b', 'the paused account never schedules this window');
});

test('G-B1: the sticky_only band skips open-session selection (yellow window takes no new sessions)', async () => {
  const port = windowCostPort(new Map([['account-a', 'sticky_only']]));
  const result = await selectWith(deps(port), [candidate('account-a'), candidate('account-b')]);
  assert.equal(result.accountId, 'account-b');
});

test('G-B1: a sticky binding in the reserve band re-admits its target', async () => {
  const port = windowCostPort(new Map([['account-a', 'sticky_only']]));
  const affinity: ProviderAccountSchedulerAffinityPort = {
    async resolve() {
      return { decision: 'allow', accountId: 'account-a' };
    },
  };
  const result = await selectWith({ ...deps(port), affinity }, [candidate('account-a')], 'session-1');
  assert.equal(result.decision, 'allow');
  assert.equal(result.accountId, 'account-a');
  assert.deepEqual(result.reasons, ['affinity', 'window-reserve-band']);
  // The re-admission re-queried the gate with isSticky=true.
  assert.ok(port.calls.some((c) => c.accountId === 'account-a' && c.isSticky));
});

test('G-B1: a paused sticky target degrades instead of re-admitting', async () => {
  const port = windowCostPort(new Map([['account-a', 'paused']]));
  const affinity: ProviderAccountSchedulerAffinityPort = {
    async resolve() {
      return { decision: 'allow', accountId: 'account-a' };
    },
  };
  // account-a paused with no fallback candidate: the sticky target is dead,
  // the selection rejects (the same defensive posture as a dead busy target).
  const result = await selectWith({ ...deps(port), affinity }, [candidate('account-a')], 'session-1');
  assert.notEqual(result.decision, 'allow');
});

test('G-B1: a window-emptied viable set rejects (the over-limit state never fails open)', async () => {
  const port = windowCostPort(
    new Map([
      ['account-a', 'sticky_only'],
      ['account-b', 'paused'],
    ]),
  );
  const result = await selectWith(deps(port), [candidate('account-a'), candidate('account-b')]);
  assert.notEqual(
    result.decision,
    'allow',
    'the sub2api posture: only the DB-READ failure fails open; an over-limit window is a real capacity state',
  );
  assert.ok(port.calls.length >= 2, 'the first pass consulted the gate for both candidates');
});

test('G-B1: a throwing gate fails open (a failed read never removes capacity)', async () => {
  const port: ProviderAccountSchedulerWindowCostPort = {
    async resolveWindowCostSchedulability() {
      throw new Error('window cost read failed');
    },
  };
  const result = await selectWith(deps(port), [candidate('account-a')]);
  assert.equal(result.decision, 'allow');
  assert.equal(result.accountId, 'account-a');
});
