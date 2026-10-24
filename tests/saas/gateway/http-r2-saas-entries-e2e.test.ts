import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import type {
  AuthorizedPlatformUpstreamCandidate,
  ModelResolutionProvenance,
} from '../../../src/saas/gateway/contracts.js';
import {
  createSaasGatewayHandler,
  type ModelDiscoveryPort,
  type PreparedEvidenceDispatchPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
} from '../../../src/saas/gateway/http-handler.js';
import {
  type PreparedEvidenceLeaseProvider,
  type PreparedEvidenceMeteringPort,
  SaasPreparedEvidenceDispatchService,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  PreparedRequestEvidenceAudit,
  PreparedRequestEvidenceInput,
  PreparedRequestEvidenceRecord,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import {
  type ProviderHttpCredentialResolver,
  type ProviderHttpDispatchProfileResolver,
  type ProviderHttpFetch,
  ProviderHttpTransport,
} from '../../../src/saas/gateway/provider-http-transport.js';
import {
  createProviderPayloadCompiler,
  type ProviderCompiledPayload,
  type ProviderUsageUpperBoundEstimator,
} from '../../../src/saas/gateway/provider-payload-compiler.js';
import {
  allowRequestPreparation,
  type RequestPreparationAdmission,
  type RequestPreparationAttemptPersistenceInput,
  type RequestPreparationAttemptRecord,
  type RequestPreparationAuthority,
  type RequestPreparationCaller,
  type RequestPreparationDecision,
  type RequestPreparationDependencies,
  type RequestPreparationEntitlement,
  type RequestPreparationPayloadCompiler,
  SaasRequestPreparationService,
} from '../../../src/saas/gateway/request-preparation-service.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';
import type { AttemptRecord, AttemptTransitionInput } from '../../../src/saas/metering/types.js';

/*
 * R2 §7.2 SaaS-entry contract tests (T03):
 * - native Gemini inbound (generateContent / streamGenerateContent) runs
 *   the FULL preparation -> admission -> signed-evidence -> dispatch chain
 *   with the public model parsed from the path;
 * - GET /v1beta/models returns only the CURRENT caller's scoped models;
 * - POST /v1/messages/count_tokens enforces auth + model scope + an
 *   independent rate limit and answers under an explicit counting policy;
 * - POST /v1/responses/compact fails closed unless a supply declares
 *   NATIVE compact (opaque compact items are never forged through the
 *   Chat bridge).
 */

const NOW = '2026-10-18T00:00:00.000Z';
const DISPATCH_DEADLINE = '2026-10-18T00:00:30.000Z';
const EXPIRES_AT = '2026-10-18T00:01:00.000Z';
const PUBLIC_MODEL = 'gemini-2.5-pro';
const GEMINI_RESPONSE = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'gemini says hi' }], role: 'model' }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
});
const MODEL_RESOLUTION: ModelResolutionProvenance = {
  requestedModel: PUBLIC_MODEL,
  mappedModel: 'catalog-model',
  resolvedModel: 'provider-model',
  mappingSource: 'alias',
  mappingVersion: 1,
};

class FakeIncomingMessage extends EventEmitter {
  readonly socket = { remoteAddress: '127.0.0.1' };
  readonly complete = true;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly url: string;
  readonly body: Uint8Array;
  resumed = false;

  constructor(options: {
    readonly method?: string;
    readonly url: string;
    readonly body?: unknown;
    readonly headers?: IncomingHttpHeaders;
  }) {
    super();
    this.method = options.method ?? 'POST';
    this.url = options.url;
    this.body = new TextEncoder().encode(JSON.stringify(options.body ?? {}));
    this.headers = {
      'content-type': 'application/json',
      authorization: 'Bearer fake-proxy-key',
      ...options.headers,
    };
  }

  resume(): this {
    this.resumed = true;
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    yield this.body;
  }
}

class FakeServerResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly writeHeadCalls: Array<{ status: number; headers: Record<string, unknown> }> = [];
  readonly writes: Uint8Array[] = [];
  endCount = 0;
  endBody: unknown;
  private readonly headerMap = new Map<string, unknown>();

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    for (const [key, value] of Object.entries(headers)) this.headerMap.set(key, value);
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.headerMap.set(name, value);
    return this;
  }

  getHeader(name: string): unknown {
    return this.headerMap.get(name);
  }

  write(chunk: Uint8Array): boolean {
    this.writes.push(new Uint8Array(chunk));
    return true;
  }

  end(body?: unknown): this {
    this.writableEnded = true;
    this.endCount += 1;
    this.endBody = body;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  bodyText(): string {
    if (this.endBody !== undefined) return String(this.endBody);
    return Buffer.concat(this.writes.map((chunk) => Buffer.from(chunk))).toString('utf8');
  }
}

function asRequest(request: FakeIncomingMessage): IncomingMessage {
  return request as unknown as IncomingMessage;
}

function asResponse(response: FakeServerResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

function authenticatedApiKey(modelScopes: readonly string[] = [PUBLIC_MODEL]): AuthenticatedApiKey {
  return {
    metadata: {
      id: 'proxy-key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalUserId: 'user-1',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-1',
      createdByUserId: 'user-1',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'platform',
      name: 'fake-key',
      prefix: 'mr_test',
      modelScopes: [...modelScopes],
      status: 'active',
      createdAt: NOW,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
    authorization: {
      keyId: 'proxy-key-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      principalKind: 'member',
      principalId: 'user-1',
      entitlementId: 'entitlement-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'platform',
      modelScopes: [...modelScopes],
      authzVersion: 1,
      modelScopeVersion: 1,
      entitlementAuthzVersion: 1,
      supplyProfileAuthzVersion: 1,
    },
  };
}

function caller(): RequestPreparationCaller {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    proxyKeyId: 'proxy-key-1',
    principalKind: 'member',
    principalId: 'user-1',
    entitlementId: 'entitlement-1',
    supplyProfileId: 'profile-1',
    supplyMode: 'platform',
    modelScopes: [PUBLIC_MODEL],
    authzVersion: 1,
    entitlementVersion: 1,
    supplyProfileVersion: 1,
    modelScopeVersion: 1,
  };
}

function entitlement(): RequestPreparationEntitlement {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    proxyKeyId: 'proxy-key-1',
    entitlementId: 'entitlement-1',
    entitlementVersion: 1,
    supplyProfileId: 'profile-1',
    supplyProfileVersion: 1,
    supplyMode: 'platform',
    modelScopeVersion: 1,
    allowedModels: [PUBLIC_MODEL],
    allowedProviderIds: [],
    projectPolicyVersion: 1,
  };
}

function candidate(): AuthorizedPlatformUpstreamCandidate & { providerId: string; productId: string } {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    proxyKeyId: 'proxy-key-1',
    supplyProfileId: 'profile-1',
    supplyMode: 'platform',
    accountOwnerKind: 'platform',
    upstreamId: 'upstream-1',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 1,
    credentialAuthzVersion: 1,
    accountAuthzVersion: 1,
    dispatchProfileId: 'dispatch-profile-1',
    supplyProfileAuthzVersion: 1,
    resolvedModel: 'provider-model',
    protocol: 'gemini',
    endpoint: 'gemini-generate-content',
    supplierCostVersion: 'supplier-cost-1',
    poolId: 'pool-1',
    poolAuthzVersion: 1,
    poolMemberAccountAuthzVersion: 1,
    poolMemberAuthzVersion: 1,
    poolGrantAuthzVersion: 1,
    poolGrantProfileAuthzVersion: 1,
    poolGrantPoolAuthzVersion: 1,
    providerId: 'provider-1',
    productId: 'product-1',
  };
}

function authority(): RequestPreparationAuthority {
  return {
    route: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      publicModel: PUBLIC_MODEL,
      publicModelId: 'public-model-1',
      publicModelVersion: 1,
      routeConfigId: 'route-config-1',
      routeConfigVersion: 1,
      protocol: 'gemini',
      providerProtocol: 'gemini',
      clientOperation: undefined,
      providerOperation: undefined,
      targetMode: 'platform_pool',
      upstreamId: 'upstream-1',
      endpoint: 'gemini-generate-content',
    },
    candidate: candidate(),
    modelMappingRules: [
      { pattern: PUBLIC_MODEL, mappedModel: 'catalog-model', mappingSource: 'alias', mappingVersion: 1 },
    ],
    modelResolution: MODEL_RESOLUTION,
    poolMemberAuthzVersion: 1,
    credentialRef: 'credential-1',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-1',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-1',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-1',
      customerPriceVersion: 'price-version-1',
      supplierCostVersion: 'supplier-cost-1',
    },
  };
}

function admission(
  input: Parameters<RequestPreparationDependencies['admission']['authorizeAndReserve']>[0],
): RequestPreparationAdmission {
  return {
    idempotencyBinding: {
      state: 'created',
      keyDigest: 'd'.repeat(64),
      requestFingerprint: input.requestFingerprint,
      requestFingerprintVersion: input.requestFingerprintVersion,
      tenantId: input.tenantId,
      projectId: input.projectId,
      proxyKeyId: input.proxyKeyId,
      requestId: input.requestId,
    },
    quotaReservation: { reference: 'quota-reservation-1', state: 'reserved' },
    rateReservation: { reference: 'rate-reservation-1', state: 'reserved' },
    holdReservation: {
      state: 'reserved',
      reference: 'hold-reference-1',
      reservationId: 'hold-reservation-1',
      tenantId: input.tenantId,
      requestId: input.requestId,
      currency: 'USD',
      amountMinorUnits: 1000,
      priceSnapshotRef: 'price-snapshot-1',
      expiresAt: EXPIRES_AT,
    },
    deadlineAtMs: Date.parse(DISPATCH_DEADLINE),
    dispatchDeadline: DISPATCH_DEADLINE,
    expiresAt: EXPIRES_AT,
    remainingAttempts: 1,
    retryBudget: 0,
    attemptOrdinal: 1,
    usageBudget: { unit: 'tokens', amount: 32, basis: 'reserved' },
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
    clientProtocol: input.clientProtocol,
    providerProtocol: input.providerProtocol,
    clientOperation: input.clientOperation,
    providerOperation: input.providerOperation,
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
  assert.ok(input.modelResolution, 'the compiled fixture must retain explicit model provenance');
  return {
    evidenceId: input.evidenceId ?? 'missing-evidence-id',
    tenantId: input.tenantId,
    projectId: input.projectId,
    requestId: input.requestId,
    attemptId: input.attemptId,
    attemptOrdinal: input.attemptOrdinal,
    supplyMode: input.supplyMode,
    accountOwnerKind: input.accountOwnerKind,
    publicModel: input.publicModel,
    protocol: input.protocol,
    requestedModel: input.modelResolution.requestedModel,
    mappedModel: input.modelResolution.mappedModel,
    resolvedModel: input.resolvedModel,
    modelResolution: { ...input.modelResolution },
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
    requestFingerprint: input.requestFingerprint,
    requestFingerprintVersion: input.requestFingerprintVersion,
    payloadCompilerVersion: input.payloadCompilerVersion,
    usageEstimatorVersion: input.usageEstimatorVersion,
    payloadSha256: input.payloadSha256,
    statementSha256: 'a'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: new Date(input.expiresAt).toISOString(),
  };
}

interface PreparationState {
  readonly calls: string[];
  readonly registered: PreparedRequestEvidenceRecord[];
  readonly payloads: Uint8Array[];
}

/** A bounded text estimator stub: the gemini chain only proves the seam, not a production estimator. */
const estimator: ProviderUsageUpperBoundEstimator = {
  version: 'gemini-e2e-estimator/v1',
  estimate: () => ({
    inputTotalUpperBound: '10',
    inputUncachedUpperBound: '10',
    cacheReadUpperBound: '0',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '0',
    reasoningOutputUpperBound: '0',
    feasibleInputBuckets: ['input'],
  }),
};

function payloadCompiler(state: PreparationState, compact = false): RequestPreparationPayloadCompiler {
  const compiler = createProviderPayloadCompiler({
    estimator,
    modelResolution: MODEL_RESOLUTION,
    modelCompatibility: (input) =>
      input.providerId === 'provider-1' &&
      input.productId === 'product-1' &&
      input.providerProtocol === (compact ? 'responses' : 'gemini') &&
      input.providerOperation === (compact ? 'responses.compact' : 'generateContent'),
    maxPayloadBytes: 1024 * 1024,
    compilerVersion: 'gemini-e2e-payload-v1',
  });
  return {
    async compile(input) {
      state.calls.push('payload');
      const decision = await compiler.compile(input);
      if (decision.decision === 'allow') {
        state.payloads.push(new Uint8Array(decision.value.payloadBytes));
      }
      return decision as RequestPreparationDecision<ProviderCompiledPayload>;
    },
  };
}

function preparationService(state: PreparationState, compact = false): SaasRequestPreparationService {
  const dependencies: RequestPreparationDependencies = {
    caller: {
      async validate() {
        state.calls.push('caller');
        return allowRequestPreparation(caller());
      },
    },
    entitlement: {
      async resolve() {
        state.calls.push('entitlement');
        return allowRequestPreparation(entitlement());
      },
    },
    authority: {
      async resolve() {
        state.calls.push('authority');
        const value = authority();
        return allowRequestPreparation(
          compact
            ? {
                ...value,
                route: {
                  ...value.route,
                  protocol: 'responses',
                  providerProtocol: 'responses',
                  clientOperation: 'responses.compact',
                  providerOperation: 'responses.compact',
                  endpoint: 'native-responses',
                },
                candidate: { ...value.candidate, protocol: 'responses', endpoint: 'native-responses' },
              }
            : value,
        );
      },
    },
    payload: payloadCompiler(state, compact),
    transaction: {
      async transaction(work) {
        return work({
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            assert.equal(sql, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'unexpected fixture SQL');
            assert.deepEqual(values, []);
            return { rows: [] as Row[], rowCount: 0 };
          },
        });
      },
    },
    admission: {
      async authorizeAndReserve(input) {
        state.calls.push('admission');
        return allowRequestPreparation(admission(input));
      },
    },
    attempt: {
      async persist(input) {
        state.calls.push('attempt');
        return allowRequestPreparation(attemptRecord(input));
      },
    },
    signer: {
      async sign() {
        state.calls.push('signer');
        return allowRequestPreparation({ signatureBase64: 'ZmFrZS1zaWduYXR1cmU=' });
      },
    },
    registrar: {
      async register(input) {
        state.calls.push('registrar');
        const record = evidenceRecord(input);
        state.registered.push(record);
        return allowRequestPreparation(record);
      },
    },
  };
  return new SaasRequestPreparationService(dependencies, {
    evidenceVerifierKeyId: 'verifier-key-1',
    now: () => new Date(NOW),
    idFactory: {
      requestId: () => 'request-1',
      attemptId: () => 'attempt-1',
      evidenceId: () => 'evidence-1',
    },
  });
}

function dispatchAttempt(evidence: PreparedRequestEvidenceRecord): AttemptRecord {
  assert.ok(evidence.modelResolution, 'the registered fixture must retain explicit model provenance');
  return {
    id: evidence.attemptId,
    tenantId: evidence.tenantId,
    requestId: evidence.requestId,
    projectPolicyVersion: '1',
    customerPriceVersion: 'price-version-1',
    customerMeteringPolicyId: 'customer-policy-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-1',
    routeConfigId: 'route-config-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-1',
    routePublicModelVersion: '1',
    routeProtocol: evidence.protocol,
    routeTargetMode: 'platform_pool',
    ordinal: evidence.attemptOrdinal,
    upstreamId: evidence.upstreamId,
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'platform',
    accountId: evidence.accountId,
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: evidence.modelResolution.resolvedModel,
    modelResolution: { ...evidence.modelResolution },
    clientProtocol: evidence.clientProtocol,
    providerProtocol: evidence.providerProtocol,
    clientOperation: evidence.clientOperation,
    providerOperation: evidence.providerOperation,
    requestFingerprint: evidence.requestFingerprint,
    requestFingerprintVersion: evidence.requestFingerprintVersion,
    payloadSha256: evidence.payloadSha256,
    payloadCompilerVersion: evidence.payloadCompilerVersion,
    usageEstimatorVersion: evidence.usageEstimatorVersion,
    protocol: evidence.protocol,
    endpoint: evidence.endpoint,
    supplierCostVersion: 'supplier-cost-1',
    dispatchProfileId: 'dispatch-profile-1',
    supplyProfileAuthzVersion: '1',
    credentialId: evidence.credentialId,
    credentialVersion: evidence.credentialVersion,
    credentialAuthzVersion: '1',
    accountAuthzVersion: '1',
    poolId: null,
    poolAuthzVersion: null,
    poolMemberAccountAuthzVersion: null,
    poolMemberAuthzVersion: null,
    poolGrantAuthzVersion: null,
    poolGrantProfileAuthzVersion: null,
    poolGrantPoolAuthzVersion: null,
    profileAccountAuthzVersion: '1',
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

class FakeEvidenceStore {
  constructor(
    private readonly state: PreparationState,
    private readonly metering: FakeMetering,
  ) {}

  async preflightForDispatch(
    evidenceId: string,
    _audit: PreparedRequestEvidenceAudit,
    options?: { readonly payloadSha256?: string },
  ): Promise<PreparedRequestEvidenceRecord> {
    const registered = this.state.registered.at(-1);
    assert.ok(registered);
    assert.equal(evidenceId, registered.evidenceId);
    assert.equal(options?.payloadSha256, registered.payloadSha256);
    return { ...registered, status: 'registered', claimedAt: null, claimedAttemptId: null };
  }

  async claimForDispatch(
    evidenceId: string,
    audit: PreparedRequestEvidenceAudit,
    options?: { readonly payloadSha256?: string },
  ): Promise<PreparedRequestEvidenceRecord> {
    const registered = this.state.registered.at(-1);
    assert.ok(registered);
    assert.equal(evidenceId, registered.evidenceId);
    assert.equal(options?.payloadSha256, registered.payloadSha256);
    assert.equal(registered.status, 'registered');
    this.metering.claimPreparedEvidence(registered);
    this.audits.push(audit);
    return { ...registered, status: 'claimed', claimedAt: NOW, claimedAttemptId: registered.attemptId };
  }

  readonly audits: PreparedRequestEvidenceAudit[] = [];
}

class FakeMetering implements PreparedEvidenceMeteringPort {
  readonly transitions: AttemptTransitionInput[] = [];
  current: AttemptRecord | null = null;

  constructor(private readonly state: PreparationState) {}

  async getAttempt(tenantId: string, requestId: string, attemptId: string): Promise<AttemptRecord | null> {
    const evidence = this.state.registered.at(-1);
    assert.ok(evidence);
    assert.equal(tenantId, evidence.tenantId);
    assert.equal(requestId, evidence.requestId);
    assert.equal(attemptId, evidence.attemptId);
    this.current ??= dispatchAttempt(evidence);
    return this.current;
  }

  claimPreparedEvidence(evidence: PreparedRequestEvidenceRecord): void {
    assert.ok(this.current);
    this.current = {
      ...this.current,
      preparedEvidenceId: evidence.evidenceId,
      stateVersion: this.current.stateVersion + 1,
      updatedAt: NOW,
    };
  }

  async transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord> {
    assert.ok(this.current);
    assert.equal(input.expectedStateVersion, this.current.stateVersion);
    this.transitions.push(input);
    this.current = {
      ...this.current,
      dispatchState: input.dispatchState ?? this.current.dispatchState,
      resultState: input.resultState ?? this.current.resultState,
      responseStarted: this.current.responseStarted || input.responseStarted === true,
      responseStartedAt:
        input.responseStarted === true ? (this.current.responseStartedAt ?? NOW) : this.current.responseStartedAt,
      resultHttpStatus: input.resultHttpStatus ?? this.current.resultHttpStatus,
      unknownReason: input.unknownReason ?? this.current.unknownReason,
      stateVersion: this.current.stateVersion + 1,
      updatedAt: NOW,
    };
    return this.current;
  }

  async recordKnownNonSuccessHttpResponse(): Promise<AttemptRecord> {
    throw new Error('no non-success response is expected in the gemini native chain');
  }
}

type SettlementPort = NonNullable<ConstructorParameters<typeof SaasPreparedEvidenceDispatchService>[4]>;

class FakeLeaseProvider implements PreparedEvidenceLeaseProvider {
  acquireCount = 0;
  releaseCount = 0;

  async acquire(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly upstreamId: string;
    readonly attemptId: string;
  }) {
    this.acquireCount += 1;
    assert.equal(input.tenantId, 'tenant-1');
    assert.equal(input.accountId, 'account-1');
    return {
      fencingToken: 'fence-1',
      renewIntervalMs: 1_000,
      renew: async () => {},
      release: async () => {
        this.releaseCount += 1;
      },
    };
  }
}

interface ProviderTrace {
  readonly urls: string[];
  readonly payloads: unknown[];
}

function providerTransport(trace: ProviderTrace, compactResponse?: string): ProviderHttpTransport {
  const fetch: ProviderHttpFetch = async (url, init) => {
    trace.urls.push(url);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    const body = init.body;
    assert.ok(body instanceof Uint8Array);
    trace.payloads.push(JSON.parse(new TextDecoder().decode(body)));
    return new Response(compactResponse ?? GEMINI_RESPONSE, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'fake-provider-request' },
    });
  };
  const resolveDispatchProfile: ProviderHttpDispatchProfileResolver = async () => ({
    url: compactResponse
      ? 'https://provider.example/v1/responses/compact'
      : 'https://provider.example/v1beta/models/provider-model:generateContent',
  });
  const resolveCredential: ProviderHttpCredentialResolver = async (_input, useCredential) =>
    useCredential({ headerName: 'authorization', value: 'Bearer fake-provider-credential' });
  return new ProviderHttpTransport({
    fetch,
    resolveDispatchProfile,
    resolveCredential,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    timeoutMs: 1_000,
  });
}

function authenticator(): ProxyKeyAuthenticator {
  return {
    async authenticate() {
      return authenticatedApiKey();
    },
  };
}

function modelDiscovery(models: readonly string[]): ModelDiscoveryPort {
  return {
    async list() {
      return [...models];
    },
  };
}

function strictDispatchGuard(): PreparedEvidenceDispatchPort {
  return {
    async dispatch() {
      throw new Error('dispatch must not run on this path');
    },
  };
}

function strictPreparationGuard(): RequestPreparationPort {
  return {
    async prepare() {
      throw new Error('preparation must not run on this path');
    },
  };
}

const GEMINI_BODY = {
  contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
};

async function runHandler(
  handler: ReturnType<typeof createSaasGatewayHandler>,
  request: FakeIncomingMessage,
): Promise<FakeServerResponse> {
  const response = new FakeServerResponse();
  assert.equal(await handler(asRequest(request), asResponse(response), { requestId: 'request-1' }), true);
  return response;
}

test('R2 §7.2: native Gemini generateContent runs the full preparation -> evidence -> dispatch chain with the model from the path', async () => {
  const state: PreparationState = { calls: [], registered: [], payloads: [] };
  const preparation = preparationService(state);
  const metering = new FakeMetering(state);
  const evidence = new FakeEvidenceStore(state, metering);
  const lease = new FakeLeaseProvider();
  const trace: ProviderTrace = { urls: [], payloads: [] };
  const settlement: SettlementPort = {
    async complete() {
      throw new Error('the generic transport cannot observe gemini usage; settlement stays unknown');
    },
    async retainUnknown() {
      assert.ok(metering.current);
      return metering.current;
    },
  };
  const dispatch = new SaasPreparedEvidenceDispatchService(
    evidence,
    metering,
    lease,
    providerTransport(trace),
    settlement,
  );
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: preparation as RequestPreparationPort,
    dispatch: dispatch as PreparedEvidenceDispatchPort,
    entryPoint: 'gemini-native-e2e-test',
  });
  const response = await runHandler(
    handler,
    new FakeIncomingMessage({ url: `/v1beta/models/${PUBLIC_MODEL}:generateContent`, body: GEMINI_BODY }),
  );

  // The full chain ran: auth -> caller -> entitlement -> authority -> payload
  // -> admission -> attempt -> signer -> registrar -> dispatch.
  assert.deepEqual(state.calls, [
    'caller',
    'entitlement',
    'authority',
    'payload',
    'admission',
    'attempt',
    'signer',
    'registrar',
  ]);
  assert.equal(lease.acquireCount, 1);
  assert.equal(trace.urls.length, 1);
  assert.equal(trace.urls[0], 'https://provider.example/v1beta/models/provider-model:generateContent');

  // Signed evidence: native Gemini inbound provenance, CHECK-legal operation,
  // public model parsed from the PATH (never from the body).
  const registered = state.registered[0];
  assert.ok(registered);
  assert.equal(registered.clientProtocol, 'gemini');
  assert.equal(registered.providerProtocol, 'gemini');
  assert.equal(registered.clientOperation, 'generateContent');
  assert.equal(registered.providerOperation, 'generateContent');
  assert.equal(registered.requestedModel, PUBLIC_MODEL);
  assert.equal(registered.resolvedModel, 'provider-model');
  assert.equal(registered.endpoint, 'gemini-generate-content');

  // The compiled provider payload is the client body (contents preserved) —
  // same-protocol passthrough, no cross-protocol forging.
  assert.deepEqual((trace.payloads[0] as Record<string, unknown>).contents, GEMINI_BODY.contents);

  // The client receives the native Gemini response envelope verbatim.
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(response.bodyText(), GEMINI_RESPONSE);
  assert.equal(response.endCount, 1);
});

test('R2 §7.2: native Gemini streamGenerateContent injects the server-owned stream fact and relays the response', async () => {
  const state: PreparationState = { calls: [], registered: [], payloads: [] };
  const preparation = preparationService(state);
  const metering = new FakeMetering(state);
  const evidence = new FakeEvidenceStore(state, metering);
  const lease = new FakeLeaseProvider();
  const trace: ProviderTrace = { urls: [], payloads: [] };
  const settlement: SettlementPort = {
    async complete() {
      throw new Error('the generic transport cannot observe gemini usage; settlement stays unknown');
    },
    async retainUnknown() {
      assert.ok(metering.current);
      return metering.current;
    },
  };
  const dispatch = new SaasPreparedEvidenceDispatchService(
    evidence,
    metering,
    lease,
    providerTransport(trace),
    settlement,
  );
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: preparation as RequestPreparationPort,
    dispatch: dispatch as PreparedEvidenceDispatchPort,
    entryPoint: 'gemini-native-e2e-test',
  });
  const response = await runHandler(
    handler,
    new FakeIncomingMessage({ url: `/v1beta/models/${PUBLIC_MODEL}:streamGenerateContent`, body: GEMINI_BODY }),
  );

  assert.deepEqual(state.calls, [
    'caller',
    'entitlement',
    'authority',
    'payload',
    'admission',
    'attempt',
    'signer',
    'registrar',
  ]);
  // The trusted boundary set stream=true (native Gemini bodies carry no
  // stream field; the SSE action lives in the path).
  const sentPayload = trace.payloads[0] as Record<string, unknown>;
  assert.equal(sentPayload.stream, true);
  assert.deepEqual(sentPayload.contents, GEMINI_BODY.contents);
  // The registered evidence still carries the single canonical operation.
  assert.equal(state.registered[0]?.clientOperation, 'generateContent');
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(response.bodyText(), GEMINI_RESPONSE);
});

test('R2 §7.2: unknown /v1beta paths 404 and wrong-method Gemini native paths answer 405', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const notFound = await runHandler(handler, new FakeIncomingMessage({ url: '/v1beta/other', body: GEMINI_BODY }));
  assert.equal(notFound.writeHeadCalls[0]?.status, 404);
  assert.equal(JSON.parse(notFound.bodyText()).error.code, 'NOT_FOUND');
  const unknownAction = await runHandler(
    handler,
    new FakeIncomingMessage({ url: `/v1beta/models/${PUBLIC_MODEL}:countTokens`, body: GEMINI_BODY }),
  );
  assert.equal(unknownAction.writeHeadCalls[0]?.status, 404);
  const wrongMethod = await runHandler(
    handler,
    new FakeIncomingMessage({ method: 'GET', url: `/v1beta/models/${PUBLIC_MODEL}:generateContent` }),
  );
  assert.equal(wrongMethod.writeHeadCalls[0]?.status, 405);
  assert.equal(JSON.parse(wrongMethod.bodyText()).error.code, 'METHOD_NOT_ALLOWED');
});

test("R2 §7.2: GET /v1beta/models returns only the current caller's scoped models in the Gemini envelope", async () => {
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        // Key A: only gemini-2.5-pro is in scope, even though the assembled
        // catalog also serves gemini-2.5-flash.
        return authenticatedApiKey([PUBLIC_MODEL]);
      },
    },
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const response = await runHandler(handler, new FakeIncomingMessage({ method: 'GET', url: '/v1beta/models' }));
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.deepEqual(JSON.parse(response.bodyText()), {
    models: [{ name: `models/${PUBLIC_MODEL}`, displayName: PUBLIC_MODEL }],
  });
});

test('R2 §7.2: GET /v1beta/models fails closed on unauthenticated callers, wrong methods, and absent discovery', async () => {
  const unauthenticated = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return null;
      },
    },
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const noKey = await runHandler(unauthenticated, new FakeIncomingMessage({ method: 'GET', url: '/v1beta/models' }));
  assert.equal(noKey.writeHeadCalls[0]?.status, 401);

  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const wrongMethod = await runHandler(handler, new FakeIncomingMessage({ method: 'POST', url: '/v1beta/models' }));
  assert.equal(wrongMethod.writeHeadCalls[0]?.status, 405);

  const noDiscovery = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
  });
  const unavailable = await runHandler(noDiscovery, new FakeIncomingMessage({ method: 'GET', url: '/v1beta/models' }));
  assert.equal(unavailable.writeHeadCalls[0]?.status, 503);
});

test('R2 §7.2: POST /v1/messages/count_tokens authenticates, scope-checks, rate-limits, and labels the estimate policy', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
    countTokensRateLimitPerMinute: 2,
  });
  const body = { model: PUBLIC_MODEL, messages: [{ role: 'user', content: 'hello world, count me' }] };
  const first = await runHandler(handler, new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body }));
  assert.equal(first.writeHeadCalls[0]?.status, 200);
  assert.deepEqual(JSON.parse(first.bodyText()), { input_tokens: 6 });
  assert.equal(first.writeHeadCalls[0]?.headers['x-model-router-count-policy'], 'local-estimate');

  // Independent rate limit: the second call fits, the third is 429 with
  // Retry-After — without ever touching the generation admission path.
  const second = await runHandler(handler, new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body }));
  assert.equal(second.writeHeadCalls[0]?.status, 200);
  const third = await runHandler(handler, new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body }));
  assert.equal(third.writeHeadCalls[0]?.status, 429);
  assert.equal(JSON.parse(third.bodyText()).error.code, 'RATE_LIMITED');
  assert.ok(Number(third.writeHeadCalls[0]?.headers['retry-after']) >= 1);
});

test('R2 §7.2: count_tokens enforces model scope and method, and never bypasses auth', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  // Out-of-scope model: the key cannot see other-model, so the request is
  // rejected exactly like a preparation-stage scope denial.
  const outOfScope = await runHandler(
    handler,
    new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body: { model: 'other-model', messages: [] } }),
  );
  assert.equal(outOfScope.writeHeadCalls[0]?.status, 403);
  assert.equal(JSON.parse(outOfScope.bodyText()).error.code, 'REQUEST_REJECTED');

  const wrongMethod = await runHandler(
    handler,
    new FakeIncomingMessage({ method: 'GET', url: '/v1/messages/count_tokens' }),
  );
  assert.equal(wrongMethod.writeHeadCalls[0]?.status, 405);

  const unauthenticated = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return null;
      },
    },
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const noKey = await runHandler(
    unauthenticated,
    new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body: { model: PUBLIC_MODEL, messages: [] } }),
  );
  assert.equal(noKey.writeHeadCalls[0]?.status, 401);

  // A supply that declares native counting fails closed (501) rather than
  // silently substituting the local estimate.
  const nativeDeclared = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
    countTokensNativeSupply: () => true,
  });
  const native = await runHandler(
    nativeDeclared,
    new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body: { model: PUBLIC_MODEL, messages: [] } }),
  );
  assert.equal(native.writeHeadCalls[0]?.status, 501);
  assert.equal(JSON.parse(native.bodyText()).error.code, 'NATIVE_COUNT_TOKENS_UNAVAILABLE');
});

test('R2 §7.2: POST /v1/responses/compact fails closed without a declared native-compact supply', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const response = await runHandler(
    handler,
    new FakeIncomingMessage({ url: '/v1/responses/compact', body: { model: PUBLIC_MODEL, input: [] } }),
  );
  // A supply without the declared native-compact capability is a MISSING
  // capability (the embeddings 404 precedent) — opaque compact items are
  // never forged through the Chat bridge.
  assert.equal(response.writeHeadCalls[0]?.status, 404);
  const error = JSON.parse(response.bodyText()).error;
  assert.equal(error.code, 'CAPABILITY_UNSUPPORTED');
  assert.match(error.message, /native compact/);

  const wrongMethod = await runHandler(
    handler,
    new FakeIncomingMessage({ method: 'GET', url: '/v1/responses/compact' }),
  );
  assert.equal(wrongMethod.writeHeadCalls[0]?.status, 405);

  const outOfScope = await runHandler(
    handler,
    new FakeIncomingMessage({ url: '/v1/responses/compact', body: { model: 'other-model', input: [] } }),
  );
  assert.equal(outOfScope.writeHeadCalls[0]?.status, 403);

  // A declared supply now enters preparation; a missing preparation
  // authority fails closed before dispatch.
  const declared = createSaasGatewayHandler({
    authenticator: authenticator(),
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
    responsesCompactNativeSupply: () => true,
  });
  const declaredResponse = await runHandler(
    declared,
    new FakeIncomingMessage({ url: '/v1/responses/compact', body: { model: PUBLIC_MODEL, input: [] } }),
  );
  assert.equal(declaredResponse.writeHeadCalls[0]?.status, 503);
  assert.equal(JSON.parse(declaredResponse.bodyText()).error.code, 'PREPARATION_UNAVAILABLE');
});

test('native compact traverses admission/evidence/dispatch, preserves opaque items and settles reported usage', async () => {
  const state: PreparationState = { calls: [], registered: [], payloads: [] };
  const metering = new FakeMetering(state);
  const lease = new FakeLeaseProvider();
  const trace: ProviderTrace = { urls: [], payloads: [] };
  const opaque = { type: 'compaction', id: 'compact-item', encrypted_content: 'opaque-provider-state' };
  const providerBody = JSON.stringify({
    id: 'compact-result',
    object: 'response.compaction',
    output: [opaque],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });
  let settled = 0;
  const dispatch = new SaasPreparedEvidenceDispatchService(
    new FakeEvidenceStore(state, metering),
    metering,
    lease,
    providerTransport(trace, providerBody),
    {
      async complete(input) {
        settled += 1;
        assert.equal(input.usage.inputTotal, 5);
        assert.equal(input.usage.outputTotal, 2);
        assert.ok(metering.current);
        return { kind: 'settled', attempt: metering.current };
      },
      async retainUnknown() {
        throw new Error('native compact usage must settle');
      },
    },
  );
  const response = await runHandler(
    createSaasGatewayHandler({
      authenticator: authenticator(),
      preparation: preparationService(state, true),
      dispatch,
      responsesCompactNativeSupply: () => true,
    }),
    new FakeIncomingMessage({
      url: '/v1/responses/compact',
      body: {
        model: PUBLIC_MODEL,
        input: [{ role: 'user', content: 'a long conversation' }, opaque],
        instructions: 'retain project decisions',
      },
    }),
  );
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(response.bodyText(), providerBody);
  assert.equal(trace.urls[0], 'https://provider.example/v1/responses/compact');
  assert.deepEqual((trace.payloads[0] as { input: unknown[] }).input[1], opaque);
  assert.ok(state.calls.includes('admission'));
  assert.equal(state.registered[0]?.clientOperation, 'responses.compact');
  assert.equal(state.registered[0]?.providerOperation, 'responses.compact');
  assert.equal(settled, 1);
  assert.equal(lease.releaseCount, 1);
});

test('R2 §7.2: an unauthenticated count_tokens/compact caller never reaches admission', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        throw new Error('authenticator outage');
      },
    },
    preparation: strictPreparationGuard(),
    dispatch: strictDispatchGuard(),
    modelDiscovery: modelDiscovery([PUBLIC_MODEL]),
  });
  const response = await runHandler(
    handler,
    new FakeIncomingMessage({ url: '/v1/messages/count_tokens', body: { model: PUBLIC_MODEL, messages: [] } }),
  );
  assert.equal(response.writeHeadCalls[0]?.status, 503);
  assert.equal(JSON.parse(response.bodyText()).error.code, 'AUTHENTICATION_UNAVAILABLE');
});
