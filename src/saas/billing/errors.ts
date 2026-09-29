export type SaasBillingErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CURRENCY'
  | 'INVALID_AMOUNT'
  | 'EXECUTOR_REQUIRED'
  | 'BYOK_WALLET_FORBIDDEN'
  | 'BILLING_STORAGE_ERROR'
  | 'WALLET_NOT_FOUND'
  | 'RESERVATION_NOT_FOUND'
  | 'RESERVATION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INSUFFICIENT_FUNDS'
  | 'SPENDING_FROZEN'
  | 'RESERVATION_STATE_CONFLICT'
  | 'RECONCILIATION_REQUIRED'
  | 'FUNDING_REFERENCE_REQUIRED';

const SAFE_MESSAGES: Record<SaasBillingErrorCode, string> = {
  INVALID_INPUT: 'The billing request contains invalid data.',
  INVALID_CURRENCY: 'The billing currency is invalid.',
  INVALID_AMOUNT: 'The billing amount is invalid.',
  EXECUTOR_REQUIRED: 'Billing operations require a caller-owned transaction executor.',
  BYOK_WALLET_FORBIDDEN: 'BYOK requests cannot use the platform wallet.',
  BILLING_STORAGE_ERROR: 'The billing service could not complete the request.',
  WALLET_NOT_FOUND: 'The platform wallet is not available for this tenant and currency.',
  RESERVATION_NOT_FOUND: 'The billing reservation was not found.',
  RESERVATION_CONFLICT: 'The billing reservation conflicts with an existing operation.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key conflicts with an existing billing operation.',
  INSUFFICIENT_FUNDS: 'The platform wallet does not have enough available funds.',
  SPENDING_FROZEN: 'Platform spending is temporarily frozen pending reconciliation.',
  RESERVATION_STATE_CONFLICT: 'The billing reservation is already in a different terminal state.',
  RECONCILIATION_REQUIRED: 'The billing operation requires reconciliation evidence before it can finish.',
  FUNDING_REFERENCE_REQUIRED: 'Verified funding requires an immutable source or order reference.',
};

const ERROR_STATUS: Record<SaasBillingErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_CURRENCY: 400,
  INVALID_AMOUNT: 400,
  EXECUTOR_REQUIRED: 500,
  BYOK_WALLET_FORBIDDEN: 400,
  BILLING_STORAGE_ERROR: 500,
  WALLET_NOT_FOUND: 404,
  RESERVATION_NOT_FOUND: 404,
  RESERVATION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_FUNDS: 409,
  SPENDING_FROZEN: 409,
  RESERVATION_STATE_CONFLICT: 409,
  RECONCILIATION_REQUIRED: 409,
  FUNDING_REFERENCE_REQUIRED: 400,
};

export class SaasBillingError extends Error {
  readonly code: SaasBillingErrorCode;
  readonly status: number;

  constructor(code: SaasBillingErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'SaasBillingError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSaasBillingError(error: unknown): error is SaasBillingError {
  return error instanceof SaasBillingError;
}
