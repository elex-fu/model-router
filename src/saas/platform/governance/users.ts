import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import { hashPassword } from '../../identity/password.js';
import type { PlatformAdminActor } from '../access/index.js';
import { verifyGovernanceActor } from './actor.js';
import {
  decodeGovernanceCursor,
  encodeGovernanceCursor,
  type GovernanceCursor,
  governanceCursorSecret,
  governanceFilterHash,
} from './cursor.js';
import {
  governanceConflict,
  governanceForbidden,
  governanceInvalid,
  governanceNotFound,
  governanceStorage,
  PlatformGovernanceError,
} from './errors.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CURSOR_PREFIX = 'pu1.';
const MAX_EMAIL_SEARCH_LENGTH = 100;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;
const EMAIL_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,255}$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_BYTES = 1024;

/** Roles that may read the customer user directory. */
const USER_READ_ROLES = ['superadmin', 'security', 'operations', 'support-readonly'] as const;
/** Roles that may mutate customer users. */
const USER_WRITE_ROLES = ['superadmin', 'security'] as const;

export interface PlatformUserSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly emailVerifiedAt: string | null;
  readonly disabledAt: string | null;
  readonly createdAt: string;
}

export interface PlatformUserPage {
  readonly items: readonly PlatformUserSummary[];
  readonly nextCursor: string | null;
}

export interface PlatformUserListQuery {
  readonly emailContains?: string;
  readonly status?: 'active' | 'disabled';
  readonly cursor?: string | null;
  readonly limit?: number;
}

export type PlatformUserGovernanceDatabase = Pick<SaasDatabase, 'query' | 'transaction'>;

export interface PlatformUserGovernanceServiceOptions {
  readonly cursorSecret?: string | Uint8Array;
  readonly currentDate?: () => Date;
}

interface UserRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly display_name: unknown;
  readonly email_verified_at: unknown;
  readonly disabled_at: unknown;
  readonly created_at: unknown;
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

function normalizeListQuery(value: unknown): {
  readonly limit: number;
  readonly emailContains: string | null;
  readonly status: 'active' | 'disabled' | null;
} {
  if (value === undefined || value === null) return { limit: DEFAULT_PAGE_SIZE, emailContains: null, status: null };
  if (typeof value !== 'object' || Array.isArray(value)) governanceInvalid();
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== 'emailContains' && key !== 'status' && key !== 'cursor' && key !== 'limit') governanceInvalid();
  }
  const limit = candidate.limit === undefined ? DEFAULT_PAGE_SIZE : candidate.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    governanceInvalid();
  }
  let emailContains: string | null = null;
  if (candidate.emailContains !== undefined && candidate.emailContains !== null) {
    if (
      typeof candidate.emailContains !== 'string' ||
      candidate.emailContains.length === 0 ||
      candidate.emailContains.length > MAX_EMAIL_SEARCH_LENGTH ||
      candidate.emailContains.trim() !== candidate.emailContains ||
      !hasSafeTextCharacters(candidate.emailContains)
    ) {
      governanceInvalid();
    }
    emailContains = candidate.emailContains.toLowerCase();
  }
  let status: 'active' | 'disabled' | null = null;
  if (candidate.status !== undefined && candidate.status !== null) {
    if (candidate.status !== 'active' && candidate.status !== 'disabled') governanceInvalid();
    status = candidate.status;
  }
  return { limit, emailContains, status };
}

function storedTimestamp(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) governanceStorage();
    return value.toISOString();
  }
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    governanceStorage();
  }
  return value;
}

function nullableStoredTimestamp(value: unknown): string | null {
  return value === null ? null : storedTimestamp(value);
}

function storedEmail(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) {
    governanceStorage();
  }
  return value;
}

function storedDisplayName(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH ||
    !hasSafeTextCharacters(value)
  ) {
    governanceStorage();
  }
  return value;
}

function mapUserRow(row: UserRow): PlatformUserSummary {
  if (row === null || typeof row !== 'object') governanceStorage();
  if (typeof row.id !== 'string' || !UUID_PATTERN.test(row.id)) governanceStorage();
  return {
    id: row.id.toLowerCase(),
    email: storedEmail(row.email),
    displayName: storedDisplayName(row.display_name),
    emailVerifiedAt: nullableStoredTimestamp(row.email_verified_at),
    disabledAt: nullableStoredTimestamp(row.disabled_at),
    createdAt: storedTimestamp(row.created_at),
  };
}

export class PlatformUserGovernanceService {
  private readonly cursorSecret: Uint8Array;
  private readonly currentDate: () => Date;

  constructor(
    private readonly database: PlatformUserGovernanceDatabase,
    options: PlatformUserGovernanceServiceOptions = {},
  ) {
    if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
      throw new TypeError('database must implement the SaaS database contract');
    }
    this.cursorSecret = governanceCursorSecret(options.cursorSecret);
    this.currentDate = options.currentDate ?? (() => new Date());
  }

  async listUsers(actor: PlatformAdminActor, queryInput?: PlatformUserListQuery): Promise<PlatformUserPage> {
    const verifiedActor = validateActor(actor);
    const query = normalizeListQuery(queryInput);
    const filterHash = governanceFilterHash('users', {
      ...(query.emailContains === null ? {} : { emailContains: query.emailContains }),
      ...(query.status === null ? {} : { status: query.status }),
    });
    const cursor = decodeGovernanceCursor(
      this.cursorSecret,
      CURSOR_PREFIX,
      (queryInput as Record<string, unknown> | undefined)?.cursor,
      filterHash,
    );

    try {
      return await this.database.transaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await verifyGovernanceActor(tx, verifiedActor, USER_READ_ROLES);

        const values: unknown[] = [];
        const conditions: string[] = ['anonymized_at IS NULL'];
        if (query.emailContains !== null) {
          values.push(`%${query.emailContains.replace(/[%_\\]/g, (mark) => `\\${mark}`)}%`);
          conditions.push(`email_canonical LIKE $${values.length} ESCAPE '\\'`);
        }
        if (query.status === 'active') conditions.push('disabled_at IS NULL');
        if (query.status === 'disabled') conditions.push('disabled_at IS NOT NULL');
        if (cursor !== null) {
          values.push(cursor.occurredAt, cursor.id);
          conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
        }
        values.push(query.limit + 1);

        const result = await tx.query<UserRow>(
          `SELECT id::text AS id,
                  email_canonical AS email,
                  display_name,
                  to_char(email_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS email_verified_at,
                  to_char(disabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS disabled_at,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
             FROM saas_users
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC, id DESC
            LIMIT $${values.length}`,
          values,
        );
        if (!result || !Array.isArray(result.rows)) governanceStorage();
        const rows = result.rows;
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit).map(mapUserRow);
        const lastItem = items.at(-1);
        return {
          items,
          nextCursor:
            hasMore && lastItem
              ? encodeGovernanceCursor(this.cursorSecret, CURSOR_PREFIX, {
                  version: 1,
                  filterHash,
                  occurredAt: lastItem.createdAt,
                  id: lastItem.id,
                })
              : null,
        };
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  /**
   * Disable or re-enable a customer user. Disabling revokes every customer and
   * platform session. Users holding platform role assignments are managed
   * through the operator endpoints and cannot be disabled here.
   */
  async setUserDisabled(actor: PlatformAdminActor, targetUserIdInput: unknown, disabled: unknown): Promise<void> {
    const verifiedActor = validateActor(actor);
    const targetUserId = inputUuid(targetUserIdInput);
    if (typeof disabled !== 'boolean') governanceInvalid();
    if (targetUserId === verifiedActor.userId.toLowerCase()) governanceConflict();

    try {
      await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, USER_WRITE_ROLES);
        const target = await this.lockTargetUser(tx, targetUserId);

        const platformRoles = await tx.query<{ readonly role: unknown }>(
          `SELECT role FROM saas_platform_role_assignments WHERE user_id = $1 LIMIT 1`,
          [targetUserId],
        );
        if (!platformRoles || !Array.isArray(platformRoles.rows)) governanceStorage();
        if (platformRoles.rows.length > 0) governanceConflict();

        const currentlyDisabled = target.disabled_at !== null && target.disabled_at !== undefined;
        if (currentlyDisabled === disabled) governanceConflict();

        const now = this.currentDate().toISOString();
        const updated = await tx.query(`UPDATE saas_users SET disabled_at = $2, updated_at = $2 WHERE id = $1`, [
          targetUserId,
          disabled ? now : null,
        ]);
        if (!updated || updated.rowCount !== 1) governanceStorage();
        if (disabled) await revokeAllSessions(tx, targetUserId, now);
        await appendGovernanceAudit(tx, {
          action: disabled ? 'platform_user.disabled' : 'platform_user.enabled',
          targetType: 'platform_user',
          targetId: targetUserId,
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
   * Operator-set password reset: the operator supplies the new password
   * out-of-band; every existing session is revoked. The password value is
   * hashed before the transaction and is never written to audit, logs, or
   * responses.
   */
  async resetUserPassword(
    actor: PlatformAdminActor,
    targetUserIdInput: unknown,
    passwordInput: unknown,
  ): Promise<void> {
    const verifiedActor = validateActor(actor);
    const targetUserId = inputUuid(targetUserIdInput);
    const password = validatePasswordInput(passwordInput);
    // scrypt runs outside the transaction so the PG lock is never held during
    // deliberately slow password work.
    const passwordHash = await hashPassword(password);

    try {
      await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, USER_WRITE_ROLES);
        await this.lockTargetUser(tx, targetUserId);
        const now = this.currentDate().toISOString();
        const updated = await tx.query(`UPDATE saas_users SET password_hash = $2, updated_at = $3 WHERE id = $1`, [
          targetUserId,
          passwordHash,
          now,
        ]);
        if (!updated || updated.rowCount !== 1) governanceStorage();
        await revokeAllSessions(tx, targetUserId, now);
        await appendGovernanceAudit(tx, {
          action: 'platform_user.password_reset',
          targetType: 'platform_user',
          targetId: targetUserId,
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
   * Force MFA re-enrollment: revoke every TOTP/passkey credential and every
   * session, so the next login starts without any registered factor.
   */
  async resetUserMfa(actor: PlatformAdminActor, targetUserIdInput: unknown): Promise<void> {
    const verifiedActor = validateActor(actor);
    const targetUserId = inputUuid(targetUserIdInput);

    try {
      await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, USER_WRITE_ROLES);
        await this.lockTargetUser(tx, targetUserId);
        const now = this.currentDate().toISOString();
        const revokedCredentials = await tx.query(
          `UPDATE saas_mfa_credentials SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
          [targetUserId, now],
        );
        if (!revokedCredentials || typeof revokedCredentials.rowCount !== 'number') governanceStorage();
        await revokeAllSessions(tx, targetUserId, now);
        await appendGovernanceAudit(tx, {
          action: 'platform_user.mfa_reset',
          targetType: 'platform_user',
          targetId: targetUserId,
          actorUserId: verifiedActor.userId,
          occurredAt: now,
        });
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  private async lockTargetUser(tx: SqlExecutor, targetUserId: string): Promise<{ readonly disabled_at: unknown }> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:user:' || $1::uuid::text, 0))", [
      targetUserId,
    ]);
    const result = await tx.query<{ readonly disabled_at: unknown }>(
      `SELECT disabled_at FROM saas_users WHERE id = $1 AND anonymized_at IS NULL LIMIT 1 FOR UPDATE`,
      [targetUserId],
    );
    if (!result || !Array.isArray(result.rows)) governanceStorage();
    if (result.rows.length !== 1) governanceNotFound();
    return result.rows[0] as { readonly disabled_at: unknown };
  }
}

async function revokeAllSessions(tx: SqlExecutor, userId: string, now: string): Promise<void> {
  const customerSessions = await tx.query(
    `UPDATE saas_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, now],
  );
  if (!customerSessions || typeof customerSessions.rowCount !== 'number') governanceStorage();
  const platformSessions = await tx.query(
    `UPDATE saas_platform_sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, now],
  );
  if (!platformSessions || typeof platformSessions.rowCount !== 'number') governanceStorage();
}

interface GovernanceAuditEntry {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly actorUserId: string;
  readonly occurredAt: string;
  readonly tenantId?: string;
}

/**
 * Governance audit entries never carry passwords, tokens, hashes, or email
 * addresses — only stable identifiers and the action name.
 */
export async function appendGovernanceAudit(tx: SqlExecutor, entry: GovernanceAuditEntry): Promise<void> {
  const id = randomUUID();
  const result = await tx.query(
    `INSERT INTO saas_audit_events
       (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'platform_governance')`,
    [id, entry.tenantId ?? null, entry.actorUserId, entry.action, entry.targetType, entry.targetId, entry.occurredAt],
  );
  if (!result || result.rowCount !== 1) governanceStorage();
}
