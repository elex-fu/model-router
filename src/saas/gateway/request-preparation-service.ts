import { createHash, randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import type { ApiKeyPrincipalKind, AuthenticatedApiKey } from '../keys/types.js';
import type {
  AuthorizedPlatformUpstreamCandidate,
  AuthorizedUpstreamCandidate,
  GatewayProtocol,
  ModelMappingRule,
  ModelResolutionProvenance,
  SupplyMode,
} from './contracts.js';
import { createModelResolutionProvenance } from './contracts.js';
import type { NormalSuccessSettlementSnapshot } from './dispatch-usage-settlement.js';
import {
  canonicalPreparedRequestEvidencePayload,
  type PreparedRequestEvidenceAudit,
  type PreparedRequestEvidenceInput,
  type PreparedRequestEvidenceRecord,
  type PreparedRequestUsageEnvelope,
} from './prepared-request-evidence-service.js';
import type { ProviderAccountSchedulerPort } from './provider-account-scheduler.js';
import type { GatewayRequestIdempotencyClaimed } from './request-idempotency.js';

/** Exact integers are kept at the orchestration boundary; no floating point is accepted. */
export type RequestPreparationExactInteger = bigint | number | string;

export type RequestPreparationStage =
  | 'caller'
  | 'entitlement'
  | 'authority'
  | 'payload'
  | 'admission'
  | 'attempt'
  | 'evidence'
  | 'dispatch';

export type RequestPreparationFailureCode =
  | 'invalid_input'
  | 'proxy_key_invalid'
  | 'proxy_key_disabled'
  | 'caller_denied'
  | 'entitlement_denied'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'hold_denied'
  | 'route_denied'
  | 'account_denied'
  | 'payload_invalid'
  | 'payload_bounds_unavailable'
  | 'capability_unavailable'
  | 'canonicalization_failed'
  | 'signing_failed'
  | 'attempt_persistence_failed'
  | 'evidence_registration_failed'
  | 'binding_mismatch'
  | 'idempotency_conflict'
  | 'idempotency_replay'
  | 'client_cancelled'
  | 'dispatch_failed'
  | 'storage_failure';

export interface RequestPreparationAllowed<T> {
  readonly decision: 'allow';
  readonly value: T;
}

export interface RequestPreparationRejected {
  readonly decision: 'reject';
  readonly code: RequestPreparationFailureCode;
  readonly message: string;
  readonly canonicalRequest?: CanonicalRequestStatusReference;
}

export interface RequestPreparationBlocked {
  readonly decision: 'block';
  readonly code: RequestPreparationFailureCode;
  readonly message: string;
}

export type RequestPreparationDecision<T> =
  | RequestPreparationAllowed<T>
  | RequestPreparationRejected
  | RequestPreparationBlocked;

export interface CanonicalRequestStatusReference {
  readonly requestId: string;
  readonly status: 'in_progress' | 'unknown' | 'completed';
}

export function allowRequestPreparation<T>(value: T): RequestPreparationAllowed<T> {
  return { decision: 'allow', value };
}

export function rejectRequestPreparation(
  code: RequestPreparationFailureCode,
  message: string,
  canonicalRequest?: CanonicalRequestStatusReference,
): RequestPreparationRejected {
  return { decision: 'reject', code, message, ...(canonicalRequest ? { canonicalRequest } : {}) };
}

export function blockRequestPreparation(
  code: RequestPreparationFailureCode,
  message: string,
): RequestPreparationBlocked {
  return { decision: 'block', code, message };
}

/** Only safe server-authenticated caller facts cross the preparation boundary. */
export interface RequestPreparationCaller {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly principalKind: ApiKeyPrincipalKind;
  readonly principalId: string;
  readonly entitlementId: string;
  readonly supplyProfileId: string;
  readonly supplyMode: SupplyMode;
  readonly modelScopes: readonly string[];
  readonly authzVersion: RequestPreparationExactInteger;
  readonly entitlementVersion: RequestPreparationExactInteger;
  readonly supplyProfileVersion: RequestPreparationExactInteger;
  readonly modelScopeVersion: RequestPreparationExactInteger;
}

export interface RequestPreparationRequestAudit {
  readonly entryPoint: string;
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
}

/**
 * Server-owned scheduling context. It contains opaque affinity references,
 * never a client-selected account. Attempted accounts are scoped to this
 * request's already-fixed supply mode and are only used for same-mode
 * failover.
 */
export interface RequestPreparationSchedulingContext {
  readonly attemptedAccountIds?: readonly string[];
  readonly previousResponseId?: string;
  readonly sessionId?: string;
}

/**
 * The caller is already authenticated by KeyService. Raw proxy keys, bearer
 * credentials, URLs, endpoints, and upstream secrets intentionally do not
 * appear in this input.
 */
export interface RequestPreparationInput {
  readonly authenticatedCaller: AuthenticatedApiKey;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly clientRequest: unknown;
  /** Opaque client dedupe key; it grants no pricing or authorization authority. */
  readonly idempotencyKey?: string;
  readonly audit: RequestPreparationRequestAudit;
  readonly scheduling?: RequestPreparationSchedulingContext;
}

export interface RequestPreparationCallerPort {
  validate(input: {
    readonly authenticatedCaller: AuthenticatedApiKey;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
  }): Promise<RequestPreparationDecision<RequestPreparationCaller>>;
}

/** Server-resolved project entitlement/profile and model/provider scope. */
export interface RequestPreparationEntitlement {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly entitlementId: string;
  readonly entitlementVersion: RequestPreparationExactInteger;
  readonly supplyProfileId: string;
  readonly supplyProfileVersion: RequestPreparationExactInteger;
  readonly supplyMode: SupplyMode;
  readonly modelScopeVersion: RequestPreparationExactInteger;
  readonly allowedModels: readonly string[];
  /** Required for BYOK; platform entitlements must not use this as supply authority. */
  readonly allowedProviderIds: readonly string[];
  readonly projectPolicyVersion: RequestPreparationExactInteger;
}

export interface RequestPreparationEntitlementPort {
  resolve(input: {
    readonly caller: RequestPreparationCaller;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
  }): Promise<RequestPreparationDecision<RequestPreparationEntitlement>>;
}

/** Route identity is server-owned; it cannot be selected by the client body. */
export interface RequestPreparationRouteAuthority {
  readonly tenantId: string;
  readonly projectId: string;
  readonly publicModel: string;
  readonly publicModelId: string;
  readonly publicModelVersion: RequestPreparationExactInteger;
  readonly routeConfigId: string;
  readonly routeConfigVersion: RequestPreparationExactInteger;
  readonly protocol: GatewayProtocol;
  /** Optional server-owned provider-side protocol for a protocol bridge. */
  readonly providerProtocol?: GatewayProtocol;
  /** Optional server-owned operation names; defaults are derived from protocol. */
  readonly clientOperation?: string;
  readonly providerOperation?: string;
  readonly targetMode: 'tenant_account' | 'platform_pool';
  readonly upstreamId: string;
  readonly endpoint: string;
}

export interface RequestPreparationCommercialAuthority {
  readonly customerMeteringPolicyId: string;
  readonly customerMeteringPolicyVersion: RequestPreparationExactInteger;
  readonly providerMeteringPolicyId: string;
  readonly providerMeteringPolicyVersion: RequestPreparationExactInteger;
  readonly contractAttestationId: string;
  readonly customerPriceVersion: string | null;
  readonly supplierCostVersion: string | null;
}

/**
 * This is the non-secret account/credential authority selected by a server
 * adapter. It intentionally contains credential identity and version only.
 */
export type RequestPreparationCandidateAuthority = AuthorizedUpstreamCandidate & {
  readonly providerId: string;
  readonly productId: string;
};

export interface RequestPreparationAuthority {
  readonly route: RequestPreparationRouteAuthority;
  readonly candidate: RequestPreparationCandidateAuthority;
  /** Optional candidate set for an injected account scheduler. */
  readonly candidates?: readonly RequestPreparationCandidateAuthority[];
  /** Server-owned mapping config; absent means an explicit passthrough mapping. */
  readonly modelMappingRules?: readonly ModelMappingRule[];
  /** Optional server-owned precomputed form of the same mapping decision. */
  readonly modelResolution?: ModelResolutionProvenance;
  /** Independent epoch of the platform pool-member relationship. */
  readonly poolMemberAuthzVersion: RequestPreparationExactInteger | null;
  readonly credentialRef: string;
  readonly configVersion: RequestPreparationExactInteger;
  readonly commercial: RequestPreparationCommercialAuthority;
}

export interface RequestPreparationAuthorityPort {
  resolve(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
  }): Promise<RequestPreparationDecision<RequestPreparationAuthority>>;
}

/** Bounds are derived by the server-owned payload compiler, never caller input. */
export type RequestPreparationPayloadBounds = PreparedRequestUsageEnvelope;

export interface RequestPreparationCompiledPayload {
  /** The exact bytes that a later transport must send to the selected route. */
  readonly payloadBytes: Uint8Array;
  /** Server-generated request fingerprint material/digest for metering idempotency. */
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  /** Exact compiler and estimator versions bound to the serialized payload. */
  readonly compilerVersion: string;
  readonly estimatorVersion: string;
  readonly usage: RequestPreparationPayloadBounds;
  /** Compiler output must preserve the complete non-secret model chain. */
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly resolvedModel: string;
  readonly modelResolution: ModelResolutionProvenance;
  /** Provider transport facts are server-owned compiler output. */
  readonly providerProtocol: GatewayProtocol;
  readonly providerOperation: string;
}

export interface RequestPreparationPayloadCompiler {
  compile(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly authority: RequestPreparationAuthority;
    readonly clientRequest: unknown;
    readonly clientProtocol: GatewayProtocol;
    readonly providerProtocol: GatewayProtocol;
    readonly clientOperation: string;
    readonly providerOperation: string;
    readonly modelResolution: ModelResolutionProvenance;
  }): Promise<RequestPreparationDecision<RequestPreparationCompiledPayload>>;
}

export interface RequestPreparationReservationReference {
  readonly reference: string;
  readonly state: 'reserved';
}

export interface RequestPreparationHoldReservation extends RequestPreparationReservationReference {
  readonly reservationId: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string;
  readonly amountMinorUnits: RequestPreparationExactInteger;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string | Date;
}

export interface RequestPreparationTokenBudget {
  readonly unit: 'tokens';
  readonly amount: number;
  readonly basis: 'reserved' | 'estimated' | 'explicit';
}

export interface RequestPreparationAdmission {
  readonly quotaReservation: RequestPreparationReservationReference;
  readonly rateReservation: RequestPreparationReservationReference;
  readonly holdReservation: RequestPreparationHoldReservation | null;
  /** Proof that this scoped key/fingerprint mapping was durably created before the hold. */
  readonly idempotencyBinding: {
    readonly state: 'created';
    readonly keyDigest: string;
    readonly requestFingerprint: string;
    readonly requestFingerprintVersion: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly proxyKeyId: string;
    readonly requestId: string;
  };
  readonly deadlineAtMs: number;
  readonly dispatchDeadline: string | Date;
  readonly expiresAt: string | Date;
  readonly remainingAttempts: number;
  readonly retryBudget: number;
  readonly attemptOrdinal: number;
  readonly usageBudget: RequestPreparationTokenBudget | null;
}

export interface RequestPreparationAdmissionPort {
  authorizeAndReserve(
    input: {
      readonly requestId: string;
      readonly attemptId: string;
      readonly idempotencyKey: string;
      /** Set by a trusted wrapper only after a fresh HMAC claim on this executor. */
      readonly idempotencyClaim?: GatewayRequestIdempotencyClaimed;
      readonly tenantId: string;
      readonly projectId: string;
      readonly proxyKeyId: string;
      readonly requestFingerprint: string;
      readonly requestFingerprintVersion: string;
      readonly caller: RequestPreparationCaller;
      readonly entitlement: RequestPreparationEntitlement;
      readonly authority: RequestPreparationAuthority;
      readonly payloadSha256: string;
      readonly payloadBounds: RequestPreparationPayloadBounds;
    },
    options?: RequestPreparationSqlOptions,
  ): Promise<RequestPreparationDecision<RequestPreparationAdmission>>;
}

/** The one transaction executor shared by every durable preparation write. */
export interface RequestPreparationSqlOptions {
  readonly executor: SqlExecutor;
}

/** Production preparation must be given a caller-owned outer transaction. */
export interface RequestPreparationTransactionPort {
  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

/** No request body is passed to persistence; only its digest is retained. */
export interface RequestPreparationAttemptPersistenceInput {
  readonly requestId: string;
  readonly attemptId: string;
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly authority: RequestPreparationAuthority;
  readonly admission: RequestPreparationAdmission;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly payloadSha256: string;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly modelResolution: ModelResolutionProvenance;
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: string;
  readonly providerOperation: string;
}

export interface RequestPreparationAttemptRecord {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly endpoint: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: RequestPreparationExactInteger;
  readonly supplyMode: SupplyMode;
  readonly upstreamId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly resolvedModel: string;
  /** Required provenance; it is never inferred from resolvedModel. */
  readonly modelResolution: ModelResolutionProvenance;
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: string;
  readonly providerOperation: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly payloadSha256: string;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly dispatchAuthorityState: 'bound';
  readonly dispatchState: 'not_sent';
  readonly resultState: 'pending';
  readonly responseStarted: false;
  readonly preparedEvidenceId: null;
}

export interface RequestPreparationAttemptPort {
  persist(
    input: RequestPreparationAttemptPersistenceInput,
    options?: RequestPreparationSqlOptions,
  ): Promise<RequestPreparationDecision<RequestPreparationAttemptRecord>>;
}

/**
 * Compensation is only for the pre-dispatch window. The adapter must
 * re-read the authoritative attempt and release quota, rate, and (when
 * present) wallet reservations only when that attempt is still
 * not_sent/pending with responseStarted=false. The operation must be
 * idempotent: a retry after a completed release must not release another
 * reservation or turn a dispatched attempt into a released one. The
 * expectedAttempt fields are a binding guard, not proof supplied by this
 * orchestrator; inability to prove the condition must retain the hold.
 */
export interface RequestPreparationCompensationInput {
  readonly requestId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly admission: RequestPreparationAdmission;
  readonly expectedAttempt: {
    readonly dispatchState: 'not_sent';
    readonly resultState: 'pending';
    readonly responseStarted: false;
  };
  readonly failedStage: RequestPreparationStage;
  readonly failureCode: RequestPreparationFailureCode;
  /** Server-owned evidence reference, supplied after preparation commits. */
  readonly evidenceId?: string;
  /** Local response delivery is an additional veto, never proof of non-execution. */
  readonly responseMayHaveStarted?: boolean;
}

export interface RequestPreparationCompensationResult {
  readonly requestId: string;
  readonly attemptId: string;
  readonly disposition: 'released' | 'retained_for_reconciliation';
  readonly quotaReservation: 'released' | 'retained_for_reconciliation';
  readonly rateReservation: 'released' | 'retained_for_reconciliation';
  readonly holdReservation: 'released' | 'retained_for_reconciliation' | 'not_applicable';
  readonly manualReconciliationRequired: boolean;
}

export interface RequestPreparationCompensationPort {
  releasePreDispatch(
    input: RequestPreparationCompensationInput,
    options?: RequestPreparationSqlOptions,
  ): Promise<RequestPreparationDecision<RequestPreparationCompensationResult>>;
}

export interface RequestPreparationEvidenceSignature {
  readonly signatureBase64: string;
}

export interface RequestPreparationEvidenceSigner {
  sign(input: {
    readonly verifierKeyId: string;
    readonly canonicalPayload: string;
    readonly canonicalPayloadSha256: string;
    readonly evidence: PreparedRequestEvidenceInput;
  }): Promise<RequestPreparationDecision<RequestPreparationEvidenceSignature>>;
}

export interface RequestPreparationEvidenceRegistrar {
  register(
    input: PreparedRequestEvidenceInput,
    options?: RequestPreparationSqlOptions,
  ): Promise<RequestPreparationDecision<PreparedRequestEvidenceRecord> | PreparedRequestEvidenceRecord>;
}

export interface RequestPreparationCanonicalizer {
  canonicalize(input: PreparedRequestEvidenceInput): string;
}

export interface RequestPreparationDependencies {
  readonly caller: RequestPreparationCallerPort;
  readonly entitlement: RequestPreparationEntitlementPort;
  readonly authority: RequestPreparationAuthorityPort;
  /** Optional selection path; absence preserves the existing single-candidate port. */
  readonly scheduler?: ProviderAccountSchedulerPort;
  readonly payload: RequestPreparationPayloadCompiler;
  readonly admission: RequestPreparationAdmissionPort;
  readonly attempt: RequestPreparationAttemptPort;
  /** Required for durable preparation; absence is a deliberate fail-closed result. */
  readonly transaction?: RequestPreparationTransactionPort;
  /** Missing compensation is an explicit retain-hold/manual-reconciliation outcome. */
  readonly compensation?: RequestPreparationCompensationPort;
  /** Optional only so a missing production capability returns blocked, not success. */
  readonly signer?: RequestPreparationEvidenceSigner;
  /** Optional only so a missing production capability returns blocked, not success. */
  readonly registrar?: RequestPreparationEvidenceRegistrar;
}

export interface RequestPreparationIdFactory {
  requestId(): string;
  attemptId(): string;
  evidenceId(): string;
}

export interface RequestPreparationServiceOptions {
  readonly now?: () => Date;
  readonly idFactory?: RequestPreparationIdFactory;
  /** Server configuration; never caller supplied. */
  readonly evidenceVerifierKeyId?: string;
  readonly canonicalizer?: RequestPreparationCanonicalizer;
}

export interface RequestPreparationFailureResult {
  readonly outcome: 'rejected' | 'blocked';
  readonly stage: RequestPreparationStage;
  readonly code: RequestPreparationFailureCode;
  readonly reason: string;
  readonly requestId?: string;
  readonly attemptId?: string;
  /** Reservations are never silently forgotten after admission succeeds. */
  readonly reservationDisposition?: 'released' | 'retained_for_reconciliation';
  readonly manualReconciliationRequired?: boolean;
  readonly compensation?: RequestPreparationCompensationResult | null;
  /** Existing canonical request reference for same-fingerprint idempotent retries. */
  readonly canonicalRequest?: CanonicalRequestStatusReference;
  /** A failure never returns evidence as if it were dispatchable. */
  readonly evidence: null;
}

export interface RequestPreparationPreparedResult {
  readonly outcome: 'prepared';
  readonly requestId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly payloadBytes: Uint8Array;
  readonly payloadSha256: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly endpoint: string;
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly resolvedModel: string;
  /** In-memory model provenance; this is not a persisted audit or billing fact. */
  readonly modelResolution: ModelResolutionProvenance;
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: string;
  readonly providerOperation: string;
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly authority: RequestPreparationAuthority;
  readonly admission: RequestPreparationAdmission;
  readonly normalSuccessSnapshot: NormalSuccessSettlementSnapshot;
  readonly attempt: RequestPreparationAttemptRecord;
  readonly evidenceInput: PreparedRequestEvidenceInput;
  readonly canonicalEvidencePayload: string;
  readonly canonicalEvidencePayloadSha256: string;
  readonly evidence: PreparedRequestEvidenceRecord;
}

export type RequestPreparationResult = RequestPreparationFailureResult | RequestPreparationPreparedResult;

const SUPPORTED_PROTOCOLS = new Set<GatewayProtocol>(['anthropic', 'openai', 'gemini', 'responses']);
const INPUT_BUCKETS = new Set(['input', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h']);
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const DIGEST = /^[0-9a-f]{64}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_REQUEST_ID = /^[\x21-\x7e]{1,256}$/;

function canonicalOperationForProtocol(protocol: GatewayProtocol): string {
  switch (protocol) {
    case 'anthropic':
      return 'messages';
    case 'openai':
      return 'chat.completions';
    case 'gemini':
      return 'generateContent';
    case 'responses':
      return 'responses';
  }
}

function normalizeOperationForProtocol(value: unknown, protocol: GatewayProtocol): string | null {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) return null;
  const normalized = value === 'chat/completions' ? 'chat.completions' : value;
  return normalized === canonicalOperationForProtocol(protocol) ? normalized : null;
}

interface RequestPreparationRouteFacts {
  readonly clientProtocol: GatewayProtocol;
  readonly providerProtocol: GatewayProtocol;
  readonly clientOperation: string;
  readonly providerOperation: string;
}

function routeFacts(
  authority: RequestPreparationAuthority,
  clientProtocol: GatewayProtocol,
): RequestPreparationRouteFacts {
  const providerProtocol = authority.route.providerProtocol ?? authority.candidate.protocol;
  return {
    clientProtocol,
    providerProtocol,
    clientOperation:
      normalizeOperationForProtocol(authority.route.clientOperation, clientProtocol) ??
      canonicalOperationForProtocol(clientProtocol),
    providerOperation:
      normalizeOperationForProtocol(authority.route.providerOperation, providerProtocol) ??
      canonicalOperationForProtocol(providerProtocol),
  };
}

interface ValidationIssue {
  readonly code: RequestPreparationFailureCode;
  readonly message: string;
}

interface IssuedIds {
  readonly requestId: string;
  readonly attemptId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown, _label: string): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function exactInteger(value: unknown, _label: string, allowZero = true): string | null {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) parsed = BigInt(value.trim());
    else return null;
  } catch {
    return null;
  }
  if (parsed < (allowZero ? 0n : 1n) || parsed > MAX_POSTGRES_BIGINT) return null;
  return parsed.toString(10);
}

function exactVersion(value: unknown, label: string): string | null {
  return exactInteger(value, label, false);
}

function validProviderScope(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (providerId) => typeof providerId === 'string' && providerId.trim() !== '' && providerId === providerId.trim(),
    )
  );
}

function iso(value: unknown): string | null {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function issue(code: RequestPreparationFailureCode, message: string): ValidationIssue {
  return { code, message };
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizePreparedFingerprint(value: string, version: string): string {
  const normalized = value.trim();
  const canonicalVersion = version.trim();
  if (normalized === '' || canonicalVersion === '') throw new TypeError('request fingerprint is incomplete');
  return DIGEST.test(normalized) ? normalized.toLowerCase() : digestText(`${canonicalVersion}\u0000${normalized}`);
}

function failure(
  outcome: 'rejected' | 'blocked',
  stage: RequestPreparationStage,
  code: RequestPreparationFailureCode,
  reason: string,
  ids?: IssuedIds,
  reservation?: {
    readonly reservationDisposition: 'released' | 'retained_for_reconciliation';
    readonly manualReconciliationRequired: boolean;
    readonly compensation?: RequestPreparationCompensationResult | null;
  },
): RequestPreparationFailureResult {
  return {
    outcome,
    stage,
    code,
    reason,
    ...(ids === undefined ? {} : ids),
    ...(reservation === undefined ? {} : reservation),
    evidence: null,
  };
}

function decisionFailure(
  stage: RequestPreparationStage,
  decision: RequestPreparationRejected | RequestPreparationBlocked,
  ids?: IssuedIds,
): RequestPreparationFailureResult {
  const result = failure(
    decision.decision === 'reject' ? 'rejected' : 'blocked',
    stage,
    decision.code,
    decision.message,
    ids,
  );
  return decision.decision === 'reject' && decision.canonicalRequest
    ? { ...result, canonicalRequest: decision.canonicalRequest }
    : result;
}

function isDecision<T>(value: unknown): value is RequestPreparationDecision<T> {
  if (!isRecord(value) || (value.decision !== 'allow' && value.decision !== 'reject' && value.decision !== 'block')) {
    return false;
  }
  if (value.decision === 'allow') return 'value' in value;
  if (typeof value.code !== 'string' || typeof value.message !== 'string' || value.message.trim() === '') return false;
  if (value.canonicalRequest === undefined) return true;
  return (
    value.decision === 'reject' &&
    value.code === 'idempotency_replay' &&
    isRecord(value.canonicalRequest) &&
    typeof value.canonicalRequest.requestId === 'string' &&
    SAFE_REQUEST_ID.test(value.canonicalRequest.requestId) &&
    (value.canonicalRequest.status === 'in_progress' ||
      value.canonicalRequest.status === 'unknown' ||
      value.canonicalRequest.status === 'completed')
  );
}

function adapterFailure(stage: RequestPreparationStage, ids?: IssuedIds): RequestPreparationFailureResult {
  const code: RequestPreparationFailureCode =
    stage === 'payload'
      ? 'payload_invalid'
      : stage === 'attempt'
        ? 'attempt_persistence_failed'
        : stage === 'evidence'
          ? 'evidence_registration_failed'
          : 'capability_unavailable';
  return failure('blocked', stage, code, `${stage} adapter failed closed`, ids);
}

function validateAuthenticatedCaller(input: RequestPreparationInput, now: Date): ValidationIssue | null {
  if (!isRecord(input)) return issue('invalid_input', 'request preparation input is invalid');
  const key = input.authenticatedCaller;
  if (!isRecord(key) || !isRecord(key.metadata) || !isRecord(key.authorization)) {
    return issue('proxy_key_invalid', 'an authenticated Proxy Key snapshot is required');
  }

  const metadata = key.metadata as Partial<AuthenticatedApiKey['metadata']>;
  const authorization = key.authorization as Partial<AuthenticatedApiKey['authorization']>;
  if (metadata.status !== 'active') return issue('proxy_key_disabled', 'Proxy Key is not active');
  if (metadata.expiresAt !== null && metadata.expiresAt !== undefined) {
    const expiresAt = iso(metadata.expiresAt);
    if (expiresAt === null) return issue('proxy_key_invalid', 'Proxy Key expiry is invalid');
    if (new Date(expiresAt).getTime() <= now.getTime()) return issue('proxy_key_disabled', 'Proxy Key has expired');
  }

  const identityPairs: readonly [unknown, unknown][] = [
    [metadata.id, authorization.keyId],
    [metadata.tenantId, authorization.tenantId],
    [metadata.projectId, authorization.projectId],
    [metadata.entitlementId, authorization.entitlementId],
    [metadata.supplyProfileId, authorization.supplyProfileId],
    [metadata.supplyMode, authorization.supplyMode],
    [metadata.executionPrincipalType, authorization.principalKind],
    [metadata.executionPrincipalId, authorization.principalId],
  ];
  if (identityPairs.some(([left, right]) => typeof left !== 'string' || typeof right !== 'string' || left !== right)) {
    return issue('proxy_key_invalid', 'Proxy Key authorization snapshot is inconsistent');
  }
  const metadataScopes = metadata.modelScopes;
  const authorizationScopes = authorization.modelScopes;
  if (
    !Array.isArray(metadataScopes) ||
    !Array.isArray(authorizationScopes) ||
    metadataScopes.length === 0 ||
    metadataScopes.length !== authorizationScopes.length ||
    metadataScopes.some((scope) => typeof scope !== 'string' || scope.trim() === '') ||
    authorizationScopes.some((scope) => typeof scope !== 'string' || scope.trim() === '') ||
    new Set(metadataScopes).size !== metadataScopes.length ||
    new Set(authorizationScopes).size !== authorizationScopes.length ||
    metadataScopes.some((scope, index) => scope !== authorizationScopes[index])
  ) {
    return issue('proxy_key_invalid', 'Proxy Key model scope snapshot is inconsistent');
  }
  if (
    (authorization.supplyMode !== 'platform' && authorization.supplyMode !== 'byok') ||
    (authorization.principalKind !== 'member' && authorization.principalKind !== 'project_service')
  ) {
    return issue('proxy_key_invalid', 'Proxy Key execution authority is invalid');
  }
  const versionPairs: readonly [unknown, unknown, string][] = [
    [metadata.authzVersion, authorization.authzVersion, 'authzVersion'],
    [metadata.modelScopeVersion, authorization.modelScopeVersion, 'modelScopeVersion'],
    [metadata.entitlementAuthzVersion, authorization.entitlementAuthzVersion, 'entitlementVersion'],
    [metadata.supplyProfileAuthzVersion, authorization.supplyProfileAuthzVersion, 'supplyProfileVersion'],
  ];
  if (
    versionPairs.some(
      ([metadataVersion, authorizationVersion, label]) =>
        exactVersion(metadataVersion, label) === null ||
        exactVersion(metadataVersion, label) !== exactVersion(authorizationVersion, label),
    )
  ) {
    return issue('proxy_key_invalid', 'Proxy Key authorization versions are inconsistent');
  }
  if (
    authorization.entitlementId === null ||
    authorization.entitlementId === undefined ||
    authorization.supplyProfileId === null ||
    authorization.supplyProfileId === undefined
  ) {
    return issue('proxy_key_invalid', 'Proxy Key has no durable entitlement binding');
  }
  if (
    exactVersion(authorization.authzVersion, 'authzVersion') === null ||
    exactVersion(authorization.entitlementAuthzVersion, 'entitlementVersion') === null ||
    exactVersion(authorization.supplyProfileAuthzVersion, 'supplyProfileVersion') === null ||
    exactVersion(authorization.modelScopeVersion, 'modelScopeVersion') === null
  ) {
    return issue('proxy_key_invalid', 'Proxy Key authorization versions are invalid');
  }
  if (!SUPPORTED_PROTOCOLS.has(input.protocol) || nonEmpty(input.publicModel, 'publicModel') === null) {
    return issue('invalid_input', 'public model and protocol are required');
  }
  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.length === 0 ||
      input.idempotencyKey.length > 255 ||
      input.idempotencyKey.trim() !== input.idempotencyKey ||
      [...input.idempotencyKey].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x21 || code > 0x7e;
      }))
  ) {
    return issue('invalid_input', 'Idempotency-Key is invalid');
  }
  if (!isRecord(input.audit) || nonEmpty(input.audit.entryPoint, 'audit.entryPoint') === null) {
    return issue('invalid_input', 'audit entry point is required');
  }
  for (const field of ['sourceIp', 'userAgent'] as const) {
    const value = input.audit[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return issue('invalid_input', `audit.${field} is invalid`);
    }
  }
  return null;
}

function callerFromSnapshot(input: RequestPreparationInput): RequestPreparationCaller {
  const authorization = input.authenticatedCaller.authorization;
  return {
    tenantId: authorization.tenantId,
    projectId: authorization.projectId,
    proxyKeyId: authorization.keyId,
    principalKind: authorization.principalKind,
    principalId: authorization.principalId,
    entitlementId: authorization.entitlementId,
    supplyProfileId: authorization.supplyProfileId,
    supplyMode: authorization.supplyMode,
    modelScopes: [...authorization.modelScopes],
    authzVersion: authorization.authzVersion,
    entitlementVersion: authorization.entitlementAuthzVersion,
    supplyProfileVersion: authorization.supplyProfileAuthzVersion,
    modelScopeVersion: authorization.modelScopeVersion,
  };
}

function validateCallerFacts(caller: RequestPreparationCaller, input: RequestPreparationInput): ValidationIssue | null {
  const expected = callerFromSnapshot(input);
  const pairs: readonly [string, unknown, unknown][] = [
    ['tenantId', caller.tenantId, expected.tenantId],
    ['projectId', caller.projectId, expected.projectId],
    ['proxyKeyId', caller.proxyKeyId, expected.proxyKeyId],
    ['principalKind', caller.principalKind, expected.principalKind],
    ['principalId', caller.principalId, expected.principalId],
    ['entitlementId', caller.entitlementId, expected.entitlementId],
    ['supplyProfileId', caller.supplyProfileId, expected.supplyProfileId],
    ['supplyMode', caller.supplyMode, expected.supplyMode],
    ['authzVersion', caller.authzVersion, expected.authzVersion],
    ['entitlementVersion', caller.entitlementVersion, expected.entitlementVersion],
    ['supplyProfileVersion', caller.supplyProfileVersion, expected.supplyProfileVersion],
    ['modelScopeVersion', caller.modelScopeVersion, expected.modelScopeVersion],
  ];
  if (pairs.some(([, actual, wanted]) => actual !== wanted)) {
    return issue('caller_denied', 'caller authority does not match the authenticated Proxy Key snapshot');
  }
  if (!Array.isArray(caller.modelScopes) || caller.modelScopes.length === 0) {
    return issue('caller_denied', 'caller model scope is empty');
  }
  if (new Set(caller.modelScopes).size !== caller.modelScopes.length) {
    return issue('caller_denied', 'caller model scope is ambiguous');
  }
  if (caller.principalKind !== 'member' && caller.principalKind !== 'project_service') {
    return issue('caller_denied', 'caller principal kind is invalid');
  }
  if (caller.principalKind === 'project_service' && caller.principalId !== caller.projectId) {
    return issue('caller_denied', 'project-service authority must be bound to its project');
  }
  return null;
}

function validateEntitlement(
  entitlement: RequestPreparationEntitlement,
  caller: RequestPreparationCaller,
  publicModel: string,
): ValidationIssue | null {
  const pairs: readonly [unknown, unknown][] = [
    [entitlement.tenantId, caller.tenantId],
    [entitlement.projectId, caller.projectId],
    [entitlement.proxyKeyId, caller.proxyKeyId],
    [entitlement.entitlementId, caller.entitlementId],
    [entitlement.supplyProfileId, caller.supplyProfileId],
    [entitlement.supplyMode, caller.supplyMode],
    [
      exactVersion(entitlement.entitlementVersion, 'entitlementVersion'),
      exactVersion(caller.entitlementVersion, 'entitlementVersion'),
    ],
    [
      exactVersion(entitlement.supplyProfileVersion, 'supplyProfileVersion'),
      exactVersion(caller.supplyProfileVersion, 'supplyProfileVersion'),
    ],
    [
      exactVersion(entitlement.modelScopeVersion, 'modelScopeVersion'),
      exactVersion(caller.modelScopeVersion, 'modelScopeVersion'),
    ],
  ];
  if (pairs.some(([actual, expected]) => actual === null || actual === undefined || actual !== expected)) {
    return issue('capability_unavailable', 'entitlement authority is inconsistent with the Proxy Key binding');
  }
  if (exactVersion(entitlement.projectPolicyVersion, 'projectPolicyVersion') === null) {
    return issue('capability_unavailable', 'project inference policy version is unavailable');
  }
  if (
    !Array.isArray(entitlement.allowedModels) ||
    entitlement.allowedModels.length === 0 ||
    new Set(entitlement.allowedModels).size !== entitlement.allowedModels.length
  ) {
    return issue('capability_unavailable', 'entitlement model scope is unavailable');
  }
  if (caller.supplyMode === 'byok' && !validProviderScope(entitlement.allowedProviderIds)) {
    return issue('capability_unavailable', 'BYOK provider scope is unavailable');
  }
  if (!caller.modelScopes.includes(publicModel) || !entitlement.allowedModels.includes(publicModel)) {
    return issue('entitlement_denied', 'the caller is not entitled to the requested model');
  }
  return null;
}

function candidateOptionalValue(candidate: AuthorizedUpstreamCandidate, key: string): unknown {
  return (candidate as unknown as Record<string, unknown>)[key];
}

function validateAuthority(
  authority: RequestPreparationAuthority,
  caller: RequestPreparationCaller,
  entitlement: RequestPreparationEntitlement,
  publicModel: string,
  protocol: GatewayProtocol,
): ValidationIssue | null {
  if (!isRecord(authority) || !isRecord(authority.route) || !isRecord(authority.candidate)) {
    return issue('capability_unavailable', 'route/account authority is unavailable');
  }
  const route = authority.route;
  const candidate = authority.candidate;
  const providerProtocol = route.providerProtocol ?? candidate.protocol;
  const routeStrings: readonly [unknown, string][] = [
    [route.tenantId, caller.tenantId],
    [route.projectId, caller.projectId],
    [route.publicModel, publicModel],
    [route.protocol, protocol],
    [route.upstreamId, candidate.upstreamId],
    [route.endpoint, candidate.endpoint],
  ];
  if (routeStrings.some(([actual, expected]) => typeof actual !== 'string' || actual !== expected)) {
    return issue('binding_mismatch', 'route authority does not match the server request or account candidate');
  }
  if (
    nonEmpty(route.publicModelId, 'route.publicModelId') === null ||
    exactVersion(route.publicModelVersion, 'route.publicModelVersion') === null ||
    nonEmpty(route.routeConfigId, 'route.routeConfigId') === null ||
    exactVersion(route.routeConfigVersion, 'routeConfigVersion') === null ||
    nonEmpty(route.endpoint, 'route.endpoint') === null ||
    exactVersion(authority.configVersion, 'configVersion') === null
  ) {
    return issue('capability_unavailable', 'route authority is incomplete');
  }
  if (!SUPPORTED_PROTOCOLS.has(providerProtocol)) {
    return issue('capability_unavailable', 'provider protocol authority is unsupported');
  }
  if (
    (route.clientOperation !== undefined && normalizeOperationForProtocol(route.clientOperation, protocol) === null) ||
    (route.providerOperation !== undefined &&
      normalizeOperationForProtocol(route.providerOperation, providerProtocol) === null)
  ) {
    return issue('capability_unavailable', 'route operation authority is unsupported');
  }

  const candidatePairs: readonly [unknown, unknown][] = [
    [candidate.tenantId, caller.tenantId],
    [candidate.projectId, caller.projectId],
    [candidate.proxyKeyId, caller.proxyKeyId],
    [candidate.supplyProfileId, entitlement.supplyProfileId],
    [candidate.supplyMode, entitlement.supplyMode],
    [candidate.protocol, protocol],
    [candidate.credentialId, authority.credentialRef],
  ];
  if (candidatePairs.some(([actual, expected]) => typeof actual !== 'string' || actual !== expected)) {
    return issue('binding_mismatch', 'account authority does not match the caller, route, or credential reference');
  }
  if (!SUPPORTED_PROTOCOLS.has(candidate.protocol)) {
    return issue('capability_unavailable', 'client protocol authority is unsupported');
  }
  const candidateStrings: readonly unknown[] = [
    candidate.upstreamId,
    candidate.accountId,
    candidate.credentialId,
    candidate.dispatchProfileId,
    candidate.resolvedModel,
    candidate.providerId,
    candidate.productId,
  ];
  if (candidateStrings.some((value) => nonEmpty(value, 'candidate') === null)) {
    return issue('capability_unavailable', 'account authority is incomplete');
  }
  if (candidate.supplyMode === 'byok') {
    if (!validProviderScope(entitlement.allowedProviderIds)) {
      return issue('capability_unavailable', 'BYOK provider scope is unavailable');
    }
    const authorizedProviders = new Set(entitlement.allowedProviderIds);
    const candidates = authority.candidates ?? [candidate];
    if (
      candidates.some(
        (candidateValue) => candidateValue.supplyMode !== 'byok' || !authorizedProviders.has(candidateValue.providerId),
      )
    ) {
      return issue('binding_mismatch', 'BYOK authority contains a provider outside the plan scope');
    }
  }
  for (const [value, label] of [
    [candidate.credentialVersion, 'credentialVersion'],
    [candidate.credentialAuthzVersion, 'credentialAuthzVersion'],
    [candidate.accountAuthzVersion, 'accountAuthzVersion'],
    [candidate.supplyProfileAuthzVersion, 'supplyProfileAuthzVersion'],
  ] as const) {
    if (exactVersion(value, label) === null) return issue('capability_unavailable', `candidate ${label} is invalid`);
  }

  const expectedTargetMode = candidate.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  if (route.targetMode !== expectedTargetMode)
    return issue('binding_mismatch', 'route target mode does not match supply mode');
  if (
    (candidate.supplyMode === 'byok' && candidate.accountOwnerKind !== 'tenant') ||
    (candidate.supplyMode === 'platform' && candidate.accountOwnerKind !== 'platform')
  ) {
    return issue('binding_mismatch', 'account owner kind does not match supply mode');
  }

  if (candidate.supplyMode === 'byok') {
    if (exactVersion(candidate.profileAccountAuthzVersion, 'profileAccountAuthzVersion') === null) {
      return issue('capability_unavailable', 'tenant account/profile authority is unavailable');
    }
    const forbiddenPoolFields = [
      'poolId',
      'poolAuthzVersion',
      'poolMemberAccountAuthzVersion',
      'poolMemberAuthzVersion',
      'poolGrantAuthzVersion',
      'poolGrantProfileAuthzVersion',
      'poolGrantPoolAuthzVersion',
    ];
    if (forbiddenPoolFields.some((field) => candidateOptionalValue(candidate, field) !== undefined)) {
      return issue('binding_mismatch', 'BYOK authority contains platform-pool fields');
    }
  } else {
    const candidatePoolMemberAuthzVersion =
      candidateOptionalValue(candidate, 'poolMemberAuthzVersion') ?? authority.poolMemberAuthzVersion;
    if (
      authority.candidates !== undefined &&
      candidateOptionalValue(candidate, 'poolMemberAuthzVersion') === undefined
    ) {
      return issue('capability_unavailable', 'platform candidate pool-member authority is unavailable');
    }
    const requiredPoolFields = [
      ['poolId', candidate.poolId],
      ['poolAuthzVersion', candidate.poolAuthzVersion],
      ['poolMemberAccountAuthzVersion', candidate.poolMemberAccountAuthzVersion],
      ['poolMemberAuthzVersion', candidatePoolMemberAuthzVersion],
      ['poolGrantAuthzVersion', candidate.poolGrantAuthzVersion],
      ['poolGrantProfileAuthzVersion', candidate.poolGrantProfileAuthzVersion],
      ['poolGrantPoolAuthzVersion', candidate.poolGrantPoolAuthzVersion],
    ] as const;
    for (const [label, value] of requiredPoolFields) {
      if (label === 'poolId' ? nonEmpty(value, label) === null : exactVersion(value, label) === null) {
        return issue('capability_unavailable', `platform ${label} is unavailable`);
      }
    }
    if (exactVersion(authority.poolMemberAuthzVersion, 'poolMemberAuthzVersion') === null) {
      return issue('capability_unavailable', 'platform pool-member relationship authority is unavailable');
    }
    if (candidateOptionalValue(candidate, 'profileAccountAuthzVersion') !== undefined) {
      return issue('binding_mismatch', 'platform authority contains a tenant profile-account field');
    }
  }
  if (candidate.supplyMode === 'byok' && authority.poolMemberAuthzVersion !== null) {
    return issue('binding_mismatch', 'BYOK authority contains a platform pool-member epoch');
  }

  const commercial = authority.commercial;
  if (!isRecord(commercial)) return issue('capability_unavailable', 'commercial route authority is unavailable');
  for (const [value, label] of [
    [commercial.customerMeteringPolicyId, 'customerMeteringPolicyId'],
    [commercial.providerMeteringPolicyId, 'providerMeteringPolicyId'],
    [commercial.contractAttestationId, 'contractAttestationId'],
  ] as const) {
    if (nonEmpty(value, label) === null) return issue('capability_unavailable', `${label} is unavailable`);
  }
  for (const [value, label] of [
    [commercial.customerMeteringPolicyVersion, 'customerMeteringPolicyVersion'],
    [commercial.providerMeteringPolicyVersion, 'providerMeteringPolicyVersion'],
  ] as const) {
    if (exactVersion(value, label) === null) return issue('capability_unavailable', `${label} is invalid`);
  }
  if (candidate.supplyMode === 'byok') {
    if (commercial.customerPriceVersion !== null || commercial.supplierCostVersion !== null) {
      return issue('binding_mismatch', 'BYOK authority cannot carry platform price or supplier-cost versions');
    }
    if (candidate.supplierCostVersion !== null) {
      return issue('binding_mismatch', 'BYOK candidate cannot carry a supplier-cost version');
    }
  } else {
    if (
      nonEmpty(commercial.customerPriceVersion, 'customerPriceVersion') === null ||
      nonEmpty(commercial.supplierCostVersion, 'supplierCostVersion') === null ||
      candidate.supplierCostVersion !== commercial.supplierCostVersion
    ) {
      return issue('capability_unavailable', 'platform price/cost authority is incomplete or mismatched');
    }
  }
  return null;
}

function authorityForCandidate(
  authority: RequestPreparationAuthority,
  candidate: RequestPreparationCandidateAuthority,
): RequestPreparationAuthority {
  return {
    ...authority,
    candidate,
    poolMemberAuthzVersion:
      candidate.supplyMode === 'platform'
        ? (candidate.poolMemberAuthzVersion ?? authority.poolMemberAuthzVersion)
        : null,
    credentialRef: candidate.credentialId,
  };
}

function candidateSelectionMatchesSource(
  source: readonly RequestPreparationCandidateAuthority[],
  selected: RequestPreparationCandidateAuthority,
): boolean {
  return source.some(
    (candidate) =>
      candidate.tenantId === selected.tenantId &&
      candidate.projectId === selected.projectId &&
      candidate.proxyKeyId === selected.proxyKeyId &&
      candidate.supplyProfileId === selected.supplyProfileId &&
      candidate.supplyMode === selected.supplyMode &&
      candidate.upstreamId === selected.upstreamId &&
      candidate.accountId === selected.accountId &&
      candidate.credentialId === selected.credentialId &&
      candidate.providerId === selected.providerId &&
      candidate.productId === selected.productId &&
      candidate.resolvedModel === selected.resolvedModel &&
      candidate.protocol === selected.protocol &&
      candidate.endpoint === selected.endpoint &&
      candidate.supplierCostVersion === selected.supplierCostVersion,
  );
}

function normalizedModelResolution(
  value: unknown,
  requestedModel: string,
  resolvedModel: string,
): ModelResolutionProvenance | ValidationIssue {
  if (!isRecord(value)) return issue('capability_unavailable', 'model resolution authority is unavailable');
  if (value.requestedModel !== requestedModel || value.resolvedModel !== resolvedModel) {
    return issue('binding_mismatch', 'model resolution is not bound to the requested and resolved models');
  }
  const mappedModel = nonEmpty(value.mappedModel, 'mappedModel');
  if (mappedModel === null) return issue('capability_unavailable', 'model resolution mapped model is unavailable');
  const mappingSource = value.mappingSource;
  if (mappingSource !== 'none' && mappingSource !== 'alias' && mappingSource !== 'wildcard') {
    return issue('capability_unavailable', 'model resolution mapping source is invalid');
  }
  const mappingVersion = value.mappingVersion;
  if (
    mappingVersion !== null &&
    (typeof mappingVersion !== 'number' || !Number.isSafeInteger(mappingVersion) || mappingVersion < 1)
  ) {
    return issue('capability_unavailable', 'model resolution mapping version is invalid');
  }
  if (mappingSource === 'none') {
    if (mappedModel !== requestedModel || resolvedModel !== requestedModel || mappingVersion !== null) {
      return issue('capability_unavailable', 'non-identity model resolution has no mapping source or version');
    }
  } else if (mappingVersion === null) {
    return issue('capability_unavailable', 'mapped model resolution has no mapping version');
  }
  return {
    requestedModel,
    mappedModel,
    resolvedModel,
    mappingSource,
    mappingVersion,
  };
}

function validateModelResolution(
  value: unknown,
  requestedModel: string,
  resolvedModel: string,
): ValidationIssue | null {
  const normalized = normalizedModelResolution(value, requestedModel, resolvedModel);
  return 'code' in normalized ? normalized : null;
}

function sameModelResolution(value: unknown, expected: ModelResolutionProvenance): boolean {
  return (
    isRecord(value) &&
    value.requestedModel === expected.requestedModel &&
    value.mappedModel === expected.mappedModel &&
    value.resolvedModel === expected.resolvedModel &&
    value.mappingSource === expected.mappingSource &&
    value.mappingVersion === expected.mappingVersion
  );
}

function modelResolutionFor(
  publicModel: string,
  resolvedModel: string,
  authority: RequestPreparationAuthority,
): ModelResolutionProvenance | ValidationIssue {
  if (authority.modelResolution !== undefined) {
    return normalizedModelResolution(authority.modelResolution, publicModel, resolvedModel);
  }
  try {
    const created = createModelResolutionProvenance(publicModel, resolvedModel, authority.modelMappingRules ?? []);
    return normalizedModelResolution(created, publicModel, resolvedModel);
  } catch {
    return issue('capability_unavailable', 'model mapping authority is unavailable');
  }
}

interface RequestPreparationPayloadFacts extends RequestPreparationRouteFacts {
  readonly modelResolution: ModelResolutionProvenance;
}

function validatePayload(
  payload: RequestPreparationCompiledPayload,
  expected: RequestPreparationPayloadFacts,
): ValidationIssue | null {
  if (!isRecord(payload) || !(payload.payloadBytes instanceof Uint8Array) || payload.payloadBytes.byteLength === 0) {
    return issue('payload_invalid', 'server-owned final payload bytes are required');
  }
  if (nonEmpty(payload.requestFingerprint, 'requestFingerprint') === null) {
    return issue('payload_invalid', 'server-owned request fingerprint is required');
  }
  if (nonEmpty(payload.requestFingerprintVersion, 'requestFingerprintVersion') === null) {
    return issue('payload_invalid', 'request fingerprint version is required');
  }
  if (nonEmpty(payload.compilerVersion, 'compilerVersion') === null) {
    return issue('payload_invalid', 'payload compiler version is required');
  }
  if (nonEmpty(payload.estimatorVersion, 'estimatorVersion') === null) {
    return issue('payload_invalid', 'usage estimator version is required');
  }
  if (
    payload.requestedModel !== expected.modelResolution.requestedModel ||
    payload.mappedModel !== expected.modelResolution.mappedModel ||
    payload.resolvedModel !== expected.modelResolution.resolvedModel
  ) {
    return issue('binding_mismatch', 'compiled payload model identity does not match server authority');
  }
  if (
    payload.providerProtocol !== expected.providerProtocol ||
    payload.providerOperation !== expected.providerOperation
  ) {
    return issue('binding_mismatch', 'compiled payload provider route does not match server authority');
  }
  const payloadResolution = normalizedModelResolution(
    payload.modelResolution,
    expected.modelResolution.requestedModel,
    expected.modelResolution.resolvedModel,
  );
  if ('code' in payloadResolution) return payloadResolution;
  if (!sameModelResolution(payloadResolution, expected.modelResolution)) {
    return issue('binding_mismatch', 'compiled payload model resolution does not match server authority');
  }
  const usage = payload.usage;
  if (!isRecord(usage)) return issue('payload_bounds_unavailable', 'server-owned payload usage bounds are required');
  const fields = [
    'inputTotalUpperBound',
    'inputUncachedUpperBound',
    'cacheReadUpperBound',
    'cacheWriteUpperBound',
    'cacheWrite5mUpperBound',
    'cacheWrite1hUpperBound',
    'outputTotalUpperBound',
    'reasoningOutputUpperBound',
  ] as const;
  const normalized = new Map<string, bigint>();
  for (const field of fields) {
    const value = exactInteger(usage[field], field);
    if (value === null) return issue('payload_bounds_unavailable', `payload bound ${field} is invalid`);
    normalized.set(field, BigInt(value));
  }
  const inputTotal = normalized.get('inputTotalUpperBound');
  const outputTotal = normalized.get('outputTotalUpperBound');
  const inputUncached = normalized.get('inputUncachedUpperBound');
  const cacheRead = normalized.get('cacheReadUpperBound');
  const cacheWrite = normalized.get('cacheWriteUpperBound');
  const cacheWrite5m = normalized.get('cacheWrite5mUpperBound');
  const cacheWrite1h = normalized.get('cacheWrite1hUpperBound');
  const reasoningOutput = normalized.get('reasoningOutputUpperBound');
  if (
    inputTotal === undefined ||
    outputTotal === undefined ||
    inputUncached === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite5m === undefined ||
    cacheWrite1h === undefined ||
    reasoningOutput === undefined
  ) {
    return issue('payload_bounds_unavailable', 'payload bounds are incomplete');
  }
  if (
    inputUncached > inputTotal ||
    cacheRead > inputTotal ||
    cacheWrite > inputTotal ||
    cacheWrite5m > inputTotal ||
    cacheWrite1h > inputTotal ||
    reasoningOutput > outputTotal
  ) {
    return issue('payload_bounds_unavailable', 'payload bounds exceed their signed totals');
  }
  if (
    !Array.isArray(usage.feasibleInputBuckets) ||
    usage.feasibleInputBuckets.length === 0 ||
    new Set(usage.feasibleInputBuckets).size !== usage.feasibleInputBuckets.length ||
    usage.feasibleInputBuckets.some((bucket) => typeof bucket !== 'string' || !INPUT_BUCKETS.has(bucket))
  ) {
    return issue('payload_bounds_unavailable', 'payload feasible input buckets are invalid');
  }
  return null;
}

function validateReservationReference(value: unknown, label: string): ValidationIssue | null {
  if (!isRecord(value) || value.state !== 'reserved' || nonEmpty(value.reference, `${label}.reference`) === null) {
    return issue('capability_unavailable', `${label} was not durably reserved`);
  }
  return null;
}

function validateAdmission(
  admission: RequestPreparationAdmission,
  mode: SupplyMode,
  caller: RequestPreparationCaller,
  requestId: string,
  requestFingerprint: string,
  requestFingerprintVersion: string,
  now: Date,
): ValidationIssue | null {
  if (!isRecord(admission)) return issue('capability_unavailable', 'admission result is unavailable');
  const binding = admission.idempotencyBinding;
  if (
    !isRecord(binding) ||
    binding.state !== 'created' ||
    typeof binding.keyDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(binding.keyDigest) ||
    binding.requestFingerprint !== requestFingerprint ||
    binding.requestFingerprintVersion !== requestFingerprintVersion ||
    binding.tenantId !== caller.tenantId ||
    binding.projectId !== caller.projectId ||
    binding.proxyKeyId !== caller.proxyKeyId ||
    binding.requestId !== requestId
  ) {
    return issue('capability_unavailable', 'admission did not persist the scoped idempotency mapping');
  }
  const quotaIssue = validateReservationReference(admission.quotaReservation, 'quota reservation');
  if (quotaIssue) return quotaIssue;
  const rateIssue = validateReservationReference(admission.rateReservation, 'rate reservation');
  if (rateIssue) return rateIssue;
  if (!Number.isSafeInteger(admission.deadlineAtMs) || admission.deadlineAtMs <= now.getTime()) {
    return issue('capability_unavailable', 'dispatch deadline is invalid or expired');
  }
  const dispatchDeadline = iso(admission.dispatchDeadline);
  const expiresAt = iso(admission.expiresAt);
  if (dispatchDeadline === null || expiresAt === null)
    return issue('capability_unavailable', 'admission window is invalid');
  if (new Date(dispatchDeadline).getTime() !== admission.deadlineAtMs) {
    return issue('capability_unavailable', 'dispatch deadline does not match its server timestamp');
  }
  if (new Date(expiresAt).getTime() < new Date(dispatchDeadline).getTime()) {
    return issue('capability_unavailable', 'evidence expiry precedes dispatch deadline');
  }
  if (
    !Number.isSafeInteger(admission.remainingAttempts) ||
    admission.remainingAttempts < 1 ||
    !Number.isSafeInteger(admission.retryBudget) ||
    admission.retryBudget < 0 ||
    admission.retryBudget > 1000 ||
    !Number.isSafeInteger(admission.attemptOrdinal) ||
    admission.attemptOrdinal < 1 ||
    admission.attemptOrdinal > admission.retryBudget + 1
  ) {
    return issue('capability_unavailable', 'attempt budget is invalid');
  }
  if (admission.usageBudget !== null) {
    if (
      !isRecord(admission.usageBudget) ||
      admission.usageBudget.unit !== 'tokens' ||
      !Number.isSafeInteger(admission.usageBudget.amount) ||
      admission.usageBudget.amount < 0 ||
      !['reserved', 'estimated', 'explicit'].includes(admission.usageBudget.basis)
    ) {
      return issue('capability_unavailable', 'usage budget is invalid');
    }
  }

  if (mode === 'byok') {
    if (admission.holdReservation !== null)
      return issue('binding_mismatch', 'BYOK cannot reserve a platform wallet hold');
    return null;
  }

  const hold = admission.holdReservation;
  if (!isRecord(hold) || hold.state !== 'reserved') {
    return issue('capability_unavailable', 'platform wallet hold is unavailable');
  }
  if (hold.tenantId !== caller.tenantId || hold.requestId !== requestId) {
    return issue('binding_mismatch', 'platform wallet hold is not bound to the authenticated tenant and request');
  }
  if (
    nonEmpty(hold.reference, 'hold.reference') === null ||
    nonEmpty(hold.reservationId, 'hold.reservationId') === null ||
    nonEmpty(hold.tenantId, 'hold.tenantId') === null ||
    nonEmpty(hold.requestId, 'hold.requestId') === null ||
    !/^[A-Z]{3}$/.test(hold.currency) ||
    exactInteger(hold.amountMinorUnits, 'amountMinorUnits', false) === null ||
    nonEmpty(hold.priceSnapshotRef, 'priceSnapshotRef') === null
  ) {
    return issue('capability_unavailable', 'platform wallet hold authority is incomplete');
  }
  const holdExpiry = iso(hold.expiresAt);
  if (holdExpiry === null || holdExpiry !== expiresAt) {
    return issue('binding_mismatch', 'platform wallet hold expiry is not bound to the admission window');
  }
  return null;
}

function validateAttempt(
  attempt: RequestPreparationAttemptRecord,
  ids: IssuedIds,
  caller: RequestPreparationCaller,
  authority: RequestPreparationAuthority,
  admission: RequestPreparationAdmission,
  publicModel: string,
  protocol: GatewayProtocol,
  modelResolution: ModelResolutionProvenance,
  route: RequestPreparationRouteFacts,
  requestFingerprint: string,
  requestFingerprintVersion: string,
  payloadSha256: string,
  payloadCompilerVersion: string,
  usageEstimatorVersion: string,
): ValidationIssue | null {
  if (!isRecord(attempt)) return issue('attempt_persistence_failed', 'attempt persistence returned no attempt');
  const pairs: readonly [unknown, unknown][] = [
    [attempt.tenantId, caller.tenantId],
    [attempt.projectId, caller.projectId],
    [attempt.proxyKeyId, caller.proxyKeyId],
    [attempt.requestId, ids.requestId],
    [attempt.attemptId, ids.attemptId],
    [attempt.attemptOrdinal, admission.attemptOrdinal],
    [attempt.publicModel, publicModel],
    [attempt.protocol, protocol],
    [attempt.endpoint, authority.route.endpoint],
    [attempt.routeConfigId, authority.route.routeConfigId],
    [
      exactVersion(attempt.routeConfigVersion, 'routeConfigVersion'),
      exactVersion(authority.route.routeConfigVersion, 'routeConfigVersion'),
    ],
    [attempt.supplyMode, authority.candidate.supplyMode],
    [attempt.upstreamId, authority.candidate.upstreamId],
    [attempt.accountId, authority.candidate.accountId],
    [attempt.credentialId, authority.candidate.credentialId],
    [attempt.resolvedModel, authority.candidate.resolvedModel],
    [attempt.clientProtocol, route.clientProtocol],
    [attempt.providerProtocol, route.providerProtocol],
    [attempt.clientOperation, route.clientOperation],
    [attempt.providerOperation, route.providerOperation],
    [attempt.requestFingerprint, requestFingerprint],
    [attempt.requestFingerprintVersion, requestFingerprintVersion],
    [attempt.payloadSha256, payloadSha256],
    [attempt.payloadCompilerVersion, payloadCompilerVersion],
    [attempt.usageEstimatorVersion, usageEstimatorVersion],
  ];
  if (pairs.some(([actual, expected]) => actual !== expected)) {
    return issue('binding_mismatch', 'persisted attempt does not match server authority');
  }
  if (attempt.modelResolution === undefined) {
    return issue('binding_mismatch', 'persisted attempt omitted model resolution provenance');
  }
  const modelResolutionIssue = validateModelResolution(
    attempt.modelResolution,
    publicModel,
    modelResolution.resolvedModel,
  );
  if (modelResolutionIssue) return modelResolutionIssue;
  if (!sameModelResolution(attempt.modelResolution, modelResolution)) {
    return issue('binding_mismatch', 'persisted attempt model resolution does not match server authority');
  }
  if (
    attempt.dispatchAuthorityState !== 'bound' ||
    attempt.dispatchState !== 'not_sent' ||
    attempt.resultState !== 'pending' ||
    attempt.responseStarted !== false ||
    attempt.preparedEvidenceId !== null
  ) {
    return issue('binding_mismatch', 'persisted attempt is not a fresh bound attempt');
  }
  return null;
}

function validateCompensationResult(
  compensation: RequestPreparationCompensationResult,
  ids: IssuedIds,
  admission: RequestPreparationAdmission,
  mode: SupplyMode,
): ValidationIssue | null {
  if (!isRecord(compensation)) return issue('storage_failure', 'compensation returned no release outcome');
  if (!isRecord(admission)) return issue('storage_failure', 'compensation admission binding is unavailable');
  if (compensation.requestId !== ids.requestId || compensation.attemptId !== ids.attemptId) {
    return issue('binding_mismatch', 'compensation outcome is not bound to the prepared request and attempt');
  }
  if (compensation.disposition !== 'released' && compensation.disposition !== 'retained_for_reconciliation') {
    return issue('storage_failure', 'compensation disposition is invalid');
  }
  if (compensation.quotaReservation !== 'released' && compensation.quotaReservation !== 'retained_for_reconciliation') {
    return issue('storage_failure', 'quota compensation outcome is invalid');
  }
  if (compensation.rateReservation !== 'released' && compensation.rateReservation !== 'retained_for_reconciliation') {
    return issue('storage_failure', 'rate compensation outcome is invalid');
  }
  if (
    compensation.holdReservation !== 'released' &&
    compensation.holdReservation !== 'retained_for_reconciliation' &&
    compensation.holdReservation !== 'not_applicable'
  ) {
    return issue('storage_failure', 'hold compensation outcome is invalid');
  }
  if (typeof compensation.manualReconciliationRequired !== 'boolean') {
    return issue('storage_failure', 'compensation reconciliation state is invalid');
  }

  const holdExists = mode === 'platform' && admission.holdReservation !== null;
  if (mode === 'byok' && compensation.holdReservation !== 'not_applicable') {
    return issue('binding_mismatch', 'BYOK compensation cannot release a platform wallet hold');
  }
  if (!holdExists && compensation.holdReservation !== 'not_applicable') {
    return issue('binding_mismatch', 'compensation reported a wallet hold that was not admitted');
  }
  if (holdExists && compensation.holdReservation === 'not_applicable') {
    return issue('binding_mismatch', 'platform compensation did not account for the wallet hold');
  }

  const resourceOutcomes = [
    compensation.quotaReservation,
    compensation.rateReservation,
    ...(holdExists ? [compensation.holdReservation] : []),
  ];
  const retainedResource = resourceOutcomes.some((outcome) => outcome === 'retained_for_reconciliation');
  const releasedResource = resourceOutcomes.every((outcome) => outcome === 'released');
  if (compensation.disposition === 'released') {
    if (!releasedResource || compensation.manualReconciliationRequired) {
      return issue('storage_failure', 'compensation claims release without releasing every reservation');
    }
  } else if (!compensation.manualReconciliationRequired || !retainedResource) {
    return issue('storage_failure', 'retained compensation must require manual reconciliation');
  }
  return null;
}

function auditForEvidence(
  audit: RequestPreparationRequestAudit,
  caller: RequestPreparationCaller,
  requestId: string,
): PreparedRequestEvidenceAudit {
  return {
    actorUserId: caller.principalKind === 'member' ? caller.principalId : null,
    entryPoint: audit.entryPoint,
    sourceIp: audit.sourceIp ?? null,
    userAgent: audit.userAgent ?? null,
    requestId,
  };
}

function evidenceInputFor(
  input: RequestPreparationInput,
  caller: RequestPreparationCaller,
  entitlement: RequestPreparationEntitlement,
  authority: RequestPreparationAuthority,
  admission: RequestPreparationAdmission,
  payload: RequestPreparationCompiledPayload,
  payloadSha256: string,
  requestFingerprint: string,
  ids: IssuedIds,
  evidenceId: string,
  verifierKeyId: string,
  modelResolution: ModelResolutionProvenance,
  route: RequestPreparationRouteFacts,
): PreparedRequestEvidenceInput {
  const candidate = authority.candidate;
  const hold = admission.holdReservation;
  const platform = candidate.supplyMode === 'platform';
  const platformCandidate = platform ? (candidate as AuthorizedPlatformUpstreamCandidate) : null;
  return {
    evidenceId,
    tenantId: caller.tenantId,
    projectId: caller.projectId,
    requestId: ids.requestId,
    attemptId: ids.attemptId,
    attemptOrdinal: admission.attemptOrdinal,
    proxyKeyId: caller.proxyKeyId,
    entitlementId: entitlement.entitlementId,
    entitlementVersion: entitlement.entitlementVersion,
    supplyProfileId: entitlement.supplyProfileId,
    supplyProfileVersion: entitlement.supplyProfileVersion,
    modelScopeVersion: entitlement.modelScopeVersion,
    supplyMode: candidate.supplyMode,
    principalKind: caller.principalKind,
    principalId: caller.principalId,
    authzVersion: caller.authzVersion,
    configVersion: authority.configVersion,
    projectPolicyVersion: entitlement.projectPolicyVersion,
    publicModel: input.publicModel,
    protocol: input.protocol,
    modelResolution,
    clientProtocol: route.clientProtocol,
    providerProtocol: route.providerProtocol,
    clientOperation: route.clientOperation,
    providerOperation: route.providerOperation,
    endpoint: authority.route.endpoint,
    routeConfigId: authority.route.routeConfigId,
    routeConfigVersion: authority.route.routeConfigVersion,
    routePublicModelId: authority.route.publicModelId,
    routePublicModelVersion: authority.route.publicModelVersion,
    routeProtocol: authority.route.protocol,
    routeTargetMode: authority.route.targetMode,
    routeUpstreamId: authority.route.upstreamId,
    upstreamId: candidate.upstreamId,
    accountOwnerKind: candidate.accountOwnerKind,
    accountId: candidate.accountId,
    providerId: candidate.providerId,
    productId: candidate.productId,
    resolvedModel: candidate.resolvedModel,
    dispatchProfileId: candidate.dispatchProfileId,
    supplyProfileAuthzVersion: candidate.supplyProfileAuthzVersion,
    credentialId: candidate.credentialId,
    credentialVersion: candidate.credentialVersion,
    credentialAuthzVersion: candidate.credentialAuthzVersion,
    accountAuthzVersion: candidate.accountAuthzVersion,
    profileAccountAuthzVersion: candidate.supplyMode === 'byok' ? candidate.profileAccountAuthzVersion : null,
    poolId: platformCandidate?.poolId ?? null,
    poolAuthzVersion: platformCandidate?.poolAuthzVersion ?? null,
    poolMemberAccountAuthzVersion: platformCandidate?.poolMemberAccountAuthzVersion ?? null,
    poolMemberAuthzVersion: platform
      ? (platformCandidate?.poolMemberAuthzVersion ?? authority.poolMemberAuthzVersion)
      : null,
    poolGrantAuthzVersion: platformCandidate?.poolGrantAuthzVersion ?? null,
    poolGrantProfileAuthzVersion: platformCandidate?.poolGrantProfileAuthzVersion ?? null,
    poolGrantPoolAuthzVersion: platformCandidate?.poolGrantPoolAuthzVersion ?? null,
    customerMeteringPolicyId: authority.commercial.customerMeteringPolicyId,
    customerMeteringPolicyVersion: authority.commercial.customerMeteringPolicyVersion,
    providerMeteringPolicyId: authority.commercial.providerMeteringPolicyId,
    providerMeteringPolicyVersion: authority.commercial.providerMeteringPolicyVersion,
    contractAttestationId: authority.commercial.contractAttestationId,
    customerPriceVersion: authority.commercial.customerPriceVersion,
    supplierCostVersion: authority.commercial.supplierCostVersion,
    requestFingerprint,
    requestFingerprintVersion: payload.requestFingerprintVersion.trim(),
    payloadCompilerVersion: payload.compilerVersion.trim(),
    usageEstimatorVersion: payload.estimatorVersion.trim(),
    payloadSha256,
    usage: payload.usage,
    maxHoldCurrency: platform ? (hold?.currency ?? null) : null,
    maxHoldMinorUnits: platform ? (hold?.amountMinorUnits ?? '0') : '0',
    dispatchDeadline: admission.dispatchDeadline,
    expiresAt: admission.expiresAt,
    retryBudget: admission.retryBudget,
    verifierKeyId,
    signatureBase64: '',
    audit: auditForEvidence(input.audit, caller, ids.requestId),
  };
}

function validateRegisteredEvidence(
  evidence: PreparedRequestEvidenceRecord,
  input: PreparedRequestEvidenceInput,
): ValidationIssue | null {
  if (!isRecord(evidence)) return issue('evidence_registration_failed', 'evidence registrar returned no record');
  const pairs: readonly [unknown, unknown][] = [
    [evidence.evidenceId, input.evidenceId],
    [evidence.tenantId, input.tenantId],
    [evidence.projectId, input.projectId],
    [evidence.requestId, input.requestId],
    [evidence.attemptId, input.attemptId],
    [evidence.supplyMode, input.supplyMode],
    [evidence.publicModel, input.publicModel],
    [evidence.protocol, input.protocol],
    [evidence.endpoint, input.endpoint],
    [evidence.upstreamId, input.upstreamId],
    [evidence.accountId, input.accountId],
    [evidence.credentialId, input.credentialId],
    [evidence.routeTargetMode, input.routeTargetMode],
    [evidence.payloadSha256, input.payloadSha256],
    [evidence.requestFingerprint, input.requestFingerprint],
    [evidence.requestFingerprintVersion, input.requestFingerprintVersion],
    [evidence.payloadCompilerVersion, input.payloadCompilerVersion],
    [evidence.usageEstimatorVersion, input.usageEstimatorVersion],
  ];
  if (pairs.some(([actual, expected]) => actual !== expected)) {
    return issue('binding_mismatch', 'registered prepared evidence is not bound to the attempt or final payload');
  }
  if (input.modelResolution !== undefined && !sameModelResolution(evidence.modelResolution, input.modelResolution)) {
    return issue('binding_mismatch', 'registered prepared evidence omitted model resolution provenance');
  }
  if (
    input.clientProtocol !== undefined &&
    (evidence.clientProtocol !== input.clientProtocol ||
      evidence.providerProtocol !== input.providerProtocol ||
      evidence.clientOperation !== input.clientOperation ||
      evidence.providerOperation !== input.providerOperation)
  ) {
    return issue('binding_mismatch', 'registered prepared evidence omitted trusted route operations');
  }
  if (evidence.status !== 'registered' || evidence.claimedAt !== null || evidence.claimedAttemptId !== null) {
    return issue('binding_mismatch', 'prepared evidence is not a fresh registered proof');
  }
  if (!DIGEST.test(evidence.statementSha256)) {
    return issue('evidence_registration_failed', 'prepared evidence statement digest is invalid');
  }
  return null;
}

const defaultIds: RequestPreparationIdFactory = {
  requestId: randomUUID,
  attemptId: randomUUID,
  evidenceId: randomUUID,
};

const defaultCanonicalizer: RequestPreparationCanonicalizer = {
  canonicalize: canonicalPreparedRequestEvidencePayload,
};

class RequestPreparationTransactionRollback extends Error {
  constructor(readonly result: RequestPreparationFailureResult) {
    super('request preparation transaction must roll back');
    this.name = 'RequestPreparationTransactionRollback';
  }
}

/**
 * Composes hosted request preparation only. It never performs provider I/O.
 * Each injected port must map its concrete service's domain errors to an
 * explicit reject/block decision; thrown adapter errors are converted to a
 * blocked result and can never become a prepared request.
 */
export class SaasRequestPreparationService {
  private readonly now: () => Date;
  private readonly ids: RequestPreparationIdFactory;
  private readonly canonicalizer: RequestPreparationCanonicalizer;
  private readonly evidenceVerifierKeyId: string | null;

  constructor(
    private readonly dependencies: RequestPreparationDependencies,
    options: RequestPreparationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ids = options.idFactory ?? defaultIds;
    this.canonicalizer = options.canonicalizer ?? defaultCanonicalizer;
    this.evidenceVerifierKeyId = nonEmpty(options.evidenceVerifierKeyId, 'evidenceVerifierKeyId');
  }

  async prepare(input: RequestPreparationInput): Promise<RequestPreparationResult> {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return failure('blocked', 'caller', 'capability_unavailable', 'request preparation clock is unavailable');
    }
    const inputIssue = validateAuthenticatedCaller(input, now);
    if (inputIssue) return failure('rejected', 'caller', inputIssue.code, inputIssue.message);

    const callerDecision = await this.invokeDecision('caller', () =>
      this.dependencies.caller.validate({
        authenticatedCaller: input.authenticatedCaller,
        publicModel: input.publicModel,
        protocol: input.protocol,
      }),
    );
    if (callerDecision.decision !== 'allow') return decisionFailure('caller', callerDecision);
    const caller = callerDecision.value;
    const callerIssue = validateCallerFacts(caller, input);
    if (callerIssue) return failure('rejected', 'caller', callerIssue.code, callerIssue.message);
    const entitlementDecision = await this.invokeDecision('entitlement', () =>
      this.dependencies.entitlement.resolve({ caller, publicModel: input.publicModel, protocol: input.protocol }),
    );
    if (entitlementDecision.decision !== 'allow') return decisionFailure('entitlement', entitlementDecision);
    const entitlement = entitlementDecision.value;
    const entitlementIssue = validateEntitlement(entitlement, caller, input.publicModel);
    if (entitlementIssue) {
      const outcome = entitlementIssue.code === 'entitlement_denied' ? 'rejected' : 'blocked';
      return failure(outcome, 'entitlement', entitlementIssue.code, entitlementIssue.message);
    }

    const authorityDecision = await this.invokeDecision('authority', () =>
      this.dependencies.authority.resolve({
        caller,
        entitlement,
        publicModel: input.publicModel,
        protocol: input.protocol,
      }),
    );
    if (authorityDecision.decision !== 'allow') return decisionFailure('authority', authorityDecision);
    let authority = authorityDecision.value;

    const preSelectionAuthorityIssue = validateAuthority(
      authority,
      caller,
      entitlement,
      input.publicModel,
      input.protocol,
    );
    if (preSelectionAuthorityIssue) {
      return failure('blocked', 'authority', preSelectionAuthorityIssue.code, preSelectionAuthorityIssue.message);
    }

    let ids: IssuedIds;
    try {
      ids = {
        requestId: nonEmpty(this.ids.requestId(), 'requestId') ?? '',
        attemptId: nonEmpty(this.ids.attemptId(), 'attemptId') ?? '',
      };
    } catch {
      return adapterFailure('admission');
    }
    if (ids.requestId === '' || ids.attemptId === '') return adapterFailure('admission');

    const scheduler = this.dependencies.scheduler;
    if (scheduler !== undefined) {
      const candidates = authority.candidates ?? [authority.candidate];
      const schedulerDecision = await this.invokeDecision('authority', () =>
        scheduler.select({
          requestId: ids.requestId,
          caller,
          entitlement,
          candidates,
          publicModel: input.publicModel,
          protocol: input.protocol,
          route: authority.route,
          scheduling: input.scheduling,
        }),
      );
      if (schedulerDecision.decision !== 'allow') return decisionFailure('authority', schedulerDecision, ids);
      if (!candidateSelectionMatchesSource(candidates, schedulerDecision.value)) {
        return failure(
          'blocked',
          'authority',
          'binding_mismatch',
          'scheduler selected an account outside the authorized candidate set',
          ids,
        );
      }
      if (input.scheduling?.attemptedAccountIds?.includes(schedulerDecision.value.accountId)) {
        return failure(
          'blocked',
          'authority',
          'binding_mismatch',
          'scheduler selected an account already attempted for this request mode',
          ids,
        );
      }
      if (input.scheduling?.previousResponseId !== undefined || input.scheduling?.sessionId !== undefined) {
        if (!scheduler.bindAffinity) {
          return failure(
            'blocked',
            'authority',
            'capability_unavailable',
            'provider account affinity binding is unavailable',
            ids,
          );
        }
        let affinityBinding: unknown;
        try {
          affinityBinding = await scheduler.bindAffinity({
            caller,
            entitlement,
            publicModel: input.publicModel,
            protocol: input.protocol,
            context: input.scheduling,
            route: authority.route,
            candidate: schedulerDecision.value,
          });
        } catch {
          return failure(
            'blocked',
            'authority',
            'capability_unavailable',
            'provider account affinity binding failed closed',
            ids,
          );
        }
        if (
          !isRecord(affinityBinding) ||
          (affinityBinding.decision !== 'allow' && affinityBinding.decision !== 'block')
        ) {
          return failure(
            'blocked',
            'authority',
            'capability_unavailable',
            'provider account affinity authority returned an invalid binding decision',
            ids,
          );
        }
        if (affinityBinding.decision === 'block') {
          return failure(
            'blocked',
            'authority',
            'capability_unavailable',
            nonEmpty(affinityBinding.reason, 'affinity reason') ?? 'provider account affinity binding is unavailable',
            ids,
          );
        }
      }
      authority = authorityForCandidate(authority, schedulerDecision.value);
    } else if (authority.candidates !== undefined || input.scheduling !== undefined) {
      return failure(
        'blocked',
        'authority',
        'capability_unavailable',
        'request candidate selection requires an account scheduler',
        ids,
      );
    }

    const authorityIssue = validateAuthority(authority, caller, entitlement, input.publicModel, input.protocol);
    if (authorityIssue) {
      return failure('blocked', 'authority', authorityIssue.code, authorityIssue.message, ids);
    }
    const modelResolutionResult = modelResolutionFor(input.publicModel, authority.candidate.resolvedModel, authority);
    if ('code' in modelResolutionResult) {
      return failure('blocked', 'authority', modelResolutionResult.code, modelResolutionResult.message, ids);
    }
    const modelResolution = modelResolutionResult;
    const preparationRoute = routeFacts(authority, input.protocol);
    const payloadFacts: RequestPreparationPayloadFacts = { ...preparationRoute, modelResolution };

    const payloadDecision = await this.invokeDecision('payload', () =>
      this.dependencies.payload.compile({
        caller,
        entitlement,
        authority,
        clientRequest: input.clientRequest,
        clientProtocol: preparationRoute.clientProtocol,
        providerProtocol: preparationRoute.providerProtocol,
        clientOperation: preparationRoute.clientOperation,
        providerOperation: preparationRoute.providerOperation,
        modelResolution,
      }),
    );
    if (payloadDecision.decision !== 'allow') return decisionFailure('payload', payloadDecision);
    const payload = payloadDecision.value;
    const payloadIssue = validatePayload(payload, payloadFacts);
    if (payloadIssue) return failure('blocked', 'payload', payloadIssue.code, payloadIssue.message, ids);
    const payloadBytes = new Uint8Array(payload.payloadBytes);
    const payloadSha256 = digestBytes(payloadBytes);
    const requestFingerprint = normalizePreparedFingerprint(
      payload.requestFingerprint,
      payload.requestFingerprintVersion,
    );
    const requestFingerprintVersion = payload.requestFingerprintVersion.trim();
    const payloadCompilerVersion = payload.compilerVersion.trim();
    const usageEstimatorVersion = payload.estimatorVersion.trim();

    const transaction = this.dependencies.transaction;
    if (transaction === undefined) {
      return failure(
        'blocked',
        'admission',
        'capability_unavailable',
        'durable request preparation requires one caller-owned SQL transaction',
        ids,
      );
    }

    const durableWork = async (executor: SqlExecutor): Promise<RequestPreparationResult> => {
      const compensateAndFail = (
        stage: RequestPreparationStage,
        code: RequestPreparationFailureCode,
        reason: string,
        localIds: IssuedIds,
        tenantId: string,
        admission: RequestPreparationAdmission,
        mode: SupplyMode,
      ): Promise<RequestPreparationFailureResult> =>
        this.compensateAndFail(stage, code, reason, localIds, tenantId, admission, mode, { executor });

      const admissionIdempotencyKey = input.idempotencyKey ?? ids.requestId;
      const admissionDecision = await this.invokeDecision('admission', () =>
        this.dependencies.admission.authorizeAndReserve(
          {
            requestId: ids.requestId,
            attemptId: ids.attemptId,
            idempotencyKey: admissionIdempotencyKey,
            tenantId: caller.tenantId,
            projectId: caller.projectId,
            proxyKeyId: caller.proxyKeyId,
            requestFingerprint,
            requestFingerprintVersion,
            caller,
            entitlement,
            authority,
            payloadSha256,
            payloadBounds: payload.usage,
          },
          { executor },
        ),
      );
      if (admissionDecision.decision !== 'allow') return decisionFailure('admission', admissionDecision, ids);
      const admission = admissionDecision.value;
      const admissionIssue = validateAdmission(
        admission,
        authority.candidate.supplyMode,
        caller,
        ids.requestId,
        requestFingerprint,
        requestFingerprintVersion,
        now,
      );
      if (admissionIssue) {
        return compensateAndFail(
          'admission',
          admissionIssue.code,
          admissionIssue.message,
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }

      const attemptDecision = await this.invokeDecision('attempt', () =>
        this.dependencies.attempt.persist(
          {
            requestId: ids.requestId,
            attemptId: ids.attemptId,
            caller,
            entitlement,
            authority,
            admission,
            publicModel: input.publicModel,
            protocol: input.protocol,
            requestFingerprint,
            requestFingerprintVersion,
            payloadSha256,
            payloadCompilerVersion,
            usageEstimatorVersion,
            modelResolution,
            clientProtocol: preparationRoute.clientProtocol,
            providerProtocol: preparationRoute.providerProtocol,
            clientOperation: preparationRoute.clientOperation,
            providerOperation: preparationRoute.providerOperation,
          },
          { executor },
        ),
      );
      if (attemptDecision.decision !== 'allow') {
        return compensateAndFail(
          'attempt',
          attemptDecision.code,
          attemptDecision.message,
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }
      const attempt = attemptDecision.value;
      const attemptIssue = validateAttempt(
        attempt,
        ids,
        caller,
        authority,
        admission,
        input.publicModel,
        input.protocol,
        modelResolution,
        preparationRoute,
        requestFingerprint,
        requestFingerprintVersion,
        payloadSha256,
        payloadCompilerVersion,
        usageEstimatorVersion,
      );
      if (attemptIssue) {
        return compensateAndFail(
          'attempt',
          attemptIssue.code,
          attemptIssue.message,
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }

      const signer = this.dependencies.signer;
      const registrar = this.dependencies.registrar;
      const verifierKeyId = this.evidenceVerifierKeyId;
      if (verifierKeyId === null || signer === undefined || registrar === undefined) {
        return compensateAndFail(
          'evidence',
          'capability_unavailable',
          'prepared evidence signer and registrar are required before dispatch preparation',
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }

      let evidenceId: string;
      try {
        evidenceId = nonEmpty(this.ids.evidenceId(), 'evidenceId') ?? '';
      } catch {
        return compensateAndFail(
          'evidence',
          'capability_unavailable',
          'evidence identifier allocation failed',
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }
      if (evidenceId === '') {
        return compensateAndFail(
          'evidence',
          'capability_unavailable',
          'evidence identifier is empty',
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }

      let unsignedEvidence: PreparedRequestEvidenceInput;
      try {
        unsignedEvidence = evidenceInputFor(
          input,
          caller,
          entitlement,
          authority,
          admission,
          payload,
          payloadSha256,
          requestFingerprint,
          ids,
          evidenceId,
          verifierKeyId,
          modelResolution,
          preparationRoute,
        );
      } catch {
        return compensateAndFail(
          'evidence',
          'binding_mismatch',
          'prepared evidence authority could not be built',
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }

      let canonicalEvidencePayload: string;
      try {
        canonicalEvidencePayload = this.canonicalizer.canonicalize(unsignedEvidence);
        if (typeof canonicalEvidencePayload !== 'string' || canonicalEvidencePayload.length === 0) {
          return compensateAndFail(
            'evidence',
            'canonicalization_failed',
            'canonical prepared evidence is empty',
            ids,
            caller.tenantId,
            admission,
            authority.candidate.supplyMode,
          );
        }
        if (!canonicalEvidencePayload.includes(payloadSha256)) {
          return compensateAndFail(
            'evidence',
            'canonicalization_failed',
            'canonical prepared evidence does not bind the final payload digest',
            ids,
            caller.tenantId,
            admission,
            authority.candidate.supplyMode,
          );
        }
      } catch {
        return compensateAndFail(
          'evidence',
          'canonicalization_failed',
          'canonical prepared evidence failed',
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }
      const canonicalEvidencePayloadSha256 = digestText(canonicalEvidencePayload);

      const signatureDecision = await this.invokeDecision(
        'evidence',
        () =>
          signer.sign({
            verifierKeyId,
            canonicalPayload: canonicalEvidencePayload,
            canonicalPayloadSha256: canonicalEvidencePayloadSha256,
            evidence: unsignedEvidence,
          }),
        'signing_failed',
      );
      if (signatureDecision.decision !== 'allow') {
        return compensateAndFail(
          'evidence',
          signatureDecision.code === 'evidence_registration_failed' ? 'signing_failed' : signatureDecision.code,
          signatureDecision.message,
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }
      const signature = signatureDecision.value;
      if (
        !isRecord(signature) ||
        typeof signature.signatureBase64 !== 'string' ||
        !BASE64.test(signature.signatureBase64)
      ) {
        return compensateAndFail(
          'evidence',
          'signing_failed',
          'prepared evidence signer returned an invalid signature',
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }
      const signedEvidence: PreparedRequestEvidenceInput = {
        ...unsignedEvidence,
        signatureBase64: signature.signatureBase64,
      };

      const registeredDecision = await this.invokeDecision(
        'evidence',
        async () => {
          const registered = await registrar.register(signedEvidence, { executor });
          return isDecision<PreparedRequestEvidenceRecord>(registered)
            ? registered
            : allowRequestPreparation(registered);
        },
        'evidence_registration_failed',
      );
      if (registeredDecision.decision !== 'allow') {
        return compensateAndFail(
          'evidence',
          registeredDecision.code,
          registeredDecision.message,
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }
      const evidence = registeredDecision.value;
      const evidenceIssue = validateRegisteredEvidence(evidence, signedEvidence);
      if (evidenceIssue) {
        return compensateAndFail(
          'evidence',
          evidenceIssue.code,
          evidenceIssue.message,
          ids,
          caller.tenantId,
          admission,
          authority.candidate.supplyMode,
        );
      }

      return {
        outcome: 'prepared',
        requestId: ids.requestId,
        attemptId: ids.attemptId,
        attemptOrdinal: admission.attemptOrdinal,
        payloadBytes,
        payloadSha256,
        requestFingerprint,
        requestFingerprintVersion,
        payloadCompilerVersion,
        usageEstimatorVersion,
        endpoint: authority.route.endpoint,
        requestedModel: modelResolution.requestedModel,
        mappedModel: modelResolution.mappedModel,
        resolvedModel: authority.candidate.resolvedModel,
        modelResolution,
        clientProtocol: preparationRoute.clientProtocol,
        providerProtocol: preparationRoute.providerProtocol,
        clientOperation: preparationRoute.clientOperation,
        providerOperation: preparationRoute.providerOperation,
        caller,
        entitlement,
        authority,
        admission,
        normalSuccessSnapshot: {
          supplyMode: authority.candidate.supplyMode,
          providerProtocol: preparationRoute.providerProtocol,
          customerPriceVersion: authority.commercial.customerPriceVersion,
          reservationId: admission.holdReservation?.reservationId ?? null,
          priceSnapshotRef: admission.holdReservation?.priceSnapshotRef ?? null,
          currency: admission.holdReservation?.currency ?? null,
          holdAmountMinorUnits:
            admission.holdReservation === null ? null : String(admission.holdReservation.amountMinorUnits),
          publicModelId: authority.route.publicModelId,
          publicModelVersion: String(authority.route.publicModelVersion),
          providerId: authority.candidate.providerId,
          productId: authority.candidate.productId,
          endpoint: authority.route.endpoint,
          usageEstimatorVersion,
        },
        attempt,
        evidenceInput: signedEvidence,
        canonicalEvidencePayload,
        canonicalEvidencePayloadSha256,
        evidence,
      };
    };

    try {
      return await transaction.transaction(async (executor) => {
        const result = await durableWork(executor);
        if (result.outcome !== 'prepared') throw new RequestPreparationTransactionRollback(result);
        return result;
      });
    } catch (error) {
      if (error instanceof RequestPreparationTransactionRollback) return error.result;
      return failure('blocked', 'admission', 'storage_failure', 'durable request preparation transaction failed', ids);
    }
  }

  prepareRequest(input: RequestPreparationInput): Promise<RequestPreparationResult> {
    return this.prepare(input);
  }

  private async compensateAndFail(
    stage: RequestPreparationStage,
    code: RequestPreparationFailureCode,
    reason: string,
    ids: IssuedIds,
    tenantId: string,
    admission: RequestPreparationAdmission,
    mode: SupplyMode,
    options?: RequestPreparationSqlOptions,
  ): Promise<RequestPreparationFailureResult> {
    const retain = (suffix: string): RequestPreparationFailureResult =>
      failure('blocked', stage, code, `${reason}; ${suffix}`, ids, {
        reservationDisposition: 'retained_for_reconciliation',
        manualReconciliationRequired: true,
        compensation: null,
      });

    const compensation = this.dependencies.compensation;
    if (compensation === undefined) {
      return retain('pre-dispatch reservations are retained for manual reconciliation');
    }

    let decision: RequestPreparationDecision<RequestPreparationCompensationResult>;
    try {
      decision = await compensation.releasePreDispatch(
        {
          requestId: ids.requestId,
          attemptId: ids.attemptId,
          tenantId,
          admission,
          expectedAttempt: {
            dispatchState: 'not_sent',
            resultState: 'pending',
            responseStarted: false,
          },
          failedStage: stage,
          failureCode: code,
        },
        options,
      );
    } catch {
      return retain('pre-dispatch compensation failed; manual reconciliation is required');
    }
    if (!isDecision<RequestPreparationCompensationResult>(decision)) {
      return retain('pre-dispatch compensation returned an invalid decision; manual reconciliation is required');
    }
    if (decision.decision !== 'allow') {
      return retain('pre-dispatch compensation was not confirmed; manual reconciliation is required');
    }

    const compensationIssue = validateCompensationResult(decision.value, ids, admission, mode);
    if (compensationIssue) {
      return retain(`pre-dispatch compensation was not confirmed: ${compensationIssue.message}`);
    }
    if (decision.value.disposition === 'retained_for_reconciliation') {
      return failure(
        'blocked',
        stage,
        code,
        `${reason}; pre-dispatch reservations are retained for manual reconciliation`,
        ids,
        {
          reservationDisposition: 'retained_for_reconciliation',
          manualReconciliationRequired: true,
          compensation: decision.value,
        },
      );
    }
    return failure('blocked', stage, code, reason, ids, {
      reservationDisposition: 'released',
      manualReconciliationRequired: false,
      compensation: decision.value,
    });
  }

  private async invokeDecision<T>(
    stage: RequestPreparationStage,
    operation: () => Promise<RequestPreparationDecision<T>>,
    fallbackCode?: RequestPreparationFailureCode,
  ): Promise<RequestPreparationDecision<T>> {
    try {
      const decision = await operation();
      if (!isDecision<T>(decision))
        return blockRequestPreparation('capability_unavailable', `${stage} adapter returned an invalid decision`);
      return decision;
    } catch {
      return blockRequestPreparation(
        fallbackCode ??
          (stage === 'payload'
            ? 'payload_invalid'
            : stage === 'attempt'
              ? 'attempt_persistence_failed'
              : stage === 'evidence'
                ? 'evidence_registration_failed'
                : 'capability_unavailable'),
        `${stage} adapter failed closed`,
      );
    }
  }
}

/** Descriptive alias for callers that prefer the orchestration name. */
export { SaasRequestPreparationService as RequestPreparationOrchestrator };
