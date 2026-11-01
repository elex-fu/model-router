import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Headers as UndiciHeaders } from 'undici';
import {
  CODEX_ALPHA_SEARCH_URL,
  createAlphaSearchMediaUsagePlan,
  createAlphaSearchUsageUpperBoundEstimator,
} from '../../../src/saas/gateway/codex/alpha-search.js';
import type {
  AuthorizedPlatformUpstreamCandidate,
  ModelResolutionProvenance,
} from '../../../src/saas/gateway/contracts.js';
import {
  createSaasGatewayHandler,
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
  type ProviderHttpDispatchProfileResolveInput,
  type ProviderHttpDispatchProfileResolver,
  type ProviderHttpFetch,
  ProviderHttpTransport,
} from '../../../src/saas/gateway/provider-http-transport.js';
import {
  createProviderPayloadCompiler,
  type ProviderCompiledPayload,
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

const NOW = '2026-10-30T00:00:00.000Z';
const DISPATCH_DEADLINE = '2026-10-30T00:00:30.000Z';
const EXPIRES_AT = '2026-10-30T00:01:00.000Z';
const ENDPOINT_PATH = '/v1/alpha/search';
const CLIENT_REQUEST = {
  model: 'public-model',
  commands: [{ type: 'web_search_run', query: 'model-router alpha search' }],
  settings: { search_context_size: 'medium' },
  // sub2api sanitizeOpenAIAlphaSearchBody: Responses-only fields the ChatGPT
  // alpha endpoint rejects ("Unknown parameter") — the boundary must strip
  // both before the payload is signed.
  prompt_cache_key: 'pc-key',
  store: false,
};
const PROVIDER_RESPONSE = JSON.stringify({
  results: [
    {
      type: 'text_result',
      ref_id: 'turn0search0',
      url: 'https://example.com/model-router',
      title: 'model-router',
    },
  ],
});
const MODEL_RESOLUTION: ModelResolutionProvenance = {
  requestedModel: 'public-model',
  mappedModel: 'catalog-model',
  resolvedModel: 'provider-model',
  mappingSource: 'alias',
  mappingVersion: 1,
};

class FakeIncomingMessage extends EventEmitter {
  readonly socket = { remoteAddress: '127.0.0.1' };
  readonly complete = true;
  readonly headers: IncomingHttpHeaders = {
    'content-type': 'application/json',
    authorization: 'Bearer fake-proxy-key',
  };
  readonly method = 'POST';
  readonly url = ENDPOINT_PATH;
  readonly body: Uint8Array;
  resumed = false;

  constructor(body: unknown = CLIENT_REQUEST) {
    super();
    this.body = new TextEncoder().encode(JSON.stringify(body));
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

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    return this;
  }

  setHeader(): this {
    return this;
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

function authenticatedApiKey(): AuthenticatedApiKey {
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
      modelScopes: ['public-model'],
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
      modelScopes: ['public-model'],
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
    modelScopes: ['public-model'],
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
    allowedModels: ['public-model'],
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
    protocol: 'openai',
    endpoint: 'codex-responses',
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
      publicModel: 'public-model',
      publicModelId: 'public-model-1',
      publicModelVersion: 1,
      routeConfigId: 'route-config-1',
      routeConfigVersion: 1,
      protocol: 'openai',
      providerProtocol: 'openai',
      clientOperation: 'alpha_search',
      providerOperation: 'alpha_search',
      targetMode: 'platform_pool',
      upstreamId: 'upstream-1',
      endpoint: 'codex-responses',
    },
    candidate: candidate(),
    modelMappingRules: [
      { pattern: 'public-model', mappedModel: 'catalog-model', mappingSource: 'alias', mappingVersion: 1 },
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
    // Platform wallet hold reserved from the per-call unit bound.
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
  admissionPayloadBounds: unknown;
}

/**
 * The production payload compiler with the P2-a alpha search estimator: the
 * request body is sanitized (the sub2api Responses-only field strip) and
 * rides the unchanged openai -> openai passthrough bounded per call.
 */
function payloadCompiler(state: PreparationState): RequestPreparationPayloadCompiler {
  const compiler = createProviderPayloadCompiler({
    estimator: createAlphaSearchUsageUpperBoundEstimator(),
    modelResolution: MODEL_RESOLUTION,
    modelCompatibility: (input) =>
      input.providerId === 'provider-1' &&
      input.productId === 'product-1' &&
      input.providerProtocol === 'openai' &&
      input.providerOperation === 'alpha_search',
    maxPayloadBytes: 1024 * 1024,
    compilerVersion: 'alpha-search-e2e-payload-v1',
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

function preparationDependencies(state: PreparationState): RequestPreparationDependencies {
  return {
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
      async resolve(input) {
        state.calls.push('authority');
        // Mirrors the PostgreSQL authority adapter: the trusted-boundary
        // client operation override becomes server-owned route provenance
        // (the alpha_search twin of the embeddings branch).
        const clientOperation = input.clientOperation ?? 'chat.completions';
        return allowRequestPreparation({
          ...authority(),
          route: {
            ...authority().route,
            clientOperation,
            providerOperation: clientOperation === 'alpha_search' ? 'alpha_search' : 'chat.completions',
          },
        });
      },
    },
    payload: payloadCompiler(state),
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
        state.admissionPayloadBounds = input.payloadBounds;
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
}

function preparationService(state: PreparationState): SaasRequestPreparationService {
  return new SaasRequestPreparationService(preparationDependencies(state), {
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
    routeProtocol: 'openai',
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
    protocol: 'openai',
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
  readonly audits: PreparedRequestEvidenceAudit[] = [];

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
}

class FakeMetering implements PreparedEvidenceMeteringPort {
  readonly transitions: AttemptTransitionInput[] = [];
  getAttemptCount = 0;
  current: AttemptRecord | null = null;

  constructor(private readonly state: PreparationState) {}

  async getAttempt(tenantId: string, requestId: string, attemptId: string): Promise<AttemptRecord | null> {
    this.getAttemptCount += 1;
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
    throw new Error('no non-success response is expected in the alpha search chain');
  }
}

interface SettlementCapture {
  readonly completions: Parameters<SettlementPort['complete']>[0][];
}

type SettlementPort = NonNullable<ConstructorParameters<typeof SaasPreparedEvidenceDispatchService>[4]>;

function settlementPort(capture: SettlementCapture, metering: FakeMetering): SettlementPort {
  return {
    async complete(input) {
      capture.completions.push(input);
      assert.ok(metering.current);
      // The real settlement transaction returns the terminal settled attempt.
      return {
        kind: 'settled',
        attempt: {
          ...metering.current,
          resultState: 'succeeded' as const,
          stateVersion: metering.current.stateVersion + 1,
        },
      };
    },
    async retainUnknown(input) {
      throw new Error(`settlement must not retain uncertainty in the alpha search chain: ${input.reason}`);
    },
  };
}

class FakeLeaseProvider implements PreparedEvidenceLeaseProvider {
  acquireCount = 0;
  releaseCount = 0;

  async acquire(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly upstreamId: string;
    readonly attemptId: string;
    readonly evidence: PreparedRequestEvidenceRecord;
  }) {
    this.acquireCount += 1;
    assert.equal(input.tenantId, 'tenant-1');
    assert.equal(input.accountId, 'account-1');
    assert.equal(input.upstreamId, 'upstream-1');
    assert.equal(input.attemptId, 'attempt-1');
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
  readonly headers: UndiciHeaders[];
  readonly payloads: Uint8Array[];
  readonly dispatchProfileInputs: ProviderHttpDispatchProfileResolveInput[];
}

function providerTransport(trace: ProviderTrace): ProviderHttpTransport {
  const fetch: ProviderHttpFetch = async (url, init) => {
    trace.urls.push(url);
    trace.headers.push(new UndiciHeaders(init.headers));
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    const body = init.body;
    assert.ok(body instanceof Uint8Array);
    trace.payloads.push(new Uint8Array(body));
    return new Response(PROVIDER_RESPONSE, {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'fake-provider-request' },
    });
  };
  // Mirrors the builtin codex transport's alpha_search dispatch-profile
  // branch (builtin-provider-transports.ts): the operation owns the URL.
  const resolveDispatchProfile: ProviderHttpDispatchProfileResolver = async (input) => {
    trace.dispatchProfileInputs.push(input);
    if (input.providerProtocol === 'openai' && input.providerOperation === 'alpha_search') {
      return { url: CODEX_ALPHA_SEARCH_URL };
    }
    return null;
  };
  const resolveCredential: ProviderHttpCredentialResolver = async (_input, useCredential) =>
    useCredential({ headerName: 'authorization', value: 'Bearer fake-provider-credential' });

  return new ProviderHttpTransport({
    fetch,
    resolveDispatchProfile,
    resolveCredential,
    endpointPolicy: { allowedHosts: ['chatgpt.com'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    timeoutMs: 1_000,
    // Mirrors the codex transport wiring: the per-call media usage plan rides
    // the 2xx JSON observation branch.
    mediaUsagePlan: createAlphaSearchMediaUsagePlan,
  });
}

function authenticator(calls: string[]): ProxyKeyAuthenticator {
  return {
    async authenticate(rawKey) {
      calls.push(rawKey);
      return authenticatedApiKey();
    },
  };
}

test('P2-a: /v1/alpha/search runs the admission -> per-call hold -> codex forward -> usage -> settlement chain', async () => {
  const preparationState: PreparationState = {
    calls: [],
    registered: [],
    payloads: [],
    admissionPayloadBounds: null,
  };
  const preparation = preparationService(preparationState);
  const metering = new FakeMetering(preparationState);
  const evidence = new FakeEvidenceStore(preparationState, metering);
  const lease = new FakeLeaseProvider();
  const provider: ProviderTrace = { urls: [], headers: [], payloads: [], dispatchProfileInputs: [] };
  const transport = providerTransport(provider);
  const settlementCapture: SettlementCapture = { completions: [] };
  const dispatch = new SaasPreparedEvidenceDispatchService(
    evidence,
    metering,
    lease,
    transport,
    settlementPort(settlementCapture, metering),
  );
  const keyCalls: string[] = [];
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(keyCalls),
    preparation: preparation as RequestPreparationPort,
    dispatch: dispatch as PreparedEvidenceDispatchPort,
    entryPoint: 'alpha-search-e2e-test',
  });
  const response = new FakeServerResponse();

  assert.equal(
    await handler(asRequest(new FakeIncomingMessage()), asResponse(response), { requestId: 'request-1' }),
    true,
  );
  assert.deepEqual(keyCalls, ['fake-proxy-key']);
  assert.deepEqual(preparationState.calls, [
    'caller',
    'entitlement',
    'authority',
    'payload',
    'admission',
    'attempt',
    'signer',
    'registrar',
  ]);

  // Hold basis: the admission guard received the per-call unit bound.
  assert.deepEqual(preparationState.admissionPayloadBounds, {
    inputTotalUpperBound: '0',
    inputUncachedUpperBound: '0',
    cacheReadUpperBound: '0',
    cacheWriteUpperBound: '0',
    cacheWrite5mUpperBound: '0',
    cacheWrite1hUpperBound: '0',
    outputTotalUpperBound: '0',
    reasoningOutputUpperBound: '0',
    feasibleInputBuckets: ['input'],
    perUnitUnitsUpperBound: '1',
  });

  // The prepared route, attempt, and evidence all carry the alpha_search
  // operation under the OpenAI protocol family.
  const registered = preparationState.registered[0];
  assert.ok(registered);
  assert.equal(registered.clientProtocol, 'openai');
  assert.equal(registered.providerProtocol, 'openai');
  assert.equal(registered.clientOperation, 'alpha_search');
  assert.equal(registered.providerOperation, 'alpha_search');
  assert.equal(registered.requestedModel, 'public-model');
  assert.equal(registered.resolvedModel, 'provider-model');

  // Forward: the codex dispatch profile resolves the operation-owned alpha
  // URL (the compact dispatch-profile precedent), and the sanitized
  // passthrough payload keeps the client fields with the provider-resolved
  // model while the sub2api-documented Responses-only fields are gone.
  assert.equal(provider.dispatchProfileInputs.length, 1);
  assert.equal(provider.dispatchProfileInputs[0]?.providerProtocol, 'openai');
  assert.equal(provider.dispatchProfileInputs[0]?.providerOperation, 'alpha_search');
  assert.equal(provider.urls.length, 1);
  assert.equal(provider.urls[0], CODEX_ALPHA_SEARCH_URL);
  assert.equal(provider.headers[0]?.get('authorization'), 'Bearer fake-provider-credential');
  assert.equal(provider.headers[0]?.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(provider.payloads[0])), {
    model: 'provider-model',
    commands: CLIENT_REQUEST.commands,
    settings: CLIENT_REQUEST.settings,
  });
  const forwarded = JSON.parse(new TextDecoder().decode(provider.payloads[0])) as Record<string, unknown>;
  assert.equal(forwarded.prompt_cache_key, undefined);
  assert.equal(forwarded.store, undefined);

  // Usage -> settlement: the per-call media extractor reported exactly one
  // per-request unit and settlement consumed the admission hold snapshot.
  assert.equal(settlementCapture.completions.length, 1);
  const completion = settlementCapture.completions[0];
  assert.ok(completion);
  assert.equal(completion.snapshot.reservationId, 'hold-reservation-1');
  assert.equal(completion.snapshot.providerProtocol, 'openai');
  assert.equal(completion.usage.billingMode, 'per_request');
  assert.equal(completion.usage.units, 1);
  assert.equal(completion.usage.status, 'reported');
  assert.equal(completion.usage.source, 'upstream');

  assert.equal(metering.current?.dispatchState, 'sent');
  assert.equal(metering.transitions.map((transition) => transition.dispatchState).join(','), 'dispatching,sent');
  assert.equal(lease.acquireCount, 1);
  assert.equal(lease.releaseCount, 1);

  // Client response is the untouched provider alpha envelope.
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(response.writeHeadCalls[0]?.headers['content-type'], 'application/json');
  assert.equal(response.bodyText(), PROVIDER_RESPONSE);
  assert.equal(response.endCount, 1);
});
