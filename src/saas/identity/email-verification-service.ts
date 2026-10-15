import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SaasDatabase } from '../db/types.js';
import type { EmailSender } from './email-sender.js';

/**
 * R4 registration admission (plan §R4): the email verification-code service.
 *
 * sub2api/new-api parity: a 6-digit crypto-random numeric code, issued per
 * (purpose, canonical email); only its SHA-256 hash is stored; the hash input
 * binds the purpose and the email so a code can never verify for another
 * purpose or address (new-api purpose-prefix isolation); TTL is 15 minutes
 * for registration and 30 minutes for password reset; sends are cooled down
 * 60 seconds per (purpose, email); a code tolerates at most 5 attempts; the
 * comparison is constant-time; and a successful verification consumes the
 * code exactly once.
 *
 * PG is the authoritative store (migration 106): every decision — cooldown,
 * attempt counting, expiry, one-time consumption — is a row transition inside
 * a transaction fenced by an advisory lock on (purpose, email), so multiple
 * instances share one consistent view. Redis/process memory are never
 * consulted for correctness.
 */

export type EmailVerificationPurpose = 'register' | 'password_reset';

export const REGISTER_CODE_TTL_MS = 15 * 60_000;
export const PASSWORD_RESET_CODE_TTL_MS = 30 * 60_000;
export const SEND_COOLDOWN_MS = 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** Expired rows linger this long for forensics before the next issue prunes them. */
const EXPIRED_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^[0-9]{6}$/;
const IP_PATTERN = /^[0-9a-fA-F:.]{1,45}$/;

export type EmailVerificationErrorCode =
  | 'INVALID_INPUT'
  | 'COOLDOWN_ACTIVE'
  | 'CODE_INVALID'
  | 'EMAIL_DELIVERY_FAILED'
  | 'UNAVAILABLE';

const safeMessages: Record<EmailVerificationErrorCode, string> = {
  INVALID_INPUT: 'The verification request contains invalid data.',
  COOLDOWN_ACTIVE: 'A verification code was sent recently. Please wait before requesting another.',
  CODE_INVALID: 'The verification code is invalid or expired.',
  EMAIL_DELIVERY_FAILED: 'The verification email could not be delivered.',
  UNAVAILABLE: 'The verification service could not complete the request.',
};

export class EmailVerificationError extends Error {
  readonly status: number;
  readonly code: EmailVerificationErrorCode;
  /** Seconds until a retry can be accepted (COOLDOWN_ACTIVE only). */
  readonly retryAfterSeconds?: number;

  constructor(code: EmailVerificationErrorCode, retryAfterSeconds?: number) {
    super(safeMessages[code]);
    this.name = 'EmailVerificationError';
    this.status =
      code === 'COOLDOWN_ACTIVE' ? 429 : code === 'INVALID_INPUT' ? 400 : code === 'CODE_INVALID' ? 400 : 503;
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function normalizeEmailCanonical(email: unknown): string {
  if (typeof email !== 'string' || email.length > 254) throw new EmailVerificationError('INVALID_INPUT');
  const canonical = email.trim().toLowerCase();
  if (canonical.length < 3 || !EMAIL_PATTERN.test(canonical)) throw new EmailVerificationError('INVALID_INPUT');
  return canonical;
}

function purposeTtlMs(purpose: EmailVerificationPurpose): number {
  return purpose === 'register' ? REGISTER_CODE_TTL_MS : PASSWORD_RESET_CODE_TTL_MS;
}

function hashCode(purpose: EmailVerificationPurpose, emailCanonical: string, code: string): string {
  return createHash('sha256')
    .update('saas-email-verification:v1\0', 'utf8')
    .update(purpose, 'utf8')
    .update('\0', 'utf8')
    .update(emailCanonical, 'utf8')
    .update('\0', 'utf8')
    .update(code, 'utf8')
    .digest('hex');
}

/** Constant-time hex digest comparison (both sides are 64-char sha256 hex). */
function constantTimeHashEquals(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

interface ActiveCodeRow {
  id: string;
  code_hash: string;
  attempts: number;
  expires_at: string;
}

interface LatestRow {
  created_at: string;
}

export interface EmailVerificationServiceOptions {
  readonly database: SaasDatabase;
  readonly emailSender: EmailSender;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Deterministic 6-digit code factory for tests; crypto-random in production. */
  readonly codeFactory?: () => string;
}

export interface IssueCodeInput {
  readonly email: unknown;
  readonly purpose: EmailVerificationPurpose;
  readonly createdIp?: string;
}

/**
 * Issue a verification code and deliver it. The row is inserted (and the
 * cooldown checked) inside one advisory-locked transaction; delivery happens
 * after commit and a delivery failure removes the just-inserted row so the
 * requester can retry immediately instead of waiting out the cooldown.
 */
export class EmailVerificationService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly codeFactory: () => string;

  constructor(private readonly options: EmailVerificationServiceOptions) {
    if (!options?.database || typeof options.database.transaction !== 'function') {
      throw new TypeError('EmailVerificationService requires a SaasDatabase');
    }
    if (!options?.emailSender || typeof options.emailSender.send !== 'function') {
      throw new TypeError('EmailVerificationService requires an EmailSender');
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.codeFactory = options.codeFactory ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));
  }

  async issueCode(input: IssueCodeInput): Promise<void> {
    const email = normalizeEmailCanonical(input?.email);
    if (input?.purpose !== 'register' && input?.purpose !== 'password_reset') {
      throw new EmailVerificationError('INVALID_INPUT');
    }
    const createdIp =
      typeof input.createdIp === 'string' && IP_PATTERN.test(input.createdIp) ? input.createdIp : undefined;
    const code = this.codeFactory();
    if (!CODE_PATTERN.test(code)) throw new Error('Invalid code factory output');
    const now = this.now();
    const id = this.idFactory();

    await this.options.database.transaction(async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '2s'");
      await tx.query("SET LOCAL statement_timeout = '10s'");
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `saas-email-verification:v1:${input.purpose}:${email}`,
      ]);
      const latest = await tx.query<LatestRow>(
        `SELECT created_at FROM saas_email_verification_codes
          WHERE purpose = $1 AND email_canonical = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.purpose, email],
      );
      const latestAt = latest.rows[0] ? new Date(latest.rows[0].created_at).getTime() : Number.NaN;
      if (Number.isFinite(latestAt) && now.getTime() - latestAt < SEND_COOLDOWN_MS) {
        throw new EmailVerificationError(
          'COOLDOWN_ACTIVE',
          Math.max(1, Math.ceil((SEND_COOLDOWN_MS - (now.getTime() - latestAt)) / 1000)),
        );
      }
      // Housekeeping riding the issue path: prune long-expired rows for this key.
      await tx.query(
        `DELETE FROM saas_email_verification_codes
          WHERE purpose = $1 AND email_canonical = $2 AND expires_at < $3`,
        [input.purpose, email, new Date(now.getTime() - EXPIRED_ROW_RETENTION_MS).toISOString()],
      );
      await tx.query(
        `INSERT INTO saas_email_verification_codes
           (id, email_canonical, purpose, code_hash, attempts, expires_at, consumed_at, created_ip, created_at)
         VALUES ($1, $2, $3, $4, 0, $5, NULL, $6, $7)`,
        [
          id,
          email,
          input.purpose,
          hashCode(input.purpose, email, code),
          new Date(now.getTime() + purposeTtlMs(input.purpose)).toISOString(),
          createdIp ?? null,
          now.toISOString(),
        ],
      );
    });

    try {
      await this.options.emailSender.send({
        to: email,
        subject:
          input.purpose === 'register'
            ? 'Your verification code (valid for 15 minutes)'
            : 'Your password reset code (valid for 30 minutes)',
        body: [
          `Your verification code is: ${code}`,
          '',
          input.purpose === 'register'
            ? 'Enter this code to complete registration. It expires in 15 minutes.'
            : 'Enter this code to reset your password. It expires in 30 minutes.',
          'If you did not request this code, you can ignore this email.',
        ].join('\n'),
      });
    } catch {
      // Compensating delete: the requester never received the code, so the
      // cooldown must not hold. A failed delete still leaves a valid (but
      // undelivered) code behind — the cooldown then applies as designed.
      try {
        await this.options.database.query('DELETE FROM saas_email_verification_codes WHERE id = $1', [id]);
      } catch {
        // Swallowed on purpose: the original delivery failure is the answer.
      }
      throw new EmailVerificationError('EMAIL_DELIVERY_FAILED');
    }
  }

  /**
   * Verify and atomically consume a code. A single safe refusal covers every
   * failure shape (unknown, expired, exhausted, mismatched, already used) so
   * the endpoint is not a code-space oracle.
   */
  async verifyCode(input: {
    readonly email: unknown;
    readonly purpose: EmailVerificationPurpose;
    readonly code: unknown;
  }): Promise<void> {
    const email = normalizeEmailCanonical(input?.email);
    if (input?.purpose !== 'register' && input?.purpose !== 'password_reset') {
      throw new EmailVerificationError('INVALID_INPUT');
    }
    if (typeof input.code !== 'string' || !CODE_PATTERN.test(input.code)) {
      throw new EmailVerificationError('CODE_INVALID');
    }
    const now = this.now().getTime();
    const suppliedHash = hashCode(input.purpose, email, input.code);
    let attemptRejected = false;

    try {
      await this.options.database.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '2s'");
        await tx.query("SET LOCAL statement_timeout = '10s'");
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `saas-email-verification:v1:${input.purpose}:${email}`,
        ]);
        const active = await tx.query<ActiveCodeRow>(
          `SELECT id, code_hash, attempts, expires_at FROM saas_email_verification_codes
            WHERE purpose = $1 AND email_canonical = $2 AND consumed_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE`,
          [input.purpose, email],
        );
        const row = active.rows[0];
        if (!row) throw new EmailVerificationError('CODE_INVALID');
        if (new Date(row.expires_at).getTime() <= now) throw new EmailVerificationError('CODE_INVALID');
        if (row.attempts >= MAX_CODE_ATTEMPTS) throw new EmailVerificationError('CODE_INVALID');
        if (!constantTimeHashEquals(row.code_hash, suppliedHash)) {
          // The attempt increment must survive this transaction: record it,
          // let the transaction commit, and reject afterwards. Throwing here
          // would roll the counter back and give unlimited guesses.
          await tx.query(
            'UPDATE saas_email_verification_codes SET attempts = attempts + 1 WHERE id = $1 AND attempts < $2',
            [row.id, MAX_CODE_ATTEMPTS],
          );
          attemptRejected = true;
          return;
        }
        // One-time consume inside the verification transaction.
        const consumed = await tx.query<{ id: string }>(
          'UPDATE saas_email_verification_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id',
          [row.id, new Date(now).toISOString()],
        );
        if (consumed.rows.length !== 1) throw new EmailVerificationError('CODE_INVALID');
      });
    } catch (error) {
      if (error instanceof EmailVerificationError) throw error;
      throw new EmailVerificationError('UNAVAILABLE');
    }
    if (attemptRejected) throw new EmailVerificationError('CODE_INVALID');
  }
}
