import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';

import type { ModelResolutionProvenance } from '../../../src/saas/gateway/contracts.js';
import type { NormalSuccessObservedUsage } from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import { GrokPreparedEvidenceTransport } from '../../../src/saas/gateway/grok/transport.js';
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
import { createSearchUsageUpperBoundEstimator } from '../../../src/saas/gateway/websearch/usage.js';
import type { AuthenticatedApiKey } from '../../../src/saas/keys/types.js';
import type { AttemptRecord, AttemptTransitionInput } from '../../../src/saas/metering/types.js';

/**
 * §4.3 (task #17): /v1/web_search end-to-end — the production payload
 * compiler (server-owned Responses emulation construction), the real grok
 * transport with a mock upstream, the real dispatch service, and the
 * per-call billing settlement.
 */

const NOW = '2026-10-17T00:00:00.000Z';
const DISPATCH_DEADLINE = '2026-10-17T00:00:30.000Z';
const EXPIRES_AT = '2026-10-17T00:01:00.000Z';
const ENDPOINT_PATH = '/v1/web_search';
const CLIENT_REQUEST = {
  model: 'public-model',
  query: 'latest model router news',
  max_results: 3,
};
const PROVIDER_RESPONSE = JSON.stringify({
  id: 'resp_search_1',
  object: 'response',
  status: 'completed',
  output: [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'latest model router news',
        sources: [
          { type: 'url', url: 'https://router.example.com/release', title: 'Release notes', snippet: 'raw' },
          { type: 'url', url: 'https://blog.example.org/router' },
        ],
      },
    },
    {
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: '{"results":[{"url":"https://router.example.com/release","title":"v2 is out","snippet":"enriched"},{"url":"https://invented.example.net/nope","title":"fabricated","snippet":"never visited"}]}',
          annotations: [],
        },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 60 },
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
  readonly url: string;
  readonly body: Uint8Array;
  resumed = false;

  constructor(body: unknown = CLIENT_REQUEST, url: string = ENDPOINT_PATH) {
    super();
    this.url = url;
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
  const base = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    supplyProfileId: 'profile-1',
    supplyMode: 'platform',
    modelScopes: ['public-model'],
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementAuthzVersion: 1,
    supplyProfileAuthzVersion: 1,
  };
  return {
    metadata: {
      id: 'proxy-key-1',
      principalUserId: 'user-1',
      executionPrincipalType: 'member',
      executionPrincipalId: 'user-1',
      createdByUserId: 'user-1',
      rotatedByUserId: null,
      revokedByUserId: null,
      entitlementId: 'entitlement-1',
      name: 'fake-key',
      prefix: 'mr_test',
      status: 'active',
      createdAt: NOW,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      ...base,
    },
    authorization: {
      keyId: 'proxy-key-1',
      principalKind: 'member',
      principalId: 'user-1',
      entitlementId: 'entitlement-1',
      ...base,
    },
  } as AuthenticatedApiKey;
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

function authority(overrides: { readonly providerProtocol?: string } = {}): RequestPreparationAuthority {
  const providerProtocol = overrides.providerProtocol ?? 'responses';
  return {
    route: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      publicModel: 'public-model',
      publicModelId: 'public-model-1',
      publicModelVersion: 1,
      routeConfigId: 'route-config-1',
      routeConfigVersion: 1,
      protocol: 'responses',
      providerProtocol: providerProtocol as 'responses',
      targetMode: 'platform_pool',
      upstreamId: 'upstream-1',
      endpoint: 'grok-responses',
    },
    candidate: {
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
      protocol: providerProtocol as 'responses',
      endpoint: 'grok-responses',
      supplierCostVersion: 'supplier-cost-1',
      poolId: 'pool-1',
      poolAuthzVersion: 1,
      poolMemberAccountAuthzVersion: 1,
      poolMemberAuthzVersion: 1,
      poolGrantAuthzVersion: 1,
      poolGrantProfileAuthzVersion: 1,
      poolGrantPoolAuthzVersion: 1,
      providerId: 'xai-grok',
      productId: 'grok-subscription',
    },
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
  } as RequestPreparationAuthority;
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
      amountMinorUnits: 100,
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
  readonly admissionPayloadBounds: unknown[];
  readonly requestIds: string[];
}

function payloadCompiler(state: PreparationState): RequestPreparationPayloadCompiler {
  const compiler = createProviderPayloadCompiler({
    estimator: createSearchUsageUpperBoundEstimator(),
    modelResolution: MODEL_RESOLUTION,
    modelCompatibility: (input) =>
      input.providerId === 'xai-grok' &&
      input.productId === 'grok-subscription' &&
      input.providerProtocol === 'responses' &&
      (input.providerOperation === 'web_search' || input.providerOperation === 'x_search'),
    maxPayloadBytes: 1024 * 1024,
    compilerVersion: 'search-e2e-payload-v1',
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

function preparationDependencies(
  state: PreparationState,
  authorityDecision: RequestPreparationDecision<RequestPreparationAuthority>,
): RequestPreparationDependencies {
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
      async resolve() {
        state.calls.push('authority');
        return authorityDecision;
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
        state.admissionPayloadBounds.push(input.payloadBounds);
        state.requestIds.push(input.requestId);
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

function preparationService(
  state: PreparationState,
  authorityDecision: RequestPreparationDecision<RequestPreparationAuthority> = allowRequestPreparation(authority()),
  requestId = 'request-1',
): SaasRequestPreparationService {
  return new SaasRequestPreparationService(preparationDependencies(state, authorityDecision), {
    evidenceVerifierKeyId: 'verifier-key-1',
    now: () => new Date(NOW),
    idFactory: {
      requestId: () => requestId,
      attemptId: () => `${requestId}-attempt-1`,
      evidenceId: () => `${requestId}-evidence-1`,
    },
  });
}

function dispatchAttempt(evidence: PreparedRequestEvidenceRecord): AttemptRecord {
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
    routeProtocol: 'responses',
    routeTargetMode: 'platform_pool',
    ordinal: evidence.attemptOrdinal,
    upstreamId: evidence.upstreamId,
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'platform',
    accountId: evidence.accountId,
    providerId: 'xai-grok',
    productId: 'grok-subscription',
    resolvedModel: evidence.resolvedModel ?? 'provider-model',
    modelResolution: evidence.modelResolution ? { ...evidence.modelResolution } : MODEL_RESOLUTION,
    clientProtocol: evidence.clientProtocol,
    providerProtocol: evidence.providerProtocol,
    clientOperation: evidence.clientOperation,
    providerOperation: evidence.providerOperation,
    requestFingerprint: evidence.requestFingerprint,
    requestFingerprintVersion: evidence.requestFingerprintVersion,
    payloadSha256: evidence.payloadSha256,
    payloadCompilerVersion: evidence.payloadCompilerVersion,
    usageEstimatorVersion: evidence.usageEstimatorVersion,
    protocol: 'responses',
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
    throw new Error('no non-success response is expected in the search chain');
  }
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

type SettlementPort = NonNullable<ConstructorParameters<typeof SaasPreparedEvidenceDispatchService>[4]>;

interface SettlementCapture {
  readonly completions: Array<{
    readonly requestId: string;
    readonly usage: NormalSuccessObservedUsage;
    readonly snapshot: { readonly reservationId: string | null; readonly providerProtocol: string };
  }>;
}

function settlementPort(capture: SettlementCapture, metering: FakeMetering): SettlementPort {
  return {
    async complete(input) {
      capture.completions.push({
        requestId: input.requestId,
        usage: input.usage,
        snapshot: { reservationId: input.snapshot.reservationId, providerProtocol: input.snapshot.providerProtocol },
      });
      assert.ok(metering.current);
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
      throw new Error(`settlement must not retain uncertainty in the search chain: ${input.reason}`);
    },
  };
}

class FakeLeaseProvider implements PreparedEvidenceLeaseProvider {
  async acquire(input: { readonly evidence: PreparedRequestEvidenceRecord }) {
    return {
      fencingToken: `fence-${input.evidence.attemptId}`,
      renewIntervalMs: 1_000,
      renew: async () => {},
      release: async () => {},
    };
  }
}

interface UpstreamTrace {
  readonly urls: string[];
  readonly bodies: Array<Record<string, unknown>>;
  readonly headers: Array<Record<string, unknown>>;
}

function grokTransport(trace: UpstreamTrace): GrokPreparedEvidenceTransport {
  return new GrokPreparedEvidenceTransport({
    fetch: async (url, init) => {
      trace.urls.push(url);
      trace.headers.push(init.headers as Record<string, unknown>);
      const body = init.body;
      assert.ok(body instanceof Uint8Array);
      trace.bodies.push(JSON.parse(Buffer.from(body).toString('utf8')));
      return new Response(PROVIDER_RESPONSE, {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'grok-request-1' },
      });
    },
    resolveCredential: async (_input, useCredential) =>
      useCredential({
        kind: 'api-key',
        apiKey: ['xai', 'test', 'credential'].join('-'),
      }),
    resolveRequestContext: (evidence) => ({
      model: evidence.resolvedModel ?? 'provider-model',
      stream: false,
      upstreamPath: 'responses',
      credentialKind: 'api-key',
      conversationId: null,
    }),
    timeoutMs: 1_000,
  });
}

async function runSearchRequest(
  requestId: string,
  body: unknown = CLIENT_REQUEST,
): Promise<{
  readonly response: FakeServerResponse;
  readonly state: PreparationState;
  readonly trace: UpstreamTrace;
  readonly settlement: SettlementCapture;
  readonly metering: FakeMetering;
}> {
  const state: PreparationState = {
    calls: [],
    registered: [],
    payloads: [],
    admissionPayloadBounds: [],
    requestIds: [],
  };
  const preparation = preparationService(state, allowRequestPreparation(authority()), requestId);
  const metering = new FakeMetering(state);
  const evidence = new FakeEvidenceStore(state, metering);
  const lease = new FakeLeaseProvider();
  const trace: UpstreamTrace = { urls: [], bodies: [], headers: [] };
  const transport = grokTransport(trace);
  const settlement: SettlementCapture = { completions: [] };
  const dispatch = new SaasPreparedEvidenceDispatchService(
    evidence,
    metering,
    lease,
    transport,
    settlementPort(settlement, metering),
  );
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return authenticatedApiKey();
      },
    },
    preparation: preparation as RequestPreparationPort,
    dispatch: dispatch as PreparedEvidenceDispatchPort,
    entryPoint: 'search-e2e-test',
  });
  const response = new FakeServerResponse();
  const request = new FakeIncomingMessage(body);
  assert.equal(await handler(asRequest(request), asResponse(response), { requestId }), true);
  return { response, state, trace, settlement, metering };
}

test('4.3: /v1/web_search runs the full chain — construction, whitelist transform, per-call settlement', async () => {
  const run = await runSearchRequest('request-1');
  assert.deepEqual(run.state.calls, [
    'caller',
    'entitlement',
    'authority',
    'payload',
    'admission',
    'attempt',
    'signer',
    'registrar',
  ]);

  // Hold basis: the per-call upper bound (one unit, no tokens, no tier).
  assert.equal(run.state.admissionPayloadBounds.length, 1);
  assert.deepEqual(run.state.admissionPayloadBounds[0], {
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

  // The prepared evidence carries the search operation under the responses family.
  const registered = run.state.registered[0];
  assert.ok(registered);
  assert.equal(registered.clientProtocol, 'responses');
  assert.equal(registered.providerProtocol, 'responses');
  assert.equal(registered.clientOperation, 'web_search');
  assert.equal(registered.providerOperation, 'web_search');

  // Forward: the grok transport dialed /v1/responses with the server-built
  // emulation body (the client body never rides upstream).
  assert.equal(run.trace.urls.length, 1);
  assert.equal(run.trace.urls[0], 'https://api.x.ai/v1/responses');
  const upstream = run.trace.bodies[0];
  assert.ok(upstream);
  assert.equal(upstream.model, 'provider-model');
  assert.deepEqual(upstream.tools, [{ type: 'web_search' }]);
  assert.deepEqual(upstream.include, ['web_search_call.action.sources']);
  assert.equal(upstream.store, false);
  assert.equal(upstream.stream, false);
  assert.match(upstream.input as string, /at most 3 unique results/);
  assert.match(upstream.input as string, /User query:\nlatest model router news$/);
  assert.equal(run.trace.headers[0]?.['x-xai-token-auth'], undefined, 'no CLI identity on api.x.ai');

  // Settlement: one per-call unit (the per-call SearchCount price), never tokens.
  assert.equal(run.settlement.completions.length, 1);
  const completion = run.settlement.completions[0];
  assert.ok(completion);
  assert.equal(completion.requestId, 'request-1');
  assert.equal(completion.usage.billingMode, 'per_request');
  assert.equal(completion.usage.units, 1);
  assert.equal(completion.usage.inputTotal, null);
  assert.equal(completion.usage.source, 'upstream');
  assert.equal(run.metering.current?.dispatchState, 'sent');

  // Client body: the whitelist-filtered search response — the fabricated URL
  // never left the gateway; the raw source padded the shortfall.
  assert.equal(run.response.writeHeadCalls[0]?.status, 200);
  const clientBody = JSON.parse(run.response.bodyText());
  assert.equal(clientBody.query, 'latest model router news');
  assert.equal(clientBody.max_results, 3);
  assert.equal(clientBody.provider, 'responses-search-emulation');
  assert.equal(clientBody.results.length, 2);
  assert.deepEqual(clientBody.results[0], {
    url: 'https://router.example.com/release',
    title: 'v2 is out',
    snippet: 'enriched',
  });
  assert.equal(clientBody.results[1].url, 'https://blog.example.org/router');
  assert.ok(!run.response.bodyText().includes('invented.example.net'));
});

test('4.3: two identical searches bill twice — billing identity is per call, never per query', async () => {
  const first = await runSearchRequest('request-a');
  const second = await runSearchRequest('request-b');
  assert.equal(first.settlement.completions.length, 1);
  assert.equal(second.settlement.completions.length, 1);
  assert.equal(first.settlement.completions[0]?.requestId, 'request-a');
  assert.equal(second.settlement.completions[0]?.requestId, 'request-b');
  // Same query, two distinct admissions (no query-derived idempotency collapse).
  assert.deepEqual(first.state.requestIds, ['request-a']);
  assert.deepEqual(second.state.requestIds, ['request-b']);
});

test('4.3: a search request routed to a non-responses provider protocol fails capability-closed', async () => {
  const state: PreparationState = {
    calls: [],
    registered: [],
    payloads: [],
    admissionPayloadBounds: [],
    requestIds: [],
  };
  // The authority offers an OpenAI-protocol provider for this Responses
  // client route; the client's path-derived search override carries the
  // provider-side operation to web_search, which only responses-protocol
  // providers serve → capability miss at the compiler's family gate.
  const openaiAuthority = authority({ providerProtocol: 'openai' });
  const preparation = preparationService(
    state,
    allowRequestPreparation({
      ...openaiAuthority,
      candidate: {
        ...openaiAuthority.candidate,
        protocol: 'responses',
        endpoint: 'grok-responses',
      },
    }),
    'request-1',
  );
  let dispatchCalls = 0;
  const dispatch: PreparedEvidenceDispatchPort = {
    async dispatch() {
      dispatchCalls += 1;
      throw new Error('dispatch must not run for an unsupported capability');
    },
  };
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return authenticatedApiKey();
      },
    },
    preparation: preparation as RequestPreparationPort,
    dispatch,
  });
  const response = new FakeServerResponse();
  assert.equal(
    await handler(asRequest(new FakeIncomingMessage()), asResponse(response), { requestId: 'request-1' }),
    true,
  );
  assert.equal(response.writeHeadCalls[0]?.status, 404);
  assert.equal(JSON.parse(response.bodyText()).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(dispatchCalls, 0);
  assert.deepEqual(state.calls, ['caller', 'entitlement', 'authority', 'payload']);
});

test('4.3: search input validation — missing query and wrong model are rejected before any dispatch', async () => {
  const state: PreparationState = {
    calls: [],
    registered: [],
    payloads: [],
    admissionPayloadBounds: [],
    requestIds: [],
  };
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return authenticatedApiKey();
      },
    },
    preparation: preparationService(state) as RequestPreparationPort,
    dispatch: {
      async dispatch() {
        throw new Error('dispatch must not run');
      },
    },
  });
  for (const body of [
    // Missing query / blank query / invalid max_results: the server-owned
    // construction fails closed at the payload stage (503 REQUEST_BLOCKED).
    { model: 'public-model' },
    { model: 'public-model', query: '   ' },
    { model: 'public-model', query: 'q', max_results: 'nope' },
    // A model the caller is not entitled to: 403 at entitlement.
    { model: 'other-model', query: 'q' },
  ]) {
    const response = new FakeServerResponse();
    assert.equal(
      await handler(asRequest(new FakeIncomingMessage(body)), asResponse(response), { requestId: 'request-1' }),
      true,
    );
    const status = response.writeHeadCalls[0]?.status;
    assert.ok(
      status === 400 || status === 403 || status === 503,
      `unexpected status ${status} for ${JSON.stringify(body)}`,
    );
    assert.equal(response.writeHeadCalls[0]?.headers['content-type'], 'application/json; charset=utf-8');
  }
  // Nothing was admitted, attempted, or dispatched.
  assert.equal(state.registered.length, 0);
  assert.deepEqual(
    state.calls.filter((call) => call === 'admission' || call === 'attempt' || call === 'dispatch'),
    [],
  );
});

test('4.3: /v1/web_search rejects GET (405) and /v1/x_search is a registered POST route', async () => {
  const handler = createSaasGatewayHandler({
    authenticator: {
      async authenticate() {
        return authenticatedApiKey();
      },
    },
    preparation: {
      async prepare() {
        throw new Error('not reached');
      },
    },
    dispatch: {
      async dispatch() {
        throw new Error('not reached');
      },
    },
  });
  const getResponse = new FakeServerResponse();
  const getRequest = new FakeIncomingMessage();
  Object.defineProperty(getRequest, 'method', { value: 'GET' });
  assert.equal(await handler(asRequest(getRequest), asResponse(getResponse)), true);
  assert.equal(getResponse.writeHeadCalls[0]?.status, 405);

  // x_search POST reaches preparation (fails at the fake port → 503).
  const postResponse = new FakeServerResponse();
  const postRequest = new FakeIncomingMessage({ model: 'public-model', query: 'q' }, '/v1/x_search');
  Object.assign(postRequest.headers, {});
  assert.equal(await handler(asRequest(postRequest), asResponse(postResponse)), true);
  assert.equal(postResponse.writeHeadCalls[0]?.status, 503);
  assert.equal(JSON.parse(postResponse.bodyText()).error.code, 'PREPARATION_UNAVAILABLE');
});
