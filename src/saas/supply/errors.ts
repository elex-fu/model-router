export type ProviderSupplyErrorCode =
  | 'INVALID_INPUT'
  | 'SUPPLY_STORAGE_ERROR'
  | 'ACCOUNT_EXISTS'
  | 'PROVIDER_CATALOG_CONFLICT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_STATE_CONFLICT'
  | 'ACCOUNT_REVOKED'
  | 'INVALID_ACCOUNT_LIFECYCLE'
  | 'CREDENTIAL_EXISTS'
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_STATE_CONFLICT'
  | 'CREDENTIAL_REVOKED'
  | 'INVALID_CREDENTIAL_LIFECYCLE'
  | 'CREDENTIAL_VERSION_CONFLICT'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_EXPIRED'
  | 'VALIDATION_REQUIRED'
  | 'KMS_SEAL_FAILED'
  | 'KMS_UNSEAL_FAILED'
  | 'KMS_REWRAP_FAILED';

const SAFE_MESSAGES: Record<ProviderSupplyErrorCode, string> = {
  INVALID_INPUT: 'The provider supply request contains invalid data.',
  SUPPLY_STORAGE_ERROR: 'The provider supply request could not be stored.',
  ACCOUNT_EXISTS: 'That provider account already exists.',
  PROVIDER_CATALOG_CONFLICT:
    'The provider catalog changed while this account was being created. Refresh the catalog and retry.',
  ACCOUNT_NOT_FOUND: 'The requested provider account is not registered.',
  ACCOUNT_STATE_CONFLICT: 'The provider account changed before this operation completed.',
  ACCOUNT_REVOKED: 'The provider account has been revoked.',
  INVALID_ACCOUNT_LIFECYCLE: 'The provider account lifecycle transition is not permitted.',
  CREDENTIAL_EXISTS: 'That provider credential already exists.',
  CREDENTIAL_NOT_FOUND: 'The requested provider credential is not registered.',
  CREDENTIAL_STATE_CONFLICT: 'The provider credential changed before this operation completed.',
  CREDENTIAL_REVOKED: 'The provider credential has been revoked.',
  INVALID_CREDENTIAL_LIFECYCLE: 'The provider credential lifecycle transition is not permitted.',
  CREDENTIAL_VERSION_CONFLICT: 'The provider credential version conflicts with existing supply data.',
  CREDENTIAL_UNAVAILABLE: 'The provider credential is not available for this workload.',
  CREDENTIAL_EXPIRED: 'The provider credential has expired.',
  VALIDATION_REQUIRED: 'The provider credential must be validated before it can be used.',
  KMS_SEAL_FAILED: 'The provider credential could not be sealed.',
  KMS_UNSEAL_FAILED: 'The provider credential could not be unsealed.',
  KMS_REWRAP_FAILED: 'The provider credential wrapper could not be rewrapped.',
};

const STATUS: Record<ProviderSupplyErrorCode, number> = {
  INVALID_INPUT: 400,
  SUPPLY_STORAGE_ERROR: 500,
  ACCOUNT_EXISTS: 409,
  PROVIDER_CATALOG_CONFLICT: 409,
  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_STATE_CONFLICT: 409,
  ACCOUNT_REVOKED: 409,
  INVALID_ACCOUNT_LIFECYCLE: 409,
  CREDENTIAL_EXISTS: 409,
  CREDENTIAL_NOT_FOUND: 404,
  CREDENTIAL_STATE_CONFLICT: 409,
  CREDENTIAL_REVOKED: 409,
  INVALID_CREDENTIAL_LIFECYCLE: 409,
  CREDENTIAL_VERSION_CONFLICT: 409,
  CREDENTIAL_UNAVAILABLE: 409,
  CREDENTIAL_EXPIRED: 409,
  VALIDATION_REQUIRED: 409,
  KMS_SEAL_FAILED: 503,
  KMS_UNSEAL_FAILED: 503,
  KMS_REWRAP_FAILED: 503,
};

export class ProviderSupplyError extends Error {
  readonly status: number;
  readonly code: ProviderSupplyErrorCode;

  constructor(code: ProviderSupplyErrorCode, message = SAFE_MESSAGES[code]) {
    super(message);
    this.name = 'ProviderSupplyError';
    this.status = STATUS[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
