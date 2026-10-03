import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ModelResolutionProvenance } from '../../../src/saas/gateway/contracts.js';
import type {
  NormalSuccessSettlementPort,
  NormalSuccessSettlementSnapshot,
} from '../../../src/saas/gateway/dispatch-usage-settlement.js';
import {
  type PreparedEvidenceLeaseProvider,
  type PreparedEvidenceTransport,
  type PreparedRequestEvidenceAudit,
  type PreparedRequestEvidenceRecord,
  SaasPreparedEvidenceDispatchError,
  SaasPreparedEvidenceDispatchService,
} from '../../../src/saas/gateway/index.js';
import type { ProviderAccountRuntimeHealthWriter } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import type {
  PreparedEvidenceClientStream,
  PreparedEvidenceTransportResponse,
} from '../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { ProviderHttpTransportError } from '../../../src/saas/gateway/provider-http-transport.js';
import type { AttemptRecord, AttemptTransitionInput } from '../../../src/saas/metering/types.js';

const audit: PreparedRequestEvidenceAudit = {
  actorUserId: 'user-1',
  entryPoint: 'gateway-dispatch-test',
  sourceIp: null,
  userAgent: null,
  requestId: 'request-1',
};
const payload = new TextEncoder().encode('prepared payload');
const payloadSha256 = createHash('sha256').update(payload).digest('hex');

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function evidence(): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'evidence-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    attemptOrdinal: 1,
    supplyMode: 'byok',
    accountOwnerKind: 'tenant',
    publicModel: 'model-1',
    protocol: 'openai',
    requestedModel: 'model-1',
    mappedModel: 'resolved-model-1',
    resolvedModel: 'resolved-model-1',
    modelResolution: { requestedModel: 'model-1', mappedModel: 'resolved-model-1',
      resolvedModel: 'resolved-model-1', mappingSource: 'alias', mappingVersion: 1 },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    requestFingerprint: 'c'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    endpoint: '/v1/chat/completions',
    upstreamId: 'upstream-1',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: '1',
    routeTargetMode: 'tenant_account',
    payloadSha256,
    statementSha256: 'b'.repeat(64),
    status: 'registered',
    claimedAt: null,
    claimedAttemptId: null,
    expiresAt: '2026-09-28T00:10:00.000Z',
  };
}

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'attempt-1',
    tenantId: 'tenant-1',
    requestId: 'request-1',
    projectPolicyVersion: '1',
    customerPriceVersion: null,
    customerMeteringPolicyId: 'customer-policy-1',
    customerMeteringPolicyVersion: '1',
    providerMeteringPolicyId: 'provider-policy-1',
    providerMeteringPolicyVersion: '1',
    contractAttestationId: 'attestation-1',
    routeConfigId: 'route-1',
    routeConfigVersion: '1',
    routePublicModelId: 'public-model-1',
    routePublicModelVersion: '1',
    routeProtocol: 'openai',
    routeTargetMode: 'tenant_account',
    ordinal: 1,
    upstreamId: 'upstream-1',
    bindingState: 'bound',
    dispatchAuthorityState: 'bound',
    accountOwnerKind: 'tenant',
    accountId: 'account-1',
    providerId: 'provider-1',
    productId: 'product-1',
    resolvedModel: 'resolved-model-1',
    protocol: 'openai',
    modelResolution: { requestedModel: 'model-1', mappedModel: 'resolved-model-1',
      resolvedModel: 'resolved-model-1', mappingSource: 'alias', mappingVersion: 1 },
    clientProtocol: 'openai',
    providerProtocol: 'openai',
    clientOperation: 'chat.completions',
    providerOperation: 'chat.completions',
    requestFingerprint: 'c'.repeat(64),
    requestFingerprintVersion: 'fingerprint-v1',
    payloadSha256,
    payloadCompilerVersion: 'compiler-v1',
    usageEstimatorVersion: 'estimator-v1',
    endpoint: '/v1/chat/completions',
    supplierCostVersion: null,
    dispatchProfileId: 'profile-1',
    supplyProfileAuthzVersion: '1',
    credentialId: 'credential-1',
    credentialVersion: '1',
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
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    stateVersion: 1,
    ...overrides,
  };
}

class FakeMetering {
  readonly calls: string[] = [];
  readonly reads: Array<{ tenantId: string; requestId: string; attemptId: string; version: number }> = [];
  readonly transitionInputs: AttemptTransitionInput[] = [];
  readonly claimVersions: Array<{ before: number; after: number }> = [];
  current = attempt();
  failDispatchFence = false;
  failSentTransition = false;
  failUnknownTransition = false;
  readOverride?: (read: number, snapshot: AttemptRecord) => AttemptRecord | null;
  beforeTransition?: (input: AttemptTransitionInput) => void;

  async getAttempt(tenantId: string, requestId: string, attemptId: string): Promise<AttemptRecord | null> {
    this.calls.push('get-attempt');
    this.reads.push({ tenantId, requestId, attemptId, version: this.current.stateVersion });
    const snapshot = { ...this.current };
    return this.readOverride ? this.readOverride(this.reads.length, snapshot) : snapshot;
  }

  claimEvidence(record: PreparedRequestEvidenceRecord): void {
    if (this.current.tenantId !== record.tenantId || this.current.requestId !== record.requestId ||
      this.current.id !== record.attemptId || this.current.ordinal !== record.attemptOrdinal ||
      this.current.preparedEvidenceId !== null || this.current.dispatchState !== 'not_sent' ||
      this.current.resultState !== 'pending' || this.current.responseStarted ||
      this.current.bindingState !== 'bound' || this.current.dispatchAuthorityState !== 'bound') {
      throw new Error('attempt claim CAS conflict');
    }
    const before = this.current.stateVersion;
    this.current = { ...this.current, preparedEvidenceId: record.evidenceId, stateVersion: before + 1 };
    this.claimVersions.push({ before, after: this.current.stateVersion });
  }

  async transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord> {
    this.calls.push(`transition:${input.dispatchState}`);
    this.transitionInputs.push(input);
    this.beforeTransition?.(input);
    if (input.tenantId !== this.current.tenantId || input.requestId !== this.current.requestId ||
      input.attemptId !== this.current.id || input.expectedStateVersion !== this.current.stateVersion ||
      input.expectedDispatchState !== this.current.dispatchState || input.expectedResultState !== this.current.resultState ||
      input.expectedResponseStarted !== this.current.responseStarted ||
      (input.dispatchState === 'dispatching' && (this.current.preparedEvidenceId === null ||
        this.current.bindingState !== 'bound' || this.current.dispatchAuthorityState !== 'bound'))) {
      throw new Error('attempt transition CAS conflict');
    }
    if (input.dispatchState === 'dispatching' && this.failDispatchFence) {
      throw new Error('dispatch fence conflict');
    }
    if (input.dispatchState === 'sent' && this.failSentTransition) {
      throw new Error('sent state persistence unavailable');
    }
    if (input.dispatchState === 'unknown' && this.failUnknownTransition) {
      throw new Error('unknown transition unavailable');
    }
    this.current = {
      ...this.current,
      dispatchState: input.dispatchState ?? this.current.dispatchState,
      resultState: input.resultState ?? this.current.resultState,
      responseStarted: this.current.responseStarted || input.responseStarted === true,
      responseStartedAt: this.current.responseStarted ? this.current.responseStartedAt
        : input.responseStarted ? '2026-09-28T00:00:00.000Z' : null,
      stateVersion: this.current.stateVersion + 1,
      unknownReason: input.unknownReason ?? null,
      resultHttpStatus: input.resultHttpStatus ?? null,
    };
    return this.current;
  }

  async recordKnownNonSuccessHttpResponse(input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly attemptId: string;
    readonly resultHttpStatus: number;
    readonly responseStarted: boolean;
  }): Promise<AttemptRecord> {
    this.calls.push(`known-http-failure:${input.resultHttpStatus}`);
    this.current = {
      ...this.current,
      dispatchState: 'sent',
      resultState: 'failed',
      responseStarted: this.current.responseStarted || input.responseStarted,
      responseStartedAt: this.current.responseStarted ? this.current.responseStartedAt
        : input.responseStarted ? '2026-09-28T00:00:00.000Z' : null,
      resultHttpStatus: input.resultHttpStatus,
      unknownReason: null,
      stateVersion: this.current.stateVersion + 1,
    };
    return this.current;
  }
}

class FakeEvidence {
  readonly preflightCalls: Array<{ evidenceId: string; payloadSha256?: string }> = [];
  readonly calls: Array<{ evidenceId: string; payloadSha256?: string }> = [];
  record = evidence();
  rejectClaim: Error | null = null;
  afterClaim?: () => void;
  claimResultPatch: Partial<PreparedRequestEvidenceRecord> = {};

  constructor(public metering?: FakeMetering) {}

  async preflightForDispatch(
    evidenceId: string,
    _audit: PreparedRequestEvidenceAudit,
    options?: { readonly payloadSha256?: string },
  ): Promise<PreparedRequestEvidenceRecord> {
    this.preflightCalls.push({ evidenceId, payloadSha256: options?.payloadSha256 });
    if (evidenceId !== this.record.evidenceId || options?.payloadSha256 !== this.record.payloadSha256) {
      throw new Error('claim digest mismatch');
    }
    return this.record;
  }

  async claimForDispatch(
    evidenceId: string,
    _audit: PreparedRequestEvidenceAudit,
    options?: { readonly payloadSha256?: string },
  ): Promise<PreparedRequestEvidenceRecord> {
    this.calls.push({ evidenceId, payloadSha256: options?.payloadSha256 });
    if (this.rejectClaim) throw this.rejectClaim;
    if (evidenceId !== this.record.evidenceId || options?.payloadSha256 !== this.record.payloadSha256) {
      throw new Error('claim digest mismatch');
    }
    assert.ok(this.metering, 'claim fake must bind the actual metering state');
    this.metering.claimEvidence(this.record);
    this.record = { ...this.record, status: 'claimed', claimedAt: '2026-09-28T00:00:00.000Z', claimedAttemptId: 'attempt-1' };
    this.afterClaim?.();
    return { ...this.record, ...this.claimResultPatch };
  }
}

class FakeLeaseProvider implements PreparedEvidenceLeaseProvider {
  readonly calls: string[] = [];
  unavailable = false;
  invalidContract = false;
  releaseCount = 0;
  renewCount = 0;
  renewIntervalMs = 5;
  fencingToken = 'fence-1';
  renewFailure: Error | null = null;
  releaseFailure: Error | null = null;

  async acquire(input: { readonly attemptId: string }): Promise<{
    fencingToken: string;
    renewIntervalMs: number;
    renew(): Promise<void>;
    release(): Promise<void>;
  } | null> {
    this.calls.push(input.attemptId);
    if (this.unavailable) return null;
    return {
      fencingToken: this.fencingToken,
      renewIntervalMs: this.invalidContract ? 0 : this.renewIntervalMs,
      renew: async () => {
        this.renewCount += 1;
        if (this.renewFailure) throw this.renewFailure;
      },
      release: async () => {
        this.releaseCount += 1;
        if (this.releaseFailure) throw this.releaseFailure;
      },
    };
  }
}

class FakeClientStream implements PreparedEvidenceClientStream {
  readonly controller = new AbortController();
  readonly chunks: Uint8Array[] = [];
  readonly starts: Array<{ status: number | null; headers: Readonly<Record<string, string>> }> = [];
  writeDelayMs = 0;
  startFailure: Error | null = null;
  endFailure: Error | null = null;
  endCount = 0;
  abortCount = 0;
  onStart?: () => void;
  onEnd?: () => void;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(status: number | null, headers: Readonly<Record<string, string>>): void {
    this.starts.push({ status, headers });
    this.onStart?.();
    if (this.startFailure) throw this.startFailure;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.writeDelayMs > 0) await delay(this.writeDelayMs);
    this.chunks.push(new Uint8Array(chunk));
  }

  end(): void {
    this.endCount += 1;
    this.onEnd?.();
    if (this.endFailure) throw this.endFailure;
  }

  abort(): void {
    this.abortCount += 1;
  }
}

function responseBody(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk) {
        index += 1;
        controller.enqueue(chunk);
        return;
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function service(
  evidenceService: FakeEvidence,
  metering: FakeMetering,
  leaseProvider: FakeLeaseProvider,
  transport: PreparedEvidenceTransport,
  runtimeHealthWriter?: ProviderAccountRuntimeHealthWriter,
): SaasPreparedEvidenceDispatchService {
  evidenceService.metering = metering;
  return new SaasPreparedEvidenceDispatchService(
    evidenceService,
    metering,
    leaseProvider,
    transport,
    undefined,
    runtimeHealthWriter,
  );
}

test('dispatch records provider success with the acquired lease fencing token', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.fencingToken = '712';
  const writes: unknown[] = [];
  const health: ProviderAccountRuntimeHealthWriter = {
    async recordRuntimeOutcome(input) {
      writes.push(input);
      return 'applied';
    },
  };
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };

  const result = await service(proof, metering, lease, transport, health).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(metering.current.dispatchState, 'sent');
  assert.deepEqual(writes, [
    {
      candidate: {
        tenantId: 'tenant-1',
        accountId: 'account-1',
        upstreamId: 'upstream-1',
        supplyMode: 'byok',
        accountOwnerKind: 'tenant',
      },
      attemptId: 'attempt-1',
      fencingToken: '712',
      evidence: { source: 'gateway', result: 'success' },
    },
  ]);
});

test('a confirmed successful execution with billing reconciliation remains a sent success', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  proof.metering = metering;
  const successAttempt = attempt({ preparedEvidenceId: 'evidence-1', dispatchState: 'sent', resultState: 'succeeded',
    responseStarted: true, responseStartedAt: '2026-09-28T00:00:00.000Z', resultHttpStatus: 200, stateVersion: 4 });
  const settlement: NormalSuccessSettlementPort = {
    async complete() {
      return { kind: 'reconciliation_pending', attempt: successAttempt };
    },
    async retainUnknown() {
      throw new Error('verified execution must not be reclassified as unknown');
    },
  };
  const transport: PreparedEvidenceTransport = {
    async send() {
      return {
        responseStarted: true,
        resultHttpStatus: 200,
        providerUsage: {
          inputTotal: 5,
          inputUncached: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          outputTotal: 2,
          reasoningOutput: 0,
          status: 'reported',
          source: 'upstream',
          semanticsVersion: 'v1',
        },
      };
    },
  };
  const snapshot: NormalSuccessSettlementSnapshot = {
    supplyMode: 'platform',
    providerProtocol: 'openai',
    customerPriceVersion: 'price-v1',
    reservationId: 'hold-1',
    priceSnapshotRef: 'snapshot-1',
    currency: 'USD',
    holdAmountMinorUnits: '1',
    publicModelId: 'public-model-1',
    publicModelVersion: '1',
    providerId: 'provider-1',
    productId: 'product-1',
    endpoint: '/v1/chat/completions',
    usageEstimatorVersion: 'estimator-v1',
  };

  const result = await new SaasPreparedEvidenceDispatchService(
    proof,
    metering,
    new FakeLeaseProvider(),
    transport,
    settlement,
  ).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    normalSuccessSnapshot: snapshot,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(result.attempt.resultState, 'succeeded');
});

test('dispatch records retryable provider failures and ignores caller errors', async () => {
  const writes: unknown[] = [];
  const health: ProviderAccountRuntimeHealthWriter = {
    async recordRuntimeOutcome(input) {
      writes.push(input);
      return 'applied';
    },
  };
  const networkFailure: PreparedEvidenceTransport = {
    async send() {
      throw new ProviderHttpTransportError('NETWORK_ERROR', 'provider network failure');
    },
  };
  const failed = await service(
    new FakeEvidence(),
    new FakeMetering(),
    new FakeLeaseProvider(),
    networkFailure,
    health,
  ).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit });
  assert.equal(failed.kind, 'unknown');
  assert.deepEqual(writes, [
    {
      candidate: {
        tenantId: 'tenant-1',
        accountId: 'account-1',
        upstreamId: 'upstream-1',
        supplyMode: 'byok',
        accountOwnerKind: 'tenant',
      },
      attemptId: 'attempt-1',
      fencingToken: 'fence-1',
      evidence: { source: 'gateway', result: 'retryable_failure', failureKind: 'network' },
    },
  ]);

  const provider5xx: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 503 };
    },
  };
  const serverMetering = new FakeMetering();
  const serverFailure = await service(
    new FakeEvidence(),
    serverMetering,
    new FakeLeaseProvider(),
    provider5xx,
    health,
  ).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit });
  assert.equal(serverFailure.kind, 'sent');
  assert.equal(serverFailure.attempt.resultState, 'failed');
  assert.equal(serverFailure.attempt.resultHttpStatus, 503);
  assert.deepEqual(serverMetering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'known-http-failure:503']);
  assert.equal((writes[1] as { evidence: { failureKind: string } }).evidence.failureKind, 'provider_5xx');

  const callerError: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 401 };
    },
  };
  const callerErrorMetering = new FakeMetering();
  const callerErrorResult = await service(
    new FakeEvidence(),
    callerErrorMetering,
    new FakeLeaseProvider(),
    callerError,
    health,
  ).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit });
  assert.equal(callerErrorResult.kind, 'sent');
  assert.equal(callerErrorResult.attempt.resultState, 'failed');
  assert.equal(callerErrorResult.attempt.resultHttpStatus, 401);
  assert.deepEqual(callerErrorMetering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'known-http-failure:401']);
  assert.equal(writes.length, 2);
});

test('health write failure does not alter dispatch state or repeat transport', async () => {
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  let sends = 0;
  const health: ProviderAccountRuntimeHealthWriter = {
    async recordRuntimeOutcome() {
      throw new Error('health store unavailable');
    },
  };
  const transport: PreparedEvidenceTransport = {
    async send() {
      sends += 1;
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };

  const result = await service(new FakeEvidence(), metering, lease, transport, health).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(sends, 1);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'transition:sent']);
  assert.equal(lease.releaseCount, 1);
});

test('preflights proof, acquires the lease, claims proof, then transports', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const calls: string[] = [];
  const transport: PreparedEvidenceTransport = {
    async send(input) {
      calls.push('transport');
      assert.equal(input.evidence.payloadSha256, payloadSha256);
      assert.equal(input.fencingToken, 'fence-1');
      assert.deepEqual(input.payloadBytes, payload);
      assert.equal('credentialSecret' in input, false);
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'sent');
  assert.deepEqual(proof.calls, [{ evidenceId: 'evidence-1', payloadSha256 }]);
  assert.deepEqual(proof.preflightCalls, [{ evidenceId: 'evidence-1', payloadSha256 }]);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'transition:sent']);
  assert.deepEqual(calls, ['transport']);
  assert.equal(lease.releaseCount, 1);
  assert.equal(metering.current.dispatchState, 'sent');
  assert.equal(metering.current.responseStarted, true);
});

test('dispatch rereads the bound claim and fences with its authoritative version, not the preflight version', async () => {
  const metering = new FakeMetering();
  const proof = new FakeEvidence();
  const lease = new FakeLeaseProvider();
  let sends = 0;
  const result = await service(proof, metering, lease, {
    async send() {
      sends++;
      assert.equal(metering.current.stateVersion, 3);
      assert.equal(metering.current.preparedEvidenceId, 'evidence-1');
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit });
  assert.equal(result.kind, 'sent');
  assert.equal(sends, 1);
  assert.deepEqual(metering.claimVersions, [{ before: 1, after: 2 }]);
  assert.deepEqual(metering.reads, [
    { tenantId: 'tenant-1', requestId: 'request-1', attemptId: 'attempt-1', version: 1 },
    { tenantId: 'tenant-1', requestId: 'request-1', attemptId: 'attempt-1', version: 2 },
  ]);
  assert.equal(metering.transitionInputs[0]?.expectedStateVersion, 2);
  assert.equal(metering.transitionInputs[1]?.expectedStateVersion, 3);
  assert.equal(metering.current.stateVersion, 4);
  assert.equal(lease.releaseCount, 1);
});

test('equal detached model-resolution tuples authorize dispatch by typed value, including a null passthrough revision', async () => {
  const resolutions: readonly ModelResolutionProvenance[] = [
    { requestedModel: 'model-1', mappedModel: 'resolved-model-1', resolvedModel: 'resolved-model-1',
      mappingSource: 'alias', mappingVersion: 1 },
    { requestedModel: 'model-1', mappedModel: 'model-1', resolvedModel: 'model-1',
      mappingSource: 'none', mappingVersion: null },
  ];
  for (const resolution of resolutions) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    const lease = new FakeLeaseProvider();
    proof.record = { ...proof.record, requestedModel: resolution.requestedModel, mappedModel: resolution.mappedModel,
      resolvedModel: resolution.resolvedModel, modelResolution: { ...resolution } };
    metering.current = { ...metering.current, resolvedModel: resolution.resolvedModel, modelResolution: { ...resolution } };
    // A new object with different insertion order must compare equal. Neither
    // object identity nor JSON key order is the persisted mapping contract.
    proof.claimResultPatch = { modelResolution: { mappingVersion: resolution.mappingVersion,
      mappingSource: resolution.mappingSource, resolvedModel: resolution.resolvedModel,
      mappedModel: resolution.mappedModel, requestedModel: resolution.requestedModel } };
    assert.notEqual(proof.claimResultPatch.modelResolution, proof.record.modelResolution);
    assert.notEqual(metering.current.modelResolution, proof.record.modelResolution);
    let sends = 0;
    const result = await service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: true, resultHttpStatus: 200 }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit });
    assert.equal(result.kind, 'sent');
    assert.equal(sends, 1);
    assert.equal(metering.transitionInputs[0]?.expectedStateVersion, 2);
    assert.equal(lease.releaseCount, 1);
  }
});

test('every typed resolution field and optional presence must match across preflight, claim and current attempt', async () => {
  const resolution = evidence().modelResolution;
  assert.ok(resolution);
  const patches: readonly Partial<ModelResolutionProvenance>[] = [
    { requestedModel: 'other-model' }, { mappedModel: 'other-model' }, { resolvedModel: 'other-model' },
    { mappingSource: 'wildcard' }, { mappingVersion: 2 },
  ];
  const mismatches: readonly (ModelResolutionProvenance | undefined)[] = [
    ...patches.map((patch) => ({ ...resolution, ...patch })), undefined,
  ];
  for (const target of ['attempt', 'claimed'] as const) {
    for (const mismatch of mismatches) {
      const metering = new FakeMetering();
      const proof = new FakeEvidence();
      const lease = new FakeLeaseProvider();
      if (target === 'attempt') {
        metering.readOverride = (read, snapshot) => read === 2 ? { ...snapshot, modelResolution: mismatch } : snapshot;
      } else proof.claimResultPatch = { modelResolution: mismatch };
      let sends = 0;
      await assert.rejects(service(proof, metering, lease, {
        async send() { sends++; return { responseStarted: false }; },
      }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
      (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'EVIDENCE_BINDING_MISMATCH');
      assert.equal(sends, 0);
      assert.equal(metering.transitionInputs.length, 0);
      assert.equal(proof.calls.length, 1);
      assert.equal(lease.releaseCount, 1);
    }
  }
});

test('legacy resolution omission accepts only consistent identity rows without partial or newly present provenance', async () => {
  const identity: ModelResolutionProvenance = { requestedModel: 'model-1', mappedModel: 'model-1',
    resolvedModel: 'model-1', mappingSource: 'none', mappingVersion: null };
  for (const scenario of ['consistent', 'attempt_presence', 'claimed_presence', 'partial_claimed',
    'partial_attempt', 'non_identity'] as const) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    const lease = new FakeLeaseProvider();
    proof.record = { ...proof.record, requestedModel: undefined, mappedModel: undefined, resolvedModel: 'model-1',
      modelResolution: undefined, clientProtocol: undefined, providerProtocol: undefined, clientOperation: undefined,
      providerOperation: undefined, requestFingerprint: undefined, requestFingerprintVersion: undefined,
      payloadCompilerVersion: undefined, usageEstimatorVersion: undefined };
    metering.current = { ...metering.current, resolvedModel: 'model-1', modelResolution: undefined,
      clientProtocol: undefined, providerProtocol: undefined, clientOperation: undefined, providerOperation: undefined,
      requestFingerprint: undefined, requestFingerprintVersion: undefined, payloadCompilerVersion: undefined,
      usageEstimatorVersion: undefined, payloadSha256: undefined };
    if (scenario === 'attempt_presence') {
      metering.readOverride = (read, snapshot) => read === 2 ? { ...snapshot, modelResolution: identity } : snapshot;
    } else if (scenario === 'claimed_presence') proof.claimResultPatch = { modelResolution: identity };
    else if (scenario === 'partial_claimed') proof.claimResultPatch = { requestFingerprint: 'c'.repeat(64) };
    else if (scenario === 'partial_attempt') {
      metering.readOverride = (read, snapshot) => read === 2 ? { ...snapshot, providerProtocol: 'openai' } : snapshot;
    } else if (scenario === 'non_identity') {
      proof.record = { ...proof.record, resolvedModel: 'resolved-model-1' };
      metering.current = { ...metering.current, resolvedModel: 'resolved-model-1' };
    }
    let sends = 0;
    const dispatched = service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: true, resultHttpStatus: 200 }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit });
    if (scenario === 'consistent') {
      assert.equal((await dispatched).kind, 'sent');
      assert.equal(sends, 1);
      assert.equal(metering.transitionInputs[0]?.expectedStateVersion, 2);
    } else {
      await assert.rejects(dispatched,
        (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'EVIDENCE_BINDING_MISMATCH');
      assert.equal(sends, 0);
      assert.equal(metering.transitionInputs.length, 0);
    }
    assert.equal(lease.releaseCount, 1);
  }
});

test('post-claim cancellation and absent/read-failed rows prevent fencing or sends and clean up the lease', async () => {
  for (const failure of ['cancelled', 'missing', 'read_error'] as const) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    const lease = new FakeLeaseProvider();
    let sends = 0;
    if (failure === 'cancelled') {
      proof.afterClaim = () => { metering.current = { ...metering.current, resultState: 'failed', stateVersion: 3 }; };
    } else {
      metering.readOverride = (read, snapshot) => {
        if (read === 2) {
          if (failure === 'read_error') throw new Error('synthetic post-claim read failure');
          return null;
        }
        return snapshot;
      };
    }
    await assert.rejects(service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: false }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => failure === 'read_error'
      ? error instanceof Error && error.message === 'synthetic post-claim read failure'
      : error instanceof SaasPreparedEvidenceDispatchError && error.code ===
        (failure === 'missing' ? 'ATTEMPT_NOT_FOUND' : 'EVIDENCE_BINDING_MISMATCH'));
    assert.equal(sends, 0, failure);
    assert.equal(metering.transitionInputs.length, 0, failure);
    assert.equal(proof.calls.length, 1, failure);
    assert.equal(lease.releaseCount, 1, failure);
    if (failure === 'cancelled') assert.equal(metering.current.resultState, 'failed');
  }
});

test('post-claim full identity, authority, evidence and response-fact mismatches fail closed without sends', async () => {
  const patches: Partial<AttemptRecord>[] = [
    { tenantId: 'other-tenant' }, { requestId: 'other-request' }, { id: 'other-attempt' }, { ordinal: 2 },
    { bindingState: 'legacy' }, { dispatchAuthorityState: 'unbound' }, { accountOwnerKind: 'platform' },
    { upstreamId: 'other-upstream' }, { accountId: 'other-account' }, { credentialId: 'other-credential' },
    { credentialVersion: '2' }, { protocol: 'anthropic' }, { endpoint: '/wrong-endpoint' },
    { routeTargetMode: 'platform_pool' }, { preparedEvidenceId: null }, { preparedEvidenceId: 'other-evidence' },
    { resolvedModel: 'wrong-model' }, { requestFingerprint: 'e'.repeat(64) }, { payloadSha256: 'f'.repeat(64) },
    { modelResolution: { requestedModel: 'model-1', mappedModel: 'resolved-model-1',
      resolvedModel: 'resolved-model-1', mappingSource: 'alias', mappingVersion: 2 } },
    { dispatchState: 'dispatching' }, { resultState: 'failed' }, { responseStarted: true },
    { responseStartedAt: '2026-09-28T00:00:00.000Z' }, { resultHttpStatus: 200 }, { unknownReason: 'observed' },
    { stateVersion: 0 }, { stateVersion: Number.NaN },
  ];
  for (const patch of patches) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    const lease = new FakeLeaseProvider();
    metering.readOverride = (read, snapshot) => read === 2 ? { ...snapshot, ...patch } : snapshot;
    let sends = 0;
    await assert.rejects(service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: false }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'EVIDENCE_BINDING_MISMATCH');
    assert.equal(sends, 0, JSON.stringify(patch));
    assert.equal(metering.transitionInputs.length, 0);
    assert.equal(proof.calls.length, 1);
    assert.equal(lease.releaseCount, 1);
  }
  const claimedPatches: Partial<PreparedRequestEvidenceRecord>[] = [
    { evidenceId: 'other-evidence' }, { projectId: 'other-project' }, { requestId: 'other-request' },
    { status: 'registered' }, { claimedAttemptId: 'other-attempt' }, { claimedAt: null },
    { statementSha256: 'c'.repeat(64) },
  ];
  for (const patch of claimedPatches) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    proof.claimResultPatch = patch;
    const lease = new FakeLeaseProvider();
    let sends = 0;
    await assert.rejects(service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: false }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'EVIDENCE_BINDING_MISMATCH');
    assert.equal(sends, 0);
    assert.equal(metering.transitionInputs.length, 0);
    assert.equal(lease.releaseCount, 1);
  }
});

test('version-only, cancellation and binding races after the authoritative reread lose strict CAS with zero sends', async () => {
  const patches: Partial<AttemptRecord>[] = [{}, { resultState: 'failed' },
    { dispatchState: 'dispatching' }, { preparedEvidenceId: 'other-evidence' }];
  for (const patch of patches) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    const lease = new FakeLeaseProvider();
    metering.beforeTransition = (input) => {
      if (input.dispatchState === 'dispatching') {
        metering.current = { ...metering.current, ...patch, stateVersion: metering.current.stateVersion + 1 };
      }
    };
    let sends = 0;
    await assert.rejects(service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: false }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'DISPATCH_STATE_CONFLICT');
    assert.equal(sends, 0);
    assert.equal(metering.transitionInputs.length, 1, 'one fence attempt; no broad retry');
    assert.equal(metering.transitionInputs[0]?.expectedStateVersion, 2);
    assert.equal(metering.current.stateVersion, 3, 'concurrent state is not reverted');
    assert.equal(proof.calls.length, 1);
    assert.equal(lease.releaseCount, 1);
  }
});

test('a stale post-claim version cannot fence dispatch even when identity and execution facts still match', async () => {
  const metering = new FakeMetering();
  const proof = new FakeEvidence();
  const lease = new FakeLeaseProvider();
  metering.readOverride = (read, snapshot) => read === 2 ? { ...snapshot, stateVersion: 1 } : snapshot;
  let sends = 0;
  await assert.rejects(service(proof, metering, lease, {
    async send() { sends++; return { responseStarted: false }; },
  }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
  (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'DISPATCH_STATE_CONFLICT');
  assert.equal(sends, 0);
  assert.equal(metering.transitionInputs.length, 1);
  assert.equal(metering.transitionInputs[0]?.expectedStateVersion, 1);
  assert.equal(metering.current.stateVersion, 2);
  assert.equal(lease.releaseCount, 1);
});

test('client cancellation after claim or during the reread prevents fencing and upstream sends', async () => {
  for (const stage of ['claim', 'reread'] as const) {
    const metering = new FakeMetering();
    const proof = new FakeEvidence();
    const lease = new FakeLeaseProvider();
    const client = new FakeClientStream();
    if (stage === 'claim') proof.afterClaim = () => client.controller.abort();
    else metering.readOverride = (read, snapshot) => { if (read === 2) client.controller.abort(); return snapshot; };
    let sends = 0;
    await assert.rejects(service(proof, metering, lease, {
      async send() { sends++; return { responseStarted: false }; },
    }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit, client }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'CLIENT_STREAM_ABORTED');
    assert.equal(sends, 0);
    assert.equal(metering.transitionInputs.length, 0);
    assert.equal(metering.current.stateVersion, 2);
    assert.equal(lease.releaseCount, 1);
  }
});

test('client cancellation while dispatch CAS completes makes no send and retains unknown after the fence', async () => {
  const metering = new FakeMetering();
  const proof = new FakeEvidence();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  metering.beforeTransition = (input) => { if (input.dispatchState === 'dispatching') client.controller.abort(); };
  let sends = 0;
  const result = await service(proof, metering, lease, {
    async send() { sends++; return { responseStarted: false }; },
  }).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit, client });
  assert.equal(result.kind, 'unknown');
  assert.equal(sends, 0);
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.equal(lease.releaseCount, 1);
});

test('client already aborted before dispatch leaves proof, lease, and attempt untouched', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  client.controller.abort();
  let sends = 0;
  const transport: PreparedEvidenceTransport = {
    async send() {
      sends += 1;
      return { responseStarted: false, resultHttpStatus: 200 };
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({
      evidenceId: 'evidence-1',
      payloadBytes: payload,
      audit,
      client,
    }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'CLIENT_STREAM_ABORTED',
  );

  assert.equal(sends, 0);
  assert.deepEqual(proof.calls, []);
  assert.deepEqual(metering.calls, []);
  assert.deepEqual(lease.calls, []);
  assert.equal(metering.current.dispatchState, 'not_sent');
});

test('renews the lease throughout a long transport and stops the heartbeat after classification', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  let signal: AbortSignal | undefined;
  let sendStartedResolve!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    sendStartedResolve = resolve;
  });
  let completeTransport!: (response: PreparedEvidenceTransportResponse) => void;
  const transportResponse = new Promise<PreparedEvidenceTransportResponse>((resolve) => {
    completeTransport = resolve;
  });
  const transport: PreparedEvidenceTransport = {
    send(input) {
      signal = input.signal;
      sendStartedResolve();
      return transportResponse;
    },
  };

  const dispatch = service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });
  await sendStarted;

  await t.mock.timers.tick(lease.renewIntervalMs);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lease.renewCount, 1);
  await t.mock.timers.tick(lease.renewIntervalMs);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lease.renewCount, 2);
  assert.equal(signal?.aborted, false);

  completeTransport({ responseStarted: false, resultHttpStatus: 200 });
  const result = await dispatch;

  assert.equal(result.kind, 'sent');
  const renewCountAfterClassification = lease.renewCount;
  await t.mock.timers.tick(lease.renewIntervalMs * 2);
  assert.equal(lease.renewCount, renewCountAfterClassification);
});

test('lease renewal failure aborts an abort-aware transport and records unknown', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.renewFailure = new Error('lease renewal lost');
  let aborted = false;
  const transport: PreparedEvidenceTransport = {
    send(input) {
      return new Promise((_, reject) => {
        input.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('transport aborted after lease loss'));
          },
          { once: true },
        );
      });
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(aborted, true);
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.match(metering.current.unknownReason ?? '', /lease renewal/);
  assert.equal(lease.releaseCount, 1);
});

test('client abort during provider send aborts the transport and persists unknown before releasing lease', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  let sends = 0;
  let transportSignal: AbortSignal | undefined;
  let sendStartedResolve!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    sendStartedResolve = resolve;
  });
  const transport: PreparedEvidenceTransport = {
    send(input) {
      sends += 1;
      transportSignal = input.signal;
      sendStartedResolve();
      return new Promise((_, reject) => {
        if (input.signal.aborted) {
          reject(new Error('transport received an already-aborted signal'));
          return;
        }
        input.signal.addEventListener('abort', () => reject(new Error('transport aborted after client disconnect')), {
          once: true,
        });
      });
    },
  };

  const dispatch = service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });
  await sendStarted;
  client.controller.abort();
  const result = await dispatch;

  assert.equal(sends, 1);
  assert.equal(transportSignal?.aborted, true);
  assert.equal(result.kind, 'unknown');
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.equal(metering.current.resultState, 'unknown');
  assert.equal(lease.releaseCount, 1);
});

test('lease renewal failure is fail-closed even when transport ignores abort', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.renewFailure = new Error('lease renewal lost');
  let signal: AbortSignal | undefined;
  const transport: PreparedEvidenceTransport = {
    async send(input) {
      signal = input.signal;
      await delay(20);
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(signal?.aborted, true);
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.equal(metering.current.resultState, 'unknown');
  assert.equal(metering.current.responseStarted, true);
  assert.equal(metering.current.resultHttpStatus, 200);
});

test('sent-state persistence failure is recovered as unknown without replay', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  metering.failSentTransition = true;
  let sends = 0;
  const transport: PreparedEvidenceTransport = {
    async send() {
      sends += 1;
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(sends, 1);
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.equal(metering.current.resultState, 'unknown');
  assert.match(metering.current.unknownReason ?? '', /sent state could not be persisted/);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'transition:sent', 'transition:unknown']);
});

test('release failure does not overwrite a known sent result', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.releaseFailure = new Error('release storage unavailable');
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: true, resultHttpStatus: 200 };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(result.attempt.dispatchState, 'sent');
  assert.equal(result.leaseReleaseError?.code, 'LEASE_RELEASE_FAILED');
});

test('streams response chunks with backpressure and commits headers after reading the first non-empty chunk', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  client.writeDelayMs = 12;
  const transport: PreparedEvidenceTransport = {
    async send() {
      return {
        responseStarted: false,
        resultHttpStatus: 200,
        headers: { 'content-type': 'text/plain' },
        body: responseBody([new Uint8Array([1]), new Uint8Array([2, 3])]),
      };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.deepEqual(
    client.chunks.map((chunk) => [...chunk]),
    [[1], [2, 3]],
  );
  assert.deepEqual(client.starts, [{ status: 200, headers: { 'content-type': 'text/plain' } }]);
  assert.equal(client.endCount, 1);
  assert.equal(client.abortCount, 0);
  assert.equal(metering.current.responseStarted, true);
  assert.ok(lease.renewCount >= 2);
});

test('empty provider body commits headers at EOF and records the observable response', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  const transport: PreparedEvidenceTransport = {
    async send() {
      return {
        responseStarted: false,
        resultHttpStatus: 200,
        headers: { 'content-type': 'text/plain' },
        body: responseBody([]),
      };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.deepEqual(client.starts, [{ status: 200, headers: { 'content-type': 'text/plain' } }]);
  assert.equal(client.endCount, 1);
  assert.equal(metering.current.responseStarted, true);
});

test('finalizes a bodyless response without waiting for a body and releases the lease', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 204, headers: {}, body: null };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(client.endCount, 1);
  assert.equal(client.chunks.length, 0);
  assert.deepEqual(client.starts, [{ status: 204, headers: {} }]);
  assert.equal(metering.current.responseStarted, true);
  assert.equal(lease.releaseCount, 1);
});

test('bodyless non-2xx is persisted before a downstream start failure', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  client.startFailure = new Error('downstream start failed');
  let resultStateAtStart: AttemptRecord['resultState'] | undefined;
  client.onStart = () => {
    resultStateAtStart = metering.current.resultState;
  };
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 503, body: null };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(result.attempt.dispatchState, 'sent');
  assert.equal(result.attempt.resultState, 'failed');
  assert.equal(result.attempt.resultHttpStatus, 503);
  assert.equal(resultStateAtStart, 'failed');
  assert.equal(client.abortCount, 1);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'known-http-failure:503']);
  assert.equal(lease.releaseCount, 1);
});

test('bodyless non-2xx remains terminal when downstream end fails', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  client.endFailure = new Error('downstream end failed');
  let resultStateAtEnd: AttemptRecord['resultState'] | undefined;
  client.onEnd = () => {
    resultStateAtEnd = metering.current.resultState;
  };
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 503, body: null };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(result.attempt.dispatchState, 'sent');
  assert.equal(result.attempt.resultState, 'failed');
  assert.equal(result.attempt.resultHttpStatus, 503);
  assert.equal(resultStateAtEnd, 'failed');
  assert.equal(client.endCount, 1);
  assert.equal(client.abortCount, 1);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'known-http-failure:503']);
  assert.equal(lease.releaseCount, 1);
});

test('streamed non-2xx is persisted at EOF before downstream end fails', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  client.endFailure = new Error('downstream end failed');
  let resultStateAtEnd: AttemptRecord['resultState'] | undefined;
  client.onEnd = () => {
    resultStateAtEnd = metering.current.resultState;
  };
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 503, body: responseBody([new Uint8Array([1])]) };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(result.attempt.dispatchState, 'sent');
  assert.equal(result.attempt.resultState, 'failed');
  assert.equal(result.attempt.resultHttpStatus, 503);
  assert.equal(resultStateAtEnd, 'failed');
  assert.deepEqual(
    client.chunks.map((chunk) => [...chunk]),
    [[1]],
  );
  assert.equal(client.endCount, 1);
  assert.equal(client.abortCount, 1);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'known-http-failure:503']);
});

test('complete non-2xx with a successful client send is classified as terminal failure', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 503, body: null };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'sent');
  assert.equal(result.attempt.dispatchState, 'sent');
  assert.equal(result.attempt.resultState, 'failed');
  assert.equal(result.attempt.resultHttpStatus, 503);
  assert.deepEqual(client.starts, [{ status: 503, headers: {} }]);
  assert.equal(client.endCount, 1);
  assert.equal(client.abortCount, 0);
});

test('cancellation while waiting for the first body chunk does not commit response headers', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  let upstreamCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {
        // Wait until client cancellation cancels the reader.
      });
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 200, body };
    },
  };
  const dispatch = service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });
  await delay(1);
  client.controller.abort();

  const result = await dispatch;
  assert.equal(result.kind, 'unknown');
  assert.deepEqual(client.starts, []);
  assert.equal(upstreamCancelled, true);
  assert.equal(metering.current.responseStarted, false);
});

test('cancellation after header commit but before the first write records response started', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  client.onStart = () => client.controller.abort();
  let upstreamCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    pull() {
      return new Promise<void>(() => {
        // Keep the upstream open until cancellation after response headers commit.
      });
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const transport: PreparedEvidenceTransport = {
    async send() {
      return {
        responseStarted: false,
        resultHttpStatus: 200,
        body,
      };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(client.starts.length, 1);
  assert.deepEqual(client.chunks, []);
  assert.equal(client.abortCount, 1);
  assert.equal(upstreamCancelled, true);
  assert.equal(metering.current.responseStarted, true);
});

test('client cancellation cancels the upstream reader, aborts the client sink, and records unknown', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  let upstreamCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    pull() {
      return new Promise<void>(() => {
        // Wait until the client cancellation cancels the reader.
      });
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 200, body };
    },
  };
  const dispatch = service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });
  for (let attempt = 0; attempt < 20 && client.chunks.length === 0; attempt += 1) await delay(1);
  client.controller.abort();

  const result = await dispatch;
  assert.equal(result.kind, 'unknown');
  assert.equal(upstreamCancelled, true);
  assert.ok(client.abortCount >= 1);
  assert.equal(metering.current.responseStarted, true);
  assert.match(metering.current.unknownReason ?? '', /outcome is unknown/);
});

test('lease renewal failure cancels an in-flight body and client stream without replay', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.renewFailure = new Error('lease renewal lost');
  const client = new FakeClientStream();
  let upstreamCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {
        // Heartbeat failure must cancel this pending read.
      });
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 200, body };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(upstreamCancelled, true);
  assert.ok(client.abortCount >= 1);
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.equal(metering.current.resultState, 'unknown');
});

test('upstream body failure after delivery becomes unknown and is never replayed', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  let sends = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    pull(controller) {
      controller.error(new Error('upstream body failed'));
    },
  });
  const transport: PreparedEvidenceTransport = {
    async send() {
      sends += 1;
      return { responseStarted: false, resultHttpStatus: 200, body };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(sends, 1);
  assert.deepEqual(
    client.chunks.map((chunk) => [...chunk]),
    [[1]],
  );
  assert.equal(metering.current.responseStarted, true);
  assert.equal(metering.current.resultState, 'unknown');
});

test('an incomplete non-2xx body remains unknown rather than being classified from status alone', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const client = new FakeClientStream();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    pull(controller) {
      controller.error(new Error('upstream error body was truncated'));
    },
  });
  const transport: PreparedEvidenceTransport = {
    async send() {
      return { responseStarted: false, resultHttpStatus: 503, body };
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
    client,
  });

  assert.equal(result.kind, 'unknown');
  assert.equal(result.attempt.dispatchState, 'unknown');
  assert.equal(result.attempt.resultState, 'unknown');
  assert.equal(result.attempt.resultHttpStatus, 503);
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'transition:unknown']);
  assert.deepEqual(
    client.chunks.map((chunk) => [...chunk]),
    [[1]],
  );
});

test('payload tampering is rejected before claim and transport', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  let transported = false;
  const transport: PreparedEvidenceTransport = {
    async send() {
      transported = true;
      return { responseStarted: false };
    },
  };
  const tampered = new TextEncoder().encode('tampered payload');

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({
      evidenceId: 'evidence-1',
      payloadBytes: tampered,
      audit,
    }),
    (error: unknown) => {
      assert.equal((error as { message?: string }).message, 'claim digest mismatch');
      return true;
    },
  );
  assert.equal(proof.preflightCalls.length, 1);
  assert.equal(proof.calls.length, 0);
  assert.equal(metering.calls.length, 0);
  assert.equal(transported, false);
});

test('dispatch refuses an attempt already bound to another proof', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  metering.current = attempt({ preparedEvidenceId: 'other-evidence' });
  let transported = false;
  const transport: PreparedEvidenceTransport = {
    async send() {
      transported = true;
      return { responseStarted: false };
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) =>
      error instanceof SaasPreparedEvidenceDispatchError && error.code === 'EVIDENCE_BINDING_MISMATCH',
  );
  assert.equal(transported, false);
  assert.deepEqual(metering.calls, ['get-attempt']);
});

test('fence conflicts prevent transport and preserve not_sent', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  metering.failDispatchFence = true;
  lease.releaseFailure = new Error('lease release unavailable');
  let transported = false;
  const transport: PreparedEvidenceTransport = {
    async send() {
      transported = true;
      return { responseStarted: false };
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'DISPATCH_STATE_CONFLICT',
  );
  assert.equal(transported, false);
  assert.equal(metering.current.dispatchState, 'not_sent');
  assert.equal(lease.releaseCount, 1);
});

test('transport uncertainty is persisted as unknown and is never retried automatically', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  const transport: PreparedEvidenceTransport = {
    async send() {
      throw new Error('connection lost after request write');
    },
  };

  const result = await service(proof, metering, lease, transport).dispatch({
    evidenceId: 'evidence-1',
    payloadBytes: payload,
    audit,
  });
  assert.equal(result.kind, 'unknown');
  assert.equal(metering.current.dispatchState, 'unknown');
  assert.equal(metering.current.resultState, 'unknown');
  assert.deepEqual(metering.calls, ['get-attempt', 'get-attempt', 'transition:dispatching', 'transition:unknown']);
  assert.equal(lease.releaseCount, 1);
});

test('unknown outcome that cannot be persisted fails closed', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  metering.failUnknownTransition = true;
  const transport: PreparedEvidenceTransport = {
    async send() {
      throw new Error('transport outcome unknown');
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) =>
      error instanceof SaasPreparedEvidenceDispatchError && error.code === 'UNKNOWN_STATE_UPDATE_FAILED',
  );
});

test('missing account lease fails closed before dispatching or transport', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.unavailable = true;
  let transported = false;
  const transport: PreparedEvidenceTransport = {
    async send() {
      transported = true;
      return { responseStarted: false };
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'LEASE_UNAVAILABLE',
  );
  assert.equal(transported, false);
  assert.deepEqual(proof.calls, []);
  assert.deepEqual(proof.preflightCalls, [{ evidenceId: 'evidence-1', payloadSha256 }]);
  assert.deepEqual(metering.calls, ['get-attempt']);
  assert.equal(proof.record.status, 'registered');
  assert.equal(metering.current.preparedEvidenceId, null);
});

test('a competing claim invalidates stale preflight without transport or attempt fencing', async () => {
  const proof = new FakeEvidence();
  proof.rejectClaim = new Error('evidence was claimed concurrently');
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.releaseFailure = new Error('lease release unavailable');
  let transported = false;
  const transport: PreparedEvidenceTransport = {
    async send() {
      transported = true;
      return { responseStarted: false };
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof Error && error.message === 'evidence was claimed concurrently',
  );
  assert.deepEqual(proof.preflightCalls, [{ evidenceId: 'evidence-1', payloadSha256 }]);
  assert.deepEqual(proof.calls, [{ evidenceId: 'evidence-1', payloadSha256 }]);
  assert.equal(proof.record.status, 'registered');
  assert.equal(transported, false);
  assert.deepEqual(metering.calls, ['get-attempt']);
  assert.equal(metering.current.dispatchState, 'not_sent');
  assert.equal(lease.releaseCount, 1);
});

test('an invalid acquired lease contract is released when possible before dispatch', async () => {
  const proof = new FakeEvidence();
  const metering = new FakeMetering();
  const lease = new FakeLeaseProvider();
  lease.invalidContract = true;
  let transported = false;
  const transport: PreparedEvidenceTransport = {
    async send() {
      transported = true;
      return { responseStarted: false };
    },
  };

  await assert.rejects(
    service(proof, metering, lease, transport).dispatch({ evidenceId: 'evidence-1', payloadBytes: payload, audit }),
    (error: unknown) => error instanceof SaasPreparedEvidenceDispatchError && error.code === 'LEASE_UNAVAILABLE',
  );
  assert.equal(lease.releaseCount, 1);
  assert.deepEqual(proof.calls, []);
  assert.deepEqual(metering.calls, ['get-attempt']);
  assert.equal(transported, false);
});
