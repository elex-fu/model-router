export type PlatformGovernanceErrorCode =
  | 'GOVERNANCE_INVALID_INPUT'
  | 'GOVERNANCE_FORBIDDEN'
  | 'GOVERNANCE_NOT_FOUND'
  | 'GOVERNANCE_CONFLICT'
  | 'GOVERNANCE_STORAGE_ERROR';

const SAFE_ERROR_MESSAGES: Record<PlatformGovernanceErrorCode, string> = {
  GOVERNANCE_INVALID_INPUT: 'The platform governance request contains invalid data.',
  GOVERNANCE_FORBIDDEN: 'The platform role cannot perform this governance operation.',
  GOVERNANCE_NOT_FOUND: 'The governance target does not exist.',
  GOVERNANCE_CONFLICT: 'The governance operation conflicts with the current state.',
  GOVERNANCE_STORAGE_ERROR: 'The platform governance operation could not be completed.',
};

const ERROR_STATUSES: Record<PlatformGovernanceErrorCode, number> = {
  GOVERNANCE_INVALID_INPUT: 400,
  GOVERNANCE_FORBIDDEN: 403,
  GOVERNANCE_NOT_FOUND: 404,
  GOVERNANCE_CONFLICT: 409,
  GOVERNANCE_STORAGE_ERROR: 500,
};

export class PlatformGovernanceError extends Error {
  readonly status: number;
  readonly code: PlatformGovernanceErrorCode;

  constructor(code: PlatformGovernanceErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'PlatformGovernanceError';
    this.status = ERROR_STATUSES[code];
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function governanceInvalid(): never {
  throw new PlatformGovernanceError('GOVERNANCE_INVALID_INPUT');
}

export function governanceForbidden(): never {
  throw new PlatformGovernanceError('GOVERNANCE_FORBIDDEN');
}

export function governanceNotFound(): never {
  throw new PlatformGovernanceError('GOVERNANCE_NOT_FOUND');
}

export function governanceConflict(): never {
  throw new PlatformGovernanceError('GOVERNANCE_CONFLICT');
}

export function governanceStorage(): never {
  throw new PlatformGovernanceError('GOVERNANCE_STORAGE_ERROR');
}
