export type PlatformCatalogGovernanceErrorCode = 'INVALID_INPUT' | 'CATALOG_STORAGE_ERROR';

const SAFE_MESSAGES: Record<PlatformCatalogGovernanceErrorCode, string> = {
  INVALID_INPUT: 'The platform catalog query contains invalid data.',
  CATALOG_STORAGE_ERROR: 'The platform catalog query could not be completed.',
};

const ERROR_STATUS: Record<PlatformCatalogGovernanceErrorCode, number> = {
  INVALID_INPUT: 400,
  CATALOG_STORAGE_ERROR: 500,
};

export class PlatformCatalogGovernanceError extends Error {
  readonly code: PlatformCatalogGovernanceErrorCode;
  readonly status: number;

  constructor(code: PlatformCatalogGovernanceErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'PlatformCatalogGovernanceError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPlatformCatalogGovernanceError(error: unknown): error is PlatformCatalogGovernanceError {
  return error instanceof PlatformCatalogGovernanceError;
}

export {
  PlatformCatalogGovernanceError as PlatformCatalogQueryError,
  PlatformCatalogGovernanceError as SaasPlatformCatalogQueryError,
};
