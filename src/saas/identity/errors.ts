export type SaasIdentityErrorCode =
  | 'INVALID_INPUT'
  | 'IDENTITY_STORAGE_ERROR'
  | 'IDENTITY_CONFLICT'
  | 'EMAIL_ALREADY_EXISTS'
  | 'BOOTSTRAP_ALREADY_COMPLETED'
  | 'BOOTSTRAP_TOKEN_ALREADY_ISSUED'
  | 'BOOTSTRAP_TOKEN_INVALID'
  | 'TENANT_SLUG_TAKEN'
  | 'TENANT_ACCESS_DENIED'
  | 'INSUFFICIENT_TENANT_ROLE'
  | 'INVALID_INVITATION_ROLE'
  | 'INVITATION_PENDING'
  | 'INVITATION_INVALID'
  | 'INVITATION_ALREADY_MEMBER';

const safeMessages: Record<SaasIdentityErrorCode, string> = {
  INVALID_INPUT: 'The request contains invalid identity data.',
  IDENTITY_STORAGE_ERROR: 'The identity service could not complete the request.',
  IDENTITY_CONFLICT: 'The identity request conflicts with existing data.',
  EMAIL_ALREADY_EXISTS: 'An account already exists for this email address.',
  BOOTSTRAP_ALREADY_COMPLETED: 'Platform administrator bootstrap has already completed.',
  BOOTSTRAP_TOKEN_ALREADY_ISSUED: 'A valid platform bootstrap token has already been issued.',
  BOOTSTRAP_TOKEN_INVALID: 'The platform bootstrap token is invalid or expired.',
  TENANT_SLUG_TAKEN: 'That tenant slug is already in use.',
  TENANT_ACCESS_DENIED: 'The requested tenant is unavailable to this user.',
  INSUFFICIENT_TENANT_ROLE: 'This tenant role cannot perform the requested operation.',
  INVALID_INVITATION_ROLE: 'The requested invitation role is not allowed.',
  INVITATION_PENDING: 'A valid invitation already exists for this email address.',
  INVITATION_INVALID: 'The invitation is invalid, expired, or cannot be accepted.',
  INVITATION_ALREADY_MEMBER: 'This user already has an active membership in the tenant.',
};

export class SaasIdentityError extends Error {
  readonly status: number;
  readonly code: SaasIdentityErrorCode;

  constructor(status: number, code: SaasIdentityErrorCode) {
    super(safeMessages[code]);
    this.name = 'SaasIdentityError';
    this.status = status;
    this.code = code;
  }
}
