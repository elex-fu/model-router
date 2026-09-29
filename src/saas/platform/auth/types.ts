import type { CredentialKeyProvider } from '../../credentials/crypto.js';

/** The provider name is part of the authenticated data for platform TOTP envelopes. */
export const PLATFORM_TOTP_PROVIDER = 'platform-totp' as const;

export interface PlatformAdminAuthServiceOptions {
  /** Inject the clock for deterministic expiry and replay tests. */
  readonly now?: () => Date;
  /** Platform sessions are deliberately capped at eight hours. */
  readonly sessionTtlSeconds?: number;
  readonly enrollmentTokenTtlSeconds?: number;
  readonly confirmationTokenTtlSeconds?: number;
  readonly maxMfaConfirmationAttempts?: number;
}

export interface PlatformMfaEnrollmentToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface PlatformMfaEnrollmentStart {
  readonly otpauthUri: string;
  readonly confirmationToken: string;
  readonly expiresAt: string;
}

export interface PlatformAuthSession {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PlatformAdminLogin {
  readonly token: string;
  readonly csrfToken: string;
  readonly session: PlatformAuthSession;
}

/** The second constructor argument is optional so an unconfigured service can fail closed. */
export type OptionalCredentialKeyProvider = CredentialKeyProvider | undefined;
