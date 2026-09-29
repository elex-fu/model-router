import { randomUUID } from 'node:crypto';
import { normalizeCurrency, parseMinorUnits, parseStoredMinorUnits } from '../billing/money.js';
import { PlatformWalletLedgerService } from '../billing/service.js';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../db/advisory-lock-keys.js';
import type { SqlExecutor, SqlResult } from '../db/types.js';
import { ByokServicePlanService } from '../plans/service.js';
import type { PaymentProviderRefundAdapter } from './adapter.js';
import { PaymentError } from './errors.js';
import type {
  PaymentDatabase,
  PaymentProviderRefundInput,
  PaymentProviderRefundQueryResult,
  PaymentProviderRefundResult,
  PaymentRefundAuthorizationRequest,
  PaymentRefundOperationsPort,
  PaymentRefundRecord,
  PaymentRefundStatus,
  PaymentRefundType,
  PaymentRefundWorkerBatchResult,
  PaymentWalletRefundLedger,
  RequestPlatformWalletTopUpRefundInput,
  RequestServicePlanRefundInput,
  RequestWalletTopUpRefundInput,
} from './types.js';

const REFUND_IDEMPOTENCY_NAMESPACE = 'saas.payment.refund';
const ACTIVE_REFUND_STATES = "('submitting', 'pending', 'unknown', 'blocked', 'succeeded')";
const BYOK_REFUND_POLICY_VERSION = 'byok_cancel_only_v1';
const LEGACY_SERVICE_PLAN_BLOCKED_CODE = 'SERVICE_PLAN_REFUND_ENTITLEMENT_SEAM_REQUIRED';
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_RECONCILE_DELAY_MS = 5_000;
const MAX_REFUND_TEXT_LENGTH = 512;

type StoredTimestamp = string | Date;
type StoredMinorUnits = string | number | bigint;

interface RefundRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly refund_type: string;
  readonly wallet_topup_order_id: string | null;
  readonly service_plan_order_id: string | null;
  readonly original_funding_transaction_id: string | null;
  readonly wallet_id: string | null;
  readonly provider_key: string;
  readonly merchant_id: string;
  readonly provider_order_id: string;
  readonly original_local_order_ref: string;
  readonly idempotency_namespace: string;
  readonly client_request_id: string;
  readonly requested_by_user_id: string;
  readonly authorization_ref: string;
  readonly reason_code: string;
  readonly amount_minor_units: StoredMinorUnits;
  readonly currency: string;
  readonly state: string;
  readonly provider_refund_id: string | null;
  readonly failure_code: string | null;
  readonly blocked_code: string | null;
  readonly wallet_refund_transaction_id: string | null;
  readonly service_plan_effect_ref: string | null;
  readonly provider_attempts: number | string;
  readonly lease_action: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: StoredTimestamp | null;
  readonly next_reconcile_at: StoredTimestamp;
  readonly created_at: StoredTimestamp;
  readonly updated_at: StoredTimestamp;
  readonly completed_at: StoredTimestamp | null;
}

interface WalletTopUpRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly order_type: string;
  readonly state: string;
  readonly provider_key: string;
  readonly merchant_id: string;
  readonly provider_order_id: string | null;
  readonly local_order_ref: string;
  readonly funding_reference: string;
  readonly amount_minor_units: StoredMinorUnits;
  readonly currency: string;
  readonly funding_transaction_id: string | null;
}

interface ServicePlanOrderRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly state: string;
  readonly subscription_id: string | null;
  readonly provider_key: string | null;
  readonly merchant_id: string | null;
  readonly provider_order_id: string | null;
  readonly verified_provider_key: string | null;
  readonly verified_merchant_id: string | null;
  readonly verified_amount_minor_units: StoredMinorUnits | null;
  readonly verified_currency: string | null;
  readonly snapshot_price_minor_units: StoredMinorUnits;
  readonly snapshot_currency: string;
  readonly snapshot_policy_version: string;
  readonly local_order_ref: string;
}

interface WalletRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly currency: string;
  readonly posted_balance_minor_units: StoredMinorUnits;
}

interface RefundRequest {
  readonly actorId: string;
  readonly sessionId: string | null;
  readonly actorRoles: readonly string[] | null;
  readonly tenantId: string;
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly amountMinorUnits: string | null;
  readonly reasonCode: string;
  readonly refundType: PaymentRefundType;
}

interface RefundCreation {
  readonly row: RefundRow;
  readonly submitLeaseToken: string | null;
}

export interface PaymentRefundServiceOptions {
  readonly providerKey: string;
  readonly merchantId: string;
  readonly operations: PaymentRefundOperationsPort;
  readonly walletRefundLedger?: PaymentWalletRefundLedger;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly leaseTtlMs?: number;
  readonly reconcileDelayMs?: number;
}

function rowsHaveOne<Row>(result: SqlResult<Row>): boolean {
  return result.rows.length === 1 && (result.rowCount === null || result.rowCount === 1);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function normalizeText(value: unknown, code: 'INVALID_INPUT' | 'PAYMENT_STORAGE_ERROR' = 'INVALID_INPUT'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REFUND_TEXT_LENGTH) {
    throw new PaymentError(code);
  }
  if (
    [...value].some((character) => {
      const point = character.charCodeAt(0);
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    throw new PaymentError(code);
  }
  const normalized = value.trim();
  if (!normalized) throw new PaymentError(code);
  return normalized;
}

function normalizeReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._:-]{0,95}$/.test(value)) {
    throw new PaymentError('INVALID_INPUT');
  }
  return value;
}

function normalizeTimestamp(value: unknown): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new PaymentError('PAYMENT_STORAGE_ERROR');
  return date.toISOString();
}

function nullableTimestamp(value: StoredTimestamp | null): string | null {
  return value === null ? null : normalizeTimestamp(value);
}

function mapRefundStatus(value: unknown): PaymentRefundStatus {
  if (
    value === 'submitting' ||
    value === 'pending' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'unknown' ||
    value === 'blocked'
  )
    return value;
  throw new PaymentError('PAYMENT_STORAGE_ERROR');
}

function mapRefundRow(row: RefundRow): RefundRow {
  if (row.refund_type !== 'wallet_topup' && row.refund_type !== 'byok_service_plan') {
    throw new PaymentError('PAYMENT_STORAGE_ERROR');
  }
  mapRefundStatus(row.state);
  const attempts = typeof row.provider_attempts === 'number' ? row.provider_attempts : Number(row.provider_attempts);
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new PaymentError('PAYMENT_STORAGE_ERROR');
  parseStoredMinorUnits(row.amount_minor_units);
  normalizeCurrency(row.currency);
  normalizeText(row.id, 'PAYMENT_STORAGE_ERROR');
  normalizeText(row.tenant_id, 'PAYMENT_STORAGE_ERROR');
  normalizeText(row.provider_key, 'PAYMENT_STORAGE_ERROR');
  normalizeText(row.merchant_id, 'PAYMENT_STORAGE_ERROR');
  normalizeText(row.provider_order_id, 'PAYMENT_STORAGE_ERROR');
  normalizeText(row.original_local_order_ref, 'PAYMENT_STORAGE_ERROR');
  normalizeTimestamp(row.created_at);
  normalizeTimestamp(row.updated_at);
  if (row.state === 'submitting' && (row.lease_action !== 'submit' || row.lease_token === null)) {
    throw new PaymentError('PAYMENT_STORAGE_ERROR');
  }
  if (row.lease_token !== null) normalizeText(row.lease_token, 'PAYMENT_STORAGE_ERROR');
  if (row.lease_expires_at !== null) normalizeTimestamp(row.lease_expires_at);
  if (row.refund_type === 'byok_service_plan') {
    if (
      row.wallet_topup_order_id !== null ||
      row.service_plan_order_id === null ||
      row.original_funding_transaction_id !== null ||
      row.wallet_id !== null ||
      row.wallet_refund_transaction_id !== null ||
      (row.state !== 'blocked' && row.service_plan_effect_ref === null)
    ) {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
  } else if (
    row.wallet_topup_order_id === null ||
    row.service_plan_order_id !== null ||
    row.original_funding_transaction_id === null ||
    row.wallet_id === null ||
    row.service_plan_effect_ref !== null
  ) {
    throw new PaymentError('PAYMENT_STORAGE_ERROR');
  }
  return row;
}

function toRecord(source: RefundRow): PaymentRefundRecord {
  const row = mapRefundRow(source);
  const isWallet = row.refund_type === 'wallet_topup';
  const originalOrderId = isWallet ? row.wallet_topup_order_id : row.service_plan_order_id;
  if (originalOrderId === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    refundType: row.refund_type as PaymentRefundType,
    originalOrderId,
    amountMinorUnits: parseStoredMinorUnits(row.amount_minor_units).toString(),
    currency: row.currency,
    status: mapRefundStatus(row.state),
    providerRefundId: row.provider_refund_id,
    failureCode: row.failure_code,
    blockedCode: row.blocked_code,
    walletRefundTransactionId: row.wallet_refund_transaction_id,
    createdAt: normalizeTimestamp(row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at),
    completedAt: nullableTimestamp(row.completed_at),
  };
}

function assertRefundReplay(row: RefundRow, request: RefundRequest): void {
  const originalOrderId = request.refundType === 'wallet_topup' ? row.wallet_topup_order_id : row.service_plan_order_id;
  if (
    row.tenant_id !== request.tenantId ||
    row.refund_type !== request.refundType ||
    originalOrderId !== request.orderId ||
    (request.amountMinorUnits !== null &&
      parseStoredMinorUnits(row.amount_minor_units).toString() !== request.amountMinorUnits) ||
    row.reason_code !== request.reasonCode
  ) {
    throw new PaymentError('REFUND_STATE_CONFLICT');
  }
}

function addMs(now: Date, duration: number): string {
  return new Date(now.getTime() + duration).toISOString();
}

function isDefinitiveNonAcceptance(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const acceptance = (error as Record<string, unknown>).acceptance;
  return acceptance === 'not_accepted' || acceptance === 'rejected';
}

function providerEchoMatches(
  expected: PaymentProviderRefundInput,
  actual: PaymentProviderRefundResult | PaymentProviderRefundQueryResult,
): boolean {
  try {
    return (
      actual.localRefundId === expected.localRefundId &&
      actual.idempotencyReference === expected.idempotencyReference &&
      actual.tenantId === expected.tenantId &&
      actual.originalLocalOrderId === expected.originalLocalOrderId &&
      actual.providerKey === expected.providerKey &&
      actual.merchantId === expected.merchantId &&
      actual.providerOrderId === expected.providerOrderId &&
      parseMinorUnits(actual.amountMinorUnits).toString() === expected.amountMinorUnits &&
      normalizeCurrency(actual.currency) === expected.currency &&
      (expected.providerRefundId === null || actual.providerRefundId === expected.providerRefundId) &&
      (actual.providerRefundId === null || normalizeText(actual.providerRefundId) === actual.providerRefundId)
    );
  } catch {
    return false;
  }
}

function refundColumns(): string {
  return `id, tenant_id, refund_type, wallet_topup_order_id, service_plan_order_id,
    original_funding_transaction_id, wallet_id, provider_key, merchant_id, provider_order_id,
    original_local_order_ref, idempotency_namespace, client_request_id, requested_by_user_id,
    authorization_ref, reason_code, amount_minor_units, currency, state, provider_refund_id,
    failure_code, blocked_code, wallet_refund_transaction_id, provider_attempts, lease_action,
    service_plan_effect_ref, lease_token, lease_expires_at, next_reconcile_at, created_at,
    updated_at, completed_at`;
}

/**
 * PSP refund coordinator. DB transactions only create/claim or finalize facts;
 * submit/query calls always happen after the transaction and locks have ended.
 */
export class PaymentRefundService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly walletRefundLedger: PaymentWalletRefundLedger;
  private readonly servicePlans: ByokServicePlanService;
  private readonly leaseTtlMs: number;
  private readonly reconcileDelayMs: number;

  constructor(
    private readonly database: PaymentDatabase,
    private readonly provider: PaymentProviderRefundAdapter,
    private readonly options: PaymentRefundServiceOptions,
  ) {
    this.providerKey = normalizeText(options.providerKey);
    this.merchantId = normalizeText(options.merchantId);
    if (provider.providerKey !== this.providerKey || provider.merchantId !== this.merchantId) {
      throw new TypeError('Refund provider identity must match the configured provider and merchant');
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.servicePlans = new ByokServicePlanService(database, {
      now: this.now,
      idFactory: this.idFactory,
    });
    this.walletRefundLedger =
      options.walletRefundLedger ??
      new PlatformWalletLedgerService({
        now: this.now,
        idFactory: this.idFactory,
      });
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.reconcileDelayMs = options.reconcileDelayMs ?? DEFAULT_RECONCILE_DELAY_MS;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 1_000 || this.leaseTtlMs > 86_400_000) {
      throw new TypeError('leaseTtlMs must be an integer between 1000 and 86400000');
    }
    if (
      !Number.isSafeInteger(this.reconcileDelayMs) ||
      this.reconcileDelayMs < 0 ||
      this.reconcileDelayMs > 86_400_000
    ) {
      throw new TypeError('reconcileDelayMs must be an integer between 0 and 86400000');
    }
  }

  readonly providerKey: string;
  readonly merchantId: string;

  requestWalletTopUpRefund(input: RequestWalletTopUpRefundInput): Promise<PaymentRefundRecord> {
    return this.request({
      ...input,
      sessionId: null,
      actorRoles: null,
      amountMinorUnits: parseMinorUnits(input.amountMinorUnits).toString(),
      refundType: 'wallet_topup',
    });
  }

  requestPlatformWalletTopUpRefund(input: RequestPlatformWalletTopUpRefundInput): Promise<PaymentRefundRecord> {
    return this.request({ ...input, amountMinorUnits: null, refundType: 'wallet_topup' });
  }

  /** Approved requests create a provisional effect before PSP I/O starts. */
  requestServicePlanRefund(input: RequestServicePlanRefundInput): Promise<PaymentRefundRecord> {
    return this.request({
      ...input,
      sessionId: null,
      actorRoles: null,
      amountMinorUnits: parseMinorUnits(input.amountMinorUnits).toString(),
      refundType: 'byok_service_plan',
    });
  }

  async getRefund(tenantIdInput: string, refundIdInput: string): Promise<PaymentRefundRecord | null> {
    const tenantId = normalizeText(tenantIdInput);
    const refundId = normalizeText(refundIdInput);
    const result = await this.database.query<RefundRow>(
      `SELECT ${refundColumns()} FROM saas_refund_orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, refundId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async processPendingRefunds(limit = 20): Promise<PaymentRefundWorkerBatchResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError('limit must be between 1 and 100');
    const now = this.now().toISOString();
    const candidates = await this.database.query<{ id: string }>(
      `SELECT id FROM saas_refund_orders
       WHERE state IN ('submitting', 'pending', 'unknown')
         AND (
           (state = 'submitting' AND lease_action = 'submit' AND lease_expires_at <= $1)
           OR
           (state IN ('pending', 'unknown') AND next_reconcile_at <= $1
             AND (lease_action IS NULL OR lease_expires_at <= $1))
         )
       ORDER BY next_reconcile_at, created_at, id
       LIMIT $2`,
      [now, limit],
    );
    const batch = { claimed: 0, queried: 0, succeeded: 0, failed: 0, unresolved: 0 };
    for (const candidate of candidates.rows) {
      try {
        const result = await this.reconcileOne(candidate.id);
        if (!result.claimed) continue;
        batch.claimed += 1;
        batch.queried += 1;
        if (result.status === 'succeeded') batch.succeeded += 1;
        else if (result.status === 'failed') batch.failed += 1;
        else batch.unresolved += 1;
      } catch {
        batch.unresolved += 1;
      }
    }
    return batch;
  }

  private async request(requestInput: RefundRequest): Promise<PaymentRefundRecord> {
    const request: RefundRequest = {
      ...requestInput,
      actorId: normalizeText(requestInput.actorId),
      tenantId: normalizeText(requestInput.tenantId),
      orderId: normalizeText(requestInput.orderId),
      clientRequestId: normalizeText(requestInput.clientRequestId),
      amountMinorUnits:
        requestInput.amountMinorUnits === null ? null : parseMinorUnits(requestInput.amountMinorUnits).toString(),
      reasonCode: normalizeReasonCode(requestInput.reasonCode),
    };
    let creation: RefundCreation;
    try {
      creation = await this.database.transaction(async (executor) => {
        await executor.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await executor.query(`SET LOCAL lock_timeout = '2s'`);
        await executor.query(`SET LOCAL statement_timeout = '10s'`);
        return this.createOrReplay(executor, request);
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.findByIdempotency(request.tenantId, request.clientRequestId);
      if (!replay) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      assertRefundReplay(replay, request);
      return toRecord(replay);
    }

    if (creation.submitLeaseToken === null) return toRecord(creation.row);
    const submitted = await this.submitClaim(creation.row, creation.submitLeaseToken);
    if (submitted.status === 'unknown') {
      const reconciled = await this.reconcileOne(creation.row.id, true);
      if (reconciled.record) return reconciled.record;
    }
    return submitted.record;
  }

  private async createOrReplay(executor: SqlExecutor, request: RefundRequest): Promise<RefundCreation> {
    if (request.refundType === 'byok_service_plan') {
      // The BYOK effect later updates saas_project_entitlements. Fence before
      // taking either the idempotency or service-plan-order row lock so this
      // outer transaction matches fulfillVerified's global -> order order.
      await this.fenceAuthorizationWriters(executor);
    }
    const existing = await this.findByIdempotencyWith(executor, request.tenantId, request.clientRequestId, true);
    if (existing) {
      await this.authorize(executor, request, parseStoredMinorUnits(existing.amount_minor_units).toString());
      assertRefundReplay(existing, request);
      return { row: existing, submitLeaseToken: null };
    }

    const source =
      request.refundType === 'wallet_topup'
        ? await this.lockWalletTopUp(executor, request.tenantId, request.orderId)
        : await this.lockServicePlanOrder(executor, request.tenantId, request.orderId);
    this.assertOriginalPaymentIdentity(source, request.tenantId);
    const capturedAmount =
      request.refundType === 'wallet_topup'
        ? this.assertWalletTopUpSource(source as WalletTopUpRow)
        : this.assertServicePlanSource(source as ServicePlanOrderRow);
    if (request.refundType === 'byok_service_plan') {
      await this.assertNoUnresolvedServicePlanRefund(executor, request.tenantId, request.orderId);
    }
    const amountMinorUnits = request.amountMinorUnits ?? capturedAmount.toString();
    if (parseMinorUnits(amountMinorUnits) > capturedAmount) {
      throw new PaymentError('REFUND_AMOUNT_EXCEEDS_AVAILABLE');
    }

    const alreadyRequested = await this.refundedAmount(executor, request.refundType, request.tenantId, request.orderId);
    if (alreadyRequested + parseMinorUnits(amountMinorUnits) > capturedAmount) {
      throw new PaymentError('REFUND_AMOUNT_EXCEEDS_AVAILABLE');
    }

    const id = normalizeText(this.idFactory());
    const createdAt = this.now();
    const leaseToken = normalizeText(this.idFactory());
    const servicePlanEffectRef = request.refundType === 'byok_service_plan' ? normalizeText(this.idFactory()) : null;
    let wallet: WalletRow | null = null;
    let fundingTransactionId: string | null = null;
    const currency =
      request.refundType === 'wallet_topup'
        ? (source as WalletTopUpRow).currency
        : (source as ServicePlanOrderRow).snapshot_currency;
    const originalLocalOrderRef =
      request.refundType === 'wallet_topup'
        ? (source as WalletTopUpRow).local_order_ref
        : (source as ServicePlanOrderRow).local_order_ref;
    const providerOrderId = source.provider_order_id;
    if (providerOrderId === null) throw new PaymentError('ORDER_STATE_CONFLICT');
    if (request.refundType === 'wallet_topup') {
      const topUp = source as WalletTopUpRow;
      fundingTransactionId = topUp.funding_transaction_id;
      if (fundingTransactionId === null) throw new PaymentError('ORDER_STATE_CONFLICT');
      await this.assertFundingTransaction(executor, topUp, fundingTransactionId);
      wallet = await this.lockWallet(executor, request.tenantId, currency);
      await this.assertRefundableWalletAmount(executor, wallet, parseMinorUnits(amountMinorUnits));
    }

    const authorizationRef = await this.authorize(executor, request, amountMinorUnits);

    const inserted = await executor.query<RefundRow>(
      `INSERT INTO saas_refund_orders
        (id, tenant_id, refund_type, wallet_topup_order_id, service_plan_order_id,
         original_funding_transaction_id, wallet_id, provider_key, merchant_id, provider_order_id,
         original_local_order_ref, idempotency_namespace, client_request_id, requested_by_user_id,
         authorization_ref, reason_code, amount_minor_units, currency, state, blocked_code,
         service_plan_effect_ref, provider_attempts, lease_action, lease_token,
         lease_expires_at, next_reconcile_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, NULL, $20, $21, 'submit', $22, $23, $24, $25, $25)
       RETURNING ${refundColumns()}`,
      [
        id,
        request.tenantId,
        request.refundType,
        request.refundType === 'wallet_topup' ? request.orderId : null,
        request.refundType === 'byok_service_plan' ? request.orderId : null,
        fundingTransactionId,
        wallet?.id ?? null,
        this.providerKey,
        this.merchantId,
        providerOrderId,
        originalLocalOrderRef,
        REFUND_IDEMPOTENCY_NAMESPACE,
        request.clientRequestId,
        request.actorId,
        authorizationRef,
        request.reasonCode,
        amountMinorUnits,
        currency,
        'submitting',
        servicePlanEffectRef,
        1,
        leaseToken,
        addMs(createdAt, this.leaseTtlMs),
        createdAt.toISOString(),
        createdAt.toISOString(),
      ],
    );
    if (!rowsHaveOne(inserted)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
    const row = mapRefundRow(inserted.rows[0]);

    if (request.refundType === 'wallet_topup') {
      if (!wallet) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      await executor.query(
        `INSERT INTO saas_refund_wallet_freezes
          (refund_order_id, tenant_id, wallet_id, currency, amount_minor_units, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, request.tenantId, wallet.id, currency, amountMinorUnits, createdAt.toISOString()],
      );
    } else {
      const sourceOrder = source as ServicePlanOrderRow;
      if (sourceOrder.subscription_id === null || servicePlanEffectRef === null) {
        throw new PaymentError('ORDER_STATE_CONFLICT');
      }
      await this.servicePlans.applyApprovedRefundEntitlementEffect(executor, {
        tenantId: request.tenantId,
        orderId: request.orderId,
        projectId: sourceOrder.project_id,
        subscriptionId: sourceOrder.subscription_id,
        refundId: id,
        effectRef: servicePlanEffectRef,
        refundPolicyVersion: BYOK_REFUND_POLICY_VERSION,
        amountMinorUnits,
        currency,
        cutoffAt: createdAt.toISOString(),
        actorId: request.actorId,
        reasonCode: request.reasonCode,
      });
    }

    await this.options.operations.recordAudit(executor, {
      actorId: request.actorId,
      tenantId: request.tenantId,
      action: 'payment.refund.requested',
      refundId: id,
      originalOrderId: request.orderId,
      amountMinorUnits,
      currency,
      status: row.state as PaymentRefundStatus,
      reasonCode: request.reasonCode,
    });
    return { row, submitLeaseToken: leaseToken };
  }

  private async authorize(executor: SqlExecutor, request: RefundRequest, amountMinorUnits: string): Promise<string> {
    const authorizationRequest: PaymentRefundAuthorizationRequest = {
      actorId: request.actorId,
      sessionId: request.sessionId,
      actorRoles: request.actorRoles,
      tenantId: request.tenantId,
      originalOrderId: request.orderId,
      refundType: request.refundType,
      amountMinorUnits,
    };
    const authorization = await this.options.operations.authorize(authorizationRequest, executor);
    return normalizeText(authorization?.authorizationRef);
  }

  private async lockWalletTopUp(executor: SqlExecutor, tenantId: string, orderId: string): Promise<WalletTopUpRow> {
    const result = await executor.query<WalletTopUpRow>(
      `SELECT id, tenant_id, order_type, state, provider_key, merchant_id, provider_order_id,
              local_order_ref, funding_reference, amount_minor_units, currency, funding_transaction_id
       FROM saas_payment_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, orderId],
    );
    if (!rowsHaveOne(result)) throw new PaymentError('ORDER_NOT_FOUND');
    return result.rows[0];
  }

  private async lockServicePlanOrder(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
  ): Promise<ServicePlanOrderRow> {
    const result = await executor.query<ServicePlanOrderRow>(
      `SELECT o.id, o.tenant_id, o.project_id, o.state, o.subscription_id,
              o.provider_key, o.merchant_id, o.provider_order_id,
              o.verified_provider_key, o.verified_merchant_id, o.verified_amount_minor_units,
              o.verified_currency, s.price_minor_units AS snapshot_price_minor_units,
              s.currency AS snapshot_currency, s.policy_version AS snapshot_policy_version,
              o.id AS local_order_ref
       FROM saas_service_plan_orders o
       JOIN saas_service_plan_snapshots s ON s.tenant_id = o.tenant_id AND s.order_id = o.id
       WHERE o.tenant_id = $1 AND o.id = $2 FOR UPDATE OF o`,
      [tenantId, orderId],
    );
    if (!rowsHaveOne(result)) throw new PaymentError('ORDER_NOT_FOUND');
    return result.rows[0];
  }

  private assertOriginalPaymentIdentity(source: WalletTopUpRow | ServicePlanOrderRow, tenantId: string): void {
    if (
      source.tenant_id !== tenantId ||
      source.provider_key !== this.providerKey ||
      source.merchant_id !== this.merchantId ||
      !source.provider_order_id
    ) {
      throw new PaymentError('ORDER_STATE_CONFLICT');
    }
  }

  private assertWalletTopUpSource(row: WalletTopUpRow): bigint {
    if (
      row.order_type !== 'wallet_topup' ||
      row.state !== 'fulfilled' ||
      row.provider_order_id === null ||
      row.funding_transaction_id === null
    )
      throw new PaymentError('ORDER_STATE_CONFLICT');
    normalizeCurrency(row.currency);
    return parseStoredMinorUnits(row.amount_minor_units);
  }

  private assertServicePlanSource(row: ServicePlanOrderRow): bigint {
    if (
      row.state !== 'fulfilled' ||
      row.provider_key === null ||
      row.merchant_id === null ||
      row.provider_order_id === null ||
      row.subscription_id === null ||
      row.verified_provider_key !== row.provider_key ||
      row.verified_merchant_id !== row.merchant_id ||
      row.verified_amount_minor_units === null ||
      row.verified_currency === null ||
      row.verified_currency !== row.snapshot_currency
    )
      throw new PaymentError('ORDER_STATE_CONFLICT');
    const amount = parseStoredMinorUnits(row.snapshot_price_minor_units);
    if (parseStoredMinorUnits(row.verified_amount_minor_units) !== amount) {
      throw new PaymentError('ORDER_STATE_CONFLICT');
    }
    normalizeText(row.project_id, 'PAYMENT_STORAGE_ERROR');
    normalizeText(row.subscription_id, 'PAYMENT_STORAGE_ERROR');
    normalizeText(row.snapshot_policy_version, 'PAYMENT_STORAGE_ERROR');
    normalizeCurrency(row.snapshot_currency);
    return amount;
  }

  private async assertFundingTransaction(
    executor: SqlExecutor,
    order: WalletTopUpRow,
    transactionId: string,
  ): Promise<void> {
    // Funding transactions are immutable; refund admission is serialized by the locked payment order.
    const result = await executor.query<{
      readonly id: string;
      readonly tenant_id: string;
      readonly currency: string;
      readonly source_type: string;
      readonly source_order_ref: string | null;
      readonly amount_minor_units: StoredMinorUnits;
    }>(
      `SELECT id, tenant_id, currency, source_type, source_order_ref, amount_minor_units
       FROM saas_ledger_transactions
       WHERE id = $1 AND tenant_id = $2 AND currency = $3`,
      [transactionId, order.tenant_id, order.currency],
    );
    const funding = result.rows[0];
    if (
      funding?.source_type !== 'wallet_funding' ||
      funding.source_order_ref !== order.funding_reference ||
      parseStoredMinorUnits(funding.amount_minor_units) !== parseStoredMinorUnits(order.amount_minor_units)
    )
      throw new PaymentError('ORDER_STATE_CONFLICT');
  }

  private async refundedAmount(
    executor: SqlExecutor,
    type: PaymentRefundType,
    tenantId: string,
    orderId: string,
  ): Promise<bigint> {
    const column = type === 'wallet_topup' ? 'wallet_topup_order_id' : 'service_plan_order_id';
    const result = await executor.query<{ readonly amount_minor_units: StoredMinorUnits }>(
      `SELECT COALESCE(SUM(amount_minor_units), 0)::text AS amount_minor_units
       FROM saas_refund_orders
       WHERE tenant_id = $1 AND ${column} = $2 AND state IN ${ACTIVE_REFUND_STATES}
         AND NOT (refund_type = 'byok_service_plan' AND state = 'blocked'
           AND blocked_code = $3)`,
      [tenantId, orderId, LEGACY_SERVICE_PLAN_BLOCKED_CODE],
    );
    return parseStoredMinorUnits(result.rows[0]?.amount_minor_units ?? '0');
  }

  private async assertNoUnresolvedServicePlanRefund(
    executor: SqlExecutor,
    tenantId: string,
    orderId: string,
  ): Promise<void> {
    const unresolved = await executor.query<{ readonly id: string }>(
      `SELECT id FROM saas_refund_orders
       WHERE tenant_id = $1 AND service_plan_order_id = $2
         AND refund_type = 'byok_service_plan' AND state IN ('submitting', 'pending', 'unknown')
       LIMIT 1`,
      [tenantId, orderId],
    );
    if (unresolved.rows.length !== 0) throw new PaymentError('REFUND_STATE_CONFLICT');
  }

  private async lockWallet(executor: SqlExecutor, tenantId: string, currency: string): Promise<WalletRow> {
    const result = await executor.query<WalletRow>(
      `SELECT id, tenant_id, currency, posted_balance_minor_units
       FROM saas_wallets WHERE tenant_id = $1 AND currency = $2 FOR UPDATE`,
      [tenantId, currency],
    );
    if (!rowsHaveOne(result)) throw new PaymentError('ORDER_STATE_CONFLICT');
    return result.rows[0];
  }

  private async assertRefundableWalletAmount(executor: SqlExecutor, wallet: WalletRow, amount: bigint): Promise<void> {
    const [holds, freezes] = await Promise.all([
      executor.query<{ readonly total: StoredMinorUnits }>(
        `SELECT COALESCE(SUM(amount_minor_units), 0)::text AS total
         FROM saas_billing_reservations
         WHERE tenant_id = $1 AND currency = $2 AND state IN ('reserved', 'reconciliation_pending')`,
        [wallet.tenant_id, wallet.currency],
      ),
      executor.query<{ readonly total: StoredMinorUnits }>(
        `SELECT COALESCE(SUM(amount_minor_units), 0)::text AS total
         FROM saas_refund_wallet_freezes WHERE tenant_id = $1 AND currency = $2`,
        [wallet.tenant_id, wallet.currency],
      ),
    ]);
    const posted = parseStoredMinorUnits(wallet.posted_balance_minor_units);
    const held = parseStoredMinorUnits(holds.rows[0]?.total ?? '0');
    const frozen = parseStoredMinorUnits(freezes.rows[0]?.total ?? '0');
    if (held + frozen > posted || amount > posted - held - frozen) {
      throw new PaymentError('REFUND_AMOUNT_EXCEEDS_AVAILABLE');
    }
  }

  private async findByIdempotency(tenantId: string, clientRequestId: string): Promise<RefundRow | null> {
    return this.findByIdempotencyWith(this.database, tenantId, clientRequestId, false);
  }

  private async fenceAuthorizationWriters(executor: SqlExecutor): Promise<void> {
    await executor.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
    await executor.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
  }

  private async refundTypeHint(executor: SqlExecutor, refundId: string): Promise<PaymentRefundType> {
    const result = await executor.query<{ readonly refund_type: string }>(
      `SELECT refund_type FROM saas_refund_orders WHERE id = $1`,
      [refundId],
    );
    const refundType = result.rows[0]?.refund_type;
    if (refundType === undefined) throw new PaymentError('REFUND_NOT_FOUND');
    if (refundType !== 'wallet_topup' && refundType !== 'byok_service_plan') {
      throw new PaymentError('PAYMENT_STORAGE_ERROR');
    }
    return refundType;
  }

  private async findByIdempotencyWith(
    executor: SqlExecutor,
    tenantId: string,
    clientRequestId: string,
    forUpdate: boolean,
  ): Promise<RefundRow | null> {
    const result = await executor.query<RefundRow>(
      `SELECT ${refundColumns()} FROM saas_refund_orders
       WHERE tenant_id = $1 AND idempotency_namespace = $2 AND client_request_id = $3
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [tenantId, REFUND_IDEMPOTENCY_NAMESPACE, clientRequestId],
    );
    return result.rows[0] ? mapRefundRow(result.rows[0]) : null;
  }

  private providerInput(row: RefundRow): PaymentProviderRefundInput {
    const mapped = mapRefundRow(row);
    const originalLocalOrderId =
      mapped.refund_type === 'wallet_topup' ? mapped.wallet_topup_order_id : mapped.service_plan_order_id;
    if (originalLocalOrderId === null) throw new PaymentError('REFUND_STATE_CONFLICT');
    return {
      localRefundId: mapped.id,
      idempotencyReference: mapped.id,
      tenantId: mapped.tenant_id,
      originalLocalOrderId,
      providerKey: mapped.provider_key,
      merchantId: mapped.merchant_id,
      providerOrderId: mapped.provider_order_id,
      amountMinorUnits: parseStoredMinorUnits(mapped.amount_minor_units).toString(),
      currency: mapped.currency,
      providerRefundId: mapped.provider_refund_id,
    };
  }

  private async submitClaim(
    row: RefundRow,
    leaseToken: string,
  ): Promise<{ record: PaymentRefundRecord; status: PaymentRefundStatus }> {
    const input = this.providerInput(row);
    let providerResult: PaymentProviderRefundResult;
    try {
      providerResult = await this.provider.submitRefund(input);
    } catch (error) {
      const status: PaymentRefundStatus = isDefinitiveNonAcceptance(error) ? 'failed' : 'unknown';
      const code = status === 'failed' ? 'PROVIDER_REFUND_NOT_ACCEPTED' : 'PROVIDER_REFUND_OUTCOME_UNKNOWN';
      return this.persistProviderOutcome(row.id, 'submit', leaseToken, status, null, code);
    }
    if (!providerEchoMatches(input, providerResult)) {
      return this.persistProviderOutcome(
        row.id,
        'submit',
        leaseToken,
        'unknown',
        null,
        'PROVIDER_REFUND_RESULT_MISMATCH',
      );
    }
    if (
      providerResult.status !== 'pending' &&
      providerResult.status !== 'succeeded' &&
      providerResult.status !== 'failed'
    ) {
      return this.persistProviderOutcome(
        row.id,
        'submit',
        leaseToken,
        'unknown',
        null,
        'PROVIDER_REFUND_RESULT_INVALID',
      );
    }
    return this.persistProviderOutcome(
      row.id,
      'submit',
      leaseToken,
      providerResult.status,
      providerResult.providerRefundId,
      providerResult.status === 'failed' ? 'PROVIDER_REFUND_FAILED' : null,
    );
  }

  private async reconcileOne(
    refundId: string,
    immediate = false,
  ): Promise<{ claimed: boolean; status?: PaymentRefundStatus; record?: PaymentRefundRecord }> {
    const claim = await this.claimQuery(refundId, immediate);
    if (!claim) return { claimed: false };
    const input = this.providerInput(claim.row);
    let result: PaymentProviderRefundQueryResult | null = null;
    try {
      result = await this.provider.queryRefund(input);
    } catch {
      // A failed lookup says nothing about whether the provider accepted the refund.
    }
    if (result === null || !providerEchoMatches(input, result)) {
      const persisted = await this.persistProviderOutcome(
        refundId,
        'query',
        claim.leaseToken,
        'unknown',
        null,
        'PROVIDER_REFUND_QUERY_UNRESOLVED',
      );
      return { claimed: true, status: persisted.status, record: persisted.record };
    }
    if (
      result.status !== 'pending' &&
      result.status !== 'succeeded' &&
      result.status !== 'failed' &&
      result.status !== 'not_found' &&
      result.status !== 'unknown'
    ) {
      const persisted = await this.persistProviderOutcome(
        refundId,
        'query',
        claim.leaseToken,
        'unknown',
        null,
        'PROVIDER_REFUND_QUERY_UNRESOLVED',
      );
      return { claimed: true, status: persisted.status, record: persisted.record };
    }
    const status: PaymentRefundStatus =
      result.status === 'not_found' || result.status === 'unknown' ? 'unknown' : result.status;
    const persisted = await this.persistProviderOutcome(
      refundId,
      'query',
      claim.leaseToken,
      status,
      result.providerRefundId,
      status === 'failed' ? 'PROVIDER_REFUND_FAILED' : status === 'unknown' ? 'PROVIDER_REFUND_QUERY_UNRESOLVED' : null,
    );
    return { claimed: true, status: persisted.status, record: persisted.record };
  }

  private async claimQuery(
    refundIdInput: string,
    immediate: boolean,
  ): Promise<{ row: RefundRow; leaseToken: string } | null> {
    const refundId = normalizeText(refundIdInput);
    return this.database.transaction(async (executor) => {
      const selected = await executor.query<RefundRow>(
        `SELECT ${refundColumns()} FROM saas_refund_orders WHERE id = $1 FOR UPDATE`,
        [refundId],
      );
      if (!rowsHaveOne(selected)) return null;
      const row = mapRefundRow(selected.rows[0]);
      const now = this.now();
      let nextState = row.state;
      if (row.state === 'submitting') {
        if (row.lease_action !== 'submit' || row.lease_expires_at === null) {
          throw new PaymentError('PAYMENT_STORAGE_ERROR');
        }
        if (normalizeTimestamp(row.lease_expires_at) > now.toISOString()) return null;
        // Expired submit claims are ambiguous. Reconciliation only queries PSP state.
        nextState = 'unknown';
      } else if (row.state === 'pending' || row.state === 'unknown') {
        if (!immediate && normalizeTimestamp(row.next_reconcile_at) > now.toISOString()) return null;
        if (
          row.lease_action === 'query' &&
          row.lease_expires_at !== null &&
          normalizeTimestamp(row.lease_expires_at) > now.toISOString()
        )
          return null;
      } else {
        return null;
      }

      const token = normalizeText(this.idFactory());
      const updated = await executor.query<RefundRow>(
        `UPDATE saas_refund_orders
         SET state = $2, lease_action = 'query', lease_token = $3, lease_expires_at = $4,
             updated_at = $5
         WHERE id = $1
         RETURNING ${refundColumns()}`,
        [refundId, nextState, token, addMs(now, this.leaseTtlMs), now.toISOString()],
      );
      if (!rowsHaveOne(updated)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      return { row: mapRefundRow(updated.rows[0]), leaseToken: token };
    });
  }

  private async persistProviderOutcome(
    refundId: string,
    action: 'submit' | 'query',
    leaseToken: string,
    status: PaymentRefundStatus,
    providerRefundId: string | null,
    failureCode: string | null,
  ): Promise<{ record: PaymentRefundRecord; status: PaymentRefundStatus }> {
    return this.database.transaction(async (executor) => {
      const hintedRefundType = await this.refundTypeHint(executor, refundId);
      if (hintedRefundType === 'byok_service_plan' && (status === 'succeeded' || status === 'failed')) {
        // The finalizer may update saas_project_entitlements. Take the global
        // fence before locking the refund row, then revalidate the hint after
        // the lock so the hint never becomes authority by itself.
        await this.fenceAuthorizationWriters(executor);
      }
      const selected = await executor.query<RefundRow>(
        `SELECT ${refundColumns()} FROM saas_refund_orders WHERE id = $1 FOR UPDATE`,
        [refundId],
      );
      if (!rowsHaveOne(selected)) throw new PaymentError('REFUND_NOT_FOUND');
      const row = mapRefundRow(selected.rows[0]);
      if (row.refund_type !== hintedRefundType) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      if (row.lease_action !== action || row.lease_token !== leaseToken) {
        return { record: toRecord(row), status: mapRefundStatus(row.state) };
      }

      let ledgerTransactionId: string | null = null;
      if (status === 'succeeded') {
        if (row.refund_type === 'wallet_topup') {
          if (row.wallet_id === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
          const posting = await this.walletRefundLedger.postVerifiedWalletRefund(executor, {
            tenantId: row.tenant_id,
            currency: row.currency,
            amountMinorUnits: parseStoredMinorUnits(row.amount_minor_units),
            refundOrderId: row.id,
          });
          ledgerTransactionId = posting.transactionId;
        } else {
          if (row.service_plan_effect_ref === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
          await this.servicePlans.finalizeRefundEntitlementEffect(executor, {
            tenantId: row.tenant_id,
            refundId: row.id,
            effectRef: row.service_plan_effect_ref,
            outcome: 'succeeded',
            occurredAt: this.now().toISOString(),
          });
        }
      } else if (status === 'failed' && row.refund_type === 'byok_service_plan') {
        if (row.service_plan_effect_ref === null) throw new PaymentError('PAYMENT_STORAGE_ERROR');
        await this.servicePlans.finalizeRefundEntitlementEffect(executor, {
          tenantId: row.tenant_id,
          refundId: row.id,
          effectRef: row.service_plan_effect_ref,
          outcome: 'failed',
          occurredAt: this.now().toISOString(),
        });
      }

      const completedAt = status === 'succeeded' || status === 'failed' ? this.now().toISOString() : null;
      const nextReconcileAt =
        status === 'pending' || status === 'unknown'
          ? status === 'unknown' && action === 'submit'
            ? this.now().toISOString()
            : addMs(this.now(), this.reconcileDelayMs)
          : this.now().toISOString();
      const updated = await executor.query<RefundRow>(
        `UPDATE saas_refund_orders
         SET state = $3,
             provider_refund_id = COALESCE(provider_refund_id, $4),
             failure_code = $5,
             wallet_refund_transaction_id = $6,
             lease_action = NULL, lease_token = NULL, lease_expires_at = NULL,
             next_reconcile_at = $7, updated_at = $8, completed_at = $9
         WHERE id = $1 AND lease_action = $2 AND lease_token = $10
         RETURNING ${refundColumns()}`,
        [
          refundId,
          action,
          status,
          providerRefundId,
          failureCode,
          ledgerTransactionId,
          nextReconcileAt,
          this.now().toISOString(),
          completedAt,
          leaseToken,
        ],
      );
      if (!rowsHaveOne(updated)) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      const finalized = mapRefundRow(updated.rows[0]);
      if (row.refund_type === 'wallet_topup' && (status === 'succeeded' || status === 'failed')) {
        await executor.query('DELETE FROM saas_refund_wallet_freezes WHERE refund_order_id = $1', [refundId]);
      }
      const originalOrderId = finalized.wallet_topup_order_id ?? finalized.service_plan_order_id;
      if (!originalOrderId) throw new PaymentError('PAYMENT_STORAGE_ERROR');
      await this.options.operations.recordAudit(executor, {
        actorId: null,
        tenantId: finalized.tenant_id,
        action: `payment.refund.${status}`,
        refundId,
        originalOrderId,
        amountMinorUnits: parseStoredMinorUnits(finalized.amount_minor_units).toString(),
        currency: finalized.currency,
        status,
        reasonCode: null,
      });
      return { record: toRecord(finalized), status };
    });
  }
}
