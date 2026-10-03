const BASE = '/console/api/v1';

export type TenantRole = 'owner' | 'admin' | 'developer' | 'billing' | 'viewer';
export type ProjectRole = TenantRole;
export type InvitationRole = Exclude<TenantRole, 'owner'>;

export interface SafeIdentity {
  id: string;
  email: string;
  displayName: string | null;
  status: 'active';
  emailVerifiedAt: string | null;
  createdAt: string;
}

export interface SafeSession {
  userId: string;
  activeTenantId: null;
  expiresAt: string;
  createdAt: string;
}

export type CustomerSessionStatus = 'active' | 'revoked' | 'expired';

/** Allowlisted metadata returned by the customer's session-management routes. */
export interface SafeCustomerSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: CustomerSessionStatus;
  current: boolean;
}

export type CustomerRefundType = 'wallet_topup' | 'byok_service_plan';
export type CustomerRefundStatus = 'submitting' | 'pending' | 'succeeded' | 'failed' | 'unknown' | 'blocked';

/** Customer-safe refund metadata. Provider references and internal errors are intentionally omitted. */
export interface CustomerRefundSummary {
  id: string;
  refundType: CustomerRefundType;
  originalOrderId: string;
  amountMinorUnits: string;
  currency: string;
  status: CustomerRefundStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CustomerRefundPage {
  items: CustomerRefundSummary[];
  nextCursor: string | null;
}

export interface CustomerSessionRevocation {
  sessionId: string;
  revokedAt: string;
  currentSessionRevoked: boolean;
}

export interface OtherCustomerSessionsRevocation {
  revokedCount: number;
  currentSessionPreserved: true;
}

export interface SafeTenant {
  id: string;
  name: string;
  slug: string;
  status: 'active';
  role: TenantRole;
  createdAt: string;
  updatedAt: string;
  defaultProjectId?: string;
}

export interface Project {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
}

export type TenantMemberStatus = 'active' | 'suspended' | 'revoked' | 'disabled';
export interface TenantMember {
  userId: string;
  displayName: string | null;
  role: TenantRole;
  status: TenantMemberStatus;
}
export interface TenantMemberPage {
  items: TenantMember[];
  nextCursor: string | null;
}

export interface SessionResult {
  session: SafeSession;
}

export interface InvitationResult {
  invitationId: string;
  token: string;
  expiresAt: string;
}

export type ApiKeySupplyMode = 'byok' | 'platform';
export type ApiKeyStatus = 'active' | 'revoked';

export interface ApiKeyMetadata {
  id: string;
  tenantId: string;
  projectId: string;
  principalUserId: string;
  supplyProfileId: string;
  supplyMode: ApiKeySupplyMode;
  name: string;
  prefix: string;
  modelScopes: string[];
  status: ApiKeyStatus;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  authzVersion: number;
}

export interface CreatedApiKey extends ApiKeyMetadata {
  secret: string;
}

export type TenantByokCredentialStatus = 'pending' | 'active' | 'disabled' | 'revoked';
export type TenantByokValidationState = 'unverified' | 'verified' | 'failed';

export interface TenantByokCapability {
  model: string;
  endpoint: string;
  version: number;
}

export interface TenantByokAccount {
  id: string;
  displayName: string;
  providerId: string;
  productId: string;
  credentialType: string;
  region: string;
  capabilities: TenantByokCapability[];
  status: TenantByokCredentialStatus;
  validationState: TenantByokValidationState;
  lastValidatedAt: string | null;
  authzVersion: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  revokedAt: string | null;
}

/** Safe metadata returned by tenant BYOK credential routes. It never includes secret material. */
export interface TenantByokCredential {
  id: string;
  supplyMode: 'byok';
  account: TenantByokAccount;
  status: TenantByokCredentialStatus;
  validationState: TenantByokValidationState;
  secretConfigured: boolean;
  currentVersion: number | null;
  expiresAt: string | null;
  authzVersion: number;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
  revokedAt: string | null;
}

/** Secret fields are sent only in the request body and are not part of returned DTOs. */
export interface TenantByokCredentialCreateInput {
  displayName: string;
  providerId: string;
  productId: string;
  credentialType: string;
  region: string;
  purpose: string;
  model: string;
  endpoint: string;
  secret: string;
  expiresAt?: string | null;
}

export interface TenantByokCredentialSecretInput {
  expectedVersion: number;
  secret: string;
  expiresAt?: string | null;
}

export interface TenantByokCredentialLifecycleInput {
  expectedAuthzVersion: number;
}

export interface TenantByokCredentialWriteResult {
  credential: TenantByokCredential;
  version?: {
    version: number;
    status: 'active' | 'retired' | 'revoked';
    createdAt: string;
    expiresAt: string | null;
  };
}

export type ConsoleRequestStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';
export type ConsoleFinancialStatus = 'not_applicable' | 'pending' | 'settled' | 'released' | 'reconciliation_pending';
export type ConsoleReconciliationState = 'none' | 'pending' | 'resolved';
export type ConsoleSupplyMode = ApiKeySupplyMode;
export type ConsoleUsageStatus = 'reported' | 'partial' | 'missing' | 'estimated';
export type ConsoleUsageSource = 'upstream' | 'local-estimate' | 'legacy';
export type ConsoleMeasurementKind = 'snapshot' | 'delta';
export type ConsoleBillableBasis = 'exact' | 'estimated' | 'unknown' | 'not_billable';

export interface ConsoleQueryFilters {
  from?: string;
  to?: string;
  projectId?: string;
  model?: string;
  status?: ConsoleRequestStatus;
  supplyMode?: ConsoleSupplyMode;
}

export interface ConsoleUsageSummary {
  from: string;
  to: string;
  requestCount: string;
  eventCount: string;
  inputTotal: string;
  inputUncached: string;
  cacheRead: string;
  cacheWrite: string;
  cacheWrite5m: string;
  cacheWrite1h: string;
  outputTotal: string;
  reasoningOutput: string;
  totalTokens: string;
}

export interface ConsoleRequest {
  id: string;
  projectId: string;
  model: string;
  protocol: 'anthropic' | 'openai' | 'gemini' | 'responses';
  supplyMode: ConsoleSupplyMode;
  /** Execution state, not financial approval. */
  status: ConsoleRequestStatus;
  /** Absent only for older API responses; never inferred from execution/HTTP. */
  financialStatus?: ConsoleFinancialStatus;
  reconciliationState?: ConsoleReconciliationState;
  createdAt: string;
  updatedAt: string;
}

export interface ConsolePage<Item> {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
}

export const CUSTOMER_WEBHOOK_EVENT_TYPES = [
  'wallet.low_balance',
  'api_key.expiring',
  'service_plan_order.status_changed',
  'refund.status_changed',
  'request.completed',
  'usage.completed',
  'platform.maintenance',
] as const;

export type CustomerWebhookEventType = (typeof CUSTOMER_WEBHOOK_EVENT_TYPES)[number];
export type CustomerWebhookEndpointState = 'active' | 'suspended' | 'revoked';
export type CustomerWebhookSecretState = 'current' | 'overlap' | 'revoked';
export type CustomerWebhookDeliveryState = 'pending' | 'leased' | 'delivered' | 'dead_lettered' | 'cancelled';

export interface CustomerWebhookEndpoint {
  endpointId: string;
  currentVersion: number;
  state: CustomerWebhookEndpointState;
  targetUrl: string;
  eventTypes: CustomerWebhookEventType[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomerWebhookEndpointPage {
  items: CustomerWebhookEndpoint[];
  nextCursor: string | null;
}

export interface CustomerWebhookSecretMetadata {
  version: number;
  state: CustomerWebhookSecretState;
  overlapExpiresAt: string | null;
  createdAt: string;
}

export interface CreatedCustomerWebhookEndpoint {
  endpoint: CustomerWebhookEndpoint;
  signingSecret: string;
  signingSecretVersion: number;
}

export interface CustomerWebhookSigningSecretResult {
  signingSecret: string;
  signingSecretVersion: number;
}

export interface CustomerWebhookDeliveryHistoryEntry {
  eventType: CustomerWebhookEventType;
  occurredAt: string;
  status: CustomerWebhookDeliveryState;
  attempts: number;
  lastHttpStatus: number | null;
  lastLatencyMs: number | null;
  lastErrorCode: string | null;
}

export interface CustomerWebhookDeliveryHistoryPage {
  items: CustomerWebhookDeliveryHistoryEntry[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CustomerWebhookEndpointInput {
  targetUrl: string;
  eventTypes: CustomerWebhookEventType[];
}

export interface ConsoleAttempt {
  id: string;
  sequence: number;
  status: ConsoleRequestStatus;
  responseStarted: boolean;
  responseStartedAt: string | null;
  httpStatus: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConsoleUsageEvent {
  id: string;
  supplyMode: ConsoleSupplyMode;
  inputTotal: string | null;
  inputUncached: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
  cacheWrite5m: string | null;
  cacheWrite1h: string | null;
  outputTotal: string | null;
  reasoningOutput: string | null;
  status: ConsoleUsageStatus;
  source: ConsoleUsageSource;
  measurementKind: ConsoleMeasurementKind;
  billableBasis: ConsoleBillableBasis;
  createdAt: string;
}

export interface ConsoleRequestDetail extends ConsoleRequest {
  attempts: ConsoleAttempt[];
  usageEvents: ConsoleUsageEvent[];
}

export interface ServicePlanCatalogItem {
  planVersionId: string;
  planId: string;
  version: number;
  supplyMode: 'byok';
  termDays: number;
  fixedFeeMinorUnits: string;
  currency: string;
  supportedProviderIds: string[];
  supportedModels: string[];
  policyDescription: string;
}

export type PaymentCheckoutAction =
  | { kind: 'redirect'; url: string; expiresAt: string }
  | { kind: 'qr'; text: string; expiresAt: string };

export type PaymentCheckoutView =
  | { status: 'ready'; action: PaymentCheckoutAction }
  | { status: 'pending' | 'unavailable' | 'expired' | 'closed'; action: null };

export type ServicePlanOrderOperation = 'activation' | 'renewal';
export type ServicePlanOrderState =
  | 'pending'
  | 'paid'
  | 'fulfilling'
  | 'fulfilled'
  | 'cancelled'
  | 'reconciliation_pending';

export interface ServicePlanOrderSnapshot {
  id: string;
  tenantId: string;
  orderId: string;
  planVersionId: string;
  planId: string;
  planVersion: number;
  allowedProviderIds: string[];
  allowedModels: string[];
  supplyMode: 'byok';
  priceVersion: string;
  priceMinorUnits: string;
  currency: string;
  termDays: number;
  policyVersion: string;
  snapshotDigest: string;
  createdAt: string;
}

/**
 * Public order DTO. The parser intentionally ignores internal response fields
 * such as supply-profile details and never creates client-side entitlement or
 * wallet data.
 */
export interface ServicePlanOrder {
  id: string;
  tenantId: string;
  projectId: string;
  planVersionId: string;
  operation: ServicePlanOrderOperation;
  renewalOfSubscriptionId?: string | null;
  clientRequestId: string;
  state: ServicePlanOrderState;
  subscriptionId?: string | null;
  snapshot?: ServicePlanOrderSnapshot;
  createdAt: string;
  updatedAt: string;
  paidAt?: string | null;
  fulfilledAt?: string | null;
  orderType?: 'byok_service_plan';
  providerKey?: string;
  merchantId?: string;
  providerOrderId?: string | null;
  providerAttempts?: number;
  providerFailureCode?: string | null;
  checkout: PaymentCheckoutView;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

export class SaasApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'SaasApiError';
  }
}

const customerSessionErrorCodes = new Set([
  'UNAUTHENTICATED',
  'CSRF_REJECTED',
  'ORIGIN_REQUIRED',
  'ORIGIN_REJECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'REQUEST_REJECTED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

function invalidCustomerSessionResponse(): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效会话信息');
}

function customerSessionFromResponse(value: unknown): SafeCustomerSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCustomerSessionResponse();
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.expiresAt !== 'string' ||
    (candidate.revokedAt !== null && typeof candidate.revokedAt !== 'string') ||
    (candidate.status !== 'active' && candidate.status !== 'revoked' && candidate.status !== 'expired') ||
    typeof candidate.current !== 'boolean'
  ) {
    return invalidCustomerSessionResponse();
  }
  return {
    id: candidate.id,
    createdAt: candidate.createdAt,
    expiresAt: candidate.expiresAt,
    revokedAt: candidate.revokedAt,
    status: candidate.status,
    current: candidate.current,
  };
}

function customerSessionsFromResponse(value: unknown): SafeCustomerSession[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCustomerSessionResponse();
  }
  const sessions = (value as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) return invalidCustomerSessionResponse();
  return sessions.map(customerSessionFromResponse);
}

function customerSessionRevocationFromResponse(value: unknown): CustomerSessionRevocation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCustomerSessionResponse();
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId.length === 0 ||
    typeof candidate.revokedAt !== 'string' ||
    typeof candidate.currentSessionRevoked !== 'boolean'
  ) {
    return invalidCustomerSessionResponse();
  }
  return {
    sessionId: candidate.sessionId,
    revokedAt: candidate.revokedAt,
    currentSessionRevoked: candidate.currentSessionRevoked,
  };
}

function otherCustomerSessionsRevocationFromResponse(value: unknown): OtherCustomerSessionsRevocation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalidCustomerSessionResponse();
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.revokedCount !== 'number' ||
    !Number.isSafeInteger(candidate.revokedCount) ||
    candidate.revokedCount < 0 ||
    candidate.currentSessionPreserved !== true
  ) {
    return invalidCustomerSessionResponse();
  }
  return { revokedCount: candidate.revokedCount, currentSessionPreserved: true };
}

const customerWebhookEndpointStates = new Set<CustomerWebhookEndpointState>(['active', 'suspended', 'revoked']);
const customerWebhookSecretStates = new Set<CustomerWebhookSecretState>(['current', 'overlap', 'revoked']);
const customerWebhookDeliveryStates = new Set<CustomerWebhookDeliveryState>([
  'pending',
  'leased',
  'delivered',
  'dead_lettered',
  'cancelled',
]);
const customerWebhookEventTypes = new Set<string>(CUSTOMER_WEBHOOK_EVENT_TYPES);
const webhookUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidCustomerWebhookResponse(): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效 Webhook 信息');
}

function webhookString(value: unknown, maximumLength = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    return invalidCustomerWebhookResponse();
  }
  return value;
}

function webhookTimestamp(value: unknown): string {
  const timestamp = webhookString(value, 64);
  if (!Number.isFinite(Date.parse(timestamp))) return invalidCustomerWebhookResponse();
  return timestamp;
}

function webhookPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    return invalidCustomerWebhookResponse();
  }
  return value;
}

function webhookNullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalidCustomerWebhookResponse();
  }
  return value;
}

function customerWebhookEndpointFromResponse(value: unknown): CustomerWebhookEndpoint {
  if (!isRecord(value)) return invalidCustomerWebhookResponse();
  if (
    typeof value.endpointId !== 'string' ||
    !webhookUuid.test(value.endpointId) ||
    typeof value.state !== 'string' ||
    !customerWebhookEndpointStates.has(value.state as CustomerWebhookEndpointState) ||
    typeof value.targetUrl !== 'string' ||
    value.targetUrl.length === 0 ||
    value.targetUrl.length > 2048 ||
    !Array.isArray(value.eventTypes) ||
    value.eventTypes.length === 0 ||
    value.eventTypes.length > CUSTOMER_WEBHOOK_EVENT_TYPES.length ||
    value.eventTypes.some((event) => typeof event !== 'string' || !customerWebhookEventTypes.has(event)) ||
    new Set(value.eventTypes).size !== value.eventTypes.length
  ) {
    return invalidCustomerWebhookResponse();
  }
  return {
    endpointId: value.endpointId,
    currentVersion: webhookPositiveInteger(value.currentVersion, 999_999_999),
    state: value.state as CustomerWebhookEndpointState,
    targetUrl: value.targetUrl,
    eventTypes: [...value.eventTypes] as CustomerWebhookEventType[],
    createdAt: webhookTimestamp(value.createdAt),
    updatedAt: webhookTimestamp(value.updatedAt),
  };
}

function customerWebhookEndpointPageFromResponse(value: unknown): CustomerWebhookEndpointPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidCustomerWebhookResponse();
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > 256)) {
    return invalidCustomerWebhookResponse();
  }
  return { items: value.items.map(customerWebhookEndpointFromResponse), nextCursor };
}

function customerWebhookSecretFromResponse(value: unknown): CustomerWebhookSecretMetadata {
  if (
    !isRecord(value) ||
    typeof value.state !== 'string' ||
    !customerWebhookSecretStates.has(value.state as CustomerWebhookSecretState) ||
    (value.overlapExpiresAt !== null && typeof value.overlapExpiresAt !== 'string')
  ) {
    return invalidCustomerWebhookResponse();
  }
  return {
    version: webhookPositiveInteger(value.version, 999_999_999),
    state: value.state as CustomerWebhookSecretState,
    overlapExpiresAt: value.overlapExpiresAt === null ? null : webhookTimestamp(value.overlapExpiresAt),
    createdAt: webhookTimestamp(value.createdAt),
  };
}

function customerWebhookSecretsFromResponse(value: unknown): CustomerWebhookSecretMetadata[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidCustomerWebhookResponse();
  return value.items.map(customerWebhookSecretFromResponse);
}

function customerWebhookSigningSecretFromResponse(value: unknown): CustomerWebhookSigningSecretResult {
  if (!isRecord(value)) return invalidCustomerWebhookResponse();
  const signingSecret = webhookString(value.signingSecret, 512);
  return {
    signingSecret,
    signingSecretVersion: webhookPositiveInteger(value.signingSecretVersion, 999_999_999),
  };
}

function createdCustomerWebhookEndpointFromResponse(value: unknown): CreatedCustomerWebhookEndpoint {
  if (!isRecord(value)) return invalidCustomerWebhookResponse();
  const secret = customerWebhookSigningSecretFromResponse(value);
  return {
    endpoint: customerWebhookEndpointFromResponse(value.endpoint),
    ...secret,
  };
}

function customerWebhookDeliveryFromResponse(value: unknown): CustomerWebhookDeliveryHistoryEntry {
  if (
    !isRecord(value) ||
    typeof value.eventType !== 'string' ||
    !customerWebhookEventTypes.has(value.eventType) ||
    typeof value.status !== 'string' ||
    !customerWebhookDeliveryStates.has(value.status as CustomerWebhookDeliveryState) ||
    typeof value.attempts !== 'number' ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    value.attempts > 12 ||
    (value.lastErrorCode !== null &&
      (typeof value.lastErrorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.lastErrorCode)))
  ) {
    return invalidCustomerWebhookResponse();
  }
  return {
    eventType: value.eventType as CustomerWebhookEventType,
    occurredAt: webhookTimestamp(value.occurredAt),
    status: value.status as CustomerWebhookDeliveryState,
    attempts: value.attempts,
    lastHttpStatus: webhookNullableInteger(value.lastHttpStatus, 100, 599),
    lastLatencyMs: webhookNullableInteger(value.lastLatencyMs, 0, 300_000),
    lastErrorCode: value.lastErrorCode,
  };
}

function customerWebhookDeliveryPageFromResponse(value: unknown): CustomerWebhookDeliveryHistoryPage {
  if (!isRecord(value) || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean') {
    return invalidCustomerWebhookResponse();
  }
  const nextCursor = value.nextCursor;
  if (
    (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > 256)) ||
    value.hasMore !== (nextCursor !== null)
  ) {
    return invalidCustomerWebhookResponse();
  }
  return { items: value.items.map(customerWebhookDeliveryFromResponse), nextCursor, hasMore: value.hasMore };
}

const projectRoles = new Set<ProjectRole>(['owner', 'admin', 'developer', 'billing', 'viewer']);
const tenantMemberUserIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const workspaceErrorCodes = new Set([
  'REQUEST_REJECTED', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
  'CSRF_REJECTED', 'ORIGIN_REQUIRED', 'ORIGIN_REJECTED', 'HOST_REQUIRED', 'HOST_REJECTED',
  'RATE_LIMITED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
]);

function workspaceString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function workspaceDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function invalidWorkspaceResponse(): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', '工作空间响应无效，请刷新后重试。');
}

function tenantFromResponse(value: unknown): SafeTenant {
  if (!isRecord(value) || !workspaceString(value.id) || !workspaceString(value.name, 120) ||
    !workspaceString(value.slug) || value.status !== 'active' || typeof value.role !== 'string' ||
    !projectRoles.has(value.role as TenantRole) || !workspaceDate(value.createdAt) || !workspaceDate(value.updatedAt) ||
    (value.defaultProjectId !== undefined && !workspaceString(value.defaultProjectId))) return invalidWorkspaceResponse();
  return {
    id: value.id, name: value.name, slug: value.slug, status: 'active', role: value.role as TenantRole,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    ...(value.defaultProjectId === undefined ? {} : { defaultProjectId: value.defaultProjectId }),
  };
}

function tenantsFromResponse(value: unknown): SafeTenant[] {
  if (!Array.isArray(value)) return invalidWorkspaceResponse();
  const tenants = value.map(tenantFromResponse);
  if (new Set(tenants.map(tenant => tenant.id)).size !== tenants.length) return invalidWorkspaceResponse();
  return tenants;
}

function invitationFromResponse(value: unknown): InvitationResult {
  if (!isRecord(value) || !workspaceString(value.invitationId) || typeof value.token !== 'string' ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(value.token) || !workspaceDate(value.expiresAt)) return invalidWorkspaceResponse();
  // One-time token is returned only to the issuing component's memory, never
  // to a query cache or draft store. Unknown fields/digests are not projected.
  return { invitationId: value.invitationId, token: value.token, expiresAt: value.expiresAt };
}

function acceptedIdentityFromResponse(value: unknown): SafeIdentity {
  if (!isRecord(value) || !workspaceString(value.id) || !workspaceString(value.email, 254) ||
    (value.displayName !== null && !workspaceString(value.displayName, 120)) || value.status !== 'active' ||
    (value.emailVerifiedAt !== null && !workspaceDate(value.emailVerifiedAt)) || !workspaceDate(value.createdAt)) {
    return invalidWorkspaceResponse();
  }
  return { id: value.id, email: value.email, displayName: value.displayName, status: 'active',
    emailVerifiedAt: value.emailVerifiedAt, createdAt: value.createdAt };
}

function projectFromResponse(value: unknown, tenantId: string): Project {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效项目');
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.tenantId !== 'string' ||
    candidate.tenantId !== tenantId ||
    typeof candidate.name !== 'string' ||
    typeof candidate.slug !== 'string' ||
    typeof candidate.role !== 'string' ||
    !projectRoles.has(candidate.role as ProjectRole) ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string'
  ) {
    throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效项目');
  }
  return {
    id: candidate.id,
    tenantId: candidate.tenantId,
    name: candidate.name,
    slug: candidate.slug,
    role: candidate.role as ProjectRole,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function projectsFromResponse(value: unknown, tenantId: string): Project[] {
  if (!Array.isArray(value)) throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效项目列表');
  return value.map(project => projectFromResponse(project, tenantId));
}

function tenantMemberPageFromResponse(value: unknown): TenantMemberPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100 ||
    (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 1024 || !/^tm1\.[A-Za-z0-9_-]+$/.test(value.nextCursor)))) return invalidWorkspaceResponse();
  const items: TenantMember[] = value.items.map(member => {
    if (!isRecord(member) || typeof member.userId !== 'string' || !tenantMemberUserIdPattern.test(member.userId) ||
      (member.displayName !== null && (typeof member.displayName !== 'string' || member.displayName.length > 120)) ||
      typeof member.role !== 'string' || !projectRoles.has(member.role as TenantRole) ||
      (member.status !== 'active' && member.status !== 'suspended' && member.status !== 'revoked' && member.status !== 'disabled')) return invalidWorkspaceResponse();
    return { userId: member.userId, displayName: member.displayName, role: member.role as TenantRole, status: member.status };
  });
  if (new Set(items.map(member => member.userId.toLowerCase())).size !== items.length) return invalidWorkspaceResponse();
  return { items, nextCursor: value.nextCursor };
}

const tenantCredentialStatuses = new Set<TenantByokCredentialStatus>(['pending', 'active', 'disabled', 'revoked']);
const tenantValidationStates = new Set<TenantByokValidationState>(['unverified', 'verified', 'failed']);

function invalidTenantByokResponse(message = '服务返回了无效 BYOK 凭证'): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', message);
}

function tenantByokString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalidTenantByokResponse(`服务返回了无效 BYOK 凭证字段：${field}`);
  return value;
}

function tenantByokNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return tenantByokString(value, field);
}

function tenantByokPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalidTenantByokResponse(`服务返回了无效 BYOK 凭证字段：${field}`);
  }
  return value;
}

function tenantByokStatus(value: unknown, field: string): TenantByokCredentialStatus {
  if (typeof value !== 'string' || !tenantCredentialStatuses.has(value as TenantByokCredentialStatus)) {
    invalidTenantByokResponse(`服务返回了无效 BYOK 凭证字段：${field}`);
  }
  return value as TenantByokCredentialStatus;
}

function tenantByokValidationState(value: unknown, field: string): TenantByokValidationState {
  if (typeof value !== 'string' || !tenantValidationStates.has(value as TenantByokValidationState)) {
    invalidTenantByokResponse(`服务返回了无效 BYOK 凭证字段：${field}`);
  }
  return value as TenantByokValidationState;
}

function tenantByokCapability(value: unknown): TenantByokCapability {
  if (!isRecord(value)) invalidTenantByokResponse();
  return {
    model: tenantByokString(value.model, 'account.capabilities.model'),
    endpoint: tenantByokString(value.endpoint, 'account.capabilities.endpoint'),
    version: tenantByokPositiveInteger(value.version, 'account.capabilities.version'),
  };
}

export function parseTenantByokCredential(value: unknown): TenantByokCredential {
  if (!isRecord(value) || !isRecord(value.account) || value.supplyMode !== 'byok') invalidTenantByokResponse();
  const account = value.account;
  if (!Array.isArray(account.capabilities)) invalidTenantByokResponse();
  const currentVersion = value.currentVersion;
  if (currentVersion !== null && (typeof currentVersion !== 'number' || !Number.isSafeInteger(currentVersion) || currentVersion < 1)) {
    invalidTenantByokResponse('服务返回了无效 BYOK 凭证版本');
  }
  if (typeof value.secretConfigured !== 'boolean') invalidTenantByokResponse();

  return {
    id: tenantByokString(value.id, 'id'),
    supplyMode: 'byok',
    account: {
      id: tenantByokString(account.id, 'account.id'),
      displayName: tenantByokString(account.displayName, 'account.displayName'),
      providerId: tenantByokString(account.providerId, 'account.providerId'),
      productId: tenantByokString(account.productId, 'account.productId'),
      credentialType: tenantByokString(account.credentialType, 'account.credentialType'),
      region: tenantByokString(account.region, 'account.region'),
      capabilities: account.capabilities.map(tenantByokCapability),
      status: tenantByokStatus(account.status, 'account.status'),
      validationState: tenantByokValidationState(account.validationState, 'account.validationState'),
      lastValidatedAt: tenantByokNullableString(account.lastValidatedAt, 'account.lastValidatedAt'),
      authzVersion: tenantByokPositiveInteger(account.authzVersion, 'account.authzVersion'),
      createdAt: tenantByokString(account.createdAt, 'account.createdAt'),
      updatedAt: tenantByokString(account.updatedAt, 'account.updatedAt'),
      disabledAt: tenantByokNullableString(account.disabledAt, 'account.disabledAt'),
      revokedAt: tenantByokNullableString(account.revokedAt, 'account.revokedAt'),
    },
    status: tenantByokStatus(value.status, 'status'),
    validationState: tenantByokValidationState(value.validationState, 'validationState'),
    secretConfigured: value.secretConfigured,
    currentVersion: currentVersion as number | null,
    expiresAt: tenantByokNullableString(value.expiresAt, 'expiresAt'),
    authzVersion: tenantByokPositiveInteger(value.authzVersion, 'authzVersion'),
    createdAt: tenantByokString(value.createdAt, 'createdAt'),
    updatedAt: tenantByokString(value.updatedAt, 'updatedAt'),
    disabledAt: tenantByokNullableString(value.disabledAt, 'disabledAt'),
    revokedAt: tenantByokNullableString(value.revokedAt, 'revokedAt'),
  };
}

function tenantByokCredentialsFromResponse(value: unknown): TenantByokCredential[] {
  if (!isRecord(value) || !Array.isArray(value.items)) invalidTenantByokResponse('服务返回了无效 BYOK 凭证列表');
  return value.items.map(parseTenantByokCredential);
}

function tenantByokWriteResultFromResponse(value: unknown): TenantByokCredentialWriteResult {
  if (!isRecord(value) || !Object.hasOwn(value, 'credential')) invalidTenantByokResponse();
  const result: TenantByokCredentialWriteResult = { credential: parseTenantByokCredential(value.credential) };
  if (value.version !== undefined) {
    if (!isRecord(value.version)) invalidTenantByokResponse('服务返回了无效 BYOK 凭证版本');
    const status = value.version.status;
    if (status !== 'active' && status !== 'retired' && status !== 'revoked') {
      invalidTenantByokResponse('服务返回了无效 BYOK 凭证版本状态');
    }
    result.version = {
      version: tenantByokPositiveInteger(value.version.version, 'version.version'),
      status,
      createdAt: tenantByokString(value.version.createdAt, 'version.createdAt'),
      expiresAt: tenantByokNullableString(value.version.expiresAt, 'version.expiresAt'),
    };
  }
  return result;
}

function servicePlanFromResponse(value: unknown): ServicePlanCatalogItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效服务计划');
  }
  const candidate = value as Record<string, unknown>;
  const supportedProviderIds = candidate.supportedProviderIds;
  const supportedModels = candidate.supportedModels;
  if (
    typeof candidate.planVersionId !== 'string' ||
    candidate.planVersionId.trim() === '' ||
    typeof candidate.planId !== 'string' ||
    candidate.planId.trim() === '' ||
    typeof candidate.version !== 'number' ||
    !Number.isSafeInteger(candidate.version) ||
    candidate.version < 1 ||
    candidate.supplyMode !== 'byok' ||
    typeof candidate.termDays !== 'number' ||
    !Number.isSafeInteger(candidate.termDays) ||
    candidate.termDays < 1 ||
    typeof candidate.fixedFeeMinorUnits !== 'string' ||
    !/^\d+$/.test(candidate.fixedFeeMinorUnits) ||
    typeof candidate.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(candidate.currency) ||
    !Array.isArray(supportedProviderIds) ||
    supportedProviderIds.length === 0 ||
    supportedProviderIds.some(item => typeof item !== 'string' || item.trim() === '') ||
    !Array.isArray(supportedModels) ||
    supportedModels.length === 0 ||
    supportedModels.some(item => typeof item !== 'string' || item.trim() === '') ||
    typeof candidate.policyDescription !== 'string' ||
    candidate.policyDescription.trim() === ''
  ) {
    throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效服务计划');
  }
  return {
    planVersionId: candidate.planVersionId,
    planId: candidate.planId,
    version: candidate.version,
    supplyMode: 'byok',
    termDays: candidate.termDays,
    fixedFeeMinorUnits: candidate.fixedFeeMinorUnits,
    currency: candidate.currency,
    supportedProviderIds: [...supportedProviderIds] as string[],
    supportedModels: [...supportedModels] as string[],
    policyDescription: candidate.policyDescription,
  };
}

function servicePlansFromResponse(value: unknown): ServicePlanCatalogItem[] {
  if (!Array.isArray(value)) throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效服务计划列表');
  return value.map(servicePlanFromResponse);
}

const servicePlanOrderStates = new Set<ServicePlanOrderState>([
  'pending',
  'paid',
  'fulfilling',
  'fulfilled',
  'cancelled',
  'reconciliation_pending',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const customerRefundStatuses = new Set<CustomerRefundStatus>([
  'submitting',
  'pending',
  'succeeded',
  'failed',
  'unknown',
  'blocked',
]);

function invalidCustomerRefundResponse(): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效退款记录');
}

function customerRefundString(value: unknown, maximumLength = 255): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximumLength) {
    return invalidCustomerRefundResponse();
  }
  return value;
}

function customerRefundTimestamp(value: unknown): string {
  const timestamp = customerRefundString(value, 64);
  if (!Number.isFinite(Date.parse(timestamp))) return invalidCustomerRefundResponse();
  return timestamp;
}

function customerRefundFromResponse(value: unknown): CustomerRefundSummary {
  if (
    !isRecord(value) ||
    (value.refundType !== 'wallet_topup' && value.refundType !== 'byok_service_plan') ||
    typeof value.status !== 'string' ||
    !customerRefundStatuses.has(value.status as CustomerRefundStatus) ||
    typeof value.amountMinorUnits !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(value.amountMinorUnits) ||
    typeof value.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    (value.completedAt !== null && typeof value.completedAt !== 'string')
  ) {
    return invalidCustomerRefundResponse();
  }

  return {
    id: customerRefundString(value.id),
    refundType: value.refundType,
    originalOrderId: customerRefundString(value.originalOrderId),
    amountMinorUnits: value.amountMinorUnits,
    currency: value.currency,
    status: value.status as CustomerRefundStatus,
    createdAt: customerRefundTimestamp(value.createdAt),
    updatedAt: customerRefundTimestamp(value.updatedAt),
    completedAt: value.completedAt === null ? null : customerRefundTimestamp(value.completedAt),
  };
}

function customerRefundPageFromResponse(value: unknown): CustomerRefundPage {
  if (!isRecord(value) || !Array.isArray(value.items)) return invalidCustomerRefundResponse();
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor.length > 256)) {
    return invalidCustomerRefundResponse();
  }
  return { items: value.items.map(customerRefundFromResponse), nextCursor };
}

function invalidServicePlanResponse(message = '服务返回了无效服务计划订单'): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', message);
}

function requiredOrderString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalidServicePlanResponse(`服务计划订单的 ${field} 无效`);
  return value;
}

function orderTimestamp(value: unknown, field: string): string {
  const timestamp = requiredOrderString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) invalidServicePlanResponse(`服务计划订单的 ${field} 无效`);
  return timestamp;
}

function optionalOrderTimestamp(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return orderTimestamp(value, field);
}

function orderStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    invalidServicePlanResponse(`服务计划订单的 ${field} 无效`);
  }
  return [...value] as string[];
}

function orderPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalidServicePlanResponse(`服务计划订单的 ${field} 无效`);
  }
  return value;
}

function orderNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalidServicePlanResponse(`服务计划订单的 ${field} 无效`);
  }
  return value;
}

function optionalOrderString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredOrderString(value, field);
}

function optionalOrderNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredOrderString(value, field);
}

function parseCheckoutAction(value: unknown): PaymentCheckoutAction {
  if (!isRecord(value)) invalidServicePlanResponse('服务计划订单的 checkout action 无效');
  const expiresAt = orderTimestamp(value.expiresAt, 'checkout.action.expiresAt');
  if (value.kind === 'redirect') {
    const url = requiredOrderString(value.url, 'checkout.action.url');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      invalidServicePlanResponse('服务计划订单的 checkout redirect URL 无效');
    }
    if (url.length > 4096) invalidServicePlanResponse('服务计划订单的 checkout redirect URL 过长');
    return { kind: 'redirect', url, expiresAt };
  }
  if (value.kind === 'qr') {
    const text = requiredOrderString(value.text, 'checkout.action.text');
    if (text.length > 4096) invalidServicePlanResponse('服务计划订单的 checkout QR 文本过长');
    return { kind: 'qr', text, expiresAt };
  }
  invalidServicePlanResponse('服务计划订单的 checkout action 类型无效');
}

function parsePaymentCheckout(value: unknown): PaymentCheckoutView {
  if (!isRecord(value)) invalidServicePlanResponse('服务计划订单的 checkout 无效');
  if (value.status === 'ready') return { status: 'ready', action: parseCheckoutAction(value.action) };
  if (value.status === 'pending' || value.status === 'unavailable' || value.status === 'expired' || value.status === 'closed') {
    if (value.action !== null) invalidServicePlanResponse('非 ready checkout 必须没有 action');
    return { status: value.status, action: null };
  }
  invalidServicePlanResponse('服务计划订单的 checkout 状态无效');
}

function parseServicePlanSnapshot(value: unknown): ServicePlanOrderSnapshot {
  if (!isRecord(value)) invalidServicePlanResponse('服务计划订单的 snapshot 无效');
  if (value.supplyMode !== 'byok') invalidServicePlanResponse('服务计划订单的 supplyMode 无效');
  const currency = requiredOrderString(value.currency, 'snapshot.currency');
  if (!/^[A-Z]{3}$/.test(currency)) invalidServicePlanResponse('服务计划订单的 snapshot.currency 无效');
  const priceMinorUnits = requiredOrderString(value.priceMinorUnits, 'snapshot.priceMinorUnits');
  if (!/^\d+$/.test(priceMinorUnits)) invalidServicePlanResponse('服务计划订单的 snapshot.priceMinorUnits 无效');
  return {
    id: requiredOrderString(value.id, 'snapshot.id'),
    tenantId: requiredOrderString(value.tenantId, 'snapshot.tenantId'),
    orderId: requiredOrderString(value.orderId, 'snapshot.orderId'),
    planVersionId: requiredOrderString(value.planVersionId, 'snapshot.planVersionId'),
    planId: requiredOrderString(value.planId, 'snapshot.planId'),
    planVersion: orderPositiveInteger(value.planVersion, 'snapshot.planVersion'),
    allowedProviderIds: orderStringArray(value.allowedProviderIds, 'snapshot.allowedProviderIds'),
    allowedModels: orderStringArray(value.allowedModels, 'snapshot.allowedModels'),
    supplyMode: 'byok',
    priceVersion: requiredOrderString(value.priceVersion, 'snapshot.priceVersion'),
    priceMinorUnits,
    currency,
    termDays: orderPositiveInteger(value.termDays, 'snapshot.termDays'),
    policyVersion: requiredOrderString(value.policyVersion, 'snapshot.policyVersion'),
    snapshotDigest: requiredOrderString(value.snapshotDigest, 'snapshot.snapshotDigest'),
    createdAt: orderTimestamp(value.createdAt, 'snapshot.createdAt'),
  };
}

export function parseServicePlanOrder(value: unknown): ServicePlanOrder {
  if (!isRecord(value)) invalidServicePlanResponse();
  if (value.operation !== 'activation' && value.operation !== 'renewal') {
    invalidServicePlanResponse('服务计划订单的 operation 无效');
  }
  if (typeof value.state !== 'string' || !servicePlanOrderStates.has(value.state as ServicePlanOrderState)) {
    invalidServicePlanResponse('服务计划订单的 state 无效');
  }
  if (value.orderType !== undefined && value.orderType !== 'byok_service_plan') {
    invalidServicePlanResponse('服务计划订单的 orderType 无效');
  }
  const snapshot = value.snapshot === undefined ? undefined : parseServicePlanSnapshot(value.snapshot);
  const providerKey = optionalOrderString(value.providerKey, 'providerKey');
  const merchantId = optionalOrderString(value.merchantId, 'merchantId');
  const providerOrderId = optionalOrderNullableString(value.providerOrderId, 'providerOrderId');
  const providerFailureCode = optionalOrderNullableString(value.providerFailureCode, 'providerFailureCode');
  const result: ServicePlanOrder = {
    id: requiredOrderString(value.id, 'id'),
    tenantId: requiredOrderString(value.tenantId, 'tenantId'),
    projectId: requiredOrderString(value.projectId, 'projectId'),
    planVersionId: requiredOrderString(value.planVersionId, 'planVersionId'),
    operation: value.operation,
    ...(value.renewalOfSubscriptionId === undefined
      ? {}
      : { renewalOfSubscriptionId: optionalOrderNullableString(value.renewalOfSubscriptionId, 'renewalOfSubscriptionId') }),
    clientRequestId: requiredOrderString(value.clientRequestId, 'clientRequestId'),
    state: value.state as ServicePlanOrderState,
    ...(value.subscriptionId === undefined
      ? {}
      : { subscriptionId: optionalOrderNullableString(value.subscriptionId, 'subscriptionId') }),
    ...(snapshot === undefined ? {} : { snapshot }),
    createdAt: orderTimestamp(value.createdAt, 'createdAt'),
    updatedAt: orderTimestamp(value.updatedAt, 'updatedAt'),
    ...(value.paidAt === undefined ? {} : { paidAt: optionalOrderTimestamp(value.paidAt, 'paidAt') }),
    ...(value.fulfilledAt === undefined ? {} : { fulfilledAt: optionalOrderTimestamp(value.fulfilledAt, 'fulfilledAt') }),
    ...(value.orderType === undefined ? {} : { orderType: 'byok_service_plan' as const }),
    ...(providerKey === undefined ? {} : { providerKey }),
    ...(merchantId === undefined ? {} : { merchantId }),
    ...(providerOrderId === undefined ? {} : { providerOrderId }),
    ...(value.providerAttempts === undefined
      ? {}
      : { providerAttempts: orderNonNegativeInteger(value.providerAttempts, 'providerAttempts') }),
    ...(providerFailureCode === undefined ? {} : { providerFailureCode }),
    checkout: parsePaymentCheckout(value.checkout),
  };
  if (snapshot && (snapshot.tenantId !== result.tenantId || snapshot.orderId !== result.id)) {
    invalidServicePlanResponse('服务计划订单的 snapshot 归属无效');
  }
  return result;
}

function parseServicePlanOrderForTenant(value: unknown, tenantId: string): ServicePlanOrder {
  const order = parseServicePlanOrder(value);
  if (order.tenantId !== tenantId) invalidServicePlanResponse('服务计划订单不属于当前租户');
  return order;
}

export function servicePlanOrderFromError(error: unknown, tenantId?: string): ServicePlanOrder | undefined {
  if (!(error instanceof SaasApiError) || error.status !== 503 || error.data === undefined) return undefined;
  try {
    return tenantId === undefined ? parseServicePlanOrder(error.data) : parseServicePlanOrderForTenant(error.data, tenantId);
  } catch {
    return undefined;
  }
}

/**
 * The server exposes this as a readable double-submit cookie scoped to
 * /console. The session cookie remains HttpOnly and scoped to the API.
 */
function cookieValue(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  const entry = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
  if (!entry) return undefined;
  const value = entry.slice(prefix.length);
  try { return decodeURIComponent(value); } catch { return value; }
}

function withQuery(path: string, values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values as Record<string, string | number | undefined>)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function request<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
    idempotencyKey?: string;
    sensitive?: boolean;
    redactErrors?: boolean;
    workspace?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    const csrfToken = cookieValue('mr_saas_csrf');
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    throw new SaasApiError(
      0,
      'NETWORK',
      options.sensitive || options.redactErrors || options.workspace
        ? '网络连接失败，请稍后重试。'
        : error instanceof Error
          ? error.message
          : '网络连接失败',
    );
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw new SaasApiError(
      response.status,
      'INVALID_RESPONSE',
      options.workspace
        ? '工作空间响应无法读取。'
        : options.sensitive || options.redactErrors
        ? options.sensitive
          ? '凭证服务响应无法读取。'
          : '会话服务响应无法读取。'
        : error instanceof Error
          ? error.message
          : '服务响应无法读取',
    );
  }
  let parsed: ApiEnvelope<T> | undefined;
  if (raw) {
    try { parsed = JSON.parse(raw) as ApiEnvelope<T>; }
    catch { throw new SaasApiError(response.status, 'INVALID_RESPONSE', '服务返回了无效 JSON'); }
  }
  if (!response.ok) {
    const returnedCode = parsed?.error?.code;
    const safeSessionCode = returnedCode && customerSessionErrorCodes.has(returnedCode) ? returnedCode : 'HTTP_ERROR';
    const safeWorkspaceCode = typeof returnedCode === 'string' && workspaceErrorCodes.has(returnedCode) ? returnedCode : 'HTTP_ERROR';
    throw new SaasApiError(
      response.status,
      options.workspace ? safeWorkspaceCode : options.sensitive ? 'HTTP_ERROR' : options.redactErrors ? safeSessionCode : (returnedCode ?? 'HTTP_ERROR'),
      options.workspace
        ? '工作空间请求失败，请稍后重试。'
        : options.sensitive
        ? '凭证请求失败，请稍后重试。'
        : options.redactErrors
          ? '会话请求失败，请稍后重试。'
          : (parsed?.error?.message ?? `请求失败 (${response.status})`),
      options.sensitive || options.redactErrors || options.workspace ? undefined : parsed?.error?.details,
      !options.sensitive && !options.redactErrors && !options.workspace && response.status === 503 && parsed && Object.hasOwn(parsed, 'data')
        ? parsed.data
        : undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  if (!parsed || !Object.hasOwn(parsed, 'data')) {
    throw new SaasApiError(response.status, 'INVALID_RESPONSE', '服务响应缺少 data');
  }
  return parsed.data as T;
}

const consoleRequestStatuses = new Set<ConsoleRequestStatus>(['pending', 'succeeded', 'failed', 'unknown']);
const consoleFinancialStatuses = new Set<ConsoleFinancialStatus>([
  'not_applicable', 'pending', 'settled', 'released', 'reconciliation_pending',
]);
const consoleReconciliationStates = new Set<ConsoleReconciliationState>(['none', 'pending', 'resolved']);

function invalidConsoleRequestResponse(): never {
  throw new SaasApiError(200, 'INVALID_RESPONSE', '服务返回了无效请求状态');
}

/** Validate additive axes without inventing states for older response versions. */
function consoleRequestStatesFromResponse<Item extends ConsoleRequest>(value: Item): Item {
  if (
    !isRecord(value) ||
    (value.supplyMode !== 'byok' && value.supplyMode !== 'platform') ||
    typeof value.status !== 'string' || !consoleRequestStatuses.has(value.status) ||
    (value.financialStatus !== undefined &&
      (typeof value.financialStatus !== 'string' || !consoleFinancialStatuses.has(value.financialStatus))) ||
    (value.reconciliationState !== undefined &&
      (typeof value.reconciliationState !== 'string' || !consoleReconciliationStates.has(value.reconciliationState)))
  ) invalidConsoleRequestResponse();
  if (
    (value.financialStatus !== undefined &&
      ((value.supplyMode === 'byok') !== (value.financialStatus === 'not_applicable'))) ||
    (value.status === 'unknown' && value.reconciliationState !== undefined && value.reconciliationState !== 'pending')
  ) invalidConsoleRequestResponse();
  return value;
}

function consoleRequestPageFromResponse(value: ConsolePage<ConsoleRequest>): ConsolePage<ConsoleRequest> {
  if (!isRecord(value) || !Array.isArray(value.items)) invalidConsoleRequestResponse();
  return { ...value, items: value.items.map((item) => consoleRequestStatesFromResponse(item)) };
}

export const saasClient = {
  login: (input: { email: string; password: string }) =>
    request<SessionResult>('/auth/session', { method: 'POST', body: input }),
  getSession: () => request<SessionResult>('/auth/session'),
  logout: () => request<{ loggedOut: boolean }>('/auth/session', { method: 'DELETE' }),
  getCustomerSessions: () =>
    request<unknown>('/auth/sessions', { redactErrors: true }).then(customerSessionsFromResponse),
  revokeCustomerSession: (sessionId: string) =>
    request<unknown>(`/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      body: {},
      redactErrors: true,
    }).then(customerSessionRevocationFromResponse),
  revokeOtherCustomerSessions: () =>
    request<unknown>('/auth/sessions/revoke-others', {
      method: 'POST',
      body: {},
      redactErrors: true,
    }).then(otherCustomerSessionsRevocationFromResponse),
  getTenants: (options: { signal?: AbortSignal } = {}) =>
    request<unknown>('/tenants', { signal: options.signal, workspace: true }).then(tenantsFromResponse),
  createTenant: (input: { name: string; slug?: string }) =>
    request<unknown>('/tenants', { method: 'POST', body: input, workspace: true }).then(tenantFromResponse),
  getCustomerRefunds: (
    tenantId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ) => {
    const { signal, ...filters } = options;
    return request<unknown>(
      withQuery(`/tenants/${encodeURIComponent(tenantId)}/refunds`, filters),
      { signal, redactErrors: true },
    ).then(customerRefundPageFromResponse);
  },
  getCustomerWebhookEndpoints: (
    tenantId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ) => {
    const { signal, ...filters } = options;
    return request<unknown>(
      withQuery(`/tenants/${encodeURIComponent(tenantId)}/webhooks`, filters),
      { signal, redactErrors: true },
    ).then(customerWebhookEndpointPageFromResponse);
  },
  createCustomerWebhookEndpoint: (tenantId: string, input: CustomerWebhookEndpointInput) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/webhooks`, {
      method: 'POST',
      body: input,
      redactErrors: true,
    }).then(createdCustomerWebhookEndpointFromResponse),
  updateCustomerWebhookEndpoint: (
    tenantId: string,
    endpointId: string,
    input: CustomerWebhookEndpointInput,
  ) => request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}`, {
    method: 'PATCH',
    body: input,
    redactErrors: true,
  }).then(customerWebhookEndpointFromResponse),
  setCustomerWebhookEndpointState: (
    tenantId: string,
    endpointId: string,
    action: 'enable' | 'disable' | 'revoke',
  ) => request<unknown>(
    `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}/${action}`,
    { method: 'POST', body: {}, redactErrors: true },
  ).then(customerWebhookEndpointFromResponse),
  getCustomerWebhookSigningSecrets: (tenantId: string, endpointId: string) =>
    request<unknown>(
      `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}/secrets`,
      { redactErrors: true },
    ).then(customerWebhookSecretsFromResponse),
  rotateCustomerWebhookSigningSecret: (tenantId: string, endpointId: string, overlapMs: number) =>
    request<unknown>(
      `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}/rotate`,
      { method: 'POST', body: { overlapMs }, redactErrors: true },
    ).then(customerWebhookSigningSecretFromResponse),
  revokeCustomerWebhookSigningSecret: (tenantId: string, endpointId: string, version: number) =>
    request<unknown>(
      `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}/secrets/${version}/revoke`,
      { method: 'POST', body: {}, redactErrors: true },
    ).then(customerWebhookSecretFromResponse),
  getCustomerWebhookDeliveryHistory: (
    tenantId: string,
    endpointId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ) => {
    const { signal, ...filters } = options;
    return request<unknown>(
      withQuery(
        `/tenants/${encodeURIComponent(tenantId)}/webhooks/${encodeURIComponent(endpointId)}/deliveries`,
        filters,
      ),
      { signal, redactErrors: true },
    ).then(customerWebhookDeliveryPageFromResponse);
  },
  getProjects: (tenantId: string, options: { signal?: AbortSignal } = {}) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/projects`, { signal: options.signal, workspace: true })
      .then(value => projectsFromResponse(value, tenantId)),
  getTenantMembers: (tenantId: string, options: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new SaasApiError(400, 'REQUEST_REJECTED', '成员分页输入无效。');
      query.set('limit', String(options.limit));
    }
    if (options.cursor !== undefined) {
      if (typeof options.cursor !== 'string' || options.cursor.length > 1024 || !/^tm1\.[A-Za-z0-9_-]+$/.test(options.cursor)) throw new SaasApiError(400, 'REQUEST_REJECTED', '成员分页输入无效。');
      query.set('cursor', options.cursor);
    }
    const suffix = query.size ? `?${query.toString()}` : '';
    return request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/members${suffix}`, { signal: options.signal, workspace: true }).then(tenantMemberPageFromResponse);
  },
  createProject: (tenantId: string, input: { name: string; slug?: string }) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/projects`, {
      method: 'POST',
      body: input,
      workspace: true,
    }).then(value => projectFromResponse(value, tenantId)),
  createInvitation: (
    tenantId: string,
    input: { email: string; role: InvitationRole },
  ) => request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/invitations`, {
    method: 'POST',
    body: input,
    workspace: true,
  }).then(invitationFromResponse),
  getTenantByokCredentials: (tenantId: string) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/credentials`, { sensitive: true }).then(
      tenantByokCredentialsFromResponse,
    ),
  createTenantByokCredential: (tenantId: string, input: TenantByokCredentialCreateInput) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/credentials`, {
      method: 'POST',
      body: input,
      sensitive: true,
    }).then(tenantByokWriteResultFromResponse),
  replaceTenantByokCredentialSecret: (
    tenantId: string,
    credentialId: string,
    input: TenantByokCredentialSecretInput,
  ) => request<unknown>(
    `/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/secret`,
    { method: 'PUT', body: input, sensitive: true },
  ).then(tenantByokWriteResultFromResponse),
  disableTenantByokCredential: (
    tenantId: string,
    credentialId: string,
    input: TenantByokCredentialLifecycleInput,
  ) => request<unknown>(
    `/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/disable`,
    { method: 'POST', body: input },
  ).then(tenantByokWriteResultFromResponse),
  enableTenantByokCredential: (
    tenantId: string,
    credentialId: string,
    input: TenantByokCredentialLifecycleInput,
  ) => request<unknown>(
    `/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/enable`,
    { method: 'POST', body: input },
  ).then(tenantByokWriteResultFromResponse),
  revokeTenantByokCredential: (
    tenantId: string,
    credentialId: string,
    input: TenantByokCredentialLifecycleInput,
  ) => request<unknown>(
    `/tenants/${encodeURIComponent(tenantId)}/credentials/${encodeURIComponent(credentialId)}/revoke`,
    { method: 'POST', body: input },
  ).then(tenantByokWriteResultFromResponse),
  getApiKeys: (tenantId: string, projectId: string) =>
    request<ApiKeyMetadata[]>(`/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}/keys`),
  createApiKey: (
    tenantId: string,
    projectId: string,
    input: { name: string; modelScopes: string[]; supplyMode: ApiKeySupplyMode; expiresAt?: string | null },
  ) => request<CreatedApiKey>(`/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}/keys`, {
    method: 'POST',
    body: input,
  }),
  rotateApiKey: (tenantId: string, projectId: string, keyId: string) =>
    request<CreatedApiKey>(`/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(keyId)}/rotate`, {
      method: 'POST',
    }),
  revokeApiKey: (tenantId: string, projectId: string, keyId: string) =>
    request<ApiKeyMetadata>(`/tenants/${encodeURIComponent(tenantId)}/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(keyId)}/revoke`, {
      method: 'POST',
    }),
  getUsageSummary: (tenantId: string, filters: Required<Pick<ConsoleQueryFilters, 'from' | 'to'>> & Omit<ConsoleQueryFilters, 'from' | 'to'>) =>
    request<ConsoleUsageSummary | null>(withQuery(`/tenants/${encodeURIComponent(tenantId)}/usage`, filters)),
  listRequests: (
    tenantId: string,
    filters: ConsoleQueryFilters & { cursor?: string; limit?: number } = {},
  ) => request<ConsolePage<ConsoleRequest>>(withQuery(`/tenants/${encodeURIComponent(tenantId)}/requests`, filters))
    .then(consoleRequestPageFromResponse),
  getRequest: (tenantId: string, requestId: string, projectId?: string) =>
    request<ConsoleRequestDetail>(withQuery(
      `/tenants/${encodeURIComponent(tenantId)}/requests/${encodeURIComponent(requestId)}`,
      { ...(projectId === undefined ? {} : { projectId }) },
    )).then((value) => consoleRequestStatesFromResponse(value)),
  getRequestDetail: (tenantId: string, requestId: string, projectId?: string) =>
    request<ConsoleRequestDetail>(withQuery(
      `/tenants/${encodeURIComponent(tenantId)}/requests/${encodeURIComponent(requestId)}`,
      { ...(projectId === undefined ? {} : { projectId }) },
    )).then((value) => consoleRequestStatesFromResponse(value)),
  getServicePlanCatalog: (tenantId: string) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/service-plans/catalog`).then(servicePlansFromResponse),
  getServicePlans: (tenantId: string) =>
    request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/service-plans/catalog`).then(servicePlansFromResponse),
  createServicePlanOrder: (
    tenantId: string,
    input: { planVersionId: string; operation?: 'activation' },
    idempotencyKey: string,
  ) => {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new SaasApiError(0, 'INVALID_INPUT', '创建服务计划订单需要稳定的 Idempotency-Key');
    }
    if (input.operation !== undefined && input.operation !== 'activation') {
      throw new SaasApiError(0, 'INVALID_INPUT', '客户控制台只支持 activation 购买');
    }
    return request<unknown>(`/tenants/${encodeURIComponent(tenantId)}/service-plan-orders`, {
      method: 'POST',
      body: input,
      idempotencyKey,
    }).then(value => parseServicePlanOrderForTenant(value, tenantId));
  },
  getServicePlanOrder: (tenantId: string, orderId: string, signal?: AbortSignal) =>
    request<unknown>(
      `/tenants/${encodeURIComponent(tenantId)}/service-plan-orders/${encodeURIComponent(orderId)}`,
      { signal },
    ).then(value => parseServicePlanOrderForTenant(value, tenantId)),
  retryServicePlanOrder: (tenantId: string, orderId: string) =>
    request<unknown>(
      `/tenants/${encodeURIComponent(tenantId)}/service-plan-orders/${encodeURIComponent(orderId)}/retry`,
      { method: 'POST' },
    ).then(value => parseServicePlanOrderForTenant(value, tenantId)),
  getServicePlanOrderCheckout: (tenantId: string, orderId: string, signal?: AbortSignal) =>
    saasClient.getServicePlanOrder(tenantId, orderId, signal).then(order => order.checkout),
  acceptInvitation: (input: { token: string; email: string; displayName: string; password: string }) =>
    request<unknown>('/invitations/accept', { method: 'POST', body: input, workspace: true }).then(acceptedIdentityFromResponse),
};
