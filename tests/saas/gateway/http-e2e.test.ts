import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Headers as UndiciHeaders } from 'undici';

import type { SaasDatabase } from '../../../src/saas/db/index.js';
import type {
  AuthorizedByokUpstreamCandidate,
  ModelResolutionProvenance,
} from '../../../src/saas/gateway/contracts.js';
import {
  createSaasGatewayHandler,
  type PreparedEvidenceDispatchPort,
  type ProxyKeyAuthenticator,
  type RequestPreparationPort,
} from '../../../src/saas/gateway/http-handler.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import {
  type PreparedEvidenceDispatchResult,
  type PreparedEvidenceLeaseProvider,
  type PreparedEvidenceMeteringPort,
  SaasPreparedEvidenceDispatchService,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type {
  PreparedRequestEvidenceAudit,
  PreparedRequestEvidenceInput,
  PreparedRequestEvidenceRecord,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import type {
  ProviderAccountSchedulerHealthPort,
  ProviderAccountSchedulerInput,
  ProviderAccountSchedulerPort,
} from '../../../src/saas/gateway/provider-account-scheduler.js';
import {
  type ProviderHttpCredentialResolver,
  type ProviderHttpDispatchProfileResolver,
  type ProviderHttpFetch,
  ProviderHttpTransport,
} from '../../../src/saas/gateway/provider-http-transport.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
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

const NOW = '2026-09-28T00:00:00.000Z';
const DISPATCH_DEADLINE = '2026-09-28T00:00:30.000Z';
const EXPIRES_AT = '2026-09-28T00:01:00.000Z';
const CLIENT_REQUEST = {
  model: 'public-model',
  messages: [{ role: 'user', content: 'hello from client' }],
};
const PREPARED_PAYLOAD = new TextEncoder().encode(
  JSON.stringify({
    model: 'provider-model',
    messages: CLIENT_REQUEST.messages,
  }),
);
const PREPARED_PAYLOAD_SHA256 = createHash('sha256').update(PREPARED_PAYLOAD).digest('hex');
const PROVIDER_RESPONSE = JSON.stringify({
  id: 'fake-provider-response',
  model: 'provider-model',
  choices: [{ message: { role: 'assistant', content: 'hello from provider' } }],
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

  constructor(body: unknown = CLIENT_REQUEST, url: string = '/v1/chat/completions') {
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
  readonly setHeaders = new Map<string, unknown>();
  readonly writes: Uint8Array[] = [];
  endCount = 0;
  endBody: unknown;

  writeHead(status: number, headers: Record<string, unknown>): this {
    this.headersSent = true;
    this.writeHeadCalls.push({ status, headers });
    return this;
  }

  setHeader(name: string, value: unknown): this {
    this.setHeaders.set(name.toLowerCase(), value);
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
      supplyMode: 'byok',
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
      supplyMode: 'byok',
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
    supplyMode: 'byok',
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
    supplyMode: 'byok',
    modelScopeVersion: 1,
    allowedModels: ['public-model'],
    allowedProviderIds: ['provider-1'],
    projectPolicyVersion: 1,
  };
}

function candidate(): AuthorizedByokUpstreamCandidate & { providerId: string; productId: string } {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    proxyKeyId: 'proxy-key-1',
    supplyProfileId: 'profile-1',
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
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
    endpoint: 'server-owned-provider-route-1',
    supplierCostVersion: null,
    profileAccountAuthzVersion: 1,
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
      clientOperation: 'chat.completions',
      providerOperation: 'chat.completions',
      targetMode: 'tenant_account',
      upstreamId: 'upstream-1',
      endpoint: 'server-owned-provider-route-1',
    },
    candidate: candidate(),
    modelMappingRules: [
      {
        pattern: 'public-model',
        mappedModel: 'catalog-model',
        mappingSource: 'alias',
        mappingVersion: 1,
      },
    ],
    poolMemberAuthzVersion: null,
    credentialRef: 'credential-1',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-1',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-1',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-1',
      customerPriceVersion: null,
      supplierCostVersion: null,
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
    holdReservation: null,
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

function preparationDependencies(
  state: PreparationState,
  authorityDecision: RequestPreparationDecision<RequestPreparationAuthority>,
): RequestPreparationDependencies {
  const payload: RequestPreparationPayloadCompiler = {
    async compile(input) {
      state.calls.push('payload');
      assert.deepEqual(input.clientRequest, CLIENT_REQUEST);
      assert.equal(input.clientProtocol, 'openai');
      assert.equal(input.providerProtocol, 'openai');
      assert.equal(input.clientOperation, 'chat.completions');
      assert.equal(input.providerOperation, 'chat.completions');
      assert.deepEqual(input.modelResolution, MODEL_RESOLUTION);
      state.payloads.push(new Uint8Array(PREPARED_PAYLOAD));
      return allowRequestPreparation({
        payloadBytes: PREPARED_PAYLOAD,
        requestFingerprint: 'request-fingerprint-1',
        requestFingerprintVersion: 'canonical-v1',
        compilerVersion: 'test-payload-compiler-v1',
        estimatorVersion: 'test-usage-estimator-v1',
        usage: {
          inputTotalUpperBound: 16,
          inputUncachedUpperBound: 16,
          cacheReadUpperBound: 0,
          cacheWriteUpperBound: 0,
          cacheWrite5mUpperBound: 0,
          cacheWrite1hUpperBound: 0,
          outputTotalUpperBound: 16,
          reasoningOutputUpperBound: 0,
          feasibleInputBuckets: ['input'],
        },
        requestedModel: 'public-model',
        mappedModel: 'catalog-model',
        resolvedModel: 'provider-model',
        modelResolution: MODEL_RESOLUTION,
        providerProtocol: 'openai',
        providerOperation: 'chat.completions',
      });
    },
  };

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
    payload,
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
        assert.equal(input.requestId, 'request-1');
        assert.equal(input.attemptId, 'attempt-1');
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

/*
 * Roadmap batch 2 §2.1: every content-bearing hosted request now carries a
 * sticky scheduling reference, and request preparation requires an account
 * scheduler whenever input.scheduling is set. The default test scheduler
 * selects the authority's candidate and allows the affinity binding.
 */
function stickyScheduler(): ProviderAccountSchedulerPort {
  return {
    async select(input) {
      return allowRequestPreparation(input.candidates[0] ?? candidate());
    },
    async bindAffinity() {
      return { decision: 'allow' };
    },
  };
}

function preparationService(
  state: PreparationState,
  authorityDecision: RequestPreparationDecision<RequestPreparationAuthority> = allowRequestPreparation(authority()),
  scheduler: ProviderAccountSchedulerPort = stickyScheduler(),
): SaasRequestPreparationService {
  return new SaasRequestPreparationService(
    { ...preparationDependencies(state, authorityDecision), scheduler },
    {
      evidenceVerifierKeyId: 'verifier-key-1',
      now: () => new Date(NOW),
      idFactory: {
        requestId: () => 'request-1',
        attemptId: () => 'attempt-1',
        evidenceId: () => 'evidence-1',
      },
    },
  );
}

function dispatchAttempt(evidence: PreparedRequestEvidenceRecord): AttemptRecord {
  assert.ok(evidence.modelResolution, 'the registered fixture must retain explicit model provenance');
  return {
    id: evidence.attemptId,
    tenantId: evidence.tenantId,
    requestId: evidence.requestId,
    projectPolicyVersion: '1',
    customerPriceVersion: null,
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
    routeTargetMode: 'tenant_account',
    ordinal: evidence.attemptOrdinal,
    upstreamId: evidence.upstreamId,
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'tenant',
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
    supplierCostVersion: null,
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
    return {
      ...registered,
      status: 'claimed',
      claimedAt: NOW,
      claimedAttemptId: registered.attemptId,
    };
  }
}

class FakeMetering implements PreparedEvidenceMeteringPort {
  readonly transitions: AttemptTransitionInput[] = [];
  readonly knownNonSuccessResponses: Parameters<
    PreparedEvidenceMeteringPort['recordKnownNonSuccessHttpResponse']
  >[0][] = [];
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
    assert.equal(this.current.tenantId, evidence.tenantId);
    assert.equal(this.current.requestId, evidence.requestId);
    assert.equal(this.current.id, evidence.attemptId);
    assert.equal(this.current.ordinal, evidence.attemptOrdinal);
    assert.equal(this.current.bindingState, 'bound');
    assert.equal(this.current.dispatchAuthorityState, 'bound');
    assert.equal(this.current.preparedEvidenceId, null);
    assert.equal(this.current.dispatchState, 'not_sent');
    assert.equal(this.current.resultState, 'pending');
    assert.equal(this.current.responseStarted, false);
    assert.equal(this.current.responseStartedAt, null);
    assert.equal(this.current.resultHttpStatus, null);
    assert.equal(this.current.unknownReason, null);
    assert.equal(this.current.stateVersion, 1);
    // The real claim updates both evidence and attempt in one transaction.
    this.current = {
      ...this.current,
      preparedEvidenceId: evidence.evidenceId,
      stateVersion: this.current.stateVersion + 1,
      updatedAt: NOW,
    };
  }

  async transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord> {
    assert.ok(this.current);
    assert.equal(input.tenantId, this.current.tenantId);
    assert.equal(input.requestId, this.current.requestId);
    assert.equal(input.attemptId, this.current.id);
    assert.equal(input.expectedStateVersion, this.current.stateVersion);
    assert.equal(input.expectedDispatchState, this.current.dispatchState);
    assert.equal(input.expectedResultState, this.current.resultState);
    assert.equal(input.expectedResponseStarted, this.current.responseStarted);
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

  async recordKnownNonSuccessHttpResponse(
    input: Parameters<PreparedEvidenceMeteringPort['recordKnownNonSuccessHttpResponse']>[0],
  ): Promise<AttemptRecord> {
    assert.ok(this.current);
    assert.equal(input.tenantId, this.current.tenantId);
    assert.equal(input.requestId, this.current.requestId);
    assert.equal(input.attemptId, this.current.id);
    assert.ok(
      Number.isSafeInteger(input.resultHttpStatus) && input.resultHttpStatus >= 300 && input.resultHttpStatus <= 599,
    );
    assert.equal(typeof input.responseStarted, 'boolean');
    assert.ok(this.current.dispatchState === 'dispatching' || this.current.dispatchState === 'sent');
    assert.equal(this.current.resultState, 'pending');
    this.knownNonSuccessResponses.push(input);
    return this.transitionAttempt({
      tenantId: input.tenantId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      expectedStateVersion: this.current.stateVersion,
      expectedDispatchState: this.current.dispatchState,
      expectedResultState: 'pending',
      expectedResponseStarted: this.current.responseStarted,
      dispatchState: 'sent',
      resultState: 'failed',
      responseStarted: true,
      resultHttpStatus: input.resultHttpStatus,
      unknownReason: null,
    });
  }
}

class FakeLeaseProvider implements PreparedEvidenceLeaseProvider {
  acquireCount = 0;
  renewCount = 0;
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
      renew: async () => {
        this.renewCount += 1;
      },
      release: async () => {
        this.releaseCount += 1;
      },
    };
  }
}

interface ProviderTrace {
  readonly profileInputs: Parameters<ProviderHttpDispatchProfileResolver>[0][];
  readonly credentialInputs: Parameters<ProviderHttpCredentialResolver>[0][];
  readonly urls: string[];
  readonly headers: UndiciHeaders[];
  readonly payloads: Uint8Array[];
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
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'fake-provider-request',
        'x-internal-secret': 'must-not-forward',
      },
    });
  };
  const resolveDispatchProfile: ProviderHttpDispatchProfileResolver = async (input) => {
    trace.profileInputs.push(input);
    return { url: 'https://provider.example/v1/chat/completions' };
  };
  const resolveCredential: ProviderHttpCredentialResolver = async (input, useCredential) => {
    trace.credentialInputs.push(input);
    return useCredential({ headerName: 'authorization', value: 'Bearer fake-provider-credential' });
  };

  return new ProviderHttpTransport({
    fetch,
    resolveDispatchProfile,
    resolveCredential,
    endpointPolicy: { allowedHosts: ['provider.example'], allowedPorts: [443] },
    resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
    timeoutMs: 1_000,
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

test('composes the HTTP gateway through preparation, evidence dispatch, and fake provider transport', async () => {
  const preparationState: PreparationState = { calls: [], registered: [], payloads: [] };
  const preparation = preparationService(preparationState);
  const metering = new FakeMetering(preparationState);
  const evidence = new FakeEvidenceStore(preparationState, metering);
  const lease = new FakeLeaseProvider();
  const provider: ProviderTrace = {
    profileInputs: [],
    credentialInputs: [],
    urls: [],
    headers: [],
    payloads: [],
  };
  const transport = providerTransport(provider);
  const dispatch = new SaasPreparedEvidenceDispatchService(evidence, metering, lease, transport);
  const keyCalls: string[] = [];
  const handler = createSaasGatewayHandler({
    authenticator: authenticator(keyCalls),
    preparation: preparation as RequestPreparationPort,
    dispatch: dispatch as PreparedEvidenceDispatchPort,
    entryPoint: 'fake-e2e-test',
    // Batch 2 §2.1: the full composed flow with the sticky seam enabled —
    // every content-bearing request derives a scheduling reference and the
    // composition's scheduler binds it after selection.
    stickyScheduling: true,
  });
  const request = new FakeIncomingMessage();
  const response = new FakeServerResponse();

  assert.equal(await handler(asRequest(request), asResponse(response), { requestId: 'request-1' }), true);
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
  assert.deepEqual(preparationState.payloads, [PREPARED_PAYLOAD]);
  assert.equal(preparationState.registered.length, 1);
  assert.equal(preparationState.registered[0]?.payloadSha256, PREPARED_PAYLOAD_SHA256);
  assert.equal(evidence.audits[0]?.entryPoint, 'fake-e2e-test');
  assert.deepEqual(provider.urls, ['https://provider.example/v1/chat/completions']);
  assert.equal(provider.headers[0]?.get('authorization'), 'Bearer fake-provider-credential');
  assert.equal(provider.headers[0]?.get('content-type'), 'application/json');
  assert.deepEqual(provider.payloads, [PREPARED_PAYLOAD]);
  assert.equal(provider.profileInputs[0]?.endpoint, 'server-owned-provider-route-1');
  assert.equal(provider.credentialInputs[0]?.credentialId, 'credential-1');
  assert.equal(lease.acquireCount, 1);
  assert.equal(lease.releaseCount, 1);
  assert.equal(metering.getAttemptCount, 2, 'dispatch must read the authoritative attempt again after claim');
  assert.equal(metering.transitions[0]?.expectedStateVersion, 2, 'dispatch CAS must use the version updated by claim');
  assert.equal(metering.current?.stateVersion, 4);
  assert.equal(metering.current?.preparedEvidenceId, preparationState.registered[0]?.evidenceId);
  assert.equal(metering.knownNonSuccessResponses.length, 0);
  assert.equal(metering.transitions.map((transition) => transition.dispatchState).join(','), 'dispatching,sent');
  assert.equal(metering.current?.dispatchState, 'sent');
  assert.equal(metering.current?.responseStarted, true);
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(response.writeHeadCalls[0]?.headers['content-type'], 'application/json');
  assert.equal(response.writeHeadCalls[0]?.headers['x-request-id'], 'request-1');
  assert.equal(response.writeHeadCalls[0]?.headers['x-internal-secret'], undefined);
  assert.equal(response.bodyText(), PROVIDER_RESPONSE);
  assert.equal(response.endCount, 1);
  assert.equal(response.destroyed, false);
});

test('blocks a no-upstream authority result before dispatch or provider transport', async () => {
  const preparationState: PreparationState = { calls: [], registered: [], payloads: [] };
  const preparation = preparationService(
    preparationState,
    blockRequestPreparation('route_denied', 'no authorized upstream is available'),
  );
  let dispatchCalls = 0;
  const dispatch: PreparedEvidenceDispatchPort = {
    async dispatch() {
      dispatchCalls += 1;
      throw new Error('dispatch must not run for blocked preparation');
    },
  };
  const handler = createSaasGatewayHandler({
    authenticator: authenticator([]),
    preparation: preparation as RequestPreparationPort,
    dispatch,
  });
  const response = new FakeServerResponse();

  assert.equal(await handler(asRequest(new FakeIncomingMessage()), asResponse(response)), true);
  assert.equal(response.writeHeadCalls[0]?.status, 503);
  assert.equal(dispatchCalls, 0);
  assert.deepEqual(preparationState.calls, ['caller', 'entitlement', 'authority']);
  assert.deepEqual(preparationState.registered, []);
  assert.equal(JSON.parse(response.bodyText()).error.code, 'REQUEST_BLOCKED');
});

/* ------------------------------------------------------------------ */
/* G1 (task #41): Claude Code client evidence, boundary → scheduler.   */
/* ------------------------------------------------------------------ */

function preparationOptions(): ConstructorParameters<typeof SaasRequestPreparationService>[1] {
  return {
    evidenceVerifierKeyId: 'verifier-key-1',
    now: () => new Date(NOW),
    idFactory: {
      requestId: () => 'request-1',
      attemptId: () => 'attempt-1',
      evidenceId: () => 'evidence-1',
    },
  };
}

function completingDispatch(): PreparedEvidenceDispatchPort {
  return {
    async dispatch(input) {
      await input.client?.start(200, { 'content-type': 'application/json' });
      await input.client?.end();
      return { kind: 'sent' } as PreparedEvidenceDispatchResult;
    },
  };
}

test('composes Claude Code client evidence from the HTTP boundary into the scheduler input', async () => {
  const selects: ProviderAccountSchedulerInput[] = [];
  const scheduler: ProviderAccountSchedulerPort = {
    async select(inputValue) {
      selects.push(inputValue);
      return allowRequestPreparation(candidate());
    },
    async bindAffinity() {
      return { decision: 'allow' };
    },
  };
  const preparationState: PreparationState = { calls: [], registered: [], payloads: [] };
  const preparationServiceInstance = new SaasRequestPreparationService(
    {
      ...preparationDependencies(preparationState, allowRequestPreparation(authority())),
      scheduler,
    },
    preparationOptions(),
  );
  const handler = createSaasGatewayHandler({
    authenticator: authenticator([]),
    preparation: preparationServiceInstance,
    dispatch: completingDispatch(),
    stickyScheduling: true,
  });
  const request = new FakeIncomingMessage();
  Object.assign(request.headers, {
    'user-agent': 'claude-cli/1.0.34 (external, cli)',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'x-app': 'cli',
    'x-stainless-lang': 'js',
  });
  const response = new FakeServerResponse();

  assert.equal(await handler(asRequest(request), asResponse(response), { requestId: 'request-1' }), true);
  assert.equal(response.writeHeadCalls[0]?.status, 200);
  assert.equal(selects.length, 1);
  assert.deepEqual(selects[0]?.claudeCodeClient, {
    userAgent: 'claude-cli/1.0.34 (external, cli)',
    path: '/v1/chat/completions',
    headers: {
      'user-agent': 'claude-cli/1.0.34 (external, cli)',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'x-app': 'cli',
      'x-stainless-lang': 'js',
    },
    body: CLIENT_REQUEST,
  });
  // The sticky scheduling seam: the same trusted boundary derivation fills
  // input.scheduling.sessionId (here the openai content fallback: the
  // request carries no explicit session signal) and preparation forwards it
  // into the scheduler input, binding after the selection (batch 2 §2.1).
  assert.ok(selects[0]?.scheduling?.sessionId);
  assert.match(selects[0]?.scheduling?.sessionId ?? '', /^[0-9a-f]{64}$/);
  // The full composed flow still prepares, dispatches, and registers evidence.
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
});

const SCHEDULER_HEALTH: ProviderAccountSchedulerHealthPort = {
  async get() {
    return { decision: 'allow', value: { status: 'healthy', observedAt: new Date(NOW) } };
  },
};

function platformAuthenticatedApiKey(): AuthenticatedApiKey {
  const key = authenticatedApiKey();
  return {
    metadata: { ...key.metadata, supplyMode: 'platform' },
    authorization: { ...key.authorization, supplyMode: 'platform' },
  };
}

function platformCaller(): RequestPreparationCaller {
  return { ...caller(), supplyMode: 'platform' };
}

function platformEntitlement(): RequestPreparationEntitlement {
  return { ...entitlement(), supplyMode: 'platform', allowedProviderIds: [] };
}

function claudeAuthority(): RequestPreparationAuthority {
  return {
    route: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      publicModel: 'public-model',
      publicModelId: 'public-model-1',
      publicModelVersion: 1,
      routeConfigId: 'route-config-cc',
      routeConfigVersion: 1,
      protocol: 'anthropic',
      providerProtocol: 'anthropic',
      targetMode: 'platform_pool',
      upstreamId: 'pool-cc',
      endpoint: 'server-owned-provider-route-cc',
    },
    candidate: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      proxyKeyId: 'proxy-key-1',
      supplyProfileId: 'profile-1',
      supplyMode: 'platform',
      accountOwnerKind: 'platform',
      upstreamId: 'pool-cc',
      accountId: 'account-cc',
      credentialId: 'credential-cc',
      credentialVersion: 1,
      credentialAuthzVersion: 1,
      accountAuthzVersion: 1,
      dispatchProfileId: 'dispatch-profile-cc',
      supplyProfileAuthzVersion: 1,
      resolvedModel: 'provider-model',
      protocol: 'anthropic',
      endpoint: 'server-owned-provider-route-cc',
      supplierCostVersion: 'cost-cc',
      poolId: 'pool-cc',
      poolAuthzVersion: 1,
      poolMemberAccountAuthzVersion: 1,
      poolMemberAuthzVersion: 1,
      poolGrantAuthzVersion: 1,
      poolGrantProfileAuthzVersion: 1,
      poolGrantPoolAuthzVersion: 1,
      providerId: 'anthropic-claude',
      productId: 'claude-subscription',
    },
    poolMemberAuthzVersion: 1,
    credentialRef: 'credential-cc',
    configVersion: 1,
    commercial: {
      customerMeteringPolicyId: 'customer-policy-1',
      customerMeteringPolicyVersion: 1,
      providerMeteringPolicyId: 'provider-policy-1',
      providerMeteringPolicyVersion: 1,
      contractAttestationId: 'attestation-1',
      customerPriceVersion: 'customer-price-cc',
      supplierCostVersion: 'cost-cc',
    },
  };
}

/** Only F2 billing-group authority exists; root route reads return empty and transactions are forbidden. */
function claudeOnlyGroupDatabase(statements: Array<{ sql: string; values: readonly unknown[] }>): SaasDatabase {
  return {
    async query(sql: string, values: readonly unknown[]) {
      statements.push({ sql, values });
      if (sql.includes('postgres-provider-account-scheduler:billing-group')) {
        return { rows: [{ id: 'group-cc', claude_code_only: true, fallback_group_id: null }] };
      }
      return { rows: [] };
    },
    async transaction() {
      throw new Error('this fixture only serves the billing-group enforcement gate');
    },
  } as unknown as SaasDatabase;
}

function claudeOnlyGateway(
  userAgent: string,
  extraHeaders: IncomingHttpHeaders,
): {
  readonly handler: ReturnType<typeof createSaasGatewayHandler>;
  readonly request: FakeIncomingMessage;
  readonly response: FakeServerResponse;
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  readonly preparationState: PreparationState;
} {
  const statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  const scheduler = new PostgresProviderAccountScheduler({
    database: claudeOnlyGroupDatabase(statements),
    health: SCHEDULER_HEALTH,
  });
  const preparationState: PreparationState = { calls: [], registered: [], payloads: [] };
  const preparation = new SaasRequestPreparationService(
    {
      ...preparationDependencies(preparationState, allowRequestPreparation(claudeAuthority())),
      caller: {
        async validate() {
          preparationState.calls.push('caller');
          return allowRequestPreparation(platformCaller());
        },
      },
      entitlement: {
        async resolve() {
          preparationState.calls.push('entitlement');
          return allowRequestPreparation(platformEntitlement());
        },
      },
      scheduler,
    },
    preparationOptions(),
  );
  const dispatch: PreparedEvidenceDispatchPort = {
    async dispatch() {
      throw new Error('dispatch must not run when the group gate rejects');
    },
  };
  const platformAuthenticator: ProxyKeyAuthenticator = {
    async authenticate() {
      return platformAuthenticatedApiKey();
    },
  };
  const handler = createSaasGatewayHandler({
    authenticator: platformAuthenticator,
    preparation: preparation as RequestPreparationPort,
    dispatch,
  });
  const request = new FakeIncomingMessage({
    model: 'public-model',
    max_tokens: 1024,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    metadata: { user_id: 'user_e2b8a1c4d5f6a7b8c9d0e1f2a3b4c5d6' },
    messages: [{ role: 'user', content: 'hello from client' }],
  }, '/v1/messages');
  Object.assign(request.headers, { 'user-agent': userAgent, ...extraHeaders });
  return { handler, request, response: new FakeServerResponse(), statements, preparationState };
}

test('a claude_code_only group rejects third-party clients through the full HTTP boundary', async () => {
  const setup = claudeOnlyGateway('curl/8.4.0', { 'anthropic-version': '2023-06-01' });

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  assert.equal(setup.response.writeHeadCalls[0]?.status, 403);
  assert.equal(JSON.parse(setup.response.bodyText()).error.code, 'REQUEST_REJECTED');
  // The rejection happened at the billing-group gate: exactly one authority
  // read (the group resolution) and no candidate eligibility reads at all.
  assert.equal(setup.statements.length, 1);
  assert.match(setup.statements[0]?.sql ?? '', /postgres-provider-account-scheduler:billing-group/);
  assert.deepEqual(setup.preparationState.calls, ['caller', 'entitlement', 'authority']);
  // The client evidence itself never surfaces in the response.
  assert.equal(setup.response.bodyText().includes('curl/8.4.0'), false);
});

test('a claude_code_only group admits genuine Claude Code clients past the group gate', async () => {
  const setup = claudeOnlyGateway('claude-cli/1.0.34 (external, cli)', {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'x-app': 'cli',
  });

  assert.equal(await setup.handler(asRequest(setup.request), asResponse(setup.response)), true);
  // The genuine client passes the group gate; the root route read then finds
  // no persisted route authority, so selection blocks before eligibility.
  assert.equal(setup.response.writeHeadCalls[0]?.status, 503);
  assert.equal(JSON.parse(setup.response.bodyText()).error.code, 'REQUEST_BLOCKED');
  // R-dormant (115): the threshold signal read precedes the fresh route read;
  // missing route authority blocks before any candidate eligibility query.
  assert.equal(setup.statements.length, 3);
  assert.match(setup.statements[0]?.sql ?? '', /postgres-provider-account-scheduler:billing-group/);
  assert.match(setup.statements[1]?.sql ?? '', /postgres-provider-account-scheduler:threshold-candidates/);
  assert.deepEqual(
    setup.statements.map(({ sql }) => sql.match(/postgres-provider-account-scheduler:([a-z-]+)/)?.[1]),
    ['billing-group', 'threshold-candidates', 'route'],
  );
  assert.deepEqual(setup.statements[2]?.values, [
    'tenant-1',
    'project-1',
    'public-model',
    'anthropic',
    'platform',
  ]);
  assert.equal(setup.statements.some(({ sql }) => sql.includes('-eligibility')), false);
});
