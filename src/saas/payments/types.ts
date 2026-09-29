import type { MinorUnitInput } from '../billing/money.js';
import type { VerifiedFundingInput } from '../billing/types.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { TenantContext } from '../identity/types.js';
import type {
  CreateServicePlanOrderInput,
  FulfilledServicePlanResult,
  ServicePlanOrderRecord,
  VerifiedServicePlanFulfillmentInput,
} from '../plans/types.js';

export type PaymentOrderType = 'wallet_topup';

export type PaymentRefundType = 'wallet_topup' | 'byok_service_plan';

export type PaymentRefundStatus = 'submitting' | 'pending' | 'succeeded' | 'failed' | 'unknown' | 'blocked';

/** Public, secret-free refund view. Monetary values are decimal minor-unit strings. */
export interface PaymentRefundRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly refundType: PaymentRefundType;
  readonly originalOrderId: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly status: PaymentRefundStatus;
  readonly providerRefundId: string | null;
  readonly failureCode: string | null;
  readonly blockedCode: string | null;
  readonly walletRefundTransactionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface RequestWalletTopUpRefundInput {
  readonly actorId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly reasonCode: string;
}

/** Platform initiated full refund; the amount is resolved from the locked order row. */
export type RequestPlatformWalletTopUpRefundInput = Omit<RequestWalletTopUpRefundInput, 'amountMinorUnits'> & {
  /** Authenticated platform session whose authority is rechecked in the refund transaction. */
  readonly sessionId: string;
  /** Exact role snapshot returned by platform authentication. */
  readonly actorRoles: readonly string[];
};

export interface RequestServicePlanRefundInput {
  readonly actorId: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly clientRequestId: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly reasonCode: string;
}

export interface PaymentProviderRefundInput {
  /** Stable local refund UUID. It is never replaced during recovery. */
  readonly localRefundId: string;
  /** Must equal localRefundId and be reused for every provider lookup. */
  readonly idempotencyReference: string;
  readonly tenantId: string;
  readonly originalLocalOrderId: string;
  readonly providerKey: string;
  readonly merchantId: string;
  readonly providerOrderId: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly providerRefundId: string | null;
}

export type PaymentProviderRefundStatus = 'pending' | 'succeeded' | 'failed';

/** Provider responses echo the immutable scope so the payment domain can reject mismatches. */
export type PaymentProviderRefundResult = Omit<PaymentProviderRefundInput, 'providerRefundId'> & {
  readonly providerRefundId: string | null;
  readonly status: PaymentProviderRefundStatus;
};

export type PaymentProviderRefundQueryResult = Omit<PaymentProviderRefundInput, 'providerRefundId'> & {
  readonly providerRefundId: string | null;
  readonly status: PaymentProviderRefundStatus | 'not_found' | 'unknown';
};

export interface PaymentRefundAuthorizationRequest {
  readonly actorId: string;
  readonly sessionId: string | null;
  readonly actorRoles: readonly string[] | null;
  readonly tenantId: string;
  readonly originalOrderId: string;
  readonly refundType: PaymentRefundType;
  readonly amountMinorUnits: string;
}

export interface PaymentRefundAuthorization {
  /** Opaque audit reference, not an authentication token or provider credential. */
  readonly authorizationRef: string;
}

/** Required production seam: authorize the operator and append the audit event using the supplied DB tx. */
export interface PaymentRefundOperationsPort {
  /** Authorization runs in the same transaction as refund creation and its audit event. */
  authorize(input: PaymentRefundAuthorizationRequest, executor: SqlExecutor): Promise<PaymentRefundAuthorization>;
  recordAudit(
    executor: SqlExecutor,
    input: {
      readonly actorId: string | null;
      readonly tenantId: string;
      readonly action: string;
      readonly refundId: string;
      readonly originalOrderId: string;
      readonly amountMinorUnits: string;
      readonly currency: string;
      readonly status: PaymentRefundStatus;
      readonly reasonCode: string | null;
    },
  ): Promise<void>;
}

/** Implemented by PlatformWalletLedgerService; callers must pass the shared transaction executor. */
export interface PaymentWalletRefundLedger {
  postVerifiedWalletRefund(
    executor: SqlExecutor,
    input: {
      readonly tenantId: string;
      readonly currency: string;
      readonly amountMinorUnits: MinorUnitInput;
      readonly refundOrderId: string;
    },
  ): Promise<{ readonly transactionId: string; readonly replayed: boolean }>;
}

export interface PaymentRefundWorkerBatchResult {
  readonly claimed: number;
  readonly queried: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unresolved: number;
}

export type PaymentCheckoutAction =
  | {
      readonly kind: 'redirect';
      readonly url: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: 'qr';
      readonly text: string;
      readonly expiresAt: string;
    };

export type PaymentCheckoutView =
  | {
      readonly status: 'ready';
      readonly action: PaymentCheckoutAction;
    }
  | {
      readonly status: 'pending' | 'unavailable' | 'expired' | 'closed';
      readonly action: null;
    };

/** Explicit provider-specific redirect policy. No policy means no redirect action is exposed. */
export interface PaymentCheckoutRedirectPolicy {
  readonly providerKey: string;
  readonly origin: string;
  readonly pathPrefixes: readonly string[];
}

export interface PaymentCheckoutOptions {
  readonly redirectPolicies?: readonly PaymentCheckoutRedirectPolicy[];
  readonly maxQrTextLength?: number;
}

/** Customer wallet top-up admission limits, supplied by the deployment. */
export interface PaymentWalletTopUpPolicy {
  readonly currency: string;
  readonly minAmountMinorUnits: string;
  readonly maxAmountMinorUnits: string;
}

export type PaymentOrderStatus =
  | 'created'
  | 'pending'
  | 'provider_failed'
  | 'paid'
  | 'fulfilling'
  | 'fulfilled'
  | 'cancelled'
  | 'reconciliation_pending';

export type PaymentProviderEventStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export type PaymentInboxOutcome = 'accepted' | 'fulfilled' | 'replayed' | 'reconciliation' | 'rejected';

/** Public order representation; amounts stay decimal strings to preserve integer precision over JSON. */
export interface PaymentOrderRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly orderType: PaymentOrderType;
  readonly providerKey: string;
  readonly merchantId: string;
  readonly clientRequestId: string;
  readonly localOrderRef: string;
  readonly fundingReference: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly status: PaymentOrderStatus;
  readonly providerOrderId: string | null;
  readonly providerAttempts: number;
  readonly providerFailureCode: string | null;
  readonly fundingTransactionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly paidAt: string | null;
  readonly fulfilledAt: string | null;
  readonly checkout: PaymentCheckoutView;
}

export interface CreateWalletTopUpInput {
  readonly tenantId: string;
  readonly clientRequestId: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly currency: string;
}

export interface ReadWalletTopUpInput {
  readonly tenantId: string;
  readonly orderId: string;
}

export interface RetryPaymentOrderInput extends ReadWalletTopUpInput {}

export type CreateServicePlanPaymentInput = CreateServicePlanOrderInput;

export interface ReadServicePlanPaymentInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly orderId: string;
}

export type RetryServicePlanPaymentInput = ReadServicePlanPaymentInput;

/** Public payment view of the immutable BYOK service-plan order snapshot. */
export interface ServicePlanPaymentOrderRecord extends ServicePlanOrderRecord {
  readonly orderType: 'byok_service_plan';
  readonly providerKey: string;
  readonly merchantId: string;
  readonly providerOrderId: string | null;
  readonly providerAttempts: number;
  readonly providerFailureCode: string | null;
  readonly checkout: PaymentCheckoutView;
}

/** The payment domain may only fulfill through this narrow existing plan-domain seam. */
export interface ServicePlanPaymentService {
  createOrder(context: TenantContext, input: CreateServicePlanOrderInput): Promise<ServicePlanOrderRecord>;
  getOrder(context: TenantContext, orderId: string): Promise<ServicePlanOrderRecord | null>;
  fulfillVerified(input: VerifiedServicePlanFulfillmentInput): Promise<FulfilledServicePlanResult>;
}

export interface PaymentProviderCreateOrderInput {
  readonly localOrderId: string;
  readonly tenantId: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly merchantId: string;
  /** Must be the local order id; PSP adapters may pass this to their native idempotency field. */
  readonly idempotencyReference: string;
}

export interface PaymentProviderCreateOrderResult {
  readonly providerOrderId: string;
  readonly amountMinorUnits: MinorUnitInput;
  readonly currency: string;
  /** Provider-normalized, never raw, customer checkout action. */
  readonly checkoutAction?: PaymentCheckoutAction;
  /** Short alias accepted for adapters that name the normalized field `action`. */
  readonly action?: PaymentCheckoutAction;
  /** Compatibility alias for adapters that use the public field name for the normalized action. */
  readonly checkout?: PaymentCheckoutAction;
}

export interface PaymentProviderCheckoutRefreshInput {
  readonly localOrderId: string;
  readonly tenantId: string;
  readonly providerOrderId: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly merchantId: string;
}

export type PaymentProviderCheckoutRefreshResult =
  | PaymentProviderCreateOrderResult
  | PaymentCheckoutAction
  | {
      readonly checkoutAction?: PaymentCheckoutAction;
      readonly action?: PaymentCheckoutAction;
      readonly checkout?: PaymentCheckoutAction;
      readonly providerOrderId?: string;
      readonly amountMinorUnits?: MinorUnitInput;
      readonly currency?: string;
    };

/** A recovery lookup is safe only when the adapter documents same-order recovery semantics. */
export interface PaymentProviderOrderRecoveryInput {
  readonly localOrderId: string;
  readonly tenantId: string;
  readonly amountMinorUnits: string;
  readonly currency: string;
  readonly merchantId: string;
  readonly idempotencyReference: string;
}

export type PaymentWebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface PaymentProviderWebhookVerificationInput {
  readonly headers: PaymentWebhookHeaders;
  readonly rawBody: Buffer;
  readonly merchantId: string;
}

/** The verified payload is adapter-owned and is never persisted or logged by the payment service. */
export interface VerifiedPaymentProviderWebhook {
  readonly providerKey: string;
  readonly merchantId: string;
  readonly payload: unknown;
}

export interface NormalizedPaymentProviderEvent {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly providerOrderId: string;
  readonly tenantId: string;
  readonly merchantId: string;
  readonly status: PaymentProviderEventStatus;
  readonly amountMinorUnits: MinorUnitInput;
  readonly currency: string;
  readonly occurredAt: string | Date;
}

export interface PaymentWebhookResult {
  readonly outcome: PaymentInboxOutcome;
  readonly replayed: boolean;
  readonly inboxId: string;
  readonly orderId: string | null;
  readonly fundingTransactionId: string | null;
}

export interface PaymentWebhookWorkerBatchResult {
  readonly claimed: number;
  readonly processed: number;
  readonly retrying: number;
  readonly exhausted: number;
}

export type PaymentDatabase = Pick<SaasDatabase, 'query' | 'transaction'>;

export interface PaymentWalletFundingLedger {
  postVerifiedFunding(
    executor: SqlExecutor,
    input: VerifiedFundingInput,
  ): Promise<{
    readonly outcome: 'posted';
    readonly replayed: boolean;
    readonly transactionId: string;
  }>;
}

export interface PaymentServiceOptions {
  readonly providerKey: string;
  readonly merchantId: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly walletFundingLedger?: PaymentWalletFundingLedger;
  readonly servicePlanService?: ServicePlanPaymentService;
  readonly checkout?: PaymentCheckoutOptions;
  /** Compatibility alias for callers that configure payment policy directly. */
  readonly checkoutRedirectPolicies?: readonly PaymentCheckoutRedirectPolicy[];
  readonly submissionLeaseTtlMs?: number;
  /** Maximum number of PSP create submissions for one local order. */
  readonly maxProviderAttempts?: number;
  /** Delay after an explicitly safe rejection before another create submission. */
  readonly retryCooldownMs?: number;
}
