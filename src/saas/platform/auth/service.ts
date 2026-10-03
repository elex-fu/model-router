import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { CredentialEnvelope, CredentialKeyProvider, UserCredentialContext } from '../../credentials/crypto.js';
import { decryptCredential, encryptCredential } from '../../credentials/crypto.js';
import type { SaasDatabase, SqlExecutor } from '../../db/index.js';
import { SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL } from '../../db/advisory-lock-keys.js';
import { verifyPassword } from '../../identity/password.js';
import { PlatformAuthError } from './errors.js';
import { generateTotpSecret, totpUri, verifyTotpCode } from './totp.js';
import {
  PLATFORM_TOTP_PROVIDER,
  type PlatformAdminAuthServiceOptions,
  type PlatformAdminLogin,
  type PlatformAuthSession,
  type PlatformMfaEnrollmentStart,
  type PlatformMfaEnrollmentToken,
} from './types.js';

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;
const DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_CONFIRMATION_TOKEN_TTL_SECONDS = 10 * 60;
const DEFAULT_MAX_CONFIRMATION_ATTEMPTS = 5;
const MAX_CONFIRMATION_ATTEMPTS = 10;
const TOTP_STEP_MILLISECONDS = 30 * 1000;
const TOTP_WINDOW_STEPS = 1;
const TOTP_CODE_PATTERN = /^\d{6}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const PLATFORM_ADMIN_ROLE_SQL = "'superadmin', 'security', 'finance', 'operations', 'support-readonly'";

type TimestampValue = string | Date;

interface DbResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

interface PlatformAdminRow {
  id: string;
}

interface PlatformAdminPasswordRow {
  id: string;
  password_hash: unknown;
}

interface EnrollmentRow {
  id: string;
  user_id: string;
  expires_at: TimestampValue;
}

interface SetupRow {
  id: string;
  user_id: string;
  credential_id: string;
  encrypted_secret: Uint8Array;
  attempt_count: number | string;
  attempt_limit: number | string;
  expires_at: TimestampValue;
}

interface PlatformCredentialRow {
  credential_id: string;
  user_id: string;
  encrypted_secret: Uint8Array;
}

interface PlatformSessionCandidateRow {
  user_id: string;
}

interface PlatformAdminEmailRow {
  email: string;
}

interface PlatformSessionRow {
  id: string;
  user_id: string;
  created_at: TimestampValue;
  expires_at: TimestampValue;
}

interface CsrfRow {
  csrf_token_hash: string;
}

class PlatformLoginDenied extends Error {}

/** External trusted operator attestation; never a platform user/session identity. */
export interface PlatformMfaEnrollmentIssuanceAudit {
  readonly operatorId: string;
  readonly reasonCode: 'initial-enrollment' | 'approved-enrollment';
  readonly requestId: string;
}

function validateEnrollmentIssuanceAudit(audit: PlatformMfaEnrollmentIssuanceAudit): void {
  if (!audit || typeof audit.operatorId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(audit.operatorId)
    || !['initial-enrollment', 'approved-enrollment'].includes(audit.reasonCode)
    || typeof audit.requestId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(audit.requestId)) {
    throw new PlatformAuthError(400, 'INVALID_INPUT');
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function issueOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function tokenLooksPresent(token: unknown): token is string {
  return typeof token === 'string' && token.length >= 16 && token.length <= 256;
}

function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') throw new PlatformAuthError(400, 'INVALID_INPUT');
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    throw new PlatformAuthError(400, 'INVALID_INPUT');
  }
  return normalized;
}

function tryNormalizeEmail(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && EMAIL_PATTERN.test(normalized) ? normalized : undefined;
}

function platformRoleEligibilityPredicate(userIdExpression: string): string {
  return `EXISTS (
    SELECT 1 FROM saas_platform_role_assignments AS eligible_role
    WHERE eligible_role.user_id = ${userIdExpression}
      AND eligible_role.role IN (${PLATFORM_ADMIN_ROLE_SQL})
  )
  AND NOT EXISTS (
    SELECT 1 FROM saas_platform_role_assignments AS unsupported_role
    WHERE unsupported_role.user_id = ${userIdExpression}
      AND unsupported_role.role NOT IN (${PLATFORM_ADMIN_ROLE_SQL})
  )`;
}

function normalizeIssuer(issuer: unknown): string {
  if (typeof issuer !== 'string') throw new PlatformAuthError(400, 'INVALID_INPUT');
  const normalized = issuer.trim();
  if (normalized.length < 1 || normalized.length > 120) {
    throw new PlatformAuthError(400, 'INVALID_INPUT');
  }
  return normalized;
}

function validateTtl(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new PlatformAuthError(400, 'INVALID_INPUT');
  }
  return value;
}

function validateAttemptLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIRMATION_ATTEMPTS) {
    throw new PlatformAuthError(400, 'INVALID_INPUT');
  }
  return value;
}

function iso(value: TimestampValue): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
  }
  return date.toISOString();
}

function serializeEnvelope(envelope: CredentialEnvelope): Buffer {
  const encoded = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (encoded.length === 0 || encoded.length > MAX_ENVELOPE_BYTES) {
    encoded.fill(0);
    throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
  }
  return encoded;
}

function parseEnvelope(value: unknown): CredentialEnvelope {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_ENVELOPE_BYTES) {
    throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
  }
  const bytes = Buffer.from(value);
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid envelope');
    }
    return parsed as CredentialEnvelope;
  } catch {
    throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
  } finally {
    bytes.fill(0);
  }
}

function currentTotpStep(timeMs: number): number {
  const step = Math.floor(timeMs / TOTP_STEP_MILLISECONDS);
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
  }
  return step;
}

/** Return the matched step while keeping each actual code comparison in the TOTP core. */
function matchingTotpStep(secret: string, code: string, timeMs: number): number | undefined {
  if (!TOTP_CODE_PATTERN.test(code)) return undefined;
  const step = currentTotpStep(timeMs);
  for (let delta = -TOTP_WINDOW_STEPS; delta <= TOTP_WINDOW_STEPS; delta += 1) {
    const candidateStep = step + delta;
    if (candidateStep < 0) continue;
    try {
      if (
        verifyTotpCode(secret, code, candidateStep * TOTP_STEP_MILLISECONDS, {
          windowSteps: 0,
        })
      ) {
        return candidateStep;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function secureHashEquals(stored: string, supplied: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(stored)) return false;
  const expected = Buffer.from(stored, 'hex');
  const actual = Buffer.from(supplied, 'hex');
  try {
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}

export class PlatformAdminAuthService {
  private readonly now: () => Date;
  private readonly sessionTtlSeconds: number;
  private readonly enrollmentTokenTtlSeconds: number;
  private readonly confirmationTokenTtlSeconds: number;
  private readonly maxMfaConfirmationAttempts: number;

  constructor(
    private readonly database: SaasDatabase,
    private readonly credentialKeyProvider: CredentialKeyProvider | undefined = undefined,
    options: PlatformAdminAuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sessionTtlSeconds = validateTtl(
      options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
      MAX_SESSION_TTL_SECONDS,
    );
    this.enrollmentTokenTtlSeconds = validateTtl(
      options.enrollmentTokenTtlSeconds ?? DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS,
      DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS,
    );
    this.confirmationTokenTtlSeconds = validateTtl(
      options.confirmationTokenTtlSeconds ?? DEFAULT_CONFIRMATION_TOKEN_TTL_SECONDS,
      DEFAULT_CONFIRMATION_TOKEN_TTL_SECONDS,
    );
    this.maxMfaConfirmationAttempts = validateAttemptLimit(
      options.maxMfaConfirmationAttempts ?? DEFAULT_MAX_CONFIRMATION_ATTEMPTS,
    );
  }

  private currentDate(): Date {
    const value = this.now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
    }
    return date;
  }

  private requireCredentialKeyProvider(): CredentialKeyProvider {
    if (!this.credentialKeyProvider) {
      throw new PlatformAuthError(503, 'MFA_UNAVAILABLE');
    }
    return this.credentialKeyProvider;
  }

  private async query<Row>(
    executor: SqlExecutor,
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<DbResult<Row>> {
    try {
      return await executor.query<Row>(sql, values);
    } catch {
      throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
    }
  }

  private async transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (error instanceof PlatformAuthError) throw error;
      if (error instanceof PlatformLoginDenied) throw error;
      throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
    }
  }

  private async prepareAuthorizationTransaction(tx: SqlExecutor): Promise<void> {
    await this.query(tx, 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await this.query(tx, `SET LOCAL lock_timeout = '2s'`);
    await this.query(tx, `SET LOCAL statement_timeout = '10s'`);
  }

  private async lockPlatformAuthorization(tx: SqlExecutor, userId: string): Promise<void> {
    await this.query(tx, 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))', [userId]);
  }

  private async lockMfaEnrollmentIssuance(tx: SqlExecutor, userId: string): Promise<void> {
    // Match migration 046's writer order before taking the exclusive user
    // fence. Upgrading the reader fence without the statement writer first
    // would invert the global-writer/user order of revocation and enrollment.
    // Use only PG builtins: managed schema helpers remain non-callable.
    await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
    await this.query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId]);
  }

  private async isActivePlatformAdmin(tx: SqlExecutor, userId: string): Promise<boolean> {
    const result = await this.query<PlatformAdminRow>(
      tx,
      `SELECT u.id
       FROM saas_users u
       WHERE u.id = $1 AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
         AND (${platformRoleEligibilityPredicate('u.id')})
       LIMIT 1`,
      [userId],
    );
    return result.rows.length === 1;
  }

  private async decryptTotpSecret(
    row: { user_id: string; credential_id: string; encrypted_secret: Uint8Array },
    keyProvider: CredentialKeyProvider,
  ): Promise<string> {
    const envelope = parseEnvelope(row.encrypted_secret);
    const context: UserCredentialContext = {
      userId: row.user_id,
      provider: PLATFORM_TOTP_PROVIDER,
      credentialId: row.credential_id,
    };
    try {
      return await decryptCredential(envelope, context, keyProvider);
    } catch {
      throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
    }
  }

  private async revokeStaleUnverifiedTotpCredentials(
    executor: SqlExecutor,
    userId: string,
    now: string,
  ): Promise<void> {
    await this.query(
      executor,
      `WITH stale_credential AS (
         SELECT c.id
         FROM saas_mfa_credentials c
         WHERE c.user_id = $1 AND c.kind = 'totp'
           AND c.verified_at IS NULL AND c.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM saas_platform_mfa_setup_tokens s
             WHERE s.credential_id = c.id AND s.user_id = c.user_id
               AND s.consumed_at IS NULL AND s.locked_at IS NULL
               AND s.expires_at > $2
           )
         ORDER BY c.created_at, c.id
         LIMIT 1
       )
       UPDATE saas_mfa_credentials c
       SET revoked_at = $2
       FROM stale_credential stale
       WHERE c.id = stale.id AND c.user_id = $1
         AND c.verified_at IS NULL AND c.revoked_at IS NULL`,
      [userId, now],
    );
  }

  /**
   * Use the existing immutable audit table and retention path. actor_user_id
   * remains NULL: the operator is an external trusted identity, not the target
   * administrator. user_agent holds bounded CLI actor/reason metadata because
   * this generic audit schema has no workload/reason columns. No token, digest,
   * email, key material, or provider configuration is copied into that metadata.
   */
  private async appendEnrollmentIssuanceAudit(
    tx: SqlExecutor,
    audit: PlatformMfaEnrollmentIssuanceAudit,
    targetUserId: string | undefined,
    emailDigest: string,
    outcome: 'issued' | 'target-unavailable' | 'verified-totp-present' | 'enrollment-pending',
    occurredAt: string,
  ): Promise<void> {
    const id = randomUUID();
    const persisted = await this.query<{ id: string }>(tx,
      `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at,
        entry_point, request_id, user_agent)
       VALUES ($1, NULL, NULL, $2, $3, $4, $5,
         'trusted_operator_cli:platform_mfa_enroll', $6,
         jsonb_build_object('actor_kind', 'trusted_operator', 'operator_id', $7::text,
           'reason_code', $8::text, 'audience', 'platform',
           'workload_id', 'saas:platform-mfa-enroll', 'database_role', current_user,
           'outcome', $9::text)::text)
       RETURNING id`,
      [id, outcome === 'issued' ? 'platform_mfa.enrollment_token.issued' : 'platform_mfa.enrollment_token.denied',
        targetUserId ? 'platform_mfa_enrollment_user' : 'platform_mfa_enrollment_email_digest',
        targetUserId ?? emailDigest, occurredAt, audit.requestId, audit.operatorId, audit.reasonCode, outcome]);
    if (persisted.rows.length !== 1 || persisted.rows[0]?.id !== id) {
      throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
    }
  }

  async issueMfaEnrollmentToken(
    email: string,
    audit?: PlatformMfaEnrollmentIssuanceAudit,
  ): Promise<PlatformMfaEnrollmentToken> {
    if (audit !== undefined) validateEnrollmentIssuanceAudit(audit);
    const issuanceAudit = audit === undefined ? undefined
      : { operatorId: audit.operatorId, reasonCode: audit.reasonCode, requestId: audit.requestId };
    this.requireCredentialKeyProvider();
    const normalizedEmail = normalizeEmail(email);
    const candidate = await this.query<PlatformAdminRow>(
      this.database,
      `SELECT id FROM saas_users WHERE email_canonical = $1 LIMIT 1`,
      [normalizedEmail],
    );
    const candidateUserId = candidate.rows[0]?.id;
    if (!candidateUserId) {
      if (issuanceAudit) await this.transaction(async (tx) => {
        await this.prepareAuthorizationTransaction(tx);
        await this.appendEnrollmentIssuanceAudit(tx, issuanceAudit, undefined, hashToken(normalizedEmail),
          'target-unavailable', this.currentDate().toISOString());
      });
      throw new PlatformAuthError(403, 'MFA_ENROLLMENT_UNAVAILABLE');
    }
    const token = issueOpaqueToken();
    const tokenHash = hashToken(token);

    const outcome = await this.transaction<{ denied: 403 | 409 } | { expiresAt: string }>(async (tx) => {
      await this.prepareAuthorizationTransaction(tx);
      await this.lockMfaEnrollmentIssuance(tx, candidateUserId);
      const deny = async (status: 403 | 409, reason: 'target-unavailable' | 'verified-totp-present' | 'enrollment-pending') => {
        if (!issuanceAudit) throw new PlatformAuthError(status, 'MFA_ENROLLMENT_UNAVAILABLE');
        await this.appendEnrollmentIssuanceAudit(tx, issuanceAudit, candidateUserId, hashToken(normalizedEmail),
          reason, this.currentDate().toISOString());
        // Commit the denial event, then throw outside the transaction. No token
        // was inserted; throwing here would roll the immutable denial back.
        return { denied: status } as const;
      };
      const eligible = await this.isActivePlatformAdmin(tx, candidateUserId);
      if (!eligible) return deny(403, 'target-unavailable');
      const now = this.currentDate();

      const verified = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_mfa_credentials
         WHERE user_id = $1 AND kind = 'totp' AND verified_at IS NOT NULL AND revoked_at IS NULL
         LIMIT 1`,
        [candidateUserId],
      );
      if (verified.rows.length > 0) return deny(409, 'verified-totp-present');

      const pending = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_platform_mfa_enrollment_tokens
         WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > $2
         LIMIT 1`,
        [candidateUserId, now.toISOString()],
      );
      if (pending.rows.length > 0) return deny(409, 'enrollment-pending');

      const expiry = new Date(now.getTime() + this.enrollmentTokenTtlSeconds * 1000);
      await this.query(
        tx,
        `INSERT INTO saas_platform_mfa_enrollment_tokens
         (id, user_id, token_hash, created_at, expires_at, consumed_at)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [randomUUID(), candidateUserId, tokenHash, now.toISOString(), expiry.toISOString()],
      );
      if (issuanceAudit) await this.appendEnrollmentIssuanceAudit(tx, issuanceAudit, candidateUserId, hashToken(normalizedEmail),
        'issued', now.toISOString());
      return { expiresAt: expiry.toISOString() } as const;
    });

    if ('denied' in outcome) throw new PlatformAuthError(outcome.denied, 'MFA_ENROLLMENT_UNAVAILABLE');
    return { token, expiresAt: outcome.expiresAt };
  }

  async beginMfaEnrollment(token: string, issuer: string): Promise<PlatformMfaEnrollmentStart> {
    const keyProvider = this.requireCredentialKeyProvider();
    if (!tokenLooksPresent(token)) throw new PlatformAuthError(400, 'MFA_ENROLLMENT_TOKEN_INVALID');
    const normalizedIssuer = normalizeIssuer(issuer);
    const tokenHash = hashToken(token);
    const confirmationToken = issueOpaqueToken();
    const confirmationTokenHash = hashToken(confirmationToken);
    const credentialId = randomUUID();

    const result = await this.transaction(async (tx) => {
      await this.prepareAuthorizationTransaction(tx);
      const enrollment = await this.query<EnrollmentRow>(
        tx,
        `SELECT e.id, e.user_id, e.expires_at
         FROM saas_platform_mfa_enrollment_tokens e
         WHERE e.token_hash = $1 AND e.consumed_at IS NULL
         LIMIT 1
         FOR UPDATE OF e`,
        [tokenHash],
      );
      const row = enrollment.rows[0];
      if (!row) throw new PlatformAuthError(401, 'MFA_ENROLLMENT_TOKEN_INVALID');
      const now = this.currentDate();
      if (new Date(iso(row.expires_at)).getTime() <= now.getTime()) {
        throw new PlatformAuthError(401, 'MFA_ENROLLMENT_TOKEN_INVALID');
      }

      await this.revokeStaleUnverifiedTotpCredentials(tx, row.user_id, now.toISOString());

      const secret = generateTotpSecret();
      try {
        const context: UserCredentialContext = {
          userId: row.user_id,
          provider: PLATFORM_TOTP_PROVIDER,
          credentialId,
        };
        let envelope: CredentialEnvelope;
        try {
          envelope = await encryptCredential(secret, context, keyProvider);
        } catch {
          throw new PlatformAuthError(503, 'MFA_UNAVAILABLE');
        }
        const encryptedSecret = serializeEnvelope(envelope);
        try {
          await this.query(
            tx,
            `INSERT INTO saas_mfa_credentials
             (id, user_id, kind, encrypted_secret, created_at, verified_at, revoked_at)
             VALUES ($1, $2, 'totp', $3, $4, NULL, NULL)`,
            [credentialId, row.user_id, encryptedSecret, now.toISOString()],
          );
          encryptedSecret.fill(0);

          /* The credential trigger takes the exclusive user fence. Authority
           * reads below are deliberately ordinary SELECTs after that fence. */
          const fencedAt = this.currentDate();
          if (new Date(iso(row.expires_at)).getTime() <= fencedAt.getTime()) {
            throw new PlatformAuthError(401, 'MFA_ENROLLMENT_TOKEN_INVALID');
          }
          const authority = await this.query<PlatformAdminEmailRow>(
            tx,
            `SELECT u.email_canonical AS email
             FROM saas_users u
             WHERE u.id = $1 AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
               AND (${platformRoleEligibilityPredicate('u.id')})
             LIMIT 1`,
            [row.user_id],
          );
          const adminEmail = authority.rows[0]?.email;
          if (!adminEmail) throw new PlatformAuthError(401, 'MFA_ENROLLMENT_TOKEN_INVALID');

          const verified = await this.query<{ id: string }>(
            tx,
            `SELECT id FROM saas_mfa_credentials
             WHERE user_id = $1 AND id <> $2 AND kind = 'totp'
               AND verified_at IS NOT NULL AND revoked_at IS NULL
             LIMIT 1`,
            [row.user_id, credentialId],
          );
          if (verified.rows.length > 0) throw new PlatformAuthError(409, 'MFA_ENROLLMENT_UNAVAILABLE');

          const pending = await this.query<{ id: string }>(
            tx,
            `SELECT c.id
             FROM saas_mfa_credentials c
             JOIN saas_platform_mfa_setup_tokens s
               ON s.credential_id = c.id AND s.user_id = c.user_id
             WHERE c.user_id = $1 AND c.id <> $2 AND c.kind = 'totp'
               AND c.verified_at IS NULL AND c.revoked_at IS NULL
               AND s.consumed_at IS NULL AND s.locked_at IS NULL AND s.expires_at > $3
             LIMIT 1`,
            [row.user_id, credentialId, fencedAt.toISOString()],
          );
          if (pending.rows.length > 0) throw new PlatformAuthError(409, 'MFA_ENROLLMENT_UNAVAILABLE');

          const expiry = new Date(fencedAt.getTime() + this.confirmationTokenTtlSeconds * 1000);
          const consumedEnrollment = await this.query<{ id: string }>(
            tx,
            `UPDATE saas_platform_mfa_enrollment_tokens
             SET consumed_at = $2
             WHERE id = $1 AND consumed_at IS NULL AND expires_at > $2
             RETURNING id`,
            [row.id, fencedAt.toISOString()],
          );
          if (consumedEnrollment.rows.length !== 1) {
            throw new PlatformAuthError(401, 'MFA_ENROLLMENT_TOKEN_INVALID');
          }

          await this.query(
            tx,
            `INSERT INTO saas_platform_mfa_setup_tokens
             (id, user_id, credential_id, token_hash, attempt_count, attempt_limit,
              created_at, expires_at, consumed_at, locked_at)
             VALUES ($1, $2, $3, $4, 0, $5, $6, $7, NULL, NULL)`,
            [
              randomUUID(),
              row.user_id,
              credentialId,
              confirmationTokenHash,
              this.maxMfaConfirmationAttempts,
              fencedAt.toISOString(),
              expiry.toISOString(),
            ],
          );
          return {
            otpauthUri: totpUri(secret, normalizedIssuer, adminEmail),
            confirmationToken,
            expiresAt: expiry.toISOString(),
          } satisfies PlatformMfaEnrollmentStart;
        } finally {
          encryptedSecret.fill(0);
        }
      } finally {
        // The URI intentionally leaves this secret for the caller; do not persist or log it.
      }
    });

    return result;
  }

  async confirmMfaEnrollment(confirmationToken: string, code: string): Promise<void> {
    const keyProvider = this.requireCredentialKeyProvider();
    if (!tokenLooksPresent(confirmationToken)) {
      throw new PlatformAuthError(400, 'MFA_CONFIRMATION_INVALID');
    }
    const tokenHash = hashToken(confirmationToken);
    const normalizedCode = typeof code === 'string' ? code : '';

    const confirmed = await this.transaction(async (tx) => {
      await this.prepareAuthorizationTransaction(tx);
      const setupResult = await this.query<SetupRow>(
        tx,
        `SELECT s.id, s.user_id, s.credential_id, c.encrypted_secret,
                s.attempt_count, s.attempt_limit, s.expires_at
         FROM saas_platform_mfa_setup_tokens s
         JOIN saas_mfa_credentials c ON c.id = s.credential_id AND c.user_id = s.user_id
         WHERE s.token_hash = $1 AND s.consumed_at IS NULL
           AND s.locked_at IS NULL AND s.expires_at > clock_timestamp()
           AND c.kind = 'totp' AND c.verified_at IS NULL AND c.revoked_at IS NULL
         LIMIT 1
         FOR UPDATE OF s`,
        [tokenHash],
      );
      const setup = setupResult.rows[0];
      if (!setup) return false;
      const now = this.currentDate();
      if (new Date(iso(setup.expires_at)).getTime() <= now.getTime()) return false;

      const attempts = Number(setup.attempt_count);
      const attemptLimit = Number(setup.attempt_limit);
      if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(attemptLimit) || attempts >= attemptLimit) {
        return false;
      }

      let secret = await this.decryptTotpSecret(setup, keyProvider);
      let matchedStep: number | undefined;
      let checkedAt: Date;
      try {
        checkedAt = this.currentDate();
        if (new Date(iso(setup.expires_at)).getTime() <= checkedAt.getTime()) return false;
        matchedStep = matchingTotpStep(secret, normalizedCode, checkedAt.getTime());
      } finally {
        secret = '';
      }

      if (matchedStep === undefined) {
        await this.lockPlatformAuthorization(tx, setup.user_id);
        if (!(await this.isActivePlatformAdmin(tx, setup.user_id))) return false;
        const currentSetup = await this.query<{ id: string }>(
          tx,
          `SELECT s.id
           FROM saas_platform_mfa_setup_tokens s
           JOIN saas_mfa_credentials c ON c.id = s.credential_id AND c.user_id = s.user_id
           WHERE s.id = $1 AND s.user_id = $2 AND s.credential_id = $3
             AND s.consumed_at IS NULL AND s.locked_at IS NULL
             AND s.expires_at > clock_timestamp()
             AND c.kind = 'totp' AND c.verified_at IS NULL AND c.revoked_at IS NULL
           LIMIT 1`,
          [setup.id, setup.user_id, setup.credential_id],
        );
        if (currentSetup.rows.length !== 1) return false;
        await this.query(
          tx,
          `UPDATE saas_platform_mfa_setup_tokens
           SET attempt_count = attempt_count + 1,
               locked_at = CASE
                 WHEN attempt_count + 1 >= attempt_limit THEN $2
                 ELSE locked_at
               END
           WHERE id = $1 AND consumed_at IS NULL AND locked_at IS NULL
             AND attempt_count < attempt_limit
           RETURNING attempt_count`,
          [setup.id, checkedAt.toISOString()],
        );
        return false;
      }

      const verified = await this.query<{ id: string }>(
        tx,
        `UPDATE saas_mfa_credentials
         SET verified_at = $2, last_used_step = $3
         WHERE id = $1 AND user_id = $4 AND kind = 'totp'
           AND verified_at IS NULL AND revoked_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM saas_platform_mfa_setup_tokens s
             WHERE s.id = $5 AND s.user_id = $4 AND s.credential_id = $1
               AND s.consumed_at IS NULL AND s.locked_at IS NULL
               AND s.expires_at > $2
           )
         RETURNING id`,
        [setup.credential_id, checkedAt.toISOString(), String(matchedStep), setup.user_id, setup.id],
      );
      if (verified.rows.length !== 1) return false;

      /* Updating verified_at fires the MFA trigger and acquires the exclusive
       * user fence. Recheck authority and expiry after that potentially
       * blocking write, without row-locking any authorization fact. */
      const fencedAt = this.currentDate();
      if (new Date(iso(setup.expires_at)).getTime() <= fencedAt.getTime()) {
        throw new PlatformAuthError(401, 'MFA_CONFIRMATION_INVALID');
      }
      if (!(await this.isActivePlatformAdmin(tx, setup.user_id))) {
        throw new PlatformAuthError(401, 'MFA_CONFIRMATION_INVALID');
      }
      const credential = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_mfa_credentials
         WHERE id = $1 AND user_id = $2 AND kind = 'totp'
           AND verified_at = $3 AND last_used_step = $4 AND revoked_at IS NULL
         LIMIT 1`,
        [setup.credential_id, setup.user_id, checkedAt.toISOString(), String(matchedStep)],
      );
      if (credential.rows.length !== 1) throw new PlatformAuthError(401, 'MFA_CONFIRMATION_INVALID');

      const consumed = await this.query<{ id: string }>(
        tx,
        `UPDATE saas_platform_mfa_setup_tokens
         SET consumed_at = $2
         WHERE id = $1 AND user_id = $3 AND credential_id = $4
           AND consumed_at IS NULL AND locked_at IS NULL AND expires_at > $2
         RETURNING id`,
        [setup.id, fencedAt.toISOString(), setup.user_id, setup.credential_id],
      );
      if (consumed.rows.length !== 1) {
        // Force the transaction to roll back the verified_at update as well.
        throw new PlatformAuthError(401, 'MFA_CONFIRMATION_INVALID');
      }
      return true;
    });

    if (!confirmed) throw new PlatformAuthError(401, 'MFA_CONFIRMATION_INVALID');
  }

  async login(email: string, password: string, code: string): Promise<PlatformAdminLogin | undefined> {
    if (!this.credentialKeyProvider) return undefined;
    const keyProvider = this.credentialKeyProvider;

    const normalizedEmail = tryNormalizeEmail(email);
    const candidatePassword = typeof password === 'string' && password.length <= 1024 ? password : '';
    let admin: PlatformAdminPasswordRow | undefined;
    let passwordMatches: boolean;
    try {
      if (normalizedEmail !== undefined) {
        const result = await this.query<PlatformAdminPasswordRow>(
          this.database,
          `SELECT u.id, u.password_hash
           FROM saas_users u
           WHERE u.email_canonical = $1 AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
             AND (${platformRoleEligibilityPredicate('u.id')})
           LIMIT 1`,
          [normalizedEmail],
        );
        admin = result.rows[0];
      }
      passwordMatches = await verifyPassword(candidatePassword, admin?.password_hash);
    } catch {
      throw new PlatformAuthError(500, 'PLATFORM_AUTH_STORAGE_ERROR');
    }
    if (!admin || !passwordMatches) return undefined;

    const normalizedCode = typeof code === 'string' ? code : '';
    const credentialRows = await this.transaction(async (tx) => {
      await this.prepareAuthorizationTransaction(tx);
      await this.lockPlatformAuthorization(tx, admin.id);
      if (!(await this.isActivePlatformAdmin(tx, admin.id))) return [];
      const result = await this.query<PlatformCredentialRow>(
        tx,
        `SELECT c.id AS credential_id, c.user_id, c.encrypted_secret
         FROM saas_mfa_credentials c
         JOIN saas_users u ON u.id = c.user_id
         WHERE c.user_id = $1 AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
           AND (${platformRoleEligibilityPredicate('c.user_id')})
           AND c.kind = 'totp' AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
         ORDER BY c.created_at ASC, c.id ASC`,
        [admin.id],
      );
      return [...new Map(result.rows.map((row) => [row.credential_id, row])).values()];
    });
    if (credentialRows.length === 0) return undefined;

    const codeCheckedAt = this.currentDate();
    let matchedCredential: PlatformCredentialRow | undefined;
    let matchedStep: number | undefined;
    for (const credential of credentialRows) {
      let secret = await this.decryptTotpSecret(credential, keyProvider);
      try {
        const step = matchingTotpStep(secret, normalizedCode, codeCheckedAt.getTime());
        if (step !== undefined) {
          matchedCredential = credential;
          matchedStep = step;
          break;
        }
      } finally {
        secret = '';
      }
    }
    if (!matchedCredential || matchedStep === undefined) return undefined;

    /* Replay CAS runs alone, outside the shared authorization fence. Holding
     * an MFA tuple while acquiring a shared fence would invert the row-trigger
     * writer order. */
    const consumed = await this.query<{ id: string }>(
      this.database,
      `UPDATE saas_mfa_credentials
       SET last_used_step = $2
       WHERE id = $1 AND kind = 'totp' AND verified_at IS NOT NULL AND revoked_at IS NULL
         AND (last_used_step IS NULL OR last_used_step < $2)
       RETURNING id`,
      [matchedCredential.credential_id, String(matchedStep)],
    );
    if (consumed.rows.length !== 1) return undefined;

    const token = issueOpaqueToken();
    const csrfToken = issueOpaqueToken();
    const tokenHash = hashToken(token);
    const csrfTokenHash = hashToken(csrfToken);
    const sessionId = randomUUID();
    try {
      return await this.transaction(async (tx) => {
        await this.prepareAuthorizationTransaction(tx);
        /* Insert the uncommitted session before taking the shared fence. Its
         * FK takes KEY SHARE on user/MFA rows; doing that afterward could form
         * a DELETE-row -> exclusive-fence -> shared-fence -> FK-key-share
         * cycle. The token is not returned unless the fenced recheck commits. */
        const provisionalAt = this.currentDate();
        const provisionalExpiry = new Date(provisionalAt.getTime() + this.sessionTtlSeconds * 1000).toISOString();
        await this.query(
          tx,
          `INSERT INTO saas_platform_sessions
           (id, user_id, credential_id, token_hash, csrf_token_hash, created_at, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
          [
            sessionId,
            admin.id,
            matchedCredential.credential_id,
            tokenHash,
            csrfTokenHash,
            provisionalAt.toISOString(),
            provisionalExpiry,
          ],
        );

        await this.lockPlatformAuthorization(tx, admin.id);
        const finalAuthority = await this.query<{ id: string }>(
          tx,
          `SELECT c.id
           FROM saas_mfa_credentials c
           JOIN saas_users u ON u.id = c.user_id
           WHERE c.id = $1 AND c.user_id = $2 AND c.kind = 'totp'
             AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
             AND c.last_used_step = $3
             AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
             AND u.email_canonical = $4 AND u.password_hash IS NOT DISTINCT FROM $5
             AND (${platformRoleEligibilityPredicate('u.id')})
           LIMIT 1`,
          [matchedCredential.credential_id, admin.id, String(matchedStep), normalizedEmail, admin.password_hash],
        );
        if (finalAuthority.rows.length !== 1) throw new PlatformLoginDenied();

        const issuedAt = this.currentDate();
        if (Math.abs(currentTotpStep(issuedAt.getTime()) - matchedStep) > TOTP_WINDOW_STEPS) {
          throw new PlatformLoginDenied();
        }
        const session: PlatformAuthSession = {
          id: sessionId,
          userId: admin.id,
          createdAt: provisionalAt.toISOString(),
          expiresAt: provisionalExpiry,
        };
        return { token, csrfToken, session } satisfies PlatformAdminLogin;
      });
    } catch (error) {
      if (error instanceof PlatformLoginDenied) return undefined;
      throw error;
    }
  }

  async getSession(token: string): Promise<PlatformAuthSession | undefined> {
    if (!this.credentialKeyProvider || !tokenLooksPresent(token)) return undefined;
    const tokenHash = hashToken(token);
    const candidate = await this.query<PlatformSessionCandidateRow>(
      this.database,
      `SELECT user_id
       FROM saas_platform_sessions
       WHERE token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    const userId = candidate.rows[0]?.user_id;
    if (!userId) return undefined;

    const row = await this.transaction(async (tx) => {
      await this.prepareAuthorizationTransaction(tx);
      await this.lockPlatformAuthorization(tx, userId);
      const result = await this.query<PlatformSessionRow>(
        tx,
        `SELECT s.id, s.user_id, s.created_at, s.expires_at
       FROM saas_platform_sessions s
       JOIN saas_users u ON u.id = s.user_id
       JOIN saas_platform_role_assignments r
         ON r.user_id = s.user_id AND r.role IN (${PLATFORM_ADMIN_ROLE_SQL})
       JOIN saas_mfa_credentials c
         ON c.id = s.credential_id AND c.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.user_id = $2
         AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
         AND u.disabled_at IS NULL AND u.anonymized_at IS NULL AND c.kind = 'totp'
         AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
         AND (${platformRoleEligibilityPredicate('s.user_id')})
       LIMIT 1`,
        [tokenHash, userId],
      );
      return result.rows[0];
    });
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
    };
  }

  async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
    if (!this.credentialKeyProvider || !tokenLooksPresent(token) || !tokenLooksPresent(csrfToken)) return false;
    const tokenHash = hashToken(token);
    const candidate = await this.query<PlatformSessionCandidateRow>(
      this.database,
      `SELECT user_id
       FROM saas_platform_sessions
       WHERE token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );
    const userId = candidate.rows[0]?.user_id;
    if (!userId) return false;

    const csrfHash = await this.transaction(async (tx) => {
      await this.prepareAuthorizationTransaction(tx);
      await this.lockPlatformAuthorization(tx, userId);
      const result = await this.query<CsrfRow>(
        tx,
        `SELECT s.csrf_token_hash
       FROM saas_platform_sessions s
       JOIN saas_users u ON u.id = s.user_id
       JOIN saas_platform_role_assignments r
         ON r.user_id = s.user_id AND r.role IN (${PLATFORM_ADMIN_ROLE_SQL})
       JOIN saas_mfa_credentials c
         ON c.id = s.credential_id AND c.user_id = s.user_id
       WHERE s.token_hash = $1 AND s.user_id = $2
         AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
         AND u.disabled_at IS NULL AND u.anonymized_at IS NULL AND c.kind = 'totp'
         AND c.verified_at IS NOT NULL AND c.revoked_at IS NULL
         AND (${platformRoleEligibilityPredicate('s.user_id')})
       LIMIT 1`,
        [tokenHash, userId],
      );
      return result.rows[0]?.csrf_token_hash;
    });
    const stored = csrfHash;
    return stored ? secureHashEquals(stored, hashToken(csrfToken)) : false;
  }

  async logout(token: string): Promise<void> {
    if (!tokenLooksPresent(token)) return;
    await this.query(
      this.database,
      `UPDATE saas_platform_sessions
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE token_hash = $1`,
      [hashToken(token)],
    );
  }
}
