import { randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../../db/types.js';
import { hashPassword } from '../../identity/password.js';
import { isPlatformAdminRole, type PlatformAdminActor, type PlatformAdminRole } from '../access/index.js';
import { verifyGovernanceActor } from './actor.js';
import {
  governanceConflict,
  governanceForbidden,
  governanceInvalid,
  governanceNotFound,
  governanceStorage,
  PlatformGovernanceError,
} from './errors.js';
import { appendGovernanceAudit } from './users.js';

const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 120;
const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,255}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 1024;

/** Operator management is restricted to superadmin. */
const OPERATOR_ROLES = ['superadmin'] as const;

export interface PlatformOperatorSummary {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly disabledAt: string | null;
  readonly roles: readonly PlatformAdminRole[];
}

export type PlatformOperatorManagementDatabase = Pick<SaasDatabase, 'query' | 'transaction'>;

export interface PlatformOperatorManagementServiceOptions {
  readonly currentDate?: () => Date;
}

function hasSafeTextCharacters(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && code !== 0x7f;
  });
}

function inputUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) governanceInvalid();
  return value.toLowerCase();
}

function validateActor(actor: unknown): PlatformAdminActor {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) governanceForbidden();
  const candidate = actor as Partial<PlatformAdminActor>;
  if (
    typeof candidate.userId !== 'string' ||
    candidate.userId.trim() === '' ||
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId.trim() === '' ||
    !Array.isArray(candidate.roles)
  ) {
    governanceForbidden();
  }
  return candidate as PlatformAdminActor;
}

function normalizeEmail(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_EMAIL_LENGTH ||
    value.trim() !== value ||
    !hasSafeTextCharacters(value) ||
    !EMAIL_PATTERN.test(value)
  ) {
    governanceInvalid();
  }
  return value;
}

function normalizeDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > MAX_DISPLAY_NAME_LENGTH) {
    governanceInvalid();
  }
  const normalized = value.trim();
  if (!hasSafeTextCharacters(normalized)) governanceInvalid();
  return normalized;
}

function validatePasswordInput(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < MIN_PASSWORD_LENGTH ||
    Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    governanceInvalid();
  }
  return value;
}

export class PlatformOperatorManagementService {
  private readonly currentDate: () => Date;

  constructor(
    private readonly database: PlatformOperatorManagementDatabase,
    options: PlatformOperatorManagementServiceOptions = {},
  ) {
    if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
      throw new TypeError('database must implement the SaaS database contract');
    }
    this.currentDate = options.currentDate ?? (() => new Date());
  }

  async listOperators(actor: PlatformAdminActor): Promise<readonly PlatformOperatorSummary[]> {
    const verifiedActor = validateActor(actor);
    try {
      return await this.database.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await verifyGovernanceActor(tx, verifiedActor, OPERATOR_ROLES);
        const result = await tx.query<{
          readonly user_id: unknown;
          readonly email: unknown;
          readonly display_name: unknown;
          readonly disabled_at: unknown;
          readonly role: unknown;
        }>(
          `SELECT u.id::text AS user_id,
                  u.email_canonical AS email,
                  u.display_name,
                  u.disabled_at,
                  r.role
             FROM saas_platform_role_assignments r
             JOIN saas_users u ON u.id = r.user_id
            WHERE u.anonymized_at IS NULL
            ORDER BY u.email_canonical ASC, r.role ASC`,
        );
        if (!result || !Array.isArray(result.rows)) governanceStorage();
        const byUser = new Map<string, PlatformOperatorSummary & { roles: PlatformAdminRole[] }>();
        for (const row of result.rows) {
          if (
            row === null ||
            typeof row !== 'object' ||
            typeof row.user_id !== 'string' ||
            !UUID_PATTERN.test(row.user_id) ||
            typeof row.email !== 'string' ||
            row.email.length > MAX_EMAIL_LENGTH ||
            !EMAIL_PATTERN.test(row.email) ||
            !isPlatformAdminRole(row.role) ||
            (row.disabled_at !== null && !(row.disabled_at instanceof Date) && typeof row.disabled_at !== 'string')
          ) {
            governanceStorage();
          }
          const userId = row.user_id.toLowerCase();
          const displayName = row.display_name === null ? null : row.display_name;
          if (
            displayName !== null &&
            (typeof displayName !== 'string' ||
              displayName.length === 0 ||
              displayName.length > MAX_DISPLAY_NAME_LENGTH ||
              !hasSafeTextCharacters(displayName))
          ) {
            governanceStorage();
          }
          const disabledAt =
            row.disabled_at === null
              ? null
              : row.disabled_at instanceof Date
                ? row.disabled_at.toISOString()
                : String(row.disabled_at);
          const existing = byUser.get(userId);
          if (existing) {
            existing.roles.push(row.role);
          } else {
            byUser.set(userId, {
              userId,
              email: row.email,
              displayName,
              disabledAt,
              roles: [row.role],
            });
          }
        }
        return [...byUser.values()];
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  /**
   * Grant a platform role to an existing enabled user. Granting the first
   * platform role to a customer user effectively promotes them to operator;
   * MFA enrollment still happens through the trusted enrollment-token flow.
   */
  async grantOperatorRole(actor: PlatformAdminActor, targetUserIdInput: unknown, roleInput: unknown): Promise<void> {
    const verifiedActor = validateActor(actor);
    const targetUserId = inputUuid(targetUserIdInput);
    if (!isPlatformAdminRole(roleInput)) governanceInvalid();

    try {
      await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, OPERATOR_ROLES);
        await this.lockEnabledUser(tx, targetUserId);
        const now = this.currentDate().toISOString();
        const inserted = await tx.query(
          `INSERT INTO saas_platform_role_assignments (user_id, role, granted_at, granted_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, role) DO NOTHING`,
          [targetUserId, roleInput, now, verifiedActor.userId],
        );
        if (!inserted || typeof inserted.rowCount !== 'number') governanceStorage();
        if (inserted.rowCount !== 1) governanceConflict();
        await appendGovernanceAudit(tx, {
          action: 'platform_operator.role_granted',
          targetType: 'platform_operator',
          targetId: `${targetUserId}:${roleInput}`,
          actorUserId: verifiedActor.userId,
          occurredAt: now,
        });
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  /**
   * Revoke a platform role. Self-revocation is refused; the last superadmin
   * assignment can never be removed. When the target loses their final
   * platform role, all platform sessions are revoked.
   */
  async revokeOperatorRole(actor: PlatformAdminActor, targetUserIdInput: unknown, roleInput: unknown): Promise<void> {
    const verifiedActor = validateActor(actor);
    const targetUserId = inputUuid(targetUserIdInput);
    if (!isPlatformAdminRole(roleInput)) governanceInvalid();
    if (targetUserId === verifiedActor.userId.toLowerCase()) governanceConflict();

    try {
      await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, OPERATOR_ROLES);
        // Serialize concurrent superadmin revocations on a stable key.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:platform-roles', 0))");

        const existing = await tx.query<{ readonly role: unknown }>(
          `SELECT role FROM saas_platform_role_assignments WHERE user_id = $1 AND role = $2 LIMIT 1`,
          [targetUserId, roleInput],
        );
        if (!existing || !Array.isArray(existing.rows)) governanceStorage();
        if (existing.rows.length !== 1) governanceNotFound();

        if (roleInput === 'superadmin') {
          const remaining = await tx.query<{ readonly count: unknown }>(
            `SELECT count(*)::text AS count FROM saas_platform_role_assignments
              WHERE role = 'superadmin' AND user_id <> $1`,
            [targetUserId],
          );
          if (!remaining || !Array.isArray(remaining.rows) || remaining.rows.length !== 1) governanceStorage();
          const count = Number(remaining.rows[0]?.count);
          if (!Number.isSafeInteger(count) || count < 0) governanceStorage();
          if (count === 0) governanceConflict();
        }

        const deleted = await tx.query(`DELETE FROM saas_platform_role_assignments WHERE user_id = $1 AND role = $2`, [
          targetUserId,
          roleInput,
        ]);
        if (!deleted || deleted.rowCount !== 1) governanceStorage();

        const now = this.currentDate().toISOString();
        const remainingRoles = await tx.query<{ readonly role: unknown }>(
          `SELECT role FROM saas_platform_role_assignments WHERE user_id = $1 LIMIT 1`,
          [targetUserId],
        );
        if (!remainingRoles || !Array.isArray(remainingRoles.rows)) governanceStorage();
        if (remainingRoles.rows.length === 0) {
          const revokedSessions = await tx.query(
            `UPDATE saas_platform_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
            [targetUserId, now],
          );
          if (!revokedSessions || typeof revokedSessions.rowCount !== 'number') governanceStorage();
        }
        await appendGovernanceAudit(tx, {
          action: 'platform_operator.role_revoked',
          targetType: 'platform_operator',
          targetId: `${targetUserId}:${roleInput}`,
          actorUserId: verifiedActor.userId,
          occurredAt: now,
        });
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  /**
   * Create a new operator account: a fresh user with an operator-set initial
   * password plus the initial role assignment. The operator must still enroll
   * TOTP through the trusted enrollment-token flow before the first login;
   * the initial password value is never audited, logged, or returned.
   */
  async createOperator(
    actor: PlatformAdminActor,
    input: {
      readonly email: unknown;
      readonly displayName?: unknown;
      readonly password: unknown;
      readonly role: unknown;
    },
  ): Promise<PlatformOperatorSummary> {
    const verifiedActor = validateActor(actor);
    if (!input || typeof input !== 'object' || Array.isArray(input)) governanceInvalid();
    const candidate = input as Record<string, unknown>;
    for (const key of Object.keys(candidate)) {
      if (key !== 'email' && key !== 'displayName' && key !== 'password' && key !== 'role') governanceInvalid();
    }
    const email = normalizeEmail(candidate.email);
    const displayName = normalizeDisplayName(candidate.displayName);
    const password = validatePasswordInput(candidate.password);
    if (!isPlatformAdminRole(candidate.role)) governanceInvalid();
    const role: PlatformAdminRole = candidate.role;
    // scrypt runs outside the transaction; the PG lock is never held during
    // deliberately slow password work.
    const passwordHash = await hashPassword(password);

    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, OPERATOR_ROLES);
        const now = this.currentDate().toISOString();
        const userId = randomUUID();
        const created = await tx.query<{ readonly id: unknown }>(
          `INSERT INTO saas_users (id, email, password_hash, display_name, email_verified_at, disabled_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)
           ON CONFLICT (email_canonical) DO NOTHING
           RETURNING id::text AS id`,
          [userId, email, passwordHash, displayName, now],
        );
        if (!created || !Array.isArray(created.rows)) governanceStorage();
        if (created.rows.length !== 1 || created.rows[0]?.id !== userId) governanceConflict();
        const granted = await tx.query(
          `INSERT INTO saas_platform_role_assignments (user_id, role, granted_at, granted_by_user_id)
           VALUES ($1, $2, $3, $4)`,
          [userId, role, now, verifiedActor.userId],
        );
        if (!granted || granted.rowCount !== 1) governanceStorage();
        await appendGovernanceAudit(tx, {
          action: 'platform_operator.created',
          targetType: 'platform_operator',
          targetId: `${userId}:${role}`,
          actorUserId: verifiedActor.userId,
          occurredAt: now,
        });
        return {
          userId,
          email: email.toLowerCase(),
          displayName,
          disabledAt: null,
          roles: [role],
        };
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  private async lockEnabledUser(tx: { query: SaasDatabase['query'] }, userId: string): Promise<void> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:user:' || $1::uuid::text, 0))", [userId]);
    const result = await tx.query(
      `SELECT id FROM saas_users
        WHERE id = $1 AND disabled_at IS NULL AND anonymized_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [userId],
    );
    if (!result || !Array.isArray(result.rows)) governanceStorage();
    if (result.rows.length !== 1) governanceNotFound();
  }
}
