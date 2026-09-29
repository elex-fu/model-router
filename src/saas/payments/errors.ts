export type PaymentErrorCode =
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_STATE_CONFLICT'
  | 'PROVIDER_CREATE_FAILED'
  | 'PROVIDER_RESULT_INVALID'
  | 'PAYMENT_STORAGE_ERROR'
  | 'WEBHOOK_REJECTED'
  | 'WEBHOOK_INVALID'
  | 'PAYMENT_EVENT_CONFLICT'
  | 'FULFILLMENT_RETRYABLE'
  | 'REFUND_NOT_FOUND'
  | 'REFUND_FORBIDDEN'
  | 'REFUND_STATE_CONFLICT'
  | 'REFUND_AMOUNT_EXCEEDS_AVAILABLE'
  | 'REFUND_PROVIDER_UNAVAILABLE'
  | 'SERVICE_PLAN_REFUND_BLOCKED';

const SAFE_MESSAGES: Record<PaymentErrorCode, string> = {
  INVALID_INPUT: 'The payment request contains invalid data.',
  IDEMPOTENCY_CONFLICT: 'The payment request conflicts with an existing order.',
  ORDER_NOT_FOUND: 'The payment order was not found.',
  ORDER_STATE_CONFLICT: 'The payment order cannot be changed in its current state.',
  PROVIDER_CREATE_FAILED: 'The payment provider could not create the order.',
  PROVIDER_RESULT_INVALID: 'The payment provider returned an invalid order result.',
  PAYMENT_STORAGE_ERROR: 'The payment service could not complete the request.',
  WEBHOOK_REJECTED: 'The payment webhook was rejected.',
  WEBHOOK_INVALID: 'The payment webhook is invalid.',
  PAYMENT_EVENT_CONFLICT: 'The payment event conflicts with a previously received event.',
  FULFILLMENT_RETRYABLE: 'Payment fulfillment could not be completed and will be retried.',
  REFUND_NOT_FOUND: 'The refund was not found.',
  REFUND_FORBIDDEN: 'The operation is not permitted.',
  REFUND_STATE_CONFLICT: 'The refund conflicts with an existing request.',
  REFUND_AMOUNT_EXCEEDS_AVAILABLE: 'The refund exceeds the refundable amount.',
  REFUND_PROVIDER_UNAVAILABLE: 'The configured payment provider does not support refunds.',
  SERVICE_PLAN_REFUND_BLOCKED: 'The service plan refund requires an entitlement policy and operator review.',
};

const ERROR_STATUS: Record<PaymentErrorCode, number> = {
  INVALID_INPUT: 400,
  IDEMPOTENCY_CONFLICT: 409,
  ORDER_NOT_FOUND: 404,
  ORDER_STATE_CONFLICT: 409,
  PROVIDER_CREATE_FAILED: 503,
  PROVIDER_RESULT_INVALID: 502,
  PAYMENT_STORAGE_ERROR: 500,
  WEBHOOK_REJECTED: 400,
  WEBHOOK_INVALID: 400,
  PAYMENT_EVENT_CONFLICT: 409,
  FULFILLMENT_RETRYABLE: 503,
  REFUND_NOT_FOUND: 404,
  REFUND_FORBIDDEN: 403,
  REFUND_STATE_CONFLICT: 409,
  REFUND_AMOUNT_EXCEEDS_AVAILABLE: 409,
  REFUND_PROVIDER_UNAVAILABLE: 503,
  SERVICE_PLAN_REFUND_BLOCKED: 409,
};

export class PaymentError extends Error {
  readonly status: number;
  readonly code: PaymentErrorCode;

  constructor(code: PaymentErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'PaymentError';
    this.status = ERROR_STATUS[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPaymentError(value: unknown): value is PaymentError {
  return value instanceof PaymentError;
}
