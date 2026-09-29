export type SaasCatalogErrorCode =
  | 'INVALID_INPUT'
  | 'CATALOG_STORAGE_ERROR'
  | 'PROVIDER_PRODUCT_EXISTS'
  | 'PROVIDER_PRODUCT_NOT_FOUND'
  | 'PUBLIC_MODEL_ALIAS_EXISTS'
  | 'PUBLIC_MODEL_ALIAS_NOT_FOUND'
  | 'CAPABILITY_VERSION_CONFLICT'
  | 'RIGHTS_VERSION_CONFLICT'
  | 'RIGHTS_NOT_FOUND'
  | 'INVALID_RIGHTS_STATUS_TRANSITION';

const SAFE_CATALOG_MESSAGES: Record<SaasCatalogErrorCode, string> = {
  INVALID_INPUT: 'The provider catalog request contains invalid data.',
  CATALOG_STORAGE_ERROR: 'The provider catalog could not complete the request.',
  PROVIDER_PRODUCT_EXISTS: 'That provider product is already registered.',
  PROVIDER_PRODUCT_NOT_FOUND: 'The requested provider product is not registered.',
  PUBLIC_MODEL_ALIAS_EXISTS: 'That public model alias is already registered.',
  PUBLIC_MODEL_ALIAS_NOT_FOUND: 'The requested public model alias is not registered.',
  CAPABILITY_VERSION_CONFLICT: 'The provider capability version conflicts with existing catalog data.',
  RIGHTS_VERSION_CONFLICT: 'The provider rights version conflicts with existing catalog data.',
  RIGHTS_NOT_FOUND: 'The requested provider rights record is not registered.',
  INVALID_RIGHTS_STATUS_TRANSITION: 'The provider rights status transition is not permitted.',
};

const CATALOG_ERROR_STATUS: Record<SaasCatalogErrorCode, number> = {
  INVALID_INPUT: 400,
  CATALOG_STORAGE_ERROR: 500,
  PROVIDER_PRODUCT_EXISTS: 409,
  PROVIDER_PRODUCT_NOT_FOUND: 404,
  PUBLIC_MODEL_ALIAS_EXISTS: 409,
  PUBLIC_MODEL_ALIAS_NOT_FOUND: 404,
  CAPABILITY_VERSION_CONFLICT: 409,
  RIGHTS_VERSION_CONFLICT: 409,
  RIGHTS_NOT_FOUND: 404,
  INVALID_RIGHTS_STATUS_TRANSITION: 409,
};

export class SaasCatalogError extends Error {
  readonly status: number;
  readonly code: SaasCatalogErrorCode;

  constructor(code: SaasCatalogErrorCode) {
    super(SAFE_CATALOG_MESSAGES[code]);
    this.name = 'SaasCatalogError';
    this.status = CATALOG_ERROR_STATUS[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
