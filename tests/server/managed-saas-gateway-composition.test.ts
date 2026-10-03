import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  sealProviderCredential,
  type ProviderCredentialKms,
} from '../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor } from '../../src/saas/db/index.js';
import type { ModelResolutionProvenance } from '../../src/saas/gateway/contracts.js';
import { createSaasGatewayHandler, type SaasGatewayHttpHandler } from '../../src/saas/gateway/http-handler.js';
import {
  PostgresProviderAccountRuntimeHealthStore,
  type ProviderAccountRuntimeHealthWriter,
} from '../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../src/saas/gateway/postgres-provider-account-scheduler.js';
import type {
  PreparedEvidenceLeaseProvider,
  PreparedEvidenceMeteringPort,
  PreparedEvidenceTransport,
} from '../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  PreparedRequestEvidenceDispatchPort,
  PreparedRequestEvidenceInput,
  PreparedRequestEvidenceRecord,
} from '../../src/saas/gateway/prepared-request-evidence-service.js';
import { ProviderHttpTransport, ProviderHttpTransportError } from '../../src/saas/gateway/provider-http-transport.js';
import {
  allowRequestPreparation,
  type RequestPreparationAdmission,
  type RequestPreparationAdmissionPort,
  type RequestPreparationAttemptPersistenceInput,
  type RequestPreparationAttemptRecord,
  type RequestPreparationAuthority,
  type RequestPreparationCaller,
  type RequestPreparationEntitlement,
  type RequestPreparationInput,
  type RequestPreparationPayloadCompiler,
  rejectRequestPreparation,
} from '../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../src/saas/keys/types.js';
import type { AttemptRecord, AttemptTransitionInput } from '../../src/saas/metering/types.js';
import type { RequestPreparationSigner } from '../../src/saas/runtime/request-preparation-signer-adapter.js';
import { GatewayProviderCredentialUnsealer } from '../../src/saas/runtime/gateway-provider-credential-unsealer.js';
import { ProviderSupplyHttpCredentialResolver } from '../../src/saas/runtime/provider-supply-http-credential-resolver.js';
import type { ProviderCredentialDispatchBinding, ProviderCredentialDispatchProof } from '../../src/saas/supply/types.js';
import {
  createManagedSaasGatewayComposition,
  createManagedSaasGatewayProductionComposition,
  type ManagedSaasGatewayCompositionDependencies,
  ManagedSaasGatewayCompositionError,
  type ManagedSaasGatewayProductionOptions,
} from '../../src/server/managed-saas-gateway.js';

const NOW = '2099-01-01T00:00:00.000Z';
const DISPATCH_DEADLINE = '2099-01-01T00:00:30.000Z';
const EXPIRES_AT = '2099-01-01T00:01:00.000Z';
const MODEL_RESOLUTION: ModelResolutionProvenance = {
  requestedModel: 'model-a',
  mappedModel: 'catalog-model-a',
  resolvedModel: 'provider-model-a',
  mappingSource: 'alias',
  mappingVersion: 1,
};

function authenticatedCaller(): AuthenticatedApiKey {
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
      revokedByUserId: null,
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      name: 'test-key',
      prefix: 'mr_test',
      modelScopes: ['model-a'],
      status: 'active',
      createdAt: NOW,
      expiresAt: EXPIRES_AT,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'key-a',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      principalKind: 'member',
      principalId: 'user-a',
      entitlementId: 'entitlement-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      modelScopes: ['model-a'],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
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
    supplyMode: 'byok',
    modelScopes: ['model-a'],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
}

function entitlement(): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-a',
    projectId: 'project-a',
    proxyKeyId: 'key-a',
    entitlementId: 'entitlement-a',
    entitlementVersion: 1,
    supplyProfileId: 'profile-a',
    supplyProfileVersion: 1,
    supplyMode: 'byok',
    modelScopeVersion: 1,
    allowedModels: ['model-a'],
    allowedProviderIds: ['provider-a'],
    projectPolicyVersion: 1,
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
      routeConfigVersion: 1,
      protocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      targetMode: 'tenant_account',
      upstreamId: 'upstream-a',
      endpoint: 'https://provider.example/v1',
    },
    candidate: {
      tenantId: 'tenant-a',
      projectId: 'project-a',
      proxyKeyId: 'key-a',
      supplyProfileId: 'profile-a',
      supplyMode: 'byok',
      accountOwnerKind: 'tenant',
      upstreamId: 'upstream-a',
      accountId: 'account-a',
      credentialId: 'credential-a',
      credentialVersion: 1,
      credentialAuthzVersion: 1,
      accountAuthzVersion: 1,
      dispatchProfileId: 'dispatch-a',
      supplyProfileAuthzVersion: 1,
      resolvedModel: 'provider-model-a',
      protocol: 'openai',
      endpoint: 'https://provider.example/v1',
      supplierCostVersion: null,
      providerId: 'provider-a',
      productId: 'product-a',
      profileAccountAuthzVersion: 1,
    },
    modelMappingRules: [
      {
        pattern: 'model-a',
        mappedModel: 'catalog-model-a',
        mappingSource: 'alias',
        mappingVersion: 1,
      },
    ],
    poolMemberAuthzVersion: null,
    credentialRef: 'credential-a',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-a',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-a',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-a',
      customerPriceVersion: null,
      supplierCostVersion: null,
    },
  };
}

function payloadCompiler(): RequestPreparationPayloadCompiler {
  return {
    async compile() {
      return allowRequestPreparation({
        payloadBytes: new TextEncoder().encode('{"model":"provider-model-a","messages":[]}'),
        requestFingerprint: 'request-fingerprint-a',
        requestFingerprintVersion: 'canonical-v1',
        compilerVersion: 'test-compiler-v1',
        estimatorVersion: 'test-estimator-v1',
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
  input: Parameters<RequestPreparationAdmissionPort['authorizeAndReserve']>[0],
): RequestPreparationAdmission {
  return {
    quotaReservation: { reference: 'quota-a', state: 'reserved' },
    rateReservation: { reference: 'rate-a', state: 'reserved' },
    holdReservation: null,
    idempotencyBinding: {
      state: 'created',
      keyDigest: input.idempotencyClaim?.keyDigest ?? 'd'.repeat(64),
      requestFingerprint: input.requestFingerprint,
      requestFingerprintVersion: input.requestFingerprintVersion,
      tenantId: input.tenantId,
      projectId: input.projectId,
      proxyKeyId: input.proxyKeyId,
      requestId: input.requestId,
    },
    deadlineAtMs: Date.parse(DISPATCH_DEADLINE),
    dispatchDeadline: DISPATCH_DEADLINE,
    expiresAt: EXPIRES_AT,
    remainingAttempts: 1,
    retryBudget: 0,
    attemptOrdinal: 1,
    usageBudget: { unit: 'tokens', amount: 16, basis: 'reserved' },
  };
}

function attemptRecord(input: RequestPreparationAttemptPersistenceInput): RequestPreparationAttemptRecord {
  return {
    tenantId: input.caller.tenantId,
    projectId: input.caller.projectId,
    proxyKeyId: input.caller.proxyKeyId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    attemptOrdinal: input.admission.attemptOrdinal,
    publicModel: input.publicModel,
    protocol: input.protocol,
    endpoint: input.authority.route.endpoint,
    routeConfigId: input.authority.route.routeConfigId,
    routeConfigVersion: input.authority.route.routeConfigVersion,
    supplyMode: input.authority.candidate.supplyMode,
    upstreamId: input.authority.candidate.upstreamId,
    accountId: input.authority.candidate.accountId,
    credentialId: input.authority.candidate.credentialId,
    resolvedModel: input.authority.candidate.resolvedModel,
    modelResolution: input.modelResolution,
    clientProtocol: input.authority.route.protocol,
    providerProtocol: input.authority.route.providerProtocol ?? input.authority.candidate.protocol,
    clientOperation: input.authority.route.clientOperation ?? 'chat.completions',
    providerOperation: input.authority.route.providerOperation ?? 'chat.completions',
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: input.requestFingerprintVersion,
    payloadSha256: input.payloadSha256,
    payloadCompilerVersion: input.payloadCompilerVersion,
    usageEstimatorVersion: input.usageEstimatorVersion,
    dispatchAuthorityState: 'bound',
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    preparedEvidenceId: null,
  };
}

function evidenceRecord(input: PreparedRequestEvidenceInput): PreparedRequestEvidenceRecord {
  return {
    evidenceId: input.evidenceId ?? 'missing-evidence-id',
    tenantId: input.tenantId,
    projectId: input.projectId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    attemptOrdinal: input.attemptOrdinal,
    supplyMode: input.supplyMode,
    publicModel: input.publicModel,
    protocol: input.protocol,
    modelResolution: input.modelResolution,
    clientProtocol: input.clientProtocol,
    providerProtocol: input.providerProtocol,
    clientOperation: input.clientOperation,
    providerOperation: input.providerOperation,
    endpoint: input.endpoint,
    upstreamId: input.upstreamId,
    accountId: input.accountId,
    credentialId: input.credentialId,
    credentialVersion: String(input.credentialVersion),
    routeTargetMode: input.routeTargetMode,
    payloadSha256: input.payloadSha256,
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: input.requestFingerprintVersion,
    payloadCompilerVersion: input.payloadCompilerVersion,
    usageEstimatorVersion: input.usageEstimatorVersion,
    statementSha256: 'a'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: new Date(input.expiresAt).toISOString(),
  };
}

function preparationInput(): RequestPreparationInput {
  return {
    authenticatedCaller: authenticatedCaller(),
    publicModel: 'model-a',
    protocol: 'openai',
    clientRequest: { model: 'model-a', messages: [] },
    audit: { entryPoint: 'composition-test' },
  };
}

function inertDispatchDependencies(): ManagedSaasGatewayCompositionDependencies['dispatch'] {
  return {
    evidence: {
      preflightForDispatch: async () => {
        throw new Error('dispatch is not part of this preparation assertion');
      },
      claimForDispatch: async () => {
        throw new Error('dispatch is not part of this preparation assertion');
      },
    },
    metering: {
      getAttempt: async () => null,
      transitionAttempt: async () => {
        throw new Error('dispatch is not part of this preparation assertion');
      },
    },
    leaseProvider: {
      acquire: async () => null,
    },
    transport: {
      send: async () => {
        throw new Error('dispatch is not part of this preparation assertion');
      },
    },
  } as unknown as ManagedSaasGatewayCompositionDependencies['dispatch'];
}

function dispatchAttemptRecord(evidence: PreparedRequestEvidenceRecord): AttemptRecord {
  const platform = evidence.supplyMode === 'platform';
  return {
    id: evidence.attemptId,
    tenantId: evidence.tenantId,
    requestId: evidence.requestId,
    projectPolicyVersion: '1',
    customerPriceVersion: platform ? 'customer-price-a' : null,
    customerMeteringPolicyId: 'customer-policy-a',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-a',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-a',
    routeConfigId: 'route-a',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-a',
    routePublicModelVersion: '1',
    routeProtocol: evidence.protocol,
    routeTargetMode: evidence.routeTargetMode,
    ordinal: evidence.attemptOrdinal,
    upstreamId: evidence.upstreamId,
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: platform ? 'platform' : 'tenant',
    accountId: evidence.accountId,
    providerId: 'provider-a',
    productId: 'product-a',
    resolvedModel: evidence.resolvedModel ?? 'provider-model-a',
    modelResolution: evidence.modelResolution,
    clientProtocol: evidence.clientProtocol,
    providerProtocol: evidence.providerProtocol,
    clientOperation: evidence.clientOperation,
    providerOperation: evidence.providerOperation,
    requestFingerprint: evidence.requestFingerprint,
    requestFingerprintVersion: evidence.requestFingerprintVersion,
    payloadCompilerVersion: evidence.payloadCompilerVersion,
    usageEstimatorVersion: evidence.usageEstimatorVersion,
    payloadSha256: evidence.payloadSha256,
    protocol: evidence.protocol,
    endpoint: evidence.endpoint,
    supplierCostVersion: platform ? 'supplier-cost-a' : null,
    dispatchProfileId: 'dispatch-a',
    supplyProfileAuthzVersion: '1',
    credentialId: evidence.credentialId,
    credentialVersion: evidence.credentialVersion,
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: platform ? 'pool-a' : null,
    poolAuthzVersion: platform ? '1' : null,
    poolMemberAccountAuthzVersion: platform ? '1' : null,
    poolMemberAuthzVersion: platform ? '1' : null,
    poolGrantAuthzVersion: platform ? '1' : null,
    poolGrantProfileAuthzVersion: platform ? '1' : null,
    poolGrantPoolAuthzVersion: platform ? '1' : null,
    profileAccountAuthzVersion: platform ? null : '1',
    preparedEvidenceId: null,
    dispatchState: 'not_sent',
    resultState: 'pending',
    responseStarted: false,
    responseStartedAt: null,
    resultHttpStatus: null,
    unknownReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    stateVersion: 1,
  };
}

function claimedDispatchAttempt(current: AttemptRecord, evidence: PreparedRequestEvidenceRecord): AttemptRecord {
  assert.equal(current.tenantId, evidence.tenantId);
  assert.equal(current.requestId, evidence.requestId);
  assert.equal(current.id, evidence.attemptId);
  assert.equal(current.ordinal, evidence.attemptOrdinal);
  assert.equal(current.bindingState, 'bound');
  assert.equal(current.dispatchAuthorityState, 'bound');
  assert.equal(current.preparedEvidenceId, null);
  assert.equal(current.dispatchState, 'not_sent');
  assert.equal(current.resultState, 'pending');
  assert.equal(current.responseStarted, false);
  return { ...current, preparedEvidenceId: evidence.evidenceId, stateVersion: current.stateVersion + 1, updatedAt: NOW };
}

function transitionedDispatchAttempt(current: AttemptRecord, input: AttemptTransitionInput): AttemptRecord {
  assert.equal(input.tenantId, current.tenantId);
  assert.equal(input.requestId, current.requestId);
  assert.equal(input.attemptId, current.id);
  assert.equal(input.expectedStateVersion, current.stateVersion, 'strict CAS must use the post-claim version');
  assert.equal(input.expectedDispatchState, current.dispatchState);
  assert.equal(input.expectedResultState, current.resultState);
  assert.equal(input.expectedResponseStarted, current.responseStarted);
  if (input.dispatchState === 'dispatching') {
    assert.ok(current.preparedEvidenceId);
    assert.equal(current.bindingState, 'bound');
    assert.equal(current.dispatchAuthorityState, 'bound');
  }
  return {
    ...current,
    dispatchState: input.dispatchState ?? current.dispatchState,
    resultState: input.resultState ?? current.resultState,
    responseStarted: current.responseStarted || input.responseStarted === true,
    responseStartedAt: current.responseStarted ? current.responseStartedAt : input.responseStarted ? NOW : null,
    resultHttpStatus: input.resultHttpStatus ?? current.resultHttpStatus,
    unknownReason: input.unknownReason ?? null,
    stateVersion: current.stateVersion + 1,
    updatedAt: NOW,
  };
}

function dispatchComposition(
  transport: PreparedEvidenceTransport,
  runtimeHealthWriter: ProviderAccountRuntimeHealthWriter,
) {
  const payloadBytes = new Uint8Array([1]);
  const dispatchEvidence: PreparedRequestEvidenceRecord = {
    evidenceId: 'dispatch-evidence',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    requestId: 'dispatch-request',
    attemptId: 'dispatch-attempt',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    publicModel: 'model-a',
    protocol: 'openai',
    requestedModel: MODEL_RESOLUTION.requestedModel,
    mappedModel: MODEL_RESOLUTION.mappedModel,
    resolvedModel: MODEL_RESOLUTION.resolvedModel,
    modelResolution: { ...MODEL_RESOLUTION },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    requestFingerprint: 'c'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    endpoint: 'https://provider.example/v1',
    upstreamId: 'upstream-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: '1',
    routeTargetMode: 'tenant_account',
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    statementSha256: 'b'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: EXPIRES_AT,
  };
  let meteringAttempt = dispatchAttemptRecord(dispatchEvidence);
  let currentEvidence = dispatchEvidence;
  const metering: PreparedEvidenceMeteringPort = {
    async getAttempt() {
      return { ...meteringAttempt };
    },
    async transitionAttempt(input: AttemptTransitionInput) {
      meteringAttempt = transitionedDispatchAttempt(meteringAttempt, input);
      return meteringAttempt;
    },
    async recordKnownNonSuccessHttpResponse() {
      throw new Error('known non-success response is outside this dispatch health assertion');
    },
  };
  const leaseProvider: PreparedEvidenceLeaseProvider = {
    async acquire() {
      return {
        fencingToken: 'fence-from-production-composition',
        renewIntervalMs: 1000,
        async renew() {},
        async release() {},
      };
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error('preparation is outside this dispatch assertion');
  };
  const preparation = {
    caller: { validate: unused },
    entitlement: { resolve: unused },
    authority: { resolve: unused },
    payload: { compile: unused },
    admission: { authorizeAndReserve: unused },
    attempt: { persist: unused },
    transaction: { transaction: unused },
    compensation: { releasePreDispatch: unused },
    signer: { sign: unused },
    registrar: { register: unused },
  } as unknown as ManagedSaasGatewayCompositionDependencies['preparation'];

  const composition = createManagedSaasGatewayComposition({
    authenticator: { authenticate: async () => null },
    preparation,
    preparationOptions: {
      evidenceVerifierKeyId: 'dispatch-test-key',
      idFactory: {
        requestId: () => 'dispatch-request',
        attemptId: () => 'dispatch-attempt',
        evidenceId: () => 'dispatch-evidence',
      },
    },
    dispatch: {
      evidence: {
        async preflightForDispatch() {
          return dispatchEvidence;
        },
        async claimForDispatch() {
          meteringAttempt = claimedDispatchAttempt(meteringAttempt, dispatchEvidence);
          currentEvidence = {
            ...dispatchEvidence,
            status: 'claimed',
            claimedAt: NOW,
            claimedAttemptId: dispatchEvidence.attemptId,
          };
          return structuredClone(currentEvidence);
        },
      },
      metering,
      leaseProvider,
      transport,
      runtimeHealthWriter,
    },
    lifecycle: { close: async () => {} },
    maxBodyBytes: 1024,
    entryPoint: 'dispatch-composition-test',
  });
  return {
    composition, payloadBytes,
    readAttempt: () => structuredClone(meteringAttempt),
    readEvidence: () => structuredClone(currentEvidence),
  };
}

test('managed gateway composition wires success and retryable failure through the fenced health writer', async () => {
  const scenarios = [
    {
      transport: {
        async send() {
          return { responseStarted: true, resultHttpStatus: 200 };
        },
      } satisfies PreparedEvidenceTransport,
      expected: { source: 'gateway', result: 'success' },
      resultKind: 'sent',
    },
    {
      transport: {
        async send() {
          throw new ProviderHttpTransportError('NETWORK_ERROR', 'provider network failure');
        },
      } satisfies PreparedEvidenceTransport,
      expected: { source: 'gateway', result: 'retryable_failure', failureKind: 'network' },
      resultKind: 'unknown',
    },
  ] as const;

  for (const scenario of scenarios) {
    const writes: unknown[] = [];
    const runtimeHealthWriter: ProviderAccountRuntimeHealthWriter = {
      async recordRuntimeOutcome(input) {
        writes.push(input);
        return 'applied';
      },
    };
    const { composition, payloadBytes } = dispatchComposition(scenario.transport, runtimeHealthWriter);
    const result = await composition.dispatch.dispatch({
      evidenceId: 'dispatch-evidence',
      payloadBytes,
      audit: { actorUserId: 'user-a', entryPoint: 'dispatch-composition-test' },
    });

    assert.equal(result.kind, scenario.resultKind);
    assert.deepEqual(writes, [
      {
        candidate: {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          upstreamId: 'upstream-a',
          supplyMode: 'byok',
          accountOwnerKind: 'tenant',
        },
        attemptId: 'dispatch-attempt',
        fencingToken: 'fence-from-production-composition',
        evidence: scenario.expected,
      },
    ]);
    await composition.close();
  }
});

test('composition dispatch uses real credential unsealing, native bearer formatting, and ProviderHttpTransport', { timeout: 5000 }, async () => {
  const secret = Buffer.from('synthetic-composition-provider-token');
  const dataKey = randomBytes(32);
  const decryptedKeys: Uint8Array[] = [];
  let encryptionContext: Readonly<Record<string, string>> | undefined;
  let kmsDecrypts = 0;
  let proofReads = 0;
  let fetches = 0;
  let bearerMatched = false;
  const kms: ProviderCredentialKms = {
    async generateDataKey(request) {
      encryptionContext = request.encryptionContext;
      return { plaintextKey: Buffer.from(dataKey), ciphertextBlob: Buffer.from('synthetic-wrapped-composition-key') };
    },
    async decryptDataKey(request) {
      assert.deepEqual(request.encryptionContext, encryptionContext);
      kmsDecrypts += 1;
      const plaintext = Buffer.from(dataKey);
      decryptedKeys.push(plaintext);
      return plaintext;
    },
  };
  const envelope = await sealProviderCredential(secret, createProviderCredentialContext({
    deployment: 'composition', environment: 'test', ownerKind: 'tenant', tenantId: 'tenant-a',
    supplyMode: 'byok', purpose: 'inference', providerId: 'provider-a', productId: 'product-a',
    accountId: 'account-a', credentialId: 'credential-a', credentialVersion: 1, credentialType: 'api-key',
  }), kms, 'synthetic-composition-kms');
  const healthWrites: unknown[] = [];
  let readAttempt: (() => AttemptRecord) | undefined;
  let readEvidence: (() => PreparedRequestEvidenceRecord) | undefined;
  const resolver = new ProviderSupplyHttpCredentialResolver({
    proofReader: {
      async readDispatchProof(id): Promise<ProviderCredentialDispatchProof> {
        assert.equal(id, 'dispatch-evidence');
        assert.ok(readAttempt && readEvidence);
        const attempt = readAttempt();
        const evidence = readEvidence();
        // Read actual helper state after claim and its versioned dispatch CAS.
        assert.equal(attempt.preparedEvidenceId, id);
        assert.equal(attempt.stateVersion, 3);
        assert.equal(attempt.dispatchState, 'dispatching');
        assert.equal(evidence.status, 'claimed');
        proofReads += 1;
        const binding: ProviderCredentialDispatchBinding = {
          tenantId: 'tenant-a', requestId: 'dispatch-request', attemptId: 'dispatch-attempt', attemptOrdinal: 1,
          supplyMode: 'byok', accountOwnerKind: 'tenant', accountId: 'account-a', providerId: 'provider-a', productId: 'product-a',
          protocol: 'openai', endpoint: evidence.endpoint, routeConfigId: 'route-a', routeConfigVersion: 1,
          routePublicModelId: 'public-model-a', routePublicModelVersion: 1, routeProtocol: 'openai',
          routeTargetMode: 'tenant_account', routeUpstreamId: 'upstream-a', upstreamId: 'upstream-a',
          resolvedModel: MODEL_RESOLUTION.resolvedModel, dispatchProfileId: 'dispatch-a', supplyProfileAuthzVersion: 1,
          credentialId: 'credential-a', credentialVersion: 1, credentialAuthzVersion: 1, accountAuthzVersion: 1,
          profileAccountAuthzVersion: 1, poolId: null, poolAuthzVersion: null, poolMemberAccountAuthzVersion: null,
          poolMemberAuthzVersion: null, poolGrantAuthzVersion: null, poolGrantProfileAuthzVersion: null, poolGrantPoolAuthzVersion: null,
        };
        return {
          evidence: {
            ...binding, evidenceId: id, supplyProfileId: 'dispatch-a', supplyProfileVersion: 1, publicModel: 'model-a',
            status: 'claimed', claimedAt: NOW, claimedAttemptId: 'dispatch-attempt',
            dispatchDeadline: DISPATCH_DEADLINE, expiresAt: EXPIRES_AT,
          },
          attempt: {
            ...binding, preparedEvidenceId: attempt.preparedEvidenceId ?? null, dispatchAuthorityState: attempt.dispatchAuthorityState,
            dispatchState: attempt.dispatchState, resultState: attempt.resultState, responseStarted: attempt.responseStarted,
          },
          account: {
            ownerKind: 'tenant', tenantId: 'tenant-a', supplyMode: 'byok', id: 'account-a', providerId: 'provider-a', productId: 'product-a',
            credentialType: 'api-key', purpose: 'inference', status: 'active', validationState: 'verified', authzVersion: 1,
          },
          credential: {
            ownerKind: 'tenant', tenantId: 'tenant-a', supplyMode: 'byok', id: 'credential-a', accountId: 'account-a',
            providerId: 'provider-a', productId: 'product-a', status: 'active', validationState: 'verified',
            currentVersion: 1, expiresAt: null, authzVersion: 1,
          },
          version: {
            ownerKind: 'tenant', tenantId: 'tenant-a', accountId: 'account-a', credentialId: 'credential-a', version: 1,
            status: 'active', envelopeSchemaVersion: envelope.schemaVersion, contextVersion: envelope.contextVersion,
            algorithm: envelope.algorithm, kmsPurpose: 'inference', wrappingRevision: 1, createdAt: NOW,
            expiresAt: null, retiredAt: null, revokedAt: null, kmsKeyId: envelope.kmsKeyId, envelope,
          },
          profile: { tenantId: 'tenant-a', id: 'dispatch-a', supplyMode: 'byok', status: 'active', authzVersion: 1 },
          profileAccount: {
            tenantId: 'tenant-a', supplyProfileId: 'dispatch-a', supplyMode: 'byok', accountId: 'account-a',
            providerId: 'provider-a', productId: 'product-a', accountAuthzVersion: 1, status: 'active', authzVersion: 1,
            effectiveAt: NOW, expiresAt: null,
          },
          pool: null, poolMember: null, poolGrant: null,
          claimAudit: { action: 'saas_prepared_request_evidence.claimed', targetType: 'saas_prepared_request_evidence', targetId: id },
        };
      },
    },
    unsealer: new GatewayProviderCredentialUnsealer({
      decryptDataKey: (request) => kms.decryptDataKey(request), checkReady: async () => {}, close: async () => {},
    }, { deployment: 'composition', environment: 'test' }),
    resolveAuthenticationHeader: () => 'authorization',
    now: () => new Date(NOW),
  });
  const transport = new ProviderHttpTransport({
    resolveCredential: resolver.resolveCredential,
    resolveDispatchProfile: async () => ({ url: 'https://provider.example/v1/dispatch' }),
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] }, timeoutMs: 1000,
    fetch: async (_url, init) => {
      fetches += 1;
      assert.equal(init.redirect, 'manual');
      assert.ok(init.dispatcher);
      assert.ok(init.headers instanceof Headers);
      bearerMatched = init.headers.get('authorization') === `Bearer ${secret.toString('utf8')}`;
      // Native upstream contract stays strict: raw plaintext yields a real 401 response.
      return new Response(null, { status: bearerMatched ? 200 : 401 });
    },
  });
  const graph = dispatchComposition(transport, { recordRuntimeOutcome: async (input) => { healthWrites.push(input); return 'applied'; } });
  readAttempt = graph.readAttempt;
  readEvidence = graph.readEvidence;
  try {
    const result = await graph.composition.dispatch.dispatch({
      evidenceId: 'dispatch-evidence', payloadBytes: graph.payloadBytes,
      audit: { actorUserId: 'user-a', entryPoint: 'native-auth-composition-test' },
    });
    assert.equal(bearerMatched, true, 'native upstream must observe bearer formatting');
    assert.equal(fetches, 1);
    assert.equal(proofReads, 1);
    assert.equal(kmsDecrypts, 1);
    assert.equal(result.kind, 'sent');
    if (result.kind !== 'sent') throw new Error('native authenticated response was not sent');
    assert.equal(result.transport.resultHttpStatus, 200);
    assert.equal(result.attempt.stateVersion, 4);
    assert.equal(result.attempt.preparedEvidenceId, 'dispatch-evidence');
    assert.equal(healthWrites.length, 1);
    assert.ok(decryptedKeys.every((bytes) => bytes.every((byte) => byte === 0)));
  } finally {
    await graph.composition.close();
    secret.fill(0);
    dataKey.fill(0);
  }
});

async function startHttpServer(
  handler: SaasGatewayHttpHandler,
  requestId?: string,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res, requestId === undefined ? undefined : { requestId })
      .then((handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end();
      })
      .catch(() => {
        if (!res.writableEnded) res.writeHead(500).end();
      });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('complete test-mode graph uses gateway-owned IDs and one executor through evidence registration', async () => {
  const executor: SqlExecutor = { query: async () => ({ rows: [], rowCount: 0 }) };
  const executors: unknown[] = [];
  const calls: string[] = [];
  let registrarCalls = 0;
  let transactionCalls = 0;
  let closeCalls = 0;
  let cancellationResponse: { destroyed: boolean } | undefined;
  const compensationStages: string[] = [];
  const dependencies: ManagedSaasGatewayCompositionDependencies = {
    authenticator: {
      authenticate: async () => authenticatedCaller(),
    },
    preparation: {
      transaction: {
        transaction: async (work) => {
          transactionCalls += 1;
          return work(executor);
        },
      },
      caller: {
        async validate() {
          calls.push('caller');
          return allowRequestPreparation(caller());
        },
      },
      entitlement: {
        async resolve() {
          calls.push('entitlement');
          return allowRequestPreparation(entitlement());
        },
      },
      authority: {
        async resolve() {
          calls.push('authority');
          return allowRequestPreparation(authority());
        },
      },
      payload: payloadCompiler(),
      admission: {
        async authorizeAndReserve(input, options) {
          calls.push('admission');
          executors.push(options?.executor);
          return allowRequestPreparation(admission(input));
        },
      },
      attempt: {
        async persist(input, options) {
          calls.push('attempt');
          executors.push(options?.executor);
          return allowRequestPreparation(attemptRecord(input));
        },
      },
      compensation: {
        async releasePreDispatch(input, options) {
          calls.push('compensation');
          compensationStages.push(input.failedStage);
          executors.push(options?.executor);
          return allowRequestPreparation({
            requestId: input.requestId,
            attemptId: input.attemptId,
            disposition: 'released',
            quotaReservation: 'released',
            rateReservation: 'released',
            holdReservation: 'not_applicable',
            manualReconciliationRequired: false,
          });
        },
      },
      signer: {
        async sign() {
          calls.push('signer');
          return allowRequestPreparation({ signatureBase64: 'c2lnbmF0dXJl' });
        },
      },
      registrar: {
        async register(input, options) {
          calls.push('registrar');
          executors.push(options?.executor);
          registrarCalls += 1;
          if (registrarCalls === 2) {
            throw new Error('test registration failure');
          }
          if (registrarCalls === 3 && cancellationResponse) cancellationResponse.destroyed = true;
          return evidenceRecord(input);
        },
      },
    },
    preparationOptions: {
      evidenceVerifierKeyId: 'verifier-a',
      idFactory: {
        requestId: () => 'gateway-request-a',
        attemptId: () => 'gateway-attempt-a',
        evidenceId: () => 'gateway-evidence-a',
      },
    },
    dispatch: inertDispatchDependencies(),
    lifecycle: {
      close: async () => {
        closeCalls += 1;
      },
    },
    maxBodyBytes: 1024,
    entryPoint: 'composition-test',
  };

  const composition = createManagedSaasGatewayComposition(dependencies);
  assert.equal(typeof composition.handler, 'function');
  const result = await composition.preparation.prepare(preparationInput());

  assert.equal(result.outcome, 'prepared', JSON.stringify(result));
  if (result.outcome !== 'prepared') return;
  assert.equal(result.requestId, 'gateway-request-a');
  assert.equal(result.attemptId, 'gateway-attempt-a');
  assert.equal(result.evidence.evidenceId, 'gateway-evidence-a');
  assert.equal(transactionCalls, 1);
  assert.deepEqual(executors, [executor, executor, executor]);
  assert.deepEqual(calls, ['caller', 'entitlement', 'authority', 'admission', 'attempt', 'signer', 'registrar']);

  const failed = await composition.preparation.prepare(preparationInput());
  assert.equal(failed.outcome, 'blocked');
  assert.equal(failed.code, 'evidence_registration_failed');
  assert.equal(executors.length, 7);
  assert.equal(new Set(executors).size, 1);
  assert.deepEqual(calls, [
    'caller',
    'entitlement',
    'authority',
    'admission',
    'attempt',
    'signer',
    'registrar',
    'caller',
    'entitlement',
    'authority',
    'admission',
    'attempt',
    'signer',
    'registrar',
    'compensation',
  ]);

  // Exercise the production composition's HTTP cancellation wiring without a
  // socket or upstream: the client disappears while preparation awaits its registrar.
  const request = Object.assign(Readable.from([Buffer.from('{"model":"model-a","messages":[]}')]), {
    method: 'POST', url: '/v1/chat/completions', complete: true, aborted: false,
    headers: { authorization: 'Bearer synthetic-key', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false, destroyed: false, setHeader() {},
  });
  cancellationResponse = response;
  assert.equal(await composition.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse), true);
  assert.equal(transactionCalls, 4, 'preparation and committed-request cleanup each own a separate transaction');
  assert.deepEqual(compensationStages, ['evidence', 'dispatch']);
  assert.equal(calls.at(-1), 'compensation');
  assert.equal(response.listenerCount('close'), 0);

  await composition.close();
  await composition.close();
  assert.equal(closeCalls, 1);
});

test('GET /v1/models intersects key scopes with the same caller, entitlement, and route authority ports', async () => {
  const scopes = ['allowed-model', 'entitlement-denied', 'unpublished-model', 'unsupported-model'];
  const baseKey = authenticatedCaller();
  const scopedKey: AuthenticatedApiKey = {
    metadata: { ...baseKey.metadata, modelScopes: scopes },
    authorization: { ...baseKey.authorization, modelScopes: scopes },
  };
  const callerChecks: string[] = [];
  const entitlementChecks: string[] = [];
  const authorityChecks: string[] = [];
  const dependencies: ManagedSaasGatewayCompositionDependencies = {
    authenticator: {
      authenticate: async (rawKey) => (rawKey === 'test-secret' ? scopedKey : null),
    },
    preparation: {
      caller: {
        async validate(input) {
          callerChecks.push(input.publicModel);
          return allowRequestPreparation({ ...caller(), modelScopes: [...scopes] });
        },
      },
      entitlement: {
        async resolve(input) {
          entitlementChecks.push(input.publicModel);
          if (input.publicModel === 'entitlement-denied') {
            return rejectRequestPreparation('entitlement_denied', 'not entitled');
          }
          return allowRequestPreparation({
            ...entitlement(),
            allowedModels: [...scopes, 'outside-key-scope'],
          });
        },
      },
      authority: {
        async resolve(input) {
          authorityChecks.push(input.publicModel);
          if (input.publicModel === 'unpublished-model') {
            return rejectRequestPreparation('route_denied', 'no published route');
          }
          if (input.publicModel === 'unsupported-model') {
            return rejectRequestPreparation('account_denied', 'unsupported provider capability or rights');
          }
          return allowRequestPreparation({
            ...authority(),
            route: { ...authority().route, publicModel: input.publicModel },
          });
        },
      },
      payload: payloadCompiler(),
      admission: {
        authorizeAndReserve: async (input) => allowRequestPreparation(admission(input)),
      },
      attempt: { persist: async (input) => allowRequestPreparation(attemptRecord(input)) },
      transaction: {
        transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) =>
          work({
            async query<Row>() {
              return { rows: [] as Row[], rowCount: 0 };
            },
          }),
      },
      compensation: {
        releasePreDispatch: async (input) =>
          allowRequestPreparation({
            requestId: input.requestId,
            attemptId: input.attemptId,
            disposition: 'released',
            quotaReservation: 'released',
            rateReservation: 'released',
            holdReservation: 'not_applicable',
            manualReconciliationRequired: false,
          }),
      },
      signer: { sign: async () => allowRequestPreparation({ signatureBase64: 'c2lnbmF0dXJl' }) },
      registrar: { register: async (input) => evidenceRecord(input) },
    },
    preparationOptions: {
      evidenceVerifierKeyId: 'discovery-test-key',
      idFactory: {
        requestId: () => 'discovery-request',
        attemptId: () => 'discovery-attempt',
        evidenceId: () => 'discovery-evidence',
      },
    },
    dispatch: inertDispatchDependencies(),
    lifecycle: { close: async () => {} },
    maxBodyBytes: 1024,
    entryPoint: 'model-discovery-test',
  };

  const composition = createManagedSaasGatewayComposition(dependencies);
  const server = await startHttpServer(composition.handler);
  try {
    const response = await fetch(`${server.origin}/v1/models?tenant_id=client-controlled`, {
      headers: { authorization: 'Bearer test-secret' },
    });
    assert.equal(response.status, 200);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, {
      object: 'list',
      data: [{ id: 'allowed-model', object: 'model', created: 0, owned_by: 'managed-saas' }],
    });
    assert.deepEqual(callerChecks, scopes);
    assert.deepEqual(entitlementChecks, scopes);
    assert.deepEqual(authorityChecks, ['allowed-model', 'unpublished-model', 'unsupported-model']);
    const responseText = JSON.stringify(responseBody);
    for (const internal of ['test-secret', 'tenant-a', 'provider-a', 'account-a', 'credential-a', 'provider.example']) {
      assert.equal(responseText.includes(internal), false);
    }
  } finally {
    await server.close();
    await composition.close();
  }
});

test('managed HTTP boundary shares trusted IDs across 401 and concurrent admission refusals', async () => {
  const generatedIds = ['server-id-401', 'server-id-a', 'server-id-b'];
  const idsIssued: string[] = [];
  const admissionRequestIds: string[] = [];
  let authorityCalls = 0;
  let releaseAuthority!: () => void;
  const bothAuthorities = new Promise<void>((resolve) => {
    releaseAuthority = resolve;
  });
  const composition = createManagedSaasGatewayComposition({
    authenticator: {
      authenticate: async (rawKey) => (rawKey === 'invalid' ? null : authenticatedCaller()),
    },
    preparation: {
      caller: { validate: async () => allowRequestPreparation(caller()) },
      entitlement: { resolve: async () => allowRequestPreparation(entitlement()) },
      authority: {
        async resolve() {
          authorityCalls += 1;
          if (authorityCalls === 2) releaseAuthority();
          await bothAuthorities;
          return allowRequestPreparation(authority());
        },
      },
      payload: payloadCompiler(),
      admission: {
        async authorizeAndReserve(input) {
          admissionRequestIds.push(input.requestId);
          return rejectRequestPreparation('quota_exceeded', 'fixture admission refusal');
        },
      },
      attempt: { persist: async (input) => allowRequestPreparation(attemptRecord(input)) },
      transaction: { transaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }) },
      compensation: {
        releasePreDispatch: async (input) =>
          allowRequestPreparation({
            requestId: input.requestId,
            attemptId: input.attemptId,
            disposition: 'released',
            quotaReservation: 'released',
            rateReservation: 'released',
            holdReservation: 'not_applicable',
            manualReconciliationRequired: false,
          }),
      },
      signer: { sign: async () => allowRequestPreparation({ signatureBase64: 'c2lnbmF0dXJl' }) },
      registrar: { register: async (input) => evidenceRecord(input) },
    },
    preparationOptions: {
      evidenceVerifierKeyId: 'verifier-http',
      idFactory: {
        requestId: () => {
          const requestId = generatedIds[idsIssued.length] ?? `unexpected-id-${idsIssued.length}`;
          idsIssued.push(requestId);
          return requestId;
        },
        attemptId: () => `attempt-${idsIssued.length}`,
        evidenceId: () => `evidence-${idsIssued.length}`,
      },
    },
    dispatch: inertDispatchDependencies(),
    lifecycle: { close: async () => {} },
    maxBodyBytes: 1024,
    entryPoint: 'composition-http-test',
  });
  const server = await startHttpServer(composition.handler);
  try {
    const endpoint = `${server.origin}/v1/chat/completions`;
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer invalid',
        'content-type': 'application/json',
        'x-request-id': 'client-controlled-401',
      },
      body: JSON.stringify({ model: 'model-a', messages: [] }),
    });
    const unauthorizedBody = (await unauthorized.json()) as { error: { requestId: string } };
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('x-request-id'), 'server-id-401');
    assert.equal(unauthorizedBody.error.requestId, 'server-id-401');

    const concurrentResponses = await Promise.all(
      ['client-controlled-a', 'client-controlled-b'].map((spoofedId) =>
        fetch(endpoint, {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid',
            'content-type': 'application/json',
            'x-request-id': spoofedId,
          },
          body: JSON.stringify({ model: 'model-a', messages: [] }),
        }),
      ),
    );
    const concurrentResults = await Promise.all(
      concurrentResponses.map(async (response) => ({
        response,
        body: (await response.json()) as { error: { requestId: string } },
      })),
    );
    for (const { response, body } of concurrentResults) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('x-request-id'), body.error.requestId);
    }
    const expectedConcurrentIds = ['server-id-a', 'server-id-b'];
    assert.deepEqual(concurrentResults.map(({ body }) => body.error.requestId).sort(), expectedConcurrentIds);
    assert.deepEqual([...admissionRequestIds].sort(), expectedConcurrentIds);
    assert.deepEqual(idsIssued, generatedIds);
  } finally {
    await server.close();
    await composition.close();
  }
});

test('standalone handler uses a secure fallback ID and keeps dispatch error header and DTO aligned', async () => {
  const unavailableAuthenticator = createSaasGatewayHandler({
    authenticator: { authenticate: async () => null },
    preparation: {
      prepare: async () => {
        throw new Error('must not prepare an unauthenticated request');
      },
    },
    dispatch: {
      dispatch: async () => {
        throw new Error('must not dispatch an unauthenticated request');
      },
    },
  });
  const fallbackServer = await startHttpServer(unavailableAuthenticator);
  try {
    const response = await fetch(`${fallbackServer.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer invalid',
        'content-type': 'application/json',
        'x-request-id': 'client-controlled-fallback',
      },
      body: JSON.stringify({ model: 'model-a', messages: [] }),
    });
    const body = (await response.json()) as { error: { requestId: string } };
    assert.equal(response.status, 401);
    assert.match(body.error.requestId, /^gateway_[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-request-id'), body.error.requestId);
  } finally {
    await fallbackServer.close();
  }

  const trustedRequestId = 'server-dispatch-error-id';
  const dispatchFailure = createSaasGatewayHandler({
    authenticator: { authenticate: async () => authenticatedCaller() },
    preparation: {
      prepare: async () =>
        ({
          outcome: 'prepared',
          requestId: trustedRequestId,
          evidence: { evidenceId: 'dispatch-error-evidence' },
          payloadBytes: new Uint8Array([1]),
        }) as never,
    },
    dispatch: {
      dispatch: async () => {
        throw new Error('fixture upstream failure');
      },
    },
  });
  const dispatchServer = await startHttpServer(dispatchFailure, trustedRequestId);
  try {
    const response = await fetch(`${dispatchServer.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid',
        'content-type': 'application/json',
        'x-request-id': 'client-controlled-dispatch',
      },
      body: JSON.stringify({ model: 'model-a', messages: [] }),
    });
    const body = (await response.json()) as { error: { requestId: string; code: string } };
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'DISPATCH_FAILED');
    assert.equal(body.error.requestId, trustedRequestId);
    assert.equal(response.headers.get('x-request-id'), trustedRequestId);
  } finally {
    await dispatchServer.close();
  }
});

test('streamed provider headers cannot replace the server request ID', async () => {
  const trustedRequestId = 'server-stream-request-id';
  const handler = createSaasGatewayHandler({
    authenticator: { authenticate: async () => authenticatedCaller() },
    preparation: {
      prepare: async () =>
        ({
          outcome: 'prepared',
          requestId: trustedRequestId,
          evidence: { evidenceId: 'stream-evidence' },
          payloadBytes: new Uint8Array([1]),
        }) as never,
    },
    dispatch: {
      dispatch: async ({ client }) => {
        assert.ok(client, 'HTTP dispatch must receive the client stream');
        client.start(200, {
          'content-type': 'text/event-stream',
          'x-request-id': 'provider-controlled-stream-id',
        });
        await client.write(new TextEncoder().encode('data: {"ok":true}\n\n'));
        client.end();
        return { kind: 'sent' } as never;
      },
    },
  });
  const server = await startHttpServer(handler, trustedRequestId);
  try {
    const response = await fetch(`${server.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid',
        'content-type': 'application/json',
        'x-request-id': 'client-controlled-stream-id',
      },
      body: JSON.stringify({ model: 'model-a', messages: [], stream: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('x-request-id'), trustedRequestId);
    assert.equal(await response.text(), 'data: {"ok":true}\n\n');
  } finally {
    await server.close();
  }
});

test('production builder binds the real database transaction and does not allocate IDs', async () => {
  const healthWrites: Array<{ sql: string; values: readonly unknown[] }> = [];
  const database = {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) =>
      work({
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          if (sql.includes('INSERT INTO saas_provider_account_runtime_health')) {
            healthWrites.push({ sql, values });
            return { rows: [{ revision: healthWrites.length } as Row], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      }),
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  } as unknown as SaasDatabase;
  const endpointPolicy = { allowedHosts: ['provider.example'], allowedPorts: [443] } as const;
  const downstreamAdmissionInputs: unknown[] = [];
  const schedulerAffinity = {
    resolve: async () => ({ decision: 'allow' as const, accountId: null }),
  };
  const options: ManagedSaasGatewayProductionOptions = {
    caller: { validate: async () => allowRequestPreparation(caller()) },
    entitlement: { resolve: async () => allowRequestPreparation(entitlement()) },
    schedulerAffinity,
    admission: {
      authorizeAndReserve: async (input) => {
        downstreamAdmissionInputs.push(input);
        return allowRequestPreparation(admission(input));
      },
    },
    attempt: { persist: async (input) => allowRequestPreparation(attemptRecord(input)) },
    compensation: {
      releasePreDispatch: async (input) =>
        allowRequestPreparation({
          requestId: input.requestId,
          attemptId: input.attemptId,
          disposition: 'released',
          quotaReservation: 'released',
          rateReservation: 'released',
          holdReservation: 'not_applicable',
          manualReconciliationRequired: false,
        }),
    },
    providerPreparationRoute: async () => ({
      clientProtocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      modelResolution: MODEL_RESOLUTION,
    }),
    providerPayload: {
      estimator: {
        version: 'test-estimator-v1',
        estimate: async () => ({
          inputTotalUpperBound: 1,
          inputUncachedUpperBound: 1,
          cacheReadUpperBound: 0,
          cacheWriteUpperBound: 0,
          cacheWrite5mUpperBound: 0,
          cacheWrite1hUpperBound: 0,
          outputTotalUpperBound: 1,
          reasoningOutputUpperBound: 0,
          feasibleInputBuckets: ['input'],
        }),
      },
      modelCompatibility: async () => true,
      maxPayloadBytes: 1024,
      compilerVersion: 'test-compiler-v1',
    },
    evidenceSigner: {
      verifierKeyId: 'verifier-a',
      sign: (input: PreparedRequestEvidenceInput) => ({ ...input, signatureBase64: 'c2lnbmF0dXJl' }),
    } as RequestPreparationSigner,
    evidenceVerifierKeyId: 'verifier-a',
    idFactory: {
      requestId: () => 'gateway-request-b',
      attemptId: () => 'gateway-attempt-b',
      evidenceId: () => 'gateway-evidence-b',
    },
    trustedVerifierPublicKeys: new Map([['verifier-a', 'unused-test-key']]),
    providerTargetResolver: {
      resolve: () => ({
        url: 'https://provider.example/v1',
        method: 'POST',
        endpointPolicy,
      }),
    },
    providerTargetRoute: async () => ({
      productId: 'product-a',
      providerProtocol: 'openai',
      providerOperation: 'chat.completions',
    }),
    providerCredentialUnsealingKms: {
      decryptDataKey: async () => new Uint8Array(32),
      checkReady: async () => {},
      close: async () => {},
    },
    credentialContext: { deployment: 'test', environment: 'test' },
    resolveAuthenticationHeader: async () => 'authorization',
    fetch: async () => new Response('{}', { status: 200 }),
    endpointPolicy,
    timeoutMs: 1000,
    maxConcurrency: 1,
    leaseTtlMs: 1000,
    idempotencyHmacKey: new Uint8Array(32).fill(0x5a),
    maxBodyBytes: 1024,
    entryPoint: 'composition-test',
  };

  const isInvalidConfiguration = (error: unknown): boolean =>
    error instanceof ManagedSaasGatewayCompositionError && error.code === 'INVALID_CONFIGURATION';
  assert.throws(
    () =>
      createManagedSaasGatewayProductionComposition(database, {
        ...options,
        idempotencyHmacKey: undefined,
      }),
    isInvalidConfiguration,
  );
  assert.throws(
    () =>
      createManagedSaasGatewayProductionComposition(database, {
        ...options,
        idempotencyHmacKey: new Uint8Array(31),
      }),
    isInvalidConfiguration,
  );

  const composition = createManagedSaasGatewayProductionComposition(database, options);
  const productionDispatchHealth = (composition.dispatch as unknown as { runtimeHealthWriter: unknown })
    .runtimeHealthWriter;
  assert.ok(productionDispatchHealth instanceof PostgresProviderAccountRuntimeHealthStore);
  const productionDispatch = composition.dispatch as unknown as {
    evidence: PreparedRequestEvidenceDispatchPort;
    metering: PreparedEvidenceMeteringPort;
    leaseProvider: PreparedEvidenceLeaseProvider;
    transport: PreparedEvidenceTransport;
  };
  const productionEvidence: PreparedRequestEvidenceRecord = {
    evidenceId: 'production-dispatch-evidence',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    requestId: 'production-dispatch-request',
    attemptId: 'production-dispatch-attempt',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    publicModel: 'model-a',
    protocol: 'openai',
    requestedModel: MODEL_RESOLUTION.requestedModel,
    mappedModel: MODEL_RESOLUTION.mappedModel,
    resolvedModel: MODEL_RESOLUTION.resolvedModel,
    modelResolution: { ...MODEL_RESOLUTION },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    requestFingerprint: 'c'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    endpoint: 'https://provider.example/v1',
    upstreamId: 'upstream-a',
    accountId: 'account-a',
    credentialId: 'credential-a',
    credentialVersion: '1',
    routeTargetMode: 'tenant_account',
    payloadSha256: 'a'.repeat(64),
    statementSha256: 'b'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: EXPIRES_AT,
  };
  let currentAttempt = dispatchAttemptRecord(productionEvidence);
  productionDispatch.evidence = {
    async preflightForDispatch() {
      return productionEvidence;
    },
    async claimForDispatch() {
      currentAttempt = claimedDispatchAttempt(currentAttempt, productionEvidence);
      return {
        ...productionEvidence,
        status: 'claimed',
        claimedAt: NOW,
        claimedAttemptId: productionEvidence.attemptId,
      };
    },
  };
  const productionScenarios = [
    {
      fencingToken: '701',
      send: async () => ({ responseStarted: true, resultHttpStatus: 200 }),
      resultKind: 'sent',
      healthOutcome: 'gateway_success',
    },
    {
      fencingToken: '702',
      send: async () => {
        throw new ProviderHttpTransportError('NETWORK_ERROR', 'provider network failure');
      },
      resultKind: 'unknown',
      healthOutcome: 'gateway_network_failure',
    },
  ] as const;
  for (const scenario of productionScenarios) {
    currentAttempt = dispatchAttemptRecord(productionEvidence);
    productionDispatch.metering = {
      async getAttempt() {
        return { ...currentAttempt };
      },
      async transitionAttempt(input: AttemptTransitionInput) {
        currentAttempt = transitionedDispatchAttempt(currentAttempt, input);
        return currentAttempt;
      },
      async recordKnownNonSuccessHttpResponse() {
        throw new Error('known non-success response is outside this production health assertion');
      },
    };
    productionDispatch.leaseProvider = {
      async acquire() {
        return {
          fencingToken: scenario.fencingToken,
          renewIntervalMs: 1000,
          async renew() {},
          async release() {},
        };
      },
    };
    productionDispatch.transport = { send: scenario.send };
    const result = await composition.dispatch.dispatch({
      evidenceId: productionEvidence.evidenceId,
      payloadBytes: new Uint8Array([1]),
      audit: { actorUserId: 'user-a', entryPoint: 'production-health-test' },
    });
    assert.equal(result.kind, scenario.resultKind);
  }
  assert.deepEqual(
    healthWrites.map(({ values }) => [values[6], values[9]]),
    [
      ['701', 'gateway_success'],
      ['702', 'gateway_network_failure'],
    ],
  );
  assert.ok(healthWrites.every(({ sql }) => sql.includes('FROM saas_provider_account_leases')));
  const dependencies = (
    composition.preparation as unknown as {
      dependencies: { scheduler: unknown; transaction: unknown; admission: RequestPreparationAdmissionPort };
    }
  ).dependencies;
  assert.ok(dependencies.scheduler instanceof PostgresProviderAccountScheduler);
  const defaultSchedulerDecision = await (dependencies.scheduler as PostgresProviderAccountScheduler).select({
    requestId: 'no-candidates',
    caller: caller(),
    entitlement: entitlement(),
    candidates: [],
    publicModel: 'model-a',
    protocol: 'openai',
  });
  assert.equal(defaultSchedulerDecision.decision, 'reject');
  assert.equal(dependencies.transaction, database);

  const TENANT_ID = '11111111-1111-4111-8111-111111111111';
  const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
  const PROXY_KEY_ID = '33333333-3333-4333-8333-333333333333';
  const REQUEST_A_ID = '44444444-4444-4444-8444-444444444444';
  const REQUEST_B_ID = '55555555-5555-4555-8555-555555555555';
  const persisted = new Map<string, Record<string, unknown>>();
  const claimExecutor: SqlExecutor = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (sql.startsWith('INSERT INTO saas_gateway_request_idempotency_keys')) {
        const [tenantId, projectId, proxyKeyId, keyDigest, fingerprint, version, requestId] = values;
        const identity = [tenantId, projectId, proxyKeyId, keyDigest].join('|');
        if (persisted.has(identity)) return { rows: [], rowCount: 0 };
        persisted.set(identity, {
          projectId,
          proxyKeyId,
          request_fingerprint: fingerprint,
          request_fingerprint_version: version,
          request_id: requestId,
          state: 'in_progress',
          execution_state: 'pending',
        });
        return { rows: [{ request_id: requestId } as Row], rowCount: 1 };
      }
      if (sql.startsWith('SELECT request_fingerprint, request_fingerprint_version')) {
        const [tenantId, projectId, proxyKeyId, keyDigest] = values;
        const row = persisted.get([tenantId, projectId, proxyKeyId, keyDigest].join('|'));
        const canonicalRow = row
          ? {
              ...row,
              canonical_project_id: row.projectId,
              canonical_proxy_key_id: row.proxyKeyId,
              canonical_request_fingerprint: row.request_fingerprint,
              canonical_request_fingerprint_version: row.request_fingerprint_version,
            }
          : null;
        return { rows: canonicalRow ? [canonicalRow as Row] : [], rowCount: canonicalRow ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const wrappedAdmissionInput = (
    requestId: string,
    attemptId: string,
  ): Parameters<RequestPreparationAdmissionPort['authorizeAndReserve']>[0] =>
    ({
      requestId,
      attemptId,
      idempotencyKey: 'client-retry-key',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      proxyKeyId: PROXY_KEY_ID,
      requestFingerprint: 'a'.repeat(64),
      requestFingerprintVersion: 'fingerprint-v1',
      caller: caller(),
      entitlement: entitlement(),
      authority: authority(),
      payloadSha256: 'b'.repeat(64),
      payloadBounds: {
        inputTotalUpperBound: 1,
        inputUncachedUpperBound: 1,
        cacheReadUpperBound: 0,
        cacheWriteUpperBound: 0,
        cacheWrite5mUpperBound: 0,
        cacheWrite1hUpperBound: 0,
        outputTotalUpperBound: 1,
        reasoningOutputUpperBound: 0,
        feasibleInputBuckets: ['input'],
      },
    });
  const firstClaim = await dependencies.admission.authorizeAndReserve(
    wrappedAdmissionInput(REQUEST_A_ID, 'attempt-a'),
    { executor: claimExecutor },
  );
  assert.equal(firstClaim.decision, 'allow');
  assert.equal(downstreamAdmissionInputs.length, 1);
  const forwarded = downstreamAdmissionInputs[0] as {
    idempotencyClaim?: { canonicalRequestId: string; keyDigest: string };
  };
  assert.equal(forwarded.idempotencyClaim?.canonicalRequestId, REQUEST_A_ID);
  assert.match(forwarded.idempotencyClaim?.keyDigest ?? '', /^[0-9a-f]{64}$/);
  const existingMapping = [...persisted.values()][0];
  assert.ok(existingMapping);
  existingMapping.execution_state = 'succeeded';
  const retry = await dependencies.admission.authorizeAndReserve(wrappedAdmissionInput(REQUEST_B_ID, 'attempt-b'), {
    executor: claimExecutor,
  });
  assert.equal(retry.decision, 'reject');
  if (retry.decision === 'reject') {
    assert.equal(retry.code, 'idempotency_replay');
    assert.deepEqual(retry.canonicalRequest, { requestId: REQUEST_A_ID, status: 'completed' });
  }
  assert.equal(downstreamAdmissionInputs.length, 1);
  assert.equal([...persisted.values()][0].request_id, REQUEST_A_ID);
  await composition.close();
});

test('production composition rejects missing affinity or storage before readiness', () => {
  const database = {
    transaction: async <T>(work: (executor: SqlExecutor) => Promise<T>) =>
      work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  } as unknown as SaasDatabase;
  const isMissingDependency = (error: unknown): boolean =>
    error instanceof ManagedSaasGatewayCompositionError && error.code === 'MISSING_DEPENDENCY';

  assert.throws(
    () =>
      createManagedSaasGatewayProductionComposition(database, {
        schedulerAffinity: undefined,
      } as unknown as ManagedSaasGatewayProductionOptions),
    isMissingDependency,
  );
  assert.throws(
    () =>
      createManagedSaasGatewayProductionComposition(
        undefined as unknown as SaasDatabase,
        {
          schedulerAffinity: { resolve: async () => ({ decision: 'allow', accountId: null }) },
        } as unknown as ManagedSaasGatewayProductionOptions,
      ),
    isMissingDependency,
  );
});
