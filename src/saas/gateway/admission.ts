import { randomUUID } from 'node:crypto';
import type { MinorUnitInput } from '../billing/money.js';
import { MAX_MINOR_UNITS } from '../billing/money.js';
import type { BillingReservationResult, BillingTransactionExecutor, ReserveBillingInput } from '../billing/types.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type {
  AttemptRecord,
  AuthorizationBindingInput,
  CreateRequestInput,
  InitialAttemptInput,
  MeteringOperationOptions,
  RequestAdmission,
  RequestAdmissionCreated,
  RequestRecord,
} from '../metering/types.js';
import type {
  SaasRequestAdmissionAuthenticatedKey,
  SaasRequestAdmissionAuthorizationPrelock,
} from './authorization-prelock.js';

const REQUEST_ADMISSION_OUTBOX_EVENT_TYPE = 'request.admitted' as const;
const REQUEST_ADMISSION_OUTBOX_SCHEMA_VERSION = 1 as const;
const REQUEST_ADMISSION_AUDIT_ACTION = 'request.admitted' as const;
const REQUEST_ADMISSION_AUDIT_TARGET_TYPE = 'saas_request' as const;
const REQUEST_ADMISSION_AUDIT_ENTRY_POINT = 'gateway_admission' as const;

/** Admission cannot persist a request without the candidate selected for its first attempt. */
export type AdmissionCreateRequestInput = CreateRequestInput & {
  readonly initialAttempt: InitialAttemptInput;
};

interface AdmissionAuthorizationEvidenceCommand {
  readonly authenticatedKey: SaasRequestAdmissionAuthenticatedKey;
}

export interface ByokRequestAdmissionCommand extends AdmissionAuthorizationEvidenceCommand {
  readonly supplyMode: 'byok';
  readonly request: AdmissionCreateRequestInput;
}

/**
 * Exact, non-monetary usage evidence supplied to a platform admission guard.
 *
 * These counters are evidence only. They are not a price, currency, snapshot
 * reference, or wallet hold. The guard must prove from DB-backed pricing that
 * they are a conservative trusted upper bound before creating/resolving the
 * authoritative customer-price snapshot on the admission transaction.
 */
export interface PlatformRequestAdmissionHoldInput {
  readonly inputTotal: bigint | number | string;
  readonly inputUncached: bigint | number | string;
  readonly cacheRead: bigint | number | string;
  readonly cacheWrite: bigint | number | string;
  readonly cacheWrite5m: bigint | number | string;
  readonly cacheWrite1h: bigint | number | string;
  readonly outputTotal: bigint | number | string;
  readonly reasoningOutput: bigint | number | string;
}

/** Hold evidence plus the caller's requested admission window. */
export interface PlatformRequestAdmissionHoldEvidence extends PlatformRequestAdmissionHoldInput {
  readonly admissionExpiresAt: string | Date;
}

/**
 * Authoritative platform terms are an output of the DB-backed guard, never a
 * caller-supplied command field.
 */
export interface PlatformRequestAdmissionTerms {
  readonly currency: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly priceSnapshotRef: string;
  readonly expiresAt: string | Date;
}

/** Canonical platform command shape: only hold evidence crosses the boundary. */
export interface PlatformRequestAdmissionCommandWithTerms extends AdmissionAuthorizationEvidenceCommand {
  readonly supplyMode: 'platform';
  readonly request: AdmissionCreateRequestInput;
  readonly holdEvidence: PlatformRequestAdmissionHoldEvidence;
}

/**
 * Compatibility spelling for callers that use the older exported subtype
 * name. It still carries evidence only; it is not a caller reservation.
 */
export interface PlatformRequestAdmissionCommandWithReservation extends AdmissionAuthorizationEvidenceCommand {
  readonly supplyMode: 'platform';
  readonly request: AdmissionCreateRequestInput;
  readonly holdInput: PlatformRequestAdmissionHoldInput;
  readonly admissionExpiresAt: string | Date;
}

export type PlatformRequestAdmissionCommand =
  | PlatformRequestAdmissionCommandWithTerms
  | PlatformRequestAdmissionCommandWithReservation;

export type SaasRequestAdmissionCommand = ByokRequestAdmissionCommand | PlatformRequestAdmissionCommand;

export interface SaasRequestAdmissionServiceOptions {
  /** Used only for the metadata outbox event identifier. */
  readonly idFactory?: () => string;
  /** Used only for deterministic outbox timestamps. */
  readonly now?: () => Date;
}

export interface SaasMeteringAdmissionPort {
  admitRequest(input: CreateRequestInput, options?: MeteringOperationOptions): Promise<RequestAdmission>;
}

export interface SaasBillingReservationPort {
  reserve(executor: BillingTransactionExecutor, input: ReserveBillingInput): Promise<BillingReservationResult>;
}

/** The authoritative platform price and hold snapshot returned by the DB guard. */
export interface SaasRequestAdmissionPlatformPriceHoldFacts extends PlatformRequestAdmissionTerms {
  readonly customerPriceVersion: string;
  readonly supplierCostVersion: string;
}

/**
 * Facts supplied to the admission guard after metering has inserted the
 * request and initial attempt. The guard must use only this executor and
 * local/database state while the transaction is open; it must not perform
 * network I/O. It must validate the hold evidence as a conservative trusted
 * upper bound, then create or resolve pricing snapshots using these persisted
 * request/attempt identities on this same executor.
 */
export interface SaasRequestAdmissionGuardInput {
  readonly executor: SqlExecutor;
  readonly request: RequestRecord;
  readonly candidate: AttemptRecord;
  readonly holdEvidence: PlatformRequestAdmissionHoldEvidence | null;
}

/** Authoritative facts revalidated by a concrete DB-backed admission guard. */
export interface SaasRequestAdmissionGuardResult {
  readonly authorization: AuthorizationBindingInput;
  readonly candidate: InitialAttemptInput;
  readonly platformPriceHold: SaasRequestAdmissionPlatformPriceHoldFacts | null;
}

/**
 * Mandatory request-admission dependency. There is intentionally no default
 * implementation: production wiring must provide a concrete DB-only guard.
 */
export interface SaasRequestAdmissionGuard {
  revalidate(input: SaasRequestAdmissionGuardInput): Promise<SaasRequestAdmissionGuardResult>;
}

export interface RequestAdmissionOutboxPayload {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly request_id: string;
  readonly attempt_id: string;
  readonly supply_mode: 'byok' | 'platform';
  readonly schema_version: typeof REQUEST_ADMISSION_OUTBOX_SCHEMA_VERSION;
}

export interface RequestAdmissionOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly eventKey: string;
  readonly eventType: typeof REQUEST_ADMISSION_OUTBOX_EVENT_TYPE;
  readonly schemaVersion: typeof REQUEST_ADMISSION_OUTBOX_SCHEMA_VERSION;
  readonly supplyMode: 'byok' | 'platform';
  readonly payload: RequestAdmissionOutboxPayload;
  readonly deliveryState: 'pending';
  readonly createdAt: string;
}

export type SaasRequestAdmissionCreated = RequestAdmissionCreated & {
  readonly reservation: BillingReservationResult | null;
  readonly outboxEvent: RequestAdmissionOutboxEvent;
};

export type SaasRequestAdmissionReplayed = Extract<RequestAdmission, { kind: 'replayed' }> & {
  readonly reservation: null;
  readonly outboxEvent: null;
};

export type SaasRequestAdmissionTombstone = Extract<RequestAdmission, { kind: 'tombstone' }> & {
  readonly reservation: null;
  readonly outboxEvent: null;
};

export type SaasRequestAdmissionResult =
  | SaasRequestAdmissionCreated
  | SaasRequestAdmissionReplayed
  | SaasRequestAdmissionTombstone;

type NormalizedCommand =
  | {
      readonly supplyMode: 'byok';
      readonly request: AdmissionCreateRequestInput;
      readonly authenticatedKey: SaasRequestAdmissionAuthenticatedKey;
    }
  | {
      readonly supplyMode: 'platform';
      readonly request: AdmissionCreateRequestInput;
      readonly holdEvidence: PlatformRequestAdmissionHoldEvidence;
      readonly authenticatedKey: SaasRequestAdmissionAuthenticatedKey;
    };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireAdmissionRequest(value: unknown): AdmissionCreateRequestInput {
  const request = requireRecord(value, 'request') as unknown as CreateRequestInput;
  if (
    typeof request.initialAttempt !== 'object' ||
    request.initialAttempt === null ||
    Array.isArray(request.initialAttempt)
  ) {
    throw new TypeError('request.initialAttempt is required for admission');
  }
  return request as AdmissionCreateRequestInput;
}

function requireAdmissionAuthenticatedKey(value: unknown): SaasRequestAdmissionAuthenticatedKey {
  const authenticatedKey = requireRecord(value, 'authenticatedKey');
  const authorization = requireRecord(authenticatedKey.authorization, 'authenticatedKey.authorization');
  if (!Array.isArray(authorization.modelScopes)) {
    throw new TypeError('authenticatedKey.authorization.modelScopes is required');
  }
  return {
    authorization: {
      ...authorization,
      modelScopes: [...authorization.modelScopes],
    } as unknown as SaasRequestAdmissionAuthenticatedKey['authorization'],
  };
}

const HOLD_INPUT_KEYS = [
  'inputTotal',
  'inputUncached',
  'cacheRead',
  'cacheWrite',
  'cacheWrite5m',
  'cacheWrite1h',
  'outputTotal',
  'reasoningOutput',
] as const;

type HoldInputKey = (typeof HOLD_INPUT_KEYS)[number];

function normalizeHoldCounter(value: unknown, label: string): bigint | number | string {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be a non-negative exact integer`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative exact integer`);
    }
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) return value.trim();
  throw new TypeError(`${label} must be a non-negative exact integer`);
}

function normalizeAdmissionExpiry(value: unknown, label: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid expiry`);
  return date.toISOString();
}

function requireHoldInput(value: unknown, label: string): PlatformRequestAdmissionHoldInput {
  const holdInput = requireRecord(value, label);
  const allowed = new Set<string>(HOLD_INPUT_KEYS);
  for (const key of HOLD_INPUT_KEYS) {
    if (!(key in holdInput)) throw new TypeError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(holdInput)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not accepted`);
  }
  const normalized = {} as Record<HoldInputKey, bigint | number | string>;
  for (const key of HOLD_INPUT_KEYS) normalized[key] = normalizeHoldCounter(holdInput[key], `${label}.${key}`);
  return normalized;
}

function requireHoldEvidence(value: unknown, label: string): PlatformRequestAdmissionHoldEvidence {
  const evidence = requireRecord(value, label);
  const allowed = new Set<string>([...HOLD_INPUT_KEYS, 'admissionExpiresAt']);
  for (const key of HOLD_INPUT_KEYS) {
    if (!(key in evidence)) throw new TypeError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(evidence)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not accepted`);
  }
  const holdInput = requireHoldInput(Object.fromEntries(HOLD_INPUT_KEYS.map((key) => [key, evidence[key]])), label);
  return {
    ...holdInput,
    admissionExpiresAt: normalizeAdmissionExpiry(evidence.admissionExpiresAt, `${label}.admissionExpiresAt`),
  };
}

function normalizeCommand(command: SaasRequestAdmissionCommand): NormalizedCommand {
  const record = requireRecord(command, 'admission command');
  const supplyMode = record.supplyMode;
  const request = requireAdmissionRequest(record.request);
  const authenticatedKey = requireAdmissionAuthenticatedKey(record.authenticatedKey);

  if (supplyMode === 'byok') {
    if (request.supplyMode !== 'byok') throw new TypeError('BYOK admission requires a BYOK request');
    return { supplyMode, request, authenticatedKey };
  }

  if (supplyMode !== 'platform') throw new TypeError('admission command supplyMode is invalid');
  if (request.supplyMode !== 'platform') throw new TypeError('platform admission requires a platform request');
  if ('holdEvidence' in record) {
    return {
      supplyMode,
      request,
      authenticatedKey,
      holdEvidence: requireHoldEvidence(record.holdEvidence, 'platform holdEvidence'),
    };
  }
  return {
    supplyMode,
    request,
    authenticatedKey,
    holdEvidence: {
      ...requireHoldInput(record.holdInput, 'platform holdInput'),
      admissionExpiresAt: normalizeAdmissionExpiry(record.admissionExpiresAt, 'platform admissionExpiresAt'),
    },
  };
}

function requireFactoryValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must return non-empty text`);
  return value;
}

function normalizeNow(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('now must return a valid Date');
  }
  return value.toISOString();
}

function canonicalExactInteger(value: unknown, label: string): string {
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) return BigInt(normalized).toString(10);
  }
  throw new Error(`SaaS request admission guard returned an invalid ${label}`);
}

function canonicalPositiveMinorUnits(value: unknown, label: string): MinorUnitInput {
  if (typeof value === 'bigint' && value > 0n && value <= MAX_MINOR_UNITS) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) {
    const normalized = BigInt(value.trim());
    if (normalized > 0n && normalized <= MAX_MINOR_UNITS) return normalized.toString(10);
  }
  throw new Error(`SaaS request admission ${label} must be a positive exact integer`);
}

function canonicalExpiry(value: unknown, label: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    throw new Error(`SaaS request admission ${label} must be a valid expiry`);
  }
  return date.toISOString();
}

function assertTextMatch(label: string, expected: unknown, actual: unknown): void {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected !== actual) {
    throw new Error(`SaaS request admission guard mismatch: ${label}`);
  }
}

function assertIntegerMatch(label: string, expected: unknown, actual: unknown): void {
  if (canonicalExactInteger(expected, label) !== canonicalExactInteger(actual, label)) {
    throw new Error(`SaaS request admission guard mismatch: ${label}`);
  }
}

function assertOptionalTextMatch(label: string, expected: unknown, actual: unknown): void {
  const expectedText = expected === undefined || expected === null ? null : expected;
  const actualText = actual === undefined || actual === null ? null : actual;
  if (expectedText === null || actualText === null) {
    if (expectedText !== actualText) throw new Error(`SaaS request admission guard mismatch: ${label}`);
    return;
  }
  assertTextMatch(label, expectedText, actualText);
}

function assertOptionalIntegerMatch(label: string, expected: unknown, actual: unknown): void {
  const expectedValue = expected === undefined || expected === null ? null : expected;
  const actualValue = actual === undefined || actual === null ? null : actual;
  if (expectedValue === null || actualValue === null) {
    if (expectedValue !== actualValue) throw new Error(`SaaS request admission guard mismatch: ${label}`);
    return;
  }
  assertIntegerMatch(label, expectedValue, actualValue);
}

function assertAuthorizationMatch(supplied: AuthorizationBindingInput, authoritative: AuthorizationBindingInput): void {
  assertTextMatch('authorization.tenantId', supplied.tenantId, authoritative.tenantId);
  assertTextMatch('authorization.projectId', supplied.projectId, authoritative.projectId);
  assertIntegerMatch(
    'authorization.projectPolicyVersion',
    supplied.projectPolicyVersion,
    authoritative.projectPolicyVersion,
  );
  assertTextMatch('authorization.proxyKeyId', supplied.proxyKeyId, authoritative.proxyKeyId);
  assertTextMatch('authorization.entitlementId', supplied.entitlementId, authoritative.entitlementId);
  assertTextMatch('authorization.supplyProfileId', supplied.supplyProfileId, authoritative.supplyProfileId);
  assertIntegerMatch(
    'authorization.supplyProfileVersion',
    supplied.supplyProfileVersion,
    authoritative.supplyProfileVersion,
  );
  assertIntegerMatch('authorization.modelScopeVersion', supplied.modelScopeVersion, authoritative.modelScopeVersion);
  assertTextMatch('authorization.supplyMode', supplied.supplyMode, authoritative.supplyMode);
  assertTextMatch('authorization.principalKind', supplied.principalKind, authoritative.principalKind);
  assertTextMatch('authorization.principalId', supplied.principalId, authoritative.principalId);
  assertIntegerMatch('authorization.authzVersion', supplied.authzVersion, authoritative.authzVersion);
  assertIntegerMatch('authorization.entitlementVersion', supplied.entitlementVersion, authoritative.entitlementVersion);
  assertIntegerMatch('authorization.configVersion', supplied.configVersion, authoritative.configVersion);
}

interface AdmissionCandidateFacts {
  readonly ordinal: unknown;
  readonly upstreamId: unknown;
  readonly accountOwnerKind?: unknown;
  readonly accountId?: unknown;
  readonly providerId?: unknown;
  readonly productId?: unknown;
  readonly resolvedModel: unknown;
  readonly protocol: unknown;
  readonly endpoint?: unknown;
  readonly supplierCostVersion?: unknown;
  readonly dispatchProfileId: unknown;
  readonly supplyProfileAuthzVersion: unknown;
  readonly credentialId: unknown;
  readonly credentialVersion: unknown;
  readonly credentialAuthzVersion: unknown;
  readonly accountAuthzVersion: unknown;
  readonly poolId?: unknown;
  readonly poolAuthzVersion?: unknown;
  readonly poolMemberAccountAuthzVersion?: unknown;
  readonly poolGrantAuthzVersion?: unknown;
  readonly poolGrantProfileAuthzVersion?: unknown;
  readonly poolGrantPoolAuthzVersion?: unknown;
  readonly profileAccountAuthzVersion?: unknown;
}

function assertCandidateMatch(supplied: AdmissionCandidateFacts, authoritative: AdmissionCandidateFacts): void {
  assertIntegerMatch('candidate.ordinal', supplied.ordinal, authoritative.ordinal);
  assertTextMatch('candidate.upstreamId', supplied.upstreamId, authoritative.upstreamId);
  assertTextMatch('candidate.accountOwnerKind', supplied.accountOwnerKind, authoritative.accountOwnerKind);
  assertTextMatch('candidate.accountId', supplied.accountId, authoritative.accountId);
  assertTextMatch('candidate.providerId', supplied.providerId, authoritative.providerId);
  assertTextMatch('candidate.productId', supplied.productId, authoritative.productId);
  assertTextMatch('candidate.resolvedModel', supplied.resolvedModel, authoritative.resolvedModel);
  assertTextMatch('candidate.protocol', supplied.protocol, authoritative.protocol);
  assertTextMatch('candidate.endpoint', supplied.endpoint, authoritative.endpoint);
  assertTextMatch('candidate.dispatchProfileId', supplied.dispatchProfileId, authoritative.dispatchProfileId);
  assertIntegerMatch(
    'candidate.supplyProfileAuthzVersion',
    supplied.supplyProfileAuthzVersion,
    authoritative.supplyProfileAuthzVersion,
  );
  assertTextMatch('candidate.credentialId', supplied.credentialId, authoritative.credentialId);
  assertIntegerMatch('candidate.credentialVersion', supplied.credentialVersion, authoritative.credentialVersion);
  assertIntegerMatch(
    'candidate.credentialAuthzVersion',
    supplied.credentialAuthzVersion,
    authoritative.credentialAuthzVersion,
  );
  assertIntegerMatch('candidate.accountAuthzVersion', supplied.accountAuthzVersion, authoritative.accountAuthzVersion);
  assertOptionalTextMatch('candidate.poolId', supplied.poolId, authoritative.poolId);
  assertOptionalIntegerMatch('candidate.poolAuthzVersion', supplied.poolAuthzVersion, authoritative.poolAuthzVersion);
  assertOptionalIntegerMatch(
    'candidate.poolMemberAccountAuthzVersion',
    supplied.poolMemberAccountAuthzVersion,
    authoritative.poolMemberAccountAuthzVersion,
  );
  assertOptionalIntegerMatch(
    'candidate.poolGrantAuthzVersion',
    supplied.poolGrantAuthzVersion,
    authoritative.poolGrantAuthzVersion,
  );
  assertOptionalIntegerMatch(
    'candidate.poolGrantProfileAuthzVersion',
    supplied.poolGrantProfileAuthzVersion,
    authoritative.poolGrantProfileAuthzVersion,
  );
  assertOptionalIntegerMatch(
    'candidate.poolGrantPoolAuthzVersion',
    supplied.poolGrantPoolAuthzVersion,
    authoritative.poolGrantPoolAuthzVersion,
  );
  assertOptionalIntegerMatch(
    'candidate.profileAccountAuthzVersion',
    supplied.profileAccountAuthzVersion,
    authoritative.profileAccountAuthzVersion,
  );
  assertOptionalTextMatch(
    'candidate.supplierCostVersion',
    supplied.supplierCostVersion,
    authoritative.supplierCostVersion,
  );
}

function requireNonEmptySnapshotText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.trim().length > 255 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`SaaS request admission ${label} is required`);
  }
  return value.trim();
}

function requirePlatformCurrency(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new Error(`SaaS request admission ${label} must be a three-letter currency code`);
  }
  return value;
}

function normalizePlatformPriceHold(value: unknown): SaasRequestAdmissionPlatformPriceHoldFacts {
  const hold = requireRecord(value, 'guard platform price and hold');
  return {
    currency: requirePlatformCurrency(hold.currency, 'guard platform price and hold currency'),
    amountMinorUnits: canonicalPositiveMinorUnits(
      hold.amountMinorUnits,
      'guard platform price and hold amountMinorUnits',
    ),
    priceSnapshotRef: requireNonEmptySnapshotText(
      hold.priceSnapshotRef,
      'guard platform price and hold priceSnapshotRef',
    ),
    expiresAt: canonicalExpiry(hold.expiresAt, 'guard platform price and hold expiresAt'),
    customerPriceVersion: requireNonEmptySnapshotText(hold.customerPriceVersion, 'guard platform customerPriceVersion'),
    supplierCostVersion: requireNonEmptySnapshotText(hold.supplierCostVersion, 'guard platform supplierCostVersion'),
  };
}

function snapshotRequest(request: AdmissionCreateRequestInput): AdmissionCreateRequestInput {
  return {
    ...request,
    initialAttempt: { ...request.initialAttempt },
  };
}

function cloneHoldEvidence(evidence: PlatformRequestAdmissionHoldEvidence): PlatformRequestAdmissionHoldEvidence {
  return {
    ...evidence,
    admissionExpiresAt:
      evidence.admissionExpiresAt instanceof Date
        ? new Date(evidence.admissionExpiresAt.getTime())
        : evidence.admissionExpiresAt,
  };
}

function validateGuardResult(
  value: unknown,
  request: AdmissionCreateRequestInput,
  candidate: InitialAttemptInput,
  persistedRequest: RequestRecord,
  persistedCandidate: AttemptRecord,
  supplyMode: 'byok' | 'platform',
): SaasRequestAdmissionPlatformPriceHoldFacts | null {
  const result = requireRecord(value, 'SaaS request admission guard result');
  const authorization = requireRecord(
    result.authorization,
    'guard authorization',
  ) as unknown as AuthorizationBindingInput;
  const authoritativeCandidate = requireRecord(result.candidate, 'guard candidate') as unknown as InitialAttemptInput;
  assertAuthorizationMatch(request, authorization);
  assertAuthorizationMatch(persistedRequest, authorization);
  assertCandidateMatch(candidate, authoritativeCandidate);
  assertCandidateMatch(persistedCandidate, authoritativeCandidate);

  if (!('platformPriceHold' in result)) {
    throw new Error('SaaS request admission guard result must include platformPriceHold');
  }

  if (supplyMode === 'byok') {
    if (request.customerPriceVersion !== undefined && request.customerPriceVersion !== null) {
      throw new Error('BYOK admission cannot carry a customer price version');
    }
    if (persistedRequest.customerPriceVersion !== null) {
      throw new Error('BYOK admission cannot carry a persisted customer price version');
    }
    if (candidate.supplierCostVersion !== undefined && candidate.supplierCostVersion !== null) {
      throw new Error('BYOK admission cannot carry a supplier cost version');
    }
    if (persistedCandidate.supplierCostVersion !== null) {
      throw new Error('BYOK admission cannot carry a persisted supplier cost version');
    }
    if (result.platformPriceHold !== null) {
      throw new Error('BYOK admission cannot carry a platform price or hold reservation');
    }
    return null;
  }

  const customerPriceVersion = requireNonEmptySnapshotText(
    request.customerPriceVersion,
    'platform customerPriceVersion',
  );
  const persistedCustomerPriceVersion = requireNonEmptySnapshotText(
    persistedRequest.customerPriceVersion,
    'persisted platform customerPriceVersion',
  );
  assertTextMatch('request.customerPriceVersion', customerPriceVersion, persistedCustomerPriceVersion);
  const supplierCostVersion = requireNonEmptySnapshotText(
    candidate.supplierCostVersion,
    'platform supplierCostVersion',
  );
  const persistedSupplierCostVersion = requireNonEmptySnapshotText(
    persistedCandidate.supplierCostVersion,
    'persisted platform supplierCostVersion',
  );
  assertTextMatch('candidate.supplierCostVersion', supplierCostVersion, persistedSupplierCostVersion);
  if (result.platformPriceHold === null || result.platformPriceHold === undefined) {
    throw new Error('SaaS request admission guard must return platform price and hold facts');
  }
  const authoritativeHold = normalizePlatformPriceHold(result.platformPriceHold);
  assertTextMatch(
    'platformPriceHold.customerPriceVersion',
    customerPriceVersion,
    authoritativeHold.customerPriceVersion,
  );
  assertTextMatch('platformPriceHold.supplierCostVersion', supplierCostVersion, authoritativeHold.supplierCostVersion);
  return authoritativeHold;
}

/** The platform hold is idempotent within the tenant and logical request scope. */
export function createRequestAdmissionReservationBusinessKey(tenantId: string, requestId: string): string {
  const businessKey = `saas-request-admission:${tenantId}:${requestId}`;
  if (businessKey.length > 512) throw new TypeError('request admission reservation business key is too long');
  return businessKey;
}

export function createRequestAdmissionEventKey(tenantId: string, requestId: string): string {
  const eventKey = `${REQUEST_ADMISSION_OUTBOX_EVENT_TYPE}:${tenantId}:${requestId}`;
  if (eventKey.length > 512) throw new TypeError('request admission outbox event key is too long');
  return eventKey;
}

/**
 * Composes request admission, an optional platform hold, and bookkeeping in
 * one database transaction.  The outbox is metadata-only and is not a
 * dispatch queue: the live caller remains responsible for post-commit I/O.
 */
export class SaasRequestAdmissionService {
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: SaasDatabase,
    private readonly metering: SaasMeteringAdmissionPort,
    private readonly billing: SaasBillingReservationPort,
    private readonly guard: SaasRequestAdmissionGuard,
    private readonly authorizationPrelock: SaasRequestAdmissionAuthorizationPrelock,
    options: SaasRequestAdmissionServiceOptions = {},
  ) {
    if (!guard || typeof guard.revalidate !== 'function') {
      throw new TypeError('SaasRequestAdmissionGuard is required');
    }
    if (!authorizationPrelock || typeof authorizationPrelock.prelock !== 'function') {
      throw new TypeError('SaasRequestAdmissionAuthorizationPrelock is required');
    }
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async admit(
    command: SaasRequestAdmissionCommand,
    options: MeteringOperationOptions = {},
  ): Promise<SaasRequestAdmissionResult> {
    const normalized = normalizeCommand(command);
    const requestSnapshot = snapshotRequest(normalized.request);
    const candidateSnapshot = requestSnapshot.initialAttempt;
    const holdEvidenceSnapshot =
      normalized.supplyMode === 'platform' ? cloneHoldEvidence(normalized.holdEvidence) : null;

    const work = async (tx: SqlExecutor): Promise<SaasRequestAdmissionResult> => {
      // Establish tenant/project/principal/key authority locks before metering
      // takes the request/idempotency/attempt locks. This also authorizes
      // replay visibility before the replay branch can return.
      await this.authorizationPrelock.prelock({
        executor: tx,
        request: requestSnapshot,
        authenticatedKey: normalized.authenticatedKey,
      });

      const admission = await this.metering.admitRequest(requestSnapshot, { executor: tx });
      if (admission.kind === 'replayed') {
        return { ...admission, reservation: null, outboxEvent: null };
      }
      if (admission.kind === 'tombstone') {
        return { ...admission, reservation: null, outboxEvent: null };
      }

      const initialAttempt = admission.initialAttempt;
      if (!initialAttempt) {
        throw new Error('Metering admission did not return the required initial attempt');
      }

      const platformPriceHold = validateGuardResult(
        await this.guard.revalidate({
          executor: tx,
          request: admission.request,
          candidate: initialAttempt,
          holdEvidence: holdEvidenceSnapshot,
        }),
        requestSnapshot,
        candidateSnapshot,
        admission.request,
        initialAttempt,
        normalized.supplyMode,
      );

      let reservation: BillingReservationResult | null = null;
      if (normalized.supplyMode === 'platform') {
        if (!platformPriceHold) {
          throw new Error('SaaS request admission guard did not authorize platform price and hold facts');
        }
        const businessKey = createRequestAdmissionReservationBusinessKey(
          admission.request.tenantId,
          admission.request.id,
        );
        reservation = await this.billing.reserve(tx, {
          supplyMode: 'platform',
          tenantId: admission.request.tenantId,
          requestId: admission.request.id,
          currency: platformPriceHold.currency,
          amountMinorUnits: platformPriceHold.amountMinorUnits,
          priceSnapshotRef: platformPriceHold.priceSnapshotRef,
          expiresAt: platformPriceHold.expiresAt,
          businessKey,
        });
      }

      const outboxEvent = await this.enqueueAdmissionEvent(tx, admission, normalized.supplyMode, initialAttempt);
      await this.appendAdmissionAuditEvent(tx, admission, outboxEvent.createdAt);
      return { ...admission, reservation, outboxEvent };
    };
    return options.executor ? work(options.executor) : this.database.transaction(work);
  }

  private async appendAdmissionAuditEvent(
    tx: SqlExecutor,
    admission: RequestAdmissionCreated,
    occurredAt: string,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point, request_id)
       VALUES ($1, $2, $3, '${REQUEST_ADMISSION_AUDIT_ACTION}', '${REQUEST_ADMISSION_AUDIT_TARGET_TYPE}', $4, $5,
               '${REQUEST_ADMISSION_AUDIT_ENTRY_POINT}', $4)`,
      [
        randomUUID(),
        admission.request.tenantId,
        admission.request.principalKind === 'member' ? admission.request.principalId : null,
        admission.request.id,
        occurredAt,
      ],
    );
  }

  private async enqueueAdmissionEvent(
    tx: SqlExecutor,
    admission: RequestAdmissionCreated,
    supplyMode: 'byok' | 'platform',
    initialAttempt: NonNullable<RequestAdmissionCreated['initialAttempt']>,
  ): Promise<RequestAdmissionOutboxEvent> {
    const id = requireFactoryValue(this.idFactory(), 'idFactory');
    const createdAt = normalizeNow(this.now());
    const eventKey = createRequestAdmissionEventKey(admission.request.tenantId, admission.request.id);
    const payload: RequestAdmissionOutboxPayload = {
      tenant_id: admission.request.tenantId,
      project_id: admission.request.projectId,
      request_id: admission.request.id,
      attempt_id: initialAttempt.id,
      supply_mode: supplyMode,
      schema_version: REQUEST_ADMISSION_OUTBOX_SCHEMA_VERSION,
    };

    await tx.query(
      `INSERT INTO saas_request_admission_outbox
         (id, tenant_id, project_id, request_id, attempt_id, supply_mode, event_key,
          event_type, schema_version, payload, delivery_state, delivery_attempts,
          available_at, lease_token, lease_expires_at, last_error_code, delivered_at,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '${REQUEST_ADMISSION_OUTBOX_EVENT_TYPE}', $8, $9::jsonb,
               'pending', 0, $10, NULL, NULL, NULL, NULL, $10, $10)`,
      [
        id,
        admission.request.tenantId,
        admission.request.projectId,
        admission.request.id,
        initialAttempt.id,
        supplyMode,
        eventKey,
        REQUEST_ADMISSION_OUTBOX_SCHEMA_VERSION,
        JSON.stringify(payload),
        createdAt,
      ],
    );

    return {
      id,
      tenantId: admission.request.tenantId,
      projectId: admission.request.projectId,
      requestId: admission.request.id,
      attemptId: initialAttempt.id,
      eventKey,
      eventType: REQUEST_ADMISSION_OUTBOX_EVENT_TYPE,
      schemaVersion: REQUEST_ADMISSION_OUTBOX_SCHEMA_VERSION,
      supplyMode,
      payload,
      deliveryState: 'pending',
      createdAt,
    };
  }
}
