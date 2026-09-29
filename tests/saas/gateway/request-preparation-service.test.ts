import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { SqlExecutor } from '../../../src/saas/db/index.js';
import type {
  AuthorizedPlatformUpstreamCandidate,
  ModelResolutionProvenance,
} from '../../../src/saas/gateway/contracts.js';
import type {
  PreparedRequestEvidenceInput,
  PreparedRequestEvidenceRecord,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  ProviderAccountScheduler,
  type ProviderAccountSchedulerAffinityPort,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationAdmission,
  type RequestPreparationAttemptPersistenceInput,
  type RequestPreparationAttemptRecord,
  type RequestPreparationAuthority,
  type RequestPreparationCaller,
  type RequestPreparationCompensationInput,
  type RequestPreparationCompensationResult,
  type RequestPreparationDependencies,
  type RequestPreparationEntitlement,
  type RequestPreparationInput,
  type RequestPreparationPayloadCompiler,
  type RequestPreparationResult,
  rejectRequestPreparation,
  SaasRequestPreparationService,
} from '../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';

const NOW = '2026-09-28T00:00:00.000Z';
const DISPATCH_DEADLINE = '2026-09-28T00:00:30.000Z';
const EXPIRES_AT = '2026-09-28T00:01:00.000Z';
const TEST_HMAC_DIGEST = 'd'.repeat(64);
const MODEL_RESOLUTION: ModelResolutionProvenance = {
  requestedModel: 'model-a',
  mappedModel: 'catalog-model-a',
  resolvedModel: 'provider-model-a',
  mappingSource: 'alias',
  mappingVersion: 2,
};

function authenticatedCaller(status: 'active' | 'revoked' = 'active'): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'key-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principalUserId: 'user-a',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-a',
      createdByUserId: 'user-a',
      rotatedByUserId: null,
      revokedByUserId: status === 'active' ? null : 'admin-a',
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'platform',
      name: 'test-key',
      prefix: 'mr_live_test',
      modelScopes: ['model-a'],
      status,
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
      revokedAt: status === 'active' ? null : NOW,
      lastUsedAt: null,
      authzVersion: 11,
      modelScopeVersion: 7,
      entitlementAuthzVersion: 5,
      supplyProfileAuthzVersion: 6,
    },
    authorization: {
      keyId: 'key-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principalKind: 'member',
      principalId: 'user-a',
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'platform',
      modelScopes: ['model-a'],
      authzVersion: 11,
      modelScopeVersion: 7,
      entitlementAuthzVersion: 5,
      supplyProfileAuthzVersion: 6,
    },
  };
}

function input(overrides: Partial<RequestPreparationInput> = {}): RequestPreparationInput {
  return {
    authenticatedCaller: authenticatedCaller(),
    publicModel: 'model-a',
    protocol: 'openai',
    clientRequest: { model: 'model-a', messages: [{ role: 'user', content: 'hello' }] },
    audit: { entryPoint: 'test', sourceIp: '127.0.0.1', userAgent: 'test-agent' },
    ...overrides,
  };
}

function caller(): RequestPreparationCaller {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    principalKind: 'member',
    principalId: 'user-a',
    entitlementId: 'entitlement-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    modelScopes: ['model-a'],
    authzVersion: 11,
    entitlementVersion: 5,
    supplyProfileVersion: 6,
    modelScopeVersion: 7,
  };
}

function entitlement(): RequestPreparationEntitlement {
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
    allowedModels: ['model-a'],
    allowedProviderIds: [],
    projectPolicyVersion: 9,
  };
}

function candidate(): AuthorizedPlatformUpstreamCandidate & { providerId: string; productId: string } {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    supplyProfileId: 'profile-a',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    upstreamId: 'upstream-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: 3,
    credentialAuthzVersion: 4,
    accountAuthzVersion: 5,
    dispatchProfileId: 'dispatch-a',
    supplyProfileAuthzVersion: 6,
    resolvedModel: 'provider-model-a',
    protocol: 'openai',
    endpoint: 'https://server-owned.example/v1',
    supplierCostVersion: 'supplier-cost-1',
    poolId: 'pool-a',
    poolAuthzVersion: 2,
    poolMemberAccountAuthzVersion: 3,
    poolMemberAuthzVersion: 7,
    poolGrantAuthzVersion: 4,
    poolGrantProfileAuthzVersion: 5,
    poolGrantPoolAuthzVersion: 6,
    providerId: 'provider-a',
    productId: 'product-a',
  };
}

function authority(): RequestPreparationAuthority {
  return {
    route: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      publicModel: 'model-a',
      publicModelId: 'public-model-a',
      publicModelVersion: 1,
      routeConfigId: 'route-a',
      routeConfigVersion: 4,
      protocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      targetMode: 'platform_pool',
      upstreamId: 'upstream-a',
      endpoint: 'https://server-owned.example/v1',
    },
    candidate: candidate(),
    modelMappingRules: [
      {
        pattern: 'model-a',
        mappedModel: 'catalog-model-a',
        mappingSource: 'alias',
        mappingVersion: 2,
      },
    ],
    poolMemberAuthzVersion: 7,
    credentialRef: 'credential-a',
    configVersion: 4,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-a',
      customerMeteringPolicyVersion: 2,
      providerMeteringPolicyId: 'provider-policy-a',
      providerMeteringPolicyVersion: 3,
      contractAttestationId: 'attestation-a',
      customerPriceVersion: 'customer-price-1',
      supplierCostVersion: 'supplier-cost-1',
    },
  };
}

function alternateCandidate(): ReturnType<typeof candidate> {
  return {
    ...candidate(),
    accountId: 'account-b',
    credentialId: 'credential-b',
    poolMemberAuthzVersion: 8,
  };
}

function realScheduler(affinity?: ProviderAccountSchedulerAffinityPort): ProviderAccountScheduler {
  return new ProviderAccountScheduler(
    {
      eligibility: {
        async revalidate(inputValue) {
          return {
            decision: 'allow',
            candidate: inputValue.candidate,
            route: {
              tenantId: inputValue.caller.tenantId,
              projectId: inputValue.caller.projectId,
              routeConfigId: String(inputValue.route?.routeConfigId ?? 'route-a'),
              routeConfigVersion: String(inputValue.route?.routeConfigVersion ?? 4),
              publicModelId: String(inputValue.route?.publicModelId ?? 'public-model-a'),
              publicModelVersion: String(inputValue.route?.publicModelVersion ?? 1),
              publicModel: inputValue.publicModel,
              protocol: inputValue.protocol,
              supplyMode: inputValue.caller.supplyMode,
              targetMode: inputValue.caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool',
              upstreamId: inputValue.candidate.upstreamId,
              providerId: inputValue.candidate.providerId,
              productId: inputValue.candidate.productId,
            },
            status: 'active',
            capability: { protocol: 'openai', supportLevel: 'supported', validationState: 'verified' },
            rights: {
              providerId: 'provider-a',
              productId: 'product-a',
              model: 'provider-model-a',
              endpoint: 'https://server-owned.example/v1',
              supplyMode: 'platform',
              status: 'active',
              version: 1,
              effectiveAt: NOW,
              expiresAt: null,
            },
            priority: 1,
            weight: 1,
          };
        },
      },
      health: {
        async get() {
          return { decision: 'allow', value: { status: 'healthy', observedAt: NOW } };
        },
      },
      concurrency: {
        async get() {
          return { decision: 'allow', value: { inFlight: 0, limit: 2 } };
        },
      },
      ...(affinity ? { affinity } : {}),
    },
    { now: () => new Date(NOW) },
  );
}

function payloadCompiler(
  serializedPayload = '{"model":"provider-model-a","messages":[]}',
  observedInputs?: unknown[],
): RequestPreparationPayloadCompiler {
  return {
    async compile(inputValue) {
      observedInputs?.push(inputValue);
      assert.equal(inputValue.clientProtocol, 'openai');
      assert.equal(inputValue.providerProtocol, 'openai');
      assert.equal(inputValue.clientOperation, 'chat.completions');
      assert.equal(inputValue.providerOperation, 'chat.completions');
      assert.deepEqual(inputValue.modelResolution, MODEL_RESOLUTION);
      return allowRequestPreparation({
        payloadBytes: new TextEncoder().encode(serializedPayload),
        requestFingerprint: 'request-fingerprint-material',
        requestFingerprintVersion: 'canonical-v1',
        compilerVersion: 'compiler-v1',
        estimatorVersion: 'estimator-v1',
        usage: {
          inputTotalUpperBound: 12,
          inputUncachedUpperBound: 12,
          cacheReadUpperBound: 0,
          cacheWriteUpperBound: 0,
          cacheWrite5mUpperBound: 0,
          cacheWrite1hUpperBound: 0,
          outputTotalUpperBound: 4,
          reasoningOutputUpperBound: 0,
          feasibleInputBuckets: ['input'],
        },
        requestedModel: 'model-a',
        mappedModel: 'catalog-model-a',
        resolvedModel: 'provider-model-a',
        modelResolution: MODEL_RESOLUTION,
        providerProtocol: 'openai',
        providerOperation: 'chat.completions',
      });
    },
  };
}

function admission(
  inputValue: Parameters<RequestPreparationDependencies['admission']['authorizeAndReserve']>[0],
): RequestPreparationAdmission {
  return {
    idempotencyBinding: {
      state: 'created',
      keyDigest: TEST_HMAC_DIGEST,
      requestFingerprint: inputValue.requestFingerprint,
      requestFingerprintVersion: inputValue.requestFingerprintVersion,
      tenantId: inputValue.tenantId,
      projectId: inputValue.projectId,
      proxyKeyId: inputValue.proxyKeyId,
      requestId: inputValue.requestId,
    },
    quotaReservation: { reference: 'quota-reservation-a', state: 'reserved' },
    rateReservation: { reference: 'rate-reservation-a', state: 'reserved' },
    holdReservation: {
      reference: 'hold-reference-a',
      state: 'reserved',
      reservationId: 'reservation-a',
      tenantId: 'tenant-a',
      requestId: inputValue.requestId,
      currency: 'USD',
      amountMinorUnits: 42,
      priceSnapshotRef: 'price-snapshot-a',
      expiresAt: EXPIRES_AT,
    },
    deadlineAtMs: Date.parse(DISPATCH_DEADLINE),
    dispatchDeadline: DISPATCH_DEADLINE,
    expiresAt: EXPIRES_AT,
    remainingAttempts: 2,
    retryBudget: 1,
    attemptOrdinal: 1,
    usageBudget: { unit: 'tokens', amount: 16, basis: 'reserved' },
  };
}

function attemptRecord(value: RequestPreparationAttemptPersistenceInput): RequestPreparationAttemptRecord {
  return {
    tenantId: value.caller.tenantId,
    projectId: value.caller.projectId,
    proxyKeyId: value.caller.proxyKeyId,
    requestId: value.requestId,
    attemptId: value.attemptId,
    attemptOrdinal: value.admission.attemptOrdinal,
    publicModel: value.publicModel,
    protocol: value.protocol,
    endpoint: value.authority.route.endpoint,
    routeConfigId: value.authority.route.routeConfigId,
    routeConfigVersion: value.authority.route.routeConfigVersion,
    supplyMode: value.authority.candidate.supplyMode,
    upstreamId: value.authority.candidate.upstreamId,
    accountId: value.authority.candidate.accountId,
    credentialId: value.authority.candidate.credentialId,
    resolvedModel: value.authority.candidate.resolvedModel,
    modelResolution: value.modelResolution,
    clientProtocol: value.authority.route.protocol,
    providerProtocol: value.authority.route.providerProtocol ?? value.authority.candidate.protocol,
    clientOperation: value.authority.route.clientOperation ?? 'chat.completions',
    providerOperation: value.authority.route.providerOperation ?? 'chat.completions',
    requestFingerprint: value.requestFingerprint,
    requestFingerprintVersion: value.requestFingerprintVersion,
    payloadSha256: value.payloadSha256,
    payloadCompilerVersion: value.payloadCompilerVersion,
    usageEstimatorVersion: value.usageEstimatorVersion,
    dispatchAuthorityState: 'bound',
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    preparedEvidenceId: null,
  };
}

function evidenceRecord(value: PreparedRequestEvidenceInput): PreparedRequestEvidenceRecord {
  return {
    evidenceId: value.evidenceId ?? 'missing-evidence-id',
    tenantId: value.tenantId,
    projectId: value.projectId,
    requestId: value.requestId,
    attemptId: value.attemptId,
    attemptOrdinal: value.attemptOrdinal,
    supplyMode: value.supplyMode,
    publicModel: value.publicModel,
    protocol: value.protocol,
    modelResolution: value.modelResolution,
    clientProtocol: value.clientProtocol,
    providerProtocol: value.providerProtocol,
    clientOperation: value.clientOperation,
    providerOperation: value.providerOperation,
    endpoint: value.endpoint,
    upstreamId: value.upstreamId,
    accountId: value.accountId,
    credentialId: value.credentialId,
    credentialVersion: String(value.credentialVersion),
    routeTargetMode: value.routeTargetMode,
    requestFingerprint: value.requestFingerprint,
    requestFingerprintVersion: value.requestFingerprintVersion,
    payloadCompilerVersion: value.payloadCompilerVersion,
    usageEstimatorVersion: value.usageEstimatorVersion,
    payloadSha256: value.payloadSha256,
    statementSha256: 'a'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: new Date(value.expiresAt).toISOString(),
  };
}

interface FakeState {
  readonly calls: string[];
  readonly compensated: RequestPreparationCompensationInput[];
  readonly signed: PreparedRequestEvidenceInput[];
  readonly registered: PreparedRequestEvidenceInput[];
  readonly executors?: unknown[];
  readonly transactionEvents?: string[];
  readonly admissionInputs?: unknown[];
  readonly preAdmissionContextInputs?: unknown[];
}

function releasedCompensation(inputValue: RequestPreparationCompensationInput): RequestPreparationCompensationResult {
  return {
    requestId: inputValue.requestId,
    attemptId: inputValue.attemptId,
    disposition: 'released',
    quotaReservation: 'released',
    rateReservation: 'released',
    holdReservation: 'released',
    manualReconciliationRequired: false,
  };
}

function dependencies(state: FakeState): RequestPreparationDependencies {
  return {
    caller: {
      async validate(inputValue) {
        state.calls.push('caller');
        state.preAdmissionContextInputs?.push(inputValue);
        return allowRequestPreparation(caller());
      },
    },
    entitlement: {
      async resolve(inputValue) {
        state.calls.push('entitlement');
        state.preAdmissionContextInputs?.push(inputValue);
        return allowRequestPreparation(entitlement());
      },
    },
    authority: {
      async resolve(inputValue) {
        state.calls.push('authority');
        state.preAdmissionContextInputs?.push(inputValue);
        return allowRequestPreparation(authority());
      },
    },
    payload: payloadCompiler(undefined, state.preAdmissionContextInputs),
    transaction: {
      async transaction(work) {
        const executor: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
        state.transactionEvents?.push('begin');
        try {
          const result = await work(executor);
          state.transactionEvents?.push('commit');
          return result;
        } catch (error) {
          state.transactionEvents?.push('rollback');
          throw error;
        }
      },
    },
    admission: {
      async authorizeAndReserve(inputValue, options) {
        state.calls.push('admission');
        state.admissionInputs?.push(inputValue);
        state.executors?.push(options?.executor);
        return allowRequestPreparation(admission(inputValue));
      },
    },
    attempt: {
      async persist(inputValue, options) {
        state.calls.push('attempt');
        state.executors?.push(options?.executor);
        return allowRequestPreparation(attemptRecord(inputValue));
      },
    },
    compensation: {
      async releasePreDispatch(inputValue, options) {
        state.calls.push('compensation');
        state.compensated.push(inputValue);
        state.executors?.push(options?.executor);
        return allowRequestPreparation(releasedCompensation(inputValue));
      },
    },
    signer: {
      async sign(inputValue) {
        state.calls.push('signer');
        state.signed.push(inputValue.evidence);
        return allowRequestPreparation({ signatureBase64: 'c2lnbmF0dXJl' });
      },
    },
    registrar: {
      async register(inputValue, options) {
        state.calls.push('registrar');
        state.executors?.push(options?.executor);
        state.registered.push(inputValue);
        return allowRequestPreparation(evidenceRecord(inputValue));
      },
    },
  };
}

function service(
  state: FakeState,
  overrides: Partial<RequestPreparationDependencies> = {},
  options: ConstructorParameters<typeof SaasRequestPreparationService>[1] = {},
): SaasRequestPreparationService {
  const base = dependencies(state);
  return new SaasRequestPreparationService(
    { ...base, ...overrides },
    {
      evidenceVerifierKeyId: 'verifier-key-a',
      now: () => new Date(NOW),
      idFactory: {
        requestId: () => 'request-a',
        attemptId: () => 'attempt-a',
        evidenceId: () => 'evidence-a',
      },
      ...options,
    },
  );
}

function assertFailure(
  result: RequestPreparationResult,
  expected: { outcome: 'rejected' | 'blocked'; stage: string; code: string },
): asserts result is Extract<RequestPreparationResult, { outcome: 'rejected' | 'blocked' }> {
  assert.equal(result.outcome, expected.outcome);
  assert.equal(result.stage, expected.stage);
  assert.equal(result.code, expected.code);
  assert.equal(result.evidence, null);
}

test('prepares a server-owned payload and binds its exact digest to attempt and evidence', async () => {
  const state: FakeState = {
    calls: [],
    compensated: [],
    signed: [],
    registered: [],
    executors: [],
    admissionInputs: [],
    preAdmissionContextInputs: [],
  };
  const result = await service(state).prepare(input({ idempotencyKey: 'client-key-opaque-7' }));

  assert.equal(result.outcome, 'prepared');
  if (result.outcome !== 'prepared') return;
  const expectedDigest = createHash('sha256').update(result.payloadBytes).digest('hex');
  assert.equal(result.payloadSha256, expectedDigest);
  assert.notEqual(result.requestFingerprint, result.payloadSha256);
  assert.equal(result.requestFingerprintVersion, 'canonical-v1');
  const admissionInput = state.admissionInputs?.[0] as Record<string, unknown> | undefined;
  assert.equal(admissionInput?.idempotencyKey, 'client-key-opaque-7');
  assert.equal(admissionInput?.tenantId, 'tenant-a');
  assert.equal(admissionInput?.projectId, 'project-a');
  assert.equal(admissionInput?.proxyKeyId, 'key-a');
  assert.equal(admissionInput?.requestFingerprint, result.requestFingerprint);
  assert.equal(admissionInput?.requestFingerprintVersion, result.requestFingerprintVersion);
  const binding = result.admission.idempotencyBinding as Record<string, unknown> | undefined;
  assert.equal(binding?.keyDigest, TEST_HMAC_DIGEST);
  assert.notEqual(binding?.keyDigest, createHash('sha256').update('client-key-opaque-7').digest('hex'));
  assert.equal(binding?.tenantId, 'tenant-a');
  assert.equal(binding?.projectId, 'project-a');
  assert.equal(binding?.proxyKeyId, 'key-a');
  assert.equal(binding?.requestFingerprint, result.requestFingerprint);
  assert.equal(binding?.requestFingerprintVersion, result.requestFingerprintVersion);
  assert.equal(binding?.requestId, result.requestId);
  assert.equal(state.preAdmissionContextInputs?.length, 4);
  for (const context of state.preAdmissionContextInputs ?? []) {
    assert.equal(Object.hasOwn(context as object, 'idempotencyKey'), false);
  }
  assert.equal(result.normalSuccessSnapshot.customerPriceVersion, 'customer-price-1');
  assert.equal(result.normalSuccessSnapshot.holdAmountMinorUnits, '42');
  assert.equal(result.attempt.requestFingerprint, result.requestFingerprint);
  assert.equal(result.attempt.payloadSha256, result.payloadSha256);
  assert.equal(result.attempt.payloadCompilerVersion, 'compiler-v1');
  assert.equal(result.attempt.usageEstimatorVersion, 'estimator-v1');
  assert.equal(result.evidenceInput.requestFingerprint, result.requestFingerprint);
  assert.equal(result.evidenceInput.payloadCompilerVersion, 'compiler-v1');
  assert.equal(result.evidenceInput.usageEstimatorVersion, 'estimator-v1');
  assert.equal(result.evidenceInput.payloadSha256, expectedDigest);
  assert.equal(result.evidenceInput.endpoint, 'https://server-owned.example/v1');
  assert.equal(result.evidenceInput.credentialId, 'credential-a');
  assert.deepEqual(result.modelResolution, MODEL_RESOLUTION);
  assert.equal(result.requestedModel, 'model-a');
  assert.equal(result.mappedModel, 'catalog-model-a');
  assert.equal(result.providerProtocol, 'openai');
  assert.equal(result.providerOperation, 'chat.completions');
  assert.equal(result.normalSuccessSnapshot.reservationId, 'reservation-a');
  assert.deepEqual(result.attempt.modelResolution, MODEL_RESOLUTION);
  assert.deepEqual(result.evidenceInput.modelResolution, MODEL_RESOLUTION);
  assert.equal(result.attempt.requestId, result.evidence.requestId);
  assert.equal(result.attempt.attemptId, result.evidence.attemptId);
  assert.equal(result.evidence.attemptId, 'attempt-a');
  assert.equal(result.evidence.evidenceId, 'evidence-a');
  assert.equal(result.evidence.status, 'registered');
  assert.equal(result.evidence.claimedAttemptId, null);
  assert.equal(state.executors?.length, 3);
  assert.equal(new Set(state.executors).size, 1);
  assert.equal(state.registered.length, 1);
  assert.deepEqual(state.calls, ['caller', 'entitlement', 'authority', 'admission', 'attempt', 'signer', 'registrar']);
  assert.ok(result.canonicalEvidencePayload.includes(expectedDigest));
});

test('preparation records project-service execution scope without attributing it to the creator', async () => {
  const projectServiceCaller = {
    ...caller(),
    principalKind: 'project_service' as const,
    principalId: 'project-a',
  };
  const memberKey = authenticatedCaller();
  const key: AuthenticatedApiKey = {
    metadata: {
      ...memberKey.metadata,
      principalUserId: null,
      executionPrincipalType: 'project_service',
      executionPrincipalId: 'project-a',
    },
    authorization: {
      ...memberKey.authorization,
      principalKind: 'project_service',
      principalId: 'project-a',
    },
  };

  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    caller: {
      async validate() {
        return allowRequestPreparation(projectServiceCaller);
      },
    },
  }).prepare(input({ authenticatedCaller: key }));

  assert.equal(result.outcome, 'prepared');
  if (result.outcome !== 'prepared') return;
  assert.equal(result.evidenceInput.principalKind, 'project_service');
  assert.equal(result.evidenceInput.principalId, 'project-a');
  assert.equal(result.evidenceInput.audit.actorUserId, null);
  assert.equal(key.metadata.createdByUserId, 'user-a');
});

test('fails closed and compensates when admission omits the durable idempotency binding', async () => {
  const state: FakeState = {
    calls: [],
    compensated: [],
    signed: [],
    registered: [],
    transactionEvents: [],
  };
  const result = await service(state, {
    admission: {
      async authorizeAndReserve(inputValue) {
        const admitted = admission(inputValue);
        return allowRequestPreparation({ ...admitted, idempotencyBinding: undefined as never });
      },
    },
  }).prepare(input({ idempotencyKey: 'client-key-opaque-7' }));

  assertFailure(result, { outcome: 'blocked', stage: 'admission', code: 'capability_unavailable' });
  assert.equal(result.reservationDisposition, 'released');
  assert.equal(state.compensated.length, 1);
  assert.equal(state.calls.includes('attempt'), false);
  assert.equal(state.calls.includes('registrar'), false);
  assert.deepEqual(state.transactionEvents, ['begin', 'rollback']);
});

test('returns the existing canonical request reference and rolls back a duplicate admission transaction', async () => {
  const state: FakeState = {
    calls: [],
    compensated: [],
    signed: [],
    registered: [],
    transactionEvents: [],
  };
  const canonicalRequest = { requestId: 'canonical-request-a', status: 'unknown' as const };
  const result = await service(state, {
    admission: {
      async authorizeAndReserve() {
        return rejectRequestPreparation(
          'idempotency_replay',
          'the existing canonical request is returned without replaying its response',
          canonicalRequest,
        );
      },
    },
  }).prepare(input({ idempotencyKey: 'client-key-opaque-7' }));

  assertFailure(result, { outcome: 'rejected', stage: 'admission', code: 'idempotency_replay' });
  assert.deepEqual(result.canonicalRequest, canonicalRequest);
  assert.equal(state.calls.includes('attempt'), false);
  assert.equal(state.calls.includes('registrar'), false);
  assert.deepEqual(state.transactionEvents, ['begin', 'rollback']);
});

test('uses each generated request id as a one-shot admission idempotency key when the header is absent', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [], admissionInputs: [] };
  let issued = 0;
  const preparation = service(
    state,
    {},
    {
      idFactory: {
        requestId: () => `request-${++issued}`,
        attemptId: () => `attempt-${issued}`,
        evidenceId: () => `evidence-${issued}`,
      },
    },
  );
  const first = await preparation.prepare(input());
  const second = await preparation.prepare(input());
  assert.equal(first.outcome, 'prepared');
  assert.equal(second.outcome, 'prepared');
  if (first.outcome !== 'prepared' || second.outcome !== 'prepared') return;
  assert.notEqual(first.requestId, second.requestId);
  const admissionInputs = state.admissionInputs as Record<string, unknown>[];
  assert.deepEqual(
    admissionInputs.map(({ idempotencyKey, requestId }) => [idempotencyKey, requestId]),
    [
      [first.requestId, first.requestId],
      [second.requestId, second.requestId],
    ],
  );
});

test('keeps inbound request fingerprint distinct from payload digest when compilation changes bytes', async () => {
  const first = await service(
    { calls: [], compensated: [], signed: [], registered: [] },
    { payload: payloadCompiler('{"model":"provider-model-a","messages":[]}') },
  ).prepare(input());
  const second = await service(
    { calls: [], compensated: [], signed: [], registered: [] },
    { payload: payloadCompiler('{"model":"provider-model-a","messages":[{"role":"user"}]}') },
  ).prepare(input());

  assert.equal(first.outcome, 'prepared');
  assert.equal(second.outcome, 'prepared');
  if (first.outcome !== 'prepared' || second.outcome !== 'prepared') return;
  assert.equal(first.requestFingerprint, second.requestFingerprint);
  assert.notEqual(first.payloadSha256, second.payloadSha256);
  assert.notEqual(first.requestFingerprint, first.payloadSha256);
  assert.notEqual(second.requestFingerprint, second.payloadSha256);
  assert.equal(first.attempt.requestFingerprint, second.attempt.requestFingerprint);
  assert.notEqual(first.attempt.payloadSha256, second.attempt.payloadSha256);
  assert.equal(first.evidenceInput.requestFingerprint, first.requestFingerprint);
  assert.equal(second.evidenceInput.requestFingerprint, second.requestFingerprint);
  assert.equal(first.evidenceInput.payloadSha256, first.payloadSha256);
  assert.equal(second.evidenceInput.payloadSha256, second.payloadSha256);
});

test('runs account scheduling before payload compilation and persists the selected candidate binding', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [], executors: [] };
  const selected = alternateCandidate();
  const result = await service(state, {
    scheduler: realScheduler(),
    authority: {
      async resolve() {
        return allowRequestPreparation({
          ...authority(),
          candidates: [candidate(), selected],
        });
      },
    },
  }).prepare(input());

  assert.equal(result.outcome, 'prepared');
  if (result.outcome !== 'prepared') return;
  assert.equal(result.authority.candidate.accountId, 'account-b');
  assert.equal(result.authority.candidate.credentialId, 'credential-b');
  assert.equal(result.authority.poolMemberAuthzVersion, 8);
  assert.equal(result.attempt.accountId, 'account-b');
  assert.equal(result.evidence.accountId, 'account-b');
  assert.equal(result.evidence.credentialId, 'credential-b');
  assert.equal(result.evidenceInput.poolMemberAuthzVersion, 8);
});

test('binds the selected account only after request preparation accepts the candidate', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [], executors: [] };
  const bindings: Array<{ accountId: string; routeConfigId: string }> = [];
  const affinity: ProviderAccountSchedulerAffinityPort = {
    async resolve() {
      return { decision: 'allow', accountId: null };
    },
    async bind(inputValue) {
      state.calls.push('affinity-bind');
      bindings.push({ accountId: inputValue.accountId, routeConfigId: inputValue.scope.routeConfigId });
      return { decision: 'allow' };
    },
  };
  const result = await service(state, {
    scheduler: realScheduler(affinity),
    authority: {
      async resolve() {
        return allowRequestPreparation({ ...authority(), candidates: [candidate(), alternateCandidate()] });
      },
    },
  }).prepare(input({ scheduling: { sessionId: 'opaque-session-reference' } }));

  assert.equal(result.outcome, 'prepared');
  assert.deepEqual(bindings, [{ accountId: 'account-b', routeConfigId: 'route-a' }]);
  assert.equal(state.calls.indexOf('affinity-bind') < state.calls.indexOf('admission'), true);
});

test('rejects invalid and disabled Proxy Key snapshots before admission', async () => {
  const invalidState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const invalid = await service(invalidState).prepare(
    input({ authenticatedCaller: null as unknown as AuthenticatedApiKey }),
  );
  assertFailure(invalid, { outcome: 'rejected', stage: 'caller', code: 'proxy_key_invalid' });
  assert.deepEqual(invalidState.calls, []);

  const disabledState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const disabled = await service(disabledState).prepare(input({ authenticatedCaller: authenticatedCaller('revoked') }));
  assertFailure(disabled, { outcome: 'rejected', stage: 'caller', code: 'proxy_key_disabled' });
  assert.deepEqual(disabledState.calls, []);
});

test('fails closed when no caller-owned SQL transaction is available', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, { transaction: undefined }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'admission', code: 'capability_unavailable' });
  assert.equal(result.requestId, 'request-a');
  assert.equal(result.attemptId, 'attempt-a');
  assert.equal(state.calls.includes('admission'), false);
});

test('returns explicit permission, route, and budget denials without persisting an attempt', async () => {
  const permissionState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const permission = await service(permissionState, {
    entitlement: {
      async resolve() {
        return rejectRequestPreparation('entitlement_denied', 'model is not entitled');
      },
    },
  }).prepare(input());
  assertFailure(permission, { outcome: 'rejected', stage: 'entitlement', code: 'entitlement_denied' });
  assert.equal(permissionState.calls.includes('attempt'), false);

  const routeState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const route = await service(routeState, {
    authority: {
      async resolve() {
        return rejectRequestPreparation('route_denied', 'no dispatchable route');
      },
    },
  }).prepare(input());
  assertFailure(route, { outcome: 'rejected', stage: 'authority', code: 'route_denied' });
  assert.equal(routeState.calls.includes('attempt'), false);

  const budgetState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const budget = await service(budgetState, {
    admission: {
      async authorizeAndReserve() {
        return rejectRequestPreparation('quota_exceeded', 'quota is exhausted');
      },
    },
  }).prepare(input());
  assertFailure(budget, { outcome: 'rejected', stage: 'admission', code: 'quota_exceeded' });
  assert.equal(budgetState.calls.includes('attempt'), false);
});

test('fails closed when a platform hold is unavailable instead of pretending wallet authority', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    admission: {
      async authorizeAndReserve(inputValue) {
        return allowRequestPreparation({ ...admission(inputValue), holdReservation: null });
      },
    },
  }).prepare(input());
  assertFailure(result, { outcome: 'blocked', stage: 'admission', code: 'capability_unavailable' });
  assert.equal(state.calls.includes('attempt'), false);
});

test('does not register evidence when canonicalization or signing fails', async () => {
  const canonicalState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const canonicalFailure = await service(
    canonicalState,
    {},
    {
      canonicalizer: {
        canonicalize() {
          throw new Error('canonicalizer unavailable');
        },
      },
    },
  ).prepare(input());
  assertFailure(canonicalFailure, { outcome: 'blocked', stage: 'evidence', code: 'canonicalization_failed' });
  assert.equal(canonicalState.calls.includes('attempt'), true);
  assert.equal(canonicalState.calls.includes('registrar'), false);
  assert.equal(canonicalFailure.reservationDisposition, 'released');
  assert.equal(canonicalFailure.manualReconciliationRequired, false);
  assert.equal(canonicalState.compensated.length, 1);
  assert.deepEqual(canonicalState.compensated[0]?.expectedAttempt, {
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
  });

  const signerState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const signerFailure = await service(signerState, {
    signer: {
      async sign() {
        return blockRequestPreparation('signing_failed', 'signer unavailable');
      },
    },
  }).prepare(input());
  assertFailure(signerFailure, { outcome: 'blocked', stage: 'evidence', code: 'signing_failed' });
  assert.equal(signerState.calls.includes('registrar'), false);
  assert.equal(signerFailure.reservationDisposition, 'released');
  assert.equal(signerFailure.manualReconciliationRequired, false);
  assert.equal(signerState.compensated.length, 1);
});

test('blocks mismatched attempt persistence and mismatched proof registration', async () => {
  const attemptState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const attemptMismatch = await service(attemptState, {
    attempt: {
      async persist(inputValue) {
        return allowRequestPreparation({ ...attemptRecord(inputValue), attemptId: 'other-attempt' });
      },
    },
  }).prepare(input());
  assertFailure(attemptMismatch, { outcome: 'blocked', stage: 'attempt', code: 'binding_mismatch' });
  assert.equal(attemptState.calls.includes('signer'), false);
  assert.equal(attemptMismatch.reservationDisposition, 'released');
  assert.equal(attemptState.compensated.length, 1);

  const evidenceState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const evidenceMismatch = await service(evidenceState, {
    registrar: {
      async register(inputValue) {
        return allowRequestPreparation({ ...evidenceRecord(inputValue), attemptId: 'other-attempt' });
      },
    },
  }).prepare(input());
  assertFailure(evidenceMismatch, { outcome: 'blocked', stage: 'evidence', code: 'binding_mismatch' });
  assert.equal(evidenceState.calls.includes('signer'), true);
  assert.equal(evidenceMismatch.reservationDisposition, 'released');
  assert.equal(evidenceState.compensated.length, 1);
});

test('fails closed when the attempt adapter drops model-resolution provenance', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    attempt: {
      async persist(inputValue) {
        const record = attemptRecord(inputValue) as unknown as Record<string, unknown>;
        delete record.modelResolution;
        return allowRequestPreparation(record as unknown as RequestPreparationAttemptRecord);
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'attempt', code: 'binding_mismatch' });
  assert.equal(state.calls.includes('signer'), false);
  assert.equal(state.compensated.length, 1);
});

test('fails closed when compiler output changes model or provider-route facts', async () => {
  const modelState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const modelMismatch = await service(modelState, {
    payload: {
      async compile(inputValue) {
        const decision = await payloadCompiler().compile(inputValue);
        if (decision.decision !== 'allow') return decision;
        return allowRequestPreparation({ ...decision.value, mappedModel: 'unbound-model' });
      },
    },
  }).prepare(input());
  assertFailure(modelMismatch, { outcome: 'blocked', stage: 'payload', code: 'binding_mismatch' });
  assert.equal(modelState.compensated.length, 0);

  const routeState: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const routeMismatch = await service(routeState, {
    payload: {
      async compile(inputValue) {
        const decision = await payloadCompiler().compile(inputValue);
        if (decision.decision !== 'allow') return decision;
        return allowRequestPreparation({ ...decision.value, providerOperation: 'responses' });
      },
    },
  }).prepare(input());
  assertFailure(routeMismatch, { outcome: 'blocked', stage: 'payload', code: 'binding_mismatch' });
  assert.equal(routeState.compensated.length, 0);
});

test('fails closed when a non-identity authority mapping omits its revision', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    authority: {
      async resolve() {
        return allowRequestPreparation({
          ...authority(),
          modelResolution: { ...MODEL_RESOLUTION, mappingVersion: null },
        });
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'authority', code: 'capability_unavailable' });
  assert.equal(state.calls.includes('payload'), false);
});

test('fails closed when route operation is not legal for its server protocol', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    authority: {
      async resolve() {
        return allowRequestPreparation({
          ...authority(),
          route: { ...authority().route, providerOperation: 'messages' },
        });
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'authority', code: 'capability_unavailable' });
  assert.equal(state.calls.includes('payload'), false);
});

test('rejects a platform hold bound to another tenant and compensates the admission', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    admission: {
      async authorizeAndReserve(inputValue) {
        const admitted = admission(inputValue);
        if (admitted.holdReservation === null) {
          return blockRequestPreparation('capability_unavailable', 'test hold unavailable');
        }
        return allowRequestPreparation({
          ...admitted,
          holdReservation: { ...admitted.holdReservation, tenantId: 'tenant-b' },
        });
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'admission', code: 'binding_mismatch' });
  assert.equal(result.reservationDisposition, 'released');
  assert.equal(state.compensated.length, 1);
  assert.equal(state.compensated[0]?.tenantId, 'tenant-a');
  assert.equal(state.calls.includes('attempt'), false);
});

test('retains reservations for manual reconciliation when compensation is unavailable', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    compensation: undefined,
    signer: {
      async sign() {
        return blockRequestPreparation('signing_failed', 'signer unavailable');
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'evidence', code: 'signing_failed' });
  assert.equal(result.reservationDisposition, 'retained_for_reconciliation');
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(result.compensation, null);
  assert.equal(state.compensated.length, 0);
});

test('records a retained hold when compensation cannot prove pre-dispatch safety', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    compensation: {
      async releasePreDispatch(inputValue) {
        return allowRequestPreparation({
          requestId: inputValue.requestId,
          attemptId: inputValue.attemptId,
          disposition: 'retained_for_reconciliation',
          quotaReservation: 'released',
          rateReservation: 'released',
          holdReservation: 'retained_for_reconciliation',
          manualReconciliationRequired: true,
        });
      },
    },
    registrar: {
      async register() {
        return blockRequestPreparation('evidence_registration_failed', 'evidence store unavailable');
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'evidence', code: 'evidence_registration_failed' });
  assert.equal(result.reservationDisposition, 'retained_for_reconciliation');
  assert.equal(result.manualReconciliationRequired, true);
  assert.equal(result.compensation?.holdReservation, 'retained_for_reconciliation');
});

test('compensates an explicit evidence registration failure before returning blocked', async () => {
  const state: FakeState = { calls: [], compensated: [], signed: [], registered: [] };
  const result = await service(state, {
    registrar: {
      async register() {
        return blockRequestPreparation('evidence_registration_failed', 'evidence store unavailable');
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'evidence', code: 'evidence_registration_failed' });
  assert.equal(result.reservationDisposition, 'released');
  assert.equal(result.manualReconciliationRequired, false);
  assert.equal(state.compensated.length, 1);
  assert.equal(state.registered.length, 0);
});

test('rolls back every durable preparation decision on the shared outer executor', async () => {
  const transactionEvents: string[] = [];
  const executors: unknown[] = [];
  const state: FakeState = {
    calls: [],
    compensated: [],
    signed: [],
    registered: [],
    executors,
    transactionEvents,
  };
  const result = await service(state, {
    registrar: {
      async register(_inputValue, options) {
        executors.push(options?.executor);
        return blockRequestPreparation('evidence_registration_failed', 'database write failed');
      },
    },
  }).prepare(input());

  assertFailure(result, { outcome: 'blocked', stage: 'evidence', code: 'evidence_registration_failed' });
  assert.deepEqual(transactionEvents, ['begin', 'rollback']);
  assert.equal(executors.length, 4);
  assert.equal(new Set(executors).size, 1);
});
