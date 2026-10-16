import { randomUUID } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase } from '../db/types.js';
import type { EmailVerificationService } from './email-verification-service.js';
import { EmailVerificationError, normalizeEmailCanonical } from './email-verification-service.js';
import { hashPassword } from './password.js';
import type { RegistrationAdmissionSettings } from './registration-settings.js';
import { isEmailDomainAdmitted, parseRegistrationAdmissionSettings } from './registration-settings.js';
import type { CaptchaProof } from './turnstile-service.js';

/**
 * R4 registration admission (plan §R4): the public registration orchestration.
 *
 * Validation order (sub2api semantics, fail-closed at every step):
 *   registration switch → invite code (invite mode) → email domain
 *   allow/deny lists → Turnstile → email verification code → atomic user
 *   creation with email_verified_at backfilled.
 *
 * The email-existence probe deliberately runs BEFORE the captcha and code
 * verification so the common "address already registered" failure never burns
 * a captcha solve or a one-time code.
 *
 * Post-commit provisioning (personal tenant, affiliate attribution, the
 * three-tier registration rewards) is best-effort and never blocks or fails
 * an otherwise successful registration — the sub2api posture (binding
 * failures are logged, the account still exists). The identity transaction
 * itself reuses the bootstrap/OAuth writer fences and the preallocated user
 * advisory lock.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9]{6,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RegistrationErrorCode =
  | 'INVALID_INPUT'
  | 'REGISTRATION_CLOSED'
  | 'INVITE_CODE_REQUIRED'
  | 'INVITE_CODE_INVALID'
  | 'EMAIL_DOMAIN_REJECTED'
  | 'EMAIL_ALREADY_EXISTS'
  | 'CAPTCHA_REJECTED'
  | 'VERIFICATION_CODE_REQUIRED'
  | 'VERIFICATION_CODE_INVALID'
  | 'CREDENTIALS_REJECTED'
  | 'UNAVAILABLE';

const safeMessages: Record<RegistrationErrorCode, string> = {
  INVALID_INPUT: 'The registration request contains invalid data.',
  REGISTRATION_CLOSED: 'Registration is currently closed.',
  INVITE_CODE_REQUIRED: 'An invite code is required to register.',
  INVITE_CODE_INVALID: 'The invite code is invalid.',
  EMAIL_DOMAIN_REJECTED: 'This email domain cannot register.',
  EMAIL_ALREADY_EXISTS: 'An account already exists for this email address.',
  CAPTCHA_REJECTED: 'Human verification failed. Please try again.',
  VERIFICATION_CODE_REQUIRED: 'An email verification code is required.',
  VERIFICATION_CODE_INVALID: 'The verification code is invalid or expired.',
  CREDENTIALS_REJECTED: 'The password reset could not be completed.',
  UNAVAILABLE: 'The registration service could not complete the request.',
};

export class RegistrationError extends Error {
  readonly status: number;
  readonly code: RegistrationErrorCode;

  constructor(status: number, code: RegistrationErrorCode) {
    super(safeMessages[code]);
    this.name = 'RegistrationError';
    this.status = status;
    this.code = code;
  }
}

function fail(status: number, code: RegistrationErrorCode): never {
  throw new RegistrationError(status, code);
}

/** Identity capabilities injected into the registration service (fakeable). */
export interface RegistrationIdentityDirectory {
  findUserAccountByEmail(email: string): Promise<{ readonly userId: string } | undefined>;
  issueSessionForUser(
    userId: string,
    ttlSeconds: number,
  ): Promise<{ readonly token: string; readonly csrfToken: string; readonly session: unknown } | undefined>;
  createTenant(
    userId: string,
    input: { readonly name: string; readonly slug?: string },
  ): Promise<{ readonly id: string }>;
}

/**
 * Affiliate/reward port implemented by the marketing layer. `resolveInviteCode`
 * is the admission-time gate (invite mode); `completeRegistrationAttribution`
 * performs the post-commit binding plus the three-tier rewards
 * (registration grant / code filler / code owner) through the wallet ledger.
 */
export interface RegistrationAffiliatePort {
  /** Inviter tenant id for a valid code, null when unresolvable. */
  resolveInviteCode(inviteCode: string): Promise<string | null>;
  completeRegistrationAttribution(input: {
    readonly inviteeTenantId: string;
    readonly userId: string;
    readonly inviteCode?: string;
  }): Promise<void>;
}

export interface RegistrationServiceOptions {
  readonly database: SaasDatabase;
  readonly identity: RegistrationIdentityDirectory;
  readonly verification: EmailVerificationService;
  readonly captcha: CaptchaProof;
  readonly settings: RegistrationAdmissionSettings;
  /**
   * F1 platform settings store: dynamic store-first settings resolution. When
   * present, every admission decision re-resolves the merged store+env
   * configuration (a store hit wins); the static `settings` snapshot remains
   * the constructor-validated fallback. Resolvers that themselves fail
   * (misconfigured store overlay, unreadable store) must fail closed — the
   * managed wiring resolves to the fail-closed defaults in that case.
   */
  readonly settingsResolver?: () => Promise<RegistrationAdmissionSettings>;
  readonly sessionTtlSeconds: number;
  readonly affiliate?: RegistrationAffiliatePort;
  readonly now?: () => Date;
  /** Post-commit provisioning failures (never fatal); defaults to console.error. */
  readonly onProvisioningError?: (error: unknown, stage: string) => void;
}

export interface RegistrationInput {
  readonly email: unknown;
  readonly password: unknown;
  readonly displayName?: unknown;
  readonly verificationCode?: unknown;
  readonly inviteCode?: unknown;
  readonly captchaToken?: unknown;
  readonly remoteIp?: string;
}

export interface RegistrationSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly session: unknown;
}

function validatePasswordShape(password: unknown): string {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    fail(400, 'INVALID_INPUT');
  }
  return password;
}

function normalizeInviteCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(400, 'INVALID_INPUT');
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!INVITE_CODE_PATTERN.test(trimmed)) fail(400, 'INVITE_CODE_INVALID');
  return trimmed.toUpperCase();
}

function tenantNameFor(emailCanonical: string, displayName: string | undefined): string {
  const base = (displayName ?? emailCanonical.slice(0, emailCanonical.indexOf('@')))
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim();
  return (base.length >= 1 ? base : 'My Workspace').slice(0, 80);
}

export class RegistrationService {
  private readonly now: () => Date;
  private readonly onProvisioningError: (error: unknown, stage: string) => void;

  constructor(private readonly options: RegistrationServiceOptions) {
    if (
      !options?.database ||
      typeof options.database.transaction !== 'function' ||
      !options?.identity ||
      typeof options.identity.findUserAccountByEmail !== 'function' ||
      !options?.verification ||
      !options?.captcha ||
      typeof options.captcha.verify !== 'function' ||
      !options?.settings ||
      !Number.isSafeInteger(options.sessionTtlSeconds) ||
      options.sessionTtlSeconds < 1 ||
      options.sessionTtlSeconds > 30 * 24 * 60 * 60
    ) {
      throw new TypeError('Invalid registration service configuration');
    }
    this.now = options.now ?? (() => new Date());
    this.onProvisioningError =
      options.onProvisioningError ??
      ((error, stage) => {
        console.error(`model-router registration provisioning failed (${stage})`, error);
      });
  }

  /**
   * The effective admission settings: the store-first resolver when wired,
   * otherwise the constructor snapshot. Fail-closed — a resolver failure
   * degrades to the strict parser's empty-source defaults (closed mode, no
   * Turnstile, no SMTP, zero rewards) rather than admitting traffic against
   * an unverifiable configuration.
   */
  private async currentSettings(): Promise<RegistrationAdmissionSettings> {
    if (this.options.settingsResolver === undefined) return this.options.settings;
    try {
      return await this.options.settingsResolver();
    } catch (error) {
      console.error('model-router registration settings resolution failed; failing closed', error);
      return parseRegistrationAdmissionSettings({});
    }
  }

  /** Public admission descriptor consumed by the console register view. */
  admissionDescriptor(): {
    readonly mode: 'open' | 'invite' | 'closed';
    readonly emailVerificationRequired: boolean;
    readonly turnstile: { readonly enabled: boolean; readonly siteKey?: string };
  } {
    const settings = this.options.settings;
    return {
      mode: settings.mode,
      emailVerificationRequired: settings.emailVerificationRequired,
      turnstile: {
        enabled: settings.turnstile.enabled,
        ...(settings.turnstile.siteKey === undefined ? {} : { siteKey: settings.turnstile.siteKey }),
      },
    };
  }

  /**
   * Store-first admission descriptor (F1): resolves the effective settings the
   * same way the admission decisions do, so the public options endpoint never
   * advertises a mode the register endpoints would not honor.
   */
  async resolveAdmissionDescriptor(): Promise<ReturnType<RegistrationService['admissionDescriptor']>> {
    const settings = await this.currentSettings();
    return {
      mode: settings.mode,
      emailVerificationRequired: settings.emailVerificationRequired,
      turnstile: {
        enabled: settings.turnstile.enabled,
        ...(settings.turnstile.siteKey === undefined ? {} : { siteKey: settings.turnstile.siteKey }),
      },
    };
  }

  /** Captcha proof passthrough for the HTTP boundary (fail-closed when enabled). */
  async verifyCaptcha(input: { readonly token?: unknown; readonly remoteIp?: string }): Promise<boolean> {
    return this.options.captcha.verify({
      token: typeof input?.token === 'string' ? input.token : undefined,
      ...(input?.remoteIp === undefined ? {} : { remoteIp: input.remoteIp }),
    });
  }

  /**
   * Issue a registration code. The admission gates that can be evaluated
   * without a body — the registration switch and the domain lists — run first
   * so a closed deployment never mails codes and denied domains never reach
   * the sender.
   */
  async sendRegistrationCode(input: { readonly email: unknown; readonly createdIp?: string }): Promise<void> {
    const settings = await this.currentSettings();
    if (settings.mode === 'closed') fail(403, 'REGISTRATION_CLOSED');
    const email = normalizeEmailCanonical(input?.email);
    if (!isEmailDomainAdmitted(settings, email)) fail(403, 'EMAIL_DOMAIN_REJECTED');
    await this.options.verification.issueCode({
      email,
      purpose: 'register',
      ...(input?.createdIp === undefined ? {} : { createdIp: input.createdIp }),
    });
  }

  async register(input: RegistrationInput): Promise<RegistrationSession> {
    const settings = await this.currentSettings();
    if (settings.mode === 'closed') fail(403, 'REGISTRATION_CLOSED');

    const inviteCode = normalizeInviteCode(input?.inviteCode);
    if (settings.mode === 'invite' && inviteCode === undefined) fail(403, 'INVITE_CODE_REQUIRED');
    let inviterTenantId: string | null = null;
    if (inviteCode !== undefined && this.options.affiliate !== undefined) {
      inviterTenantId = await this.options.affiliate.resolveInviteCode(inviteCode);
      if (inviterTenantId === null) fail(403, 'INVITE_CODE_INVALID');
    } else if (inviteCode !== undefined && this.options.affiliate === undefined) {
      // An invite code was presented but no affiliate surface exists: it can
      // never be valid, and silently accepting it would mislead the user.
      fail(403, 'INVITE_CODE_INVALID');
    }

    const email = normalizeEmailCanonical(input?.email);
    if (!EMAIL_PATTERN.test(email)) fail(400, 'INVALID_INPUT');
    if (!isEmailDomainAdmitted(settings, email)) fail(403, 'EMAIL_DOMAIN_REJECTED');

    const displayName =
      input?.displayName === undefined || (typeof input.displayName === 'string' && input.displayName.trim() === '')
        ? undefined
        : typeof input.displayName === 'string' &&
            input.displayName.trim().length >= 1 &&
            input.displayName.trim().length <= 120
          ? input.displayName.trim()
          : fail(400, 'INVALID_INPUT');

    const password = validatePasswordShape(input?.password);

    // Existence probe before the captcha/code so those are never burned on
    // the common already-registered failure.
    const existing = await this.options.identity.findUserAccountByEmail(email);
    if (existing) fail(409, 'EMAIL_ALREADY_EXISTS');

    if (
      !(await this.verifyCaptcha({
        token: input?.captchaToken,
        ...(input?.remoteIp === undefined ? {} : { remoteIp: input.remoteIp }),
      }))
    ) {
      fail(403, 'CAPTCHA_REJECTED');
    }

    if (settings.emailVerificationRequired) {
      const verificationCode = input?.verificationCode;
      if (typeof verificationCode !== 'string' || verificationCode.length === 0) {
        fail(400, 'VERIFICATION_CODE_REQUIRED');
      }
      try {
        await this.options.verification.verifyCode({ email, purpose: 'register', code: verificationCode });
      } catch (error) {
        if (error instanceof EmailVerificationError && error.code === 'CODE_INVALID') {
          fail(400, 'VERIFICATION_CODE_INVALID');
        }
        throw error;
      }
    }

    const userId = randomUUID();
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password);
    } catch {
      fail(503, 'UNAVAILABLE');
    }
    const now = this.now().toISOString();

    try {
      await this.options.database.transaction(async (tx) => {
        // Same fence family as bootstrap/OAuth registration: global writer
        // fence, then the preallocated user key, before the user INSERT.
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [userId]);
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO saas_users
           (id, email, password_hash, display_name, email_verified_at, disabled_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $6)
           RETURNING id`,
          [userId, email, passwordHash, displayName ?? null, now, now],
        );
        if (inserted.rows.length !== 1 || inserted.rows[0]?.id !== userId) fail(503, 'UNAVAILABLE');
      });
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        // Concurrent same-email registration raced past the probe; the
        // canonical-email unique constraint is the authoritative gate.
        fail(409, 'EMAIL_ALREADY_EXISTS');
      }
      fail(503, 'UNAVAILABLE');
    }

    await this.provision(userId, email, displayName, inviteCode, inviterTenantId);

    const session = await this.options.identity.issueSessionForUser(userId, this.options.sessionTtlSeconds);
    if (!session || !UUID_PATTERN.test(userId)) fail(503, 'UNAVAILABLE');
    return { token: session.token, csrfToken: session.csrfToken, session: session.session };
  }

  /**
   * Post-commit provisioning: the personal tenant (the wallet/reward anchor
   * model-router's affiliate surface is tenant-scoped) and the affiliate
   * attribution + rewards. Every failure is reported and swallowed — the
   * account exists and can log in regardless.
   */
  private async provision(
    userId: string,
    emailCanonical: string,
    displayName: string | undefined,
    inviteCode: string | undefined,
    inviterTenantId: string | null,
  ): Promise<void> {
    let tenantId: string | undefined;
    try {
      const tenant = await this.options.identity.createTenant(userId, {
        name: tenantNameFor(emailCanonical, displayName),
        slug: `t-${userId.slice(0, 8)}`,
      });
      tenantId = tenant.id;
    } catch (error) {
      this.onProvisioningError(error, 'tenant');
      return;
    }
    if (this.options.affiliate === undefined || (inviteCode === undefined && inviterTenantId === null)) return;
    try {
      await this.options.affiliate.completeRegistrationAttribution({
        inviteeTenantId: tenantId,
        userId,
        ...(inviteCode === undefined ? {} : { inviteCode }),
      });
    } catch (error) {
      this.onProvisioningError(error, 'affiliate');
    }
  }

  /**
   * Password reset step 1: issue a password_reset code. Unknown addresses are
   * a silent no-op so the endpoint is not an account-existence oracle.
   */
  async requestPasswordResetCode(input: { readonly email: unknown; readonly createdIp?: string }): Promise<void> {
    const email = normalizeEmailCanonical(input?.email);
    const account = await this.options.identity.findUserAccountByEmail(email);
    if (!account) return;
    await this.options.verification.issueCode({
      email,
      purpose: 'password_reset',
      ...(input?.createdIp === undefined ? {} : { createdIp: input.createdIp }),
    });
  }

  /** Password reset step 2: verify the code, set the new password, revoke sessions. */
  async confirmPasswordReset(input: {
    readonly email: unknown;
    readonly code: unknown;
    readonly newPassword: unknown;
  }): Promise<void> {
    const email = normalizeEmailCanonical(input?.email);
    if (typeof input?.code !== 'string' || input.code.length === 0) fail(400, 'INVALID_INPUT');
    const password = validatePasswordShape(input?.newPassword);

    const account = await this.options.identity.findUserAccountByEmail(email);
    if (!account || !UUID_PATTERN.test(account.userId)) fail(400, 'CREDENTIALS_REJECTED');

    await this.options.verification
      .verifyCode({ email, purpose: 'password_reset', code: input.code })
      .catch((error: unknown) => {
        if (error instanceof EmailVerificationError && error.code === 'CODE_INVALID') {
          fail(400, 'VERIFICATION_CODE_INVALID');
        }
        throw error;
      });

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password);
    } catch {
      fail(503, 'UNAVAILABLE');
    }
    const now = this.now().toISOString();

    try {
      await this.options.database.transaction(async (tx) => {
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
        await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [account.userId]);
        const updated = await tx.query<{ id: string }>(
          `UPDATE saas_users
              SET password_hash = $2, updated_at = $3
            WHERE id = $1 AND disabled_at IS NULL
            RETURNING id`,
          [account.userId, passwordHash, now],
        );
        if (updated.rows.length !== 1) fail(400, 'CREDENTIALS_REJECTED');
        // A successful reset invalidates every existing session.
        await tx.query('UPDATE saas_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [
          account.userId,
          now,
        ]);
      });
    } catch (error) {
      if (error instanceof RegistrationError) throw error;
      fail(503, 'UNAVAILABLE');
    }
  }
}
