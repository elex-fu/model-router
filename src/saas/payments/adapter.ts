import type {
  NormalizedPaymentProviderEvent,
  PaymentProviderCheckoutRefreshInput,
  PaymentProviderCheckoutRefreshResult,
  PaymentProviderCreateOrderInput,
  PaymentProviderCreateOrderResult,
  PaymentProviderOrderRecoveryInput,
  PaymentProviderRefundInput,
  PaymentProviderRefundQueryResult,
  PaymentProviderRefundResult,
  PaymentProviderWebhookVerificationInput,
  VerifiedPaymentProviderWebhook,
} from './types.js';

/** Refund errors may release a freeze only when the adapter proves no refund was accepted. */
export interface PaymentProviderRefundSubmissionErrorDetails {
  readonly acceptance: 'not_accepted' | 'unknown';
}

/**
 * PSP refund seam. The adapter is bound to one merchant. It must verify all
 * immutable request fields, use idempotencyReference for submit, and query by
 * that same reference. A `not_found` query result is not proof of rejection.
 */
export interface PaymentProviderRefundAdapter {
  readonly providerKey: string;
  readonly merchantId: string;
  submitRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundResult>;
  queryRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult>;
}

/**
 * Provider create failures must state whether the PSP definitively rejected
 * the request.  Missing or unknown acceptance is never safe to retry.
 */
export type PaymentProviderSubmissionAcceptance = 'rejected' | 'not_accepted' | 'unknown';

/**
 * Structural error details that adapters may attach to a create failure.
 * `retryable`/`safeToRetry` are intentionally opt-in; transport status alone
 * cannot prove that a charge was not accepted.
 */
export interface PaymentProviderSubmissionErrorDetails {
  readonly acceptance: PaymentProviderSubmissionAcceptance;
  readonly retryable?: boolean;
  readonly safeToRetry?: boolean;
}

/** PSP-neutral seam. Implementations own credentials, signature rules, and provider payload parsing. */
export interface PaymentProviderAdapter {
  readonly providerKey: string;
  /**
   * On create failure, adapters should attach PaymentProviderSubmissionErrorDetails.
   * Without an explicit definitive rejection the payment service fences the
   * order for reconciliation instead of submitting it again.
   */
  createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult>;
  /** Refreshes checkout for the existing provider order; it must never create a charge. */
  refreshCheckout?(input: PaymentProviderCheckoutRefreshInput): Promise<PaymentProviderCheckoutRefreshResult>;
  /** Alias for integrations that name the same operation after its order scope. */
  refreshOrderCheckout?(input: PaymentProviderCheckoutRefreshInput): Promise<PaymentProviderCheckoutRefreshResult>;
  /**
   * Optional, explicitly idempotent same-order recovery for an ambiguous
   * create response. It must query/recover the existing PSP order and never
   * create a second charge.
   */
  recoverOrder?(input: PaymentProviderOrderRecoveryInput): Promise<PaymentProviderCreateOrderResult | null>;
  verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook>;
  normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent;
}
