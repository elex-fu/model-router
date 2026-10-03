import { createHash } from 'node:crypto';
import type { KnownNonSuccessHttpResponseInput } from '../metering/service.js';
import type { AttemptRecord, AttemptTransitionInput } from '../metering/types.js';
import type { ModelResolutionProvenance } from './contracts.js';
import type {
  NormalSuccessObservedUsage,
  NormalSuccessSettlementPort,
  NormalSuccessSettlementSnapshot,
} from './dispatch-usage-settlement.js';
import type {
  ProviderAccountRuntimeHealthCandidate,
  ProviderAccountRuntimeHealthEvidence,
  ProviderAccountRuntimeHealthWriter,
} from './postgres-provider-account-runtime-health-store.js';
import type {
  PreparedRequestEvidenceAudit,
  PreparedRequestEvidenceClaimOptions,
  PreparedRequestEvidenceDispatchPort,
  PreparedRequestEvidenceRecord,
} from './prepared-request-evidence-service.js';
import { ProviderHttpTransportError } from './provider-http-transport.js';

export interface PreparedEvidenceMeteringPort {
  getAttempt(tenantId: string, requestId: string, attemptId: string): Promise<AttemptRecord | null>;
  transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord>;
  recordKnownNonSuccessHttpResponse(input: KnownNonSuccessHttpResponseInput): Promise<AttemptRecord>;
}

export interface PreparedEvidenceTransportRequest {
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly fencingToken: string;
  /** Aborted when the account lease can no longer authorize the in-flight send. */
  readonly signal: AbortSignal;
  readonly payloadBytes: Uint8Array;
  readonly evidence: PreparedRequestEvidenceRecord;
}

export interface PreparedEvidenceTransportResponse {
  readonly responseStarted: boolean;
  readonly resultHttpStatus?: number | null;
  /** Response headers already reduced to the transport's safe allowlist. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Trustworthy, normalized provider usage supplied by a bounded transport observer. */
  readonly providerUsage?: NormalSuccessObservedUsage | null;
  /** A one-reader body stream; dispatch consumes it without buffering the body. */
  readonly body?: ReadableStream<Uint8Array> | null;
}

export interface PreparedEvidenceTransport {
  send(input: PreparedEvidenceTransportRequest): Promise<PreparedEvidenceTransportResponse>;
}

export interface PreparedEvidenceLeaseRequest {
  readonly tenantId: string;
  readonly accountId: string;
  readonly upstreamId: string;
  readonly attemptId: string;
  readonly evidence: PreparedRequestEvidenceRecord;
}

export interface PreparedEvidenceLease {
  readonly fencingToken: string;
  /** The provider's safe cadence for renewing this lease before its TTL. */
  readonly renewIntervalMs: number;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface PreparedEvidenceLeaseProvider {
  acquire(input: PreparedEvidenceLeaseRequest): Promise<PreparedEvidenceLease | null>;
}

export interface PreparedEvidenceDispatchInput {
  readonly evidenceId: string;
  readonly payloadBytes: Uint8Array;
  readonly audit: PreparedRequestEvidenceAudit;
  /** Server-selected pricing and hold facts produced during request preparation. */
  readonly normalSuccessSnapshot?: NormalSuccessSettlementSnapshot;
  /** Optional client sink used when the transport returns a streaming body. */
  readonly client?: PreparedEvidenceClientStream;
}

export interface PreparedEvidenceClientStream {
  readonly signal: AbortSignal;
  /** Commits response headers; a successful return means the client can observe a response. */
  start(status: number | null, headers: Readonly<Record<string, string>>): Promise<void> | void;
  write(chunk: Uint8Array): Promise<void> | void;
  end(): Promise<void> | void;
  abort(error?: unknown): Promise<void> | void;
}

export interface PreparedEvidenceDispatchSent {
  readonly kind: 'sent';
  readonly evidence: PreparedRequestEvidenceRecord;
  readonly attempt: AttemptRecord;
  readonly transport: PreparedEvidenceTransportResponse;
  /** Cleanup failed after the upstream result was durably classified as sent. */
  readonly leaseReleaseError?: SaasPreparedEvidenceDispatchError;
}

export interface PreparedEvidenceDispatchUnknown {
  readonly kind: 'unknown';
  readonly evidence: PreparedRequestEvidenceRecord;
  readonly attempt: AttemptRecord;
  readonly error: unknown;
  /** Cleanup failed after the outcome was durably classified as unknown. */
  readonly leaseReleaseError?: SaasPreparedEvidenceDispatchError;
}

export type PreparedEvidenceDispatchResult = PreparedEvidenceDispatchSent | PreparedEvidenceDispatchUnknown;

export type PreparedEvidenceDispatchErrorCode =
  | 'INVALID_INPUT'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_NOT_READY'
  | 'EVIDENCE_BINDING_MISMATCH'
  | 'LEASE_UNAVAILABLE'
  | 'LEASE_RELEASE_FAILED'
  | 'CLIENT_STREAM_FAILED'
  | 'CLIENT_STREAM_ABORTED'
  | 'DISPATCH_STATE_CONFLICT'
  | 'STATE_UPDATE_FAILED'
  | 'UNKNOWN_STATE_UPDATE_FAILED';

export class SaasPreparedEvidenceDispatchError extends Error {
  constructor(
    readonly code: PreparedEvidenceDispatchErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SaasPreparedEvidenceDispatchError';
  }
}

function fail(code: PreparedEvidenceDispatchErrorCode, message: string, cause?: unknown): never {
  throw new SaasPreparedEvidenceDispatchError(code, message, cause === undefined ? undefined : { cause });
}

function payloadDigest(payloadBytes: Uint8Array): string {
  return createHash('sha256').update(payloadBytes).digest('hex');
}

function requireTransportResponse(value: PreparedEvidenceTransportResponse): PreparedEvidenceTransportResponse {
  if (!value || typeof value !== 'object' || typeof value.responseStarted !== 'boolean') {
    fail('INVALID_INPUT', 'prepared evidence transport returned an invalid response');
  }
  if (
    value.body !== undefined &&
    value.body !== null &&
    (typeof value.body !== 'object' || typeof value.body.getReader !== 'function')
  ) {
    fail('INVALID_INPUT', 'prepared evidence transport returned an invalid response body');
  }
  return value;
}

function retryableTransportFailure(error: unknown): ProviderAccountRuntimeHealthEvidence | null {
  if (!(error instanceof ProviderHttpTransportError)) return null;
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
    return { source: 'gateway', result: 'retryable_failure', failureKind: 'network' };
  }
  if (error.code === 'INVALID_RESPONSE') {
    return { source: 'gateway', result: 'retryable_failure', failureKind: 'protocol' };
  }
  return null;
}

function runtimeHealthEvidence(
  response: PreparedEvidenceTransportResponse | undefined,
  transportError: unknown,
): ProviderAccountRuntimeHealthEvidence | null {
  const status = response?.resultHttpStatus;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499) return null;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) {
    return { source: 'gateway', result: 'retryable_failure', failureKind: 'provider_5xx' };
  }
  const retryable = retryableTransportFailure(transportError);
  if (retryable) return retryable;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 299) {
    return { source: 'gateway', result: 'success' };
  }
  return null;
}

function runtimeHealthCandidate(evidence: PreparedRequestEvidenceRecord): ProviderAccountRuntimeHealthCandidate | null {
  const accountOwnerKind = evidence.accountOwnerKind;
  if (
    !accountOwnerKind ||
    (evidence.supplyMode === 'byok' && accountOwnerKind !== 'tenant') ||
    (evidence.supplyMode === 'platform' && accountOwnerKind !== 'platform')
  ) {
    return null;
  }
  return {
    tenantId: evidence.tenantId,
    accountId: evidence.accountId,
    upstreamId: evidence.upstreamId,
    supplyMode: evidence.supplyMode,
    accountOwnerKind,
  };
}

function assertClientStream(value: unknown): asserts value is PreparedEvidenceClientStream {
  if (!value || typeof value !== 'object') fail('CLIENT_STREAM_FAILED', 'client response stream is invalid');
  const client = value as PreparedEvidenceClientStream;
  if (
    !client.signal ||
    typeof client.signal.aborted !== 'boolean' ||
    typeof client.signal.addEventListener !== 'function' ||
    typeof client.start !== 'function' ||
    typeof client.write !== 'function' ||
    typeof client.end !== 'function' ||
    typeof client.abort !== 'function'
  ) {
    fail('CLIENT_STREAM_FAILED', 'client response stream is invalid');
  }
}

function transitionInput(
  attempt: AttemptRecord,
  dispatchState: 'dispatching' | 'sent' | 'unknown',
  resultState: 'pending' | 'unknown',
  responseStarted: boolean,
  unknownReason?: string,
  resultHttpStatus?: number | null,
): AttemptTransitionInput {
  return {
    tenantId: attempt.tenantId,
    requestId: attempt.requestId,
    attemptId: attempt.id,
    expectedDispatchState: attempt.dispatchState,
    expectedResultState: attempt.resultState,
    expectedResponseStarted: attempt.responseStarted,
    expectedStateVersion: attempt.stateVersion,
    dispatchState,
    resultState,
    responseStarted,
    unknownReason,
    resultHttpStatus,
  };
}

function sameModelResolution(
  left: ModelResolutionProvenance | undefined,
  right: ModelResolutionProvenance | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined;
  return left.requestedModel === right.requestedModel && left.mappedModel === right.mappedModel &&
    left.resolvedModel === right.resolvedModel && left.mappingSource === right.mappingSource &&
    left.mappingVersion === right.mappingVersion;
}

function assertPostClaimAttempt(
  attempt: AttemptRecord,
  claimed: PreparedRequestEvidenceRecord,
  preflight: PreparedRequestEvidenceRecord,
): void {
  const stableEvidenceFields = [
    'evidenceId', 'tenantId', 'projectId', 'requestId', 'attemptId', 'attemptOrdinal',
    'supplyMode', 'accountOwnerKind', 'publicModel', 'protocol', 'endpoint', 'upstreamId',
    'accountId', 'credentialId', 'credentialVersion', 'routeTargetMode', 'payloadSha256',
    'statementSha256', 'expiresAt', 'requestedModel', 'mappedModel', 'resolvedModel',
    'clientProtocol', 'providerProtocol', 'clientOperation', 'providerOperation',
    'requestFingerprint', 'requestFingerprintVersion', 'payloadCompilerVersion', 'usageEstimatorVersion',
  ] as const;
  const provenanceFields = ['clientProtocol', 'providerProtocol', 'clientOperation', 'providerOperation',
    'requestFingerprint', 'requestFingerprintVersion', 'payloadCompilerVersion', 'usageEstimatorVersion'] as const;
  const resolution = claimed.modelResolution;
  const hasProvenance = resolution !== undefined || provenanceFields.some((field) => claimed[field] !== undefined);
  // Persisted legacy evidence omits the entire 029 tuple, not selected fields,
  // and can authorize only an identity mapping with equally absent attempt provenance.
  const modelBindingMatches = resolution === undefined
    ? !hasProvenance && claimed.requestedModel === undefined && claimed.mappedModel === undefined &&
      claimed.resolvedModel === claimed.publicModel && attempt.resolvedModel === claimed.publicModel &&
      provenanceFields.every((field) => attempt[field] === undefined) && attempt.payloadSha256 === undefined
    : resolution.requestedModel === claimed.publicModel && resolution.requestedModel === claimed.requestedModel &&
      resolution.mappedModel === claimed.mappedModel && resolution.resolvedModel === claimed.resolvedModel &&
      resolution.resolvedModel === attempt.resolvedModel;
  const ownerKind = claimed.supplyMode === 'byok' ? 'tenant' : 'platform';
  if (
    stableEvidenceFields.some((field) => claimed[field] !== preflight[field]) ||
    !sameModelResolution(claimed.modelResolution, preflight.modelResolution) ||
    !sameModelResolution(attempt.modelResolution, claimed.modelResolution) || !modelBindingMatches ||
    claimed.status !== 'claimed' || claimed.claimedAttemptId !== claimed.attemptId ||
    typeof claimed.claimedAt !== 'string' || claimed.claimedAt.trim() === '' ||
    (claimed.accountOwnerKind !== undefined && claimed.accountOwnerKind !== ownerKind) ||
    claimed.routeTargetMode !== (claimed.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool') ||
    attempt.tenantId !== claimed.tenantId || attempt.requestId !== claimed.requestId ||
    attempt.id !== claimed.attemptId || attempt.ordinal !== claimed.attemptOrdinal ||
    attempt.bindingState !== 'bound' || attempt.dispatchAuthorityState !== 'bound' ||
    attempt.accountOwnerKind !== ownerKind || attempt.upstreamId !== claimed.upstreamId ||
    attempt.accountId !== claimed.accountId || attempt.credentialId !== claimed.credentialId ||
    attempt.credentialVersion !== claimed.credentialVersion || attempt.protocol !== claimed.protocol ||
    attempt.endpoint !== claimed.endpoint || attempt.routeTargetMode !== claimed.routeTargetMode ||
    attempt.preparedEvidenceId !== claimed.evidenceId ||
    (claimed.resolvedModel !== undefined && attempt.resolvedModel !== claimed.resolvedModel) ||
    (claimed.clientProtocol !== undefined && attempt.clientProtocol !== claimed.clientProtocol) ||
    (claimed.providerProtocol !== undefined && attempt.providerProtocol !== claimed.providerProtocol) ||
    (claimed.clientOperation !== undefined && attempt.clientOperation !== claimed.clientOperation) ||
    (claimed.providerOperation !== undefined && attempt.providerOperation !== claimed.providerOperation) ||
    (claimed.requestFingerprint !== undefined && attempt.requestFingerprint !== claimed.requestFingerprint) ||
    (claimed.requestFingerprintVersion !== undefined && attempt.requestFingerprintVersion !== claimed.requestFingerprintVersion) ||
    (claimed.payloadCompilerVersion !== undefined && attempt.payloadCompilerVersion !== claimed.payloadCompilerVersion) ||
    (claimed.usageEstimatorVersion !== undefined && attempt.usageEstimatorVersion !== claimed.usageEstimatorVersion) ||
    ((hasProvenance || attempt.payloadSha256 !== undefined) && attempt.payloadSha256 !== claimed.payloadSha256) ||
    attempt.dispatchState !== 'not_sent' || attempt.resultState !== 'pending' ||
    attempt.responseStarted !== false || attempt.responseStartedAt !== null ||
    attempt.resultHttpStatus !== null || attempt.unknownReason !== null ||
    !Number.isSafeInteger(attempt.stateVersion) || attempt.stateVersion < 1
  ) {
    fail('EVIDENCE_BINDING_MISMATCH', 'claimed prepared evidence is not bound to the current fresh attempt');
  }
}

interface LeaseHeartbeat {
  readonly signal: AbortSignal;
  hasFailed(): boolean;
  failure(): unknown;
  stop(): Promise<void>;
}

interface CombinedAbortSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface ResponseDeliveryState {
  responseStarted: boolean;
}

function canReleaseLease(value: unknown): value is { release(): Promise<void> } {
  try {
    return Boolean(
      value && typeof value === 'object' && typeof (value as { release?: unknown }).release === 'function',
    );
  } catch {
    return false;
  }
}

async function releaseBeforeDispatch(lease: PreparedEvidenceLease): Promise<void> {
  try {
    await lease.release();
  } catch {
    // Preserve the pre-dispatch error; no transport may start after this cleanup failure.
  }
}

function startLeaseHeartbeat(lease: PreparedEvidenceLease): LeaseHeartbeat {
  const controller = new AbortController();
  let stopped = false;
  let failed = false;
  let failure: unknown;
  let renewal: Promise<void> | undefined;

  const tick = () => {
    if (stopped || failed || renewal) return;
    renewal = Promise.resolve()
      .then(() => lease.renew())
      .catch((error: unknown) => {
        failed = true;
        failure = error;
        controller.abort();
      })
      .finally(() => {
        renewal = undefined;
      });
  };
  const timer = setInterval(tick, lease.renewIntervalMs);

  return {
    signal: controller.signal,
    hasFailed: () => failed,
    failure: () => failure,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const pending = renewal;
      if (pending) await pending;
    },
  };
}

function combineAbortSignals(signals: readonly AbortSignal[]): CombinedAbortSignal {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };

  for (const signal of new Set(signals)) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    dispose(): void {
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    },
  };
}

function leaseReleaseError(cause: unknown): SaasPreparedEvidenceDispatchError {
  return new SaasPreparedEvidenceDispatchError(
    'LEASE_RELEASE_FAILED',
    'provider account lease could not be released after dispatch classification',
    { cause },
  );
}

function withLeaseReleaseError(
  result: PreparedEvidenceDispatchResult,
  error: SaasPreparedEvidenceDispatchError,
): PreparedEvidenceDispatchResult {
  return { ...result, leaseReleaseError: error };
}

async function persistUnknown(
  metering: PreparedEvidenceMeteringPort,
  evidence: PreparedRequestEvidenceRecord,
  dispatching: AttemptRecord,
  responseStarted: boolean,
  resultHttpStatus: number | null | undefined,
  reason: string,
  cause: unknown,
): Promise<PreparedEvidenceDispatchUnknown> {
  try {
    const unknown = await metering.transitionAttempt(
      transitionInput(dispatching, 'unknown', 'unknown', responseStarted, reason, resultHttpStatus),
    );
    return { kind: 'unknown', evidence, attempt: unknown, error: cause };
  } catch (error) {
    fail('UNKNOWN_STATE_UPDATE_FAILED', 'dispatch outcome is uncertain and unknown state could not be persisted', {
      cause,
      stateError: error,
    });
  }
}

async function deliverTransportResponse(
  response: PreparedEvidenceTransportResponse,
  client: PreparedEvidenceClientStream | undefined,
  leaseSignal: AbortSignal,
  state: ResponseDeliveryState,
  // Runs at receipt for a bodyless response and at EOF for a streamed response.
  onUpstreamBodyComplete: () => Promise<void>,
): Promise<void> {
  const body = response.body ?? null;
  if (!body) {
    await onUpstreamBodyComplete();
    if (!client) {
      state.responseStarted = response.responseStarted;
      return;
    }
    assertClientStream(client);
    try {
      if (client.signal.aborted || leaseSignal.aborted) {
        fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled');
      }
      await client.start(response.resultHttpStatus ?? null, response.headers ?? {});
      state.responseStarted = true;
      if (client.signal.aborted || leaseSignal.aborted) {
        fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled before completion');
      }
      await client.end();
      return;
    } catch (error) {
      try {
        await client.abort(error);
      } catch (abortError) {
        fail('CLIENT_STREAM_FAILED', 'client response stream failed and could not be aborted', {
          cause: error,
          abortError,
        });
      }
      throw error;
    }
  }

  if (!client) {
    try {
      await body.cancel();
    } catch {
      // The dispatch result remains unknown; body cleanup cannot make it safe to replay.
    }
    fail('CLIENT_STREAM_FAILED', 'a client response stream is required for a provider body');
  }
  assertClientStream(client);

  const reader = body.getReader();
  let readerCancelled: Promise<void> | undefined;
  let clientAborted: Promise<void> | undefined;
  let settled = false;
  const cancelReader = (reason: unknown): Promise<void> => {
    readerCancelled ??= reader.cancel(reason).catch(() => undefined);
    return readerCancelled;
  };
  const abortClient = (reason: unknown): Promise<void> => {
    clientAborted ??= Promise.resolve(client.abort(reason)).then(
      () => undefined,
      () => undefined,
    );
    return clientAborted;
  };
  const onAbort = () => {
    if (settled) return;
    const reason = new Error('response stream was aborted');
    void cancelReader(reason);
    void abortClient(reason);
  };
  const signals = leaseSignal === client.signal ? [leaseSignal] : [leaseSignal, client.signal];
  for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (leaseSignal.aborted) fail('CLIENT_STREAM_FAILED', 'provider lease was lost before body delivery');
    if (client.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled');
    let clientStarted = false;
    while (true) {
      if (leaseSignal.aborted) fail('CLIENT_STREAM_FAILED', 'provider lease was lost during body delivery');
      if (client.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled');
      const next = await reader.read();
      if (leaseSignal.aborted) fail('CLIENT_STREAM_FAILED', 'provider lease was lost during body delivery');
      if (client.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled');
      if (next.done) {
        await onUpstreamBodyComplete();
        if (!clientStarted) {
          await client.start(response.resultHttpStatus ?? null, response.headers ?? {});
          clientStarted = true;
          state.responseStarted = true;
          if (leaseSignal.aborted) fail('CLIENT_STREAM_FAILED', 'provider lease was lost during body delivery');
          if (client.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled');
        }
        await client.end();
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        fail('CLIENT_STREAM_FAILED', 'provider response body returned an invalid chunk');
      }
      if (next.value.byteLength === 0) continue;
      if (!clientStarted) {
        await client.start(response.resultHttpStatus ?? null, response.headers ?? {});
        clientStarted = true;
        // The sink commits headers in start(); retain this fact even if the first write is cancelled.
        state.responseStarted = true;
      }
      if (leaseSignal.aborted) fail('CLIENT_STREAM_FAILED', 'provider lease was lost during body delivery');
      if (client.signal.aborted) fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled');
      await client.write(next.value);
    }
  } catch (error) {
    await cancelReader(error);
    await abortClient(error);
    throw error;
  } finally {
    settled = true;
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
    if (readerCancelled) await readerCancelled;
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have been released by an equivalent stream adapter.
    }
  }
}

export class SaasPreparedEvidenceDispatchService {
  constructor(
    private readonly evidence: PreparedRequestEvidenceDispatchPort,
    private readonly metering: PreparedEvidenceMeteringPort,
    private readonly leaseProvider: PreparedEvidenceLeaseProvider,
    private readonly transport: PreparedEvidenceTransport,
    private readonly normalSuccessSettlement?: NormalSuccessSettlementPort,
    private readonly runtimeHealthWriter?: ProviderAccountRuntimeHealthWriter,
  ) {}

  async dispatch(input: PreparedEvidenceDispatchInput): Promise<PreparedEvidenceDispatchResult> {
    if (
      !input ||
      typeof input.evidenceId !== 'string' ||
      input.evidenceId.trim() === '' ||
      !(input.payloadBytes instanceof Uint8Array)
    ) {
      fail('INVALID_INPUT', 'evidenceId and in-memory payload bytes are required');
    }
    if (input.client !== undefined) assertClientStream(input.client);
    if (input.client?.signal.aborted) {
      fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled before dispatch began');
    }
    const payloadBytes = new Uint8Array(input.payloadBytes);
    const digest = payloadDigest(payloadBytes);
    const claimOptions: PreparedRequestEvidenceClaimOptions = { payloadSha256: digest };
    const preflightEvidence = await this.evidence.preflightForDispatch(input.evidenceId, input.audit, claimOptions);
    const attempt = await this.metering.getAttempt(
      preflightEvidence.tenantId,
      preflightEvidence.requestId,
      preflightEvidence.attemptId,
    );
    if (!attempt) fail('ATTEMPT_NOT_FOUND', 'claimed prepared evidence attempt was not found');
    if (
      attempt.preparedEvidenceId !== null ||
      attempt.dispatchState !== 'not_sent' ||
      attempt.resultState !== 'pending' ||
      attempt.responseStarted
    ) {
      fail('EVIDENCE_BINDING_MISMATCH', 'prepared evidence is not bound to a fresh attempt');
    }

    let lease: PreparedEvidenceLease;
    let acquiredLease: unknown;
    try {
      acquiredLease = await this.leaseProvider.acquire({
        tenantId: preflightEvidence.tenantId,
        accountId: preflightEvidence.accountId,
        upstreamId: preflightEvidence.upstreamId,
        attemptId: preflightEvidence.attemptId,
        evidence: preflightEvidence,
      });
      if (
        !acquiredLease ||
        typeof acquiredLease !== 'object' ||
        typeof (acquiredLease as { fencingToken?: unknown }).fencingToken !== 'string' ||
        (acquiredLease as { fencingToken: string }).fencingToken.trim() === ''
      ) {
        fail('LEASE_UNAVAILABLE', 'provider account lease could not be acquired');
      }
      const acquired = acquiredLease as Partial<PreparedEvidenceLease>;
      if (
        typeof acquired.renew !== 'function' ||
        typeof acquired.release !== 'function' ||
        typeof acquired.renewIntervalMs !== 'number' ||
        !Number.isSafeInteger(acquired.renewIntervalMs) ||
        acquired.renewIntervalMs < 1
      ) {
        fail('LEASE_UNAVAILABLE', 'provider account lease does not expose a safe renewal contract');
      }
      lease = acquired as PreparedEvidenceLease;
    } catch (error) {
      if (canReleaseLease(acquiredLease)) {
        try {
          await acquiredLease.release();
        } catch {
          // Preserve the acquisition/contract error.
        }
      }
      if (error instanceof SaasPreparedEvidenceDispatchError && error.code === 'LEASE_UNAVAILABLE') throw error;
      fail('LEASE_UNAVAILABLE', 'provider account lease could not be acquired', error);
    }

    let evidence: PreparedRequestEvidenceRecord;
    let postClaimAttempt: AttemptRecord;
    try {
      if (input.client?.signal.aborted) {
        fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled before evidence claim');
      }
      evidence = await this.evidence.claimForDispatch(input.evidenceId, input.audit, claimOptions);
      // Claim is itself a versioned attempt update. Never fence dispatch using
      // the preflight snapshot or an inferred version increment.
      const current = await this.metering.getAttempt(
        preflightEvidence.tenantId,
        preflightEvidence.requestId,
        preflightEvidence.attemptId,
      );
      if (!current) fail('ATTEMPT_NOT_FOUND', 'claimed prepared evidence attempt was not found');
      assertPostClaimAttempt(current, evidence, preflightEvidence);
      if (input.client?.signal.aborted) {
        fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled before dispatch fencing');
      }
      postClaimAttempt = current;
    } catch (error) {
      await releaseBeforeDispatch(lease);
      throw error;
    }

    let dispatching: AttemptRecord;
    try {
      dispatching = await this.metering.transitionAttempt(transitionInput(postClaimAttempt, 'dispatching', 'pending', false));
    } catch (error) {
      await releaseBeforeDispatch(lease);
      fail('DISPATCH_STATE_CONFLICT', 'attempt could not be fenced for dispatch', error);
    }

    let outcome: PreparedEvidenceDispatchResult | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    let heartbeat: LeaseHeartbeat | undefined;
    let transportSignal: CombinedAbortSignal | undefined;
    let transportResult: PreparedEvidenceTransportResponse | undefined;
    let transportError: unknown;
    try {
      heartbeat = startLeaseHeartbeat(lease);
      transportSignal = combineAbortSignals(
        input.client ? [heartbeat.signal, input.client.signal] : [heartbeat.signal],
      );
      const delivery: ResponseDeliveryState = { responseStarted: false };
      let reconciliationPersisted = false;
      try {
        if (transportSignal.signal.aborted) {
          if (heartbeat.hasFailed()) {
            fail('CLIENT_STREAM_FAILED', 'provider account lease renewal failed before provider dispatch');
          }
          fail('CLIENT_STREAM_ABORTED', 'client response stream was cancelled before provider dispatch');
        }
        transportResult = requireTransportResponse(
          await this.transport.send({
            tenantId: evidence.tenantId,
            projectId: evidence.projectId,
            requestId: evidence.requestId,
            attemptId: evidence.attemptId,
            fencingToken: lease.fencingToken,
            signal: transportSignal.signal,
            payloadBytes,
            evidence,
          }),
        );
        await deliverTransportResponse(transportResult, input.client, heartbeat.signal, delivery, async () => {
          const completeResponse = transportResult;
          const status = completeResponse?.resultHttpStatus;
          if (
            !completeResponse ||
            typeof status !== 'number' ||
            !Number.isInteger(status) ||
            status < 300 ||
            status > 599
          ) {
            return;
          }

          const knownHttpResponseStarted = status >= 200 && status <= 599;
          const failedAttempt = await this.metering.recordKnownNonSuccessHttpResponse({
            tenantId: evidence.tenantId,
            requestId: evidence.requestId,
            attemptId: evidence.attemptId,
            resultHttpStatus: status,
            responseStarted: dispatching.responseStarted || delivery.responseStarted || knownHttpResponseStarted,
          });
          outcome = { kind: 'sent', evidence, attempt: failedAttempt, transport: completeResponse };
        });
      } catch (error) {
        if (!outcome) transportError = error;
        await heartbeat.stop();
        const leaseFailure = heartbeat.hasFailed()
          ? (heartbeat.failure() ?? new Error('provider account lease renewal failed'))
          : undefined;
        // Preserve an already durable terminal upstream result if client delivery then fails.
        if (!outcome) {
          if (input.normalSuccessSnapshot && this.normalSuccessSettlement) {
            const attempt = await this.normalSuccessSettlement.retainUnknown({
              tenantId: evidence.tenantId,
              requestId: evidence.requestId,
              attemptId: evidence.attemptId,
              supplyMode: input.normalSuccessSnapshot.supplyMode,
              responseStarted: dispatching.responseStarted || delivery.responseStarted,
              reason: 'dispatch_uncertain',
            });
            reconciliationPersisted = true;
            outcome = {
              kind: 'unknown',
              evidence,
              attempt,
              error: leaseFailure ?? error,
            };
          } else {
            outcome = await persistUnknown(
              this.metering,
              evidence,
              dispatching,
              dispatching.responseStarted || delivery.responseStarted,
              transportResult?.resultHttpStatus,
              leaseFailure
                ? 'provider account lease renewal failed while transport body was in flight'
                : 'prepared evidence transport or client stream outcome is unknown',
              leaseFailure ?? error,
            );
          }
        }
      }

      if (transportResult && !outcome) {
        await heartbeat.stop();
        const status = transportResult.resultHttpStatus;
        const knownHttpResponseStarted =
          typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599;
        const responseStarted = dispatching.responseStarted || delivery.responseStarted || knownHttpResponseStarted;
        if (heartbeat.hasFailed()) {
          const leaseFailure = heartbeat.failure() ?? new Error('provider account lease renewal failed');
          if (input.normalSuccessSnapshot && this.normalSuccessSettlement) {
            const attempt = await this.normalSuccessSettlement.retainUnknown({
              tenantId: evidence.tenantId,
              requestId: evidence.requestId,
              attemptId: evidence.attemptId,
              supplyMode: input.normalSuccessSnapshot.supplyMode,
              responseStarted,
              reason: 'dispatch_uncertain',
            });
            reconciliationPersisted = true;
            outcome = { kind: 'unknown', evidence, attempt, error: leaseFailure };
          } else {
            outcome = await persistUnknown(
              this.metering,
              evidence,
              dispatching,
              responseStarted,
              transportResult.resultHttpStatus,
              'provider account lease renewal failed before the transport result could be committed',
              leaseFailure,
            );
          }
        } else {
          let sentAttempt: AttemptRecord | undefined;
          try {
            sentAttempt = await this.metering.transitionAttempt(
              transitionInput(
                dispatching,
                'sent',
                'pending',
                responseStarted,
                undefined,
                transportResult.resultHttpStatus,
              ),
            );
          } catch (error) {
            if (input.normalSuccessSnapshot && this.normalSuccessSettlement) {
              const attempt = await this.normalSuccessSettlement.retainUnknown({
                tenantId: evidence.tenantId,
                requestId: evidence.requestId,
                attemptId: evidence.attemptId,
                supplyMode: input.normalSuccessSnapshot.supplyMode,
                responseStarted,
                reason: 'dispatch_uncertain',
              });
              reconciliationPersisted = true;
              outcome = { kind: 'unknown', evidence, attempt, error };
            } else {
              outcome = await persistUnknown(
                this.metering,
                evidence,
                dispatching,
                responseStarted,
                transportResult.resultHttpStatus,
                'transport completed but sent state could not be persisted; reconciliation is required',
                error,
              );
            }
          }
          if (sentAttempt) {
            outcome = { kind: 'sent', evidence, attempt: sentAttempt, transport: transportResult };
            const snapshot = input.normalSuccessSnapshot;
            const successfulHttpResponse =
              transportResult.resultHttpStatus !== null &&
              transportResult.resultHttpStatus !== undefined &&
              transportResult.resultHttpStatus >= 200 &&
              transportResult.resultHttpStatus < 300;
            if (snapshot && successfulHttpResponse && this.normalSuccessSettlement) {
              try {
                if (transportResult.providerUsage) {
                  const completion = await this.normalSuccessSettlement.complete({
                    tenantId: evidence.tenantId,
                    requestId: evidence.requestId,
                    attemptId: evidence.attemptId,
                    snapshot,
                    usage: transportResult.providerUsage,
                  });
                  reconciliationPersisted = completion.kind === 'reconciliation_pending';
                  outcome = { kind: 'sent', evidence, attempt: completion.attempt, transport: transportResult };
                } else {
                  const attempt = await this.normalSuccessSettlement.retainUnknown({
                    tenantId: evidence.tenantId,
                    requestId: evidence.requestId,
                    attemptId: evidence.attemptId,
                    supplyMode: snapshot.supplyMode,
                    responseStarted: sentAttempt.responseStarted,
                    reason: 'usage_missing',
                  });
                  reconciliationPersisted = true;
                  outcome = {
                    kind: 'unknown',
                    evidence,
                    attempt,
                    error: new Error('provider usage is missing; hold retained for reconciliation'),
                  };
                }
              } catch {
                const attempt = await this.normalSuccessSettlement.retainUnknown({
                  tenantId: evidence.tenantId,
                  requestId: evidence.requestId,
                  attemptId: evidence.attemptId,
                  supplyMode: snapshot.supplyMode,
                  responseStarted: sentAttempt.responseStarted,
                  reason: 'settlement_failed',
                });
                reconciliationPersisted = true;
                outcome = {
                  kind: 'unknown',
                  evidence,
                  attempt,
                  error: new Error('normal-success settlement failed; hold retained for reconciliation'),
                };
              }
            }
          }
        }
      }
      if (
        outcome?.kind === 'unknown' &&
        !reconciliationPersisted &&
        input.normalSuccessSnapshot &&
        this.normalSuccessSettlement
      ) {
        const attempt = await this.normalSuccessSettlement.retainUnknown({
          tenantId: evidence.tenantId,
          requestId: evidence.requestId,
          attemptId: evidence.attemptId,
          supplyMode: input.normalSuccessSnapshot.supplyMode,
          responseStarted: outcome.attempt.responseStarted,
          reason: 'dispatch_uncertain',
        });
        outcome = { ...outcome, attempt };
      }
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    } finally {
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (error) {
          if (!outcome && !hasPrimaryError) {
            primaryError = error;
            hasPrimaryError = true;
          }
        }
      }
      transportSignal?.dispose();
      const healthEvidence = runtimeHealthEvidence(transportResult, transportError);
      const healthCandidate = runtimeHealthCandidate(evidence);
      if (healthEvidence && healthCandidate && this.runtimeHealthWriter) {
        try {
          await this.runtimeHealthWriter.recordRuntimeOutcome({
            candidate: healthCandidate,
            attemptId: evidence.attemptId,
            fencingToken: lease.fencingToken,
            evidence: healthEvidence,
          });
        } catch {
          // The health store blocks future selections after a failed observation write.
        }
      }
      try {
        await lease.release();
      } catch (error) {
        const releaseFailure = leaseReleaseError(error);
        if (outcome) outcome = withLeaseReleaseError(outcome, releaseFailure);
        else if (!hasPrimaryError) {
          primaryError = releaseFailure;
          hasPrimaryError = true;
        }
      }
    }

    if (hasPrimaryError) throw primaryError;
    if (!outcome) fail('STATE_UPDATE_FAILED', 'dispatch did not produce a classified outcome');
    return outcome;
  }
}
