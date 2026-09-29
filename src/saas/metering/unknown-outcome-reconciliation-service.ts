import { sha256Hex } from './digest.js';
import type {
  AttemptRecord,
  AttemptResultState,
  DispatchState,
  FinancialStatus,
  NormalizedUsageExact,
  ReconciliationState,
  RequestRecord,
  RequestResultState,
  UsageValues,
} from './types.js';

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const IDENTIFIER_MAX_LENGTH = 255;
const SETTLEMENT_KEY_NAMESPACE = 'saas:unknown-outcome:customer-usage:v1';

/**
 * The reconciliation request contains only database-owned lookup identities.
 * Endpoint and credential material intentionally cannot be supplied by a
 * caller; the provider/account adapter resolves those details from its own
 * server-side authority.
 */
export interface UnknownOutcomeReconciliationInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
}

export interface ServerOwnedProviderAccountLookupInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly upstreamId: string;
  readonly accountOwnerKind: 'tenant' | 'platform';
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
}

export interface ProviderAttemptIdentity {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly upstreamId: string;
  readonly accountOwnerKind: 'tenant' | 'platform';
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
}

export interface ProviderCompletedOutcome {
  readonly status: 'completed';
  readonly providerOperationId: string;
  /** Usage returned by the server-owned adapter, never a caller-supplied cost. */
  readonly usage: UsageValues;
  readonly identity: ProviderAttemptIdentity;
}

export type ProviderUnresolvedOutcomeStatus = 'pending' | 'ambiguous' | 'provider_unavailable' | 'not_found';

export interface ProviderUnresolvedOutcome {
  readonly status: ProviderUnresolvedOutcomeStatus;
  readonly evidenceRef?: string | null;
}

export type ServerOwnedProviderAccountLookupResult = ProviderCompletedOutcome | ProviderUnresolvedOutcome;

/**
 * Adapter boundary for a provider/account implementation owned by the
 * server. It is deliberately narrower than a dispatch adapter and exposes no
 * endpoint, credential, secret, or replay operation.
 */
export interface ServerOwnedProviderAccountAdapter {
  lookupUnknownAttempt(input: ServerOwnedProviderAccountLookupInput): Promise<ServerOwnedProviderAccountLookupResult>;
}

export interface UnknownOutcomeProviderEvidenceObservation {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly status: ProviderUnresolvedOutcomeStatus | 'completed' | 'invalid';
  readonly providerOperationId: string | null;
  readonly evidenceReference: string | null;
  readonly providerIdentityDigest: string | null;
  readonly usage: NormalizedUsageExact | null;
}

/** Persists a sanitized provider observation before the result can affect billing. */
export interface UnknownOutcomeProviderEvidenceObservationPort {
  recordProviderObservation(input: UnknownOutcomeProviderEvidenceObservation): Promise<void>;
}

export interface CustomerCharge {
  /** Exact non-negative currency minor units. Floating point is not accepted. */
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly rateCardId: string;
  readonly rateCardVersion: string;
}

export interface ServerOwnedCustomerRateCardInput {
  readonly request: RequestRecord;
  readonly attempt: AttemptRecord;
  readonly usage: NormalizedUsageExact;
}

/** A server-owned calculator selected from the request-time pricing snapshot. */
export interface ServerOwnedCustomerRateCard {
  calculate(input: ServerOwnedCustomerRateCardInput): Promise<CustomerCharge>;
}

export interface UnknownOutcomeMeteringReadPort {
  getAttempt(tenantId: string, requestId: string, attemptId: string): Promise<AttemptRecord | null>;
  getRequest(tenantId: string, requestId: string): Promise<RequestRecord | null>;
  listAttempts(tenantId: string, requestId: string): Promise<readonly AttemptRecord[]>;
}

export interface ReconciliationExpectedState {
  readonly attempt: {
    readonly dispatchState: DispatchState;
    readonly resultState: AttemptResultState;
    readonly responseStarted: boolean;
    readonly stateVersion: number;
  };
  readonly request: {
    readonly resultState: RequestResultState;
    readonly reconciliationState: ReconciliationState;
    readonly financialStatus: FinancialStatus;
    readonly stateVersion: number;
  };
}

export interface ConditionalSettlementInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  /** Stable server-generated key; retries for one logical request reuse it. */
  readonly idempotencyKey: string;
  readonly providerOperationId: string;
  readonly usage: NormalizedUsageExact;
  readonly charge: CustomerCharge;
  /** The writer must compare these states in the same transaction as its write. */
  readonly expectedState: ReconciliationExpectedState;
}

export type ConditionalSettlementResult =
  | {
      readonly status: 'settled' | 'replayed';
      readonly settlementId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: 'conflict';
      readonly settlementId?: string;
      readonly idempotencyKey?: string;
    };

/**
 * Narrow write boundary for the request/financial coordinator. A compliant
 * implementation atomically records the trusted usage, applies the customer
 * rate-card charge, and conditionally advances the attempt/request/hold
 * state. It must not release or refund an unknown hold.
 */
export interface ConditionalSettlementPort {
  submit(input: ConditionalSettlementInput): Promise<ConditionalSettlementResult>;
}

export type UnknownOutcomeRetainReason =
  | 'pending'
  | 'ambiguous'
  | 'provider_unavailable'
  | 'provider_not_found'
  | 'attempt_coverage_incomplete'
  | 'evidence_observation_unavailable'
  | 'byok_has_no_token_settlement';

export type UnknownOutcomeBlockedReason =
  | 'attempt_not_found'
  | 'request_not_found'
  | 'metering_read_failed'
  | 'request_attempt_identity_mismatch'
  | 'attempt_not_bound'
  | 'unsupported_supply_mode'
  | 'financial_state_not_settleable'
  | 'provider_response_invalid'
  | 'provider_identity_mismatch'
  | 'usage_not_authoritative'
  | 'customer_price_authority_missing'
  | 'rate_card_unavailable'
  | 'rate_card_invalid'
  | 'settlement_unavailable'
  | 'settlement_conflict'
  | 'settlement_write_failed';

export interface UnknownOutcomeSkipped {
  readonly kind: 'skipped';
  readonly reason: 'attempt_not_unknown';
  readonly attempt: AttemptRecord;
  readonly request: RequestRecord;
}

export interface UnknownOutcomeRetained {
  readonly kind: 'retain_unknown';
  readonly reason: UnknownOutcomeRetainReason;
  readonly providerStatus?: ProviderUnresolvedOutcomeStatus;
  readonly evidenceRef?: string | null;
  readonly attempt: AttemptRecord;
  readonly request: RequestRecord;
  /** This service performs no release, refund, or replay for this outcome. */
  readonly hold: 'retained';
}

export interface UnknownOutcomeBlocked {
  readonly kind: 'blocked';
  readonly reason: UnknownOutcomeBlockedReason;
  readonly attempt: AttemptRecord | null;
  readonly request: RequestRecord | null;
  /** A blocked reconciliation never authorizes a release or a replay. */
  readonly hold: 'retain_unknown';
}

export interface UnknownOutcomeSettled {
  readonly kind: 'settled';
  readonly status: 'settled' | 'replayed';
  readonly attempt: AttemptRecord;
  readonly request: RequestRecord;
  readonly usage: NormalizedUsageExact;
  readonly charge: CustomerCharge;
  readonly idempotencyKey: string;
  readonly settlementId: string;
}

export type UnknownOutcomeReconciliationResult =
  | UnknownOutcomeSkipped
  | UnknownOutcomeRetained
  | UnknownOutcomeBlocked
  | UnknownOutcomeSettled;

export interface UnknownOutcomeReconciliationDependencies {
  readonly metering: UnknownOutcomeMeteringReadPort;
  readonly provider: ServerOwnedProviderAccountAdapter;
  readonly observations?: UnknownOutcomeProviderEvidenceObservationPort;
  readonly rateCard?: ServerOwnedCustomerRateCard;
  readonly settlement?: ConditionalSettlementPort;
}

export function unknownOutcomeSettlementIdempotencyKey(tenantId: string, requestId: string): string {
  return `${SETTLEMENT_KEY_NAMESPACE}:${sha256Hex(`${tenantId}\0${requestId}`)}`;
}

function identifier(value: string, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized === '' || normalized.length > IDENTIFIER_MAX_LENGTH) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return normalized;
}

function isUnknownAttempt(attempt: AttemptRecord): boolean {
  return attempt.dispatchState === 'unknown' || attempt.resultState === 'unknown';
}

function isRetainableFinancialState(request: RequestRecord): boolean {
  return request.financialStatus === 'pending' || request.financialStatus === 'reconciliation_pending';
}

function retain(
  reason: UnknownOutcomeRetainReason,
  attempt: AttemptRecord,
  request: RequestRecord,
  providerStatus?: ProviderUnresolvedOutcomeStatus,
  evidenceRef?: string | null,
): UnknownOutcomeRetained {
  return {
    kind: 'retain_unknown',
    reason,
    ...(providerStatus === undefined ? {} : { providerStatus }),
    ...(evidenceRef === undefined ? {} : { evidenceRef }),
    attempt,
    request,
    hold: 'retained',
  };
}

function blocked(
  reason: UnknownOutcomeBlockedReason,
  attempt: AttemptRecord | null,
  request: RequestRecord | null,
): UnknownOutcomeBlocked {
  return { kind: 'blocked', reason, attempt, request, hold: 'retain_unknown' };
}

function text(value: unknown, maxLength = IDENTIFIER_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

function exactCount(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_POSTGRES_BIGINT) return undefined;
    return value.toString(10);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const normalized = value.trim();
  try {
    const parsed = BigInt(normalized);
    return parsed <= MAX_POSTGRES_BIGINT ? parsed.toString(10) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeTrustedUsage(value: UsageValues): NormalizedUsageExact | null {
  if (!value || typeof value !== 'object') return null;
  if (
    value.status !== 'reported' ||
    value.source !== 'upstream' ||
    value.measurementKind !== 'snapshot' ||
    value.billableBasis !== 'exact' ||
    !text(value.semanticsVersion, 64)
  ) {
    return null;
  }

  const inputTotal = exactCount(value.inputTotal);
  const inputUncached = exactCount(value.inputUncached);
  const cacheRead = exactCount(value.cacheRead);
  const cacheWrite = exactCount(value.cacheWrite);
  const cacheWrite5m = exactCount(value.cacheWrite5m);
  const cacheWrite1h = exactCount(value.cacheWrite1h);
  const outputTotal = exactCount(value.outputTotal);
  const reasoningOutput = exactCount(value.reasoningOutput);
  if (
    inputTotal === undefined ||
    inputUncached === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    cacheWrite5m === undefined ||
    cacheWrite1h === undefined ||
    outputTotal === undefined ||
    reasoningOutput === undefined
  ) {
    return null;
  }
  return {
    inputTotal,
    inputUncached,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    outputTotal,
    reasoningOutput,
    status: 'reported',
    source: 'upstream',
    semanticsVersion: value.semanticsVersion.trim(),
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  };
}

function validCharge(value: CustomerCharge): boolean {
  if (!value || typeof value !== 'object') return false;
  if (
    typeof value.amountMinorUnits !== 'string' ||
    !/^\d+$/.test(value.amountMinorUnits) ||
    value.amountMinorUnits.trim() !== value.amountMinorUnits
  ) {
    return false;
  }
  try {
    const amount = BigInt(value.amountMinorUnits);
    if (amount > MAX_POSTGRES_BIGINT || amount.toString(10) !== value.amountMinorUnits) return false;
  } catch {
    return false;
  }
  return /^[A-Z]{3}$/.test(value.currency) && text(value.rateCardId) && text(value.rateCardVersion);
}

function attemptMatchesRequest(request: RequestRecord, attempt: AttemptRecord): boolean {
  const expectedTargetMode = request.supplyMode === 'platform' ? 'platform_pool' : 'tenant_account';
  const expectedOwnerKind = request.supplyMode === 'platform' ? 'platform' : 'tenant';
  return (
    request.tenantId === attempt.tenantId &&
    request.id === attempt.requestId &&
    request.projectPolicyVersion === attempt.projectPolicyVersion &&
    request.supplyProfileId === attempt.dispatchProfileId &&
    request.supplyProfileVersion === attempt.supplyProfileAuthzVersion &&
    request.protocol === attempt.protocol &&
    request.routeConfigId === attempt.routeConfigId &&
    request.routeConfigVersion === attempt.routeConfigVersion &&
    request.routePublicModelId === attempt.routePublicModelId &&
    request.routePublicModelVersion === attempt.routePublicModelVersion &&
    request.routeProtocol === attempt.routeProtocol &&
    request.routeTargetMode === attempt.routeTargetMode &&
    request.routeTargetMode === expectedTargetMode &&
    request.routeUpstreamId === attempt.upstreamId &&
    attempt.accountOwnerKind === expectedOwnerKind
  );
}

function hasProviderIdentity(value: unknown): value is ProviderAttemptIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<ProviderAttemptIdentity>;
  return (
    text(identity.tenantId) &&
    text(identity.requestId) &&
    text(identity.attemptId) &&
    text(identity.upstreamId) &&
    (identity.accountOwnerKind === 'tenant' || identity.accountOwnerKind === 'platform') &&
    text(identity.accountId) &&
    text(identity.providerId) &&
    text(identity.productId) &&
    text(identity.resolvedModel)
  );
}

function identityMatches(request: RequestRecord, attempt: AttemptRecord, identity: ProviderAttemptIdentity): boolean {
  return (
    attemptMatchesRequest(request, attempt) &&
    identity.tenantId === request.tenantId &&
    identity.tenantId === attempt.tenantId &&
    identity.requestId === request.id &&
    identity.requestId === attempt.requestId &&
    identity.attemptId === attempt.id &&
    identity.upstreamId === attempt.upstreamId &&
    identity.accountOwnerKind === attempt.accountOwnerKind &&
    identity.accountId === attempt.accountId &&
    identity.providerId === attempt.providerId &&
    identity.productId === attempt.productId &&
    identity.resolvedModel === attempt.resolvedModel &&
    (request.routeUpstreamId === null || request.routeUpstreamId === attempt.upstreamId)
  );
}

function providerLookupInput(attempt: AttemptRecord): ServerOwnedProviderAccountLookupInput | null {
  if (
    attempt.bindingState !== 'bound' ||
    attempt.dispatchAuthorityState !== 'bound' ||
    attempt.accountOwnerKind === null ||
    attempt.accountId === null ||
    attempt.providerId === null ||
    attempt.productId === null
  ) {
    return null;
  }
  return {
    tenantId: attempt.tenantId,
    requestId: attempt.requestId,
    attemptId: attempt.id,
    upstreamId: attempt.upstreamId,
    accountOwnerKind: attempt.accountOwnerKind,
    accountId: attempt.accountId,
    providerId: attempt.providerId,
    productId: attempt.productId,
    resolvedModel: attempt.resolvedModel,
  };
}

function expectedState(attempt: AttemptRecord, request: RequestRecord): ReconciliationExpectedState {
  return {
    attempt: {
      dispatchState: attempt.dispatchState,
      resultState: attempt.resultState,
      responseStarted: attempt.responseStarted,
      stateVersion: attempt.stateVersion,
    },
    request: {
      resultState: request.resultState,
      reconciliationState: request.reconciliationState,
      financialStatus: request.financialStatus,
      stateVersion: request.stateVersion,
    },
  };
}

function settlementResultIsValid(
  value: ConditionalSettlementResult,
  idempotencyKey: string,
): value is Extract<ConditionalSettlementResult, { status: 'settled' | 'replayed' }> {
  return (
    !!value &&
    (value.status === 'settled' || value.status === 'replayed') &&
    text(value.settlementId) &&
    value.idempotencyKey === idempotencyKey
  );
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function sanitizedProviderObservation(
  tenantId: string,
  requestId: string,
  attemptId: string,
  value: unknown,
): UnknownOutcomeProviderEvidenceObservation {
  if (!value || typeof value !== 'object') {
    return {
      tenantId,
      requestId,
      attemptId,
      status: 'invalid',
      providerOperationId: null,
      evidenceReference: null,
      providerIdentityDigest: null,
      usage: null,
    };
  }
  const candidate = value as Partial<ServerOwnedProviderAccountLookupResult>;
  const allowedStatus =
    candidate.status === 'completed' ||
    candidate.status === 'pending' ||
    candidate.status === 'ambiguous' ||
    candidate.status === 'provider_unavailable' ||
    candidate.status === 'not_found';
  const status = allowedStatus ? candidate.status : 'invalid';
  const identity =
    candidate.status === 'completed' && hasProviderIdentity(candidate.identity) ? candidate.identity : null;
  const evidenceRef = (value as { readonly evidenceRef?: unknown }).evidenceRef;
  const unresolvedEvidence = candidate.status !== 'completed' && text(evidenceRef, 512) ? evidenceRef.trim() : null;
  return {
    tenantId,
    requestId,
    attemptId,
    status,
    providerOperationId:
      candidate.status === 'completed' && text(candidate.providerOperationId, 512)
        ? candidate.providerOperationId.trim()
        : null,
    evidenceReference: unresolvedEvidence,
    providerIdentityDigest: identity ? sha256Hex(JSON.stringify(identity)) : null,
    usage: candidate.status === 'completed' ? normalizeTrustedUsage(candidate.usage as UsageValues) : null,
  };
}

export class UnknownOutcomeReconciliationService {
  constructor(private readonly dependencies: UnknownOutcomeReconciliationDependencies) {}

  async reconcile(input: UnknownOutcomeReconciliationInput): Promise<UnknownOutcomeReconciliationResult> {
    const tenantId = identifier(input.tenantId, 'tenantId');
    const requestId = identifier(input.requestId, 'requestId');
    const attemptId = identifier(input.attemptId, 'attemptId');

    let attempt: AttemptRecord | null;
    try {
      attempt = await this.dependencies.metering.getAttempt(tenantId, requestId, attemptId);
    } catch {
      return blocked('metering_read_failed', null, null);
    }
    if (!attempt) return blocked('attempt_not_found', null, null);

    let request: RequestRecord | null;
    try {
      request = await this.dependencies.metering.getRequest(tenantId, requestId);
    } catch {
      return blocked('metering_read_failed', attempt, null);
    }
    if (!request) return blocked('request_not_found', attempt, null);

    if (
      attempt.tenantId !== tenantId ||
      attempt.requestId !== requestId ||
      request.tenantId !== tenantId ||
      request.id !== requestId ||
      !attemptMatchesRequest(request, attempt)
    ) {
      return blocked('request_attempt_identity_mismatch', attempt, request);
    }

    if (!isUnknownAttempt(attempt)) {
      return { kind: 'skipped', reason: 'attempt_not_unknown', attempt, request };
    }

    let attempts: readonly AttemptRecord[];
    try {
      attempts = await this.dependencies.metering.listAttempts(tenantId, requestId);
    } catch {
      return blocked('metering_read_failed', attempt, request);
    }
    const listedAttempt = attempts.find((candidate) => candidate.id === attempt.id);
    if (
      !listedAttempt ||
      listedAttempt.tenantId !== tenantId ||
      listedAttempt.requestId !== requestId ||
      listedAttempt.stateVersion !== attempt.stateVersion ||
      attempts.some((candidate) => candidate.tenantId !== tenantId || candidate.requestId !== requestId)
    ) {
      return blocked('request_attempt_identity_mismatch', attempt, request);
    }
    // A completed lookup for one attempt cannot settle a logical request when
    // another attempt may also have reached the provider. The current lookup
    // contract cannot prove the outcome of that other attempt.
    if (attempts.some((candidate) => candidate.id !== attempt.id && candidate.dispatchState !== 'not_sent')) {
      return retain('attempt_coverage_incomplete', attempt, request);
    }

    if (request.supplyMode !== 'platform') {
      return retain('byok_has_no_token_settlement', attempt, request);
    }
    if (!isRetainableFinancialState(request)) {
      return blocked('financial_state_not_settleable', attempt, request);
    }

    const lookup = providerLookupInput(attempt);
    if (!lookup) return blocked('attempt_not_bound', attempt, request);
    if (attempt.accountOwnerKind !== 'platform') {
      return blocked('request_attempt_identity_mismatch', attempt, request);
    }
    if (!this.dependencies.observations) {
      return retain('evidence_observation_unavailable', attempt, request);
    }

    let providerOutcome: ServerOwnedProviderAccountLookupResult;
    try {
      providerOutcome = await this.dependencies.provider.lookupUnknownAttempt(lookup);
    } catch {
      try {
        await this.dependencies.observations.recordProviderObservation({
          tenantId,
          requestId,
          attemptId,
          status: 'provider_unavailable',
          providerOperationId: null,
          evidenceReference: null,
          providerIdentityDigest: null,
          usage: null,
        });
      } catch {
        return retain('evidence_observation_unavailable', attempt, request, 'provider_unavailable');
      }
      return retain('provider_unavailable', attempt, request, 'provider_unavailable');
    }

    try {
      await this.dependencies.observations.recordProviderObservation(
        sanitizedProviderObservation(tenantId, requestId, attemptId, providerOutcome),
      );
    } catch {
      return retain('evidence_observation_unavailable', attempt, request);
    }

    if (!providerOutcome || typeof providerOutcome !== 'object' || !text(providerOutcome.status, 32)) {
      return blocked('provider_response_invalid', attempt, request);
    }
    if (providerOutcome.status !== 'completed') {
      if (
        providerOutcome.status !== 'pending' &&
        providerOutcome.status !== 'ambiguous' &&
        providerOutcome.status !== 'provider_unavailable' &&
        providerOutcome.status !== 'not_found'
      ) {
        return blocked('provider_response_invalid', attempt, request);
      }
      return retain(
        providerOutcome.status === 'not_found' ? 'provider_not_found' : providerOutcome.status,
        attempt,
        request,
        providerOutcome.status,
        providerOutcome.evidenceRef,
      );
    }

    if (
      !text(providerOutcome.providerOperationId, 512) ||
      !hasProviderIdentity(providerOutcome.identity) ||
      !identityMatches(request, attempt, providerOutcome.identity)
    ) {
      return blocked('provider_identity_mismatch', attempt, request);
    }

    const usage = normalizeTrustedUsage(providerOutcome.usage);
    if (!usage) return blocked('usage_not_authoritative', attempt, request);

    if (
      request.customerPriceVersion === null ||
      attempt.customerPriceVersion !== request.customerPriceVersion ||
      request.customerMeteringPolicyId === null ||
      request.customerMeteringPolicyVersion === null ||
      attempt.customerMeteringPolicyId !== request.customerMeteringPolicyId ||
      attempt.customerMeteringPolicyVersion !== request.customerMeteringPolicyVersion ||
      request.providerMeteringPolicyId === null ||
      request.providerMeteringPolicyVersion === null ||
      request.contractAttestationId === null
    ) {
      return blocked('customer_price_authority_missing', attempt, request);
    }
    if (!this.dependencies.rateCard) return blocked('rate_card_unavailable', attempt, request);

    let charge: CustomerCharge;
    try {
      charge = await this.dependencies.rateCard.calculate({ request, attempt, usage });
    } catch {
      return blocked('rate_card_unavailable', attempt, request);
    }
    if (!validCharge(charge)) return blocked('rate_card_invalid', attempt, request);
    if (!this.dependencies.settlement) return blocked('settlement_unavailable', attempt, request);

    const idempotencyKey = unknownOutcomeSettlementIdempotencyKey(request.tenantId, request.id);
    const inputForSettlement: ConditionalSettlementInput = {
      tenantId: request.tenantId,
      requestId: request.id,
      attemptId: attempt.id,
      idempotencyKey,
      providerOperationId: providerOutcome.providerOperationId.trim(),
      usage,
      charge,
      expectedState: expectedState(attempt, request),
    };

    let settlement: ConditionalSettlementResult;
    try {
      settlement = await this.dependencies.settlement.submit(inputForSettlement);
    } catch (error) {
      const code = errorCode(error);
      return blocked(
        code === 'CONFLICT' ||
          code === 'IDEMPOTENCY_CONFLICT' ||
          code === 'USAGE_SETTLEMENT_CONFLICT' ||
          code === 'SETTLEMENT_CONFLICT' ||
          code === 'RESERVATION_STATE_CONFLICT' ||
          code === 'REQUEST_TRANSITION_INVALID' ||
          code === 'ATTEMPT_TRANSITION_INVALID'
          ? 'settlement_conflict'
          : 'settlement_write_failed',
        attempt,
        request,
      );
    }
    if (!settlement || typeof settlement !== 'object') {
      return blocked('settlement_write_failed', attempt, request);
    }
    if (settlement.status === 'conflict') return blocked('settlement_conflict', attempt, request);
    if (!settlementResultIsValid(settlement, idempotencyKey)) {
      return blocked('settlement_write_failed', attempt, request);
    }
    return {
      kind: 'settled',
      status: settlement.status,
      attempt,
      request,
      usage,
      charge,
      idempotencyKey,
      settlementId: settlement.settlementId,
    };
  }
}
