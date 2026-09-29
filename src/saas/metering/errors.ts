export type SaasMeteringErrorCode =
  | 'METERING_INVALID_INPUT'
  | 'METERING_STORAGE_ERROR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_TOMBSTONED'
  | 'REQUEST_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_ORDINAL_CONFLICT'
  | 'ATTEMPT_TRANSITION_INVALID'
  | 'REQUEST_TRANSITION_INVALID'
  | 'USAGE_EVENT_NOT_FOUND'
  | 'USAGE_DUPLICATE_CONFLICT'
  | 'USAGE_SETTLEMENT_CONFLICT';

const messages: Record<SaasMeteringErrorCode, string> = {
  METERING_INVALID_INPUT: 'The metering request contains invalid data.',
  METERING_STORAGE_ERROR: 'The metering service could not complete the request.',
  IDEMPOTENCY_CONFLICT: 'The idempotency key is already bound to a different request fingerprint.',
  IDEMPOTENCY_TOMBSTONED: 'The idempotency key has been retired and cannot be reused.',
  REQUEST_NOT_FOUND: 'The requested SaaS request was not found.',
  ATTEMPT_NOT_FOUND: 'The requested SaaS attempt was not found.',
  ATTEMPT_ORDINAL_CONFLICT: 'The request attempt ordinal is already allocated.',
  ATTEMPT_TRANSITION_INVALID: 'The SaaS attempt state transition is not permitted.',
  REQUEST_TRANSITION_INVALID: 'The SaaS request state transition is not permitted.',
  USAGE_EVENT_NOT_FOUND: 'The requested usage event was not found.',
  USAGE_DUPLICATE_CONFLICT: 'The usage event key is already bound to different canonical usage.',
  USAGE_SETTLEMENT_CONFLICT: 'The usage settlement key is already bound to a different effect.',
};

const statuses: Record<SaasMeteringErrorCode, number> = {
  METERING_INVALID_INPUT: 400,
  METERING_STORAGE_ERROR: 500,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_TOMBSTONED: 409,
  REQUEST_NOT_FOUND: 404,
  ATTEMPT_NOT_FOUND: 404,
  ATTEMPT_ORDINAL_CONFLICT: 409,
  ATTEMPT_TRANSITION_INVALID: 409,
  REQUEST_TRANSITION_INVALID: 409,
  USAGE_EVENT_NOT_FOUND: 404,
  USAGE_DUPLICATE_CONFLICT: 409,
  USAGE_SETTLEMENT_CONFLICT: 409,
};

export class SaasMeteringError extends Error {
  readonly status: number;
  readonly code: SaasMeteringErrorCode;

  constructor(code: SaasMeteringErrorCode, cause?: unknown) {
    super(messages[code], cause === undefined ? undefined : { cause });
    this.name = 'SaasMeteringError';
    this.status = statuses[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
