const BASE = '/admin/api/v1';

export const PLATFORM_ADMIN_ROLES = Object.freeze([
  'superadmin',
  'security',
  'finance',
  'operations',
  'support-readonly',
] as const);

export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

export interface PlatformAuthSession {
  userId: string;
  id?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface PlatformLoginInput {
  email: string;
  password: string;
  code: string;
}

export interface PlatformLoginResult {
  session: PlatformAuthSession;
}

export interface PlatformMe {
  userId: string;
  roles: PlatformAdminRole[];
}

export interface PlatformOperationsStatusCounts {
  pending: string;
  succeeded: string;
  failed: string;
  unknown: string;
}

export interface PlatformOperationsAggregate {
  total: string;
  byStatus: PlatformOperationsStatusCounts;
}

export interface PlatformOperationsMetrics {
  dataSource: 'postgresql_persisted_aggregates';
  snapshotAt: string;
  requests: {
    successPercent: string | null;
    unknownPercent: string | null;
    financialStatus: {
      notApplicable: string;
      pending: string;
      settled: string;
      released: string;
      reconciliationPending: string;
    };
  };
  attempts: {
    successPercent: string | null;
    unknownPercent: string | null;
    responseHttp4xxCount: string;
    responseHttp5xxCount: string;
    responseStartLatencyMs: {
      sampleCount: string;
      p50: string | null;
      p95: string | null;
    };
  };
  billingReservationBacklog: {
    reserved: string;
    reconciliationPending: string;
  };
  platformAccountHealth: {
    observationCount: string;
    byState: {
      healthy: string;
      degraded: string;
      cooldown: string;
      unhealthy: string;
    };
    activeCooldownCount: string;
    latestObservedAt: string | null;
  };
  paymentWebhookBacklog: {
    pending: string;
    processing: string;
    oldestUnprocessedAgeMs: string | null;
  };
  runtimeProbes: {
    postgresql: 'unavailable' | 'not_configured';
    redis: 'unavailable' | 'not_configured';
    kms: 'unavailable' | 'not_configured';
    worker: 'unavailable' | 'not_configured';
  };
}

export interface PlatformOperationsSummary {
  from: string;
  to: string;
  requests: PlatformOperationsAggregate;
  attempts: PlatformOperationsAggregate;
  activeProviderAccountLeaseCount: string;
  /** Additive and optional so a new client remains compatible with older servers. */
  metrics?: PlatformOperationsMetrics;
}

export interface PlatformOperationsSummaryQuery {
  from: string;
  to: string;
  signal?: AbortSignal;
}

export const PLATFORM_CAPACITY_POLICY_REASONS = Object.freeze([
  'initial_provisioning',
  'customer_request',
  'capacity_adjustment',
  'incident_response',
  'risk_control',
  'data_correction',
] as const);

export type PlatformCapacityPolicyReason = (typeof PLATFORM_CAPACITY_POLICY_REASONS)[number];
export type PlatformCapacityPolicyScope = 'tenant' | 'project' | 'api_key';

export interface PlatformCapacityPolicyLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxConcurrentRequests: number;
}

interface PlatformCapacityPolicyBase {
  scope: PlatformCapacityPolicyScope;
  tenantId: string;
  revision: string;
  revisionKind: 'tenant_capacity_policy' | 'project_inference_policy' | 'api_key_authz';
  limits: PlatformCapacityPolicyLimits | null;
  configured: boolean;
}

export type PlatformCapacityPolicy =
  | (PlatformCapacityPolicyBase & { scope: 'tenant' })
  | (PlatformCapacityPolicyBase & { scope: 'project'; projectId: string })
  | (PlatformCapacityPolicyBase & { scope: 'api_key'; projectId: string; apiKeyId: string });

export type PlatformCapacityPolicyTarget =
  | { scope: 'tenant'; tenantId: string }
  | { scope: 'project'; tenantId: string; projectId: string }
  | { scope: 'api_key'; tenantId: string; projectId: string; apiKeyId: string };

export interface PlatformCapacityPolicyTargetPage {
  items: Array<{ id: string }>;
  nextCursor: string | null;
}

export interface PlatformCapacityPolicyUpdateInput {
  expectedRevision: string;
  limits: PlatformCapacityPolicyLimits;
  reason: PlatformCapacityPolicyReason;
}

export type PlatformRefundType = 'wallet_topup' | 'byok_service_plan';
export type PlatformRefundStatus = 'submitting' | 'pending' | 'succeeded' | 'failed' | 'unknown' | 'blocked';

export interface PlatformRefundRecord {
  id: string;
  tenantId: string;
  refundType: PlatformRefundType;
  originalOrderId: string;
  amountMinorUnits: string;
  currency: string;
  status: PlatformRefundStatus;
  providerRefundId: string | null;
  failureCode: string | null;
  blockedCode: string | null;
  walletRefundTransactionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PlatformWalletTopUpRefundInput {
  tenantId: string;
  orderId: string;
  reasonCode: string;
  idempotencyKey: string;
}

export interface PlatformCatalogPage<Item> {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type PlatformPriceVersionKind = 'customer' | 'supplier';
export type PlatformPriceMetric = 'input' | 'cache_read' | 'cache_write' | 'cache_write_5m' | 'cache_write_1h' | 'output';

export interface PlatformExactPriceRate {
  numeratorMinorUnits: string;
  denominatorUnits: string;
}

export interface PlatformRateSetInput {
  input: PlatformExactPriceRate;
  output: PlatformExactPriceRate;
  cache_read?: PlatformExactPriceRate | null;
  cache_write?: PlatformExactPriceRate | null;
  cache_write_5m?: PlatformExactPriceRate | null;
  cache_write_1h?: PlatformExactPriceRate | null;
}

export type PlatformRateSet = Required<Record<PlatformPriceMetric, PlatformExactPriceRate | null>>;

export interface PlatformPricingTarget {
  publicModelId: string;
  publicModelVersion: number;
  publicModelAlias: string;
  displayName: string;
  providerId: string;
  productId: string;
  resolvedModel: string;
  protocol: string;
  endpoint: string;
  capabilityVersion: number;
}

export interface PlatformPricingTargetQuery {
  kind: PlatformPriceVersionKind;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface PlatformPriceVersion {
  kind: PlatformPriceVersionKind;
  id: string;
  version: number;
  publicModelId: string;
  publicModelVersion: number;
  providerId: string;
  productId: string;
  resolvedModel?: string;
  protocol: string;
  endpoint: string;
  currency: string;
  commercialPolicyVersion: string;
  calculatorVersion: string;
  roundingVersion: string;
  roundingMode: 'floor' | 'ceil' | 'half_up' | 'half_even';
  roundingBoundary: 'total';
  rates: PlatformRateSet;
  effectiveAt: string;
  expiresAt: string | null;
  definitionDigest: string;
  createdAt: string;
}

export interface PlatformPriceVersionHistoryQuery {
  kind: PlatformPriceVersionKind;
  publicModelId: string;
  publicModelVersion: number;
  protocol: string;
  endpoint: string;
  currency: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface PlatformPriceVersionRegistrationInput {
  publicModelId: string;
  publicModelVersion: number;
  protocol: string;
  endpoint: string;
  currency: string;
  idempotencyKey: string;
  effectiveAt: string;
  expiresAt?: string | null;
  commercialPolicyVersion: string;
  calculatorVersion: string;
  roundingVersion: string;
  roundingMode: 'floor' | 'ceil' | 'half_up' | 'half_even';
  roundingBoundary?: 'total';
  rates: PlatformRateSetInput;
}

export interface PlatformCatalogProduct {
  providerId: string;
  productId: string;
  displayName: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface PlatformCatalogCapability {
  providerId: string;
  productId: string;
  model: string;
  endpoint: string;
  protocol: string;
  version: number;
  supportLevel: 'supported' | 'limited' | 'unsupported';
  validationState: 'unverified' | 'verified' | 'failed';
  createdAt: string;
}

export interface PlatformCatalogRights {
  rightsId: string;
  version: number;
  providerId: string;
  productId: string;
  supplyMode: 'byok' | 'platform';
  region: string;
  purpose: string;
  modelScope: string[];
  endpointScope: string[];
  effectiveAt: string;
  expiresAt: string | null;
  status: 'draft' | 'active' | 'revoked';
  createdAt: string;
}

export interface PlatformCatalogRightsVersionInput {
  rightsId?: string;
  providerId: string;
  productId: string;
  credentialType: string;
  supplyMode: 'byok' | 'platform';
  region: string;
  purpose: string;
  modelScope: string[];
  endpointScope: string[];
  effectiveAt: string;
  expiresAt?: string | null;
  approvalReference: string;
  evidenceReference: string;
  evidenceSha256: string;
  status?: 'draft' | 'active';
}

export interface PlatformCatalogRightsRevokeInput {
  approvalReference: string;
  evidenceReference: string;
  evidenceSha256: string;
  effectiveAt?: string;
}

export type PlatformSupplyAccountStatus = 'pending' | 'active' | 'disabled' | 'revoked';
export type PlatformSupplyCredentialStatus = 'pending' | 'active' | 'disabled' | 'revoked';
export type PlatformSupplyValidationState = 'unverified' | 'verified' | 'failed';
export type PlatformSupplyCredentialVersionStatus = 'active' | 'retired' | 'revoked';

export interface PlatformSupplyCapability {
  model: string;
  endpoint: string;
  version: number;
}

/** The owner and supply mode are intentionally absent: this route always creates platform supply. */
export interface PlatformSupplyAccountCreateInput {
  displayName: string;
  providerId: string;
  productId: string;
  credentialType: string;
  region: string;
  purpose: string;
  rightsId: string;
  rightsVersion: number;
  capabilities: PlatformSupplyCapability[];
}

export type PlatformSupplyAccountInput = PlatformSupplyAccountCreateInput;

export interface PlatformSupplyAccount {
  ownerKind: 'platform';
  tenantId: null;
  supplyMode: 'platform';
  id: string;
  displayName: string;
  providerId: string;
  productId: string;
  credentialType: string;
  region: string;
  purpose: string;
  rightsId: string;
  rightsVersion: number;
  capabilities: PlatformSupplyCapability[];
  status: PlatformSupplyAccountStatus;
  validationState: PlatformSupplyValidationState;
  validationErrorCode: string | null;
  lastValidatedAt: string | null;
  authzVersion: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  revokedAt: string | null;
}

export interface PlatformSupplyCredentialVersion {
  ownerKind: 'platform';
  tenantId: null;
  accountId: string;
  credentialId: string;
  version: number;
  status: PlatformSupplyCredentialVersionStatus;
  envelopeSchemaVersion?: number;
  contextVersion?: number;
  algorithm?: string;
  kmsPurpose?: string;
  wrappingRevision?: number;
  createdAt: string;
  expiresAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
}

export interface PlatformSupplyCredential {
  ownerKind: 'platform';
  tenantId: null;
  supplyMode: 'platform';
  id: string;
  accountId: string;
  providerId: string;
  productId: string;
  credentialType: string;
  status: PlatformSupplyCredentialStatus;
  validationState: PlatformSupplyValidationState;
  validationErrorCode: string | null;
  lastValidatedAt: string | null;
  currentVersion: number | null;
  expiresAt: string | null;
  authzVersion: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  revokedAt: string | null;
  versions?: PlatformSupplyCredentialVersion[];
}

export type PlatformSupplyCredentialRewrapStatus = 'ready' | 'already_current' | 'not_eligible';
export type PlatformSupplyCredentialRewrapOutcome = 'succeeded' | 'unknown' | 'conflict' | 'error';

export interface PlatformSupplyCredentialWrappingStatus {
  state: PlatformSupplyCredentialRewrapStatus;
  credentialVersion: number | null;
  wrappingRevision: number | null;
}

export interface PlatformSupplyCredentialRewrapInput {
  expectedVersion: number;
  expectedWrappingRevision: number;
  idempotencyKey: string;
}

export interface PlatformSupplyCredentialRewrapResult {
  state: PlatformSupplyCredentialRewrapOutcome;
  credentialVersion: number;
  expectedWrappingRevision: number;
  wrappingRevision: number | null;
  refreshRequired: boolean;
}

export interface PlatformSupplyCredentialSecretInput {
  secret: string;
  expiresAt?: string | null;
}

export type PlatformSupplyCredentialInput = PlatformSupplyCredentialSecretInput;

export interface PlatformSupplyCredentialRotationInput extends PlatformSupplyCredentialSecretInput {
  expectedVersion: number | null;
}

export interface PlatformSupplyLifecycleInput {
  expectedAuthzVersion: number;
}

export interface PlatformSupplyCredentialWriteResult {
  credential: PlatformSupplyCredential;
  version?: PlatformSupplyCredentialVersion;
}

export interface PlatformCatalogPageQuery {
  limit?: number;
  cursor?: string;
  providerId?: string;
  signal?: AbortSignal;
}

export type PlatformCatalogProductsQuery = Omit<PlatformCatalogPageQuery, 'providerId'>;

export interface PlatformAuditOperatorAttestation {
  /** Declared external operator reference; not a verified platform user. */
  operatorId: string;
  reasonCode: 'initial-enrollment' | 'approved-enrollment';
  outcome: 'issued' | 'target-unavailable' | 'verified-totp-present' | 'enrollment-pending';
}

export interface PlatformAuditEvent {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  occurredAt: string;
  operatorAttestation?: PlatformAuditOperatorAttestation;
}

export interface PlatformAuditPageQuery {
  actorId?: string;
  action?: string;
  entityType?: string;
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export type PlatformAuditEventPage = PlatformCatalogPage<PlatformAuditEvent>;

export type PlatformUnknownOutcomeSupplyMode = 'byok' | 'platform';
export type PlatformUnknownOutcomeObservationKind =
  | 'request_snapshot'
  | 'attempt_snapshot'
  | 'usage_snapshot'
  | 'provider_evidence'
  | 'operator_resolution';
export type PlatformUnknownOutcomeExecutionState = 'pending' | 'succeeded' | 'failed' | 'unknown';
export type PlatformUnknownOutcomeReconciliationState = 'none' | 'pending' | 'resolved';

/**
 * Metadata-only projection of an operator-required unknown-outcome case.
 * Prompt, response, provider usage, actor and operator-reason bodies are intentionally absent.
 */
export interface PlatformUnknownOutcomeCaseSummary {
  caseId: string;
  tenantId: string;
  projectId: string;
  requestId: string;
  supplyMode: PlatformUnknownOutcomeSupplyMode;
  scanAttempts: number;
  lastErrorCode: string | null;
  createdAt: string;
}

/** Immutable, metadata-only observation used by the operator timeline. */
export interface PlatformUnknownOutcomeObservation {
  observationId: string;
  kind: PlatformUnknownOutcomeObservationKind;
  observedAt: string;
  attemptId: string | null;
  usageEventId: string | null;
  supplyMode: PlatformUnknownOutcomeSupplyMode | null;
  executionState: PlatformUnknownOutcomeExecutionState | null;
  reconciliationState: PlatformUnknownOutcomeReconciliationState | null;
  financialStatus: string | null;
  requestStateVersion: number | null;
  dispatchState: string | null;
  resultState: string | null;
  responseStarted: boolean | null;
  attemptStateVersion: number | null;
  upstreamId: string | null;
  accountOwnerKind: string | null;
  accountId: string | null;
  providerId: string | null;
  productId: string | null;
  resolvedModel: string | null;
  unknownReason: string | null;
  usageEventDigest: string | null;
  providerStatus: string | null;
  providerOperationId: string | null;
  providerIdentityDigest: string | null;
  evidenceReference: string | null;
  operatorOutcome: string | null;
  auditEventId: string | null;
}

export interface PlatformUnknownOutcomeCaseDetail {
  summary: PlatformUnknownOutcomeCaseSummary;
  possibleAttemptIds: string[];
  observations: PlatformUnknownOutcomeObservation[];
}

export interface PlatformUnknownOutcomeListQuery {
  tenantId: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface PlatformUnknownOutcomeCoverageInput {
  attemptId: string;
  evidenceReference: string;
}

export interface PlatformUnknownOutcomeResolutionInput {
  tenantId: string;
  caseId: string;
  supportTicketRef: string;
  reason: string;
  coverage: PlatformUnknownOutcomeCoverageInput[];
  idempotencyKey: string;
}

export interface PlatformUnknownOutcomeResolutionResult {
  status: 'resolved' | 'replayed';
  caseId: string;
  requestId: string;
}

export interface PlatformMfaEnrollmentStart {
  otpauthUri: string;
  confirmationToken: string;
  expiresAt: string;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
}

interface ReadRequestOptions {
  signal?: AbortSignal;
}

interface RequestOptions extends ReadRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  bearerToken?: string;
  idempotencyKey?: string;
}

export class PlatformApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

let csrfToken: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `管理接口返回了无效的 ${field}`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function parseSession(value: unknown): PlatformAuthSession {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '管理接口返回了无效会话');
  }

  return {
    userId: requiredString(value.userId, 'userId'),
    id: optionalString(value.id, 'id'),
    createdAt: optionalString(value.createdAt, 'createdAt'),
    expiresAt: optionalString(value.expiresAt, 'expiresAt'),
  };
}

function isPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return typeof value === 'string' && (PLATFORM_ADMIN_ROLES as readonly string[]).includes(value);
}

function parseMe(value: unknown): PlatformMe {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '管理接口返回了无效管理员身份');
  }

  const candidate = isRecord(value.me) ? value.me : isRecord(value.actor) ? value.actor : value;
  const roles = candidate.roles;
  if (
    typeof candidate.userId !== 'string' ||
    candidate.userId.length === 0 ||
    !Array.isArray(roles) ||
    roles.length === 0 ||
    roles.some((role) => !isPlatformAdminRole(role))
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '管理接口返回了无效管理员身份');
  }

  return { userId: candidate.userId, roles: [...roles] };
}

function parseEnrollment(value: unknown): PlatformMfaEnrollmentStart {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', 'MFA 接口返回了无效配置');
  }

  return {
    otpauthUri: requiredString(value.otpauthUri, 'otpauthUri'),
    confirmationToken: requiredString(value.confirmationToken, 'confirmationToken'),
    expiresAt: requiredString(value.expiresAt, 'expiresAt'),
  };
}

function parseOperationsCount(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 无效`);
  }
  return value;
}

function parseOperationsPercent(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:100|\d{1,2})\.\d{2}$/.test(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 无效`);
  }
  const [integerPart, fractionPart] = value.split('.');
  if (BigInt(integerPart ?? '0') * 100n + BigInt(fractionPart ?? '0') > 10_000n) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 超出范围`);
  }
  return value;
}

function parseOperationsTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 无效`);
  }
  return new Date(parsed).toISOString();
}

function parseOperationsNullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : parseOperationsTimestamp(value, field);
}

function parseOperationsStatusCounts(value: unknown, field: string): PlatformOperationsStatusCounts {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 无效`);
  }
  return {
    pending: parseOperationsCount(value.pending, `${field}.pending`),
    succeeded: parseOperationsCount(value.succeeded, `${field}.succeeded`),
    failed: parseOperationsCount(value.failed, `${field}.failed`),
    unknown: parseOperationsCount(value.unknown, `${field}.unknown`),
  };
}

function parseOperationsAggregate(value: unknown, field: string): PlatformOperationsAggregate {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 无效`);
  }
  const total = parseOperationsCount(value.total, `${field}.total`);
  const byStatus = parseOperationsStatusCounts(value.byStatus, `${field}.byStatus`);
  const statusTotal = BigInt(byStatus.pending) + BigInt(byStatus.succeeded) + BigInt(byStatus.failed) + BigInt(byStatus.unknown);
  if (statusTotal !== BigInt(total)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 状态计数不一致`);
  }
  return { total, byStatus };
}

function parseOperationsMetrics(value: unknown, requestTotal: string): PlatformOperationsMetrics {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要扩展指标无效');
  }
  const requests = value.requests;
  const financialStatus = isRecord(requests) ? requests.financialStatus : undefined;
  const attempts = value.attempts;
  const responseStartLatencyMs = isRecord(attempts) ? attempts.responseStartLatencyMs : undefined;
  const billingReservationBacklog = value.billingReservationBacklog;
  const platformAccountHealth = value.platformAccountHealth;
  const healthByState = isRecord(platformAccountHealth) ? platformAccountHealth.byState : undefined;
  const paymentWebhookBacklog = value.paymentWebhookBacklog;
  const runtimeProbes = value.runtimeProbes;

  if (
    value.dataSource !== 'postgresql_persisted_aggregates' ||
    !isRecord(requests) ||
    !isRecord(financialStatus) ||
    !isRecord(attempts) ||
    !isRecord(responseStartLatencyMs) ||
    !isRecord(billingReservationBacklog) ||
    !isRecord(platformAccountHealth) ||
    !isRecord(healthByState) ||
    !isRecord(paymentWebhookBacklog) ||
    !isRecord(runtimeProbes)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要扩展指标无效');
  }

  const probeStatus = (probe: unknown, field: string): 'unavailable' | 'not_configured' => {
    if (probe !== 'unavailable' && probe !== 'not_configured') {
      throw new PlatformApiError(200, 'INVALID_RESPONSE', `运营摘要中的 ${field} 无效`);
    }
    return probe;
  };
  const latency = {
    sampleCount: parseOperationsCount(responseStartLatencyMs.sampleCount, 'attempts.responseStartLatencyMs.sampleCount'),
    p50: responseStartLatencyMs.p50 === null
      ? null
      : parseOperationsCount(responseStartLatencyMs.p50, 'attempts.responseStartLatencyMs.p50'),
    p95: responseStartLatencyMs.p95 === null
      ? null
      : parseOperationsCount(responseStartLatencyMs.p95, 'attempts.responseStartLatencyMs.p95'),
  };
  if (
    (latency.sampleCount === '0' && (latency.p50 !== null || latency.p95 !== null)) ||
    (latency.sampleCount !== '0' && (latency.p50 === null || latency.p95 === null))
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要中的尝试响应延迟样本无效');
  }

  const healthObservationCount = parseOperationsCount(
    platformAccountHealth.observationCount,
    'platformAccountHealth.observationCount',
  );
  const healthByStateParsed = {
    healthy: parseOperationsCount(healthByState.healthy, 'platformAccountHealth.byState.healthy'),
    degraded: parseOperationsCount(healthByState.degraded, 'platformAccountHealth.byState.degraded'),
    cooldown: parseOperationsCount(healthByState.cooldown, 'platformAccountHealth.byState.cooldown'),
    unhealthy: parseOperationsCount(healthByState.unhealthy, 'platformAccountHealth.byState.unhealthy'),
  };
  if (
    BigInt(healthByStateParsed.healthy) + BigInt(healthByStateParsed.degraded) +
      BigInt(healthByStateParsed.cooldown) + BigInt(healthByStateParsed.unhealthy) !== BigInt(healthObservationCount)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要中的平台账号健康计数不一致');
  }

  const pending = parseOperationsCount(paymentWebhookBacklog.pending, 'paymentWebhookBacklog.pending');
  const processing = parseOperationsCount(paymentWebhookBacklog.processing, 'paymentWebhookBacklog.processing');
  const oldestUnprocessedAgeMs = paymentWebhookBacklog.oldestUnprocessedAgeMs === null
    ? null
    : parseOperationsCount(paymentWebhookBacklog.oldestUnprocessedAgeMs, 'paymentWebhookBacklog.oldestUnprocessedAgeMs');
  if ((BigInt(pending) + BigInt(processing) > 0n) !== (oldestUnprocessedAgeMs !== null)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要中的 webhook 积压计数不一致');
  }

  const result: PlatformOperationsMetrics = {
    dataSource: 'postgresql_persisted_aggregates',
    snapshotAt: parseOperationsTimestamp(value.snapshotAt, 'snapshotAt'),
    requests: {
      successPercent: parseOperationsPercent(requests.successPercent, 'requests.successPercent'),
      unknownPercent: parseOperationsPercent(requests.unknownPercent, 'requests.unknownPercent'),
      financialStatus: {
        notApplicable: parseOperationsCount(financialStatus.notApplicable, 'requests.financialStatus.notApplicable'),
        pending: parseOperationsCount(financialStatus.pending, 'requests.financialStatus.pending'),
        settled: parseOperationsCount(financialStatus.settled, 'requests.financialStatus.settled'),
        released: parseOperationsCount(financialStatus.released, 'requests.financialStatus.released'),
        reconciliationPending: parseOperationsCount(
          financialStatus.reconciliationPending,
          'requests.financialStatus.reconciliationPending',
        ),
      },
    },
    attempts: {
      successPercent: parseOperationsPercent(attempts.successPercent, 'attempts.successPercent'),
      unknownPercent: parseOperationsPercent(attempts.unknownPercent, 'attempts.unknownPercent'),
      responseHttp4xxCount: parseOperationsCount(attempts.responseHttp4xxCount, 'attempts.responseHttp4xxCount'),
      responseHttp5xxCount: parseOperationsCount(attempts.responseHttp5xxCount, 'attempts.responseHttp5xxCount'),
      responseStartLatencyMs: latency,
    },
    billingReservationBacklog: {
      reserved: parseOperationsCount(billingReservationBacklog.reserved, 'billingReservationBacklog.reserved'),
      reconciliationPending: parseOperationsCount(
        billingReservationBacklog.reconciliationPending,
        'billingReservationBacklog.reconciliationPending',
      ),
    },
    platformAccountHealth: {
      observationCount: healthObservationCount,
      byState: healthByStateParsed,
      activeCooldownCount: parseOperationsCount(
        platformAccountHealth.activeCooldownCount,
        'platformAccountHealth.activeCooldownCount',
      ),
      latestObservedAt: parseOperationsNullableTimestamp(
        platformAccountHealth.latestObservedAt,
        'platformAccountHealth.latestObservedAt',
      ),
    },
    paymentWebhookBacklog: { pending, processing, oldestUnprocessedAgeMs },
    runtimeProbes: {
      postgresql: probeStatus(runtimeProbes.postgresql, 'runtimeProbes.postgresql'),
      redis: probeStatus(runtimeProbes.redis, 'runtimeProbes.redis'),
      kms: probeStatus(runtimeProbes.kms, 'runtimeProbes.kms'),
      worker: probeStatus(runtimeProbes.worker, 'runtimeProbes.worker'),
    },
  };

  const financialCounts = result.requests.financialStatus;
  const financialTotal = BigInt(financialCounts.notApplicable) + BigInt(financialCounts.pending) +
    BigInt(financialCounts.settled) + BigInt(financialCounts.released) +
    BigInt(financialCounts.reconciliationPending);
  if (
    financialTotal !== BigInt(requestTotal) ||
    (result.platformAccountHealth.latestObservedAt === null) !== (healthObservationCount === '0') ||
    BigInt(result.platformAccountHealth.activeCooldownCount) > BigInt(healthByStateParsed.cooldown)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要中的扩展聚合计数无效');
  }
  return result;
}

function parseOperationsSummary(value: unknown): PlatformOperationsSummary {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要响应无效');
  }
  const from = requiredString(value.from, 'from');
  const to = requiredString(value.to, 'to');
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime >= toTime) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '运营摘要中的时间范围无效');
  }
  const requests = parseOperationsAggregate(value.requests, 'requests');
  return {
    from,
    to,
    requests,
    attempts: parseOperationsAggregate(value.attempts, 'attempts'),
    activeProviderAccountLeaseCount: parseOperationsCount(value.activeProviderAccountLeaseCount, 'activeProviderAccountLeaseCount'),
    ...(value.metrics === undefined ? {} : { metrics: parseOperationsMetrics(value.metrics, requests.total) }),
  };
}

function parseCapacityPolicyLimits(value: unknown): PlatformCapacityPolicyLimits | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略中的限制值无效');
  }
  const limits = {
    requestsPerMinute: value.requestsPerMinute,
    tokensPerMinute: value.tokensPerMinute,
    maxConcurrentRequests: value.maxConcurrentRequests,
  };
  if (
    typeof limits.requestsPerMinute !== 'number' ||
    !Number.isSafeInteger(limits.requestsPerMinute) ||
    limits.requestsPerMinute < 1 ||
    typeof limits.tokensPerMinute !== 'number' ||
    !Number.isSafeInteger(limits.tokensPerMinute) ||
    limits.tokensPerMinute < 1 ||
    typeof limits.maxConcurrentRequests !== 'number' ||
    !Number.isSafeInteger(limits.maxConcurrentRequests) ||
    limits.maxConcurrentRequests < 1 ||
    limits.maxConcurrentRequests > 2_147_483_647
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略中的限制值无效');
  }
  return limits as PlatformCapacityPolicyLimits;
}

function parseCapacityPolicy(
  value: unknown,
  target: PlatformCapacityPolicyTarget,
): PlatformCapacityPolicy {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略响应无效');
  }
  const expectedRevisionKind =
    target.scope === 'tenant'
      ? 'tenant_capacity_policy'
      : target.scope === 'project'
        ? 'project_inference_policy'
        : 'api_key_authz';
  const revision = value.revision;
  const tenantId = value.tenantId;
  const limits = parseCapacityPolicyLimits(value.limits);
  if (
    value.scope !== target.scope ||
    typeof tenantId !== 'string' ||
    tenantId.toLowerCase() !== target.tenantId.toLowerCase() ||
    typeof revision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(revision) ||
    BigInt(revision) > MAX_CAPACITY_REVISION ||
    value.revisionKind !== expectedRevisionKind ||
    typeof value.configured !== 'boolean' ||
    value.configured !== (limits !== null)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略响应无效');
  }
  const base: PlatformCapacityPolicyBase = {
    scope: target.scope,
    tenantId: tenantId.toLowerCase(),
    revision,
    revisionKind: expectedRevisionKind,
    configured: value.configured,
    limits,
  };
  if (target.scope === 'tenant') return { ...base, scope: 'tenant' };
  const projectId = value.projectId;
  if (typeof projectId !== 'string' || projectId.toLowerCase() !== target.projectId.toLowerCase()) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略响应中的项目 ID 无效');
  }
  if (target.scope === 'project') return { ...base, scope: 'project', projectId: projectId.toLowerCase() };
  const apiKeyId = value.apiKeyId;
  if (typeof apiKeyId !== 'string' || apiKeyId.toLowerCase() !== target.apiKeyId.toLowerCase()) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略响应中的 API key ID 无效');
  }
  return {
    ...base,
    scope: 'api_key',
    projectId: projectId.toLowerCase(),
    apiKeyId: apiKeyId.toLowerCase(),
  };
}

function refundNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredString(value, field);
}

function refundTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `退款响应中的 ${field} 无效`);
  }
  return timestamp;
}

function parsePlatformRefundRecord(value: unknown): PlatformRefundRecord {
  if (
    !isRecord(value) ||
    (value.refundType !== 'wallet_topup' && value.refundType !== 'byok_service_plan') ||
    (value.status !== 'submitting' && value.status !== 'pending' && value.status !== 'succeeded' &&
      value.status !== 'failed' && value.status !== 'unknown' && value.status !== 'blocked') ||
    typeof value.amountMinorUnits !== 'string' || !/^(0|[1-9]\d*)$/.test(value.amountMinorUnits) ||
    typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '退款响应无效');
  }
  return {
    id: requiredString(value.id, 'id'),
    tenantId: requiredString(value.tenantId, 'tenantId'),
    refundType: value.refundType,
    originalOrderId: requiredString(value.originalOrderId, 'originalOrderId'),
    amountMinorUnits: value.amountMinorUnits,
    currency: value.currency,
    status: value.status,
    providerRefundId: refundNullableString(value.providerRefundId, 'providerRefundId'),
    failureCode: refundNullableString(value.failureCode, 'failureCode'),
    blockedCode: refundNullableString(value.blockedCode, 'blockedCode'),
    walletRefundTransactionId: refundNullableString(value.walletRefundTransactionId, 'walletRefundTransactionId'),
    createdAt: refundTimestamp(value.createdAt, 'createdAt'),
    updatedAt: refundTimestamp(value.updatedAt, 'updatedAt'),
    completedAt: value.completedAt === null ? null : refundTimestamp(value.completedAt, 'completedAt'),
  };
}

function refundRecordPath(tenantId: string, refundId: string): string {
  return `/payments/refunds/${encodeURIComponent(tenantId)}/${encodeURIComponent(refundId)}`;
}

function refundRequestField(value: string, field: string, maxLength: number): string {
  if (
    typeof value !== 'string' || value.trim() === '' || value.length > maxLength ||
    [...value].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new PlatformApiError(400, 'INVALID_BODY', `退款申请中的 ${field} 无效`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `目录响应中的 ${field} 无效`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `目录响应中的 ${field} 无效`);
  }
  return [...value];
}

function parseCatalogProduct(value: unknown): PlatformCatalogProduct {
  if (!isRecord(value) || (value.status !== 'active' && value.status !== 'disabled')) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '目录响应中的产品记录无效');
  }
  return {
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    displayName: requiredString(value.displayName, 'displayName'),
    status: value.status,
    createdAt: requiredString(value.createdAt, 'createdAt'),
  };
}

function parseCatalogCapability(value: unknown): PlatformCatalogCapability {
  if (
    !isRecord(value) ||
    (value.supportLevel !== 'supported' && value.supportLevel !== 'limited' && value.supportLevel !== 'unsupported') ||
    (value.validationState !== 'unverified' && value.validationState !== 'verified' && value.validationState !== 'failed')
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '目录响应中的能力记录无效');
  }
  return {
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    model: requiredString(value.model, 'model'),
    endpoint: requiredString(value.endpoint, 'endpoint'),
    protocol: requiredString(value.protocol, 'protocol'),
    version: requiredPositiveInteger(value.version, 'version'),
    supportLevel: value.supportLevel,
    validationState: value.validationState,
    createdAt: requiredString(value.createdAt, 'createdAt'),
  };
}

function parseCatalogRights(value: unknown): PlatformCatalogRights {
  if (
    !isRecord(value) ||
    (value.supplyMode !== 'byok' && value.supplyMode !== 'platform') ||
    (value.status !== 'draft' && value.status !== 'active' && value.status !== 'revoked') ||
    (value.expiresAt !== null && typeof value.expiresAt !== 'string')
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '目录响应中的权益记录无效');
  }
  return {
    rightsId: requiredString(value.rightsId, 'rightsId'),
    version: requiredPositiveInteger(value.version, 'version'),
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    supplyMode: value.supplyMode,
    region: requiredString(value.region, 'region'),
    purpose: requiredString(value.purpose, 'purpose'),
    modelScope: parseStringArray(value.modelScope, 'modelScope'),
    endpointScope: parseStringArray(value.endpointScope, 'endpointScope'),
    effectiveAt: requiredString(value.effectiveAt, 'effectiveAt'),
    expiresAt: value.expiresAt,
    status: value.status,
    createdAt: requiredString(value.createdAt, 'createdAt'),
  };
}

function parseCatalogPage<Item>(value: unknown, parseItem: (item: unknown) => Item): PlatformCatalogPage<Item> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.hasMore !== 'boolean' ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '目录分页响应无效');
  }
  return {
    items: value.items.map(parseItem),
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
  };
}

function parsePlatformPricingTarget(value: unknown): PlatformPricingTarget {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '定价目标响应无效');
  }
  return {
    publicModelId: requiredString(value.publicModelId, 'publicModelId'),
    publicModelVersion: requiredPositiveInteger(value.publicModelVersion, 'publicModelVersion'),
    publicModelAlias: requiredString(value.publicModelAlias, 'publicModelAlias'),
    displayName: requiredString(value.displayName, 'displayName'),
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    resolvedModel: requiredString(value.resolvedModel, 'resolvedModel'),
    protocol: requiredString(value.protocol, 'protocol'),
    endpoint: requiredString(value.endpoint, 'endpoint'),
    capabilityVersion: requiredPositiveInteger(value.capabilityVersion, 'capabilityVersion'),
  };
}

function parsePlatformExactPriceRate(value: unknown, field: string): PlatformExactPriceRate | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.numeratorMinorUnits !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(value.numeratorMinorUnits) ||
    typeof value.denominatorUnits !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(value.denominatorUnits)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `定价响应中的 ${field} 无效`);
  }
  return { numeratorMinorUnits: value.numeratorMinorUnits, denominatorUnits: value.denominatorUnits };
}

const PLATFORM_PRICE_METRICS: readonly PlatformPriceMetric[] = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
];

function parsePlatformPriceVersion(value: unknown): PlatformPriceVersion {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '定价版本响应无效');
  }
  const rateValues = value.rates;
  if (!isRecord(rateValues)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '定价版本响应无效');
  }
  if (
    (value.kind !== 'customer' && value.kind !== 'supplier') ||
    (value.roundingMode !== 'floor' && value.roundingMode !== 'ceil' && value.roundingMode !== 'half_up' &&
      value.roundingMode !== 'half_even') ||
    value.roundingBoundary !== 'total' ||
    value.expiresAt !== null && typeof value.expiresAt !== 'string' ||
    Object.keys(rateValues).length !== PLATFORM_PRICE_METRICS.length ||
    Object.keys(rateValues).some(key => !PLATFORM_PRICE_METRICS.includes(key as PlatformPriceMetric)) ||
    typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency) ||
    typeof value.definitionDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.definitionDigest)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '定价版本响应无效');
  }
  const rates = Object.fromEntries(
    PLATFORM_PRICE_METRICS.map(metric => [metric, parsePlatformExactPriceRate(rateValues[metric], metric)]),
  ) as PlatformRateSet;
  const resolvedModel = value.resolvedModel;
  if ((value.kind === 'supplier' && typeof resolvedModel !== 'string') ||
      (value.kind === 'customer' && resolvedModel !== undefined)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '定价版本响应中的模型映射无效');
  }
  return {
    kind: value.kind,
    id: requiredString(value.id, 'id'),
    version: requiredPositiveInteger(value.version, 'version'),
    publicModelId: requiredString(value.publicModelId, 'publicModelId'),
    publicModelVersion: requiredPositiveInteger(value.publicModelVersion, 'publicModelVersion'),
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    ...(value.kind === 'supplier' ? { resolvedModel: requiredString(resolvedModel, 'resolvedModel') } : {}),
    protocol: requiredString(value.protocol, 'protocol'),
    endpoint: requiredString(value.endpoint, 'endpoint'),
    currency: value.currency,
    commercialPolicyVersion: requiredString(value.commercialPolicyVersion, 'commercialPolicyVersion'),
    calculatorVersion: requiredString(value.calculatorVersion, 'calculatorVersion'),
    roundingVersion: requiredString(value.roundingVersion, 'roundingVersion'),
    roundingMode: value.roundingMode,
    roundingBoundary: 'total',
    rates,
    effectiveAt: requiredString(value.effectiveAt, 'effectiveAt'),
    expiresAt: value.expiresAt,
    definitionDigest: value.definitionDigest,
    createdAt: requiredString(value.createdAt, 'createdAt'),
  };
}

function supplyPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `供给响应中的 ${field} 无效`);
  }
  return value;
}

function supplyNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

function parsePlatformSupplyOwner(value: Record<string, unknown>): { ownerKind: 'platform'; tenantId: null; supplyMode: 'platform' } {
  if (value.ownerKind !== undefined && value.ownerKind !== 'platform') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给响应中的 ownerKind 无效');
  }
  if (value.tenantId !== undefined && value.tenantId !== null) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '平台供给响应不应包含租户 ID');
  }
  if (value.supplyMode !== undefined && value.supplyMode !== 'platform') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给响应中的 supplyMode 无效');
  }
  return { ownerKind: 'platform', tenantId: null, supplyMode: 'platform' };
}

function parsePlatformSupplyCapability(value: unknown): PlatformSupplyCapability {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给账号响应中的 capability 无效');
  }
  return {
    model: requiredString(value.model, 'model'),
    endpoint: requiredString(value.endpoint, 'endpoint'),
    version: supplyPositiveInteger(value.version ?? value.capabilityVersion, 'capability.version'),
  };
}

function parsePlatformSupplyCapabilities(value: unknown): PlatformSupplyCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给账号响应中的 capabilities 无效');
  }
  return value.map(parsePlatformSupplyCapability);
}

function parsePlatformSupplyStatus(value: unknown, field: string): PlatformSupplyAccountStatus {
  if (value !== 'pending' && value !== 'active' && value !== 'disabled' && value !== 'revoked') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `供给响应中的 ${field} 无效`);
  }
  return value;
}

function parsePlatformSupplyValidationState(value: unknown, field: string): PlatformSupplyValidationState {
  if (value !== 'unverified' && value !== 'verified' && value !== 'failed') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `供给响应中的 ${field} 无效`);
  }
  return value;
}

function parsePlatformSupplyAccount(value: unknown): PlatformSupplyAccount {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给账号响应无效');
  }
  const owner = parsePlatformSupplyOwner(value);
  return {
    ...owner,
    id: requiredString(value.id, 'id'),
    displayName: requiredString(value.displayName, 'displayName'),
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    credentialType: requiredString(value.credentialType, 'credentialType'),
    region: requiredString(value.region, 'region'),
    purpose: requiredString(value.purpose, 'purpose'),
    rightsId: requiredString(value.rightsId, 'rightsId'),
    rightsVersion: supplyPositiveInteger(value.rightsVersion, 'rightsVersion'),
    capabilities: parsePlatformSupplyCapabilities(value.capabilities),
    status: parsePlatformSupplyStatus(value.status, 'status'),
    validationState: parsePlatformSupplyValidationState(value.validationState, 'validationState'),
    validationErrorCode: supplyNullableString(value.validationErrorCode, 'validationErrorCode'),
    lastValidatedAt: supplyNullableString(value.lastValidatedAt, 'lastValidatedAt'),
    authzVersion: supplyPositiveInteger(value.authzVersion, 'authzVersion'),
    createdAt: requiredString(value.createdAt, 'createdAt'),
    updatedAt: requiredString(value.updatedAt, 'updatedAt'),
    disabledAt: supplyNullableString(value.disabledAt, 'disabledAt'),
    revokedAt: supplyNullableString(value.revokedAt, 'revokedAt'),
  };
}

function parsePlatformSupplyCredentialVersion(value: unknown): PlatformSupplyCredentialVersion {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证版本响应无效');
  }
  const owner = parsePlatformSupplyOwner(value);
  const schemaVersion = value.envelopeSchemaVersion ?? value.schemaVersion;
  const wrappingRevision = value.wrappingRevision;
  return {
    ...owner,
    accountId: requiredString(value.accountId, 'accountId'),
    credentialId: requiredString(value.credentialId, 'credentialId'),
    version: supplyPositiveInteger(value.version, 'version'),
    status:
      value.status === 'active' || value.status === 'retired' || value.status === 'revoked'
        ? value.status
        : (() => {
            throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证版本响应中的 status 无效');
          })(),
    ...(schemaVersion === undefined ? {} : { envelopeSchemaVersion: supplyPositiveInteger(schemaVersion, 'schemaVersion') }),
    ...(value.contextVersion === undefined ? {} : { contextVersion: supplyPositiveInteger(value.contextVersion, 'contextVersion') }),
    ...(value.algorithm === undefined ? {} : { algorithm: requiredString(value.algorithm, 'algorithm') }),
    ...(value.kmsPurpose === undefined ? {} : { kmsPurpose: requiredString(value.kmsPurpose, 'kmsPurpose') }),
    ...(wrappingRevision === undefined ? {} : { wrappingRevision: supplyPositiveInteger(wrappingRevision, 'wrappingRevision') }),
    createdAt: requiredString(value.createdAt, 'createdAt'),
    expiresAt: supplyNullableString(value.expiresAt, 'expiresAt'),
    retiredAt: supplyNullableString(value.retiredAt, 'retiredAt'),
    revokedAt: supplyNullableString(value.revokedAt, 'revokedAt'),
  };
}

function parsePlatformSupplyCredential(value: unknown): PlatformSupplyCredential {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证响应无效');
  }
  const owner = parsePlatformSupplyOwner(value);
  const versionsValue = value.versions ?? value.credentialVersions;
  if (versionsValue !== undefined && !Array.isArray(versionsValue)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证响应中的 versions 无效');
  }
  const versions = versionsValue?.map(parsePlatformSupplyCredentialVersion);
  return {
    ...owner,
    id: requiredString(value.id, 'id'),
    accountId: requiredString(value.accountId, 'accountId'),
    providerId: requiredString(value.providerId, 'providerId'),
    productId: requiredString(value.productId, 'productId'),
    credentialType: requiredString(value.credentialType, 'credentialType'),
    status: parsePlatformSupplyStatus(value.status, 'status'),
    validationState: parsePlatformSupplyValidationState(value.validationState, 'validationState'),
    validationErrorCode: supplyNullableString(value.validationErrorCode, 'validationErrorCode'),
    lastValidatedAt: supplyNullableString(value.lastValidatedAt, 'lastValidatedAt'),
    currentVersion: value.currentVersion === null || value.currentVersion === undefined
      ? null
      : supplyPositiveInteger(value.currentVersion, 'currentVersion'),
    expiresAt: supplyNullableString(value.expiresAt, 'expiresAt'),
    authzVersion: supplyPositiveInteger(value.authzVersion, 'authzVersion'),
    createdAt: requiredString(value.createdAt, 'createdAt'),
    updatedAt: requiredString(value.updatedAt, 'updatedAt'),
    disabledAt: supplyNullableString(value.disabledAt, 'disabledAt'),
    revokedAt: supplyNullableString(value.revokedAt, 'revokedAt'),
    ...(versions === undefined ? {} : { versions }),
  };
}

function nestedSupplyRecord(value: unknown, key: 'account' | 'credential'): unknown {
  if (!isRecord(value)) return value;
  return isRecord(value[key]) ? value[key] : value;
}

function parsePlatformSupplyAccountList(value: unknown): PlatformSupplyAccount[] {
  if (Array.isArray(value)) return value.map(parsePlatformSupplyAccount);
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给账号列表响应无效');
  }
  const items = Array.isArray(value.items) ? value.items : value.accounts;
  if (!Array.isArray(items)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给账号列表响应无效');
  }
  return items.map(parsePlatformSupplyAccount);
}

function parsePlatformSupplyCredentialList(value: unknown): PlatformSupplyCredential[] {
  if (Array.isArray(value)) return value.map(parsePlatformSupplyCredentialValue);
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证列表响应无效');
  }
  const items = Array.isArray(value.items) ? value.items : value.credentials;
  if (!Array.isArray(items)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证列表响应无效');
  }
  return items.map(parsePlatformSupplyCredentialValue);
}

function parsePlatformSupplyCredentialWrappingStatus(value: unknown): PlatformSupplyCredentialWrappingStatus {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'credentialVersion,state,wrappingRevision' ||
    (value.state !== 'ready' && value.state !== 'already_current' && value.state !== 'not_eligible')
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '凭证重封装状态响应无效');
  }
  return {
    state: value.state,
    credentialVersion: value.credentialVersion === null
      ? null
      : supplyPositiveInteger(value.credentialVersion, 'credentialVersion'),
    wrappingRevision: value.wrappingRevision === null
      ? null
      : supplyPositiveInteger(value.wrappingRevision, 'wrappingRevision'),
  };
}

function parsePlatformSupplyCredentialRewrapResult(value: unknown): PlatformSupplyCredentialRewrapResult {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !==
      'credentialVersion,expectedWrappingRevision,refreshRequired,state,wrappingRevision' ||
    (value.state !== 'succeeded' && value.state !== 'unknown' && value.state !== 'conflict' && value.state !== 'error') ||
    typeof value.refreshRequired !== 'boolean'
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '凭证重封装响应无效');
  }
  return {
    state: value.state,
    credentialVersion: supplyPositiveInteger(value.credentialVersion, 'credentialVersion'),
    expectedWrappingRevision: supplyPositiveInteger(value.expectedWrappingRevision, 'expectedWrappingRevision'),
    wrappingRevision: value.wrappingRevision === null
      ? null
      : supplyPositiveInteger(value.wrappingRevision, 'wrappingRevision'),
    refreshRequired: value.refreshRequired,
  };
}

function parsePlatformSupplyCredentialValue(value: unknown): PlatformSupplyCredential {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证列表项无效');
  }
  const nested = nestedSupplyRecord(value, 'credential');
  if (isRecord(nested) && nested.versions === undefined && Array.isArray(value.versions)) {
    return parsePlatformSupplyCredential({ ...nested, versions: value.versions });
  }
  return parsePlatformSupplyCredential(nested);
}

function parsePlatformSupplyCredentialWriteResult(value: unknown): PlatformSupplyCredentialWriteResult {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '供给凭证写入响应无效');
  }
  const credential = parsePlatformSupplyCredential(nestedSupplyRecord(value, 'credential'));
  const versionValue = isRecord(value.version) ? value.version : undefined;
  return {
    credential,
    ...(versionValue === undefined ? {} : { version: parsePlatformSupplyCredentialVersion(versionValue) }),
  };
}

function catalogPath(path: string, query: PlatformCatalogPageQuery): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.providerId !== undefined) params.set('providerId', query.providerId);
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function pricingTargetPath(query: PlatformPricingTargetQuery): string {
  const params = new URLSearchParams({ kind: query.kind });
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return `/pricing/targets?${params.toString()}`;
}

function pricingHistoryPath(query: PlatformPriceVersionHistoryQuery): string {
  const params = new URLSearchParams({
    kind: query.kind,
    publicModelId: query.publicModelId,
    publicModelVersion: String(query.publicModelVersion),
    protocol: query.protocol,
    endpoint: query.endpoint,
    currency: query.currency,
  });
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return `/pricing/versions?${params.toString()}`;
}

function priceRegistrationBody(input: PlatformPriceVersionRegistrationInput): Record<string, unknown> {
  const rates: Record<string, unknown> = { input: input.rates.input, output: input.rates.output };
  for (const metric of ['cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'] as const) {
    if (input.rates[metric] !== undefined) rates[metric] = input.rates[metric];
  }
  return {
    publicModelId: input.publicModelId,
    publicModelVersion: input.publicModelVersion,
    protocol: input.protocol,
    endpoint: input.endpoint,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    effectiveAt: input.effectiveAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    commercialPolicyVersion: input.commercialPolicyVersion,
    calculatorVersion: input.calculatorVersion,
    roundingVersion: input.roundingVersion,
    roundingMode: input.roundingMode,
    ...(input.roundingBoundary === undefined ? {} : { roundingBoundary: input.roundingBoundary }),
    rates,
  };
}

function operationsSummaryPath(query: PlatformOperationsSummaryQuery): string {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  return `/ops/summary?${params.toString()}`;
}

const CAPACITY_POLICY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_CAPACITY_REVISION = 9_223_372_036_854_775_807n;

function capacityPolicyId(value: string, field: string): string {
  if (typeof value !== 'string' || !CAPACITY_POLICY_ID_PATTERN.test(value) || value.trim() !== value) {
    throw new PlatformApiError(400, 'INVALID_POLICY_TARGET', `请输入有效的 ${field} UUID`);
  }
  return value.toLowerCase();
}

function capacityPolicyPath(target: PlatformCapacityPolicyTarget): string {
  const tenantId = capacityPolicyId(target.tenantId, '租户 ID');
  if (target.scope === 'tenant') return `/capacity/tenants/${encodeURIComponent(tenantId)}`;
  const projectId = capacityPolicyId(target.projectId, '项目 ID');
  const projectPath = `/capacity/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}`;
  if (target.scope === 'project') return projectPath;
  return `${projectPath}/api-keys/${encodeURIComponent(capacityPolicyId(target.apiKeyId, 'API key ID'))}`;
}

function capacityPolicyTargetPagePath(path: string, cursor?: string): string {
  if (cursor === undefined) return path;
  const params = new URLSearchParams({ cursor: capacityPolicyId(cursor, '分页游标') });
  return `${path}?${params.toString()}`;
}

function parseCapacityPolicyTargetPage(value: unknown): PlatformCapacityPolicyTargetPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 25) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略目标分页响应无效');
  }
  const items = value.items.map((item) => {
    if (!isRecord(item)) throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略目标分页响应无效');
    try {
      return { id: capacityPolicyId(item.id as string, '目标 ID') };
    } catch {
      throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略目标分页响应无效');
    }
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略目标分页响应包含重复项');
  }
  let nextCursor: string | null;
  if (value.nextCursor === null) {
    nextCursor = null;
  } else {
    try {
      nextCursor = capacityPolicyId(value.nextCursor as string, '分页游标');
    } catch {
      throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略目标分页响应无效');
    }
    if (items.at(-1)?.id !== nextCursor) {
      throw new PlatformApiError(200, 'INVALID_RESPONSE', '容量策略目标分页游标无效');
    }
  }
  return { items, nextCursor };
}

function validateCapacityPolicyUpdate(input: PlatformCapacityPolicyUpdateInput): PlatformCapacityPolicyUpdateInput {
  if (
    typeof input.expectedRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/u.test(input.expectedRevision) ||
    BigInt(input.expectedRevision) > MAX_CAPACITY_REVISION
  ) {
    throw new PlatformApiError(400, 'INVALID_POLICY_REVISION', '策略版本必须是有效的正整数');
  }
  if (
    !input.limits ||
    !Number.isSafeInteger(input.limits.requestsPerMinute) ||
    input.limits.requestsPerMinute < 1 ||
    !Number.isSafeInteger(input.limits.tokensPerMinute) ||
    input.limits.tokensPerMinute < 1 ||
    !Number.isSafeInteger(input.limits.maxConcurrentRequests) ||
    input.limits.maxConcurrentRequests < 1 ||
    input.limits.maxConcurrentRequests > 2_147_483_647
  ) {
    throw new PlatformApiError(400, 'INVALID_POLICY_LIMITS', '所有容量上限必须是有效的正整数');
  }
  if (!(PLATFORM_CAPACITY_POLICY_REASONS as readonly string[]).includes(input.reason)) {
    throw new PlatformApiError(400, 'INVALID_POLICY_REASON', '请选择有效的审计原因');
  }
  return {
    expectedRevision: input.expectedRevision,
    limits: { ...input.limits },
    reason: input.reason,
  };
}

function auditPath(query: PlatformAuditPageQuery): string {
  const params = new URLSearchParams();
  if (query.actorId !== undefined) params.set('actorId', query.actorId);
  if (query.action !== undefined) params.set('action', query.action);
  if (query.entityType !== undefined) params.set('entityType', query.entityType);
  if (query.createdFrom !== undefined) params.set('createdFrom', query.createdFrom);
  if (query.createdTo !== undefined) params.set('createdTo', query.createdTo);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const encoded = params.toString();
  return encoded ? `/audit/events?${encoded}` : '/audit/events';
}

function rightsRevokePath(rightsId: string): string {
  return `/catalog/rights/${encodeURIComponent(rightsId)}/revoke`;
}

export type PlatformSupplyLifecycleAction = 'enable' | 'disable' | 'revoke';

function supplyAccountPath(accountId: string): string {
  return `/supply/accounts/${encodeURIComponent(accountId)}`;
}

function supplyAccountActionPath(accountId: string, action: PlatformSupplyLifecycleAction): string {
  return `${supplyAccountPath(accountId)}/${action}`;
}

function supplyCredentialPath(credentialId: string): string {
  return `/supply/credentials/${encodeURIComponent(credentialId)}`;
}

function supplyCredentialRewrapPath(accountId: string, credentialId: string): string {
  return `${supplyAccountPath(accountId)}/credentials/${encodeURIComponent(credentialId)}/rewrap`;
}

function supplyCredentialActionPath(credentialId: string, action: PlatformSupplyLifecycleAction): string {
  return `${supplyCredentialPath(credentialId)}/${action}`;
}

function supplyAccountLifecycleRequest(
  accountId: string,
  action: PlatformSupplyLifecycleAction,
  input: PlatformSupplyLifecycleInput,
  options: ReadRequestOptions,
): Promise<PlatformSupplyAccount> {
  return request<unknown>(supplyAccountActionPath(accountId, action), {
    ...options,
    method: 'POST',
    body: { expectedAuthzVersion: input.expectedAuthzVersion },
  }).then(value => parsePlatformSupplyAccount(nestedSupplyRecord(value, 'account')));
}

function supplyCredentialLifecycleRequest(
  credentialId: string,
  action: PlatformSupplyLifecycleAction,
  input: PlatformSupplyLifecycleInput,
  options: ReadRequestOptions,
): Promise<PlatformSupplyCredential> {
  return request<unknown>(supplyCredentialActionPath(credentialId, action), {
    ...options,
    method: 'POST',
    body: { expectedAuthzVersion: input.expectedAuthzVersion },
  }).then(value => parsePlatformSupplyCredential(nestedSupplyRecord(value, 'credential')));
}

function parseAuditUuid(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `审计响应中的 ${field} 无效`);
  }
  return value.toLowerCase();
}

function parseAuditNullableText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    [...value].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `审计响应中的 ${field} 无效`);
  }
  return value;
}

function parseAuditOperatorAttestation(
  value: unknown,
  event: PlatformAuditEvent,
  context: Record<string, unknown>,
): PlatformAuditOperatorAttestation | undefined {
  if (value === undefined) return undefined;
  const invalid = (): never => {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '审计响应中的运维声明无效');
  };
  if (!isRecord(value)) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some(key => key !== 'operatorId' && key !== 'reasonCode' && key !== 'outcome')) {
    return invalid();
  }
  if (context.tenantId !== null || event.actorId !== null
    || context.entryPoint !== 'trusted_operator_cli:platform_mfa_enroll'
    || (event.action !== 'platform_mfa.enrollment_token.issued'
      && event.action !== 'platform_mfa.enrollment_token.denied')
    || typeof value.operatorId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value.operatorId)) return invalid();
  const reasonCode = value.reasonCode;
  const outcome = value.outcome;
  if (reasonCode !== 'initial-enrollment' && reasonCode !== 'approved-enrollment') return invalid();
  if (outcome !== 'issued' && outcome !== 'target-unavailable'
    && outcome !== 'verified-totp-present' && outcome !== 'enrollment-pending') return invalid();
  if ((event.action === 'platform_mfa.enrollment_token.issued') !== (outcome === 'issued')) return invalid();
  if (event.entityType === 'platform_mfa_enrollment_user') {
    parseAuditUuid(event.entityId, 'entityId');
  } else if (event.entityType !== 'platform_mfa_enrollment_email_digest'
    || outcome !== 'target-unavailable' || context.entityId !== null) return invalid();
  return { operatorId: value.operatorId, reasonCode, outcome };
}

function parseAuditEvent(value: unknown): PlatformAuditEvent {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '审计事件响应无效');
  }
  const action = value.action;
  const entityType = value.entityType;
  const occurredAt = value.occurredAt;
  if (
    typeof action !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action) ||
    typeof entityType !== 'string' ||
    entityType.length === 0 ||
    entityType.length > 128 ||
    entityType.trim() !== entityType ||
    [...entityType].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f) ||
    typeof occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    new Date(occurredAt).toISOString() !== occurredAt
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '审计事件响应无效');
  }

  const event: PlatformAuditEvent = {
    id: parseAuditUuid(value.id, 'id') as string,
    actorId: parseAuditUuid(value.actorId, 'actorId', true),
    action,
    entityType,
    entityId: entityType === 'platform_mfa_enrollment_email_digest'
      ? null : parseAuditNullableText(value.entityId, 'entityId', 512),
    occurredAt,
  };
  const operatorAttestation = parseAuditOperatorAttestation(value.operatorAttestation, event, value);
  return { ...event, ...(operatorAttestation === undefined ? {} : { operatorAttestation }) };
}

function parseAuditPage(value: unknown): PlatformAuditEventPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    typeof value.hasMore !== 'boolean' ||
    (value.nextCursor !== null && typeof value.nextCursor !== 'string')
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '审计分页响应无效');
  }
  return {
    items: value.items.map(parseAuditEvent),
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
  };
}

const UNKNOWN_OUTCOME_DEFAULT_LIMIT = 50;
const UNKNOWN_OUTCOME_MAX_LIMIT = 100;
const UNKNOWN_OUTCOME_MAX_COVERAGE = 100;
const UNKNOWN_OUTCOME_MAX_OBSERVATIONS = 2_000;
const UNKNOWN_OUTCOME_MAX_SCAN_ATTEMPTS = 12;

function unknownOutcomeText(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `未知结果响应中的 ${field} 无效`);
  }
  return value;
}

function unknownOutcomeNullableText(value: unknown, field: string, maximum = 512): string | null {
  return value === null || value === undefined ? null : unknownOutcomeText(value, field, maximum);
}

function unknownOutcomeTimestamp(value: unknown, field: string): string {
  const timestamp = unknownOutcomeText(value, field, 64);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `未知结果响应中的 ${field} 无效`);
  }
  return new Date(parsed).toISOString();
}

function unknownOutcomeNullableInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `未知结果响应中的 ${field} 无效`);
  }
  return value;
}

function parseUnknownOutcomeSupplyMode(value: unknown, field: string): PlatformUnknownOutcomeSupplyMode {
  if (value !== 'byok' && value !== 'platform') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', `未知结果响应中的 ${field} 无效`);
  }
  return value;
}

function parseUnknownOutcomeExecutionState(value: unknown): PlatformUnknownOutcomeExecutionState | null {
  if (value === null || value === undefined) return null;
  if (value !== 'pending' && value !== 'succeeded' && value !== 'failed' && value !== 'unknown') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果响应中的 executionState 无效');
  }
  return value;
}

function parseUnknownOutcomeReconciliationState(value: unknown): PlatformUnknownOutcomeReconciliationState | null {
  if (value === null || value === undefined) return null;
  if (value !== 'none' && value !== 'pending' && value !== 'resolved') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果响应中的 reconciliationState 无效');
  }
  return value;
}

function parseUnknownOutcomeObservationKind(value: unknown): PlatformUnknownOutcomeObservationKind {
  if (
    value !== 'request_snapshot' &&
    value !== 'attempt_snapshot' &&
    value !== 'usage_snapshot' &&
    value !== 'provider_evidence' &&
    value !== 'operator_resolution'
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果响应中的 observation kind 无效');
  }
  return value;
}

function parseUnknownOutcomeCaseSummary(value: unknown): PlatformUnknownOutcomeCaseSummary {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件摘要无效');
  }
  const scanAttempts = value.scanAttempts;
  if (
    typeof scanAttempts !== 'number' ||
    !Number.isSafeInteger(scanAttempts) ||
    scanAttempts < 0 ||
    scanAttempts > UNKNOWN_OUTCOME_MAX_SCAN_ATTEMPTS
  ) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果响应中的 scanAttempts 无效');
  }
  return {
    caseId: unknownOutcomeText(value.caseId, 'caseId'),
    tenantId: unknownOutcomeText(value.tenantId, 'tenantId'),
    projectId: unknownOutcomeText(value.projectId, 'projectId'),
    requestId: unknownOutcomeText(value.requestId, 'requestId'),
    supplyMode: parseUnknownOutcomeSupplyMode(value.supplyMode, 'supplyMode'),
    scanAttempts,
    lastErrorCode: unknownOutcomeNullableText(value.lastErrorCode, 'lastErrorCode', 64),
    createdAt: unknownOutcomeTimestamp(value.createdAt, 'createdAt'),
  };
}

function parseUnknownOutcomeObservation(value: unknown): PlatformUnknownOutcomeObservation {
  if (!isRecord(value)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果响应中的 observation 无效');
  }
  const responseStarted = value.responseStarted;
  if (responseStarted !== null && responseStarted !== undefined && typeof responseStarted !== 'boolean') {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果响应中的 responseStarted 无效');
  }
  return {
    observationId: unknownOutcomeText(value.observationId, 'observationId'),
    kind: parseUnknownOutcomeObservationKind(value.kind),
    observedAt: unknownOutcomeTimestamp(value.observedAt, 'observedAt'),
    attemptId: unknownOutcomeNullableText(value.attemptId, 'attemptId'),
    usageEventId: unknownOutcomeNullableText(value.usageEventId, 'usageEventId'),
    supplyMode:
      value.supplyMode === null || value.supplyMode === undefined
        ? null
        : parseUnknownOutcomeSupplyMode(value.supplyMode, 'supplyMode'),
    executionState: parseUnknownOutcomeExecutionState(value.executionState),
    reconciliationState: parseUnknownOutcomeReconciliationState(value.reconciliationState),
    financialStatus: unknownOutcomeNullableText(value.financialStatus, 'financialStatus', 128),
    requestStateVersion: unknownOutcomeNullableInteger(value.requestStateVersion, 'requestStateVersion'),
    dispatchState: unknownOutcomeNullableText(value.dispatchState, 'dispatchState', 128),
    resultState: unknownOutcomeNullableText(value.resultState, 'resultState', 128),
    responseStarted: responseStarted === undefined ? null : responseStarted,
    attemptStateVersion: unknownOutcomeNullableInteger(value.attemptStateVersion, 'attemptStateVersion'),
    upstreamId: unknownOutcomeNullableText(value.upstreamId, 'upstreamId'),
    accountOwnerKind: unknownOutcomeNullableText(value.accountOwnerKind, 'accountOwnerKind', 128),
    accountId: unknownOutcomeNullableText(value.accountId, 'accountId'),
    providerId: unknownOutcomeNullableText(value.providerId, 'providerId'),
    productId: unknownOutcomeNullableText(value.productId, 'productId'),
    resolvedModel: unknownOutcomeNullableText(value.resolvedModel, 'resolvedModel', 512),
    unknownReason: unknownOutcomeNullableText(value.unknownReason, 'unknownReason', 1024),
    usageEventDigest: unknownOutcomeNullableText(value.usageEventDigest, 'usageEventDigest', 64),
    providerStatus: unknownOutcomeNullableText(value.providerStatus, 'providerStatus', 128),
    providerOperationId: unknownOutcomeNullableText(value.providerOperationId, 'providerOperationId'),
    providerIdentityDigest: unknownOutcomeNullableText(value.providerIdentityDigest, 'providerIdentityDigest', 64),
    evidenceReference: unknownOutcomeNullableText(value.evidenceReference, 'evidenceReference'),
    operatorOutcome: unknownOutcomeNullableText(value.operatorOutcome, 'operatorOutcome', 128),
    auditEventId: unknownOutcomeNullableText(value.auditEventId, 'auditEventId'),
  };
}

function parseUnknownOutcomeCaseDetail(value: unknown): PlatformUnknownOutcomeCaseDetail {
  if (!isRecord(value) || !Array.isArray(value.possibleAttemptIds) || !Array.isArray(value.observations)) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件详情无效');
  }
  if (value.possibleAttemptIds.length > UNKNOWN_OUTCOME_MAX_COVERAGE) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件包含过多可能尝试');
  }
  const possibleAttemptIds = value.possibleAttemptIds.map((attemptId, index) =>
    unknownOutcomeText(attemptId, `possibleAttemptIds[${index}]`),
  );
  if (new Set(possibleAttemptIds).size !== possibleAttemptIds.length) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件包含重复的可能尝试');
  }
  if (value.observations.length > UNKNOWN_OUTCOME_MAX_OBSERVATIONS) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件包含过多观察记录');
  }
  const observations = value.observations.map(parseUnknownOutcomeObservation);
  if (new Set(observations.map(observation => observation.observationId)).size !== observations.length) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件包含重复的观察记录');
  }
  return {
    summary: parseUnknownOutcomeCaseSummary(value.summary),
    possibleAttemptIds,
    observations,
  };
}

function parseUnknownOutcomeCaseList(value: unknown): PlatformUnknownOutcomeCaseSummary[] {
  const items = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : undefined;
  if (!items || items.length > UNKNOWN_OUTCOME_MAX_LIMIT) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件列表响应无效');
  }
  const summaries = items.map(parseUnknownOutcomeCaseSummary);
  if (new Set(summaries.map(summary => summary.caseId)).size !== summaries.length) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件列表包含重复案件');
  }
  return summaries;
}

function parseUnknownOutcomeResolutionResult(value: unknown): PlatformUnknownOutcomeResolutionResult {
  if (!isRecord(value) || (value.status !== 'resolved' && value.status !== 'replayed')) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果处置响应无效');
  }
  return {
    status: value.status,
    caseId: unknownOutcomeText(value.caseId, 'caseId'),
    requestId: unknownOutcomeText(value.requestId, 'requestId'),
  };
}

function unknownOutcomeRequestText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > maximum ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  ) {
    throw new PlatformApiError(400, 'INVALID_INPUT', `未知结果处置中的 ${field} 无效`);
  }
  return value.trim();
}

function unknownOutcomeListPath(query: PlatformUnknownOutcomeListQuery): string {
  const tenantId = unknownOutcomeRequestText(query.tenantId, 'tenantId', 255);
  const limit = query.limit ?? UNKNOWN_OUTCOME_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > UNKNOWN_OUTCOME_MAX_LIMIT) {
    throw new PlatformApiError(400, 'INVALID_INPUT', '未知结果案件列表 limit 无效');
  }
  const params = new URLSearchParams({ tenantId, limit: String(limit) });
  return `/ops/unknown-outcomes?${params.toString()}`;
}

function unknownOutcomeCasePath(tenantIdInput: string, caseIdInput: string, action?: string): string {
  const tenantId = unknownOutcomeRequestText(tenantIdInput, 'tenantId', 255);
  const caseId = unknownOutcomeRequestText(caseIdInput, 'caseId', 255);
  const params = new URLSearchParams({ tenantId });
  return `/ops/unknown-outcomes/${encodeURIComponent(caseId)}${action ? `/${action}` : ''}?${params.toString()}`;
}

function validateUnknownOutcomeResolutionInput(input: PlatformUnknownOutcomeResolutionInput): {
  tenantId: string;
  caseId: string;
  supportTicketRef: string;
  reason: string;
  coverage: PlatformUnknownOutcomeCoverageInput[];
  idempotencyKey: string;
} {
  const tenantId = unknownOutcomeRequestText(input.tenantId, 'tenantId', 255);
  const caseId = unknownOutcomeRequestText(input.caseId, 'caseId', 255);
  const supportTicketRef = unknownOutcomeRequestText(input.supportTicketRef, 'supportTicketRef', 255);
  const reason = unknownOutcomeRequestText(input.reason, 'reason', 2_000);
  const idempotencyKey = unknownOutcomeRequestText(input.idempotencyKey, 'idempotencyKey', 255);
  if (!Array.isArray(input.coverage) || input.coverage.length === 0 || input.coverage.length > UNKNOWN_OUTCOME_MAX_COVERAGE) {
    throw new PlatformApiError(400, 'INVALID_INPUT', '未知结果处置必须逐项提供 evidenceReference');
  }
  const coverage = input.coverage.map((item, index) => {
    if (!isRecord(item)) {
      throw new PlatformApiError(400, 'INVALID_INPUT', `未知结果处置中的 coverage[${index}] 无效`);
    }
    return {
      attemptId: unknownOutcomeRequestText(item.attemptId, `coverage[${index}].attemptId`, 255),
      evidenceReference: unknownOutcomeRequestText(
        item.evidenceReference,
        `coverage[${index}].evidenceReference`,
        512,
      ),
    };
  });
  if (new Set(coverage.map(item => item.attemptId)).size !== coverage.length) {
    throw new PlatformApiError(400, 'INVALID_INPUT', '未知结果处置中的 attemptId 不能重复');
  }
  return { tenantId, caseId, supportTicketRef, reason, coverage, idempotencyKey };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (method === 'POST' && options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new PlatformApiError(0, 'NETWORK', '无法连接管理服务');
  }

  const raw = await response.text();
  if (response.status === 401) clearPlatformCsrfToken();
  let parsed: ApiEnvelope<T> | undefined;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw) as ApiEnvelope<T>;
    } catch {
      throw new PlatformApiError(response.status, 'INVALID_RESPONSE', '服务返回了无效 JSON');
    }
  }

  if (!response.ok) {
    const error = parsed?.error;
    throw new PlatformApiError(
      response.status,
      error?.code ?? 'HTTP_ERROR',
      error?.message ?? '管理请求失败',
      error?.requestId,
    );
  }

  if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'data')) {
    throw new PlatformApiError(response.status, 'INVALID_RESPONSE', '服务响应缺少 data');
  }
  return parsed.data as T;
}

function parseLogin(value: unknown): PlatformLoginResult {
  if (!isRecord(value) || typeof value.csrfToken !== 'string' || value.csrfToken.length === 0) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '登录响应缺少安全令牌');
  }

  const session = parseSession(value.session);
  csrfToken = value.csrfToken;
  return { session };
}

function parseLogout(value: unknown): { loggedOut: boolean } {
  if (!isRecord(value) || value.loggedOut !== true) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', '退出登录响应无效');
  }
  return { loggedOut: true };
}

function parseConfirmation(value: unknown): { confirmed: boolean } {
  if (!isRecord(value) || value.confirmed !== true) {
    throw new PlatformApiError(200, 'INVALID_RESPONSE', 'MFA 确认响应无效');
  }
  return { confirmed: true };
}

export function clearPlatformCsrfToken(): void {
  csrfToken = undefined;
}

/** The token stays in this module's memory; it is never persisted in browser storage. */
export function hasPlatformCsrfToken(): boolean {
  return csrfToken !== undefined;
}

export function isPlatformApiUnavailable(error: unknown): boolean {
  return (
    error instanceof PlatformApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501 || error.code === 'NOT_FOUND')
  );
}

export const platformClient = {
  async login(input: PlatformLoginInput): Promise<PlatformLoginResult> {
    clearPlatformCsrfToken();
    const value = await request<unknown>('/auth/session', {
      method: 'POST',
      body: input,
    });
    return parseLogin(value);
  },

  getSession(options: ReadRequestOptions = {}): Promise<PlatformAuthSession> {
    return request<unknown>('/auth/session', options).then((value) => {
      if (!isRecord(value)) {
        throw new PlatformApiError(200, 'INVALID_RESPONSE', '会话响应无效');
      }
      return parseSession(value.session);
    });
  },

  async logout(): Promise<{ loggedOut: boolean }> {
    try {
      const value = await request<unknown>('/auth/session', { method: 'DELETE' });
      return parseLogout(value);
    } finally {
      clearPlatformCsrfToken();
    }
  },

  startMfaEnrollment(
    issuer: string,
    enrollmentToken: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformMfaEnrollmentStart> {
    return request<unknown>('/auth/mfa/enrollment/start', {
      ...options,
      method: 'POST',
      body: { issuer },
      bearerToken: enrollmentToken,
    }).then(parseEnrollment);
  },

  async confirmMfaEnrollment(
    confirmationToken: string,
    code: string,
    options: ReadRequestOptions = {},
  ): Promise<{ confirmed: boolean }> {
    const value = await request<unknown>('/auth/mfa/enrollment/confirm', {
      ...options,
      method: 'POST',
      body: { confirmationToken, code },
    });
    return parseConfirmation(value);
  },

  getMe(options: ReadRequestOptions = {}): Promise<PlatformMe> {
    return request<unknown>('/me', options).then(parseMe);
  },

  getOpsSummary(query: PlatformOperationsSummaryQuery): Promise<PlatformOperationsSummary> {
    return request<unknown>(operationsSummaryPath(query), { signal: query.signal }).then(parseOperationsSummary);
  },

  listUnknownOutcomeCases(query: PlatformUnknownOutcomeListQuery): Promise<PlatformUnknownOutcomeCaseSummary[]> {
    const tenantId = unknownOutcomeRequestText(query.tenantId, 'tenantId', 255);
    return request<unknown>(unknownOutcomeListPath({ ...query, tenantId }), { signal: query.signal }).then((value) => {
      const cases = parseUnknownOutcomeCaseList(value);
      if (cases.some(item => item.tenantId !== tenantId)) {
        throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件列表越过了租户边界');
      }
      return cases;
    });
  },

  /** Alias matching the API resource name; both methods use the same strict parser. */
  listUnknownOutcomes(query: PlatformUnknownOutcomeListQuery): Promise<PlatformUnknownOutcomeCaseSummary[]> {
    return platformClient.listUnknownOutcomeCases(query);
  },

  getUnknownOutcomeCase(
    tenantId: string,
    caseId: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformUnknownOutcomeCaseDetail> {
    const requestedTenantId = unknownOutcomeRequestText(tenantId, 'tenantId', 255);
    const requestedCaseId = unknownOutcomeRequestText(caseId, 'caseId', 255);
    return request<unknown>(unknownOutcomeCasePath(requestedTenantId, requestedCaseId), options).then((value) => {
      const detail = parseUnknownOutcomeCaseDetail(value);
      if (detail.summary.tenantId !== requestedTenantId || detail.summary.caseId !== requestedCaseId) {
        throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果案件详情越过了租户或案件边界');
      }
      return detail;
    });
  },

  getUnknownOutcome(
    tenantId: string,
    caseId: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformUnknownOutcomeCaseDetail> {
    return platformClient.getUnknownOutcomeCase(tenantId, caseId, options);
  },

  resolveUnknownOutcomeNotExecuted(
    input: PlatformUnknownOutcomeResolutionInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformUnknownOutcomeResolutionResult> {
    const validated = validateUnknownOutcomeResolutionInput(input);
    return request<unknown>(unknownOutcomeCasePath(validated.tenantId, validated.caseId, 'resolve-not-executed'), {
      ...options,
      method: 'POST',
      idempotencyKey: validated.idempotencyKey,
      body: {
        supportTicketRef: validated.supportTicketRef,
        reason: validated.reason,
        outcome: 'not_executed',
        coverage: validated.coverage.map(item => ({
          attemptId: item.attemptId,
          outcome: 'not_executed' as const,
          evidenceReference: item.evidenceReference,
        })),
      },
    }).then((value) => {
      const result = parseUnknownOutcomeResolutionResult(value);
      if (result.caseId !== validated.caseId) {
        throw new PlatformApiError(200, 'INVALID_RESPONSE', '未知结果处置响应中的案件 ID 无效');
      }
      return result;
    });
  },

  resolveUnknownOutcome(
    input: PlatformUnknownOutcomeResolutionInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformUnknownOutcomeResolutionResult> {
    return platformClient.resolveUnknownOutcomeNotExecuted(input, options);
  },

  getCapacityPolicy(
    target: PlatformCapacityPolicyTarget,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCapacityPolicy> {
    return request<unknown>(capacityPolicyPath(target), options).then((value) => parseCapacityPolicy(value, target));
  },

  listCapacityPolicyTenants(
    cursor?: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCapacityPolicyTargetPage> {
    return request<unknown>(capacityPolicyTargetPagePath('/capacity/targets/tenants', cursor), options)
      .then(parseCapacityPolicyTargetPage);
  },

  listCapacityPolicyProjects(
    tenantId: string,
    cursor?: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCapacityPolicyTargetPage> {
    const path = `/capacity/targets/tenants/${encodeURIComponent(capacityPolicyId(tenantId, '租户 ID'))}/projects`;
    return request<unknown>(capacityPolicyTargetPagePath(path, cursor), options).then(parseCapacityPolicyTargetPage);
  },

  listCapacityPolicyApiKeys(
    tenantId: string,
    projectId: string,
    cursor?: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCapacityPolicyTargetPage> {
    const path = `/capacity/targets/tenants/${encodeURIComponent(capacityPolicyId(tenantId, '租户 ID'))}` +
      `/projects/${encodeURIComponent(capacityPolicyId(projectId, '项目 ID'))}/api-keys`;
    return request<unknown>(capacityPolicyTargetPagePath(path, cursor), options).then(parseCapacityPolicyTargetPage);
  },

  updateCapacityPolicy(
    target: PlatformCapacityPolicyTarget,
    input: PlatformCapacityPolicyUpdateInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCapacityPolicy> {
    const body = validateCapacityPolicyUpdate(input);
    return request<unknown>(capacityPolicyPath(target), {
      ...options,
      method: 'PUT',
      body,
    }).then((value) => parseCapacityPolicy(value, target));
  },

  requestWalletTopUpRefund(input: PlatformWalletTopUpRefundInput): Promise<PlatformRefundRecord> {
    const tenantId = refundRequestField(input.tenantId, 'tenantId', 255);
    const orderId = refundRequestField(input.orderId, 'orderId', 255);
    const reasonCode = refundRequestField(input.reasonCode, 'reasonCode', 96);
    if (
      typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim() === '' || input.idempotencyKey.length > 255 ||
      [...input.idempotencyKey].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)
    ) {
      throw new PlatformApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '退款申请需要有效的幂等键');
    }
    const idempotencyKey = input.idempotencyKey.trim();
    return request<unknown>('/payments/refunds', {
      method: 'POST',
      body: { tenantId, orderId, reasonCode },
      idempotencyKey,
    }).then(parsePlatformRefundRecord);
  },

  getRefund(tenantId: string, refundId: string, options: ReadRequestOptions = {}): Promise<PlatformRefundRecord> {
    return request<unknown>(refundRecordPath(tenantId, refundId), options).then(parsePlatformRefundRecord);
  },

  listProducts(query: PlatformCatalogProductsQuery = {}): Promise<PlatformCatalogPage<PlatformCatalogProduct>> {
    return request<unknown>(catalogPath('/catalog/products', query), { signal: query.signal })
      .then(value => parseCatalogPage(value, parseCatalogProduct));
  },

  listCapabilities(query: PlatformCatalogPageQuery = {}): Promise<PlatformCatalogPage<PlatformCatalogCapability>> {
    return request<unknown>(catalogPath('/catalog/capabilities', query), { signal: query.signal })
      .then(value => parseCatalogPage(value, parseCatalogCapability));
  },

  listRights(query: PlatformCatalogPageQuery = {}): Promise<PlatformCatalogPage<PlatformCatalogRights>> {
    return request<unknown>(catalogPath('/catalog/rights', query), { signal: query.signal })
      .then(value => parseCatalogPage(value, parseCatalogRights));
  },

  listPricingTargets(query: PlatformPricingTargetQuery): Promise<PlatformCatalogPage<PlatformPricingTarget>> {
    return request<unknown>(pricingTargetPath(query), { signal: query.signal })
      .then(value => parseCatalogPage(value, parsePlatformPricingTarget));
  },

  listPriceVersionHistory(query: PlatformPriceVersionHistoryQuery): Promise<PlatformCatalogPage<PlatformPriceVersion>> {
    return request<unknown>(pricingHistoryPath(query), { signal: query.signal })
      .then(value => parseCatalogPage(value, parsePlatformPriceVersion));
  },

  registerCustomerPriceVersion(
    input: PlatformPriceVersionRegistrationInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformPriceVersion> {
    return request<unknown>('/pricing/customer-versions', {
      ...options,
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: priceRegistrationBody(input),
    }).then(parsePlatformPriceVersion);
  },

  registerSupplierCostVersion(
    input: PlatformPriceVersionRegistrationInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformPriceVersion> {
    return request<unknown>('/pricing/supplier-cost-versions', {
      ...options,
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: priceRegistrationBody(input),
    }).then(parsePlatformPriceVersion);
  },

  listSupplyAccounts(options: ReadRequestOptions = {}): Promise<PlatformSupplyAccount[]> {
    return request<unknown>('/supply/accounts', options).then(parsePlatformSupplyAccountList);
  },

  createSupplyAccount(
    input: PlatformSupplyAccountCreateInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyAccount> {
    return request<unknown>('/supply/accounts', {
      ...options,
      method: 'POST',
      body: {
        displayName: input.displayName,
        providerId: input.providerId,
        productId: input.productId,
        credentialType: input.credentialType,
        region: input.region,
        purpose: input.purpose,
        rightsId: input.rightsId,
        rightsVersion: input.rightsVersion,
        capabilities: input.capabilities.map(capability => ({
          model: capability.model,
          endpoint: capability.endpoint,
          version: capability.version,
        })),
      },
    }).then(value => parsePlatformSupplyAccount(nestedSupplyRecord(value, 'account')));
  },

  listSupplyCredentials(accountId: string, options: ReadRequestOptions = {}): Promise<PlatformSupplyCredential[]> {
    return request<unknown>(`${supplyAccountPath(accountId)}/credentials`, options)
      .then(parsePlatformSupplyCredentialList);
  },

  getSupplyCredentialWrappingStatus(
    accountId: string,
    credentialId: string,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredentialWrappingStatus> {
    return request<unknown>(supplyCredentialRewrapPath(accountId, credentialId), options)
      .then(parsePlatformSupplyCredentialWrappingStatus);
  },

  rewrapSupplyCredential(
    accountId: string,
    credentialId: string,
    input: PlatformSupplyCredentialRewrapInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredentialRewrapResult> {
    return request<unknown>(supplyCredentialRewrapPath(accountId, credentialId), {
      ...options,
      method: 'POST',
      idempotencyKey: input.idempotencyKey,
      body: {
        expectedVersion: input.expectedVersion,
        expectedWrappingRevision: input.expectedWrappingRevision,
      },
    }).then(parsePlatformSupplyCredentialRewrapResult);
  },

  createSupplyCredential(
    accountId: string,
    input: PlatformSupplyCredentialSecretInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredentialWriteResult> {
    return request<unknown>(`${supplyAccountPath(accountId)}/credentials`, {
      ...options,
      method: 'POST',
      body: {
        secret: input.secret,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
    }).then(parsePlatformSupplyCredentialWriteResult);
  },

  rotateSupplyCredentialSecret(
    credentialId: string,
    input: PlatformSupplyCredentialRotationInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredentialWriteResult> {
    return request<unknown>(`${supplyCredentialPath(credentialId)}/secret`, {
      ...options,
      method: 'PUT',
      body: {
        expectedVersion: input.expectedVersion,
        secret: input.secret,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      },
    }).then(parsePlatformSupplyCredentialWriteResult);
  },

  rotateSupplyCredential(
    credentialId: string,
    input: PlatformSupplyCredentialRotationInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredentialWriteResult> {
    return platformClient.rotateSupplyCredentialSecret(credentialId, input, options);
  },

  setSupplyAccountLifecycle(
    accountId: string,
    action: PlatformSupplyLifecycleAction,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyAccount> {
    return supplyAccountLifecycleRequest(accountId, action, input, options);
  },

  enableSupplyAccount(
    accountId: string,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyAccount> {
    return supplyAccountLifecycleRequest(accountId, 'enable', input, options);
  },

  disableSupplyAccount(
    accountId: string,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyAccount> {
    return supplyAccountLifecycleRequest(accountId, 'disable', input, options);
  },

  revokeSupplyAccount(
    accountId: string,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyAccount> {
    return supplyAccountLifecycleRequest(accountId, 'revoke', input, options);
  },

  setSupplyCredentialLifecycle(
    credentialId: string,
    action: PlatformSupplyLifecycleAction,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredential> {
    return supplyCredentialLifecycleRequest(credentialId, action, input, options);
  },

  enableSupplyCredential(
    credentialId: string,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredential> {
    return supplyCredentialLifecycleRequest(credentialId, 'enable', input, options);
  },

  disableSupplyCredential(
    credentialId: string,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredential> {
    return supplyCredentialLifecycleRequest(credentialId, 'disable', input, options);
  },

  revokeSupplyCredential(
    credentialId: string,
    input: PlatformSupplyLifecycleInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformSupplyCredential> {
    return supplyCredentialLifecycleRequest(credentialId, 'revoke', input, options);
  },

  registerRightsVersion(
    input: PlatformCatalogRightsVersionInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCatalogRights> {
    return request<unknown>('/catalog/rights/versions', {
      ...options,
      method: 'POST',
      body: input,
    }).then(parseCatalogRights);
  },

  revokeRights(
    rightsId: string,
    input: PlatformCatalogRightsRevokeInput,
    options: ReadRequestOptions = {},
  ): Promise<PlatformCatalogRights> {
    return request<unknown>(rightsRevokePath(rightsId), {
      ...options,
      method: 'POST',
      body: input,
    }).then(parseCatalogRights);
  },

  listAuditEvents(query: PlatformAuditPageQuery = {}): Promise<PlatformAuditEventPage> {
    return request<unknown>(auditPath(query), { signal: query.signal })
      .then(parseAuditPage);
  },
};

export const saasPlatformClient = platformClient;
