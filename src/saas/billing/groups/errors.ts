export type SaasBillingGroupsErrorCode =
  | 'INVALID_INPUT'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_INACTIVE'
  | 'GROUP_STORAGE_ERROR'
  | 'INVALID_MULTIPLIER'
  | 'INVALID_OVERRIDE'
  | 'AMOUNT_OVERFLOW'
  | 'GROUP_CONFLICT'
  | 'TARGET_NOT_FOUND'
  | 'GROUP_SPEND_STORAGE_ERROR'
  | 'GROUP_SPEND_CURRENCY_MISMATCH'
  | 'GROUP_SPEND_EXCEEDED';

const SAFE_MESSAGES: Record<SaasBillingGroupsErrorCode, string> = {
  INVALID_INPUT: 'The billing group request contains invalid data.',
  GROUP_NOT_FOUND: 'The billing group was not found.',
  GROUP_INACTIVE: 'The billing group is not active.',
  GROUP_STORAGE_ERROR: 'The billing group service could not complete the request.',
  INVALID_MULTIPLIER: 'The billing group multiplier is invalid.',
  INVALID_OVERRIDE: 'The billing group model pricing override is invalid.',
  AMOUNT_OVERFLOW: 'The multiplied billing amount is outside the supported range.',
  GROUP_CONFLICT: 'The billing group change conflicts with existing data.',
  TARGET_NOT_FOUND: 'The billing group binding target was not found.',
  GROUP_SPEND_STORAGE_ERROR: 'The billing group spend window state is unavailable.',
  GROUP_SPEND_CURRENCY_MISMATCH: 'The billing group spend window currencies do not match.',
  GROUP_SPEND_EXCEEDED: 'The billing group spend limit is exhausted.',
};

export class SaasBillingGroupsError extends Error {
  readonly code: SaasBillingGroupsErrorCode;

  constructor(code: SaasBillingGroupsErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'SaasBillingGroupsError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSaasBillingGroupsError(error: unknown): error is SaasBillingGroupsError {
  return error instanceof SaasBillingGroupsError;
}
