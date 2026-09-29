import { createHash, randomUUID } from 'node:crypto';
import { normalizeCurrency, parseMinorUnits, parseStoredMinorUnits } from '../billing/money.js';
import { PlatformWalletLedgerService } from '../billing/service.js';
import type { SqlExecutor, SqlResult } from '../db/types.js';
import type { TenantContext } from '../identity/types.js';
import { isServicePlanError } from '../plans/errors.js';
import type { ServicePlanOrderRecord } from '../plans/types.js';
import type { PaymentProviderAdapter } from './adapter.js';
import {
  checkoutActionColumns,
  checkoutViewFromStored,
  type NormalizedCheckoutPolicy,
  normalizePaymentCheckoutOptions,
  normalizeProviderCheckoutAction,
  type StoredCheckoutFields,
  unavailableCheckout,
} from './checkout.js';
import { isPaymentError, PaymentError, type PaymentErrorCode } from './errors.js';
import type {
  CreateServicePlanPaymentInput,
  CreateWalletTopUpInput,
  NormalizedPaymentProviderEvent,
  PaymentCheckoutAction,
  PaymentCheckoutView,
  PaymentDatabase,
  PaymentInboxOutcome,
  PaymentOrderRecord,
  PaymentOrderStatus,
  PaymentProviderEventStatus,
  PaymentServiceOptions,
  PaymentWebhookHeaders,
  PaymentWebhookResult,
  PaymentWebhookWorkerBatchResult,
  ReadServicePlanPaymentInput,
  ReadWalletTopUpInput,
  RetryPaymentOrderInput,
  RetryServicePlanPaymentInput,
  ServicePlanPaymentOrderRecord,
} from './types.js';

const FUNDING_NAMESPACE = 'saas.payment.wallet_topup';
const MAX_TEXT_LENGTH = 512;
const MAX_EVENT_BODY_BYTES = 1024 * 1024;
const SAFE_RETRY_FAILURE_CODE = 'PROVIDER_CREATE_REJECTED';
const NON_RETRYABLE_FAILURE_CODE = 'PROVIDER_CREATE_NOT_RETRYABLE';
const RETRY_LIMIT_FAILURE_CODE = 'PROVIDER_RETRY_LIMIT';
const DEFAULT_MAX_PROVIDER_ATTEMPTS = 3;
const MAX_PROVIDER_ATTEMPTS = 10;
const DEFAULT_RETRY_COOLDOWN_MS = 1_000;
const MAX_RETRY_COOLDOWN_MS = 86_400_000;
const WEBHOOK_WORKER_LEASE_MS = 60_000;
const WEBHOOK_UNKNOWN_ORDER_GRACE_MS = 60_000;
const WEBHOOK_WORKER_MAX_ATTEMPTS = 12;
const WEBHOOK_WORKER_MAX_BATCH_SIZE = 100;

type StoredTimestamp = string | Date;
type StoredMinorUnits = string | number | bigint;

interface PaymentOrderRow {
  id: string;
  tenant_id: string;
  order_type: string;
  provider_key: string;
  merchant_id: string;
  client_request_id: string;
  local_order_ref: string;
  funding_reference: string;
  amount_minor_units: StoredMinorUnits;
  currency: string;
  state: string;
  provider_order_id: string | null;
  provider_attempts: number;
  provider_failure_code: string | null;
  funding_transaction_id: string | null;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  paid_at: StoredTimestamp | null;
  fulfilled_at: StoredTimestamp | null;
  checkout_kind?: string | null;
  checkout_url?: string | null;
  checkout_text?: string | null;
  checkout_expires_at?: StoredTimestamp | null;
  provider_submission_state?: string | null;
  provider_submission_lease_token?: string | null;
  provider_submission_lease_expires_at?: StoredTimestamp | null;
}

interface PaymentInboxRow {
  id: string;
  provider_key: string;
  merchant_id: string;
  provider_event_id: string;
  event_type: string;
  provider_order_id: string;
  event_tenant_id: string;
  tenant_id: string | null;
  local_order_id: string | null;
  event_status: string;
  amount_minor_units: StoredMinorUnits;
  currency: string;
  occurred_at: StoredTimestamp;
  received_at: StoredTimestamp;
  processing_outcome: string;
  outcome_code: string | null;
  processing_state: string;
  attempt_count: number;
  next_attempt_at: StoredTimestamp;
  lease_token: string | null;
  lease_expires_at: StoredTimestamp | null;
  processed_at: StoredTimestamp | null;
  last_error_code: string | null;
  updated_at: StoredTimestamp;
}

interface ServicePlanPaymentRow {
  id: string;
  tenant_id: string;
  project_id: string;
  plan_version_id: string;
  operation: string;
  renewal_of_subscription_id: string | null;
  client_request_id: string;
  state: string;
  subscription_id: string | null;
  provider_key: string | null;
  merchant_id: string | null;
  provider_order_id: string | null;
  provider_attempts: number;
  provider_failure_code: string | null;
  verified_settlement_id: string | null;
  verified_provider_key: string | null;
  verified_merchant_id: string | null;
  verified_amount_minor_units: StoredMinorUnits | null;
  verified_currency: string | null;
  fulfillment_reference: string | null;
  created_at: StoredTimestamp;
  updated_at: StoredTimestamp;
  paid_at: StoredTimestamp | null;
  fulfilled_at: StoredTimestamp | null;
  snapshot_price_minor_units: StoredMinorUnits;
  snapshot_currency: string;
  checkout_kind?: string | null;
  checkout_url?: string | null;
  checkout_text?: string | null;
  checkout_expires_at?: StoredTimestamp | null;
  provider_submission_state?: string | null;
  provider_submission_lease_token?: string | null;
  provider_submission_lease_expires_at?: StoredTimestamp | null;
}

type MappedServicePlanPaymentRow = ServicePlanPaymentRow & {
  readonly snapshot_price_minor_units: string;
  readonly providerSubmissionState: string;
  readonly providerSubmissionLeaseToken: string | null;
  readonly providerSubmissionLeaseExpiresAt: string | null;
};

interface NormalizedEvent {
  readonly providerKey: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerOrderId: string;
  readonly tenantId: string;
  readonly merchantId: string;
  readonly status: PaymentProviderEventStatus;
  readonly amountMinorUnits: bigint;
  readonly currency: string;
  readonly occurredAt: string;
}

interface ProviderAttemptClaim {
  readonly claimed: boolean;
  readonly order: PaymentOrderEntity;
  readonly leaseToken: string | null;
}

interface ServicePlanProviderAttemptClaim {
  readonly claimed: boolean;
  readonly order: MappedServicePlanPaymentRow;
  readonly leaseToken: string | null;
}

type PaymentOrderEntity = Omit<PaymentOrderRecord, 'checkout'> &
  StoredCheckoutFields & {
    readonly providerSubmissionState: string;
    readonly providerSubmissionLeaseToken: string | null;
    readonly providerSubmissionLeaseExpiresAt: string | null;
  };

interface ServicePlanFulfillmentWork {
  readonly kind: 'service_plan_fulfillment';
  readonly inbox: PaymentInboxRow;
  readonly order: MappedServicePlanPaymentRow;
  readonly event: NormalizedEvent;
}

type ProcessedWebhook = PaymentWebhookResult | ServicePlanFulfillmentWork;

type ProviderSubmissionDisposition = 'safe_rejection' | 'definitive_rejection' | 'acceptance_unknown';

function rowsHaveOne<Row>(result: SqlResult<Row>): boolean {
  return result.rows.length === 1 && (result.rowCount === null || result.rowCount === 1);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function providerSubmissionDisposition(error: unknown): ProviderSubmissionDisposition {
  if (!error || typeof error !== 'object') return 'acceptance_unknown';
  const value = error as Record<string, unknown>;
  const acceptance = value.acceptance;
  if (acceptance !== 'rejected' && acceptance !== 'not_accepted') return 'acceptance_unknown';
  if (value.retryable === true || value.safeToRetry === true) {
    if (value.retryable === false || value.safeToRetry === false) return 'definitive_rejection';
    return 'safe_rejection';
  }
  return 'definitive_rejection';
}

function providerCheckoutAction(value: {
  readonly checkoutAction?: PaymentCheckoutAction;
  readonly action?: PaymentCheckoutAction;
  readonly checkout?: PaymentCheckoutAction;
}): PaymentCheckoutAction | undefined {
  return value.checkoutAction ?? value.action ?? value.checkout;
}

function checkoutRefreshAction(value: unknown): PaymentCheckoutAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'redirect' || candidate.kind === 'qr') return value as PaymentCheckoutAction;
  return providerCheckoutAction(candidate);
}

function normalizeText(value: unknown, code: PaymentErrorCode = 'INVALID_INPUT'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_LENGTH) throw new PaymentError(code);
  if (
    [...value].some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new PaymentError(code);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new PaymentError(code);
  return normalized;
}

function normalizeTimestamp(value: unknown): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new PaymentError('INVALID_INPUT');
  return date.toISOString();
}

function storedTimestamp(value: unknown): string {
  return normalizeTimestamp(value);
}

function mapStatus(value: unknown): PaymentOrderStatus {
  if (
    value === 'created' ||
    value === 'pending' ||
    value === 'provider_failed' ||
    value === 'paid' ||
    value === 'fulfilling' ||
    value === 'fulfilled' ||
    value === 'cancelled' ||
    value === 'reconciliation_pending'
  ) {
    return value;
  }
  throw new PaymentError('PAYMENT_STORAGE_ERROR');
}

function mapInboxOutcome(value: unknown): PaymentInboxOutcome {
  if (
    value === 'accepted' ||
    value === 'fulfilled' ||
    value === 'replayed' ||
    value === 'reconciliation' ||
    value === 'rejected'
  ) {
    return value;
  }
  throw new PaymentError('PAYMENT_STORAGE_ERROR');
}

function mapProviderEventStatus(value: unknown): PaymentProviderEventStatus {
  if (value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'cancelled') return value;
  throw new PaymentError('PAYMENT_STORAGE_ERROR');
}

function mapSubmissionState(value: unknown): string {
  if (value === undefined || value === null) return 'idle';
  if (value === 'idle' || value === 'submitting' || value === 'failed' || value === 'unknown') return value;
  throw new PaymentError('PAYMENT_STORAGE_ERROR');
}

function mapLeaseToken(value: unknown, submissionState: string): string | null {
  if (submissionState !== 'submitting') {
    if (value !== undefined && value !== null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return null;
  }
  return normalizeText(value, 'PAYMENT_STORAGE_ERROR');
}

function mapLeaseExpiry(value: unknown, submissionState: string): string | null {
  if (submissionState !== 'submitting') {
    if (value !== undefined && value !== null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return null;
  }
  return storedTimestamp(value);
}

function mapOrderRow(row: PaymentOrderRow): PaymentOrderEntity {
  if (row.order_type !== 'wallet_topup') throw new PaymentError('PAYMENT_STORAGE_ERROR');
  const attempts = typeof row.provider_attempts === 'number' ? row.provider_attempts : Number(row.provider_attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new PaymentError('PAYMENT_STORAGE_ERROR');
  const providerSubmissionState = mapSubmissionState(row.provider_submission_state);
  return {
    id: normalizeText(row.id),
    tenantId: normalizeText(row.tenant_id),
    orderType: 'wallet_topup',
    providerKey: normalizeText(row.provider_key),
    merchantId: normalizeText(row.merchant_id),
    clientRequestId: normalizeText(row.client_request_id),
    localOrderRef: normalizeText(row.local_order_ref),
    fundingReference: normalizeText(row.funding_reference),
    amountMinorUnits: parseStoredMinorUnits(row.amount_minor_units).toString(),
    currency: normalizeCurrency(row.currency),
    status: mapStatus(row.state),
    providerOrderId: row.provider_order_id === null ? null : normalizeText(row.provider_order_id),
    providerAttempts: attempts,
    providerFailureCode: row.provider_failure_code === null ? null : normalizeText(row.provider_failure_code),
    fundingTransactionId: row.funding_transaction_id === null ? null : normalizeText(row.funding_transaction_id),
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    paidAt: row.paid_at === null ? null : storedTimestamp(row.paid_at),
    fulfilledAt: row.fulfilled_at === null ? null : storedTimestamp(row.fulfilled_at),
    checkoutKind: row.checkout_kind,
    checkoutUrl: row.checkout_url,
    checkoutText: row.checkout_text,
    checkoutExpiresAt: row.checkout_expires_at,
    providerSubmissionState,
    providerSubmissionLeaseToken: mapLeaseToken(row.provider_submission_lease_token, providerSubmissionState),
    providerSubmissionLeaseExpiresAt: mapLeaseExpiry(row.provider_submission_lease_expires_at, providerSubmissionState),
  };
}

function mapServicePlanPaymentRow(row: ServicePlanPaymentRow): MappedServicePlanPaymentRow {
  const attempts = typeof row.provider_attempts === 'number' ? row.provider_attempts : Number(row.provider_attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new PaymentError('PAYMENT_STORAGE_ERROR');
  if (
    row.provider_key !== null &&
    row.merchant_id !== null &&
    row.provider_order_id !== null &&
    (row.provider_key.trim() === '' || row.merchant_id.trim() === '' || row.provider_order_id.trim() === '')
  ) {
    throw new PaymentError('PAYMENT_STORAGE_ERROR');
  }
  if (row.provider_key === null || row.merchant_id === null) {
    if (row.provider_key !== null || row.merchant_id !== null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
  }
  const snapshotAmount = parseStoredMinorUnits(row.snapshot_price_minor_units);
  const snapshotCurrency = normalizeCurrency(row.snapshot_currency);
  const providerSubmissionState = mapSubmissionState(row.provider_submission_state);
  if (row.state !== 'pending' && row.state !== 'paid' && row.state !== 'fulfilling' && row.state !== 'fulfilled') {
    if (row.state !== 'cancelled' && row.state !== 'reconciliation_pending') {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }
  return {
    ...row,
    provider_attempts: attempts,
    snapshot_price_minor_units: snapshotAmount.toString(),
    snapshot_currency: snapshotCurrency,
    providerSubmissionState,
    providerSubmissionLeaseToken: mapLeaseToken(row.provider_submission_lease_token, providerSubmissionState),
    providerSubmissionLeaseExpiresAt: mapLeaseExpiry(row.provider_submission_lease_expires_at, providerSubmissionState),
  };
}

function mapInboxRow(row: PaymentInboxRow): {
  readonly outcome: PaymentInboxOutcome;
  readonly orderId: string | null;
  readonly fundingTransactionId: string | null;
} {
  mapProviderEventStatus(row.event_status);
  parseStoredMinorUnits(row.amount_minor_units);
  normalizeCurrency(row.currency);
  return {
    outcome: mapInboxOutcome(row.processing_outcome),
    orderId: row.local_order_id === null ? null : normalizeText(row.local_order_id),
    fundingTransactionId: null,
  };
}

const ORDER_COLUMNS = `id, tenant_id, order_type, provider_key, merchant_id, client_request_id,
  local_order_ref, funding_reference, amount_minor_units, currency, state, provider_order_id,
  provider_attempts, provider_failure_code, funding_transaction_id, created_at, updated_at, paid_at, fulfilled_at,
  checkout_kind, checkout_url, checkout_text, checkout_expires_at,
  provider_submission_state, provider_submission_lease_token, provider_submission_lease_expires_at`;

const INBOX_COLUMNS = `id, provider_key, merchant_id, provider_event_id, event_type, provider_order_id,
  event_tenant_id, tenant_id, local_order_id, event_status, amount_minor_units, currency, occurred_at,
  processing_outcome, outcome_code, processing_state, attempt_count, next_attempt_at,
  lease_token, lease_expires_at, processed_at, last_error_code, updated_at`;

const SERVICE_PLAN_PAYMENT_COLUMNS = `o.id, o.tenant_id, o.project_id, o.plan_version_id,
  o.operation, o.renewal_of_subscription_id, o.client_request_id, o.state, o.subscription_id,
  o.provider_key, o.merchant_id, o.provider_order_id, o.provider_attempts, o.provider_failure_code,
  o.verified_settlement_id, o.verified_provider_key, o.verified_merchant_id,
  o.verified_amount_minor_units, o.verified_currency, o.fulfillment_reference,
  o.created_at, o.updated_at, o.paid_at, o.fulfilled_at,
  o.checkout_kind, o.checkout_url, o.checkout_text, o.checkout_expires_at,
  o.provider_submission_state, o.provider_submission_lease_token, o.provider_submission_lease_expires_at,
  snap.price_minor_units AS snapshot_price_minor_units, snap.currency AS snapshot_currency`;

export class PaymentFulfillmentService {
  readonly providerKey: string;
  readonly merchantId: string;

  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly walletFundingLedger: PaymentServiceOptions['walletFundingLedger'];
  private readonly servicePlanService: PaymentServiceOptions['servicePlanService'];
  private readonly checkoutPolicy: NormalizedCheckoutPolicy;
  private readonly submissionLeaseTtlMs: number;
  private readonly maxProviderAttempts: number;
  private readonly retryCooldownMs: number;

  constructor(
    private readonly database: PaymentDatabase,
    private readonly provider: PaymentProviderAdapter,
    options: PaymentServiceOptions,
  ) {
    this.providerKey = normalizeText(options.providerKey);
    this.merchantId = normalizeText(options.merchantId);
    if (provider.providerKey !== this.providerKey) throw new TypeError('provider.providerKey must match providerKey');
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.walletFundingLedger =
      options.walletFundingLedger ?? new PlatformWalletLedgerService({ now: this.now, idFactory: this.idFactory });
    this.servicePlanService = options.servicePlanService;
    this.checkoutPolicy = normalizePaymentCheckoutOptions(options.checkout, options.checkoutRedirectPolicies);
    this.submissionLeaseTtlMs = options.submissionLeaseTtlMs ?? 60_000;
    this.maxProviderAttempts = options.maxProviderAttempts ?? DEFAULT_MAX_PROVIDER_ATTEMPTS;
    this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    if (
      !Number.isSafeInteger(this.submissionLeaseTtlMs) ||
      this.submissionLeaseTtlMs < 1_000 ||
      this.submissionLeaseTtlMs > 86_400_000
    ) {
      throw new TypeError('submissionLeaseTtlMs must be an integer between 1000 and 86400000');
    }
    if (
      !Number.isSafeInteger(this.maxProviderAttempts) ||
      this.maxProviderAttempts < 1 ||
      this.maxProviderAttempts > MAX_PROVIDER_ATTEMPTS
    ) {
      throw new TypeError(`maxProviderAttempts must be an integer between 1 and ${MAX_PROVIDER_ATTEMPTS}`);
    }
    if (
      !Number.isSafeInteger(this.retryCooldownMs) ||
      this.retryCooldownMs < 0 ||
      this.retryCooldownMs > MAX_RETRY_COOLDOWN_MS
    ) {
      throw new TypeError(`retryCooldownMs must be an integer between 0 and ${MAX_RETRY_COOLDOWN_MS}`);
    }
  }

  async createWalletTopUp(input: CreateWalletTopUpInput): Promise<PaymentOrderRecord> {
    const normalized = this.normalizeCreateInput(input);
    let existing = await this.findOrderByClientRequest(normalized.tenantId, normalized.clientRequestId);
    if (existing) {
      this.assertCreateReplay(existing, normalized);
      if (existing.status === 'created' || existing.status === 'provider_failed') {
        return this.submitProviderOrder(existing, false);
      }
      return this.publicWalletOrder(existing);
    }

    const orderId = normalizeText(this.idFactory());
    const createdAt = this.currentDate().toISOString();
    const inserted = await this.runTransaction((executor) =>
      this.insertOrder(executor, {
        id: orderId,
        tenantId: normalized.tenantId,
        clientRequestId: normalized.clientRequestId,
        amountMinorUnits: normalized.amountMinorUnits,
        currency: normalized.currency,
        createdAt,
      }),
    );
    if (inserted) return this.submitProviderOrder(inserted, false);

    existing = await this.findOrderByClientRequest(normalized.tenantId, normalized.clientRequestId);
    if (!existing) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    this.assertCreateReplay(existing, normalized);
    if (existing.status === 'created' || existing.status === 'provider_failed') {
      return this.submitProviderOrder(existing, false);
    }
    return this.publicWalletOrder(existing);
  }

  /**
   * Creates the existing BYOK service-plan order first, then submits its
   * immutable plan amount/currency snapshot to the provider.  No customer
   * supplied amount or payment-success flag is accepted here.
   */
  async createServicePlanPayment(
    context: TenantContext,
    input: CreateServicePlanPaymentInput,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const servicePlan = this.requireServicePlanService();
    const normalizedInput = this.normalizeServicePlanInput(input);
    const order = await servicePlan.createOrder(context, normalizedInput);
    return this.submitServicePlanProviderOrder(order, false);
  }

  async getServicePlanPayment(context: TenantContext, orderId: string): Promise<ServicePlanPaymentOrderRecord | null> {
    const servicePlan = this.requireServicePlanService();
    const scope = this.normalizeServicePlanScope(context);
    const normalizedOrderId = normalizeText(orderId);
    const row = await this.findServicePlanPaymentById(
      this.database,
      scope.tenantId,
      scope.projectId,
      normalizedOrderId,
    );
    if (!row) return null;
    const order = await servicePlan.getOrder(context, normalizedOrderId);
    if (!order) return null;
    return this.mapServicePlanPaymentOrder(order, row);
  }

  async retryServicePlanPayment(
    context: TenantContext,
    input: RetryServicePlanPaymentInput,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const servicePlan = this.requireServicePlanService();
    const scope = this.normalizeServicePlanScope(context);
    const normalizedOrderId = normalizeText(input?.orderId);
    if (scope.tenantId !== normalizeText(input?.tenantId) || scope.projectId !== normalizeText(input?.projectId)) {
      throw new PaymentError('ORDER_NOT_FOUND');
    }
    const current = await this.getServicePlanPayment(context, normalizedOrderId);
    if (!current) throw new PaymentError('ORDER_NOT_FOUND');
    if (current.state === 'fulfilled') return current;
    if (current.state !== 'pending') throw new PaymentError('ORDER_STATE_CONFLICT');
    if (current.providerOrderId !== null) return current;
    if (current.providerFailureCode !== null && current.providerFailureCode !== SAFE_RETRY_FAILURE_CODE) {
      throw new PaymentError('ORDER_STATE_CONFLICT');
    }
    if (current.providerAttempts >= this.maxProviderAttempts) throw new PaymentError('ORDER_STATE_CONFLICT');
    if (!servicePlan) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return this.submitServicePlanProviderOrder(current, true);
  }

  // Explicit BYOK aliases keep the payment seam discoverable to callers that
  // name the commercial product rather than its service-plan table.
  createByokServicePlanPayment(
    context: TenantContext,
    input: CreateServicePlanPaymentInput,
  ): Promise<ServicePlanPaymentOrderRecord> {
    return this.createServicePlanPayment(context, input);
  }

  getByokServicePlanPayment(context: TenantContext, orderId: string): Promise<ServicePlanPaymentOrderRecord | null> {
    return this.getServicePlanPayment(context, orderId);
  }

  retryByokServicePlanPayment(
    context: TenantContext,
    input: RetryServicePlanPaymentInput,
  ): Promise<ServicePlanPaymentOrderRecord> {
    return this.retryServicePlanPayment(context, input);
  }

  async getWalletTopUp(input: ReadWalletTopUpInput): Promise<PaymentOrderRecord | null> {
    const tenantId = normalizeText(input.tenantId);
    const orderId = normalizeText(input.orderId);
    const order = await this.findWalletOrderById(this.database, tenantId, orderId);
    return order ? this.publicWalletOrder(order) : null;
  }

  async retryProviderOrder(input: RetryPaymentOrderInput): Promise<PaymentOrderRecord> {
    const tenantId = normalizeText(input.tenantId);
    const orderId = normalizeText(input.orderId);
    const order = await this.findWalletOrderById(this.database, tenantId, orderId);
    if (!order) throw new PaymentError('ORDER_NOT_FOUND');
    this.assertProviderSnapshot(order);
    if (order.status !== 'created' && order.status !== 'provider_failed') {
      if (order.status === 'pending' || order.status === 'fulfilled') return this.publicWalletOrder(order);
      throw new PaymentError('ORDER_STATE_CONFLICT');
    }
    if (order.providerOrderId !== null || order.providerFailureCode !== SAFE_RETRY_FAILURE_CODE) {
      throw new PaymentError('ORDER_STATE_CONFLICT');
    }
    if (order.providerAttempts >= this.maxProviderAttempts) throw new PaymentError('ORDER_STATE_CONFLICT');
    return this.submitProviderOrder(order, true);
  }

  async refreshWalletTopUpCheckout(input: ReadWalletTopUpInput): Promise<PaymentOrderRecord> {
    const tenantId = normalizeText(input?.tenantId);
    const orderId = normalizeText(input?.orderId);
    const order = await this.findWalletOrderById(this.database, tenantId, orderId);
    if (!order) throw new PaymentError('ORDER_NOT_FOUND');
    return this.refreshWalletCheckout(order);
  }

  async refreshServicePlanPaymentCheckout(
    context: TenantContext,
    input: ReadServicePlanPaymentInput,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const servicePlan = this.requireServicePlanService();
    const scope = this.normalizeServicePlanScope(context);
    const tenantId = normalizeText(input?.tenantId);
    const projectId = normalizeText(input?.projectId);
    const orderId = normalizeText(input?.orderId);
    if (scope.tenantId !== tenantId || scope.projectId !== projectId) throw new PaymentError('ORDER_NOT_FOUND');
    const row = await this.findServicePlanPaymentById(this.database, tenantId, projectId, orderId);
    if (!row) throw new PaymentError('ORDER_NOT_FOUND');
    const order = await servicePlan.getOrder(context, orderId);
    if (!order) throw new PaymentError('ORDER_NOT_FOUND');
    return this.refreshServicePlanCheckout(order, row);
  }

  refreshByokServicePlanCheckout(
    context: TenantContext,
    input: ReadServicePlanPaymentInput,
  ): Promise<ServicePlanPaymentOrderRecord> {
    return this.refreshServicePlanPaymentCheckout(context, input);
  }

  private async refreshWalletCheckout(order: PaymentOrderEntity): Promise<PaymentOrderRecord> {
    const current = this.publicWalletOrder(order);
    if (current.checkout.status === 'closed' || current.checkout.status === 'ready') return current;
    this.assertProviderSnapshot(order);
    const refreshCheckout = this.provider.refreshCheckout ?? this.provider.refreshOrderCheckout;
    if (order.providerOrderId === null || typeof refreshCheckout !== 'function') {
      return this.publicWalletOrder(order, unavailableCheckout());
    }

    let result: Awaited<ReturnType<NonNullable<PaymentProviderAdapter['refreshCheckout']>>>;
    try {
      result = await refreshCheckout.call(this.provider, {
        localOrderId: order.id,
        tenantId: order.tenantId,
        providerOrderId: order.providerOrderId,
        amountMinorUnits: order.amountMinorUnits,
        currency: order.currency,
        merchantId: order.merchantId,
      });
    } catch {
      return this.publicWalletOrder(order, unavailableCheckout());
    }

    let action: PaymentCheckoutAction | null;
    try {
      const candidate = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      if (
        (candidate.providerOrderId === undefined ? order.providerOrderId : normalizeText(candidate.providerOrderId)) !==
          order.providerOrderId ||
        (candidate.amountMinorUnits === undefined
          ? BigInt(order.amountMinorUnits)
          : parseMinorUnits(candidate.amountMinorUnits)) !== BigInt(order.amountMinorUnits) ||
        (candidate.currency === undefined ? order.currency : normalizeCurrency(candidate.currency)) !== order.currency
      ) {
        throw new PaymentError('PROVIDER_RESULT_INVALID');
      }
      action = normalizeProviderCheckoutAction(checkoutRefreshAction(result), this.providerKey, this.checkoutPolicy);
    } catch {
      action = null;
    }
    const updated = await this.persistWalletCheckout(order, action);
    const publicOrder = this.publicWalletOrder(updated);
    return action === null && publicOrder.checkout.status !== 'closed'
      ? { ...publicOrder, checkout: unavailableCheckout() }
      : publicOrder;
  }

  private async persistWalletCheckout(
    order: PaymentOrderEntity,
    action: PaymentCheckoutAction | null,
  ): Promise<PaymentOrderEntity> {
    const columns = checkoutActionColumns(action);
    return this.runTransaction(async (executor) => {
      const result = await executor.query<PaymentOrderRow>(
        `UPDATE saas_payment_orders
         SET checkout_kind = $3, checkout_url = $4, checkout_text = $5, checkout_expires_at = $6,
             updated_at = $7
         WHERE tenant_id = $1 AND id = $2 AND provider_order_id = $8
           AND state = 'pending'
         RETURNING ${ORDER_COLUMNS}`,
        [
          order.tenantId,
          order.id,
          columns.kind,
          columns.url,
          columns.text,
          columns.expiresAt,
          this.currentDate().toISOString(),
          order.providerOrderId,
        ],
      );
      if (rowsHaveOne(result) && result.rows[0]) return mapOrderRow(result.rows[0]);
      const reread = await this.lockOrder(executor, order.tenantId, order.id);
      if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
      return reread;
    });
  }

  private async refreshServicePlanCheckout(
    order: ServicePlanOrderRecord,
    row: MappedServicePlanPaymentRow,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const current = this.mapServicePlanPaymentOrder(order, row);
    if (current.checkout.status === 'closed' || current.checkout.status === 'ready') return current;
    const merchantId = row.merchant_id;
    this.assertProviderSnapshotValues(row.provider_key, merchantId);
    if (merchantId === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    const refreshCheckout = this.provider.refreshCheckout ?? this.provider.refreshOrderCheckout;
    if (row.provider_order_id === null || typeof refreshCheckout !== 'function') {
      return { ...current, checkout: unavailableCheckout() };
    }

    let result: Awaited<ReturnType<NonNullable<PaymentProviderAdapter['refreshCheckout']>>>;
    try {
      result = await refreshCheckout.call(this.provider, {
        localOrderId: row.id,
        tenantId: row.tenant_id,
        providerOrderId: row.provider_order_id,
        amountMinorUnits: row.snapshot_price_minor_units.toString(),
        currency: row.snapshot_currency,
        merchantId,
      });
    } catch {
      return { ...current, checkout: unavailableCheckout() };
    }

    let action: PaymentCheckoutAction | null;
    try {
      const candidate = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      if (
        (candidate.providerOrderId === undefined ? row.provider_order_id : normalizeText(candidate.providerOrderId)) !==
          row.provider_order_id ||
        (candidate.amountMinorUnits === undefined
          ? parseStoredMinorUnits(row.snapshot_price_minor_units)
          : parseMinorUnits(candidate.amountMinorUnits)) !== parseStoredMinorUnits(row.snapshot_price_minor_units) ||
        (candidate.currency === undefined ? row.snapshot_currency : normalizeCurrency(candidate.currency)) !==
          row.snapshot_currency
      ) {
        throw new PaymentError('PROVIDER_RESULT_INVALID');
      }
      action = normalizeProviderCheckoutAction(checkoutRefreshAction(result), this.providerKey, this.checkoutPolicy);
    } catch {
      action = null;
    }
    const updated = await this.persistServicePlanCheckout(row, action);
    return this.mapServicePlanPaymentOrder(order, updated);
  }

  private async persistServicePlanCheckout(
    row: MappedServicePlanPaymentRow,
    action: PaymentCheckoutAction | null,
  ): Promise<MappedServicePlanPaymentRow> {
    const columns = checkoutActionColumns(action);
    return this.runTransaction(async (executor) => {
      const result = await executor.query<{ id: string }>(
        `UPDATE saas_service_plan_orders
         SET checkout_kind = $4, checkout_url = $5, checkout_text = $6, checkout_expires_at = $7,
             updated_at = $8
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
           AND provider_order_id = $9 AND state = 'pending'
         RETURNING id`,
        [
          row.tenant_id,
          row.project_id,
          row.id,
          columns.kind,
          columns.url,
          columns.text,
          columns.expiresAt,
          this.currentDate().toISOString(),
          row.provider_order_id,
        ],
      );
      if (!rowsHaveOne(result)) {
        const reread = await this.findServicePlanPaymentById(executor, row.tenant_id, row.project_id, row.id, true);
        if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
        return reread;
      }
      const reread = await this.findServicePlanPaymentById(executor, row.tenant_id, row.project_id, row.id, true);
      if (!reread) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return reread;
    });
  }

  async handleWebhook(headers: PaymentWebhookHeaders, rawBody: Buffer): Promise<PaymentWebhookResult> {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > MAX_EVENT_BODY_BYTES) {
      throw new PaymentError('WEBHOOK_INVALID');
    }

    let verified: Awaited<ReturnType<PaymentProviderAdapter['verifyWebhook']>>;
    try {
      verified = await this.provider.verifyWebhook({ headers, rawBody, merchantId: this.merchantId });
    } catch {
      throw new PaymentError('WEBHOOK_REJECTED');
    }
    if (verified.providerKey !== this.providerKey || verified.merchantId !== this.merchantId) {
      throw new PaymentError('WEBHOOK_REJECTED');
    }

    let event: NormalizedEvent;
    try {
      event = this.normalizeEvent(this.provider.normalizeEvent(verified));
    } catch (error) {
      if (isPaymentError(error) && error.code === 'WEBHOOK_REJECTED') throw error;
      throw new PaymentError('WEBHOOK_INVALID');
    }

    return this.runTransaction((executor) => this.enqueueWebhook(executor, event));
  }

  /**
   * Claims and processes durable webhook inbox work. This method is only for
   * an internal worker; public webhook requests stop after signature
   * verification and inbox commit.
   */
  async processPendingWebhooks(limit = 20): Promise<PaymentWebhookWorkerBatchResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WEBHOOK_WORKER_MAX_BATCH_SIZE) {
      throw new PaymentError('INVALID_INPUT');
    }
    const claimed = await this.claimPendingWebhooks(limit);
    let processed = 0;
    let retrying = 0;
    let exhausted = 0;

    for (const inbox of claimed) {
      try {
        const result = await this.processClaimedWebhook(inbox);
        if (result !== null) {
          if ('kind' in result && result.kind === 'service_plan_fulfillment') {
            await this.fulfillServicePlanWebhook(result);
          }
          processed += 1;
        }
      } catch {
        const released = await this.releaseWebhookClaim(inbox);
        if (released === 'exhausted') exhausted += 1;
        else if (released === 'retrying') retrying += 1;
      }
    }
    return { claimed: claimed.length, processed, retrying, exhausted };
  }

  private requireServicePlanService(): NonNullable<PaymentServiceOptions['servicePlanService']> {
    if (!this.servicePlanService) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return this.servicePlanService;
  }

  private normalizeServicePlanScope(context: TenantContext): { tenantId: string; projectId: string } {
    return {
      tenantId: normalizeText(context?.tenantId),
      projectId: normalizeText(context?.projectId),
    };
  }

  private normalizeServicePlanInput(input: CreateServicePlanPaymentInput): CreateServicePlanPaymentInput {
    if (!input || typeof input !== 'object') throw new PaymentError('INVALID_INPUT');
    const operation = input.operation;
    if (operation !== undefined && operation !== 'activation' && operation !== 'renewal') {
      throw new PaymentError('INVALID_INPUT');
    }
    const normalized: CreateServicePlanPaymentInput = {
      planVersionId: normalizeText(input.planVersionId),
      clientRequestId: normalizeText(input.clientRequestId),
      ...(operation === undefined ? {} : { operation }),
      ...(input.renewalOfSubscriptionId === undefined
        ? {}
        : { renewalOfSubscriptionId: normalizeText(input.renewalOfSubscriptionId) }),
    };
    return normalized;
  }

  private publicWalletOrder(order: PaymentOrderEntity, checkoutOverride?: PaymentCheckoutView): PaymentOrderRecord {
    const {
      checkoutKind,
      checkoutUrl,
      checkoutText,
      checkoutExpiresAt,
      providerSubmissionState,
      providerSubmissionLeaseToken,
      providerSubmissionLeaseExpiresAt,
      ...publicFields
    } = order;
    void providerSubmissionLeaseToken;
    void providerSubmissionLeaseExpiresAt;
    return {
      ...publicFields,
      checkout:
        checkoutOverride ??
        checkoutViewFromStored(
          { checkoutKind, checkoutUrl, checkoutText, checkoutExpiresAt },
          order.providerKey,
          order.status,
          providerSubmissionState,
          this.checkoutPolicy,
          this.currentDate(),
        ),
    };
  }

  private mapServicePlanPaymentOrder(
    order: ServicePlanOrderRecord,
    row: ServicePlanPaymentRow,
  ): ServicePlanPaymentOrderRecord {
    const normalized = mapServicePlanPaymentRow(row);
    const providerKey = normalized.provider_key;
    const merchantId = normalized.merchant_id;
    if (providerKey === null || merchantId === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    if (
      normalized.id !== order.id ||
      normalized.tenant_id !== order.tenantId ||
      normalized.project_id !== order.projectId ||
      normalized.plan_version_id !== order.planVersionId ||
      normalized.state !== order.state ||
      normalized.snapshot_price_minor_units !== order.snapshot.priceMinorUnits ||
      normalized.snapshot_currency !== order.snapshot.currency
    ) {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
    return {
      ...order,
      orderType: 'byok_service_plan',
      providerKey: normalizeText(providerKey, 'PAYMENT_STORAGE_ERROR'),
      merchantId: normalizeText(merchantId, 'PAYMENT_STORAGE_ERROR'),
      providerOrderId:
        normalized.provider_order_id === null
          ? null
          : normalizeText(normalized.provider_order_id, 'PAYMENT_STORAGE_ERROR'),
      providerAttempts: normalized.provider_attempts,
      providerFailureCode:
        normalized.provider_failure_code === null
          ? null
          : normalizeText(normalized.provider_failure_code, 'PAYMENT_STORAGE_ERROR'),
      checkout: checkoutViewFromStored(
        {
          checkoutKind: normalized.checkout_kind,
          checkoutUrl: normalized.checkout_url,
          checkoutText: normalized.checkout_text,
          checkoutExpiresAt: normalized.checkout_expires_at,
        },
        normalizeText(providerKey, 'PAYMENT_STORAGE_ERROR'),
        normalized.state,
        normalized.providerSubmissionState,
        this.checkoutPolicy,
        this.currentDate(),
      ),
    };
  }

  private async findServicePlanPaymentById(
    executor: SqlExecutor,
    tenantId: string,
    projectId: string,
    orderId: string,
    forUpdate = false,
  ): Promise<MappedServicePlanPaymentRow | null> {
    try {
      const result = await executor.query<ServicePlanPaymentRow>(
        `SELECT ${SERVICE_PLAN_PAYMENT_COLUMNS}
         FROM saas_service_plan_orders o
         JOIN saas_service_plan_snapshots snap
           ON snap.tenant_id = o.tenant_id AND snap.order_id = o.id
         WHERE o.tenant_id = $1 AND o.project_id = $2 AND o.id = $3
         LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [tenantId, projectId, orderId],
      );
      return result.rows[0] ? mapServicePlanPaymentRow(result.rows[0]) : null;
    } catch (error) {
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async findServicePlanPaymentByProvider(
    executor: SqlExecutor,
    providerKey: string,
    merchantId: string,
    providerOrderId: string,
    forUpdate = false,
  ): Promise<MappedServicePlanPaymentRow | null> {
    try {
      const result = await executor.query<ServicePlanPaymentRow>(
        `SELECT ${SERVICE_PLAN_PAYMENT_COLUMNS}
         FROM saas_service_plan_orders o
         JOIN saas_service_plan_snapshots snap
           ON snap.tenant_id = o.tenant_id AND snap.order_id = o.id
         WHERE o.provider_key = $1 AND o.merchant_id = $2 AND o.provider_order_id = $3
         ORDER BY o.tenant_id, o.id
         LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
        [providerKey, merchantId, providerOrderId],
      );
      return result.rows[0] ? mapServicePlanPaymentRow(result.rows[0]) : null;
    } catch (error) {
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async submitServicePlanProviderOrder(
    order: ServicePlanOrderRecord,
    forceRetry: boolean,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const claim = await this.runTransaction((executor) =>
      this.claimServicePlanProviderAttempt(executor, order, forceRetry),
    );
    if (!claim.claimed) return this.mapServicePlanPaymentOrder(order, claim.order);

    const merchantId = claim.order.merchant_id;
    if (claim.order.provider_key !== this.providerKey || merchantId === null || merchantId !== this.merchantId) {
      return this.recordServicePlanProviderUnknown(order, claim.order, claim.leaseToken);
    }

    let providerResult: Awaited<ReturnType<PaymentProviderAdapter['createOrder']>>;
    try {
      providerResult = await this.provider.createOrder({
        localOrderId: claim.order.id,
        tenantId: claim.order.tenant_id,
        amountMinorUnits: claim.order.snapshot_price_minor_units.toString(),
        currency: claim.order.snapshot_currency,
        merchantId,
        idempotencyReference: claim.order.id,
      });
    } catch (error) {
      const disposition = providerSubmissionDisposition(error);
      if (disposition === 'safe_rejection') {
        const failureCode =
          claim.order.provider_attempts >= this.maxProviderAttempts
            ? RETRY_LIMIT_FAILURE_CODE
            : SAFE_RETRY_FAILURE_CODE;
        return this.recordServicePlanProviderFailure(order, claim.order, claim.leaseToken, failureCode);
      }
      if (disposition === 'definitive_rejection') {
        return this.recordServicePlanProviderFailure(order, claim.order, claim.leaseToken, NON_RETRYABLE_FAILURE_CODE);
      }
      return this.recoverOrFenceServicePlanSubmission(order, claim.order, claim.leaseToken);
    }

    let providerOrderId: string;
    let providerAmount: bigint;
    let providerCurrency: string;
    let checkoutAction: PaymentCheckoutAction | null;
    try {
      providerOrderId = normalizeText(providerResult.providerOrderId);
      providerAmount = parseMinorUnits(providerResult.amountMinorUnits);
      providerCurrency = normalizeCurrency(providerResult.currency);
      if (
        providerAmount !== parseStoredMinorUnits(claim.order.snapshot_price_minor_units) ||
        providerCurrency !== claim.order.snapshot_currency
      ) {
        throw new PaymentError('PROVIDER_RESULT_INVALID');
      }
      checkoutAction = normalizeProviderCheckoutAction(
        providerCheckoutAction(providerResult),
        this.providerKey,
        this.checkoutPolicy,
      );
    } catch {
      return this.recordServicePlanProviderUnknown(order, claim.order, claim.leaseToken);
    }

    const updated = await this.runTransaction((executor) =>
      this.recordServicePlanProviderSuccess(executor, claim.order, claim.leaseToken, providerOrderId, checkoutAction),
    );
    return this.mapServicePlanPaymentOrder(order, updated);
  }

  private async claimServicePlanProviderAttempt(
    executor: SqlExecutor,
    order: ServicePlanOrderRecord,
    _forceRetry: boolean,
  ): Promise<ServicePlanProviderAttemptClaim> {
    const current = await this.findServicePlanPaymentById(executor, order.tenantId, order.projectId, order.id, true);
    if (!current) throw new PaymentError('ORDER_NOT_FOUND');
    if (
      (current.provider_key !== null && current.provider_key !== this.providerKey) ||
      (current.merchant_id !== null && current.merchant_id !== this.merchantId)
    ) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.state !== 'pending' || current.provider_order_id !== null) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerSubmissionState === 'unknown') {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerSubmissionState === 'submitting') {
      if (
        current.providerSubmissionLeaseExpiresAt !== null &&
        new Date(current.providerSubmissionLeaseExpiresAt).getTime() > this.currentDate().getTime()
      ) {
        return { claimed: false, order: current, leaseToken: null };
      }
      await this.markServicePlanSubmissionUnknown(executor, current);
      const fenced = await this.findServicePlanPaymentById(executor, order.tenantId, order.projectId, order.id, true);
      if (!fenced) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return { claimed: false, order: fenced, leaseToken: null };
    }
    if (current.provider_attempts > 0 && current.provider_failure_code === null) {
      await this.markServicePlanSubmissionUnknown(executor, current);
      const fenced = await this.findServicePlanPaymentById(executor, order.tenantId, order.projectId, order.id, true);
      if (!fenced) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return { claimed: false, order: fenced, leaseToken: null };
    }
    if (current.provider_failure_code !== null && current.provider_failure_code !== SAFE_RETRY_FAILURE_CODE) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.provider_attempts >= this.maxProviderAttempts) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerSubmissionState === 'failed' && !this.retryCooldownElapsed(current.updated_at)) {
      return { claimed: false, order: current, leaseToken: null };
    }

    try {
      const leaseToken = normalizeText(this.idFactory());
      const leaseExpiresAt = new Date(this.currentDate().getTime() + this.submissionLeaseTtlMs).toISOString();
      const result = await executor.query<{ id: string }>(
        `UPDATE saas_service_plan_orders
         SET provider_key = COALESCE(provider_key, $3),
             merchant_id = COALESCE(merchant_id, $4),
             provider_attempts = provider_attempts + 1,
             provider_failure_code = NULL,
             provider_submission_state = 'submitting',
             provider_submission_lease_token = $7,
             provider_submission_lease_expires_at = $8,
             updated_at = $5
         WHERE tenant_id = $1 AND project_id = $2 AND id = $6
           AND state = 'pending' AND provider_order_id IS NULL
           AND provider_submission_state IN ('idle', 'failed')
           AND (provider_key IS NULL OR provider_key = $3)
           AND (merchant_id IS NULL OR merchant_id = $4)
         RETURNING id`,
        [
          order.tenantId,
          order.projectId,
          this.providerKey,
          this.merchantId,
          this.currentDate().toISOString(),
          order.id,
          leaseToken,
          leaseExpiresAt,
        ],
      );
      if (!rowsHaveOne(result)) {
        const reread = await this.findServicePlanPaymentById(executor, order.tenantId, order.projectId, order.id, true);
        if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
        return { claimed: false, order: reread, leaseToken: null };
      }
      const updated = await this.findServicePlanPaymentById(executor, order.tenantId, order.projectId, order.id, true);
      if (!updated) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return { claimed: true, order: updated, leaseToken };
    } catch (error) {
      if (isPaymentError(error)) throw error;
      if (isUniqueViolation(error)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async recordServicePlanProviderFailure(
    order: ServicePlanOrderRecord,
    current: MappedServicePlanPaymentRow,
    leaseToken: string | null,
    failureCode: typeof SAFE_RETRY_FAILURE_CODE | typeof NON_RETRYABLE_FAILURE_CODE | typeof RETRY_LIMIT_FAILURE_CODE,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const updated = await this.runTransaction(async (executor) => {
      const result = await executor.query<{ id: string }>(
        `UPDATE saas_service_plan_orders
         SET provider_failure_code = $3,
             provider_submission_state = 'failed',
             provider_submission_lease_token = NULL,
             provider_submission_lease_expires_at = NULL,
             updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $5
           AND state = 'pending' AND provider_order_id IS NULL
           AND provider_submission_state = 'submitting'
           AND provider_submission_lease_token = $6
         RETURNING id`,
        [current.tenant_id, current.project_id, failureCode, this.currentDate().toISOString(), current.id, leaseToken],
      );
      if (!rowsHaveOne(result)) {
        const reread = await this.findServicePlanPaymentById(
          executor,
          current.tenant_id,
          current.project_id,
          current.id,
        );
        if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
        return reread;
      }
      const reread = await this.findServicePlanPaymentById(executor, current.tenant_id, current.project_id, current.id);
      if (!reread) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return reread;
    });
    return this.mapServicePlanPaymentOrder(order, updated);
  }

  private async recordServicePlanProviderUnknown(
    order: ServicePlanOrderRecord,
    current: MappedServicePlanPaymentRow,
    leaseToken: string | null,
  ): Promise<ServicePlanPaymentOrderRecord> {
    const updated = await this.runTransaction(async (executor) => {
      await this.markServicePlanSubmissionUnknown(executor, current, leaseToken);
      const reread = await this.findServicePlanPaymentById(executor, current.tenant_id, current.project_id, current.id);
      if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
      return reread;
    });
    return this.mapServicePlanPaymentOrder(order, updated);
  }

  private async recoverOrFenceServicePlanSubmission(
    order: ServicePlanOrderRecord,
    current: MappedServicePlanPaymentRow,
    leaseToken: string | null,
  ): Promise<ServicePlanPaymentOrderRecord> {
    if (current.provider_key !== this.providerKey || current.merchant_id !== this.merchantId) {
      return this.recordServicePlanProviderUnknown(order, current, leaseToken);
    }
    if (!this.provider.recoverOrder || leaseToken === null) {
      return this.recordServicePlanProviderUnknown(order, current, leaseToken);
    }
    let recovered: Awaited<ReturnType<NonNullable<PaymentProviderAdapter['recoverOrder']>>>;
    try {
      recovered = await this.provider.recoverOrder({
        localOrderId: current.id,
        tenantId: current.tenant_id,
        amountMinorUnits: current.snapshot_price_minor_units.toString(),
        currency: current.snapshot_currency,
        merchantId: current.merchant_id,
        idempotencyReference: current.id,
      });
    } catch {
      return this.recordServicePlanProviderUnknown(order, current, leaseToken);
    }
    if (!recovered) return this.recordServicePlanProviderUnknown(order, current, leaseToken);
    let providerOrderId: string;
    let checkoutAction: PaymentCheckoutAction | null;
    try {
      providerOrderId = normalizeText(recovered.providerOrderId);
      if (
        parseMinorUnits(recovered.amountMinorUnits) !== parseStoredMinorUnits(current.snapshot_price_minor_units) ||
        normalizeCurrency(recovered.currency) !== current.snapshot_currency
      ) {
        throw new PaymentError('PROVIDER_RESULT_INVALID');
      }
      checkoutAction = normalizeProviderCheckoutAction(
        providerCheckoutAction(recovered),
        this.providerKey,
        this.checkoutPolicy,
      );
    } catch {
      return this.recordServicePlanProviderUnknown(order, current, leaseToken);
    }
    const updated = await this.runTransaction((executor) =>
      this.recordServicePlanProviderSuccess(executor, current, leaseToken, providerOrderId, checkoutAction),
    );
    return this.mapServicePlanPaymentOrder(order, updated);
  }

  private async recordServicePlanProviderSuccess(
    executor: SqlExecutor,
    current: MappedServicePlanPaymentRow,
    leaseToken: string | null,
    providerOrderId: string,
    checkoutAction: PaymentCheckoutAction | null,
  ): Promise<MappedServicePlanPaymentRow> {
    const columns = checkoutActionColumns(checkoutAction);
    try {
      const result = await executor.query<{ id: string }>(
        `UPDATE saas_service_plan_orders
         SET provider_order_id = $3, provider_failure_code = NULL,
             checkout_kind = $6, checkout_url = $7, checkout_text = $8, checkout_expires_at = $9,
             provider_submission_state = 'idle',
             provider_submission_lease_token = NULL,
             provider_submission_lease_expires_at = NULL,
             updated_at = $4
         WHERE tenant_id = $1 AND project_id = $2 AND id = $5
           AND state = 'pending' AND provider_order_id IS NULL
           AND provider_submission_state = 'submitting'
           AND provider_submission_lease_token = $10
         RETURNING id`,
        [
          current.tenant_id,
          current.project_id,
          providerOrderId,
          this.currentDate().toISOString(),
          current.id,
          columns.kind,
          columns.url,
          columns.text,
          columns.expiresAt,
          leaseToken,
        ],
      );
      if (!rowsHaveOne(result)) {
        const reread = await this.findServicePlanPaymentById(
          executor,
          current.tenant_id,
          current.project_id,
          current.id,
          true,
        );
        if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
        if (reread.provider_order_id === providerOrderId && reread.state === 'pending') return reread;
        throw new PaymentError('PAYMENT_STORAGE_ERROR');
      }
      const updated = await this.findServicePlanPaymentById(
        executor,
        current.tenant_id,
        current.project_id,
        current.id,
        true,
      );
      if (!updated) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return updated;
    } catch (error) {
      if (isPaymentError(error)) throw error;
      if (isUniqueViolation(error)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private providerSnapshotMatches(order: PaymentOrderEntity): boolean {
    return order.providerKey === this.providerKey && order.merchantId === this.merchantId;
  }

  private assertProviderSnapshot(order: PaymentOrderEntity): void {
    this.assertProviderSnapshotValues(order.providerKey, order.merchantId);
  }

  private assertProviderSnapshotValues(providerKey: string | null, merchantId: string | null): void {
    if (providerKey !== this.providerKey || merchantId !== this.merchantId) {
      throw new PaymentError('ORDER_STATE_CONFLICT');
    }
  }

  private retryCooldownElapsed(updatedAt: string | Date): boolean {
    const updatedAtMs = new Date(updatedAt).getTime();
    return Number.isFinite(updatedAtMs) && this.currentDate().getTime() - updatedAtMs >= this.retryCooldownMs;
  }

  private currentDate(): Date {
    const value = this.now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return date;
  }

  private normalizeCreateInput(input: CreateWalletTopUpInput): {
    readonly tenantId: string;
    readonly clientRequestId: string;
    readonly amountMinorUnits: bigint;
    readonly currency: string;
  } {
    return {
      tenantId: normalizeText(input?.tenantId),
      clientRequestId: normalizeText(input?.clientRequestId),
      amountMinorUnits: parseMinorUnits(input?.amountMinorUnits),
      currency: normalizeCurrency(input?.currency),
    };
  }

  private normalizeEvent(input: NormalizedPaymentProviderEvent): NormalizedEvent {
    if (!input || typeof input !== 'object') throw new PaymentError('WEBHOOK_INVALID');
    const merchantId = normalizeText(input.merchantId);
    if (merchantId !== this.merchantId) throw new PaymentError('WEBHOOK_REJECTED');
    if (
      input.status !== 'pending' &&
      input.status !== 'succeeded' &&
      input.status !== 'failed' &&
      input.status !== 'cancelled'
    ) {
      throw new PaymentError('WEBHOOK_INVALID');
    }
    return {
      providerKey: this.providerKey,
      providerEventId: normalizeText(input.providerEventId),
      eventType: normalizeText(input.eventType),
      providerOrderId: normalizeText(input.providerOrderId),
      tenantId: normalizeText(input.tenantId),
      merchantId,
      status: input.status,
      amountMinorUnits: parseMinorUnits(input.amountMinorUnits),
      currency: normalizeCurrency(input.currency),
      occurredAt: normalizeTimestamp(input.occurredAt),
    };
  }

  private assertCreateReplay(
    order: PaymentOrderEntity,
    input: {
      readonly tenantId: string;
      readonly clientRequestId: string;
      readonly amountMinorUnits: bigint;
      readonly currency: string;
    },
  ): void {
    if (
      order.tenantId !== input.tenantId ||
      order.clientRequestId !== input.clientRequestId ||
      order.providerKey !== this.providerKey ||
      order.merchantId !== this.merchantId ||
      order.currency !== input.currency ||
      BigInt(order.amountMinorUnits) !== input.amountMinorUnits
    ) {
      throw new PaymentError('IDEMPOTENCY_CONFLICT');
    }
  }

  private async findOrderByClientRequest(
    tenantId: string,
    clientRequestId: string,
  ): Promise<PaymentOrderEntity | null> {
    try {
      const result = await this.database.query<PaymentOrderRow>(
        `SELECT ${ORDER_COLUMNS}
         FROM saas_payment_orders
         WHERE tenant_id = $1 AND client_request_id = $2`,
        [tenantId, clientRequestId],
      );
      return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
    } catch (error) {
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async findWalletOrderById(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
    forUpdate = false,
  ): Promise<PaymentOrderEntity | null> {
    try {
      const result = await executor.query<PaymentOrderRow>(
        `SELECT ${ORDER_COLUMNS}
         FROM saas_payment_orders
         WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
        [tenantId, orderId],
      );
      return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
    } catch (error) {
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async insertOrder(
    executor: SqlExecutor,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly clientRequestId: string;
      readonly amountMinorUnits: bigint;
      readonly currency: string;
      readonly createdAt: string;
    },
  ): Promise<PaymentOrderEntity | null> {
    try {
      const result = await executor.query<PaymentOrderRow>(
        `INSERT INTO saas_payment_orders
          (id, tenant_id, order_type, provider_key, merchant_id, client_request_id,
           local_order_ref, funding_reference, amount_minor_units, currency, state,
           provider_attempts, created_at, updated_at)
         VALUES ($1, $2, 'wallet_topup', $3, $4, $5, $1, $1, $6, $7, 'created', 0, $8, $8)
         ON CONFLICT (tenant_id, client_request_id) DO NOTHING
         RETURNING ${ORDER_COLUMNS}`,
        [
          input.id,
          input.tenantId,
          this.providerKey,
          this.merchantId,
          input.clientRequestId,
          input.amountMinorUnits.toString(),
          input.currency,
          input.createdAt,
        ],
      );
      return rowsHaveOne(result) && result.rows[0] ? mapOrderRow(result.rows[0]) : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async submitProviderOrder(order: PaymentOrderEntity, forceRetry: boolean): Promise<PaymentOrderRecord> {
    const claim = await this.runTransaction((executor) => this.claimProviderAttempt(executor, order, forceRetry));
    if (!claim.claimed) return this.publicWalletOrder(claim.order);

    if (!this.providerSnapshotMatches(claim.order)) {
      return this.recordProviderUnknown(claim.order, claim.leaseToken);
    }

    let providerResult: Awaited<ReturnType<PaymentProviderAdapter['createOrder']>>;
    try {
      providerResult = await this.provider.createOrder({
        localOrderId: claim.order.id,
        tenantId: claim.order.tenantId,
        amountMinorUnits: claim.order.amountMinorUnits,
        currency: claim.order.currency,
        merchantId: claim.order.merchantId,
        idempotencyReference: claim.order.id,
      });
    } catch (error) {
      const disposition = providerSubmissionDisposition(error);
      if (disposition === 'safe_rejection') {
        const failureCode =
          claim.order.providerAttempts >= this.maxProviderAttempts ? RETRY_LIMIT_FAILURE_CODE : SAFE_RETRY_FAILURE_CODE;
        return this.recordProviderFailure(claim.order, claim.leaseToken, failureCode);
      }
      if (disposition === 'definitive_rejection') {
        return this.recordProviderFailure(claim.order, claim.leaseToken, NON_RETRYABLE_FAILURE_CODE);
      }
      return this.recoverOrFenceProviderSubmission(claim.order, claim.leaseToken);
    }

    let providerOrderId: string;
    let providerAmount: bigint;
    let providerCurrency: string;
    let checkoutAction: PaymentCheckoutAction | null;
    try {
      providerOrderId = normalizeText(providerResult.providerOrderId);
      providerAmount = parseMinorUnits(providerResult.amountMinorUnits);
      providerCurrency = normalizeCurrency(providerResult.currency);
      if (providerAmount !== BigInt(claim.order.amountMinorUnits) || providerCurrency !== claim.order.currency) {
        throw new PaymentError('PROVIDER_RESULT_INVALID');
      }
      checkoutAction = normalizeProviderCheckoutAction(
        providerCheckoutAction(providerResult),
        this.providerKey,
        this.checkoutPolicy,
      );
    } catch {
      return this.recordProviderUnknown(claim.order, claim.leaseToken);
    }

    const updated = await this.runTransaction((executor) =>
      this.recordProviderSuccess(executor, claim.order, claim.leaseToken, providerOrderId, checkoutAction),
    );
    return this.publicWalletOrder(updated);
  }

  private async claimProviderAttempt(
    executor: SqlExecutor,
    order: PaymentOrderEntity,
    _forceRetry: boolean,
  ): Promise<ProviderAttemptClaim> {
    const current = await this.lockOrder(executor, order.tenantId, order.id);
    if (!current) throw new PaymentError('ORDER_NOT_FOUND');
    if (!this.providerSnapshotMatches(current)) throw new PaymentError('ORDER_STATE_CONFLICT');
    if (!['created', 'provider_failed'].includes(current.status)) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerOrderId !== null) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerSubmissionState === 'unknown') {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerSubmissionState === 'submitting') {
      if (
        current.providerSubmissionLeaseExpiresAt !== null &&
        new Date(current.providerSubmissionLeaseExpiresAt).getTime() > this.currentDate().getTime()
      ) {
        return { claimed: false, order: current, leaseToken: null };
      }
      await this.markProviderSubmissionUnknown(executor, current);
      const fenced = await this.lockOrder(executor, current.tenantId, current.id);
      if (!fenced) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return { claimed: false, order: fenced, leaseToken: null };
    }
    if (current.providerAttempts > 0 && current.providerFailureCode === null) {
      await this.markProviderSubmissionUnknown(executor, current);
      const fenced = await this.lockOrder(executor, current.tenantId, current.id);
      if (!fenced) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return { claimed: false, order: fenced, leaseToken: null };
    }
    if (current.providerFailureCode !== null && current.providerFailureCode !== SAFE_RETRY_FAILURE_CODE) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerAttempts >= this.maxProviderAttempts) {
      return { claimed: false, order: current, leaseToken: null };
    }
    if (current.providerSubmissionState === 'failed' && !this.retryCooldownElapsed(current.updatedAt)) {
      return { claimed: false, order: current, leaseToken: null };
    }

    const leaseToken = normalizeText(this.idFactory());
    const leaseExpiresAt = new Date(this.currentDate().getTime() + this.submissionLeaseTtlMs).toISOString();
    const result = await executor.query<PaymentOrderRow>(
      `UPDATE saas_payment_orders
       SET state = 'created', provider_attempts = provider_attempts + 1,
           provider_failure_code = NULL,
           provider_submission_state = 'submitting',
           provider_submission_lease_token = $4,
           provider_submission_lease_expires_at = $5,
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2 AND state IN ('created', 'provider_failed')
         AND provider_submission_state IN ('idle', 'failed')
       RETURNING ${ORDER_COLUMNS}`,
      [current.tenantId, current.id, this.currentDate().toISOString(), leaseToken, leaseExpiresAt],
    );
    if (!rowsHaveOne(result) || !result.rows[0]) {
      const reread = await this.lockOrder(executor, current.tenantId, current.id);
      if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
      return { claimed: false, order: reread, leaseToken: null };
    }
    const claimed = mapOrderRow(result.rows[0]);
    return {
      claimed: true,
      order: claimed,
      leaseToken,
    };
  }

  private async recordProviderFailure(
    order: PaymentOrderEntity,
    leaseToken: string | null,
    failureCode: typeof SAFE_RETRY_FAILURE_CODE | typeof NON_RETRYABLE_FAILURE_CODE | typeof RETRY_LIMIT_FAILURE_CODE,
  ): Promise<PaymentOrderRecord> {
    return this.runTransaction(async (executor) => {
      const result = await executor.query<PaymentOrderRow>(
        `UPDATE saas_payment_orders
         SET state = 'provider_failed', provider_failure_code = $3,
             provider_submission_state = 'failed',
             provider_submission_lease_token = NULL,
             provider_submission_lease_expires_at = NULL,
             updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND state = 'created'
           AND provider_submission_state = 'submitting'
           AND provider_submission_lease_token = $5
         RETURNING ${ORDER_COLUMNS}`,
        [order.tenantId, order.id, failureCode, this.currentDate().toISOString(), leaseToken],
      );
      if (rowsHaveOne(result) && result.rows[0]) return this.publicWalletOrder(mapOrderRow(result.rows[0]));
      const current = await this.lockOrder(executor, order.tenantId, order.id);
      if (!current) throw new PaymentError('ORDER_NOT_FOUND');
      return this.publicWalletOrder(current);
    });
  }

  private async recordProviderUnknown(
    order: PaymentOrderEntity,
    leaseToken: string | null,
  ): Promise<PaymentOrderRecord> {
    const current = await this.runTransaction(async (executor) => {
      await this.markProviderSubmissionUnknown(executor, order, leaseToken);
      const reread = await this.lockOrder(executor, order.tenantId, order.id);
      if (!reread) throw new PaymentError('ORDER_NOT_FOUND');
      return reread;
    });
    return this.publicWalletOrder(current);
  }

  private async recoverOrFenceProviderSubmission(
    order: PaymentOrderEntity,
    leaseToken: string | null,
  ): Promise<PaymentOrderRecord> {
    if (!this.provider.recoverOrder || leaseToken === null) return this.recordProviderUnknown(order, leaseToken);
    let recovered: Awaited<ReturnType<NonNullable<PaymentProviderAdapter['recoverOrder']>>>;
    try {
      recovered = await this.provider.recoverOrder({
        localOrderId: order.id,
        tenantId: order.tenantId,
        amountMinorUnits: order.amountMinorUnits,
        currency: order.currency,
        merchantId: order.merchantId,
        idempotencyReference: order.id,
      });
    } catch {
      return this.recordProviderUnknown(order, leaseToken);
    }
    if (!recovered) return this.recordProviderUnknown(order, leaseToken);
    let providerOrderId: string;
    let checkoutAction: PaymentCheckoutAction | null;
    try {
      providerOrderId = normalizeText(recovered.providerOrderId);
      if (
        parseMinorUnits(recovered.amountMinorUnits) !== BigInt(order.amountMinorUnits) ||
        normalizeCurrency(recovered.currency) !== order.currency
      ) {
        throw new PaymentError('PROVIDER_RESULT_INVALID');
      }
      checkoutAction = normalizeProviderCheckoutAction(
        providerCheckoutAction(recovered),
        this.providerKey,
        this.checkoutPolicy,
      );
    } catch {
      return this.recordProviderUnknown(order, leaseToken);
    }
    const updated = await this.runTransaction((executor) =>
      this.recordProviderSuccess(executor, order, leaseToken, providerOrderId, checkoutAction),
    );
    return this.publicWalletOrder(updated);
  }

  private async recordProviderSuccess(
    executor: SqlExecutor,
    order: PaymentOrderEntity,
    leaseToken: string | null,
    providerOrderId: string,
    checkoutAction: PaymentCheckoutAction | null,
  ): Promise<PaymentOrderEntity> {
    const columns = checkoutActionColumns(checkoutAction);
    try {
      const result = await executor.query<PaymentOrderRow>(
        `UPDATE saas_payment_orders
         SET state = 'pending', provider_order_id = $3, provider_failure_code = NULL,
             checkout_kind = $6, checkout_url = $7, checkout_text = $8, checkout_expires_at = $9,
             provider_submission_state = 'idle',
             provider_submission_lease_token = NULL,
             provider_submission_lease_expires_at = NULL,
             updated_at = $4
         WHERE tenant_id = $1 AND id = $2 AND state = 'created'
           AND provider_submission_state = 'submitting'
           AND provider_submission_lease_token = $10
         RETURNING ${ORDER_COLUMNS}`,
        [
          order.tenantId,
          order.id,
          providerOrderId,
          this.currentDate().toISOString(),
          order.id,
          columns.kind,
          columns.url,
          columns.text,
          columns.expiresAt,
          leaseToken,
        ],
      );
      if (rowsHaveOne(result) && result.rows[0]) return mapOrderRow(result.rows[0]);
      const current = await this.lockOrder(executor, order.tenantId, order.id);
      if (!current) throw new PaymentError('ORDER_NOT_FOUND');
      if (current.providerOrderId === providerOrderId && current.status === 'pending') return current;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    } catch (error) {
      if (isPaymentError(error)) throw error;
      if (isUniqueViolation(error)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async markProviderSubmissionUnknown(
    executor: SqlExecutor,
    current: PaymentOrderEntity,
    leaseToken: string | null = current.providerSubmissionLeaseToken,
  ): Promise<void> {
    const result = await executor.query<{ id: string }>(
      `UPDATE saas_payment_orders
       SET state = 'reconciliation_pending',
           provider_failure_code = 'PROVIDER_ACCEPTANCE_UNKNOWN',
           provider_submission_state = 'unknown',
           provider_submission_lease_token = NULL,
           provider_submission_lease_expires_at = NULL,
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2
         AND state = 'created'
         AND (
           (provider_submission_state = 'submitting' AND provider_submission_lease_token = $4)
           OR (provider_submission_state = 'idle' AND provider_submission_lease_token IS NULL)
         )
       RETURNING id`,
      [current.tenantId, current.id, this.currentDate().toISOString(), leaseToken],
    );
    if (rowsHaveOne(result)) return;
    const reread = await this.lockOrder(executor, current.tenantId, current.id);
    if (!reread || !['reconciliation_pending', 'provider_failed', 'pending'].includes(reread.status)) {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async markServicePlanSubmissionUnknown(
    executor: SqlExecutor,
    current: MappedServicePlanPaymentRow,
    leaseToken: string | null = current.providerSubmissionLeaseToken,
  ): Promise<void> {
    const result = await executor.query<{ id: string }>(
      `UPDATE saas_service_plan_orders
       SET state = 'reconciliation_pending',
           provider_failure_code = 'PROVIDER_ACCEPTANCE_UNKNOWN',
           provider_submission_state = 'unknown',
           provider_submission_lease_token = NULL,
           provider_submission_lease_expires_at = NULL,
           updated_at = $4
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3
         AND state = 'pending'
         AND (
           (provider_submission_state = 'submitting' AND provider_submission_lease_token = $5)
           OR (provider_submission_state = 'idle' AND provider_submission_lease_token IS NULL)
         )
       RETURNING id`,
      [current.tenant_id, current.project_id, current.id, this.currentDate().toISOString(), leaseToken],
    );
    if (rowsHaveOne(result)) return;
    const reread = await this.findServicePlanPaymentById(
      executor,
      current.tenant_id,
      current.project_id,
      current.id,
      true,
    );
    if (!reread || !['reconciliation_pending', 'pending', 'fulfilled', 'cancelled'].includes(reread.state)) {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async lockOrder(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
  ): Promise<PaymentOrderEntity | null> {
    const result = await executor.query<PaymentOrderRow>(
      `SELECT ${ORDER_COLUMNS}
       FROM saas_payment_orders
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId, orderId],
    );
    return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  private async findOrderByProvider(
    executor: SqlExecutor,
    providerKey: string,
    merchantId: string,
    providerOrderId: string,
  ): Promise<PaymentOrderEntity | null> {
    const result = await executor.query<PaymentOrderRow>(
      `SELECT ${ORDER_COLUMNS}
       FROM saas_payment_orders
       WHERE provider_key = $1 AND merchant_id = $2 AND provider_order_id = $3
       ORDER BY tenant_id
       LIMIT 1
       FOR UPDATE`,
      [providerKey, merchantId, providerOrderId],
    );
    return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  private async enqueueWebhook(executor: SqlExecutor, event: NormalizedEvent): Promise<PaymentWebhookResult> {
    const existing = await this.findInbox(executor, event, true);
    if (existing) {
      this.assertInboxReplay(existing, event);
      const mapped = mapInboxRow(existing);
      return {
        outcome: mapped.outcome,
        replayed: true,
        inboxId: existing.id,
        orderId: mapped.orderId,
        fundingTransactionId: mapped.fundingTransactionId,
      };
    }

    const order = await this.findOrderByProvider(executor, event.providerKey, event.merchantId, event.providerOrderId);
    const servicePlanOrder = order
      ? null
      : await this.findServicePlanPaymentByProvider(
          executor,
          event.providerKey,
          event.merchantId,
          event.providerOrderId,
          true,
        );
    const inboxId = normalizeText(this.idFactory());
    const inserted = await this.insertInbox(executor, inboxId, event, order ?? servicePlanOrder);
    if (!inserted) {
      const raced = await this.findInbox(executor, event, true);
      if (!raced) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      this.assertInboxReplay(raced, event);
      const mapped = mapInboxRow(raced);
      return {
        outcome: mapped.outcome,
        replayed: true,
        inboxId: raced.id,
        orderId: mapped.orderId,
        fundingTransactionId: mapped.fundingTransactionId,
      };
    }
    const mappedInserted = mapInboxRow(inserted);
    return {
      outcome: 'accepted',
      replayed: false,
      inboxId: inserted.id,
      orderId: mappedInserted.orderId,
      fundingTransactionId: mappedInserted.fundingTransactionId,
    };
  }

  private async processClaimedWebhook(inbox: PaymentInboxRow): Promise<ProcessedWebhook | null> {
    const leaseToken = inbox.lease_token;
    if (leaseToken === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return this.runTransaction(async (executor) => {
      const claimed = await this.findInboxById(executor, inbox.id, true);
      if (claimed?.processing_state !== 'processing' || claimed.lease_token !== leaseToken) {
        return null;
      }
      const event = this.eventFromInbox(claimed);
      const order = await this.findOrderByProvider(
        executor,
        event.providerKey,
        event.merchantId,
        event.providerOrderId,
      );
      const servicePlanOrder = order
        ? null
        : await this.findServicePlanPaymentByProvider(
            executor,
            event.providerKey,
            event.merchantId,
            event.providerOrderId,
            true,
          );
      if (servicePlanOrder) return this.processServicePlanWebhook(executor, claimed, servicePlanOrder, event);
      if (!order) {
        const receivedAt = new Date(storedTimestamp(claimed.received_at)).getTime();
        if (this.currentDate().getTime() - receivedAt < WEBHOOK_UNKNOWN_ORDER_GRACE_MS) {
          throw new PaymentError('FULFILLMENT_RETRYABLE');
        }
        return this.finishInbox(executor, claimed, 'reconciliation', 'ORDER_NOT_FOUND');
      }
      if (
        order.providerKey !== event.providerKey ||
        order.merchantId !== event.merchantId ||
        order.tenantId !== event.tenantId ||
        order.currency !== event.currency ||
        BigInt(order.amountMinorUnits) !== event.amountMinorUnits
      ) {
        return this.finishInbox(executor, claimed, 'reconciliation', 'ORDER_FIELDS_MISMATCH');
      }

      if (event.status === 'succeeded') return this.fulfillFromEvent(executor, claimed, order);
      if (event.status === 'pending') {
        if (order.status === 'created' || order.status === 'provider_failed' || order.status === 'pending') {
          const pending = await this.updateOrderState(executor, order, 'pending', null, null);
          if (!pending) throw new PaymentError('PAYMENT_STORAGE_ERROR');
          return this.finishInbox(executor, claimed, 'accepted', null);
        }
        return this.finishInbox(executor, claimed, 'reconciliation', 'LATE_STATE');
      }

      if (event.status === 'failed' || event.status === 'cancelled') {
        if (order.status === 'created' || order.status === 'provider_failed' || order.status === 'pending') {
          const next = event.status === 'cancelled' ? 'cancelled' : 'provider_failed';
          const updated = await this.updateOrderState(executor, order, next, null, null);
          if (!updated) throw new PaymentError('PAYMENT_STORAGE_ERROR');
          return this.finishInbox(
            executor,
            claimed,
            'rejected',
            event.status === 'cancelled' ? 'PROVIDER_CANCELLED' : 'PROVIDER_FAILED',
          );
        }
        return this.finishInbox(executor, claimed, 'reconciliation', 'LATE_STATE');
      }

      return this.finishInbox(executor, claimed, 'rejected', 'INVALID_EVENT_STATUS');
    });
  }

  private async claimPendingWebhooks(limit: number): Promise<PaymentInboxRow[]> {
    return this.runTransaction(async (executor) => {
      const now = this.currentDate();
      const result = await executor.query<PaymentInboxRow>(
        `SELECT ${INBOX_COLUMNS}
         FROM saas_payment_inbox
         WHERE (processing_state = 'pending' AND next_attempt_at <= $1)
            OR (processing_state = 'processing' AND lease_expires_at <= $1)
         ORDER BY received_at ASC, id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now.toISOString(), limit],
      );
      const claimed: PaymentInboxRow[] = [];
      for (const row of result.rows) {
        const leaseToken = normalizeText(this.idFactory());
        const updated = await executor.query<PaymentInboxRow>(
          `UPDATE saas_payment_inbox
           SET processing_state = 'processing', attempt_count = attempt_count + 1,
               lease_token = $2, lease_expires_at = $3, updated_at = $4, last_error_code = NULL
           WHERE id = $1
           RETURNING ${INBOX_COLUMNS}`,
          [row.id, leaseToken, new Date(now.getTime() + WEBHOOK_WORKER_LEASE_MS).toISOString(), now.toISOString()],
        );
        if (!rowsHaveOne(updated) || !updated.rows[0]) throw new PaymentError('PAYMENT_STORAGE_ERROR');
        claimed.push(updated.rows[0]);
      }
      return claimed;
    });
  }

  private async releaseWebhookClaim(inbox: PaymentInboxRow): Promise<'retrying' | 'exhausted' | 'lost'> {
    if (inbox.lease_token === null) return 'lost';
    return this.runTransaction(async (executor) => {
      const now = this.currentDate();
      const lastErrorCode = 'WORKER_PROCESSING_FAILED';
      if (inbox.attempt_count >= WEBHOOK_WORKER_MAX_ATTEMPTS) {
        const result = await executor.query<{ id: string }>(
          `UPDATE saas_payment_inbox
           SET processing_state = 'processed', processing_outcome = 'reconciliation',
               outcome_code = 'WORKER_RETRIES_EXHAUSTED', last_error_code = $3,
               processed_at = $4, updated_at = $4, lease_token = NULL, lease_expires_at = NULL
           WHERE id = $1 AND processing_state = 'processing' AND lease_token = $2
           RETURNING id`,
          [inbox.id, inbox.lease_token, lastErrorCode, now.toISOString()],
        );
        return rowsHaveOne(result) ? 'exhausted' : 'lost';
      }
      const backoffMs = Math.min(1_000 * 2 ** Math.min(inbox.attempt_count - 1, 8), 300_000);
      const result = await executor.query<{ id: string }>(
        `UPDATE saas_payment_inbox
         SET processing_state = 'pending', next_attempt_at = $3,
             last_error_code = $4, updated_at = $5, lease_token = NULL, lease_expires_at = NULL
         WHERE id = $1 AND processing_state = 'processing' AND lease_token = $2
         RETURNING id`,
        [
          inbox.id,
          inbox.lease_token,
          new Date(now.getTime() + backoffMs).toISOString(),
          lastErrorCode,
          now.toISOString(),
        ],
      );
      return rowsHaveOne(result) ? 'retrying' : 'lost';
    });
  }

  private eventFromInbox(row: PaymentInboxRow): NormalizedEvent {
    return {
      providerKey: normalizeText(row.provider_key, 'PAYMENT_STORAGE_ERROR'),
      providerEventId: normalizeText(row.provider_event_id, 'PAYMENT_STORAGE_ERROR'),
      eventType: normalizeText(row.event_type, 'PAYMENT_STORAGE_ERROR'),
      providerOrderId: normalizeText(row.provider_order_id, 'PAYMENT_STORAGE_ERROR'),
      tenantId: normalizeText(row.event_tenant_id, 'PAYMENT_STORAGE_ERROR'),
      merchantId: normalizeText(row.merchant_id, 'PAYMENT_STORAGE_ERROR'),
      status: mapProviderEventStatus(row.event_status),
      amountMinorUnits: parseStoredMinorUnits(row.amount_minor_units),
      currency: normalizeCurrency(row.currency),
      occurredAt: storedTimestamp(row.occurred_at),
    };
  }

  private async processServicePlanWebhook(
    executor: SqlExecutor,
    inbox: PaymentInboxRow,
    order: MappedServicePlanPaymentRow,
    event: NormalizedEvent,
  ): Promise<ProcessedWebhook> {
    const orderId = order.id;
    if (
      order.provider_key !== event.providerKey ||
      order.merchant_id !== event.merchantId ||
      order.tenant_id !== event.tenantId ||
      normalizeCurrency(order.snapshot_currency) !== event.currency ||
      parseStoredMinorUnits(order.snapshot_price_minor_units) !== event.amountMinorUnits
    ) {
      await this.markServicePlanReconciliation(executor, order);
      return this.finishInbox(executor, inbox, 'reconciliation', 'ORDER_FIELDS_MISMATCH', null, orderId);
    }

    if (event.status === 'succeeded') {
      if (order.state === 'pending') {
        return { kind: 'service_plan_fulfillment', inbox, order, event };
      }
      if (
        order.state === 'fulfilled' &&
        order.verified_settlement_id === event.providerEventId &&
        order.verified_provider_key === event.providerKey &&
        order.verified_merchant_id === event.merchantId &&
        order.verified_amount_minor_units !== null &&
        parseStoredMinorUnits(order.verified_amount_minor_units) === event.amountMinorUnits &&
        order.verified_currency === event.currency
      ) {
        return this.finishInbox(executor, inbox, 'fulfilled', null, null, orderId);
      }
      return this.finishInbox(executor, inbox, 'reconciliation', 'LATE_STATE', null, orderId);
    }
    if (event.status === 'pending') {
      if (order.state === 'pending') return this.finishInbox(executor, inbox, 'accepted', null, null, orderId);
      return this.finishInbox(executor, inbox, 'reconciliation', 'LATE_STATE', null, orderId);
    }
    if (event.status === 'failed' || event.status === 'cancelled') {
      if (order.state === 'pending') await this.markServicePlanReconciliation(executor, order);
      return this.finishInbox(
        executor,
        inbox,
        'reconciliation',
        event.status === 'cancelled' ? 'PROVIDER_CANCELLED' : 'PROVIDER_FAILED',
        null,
        orderId,
      );
    }
    return this.finishInbox(executor, inbox, 'reconciliation', 'INVALID_EVENT_STATUS', null, orderId);
  }

  private async fulfillServicePlanWebhook(work: ServicePlanFulfillmentWork): Promise<PaymentWebhookResult> {
    const servicePlan = this.requireServicePlanService();
    const evidence = createHash('sha256')
      .update(
        JSON.stringify([
          work.event.providerKey,
          work.event.merchantId,
          work.event.providerEventId,
          work.event.eventType,
          work.event.providerOrderId,
          work.event.tenantId,
          work.event.amountMinorUnits.toString(),
          work.event.currency,
          work.event.occurredAt,
        ]),
      )
      .digest('hex');
    let fulfillment: Awaited<ReturnType<typeof servicePlan.fulfillVerified>>;
    try {
      fulfillment = await servicePlan.fulfillVerified({
        kind: 'server_verified_service_plan_fulfillment',
        orderId: work.order.id,
        tenantId: work.order.tenant_id,
        projectId: work.order.project_id,
        settlementId: work.event.providerEventId,
        providerKey: work.event.providerKey,
        merchantId: work.event.merchantId,
        amountMinorUnits: work.event.amountMinorUnits.toString(),
        currency: work.event.currency,
        fulfillmentReference: `${work.event.providerKey}:${work.event.merchantId}:${work.event.providerEventId}`,
        fulfillmentEvidenceSha256: evidence,
        verifiedAt: this.currentDate().toISOString(),
      });
    } catch (error) {
      if (
        isServicePlanError(error) &&
        [
          'FULFILLMENT_CONFLICT',
          'ORDER_STATE_CONFLICT',
          'ACTIVE_SUBSCRIPTION_EXISTS',
          'SUBSCRIPTION_STATE_CONFLICT',
        ].includes(error.code)
      ) {
        return this.runTransaction(async (executor) => {
          const current = await this.findServicePlanPaymentByProvider(
            executor,
            work.event.providerKey,
            work.event.merchantId,
            work.event.providerOrderId,
            true,
          );
          if (current) await this.markServicePlanReconciliation(executor, current);
          return this.finishInbox(executor, work.inbox, 'reconciliation', 'FULFILLMENT_CONFLICT', null, work.order.id);
        });
      }
      throw new PaymentError('FULFILLMENT_RETRYABLE');
    }

    const result = await this.runTransaction((executor) =>
      this.finishInbox(executor, work.inbox, 'fulfilled', null, null, work.order.id),
    );
    return { ...result, replayed: fulfillment.replayed };
  }

  private async fulfillFromEvent(
    executor: SqlExecutor,
    inbox: PaymentInboxRow,
    order: PaymentOrderEntity,
  ): Promise<PaymentWebhookResult> {
    if (order.status === 'fulfilled') return this.finishInbox(executor, inbox, 'reconciliation', 'LATE_STATE');
    if (order.status === 'cancelled' || order.status === 'paid' || order.status === 'fulfilling') {
      const reconciliation = await this.updateOrderState(executor, order, 'reconciliation_pending', null, null);
      if (!reconciliation) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return this.finishInbox(executor, inbox, 'reconciliation', 'LATE_STATE');
    }
    if (order.status !== 'created' && order.status !== 'pending' && order.status !== 'provider_failed') {
      return this.finishInbox(executor, inbox, 'reconciliation', 'LATE_STATE');
    }

    const paid = await this.updateOrderState(executor, order, 'paid', this.currentDate().toISOString(), null);
    if (!paid) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    const fulfilling = await this.updateOrderState(executor, paid, 'fulfilling', paid.paidAt, null);
    if (!fulfilling) throw new PaymentError('PAYMENT_STORAGE_ERROR');

    let funding: Awaited<ReturnType<NonNullable<PaymentServiceOptions['walletFundingLedger']>['postVerifiedFunding']>>;
    try {
      if (!this.walletFundingLedger) throw new PaymentError('FULFILLMENT_RETRYABLE');
      funding = await this.walletFundingLedger.postVerifiedFunding(executor, {
        tenantId: order.tenantId,
        currency: order.currency,
        amountMinorUnits: order.amountMinorUnits,
        sourceOrderRef: order.id,
        idempotencyKey: order.id,
        idempotencyNamespace: FUNDING_NAMESPACE,
        metadataRef: `payment-order:${order.id}`,
      });
    } catch {
      throw new PaymentError('FULFILLMENT_RETRYABLE');
    }

    const fulfilled = await this.updateOrderState(
      executor,
      fulfilling,
      'fulfilled',
      this.currentDate().toISOString(),
      funding.transactionId,
    );
    if (!fulfilled) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    return this.finishInbox(executor, inbox, 'fulfilled', null, funding.transactionId);
  }

  private async updateOrderState(
    executor: SqlExecutor,
    order: PaymentOrderEntity,
    state: PaymentOrderStatus,
    paidAt: string | null,
    fundingTransactionId: string | null,
  ): Promise<PaymentOrderEntity | null> {
    const result = await executor.query<PaymentOrderRow>(
      `UPDATE saas_payment_orders
       SET state = $3,
           paid_at = CASE WHEN $3 IN ('paid', 'fulfilling', 'fulfilled') THEN COALESCE(paid_at, $4) ELSE paid_at END,
           funding_transaction_id = COALESCE($5, funding_transaction_id),
           fulfilled_at = CASE WHEN $3 = 'fulfilled' THEN COALESCE(fulfilled_at, $4) ELSE fulfilled_at END,
           updated_at = $6
       WHERE tenant_id = $1 AND id = $2
         AND state IN ('created', 'provider_failed', 'pending', 'paid', 'fulfilling', 'cancelled', 'reconciliation_pending')
       RETURNING ${ORDER_COLUMNS}`,
      [order.tenantId, order.id, state, paidAt, fundingTransactionId, this.currentDate().toISOString()],
    );
    return rowsHaveOne(result) && result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  private async markServicePlanReconciliation(executor: SqlExecutor, order: ServicePlanPaymentRow): Promise<void> {
    const result = await executor.query<{ id: string }>(
      `UPDATE saas_service_plan_orders
       SET state = 'reconciliation_pending', updated_at = $4
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3
         AND state IN ('pending', 'paid', 'fulfilling')
       RETURNING id`,
      [order.tenant_id, order.project_id, order.id, this.currentDate().toISOString()],
    );
    if (rowsHaveOne(result)) return;
    const current = await this.findServicePlanPaymentById(executor, order.tenant_id, order.project_id, order.id);
    if (!current || !['fulfilled', 'cancelled', 'reconciliation_pending'].includes(current.state)) {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private async findInbox(
    executor: SqlExecutor,
    event: NormalizedEvent,
    forUpdate: boolean,
  ): Promise<PaymentInboxRow | null> {
    const result = await executor.query<PaymentInboxRow>(
      `SELECT ${INBOX_COLUMNS}
       FROM saas_payment_inbox
       WHERE provider_key = $1 AND merchant_id = $2 AND provider_event_id = $3
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [event.providerKey, event.merchantId, event.providerEventId],
    );
    return result.rows[0] ?? null;
  }

  private async findInboxById(
    executor: SqlExecutor,
    inboxId: string,
    forUpdate: boolean,
  ): Promise<PaymentInboxRow | null> {
    const result = await executor.query<PaymentInboxRow>(
      `SELECT ${INBOX_COLUMNS}
       FROM saas_payment_inbox
       WHERE id = $1
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [inboxId],
    );
    return result.rows[0] ?? null;
  }

  private async insertInbox(
    executor: SqlExecutor,
    id: string,
    event: NormalizedEvent,
    order: PaymentOrderEntity | MappedServicePlanPaymentRow | null,
  ): Promise<PaymentInboxRow | null> {
    const tenantId = order === null ? null : 'tenantId' in order ? order.tenantId : order.tenant_id;
    const localOrderId = order !== null && 'tenantId' in order ? order.id : null;
    try {
      const result = await executor.query<PaymentInboxRow>(
        `INSERT INTO saas_payment_inbox
          (id, provider_key, merchant_id, provider_event_id, event_type, provider_order_id,
           event_tenant_id, tenant_id, local_order_id, event_status, amount_minor_units, currency,
           occurred_at, received_at, next_attempt_at, updated_at, processing_outcome, outcome_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $14, 'accepted', NULL)
         ON CONFLICT (provider_key, merchant_id, provider_event_id) DO NOTHING
         RETURNING ${INBOX_COLUMNS}`,
        [
          id,
          event.providerKey,
          event.merchantId,
          event.providerEventId,
          event.eventType,
          event.providerOrderId,
          event.tenantId,
          tenantId,
          localOrderId,
          event.status,
          event.amountMinorUnits.toString(),
          event.currency,
          event.occurredAt,
          this.currentDate().toISOString(),
        ],
      );
      return rowsHaveOne(result) && result.rows[0] ? result.rows[0] : null;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }

  private assertInboxReplay(row: PaymentInboxRow, event: NormalizedEvent): void {
    if (
      row.provider_key !== event.providerKey ||
      row.merchant_id !== event.merchantId ||
      row.provider_event_id !== event.providerEventId ||
      row.event_type !== event.eventType ||
      row.provider_order_id !== event.providerOrderId ||
      row.event_tenant_id !== event.tenantId ||
      mapProviderEventStatus(row.event_status) !== event.status ||
      parseStoredMinorUnits(row.amount_minor_units) !== event.amountMinorUnits ||
      normalizeCurrency(row.currency) !== event.currency ||
      storedTimestamp(row.occurred_at) !== event.occurredAt
    ) {
      throw new PaymentError('PAYMENT_EVENT_CONFLICT');
    }
  }

  private async finishInbox(
    executor: SqlExecutor,
    row: PaymentInboxRow,
    outcome: PaymentInboxOutcome,
    outcomeCode: string | null,
    fundingTransactionId: string | null = null,
    orderIdOverride: string | null = null,
  ): Promise<PaymentWebhookResult> {
    const now = this.currentDate().toISOString();
    const result = await executor.query<PaymentInboxRow>(
      `UPDATE saas_payment_inbox
       SET processing_outcome = $2, outcome_code = $3,
           processing_state = 'processed', processed_at = $4, updated_at = $4,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = NULL
       WHERE id = $1 AND processing_state = 'processing' AND lease_token = $5
       RETURNING ${INBOX_COLUMNS}`,
      [row.id, outcome, outcomeCode, now, row.lease_token],
    );
    if (!rowsHaveOne(result) || !result.rows[0]) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    const finalRow = result.rows[0];
    const mapped = mapInboxRow(finalRow);
    return {
      outcome: mapped.outcome,
      replayed: false,
      inboxId: finalRow.id,
      orderId: orderIdOverride ?? mapped.orderId,
      fundingTransactionId: fundingTransactionId ?? mapped.fundingTransactionId,
    };
  }

  private async runTransaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (isPaymentError(error)) throw error;
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  }
}
