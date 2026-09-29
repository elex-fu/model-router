import { randomUUID } from 'node:crypto';
import { PlatformWalletLedgerService } from '../billing/service.js';
import type { SqlExecutor } from '../db/types.js';
import type { ModelResolutionProvenance } from '../gateway/contracts.js';
import {
  canonicalUsage,
  digestClientKey,
  type HmacSecret,
  normalizeFingerprint,
  settlementDigest,
  usageEventDigest,
} from './digest.js';
import { SaasMeteringError, type SaasMeteringErrorCode } from './errors.js';
import type {
  AttemptRecord,
  AttemptResultState,
  AttemptTransitionInput,
  AuthorizationBindingInput,
  CommercialMeteringAuthoritySnapshotInput,
  CreateAttemptInput,
  CreateIdempotencyTombstoneInput,
  CreateRequestInput,
  DispatchAuthorityState,
  DispatchState,
  ExactIntegerInput,
  ExactTokenCount,
  FinancialStatus,
  FinancialTransitionInput,
  IdempotencyRecord,
  InitialAttemptInput,
  MeteringDatabase,
  MeteringOperationOptions,
  MeteringRouteTargetMode,
  NormalizedUsageExact,
  PrincipalKind,
  ReconciliationState,
  RecordUsageEventInput,
  RecordUsageSettlementInput,
  RequestAdmission,
  RequestListOptions,
  RequestRecord,
  RequestTransitionInput,
  RouteAuthoritySnapshotInput,
  UsageEventRecord,
  UsageSettlementRecord,
  UsageValues,
} from './types.js';

type Row = Record<string, unknown>;

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const BILLING_RESERVATION_NAMESPACE = 'saas.billing.reservation';
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const PROTOCOLS = new Set(['anthropic', 'openai', 'gemini', 'responses']);
const SUPPLY_MODES = new Set(['byok', 'platform']);
const ACCOUNT_OWNER_KINDS = new Set(['tenant', 'platform']);
const PRINCIPAL_KINDS = new Set(['member', 'project_service']);
const DISPATCH_STATES = new Set<DispatchState>(['not_sent', 'dispatching', 'sent', 'unknown']);
const RESULT_STATES = new Set<AttemptResultState>(['pending', 'succeeded', 'failed', 'unknown']);
const RECONCILIATION_STATES = new Set<ReconciliationState>(['none', 'pending', 'resolved']);
const FINANCIAL_STATUSES = new Set<FinancialStatus>([
  'not_applicable',
  'pending',
  'settled',
  'released',
  'reconciliation_pending',
]);

interface MeteringServiceOptions {
  readonly now?: () => Date;
  readonly idempotencyHmacSecret?: HmacSecret;
  readonly knownResponseBilling?: Pick<PlatformWalletLedgerService, 'markReconciliationPending'>;
}

export interface KnownNonSuccessHttpResponseInput {
  readonly tenantId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly resultHttpStatus: number;
  readonly responseStarted: boolean;
}

interface KnownHttpResponseStateRow extends Row {
  readonly attempt_id: unknown;
  readonly attempt_tenant_id: unknown;
  readonly attempt_request_id: unknown;
  readonly attempt_dispatch_state: unknown;
  readonly attempt_result_state: unknown;
  readonly attempt_result_http_status: unknown;
  readonly attempt_response_started: unknown;
  readonly attempt_state_version: unknown;
  readonly request_id: unknown;
  readonly request_tenant_id: unknown;
  readonly request_supply_mode: unknown;
  readonly request_result_state: unknown;
  readonly request_reconciliation_state: unknown;
  readonly request_financial_status: unknown;
  readonly request_state_version: unknown;
}

/**
 * Identity issued by the hosted request-preparation orchestrator.
 *
 * These values are facts, not hints: prepared admission must persist them
 * verbatim and must never mint replacement request/attempt identities.
 */
export interface PreparedRequestIdentity {
  readonly requestId: string;
  readonly attemptId: string;
}

export type PreparedRequestAdmissionInput = CreateRequestInput & PreparedRequestIdentity;

/**
 * A prepared replay may be unkeyed.  The existing RequestAdmission union
 * requires an IdempotencyRecord for its replay branch, so this service-local
 * result keeps the durable request/attempt identity without fabricating an
 * idempotency row that does not exist.
 */
export interface PreparedRequestAdmissionReplay {
  readonly kind: 'replayed';
  readonly request: RequestRecord;
  readonly idempotency: IdempotencyRecord | null;
  readonly initialAttempt: AttemptRecord;
}

export type PreparedRequestAdmission = RequestAdmission | PreparedRequestAdmissionReplay;

interface NormalizedAuthorizationBinding {
  readonly tenantId: string;
  readonly projectId: string;
  readonly proxyKeyId: string;
  readonly entitlementId: string;
  readonly supplyProfileId: string;
  readonly supplyProfileVersion: string;
  readonly modelScopeVersion: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly principalKind: PrincipalKind;
  readonly principalId: string;
  readonly authzVersion: string;
  readonly entitlementVersion: string;
  readonly configVersion: string;
  readonly projectPolicyVersion: string;
}

interface NormalizedCommercialMeteringAuthority {
  readonly customerMeteringPolicyId: string;
  readonly customerMeteringPolicyVersion: string;
  readonly providerMeteringPolicyId: string;
  readonly providerMeteringPolicyVersion: string;
  readonly contractAttestationId: string;
}

interface NormalizedRouteAuthority {
  readonly routeConfigId: string;
  readonly routeConfigVersion: string;
  readonly routePublicModelId: string;
  readonly routePublicModelVersion: string;
  readonly routeProtocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly routeTargetMode: MeteringRouteTargetMode;
  readonly routeUpstreamId: string | null;
}

interface NormalizedRequestInput
  extends NormalizedAuthorizationBinding,
    NormalizedRouteAuthority,
    NormalizedCommercialMeteringAuthority {
  readonly publicModel: string;
  readonly protocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly endpoint: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly idempotencyKeyDigest: string | null;
  readonly customerPriceVersion: string | null;
  readonly initialAttempt: InitialAttemptInput | null;
}

interface NormalizedAttemptInput extends NormalizedCommercialMeteringAuthority {
  readonly tenantId: string;
  readonly requestId: string;
  readonly ordinal: number;
  readonly upstreamId: string;
  readonly accountOwnerKind: 'tenant' | 'platform';
  readonly accountId: string;
  readonly providerId: string;
  readonly productId: string;
  readonly resolvedModel: string;
  readonly protocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly endpoint: string;
  readonly supplierCostVersion: string | null;
  readonly customerPriceVersion: string | null;
  readonly dispatchProfileId: string;
  readonly supplyProfileAuthzVersion: string;
  readonly credentialId: string;
  readonly credentialVersion: string;
  readonly credentialAuthzVersion: string;
  readonly accountAuthzVersion: string;
  readonly projectPolicyVersion: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: string;
  readonly routePublicModelId: string;
  readonly routePublicModelVersion: string;
  readonly routeProtocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly routeTargetMode: MeteringRouteTargetMode;
  readonly poolId: string | null;
  readonly poolAuthzVersion: string | null;
  readonly poolMemberAccountAuthzVersion: string | null;
  readonly poolMemberAuthzVersion: string | null;
  readonly poolGrantAuthzVersion: string | null;
  readonly poolGrantProfileAuthzVersion: string | null;
  readonly poolGrantPoolAuthzVersion: string | null;
  readonly profileAccountAuthzVersion: string | null;
  readonly modelResolution: ModelResolutionProvenance;
  readonly clientProtocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly providerProtocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly clientOperation: string;
  readonly providerOperation: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly payloadSha256: string;
}

interface Attempt029ProvenanceInput {
  readonly requestFingerprint?: unknown;
  readonly requestFingerprintVersion?: unknown;
  readonly payloadCompilerVersion?: unknown;
  readonly usageEstimatorVersion?: unknown;
  readonly payloadSha256?: unknown;
}

type RuntimeAttemptInput = CreateAttemptInput & Attempt029ProvenanceInput;

interface StoredAttempt029Provenance {
  readonly requestedModel: string;
  readonly mappedModel: string;
  readonly mappingSource: ModelResolutionProvenance['mappingSource'];
  readonly mappingVersion: string | null;
  readonly providerProtocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  readonly clientOperation: string;
  readonly providerOperation: string;
  readonly requestFingerprint: string;
  readonly requestFingerprintVersion: string;
  readonly payloadCompilerVersion: string;
  readonly usageEstimatorVersion: string;
  readonly payloadSha256: string;
}

interface NormalizedUsage extends NormalizedUsageExact {
  readonly inputTotal: ExactTokenCount;
  readonly inputUncached: ExactTokenCount;
  readonly cacheRead: ExactTokenCount;
  readonly cacheWrite: ExactTokenCount;
  readonly cacheWrite5m: ExactTokenCount;
  readonly cacheWrite1h: ExactTokenCount;
  readonly outputTotal: ExactTokenCount;
  readonly reasoningOutput: ExactTokenCount;
}

function fail(code: SaasMeteringErrorCode, cause?: unknown): never {
  throw new SaasMeteringError(code, cause);
}

function asNonEmptyText(value: unknown, _field: string, maxLength = 512): string {
  if (typeof value !== 'string') fail('METERING_INVALID_INPUT');
  const normalized = value.trim();
  if (normalized === '' || normalized.length > maxLength) fail('METERING_INVALID_INPUT');
  return normalized;
}

function asIdentifier(value: unknown): string {
  return asNonEmptyText(value, 'identifier', 255);
}

function asOptionalText(value: unknown, maxLength = 255): string | null {
  if (value === undefined || value === null) return null;
  return asNonEmptyText(value, 'optional text', maxLength);
}

function asOptionalStoredText(value: unknown, maxLength = 255): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail('METERING_STORAGE_ERROR');
  const normalized = value.trim();
  if (normalized === '' || normalized.length > maxLength) fail('METERING_STORAGE_ERROR');
  return normalized;
}

function asVersion(value: ExactIntegerInput, _field: string): string {
  let text: string;
  if (typeof value === 'bigint') {
    text = value.toString(10);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('METERING_INVALID_INPUT');
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    fail('METERING_INVALID_INPUT');
  }
  if (!/^\d+$/.test(text) || BigInt(text) < 1n || BigInt(text) > MAX_POSTGRES_BIGINT) {
    fail('METERING_INVALID_INPUT');
  }
  return BigInt(text).toString(10);
}

function asToken(value: ExactIntegerInput | null, _field: string): string | null {
  if (value === null) return null;
  let text: string;
  if (typeof value === 'bigint') {
    text = value.toString(10);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('METERING_INVALID_INPUT');
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    fail('METERING_INVALID_INPUT');
  }
  if (!/^\d+$/.test(text) || BigInt(text) > MAX_POSTGRES_BIGINT) fail('METERING_INVALID_INPUT');
  return BigInt(text).toString(10);
}

function asStoredToken(value: unknown): ExactTokenCount {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return asToken(value, 'stored token');
  if (typeof value === 'number') return asToken(value, 'stored token');
  if (typeof value === 'string') return asToken(value, 'stored token');
  fail('METERING_STORAGE_ERROR');
}

function asOptionalStoredVersion(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    fail('METERING_STORAGE_ERROR');
  }
  return asVersion(value, field);
}

function asProtocol(value: unknown): 'anthropic' | 'openai' | 'gemini' | 'responses' {
  const protocol = asNonEmptyText(value, 'protocol', 32);
  if (!PROTOCOLS.has(protocol)) fail('METERING_INVALID_INPUT');
  return protocol as 'anthropic' | 'openai' | 'gemini' | 'responses';
}

function asSupplyMode(value: unknown): 'byok' | 'platform' {
  const mode = asNonEmptyText(value, 'supplyMode', 32);
  if (!SUPPLY_MODES.has(mode)) fail('METERING_INVALID_INPUT');
  return mode as 'byok' | 'platform';
}

function asAccountOwnerKind(value: unknown): 'tenant' | 'platform' {
  const kind = asNonEmptyText(value, 'accountOwnerKind', 32);
  if (!ACCOUNT_OWNER_KINDS.has(kind)) fail('METERING_INVALID_INPUT');
  return kind as 'tenant' | 'platform';
}

function asOptionalAccountOwnerKind(value: unknown): 'tenant' | 'platform' | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ACCOUNT_OWNER_KINDS.has(value)) fail('METERING_STORAGE_ERROR');
  return value as 'tenant' | 'platform';
}

function asBindingState(value: unknown): 'legacy' | 'bound' {
  if (value !== 'legacy' && value !== 'bound') fail('METERING_STORAGE_ERROR');
  return value;
}

function asDispatchAuthorityState(value: unknown): DispatchAuthorityState {
  if (value !== 'unbound' && value !== 'bound') fail('METERING_STORAGE_ERROR');
  return value;
}

function asPrincipalKind(value: unknown): PrincipalKind {
  const kind = asNonEmptyText(value, 'principalKind', 32);
  if (!PRINCIPAL_KINDS.has(kind)) fail('METERING_INVALID_INPUT');
  return kind as PrincipalKind;
}

function asDispatchState(value: unknown): DispatchState {
  if (typeof value !== 'string' || !DISPATCH_STATES.has(value as DispatchState)) fail('METERING_INVALID_INPUT');
  return value as DispatchState;
}

function asResultState(value: unknown): AttemptResultState {
  if (typeof value !== 'string' || !RESULT_STATES.has(value as AttemptResultState)) fail('METERING_INVALID_INPUT');
  return value as AttemptResultState;
}

function asReconciliationState(value: unknown): ReconciliationState {
  if (typeof value !== 'string' || !RECONCILIATION_STATES.has(value as ReconciliationState)) {
    fail('METERING_INVALID_INPUT');
  }
  return value as ReconciliationState;
}

function asFinancialStatus(value: unknown): FinancialStatus {
  if (typeof value !== 'string' || !FINANCIAL_STATUSES.has(value as FinancialStatus)) {
    fail('METERING_INVALID_INPUT');
  }
  return value as FinancialStatus;
}

function asOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail('METERING_INVALID_INPUT');
  return value;
}

function asStateVersion(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER) {
    return Number(value);
  }
  if (typeof value === 'bigint' && value >= 1n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  fail('METERING_STORAGE_ERROR');
}

function asDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  fail('METERING_STORAGE_ERROR');
}

function asNullableDateString(value: unknown): string | null {
  return value === null || value === undefined ? null : asDateString(value);
}

function asNullableHttpStatus(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 599) {
    fail('METERING_STORAGE_ERROR');
  }
  return value;
}

function normalizeBinding(input: AuthorizationBindingInput): NormalizedAuthorizationBinding {
  const binding = {
    tenantId: asIdentifier(input.tenantId),
    projectId: asIdentifier(input.projectId),
    proxyKeyId: asIdentifier(input.proxyKeyId),
    entitlementId: asIdentifier(input.entitlementId),
    supplyProfileId: asIdentifier(input.supplyProfileId),
    supplyProfileVersion: asVersion(input.supplyProfileVersion, 'supplyProfileVersion'),
    modelScopeVersion: asVersion(input.modelScopeVersion, 'modelScopeVersion'),
    supplyMode: asSupplyMode(input.supplyMode),
    principalKind: asPrincipalKind(input.principalKind),
    principalId: asIdentifier(input.principalId),
    authzVersion: asVersion(input.authzVersion, 'authzVersion'),
    entitlementVersion: asVersion(input.entitlementVersion, 'entitlementVersion'),
    configVersion: asVersion(input.configVersion, 'configVersion'),
    projectPolicyVersion: asVersion(
      input.projectPolicyVersion ?? fail('METERING_INVALID_INPUT'),
      'projectPolicyVersion',
    ),
  } as const;
  return binding;
}

function normalizeRouteAuthority(
  input: RouteAuthoritySnapshotInput,
  requireUpstreamId: boolean,
): NormalizedRouteAuthority {
  const routeConfigId = asIdentifier(input.routeConfigId ?? fail('METERING_INVALID_INPUT'));
  const routeConfigVersion = asVersion(
    input.routeConfigVersion ?? fail('METERING_INVALID_INPUT'),
    'routeConfigVersion',
  );
  const routePublicModelId = asIdentifier(input.routePublicModelId ?? fail('METERING_INVALID_INPUT'));
  const routePublicModelVersion = asVersion(
    input.routePublicModelVersion ?? fail('METERING_INVALID_INPUT'),
    'routePublicModelVersion',
  );
  const routeProtocol = asProtocol(input.routeProtocol ?? fail('METERING_INVALID_INPUT'));
  const routeTargetMode = input.routeTargetMode;
  if (routeTargetMode !== 'tenant_account' && routeTargetMode !== 'platform_pool') {
    fail('METERING_INVALID_INPUT');
  }
  const routeUpstreamId =
    input.routeUpstreamId === null || input.routeUpstreamId === undefined ? null : asIdentifier(input.routeUpstreamId);
  if (requireUpstreamId && routeUpstreamId === null) fail('METERING_INVALID_INPUT');
  return {
    routeConfigId,
    routeConfigVersion,
    routePublicModelId,
    routePublicModelVersion,
    routeProtocol,
    routeTargetMode,
    routeUpstreamId,
  };
}

function normalizeCommercialMeteringAuthority(
  input: CommercialMeteringAuthoritySnapshotInput,
): NormalizedCommercialMeteringAuthority {
  const customerMeteringPolicyId = asIdentifier(input.customerMeteringPolicyId ?? fail('METERING_INVALID_INPUT'));
  const customerMeteringPolicyVersion = asVersion(
    input.customerMeteringPolicyVersion ?? fail('METERING_INVALID_INPUT'),
    'customerMeteringPolicyVersion',
  );
  const providerMeteringPolicyId = asIdentifier(input.providerMeteringPolicyId ?? fail('METERING_INVALID_INPUT'));
  const providerMeteringPolicyVersion = asVersion(
    input.providerMeteringPolicyVersion ?? fail('METERING_INVALID_INPUT'),
    'providerMeteringPolicyVersion',
  );
  const contractAttestationId = asIdentifier(input.contractAttestationId ?? fail('METERING_INVALID_INPUT'));
  return {
    customerMeteringPolicyId,
    customerMeteringPolicyVersion,
    providerMeteringPolicyId,
    providerMeteringPolicyVersion,
    contractAttestationId,
  };
}

function normalizeRequest(input: CreateRequestInput, hmacSecret?: HmacSecret): NormalizedRequestInput {
  const binding = normalizeBinding(input);
  const route = normalizeRouteAuthority(input, true);
  const commercial = normalizeCommercialMeteringAuthority(input);
  const protocol = asProtocol(input.protocol);
  if (route.routeProtocol !== protocol) fail('METERING_INVALID_INPUT');
  const expectedTargetMode = input.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool';
  if (route.routeTargetMode !== expectedTargetMode) fail('METERING_INVALID_INPUT');
  if (binding.configVersion !== route.routeConfigVersion) fail('METERING_INVALID_INPUT');
  const customerPriceVersion = asOptionalText(input.customerPriceVersion, 128);
  if ((binding.supplyMode === 'platform') !== (customerPriceVersion !== null)) {
    fail('METERING_INVALID_INPUT');
  }
  const requestFingerprintVersion = asNonEmptyText(input.requestFingerprintVersion, 'requestFingerprintVersion', 64);
  let idempotencyKeyDigest: string | null = null;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    const key = asNonEmptyText(input.idempotencyKey, 'idempotencyKey', 4096);
    idempotencyKeyDigest = digestClientKey(key, hmacSecret);
  }
  return {
    ...binding,
    ...route,
    ...commercial,
    publicModel: asNonEmptyText(input.publicModel, 'publicModel', 512),
    protocol,
    endpoint: asNonEmptyText(input.endpoint, 'endpoint', 1024),
    requestFingerprint: normalizeFingerprint(input.requestFingerprint, requestFingerprintVersion),
    requestFingerprintVersion,
    idempotencyKeyDigest,
    customerPriceVersion,
    initialAttempt: input.initialAttempt ?? null,
  };
}

function operationForProtocol(protocol: 'anthropic' | 'openai' | 'gemini' | 'responses'): string {
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

function asInputDigest(value: unknown): string {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) fail('METERING_INVALID_INPUT');
  return value.toLowerCase();
}

function asProvenanceMappingVersion(value: unknown): number | null {
  if (value === null) return null;
  const normalized = asVersion(value as ExactIntegerInput, 'modelResolution.mappingVersion');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) fail('METERING_INVALID_INPUT');
  return parsed;
}

function normalizeAttemptProvenance(
  input: CreateAttemptInput,
  protocol: 'anthropic' | 'openai' | 'gemini' | 'responses',
  resolvedModel: string,
): Pick<
  NormalizedAttemptInput,
  | 'modelResolution'
  | 'clientProtocol'
  | 'providerProtocol'
  | 'clientOperation'
  | 'providerOperation'
  | 'requestFingerprint'
  | 'requestFingerprintVersion'
  | 'payloadCompilerVersion'
  | 'usageEstimatorVersion'
  | 'payloadSha256'
> {
  const runtime = input as RuntimeAttemptInput;
  const modelResolution = input.modelResolution;
  if (!modelResolution) fail('METERING_INVALID_INPUT');
  const requestedModel = asNonEmptyText(modelResolution.requestedModel, 'modelResolution.requestedModel', 512);
  const mappedModel = asNonEmptyText(modelResolution.mappedModel, 'modelResolution.mappedModel', 512);
  const resolvedProvenanceModel = asNonEmptyText(modelResolution.resolvedModel, 'modelResolution.resolvedModel', 512);
  if (resolvedProvenanceModel !== resolvedModel) fail('METERING_INVALID_INPUT');
  const mappingSource = modelResolution.mappingSource;
  if (mappingSource !== 'none' && mappingSource !== 'alias' && mappingSource !== 'wildcard') {
    fail('METERING_INVALID_INPUT');
  }
  const mappingVersion = asProvenanceMappingVersion(modelResolution.mappingVersion);
  if (mappingSource === 'none') {
    if (requestedModel !== mappedModel || mappedModel !== resolvedModel || mappingVersion !== null) {
      fail('METERING_INVALID_INPUT');
    }
  } else if (mappingVersion === null) {
    fail('METERING_INVALID_INPUT');
  }

  const clientProtocol = asProtocol(input.clientProtocol ?? fail('METERING_INVALID_INPUT'));
  const providerProtocol = asProtocol(input.providerProtocol ?? fail('METERING_INVALID_INPUT'));
  if (clientProtocol !== protocol) fail('METERING_INVALID_INPUT');
  const clientOperation = asNonEmptyText(
    input.clientOperation ?? fail('METERING_INVALID_INPUT'),
    'clientOperation',
    128,
  );
  const providerOperation = asNonEmptyText(
    input.providerOperation ?? fail('METERING_INVALID_INPUT'),
    'providerOperation',
    128,
  );
  if (
    clientOperation !== operationForProtocol(clientProtocol) ||
    providerOperation !== operationForProtocol(providerProtocol)
  ) {
    fail('METERING_INVALID_INPUT');
  }

  const requestFingerprintVersion = asNonEmptyText(
    runtime.requestFingerprintVersion ?? fail('METERING_INVALID_INPUT'),
    'requestFingerprintVersion',
    64,
  );
  const requestFingerprint = normalizeFingerprint(
    asNonEmptyText(runtime.requestFingerprint ?? fail('METERING_INVALID_INPUT'), 'requestFingerprint', 4096),
    requestFingerprintVersion,
  );
  const payloadCompilerVersion = asNonEmptyText(
    runtime.payloadCompilerVersion ?? fail('METERING_INVALID_INPUT'),
    'payloadCompilerVersion',
    64,
  );
  const usageEstimatorVersion = asNonEmptyText(
    runtime.usageEstimatorVersion ?? fail('METERING_INVALID_INPUT'),
    'usageEstimatorVersion',
    64,
  );
  const payloadSha256 = asInputDigest(runtime.payloadSha256);
  return {
    modelResolution: {
      requestedModel,
      mappedModel,
      resolvedModel,
      mappingSource,
      mappingVersion,
    },
    clientProtocol,
    providerProtocol,
    clientOperation,
    providerOperation,
    requestFingerprint,
    requestFingerprintVersion,
    payloadCompilerVersion,
    usageEstimatorVersion,
    payloadSha256,
  };
}

function normalizeAttempt(input: CreateAttemptInput): NormalizedAttemptInput {
  const accountOwnerKind = asAccountOwnerKind(input.accountOwnerKind);
  const route = normalizeRouteAuthority(input, false);
  const commercial = normalizeCommercialMeteringAuthority(input);
  const protocol = asProtocol(input.protocol);
  if (route.routeProtocol !== protocol) fail('METERING_INVALID_INPUT');
  const expectedTargetMode = accountOwnerKind === 'tenant' ? 'tenant_account' : 'platform_pool';
  if (route.routeTargetMode !== expectedTargetMode) fail('METERING_INVALID_INPUT');
  const resolvedModel = asNonEmptyText(input.resolvedModel, 'resolvedModel', 512);
  const provenance = normalizeAttemptProvenance(input, protocol, resolvedModel);
  const common = {
    tenantId: asIdentifier(input.tenantId),
    requestId: asIdentifier(input.requestId),
    ordinal: asOrdinal(input.ordinal),
    upstreamId: asIdentifier(input.upstreamId),
    accountOwnerKind,
    accountId: asIdentifier(input.accountId),
    providerId: asIdentifier(input.providerId),
    productId: asIdentifier(input.productId),
    resolvedModel,
    protocol,
    endpoint: asNonEmptyText(input.endpoint, 'endpoint', 1024),
    supplierCostVersion: asOptionalText(input.supplierCostVersion, 128),
    customerPriceVersion: asOptionalText(input.customerPriceVersion, 128),
    dispatchProfileId: asIdentifier(input.dispatchProfileId),
    supplyProfileAuthzVersion: asVersion(input.supplyProfileAuthzVersion, 'supplyProfileAuthzVersion'),
    credentialId: asIdentifier(input.credentialId),
    credentialVersion: asVersion(input.credentialVersion, 'credentialVersion'),
    credentialAuthzVersion: asVersion(input.credentialAuthzVersion, 'credentialAuthzVersion'),
    accountAuthzVersion: asVersion(input.accountAuthzVersion, 'accountAuthzVersion'),
    projectPolicyVersion: asVersion(
      input.projectPolicyVersion ?? fail('METERING_INVALID_INPUT'),
      'projectPolicyVersion',
    ),
    routeConfigId: route.routeConfigId,
    routeConfigVersion: route.routeConfigVersion,
    routePublicModelId: route.routePublicModelId,
    routePublicModelVersion: route.routePublicModelVersion,
    routeProtocol: route.routeProtocol,
    routeTargetMode: route.routeTargetMode,
    ...provenance,
    ...commercial,
  };

  if (accountOwnerKind === 'tenant') {
    const tenantInput = input as Extract<CreateAttemptInput, { accountOwnerKind: 'tenant' }>;
    return {
      ...common,
      poolId: null,
      poolAuthzVersion: null,
      poolMemberAccountAuthzVersion: null,
      poolMemberAuthzVersion: null,
      poolGrantAuthzVersion: null,
      poolGrantProfileAuthzVersion: null,
      poolGrantPoolAuthzVersion: null,
      profileAccountAuthzVersion: asVersion(tenantInput.profileAccountAuthzVersion, 'profileAccountAuthzVersion'),
    };
  }

  const platformInput = input as Extract<CreateAttemptInput, { accountOwnerKind: 'platform' }>;
  return {
    ...common,
    poolId: asIdentifier(platformInput.poolId),
    poolAuthzVersion: asVersion(platformInput.poolAuthzVersion, 'poolAuthzVersion'),
    poolMemberAuthzVersion: asVersion(platformInput.poolMemberAuthzVersion, 'poolMemberAuthzVersion'),
    poolMemberAccountAuthzVersion: asVersion(
      platformInput.poolMemberAccountAuthzVersion,
      'poolMemberAccountAuthzVersion',
    ),
    poolGrantAuthzVersion: asVersion(platformInput.poolGrantAuthzVersion, 'poolGrantAuthzVersion'),
    poolGrantProfileAuthzVersion: asVersion(platformInput.poolGrantProfileAuthzVersion, 'poolGrantProfileAuthzVersion'),
    poolGrantPoolAuthzVersion: asVersion(platformInput.poolGrantPoolAuthzVersion, 'poolGrantPoolAuthzVersion'),
    profileAccountAuthzVersion: null,
  };
}

function normalizeInitialAttempt(
  input: InitialAttemptInput,
  tenantId: string,
  requestId: string,
  supplyMode: 'byok' | 'platform',
  commercial: NormalizedCommercialMeteringAuthority,
  customerPriceVersion: string | null,
): NormalizedAttemptInput {
  const normalized = normalizeAttempt({
    ...input,
    tenantId,
    requestId,
    customerMeteringPolicyId: input.customerMeteringPolicyId ?? commercial.customerMeteringPolicyId,
    customerMeteringPolicyVersion: input.customerMeteringPolicyVersion ?? commercial.customerMeteringPolicyVersion,
    providerMeteringPolicyId: input.providerMeteringPolicyId ?? commercial.providerMeteringPolicyId,
    providerMeteringPolicyVersion: input.providerMeteringPolicyVersion ?? commercial.providerMeteringPolicyVersion,
    contractAttestationId: input.contractAttestationId ?? commercial.contractAttestationId,
    customerPriceVersion: input.customerPriceVersion ?? customerPriceVersion,
  });
  const expectedOwnerKind = supplyMode === 'byok' ? 'tenant' : 'platform';
  if (normalized.accountOwnerKind !== expectedOwnerKind) fail('METERING_INVALID_INPUT');
  if (supplyMode === 'byok' && normalized.supplierCostVersion !== null) fail('METERING_INVALID_INPUT');
  if (supplyMode === 'platform' && normalized.supplierCostVersion === null) fail('METERING_INVALID_INPUT');
  if ((supplyMode === 'platform') !== (normalized.customerPriceVersion !== null)) {
    fail('METERING_INVALID_INPUT');
  }
  return normalized;
}

function normalizeUsage(input: UsageValues): NormalizedUsage {
  const status = input.status;
  const source = input.source;
  const measurementKind = input.measurementKind;
  const billableBasis = input.billableBasis;
  if (!['reported', 'partial', 'missing', 'estimated'].includes(status)) fail('METERING_INVALID_INPUT');
  if (!['upstream', 'local-estimate', 'legacy'].includes(source)) fail('METERING_INVALID_INPUT');
  if (!['snapshot', 'delta'].includes(measurementKind)) fail('METERING_INVALID_INPUT');
  if (!['exact', 'estimated', 'unknown', 'not_billable'].includes(billableBasis)) fail('METERING_INVALID_INPUT');
  const semanticsVersion = asNonEmptyText(input.semanticsVersion, 'semanticsVersion', 64);
  return {
    inputTotal: asToken(input.inputTotal, 'inputTotal'),
    inputUncached: asToken(input.inputUncached, 'inputUncached'),
    cacheRead: asToken(input.cacheRead, 'cacheRead'),
    cacheWrite: asToken(input.cacheWrite, 'cacheWrite'),
    cacheWrite5m: asToken(input.cacheWrite5m, 'cacheWrite5m'),
    cacheWrite1h: asToken(input.cacheWrite1h, 'cacheWrite1h'),
    outputTotal: asToken(input.outputTotal, 'outputTotal'),
    reasoningOutput: asToken(input.reasoningOutput, 'reasoningOutput'),
    status,
    source,
    semanticsVersion,
    measurementKind,
    billableBasis,
  };
}

function normalizeNow(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('METERING_INVALID_INPUT');
  return value.toISOString();
}

function mapIdempotency(row: Row): IdempotencyRecord {
  return {
    id: asIdentifier(row.id),
    tenantId: asIdentifier(row.tenant_id),
    proxyKeyId: asIdentifier(row.proxy_key_id),
    keyDigest: asDigest(row.key_digest),
    requestFingerprint: asDigest(row.request_fingerprint),
    requestFingerprintVersion: asNonEmptyText(row.request_fingerprint_version, 'requestFingerprintVersion', 64),
    requestId: row.request_id === null || row.request_id === undefined ? null : asIdentifier(row.request_id),
    kind: row.kind === 'active' || row.kind === 'tombstone' ? row.kind : fail('METERING_STORAGE_ERROR'),
    createdAt: asDateString(row.created_at),
  };
}

function asDigest(value: unknown): string {
  if (typeof value !== 'string' || !HEX_DIGEST.test(value)) fail('METERING_STORAGE_ERROR');
  return value.toLowerCase();
}

function allNullish(values: readonly unknown[]): boolean {
  return values.every((value) => value === null || value === undefined);
}

function allPresent(values: readonly unknown[]): boolean {
  return values.every((value) => value !== null && value !== undefined);
}

function mapAttempt029Provenance(row: Row): StoredAttempt029Provenance | null {
  const modelValues = [
    row.model_resolution_requested_model,
    row.model_resolution_mapped_model,
    row.model_resolution_mapping_source,
    row.model_resolution_mapping_version,
  ];
  const transportValues = [
    row.provider_protocol,
    row.client_operation,
    row.provider_operation,
    row.request_fingerprint,
    row.request_fingerprint_version,
    row.payload_compiler_version,
    row.usage_estimator_version,
    row.payload_sha256,
  ];
  const modelAbsent = allNullish(modelValues);
  const modelComplete = allPresent(modelValues.slice(0, 3));
  const transportAbsent = allNullish(transportValues);
  const transportComplete = allPresent(transportValues);
  if ((modelAbsent ? 0 : 1) !== (modelComplete ? 1 : 0) || (transportAbsent ? 0 : 1) !== (transportComplete ? 1 : 0)) {
    fail('METERING_STORAGE_ERROR');
  }
  if (modelAbsent && transportAbsent) return null;
  if (!modelComplete || !transportComplete) fail('METERING_STORAGE_ERROR');
  const mappingSource = row.model_resolution_mapping_source;
  if (mappingSource !== 'none' && mappingSource !== 'alias' && mappingSource !== 'wildcard') {
    fail('METERING_STORAGE_ERROR');
  }
  if (
    mappingSource !== 'none' &&
    (row.model_resolution_mapping_version === null || row.model_resolution_mapping_version === undefined)
  ) {
    fail('METERING_STORAGE_ERROR');
  }
  if (
    mappingSource === 'none' &&
    row.model_resolution_mapping_version !== null &&
    row.model_resolution_mapping_version !== undefined
  ) {
    fail('METERING_STORAGE_ERROR');
  }
  return {
    requestedModel: asNonEmptyText(row.model_resolution_requested_model, 'requestedModel', 512),
    mappedModel: asNonEmptyText(row.model_resolution_mapped_model, 'mappedModel', 512),
    mappingSource,
    mappingVersion: asOptionalStoredVersion(row.model_resolution_mapping_version, 'mappingVersion'),
    providerProtocol: asProtocol(row.provider_protocol),
    clientOperation: asNonEmptyText(row.client_operation, 'clientOperation', 128),
    providerOperation: asNonEmptyText(row.provider_operation, 'providerOperation', 128),
    requestFingerprint: asDigest(row.request_fingerprint),
    requestFingerprintVersion: asNonEmptyText(row.request_fingerprint_version, 'requestFingerprintVersion', 64),
    payloadCompilerVersion: asNonEmptyText(row.payload_compiler_version, 'payloadCompilerVersion', 64),
    usageEstimatorVersion: asNonEmptyText(row.usage_estimator_version, 'usageEstimatorVersion', 64),
    payloadSha256: asDigest(row.payload_sha256),
  };
}

function mapRequest(row: Row): RequestRecord {
  return {
    id: asIdentifier(row.id),
    tenantId: asIdentifier(row.tenant_id),
    projectId: asIdentifier(row.project_id),
    proxyKeyId: asIdentifier(row.proxy_key_id),
    entitlementId: asIdentifier(row.entitlement_id),
    supplyProfileId: asIdentifier(row.supply_profile_id),
    supplyProfileVersion: asVersion(String(row.supply_profile_version), 'supplyProfileVersion'),
    modelScopeVersion: asVersion(String(row.model_scope_version), 'modelScopeVersion'),
    supplyMode: asSupplyMode(row.supply_mode),
    principalKind: asPrincipalKind(row.principal_kind),
    principalId: asIdentifier(row.principal_id),
    authzVersion: asVersion(String(row.authz_version), 'authzVersion'),
    entitlementVersion: asVersion(String(row.entitlement_version), 'entitlementVersion'),
    configVersion: asVersion(String(row.config_version), 'configVersion'),
    projectPolicyVersion: asOptionalStoredVersion(row.project_policy_version, 'projectPolicyVersion'),
    customerMeteringPolicyId: asOptionalStoredText(row.customer_metering_policy_id),
    customerMeteringPolicyVersion: asOptionalStoredVersion(
      row.customer_metering_policy_version,
      'customerMeteringPolicyVersion',
    ),
    providerMeteringPolicyId: asOptionalStoredText(row.provider_metering_policy_id),
    providerMeteringPolicyVersion: asOptionalStoredVersion(
      row.provider_metering_policy_version,
      'providerMeteringPolicyVersion',
    ),
    contractAttestationId: asOptionalStoredText(row.contract_attestation_id),
    routeConfigId: asOptionalStoredText(row.route_config_id),
    routeConfigVersion: asOptionalStoredVersion(row.route_config_version, 'routeConfigVersion'),
    routePublicModelId: asOptionalStoredText(row.route_public_model_id),
    routePublicModelVersion: asOptionalStoredVersion(row.route_public_model_version, 'routePublicModelVersion'),
    routeProtocol:
      row.route_protocol === null || row.route_protocol === undefined ? null : asProtocol(row.route_protocol),
    routeTargetMode:
      row.route_target_mode === null || row.route_target_mode === undefined
        ? null
        : row.route_target_mode === 'tenant_account' || row.route_target_mode === 'platform_pool'
          ? row.route_target_mode
          : fail('METERING_STORAGE_ERROR'),
    routeUpstreamId: asOptionalStoredText(row.route_upstream_id),
    publicModel: asNonEmptyText(row.public_model, 'publicModel', 512),
    protocol: asProtocol(row.protocol),
    endpoint: asNonEmptyText(row.endpoint, 'endpoint', 1024),
    requestFingerprint: asDigest(row.request_fingerprint),
    requestFingerprintVersion: asNonEmptyText(row.request_fingerprint_version, 'requestFingerprintVersion', 64),
    idempotencyKeyDigest:
      row.idempotency_key_digest === null || row.idempotency_key_digest === undefined
        ? null
        : asDigest(row.idempotency_key_digest),
    customerPriceVersion:
      row.customer_price_version === null || row.customer_price_version === undefined
        ? null
        : asNonEmptyText(row.customer_price_version, 'customerPriceVersion', 128),
    financialStatus: asFinancialStatus(row.financial_status),
    resultState: asResultState(row.execution_state),
    reconciliationState: asReconciliationState(row.reconciliation_state),
    createdAt: asDateString(row.created_at),
    updatedAt: asDateString(row.updated_at),
    stateVersion: asStateVersion(row.state_version),
  };
}

function mapAttempt(row: Row): AttemptRecord {
  const bindingState = asBindingState(row.binding_state);
  const dispatchAuthorityState = asDispatchAuthorityState(
    row.dispatch_authority_state ?? (bindingState === 'legacy' ? 'unbound' : 'bound'),
  );
  const accountOwnerKind = asOptionalAccountOwnerKind(row.account_owner_kind);
  const accountId = asOptionalStoredText(row.account_id);
  const providerId = asOptionalStoredText(row.provider_id);
  const productId = asOptionalStoredText(row.product_id);
  const endpoint = asOptionalStoredText(row.endpoint, 1024);
  const resolvedModel = asNonEmptyText(row.resolved_model, 'resolvedModel', 512);
  const protocol = asProtocol(row.protocol);
  const provenance = mapAttempt029Provenance(row);
  if (bindingState === 'bound') {
    if (
      accountOwnerKind === null ||
      accountId === null ||
      providerId === null ||
      productId === null ||
      endpoint === null
    ) {
      fail('METERING_STORAGE_ERROR');
    }
  } else if (
    accountOwnerKind !== null ||
    accountId !== null ||
    providerId !== null ||
    productId !== null ||
    endpoint !== null
  ) {
    fail('METERING_STORAGE_ERROR');
  }

  const dispatchProfileId = asOptionalStoredText(row.dispatch_profile_id);
  const supplyProfileAuthzVersion = asOptionalStoredVersion(
    row.supply_profile_authz_version,
    'supplyProfileAuthzVersion',
  );
  const credentialId = asOptionalStoredText(row.credential_id);
  const credentialVersion = asOptionalStoredVersion(row.credential_version, 'credentialVersion');
  const credentialAuthzVersion = asOptionalStoredVersion(row.credential_authz_version, 'credentialAuthzVersion');
  const accountAuthzVersion = asOptionalStoredVersion(row.account_authz_version, 'accountAuthzVersion');
  const poolId = asOptionalStoredText(row.pool_id);
  const poolAuthzVersion = asOptionalStoredVersion(row.pool_authz_version, 'poolAuthzVersion');
  const poolMemberAccountAuthzVersion = asOptionalStoredVersion(
    row.pool_member_account_authz_version,
    'poolMemberAccountAuthzVersion',
  );
  const poolMemberAuthzVersion = asOptionalStoredVersion(row.pool_member_authz_version, 'poolMemberAuthzVersion');
  const poolGrantAuthzVersion = asOptionalStoredVersion(row.pool_grant_authz_version, 'poolGrantAuthzVersion');
  const poolGrantProfileAuthzVersion = asOptionalStoredVersion(
    row.pool_grant_profile_authz_version,
    'poolGrantProfileAuthzVersion',
  );
  const poolGrantPoolAuthzVersion = asOptionalStoredVersion(
    row.pool_grant_pool_authz_version,
    'poolGrantPoolAuthzVersion',
  );
  const profileAccountAuthzVersion = asOptionalStoredVersion(
    row.profile_account_authz_version,
    'profileAccountAuthzVersion',
  );
  const authorityRefs = [
    dispatchProfileId,
    supplyProfileAuthzVersion,
    credentialId,
    credentialVersion,
    credentialAuthzVersion,
    accountAuthzVersion,
    poolId,
    poolAuthzVersion,
    poolMemberAccountAuthzVersion,
    poolMemberAuthzVersion,
    poolGrantAuthzVersion,
    poolGrantProfileAuthzVersion,
    poolGrantPoolAuthzVersion,
    profileAccountAuthzVersion,
  ];
  if (dispatchAuthorityState === 'unbound' && authorityRefs.some((value) => value !== null)) {
    fail('METERING_STORAGE_ERROR');
  }
  if (dispatchAuthorityState === 'bound') {
    if (
      dispatchProfileId === null ||
      supplyProfileAuthzVersion === null ||
      credentialId === null ||
      credentialVersion === null ||
      credentialAuthzVersion === null ||
      accountAuthzVersion === null
    ) {
      fail('METERING_STORAGE_ERROR');
    }
    if (accountOwnerKind === 'tenant') {
      if (
        profileAccountAuthzVersion === null ||
        poolId !== null ||
        poolAuthzVersion !== null ||
        poolMemberAccountAuthzVersion !== null ||
        poolMemberAuthzVersion !== null ||
        poolGrantAuthzVersion !== null ||
        poolGrantProfileAuthzVersion !== null ||
        poolGrantPoolAuthzVersion !== null
      ) {
        fail('METERING_STORAGE_ERROR');
      }
    } else if (accountOwnerKind === 'platform') {
      if (
        profileAccountAuthzVersion !== null ||
        poolId === null ||
        poolAuthzVersion === null ||
        poolMemberAccountAuthzVersion === null ||
        poolMemberAuthzVersion === null ||
        poolGrantAuthzVersion === null ||
        poolGrantProfileAuthzVersion === null ||
        poolGrantPoolAuthzVersion === null
      ) {
        fail('METERING_STORAGE_ERROR');
      }
    } else {
      fail('METERING_STORAGE_ERROR');
    }
  }
  return {
    id: asIdentifier(row.id),
    tenantId: asIdentifier(row.tenant_id),
    requestId: asIdentifier(row.request_id),
    projectPolicyVersion: asOptionalStoredVersion(row.project_policy_version, 'projectPolicyVersion'),
    customerPriceVersion:
      row.customer_price_version === null || row.customer_price_version === undefined
        ? null
        : asNonEmptyText(row.customer_price_version, 'customerPriceVersion', 128),
    customerMeteringPolicyId: asOptionalStoredText(row.customer_metering_policy_id),
    customerMeteringPolicyVersion: asOptionalStoredVersion(
      row.customer_metering_policy_version,
      'customerMeteringPolicyVersion',
    ),
    providerMeteringPolicyId: asOptionalStoredText(row.provider_metering_policy_id),
    providerMeteringPolicyVersion: asOptionalStoredVersion(
      row.provider_metering_policy_version,
      'providerMeteringPolicyVersion',
    ),
    contractAttestationId: asOptionalStoredText(row.contract_attestation_id),
    routeConfigId: asOptionalStoredText(row.route_config_id),
    routeConfigVersion: asOptionalStoredVersion(row.route_config_version, 'routeConfigVersion'),
    routePublicModelId: asOptionalStoredText(row.route_public_model_id),
    routePublicModelVersion: asOptionalStoredVersion(row.route_public_model_version, 'routePublicModelVersion'),
    routeProtocol:
      row.route_protocol === null || row.route_protocol === undefined ? null : asProtocol(row.route_protocol),
    routeTargetMode:
      row.route_target_mode === null || row.route_target_mode === undefined
        ? null
        : row.route_target_mode === 'tenant_account' || row.route_target_mode === 'platform_pool'
          ? row.route_target_mode
          : fail('METERING_STORAGE_ERROR'),
    ordinal: asOrdinal(row.ordinal),
    upstreamId: asIdentifier(row.upstream_id),
    bindingState,
    dispatchAuthorityState,
    accountOwnerKind,
    accountId,
    providerId,
    productId,
    resolvedModel,
    protocol,
    ...(provenance === null
      ? {}
      : {
          modelResolution: {
            requestedModel: provenance.requestedModel,
            mappedModel: provenance.mappedModel,
            resolvedModel,
            mappingSource: provenance.mappingSource,
            mappingVersion:
              provenance.mappingVersion === null
                ? null
                : (() => {
                    const value = Number(provenance.mappingVersion);
                    if (!Number.isSafeInteger(value)) fail('METERING_STORAGE_ERROR');
                    return value;
                  })(),
          },
          clientProtocol: protocol,
          providerProtocol: provenance.providerProtocol,
          clientOperation: provenance.clientOperation,
          providerOperation: provenance.providerOperation,
          requestFingerprint: provenance.requestFingerprint,
          requestFingerprintVersion: provenance.requestFingerprintVersion,
          payloadCompilerVersion: provenance.payloadCompilerVersion,
          usageEstimatorVersion: provenance.usageEstimatorVersion,
          payloadSha256: provenance.payloadSha256,
        }),
    endpoint,
    supplierCostVersion:
      row.supplier_cost_version === null || row.supplier_cost_version === undefined
        ? null
        : asNonEmptyText(row.supplier_cost_version, 'supplierCostVersion', 128),
    dispatchProfileId,
    supplyProfileAuthzVersion,
    credentialId,
    credentialVersion,
    credentialAuthzVersion,
    accountAuthzVersion,
    poolId,
    poolAuthzVersion,
    poolMemberAccountAuthzVersion,
    poolMemberAuthzVersion,
    poolGrantAuthzVersion,
    poolGrantProfileAuthzVersion,
    poolGrantPoolAuthzVersion,
    profileAccountAuthzVersion,
    preparedEvidenceId:
      row.prepared_evidence_id === null || row.prepared_evidence_id === undefined
        ? null
        : asIdentifier(row.prepared_evidence_id),
    dispatchState: asDispatchState(row.dispatch_state),
    resultState: asResultState(row.result_state),
    responseStarted: row.response_started === true,
    responseStartedAt: asNullableDateString(row.response_started_at),
    resultHttpStatus: asNullableHttpStatus(row.result_http_status),
    unknownReason:
      row.unknown_reason === null || row.unknown_reason === undefined
        ? null
        : asNonEmptyText(row.unknown_reason, 'unknownReason', 1024),
    createdAt: asDateString(row.created_at),
    updatedAt: asDateString(row.updated_at),
    stateVersion: asStateVersion(row.state_version),
  } as AttemptRecord;
}

function mapUsage(row: Row): UsageEventRecord {
  return {
    id: asIdentifier(row.id),
    tenantId: asIdentifier(row.tenant_id),
    requestId: asIdentifier(row.request_id),
    attemptId: asIdentifier(row.attempt_id),
    supplyMode: asSupplyMode(row.supply_mode),
    dedupeKeyDigest: asDigest(row.dedupe_key_digest),
    eventDigest: asDigest(row.event_digest),
    inputTotal: asStoredToken(row.input_total),
    inputUncached: asStoredToken(row.input_uncached),
    cacheRead: asStoredToken(row.cache_read),
    cacheWrite: asStoredToken(row.cache_write),
    cacheWrite5m: asStoredToken(row.cache_write_5m),
    cacheWrite1h: asStoredToken(row.cache_write_1h),
    outputTotal: asStoredToken(row.output_total),
    reasoningOutput: asStoredToken(row.reasoning_output),
    status: row.status as UsageValues['status'],
    source: row.source as UsageValues['source'],
    semanticsVersion: asNonEmptyText(row.semantics_version, 'semanticsVersion', 64),
    measurementKind: row.measurement_kind as UsageValues['measurementKind'],
    billableBasis: row.billable_basis as UsageValues['billableBasis'],
    createdAt: asDateString(row.created_at),
  };
}

function mapSettlement(row: Row): UsageSettlementRecord {
  return {
    id: asIdentifier(row.id),
    tenantId: asIdentifier(row.tenant_id),
    usageEventId: asIdentifier(row.usage_event_id),
    requestId: asIdentifier(row.request_id),
    attemptId: asIdentifier(row.attempt_id),
    settlementKeyDigest: asDigest(row.settlement_key_digest),
    settlementDigest: asDigest(row.settlement_digest),
    kind:
      row.kind === 'usage_recorded' || row.kind === 'platform_cost_observed'
        ? row.kind
        : fail('METERING_STORAGE_ERROR'),
    createdAt: asDateString(row.created_at),
  };
}

function requestColumns(alias = ''): string {
  const prefix = alias === '' ? '' : `${alias}.`;
  return [
    `${prefix}id`,
    `${prefix}tenant_id`,
    `${prefix}project_id`,
    `${prefix}project_policy_version`,
    `${prefix}proxy_key_id`,
    `${prefix}entitlement_id`,
    `${prefix}supply_profile_id`,
    `${prefix}supply_profile_version`,
    `${prefix}model_scope_version`,
    `${prefix}supply_mode`,
    `${prefix}principal_kind`,
    `${prefix}principal_id`,
    `${prefix}authz_version`,
    `${prefix}entitlement_version`,
    `${prefix}config_version`,
    `${prefix}customer_metering_policy_id`,
    `${prefix}customer_metering_policy_version`,
    `${prefix}provider_metering_policy_id`,
    `${prefix}provider_metering_policy_version`,
    `${prefix}contract_attestation_id`,
    `${prefix}route_config_id`,
    `${prefix}route_config_version`,
    `${prefix}route_public_model_id`,
    `${prefix}route_public_model_version`,
    `${prefix}route_protocol`,
    `${prefix}route_target_mode`,
    `${prefix}route_upstream_id`,
    `${prefix}public_model`,
    `${prefix}protocol`,
    `${prefix}endpoint`,
    `${prefix}request_fingerprint`,
    `${prefix}request_fingerprint_version`,
    `${prefix}customer_price_version`,
    `${prefix}execution_state`,
    `${prefix}financial_status`,
    `${prefix}reconciliation_state`,
    `${prefix}created_at`,
    `${prefix}updated_at`,
    `${prefix}state_version`,
  ].join(', ');
}

const attemptColumns = [
  'id',
  'tenant_id',
  'request_id',
  'project_policy_version',
  'customer_price_version',
  'customer_metering_policy_id',
  'customer_metering_policy_version',
  'provider_metering_policy_id',
  'provider_metering_policy_version',
  'contract_attestation_id',
  'route_config_id',
  'route_config_version',
  'route_public_model_id',
  'route_public_model_version',
  'route_protocol',
  'route_target_mode',
  'ordinal',
  'upstream_id',
  'binding_state',
  'account_owner_kind',
  'account_id',
  'provider_id',
  'product_id',
  'resolved_model',
  'protocol',
  'endpoint',
  'supplier_cost_version',
  'dispatch_authority_state',
  'dispatch_profile_id',
  'supply_profile_authz_version',
  'credential_id',
  'credential_version',
  'credential_authz_version',
  'account_authz_version',
  'pool_id',
  'pool_authz_version',
  'pool_member_account_authz_version',
  'pool_member_authz_version',
  'pool_grant_authz_version',
  'pool_grant_profile_authz_version',
  'pool_grant_pool_authz_version',
  'profile_account_authz_version',
  'model_resolution_requested_model',
  'model_resolution_mapped_model',
  'model_resolution_mapping_source',
  'model_resolution_mapping_version',
  'provider_protocol',
  'client_operation',
  'provider_operation',
  'request_fingerprint',
  'request_fingerprint_version',
  'payload_compiler_version',
  'usage_estimator_version',
  'payload_sha256',
  'prepared_evidence_id',
  'dispatch_state',
  'result_state',
  'response_started',
  'response_started_at',
  'result_http_status',
  'unknown_reason',
  'created_at',
  'updated_at',
  'state_version',
].join(', ');

const usageColumns = [
  'id',
  'tenant_id',
  'request_id',
  'attempt_id',
  'supply_mode',
  'dedupe_key_digest',
  'event_digest',
  'input_total',
  'input_uncached',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output_total',
  'reasoning_output',
  'status',
  'source',
  'semantics_version',
  'measurement_kind',
  'billable_basis',
  'created_at',
].join(', ');

function attemptDispatchTransitionAllowed(from: DispatchState, to: DispatchState): boolean {
  if (from === to) return true;
  if (from === 'not_sent') return to === 'dispatching';
  if (from === 'dispatching') return to === 'not_sent' || to === 'sent' || to === 'unknown';
  if (from === 'sent') return to === 'unknown';
  return to === 'not_sent' || to === 'sent';
}

function resultTransitionAllowed(from: AttemptResultState, to: AttemptResultState): boolean {
  if (from === to) return true;
  if (from === 'pending') return to === 'succeeded' || to === 'failed' || to === 'unknown';
  return from === 'unknown' && (to === 'succeeded' || to === 'failed');
}

function requestReconciliationTransitionAllowed(from: ReconciliationState, to: ReconciliationState): boolean {
  if (from === to) return true;
  if (from === 'none') return to === 'pending';
  return from === 'pending' && to === 'resolved';
}

function financialTransitionAllowed(from: FinancialStatus, to: FinancialStatus): boolean {
  if (from === to) return true;
  if (from === 'pending') return to === 'settled' || to === 'released' || to === 'reconciliation_pending';
  return from === 'reconciliation_pending' && (to === 'settled' || to === 'released');
}

function sameUsage(left: UsageEventRecord, right: NormalizedUsageExact): boolean {
  return canonicalUsage(left) === canonicalUsage(right);
}

function sameFacts(pairs: readonly (readonly [unknown, unknown])[]): boolean {
  return pairs.every(([left, right]) => left === right);
}

function isPreparedRequestInput(
  input: CreateRequestInput | PreparedRequestAdmissionInput,
): input is PreparedRequestAdmissionInput {
  return 'requestId' in input && 'attemptId' in input;
}

function preparedRequestFactsMatch(existing: RequestRecord, input: NormalizedRequestInput): boolean {
  return sameFacts([
    [existing.tenantId, input.tenantId],
    [existing.projectId, input.projectId],
    [existing.proxyKeyId, input.proxyKeyId],
    [existing.entitlementId, input.entitlementId],
    [existing.supplyProfileId, input.supplyProfileId],
    [existing.supplyProfileVersion, input.supplyProfileVersion],
    [existing.modelScopeVersion, input.modelScopeVersion],
    [existing.supplyMode, input.supplyMode],
    [existing.principalKind, input.principalKind],
    [existing.principalId, input.principalId],
    [existing.authzVersion, input.authzVersion],
    [existing.entitlementVersion, input.entitlementVersion],
    [existing.configVersion, input.configVersion],
    [existing.projectPolicyVersion, input.projectPolicyVersion],
    [existing.customerMeteringPolicyId, input.customerMeteringPolicyId],
    [existing.customerMeteringPolicyVersion, input.customerMeteringPolicyVersion],
    [existing.providerMeteringPolicyId, input.providerMeteringPolicyId],
    [existing.providerMeteringPolicyVersion, input.providerMeteringPolicyVersion],
    [existing.contractAttestationId, input.contractAttestationId],
    [existing.routeConfigId, input.routeConfigId],
    [existing.routeConfigVersion, input.routeConfigVersion],
    [existing.routePublicModelId, input.routePublicModelId],
    [existing.routePublicModelVersion, input.routePublicModelVersion],
    [existing.routeProtocol, input.routeProtocol],
    [existing.routeTargetMode, input.routeTargetMode],
    [existing.routeUpstreamId, input.routeUpstreamId],
    [existing.publicModel, input.publicModel],
    [existing.protocol, input.protocol],
    [existing.endpoint, input.endpoint],
    [existing.requestFingerprint, input.requestFingerprint],
    [existing.requestFingerprintVersion, input.requestFingerprintVersion],
    [existing.idempotencyKeyDigest, input.idempotencyKeyDigest],
    [existing.customerPriceVersion, input.customerPriceVersion],
  ]);
}

function preparedAttemptFactsMatch(existing: AttemptRecord, input: NormalizedAttemptInput): boolean {
  return (
    existing.bindingState === 'bound' &&
    existing.dispatchAuthorityState === 'bound' &&
    sameFacts([
      [existing.tenantId, input.tenantId],
      [existing.requestId, input.requestId],
      [existing.projectPolicyVersion, input.projectPolicyVersion],
      [existing.customerPriceVersion, input.customerPriceVersion],
      [existing.customerMeteringPolicyId, input.customerMeteringPolicyId],
      [existing.customerMeteringPolicyVersion, input.customerMeteringPolicyVersion],
      [existing.providerMeteringPolicyId, input.providerMeteringPolicyId],
      [existing.providerMeteringPolicyVersion, input.providerMeteringPolicyVersion],
      [existing.contractAttestationId, input.contractAttestationId],
      [existing.routeConfigId, input.routeConfigId],
      [existing.routeConfigVersion, input.routeConfigVersion],
      [existing.routePublicModelId, input.routePublicModelId],
      [existing.routePublicModelVersion, input.routePublicModelVersion],
      [existing.routeProtocol, input.routeProtocol],
      [existing.routeTargetMode, input.routeTargetMode],
      [existing.ordinal, input.ordinal],
      [existing.upstreamId, input.upstreamId],
      [existing.accountOwnerKind, input.accountOwnerKind],
      [existing.accountId, input.accountId],
      [existing.providerId, input.providerId],
      [existing.productId, input.productId],
      [existing.resolvedModel, input.resolvedModel],
      [existing.modelResolution?.requestedModel, input.modelResolution.requestedModel],
      [existing.modelResolution?.mappedModel, input.modelResolution.mappedModel],
      [existing.modelResolution?.resolvedModel, input.modelResolution.resolvedModel],
      [existing.modelResolution?.mappingSource, input.modelResolution.mappingSource],
      [
        existing.modelResolution?.mappingVersion === null || existing.modelResolution?.mappingVersion === undefined
          ? null
          : String(existing.modelResolution.mappingVersion),
        input.modelResolution.mappingVersion === null ? null : String(input.modelResolution.mappingVersion),
      ],
      [existing.protocol, input.protocol],
      [existing.clientProtocol, input.clientProtocol],
      [existing.providerProtocol, input.providerProtocol],
      [existing.clientOperation, input.clientOperation],
      [existing.providerOperation, input.providerOperation],
      [existing.endpoint, input.endpoint],
      [existing.requestFingerprint, input.requestFingerprint],
      [existing.requestFingerprintVersion, input.requestFingerprintVersion],
      [existing.payloadCompilerVersion, input.payloadCompilerVersion],
      [existing.usageEstimatorVersion, input.usageEstimatorVersion],
      [existing.payloadSha256, input.payloadSha256],
      [existing.supplierCostVersion, input.supplierCostVersion],
      [existing.dispatchProfileId, input.dispatchProfileId],
      [existing.supplyProfileAuthzVersion, input.supplyProfileAuthzVersion],
      [existing.credentialId, input.credentialId],
      [existing.credentialVersion, input.credentialVersion],
      [existing.credentialAuthzVersion, input.credentialAuthzVersion],
      [existing.accountAuthzVersion, input.accountAuthzVersion],
      [existing.poolId, input.poolId],
      [existing.poolAuthzVersion, input.poolAuthzVersion],
      [existing.poolMemberAccountAuthzVersion, input.poolMemberAccountAuthzVersion],
      [existing.poolMemberAuthzVersion, input.poolMemberAuthzVersion],
      [existing.poolGrantAuthzVersion, input.poolGrantAuthzVersion],
      [existing.poolGrantProfileAuthzVersion, input.poolGrantProfileAuthzVersion],
      [existing.poolGrantPoolAuthzVersion, input.poolGrantPoolAuthzVersion],
      [existing.profileAccountAuthzVersion, input.profileAccountAuthzVersion],
    ])
  );
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate?.code === '23505' && candidate.constraint === constraint;
}

export class SaasMeteringService {
  private readonly now: () => Date;
  private readonly idempotencyHmacSecret?: HmacSecret;
  private readonly knownResponseBilling: Pick<PlatformWalletLedgerService, 'markReconciliationPending'>;

  constructor(
    private readonly database: MeteringDatabase,
    options: MeteringServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idempotencyHmacSecret = options.idempotencyHmacSecret;
    this.knownResponseBilling = options.knownResponseBilling ?? new PlatformWalletLedgerService();
  }

  /** Transaction seam for a future gateway/wallet coordinator. */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  private async write<T>(executor: SqlExecutor | undefined, work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return executor ? work(executor) : this.database.transaction(work);
  }

  private async rows<T extends Row>(executor: SqlExecutor, sql: string, values: readonly unknown[] = []): Promise<T[]> {
    try {
      const result = await executor.query<T>(sql, values);
      return result.rows;
    } catch (error) {
      if (error instanceof SaasMeteringError) throw error;
      throw new SaasMeteringError('METERING_STORAGE_ERROR', error);
    }
  }

  private async one<T extends Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.rows<T>(executor, sql, values);
    return rows[0] ?? null;
  }

  private async insertRequest(
    tx: SqlExecutor,
    input: NormalizedRequestInput,
    requestId: string,
    createdAt: string,
  ): Promise<RequestRecord> {
    const rows = await this.rows<Row>(
      tx,
      `INSERT INTO saas_requests
         (id, tenant_id, project_id, project_policy_version, proxy_key_id, entitlement_id, supply_profile_id,
          supply_profile_version, model_scope_version, supply_mode, principal_kind, principal_id,
          authz_version, entitlement_version, config_version, customer_metering_policy_id,
          customer_metering_policy_version, provider_metering_policy_id, provider_metering_policy_version,
          contract_attestation_id, route_config_id, route_config_version,
          route_public_model_id, route_public_model_version, route_protocol, route_target_mode, route_upstream_id,
          public_model, protocol, endpoint, request_fingerprint, request_fingerprint_version, customer_price_version,
          execution_state, financial_status, reconciliation_state, created_at, updated_at, state_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
               $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, 'pending', $34, 'none', $35, $35, 1)
       RETURNING ${requestColumns()}`,
      [
        requestId,
        input.tenantId,
        input.projectId,
        input.projectPolicyVersion,
        input.proxyKeyId,
        input.entitlementId,
        input.supplyProfileId,
        input.supplyProfileVersion,
        input.modelScopeVersion,
        input.supplyMode,
        input.principalKind,
        input.principalId,
        input.authzVersion,
        input.entitlementVersion,
        input.configVersion,
        input.customerMeteringPolicyId,
        input.customerMeteringPolicyVersion,
        input.providerMeteringPolicyId,
        input.providerMeteringPolicyVersion,
        input.contractAttestationId,
        input.routeConfigId,
        input.routeConfigVersion,
        input.routePublicModelId,
        input.routePublicModelVersion,
        input.routeProtocol,
        input.routeTargetMode,
        input.routeUpstreamId,
        input.publicModel,
        input.protocol,
        input.endpoint,
        input.requestFingerprint,
        input.requestFingerprintVersion,
        input.customerPriceVersion,
        input.supplyMode === 'byok' ? 'not_applicable' : 'pending',
        createdAt,
      ],
    );
    const row = rows[0];
    if (!row) fail('METERING_STORAGE_ERROR');
    return { ...mapRequest(row), idempotencyKeyDigest: input.idempotencyKeyDigest };
  }

  private async insertAttempt(
    tx: SqlExecutor,
    input: NormalizedAttemptInput,
    attemptId: string = randomUUID(),
  ): Promise<AttemptRecord> {
    const request = await this.one<Row>(
      tx,
      `SELECT id, project_policy_version, customer_price_version,
              customer_metering_policy_id, customer_metering_policy_version,
              provider_metering_policy_id, provider_metering_policy_version,
              contract_attestation_id, route_config_id, route_config_version,
              route_public_model_id, route_public_model_version, route_protocol,
              route_target_mode, route_upstream_id, supply_mode, supply_profile_id,
              public_model, request_fingerprint, request_fingerprint_version,
              protocol, endpoint
       FROM saas_requests
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [input.tenantId, input.requestId],
    );
    if (!request) fail('REQUEST_NOT_FOUND');

    const supplyMode = asSupplyMode(request.supply_mode);
    const expectedOwnerKind = supplyMode === 'byok' ? 'tenant' : 'platform';
    if (input.accountOwnerKind !== expectedOwnerKind) fail('METERING_INVALID_INPUT');
    if (supplyMode === 'byok' && input.supplierCostVersion !== null) fail('METERING_INVALID_INPUT');
    if (supplyMode === 'platform' && input.supplierCostVersion === null) fail('METERING_INVALID_INPUT');
    if (asProtocol(request.protocol) !== input.protocol) fail('METERING_INVALID_INPUT');
    if (asNonEmptyText(request.public_model, 'publicModel', 512) !== input.modelResolution.requestedModel) {
      fail('METERING_INVALID_INPUT');
    }
    if (asDigest(request.request_fingerprint) !== input.requestFingerprint) fail('METERING_INVALID_INPUT');
    if (
      asNonEmptyText(request.request_fingerprint_version, 'requestFingerprintVersion', 128) !==
      input.requestFingerprintVersion
    ) {
      fail('METERING_INVALID_INPUT');
    }
    if (asNonEmptyText(request.endpoint, 'endpoint', 1024) !== input.endpoint) fail('METERING_INVALID_INPUT');
    if (asIdentifier(request.supply_profile_id) !== input.dispatchProfileId) fail('METERING_INVALID_INPUT');
    const requestPolicyVersion = asOptionalStoredVersion(request.project_policy_version, 'projectPolicyVersion');
    if (requestPolicyVersion === null || requestPolicyVersion !== input.projectPolicyVersion) {
      fail('METERING_INVALID_INPUT');
    }
    if (
      asOptionalStoredText(request.customer_metering_policy_id) !== input.customerMeteringPolicyId ||
      asOptionalStoredVersion(request.customer_metering_policy_version, 'customerMeteringPolicyVersion') !==
        input.customerMeteringPolicyVersion ||
      asOptionalStoredText(request.provider_metering_policy_id) !== input.providerMeteringPolicyId ||
      asOptionalStoredVersion(request.provider_metering_policy_version, 'providerMeteringPolicyVersion') !==
        input.providerMeteringPolicyVersion ||
      asOptionalStoredText(request.contract_attestation_id) !== input.contractAttestationId ||
      (request.customer_price_version === null || request.customer_price_version === undefined
        ? null
        : asNonEmptyText(request.customer_price_version, 'customerPriceVersion', 128)) !== input.customerPriceVersion
    ) {
      fail('METERING_INVALID_INPUT');
    }
    if (
      asOptionalStoredText(request.route_config_id) !== input.routeConfigId ||
      asOptionalStoredVersion(request.route_config_version, 'routeConfigVersion') !== input.routeConfigVersion ||
      asOptionalStoredText(request.route_public_model_id) !== input.routePublicModelId ||
      asOptionalStoredVersion(request.route_public_model_version, 'routePublicModelVersion') !==
        input.routePublicModelVersion ||
      (request.route_protocol === null || request.route_protocol === undefined
        ? null
        : asProtocol(request.route_protocol)) !== input.routeProtocol ||
      request.route_target_mode !== input.routeTargetMode ||
      asOptionalStoredText(request.route_upstream_id) !== input.upstreamId
    ) {
      fail('METERING_INVALID_INPUT');
    }

    const existingOrdinal = await this.one<Row>(
      tx,
      `SELECT id
       FROM saas_attempts
       WHERE tenant_id = $1 AND request_id = $2 AND ordinal = $3
       FOR UPDATE`,
      [input.tenantId, input.requestId, input.ordinal],
    );
    if (existingOrdinal) fail('ATTEMPT_ORDINAL_CONFLICT');

    const createdAt = normalizeNow(this.now);
    try {
      const rows = await this.rows<Row>(
        tx,
        `INSERT INTO saas_attempts
           (id, tenant_id, request_id, project_policy_version, customer_price_version,
            customer_metering_policy_id, customer_metering_policy_version,
            provider_metering_policy_id, provider_metering_policy_version, contract_attestation_id,
            route_config_id, route_config_version,
            route_public_model_id, route_public_model_version, route_protocol, route_target_mode,
            ordinal, upstream_id, binding_state, dispatch_authority_state,
            account_owner_kind, tenant_account_id, platform_account_id, provider_id, product_id,
            resolved_model, protocol, endpoint, supplier_cost_version,
            dispatch_profile_id, supply_profile_authz_version, credential_id, credential_version,
            credential_authz_version, account_authz_version, pool_id, pool_authz_version,
            pool_member_account_authz_version, pool_member_authz_version, pool_grant_authz_version,
            pool_grant_profile_authz_version, pool_grant_pool_authz_version,
            profile_account_authz_version,
            model_resolution_requested_model, model_resolution_mapped_model,
            model_resolution_mapping_source, model_resolution_mapping_version,
            provider_protocol, client_operation, provider_operation,
            request_fingerprint, request_fingerprint_version,
            payload_compiler_version, usage_estimator_version, payload_sha256,
            dispatch_state, result_state, response_started, created_at, updated_at, state_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 'bound', 'bound', $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
                 $34, $35, $36, $37, $38, $39, $40, $41,
                 $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53,
                 'not_sent', 'pending', FALSE, $54, $54, 1)
         RETURNING ${attemptColumns}`,
        [
          attemptId,
          input.tenantId,
          input.requestId,
          input.projectPolicyVersion,
          input.customerPriceVersion,
          input.customerMeteringPolicyId,
          input.customerMeteringPolicyVersion,
          input.providerMeteringPolicyId,
          input.providerMeteringPolicyVersion,
          input.contractAttestationId,
          input.routeConfigId,
          input.routeConfigVersion,
          input.routePublicModelId,
          input.routePublicModelVersion,
          input.routeProtocol,
          input.routeTargetMode,
          input.ordinal,
          input.upstreamId,
          input.accountOwnerKind,
          input.accountOwnerKind === 'tenant' ? input.accountId : null,
          input.accountOwnerKind === 'platform' ? input.accountId : null,
          input.providerId,
          input.productId,
          input.resolvedModel,
          input.protocol,
          input.endpoint,
          input.supplierCostVersion,
          input.dispatchProfileId,
          input.supplyProfileAuthzVersion,
          input.credentialId,
          input.credentialVersion,
          input.credentialAuthzVersion,
          input.accountAuthzVersion,
          input.poolId,
          input.poolAuthzVersion,
          input.poolMemberAccountAuthzVersion,
          input.poolMemberAuthzVersion,
          input.poolGrantAuthzVersion,
          input.poolGrantProfileAuthzVersion,
          input.poolGrantPoolAuthzVersion,
          input.profileAccountAuthzVersion,
          input.modelResolution.requestedModel,
          input.modelResolution.mappedModel,
          input.modelResolution.mappingSource,
          input.modelResolution.mappingVersion,
          input.providerProtocol,
          input.clientOperation,
          input.providerOperation,
          input.requestFingerprint,
          input.requestFingerprintVersion,
          input.payloadCompilerVersion,
          input.usageEstimatorVersion,
          input.payloadSha256,
          createdAt,
        ],
      );
      const row = rows[0];
      if (!row) fail('METERING_STORAGE_ERROR');
      return mapAttempt(row);
    } catch (error) {
      const cause = error instanceof SaasMeteringError ? error.cause : error;
      if (isUniqueViolation(cause, 'saas_attempts_request_ordinal_unique')) fail('ATTEMPT_ORDINAL_CONFLICT');
      if (error instanceof SaasMeteringError) throw error;
      throw new SaasMeteringError('METERING_STORAGE_ERROR', error);
    }
  }

  private async replayPreparedAdmission(
    tx: SqlExecutor,
    normalized: NormalizedRequestInput,
    normalizedAttempt: NormalizedAttemptInput,
    requestId: string,
    attemptId: string,
    existingRequest: RequestRecord,
  ): Promise<PreparedRequestAdmissionReplay> {
    if (existingRequest.id !== requestId || !preparedRequestFactsMatch(existingRequest, normalized)) {
      fail('IDEMPOTENCY_CONFLICT');
    }

    const existingAttempt = await this.getAttempt(existingRequest.tenantId, requestId, attemptId, { executor: tx });
    if (!existingAttempt) {
      const existingOrdinal = await this.one<Row>(
        tx,
        `SELECT id
         FROM saas_attempts
         WHERE tenant_id = $1 AND request_id = $2 AND ordinal = $3
         FOR UPDATE`,
        [normalizedAttempt.tenantId, normalizedAttempt.requestId, normalizedAttempt.ordinal],
      );
      if (existingOrdinal) fail('IDEMPOTENCY_CONFLICT');
      fail('METERING_STORAGE_ERROR');
    }
    if (existingAttempt.id !== attemptId || !preparedAttemptFactsMatch(existingAttempt, normalizedAttempt)) {
      fail('IDEMPOTENCY_CONFLICT');
    }

    let idempotency: IdempotencyRecord | null = null;
    if (normalized.idempotencyKeyDigest !== null) {
      const row = await this.one<Row>(
        tx,
        `SELECT id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                request_fingerprint_version, request_id, kind, created_at
         FROM saas_idempotency_records
         WHERE tenant_id = $1 AND proxy_key_id = $2 AND key_digest = $3
         FOR UPDATE`,
        [normalized.tenantId, normalized.proxyKeyId, normalized.idempotencyKeyDigest],
      );
      if (!row) fail('METERING_STORAGE_ERROR');
      idempotency = mapIdempotency(row);
      if (idempotency.kind === 'tombstone') fail('IDEMPOTENCY_TOMBSTONED');
      if (
        idempotency.requestId !== requestId ||
        idempotency.requestFingerprint !== normalized.requestFingerprint ||
        idempotency.requestFingerprintVersion !== normalized.requestFingerprintVersion
      ) {
        fail('IDEMPOTENCY_CONFLICT');
      }
    }

    return {
      kind: 'replayed',
      request: existingRequest,
      idempotency,
      initialAttempt: existingAttempt,
    };
  }

  /**
   * Admit a request whose identities were already issued by request
   * preparation.  A caller composing wallet, outbox, and audit writes must
   * pass the already-open transaction through `options.executor`; this method
   * never opens a nested transaction in that case.  Without an executor, the
   * atomic boundary is intentionally limited to metering rows.
   */
  async admitPreparedRequest(
    input: PreparedRequestAdmissionInput,
    options?: MeteringOperationOptions,
  ): Promise<PreparedRequestAdmission>;
  async admitPreparedRequest(
    input: CreateRequestInput,
    identity: PreparedRequestIdentity & MeteringOperationOptions,
  ): Promise<PreparedRequestAdmission>;
  async admitPreparedRequest(
    input: CreateRequestInput,
    identity: PreparedRequestIdentity,
    options?: MeteringOperationOptions,
  ): Promise<PreparedRequestAdmission>;
  async admitPreparedRequest(
    input: CreateRequestInput | PreparedRequestAdmissionInput,
    identityOrOptions: PreparedRequestIdentity | MeteringOperationOptions = {},
    options: MeteringOperationOptions = {},
  ): Promise<PreparedRequestAdmission> {
    const inlineIdentity = isPreparedRequestInput(input);
    const identity = inlineIdentity
      ? { requestId: input.requestId, attemptId: input.attemptId }
      : (identityOrOptions as PreparedRequestIdentity);
    const operationOptions = inlineIdentity
      ? (identityOrOptions as MeteringOperationOptions)
      : 'executor' in identityOrOptions
        ? (identityOrOptions as MeteringOperationOptions)
        : options;
    const normalized = normalizeRequest(input, this.idempotencyHmacSecret);
    const requestId = asIdentifier(identity.requestId);
    const attemptId = asIdentifier(identity.attemptId);
    if (!normalized.initialAttempt) fail('METERING_INVALID_INPUT');
    const normalizedAttempt = normalizeInitialAttempt(
      normalized.initialAttempt,
      normalized.tenantId,
      requestId,
      normalized.supplyMode,
      normalized,
      normalized.customerPriceVersion,
    );
    const createdAt = normalizeNow(this.now);

    return this.write(operationOptions.executor, async (tx) => {
      const existingRequest = await this.getRequest(normalized.tenantId, requestId, { executor: tx });
      const existingAttemptIdentity = await this.one<Row>(
        tx,
        `SELECT id
         FROM saas_attempts
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE`,
        [normalized.tenantId, attemptId],
      );
      if (existingAttemptIdentity && !existingRequest) fail('IDEMPOTENCY_CONFLICT');
      if (existingRequest) {
        return this.replayPreparedAdmission(tx, normalized, normalizedAttempt, requestId, attemptId, existingRequest);
      }

      let idempotency: IdempotencyRecord | null = null;
      if (normalized.idempotencyKeyDigest !== null) {
        const inserted = await this.rows<Row>(
          tx,
          `INSERT INTO saas_idempotency_records
             (id, tenant_id, proxy_key_id, key_digest, request_fingerprint, request_fingerprint_version,
              request_id, kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
           ON CONFLICT (tenant_id, proxy_key_id, key_digest)
           DO UPDATE SET key_digest = saas_idempotency_records.key_digest
           WHERE FALSE
           RETURNING id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                     request_fingerprint_version, request_id, kind, created_at`,
          [
            randomUUID(),
            normalized.tenantId,
            normalized.proxyKeyId,
            normalized.idempotencyKeyDigest,
            normalized.requestFingerprint,
            normalized.requestFingerprintVersion,
            requestId,
            createdAt,
          ],
        );
        if (inserted[0]) {
          idempotency = mapIdempotency(inserted[0]);
        } else {
          const existing = await this.one<Row>(
            tx,
            `SELECT id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                    request_fingerprint_version, request_id, kind, created_at
             FROM saas_idempotency_records
             WHERE tenant_id = $1 AND proxy_key_id = $2 AND key_digest = $3
             FOR UPDATE`,
            [normalized.tenantId, normalized.proxyKeyId, normalized.idempotencyKeyDigest],
          );
          if (!existing) fail('METERING_STORAGE_ERROR');
          idempotency = mapIdempotency(existing);
          if (
            idempotency.requestFingerprint !== normalized.requestFingerprint ||
            idempotency.requestFingerprintVersion !== normalized.requestFingerprintVersion
          ) {
            fail('IDEMPOTENCY_CONFLICT');
          }
          if (idempotency.kind === 'tombstone') return { kind: 'tombstone', idempotency };
          if (idempotency.requestId === null) fail('METERING_STORAGE_ERROR');
          if (idempotency.requestId !== requestId) fail('IDEMPOTENCY_CONFLICT');
          const existingRequestByKey = await this.getRequest(normalized.tenantId, requestId, { executor: tx });
          if (!existingRequestByKey) fail('METERING_STORAGE_ERROR');
          return this.replayPreparedAdmission(
            tx,
            normalized,
            normalizedAttempt,
            requestId,
            attemptId,
            existingRequestByKey,
          );
        }
      }

      let request: RequestRecord;
      try {
        request = await this.insertRequest(tx, normalized, requestId, createdAt);
      } catch (error) {
        const cause = error instanceof SaasMeteringError ? error.cause : error;
        if (isUniqueViolation(cause, 'saas_requests_tenant_id_unique')) fail('IDEMPOTENCY_CONFLICT');
        throw error;
      }

      let initialAttempt: AttemptRecord;
      try {
        initialAttempt = await this.insertAttempt(tx, normalizedAttempt, attemptId);
      } catch (error) {
        const cause = error instanceof SaasMeteringError ? error.cause : error;
        if (isUniqueViolation(cause, 'saas_attempts_tenant_id_unique')) fail('IDEMPOTENCY_CONFLICT');
        throw error;
      }
      return { kind: 'created', request, idempotency, initialAttempt };
    });
  }

  async admitRequest(input: CreateRequestInput, options: MeteringOperationOptions = {}): Promise<RequestAdmission> {
    const normalized = normalizeRequest(input, this.idempotencyHmacSecret);
    const requestId = randomUUID();
    const createdAt = normalizeNow(this.now);

    return this.write(options.executor, async (tx) => {
      let idempotency: IdempotencyRecord | null = null;
      if (normalized.idempotencyKeyDigest !== null) {
        const inserted = await this.rows<Row>(
          tx,
          `INSERT INTO saas_idempotency_records
             (id, tenant_id, proxy_key_id, key_digest, request_fingerprint, request_fingerprint_version,
              request_id, kind, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
           ON CONFLICT (tenant_id, proxy_key_id, key_digest)
           DO UPDATE SET key_digest = saas_idempotency_records.key_digest
           WHERE FALSE
           RETURNING id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                     request_fingerprint_version, request_id, kind, created_at`,
          [
            randomUUID(),
            normalized.tenantId,
            normalized.proxyKeyId,
            normalized.idempotencyKeyDigest,
            normalized.requestFingerprint,
            normalized.requestFingerprintVersion,
            requestId,
            createdAt,
          ],
        );
        if (inserted[0]) {
          idempotency = mapIdempotency(inserted[0]);
        } else {
          const existing = await this.one<Row>(
            tx,
            `SELECT id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                    request_fingerprint_version, request_id, kind, created_at
             FROM saas_idempotency_records
             WHERE tenant_id = $1 AND proxy_key_id = $2 AND key_digest = $3
             FOR UPDATE`,
            [normalized.tenantId, normalized.proxyKeyId, normalized.idempotencyKeyDigest],
          );
          if (!existing) fail('METERING_STORAGE_ERROR');
          idempotency = mapIdempotency(existing);
          if (
            idempotency.requestFingerprint !== normalized.requestFingerprint ||
            idempotency.requestFingerprintVersion !== normalized.requestFingerprintVersion
          ) {
            fail('IDEMPOTENCY_CONFLICT');
          }
          if (idempotency.kind === 'tombstone') fail('IDEMPOTENCY_TOMBSTONED');
          if (idempotency.requestId === null) fail('METERING_STORAGE_ERROR');
          const existingRequest = await this.getRequest(normalized.tenantId, idempotency.requestId, { executor: tx });
          if (!existingRequest) fail('METERING_STORAGE_ERROR');
          return { kind: 'replayed', request: existingRequest, idempotency };
        }
      }

      const request = await this.insertRequest(tx, normalized, requestId, createdAt);
      const initialAttempt = normalized.initialAttempt
        ? await this.insertAttempt(
            tx,
            normalizeInitialAttempt(
              normalized.initialAttempt,
              normalized.tenantId,
              requestId,
              normalized.supplyMode,
              normalized,
              normalized.customerPriceVersion,
            ),
          )
        : null;
      return { kind: 'created', request, idempotency, initialAttempt };
    });
  }

  async createRequest(input: CreateRequestInput, options: MeteringOperationOptions = {}): Promise<RequestAdmission> {
    return this.admitRequest(input, options);
  }

  async tombstoneIdempotencyKey(
    input: CreateIdempotencyTombstoneInput,
    options: MeteringOperationOptions = {},
  ): Promise<IdempotencyRecord> {
    const tenantId = asIdentifier(input.tenantId);
    const proxyKeyId = asIdentifier(input.proxyKeyId);
    const idempotencyKey = asNonEmptyText(input.idempotencyKey, 'idempotencyKey', 4096);
    const requestFingerprintVersion = asNonEmptyText(input.requestFingerprintVersion, 'requestFingerprintVersion', 64);
    const requestFingerprint = normalizeFingerprint(input.requestFingerprint, requestFingerprintVersion);
    const keyDigest = digestClientKey(idempotencyKey, this.idempotencyHmacSecret);
    const createdAt = normalizeNow(this.now);
    return this.write(options.executor, async (tx) => {
      const inserted = await this.rows<Row>(
        tx,
        `INSERT INTO saas_idempotency_records
           (id, tenant_id, proxy_key_id, key_digest, request_fingerprint, request_fingerprint_version,
            request_id, kind, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, 'tombstone', $7)
         ON CONFLICT (tenant_id, proxy_key_id, key_digest)
         DO UPDATE SET key_digest = saas_idempotency_records.key_digest
         WHERE FALSE
         RETURNING id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                   request_fingerprint_version, request_id, kind, created_at`,
        [randomUUID(), tenantId, proxyKeyId, keyDigest, requestFingerprint, requestFingerprintVersion, createdAt],
      );
      if (inserted[0]) return mapIdempotency(inserted[0]);
      const existing = await this.one<Row>(
        tx,
        `SELECT id, tenant_id, proxy_key_id, key_digest, request_fingerprint,
                request_fingerprint_version, request_id, kind, created_at
         FROM saas_idempotency_records
         WHERE tenant_id = $1 AND proxy_key_id = $2 AND key_digest = $3
         FOR UPDATE`,
        [tenantId, proxyKeyId, keyDigest],
      );
      if (!existing) fail('METERING_STORAGE_ERROR');
      const record = mapIdempotency(existing);
      if (
        record.kind !== 'tombstone' ||
        record.requestFingerprint !== requestFingerprint ||
        record.requestFingerprintVersion !== requestFingerprintVersion
      ) {
        fail('IDEMPOTENCY_CONFLICT');
      }
      return record;
    });
  }

  async createAttempt(input: CreateAttemptInput, options: MeteringOperationOptions = {}): Promise<AttemptRecord> {
    return this.write(options.executor, (tx) => this.insertAttempt(tx, normalizeAttempt(input)));
  }

  async prepareAttempt(input: CreateAttemptInput, options: MeteringOperationOptions = {}): Promise<AttemptRecord> {
    return this.createAttempt(input, options);
  }

  async transitionAttempt(input: AttemptTransitionInput): Promise<AttemptRecord> {
    const expectedDispatchState = asDispatchState(input.expectedDispatchState);
    const expectedResultState = asResultState(input.expectedResultState);
    const expectedResponseStarted = input.expectedResponseStarted;
    if (typeof expectedResponseStarted !== 'boolean') fail('METERING_INVALID_INPUT');
    const dispatchState =
      input.dispatchState === undefined ? expectedDispatchState : asDispatchState(input.dispatchState);
    const resultState = input.resultState === undefined ? expectedResultState : asResultState(input.resultState);
    const responseStarted = input.responseStarted === undefined ? expectedResponseStarted : input.responseStarted;
    if (typeof responseStarted !== 'boolean' || (responseStarted === false && expectedResponseStarted === true)) {
      fail('ATTEMPT_TRANSITION_INVALID');
    }
    if (!attemptDispatchTransitionAllowed(expectedDispatchState, dispatchState)) fail('ATTEMPT_TRANSITION_INVALID');
    if (!resultTransitionAllowed(expectedResultState, resultState)) fail('ATTEMPT_TRANSITION_INVALID');
    if (dispatchState === 'not_sent' && resultState !== 'pending') fail('ATTEMPT_TRANSITION_INVALID');
    if (resultState === 'unknown' && dispatchState === 'not_sent') fail('ATTEMPT_TRANSITION_INVALID');
    if (
      (resultState === 'succeeded' || resultState === 'failed') &&
      dispatchState !== 'sent' &&
      dispatchState !== 'unknown'
    ) {
      fail('ATTEMPT_TRANSITION_INVALID');
    }
    if (responseStarted && dispatchState !== 'sent' && dispatchState !== 'unknown') {
      fail('ATTEMPT_TRANSITION_INVALID');
    }
    const unknown = dispatchState === 'unknown' || resultState === 'unknown';
    const unknownReason = unknown ? asNonEmptyText(input.unknownReason, 'unknownReason', 1024) : null;
    const hasHttpStatus = input.resultHttpStatus !== undefined;
    const httpStatus = input.resultHttpStatus === undefined ? null : asNullableHttpStatus(input.resultHttpStatus);
    const tenantId = asIdentifier(input.tenantId);
    const requestId = asIdentifier(input.requestId);
    const attemptId = asIdentifier(input.attemptId);
    const updatedAt = normalizeNow(this.now);

    return this.write(input.executor, async (tx) => {
      const rows = await this.rows<Row>(
        tx,
        `UPDATE saas_attempts
         SET dispatch_state = $4,
             result_state = $5,
             response_started = (response_started OR $6),
             response_started_at = CASE
               WHEN response_started THEN response_started_at
               WHEN $6 THEN $7
               ELSE response_started_at
             END,
             result_http_status = CASE WHEN $8 THEN $9 ELSE result_http_status END,
             unknown_reason = $10,
             updated_at = $7,
             state_version = state_version + 1
         WHERE tenant_id = $1 AND request_id = $2 AND id = $3
           AND dispatch_state = $11
           AND result_state = $12
           AND response_started = $13
           AND ($14::bigint IS NULL OR state_version = $14)
         RETURNING ${attemptColumns}`,
        [
          tenantId,
          requestId,
          attemptId,
          dispatchState,
          resultState,
          responseStarted,
          updatedAt,
          hasHttpStatus,
          httpStatus,
          unknownReason,
          expectedDispatchState,
          expectedResultState,
          expectedResponseStarted,
          input.expectedStateVersion ?? null,
        ],
      );
      const row = rows[0];
      if (row) return mapAttempt(row);
      const existing = await this.one<Row>(
        tx,
        `SELECT ${attemptColumns}
         FROM saas_attempts
         WHERE tenant_id = $1 AND request_id = $2 AND id = $3`,
        [tenantId, requestId, attemptId],
      );
      if (!existing) fail('ATTEMPT_NOT_FOUND');
      fail('ATTEMPT_TRANSITION_INVALID');
    });
  }

  /** Persist a complete non-2xx response while retaining any unresolved platform hold. */
  async recordKnownNonSuccessHttpResponse(input: KnownNonSuccessHttpResponseInput): Promise<AttemptRecord> {
    const tenantId = asIdentifier(input.tenantId);
    const requestId = asIdentifier(input.requestId);
    const attemptId = asIdentifier(input.attemptId);
    if (
      !Number.isSafeInteger(input.resultHttpStatus) ||
      input.resultHttpStatus < 300 ||
      input.resultHttpStatus > 599 ||
      typeof input.responseStarted !== 'boolean'
    ) {
      fail('METERING_INVALID_INPUT');
    }

    return this.database.transaction(async (tx) => {
      const state = await this.one<KnownHttpResponseStateRow>(
        tx,
        `SELECT a.id AS attempt_id, a.tenant_id AS attempt_tenant_id,
                a.request_id AS attempt_request_id, a.dispatch_state AS attempt_dispatch_state,
                a.result_state AS attempt_result_state, a.response_started AS attempt_response_started,
                a.result_http_status AS attempt_result_http_status, a.state_version AS attempt_state_version,
                r.id AS request_id, r.tenant_id AS request_tenant_id, r.supply_mode AS request_supply_mode,
                r.execution_state AS request_result_state, r.reconciliation_state AS request_reconciliation_state,
                r.financial_status AS request_financial_status, r.state_version AS request_state_version
           FROM saas_attempts a
           JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
          WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3
          FOR UPDATE OF a, r`,
        [tenantId, requestId, attemptId],
      );
      if (
        !state ||
        state.attempt_tenant_id !== tenantId ||
        state.attempt_request_id !== requestId ||
        state.attempt_id !== attemptId ||
        state.request_tenant_id !== tenantId ||
        state.request_id !== requestId
      ) {
        fail('ATTEMPT_NOT_FOUND');
      }

      const supplyMode = state.request_supply_mode;
      if (supplyMode !== 'platform' && supplyMode !== 'byok') fail('METERING_STORAGE_ERROR');
      const finalFinancialStatus = supplyMode === 'platform' ? 'reconciliation_pending' : 'not_applicable';
      const alreadyClassified =
        state.attempt_dispatch_state === 'sent' &&
        state.attempt_result_state === 'failed' &&
        state.request_result_state === 'failed' &&
        state.request_reconciliation_state === 'none' &&
        state.request_financial_status === finalFinancialStatus;
      if (alreadyClassified) {
        if (state.attempt_result_http_status !== input.resultHttpStatus) fail('ATTEMPT_TRANSITION_INVALID');
        await this.ensureKnownHttpFailureHold(tx, {
          tenantId,
          requestId,
          attemptId,
          supplyMode,
          resultHttpStatus: input.resultHttpStatus,
        });
        const replayed = await this.getAttempt(tenantId, requestId, attemptId, { executor: tx });
        if (!replayed) fail('ATTEMPT_NOT_FOUND');
        return replayed;
      }

      const dispatchState = state.attempt_dispatch_state;
      if (
        (dispatchState !== 'dispatching' && dispatchState !== 'sent') ||
        state.attempt_result_state !== 'pending' ||
        state.request_result_state !== 'pending' ||
        state.request_reconciliation_state !== 'none' ||
        (supplyMode === 'platform' &&
          state.request_financial_status !== 'pending' &&
          state.request_financial_status !== 'reconciliation_pending') ||
        (supplyMode === 'byok' && state.request_financial_status !== 'not_applicable')
      ) {
        fail('ATTEMPT_TRANSITION_INVALID');
      }

      const expectedAttemptVersion = asStateVersion(state.attempt_state_version);
      const expectedRequestVersion = asStateVersion(state.request_state_version);
      const expectedResponseStarted = state.attempt_response_started === true;
      const attempt = await this.transitionAttempt({
        executor: tx,
        tenantId,
        requestId,
        attemptId,
        expectedDispatchState: dispatchState,
        expectedResultState: 'pending',
        expectedResponseStarted,
        expectedStateVersion: expectedAttemptVersion,
        dispatchState: 'sent',
        resultState: 'failed',
        // A complete HTTP status line is definitive evidence that an upstream
        // response started, even when the transport's body-start flag is false.
        responseStarted: true,
        resultHttpStatus: input.resultHttpStatus,
        unknownReason: null,
      });
      const request = await this.transitionRequest({
        executor: tx,
        tenantId,
        requestId,
        expectedResultState: 'pending',
        expectedReconciliationState: 'none',
        expectedStateVersion: expectedRequestVersion,
        resultState: 'failed',
        reconciliationState: 'none',
      });
      await this.ensureKnownHttpFailureHold(tx, {
        tenantId,
        requestId,
        attemptId,
        supplyMode,
        resultHttpStatus: input.resultHttpStatus,
      });
      if (supplyMode === 'platform' && state.request_financial_status === 'pending') {
        await this.transitionFinancialStatus({
          executor: tx,
          tenantId,
          requestId,
          expectedFinancialStatus: 'pending',
          financialStatus: 'reconciliation_pending',
          expectedStateVersion: request.stateVersion,
        });
      }
      return attempt;
    });
  }

  private async ensureKnownHttpFailureHold(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly requestId: string;
      readonly attemptId: string;
      readonly supplyMode: 'platform' | 'byok';
      readonly resultHttpStatus: number;
    },
  ): Promise<void> {
    if (input.supplyMode === 'byok') return;
    const reservation = await this.knownResponseBilling.markReconciliationPending(executor, {
      supplyMode: 'platform',
      tenantId: input.tenantId,
      requestId: input.requestId,
      evidenceRef: `gateway-http-non-success:${input.attemptId}:${input.resultHttpStatus}`,
      businessKey: `saas-request-admission:${input.tenantId}:${input.requestId}`,
      idempotencyNamespace: BILLING_RESERVATION_NAMESPACE,
    });
    if (reservation.state !== 'reconciliation_pending') fail('REQUEST_TRANSITION_INVALID');
  }

  async transitionRequest(input: RequestTransitionInput): Promise<RequestRecord> {
    const expectedResultState = asResultState(input.expectedResultState);
    const expectedReconciliationState = asReconciliationState(input.expectedReconciliationState);
    const resultState = input.resultState === undefined ? expectedResultState : asResultState(input.resultState);
    const reconciliationState =
      input.reconciliationState === undefined
        ? expectedReconciliationState
        : asReconciliationState(input.reconciliationState);
    if (!resultTransitionAllowed(expectedResultState, resultState)) fail('REQUEST_TRANSITION_INVALID');
    if (!requestReconciliationTransitionAllowed(expectedReconciliationState, reconciliationState)) {
      fail('REQUEST_TRANSITION_INVALID');
    }
    if (resultState === 'unknown' && reconciliationState !== 'pending') fail('REQUEST_TRANSITION_INVALID');
    if (resultState !== 'unknown' && expectedResultState === 'unknown' && reconciliationState !== 'resolved') {
      fail('REQUEST_TRANSITION_INVALID');
    }
    const tenantId = asIdentifier(input.tenantId);
    const requestId = asIdentifier(input.requestId);
    const updatedAt = normalizeNow(this.now);
    return this.write(input.executor, async (tx) => {
      const rows = await this.rows<Row>(
        tx,
        `UPDATE saas_requests
         SET execution_state = $3,
             reconciliation_state = $4,
             updated_at = $5,
             state_version = state_version + 1
         WHERE tenant_id = $1 AND id = $2
           AND execution_state = $6
           AND reconciliation_state = $7
           AND ($8::bigint IS NULL OR state_version = $8)
         RETURNING ${requestColumns()}`,
        [
          tenantId,
          requestId,
          resultState,
          reconciliationState,
          updatedAt,
          expectedResultState,
          expectedReconciliationState,
          input.expectedStateVersion ?? null,
        ],
      );
      const row = rows[0];
      if (row) return mapRequest(row);
      const existing = await this.one<Row>(
        tx,
        `SELECT ${requestColumns()}
         FROM saas_requests
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      );
      if (!existing) fail('REQUEST_NOT_FOUND');
      fail('REQUEST_TRANSITION_INVALID');
    });
  }

  async transitionFinancialStatus(input: FinancialTransitionInput): Promise<RequestRecord> {
    const expectedFinancialStatus = asFinancialStatus(input.expectedFinancialStatus);
    const financialStatus = asFinancialStatus(input.financialStatus);
    if (!financialTransitionAllowed(expectedFinancialStatus, financialStatus)) {
      fail('REQUEST_TRANSITION_INVALID');
    }
    const tenantId = asIdentifier(input.tenantId);
    const requestId = asIdentifier(input.requestId);
    const updatedAt = normalizeNow(this.now);
    return this.write(input.executor, async (tx) => {
      const rows = await this.rows<Row>(
        tx,
        `UPDATE saas_requests
         SET financial_status = $3,
             updated_at = $4,
             state_version = state_version + 1
         WHERE tenant_id = $1 AND id = $2
           AND financial_status = $5
           AND ($6::bigint IS NULL OR state_version = $6)
         RETURNING ${requestColumns()}`,
        [tenantId, requestId, financialStatus, updatedAt, expectedFinancialStatus, input.expectedStateVersion ?? null],
      );
      const row = rows[0];
      if (row) return mapRequest(row);
      const existing = await this.one<Row>(
        tx,
        `SELECT ${requestColumns()}
         FROM saas_requests
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, requestId],
      );
      if (!existing) fail('REQUEST_NOT_FOUND');
      fail('REQUEST_TRANSITION_INVALID');
    });
  }

  async recordUsageEvent(
    input: RecordUsageEventInput,
    options: MeteringOperationOptions = {},
  ): Promise<UsageEventRecord> {
    const tenantId = asIdentifier(input.tenantId);
    const requestId = asIdentifier(input.requestId);
    const attemptId = asIdentifier(input.attemptId);
    const supplyMode = asSupplyMode(input.supplyMode);
    const usage = normalizeUsage(input.usage);
    const eventDigest = usageEventDigest({ tenantId, requestId, attemptId, supplyMode }, usage);
    const dedupeKeyDigest =
      input.eventKey === undefined || input.eventKey === null
        ? eventDigest
        : digestClientKey(asNonEmptyText(input.eventKey, 'eventKey', 4096), this.idempotencyHmacSecret);
    return this.write(options.executor, async (tx) => {
      const attempt = await this.one<Row>(
        tx,
        `SELECT a.id, r.supply_mode
         FROM saas_attempts a
         JOIN saas_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
         WHERE a.tenant_id = $1 AND a.request_id = $2 AND a.id = $3
         LIMIT 1`,
        [tenantId, requestId, attemptId],
      );
      if (!attempt) fail('ATTEMPT_NOT_FOUND');
      if (attempt.supply_mode !== supplyMode) fail('METERING_INVALID_INPUT');

      const inserted = await this.rows<Row>(
        tx,
        `INSERT INTO saas_usage_events
           (id, tenant_id, request_id, attempt_id, supply_mode, dedupe_key_digest, event_digest,
            input_total, input_uncached, cache_read, cache_write, cache_write_5m, cache_write_1h,
            output_total, reasoning_output, status, source, semantics_version, measurement_kind,
            billable_basis, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (tenant_id, attempt_id, dedupe_key_digest)
         DO UPDATE SET event_digest = saas_usage_events.event_digest
         WHERE FALSE
         RETURNING ${usageColumns}`,
        [
          randomUUID(),
          tenantId,
          requestId,
          attemptId,
          supplyMode,
          dedupeKeyDigest,
          eventDigest,
          usage.inputTotal,
          usage.inputUncached,
          usage.cacheRead,
          usage.cacheWrite,
          usage.cacheWrite5m,
          usage.cacheWrite1h,
          usage.outputTotal,
          usage.reasoningOutput,
          usage.status,
          usage.source,
          usage.semanticsVersion,
          usage.measurementKind,
          usage.billableBasis,
          normalizeNow(this.now),
        ],
      );
      if (inserted[0]) return mapUsage(inserted[0]);
      const existing = await this.one<Row>(
        tx,
        `SELECT ${usageColumns}
         FROM saas_usage_events
         WHERE tenant_id = $1 AND attempt_id = $2 AND dedupe_key_digest = $3
         FOR UPDATE`,
        [tenantId, attemptId, dedupeKeyDigest],
      );
      if (!existing) fail('METERING_STORAGE_ERROR');
      const existingUsage = mapUsage(existing);
      if (existingUsage.eventDigest !== eventDigest || !sameUsage(existingUsage, usage)) {
        fail('USAGE_DUPLICATE_CONFLICT');
      }
      return existingUsage;
    });
  }

  async recordUsage(input: RecordUsageEventInput, options: MeteringOperationOptions = {}): Promise<UsageEventRecord> {
    return this.recordUsageEvent(input, options);
  }

  async createUsageSettlement(
    input: RecordUsageSettlementInput,
    options: MeteringOperationOptions = {},
  ): Promise<UsageSettlementRecord> {
    const tenantId = asIdentifier(input.tenantId);
    const usageEventId = asIdentifier(input.usageEventId);
    const settlementKeyDigest = digestClientKey(
      asNonEmptyText(input.settlementKey, 'settlementKey', 4096),
      this.idempotencyHmacSecret,
    );
    const kind = input.settlementKind ?? 'usage_recorded';
    if (kind !== 'usage_recorded' && kind !== 'platform_cost_observed') fail('METERING_INVALID_INPUT');

    return this.write(options.executor, async (tx) => {
      const usage = await this.one<Row>(
        tx,
        `SELECT id, tenant_id, request_id, attempt_id, event_digest
         FROM saas_usage_events
         WHERE tenant_id = $1 AND id = $2
         LIMIT 1`,
        [tenantId, usageEventId],
      );
      if (!usage) fail('USAGE_EVENT_NOT_FOUND');
      const digest = settlementDigest({
        tenantId,
        usageEventId,
        kind,
        usageEventDigest: asDigest(usage.event_digest),
      });
      const inserted = await this.rows<Row>(
        tx,
        `INSERT INTO saas_usage_settlements
           (id, tenant_id, usage_event_id, request_id, attempt_id, settlement_key_digest,
            settlement_digest, kind, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT
         DO UPDATE SET settlement_digest = saas_usage_settlements.settlement_digest
         WHERE FALSE
         RETURNING id, tenant_id, usage_event_id, request_id, attempt_id,
                   settlement_key_digest, settlement_digest, kind, created_at`,
        [
          randomUUID(),
          tenantId,
          usageEventId,
          usage.request_id,
          usage.attempt_id,
          settlementKeyDigest,
          digest,
          kind,
          normalizeNow(this.now),
        ],
      );
      if (inserted[0]) return mapSettlement(inserted[0]);
      const existing = await this.one<Row>(
        tx,
        `SELECT id, tenant_id, usage_event_id, request_id, attempt_id,
                settlement_key_digest, settlement_digest, kind, created_at
         FROM saas_usage_settlements
         WHERE tenant_id = $1
           AND (usage_event_id = $2 OR settlement_key_digest = $3)
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE`,
        [tenantId, usageEventId, settlementKeyDigest],
      );
      if (!existing) fail('METERING_STORAGE_ERROR');
      const existingSettlement = mapSettlement(existing);
      if (
        existingSettlement.usageEventId !== usageEventId ||
        existingSettlement.settlementKeyDigest !== settlementKeyDigest ||
        existingSettlement.settlementDigest !== digest ||
        existingSettlement.kind !== kind
      ) {
        fail('USAGE_SETTLEMENT_CONFLICT');
      }
      return existingSettlement;
    });
  }

  async recordUsageSettlement(
    input: RecordUsageSettlementInput,
    options: MeteringOperationOptions = {},
  ): Promise<UsageSettlementRecord> {
    return this.createUsageSettlement(input, options);
  }

  async getRequest(
    tenantId: string,
    requestId: string,
    options: MeteringOperationOptions = {},
  ): Promise<RequestRecord | null> {
    const executor = options.executor ?? this.database;
    const row = await this.one<Row>(
      executor,
      `SELECT ${requestColumns('r')}, i.key_digest AS idempotency_key_digest
       FROM saas_requests r
       LEFT JOIN saas_idempotency_records i
         ON i.tenant_id = r.tenant_id AND i.request_id = r.id AND i.kind = 'active'
       WHERE r.tenant_id = $1 AND r.id = $2
       LIMIT 1`,
      [asIdentifier(tenantId), asIdentifier(requestId)],
    );
    return row ? mapRequest(row) : null;
  }

  async listRequests(tenantId: string, options: RequestListOptions = {}): Promise<RequestRecord[]> {
    const executor = options.executor ?? this.database;
    const values: unknown[] = [asIdentifier(tenantId)];
    const predicates = ['r.tenant_id = $1'];
    if (options.projectId !== undefined) {
      values.push(asIdentifier(options.projectId));
      predicates.push(`r.project_id = $${values.length}`);
    }
    if (options.proxyKeyId !== undefined) {
      values.push(asIdentifier(options.proxyKeyId));
      predicates.push(`r.proxy_key_id = $${values.length}`);
    }
    const limit = options.limit === undefined ? 100 : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('METERING_INVALID_INPUT');
    values.push(limit);
    const rows = await this.rows<Row>(
      executor,
      `SELECT ${requestColumns('r')}, i.key_digest AS idempotency_key_digest
       FROM saas_requests r
       LEFT JOIN saas_idempotency_records i
         ON i.tenant_id = r.tenant_id AND i.request_id = r.id AND i.kind = 'active'
       WHERE ${predicates.join(' AND ')}
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT $${values.length}`,
      values,
    );
    return rows.map(mapRequest);
  }

  async getAttempt(
    tenantId: string,
    requestId: string,
    attemptId: string,
    options: MeteringOperationOptions = {},
  ): Promise<AttemptRecord | null> {
    const executor = options.executor ?? this.database;
    const row = await this.one<Row>(
      executor,
      `SELECT ${attemptColumns}
       FROM saas_attempts
       WHERE tenant_id = $1 AND request_id = $2 AND id = $3
       LIMIT 1`,
      [asIdentifier(tenantId), asIdentifier(requestId), asIdentifier(attemptId)],
    );
    return row ? mapAttempt(row) : null;
  }

  async listAttempts(
    tenantId: string,
    requestId: string,
    options: MeteringOperationOptions = {},
  ): Promise<AttemptRecord[]> {
    const executor = options.executor ?? this.database;
    const rows = await this.rows<Row>(
      executor,
      `SELECT ${attemptColumns}
       FROM saas_attempts
       WHERE tenant_id = $1 AND request_id = $2
       ORDER BY ordinal ASC`,
      [asIdentifier(tenantId), asIdentifier(requestId)],
    );
    return rows.map(mapAttempt);
  }

  async listUsageEvents(
    tenantId: string,
    requestId: string,
    options: MeteringOperationOptions = {},
  ): Promise<UsageEventRecord[]> {
    const executor = options.executor ?? this.database;
    const rows = await this.rows<Row>(
      executor,
      `SELECT ${usageColumns}
       FROM saas_usage_events
       WHERE tenant_id = $1 AND request_id = $2
       ORDER BY created_at ASC, id ASC`,
      [asIdentifier(tenantId), asIdentifier(requestId)],
    );
    return rows.map(mapUsage);
  }

  async getUsageEvent(
    tenantId: string,
    usageEventId: string,
    options: MeteringOperationOptions = {},
  ): Promise<UsageEventRecord | null> {
    const executor = options.executor ?? this.database;
    const row = await this.one<Row>(
      executor,
      `SELECT ${usageColumns}
       FROM saas_usage_events
       WHERE tenant_id = $1 AND id = $2
       LIMIT 1`,
      [asIdentifier(tenantId), asIdentifier(usageEventId)],
    );
    return row ? mapUsage(row) : null;
  }

  async getUsageSettlement(
    tenantId: string,
    usageEventId: string,
    options: MeteringOperationOptions = {},
  ): Promise<UsageSettlementRecord | null> {
    const executor = options.executor ?? this.database;
    const row = await this.one<Row>(
      executor,
      `SELECT id, tenant_id, usage_event_id, request_id, attempt_id,
              settlement_key_digest, settlement_digest, kind, created_at
       FROM saas_usage_settlements
       WHERE tenant_id = $1 AND usage_event_id = $2
       LIMIT 1`,
      [asIdentifier(tenantId), asIdentifier(usageEventId)],
    );
    return row ? mapSettlement(row) : null;
  }
}

export type { MeteringServiceOptions };
