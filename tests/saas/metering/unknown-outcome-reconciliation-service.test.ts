import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttemptRecord, RequestRecord, UsageValues } from '../../../src/saas/metering/types.js';
import {
  type ConditionalSettlementInput,
  type ConditionalSettlementResult,
  type CustomerCharge,
  type ProviderAttemptIdentity,
  type ServerOwnedProviderAccountLookupResult,
  type UnknownOutcomeReconciliationResult,
  UnknownOutcomeReconciliationService,
  unknownOutcomeSettlementIdempotencyKey,
} from '../../../src/saas/metering/unknown-outcome-reconciliation-service.js';

function request(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: 'request-a',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    projectPolicyVersion: '1',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyProfileVersion: '1',
    modelScopeVersion: '1',
    supplyMode: 'platform',
    principalKind: 'member',
    principalId: 'member-a',
    authzVersion: '1',
    entitlementVersion: '1',
    configVersion: '1',
    customerMeteringPolicyId: 'customer-policy-a',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-a',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-a',
    routeConfigId: 'route-a',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-a',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'platform_pool',
    routeUpstreamId: 'upstream-a',
    publicModel: 'public-model',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    requestFingerprint: 'a'.repeat(64),
    requestFingerprintVersion: 'v1',
    idempotencyKeyDigest: null,
    customerPriceVersion: 'price-v1',
    financialStatus: 'reconciliation_pending',
    resultState: 'unknown',
    reconciliationState: 'pending',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    stateVersion: 3,
    ...overrides,
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-a',
    tenantId: 'tenant-a',
    requestId: 'request-a',
    projectPolicyVersion: '1',
    customerPriceVersion: 'price-v1',
    customerMeteringPolicyId: 'customer-policy-a',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-a',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-a',
    routeConfigId: 'route-a',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-a',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'platform_pool',
    ordinal: 1,
    upstreamId: 'upstream-a',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'platform',
    accountId: 'account-a',
    providerId: 'provider-a',
    productId: 'product-a',
    resolvedModel: 'actual-model-a',
    protocol: 'openai',
    endpoint: '/v1/chat/completions',
    supplierCostVersion: 'supplier-v1',
    dispatchProfileId: 'profile-a',
    supplyProfileAuthzVersion: '1',
    credentialId: 'credential-a',
    credentialVersion: '1',
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: 'pool-a',
    poolAuthzVersion: '1',
    poolMemberAccountAuthzVersion: '1',
    poolMemberAuthzVersion: '1',
    poolGrantAuthzVersion: '1',
    poolGrantProfileAuthzVersion: '1',
    poolGrantPoolAuthzVersion: '1',
    profileAccountAuthzVersion: null,
    preparedEvidenceId: 'evidence-a',
    dispatchState: 'unknown',
    resultState: 'unknown',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: 'connection lost after request write',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    stateVersion: 4,
    ...overrides,
  };
}

function usage(overrides: Partial<UsageValues> = {}): UsageValues {
  return {
    inputTotal: '12',
    inputUncached: '12',
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: '8',
    reasoningOutput: null,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'provider-usage-v1',
    measurementKind: 'snapshot',
    billableBasis: 'exact',
    ...overrides,
  };
}

function identity(currentAttempt: AttemptRecord, currentRequest: RequestRecord): ProviderAttemptIdentity {
  return {
    tenantId: currentRequest.tenantId,
    requestId: currentRequest.id,
    attemptId: currentAttempt.id,
    upstreamId: currentAttempt.upstreamId,
    accountOwnerKind: 'platform',
    accountId: currentAttempt.accountId ?? 'missing-account',
    providerId: currentAttempt.providerId ?? 'missing-provider',
    productId: currentAttempt.productId ?? 'missing-product',
    resolvedModel: currentAttempt.resolvedModel,
  };
}

function completed(
  currentAttempt: AttemptRecord,
  currentRequest: RequestRecord,
): ServerOwnedProviderAccountLookupResult {
  return {
    status: 'completed',
    providerOperationId: 'provider-operation-a',
    identity: identity(currentAttempt, currentRequest),
    usage: usage(),
  };
}

interface Harness {
  currentAttempt: AttemptRecord;
  currentRequest: RequestRecord;
  lookupInputs: Record<string, unknown>[];
  providerObservations: Record<string, unknown>[];
  settlementInputs: ConditionalSettlementInput[];
  rateCardInputs: CustomerCharge[];
  outcome: ServerOwnedProviderAccountLookupResult | 'throw';
  settlementOutcome: ConditionalSettlementResult | 'throw';
  service: UnknownOutcomeReconciliationService;
}

function harness(
  options: {
    currentAttempt?: AttemptRecord;
    currentRequest?: RequestRecord;
    outcome?: ServerOwnedProviderAccountLookupResult | 'throw';
    settlementOutcome?: ConditionalSettlementResult | 'throw';
    withObservations?: boolean;
    withRateCard?: boolean;
    withSettlement?: boolean;
  } = {},
): Harness {
  const currentAttempt = options.currentAttempt ?? attempt();
  const currentRequest = options.currentRequest ?? request();
  const lookupInputs: Record<string, unknown>[] = [];
  const providerObservations: Record<string, unknown>[] = [];
  const settlementInputs: ConditionalSettlementInput[] = [];
  const rateCardInputs: CustomerCharge[] = [];
  const outcome = options.outcome ?? completed(currentAttempt, currentRequest);
  const settlementOutcome = options.settlementOutcome ?? {
    status: 'settled',
    settlementId: 'settlement-a',
    idempotencyKey: unknownOutcomeSettlementIdempotencyKey(currentRequest.tenantId, currentRequest.id),
  };
  const service = new UnknownOutcomeReconciliationService({
    metering: {
      async getAttempt() {
        return currentAttempt;
      },
      async getRequest() {
        return currentRequest;
      },
      async listAttempts() {
        return [currentAttempt];
      },
    },
    provider: {
      async lookupUnknownAttempt(input) {
        lookupInputs.push(input);
        if (outcome === 'throw') throw new Error('provider unavailable');
        return outcome;
      },
    },
    ...(options.withObservations === false
      ? {}
      : {
          observations: {
            async recordProviderObservation(input) {
              providerObservations.push(input);
            },
          },
        }),
    ...(options.withRateCard === false
      ? {}
      : {
          rateCard: {
            async calculate(input) {
              rateCardInputs.push({
                amountMinorUnits: '42',
                currency: 'USD',
                rateCardId: input.request.customerPriceVersion ?? 'missing-price',
                rateCardVersion: 'calculator-v1',
              });
              return rateCardInputs[rateCardInputs.length - 1] as CustomerCharge;
            },
          },
        }),
    ...(options.withSettlement === false
      ? {}
      : {
          settlement: {
            async submit(input: ConditionalSettlementInput) {
              settlementInputs.push(input);
              if (settlementOutcome === 'throw') throw new Error('settlement unavailable');
              return settlementOutcome;
            },
          },
        }),
  });
  return {
    currentAttempt,
    currentRequest,
    lookupInputs,
    providerObservations,
    settlementInputs,
    rateCardInputs,
    outcome,
    settlementOutcome,
    service,
  };
}

function assertRetained(result: UnknownOutcomeReconciliationResult, reason: string): void {
  assert.equal(result.kind, 'retain_unknown');
  if (result.kind !== 'retain_unknown') throw new Error('expected retain_unknown');
  assert.equal(result.reason, reason);
  assert.equal(result.hold, 'retained');
}

test('skips non-unknown attempts without querying provider or touching settlement', async () => {
  const currentAttempt = attempt({ dispatchState: 'sent', resultState: 'pending' });
  const currentRequest = request({ resultState: 'pending', reconciliationState: 'none', financialStatus: 'pending' });
  const testHarness = harness({ currentAttempt, currentRequest });

  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assert.equal(result.kind, 'skipped');
  assert.equal(testHarness.lookupInputs.length, 0);
  assert.equal(testHarness.rateCardInputs.length, 0);
  assert.equal(testHarness.settlementInputs.length, 0);
});

test('retains unknown and hold for pending, ambiguous, provider-unavailable, and not-found', async () => {
  for (const status of ['pending', 'ambiguous', 'not_found'] as const) {
    const testHarness = harness({ outcome: { status } });
    const result = await testHarness.service.reconcile({
      tenantId: 'tenant-a',
      requestId: 'request-a',
      attemptId: 'attempt-a',
    });
    assertRetained(result, status === 'not_found' ? 'provider_not_found' : status);
    assert.equal(testHarness.settlementInputs.length, 0);
  }

  const unavailable = harness({ outcome: 'throw' });
  const unavailableResult = await unavailable.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });
  assertRetained(unavailableResult, 'provider_unavailable');
  assert.equal(
    unavailableResult.kind === 'retain_unknown' ? unavailableResult.providerStatus : undefined,
    'provider_unavailable',
  );
  assert.equal(unavailable.settlementInputs.length, 0);
});

test('does not treat provider not-found as proof that the request was not executed', async () => {
  const testHarness = harness({ outcome: { status: 'not_found', evidenceRef: 'query-a' } });
  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assertRetained(result, 'provider_not_found');
  assert.equal(testHarness.rateCardInputs.length, 0);
  assert.equal(testHarness.settlementInputs.length, 0);
  assert.equal(testHarness.providerObservations[0]?.status, 'not_found');
  assert.equal(testHarness.providerObservations[0]?.evidenceReference, 'query-a');
});

test('does not call Provider when durable evidence observation storage is unavailable', async () => {
  const testHarness = harness({ withObservations: false });
  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assertRetained(result, 'evidence_observation_unavailable');
  assert.equal(testHarness.lookupInputs.length, 0);
  assert.equal(testHarness.settlementInputs.length, 0);
});

test('retains a logical request when another possibly sent attempt is not covered', async () => {
  const currentAttempt = attempt();
  const otherAttempt = attempt({
    id: 'attempt-b',
    ordinal: 2,
    dispatchState: 'unknown',
    resultState: 'unknown',
    stateVersion: 2,
  });
  const currentRequest = request();
  const lookupInputs: unknown[] = [];
  let settlementCalls = 0;
  const service = new UnknownOutcomeReconciliationService({
    metering: {
      async getAttempt() {
        return currentAttempt;
      },
      async getRequest() {
        return currentRequest;
      },
      async listAttempts() {
        return [currentAttempt, otherAttempt];
      },
    },
    provider: {
      async lookupUnknownAttempt(input) {
        lookupInputs.push(input);
        return completed(currentAttempt, currentRequest);
      },
    },
    rateCard: {
      async calculate() {
        return { amountMinorUnits: '42', currency: 'USD', rateCardId: 'price-v1', rateCardVersion: 'v1' };
      },
    },
    settlement: {
      async submit() {
        settlementCalls += 1;
        return { status: 'conflict' };
      },
    },
  });

  const result = await service.reconcile({ tenantId: 'tenant-a', requestId: 'request-a', attemptId: 'attempt-a' });

  assertRetained(result, 'attempt_coverage_incomplete');
  assert.equal(lookupInputs.length, 0);
  assert.equal(settlementCalls, 0);
});

test('validates completed provider identity before usage pricing or settlement', async () => {
  const currentAttempt = attempt();
  const currentRequest = request();
  const completedOutcome = completed(currentAttempt, currentRequest);
  const mismatched = {
    ...completedOutcome,
    identity: { ...completedOutcome.identity, accountId: 'different-account' },
  } satisfies ServerOwnedProviderAccountLookupResult;
  const testHarness = harness({ outcome: mismatched });

  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assert.equal(result.kind, 'blocked');
  if (result.kind !== 'blocked') throw new Error('expected blocked');
  assert.equal(result.reason, 'provider_identity_mismatch');
  assert.equal(testHarness.rateCardInputs.length, 0);
  assert.equal(testHarness.settlementInputs.length, 0);
});

test('uses only trusted exact usage and server-owned rate-card charge, then submits expected state and idempotency key', async () => {
  const testHarness = harness();
  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assert.equal(result.kind, 'settled');
  if (result.kind !== 'settled') throw new Error('expected settled');
  assert.equal(result.charge.amountMinorUnits, '42');
  assert.equal(result.charge.currency, 'USD');
  assert.equal(result.usage.inputTotal, '12');
  assert.equal(testHarness.settlementInputs.length, 1);
  assert.equal(testHarness.providerObservations.length, 1);
  assert.equal(testHarness.providerObservations[0]?.status, 'completed');
  assert.equal(testHarness.providerObservations[0]?.providerOperationId, 'provider-operation-a');
  const settlementInput = testHarness.settlementInputs[0];
  if (!settlementInput) throw new Error('expected settlement input');
  assert.equal(settlementInput.idempotencyKey, unknownOutcomeSettlementIdempotencyKey('tenant-a', 'request-a'));
  assert.deepEqual(settlementInput.expectedState, {
    attempt: {
      dispatchState: 'unknown',
      resultState: 'unknown',
      responseStarted: false,
      stateVersion: 4,
    },
    request: {
      resultState: 'unknown',
      reconciliationState: 'pending',
      financialStatus: 'reconciliation_pending',
      stateVersion: 3,
    },
  });
  const lookupInput = testHarness.lookupInputs[0];
  assert.ok(lookupInput);
  assert.equal('endpoint' in lookupInput, false);
  assert.equal('credentialId' in lookupInput, false);
});

test('repeated reconciliation submits the same idempotency key and can replay safely', async () => {
  const currentAttempt = attempt();
  const currentRequest = request();
  const key = unknownOutcomeSettlementIdempotencyKey('tenant-a', 'request-a');
  let submitCount = 0;
  const submittedKeys: string[] = [];
  const testHarness = harness({ currentAttempt, currentRequest });
  const service = new UnknownOutcomeReconciliationService({
    metering: {
      async getAttempt() {
        return currentAttempt;
      },
      async getRequest() {
        return currentRequest;
      },
      async listAttempts() {
        return [currentAttempt];
      },
    },
    provider: {
      async lookupUnknownAttempt() {
        return completed(currentAttempt, currentRequest);
      },
    },
    observations: {
      async recordProviderObservation() {},
    },
    rateCard: {
      async calculate() {
        return { amountMinorUnits: '42', currency: 'USD', rateCardId: 'price-v1', rateCardVersion: 'v1' };
      },
    },
    settlement: {
      async submit(input) {
        submitCount += 1;
        submittedKeys.push(input.idempotencyKey);
        return submitCount === 1
          ? { status: 'settled', settlementId: 'settlement-a', idempotencyKey: key }
          : { status: 'replayed', settlementId: 'settlement-a', idempotencyKey: key };
      },
    },
  });

  const first = await service.reconcile({ tenantId: 'tenant-a', requestId: 'request-a', attemptId: 'attempt-a' });
  const second = await service.reconcile({ tenantId: 'tenant-a', requestId: 'request-a', attemptId: 'attempt-a' });
  assert.equal(first.kind, 'settled');
  assert.equal(second.kind, 'settled');
  if (second.kind !== 'settled') throw new Error('expected replayed settlement');
  assert.equal(second.status, 'replayed');
  assert.equal(submitCount, 2);
  assert.deepEqual(submittedKeys, [key, key]);
  assert.equal(testHarness.settlementInputs.length, 0);
});

test('retains unknown on settlement conflict and never accepts provider cost or releases a hold', async () => {
  const testHarness = harness({
    outcome: {
      ...completed(attempt(), request()),
      cost: 999999,
    } as ServerOwnedProviderAccountLookupResult,
    settlementOutcome: { status: 'conflict', idempotencyKey: 'different-key' },
  });

  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assert.equal(result.kind, 'blocked');
  if (result.kind !== 'blocked') throw new Error('expected blocked');
  assert.equal(result.reason, 'settlement_conflict');
  assert.equal(result.hold, 'retain_unknown');
  assert.equal(testHarness.settlementInputs.length, 1);
  assert.equal(testHarness.settlementInputs[0]?.charge.amountMinorUnits, '42');
});

test('blocks completed reconciliation when wiring or usage authority is missing', async () => {
  const noSettlement = harness({ withSettlement: false });
  const noSettlementResult = await noSettlement.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });
  assert.equal(noSettlementResult.kind, 'blocked');
  if (noSettlementResult.kind !== 'blocked') throw new Error('expected blocked');
  assert.equal(noSettlementResult.reason, 'settlement_unavailable');

  const noRateCard = harness({ withRateCard: false });
  const noRateCardResult = await noRateCard.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });
  assert.equal(noRateCardResult.kind, 'blocked');
  if (noRateCardResult.kind !== 'blocked') throw new Error('expected blocked');
  assert.equal(noRateCardResult.reason, 'rate_card_unavailable');

  const untrustedUsage = harness({
    outcome: { ...completed(attempt(), request()), usage: usage({ billableBasis: 'estimated' }) },
  });
  const untrustedResult = await untrustedUsage.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });
  assert.equal(untrustedResult.kind, 'blocked');
  if (untrustedResult.kind !== 'blocked') throw new Error('expected blocked');
  assert.equal(untrustedResult.reason, 'usage_not_authoritative');
});

test('does not reconcile BYOK attempts into hosted-token settlement', async () => {
  const testHarness = harness({
    currentAttempt: attempt({ accountOwnerKind: 'tenant', routeTargetMode: 'tenant_account' }),
    currentRequest: request({
      supplyMode: 'byok',
      routeTargetMode: 'tenant_account',
      financialStatus: 'not_applicable',
    }),
  });
  const result = await testHarness.service.reconcile({
    tenantId: 'tenant-a',
    requestId: 'request-a',
    attemptId: 'attempt-a',
  });

  assertRetained(result, 'byok_has_no_token_settlement');
  assert.equal(testHarness.lookupInputs.length, 0);
  assert.equal(testHarness.settlementInputs.length, 0);
});
