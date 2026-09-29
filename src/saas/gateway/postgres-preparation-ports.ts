import { randomUUID } from 'node:crypto';
import { SaasBillingError } from '../billing/errors.js';
import type { PlatformWalletLedgerService } from '../billing/service.js';
import type { ReleaseBillingInput } from '../billing/types.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { AuthenticatedApiKey } from '../keys/types.js';
import type { SaasMeteringService } from '../metering/service.js';
import type { AttemptRecord, CreateRequestInput, RequestAdmission, RequestRecord } from '../metering/types.js';
import {
  createRequestAdmissionReservationBusinessKey,
  type PlatformRequestAdmissionHoldEvidence,
  type SaasMeteringAdmissionPort,
  type SaasRequestAdmissionCommand,
  type SaasRequestAdmissionGuard,
  SaasRequestAdmissionService,
} from './admission.js';
import type { SaasRequestAdmissionAuthorizationPrelock } from './authorization-prelock.js';
import {
  type GatewayRequestIdempotencyClaimResult,
  type GatewayRequestIdempotencyStore,
  isGatewayRequestIdempotencyClaimed,
} from './request-idempotency.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationAdmission,
  type RequestPreparationAdmissionPort,
  type RequestPreparationAttemptPersistenceInput,
  type RequestPreparationAttemptPort,
  type RequestPreparationAttemptRecord,
  type RequestPreparationCaller,
  type RequestPreparationCallerPort,
  type RequestPreparationCompensationInput,
  type RequestPreparationCompensationPort,
  type RequestPreparationCompensationResult,
  type RequestPreparationDecision,
  type RequestPreparationEntitlement,
  type RequestPreparationEntitlementPort,
  type RequestPreparationPayloadBounds,
  type RequestPreparationReservationReference,
  type RequestPreparationSqlOptions,
  type RequestPreparationTokenBudget,
  rejectRequestPreparation,
} from './request-preparation-service.js';

const SAFE_ADMISSION_FAILURE = 'SaaS request admission could not be authorized.';
const SAFE_ATTEMPT_FAILURE = 'SaaS initial attempt could not be persisted.';
const SAFE_COMPENSATION_FAILURE = 'SaaS pre-dispatch reservations could not be safely released.';

type Row = Record<string, unknown>;

export interface PostgresPreparationCapacityReservation {
  readonly quotaReservation: RequestPreparationReservationReference;
  readonly rateReservation: RequestPreparationReservationReference;
  readonly retryBudget: number;
  readonly remainingAttempts: number;
  readonly usageBudget: RequestPreparationTokenBudget | null;
}

/**
 * The repository has no quota/rate reservation schema or service yet. A
 * production implementation must reserve and release both on the supplied
 * transaction executor and make reserve idempotent by tenant/request ID.
 */
export interface PostgresPreparationCapacityPort {
  reserve(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly projectId: string;
      readonly proxyKeyId: string;
      readonly requestId: string;
      readonly attemptId: string;
      readonly supplyMode: 'byok' | 'platform';
      readonly payloadBounds: RequestPreparationPayloadBounds;
      readonly idempotencyScopeKey: string;
      readonly requestFingerprint: string;
      readonly requestFingerprintVersion: string;
    },
  ): Promise<RequestPreparationDecision<PostgresPreparationCapacityReservation>>;
  release(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly projectId: string;
      readonly requestId: string;
      readonly attemptId: string;
      readonly quotaReservation: RequestPreparationReservationReference;
      readonly rateReservation: RequestPreparationReservationReference;
    },
  ): Promise<{
    readonly quotaReservation: 'released' | 'retained_for_reconciliation';
    readonly rateReservation: 'released' | 'retained_for_reconciliation';
  }>;
}

export interface PostgresPreparationPortsOptions {
  readonly database: SaasDatabase;
  readonly metering: Pick<SaasMeteringService, 'admitPreparedRequest' | 'getRequest' | 'getAttempt'>;
  readonly billing: Pick<PlatformWalletLedgerService, 'reserve' | 'release'>;
  readonly guard: SaasRequestAdmissionGuard;
  readonly authorizationPrelock: SaasRequestAdmissionAuthorizationPrelock;
  /** Existing DB-backed project/supply entitlement resolver. */
  readonly entitlement: RequestPreparationEntitlementPort;
  /** Required to allow admission; absent means fail closed. */
  readonly capacity?: PostgresPreparationCapacityPort;
  /** Used when the production composition has not already claimed this request. */
  readonly idempotencyStore?: GatewayRequestIdempotencyStore;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  /** Must match the payload compiler's normalized request fingerprint version. */
  readonly requestFingerprintVersion?: string;
  readonly admissionTtlMs?: number;
  readonly retryBudget?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface PostgresPreparationPorts {
  readonly caller: RequestPreparationCallerPort;
  readonly entitlement: RequestPreparationEntitlementPort;
  readonly admission: RequestPreparationAdmissionPort;
  readonly attempt: RequestPreparationAttemptPort;
  readonly compensation: RequestPreparationCompensationPort;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim();
}

function exactVersion(value: unknown): string | null {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value));
    return parsed > 0n ? parsed.toString(10) : null;
  } catch {
    return null;
  }
}

function normalizedScopes(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((scope) => !nonEmpty(scope)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as string[];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function callerFromAuthenticatedKey(value: AuthenticatedApiKey, publicModel: string): RequestPreparationCaller | null {
  if (!value || typeof value !== 'object' || !value.authorization || !value.metadata) return null;
  const auth = value.authorization;
  const metadata = value.metadata;
  const scopes = normalizedScopes(auth.modelScopes);
  if (
    metadata.status !== 'active' ||
    (metadata.expiresAt !== null && Date.parse(metadata.expiresAt) <= Date.now()) ||
    !scopes ||
    !scopes.includes(publicModel) ||
    !sameStrings(scopes, metadata.modelScopes) ||
    metadata.id !== auth.keyId ||
    metadata.tenantId !== auth.tenantId ||
    metadata.projectId !== auth.projectId ||
    metadata.executionPrincipalType !== auth.principalKind ||
    metadata.executionPrincipalId !== auth.principalId ||
    metadata.entitlementId !== auth.entitlementId ||
    metadata.supplyProfileId !== auth.supplyProfileId ||
    metadata.supplyMode !== auth.supplyMode ||
    metadata.authzVersion !== auth.authzVersion ||
    metadata.modelScopeVersion !== auth.modelScopeVersion ||
    metadata.entitlementAuthzVersion !== auth.entitlementAuthzVersion ||
    metadata.supplyProfileAuthzVersion !== auth.supplyProfileAuthzVersion ||
    !nonEmpty(auth.tenantId) ||
    !nonEmpty(auth.projectId) ||
    !nonEmpty(auth.keyId) ||
    !nonEmpty(auth.principalId) ||
    !nonEmpty(auth.entitlementId) ||
    !nonEmpty(auth.supplyProfileId) ||
    (auth.supplyMode !== 'byok' && auth.supplyMode !== 'platform') ||
    !exactVersion(auth.authzVersion) ||
    !exactVersion(auth.modelScopeVersion) ||
    !exactVersion(auth.entitlementAuthzVersion) ||
    !exactVersion(auth.supplyProfileAuthzVersion)
  ) {
    return null;
  }
  return {
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    proxyKeyId: auth.keyId,
    principalKind: auth.principalKind,
    principalId: auth.principalId,
    entitlementId: auth.entitlementId,
    supplyProfileId: auth.supplyProfileId,
    supplyMode: auth.supplyMode,
    modelScopes: scopes,
    authzVersion: auth.authzVersion,
    entitlementVersion: auth.entitlementAuthzVersion,
    supplyProfileVersion: auth.supplyProfileAuthzVersion,
    modelScopeVersion: auth.modelScopeVersion,
  };
}

function entitlementMatchesCaller(
  caller: RequestPreparationCaller,
  entitlement: RequestPreparationEntitlement,
  publicModel: string,
): boolean {
  return (
    entitlement.tenantId === caller.tenantId &&
    entitlement.projectId === caller.projectId &&
    entitlement.proxyKeyId === caller.proxyKeyId &&
    entitlement.entitlementId === caller.entitlementId &&
    String(entitlement.entitlementVersion) === String(caller.entitlementVersion) &&
    entitlement.supplyProfileId === caller.supplyProfileId &&
    String(entitlement.supplyProfileVersion) === String(caller.supplyProfileVersion) &&
    entitlement.supplyMode === caller.supplyMode &&
    String(entitlement.modelScopeVersion) === String(caller.modelScopeVersion) &&
    nonEmpty(exactVersion(entitlement.projectPolicyVersion)) &&
    normalizedScopes(entitlement.allowedModels)?.includes(publicModel) === true &&
    (caller.supplyMode === 'byok'
      ? normalizedScopes(entitlement.allowedProviderIds) !== null
      : Array.isArray(entitlement.allowedProviderIds) && entitlement.allowedProviderIds.length === 0)
  );
}

function operation(protocol: string): string | null {
  switch (protocol) {
    case 'anthropic':
      return 'messages';
    case 'openai':
      return 'chat.completions';
    case 'gemini':
      return 'generateContent';
    case 'responses':
      return 'responses';
    default:
      return null;
  }
}

function canonicalModelResolution(input: {
  readonly publicModel: string;
  readonly authority: RequestPreparationAttemptPersistenceInput['authority'];
}) {
  const provided = input.authority.modelResolution;
  if (provided) return provided;
  if (input.publicModel !== input.authority.candidate.resolvedModel) return null;
  return {
    requestedModel: input.publicModel,
    mappedModel: input.publicModel,
    resolvedModel: input.publicModel,
    mappingSource: 'none' as const,
    mappingVersion: null,
  };
}

function createRequestAndAttempt(input: {
  readonly requestId: string;
  readonly attemptId: string;
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly authority: RequestPreparationAttemptPersistenceInput['authority'];
  readonly publicModel: string;
  readonly protocol: RequestPreparationAttemptPersistenceInput['protocol'];
  readonly fingerprint: string;
  readonly fingerprintVersion: string;
  readonly payloadSha256: string;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly modelResolution: NonNullable<ReturnType<typeof canonicalModelResolution>>;
  readonly clientProtocol: RequestPreparationAttemptPersistenceInput['clientProtocol'];
  readonly providerProtocol: RequestPreparationAttemptPersistenceInput['providerProtocol'];
  readonly clientOperation: string;
  readonly providerOperation: string;
}) {
  const { caller, entitlement, authority } = input;
  const route = authority.route;
  const commercial = authority.commercial;
  const candidate = authority.candidate as unknown as Row;
  const commonAttempt: Row = {
    ordinal: 1,
    upstreamId: candidate.upstreamId,
    accountId: candidate.accountId,
    providerId: candidate.providerId,
    productId: candidate.productId,
    resolvedModel: candidate.resolvedModel,
    protocol: candidate.protocol,
    endpoint: route.endpoint,
    dispatchProfileId: caller.supplyProfileId,
    supplyProfileAuthzVersion: caller.supplyProfileVersion,
    credentialId: candidate.credentialId,
    credentialVersion: candidate.credentialVersion,
    credentialAuthzVersion: candidate.credentialAuthzVersion,
    accountAuthzVersion: candidate.accountAuthzVersion,
    accountOwnerKind: caller.supplyMode === 'byok' ? 'tenant' : 'platform',
    projectPolicyVersion: entitlement.projectPolicyVersion,
    supplierCostVersion: commercial.supplierCostVersion,
    customerPriceVersion: commercial.customerPriceVersion,
    customerMeteringPolicyId: commercial.customerMeteringPolicyId,
    customerMeteringPolicyVersion: commercial.customerMeteringPolicyVersion,
    providerMeteringPolicyId: commercial.providerMeteringPolicyId,
    providerMeteringPolicyVersion: commercial.providerMeteringPolicyVersion,
    contractAttestationId: commercial.contractAttestationId,
    routeConfigId: route.routeConfigId,
    routeConfigVersion: route.routeConfigVersion,
    routePublicModelId: route.publicModelId,
    routePublicModelVersion: route.publicModelVersion,
    routeProtocol: route.protocol,
    routeTargetMode: route.targetMode,
    modelResolution: input.modelResolution,
    clientProtocol: input.clientProtocol,
    providerProtocol: input.providerProtocol,
    clientOperation: input.clientOperation,
    providerOperation: input.providerOperation,
    requestFingerprint: input.fingerprint,
    requestFingerprintVersion: input.fingerprintVersion,
    payloadSha256: input.payloadSha256,
    payloadCompilerVersion: input.payloadCompilerVersion,
    usageEstimatorVersion: input.usageEstimatorVersion,
  };
  if (caller.supplyMode === 'byok') {
    commonAttempt.profileAccountAuthzVersion = candidate.profileAccountAuthzVersion;
  } else {
    for (const key of [
      'poolId',
      'poolAuthzVersion',
      'poolMemberAuthzVersion',
      'poolMemberAccountAuthzVersion',
      'poolGrantAuthzVersion',
      'poolGrantProfileAuthzVersion',
      'poolGrantPoolAuthzVersion',
    ]) {
      commonAttempt[key] = candidate[key];
    }
  }
  const request = {
    tenantId: caller.tenantId,
    projectId: caller.projectId,
    proxyKeyId: caller.proxyKeyId,
    entitlementId: caller.entitlementId,
    entitlementVersion: caller.entitlementVersion,
    supplyProfileId: caller.supplyProfileId,
    supplyProfileVersion: caller.supplyProfileVersion,
    modelScopeVersion: caller.modelScopeVersion,
    supplyMode: caller.supplyMode,
    principalKind: caller.principalKind,
    principalId: caller.principalId,
    authzVersion: caller.authzVersion,
    configVersion: authority.configVersion,
    projectPolicyVersion: entitlement.projectPolicyVersion,
    publicModel: input.publicModel,
    protocol: input.protocol,
    endpoint: route.endpoint,
    modelResolution: input.modelResolution,
    clientProtocol: input.clientProtocol,
    providerProtocol: input.providerProtocol,
    clientOperation: input.clientOperation,
    providerOperation: input.providerOperation,
    requestFingerprint: input.fingerprint,
    requestFingerprintVersion: input.fingerprintVersion,
    customerPriceVersion: commercial.customerPriceVersion,
    customerMeteringPolicyId: commercial.customerMeteringPolicyId,
    customerMeteringPolicyVersion: commercial.customerMeteringPolicyVersion,
    providerMeteringPolicyId: commercial.providerMeteringPolicyId,
    providerMeteringPolicyVersion: commercial.providerMeteringPolicyVersion,
    contractAttestationId: commercial.contractAttestationId,
    routeConfigId: route.routeConfigId,
    routeConfigVersion: route.routeConfigVersion,
    routePublicModelId: route.publicModelId,
    routePublicModelVersion: route.publicModelVersion,
    routeProtocol: route.protocol,
    routeTargetMode: route.targetMode,
    routeUpstreamId: route.upstreamId,
    initialAttempt: commonAttempt,
  };
  return { request, initialAttempt: commonAttempt };
}

function sameAuthority(
  left: RequestPreparationAttemptPersistenceInput,
  right: RequestPreparationAttemptPersistenceInput,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.attemptId === right.attemptId &&
    left.caller.tenantId === right.caller.tenantId &&
    left.caller.projectId === right.caller.projectId &&
    left.caller.proxyKeyId === right.caller.proxyKeyId &&
    left.caller.supplyMode === right.caller.supplyMode &&
    left.entitlement.entitlementId === right.entitlement.entitlementId &&
    left.authority.route.routeConfigId === right.authority.route.routeConfigId &&
    String(left.authority.route.routeConfigVersion) === String(right.authority.route.routeConfigVersion) &&
    left.authority.candidate.accountId === right.authority.candidate.accountId &&
    left.authority.candidate.credentialId === right.authority.candidate.credentialId &&
    left.authority.candidate.upstreamId === right.authority.candidate.upstreamId &&
    left.authority.commercial.customerPriceVersion === right.authority.commercial.customerPriceVersion &&
    left.authority.commercial.supplierCostVersion === right.authority.commercial.supplierCostVersion
  );
}

function safeCapacityResult(value: PostgresPreparationCapacityReservation): boolean {
  const validRef = (reference: RequestPreparationReservationReference) =>
    reference?.state === 'reserved' && nonEmpty(reference.reference);
  return (
    validRef(value.quotaReservation) &&
    validRef(value.rateReservation) &&
    Number.isSafeInteger(value.retryBudget) &&
    value.retryBudget >= 0 &&
    value.retryBudget <= 1000 &&
    Number.isSafeInteger(value.remainingAttempts) &&
    value.remainingAttempts > 0 &&
    (value.usageBudget === null ||
      (value.usageBudget.unit === 'tokens' &&
        Number.isSafeInteger(value.usageBudget.amount) &&
        value.usageBudget.amount >= 0 &&
        ['reserved', 'estimated', 'explicit'].includes(value.usageBudget.basis)))
  );
}

async function queryOne<RowType extends Row>(
  executor: SqlExecutor,
  sql: string,
  values: readonly unknown[],
): Promise<RowType | null> {
  const result = await executor.query<RowType>(sql, values);
  if (!result || !Array.isArray(result.rows) || result.rows.length > 1) throw new Error('invalid admission SQL result');
  return result.rows[0] ?? null;
}

function attemptIsPreDispatch(attempt: AttemptRecord): boolean {
  return (
    attempt.dispatchState === 'not_sent' &&
    attempt.resultState === 'pending' &&
    attempt.responseStarted === false &&
    attempt.dispatchAuthorityState === 'bound' &&
    attempt.bindingState === 'bound'
  );
}

function admissionHoldEvidence(
  payloadBounds: RequestPreparationPayloadBounds,
  admissionExpiresAt: Date,
): PlatformRequestAdmissionHoldEvidence {
  return {
    inputTotal: payloadBounds.inputTotalUpperBound,
    inputUncached: payloadBounds.inputUncachedUpperBound,
    cacheRead: payloadBounds.cacheReadUpperBound,
    cacheWrite: payloadBounds.cacheWriteUpperBound,
    cacheWrite5m: payloadBounds.cacheWrite5mUpperBound,
    cacheWrite1h: payloadBounds.cacheWrite1hUpperBound,
    outputTotal: payloadBounds.outputTotalUpperBound,
    reasoningOutput: payloadBounds.reasoningOutputUpperBound,
    admissionExpiresAt,
  };
}

function requestIsUncharged(request: RequestRecord, supplyMode: 'byok' | 'platform'): boolean {
  return (
    request.resultState === 'pending' &&
    request.reconciliationState === 'none' &&
    (supplyMode === 'byok' ? request.financialStatus === 'not_applicable' : request.financialStatus === 'pending')
  );
}

function holdFromReservation(reservation: {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly currency: string;
  readonly amountMinorUnits: bigint;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string;
}): RequestPreparationAdmission['holdReservation'] {
  return {
    reference: reservation.id,
    reservationId: reservation.id,
    state: 'reserved',
    tenantId: reservation.tenantId,
    requestId: reservation.requestId,
    currency: reservation.currency,
    amountMinorUnits: reservation.amountMinorUnits,
    priceSnapshotRef: reservation.priceSnapshotRef,
    expiresAt: reservation.expiresAt,
  };
}

function isDecision<T>(value: unknown): value is RequestPreparationDecision<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'decision' in value &&
    ((value as { decision?: unknown }).decision === 'allow' ||
      (value as { decision?: unknown }).decision === 'reject' ||
      (value as { decision?: unknown }).decision === 'block')
  );
}

function safeErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Build real PostgreSQL-backed ports; all durable writes use the caller's transaction. */
export function createPostgresPreparationPorts(options: PostgresPreparationPortsOptions): PostgresPreparationPorts {
  if (!options?.database || typeof options.database.transaction !== 'function') {
    throw new TypeError('Postgres preparation database is required');
  }
  if (!options.metering || !options.billing || !options.guard || !options.authorizationPrelock) {
    throw new TypeError('Postgres preparation metering, billing, guard, and authorization prelock are required');
  }
  if (!nonEmpty(options.payloadCompilerVersion) || !nonEmpty(options.usageEstimatorVersion)) {
    throw new TypeError('Postgres preparation compiler and estimator versions are required');
  }

  const now = options.now ?? (() => new Date());
  const admissionTtlMs = options.admissionTtlMs ?? 30_000;
  const idFactory = options.idFactory ?? randomUUID;
  const bindings = new Map<string, RequestPreparationAttemptPersistenceInput>();

  const caller: RequestPreparationCallerPort = {
    async validate(input) {
      if (!input || typeof input !== 'object' || !nonEmpty(input.publicModel)) {
        return { decision: 'reject', code: 'invalid_input', message: 'The authenticated caller is invalid.' };
      }
      const value = callerFromAuthenticatedKey(input.authenticatedCaller, input.publicModel);
      if (!value)
        return { decision: 'reject', code: 'caller_denied', message: 'The authenticated caller is no longer valid.' };
      return allowRequestPreparation(value);
    },
  };

  const entitlement: RequestPreparationEntitlementPort = {
    async resolve(input) {
      let decision: RequestPreparationDecision<RequestPreparationEntitlement>;
      try {
        decision = await options.entitlement.resolve(input);
      } catch {
        return blockRequestPreparation('storage_failure', 'Project entitlement could not be revalidated.');
      }
      if (!isDecision<RequestPreparationEntitlement>(decision)) {
        return blockRequestPreparation('capability_unavailable', 'Project entitlement returned an invalid decision.');
      }
      if (decision.decision !== 'allow') return decision;
      if (!entitlementMatchesCaller(input.caller, decision.value, input.publicModel)) {
        return {
          decision: 'reject',
          code: 'entitlement_denied',
          message: 'Project entitlement does not match the caller.',
        };
      }
      return decision;
    },
  };

  const admission: RequestPreparationAdmissionPort = {
    async authorizeAndReserve(input, sqlOptions?: RequestPreparationSqlOptions) {
      const executor = sqlOptions?.executor;
      if (!executor) return blockRequestPreparation('capability_unavailable', SAFE_ADMISSION_FAILURE);
      const { caller: resolvedCaller, entitlement: resolvedEntitlement, authority } = input;
      if (
        !entitlementMatchesCaller(resolvedCaller, resolvedEntitlement, authority.route.publicModel) ||
        authority.route.tenantId !== resolvedCaller.tenantId ||
        authority.route.projectId !== resolvedCaller.projectId ||
        authority.route.protocol !== input.authority.route.protocol ||
        authority.route.targetMode !== (resolvedCaller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool') ||
        authority.candidate.supplyMode !== resolvedCaller.supplyMode ||
        !/^[0-9a-f]{64}$/i.test(input.payloadSha256)
      ) {
        return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ADMISSION_FAILURE };
      }
      const clientIdempotencyKey = input.idempotencyKey;
      if (!nonEmpty(clientIdempotencyKey)) {
        return { decision: 'reject', code: 'invalid_input', message: 'The idempotency key is invalid.' };
      }
      if (!nonEmpty(input.requestFingerprint) || !nonEmpty(input.requestFingerprintVersion)) {
        return { decision: 'reject', code: 'invalid_input', message: 'The idempotency fingerprint is unavailable.' };
      }
      if (
        options.requestFingerprintVersion !== undefined &&
        input.requestFingerprintVersion !== options.requestFingerprintVersion
      ) {
        return {
          decision: 'reject',
          code: 'binding_mismatch',
          message: 'The request fingerprint version is not supported.',
        };
      }
      const requestFingerprint = input.requestFingerprint;
      const requestFingerprintVersion = input.requestFingerprintVersion;
      if (!nonEmpty(requestFingerprint) || !nonEmpty(requestFingerprintVersion)) {
        return { decision: 'reject', code: 'invalid_input', message: 'The request fingerprint is invalid.' };
      }
      let idempotencyClaim = input.idempotencyClaim;
      if (idempotencyClaim !== undefined && !isGatewayRequestIdempotencyClaimed(idempotencyClaim)) {
        return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ADMISSION_FAILURE };
      }
      if (idempotencyClaim === undefined) {
        if (!options.idempotencyStore) {
          return blockRequestPreparation('capability_unavailable', 'Persistent request idempotency is unavailable.');
        }
        let claimResult: GatewayRequestIdempotencyClaimResult;
        try {
          claimResult = await options.idempotencyStore.claim(executor, {
            tenantId: resolvedCaller.tenantId,
            projectId: resolvedCaller.projectId,
            proxyKeyId: resolvedCaller.proxyKeyId,
            clientKey: clientIdempotencyKey,
            requestFingerprint,
            requestFingerprintVersion,
            requestId: input.requestId,
          });
        } catch {
          return blockRequestPreparation('storage_failure', SAFE_ADMISSION_FAILURE);
        }
        if (claimResult.kind === 'fingerprint_conflict') {
          return {
            decision: 'reject',
            code: 'idempotency_conflict',
            message: 'The idempotency key is already bound to a different request fingerprint.',
          };
        }
        if (claimResult.kind === 'existing') {
          return rejectRequestPreparation(
            'idempotency_replay',
            'The existing canonical request is returned without replaying its response.',
            { requestId: claimResult.canonicalRequestId, status: claimResult.canonicalRequestStatus },
          );
        }
        idempotencyClaim = claimResult;
      }
      if (idempotencyClaim.canonicalRequestId !== input.requestId) {
        return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ADMISSION_FAILURE };
      }
      const canonicalRequestId = idempotencyClaim.canonicalRequestId;
      const idempotencyScopeKey = idempotencyClaim.keyDigest;
      if (!options.capacity) {
        return blockRequestPreparation(
          'capability_unavailable',
          'Transactional quota and rate reservation are unavailable.',
        );
      }
      const observedNow = now();
      if (
        !(observedNow instanceof Date) ||
        !Number.isFinite(observedNow.getTime()) ||
        !Number.isSafeInteger(admissionTtlMs) ||
        admissionTtlMs < 1
      ) {
        return blockRequestPreparation('capability_unavailable', SAFE_ADMISSION_FAILURE);
      }
      const expiresAt = new Date(observedNow.getTime() + admissionTtlMs);
      let capacityResult: RequestPreparationDecision<PostgresPreparationCapacityReservation>;
      try {
        capacityResult = await options.capacity.reserve(executor, {
          tenantId: resolvedCaller.tenantId,
          projectId: resolvedCaller.projectId,
          proxyKeyId: resolvedCaller.proxyKeyId,
          requestId: canonicalRequestId,
          attemptId: input.attemptId,
          supplyMode: resolvedCaller.supplyMode,
          payloadBounds: input.payloadBounds,
          idempotencyScopeKey,
          requestFingerprint,
          requestFingerprintVersion,
        });
      } catch {
        return blockRequestPreparation('storage_failure', SAFE_ADMISSION_FAILURE);
      }
      if (!isDecision<PostgresPreparationCapacityReservation>(capacityResult)) {
        return blockRequestPreparation('capability_unavailable', SAFE_ADMISSION_FAILURE);
      }
      if (capacityResult.decision !== 'allow') return capacityResult;
      if (!safeCapacityResult(capacityResult.value)) {
        return blockRequestPreparation('capability_unavailable', SAFE_ADMISSION_FAILURE);
      }

      const modelResolution = canonicalModelResolution({ publicModel: authority.route.publicModel, authority });
      if (!modelResolution) {
        return blockRequestPreparation('capability_unavailable', 'Model mapping provenance is unavailable.');
      }
      const providerProtocol = authority.route.providerProtocol ?? authority.candidate.protocol;
      const clientOperation = authority.route.clientOperation ?? operation(authority.route.protocol);
      const providerOperation = authority.route.providerOperation ?? operation(providerProtocol);
      if (!clientOperation || !providerOperation) {
        return blockRequestPreparation('capability_unavailable', SAFE_ADMISSION_FAILURE);
      }
      const staged = createRequestAndAttempt({
        requestId: canonicalRequestId,
        attemptId: input.attemptId,
        caller: resolvedCaller,
        entitlement: resolvedEntitlement,
        authority,
        publicModel: authority.route.publicModel,
        protocol: authority.route.protocol,
        fingerprint: requestFingerprint,
        fingerprintVersion: requestFingerprintVersion,
        payloadSha256: input.payloadSha256.toLowerCase(),
        payloadCompilerVersion: options.payloadCompilerVersion,
        usageEstimatorVersion: options.usageEstimatorVersion,
        modelResolution,
        clientProtocol: authority.route.protocol,
        providerProtocol,
        clientOperation,
        providerOperation,
      });
      const authenticatedKey = {
        authorization: {
          keyId: resolvedCaller.proxyKeyId,
          tenantId: resolvedCaller.tenantId,
          projectId: resolvedCaller.projectId,
          principalKind: resolvedCaller.principalKind,
          principalId: resolvedCaller.principalId,
          entitlementId: resolvedCaller.entitlementId,
          supplyProfileId: resolvedCaller.supplyProfileId,
          supplyMode: resolvedCaller.supplyMode,
          modelScopes: [...resolvedCaller.modelScopes],
          authzVersion: Number(resolvedCaller.authzVersion),
          modelScopeVersion: Number(resolvedCaller.modelScopeVersion),
          entitlementAuthzVersion: Number(resolvedCaller.entitlementVersion),
          supplyProfileAuthzVersion: Number(resolvedCaller.supplyProfileVersion),
        },
      };
      const request = staged.request as CreateRequestInput & {
        readonly initialAttempt: NonNullable<CreateRequestInput['initialAttempt']>;
      };
      const command: SaasRequestAdmissionCommand =
        resolvedCaller.supplyMode === 'platform'
          ? {
              supplyMode: 'platform',
              authenticatedKey,
              request,
              holdEvidence: admissionHoldEvidence(input.payloadBounds, expiresAt),
            }
          : { supplyMode: 'byok', authenticatedKey, request };

      const fixedIdsMetering: SaasMeteringAdmissionPort = {
        async admitRequest(request: CreateRequestInput, meterOptions = {}) {
          if (!meterOptions?.executor) throw new Error('caller transaction is required');
          // Prepared replays may have no metering idempotency row. Admission only
          // consumes the replay kind/request here; this adapter reloads and
          // revalidates the persisted attempt before returning an allowed result.
          return (await options.metering.admitPreparedRequest(request, {
            requestId: canonicalRequestId,
            attemptId: input.attemptId,
            executor: meterOptions.executor,
          })) as RequestAdmission;
        },
      };
      try {
        const service = new SaasRequestAdmissionService(
          options.database,
          fixedIdsMetering,
          options.billing,
          options.guard,
          options.authorizationPrelock,
          { idFactory, now },
        );
        const result = await service.admit(command, { executor });
        if (result.kind === 'tombstone') {
          return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ADMISSION_FAILURE };
        }
        if (result.request.id !== canonicalRequestId || result.request.tenantId !== resolvedCaller.tenantId) {
          return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ADMISSION_FAILURE };
        }
        let holdReservation: RequestPreparationAdmission['holdReservation'] = null;
        if (resolvedCaller.supplyMode === 'platform') {
          if (result.kind === 'created' && result.reservation) {
            holdReservation = holdFromReservation(result.reservation);
          } else {
            const existing = await queryOne<Row>(
              executor,
              `SELECT id, tenant_id, request_id, currency, amount_minor_units, price_snapshot_ref, expires_at, state
               FROM saas_billing_reservations
               WHERE tenant_id = $1 AND request_id = $2
                 AND idempotency_namespace = 'saas.billing.reservation' AND business_key = $3
               FOR SHARE`,
              [
                resolvedCaller.tenantId,
                canonicalRequestId,
                createRequestAdmissionReservationBusinessKey(resolvedCaller.tenantId, canonicalRequestId),
              ],
            );
            if (
              existing?.state !== 'reserved' ||
              existing.tenant_id !== resolvedCaller.tenantId ||
              existing.request_id !== canonicalRequestId ||
              !nonEmpty(existing.id) ||
              !nonEmpty(existing.currency) ||
              !nonEmpty(existing.price_snapshot_ref)
            ) {
              return { decision: 'reject', code: 'hold_denied', message: 'The existing platform hold is unavailable.' };
            }
            holdReservation = holdFromReservation({
              id: existing.id as string,
              tenantId: existing.tenant_id as string,
              requestId: existing.request_id as string,
              currency: existing.currency as string,
              amountMinorUnits: BigInt(String(existing.amount_minor_units)),
              priceSnapshotRef: existing.price_snapshot_ref as string,
              expiresAt: new Date(String(existing.expires_at)).toISOString(),
            });
          }
          if (!holdReservation) {
            return { decision: 'reject', code: 'hold_denied', message: 'The existing platform hold is unavailable.' };
          }
          if (
            holdReservation.expiresAt instanceof Date
              ? holdReservation.expiresAt.getTime() !== expiresAt.getTime()
              : Date.parse(holdReservation.expiresAt) !== expiresAt.getTime()
          ) {
            return {
              decision: 'reject',
              code: 'binding_mismatch',
              message: 'The platform hold window does not match admission.',
            };
          }
        } else if (result.reservation !== null) {
          return {
            decision: 'reject',
            code: 'binding_mismatch',
            message: 'BYOK cannot reserve a platform wallet hold.',
          };
        }
        const persistedAttempt =
          result.kind === 'created'
            ? result.initialAttempt
            : await options.metering.getAttempt(resolvedCaller.tenantId, canonicalRequestId, input.attemptId, {
                executor,
              });
        if (!persistedAttempt || persistedAttempt.id !== input.attemptId || !attemptIsPreDispatch(persistedAttempt)) {
          return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ADMISSION_FAILURE };
        }
        if (result.kind === 'replayed') {
          await options.guard.revalidate({
            executor,
            request: result.request,
            candidate: persistedAttempt,
            holdEvidence:
              resolvedCaller.supplyMode === 'platform' ? admissionHoldEvidence(input.payloadBounds, expiresAt) : null,
          });
        }
        const deadlineAtMs = expiresAt.getTime();
        const admission: RequestPreparationAdmission = {
          quotaReservation: capacityResult.value.quotaReservation,
          rateReservation: capacityResult.value.rateReservation,
          holdReservation,
          idempotencyBinding: {
            state: 'created',
            keyDigest: idempotencyClaim.keyDigest,
            requestFingerprint,
            requestFingerprintVersion,
            tenantId: resolvedCaller.tenantId,
            projectId: resolvedCaller.projectId,
            proxyKeyId: resolvedCaller.proxyKeyId,
            requestId: canonicalRequestId,
          },
          deadlineAtMs,
          dispatchDeadline: expiresAt,
          expiresAt,
          remainingAttempts: capacityResult.value.remainingAttempts,
          retryBudget: capacityResult.value.retryBudget,
          attemptOrdinal: persistedAttempt.ordinal,
          usageBudget: capacityResult.value.usageBudget,
        };
        bindings.set(canonicalRequestId, {
          requestId: canonicalRequestId,
          attemptId: input.attemptId,
          caller: resolvedCaller,
          entitlement: resolvedEntitlement,
          authority,
          admission,
          publicModel: authority.route.publicModel,
          protocol: authority.route.protocol,
          requestFingerprint,
          requestFingerprintVersion,
          payloadSha256: input.payloadSha256.toLowerCase(),
          payloadCompilerVersion: options.payloadCompilerVersion,
          usageEstimatorVersion: options.usageEstimatorVersion,
          modelResolution,
          clientProtocol: authority.route.protocol,
          providerProtocol,
          clientOperation,
          providerOperation,
        });
        return allowRequestPreparation(admission);
      } catch (error) {
        if (safeErrorCode(error) === 'IDEMPOTENCY_CONFLICT') {
          return {
            decision: 'reject',
            code: 'binding_mismatch',
            message: 'The idempotency key is already bound to a different request identity or fingerprint.',
          };
        }
        if (
          (error instanceof SaasBillingError && error.code === 'INSUFFICIENT_FUNDS') ||
          safeErrorCode(error) === 'INSUFFICIENT_FUNDS'
        ) {
          return {
            decision: 'reject',
            code: 'hold_denied',
            message: 'The platform wallet has insufficient available funds.',
          };
        }
        return blockRequestPreparation('storage_failure', SAFE_ADMISSION_FAILURE);
      }
    },
  };

  const attempt: RequestPreparationAttemptPort = {
    async persist(input, sqlOptions?: RequestPreparationSqlOptions) {
      const executor = sqlOptions?.executor;
      if (!executor) return blockRequestPreparation('capability_unavailable', SAFE_ATTEMPT_FAILURE);
      const expected = bindings.get(input.requestId);
      if (
        !expected ||
        !sameAuthority(expected, input) ||
        input.attemptId !== expected.attemptId ||
        input.requestFingerprint !== expected.requestFingerprint ||
        input.requestFingerprintVersion !== expected.requestFingerprintVersion ||
        input.payloadSha256 !== expected.payloadSha256 ||
        input.payloadCompilerVersion !== expected.payloadCompilerVersion ||
        input.usageEstimatorVersion !== expected.usageEstimatorVersion ||
        input.publicModel !== expected.publicModel ||
        input.protocol !== expected.protocol ||
        input.clientProtocol !== expected.clientProtocol ||
        input.providerProtocol !== expected.providerProtocol ||
        input.clientOperation !== expected.clientOperation ||
        input.providerOperation !== expected.providerOperation ||
        JSON.stringify(input.modelResolution) !== JSON.stringify(expected.modelResolution)
      ) {
        return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ATTEMPT_FAILURE };
      }
      try {
        const [request, storedAttempt] = await Promise.all([
          options.metering.getRequest(input.caller.tenantId, input.requestId, { executor }),
          options.metering.getAttempt(input.caller.tenantId, input.requestId, input.attemptId, { executor }),
        ]);
        if (
          !request ||
          !storedAttempt ||
          request.tenantId !== input.caller.tenantId ||
          request.projectId !== input.caller.projectId ||
          request.proxyKeyId !== input.caller.proxyKeyId ||
          request.supplyMode !== input.caller.supplyMode ||
          request.publicModel !== input.publicModel ||
          request.protocol !== input.protocol ||
          request.requestFingerprint !== input.requestFingerprint ||
          request.requestFingerprintVersion !== input.requestFingerprintVersion ||
          storedAttempt.id !== input.attemptId ||
          storedAttempt.requestId !== input.requestId ||
          storedAttempt.tenantId !== input.caller.tenantId ||
          !attemptIsPreDispatch(storedAttempt) ||
          storedAttempt.ordinal !== expected.admission.attemptOrdinal ||
          storedAttempt.upstreamId !== input.authority.candidate.upstreamId ||
          storedAttempt.accountId !== input.authority.candidate.accountId ||
          storedAttempt.credentialId !== input.authority.candidate.credentialId ||
          storedAttempt.routeConfigId !== input.authority.route.routeConfigId ||
          String(storedAttempt.routeConfigVersion) !== String(input.authority.route.routeConfigVersion) ||
          !requestIsUncharged(request, input.caller.supplyMode)
        ) {
          return { decision: 'reject', code: 'binding_mismatch', message: SAFE_ATTEMPT_FAILURE };
        }
        const value: RequestPreparationAttemptRecord = {
          tenantId: storedAttempt.tenantId,
          projectId: input.caller.projectId,
          proxyKeyId: input.caller.proxyKeyId,
          requestId: storedAttempt.requestId,
          attemptId: storedAttempt.id,
          attemptOrdinal: storedAttempt.ordinal,
          publicModel: input.publicModel,
          protocol: input.protocol,
          endpoint: input.authority.route.endpoint,
          routeConfigId: input.authority.route.routeConfigId,
          routeConfigVersion: input.authority.route.routeConfigVersion,
          supplyMode: input.caller.supplyMode,
          upstreamId: storedAttempt.upstreamId,
          accountId: input.authority.candidate.accountId,
          credentialId: input.authority.candidate.credentialId,
          resolvedModel: storedAttempt.resolvedModel,
          modelResolution: expected.modelResolution,
          clientProtocol: expected.clientProtocol,
          providerProtocol: expected.providerProtocol,
          clientOperation: expected.clientOperation,
          providerOperation: expected.providerOperation,
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
        bindings.delete(input.requestId);
        return allowRequestPreparation(value);
      } catch {
        return blockRequestPreparation('storage_failure', SAFE_ATTEMPT_FAILURE);
      }
    },
  };

  const compensation: RequestPreparationCompensationPort = {
    async releasePreDispatch(input: RequestPreparationCompensationInput, sqlOptions?: RequestPreparationSqlOptions) {
      const executor = sqlOptions?.executor;
      if (!executor) return blockRequestPreparation('capability_unavailable', SAFE_COMPENSATION_FAILURE);
      try {
        const [request, storedAttempt] = await Promise.all([
          options.metering.getRequest(input.tenantId, input.requestId, { executor }),
          options.metering.getAttempt(input.tenantId, input.requestId, input.attemptId, { executor }),
        ]);
        if (
          !request ||
          !storedAttempt ||
          request.tenantId !== input.tenantId ||
          storedAttempt.tenantId !== input.tenantId ||
          storedAttempt.requestId !== input.requestId ||
          storedAttempt.id !== input.attemptId ||
          !attemptIsPreDispatch(storedAttempt) ||
          storedAttempt.dispatchState !== input.expectedAttempt.dispatchState ||
          storedAttempt.resultState !== input.expectedAttempt.resultState ||
          storedAttempt.responseStarted !== input.expectedAttempt.responseStarted ||
          !requestIsUncharged(request, request.supplyMode)
        ) {
          return { decision: 'reject', code: 'binding_mismatch', message: SAFE_COMPENSATION_FAILURE };
        }
        if (!options.capacity) return blockRequestPreparation('capability_unavailable', SAFE_COMPENSATION_FAILURE);
        const capacityRelease = await options.capacity.release(executor, {
          tenantId: input.tenantId,
          projectId: request.projectId,
          requestId: input.requestId,
          attemptId: input.attemptId,
          quotaReservation: input.admission.quotaReservation,
          rateReservation: input.admission.rateReservation,
        });
        let holdResult: RequestPreparationCompensationResult['holdReservation'] = 'not_applicable';
        if (request.supplyMode === 'platform') {
          const hold = input.admission.holdReservation;
          if (!hold || hold.tenantId !== input.tenantId || hold.requestId !== input.requestId) {
            return { decision: 'reject', code: 'binding_mismatch', message: SAFE_COMPENSATION_FAILURE };
          }
          const release: ReleaseBillingInput = {
            supplyMode: 'platform',
            tenantId: input.tenantId,
            requestId: input.requestId,
            currency: hold.currency,
            releaseId: `gateway-pre-dispatch:${input.attemptId}`,
            releaseEvidenceRef: `gateway-pre-dispatch:${input.attemptId}:${input.failedStage}:${input.failureCode}`,
            businessKey: createRequestAdmissionReservationBusinessKey(input.tenantId, input.requestId),
          };
          const released = await options.billing.release(executor, release);
          if (
            released.id !== hold.reservationId ||
            released.tenantId !== input.tenantId ||
            released.requestId !== input.requestId ||
            released.state !== 'released'
          ) {
            return blockRequestPreparation('storage_failure', SAFE_COMPENSATION_FAILURE);
          }
          holdResult = 'released';
        }
        const quotaReservation = capacityRelease.quotaReservation;
        const rateReservation = capacityRelease.rateReservation;
        const allReleased =
          quotaReservation === 'released' &&
          rateReservation === 'released' &&
          (holdResult === 'released' || holdResult === 'not_applicable');
        const value: RequestPreparationCompensationResult = {
          requestId: input.requestId,
          attemptId: input.attemptId,
          disposition: allReleased ? 'released' : 'retained_for_reconciliation',
          quotaReservation,
          rateReservation,
          holdReservation: holdResult,
          manualReconciliationRequired: !allReleased,
        };
        return allowRequestPreparation(value);
      } catch {
        return blockRequestPreparation('storage_failure', SAFE_COMPENSATION_FAILURE);
      }
    },
  };

  return { caller, entitlement, admission, attempt, compensation };
}
