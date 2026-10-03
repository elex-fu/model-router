import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Headers as UndiciHeaders } from 'undici';

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
  readonly url = '/v1/chat/completions';
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
        return work({} as never);
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

function preparationService(
  state: PreparationState,
  authorityDecision: RequestPreparationDecision<RequestPreparationAuthority> = allowRequestPreparation(authority()),
): SaasRequestPreparationService {
  return new SaasRequestPreparationService(preparationDependencies(state, authorityDecision), {
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

  constructor(private readonly state: PreparationState, private readonly metering: FakeMetering) {}

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
  readonly knownNonSuccessResponses: Parameters<PreparedEvidenceMeteringPort['recordKnownNonSuccessHttpResponse']>[0][] = [];
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
      responseStartedAt: input.responseStarted === true ? (this.current.responseStartedAt ?? NOW) : this.current.responseStartedAt,
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
    assert.ok(Number.isSafeInteger(input.resultHttpStatus) && input.resultHttpStatus >= 300 && input.resultHttpStatus <= 599);
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
