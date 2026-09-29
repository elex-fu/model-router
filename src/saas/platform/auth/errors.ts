export type PlatformAuthErrorCode =
  | 'INVALID_INPUT'
  | 'MFA_UNAVAILABLE'
  | 'MFA_ENROLLMENT_UNAVAILABLE'
  | 'MFA_ENROLLMENT_TOKEN_INVALID'
  | 'MFA_CONFIRMATION_INVALID'
  | 'PLATFORM_AUTH_STORAGE_ERROR';

const SAFE_MESSAGES: Record<PlatformAuthErrorCode, string> = {
  INVALID_INPUT: 'The platform authentication request is invalid.',
  MFA_UNAVAILABLE: 'Platform MFA is unavailable.',
  MFA_ENROLLMENT_UNAVAILABLE: 'Platform MFA enrollment is unavailable.',
  MFA_ENROLLMENT_TOKEN_INVALID: 'The MFA enrollment token is invalid or expired.',
  MFA_CONFIRMATION_INVALID: 'The MFA confirmation could not be completed.',
  PLATFORM_AUTH_STORAGE_ERROR: 'The platform authentication service could not complete the request.',
};

export class PlatformAuthError extends Error {
  readonly status: number;
  readonly code: PlatformAuthErrorCode;

  constructor(status: number, code: PlatformAuthErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'PlatformAuthError';
    this.status = status;
    this.code = code;
  }
}
