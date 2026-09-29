import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type AttemptBusinessKey,
  type AttemptFinalization,
  type AttemptObservationInput,
  type AttemptUsageEvidence,
  type AuthorizedUpstreamCandidate,
  authorizeModelCandidates,
  candidateMatchesScope,
  createAttemptObservation,
  createModelResolutionProvenance,
  createRequestFinancialBusinessKey,
  createRequestFinancialReconciliationPending,
  createRequestFinancialResolution,
  finalizeAttemptObservation,
  type GatewayEvidenceReference,
  type GatewayUsage,
  type RequestFinancialReconciliationPending,
  type RequestFinancialResolution,
  type RequestFinancialResolutionInput,
  requireNonEmptyCandidates,
  resolveModelMapping,
  type SaasProxyAuthorizationContext,
} from '../../../src/saas/gateway/contracts.js';

function authorization(overrides: Partial<SaasProxyAuthorizationContext> = {}): SaasProxyAuthorizationContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    principalId: 'principal-1',
    proxyKeyId: 'proxy-key-1',
    supplyProfileId: 'profile-byok-1',
    supplyMode: 'byok',
    authzVersion: 4,
    entitlementVersion: 7,
    configVersion: 12,
    ...overrides,
  };
}

function candidate(overrides: Partial<AuthorizedUpstreamCandidate> = {}): AuthorizedUpstreamCandidate {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    proxyKeyId: 'proxy-key-1',
    supplyProfileId: 'profile-byok-1',
    supplyMode: 'byok',
    upstreamId: 'upstream-1',
    accountOwnerKind: 'tenant',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 1,
    credentialAuthzVersion: 1,
    accountAuthzVersion: 1,
    dispatchProfileId: 'profile-byok-1',
    supplyProfileAuthzVersion: 1,
    profileAccountAuthzVersion: 1,
    resolvedModel: 'provider-model-1',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    supplierCostVersion: null,
    ...overrides,
  };
}

const usage = {
  inputTotal: 10,
  inputUncached: 10,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite5m: null,
  cacheWrite1h: null,
  outputTotal: 4,
  reasoningOutput: null,
  status: 'reported',
  source: 'upstream',
  semanticsVersion: 'v1',
} as const satisfies GatewayUsage;

const usageEvidence = {
  kind: 'normalized_usage',
  reference: 'usage-event-1',
  digest: 'sha256:usage-1',
  source: 'upstream',
  semanticsVersion: 'v1',
} as const satisfies AttemptUsageEvidence;

const evidenceReference = {
  reference: 'evidence-1',
  digest: 'sha256:evidence-1',
} as const satisfies GatewayEvidenceReference;

const attemptBusinessKey = {
  namespace: 'saas-proxy-attempt',
  requestId: 'request-1',
  attemptId: 'attempt-1',
} as const satisfies AttemptBusinessKey;

function attemptInput(
  overrides: Partial<Omit<AttemptObservationInput, 'supplyMode'>> & { readonly supplyMode?: 'byok' | 'platform' } = {},
): AttemptObservationInput {
  return {
    businessKey: attemptBusinessKey,
    supplyMode: 'byok',
    dispatchState: 'sent',
    resultState: 'succeeded',
    responseStarted: true,
    usage,
    usageEvidence,
    ...overrides,
  } as AttemptObservationInput;
}

function requestFinancialBusinessKey(
  overrides: Partial<{ requestId: string; reservationId: string; settlementId: string }> = {},
) {
  return createRequestFinancialBusinessKey({
    namespace: 'saas-request-financial-resolution',
    requestId: 'request-1',
    reservationId: 'reservation-1',
    settlementId: 'settlement-1',
    ...overrides,
  });
}

test('authorization context is server-owned and carries the fixed SaaS boundary', () => {
  const context = authorization();

  assert.deepEqual(context, {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    principalId: 'principal-1',
    proxyKeyId: 'proxy-key-1',
    supplyProfileId: 'profile-byok-1',
    supplyMode: 'byok',
    authzVersion: 4,
    entitlementVersion: 7,
    configVersion: 12,
  });
  assert.equal('key' in context, false);
  assert.equal('secret' in context, false);
});

test('empty candidate sets are an explicit deny, never unrestricted', () => {
  const result = authorizeModelCandidates(authorization(), 'public-model', 'openai', []);

  assert.equal(result.decision, 'deny');
  if (result.decision !== 'deny') throw new Error('expected deny');
  assert.equal(result.reason, 'no_authorized_candidates');
  assert.deepEqual(result.candidates, []);
  assert.throws(() => requireNonEmptyCandidates([]), /must not be empty/);
});

test('candidate scope fixes tenant, project, profile, mode, and key', () => {
  const context = authorization();
  const allowed = candidate();
  assert.equal(candidateMatchesScope(context, allowed), true);

  for (const mismatch of [
    { tenantId: 'tenant-2' },
    { projectId: 'project-2' },
    { proxyKeyId: 'proxy-key-2' },
    { supplyProfileId: 'profile-platform-1' },
    { supplyMode: 'platform' as const },
  ]) {
    const denied = authorizeModelCandidates(context, 'public-model', 'openai', [candidate(mismatch)]);
    assert.equal(denied.decision, 'deny');
    if (denied.decision !== 'deny') throw new Error('expected deny');
    assert.equal(denied.reason, 'candidate_scope_mismatch');
    assert.deepEqual(denied.candidates, []);
  }
});

test('model provenance preserves requested, mapped, and resolved identities with source/version', () => {
  const rules = [
    { pattern: 'public-*', mappedModel: 'wildcard-model', mappingSource: 'wildcard' as const, mappingVersion: 4 },
    { pattern: 'public-alias', mappedModel: 'catalog-model', mappingSource: 'alias' as const, mappingVersion: 7 },
  ];

  assert.deepEqual(resolveModelMapping('public-alias', rules), {
    mappedModel: 'catalog-model',
    mappingSource: 'alias',
    mappingVersion: 7,
  });
  assert.deepEqual(createModelResolutionProvenance('public-alias', 'provider-model', rules), {
    requestedModel: 'public-alias',
    mappedModel: 'catalog-model',
    resolvedModel: 'provider-model',
    mappingSource: 'alias',
    mappingVersion: 7,
  });
  assert.deepEqual(resolveModelMapping('other-model', rules), {
    mappedModel: 'other-model',
    mappingSource: 'none',
    mappingVersion: null,
  });
  assert.throws(
    () => createModelResolutionProvenance('public-alias', 'provider-model'),
    /non-identity model resolution requires mapping source and version/,
  );
  assert.throws(
    () =>
      resolveModelMapping('public-alias', [
        { pattern: 'public-alias', mappedModel: 'catalog-model', mappingSource: 'alias' } as never,
      ]),
    /mappingVersion is invalid/,
  );
});

test('an allowed model result carries a non-empty, secret-free candidate set', () => {
  const result = authorizeModelCandidates(authorization(), 'public-model', 'openai', [candidate()]);

  assert.equal(result.decision, 'allow');
  if (result.decision !== 'allow') throw new Error('expected allow');
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(
    {
      upstreamId: result.candidates[0]?.upstreamId,
      accountId: result.candidates[0]?.accountId,
      poolId: result.candidates[0]?.poolId,
      credentialId: result.candidates[0]?.credentialId,
    },
    {
      upstreamId: 'upstream-1',
      accountId: 'account-1',
      poolId: undefined,
      credentialId: 'credential-1',
    },
  );
  const firstCandidate = result.candidates[0];
  assert.ok(firstCandidate);
  assert.equal('secret' in firstCandidate, false);
});

test('attempt observation represents each dispatch state and each result state separately', () => {
  const dispatchCases = [
    ['not_sent', 'pending', false],
    ['dispatching', 'pending', false],
    ['sent', 'pending', false],
    ['unknown', 'unknown', false],
  ] as const;

  for (const [dispatchState, resultState, responseStarted] of dispatchCases) {
    const observation = createAttemptObservation(
      attemptInput({
        dispatchState,
        resultState,
        responseStarted,
        usage: null,
        usageEvidence: null,
      }),
    );
    assert.equal(observation.dispatchState, dispatchState);
    assert.equal(observation.resultState, resultState);
    assert.equal(observation.responseStarted, responseStarted);
  }

  for (const resultState of ['pending', 'succeeded', 'failed', 'cancelled', 'unknown'] as const) {
    const observation = createAttemptObservation(
      attemptInput({ dispatchState: 'sent', resultState, responseStarted: true }),
    );
    assert.equal(observation.resultState, resultState);
  }
});

test('attempt observation validates impossible combinations and requires usage evidence', () => {
  assert.throws(
    () => createAttemptObservation(attemptInput({ dispatchState: 'not_sent', responseStarted: true })),
    /responseStarted requires dispatchState sent/,
  );
  assert.throws(
    () => createAttemptObservation(attemptInput({ dispatchState: 'dispatching', responseStarted: true })),
    /responseStarted requires dispatchState sent/,
  );
  assert.throws(
    () =>
      createAttemptObservation(
        attemptInput({
          dispatchState: 'not_sent',
          resultState: 'succeeded',
          responseStarted: false,
          usage: null,
          usageEvidence: null,
        }),
      ),
    /succeeded attempt requires/,
  );
  assert.throws(
    () =>
      createAttemptObservation(
        attemptInput({
          dispatchState: 'unknown',
          resultState: 'failed',
          responseStarted: false,
          usage: null,
          usageEvidence: null,
        }),
      ),
    /cannot claim a definitive attempt result/,
  );
  assert.throws(
    () => createAttemptObservation(attemptInput({ responseStarted: false, usage: null, usageEvidence })),
    /provided together/,
  );
  assert.throws(
    () => createAttemptObservation(attemptInput({ responseStarted: false, usage, usageEvidence })),
    /requires responseStarted/,
  );
  assert.throws(
    () => createAttemptObservation(attemptInput({ usageEvidence: { ...usageEvidence, source: 'legacy' } })),
    /must match normalized usage/,
  );
});

test('attempt finalization is keyed, monotonic, and makes no wallet decision', () => {
  const pending = createAttemptObservation(
    attemptInput({ resultState: 'pending', responseStarted: false, usage: null, usageEvidence: null }),
  );
  const finalized = finalizeAttemptObservation(pending, attemptInput({ resultState: 'succeeded' }));
  assert.equal(finalized.kind, 'finalize_attempt');
  assert.deepEqual(finalized.businessKey, attemptBusinessKey);
  assert.equal(finalized.observation.responseStarted, true);
  assert.equal(finalized.supplyMode, 'byok');
  assert.equal(finalized.wallet, 'not_applicable');
  assert.equal('charge' in finalized, false);
  assert.equal('settlement' in finalized, false);

  const platform = finalizeAttemptObservation(null, attemptInput({ supplyMode: 'platform' }));
  assert.equal(platform.supplyMode, 'platform');
  assert.equal('wallet' in platform, false);
  assert.equal('charge' in platform, false);
  assert.equal('supplierCostAsCustomerCharge' in platform, false);

  assert.throws(
    () =>
      finalizeAttemptObservation(
        createAttemptObservation(attemptInput()),
        attemptInput({ responseStarted: false, resultState: 'failed', usage: null, usageEvidence: null }),
      ),
    /responseStarted is monotonic/,
  );
  assert.throws(
    () =>
      finalizeAttemptObservation(
        pending,
        attemptInput({ businessKey: { ...attemptBusinessKey, attemptId: 'attempt-2' } }),
      ),
    /same business identity/,
  );
  assert.throws(
    () => finalizeAttemptObservation(pending, attemptInput({ supplyMode: 'platform' })),
    /same supply mode/,
  );
});

test('new contracts reject the old combined dispatch outcome shape', () => {
  const ambiguousLegacyResult = {
    state: 'sent',
    outcome: 'completed',
    httpStatus: 200,
    usage,
  } as const;
  // @ts-expect-error Legacy state/outcome conflates dispatch and result state.
  const rejectedLegacyInput: AttemptObservationInput = ambiguousLegacyResult;
  assert.ok(rejectedLegacyInput);

  assert.throws(
    () => createAttemptObservation(ambiguousLegacyResult as unknown as AttemptObservationInput),
    /Invalid attempt dispatch state/,
  );
});

test('attempt observation factories drop unrecognized credentials and key-like fields', () => {
  const untrustedInput = {
    ...attemptInput({ usage: null, usageEvidence: null, resultState: 'pending', responseStarted: false }),
    rawKey: 'never-return-this',
    credential: 'never-return-this-either',
  } as unknown as AttemptObservationInput;
  const observation = createAttemptObservation(untrustedInput);
  assert.equal('rawKey' in observation, false);
  assert.equal('credential' in observation, false);
  assert.equal('idempotencyKey' in observation.businessKey, false);
});

test('request-level settle carries exact amount, price snapshot, and billable usage evidence', () => {
  const settled = createRequestFinancialResolution({
    kind: 'settle',
    businessKey: requestFinancialBusinessKey(),
    supplyMode: 'platform',
    amount: { currency: 'USD', minorUnits: 0n },
    priceSnapshotRef: 'price-snapshot-4',
    billableUsage: {
      digest: 'sha256:billable-usage-1',
      evidence: [evidenceReference],
    },
  });
  assert.equal(settled.kind, 'settle');
  if (settled.kind !== 'settle') throw new Error('expected settle');
  assert.deepEqual(settled.amount, { currency: 'USD', minorUnits: 0n });
  assert.equal(settled.priceSnapshotRef, 'price-snapshot-4');
  assert.equal(settled.billableUsage.digest, 'sha256:billable-usage-1');
  assert.equal(settled.billableUsage.evidence.length, 1);
  assert.equal('customerCharge' in settled, false);
  assert.equal('supplierCostAsCustomerCharge' in settled, false);
});

test('request-level settle rejects null or inexact amounts and missing usage evidence', () => {
  const shared = {
    kind: 'settle',
    businessKey: requestFinancialBusinessKey(),
    supplyMode: 'platform',
    priceSnapshotRef: 'price-snapshot-4',
  } as const;

  assert.throws(
    () =>
      createRequestFinancialResolution({
        ...shared,
        amount: null,
        billableUsage: { digest: 'digest', evidence: [evidenceReference] },
      } as unknown as RequestFinancialResolutionInput),
    /Settlement amount must be an object/,
  );
  assert.throws(
    () =>
      createRequestFinancialResolution({
        ...shared,
        amount: { currency: 'USD', minorUnits: 1.5 },
        billableUsage: { digest: 'digest', evidence: [evidenceReference] },
      } as unknown as RequestFinancialResolutionInput),
    /exact, non-negative integer minor units/,
  );
  assert.throws(
    () =>
      createRequestFinancialResolution({
        ...shared,
        amount: { currency: 'USD', minorUnits: 1n },
        billableUsage: { digest: 'digest', evidence: [] },
      } as unknown as RequestFinancialResolutionInput),
    /must not be empty/,
  );

  // @ts-expect-error Settlement amounts are exact and non-null.
  const ambiguousNullAmount: RequestFinancialResolutionInput = {
    ...shared,
    amount: null,
    billableUsage: { digest: 'digest', evidence: [evidenceReference] },
  };
  assert.ok(ambiguousNullAmount);
});

test('request-level release requires explicit confirmed non-execution basis, reason, and matching evidence', () => {
  const released = createRequestFinancialResolution({
    kind: 'release',
    businessKey: requestFinancialBusinessKey(),
    supplyMode: 'platform',
    basis: 'all_attempts_not_sent',
    reason: 'All candidate sends were stopped before dispatch.',
    evidence: [{ ...evidenceReference, basis: 'all_attempts_not_sent' }],
  });
  assert.equal(released.kind, 'release');
  if (released.kind !== 'release') throw new Error('expected release');
  assert.equal(released.basis, 'all_attempts_not_sent');
  assert.equal(released.evidence[0]?.basis, 'all_attempts_not_sent');

  assert.throws(
    () =>
      createRequestFinancialResolution({
        kind: 'release',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'platform',
        basis: null,
        reason: 'No confirmed non-execution basis.',
        evidence: [{ ...evidenceReference, basis: 'all_attempts_not_sent' }],
      } as unknown as RequestFinancialResolutionInput),
    /explicit confirmed non-execution basis/,
  );
  assert.throws(
    () =>
      createRequestFinancialResolution({
        kind: 'release',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'platform',
        basis: 'all_attempts_not_sent',
        reason: 'Evidence was not recorded.',
        evidence: [],
      } as unknown as RequestFinancialResolutionInput),
    /Release evidence must not be empty/,
  );
  assert.throws(
    () =>
      createRequestFinancialResolution({
        kind: 'release',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'platform',
        basis: 'all_attempts_not_sent',
        reason: 'Evidence does not support release.',
        evidence: [{ ...evidenceReference, basis: 'provider_confirmed_not_executed' }],
      }),
    /basis must match/,
  );
});

test('retain-hold requires an uncertainty or overrun reason and a review time', () => {
  const held = createRequestFinancialResolution({
    kind: 'retain_hold',
    businessKey: requestFinancialBusinessKey(),
    supplyMode: 'platform',
    reason: 'usage_overrun',
    evidence: [evidenceReference],
    nextReviewAt: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(held.kind, 'retain_hold');
  if (held.kind !== 'retain_hold') throw new Error('expected retain_hold');
  assert.equal(held.reason, 'usage_overrun');
  assert.equal(held.nextReviewAt, '2030-01-01T00:00:00.000Z');

  assert.throws(
    () =>
      createRequestFinancialResolution({
        kind: 'retain_hold',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'platform',
        reason: 'some arbitrary status',
        evidence: [evidenceReference],
        nextReviewAt: '2030-01-01T00:00:00.000Z',
      } as unknown as RequestFinancialResolutionInput),
    /uncertainty or overrun reason/,
  );
  assert.throws(
    () =>
      createRequestFinancialResolution({
        kind: 'retain_hold',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'platform',
        reason: 'dispatch_uncertain',
        evidence: [evidenceReference],
        nextReviewAt: 'tomorrow',
      }),
    /UTC ISO timestamp/,
  );
});

test('reconciliation-pending is explicitly intermediate and outside the resolution union', () => {
  const pending: RequestFinancialReconciliationPending = createRequestFinancialReconciliationPending({
    kind: 'reconciliation_pending',
    businessKey: requestFinancialBusinessKey(),
    supplyMode: 'platform',
    reason: 'dispatch_uncertain',
    nextReviewAt: '2030-01-01T00:00:00.000Z',
  });
  assert.equal(pending.terminal, false);
  assert.equal(pending.kind, 'reconciliation_pending');

  // @ts-expect-error Pending reconciliation is not a financial resolution.
  const rejectedAsResolution: RequestFinancialResolution = pending;
  // @ts-expect-error A reconciliation status cannot be constructed as a resolution variant.
  const rejectedPendingInput: RequestFinancialResolutionInput = pending;
  assert.ok(rejectedAsResolution);
  assert.ok(rejectedPendingInput);

  assert.throws(
    () =>
      createRequestFinancialReconciliationPending({
        kind: 'reconciliation_pending',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'platform',
        reason: 'dispatch_uncertain',
        nextReviewAt: 'not-a-time',
      }),
    /UTC ISO timestamp/,
  );
});

test('request financial resolution keys require request, reservation, and settlement identities', () => {
  assert.throws(
    () =>
      createRequestFinancialBusinessKey({
        namespace: 'saas-request-financial-resolution',
        requestId: 'request-1',
        reservationId: '',
        settlementId: 'settlement-1',
      }),
    /reservationId must be a non-empty string/,
  );
  assert.throws(
    () =>
      createRequestFinancialResolution({
        kind: 'settle',
        businessKey: requestFinancialBusinessKey(),
        supplyMode: 'byok',
        amount: { currency: 'USD', minorUnits: 1n },
        priceSnapshotRef: 'price-snapshot-4',
        billableUsage: { digest: 'digest', evidence: [evidenceReference] },
      } as unknown as RequestFinancialResolutionInput),
    /only applicable to platform supply/,
  );
});

test('attempt finalization types have no customer charge field', () => {
  const finalization = finalizeAttemptObservation(null, attemptInput()) satisfies AttemptFinalization;
  assert.equal(finalization.kind, 'finalize_attempt');

  // @ts-expect-error Financial amount belongs to request-level resolution only.
  const chargedAttempt: AttemptFinalization = { ...finalization, amount: { currency: 'USD', minorUnits: 1n } };
  assert.ok(chargedAttempt);
});
