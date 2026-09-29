export type PlatformAuditQueryErrorCode = 'AUDIT_INVALID_INPUT' | 'AUDIT_STORAGE_ERROR';
export type PlatformAuditHistoryQueryErrorCode = PlatformAuditQueryErrorCode;

const SAFE_MESSAGES: Record<PlatformAuditQueryErrorCode, string> = {
  AUDIT_INVALID_INPUT: 'The platform audit query contains invalid data.',
  AUDIT_STORAGE_ERROR: 'The platform audit query could not be completed.',
};

const ERROR_STATUS: Record<PlatformAuditQueryErrorCode, number> = {
  AUDIT_INVALID_INPUT: 400,
  AUDIT_STORAGE_ERROR: 500,
};

export class PlatformAuditQueryError extends Error {
  readonly code: PlatformAuditQueryErrorCode;
  readonly status: number;

  constructor(code: PlatformAuditQueryErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'PlatformAuditQueryError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPlatformAuditQueryError(error: unknown): error is PlatformAuditQueryError {
  return error instanceof PlatformAuditQueryError;
}

export {
  PlatformAuditQueryError as PlatformAuditHistoryQueryError,
  PlatformAuditQueryError as SaasPlatformAuditQueryError,
  PlatformAuditQueryError as SaasPlatformAuditHistoryQueryError,
};
