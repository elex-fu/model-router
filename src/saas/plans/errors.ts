export type ServicePlanErrorCode =
  | 'INVALID_INPUT'
  | 'ACCESS_DENIED'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_VERSION_UNAVAILABLE'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_CONFLICT'
  | 'ORDER_STATE_CONFLICT'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'SUBSCRIPTION_STATE_CONFLICT'
  | 'ACTIVE_SUBSCRIPTION_EXISTS'
  | 'FULFILLMENT_REQUIRED'
  | 'FULFILLMENT_CONFLICT'
  | 'ENTITLEMENT_UNAVAILABLE'
  | 'SUBSCRIPTION_NOT_DUE'
  | 'STORAGE_ERROR';

const SAFE_MESSAGES: Record<ServicePlanErrorCode, string> = {
  INVALID_INPUT: 'The service plan request contains invalid data.',
  ACCESS_DENIED: 'The service plan operation is not permitted.',
  PLAN_NOT_FOUND: 'The service plan was not found.',
  PLAN_VERSION_UNAVAILABLE: 'The service plan version is not available.',
  ORDER_NOT_FOUND: 'The service plan order was not found.',
  ORDER_CONFLICT: 'The service plan order conflicts with an existing request.',
  ORDER_STATE_CONFLICT: 'The service plan order cannot change in its current state.',
  SUBSCRIPTION_NOT_FOUND: 'The service plan subscription was not found.',
  SUBSCRIPTION_STATE_CONFLICT: 'The service plan subscription cannot change in its current state.',
  ACTIVE_SUBSCRIPTION_EXISTS: 'An active BYOK service plan already exists for this project.',
  FULFILLMENT_REQUIRED: 'A verified server fulfillment record is required.',
  FULFILLMENT_CONFLICT: 'The verified fulfillment record conflicts with the plan order.',
  ENTITLEMENT_UNAVAILABLE: 'The BYOK supply entitlement is not currently available.',
  SUBSCRIPTION_NOT_DUE: 'The service plan subscription is not due to expire.',
  STORAGE_ERROR: 'The service plan service could not complete the request.',
};

const ERROR_STATUS: Record<ServicePlanErrorCode, number> = {
  INVALID_INPUT: 400,
  ACCESS_DENIED: 403,
  PLAN_NOT_FOUND: 404,
  PLAN_VERSION_UNAVAILABLE: 409,
  ORDER_NOT_FOUND: 404,
  ORDER_CONFLICT: 409,
  ORDER_STATE_CONFLICT: 409,
  SUBSCRIPTION_NOT_FOUND: 404,
  SUBSCRIPTION_STATE_CONFLICT: 409,
  ACTIVE_SUBSCRIPTION_EXISTS: 409,
  FULFILLMENT_REQUIRED: 403,
  FULFILLMENT_CONFLICT: 409,
  ENTITLEMENT_UNAVAILABLE: 503,
  SUBSCRIPTION_NOT_DUE: 409,
  STORAGE_ERROR: 500,
};

export class ServicePlanError extends Error {
  readonly status: number;
  readonly code: ServicePlanErrorCode;

  constructor(code: ServicePlanErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ServicePlanError';
    this.status = ERROR_STATUS[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isServicePlanError(value: unknown): value is ServicePlanError {
  return value instanceof ServicePlanError;
}
