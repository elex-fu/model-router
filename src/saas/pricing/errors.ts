export type SaasPricingErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CURRENCY'
  | 'INVALID_RATE'
  | 'INVALID_WINDOW'
  | 'PRICE_VERSION_NOT_FOUND'
  | 'PRICE_VERSION_NOT_EFFECTIVE'
  | 'PRICE_VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SNAPSHOT_CONFLICT'
  | 'PRICING_STORAGE_ERROR'
  | 'USAGE_INCOMPLETE'
  | 'PRICE_RATE_MISSING'
  | 'PRICE_AMOUNT_OVERFLOW'
  | 'CURRENCY_MISMATCH'
  | 'PLATFORM_REQUEST_REQUIRED'
  | 'REQUEST_BINDING_MISMATCH'
  | 'SUPPLIER_ACCOUNT_NOT_FOUND'
  | 'SUPPLIER_ATTEMPT_BINDING_UNAVAILABLE'
  | 'SUPPLIER_ATTEMPT_BINDING_MISMATCH'
  | 'ZERO_PRICE_NOT_RESERVABLE';

const SAFE_MESSAGES: Record<SaasPricingErrorCode, string> = {
  INVALID_INPUT: 'The pricing request contains invalid data.',
  INVALID_CURRENCY: 'The pricing currency is invalid.',
  INVALID_RATE: 'The pricing rate is invalid.',
  INVALID_WINDOW: 'The pricing effective window is invalid.',
  PRICE_VERSION_NOT_FOUND: 'The requested pricing version was not found.',
  PRICE_VERSION_NOT_EFFECTIVE: 'No pricing version is effective for the requested time.',
  PRICE_VERSION_CONFLICT: 'The pricing version conflicts with existing pricing data.',
  IDEMPOTENCY_CONFLICT: 'The pricing idempotency key conflicts with a different append.',
  SNAPSHOT_CONFLICT: 'The pricing snapshot conflicts with an existing request snapshot.',
  PRICING_STORAGE_ERROR: 'The pricing service could not complete the request.',
  USAGE_INCOMPLETE: 'The usage evidence is incomplete for exact pricing.',
  PRICE_RATE_MISSING: 'The pricing version does not define a required rate.',
  PRICE_AMOUNT_OVERFLOW: 'The calculated pricing amount is outside the supported range.',
  CURRENCY_MISMATCH: 'The pricing currencies cannot be combined.',
  PLATFORM_REQUEST_REQUIRED: 'Commercial pricing snapshots require a platform-supplied request.',
  REQUEST_BINDING_MISMATCH: 'The pricing snapshot does not match its request protocol or endpoint.',
  SUPPLIER_ACCOUNT_NOT_FOUND: 'The selected platform provider account is not registered for this provider product.',
  SUPPLIER_ATTEMPT_BINDING_UNAVAILABLE:
    'The current attempt contract does not expose the platform account, provider, product, and endpoint binding required for supplier pricing.',
  SUPPLIER_ATTEMPT_BINDING_MISMATCH:
    'The selected platform account and supplier pricing identity do not match the request attempt.',
  ZERO_PRICE_NOT_RESERVABLE: 'A zero-priced admission hold cannot be reserved by billing.',
};

const ERROR_STATUS: Record<SaasPricingErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_CURRENCY: 400,
  INVALID_RATE: 400,
  INVALID_WINDOW: 400,
  PRICE_VERSION_NOT_FOUND: 404,
  PRICE_VERSION_NOT_EFFECTIVE: 404,
  PRICE_VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SNAPSHOT_CONFLICT: 409,
  PRICING_STORAGE_ERROR: 500,
  USAGE_INCOMPLETE: 409,
  PRICE_RATE_MISSING: 409,
  PRICE_AMOUNT_OVERFLOW: 409,
  CURRENCY_MISMATCH: 409,
  PLATFORM_REQUEST_REQUIRED: 409,
  REQUEST_BINDING_MISMATCH: 409,
  SUPPLIER_ACCOUNT_NOT_FOUND: 409,
  SUPPLIER_ATTEMPT_BINDING_UNAVAILABLE: 409,
  SUPPLIER_ATTEMPT_BINDING_MISMATCH: 409,
  ZERO_PRICE_NOT_RESERVABLE: 409,
};

export class SaasPricingError extends Error {
  readonly status: number;
  readonly code: SaasPricingErrorCode;

  constructor(code: SaasPricingErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'SaasPricingError';
    this.status = ERROR_STATUS[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSaasPricingError(error: unknown): error is SaasPricingError {
  return error instanceof SaasPricingError;
}
