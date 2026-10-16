import type { CredentialKeyProvider } from '../credentials/crypto.js';
import type { CustomerMfaSessionProof } from './customer-mfa-types.js';

/** Passkeys ride the exact customer session proof the TOTP factor uses. */
export type CustomerPasskeySessionProof = CustomerMfaSessionProof;

export interface CustomerPasskeySummary {
  readonly credentialId: string;
  readonly createdAt: string;
  readonly verifiedAt: string;
}
export interface CustomerPasskeyList {
  readonly passkeys: readonly CustomerPasskeySummary[];
}
export interface CustomerPasskeyRegistrationStart {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: ReadonlyArray<{ readonly type: 'public-key'; readonly alg: -7 | -257 }>;
  readonly timeout: number;
  readonly attestation: 'none';
  readonly authenticatorSelection: {
    readonly residentKey: 'preferred';
    readonly userVerification: 'required' | 'discouraged';
  };
  readonly expiresAt: string;
}
export interface CustomerPasskeyAssertionStart {
  readonly challenge: string;
  readonly rpId: string;
  readonly allowCredentials: ReadonlyArray<{ readonly type: 'public-key'; readonly id: string }>;
  readonly timeout: number;
  readonly userVerification: 'required' | 'discouraged';
  readonly expiresAt: string;
}
export interface CustomerPasskeyRegistrationFinishInput {
  readonly password: string;
  readonly currentTotpCode?: string;
  readonly challenge: string;
  readonly credential: {
    readonly id: string;
    readonly clientDataJSON: string;
    readonly attestationObject: string;
  };
}
export interface CustomerPasskeyAssertionFinishInput {
  readonly password: string;
  readonly challenge: string;
  readonly credential: {
    readonly id: string;
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string | null;
  };
}
export interface CustomerPasskeyStartInput {
  readonly password: string;
  /** Required whenever a verified TOTP factor is active (cross-factor gate). */
  readonly currentTotpCode?: string;
  /** Assertion starts name the exact passkey to exercise. */
  readonly credentialId?: string;
}
export interface CustomerPasskeyRemoveInput {
  readonly password: string;
  readonly currentTotpCode?: string;
  readonly credentialId: string;
}
export interface CustomerPasskeyAssertionVerified {
  readonly verified: true;
  readonly credentialId: string;
}
export interface CustomerPasskeyChanged {
  readonly credentialId: string;
  /** ALL prior customer sessions, including this one, are revoked atomically. */
  readonly sessionsRevoked: number;
  readonly signInRequired: true;
}
export interface CustomerPasskeyOperations {
  list(proof: CustomerPasskeySessionProof): Promise<CustomerPasskeyList>;
  startRegistration(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyStartInput,
  ): Promise<CustomerPasskeyRegistrationStart>;
  finishRegistration(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyRegistrationFinishInput,
  ): Promise<CustomerPasskeyChanged>;
  startAssertion(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyStartInput,
  ): Promise<CustomerPasskeyAssertionStart>;
  finishAssertion(
    proof: CustomerPasskeySessionProof,
    input: CustomerPasskeyAssertionFinishInput,
  ): Promise<CustomerPasskeyAssertionVerified>;
  remove(proof: CustomerPasskeySessionProof, input: CustomerPasskeyRemoveInput): Promise<CustomerPasskeyChanged>;
}
export interface CustomerPasskeyOptions {
  readonly keyProvider?: CredentialKeyProvider;
  /** Effective RP ID (domain only, no scheme/port); sha256-bound into authenticatorData. */
  readonly rpId: string;
  /** Deployment label shown to authenticators; never a request-body value. */
  readonly rpName: string;
  /** Exact https origins allowed to produce ceremonies. */
  readonly origins: readonly string[];
  /** Default true; only tests may relax. */
  readonly requireUserVerification?: boolean;
}
export type CustomerPasskeyCode =
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'REAUTH_REQUIRED'
  | 'PASSKEY_REJECTED'
  | 'PASSKEY_NOT_FOUND'
  | 'CEREMONY_INVALID'
  | 'MFA_STATE_CONFLICT'
  | 'RATE_LIMITED'
  | 'AUTHORITY_CHANGED'
  | 'UNAVAILABLE';
export class CustomerPasskeyError extends Error {
  readonly status: number;
  constructor(readonly code: CustomerPasskeyCode) {
    super('The customer passkey operation could not be completed.');
    this.name = 'CustomerPasskeyError';
    this.status =
      code === 'INVALID_INPUT'
        ? 400
        : code === 'UNAUTHENTICATED'
          ? 401
          : code === 'PASSKEY_NOT_FOUND'
            ? 404
            : code === 'REAUTH_REQUIRED' || code === 'PASSKEY_REJECTED'
              ? 403
              : code === 'RATE_LIMITED'
                ? 429
                : code === 'UNAVAILABLE'
                  ? 503
                  : 409;
  }
}
export function customerPasskeyFail(code: CustomerPasskeyCode): never {
  throw new CustomerPasskeyError(code);
}
