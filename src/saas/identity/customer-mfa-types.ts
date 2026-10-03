import type { CredentialKeyProvider } from '../credentials/crypto.js';

export interface CustomerMfaSessionProof {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly requestId: string;
}
export interface CustomerMfaStartInput {
  readonly password: string;
  /** Required when replacing an already verified customer credential. */
  readonly currentTotpCode?: string;
}
export interface CustomerMfaConfirmInput extends CustomerMfaStartInput {
  readonly confirmationToken: string;
  readonly code: string;
}
export interface CustomerMfaRevokeInput { readonly password: string; readonly code: string }
export interface CustomerMfaEnrollment {
  readonly confirmationToken: string;
  readonly secret: string;
  readonly otpauthUri: string;
  readonly expiresAt: string;
}
export interface CustomerMfaStatus { readonly enabled: boolean }
export interface CustomerMfaChanged {
  readonly enabled: boolean;
  /** ALL prior customer sessions, including this one, are revoked atomically. */
  readonly sessionsRevoked: number;
  readonly signInRequired: true;
}
export interface CustomerMfaOperations {
  status(proof: CustomerMfaSessionProof): Promise<CustomerMfaStatus>;
  start(proof: CustomerMfaSessionProof, input: CustomerMfaStartInput): Promise<CustomerMfaEnrollment>;
  confirm(proof: CustomerMfaSessionProof, input: CustomerMfaConfirmInput): Promise<CustomerMfaChanged>;
  revoke(proof: CustomerMfaSessionProof, input: CustomerMfaRevokeInput): Promise<CustomerMfaChanged>;
}
export interface CustomerMfaOptions {
  readonly keyProvider?: CredentialKeyProvider;
  /** Trusted deployment label, never a request-body selector. */
  readonly issuer: string;
}
export type CustomerMfaCode =
  | 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'CSRF_REJECTED' | 'REAUTH_REQUIRED'
  | 'MFA_CODE_REJECTED' | 'MFA_STATE_CONFLICT' | 'ENROLLMENT_PENDING'
  | 'ENROLLMENT_INVALID' | 'RATE_LIMITED' | 'AUTHORITY_CHANGED' | 'UNAVAILABLE';
export class CustomerMfaError extends Error {
  readonly status: number;
  constructor(readonly code: CustomerMfaCode) {
    super('The customer MFA operation could not be completed.');
    this.name = 'CustomerMfaError';
    this.status = code === 'INVALID_INPUT' ? 400
      : code === 'UNAUTHENTICATED' ? 401
      : code === 'CSRF_REJECTED' || code === 'REAUTH_REQUIRED' || code === 'MFA_CODE_REJECTED' ? 403
      : code === 'RATE_LIMITED' ? 429
      : code === 'UNAVAILABLE' ? 503 : 409;
  }
}
export function customerMfaFail(code: CustomerMfaCode): never { throw new CustomerMfaError(code); }
