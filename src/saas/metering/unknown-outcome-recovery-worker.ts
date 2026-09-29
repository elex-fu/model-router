import { randomUUID } from 'node:crypto';
import { PlatformWalletLedgerService } from '../billing/service.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { sha256Hex } from './digest.js';
import { PostgresUnknownOutcomeOperatorAuthorizationAdapter } from './postgres-unknown-outcome-operator-authorization.js';
import type { SaasMeteringService } from './service.js';
import type { UnknownOutcomeProviderEvidenceObservation } from './unknown-outcome-reconciliation-service.js';

const MAX_BATCH_SIZE = 100;
const MAX_LEASE_MS = 5 * 60 * 1000;
const MAX_SCAN_ATTEMPTS = 12;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const OPERATOR_AUDIT_ENTRY_POINT = 'saas_gateway_operator_reconciliation';
const BILLING_RESERVATION_NAMESPACE = 'saas.billing.reservation';

export type UnknownOutcomeSupplyMode = 'byok' | 'platform';

export interface UnknownOutcomeRecoveryClaim {
  readonly caseId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly supplyMode: UnknownOutcomeSupplyMode;
  readonly leaseToken: string;
  readonly scanAttempt: number;
}

export interface UnknownOutcomeOperatorCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly supplyMode: UnknownOutcomeSupplyMode;
  readonly scanAttempts: number;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
}

export interface UnknownOutcomeCaseObservation {
  readonly observationId: string;
  readonly kind:
    | 'request_snapshot'
    | 'attempt_snapshot'
    | 'usage_snapshot'
    | 'provider_evidence'
    | 'operator_resolution';
  readonly observedAt: string;
  readonly attemptId: string | null;
  readonly usageEventId: string | null;
  readonly supplyMode: UnknownOutcomeSupplyMode | null;
  readonly executionState: 'pending' | 'succeeded' | 'failed' | 'unknown' | null;
  readonly reconciliationState: 'none' | 'pending' | 'resolved' | null;
  readonly financialStatus: string | null;
  readonly requestStateVersion: number | null;
  readonly dispatchState: string | null;
  readonly resultState: string | null;
  readonly responseStarted: boolean | null;
  readonly attemptStateVersion: number | null;
  readonly upstreamId: string | null;
  readonly accountOwnerKind: string | null;
  readonly accountId: string | null;
  readonly providerId: string | null;
  readonly productId: string | null;
  readonly resolvedModel: string | null;
  readonly unknownReason: string | null;
  readonly usageEventDigest: string | null;
  readonly providerStatus: string | null;
  readonly providerOperationId: string | null;
  readonly providerIdentityDigest: string | null;
  readonly providerUsage: unknown | null;
  readonly evidenceReference: string | null;
  readonly operatorOutcome: string | null;
  readonly actorUserId: string | null;
  readonly reason: string | null;
  readonly auditEventId: string | null;
  readonly supportTicketRef: string | null;
}

export interface UnknownOutcomeOperatorCaseDetail {
  readonly summary: UnknownOutcomeOperatorCase;
  readonly possibleAttemptIds: readonly string[];
  readonly observations: readonly UnknownOutcomeCaseObservation[];
}

export interface UnknownOutcomeOperatorCoverage {
  readonly attemptId: string;
  readonly outcome: 'not_executed' | 'executed';
  readonly evidenceReference: string;
}

export interface ResolveUnknownOutcomeNonExecutionInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly actorUserId: string;
  /** Derived from the authenticated platform session; never persisted or audited. */
  readonly actorSessionId: string;
  /** Bounded support-system locator persisted with the resolution record. */
  readonly supportTicketRef: string;
  readonly idempotencyKey: string;
  readonly reason: string;
  /** One independently referenced operator evidence item for every possibly sent attempt. */
  readonly coverage: readonly UnknownOutcomeOperatorCoverage[];
}

export interface PreparedUnknownOutcomeResolution extends ResolveUnknownOutcomeNonExecutionInput {
  readonly resolutionDigest: string;
  readonly evidenceDigest: string;
}

export type UnknownOutcomeOperatorResolutionResult =
  | { readonly status: 'resolved' | 'replayed'; readonly caseId: string; readonly requestId: string }
  | { readonly status: 'unauthorized' }
  | { readonly status: 'case_not_found' }
  | { readonly status: 'insufficient_evidence'; readonly missingAttemptIds: readonly string[] }
  | { readonly status: 'unexpected_attempt_coverage'; readonly attemptIds: readonly string[] }
  | { readonly status: 'contradictory_evidence'; readonly attemptIds: readonly string[] }
  | { readonly status: 'request_not_unknown' | 'financial_state_conflict' | 'resolution_conflict' };

export type UnknownOutcomeCaseCaptureResult =
  | { readonly status: 'operator_required'; readonly caseId: string; readonly requestId: string }
  | { readonly status: 'superseded'; readonly caseId: string; readonly requestId: string }
  | { readonly status: 'lease_lost'; readonly caseId: string; readonly requestId: string };

type UnknownOutcomeOperatorCoverageError = Extract<
  UnknownOutcomeOperatorResolutionResult,
  { status: 'insufficient_evidence' | 'unexpected_attempt_coverage' | 'contradictory_evidence' }
>;

export interface UnknownOutcomeRecoveryRepository {
  claimDue(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly UnknownOutcomeRecoveryClaim[]>;
  captureAndEscalate(claim: UnknownOutcomeRecoveryClaim): Promise<UnknownOutcomeCaseCaptureResult>;
  retryClaim(
    claim: UnknownOutcomeRecoveryClaim,
    errorCode: string,
    backoffMs: number,
    maxAttempts: number,
  ): Promise<boolean>;
  listOperatorRequired(tenantId: string, limit: number): Promise<readonly UnknownOutcomeOperatorCase[]>;
  getOperatorRequired(tenantId: string, caseId: string): Promise<UnknownOutcomeOperatorCaseDetail | null>;
  resolveNonExecution(
    input: PreparedUnknownOutcomeResolution,
    revalidateAuthorization: UnknownOutcomeOperatorAuthorizationRecheck,
  ): Promise<UnknownOutcomeOperatorResolutionResult>;
  recordProviderObservation(input: UnknownOutcomeProviderEvidenceObservation): Promise<void>;
}

export interface UnknownOutcomeOperatorAuthorizationTransactionInput {
  readonly executor: SqlExecutor;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorSessionId: string;
}

export interface UnknownOutcomeOperatorAuthorizationPreflightInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorSessionId: string;
}

export interface UnknownOutcomeOperatorAuthorizationPort {
  /** Fast preflight only; this result is never authoritative for the mutation. */
  mayResolveUnknownOutcome(input: UnknownOutcomeOperatorAuthorizationPreflightInput): Promise<boolean>;
  /**
   * Rechecks current authorization facts on the supplied transaction executor.
   * Implementations must use this executor, acquire the matching authorization
   * fences before ordinary reads, and fail closed.
   */
  revalidateMayResolveUnknownOutcome(input: UnknownOutcomeOperatorAuthorizationTransactionInput): Promise<boolean>;
}

export type UnknownOutcomeOperatorAuthorizationRecheck = (
  input: UnknownOutcomeOperatorAuthorizationTransactionInput,
) => Promise<boolean>;

export interface UnknownOutcomeRecoveryRunResult {
  readonly claimed: number;
  readonly operatorRequired: readonly string[];
  readonly superseded: readonly string[];
  readonly leaseLost: readonly string[];
  readonly deferred: readonly string[];
  readonly failed: number;
}

export function validateOperatorCoverage(
  possibleAttemptIds: readonly string[],
  coverage: readonly UnknownOutcomeOperatorCoverage[],
): UnknownOutcomeOperatorCoverageError | null {
  const expected = new Set(possibleAttemptIds);
  const seen = new Set<string>();
  const missingAttemptIds = possibleAttemptIds.filter(
    (attemptId) => !coverage.some((item) => item.attemptId === attemptId),
  );
  if (missingAttemptIds.length > 0) return { status: 'insufficient_evidence', missingAttemptIds };

  const unexpected = coverage.filter((item) => !expected.has(item.attemptId)).map((item) => item.attemptId);
  const duplicates: string[] = [];
  for (const item of coverage) {
    if (seen.has(item.attemptId)) duplicates.push(item.attemptId);
    seen.add(item.attemptId);
  }
  if (unexpected.length > 0 || duplicates.length > 0) {
    return { status: 'unexpected_attempt_coverage', attemptIds: [...new Set([...unexpected, ...duplicates])].sort() };
  }

  const contradictory = coverage.filter((item) => item.outcome !== 'not_executed').map((item) => item.attemptId);
  if (contradictory.length > 0) {
    return { status: 'contradictory_evidence', attemptIds: contradictory.sort() };
  }
  return null;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be text`);
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
  if (normalized.length === 0 || normalized.length > maximum || hasControlCharacter) {
    throw new TypeError(`Invalid ${field}`);
  }
  return normalized;
}

function positiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be between 1 and ${maximum}`);
  }
}

function databaseText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
    throw new Error(`Invalid reconciliation database value: ${field}`);
  }
  return value;
}

function databaseOptionalText(value: unknown, field: string, maximum = 512): string | null {
  return value === null || value === undefined ? null : databaseText(value, field, maximum);
}

function databaseInteger(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid reconciliation database value: ${field}`);
  }
  return parsed;
}

function databaseDate(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new Error(`Invalid reconciliation database value: ${field}`);
  return date.toISOString();
}

function supplyMode(value: unknown): UnknownOutcomeSupplyMode {
  if (value === 'byok' || value === 'platform') return value;
  throw new Error('Invalid reconciliation database value: supply_mode');
}

function rowState(value: unknown): 'pending' | 'succeeded' | 'failed' | 'unknown' {
  if (value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'unknown') return value;
  throw new Error('Invalid reconciliation database value: execution state');
}

function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'RECONCILIATION_SCAN_FAILED';
}

class ReconciliationLeaseLostError extends Error {
  readonly code = 'RECONCILIATION_LEASE_LOST';

  constructor() {
    super('Unknown-outcome reconciliation lease was lost');
    this.name = 'ReconciliationLeaseLostError';
  }
}

function retryBackoffMs(scanAttempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, scanAttempt - 1), MAX_BACKOFF_MS);
}

function normalizeOperatorResolution(input: ResolveUnknownOutcomeNonExecutionInput): PreparedUnknownOutcomeResolution {
  const tenantId = boundedText(input.tenantId, 'tenantId', 255);
  const caseId = boundedText(input.caseId, 'caseId', 255);
  const actorUserId = boundedText(input.actorUserId, 'actorUserId', 255);
  const actorSessionId = boundedText(input.actorSessionId, 'actorSessionId', 255);
  const supportTicketRef = boundedText(input.supportTicketRef, 'supportTicketRef', 255);
  const idempotencyKey = boundedText(input.idempotencyKey, 'idempotencyKey', 255);
  const reason = boundedText(input.reason, 'reason', 2000);
  if (!Array.isArray(input.coverage) || input.coverage.length === 0 || input.coverage.length > 100) {
    throw new TypeError('coverage must contain between 1 and 100 attempt references');
  }
  const coverage = input.coverage
    .map((item) => ({
      attemptId: boundedText(item.attemptId, 'coverage.attemptId', 255),
      outcome: item.outcome,
      evidenceReference: boundedText(item.evidenceReference, 'coverage.evidenceReference', 512),
    }))
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
  const resolutionDigest = sha256Hex(
    JSON.stringify({ tenantId, caseId, actorUserId, supportTicketRef, idempotencyKey, reason, coverage }),
  );
  const evidenceDigest = sha256Hex(
    JSON.stringify(coverage.map(({ attemptId, evidenceReference }) => [attemptId, evidenceReference])),
  );
  return {
    tenantId,
    caseId,
    actorUserId,
    actorSessionId,
    supportTicketRef,
    idempotencyKey,
    reason,
    coverage,
    resolutionDigest,
    evidenceDigest,
  };
}

/** Durable operator case scanner. It performs no Provider calls or request redispatch. */
export class UnknownOutcomeReconciliationWorker {
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly repository: UnknownOutcomeRecoveryRepository,
    options: { readonly batchSize?: number; readonly leaseMs?: number; readonly maxAttempts?: number } = {},
  ) {
    this.batchSize = options.batchSize ?? 25;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 8;
    positiveInteger(this.batchSize, 'batchSize', MAX_BATCH_SIZE);
    positiveInteger(this.leaseMs, 'leaseMs', MAX_LEASE_MS);
    positiveInteger(this.maxAttempts, 'maxAttempts', MAX_SCAN_ATTEMPTS);
  }

  async runOnce(): Promise<UnknownOutcomeRecoveryRunResult> {
    const claims = await this.repository.claimDue(this.batchSize, this.leaseMs, this.maxAttempts);
    const operatorRequired: string[] = [];
    const superseded: string[] = [];
    const leaseLost: string[] = [];
    const deferred: string[] = [];
    let failed = 0;

    for (const claim of claims) {
      try {
        const result = await this.repository.captureAndEscalate(claim);
        if (result.status === 'operator_required') operatorRequired.push(result.caseId);
        else if (result.status === 'superseded') superseded.push(result.caseId);
        else leaseLost.push(result.caseId);
      } catch (error) {
        if (safeErrorCode(error) === 'RECONCILIATION_LEASE_LOST') {
          leaseLost.push(claim.caseId);
          continue;
        }
        failed += 1;
        try {
          const deferredByRepository = await this.repository.retryClaim(
            claim,
            safeErrorCode(error),
            retryBackoffMs(claim.scanAttempt),
            this.maxAttempts,
          );
          if (deferredByRepository) deferred.push(claim.caseId);
          else operatorRequired.push(claim.caseId);
        } catch {
          // The lease remains durable and will be reclaimed after expiry if the
          // database was unavailable while recording the retry.
          deferred.push(claim.caseId);
        }
      }
    }

    return { claimed: claims.length, operatorRequired, superseded, leaseLost, deferred, failed };
  }
}

/** Authorization is checked on every call; tenant and evidence scope are rechecked in the repository. */
export class UnknownOutcomeOperatorResolutionService {
  constructor(
    private readonly authorization: UnknownOutcomeOperatorAuthorizationPort,
    private readonly repository: UnknownOutcomeRecoveryRepository,
  ) {}

  async list(tenantIdInput: string, limit = 50): Promise<readonly UnknownOutcomeOperatorCase[]> {
    const tenantId = boundedText(tenantIdInput, 'tenantId', 255);
    positiveInteger(limit, 'limit', MAX_BATCH_SIZE);
    return this.repository.listOperatorRequired(tenantId, limit);
  }

  async get(tenantIdInput: string, caseIdInput: string): Promise<UnknownOutcomeOperatorCaseDetail | null> {
    const tenantId = boundedText(tenantIdInput, 'tenantId', 255);
    const caseId = boundedText(caseIdInput, 'caseId', 255);
    return this.repository.getOperatorRequired(tenantId, caseId);
  }

  async resolveNotExecuted(
    input: ResolveUnknownOutcomeNonExecutionInput,
  ): Promise<UnknownOutcomeOperatorResolutionResult> {
    const prepared = normalizeOperatorResolution(input);
    if (prepared.coverage.some((item) => item.outcome !== 'not_executed')) {
      return {
        status: 'contradictory_evidence',
        attemptIds: prepared.coverage.filter((item) => item.outcome !== 'not_executed').map((item) => item.attemptId),
      };
    }
    let authorized = false;
    try {
      authorized = await this.authorization.mayResolveUnknownOutcome({
        tenantId: prepared.tenantId,
        actorUserId: prepared.actorUserId,
        actorSessionId: prepared.actorSessionId,
      });
    } catch {
      return { status: 'unauthorized' };
    }
    if (!authorized) return { status: 'unauthorized' };
    return this.repository.resolveNonExecution(prepared, (transactionInput) =>
      this.authorization.revalidateMayResolveUnknownOutcome(transactionInput),
    );
  }
}

interface RecoveryRequestRow {
  readonly id: unknown;
  readonly tenant_id: unknown;
  readonly project_id: unknown;
  readonly supply_mode: unknown;
  readonly execution_state: unknown;
  readonly reconciliation_state: unknown;
  readonly financial_status: unknown;
  readonly state_version: unknown;
}

interface RecoveryAttemptRow {
  readonly id: unknown;
  readonly dispatch_state: unknown;
  readonly result_state: unknown;
  readonly response_started: unknown;
  readonly state_version: unknown;
  readonly unknown_reason: unknown;
  readonly upstream_id: unknown;
  readonly account_owner_kind: unknown;
  readonly account_id: unknown;
  readonly provider_id: unknown;
  readonly product_id: unknown;
  readonly resolved_model: unknown;
}

interface RecoveryUsageRow {
  readonly id: unknown;
  readonly attempt_id: unknown;
  readonly event_digest: unknown;
}

interface RecoveryCaseRow {
  readonly id: unknown;
  readonly tenant_id: unknown;
  readonly project_id: unknown;
  readonly request_id: unknown;
  readonly supply_mode: unknown;
  readonly case_state: unknown;
  readonly scan_attempt_count: unknown;
  readonly lease_token: unknown;
  readonly last_error_code: unknown;
  readonly created_at: unknown;
  readonly resolution_idempotency_key: unknown;
  readonly resolution_digest: unknown;
}

interface RecoveryObservationRow {
  readonly id: unknown;
  readonly observation_kind: unknown;
  readonly observed_at: unknown;
  readonly attempt_id: unknown;
  readonly usage_event_id: unknown;
  readonly supply_mode: unknown;
  readonly execution_state: unknown;
  readonly reconciliation_state: unknown;
  readonly financial_status: unknown;
  readonly request_state_version: unknown;
  readonly dispatch_state: unknown;
  readonly result_state: unknown;
  readonly response_started: unknown;
  readonly attempt_state_version: unknown;
  readonly upstream_id: unknown;
  readonly account_owner_kind: unknown;
  readonly account_id: unknown;
  readonly provider_id: unknown;
  readonly product_id: unknown;
  readonly resolved_model: unknown;
  readonly attempt_unknown_reason: unknown;
  readonly usage_event_digest: unknown;
  readonly provider_status: unknown;
  readonly provider_operation_id: unknown;
  readonly provider_identity_digest: unknown;
  readonly provider_usage: unknown;
  readonly evidence_reference: unknown;
  readonly operator_outcome: unknown;
  readonly actor_user_id: unknown;
  readonly reason: unknown;
  readonly audit_event_id: unknown;
  readonly support_ticket_ref: unknown;
}

function assertCaseIdentity(row: RecoveryCaseRow, claim: UnknownOutcomeRecoveryClaim): void {
  if (
    databaseText(row.id, 'case.id') !== claim.caseId ||
    databaseText(row.tenant_id, 'case.tenant_id') !== claim.tenantId ||
    databaseText(row.project_id, 'case.project_id') !== claim.projectId ||
    databaseText(row.request_id, 'case.request_id') !== claim.requestId ||
    supplyMode(row.supply_mode) !== claim.supplyMode
  ) {
    throw new Error('Reconciliation case identity changed');
  }
}

function possibleAttempt(row: RecoveryAttemptRow): boolean {
  return databaseText(row.dispatch_state, 'attempt.dispatch_state') !== 'not_sent';
}

function operatorCoverageCheck(
  rows: readonly RecoveryAttemptRow[],
  coverage: readonly UnknownOutcomeOperatorCoverage[],
): UnknownOutcomeOperatorCoverageError | null {
  const possibleIds = rows.filter(possibleAttempt).map((row) => databaseText(row.id, 'attempt.id'));
  if (possibleIds.length === 0) return { status: 'insufficient_evidence', missingAttemptIds: [] };
  const result = validateOperatorCoverage(possibleIds, coverage);
  if (result) return result;
  const succeeded = rows
    .filter((row) => row.result_state === 'succeeded')
    .map((row) => databaseText(row.id, 'attempt.id'));
  return succeeded.length > 0 ? { status: 'contradictory_evidence', attemptIds: succeeded } : null;
}

function mapOperatorCase(row: RecoveryCaseRow): UnknownOutcomeOperatorCase {
  return {
    caseId: databaseText(row.id, 'case.id'),
    tenantId: databaseText(row.tenant_id, 'case.tenant_id'),
    projectId: databaseText(row.project_id, 'case.project_id'),
    requestId: databaseText(row.request_id, 'case.request_id'),
    supplyMode: supplyMode(row.supply_mode),
    scanAttempts: databaseInteger(row.scan_attempt_count, 'case.scan_attempt_count', 0, MAX_SCAN_ATTEMPTS),
    lastErrorCode: databaseOptionalText(row.last_error_code, 'case.last_error_code', 64),
    createdAt: databaseDate(row.created_at, 'case.created_at'),
  };
}

function observationText(value: unknown, field: string, maximum = 2048): string | null {
  return value === null || value === undefined ? null : databaseText(value, field, maximum);
}

function mapObservation(row: RecoveryObservationRow): UnknownOutcomeCaseObservation {
  const kind = databaseText(row.observation_kind, 'observation.kind');
  if (
    kind !== 'request_snapshot' &&
    kind !== 'attempt_snapshot' &&
    kind !== 'usage_snapshot' &&
    kind !== 'provider_evidence' &&
    kind !== 'operator_resolution'
  ) {
    throw new Error('Invalid reconciliation database value: observation.kind');
  }
  const executionState = row.execution_state;
  const reconciliationState = row.reconciliation_state;
  if (
    executionState !== null &&
    executionState !== 'pending' &&
    executionState !== 'succeeded' &&
    executionState !== 'failed' &&
    executionState !== 'unknown'
  ) {
    throw new Error('Invalid reconciliation database value: observation.execution_state');
  }
  if (
    reconciliationState !== null &&
    reconciliationState !== 'none' &&
    reconciliationState !== 'pending' &&
    reconciliationState !== 'resolved'
  ) {
    throw new Error('Invalid reconciliation database value: observation.reconciliation_state');
  }
  return {
    observationId: databaseText(row.id, 'observation.id'),
    kind,
    observedAt: databaseDate(row.observed_at, 'observation.observed_at'),
    attemptId: observationText(row.attempt_id, 'observation.attempt_id'),
    usageEventId: observationText(row.usage_event_id, 'observation.usage_event_id'),
    supplyMode: row.supply_mode === null || row.supply_mode === undefined ? null : supplyMode(row.supply_mode),
    executionState,
    reconciliationState,
    financialStatus: observationText(row.financial_status, 'observation.financial_status'),
    requestStateVersion:
      row.request_state_version === null || row.request_state_version === undefined
        ? null
        : databaseInteger(row.request_state_version, 'observation.request_state_version', 1),
    dispatchState: observationText(row.dispatch_state, 'observation.dispatch_state'),
    resultState: observationText(row.result_state, 'observation.result_state'),
    responseStarted:
      row.response_started === null || row.response_started === undefined ? null : row.response_started === true,
    attemptStateVersion:
      row.attempt_state_version === null || row.attempt_state_version === undefined
        ? null
        : databaseInteger(row.attempt_state_version, 'observation.attempt_state_version', 1),
    upstreamId: observationText(row.upstream_id, 'observation.upstream_id'),
    accountOwnerKind: observationText(row.account_owner_kind, 'observation.account_owner_kind'),
    accountId: observationText(row.account_id, 'observation.account_id'),
    providerId: observationText(row.provider_id, 'observation.provider_id'),
    productId: observationText(row.product_id, 'observation.product_id'),
    resolvedModel: observationText(row.resolved_model, 'observation.resolved_model'),
    unknownReason: observationText(row.attempt_unknown_reason, 'observation.attempt_unknown_reason'),
    usageEventDigest: observationText(row.usage_event_digest, 'observation.usage_event_digest', 64),
    providerStatus: observationText(row.provider_status, 'observation.provider_status'),
    providerOperationId: observationText(row.provider_operation_id, 'observation.provider_operation_id'),
    providerIdentityDigest: observationText(row.provider_identity_digest, 'observation.provider_identity_digest', 64),
    providerUsage: row.provider_usage ?? null,
    evidenceReference: observationText(row.evidence_reference, 'observation.evidence_reference'),
    operatorOutcome: observationText(row.operator_outcome, 'observation.operator_outcome'),
    actorUserId: observationText(row.actor_user_id, 'observation.actor_user_id'),
    reason: observationText(row.reason, 'observation.reason', 2000),
    auditEventId: observationText(row.audit_event_id, 'observation.audit_event_id'),
    supportTicketRef: observationText(row.support_ticket_ref, 'observation.support_ticket_ref', 255),
  };
}

/** PostgreSQL implementation; provider I/O is deliberately absent from this repository. */
export class PostgresUnknownOutcomeRecoveryRepository implements UnknownOutcomeRecoveryRepository {
  private readonly idFactory: () => string;

  constructor(
    private readonly database: SaasDatabase,
    private readonly metering: SaasMeteringService,
    private readonly billing: PlatformWalletLedgerService = new PlatformWalletLedgerService(),
    options: { readonly idFactory?: () => string } = {},
  ) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async claimDue(limit: number, leaseMs: number, maxAttempts: number): Promise<readonly UnknownOutcomeRecoveryClaim[]> {
    positiveInteger(limit, 'limit', MAX_BATCH_SIZE);
    positiveInteger(leaseMs, 'leaseMs', MAX_LEASE_MS);
    positiveInteger(maxAttempts, 'maxAttempts', MAX_SCAN_ATTEMPTS);

    return this.database.transaction(async (tx) => {
      const missing = await tx.query<RecoveryRequestRow>(
        `SELECT r.id, r.tenant_id, r.project_id, r.supply_mode,
                r.execution_state, r.reconciliation_state, r.financial_status, r.state_version
           FROM saas_requests AS r
          WHERE r.execution_state = 'unknown'
            AND r.reconciliation_state = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM saas_unknown_outcome_reconciliation_cases AS c
               WHERE c.tenant_id = r.tenant_id AND c.request_id = r.id
            )
          ORDER BY r.updated_at ASC, r.tenant_id ASC, r.id ASC
          LIMIT $1
          FOR UPDATE OF r SKIP LOCKED`,
        [limit],
      );
      for (const request of missing.rows) {
        const tenantId = databaseText(request.tenant_id, 'request.tenant_id');
        const requestId = databaseText(request.id, 'request.id');
        const projectId = databaseText(request.project_id, 'request.project_id');
        const mode = supplyMode(request.supply_mode);
        await tx.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_cases
             (id, tenant_id, project_id, request_id, supply_mode, case_state,
              scan_attempt_count, next_attempt_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'open', 0, clock_timestamp(), clock_timestamp(), clock_timestamp())
           ON CONFLICT (tenant_id, request_id) DO NOTHING`,
          [this.idFactory(), tenantId, projectId, requestId, mode],
        );
      }

      await tx.query(
        `UPDATE saas_unknown_outcome_reconciliation_cases
            SET case_state = 'operator_required',
                next_attempt_at = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = COALESCE(last_error_code, 'RECONCILIATION_RETRY_LIMIT'),
                updated_at = clock_timestamp()
          WHERE case_state = 'open'
            AND scan_attempt_count >= $1
            AND next_attempt_at <= clock_timestamp()
            AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())`,
        [maxAttempts],
      );

      const ready = await tx.query<RecoveryCaseRow>(
        `SELECT id, tenant_id, project_id, request_id, supply_mode,
                case_state, scan_attempt_count, lease_token, last_error_code, created_at,
                resolution_idempotency_key, resolution_digest
           FROM saas_unknown_outcome_reconciliation_cases
          WHERE case_state = 'open'
            AND scan_attempt_count < $2
            AND next_attempt_at <= clock_timestamp()
            AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
          ORDER BY next_attempt_at ASC, created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit, maxAttempts],
      );

      const claims: UnknownOutcomeRecoveryClaim[] = [];
      for (const row of ready.rows) {
        const caseId = databaseText(row.id, 'case.id');
        const tenantId = databaseText(row.tenant_id, 'case.tenant_id');
        const projectId = databaseText(row.project_id, 'case.project_id');
        const requestId = databaseText(row.request_id, 'case.request_id');
        const mode = supplyMode(row.supply_mode);
        const leaseToken = this.idFactory();
        const claimed = await tx.query<RecoveryCaseRow>(
          `UPDATE saas_unknown_outcome_reconciliation_cases
              SET lease_token = $2,
                  lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
                  scan_attempt_count = scan_attempt_count + 1,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND tenant_id = $4
              AND case_state = 'open'
              AND scan_attempt_count < $5
              AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp())
            RETURNING scan_attempt_count`,
          [caseId, leaseToken, leaseMs, tenantId, maxAttempts],
        );
        const attemptNumber = databaseInteger(
          claimed.rows[0]?.scan_attempt_count,
          'case.scan_attempt_count',
          1,
          maxAttempts,
        );
        claims.push({
          caseId,
          tenantId,
          projectId,
          requestId,
          supplyMode: mode,
          leaseToken,
          scanAttempt: attemptNumber,
        });
      }
      return claims;
    });
  }

  async captureAndEscalate(claim: UnknownOutcomeRecoveryClaim): Promise<UnknownOutcomeCaseCaptureResult> {
    return this.database.transaction(async (tx) => {
      const requestResult = await tx.query<RecoveryRequestRow>(
        `SELECT id, tenant_id, project_id, supply_mode, execution_state,
                reconciliation_state, financial_status, state_version
           FROM saas_requests
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
        [claim.tenantId, claim.requestId],
      );
      const request = requestResult.rows[0];
      if (!request) throw new Error('Unknown-outcome request disappeared');
      if (
        databaseText(request.tenant_id, 'request.tenant_id') !== claim.tenantId ||
        databaseText(request.project_id, 'request.project_id') !== claim.projectId ||
        databaseText(request.id, 'request.id') !== claim.requestId ||
        supplyMode(request.supply_mode) !== claim.supplyMode
      ) {
        throw new Error('Unknown-outcome request identity changed');
      }

      const attemptResult = await tx.query<RecoveryAttemptRow>(
        `SELECT id, dispatch_state, result_state, response_started, state_version, unknown_reason,
                upstream_id, account_owner_kind, account_id, provider_id, product_id, resolved_model
           FROM saas_attempts
          WHERE tenant_id = $1 AND request_id = $2
          ORDER BY ordinal ASC, id ASC
          FOR UPDATE`,
        [claim.tenantId, claim.requestId],
      );
      const usageResult = await tx.query<RecoveryUsageRow>(
        `SELECT id, attempt_id, event_digest
           FROM saas_usage_events
          WHERE tenant_id = $1 AND request_id = $2
          ORDER BY created_at ASC, id ASC`,
        [claim.tenantId, claim.requestId],
      );
      const ownedLease = await tx.query<RecoveryCaseRow>(
        `SELECT id, tenant_id, project_id, request_id, supply_mode,
                case_state, scan_attempt_count, lease_token, last_error_code, created_at,
                resolution_idempotency_key, resolution_digest
          FROM saas_unknown_outcome_reconciliation_cases
          WHERE id = $1 AND tenant_id = $2 AND request_id = $3
            AND case_state = 'open' AND lease_token = $4
            AND lease_expires_at > clock_timestamp()
          FOR UPDATE`,
        [claim.caseId, claim.tenantId, claim.requestId, claim.leaseToken],
      );
      if (!ownedLease.rows[0]) return { status: 'lease_lost', caseId: claim.caseId, requestId: claim.requestId };
      assertCaseIdentity(ownedLease.rows[0], claim);
      const requestVersion = databaseInteger(request.state_version, 'request.state_version', 1);
      const requestExecution = rowState(request.execution_state);
      const requestReconciliation = databaseText(request.reconciliation_state, 'request.reconciliation_state');
      const requestFinancial = databaseText(request.financial_status, 'request.financial_status');
      const mode = supplyMode(request.supply_mode);

      const requestObservation = async (financialStatus: string, stateVersion: number): Promise<void> => {
        await tx.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, observation_kind, supply_mode,
              execution_state, reconciliation_state, financial_status, request_state_version, observed_at)
           VALUES ($1, $2, $3, $4, 'request_snapshot', $5, $6, $7, $8, $9, clock_timestamp())`,
          [
            this.idFactory(),
            claim.tenantId,
            claim.caseId,
            claim.requestId,
            mode,
            requestExecution,
            requestReconciliation,
            financialStatus,
            stateVersion,
          ],
        );
      };

      await requestObservation(requestFinancial, requestVersion);
      for (const attempt of attemptResult.rows) {
        await tx.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, attempt_id, observation_kind,
              request_state_version, dispatch_state, result_state, response_started,
              attempt_state_version, upstream_id, account_owner_kind, account_id,
              provider_id, product_id, resolved_model, attempt_unknown_reason, observed_at)
           VALUES ($1, $2, $3, $4, $5, 'attempt_snapshot', $6, $7, $8, $9, $10,
                   $11, $12, $13, $14, $15, $16, $17, clock_timestamp())`,
          [
            this.idFactory(),
            claim.tenantId,
            claim.caseId,
            claim.requestId,
            databaseText(attempt.id, 'attempt.id'),
            requestVersion,
            databaseText(attempt.dispatch_state, 'attempt.dispatch_state'),
            databaseText(attempt.result_state, 'attempt.result_state'),
            attempt.response_started === true,
            databaseInteger(attempt.state_version, 'attempt.state_version', 1),
            databaseText(attempt.upstream_id, 'attempt.upstream_id'),
            databaseOptionalText(attempt.account_owner_kind, 'attempt.account_owner_kind'),
            databaseOptionalText(attempt.account_id, 'attempt.account_id'),
            databaseOptionalText(attempt.provider_id, 'attempt.provider_id'),
            databaseOptionalText(attempt.product_id, 'attempt.product_id'),
            databaseText(attempt.resolved_model, 'attempt.resolved_model'),
            databaseOptionalText(attempt.unknown_reason, 'attempt.unknown_reason', 1024),
          ],
        );
      }
      for (const usage of usageResult.rows) {
        await tx.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, attempt_id, usage_event_id,
              observation_kind, usage_event_digest, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'usage_snapshot', $7, clock_timestamp())`,
          [
            this.idFactory(),
            claim.tenantId,
            claim.caseId,
            claim.requestId,
            databaseText(usage.attempt_id, 'usage.attempt_id'),
            databaseText(usage.id, 'usage.id'),
            databaseText(usage.event_digest, 'usage.event_digest', 64),
          ],
        );
      }

      const stillUnknown = requestExecution === 'unknown' && requestReconciliation === 'pending';
      let finalFinancial = requestFinancial;
      let finalRequestVersion = requestVersion;
      let financialError: string | null = null;
      if (stillUnknown && mode === 'platform') {
        if (requestFinancial !== 'pending' && requestFinancial !== 'reconciliation_pending') {
          financialError = 'PLATFORM_FINANCIAL_STATE_CONFLICT';
        } else {
          const pending = await this.billing.markReconciliationPending(tx, {
            supplyMode: 'platform',
            tenantId: claim.tenantId,
            requestId: claim.requestId,
            evidenceRef: `unknown-outcome-case:${claim.caseId}`,
            businessKey: `saas-request-admission:${claim.tenantId}:${claim.requestId}`,
            idempotencyNamespace: BILLING_RESERVATION_NAMESPACE,
          });
          if (pending.state !== 'reconciliation_pending') {
            financialError = 'PLATFORM_RESERVATION_STATE_CONFLICT';
          } else if (requestFinancial === 'pending') {
            const updated = await this.metering.transitionFinancialStatus({
              executor: tx,
              tenantId: claim.tenantId,
              requestId: claim.requestId,
              expectedFinancialStatus: 'pending',
              financialStatus: 'reconciliation_pending',
              expectedStateVersion: requestVersion,
            });
            finalFinancial = updated.financialStatus;
            finalRequestVersion = updated.stateVersion;
            await requestObservation(finalFinancial, finalRequestVersion);
          }
        }
      }

      const finalState = stillUnknown ? 'operator_required' : 'superseded';
      const lastErrorCode = financialError;
      const updatedCase = await tx.query(
        `UPDATE saas_unknown_outcome_reconciliation_cases
            SET case_state = $4,
                next_attempt_at = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = $5,
                updated_at = clock_timestamp()
          WHERE id = $1 AND tenant_id = $2 AND lease_token = $3`,
        [claim.caseId, claim.tenantId, claim.leaseToken, finalState, lastErrorCode],
      );
      if (updatedCase.rowCount !== 1) throw new ReconciliationLeaseLostError();
      return stillUnknown
        ? { status: 'operator_required', caseId: claim.caseId, requestId: claim.requestId }
        : { status: 'superseded', caseId: claim.caseId, requestId: claim.requestId };
    });
  }

  async retryClaim(
    claim: UnknownOutcomeRecoveryClaim,
    errorCode: string,
    backoffMs: number,
    maxAttempts: number,
  ): Promise<boolean> {
    if (!SAFE_ERROR_CODE.test(errorCode)) throw new TypeError('Invalid reconciliation error code');
    positiveInteger(backoffMs, 'backoffMs', MAX_BACKOFF_MS);
    positiveInteger(maxAttempts, 'maxAttempts', MAX_SCAN_ATTEMPTS);
    return this.database.transaction(async (tx) => {
      const result = await tx.query<{ readonly case_state: unknown }>(
        `UPDATE saas_unknown_outcome_reconciliation_cases
            SET case_state = CASE
                  WHEN scan_attempt_count >= $5 THEN 'operator_required'
                  ELSE 'open'
                END,
                next_attempt_at = CASE
                  WHEN scan_attempt_count >= $5 THEN NULL
                  ELSE clock_timestamp() + ($4::bigint * interval '1 millisecond')
                END,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = $6,
                updated_at = clock_timestamp()
          WHERE id = $1 AND tenant_id = $2 AND request_id = $3
            AND case_state = 'open' AND lease_token = $7
          RETURNING case_state`,
        [claim.caseId, claim.tenantId, claim.requestId, backoffMs, maxAttempts, errorCode, claim.leaseToken],
      );
      const state = result.rows[0]?.case_state;
      if (state === undefined) return false;
      return state === 'open';
    });
  }

  async listOperatorRequired(tenantIdInput: string, limit: number): Promise<readonly UnknownOutcomeOperatorCase[]> {
    const tenantId = boundedText(tenantIdInput, 'tenantId', 255);
    positiveInteger(limit, 'limit', MAX_BATCH_SIZE);
    const result = await this.database.query<RecoveryCaseRow>(
      `SELECT id, tenant_id, project_id, request_id, supply_mode,
              case_state, scan_attempt_count, lease_token, last_error_code, created_at,
              resolution_idempotency_key, resolution_digest
         FROM saas_unknown_outcome_reconciliation_cases
        WHERE tenant_id = $1 AND case_state = 'operator_required'
          AND EXISTS (
            SELECT 1 FROM saas_requests AS r
             WHERE r.tenant_id = saas_unknown_outcome_reconciliation_cases.tenant_id
               AND r.id = saas_unknown_outcome_reconciliation_cases.request_id
               AND r.execution_state = 'unknown' AND r.reconciliation_state = 'pending'
          )
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [tenantId, limit],
    );
    return result.rows.map(mapOperatorCase);
  }

  async getOperatorRequired(
    tenantIdInput: string,
    caseIdInput: string,
  ): Promise<UnknownOutcomeOperatorCaseDetail | null> {
    const tenantId = boundedText(tenantIdInput, 'tenantId', 255);
    const caseId = boundedText(caseIdInput, 'caseId', 255);
    const caseResult = await this.database.query<RecoveryCaseRow>(
      `SELECT c.id, c.tenant_id, c.project_id, c.request_id, c.supply_mode,
              c.case_state, c.scan_attempt_count, c.lease_token, c.last_error_code, c.created_at,
              c.resolution_idempotency_key, c.resolution_digest
         FROM saas_unknown_outcome_reconciliation_cases AS c
        WHERE c.tenant_id = $1 AND c.id = $2 AND c.case_state = 'operator_required'
          AND EXISTS (
            SELECT 1 FROM saas_requests AS r
             WHERE r.tenant_id = c.tenant_id AND r.id = c.request_id
               AND r.execution_state = 'unknown' AND r.reconciliation_state = 'pending'
          )`,
      [tenantId, caseId],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) return null;
    const summary = mapOperatorCase(caseRow);
    const [attemptResult, observationResult] = await Promise.all([
      this.database.query<{ readonly id: unknown; readonly dispatch_state: unknown }>(
        `SELECT id, dispatch_state
           FROM saas_attempts
          WHERE tenant_id = $1 AND request_id = $2
          ORDER BY ordinal ASC, id ASC`,
        [tenantId, summary.requestId],
      ),
      this.database.query<RecoveryObservationRow>(
        `SELECT id, observation_kind, observed_at, attempt_id, usage_event_id,
                supply_mode, execution_state, reconciliation_state, financial_status,
                request_state_version, dispatch_state, result_state, response_started,
                attempt_state_version, upstream_id, account_owner_kind, account_id,
                provider_id, product_id, resolved_model, attempt_unknown_reason,
                usage_event_digest, provider_status, provider_operation_id,
                provider_identity_digest, provider_usage, evidence_reference,
                operator_outcome, actor_user_id, reason, audit_event_id, support_ticket_ref
           FROM saas_unknown_outcome_reconciliation_observations
          WHERE tenant_id = $1 AND case_id = $2
          ORDER BY observed_at ASC, id ASC`,
        [tenantId, caseId],
      ),
    ]);
    const possibleAttemptIds = attemptResult.rows
      .filter((row) => databaseText(row.dispatch_state, 'attempt.dispatch_state') !== 'not_sent')
      .map((row) => databaseText(row.id, 'attempt.id'));
    return { summary, possibleAttemptIds, observations: observationResult.rows.map(mapObservation) };
  }

  async recordProviderObservation(input: UnknownOutcomeProviderEvidenceObservation): Promise<void> {
    const tenantId = boundedText(input.tenantId, 'tenantId', 255);
    const requestId = boundedText(input.requestId, 'requestId', 255);
    const attemptId = boundedText(input.attemptId, 'attemptId', 255);
    const allowedStatuses = new Set([
      'completed',
      'pending',
      'ambiguous',
      'provider_unavailable',
      'not_found',
      'invalid',
    ]);
    if (!allowedStatuses.has(input.status)) throw new TypeError('Invalid provider observation status');
    const evidenceReference =
      input.evidenceReference === null ? null : boundedText(input.evidenceReference, 'evidenceReference', 512);
    const providerOperationId =
      input.providerOperationId === null ? null : boundedText(input.providerOperationId, 'providerOperationId', 512);
    const providerIdentityDigest = input.providerIdentityDigest;
    if (providerIdentityDigest !== null && !/^[0-9a-f]{64}$/.test(providerIdentityDigest)) {
      throw new TypeError('Invalid provider identity digest');
    }
    const providerUsage = input.usage === null ? null : JSON.stringify(input.usage);
    if (providerUsage !== null && providerUsage.length > 2048)
      throw new TypeError('Provider usage observation is too large');
    await this.database.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO saas_unknown_outcome_reconciliation_observations
           (id, tenant_id, case_id, request_id, attempt_id, observation_kind,
            evidence_reference, provider_status, provider_operation_id,
            provider_identity_digest, provider_usage, observed_at)
         SELECT $1, c.tenant_id, c.id, c.request_id, a.id, 'provider_evidence',
                $5, $6, $7, $8, $9::jsonb, clock_timestamp()
           FROM saas_unknown_outcome_reconciliation_cases AS c
           JOIN saas_attempts AS a
             ON a.tenant_id = c.tenant_id AND a.request_id = c.request_id AND a.id = $4
          WHERE c.tenant_id = $2 AND c.request_id = $3`,
        [
          this.idFactory(),
          tenantId,
          requestId,
          attemptId,
          evidenceReference,
          input.status,
          providerOperationId,
          providerIdentityDigest,
          providerUsage,
        ],
      );
      if (inserted.rowCount !== 1) throw new Error('Provider observation does not match a durable case attempt');
    });
  }

  async resolveNonExecution(
    input: PreparedUnknownOutcomeResolution,
    revalidateAuthorization: UnknownOutcomeOperatorAuthorizationRecheck,
  ): Promise<UnknownOutcomeOperatorResolutionResult> {
    return this.database.transaction(async (tx) => {
      if (
        !(await revalidateAuthorization({
          executor: tx,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorSessionId: input.actorSessionId,
        }))
      ) {
        return { status: 'unauthorized' };
      }

      const caseIdentityResult = await tx.query<RecoveryCaseRow>(
        `SELECT id, tenant_id, project_id, request_id, supply_mode,
                case_state, scan_attempt_count, lease_token, last_error_code, created_at,
                resolution_idempotency_key, resolution_digest
           FROM saas_unknown_outcome_reconciliation_cases
          WHERE id = $1 AND tenant_id = $2`,
        [input.caseId, input.tenantId],
      );
      const caseIdentity = caseIdentityResult.rows[0];
      if (!caseIdentity) return { status: 'case_not_found' };
      const requestId = databaseText(caseIdentity.request_id, 'case.request_id');

      const requestResult = await tx.query<RecoveryRequestRow>(
        `SELECT id, tenant_id, project_id, supply_mode, execution_state,
                reconciliation_state, financial_status, state_version
           FROM saas_requests
          WHERE tenant_id = $1 AND id = $2
          FOR UPDATE`,
        [input.tenantId, requestId],
      );
      const request = requestResult.rows[0];
      if (!request) return { status: 'case_not_found' };
      const attemptsResult = await tx.query<RecoveryAttemptRow>(
        `SELECT id, dispatch_state, result_state, response_started, state_version, unknown_reason,
                upstream_id, account_owner_kind, account_id, provider_id, product_id, resolved_model
           FROM saas_attempts
          WHERE tenant_id = $1 AND request_id = $2
          ORDER BY ordinal ASC, id ASC
          FOR UPDATE`,
        [input.tenantId, requestId],
      );

      const currentCaseResult = await tx.query<RecoveryCaseRow>(
        `SELECT id, tenant_id, project_id, request_id, supply_mode,
                case_state, scan_attempt_count, lease_token, last_error_code, created_at,
                resolution_idempotency_key, resolution_digest
          FROM saas_unknown_outcome_reconciliation_cases
          WHERE id = $1 AND tenant_id = $2
        `,
        [input.caseId, input.tenantId],
      );
      const currentCase = currentCaseResult.rows[0];
      if (!currentCase) return { status: 'case_not_found' };
      assertCaseIdentity(currentCase, {
        caseId: input.caseId,
        tenantId: input.tenantId,
        projectId: databaseText(caseIdentity.project_id, 'case.project_id'),
        requestId,
        supplyMode: supplyMode(caseIdentity.supply_mode),
        leaseToken: '',
        scanAttempt: databaseInteger(caseIdentity.scan_attempt_count, 'case.scan_attempt_count', 0, MAX_SCAN_ATTEMPTS),
      });

      if (currentCase.case_state === 'resolved') {
        if (
          currentCase.resolution_idempotency_key === input.idempotencyKey &&
          currentCase.resolution_digest === input.resolutionDigest
        ) {
          return { status: 'replayed', caseId: input.caseId, requestId };
        }
        return { status: 'resolution_conflict' };
      }
      if (currentCase.case_state !== 'operator_required') return { status: 'resolution_conflict' };

      const currentExecution = rowState(request.execution_state);
      const currentReconciliation = databaseText(request.reconciliation_state, 'request.reconciliation_state');
      const mode = supplyMode(request.supply_mode);
      const currentFinancial = databaseText(request.financial_status, 'request.financial_status');
      if (currentExecution !== 'unknown' || currentReconciliation !== 'pending') {
        return { status: 'request_not_unknown' };
      }
      if (
        (mode === 'platform' && currentFinancial !== 'reconciliation_pending') ||
        (mode === 'byok' && currentFinancial !== 'not_applicable')
      ) {
        return { status: 'financial_state_conflict' };
      }

      const coverageError = operatorCoverageCheck(attemptsResult.rows, input.coverage);
      if (coverageError) return coverageError;

      const requestVersion = databaseInteger(request.state_version, 'request.state_version', 1);
      for (const row of attemptsResult.rows) {
        const attemptId = databaseText(row.id, 'attempt.id');
        if (!possibleAttempt(row)) continue;
        const dispatchState = databaseText(row.dispatch_state, 'attempt.dispatch_state');
        const resultState = databaseText(row.result_state, 'attempt.result_state');
        if (resultState === 'pending' || resultState === 'unknown') {
          await this.metering.transitionAttempt({
            executor: tx,
            tenantId: input.tenantId,
            requestId,
            attemptId,
            expectedDispatchState: dispatchState as 'dispatching' | 'sent' | 'unknown',
            expectedResultState: resultState as 'pending' | 'unknown',
            expectedResponseStarted: row.response_started === true,
            expectedStateVersion: databaseInteger(row.state_version, 'attempt.state_version', 1),
            dispatchState: dispatchState as 'dispatching' | 'sent' | 'unknown',
            resultState: 'failed',
            unknownReason:
              dispatchState === 'unknown' ? databaseText(row.unknown_reason, 'attempt.unknown_reason', 1024) : null,
          });
        }
      }

      const failedRequest = await this.metering.transitionRequest({
        executor: tx,
        tenantId: input.tenantId,
        requestId,
        expectedResultState: 'unknown',
        expectedReconciliationState: 'pending',
        expectedStateVersion: requestVersion,
        resultState: 'failed',
        reconciliationState: 'resolved',
      });

      const releaseEvidenceRef = `unknown-outcome-resolution:v1:${input.evidenceDigest}`;
      if (mode === 'platform') {
        const release = await this.billing.release(tx, {
          supplyMode: 'platform',
          tenantId: input.tenantId,
          requestId,
          releaseId: `unknown-outcome-release:v1:${input.resolutionDigest}`,
          releaseEvidenceRef,
          reconciliationEvidenceRef: releaseEvidenceRef,
          businessKey: `saas-request-admission:${input.tenantId}:${requestId}`,
          idempotencyNamespace: BILLING_RESERVATION_NAMESPACE,
        });
        if (release.state !== 'released') throw new Error('Platform hold did not release with operator evidence');
        await this.metering.transitionFinancialStatus({
          executor: tx,
          tenantId: input.tenantId,
          requestId,
          expectedFinancialStatus: 'reconciliation_pending',
          financialStatus: 'released',
          expectedStateVersion: failedRequest.stateVersion,
        });
      }

      const auditEventId = this.idFactory();
      await tx.query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id,
            occurred_at, entry_point, request_id)
         VALUES ($1, $2, $3, 'request.unknown_outcome.operator_not_executed',
                 'saas_unknown_outcome_reconciliation_case', $4, clock_timestamp(), $5, $6)`,
        [auditEventId, input.tenantId, input.actorUserId, input.caseId, OPERATOR_AUDIT_ENTRY_POINT, requestId],
      );
      for (const item of input.coverage) {
        const attemptRow = attemptsResult.rows.find((row) => row.id === item.attemptId);
        if (!attemptRow) return { status: 'unexpected_attempt_coverage', attemptIds: [item.attemptId] };
        await tx.query(
          `INSERT INTO saas_unknown_outcome_reconciliation_observations
             (id, tenant_id, case_id, request_id, attempt_id, observation_kind,
              request_state_version, dispatch_state, result_state, response_started,
              attempt_state_version, upstream_id, account_owner_kind, account_id,
              provider_id, product_id, resolved_model, attempt_unknown_reason,
              evidence_reference, operator_outcome, actor_user_id,
              reason, audit_event_id, support_ticket_ref, observed_at)
           VALUES ($1, $2, $3, $4, $5, 'operator_resolution', $6, $7, $8, $9,
                   $10, $11, $12, $13, $14, $15, $16, $17, 'not_executed',
                   $18, $19, $20, $21, $22, clock_timestamp())`,
          [
            this.idFactory(),
            input.tenantId,
            input.caseId,
            requestId,
            item.attemptId,
            requestVersion,
            databaseText(attemptRow.dispatch_state, 'attempt.dispatch_state'),
            databaseText(attemptRow.result_state, 'attempt.result_state'),
            attemptRow.response_started === true,
            databaseInteger(attemptRow.state_version, 'attempt.state_version', 1),
            databaseText(attemptRow.upstream_id, 'attempt.upstream_id'),
            databaseOptionalText(attemptRow.account_owner_kind, 'attempt.account_owner_kind'),
            databaseOptionalText(attemptRow.account_id, 'attempt.account_id'),
            databaseOptionalText(attemptRow.provider_id, 'attempt.provider_id'),
            databaseOptionalText(attemptRow.product_id, 'attempt.product_id'),
            databaseText(attemptRow.resolved_model, 'attempt.resolved_model'),
            databaseOptionalText(attemptRow.unknown_reason, 'attempt.unknown_reason', 1024),
            item.evidenceReference,
            input.actorUserId,
            input.reason,
            auditEventId,
            input.supportTicketRef,
          ],
        );
      }
      const updated = await tx.query(
        `UPDATE saas_unknown_outcome_reconciliation_cases
            SET case_state = 'resolved',
                next_attempt_at = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                resolution_idempotency_key = $3,
                resolution_digest = $4,
                resolution_actor_user_id = $5,
                resolution_reason = $6,
                resolution_evidence_digest = $7,
                resolution_audit_event_id = $8,
                resolution_support_ticket_ref = $9,
                resolved_at = clock_timestamp(),
                updated_at = clock_timestamp()
          WHERE id = $1 AND tenant_id = $2 AND case_state = 'operator_required'
          RETURNING id`,
        [
          input.caseId,
          input.tenantId,
          input.idempotencyKey,
          input.resolutionDigest,
          input.actorUserId,
          input.reason,
          input.evidenceDigest,
          auditEventId,
          input.supportTicketRef,
        ],
      );
      if (updated.rowCount !== 1) throw new Error('Concurrent unknown-outcome resolution changed the case');
      return { status: 'resolved', caseId: input.caseId, requestId };
    });
  }
}

export interface UnknownOutcomeRecoveryWorkflowOptions {
  readonly database: SaasDatabase;
  readonly metering: SaasMeteringService;
  /** Optional override for deterministic tests or a deployment-specific port. */
  readonly authorization?: UnknownOutcomeOperatorAuthorizationPort;
  readonly billing?: PlatformWalletLedgerService;
  readonly worker?: { readonly batchSize?: number; readonly leaseMs?: number; readonly maxAttempts?: number };
  readonly repository?: { readonly idFactory?: () => string };
}

/**
 * Wires the durable scanner, tenant-scoped operator workflow, and provider
 * observation sink to one repository. A real PostgreSQL authorization adapter
 * is used by default; deployments may inject a stricter wrapper when needed.
 */
export function createUnknownOutcomeRecoveryWorkflow(input: UnknownOutcomeRecoveryWorkflowOptions) {
  const repository = new PostgresUnknownOutcomeRecoveryRepository(input.database, input.metering, input.billing, {
    idFactory: input.repository?.idFactory,
  });
  const authorization = input.authorization ?? new PostgresUnknownOutcomeOperatorAuthorizationAdapter(input.database);
  return {
    repository,
    worker: new UnknownOutcomeReconciliationWorker(repository, input.worker),
    operatorResolution: new UnknownOutcomeOperatorResolutionService(authorization, repository),
    providerObservations: repository,
  };
}
