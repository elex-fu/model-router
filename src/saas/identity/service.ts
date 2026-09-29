import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/index.js';
import { SaasIdentityError, type SaasIdentityErrorCode } from './errors.js';
import { hashPassword as hashPasswordValue, verifyPassword as verifyPasswordValue } from './password.js';
import type {
  AcceptInvitationInput,
  BootstrapAdminInput,
  CreateInvitationInput,
  CreateProjectInput,
  CreateTenantInput,
  InvitationRole,
  LoginInput,
  PlatformAdminPasswordAuthentication,
  ProjectRole,
  SaasIdentityServiceOptions,
  SafeIdentity,
  SafeProject,
  SafeSession,
  SafeTenant,
  TenantContext,
  TenantContextInput,
  TenantRole,
} from './types.js';

const BOOTSTRAP_TTL_SECONDS = 15 * 60;
const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_INVITATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const BOOTSTRAP_LOCK_SQL = 'SELECT pg_advisory_xact_lock(1396789587, 1)';
const USER_AUTHORIZATION_FENCE_SQL = 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text, 0))';
const USER_SESSION_MUTATION_FENCE_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))';
const TENANT_AUTHORIZATION_FENCE_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('saas-authz:tenant:' || $1::uuid::text, 0))";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Authorization readers acquire tenant -> project -> sorted user ->
 * entitlement/profile -> provider-rights fences before authority reads.
 * Session mutations follow migration 046's writer order: writer statement
 * fence -> session row -> user fence -> audit. Invitation acceptance first
 * claims its invitation row and then takes only the optional user fence; it
 * never takes the tenant/project fences.
 */

type TimestampValue = string | Date;

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  disabled_at: TimestampValue | null;
  email_verified_at: TimestampValue | null;
  created_at: TimestampValue;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  role: string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
  default_project_id: string | null;
}

interface ProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  role: string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

interface PlatformStateRow {
  initialized: boolean;
  initialized_at: TimestampValue | null;
}

interface TenantContextRow {
  tenant_id: string;
  tenant_role: string;
  project_role: string;
  project_id: string;
}

interface SessionRow {
  user_id: string;
  expires_at: TimestampValue;
  created_at: TimestampValue;
}

interface CustomerSessionRow {
  id: string;
  created_at: TimestampValue;
  expires_at: TimestampValue;
  revoked_at: TimestampValue | null;
  is_current: boolean;
}

interface LockedCustomerSessionRow {
  id: string;
  user_id: string;
  expires_at: TimestampValue;
  revoked_at: TimestampValue | null;
  user_disabled_at: TimestampValue | null;
}

interface RevokedCustomerSessionRow {
  id: string;
  revoked_at: TimestampValue;
  is_current: boolean;
  newly_revoked: boolean;
}

interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role: string;
  expires_at: TimestampValue;
  accepted_at: TimestampValue | null;
  revoked_at: TimestampValue | null;
}

interface DbResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export type CustomerSessionStatus = 'active' | 'revoked' | 'expired';

/** Metadata for a session in the authenticated customer's own session family. */
export interface SafeCustomerSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: CustomerSessionStatus;
  current: boolean;
}

export interface CustomerSessionRevocation {
  sessionId: string;
  revokedAt: string;
  currentSessionRevoked: boolean;
}

export interface OtherCustomerSessionsRevocation {
  revokedCount: number;
  /** Revoking other sessions always leaves the authenticated session active. */
  currentSessionPreserved: true;
}

class CustomerSessionAuthenticationError extends Error {
  readonly status = 401;

  constructor() {
    super('Authentication is required');
    this.name = 'CustomerSessionAuthenticationError';
  }
}

function fail(status: number, code: SaasIdentityErrorCode): never {
  throw new SaasIdentityError(status, code);
}

function normalizeEmail(email: string): string {
  if (typeof email !== 'string') fail(400, 'INVALID_INPUT');
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
    fail(400, 'INVALID_INPUT');
  }
  return normalized;
}

function tryNormalizeEmail(email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 254 && EMAIL_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeDisplayName(displayName: string): string {
  if (typeof displayName !== 'string') fail(400, 'INVALID_INPUT');
  const normalized = displayName.trim();
  if (normalized.length < 1 || normalized.length > 120) fail(400, 'INVALID_INPUT');
  return normalized;
}

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    fail(400, 'INVALID_INPUT');
  }
}

function validateTtl(ttlSeconds: number, maxSeconds: number): void {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxSeconds) {
    fail(400, 'INVALID_INPUT');
  }
}

function validateId(id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 200) {
    fail(400, 'INVALID_INPUT');
  }
}

function iso(value: TimestampValue): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(500, 'IDENTITY_STORAGE_ERROR');
  return date.toISOString();
}

function safeIdentity(row: UserRow): SafeIdentity {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: 'active',
    emailVerifiedAt: row.email_verified_at === null ? null : iso(row.email_verified_at),
    createdAt: iso(row.created_at),
  };
}

function safeSession(row: SessionRow): SafeSession {
  return {
    userId: row.user_id,
    activeTenantId: null,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function safeCustomerSession(row: CustomerSessionRow, now: Date): SafeCustomerSession {
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.is_current !== 'boolean' ||
    row.revoked_at === undefined
  ) {
    fail(500, 'IDENTITY_STORAGE_ERROR');
  }
  const createdAt = iso(row.created_at);
  const expiresAt = iso(row.expires_at);
  const revokedAt = row.revoked_at === null ? null : iso(row.revoked_at);
  const status: CustomerSessionStatus =
    revokedAt !== null ? 'revoked' : new Date(expiresAt).getTime() <= now.getTime() ? 'expired' : 'active';
  return { id: row.id, createdAt, expiresAt, revokedAt, status, current: row.is_current };
}

function isTenantRole(role: unknown): role is TenantRole {
  return role === 'owner' || role === 'admin' || role === 'developer' || role === 'billing' || role === 'viewer';
}

function isProjectRole(role: unknown): role is ProjectRole {
  return role === 'owner' || role === 'admin' || role === 'developer' || role === 'billing' || role === 'viewer';
}

function safeTenant(row: TenantRow): SafeTenant {
  if (
    row.status !== 'active' ||
    !isTenantRole(row.role) ||
    typeof row.default_project_id !== 'string' ||
    row.default_project_id.length === 0
  ) {
    fail(500, 'IDENTITY_STORAGE_ERROR');
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: 'active',
    role: row.role,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    defaultProjectId: row.default_project_id,
  };
}

function safeProject(row: ProjectRow): SafeProject {
  if (
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.tenant_id !== 'string' ||
    row.tenant_id.length === 0 ||
    typeof row.name !== 'string' ||
    typeof row.slug !== 'string' ||
    !isProjectRole(row.role)
  ) {
    fail(500, 'IDENTITY_STORAGE_ERROR');
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function normalizeTenantName(name: string): string {
  if (typeof name !== 'string') fail(400, 'INVALID_INPUT');
  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > 120) fail(400, 'INVALID_INPUT');
  return normalized;
}

function tenantSlug(name: string, requestedSlug?: string): string {
  const candidate =
    requestedSlug === undefined
      ? name
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 63)
      : typeof requestedSlug === 'string'
        ? requestedSlug.trim().toLowerCase()
        : '';
  if (!candidate || candidate.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)) {
    fail(400, 'INVALID_INPUT');
  }
  return candidate;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function issueOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function storageError(error: unknown, uniqueCode: SaasIdentityErrorCode): SaasIdentityError {
  if (error instanceof SaasIdentityError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    return new SaasIdentityError(409, uniqueCode);
  }
  return new SaasIdentityError(500, 'IDENTITY_STORAGE_ERROR');
}

async function hashPassword(password: string): Promise<string> {
  try {
    return await hashPasswordValue(password);
  } catch {
    throw new SaasIdentityError(500, 'IDENTITY_STORAGE_ERROR');
  }
}

async function verifyPassword(password: string, encoded: string | null | undefined): Promise<boolean> {
  try {
    return await verifyPasswordValue(password, encoded);
  } catch {
    throw new SaasIdentityError(500, 'IDENTITY_STORAGE_ERROR');
  }
}

function tokenLooksPresent(token: string): boolean {
  return typeof token === 'string' && token.length >= 16 && token.length <= 256;
}

function invitationRole(value: unknown): value is InvitationRole {
  return value === 'admin' || value === 'developer' || value === 'billing' || value === 'viewer';
}

function chooseDefaultProjectNameAndSlug(existing: Array<{ name: string; slug_canonical: string }>): {
  name: string;
  slug: string;
} {
  const names = new Set(existing.map((row) => row.name.trim().toLowerCase()));
  const slugs = new Set(existing.map((row) => row.slug_canonical.trim().toLowerCase()));
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const name = suffix === 1 ? 'Default' : `Default ${suffix}`;
    const slug = suffix === 1 ? 'default' : `default-${suffix}`;
    if (!names.has(name.toLowerCase()) && !slugs.has(slug)) return { name, slug };
  }
  fail(409, 'IDENTITY_CONFLICT');
}

export class SaasIdentityService {
  private readonly now: () => Date;

  constructor(
    private readonly database: SaasDatabase,
    options: SaasIdentityServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private currentDate(): Date {
    const value = this.now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) fail(500, 'IDENTITY_STORAGE_ERROR');
    return date;
  }

  private async query<Row>(
    executor: SqlExecutor,
    sql: string,
    values: unknown[] = [],
    uniqueCode: SaasIdentityErrorCode = 'IDENTITY_CONFLICT',
  ): Promise<DbResult<Row>> {
    try {
      return await executor.query<Row>(sql, values);
    } catch (error) {
      throw storageError(error, uniqueCode);
    }
  }

  private async transaction<T>(
    work: (tx: SqlExecutor) => Promise<T>,
    uniqueCode: SaasIdentityErrorCode = 'IDENTITY_CONFLICT',
  ): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (error instanceof CustomerSessionAuthenticationError) throw error;
      throw storageError(error, uniqueCode);
    }
  }

  /**
   * Authorization transactions acquire tenant fences before user fences, then
   * perform fresh READ COMMITTED authority reads. The user key matches the
   * ordered per-user fence installed by migration 046.
   */
  private async fenceTenantAuthorization(tx: SqlExecutor, tenantId: string): Promise<void> {
    await this.query(tx, TENANT_AUTHORIZATION_FENCE_SQL, [tenantId]);
  }

  private async fenceUserAuthorization(tx: SqlExecutor, userId: string): Promise<void> {
    await this.query(tx, USER_AUTHORIZATION_FENCE_SQL, [userId]);
  }

  private async fenceUserSessionMutation(tx: SqlExecutor, userId: string): Promise<void> {
    await this.query(tx, USER_SESSION_MUTATION_FENCE_SQL, [userId]);
  }

  private async fenceAuthorizationWriters(tx: SqlExecutor): Promise<void> {
    await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
    await this.query(tx, SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
  }

  private async readPlatformState(executor: SqlExecutor, forUpdate = false): Promise<PlatformStateRow> {
    const result = await this.query<PlatformStateRow>(
      executor,
      `SELECT initialized, initialized_at
       FROM saas_platform_state
       WHERE singleton = TRUE
       LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    );
    const state = result.rows[0];
    if (
      !state ||
      typeof state.initialized !== 'boolean' ||
      (state.initialized && state.initialized_at === null) ||
      (!state.initialized && state.initialized_at !== null)
    ) {
      fail(500, 'IDENTITY_STORAGE_ERROR');
    }
    return state;
  }

  private async markPlatformInitialized(executor: SqlExecutor): Promise<void> {
    const result = await this.query<PlatformStateRow>(
      executor,
      `UPDATE saas_platform_state
       SET initialized = TRUE
       WHERE singleton = TRUE AND initialized = FALSE
       RETURNING initialized, initialized_at`,
    );
    if (result.rows.length === 1) return;

    const state = await this.readPlatformState(executor);
    if (state.initialized) fail(409, 'BOOTSTRAP_ALREADY_COMPLETED');
    fail(500, 'IDENTITY_STORAGE_ERROR');
  }

  private async findUserByEmail(email: string, executor: SqlExecutor = this.database): Promise<UserRow | undefined> {
    const result = await this.query<UserRow>(
      executor,
      `SELECT id, email_canonical AS email, display_name, password_hash,
              disabled_at, email_verified_at, created_at
       FROM saas_users WHERE email_canonical = $1 LIMIT 1`,
      [email],
    );
    return result.rows[0];
  }

  private async findPlatformAdminByEmail(
    email: string,
    executor: SqlExecutor = this.database,
  ): Promise<UserRow | undefined> {
    const result = await this.query<UserRow>(
      executor,
      `SELECT u.id, u.email_canonical AS email, u.display_name, u.password_hash,
              u.disabled_at, u.email_verified_at, u.created_at
       FROM saas_users u
       JOIN saas_platform_role_assignments r ON r.user_id = u.id
       WHERE u.email_canonical = $1 AND u.disabled_at IS NULL AND r.role = 'superadmin'
       LIMIT 1`,
      [email],
    );
    return result.rows[0];
  }

  /**
   * Authenticate only an active user with a current superadmin assignment.
   * Unknown users, disabled users, non-superadmins, malformed credentials, and
   * wrong passwords all return the same undefined result after password work.
   */
  async authenticatePlatformAdminPassword(
    email: string,
    password: string,
  ): Promise<PlatformAdminPasswordAuthentication | undefined> {
    const normalizedEmail = tryNormalizeEmail(email);
    const candidatePassword = typeof password === 'string' && password.length <= 1024 ? password : '';
    const user = normalizedEmail ? await this.findPlatformAdminByEmail(normalizedEmail) : undefined;
    const passwordMatches = await verifyPassword(candidatePassword, user?.password_hash);
    if (!user || !passwordMatches || user.disabled_at !== null) return undefined;
    return { userId: user.id, email: user.email };
  }

  async bootstrapStatus(): Promise<{ initialized: boolean; bootstrapRequired: boolean }> {
    const { initialized } = await this.readPlatformState(this.database);
    return { initialized, bootstrapRequired: !initialized };
  }

  async issueBootstrapToken(createdBy?: string): Promise<{ token: string; expiresAt: string }> {
    if (createdBy !== undefined) validateId(createdBy);
    const token = issueOpaqueToken();
    const tokenHash = hashToken(token);

    const expiresAt = await this.transaction(async (tx) => {
      await this.query(tx, BOOTSTRAP_LOCK_SQL);
      if ((await this.readPlatformState(tx, true)).initialized) {
        fail(409, 'BOOTSTRAP_ALREADY_COMPLETED');
      }

      if (createdBy !== undefined) {
        const creator = await this.query<{ id: string }>(
          tx,
          `SELECT id FROM saas_users WHERE id = $1 AND disabled_at IS NULL LIMIT 1`,
          [createdBy],
        );
        if (creator.rows.length === 0) fail(400, 'INVALID_INPUT');
      }

      const now = this.currentDate();
      const expiry = new Date(now.getTime() + BOOTSTRAP_TTL_SECONDS * 1000);
      const pending = await this.query<{ token_hash: string }>(
        tx,
        `SELECT token_hash FROM saas_bootstrap_tokens
         WHERE consumed_at IS NULL AND expires_at > $1 LIMIT 1`,
        [now.toISOString()],
      );
      if (pending.rows.length > 0) fail(409, 'BOOTSTRAP_TOKEN_ALREADY_ISSUED');

      await this.query(
        tx,
        `INSERT INTO saas_bootstrap_tokens
         (token_hash, expires_at, consumed_at, created_by_user_id, created_at)
         VALUES ($1, $2, NULL, $3, $4)`,
        [tokenHash, expiry.toISOString(), createdBy ?? null, now.toISOString()],
      );
      return expiry.toISOString();
    });

    return { token, expiresAt };
  }

  async bootstrapPlatformAdmin(input: BootstrapAdminInput): Promise<SafeIdentity> {
    const token = input?.token;
    if (!tokenLooksPresent(token)) fail(400, 'INVALID_INPUT');
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    validatePassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const userId = randomUUID();

    return this.transaction(async (tx) => {
      // The role-assignment INSERT invokes migration 046's global writer
      // trigger. Acquire it before the bootstrap advisory and state row lock.
      await this.fenceAuthorizationWriters(tx);
      await this.query(tx, BOOTSTRAP_LOCK_SQL);
      if ((await this.readPlatformState(tx, true)).initialized) {
        fail(409, 'BOOTSTRAP_ALREADY_COMPLETED');
      }

      const now = this.currentDate();
      const consumed = await this.query<{ token_hash: string }>(
        tx,
        `UPDATE saas_bootstrap_tokens SET consumed_at = $2
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
         RETURNING token_hash`,
        [hashToken(token), now.toISOString()],
        'BOOTSTRAP_TOKEN_INVALID',
      );
      if (consumed.rows.length === 0) fail(401, 'BOOTSTRAP_TOKEN_INVALID');

      const existing = await this.query<{ id: string }>(
        tx,
        'SELECT id FROM saas_users WHERE email_canonical = $1 LIMIT 1',
        [email],
      );
      if (existing.rows.length > 0) fail(409, 'EMAIL_ALREADY_EXISTS');

      const user = await this.query<UserRow>(
        tx,
        `INSERT INTO saas_users
         (id, email, password_hash, display_name, email_verified_at, disabled_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)
         RETURNING id, email_canonical AS email, display_name, password_hash,
                   disabled_at, email_verified_at, created_at`,
        [userId, email, passwordHash, displayName, now.toISOString()],
        'EMAIL_ALREADY_EXISTS',
      );
      await this.query(
        tx,
        `INSERT INTO saas_platform_role_assignments
         (user_id, role, granted_at, granted_by_user_id)
         VALUES ($1, 'superadmin', $2, NULL)`,
        [userId, now.toISOString()],
        'BOOTSTRAP_ALREADY_COMPLETED',
      );
      await this.markPlatformInitialized(tx);
      const createdUser = user.rows[0];
      if (!createdUser) fail(500, 'IDENTITY_STORAGE_ERROR');
      return safeIdentity(createdUser);
    }, 'EMAIL_ALREADY_EXISTS');
  }

  async login(input: LoginInput): Promise<{ token: string; csrfToken: string; session: SafeSession } | undefined> {
    const email = normalizeEmail(input.email);
    validatePassword(input.password);
    validateTtl(input.ttlSeconds, MAX_SESSION_TTL_SECONDS);

    const user = await this.findUserByEmail(email);
    const passwordMatches = await verifyPassword(input.password, user?.password_hash);
    if (!user || !passwordMatches || user.disabled_at !== null) return undefined;

    const token = issueOpaqueToken();
    const csrfToken = issueOpaqueToken();
    const tokenHash = hashToken(token);
    const csrfTokenHash = hashToken(csrfToken);
    const now = this.currentDate();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
    const sessionId = randomUUID();

    const session = await this.transaction(async (tx) => {
      // Session INSERT invokes migration 046's global writer trigger. Keep
      // the writer -> entity-fence order before the user recheck.
      await this.fenceAuthorizationWriters(tx);
      await this.fenceUserAuthorization(tx, user.id);
      const activeUser = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_users
         WHERE id = $1 AND email_canonical = $2 AND password_hash = $3
           AND disabled_at IS NULL
         LIMIT 1`,
        [user.id, user.email, user.password_hash],
      );
      if (activeUser.rows.length === 0) return undefined;

      const createdAt = this.currentDate().toISOString();
      await this.query(
        tx,
        `INSERT INTO saas_sessions
         (id, user_id, token_hash, csrf_token_hash, created_at, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
        [sessionId, user.id, tokenHash, csrfTokenHash, createdAt, expiresAt.toISOString()],
      );
      return {
        userId: user.id,
        activeTenantId: null,
        expiresAt: expiresAt.toISOString(),
        createdAt,
      } satisfies SafeSession;
    });

    return session ? { token, csrfToken, session } : undefined;
  }

  async getSession(token: string): Promise<SafeSession | undefined> {
    if (!tokenLooksPresent(token)) return undefined;
    const now = this.currentDate().toISOString();
    const result = await this.query<SessionRow>(
      this.database,
      `SELECT s.user_id, s.expires_at, s.created_at
       FROM saas_sessions s
       JOIN saas_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
         AND u.disabled_at IS NULL LIMIT 1`,
      [hashToken(token), now],
    );
    return result.rows[0] ? safeSession(result.rows[0]) : undefined;
  }

  async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
    if (!tokenLooksPresent(token) || !tokenLooksPresent(csrfToken)) return false;
    const now = this.currentDate().toISOString();
    const result = await this.query<{ csrf_token_hash: string }>(
      this.database,
      `SELECT s.csrf_token_hash FROM saas_sessions s
       JOIN saas_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
         AND u.disabled_at IS NULL LIMIT 1`,
      [hashToken(token), now],
    );
    const stored = result.rows[0]?.csrf_token_hash;
    if (!stored) return false;
    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(hashToken(csrfToken), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async logout(token: string): Promise<void> {
    if (!tokenLooksPresent(token)) return;
    await this.query(
      this.database,
      `UPDATE saas_sessions SET revoked_at = COALESCE(revoked_at, $2)
       WHERE token_hash = $1`,
      [hashToken(token), this.currentDate().toISOString()],
    );
  }

  async listSessions(token: string): Promise<SafeCustomerSession[] | undefined> {
    if (!tokenLooksPresent(token)) return undefined;
    const now = this.currentDate();
    const result = await this.query<CustomerSessionRow>(
      this.database,
      `WITH authenticated_customer_session AS (
         SELECT current_session.user_id
         FROM saas_sessions current_session
         JOIN saas_users session_owner ON session_owner.id = current_session.user_id
         WHERE current_session.token_hash = $1
           AND current_session.revoked_at IS NULL
           AND current_session.expires_at > $2
           AND session_owner.disabled_at IS NULL
         LIMIT 1
       )
       SELECT listed_session.id, listed_session.created_at, listed_session.expires_at,
              listed_session.revoked_at, (listed_session.token_hash = $1) AS is_current
       FROM saas_sessions listed_session
       JOIN authenticated_customer_session caller
         ON caller.user_id = listed_session.user_id
       ORDER BY listed_session.created_at DESC, listed_session.id`,
      [hashToken(token), now.toISOString()],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows.map((row) => safeCustomerSession(row, now));
  }

  private async lockActiveCustomerSession(tx: SqlExecutor, token: string): Promise<{ id: string; userId: string }> {
    if (!tokenLooksPresent(token)) throw new CustomerSessionAuthenticationError();
    const tokenHash = hashToken(token);
    const hint = await this.query<{ id: string; user_id: string }>(
      tx,
      `SELECT id, user_id FROM saas_sessions WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
    );
    const sessionHint = hint.rows[0];
    if (!sessionHint) throw new CustomerSessionAuthenticationError();

    // Migration 046 takes its global writer fence before tuple locks and the
    // per-user fence after them. Match that order to serialize against both
    // session revocation and user disablement without an advisory/tuple cycle.
    await this.fenceAuthorizationWriters(tx);
    const locked = await this.query<{
      id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
    }>(
      tx,
      `SELECT id, user_id, expires_at, revoked_at
       FROM saas_sessions
       WHERE token_hash = $1 AND id = $2 AND user_id = $3
       LIMIT 1 FOR UPDATE`,
      [tokenHash, sessionHint.id, sessionHint.user_id],
    );
    const lockedSession = locked.rows[0];
    if (!lockedSession) throw new CustomerSessionAuthenticationError();

    await this.fenceUserSessionMutation(tx, lockedSession.user_id);
    // This new READ COMMITTED statement follows the fence wait. The held row
    // lock protects revocation; the fresh join observes committed disablement.
    const result = await this.query<LockedCustomerSessionRow>(
      tx,
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.disabled_at AS user_disabled_at
       FROM saas_sessions s
       JOIN saas_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.id = $2 AND s.user_id = $3
       LIMIT 1`,
      [tokenHash, lockedSession.id, lockedSession.user_id],
    );
    const row = result.rows[0];
    if (!row) throw new CustomerSessionAuthenticationError();

    // Take the time after acquiring the row locks so a session that expires
    // while this transaction waits cannot authorize a write.
    const now = this.currentDate();
    if (
      row.revoked_at !== null ||
      new Date(iso(row.expires_at)).getTime() <= now.getTime() ||
      row.user_disabled_at !== null
    ) {
      throw new CustomerSessionAuthenticationError();
    }
    return { id: row.id, userId: row.user_id };
  }

  private async appendCustomerSessionAudit(
    tx: SqlExecutor,
    actorUserId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    occurredAt: string,
    requestId: string,
  ): Promise<void> {
    await this.query(
      tx,
      `INSERT INTO saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point, request_id)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, 'customer_identity_sessions', $7)`,
      [randomUUID(), actorUserId, action, targetType, targetId, occurredAt, requestId],
    );
  }

  async revokeSession(
    token: string,
    sessionId: string,
    requestId: string = randomUUID(),
  ): Promise<CustomerSessionRevocation | undefined> {
    validateId(sessionId);
    return this.transaction(async (tx) => {
      const current = await this.lockActiveCustomerSession(tx, token);
      const result = await this.query<RevokedCustomerSessionRow>(
        tx,
        `WITH selected_session AS (
           SELECT id, revoked_at AS previous_revoked_at FROM saas_sessions
           WHERE user_id = $1 AND id = $2
           FOR UPDATE
         ), changed_session AS (
           UPDATE saas_sessions AS target
           SET revoked_at = COALESCE(target.revoked_at, $3)
           FROM selected_session
           WHERE target.id = selected_session.id
           RETURNING target.id, target.revoked_at, (target.id = $4) AS is_current,
                     (selected_session.previous_revoked_at IS NULL) AS newly_revoked
         )
         SELECT id, revoked_at, is_current, newly_revoked FROM changed_session`,
        [current.userId, sessionId, this.currentDate().toISOString(), current.id],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      if (typeof row.is_current !== 'boolean' || typeof row.newly_revoked !== 'boolean') {
        fail(500, 'IDENTITY_STORAGE_ERROR');
      }
      if (row.newly_revoked) {
        await this.appendCustomerSessionAudit(
          tx,
          current.userId,
          'customer_session.revoked',
          'saas_session',
          row.id,
          iso(row.revoked_at),
          requestId,
        );
      }
      return {
        sessionId: row.id,
        revokedAt: iso(row.revoked_at),
        currentSessionRevoked: row.is_current,
      };
    });
  }

  async revokeOtherSessions(token: string, requestId: string = randomUUID()): Promise<OtherCustomerSessionsRevocation> {
    return this.transaction(async (tx) => {
      const current = await this.lockActiveCustomerSession(tx, token);
      const now = this.currentDate().toISOString();
      const result = await this.query<{ id: string }>(
        tx,
        `UPDATE saas_sessions
         SET revoked_at = $3
         WHERE user_id = $1 AND id <> $2
           AND revoked_at IS NULL AND expires_at > $3
         RETURNING id`,
        [current.userId, current.id, now],
      );
      if (result.rows.length > 0) {
        await this.appendCustomerSessionAudit(
          tx,
          current.userId,
          'customer_sessions.other_sessions_revoked',
          'saas_session_family',
          null,
          now,
          requestId,
        );
      }
      return { revokedCount: result.rows.length, currentSessionPreserved: true };
    });
  }

  async createTenant(userId: string, input: CreateTenantInput): Promise<SafeTenant> {
    validateId(userId);
    const name = normalizeTenantName(input.name);
    const slug = tenantSlug(name, input.slug);
    const tenantId = randomUUID();
    const defaultProjectId = randomUUID();

    return this.transaction(async (tx) => {
      await this.fenceUserAuthorization(tx, userId);
      const user = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_users WHERE id = $1 AND disabled_at IS NULL LIMIT 1`,
        [userId],
      );
      if (user.rows.length === 0) fail(404, 'TENANT_ACCESS_DENIED');
      const now = this.currentDate().toISOString();
      const tenant = await this.query<TenantRow>(
        tx,
        `INSERT INTO saas_tenants (id, name, slug, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $4)
         RETURNING id, name, slug, status, created_at, updated_at`,
        [tenantId, name, slug, now],
        'TENANT_SLUG_TAKEN',
      );

      await this.query(
        tx,
        `INSERT INTO saas_memberships (tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, 'owner', $3, $3)`,
        [tenantId, userId, now],
      );

      const existingProjects = await this.query<{ name: string; slug_canonical: string }>(
        tx,
        `SELECT name, slug_canonical FROM saas_projects WHERE tenant_id = $1`,
        [tenantId],
      );
      const defaultProject = chooseDefaultProjectNameAndSlug(existingProjects.rows);
      await this.query(
        tx,
        `INSERT INTO saas_projects (tenant_id, id, name, slug, is_default, created_at, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, $5, $5)`,
        [tenantId, defaultProjectId, defaultProject.name, defaultProject.slug, now],
      );
      await this.query(
        tx,
        `INSERT INTO saas_project_memberships
         (tenant_id, project_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, 'owner', $4, $4)`,
        [tenantId, defaultProjectId, userId, now],
      );

      const created = tenant.rows[0];
      if (!created) fail(500, 'IDENTITY_STORAGE_ERROR');
      return safeTenant({ ...created, role: 'owner', default_project_id: defaultProjectId });
    }, 'TENANT_SLUG_TAKEN');
  }

  async listTenants(userId: string): Promise<SafeTenant[]> {
    validateId(userId);
    const result = await this.query<TenantRow>(
      this.database,
      `SELECT t.id, t.name, t.slug, t.status, m.role, t.created_at, t.updated_at,
              default_project.id AS default_project_id
       FROM saas_tenants t
       JOIN saas_memberships m ON m.tenant_id = t.id
       JOIN saas_users u ON u.id = m.user_id
       LEFT JOIN LATERAL (
         SELECT p.id
         FROM saas_projects p
         WHERE p.tenant_id = t.id AND p.is_default = TRUE
         LIMIT 1
       ) default_project ON TRUE
       JOIN saas_project_memberships pm
         ON pm.tenant_id = t.id AND pm.project_id = default_project.id
        AND pm.user_id = m.user_id AND pm.status = 'active'
       WHERE m.user_id = $1 AND m.status = 'active'
         AND t.status = 'active' AND u.disabled_at IS NULL
       ORDER BY t.name, t.id`,
      [userId],
    );
    return result.rows.map(safeTenant);
  }

  async listProjects(userId: string, tenantId: string): Promise<SafeProject[]> {
    validateId(userId);
    validateId(tenantId);
    const result = await this.query<ProjectRow>(
      this.database,
      `SELECT p.id, p.tenant_id, p.name, p.slug, pm.role, p.created_at, p.updated_at
       FROM saas_tenants t
       JOIN saas_memberships tm ON tm.tenant_id = t.id
       JOIN saas_users u ON u.id = tm.user_id
       JOIN saas_projects p ON p.tenant_id = t.id
       JOIN saas_project_memberships pm
         ON pm.tenant_id = p.tenant_id AND pm.project_id = p.id
        AND pm.user_id = tm.user_id AND pm.status = 'active'
       WHERE t.id = $1 AND tm.user_id = $2 AND tm.status = 'active'
         AND t.status = 'active' AND u.disabled_at IS NULL
       ORDER BY p.name, p.id`,
      [tenantId, userId],
    );
    if (result.rows.length === 0) fail(403, 'TENANT_ACCESS_DENIED');
    return result.rows.map(safeProject);
  }

  async createProject(actorUserId: string, tenantId: string, input: CreateProjectInput): Promise<SafeProject> {
    validateId(actorUserId);
    validateId(tenantId);
    const name = normalizeTenantName(input.name);
    const slug = tenantSlug(name, input.slug);
    const projectId = randomUUID();

    return this.transaction(async (tx) => {
      // Tenant and user fences precede the authority read and project writes.
      // Their database triggers serialize membership/tenant and user changes.
      await this.fenceTenantAuthorization(tx, tenantId);
      await this.fenceUserAuthorization(tx, actorUserId);
      const actor = await this.query<{ role: string }>(
        tx,
        `SELECT m.role FROM saas_memberships m
         JOIN saas_tenants t ON t.id = m.tenant_id
         JOIN saas_users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND m.user_id = $2
           AND m.status = 'active' AND t.status = 'active' AND u.disabled_at IS NULL
         LIMIT 1`,
        [tenantId, actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (!actorRole || !isTenantRole(actorRole)) fail(403, 'TENANT_ACCESS_DENIED');
      if (actorRole !== 'owner' && actorRole !== 'admin') fail(403, 'INSUFFICIENT_TENANT_ROLE');

      const now = this.currentDate().toISOString();
      const project = await this.query<ProjectRow>(
        tx,
        `INSERT INTO saas_projects (tenant_id, id, name, slug, is_default, created_at, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, $5, $5)
         RETURNING id, tenant_id, name, slug, created_at, updated_at`,
        [tenantId, projectId, name, slug, now],
      );
      const created = project.rows[0];
      if (!created) fail(500, 'IDENTITY_STORAGE_ERROR');

      await this.query(
        tx,
        `INSERT INTO saas_project_memberships
         (tenant_id, project_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [tenantId, projectId, actorUserId, actorRole, now],
      );

      return safeProject({ ...created, role: actorRole });
    }, 'IDENTITY_CONFLICT');
  }

  private async queryTenantContext(
    executor: SqlExecutor,
    input: TenantContextInput,
  ): Promise<DbResult<TenantContextRow>> {
    const projectId = input.projectId;
    if (projectId === undefined) {
      return this.query<TenantContextRow>(
        executor,
        `SELECT t.id AS tenant_id, m.role AS tenant_role,
                pm.role AS project_role, default_project.id AS project_id
         FROM saas_tenants t
         JOIN saas_memberships m ON m.tenant_id = t.id
         JOIN saas_users u ON u.id = m.user_id
         JOIN LATERAL (
           SELECT p.id
           FROM saas_projects p
           WHERE p.tenant_id = t.id AND p.is_default = TRUE
           LIMIT 1
         ) default_project ON TRUE
         JOIN saas_project_memberships pm
           ON pm.tenant_id = t.id AND pm.project_id = default_project.id
          AND pm.user_id = m.user_id AND pm.status = 'active'
         WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'
           AND t.status = 'active' AND u.disabled_at IS NULL
         LIMIT 1`,
        [input.tenantId, input.userId],
      );
    }

    return this.query<TenantContextRow>(
      executor,
      `SELECT t.id AS tenant_id, m.role AS tenant_role,
              pm.role AS project_role, p.id AS project_id
       FROM saas_tenants t
       JOIN saas_memberships m ON m.tenant_id = t.id
       JOIN saas_users u ON u.id = m.user_id
       JOIN saas_projects p ON p.tenant_id = t.id AND p.id = $3
       JOIN saas_project_memberships pm
         ON pm.tenant_id = t.id AND pm.project_id = p.id
        AND pm.user_id = m.user_id AND pm.status = 'active'
       WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active'
         AND t.status = 'active' AND u.disabled_at IS NULL
       LIMIT 1`,
      [input.tenantId, input.userId, projectId],
    );
  }

  /** Resolve a client-selected tenant/project into an authorized server context. */
  async resolveTenantContext(input: TenantContextInput): Promise<TenantContext> {
    validateId(input.userId);
    validateId(input.tenantId);
    if (input.projectId !== undefined) validateId(input.projectId);

    const result = await this.queryTenantContext(this.database, input);
    const row = result.rows[0];
    if (!row || !isTenantRole(row.tenant_role) || !isProjectRole(row.project_role)) {
      fail(404, 'TENANT_ACCESS_DENIED');
    }
    if (typeof row.project_id !== 'string' || row.project_id.length === 0) {
      fail(500, 'IDENTITY_STORAGE_ERROR');
    }
    return {
      userId: input.userId,
      tenantId: row.tenant_id,
      projectId: row.project_id,
      tenantRole: row.tenant_role,
      projectRole: row.project_role,
    };
  }

  /** Authorize an explicit project selection; omission is not an authorization grant. */
  async authorizeProjectAccess(input: TenantContextInput & { projectId: string }): Promise<TenantContext> {
    validateId(input.projectId);
    return this.resolveTenantContext(input);
  }

  async createInvitation(
    actorUserId: string,
    tenantId: string,
    input: CreateInvitationInput,
  ): Promise<{ invitationId: string; token: string; expiresAt: string }> {
    validateId(actorUserId);
    validateId(tenantId);
    const email = normalizeEmail(input.email);
    if (!invitationRole(input.role)) fail(400, 'INVALID_INVITATION_ROLE');
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS;
    validateTtl(ttlSeconds, MAX_INVITATION_TTL_SECONDS);

    const token = issueOpaqueToken();
    const tokenHash = hashToken(token);
    const invitationId = randomUUID();

    const expiresAt = await this.transaction(async (tx) => {
      await this.fenceTenantAuthorization(tx, tenantId);
      await this.fenceUserAuthorization(tx, actorUserId);
      const actor = await this.query<{ role: string }>(
        tx,
        `SELECT m.role FROM saas_memberships m
         JOIN saas_tenants t ON t.id = m.tenant_id
         JOIN saas_users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND m.user_id = $2
           AND m.status = 'active' AND t.status = 'active' AND u.disabled_at IS NULL LIMIT 1`,
        [tenantId, actorUserId],
      );
      const actorRole = actor.rows[0]?.role;
      if (!actorRole || !isTenantRole(actorRole)) fail(404, 'TENANT_ACCESS_DENIED');
      if (actorRole !== 'owner' && actorRole !== 'admin') fail(403, 'INSUFFICIENT_TENANT_ROLE');
      if (actorRole === 'admin' && input.role === 'admin') {
        fail(403, 'INSUFFICIENT_TENANT_ROLE');
      }

      const existingMember = await this.query<{ user_id: string }>(
        tx,
        `SELECT m.user_id FROM saas_memberships m
         JOIN saas_users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND u.email_canonical = $2 LIMIT 1`,
        [tenantId, email],
      );
      if (existingMember.rows.length > 0) fail(409, 'INVITATION_ALREADY_MEMBER');

      const now = this.currentDate();
      const pending = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_invitations
         WHERE tenant_id = $1 AND invited_email_canonical = $2
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $3 LIMIT 1`,
        [tenantId, email, now.toISOString()],
      );
      if (pending.rows.length > 0) fail(409, 'INVITATION_PENDING');

      const expiry = new Date(now.getTime() + ttlSeconds * 1000);
      await this.query(
        tx,
        `INSERT INTO saas_invitations
         (tenant_id, id, invited_email, role, token_hash, created_by_user_id,
          accepted_by_user_id, created_at, expires_at, accepted_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, NULL, NULL)`,
        [tenantId, invitationId, email, input.role, tokenHash, actorUserId, now.toISOString(), expiry.toISOString()],
        'INVITATION_PENDING',
      );
      return expiry.toISOString();
    }, 'INVITATION_PENDING');

    return { invitationId, token, expiresAt };
  }

  async acceptInvitation(input: AcceptInvitationInput): Promise<SafeIdentity> {
    if (!tokenLooksPresent(input?.token)) fail(400, 'INVITATION_INVALID');
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    validatePassword(input.password);
    const tokenHash = hashToken(input.token);

    const preflightNow = this.currentDate();
    const invitationResult = await this.query<InvitationRow>(
      this.database,
      `SELECT id, tenant_id, invited_email_canonical AS email, role,
              expires_at, accepted_at, revoked_at
       FROM saas_invitations WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
    );
    const preflightInvitation = invitationResult.rows[0];
    if (
      !preflightInvitation ||
      preflightInvitation.email !== email ||
      preflightInvitation.accepted_at !== null ||
      preflightInvitation.revoked_at !== null ||
      Date.parse(iso(preflightInvitation.expires_at)) <= preflightNow.getTime()
    ) {
      fail(400, 'INVITATION_INVALID');
    }

    const preflightUser = await this.findUserByEmail(email);
    let newPasswordHash: string | undefined;
    if (preflightUser) {
      if (preflightUser.disabled_at !== null || !(await verifyPassword(input.password, preflightUser.password_hash))) {
        fail(400, 'INVITATION_INVALID');
      }
    } else {
      newPasswordHash = await hashPassword(input.password);
    }

    const createdUser = await this.transaction(async (tx) => {
      const now = this.currentDate();
      const locked = await this.query<InvitationRow>(
        tx,
        `SELECT id, tenant_id, invited_email_canonical AS email, role,
                expires_at, accepted_at, revoked_at
         FROM saas_invitations WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const invitation = locked.rows[0];
      if (
        !invitation ||
        invitation.email !== email ||
        invitation.accepted_at !== null ||
        invitation.revoked_at !== null ||
        Date.parse(iso(invitation.expires_at)) <= now.getTime()
      ) {
        fail(400, 'INVITATION_INVALID');
      }
      if (!invitationRole(invitation.role)) fail(400, 'INVITATION_INVALID');

      const tenant = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_tenants WHERE id = $1 AND status = 'active' LIMIT 1`,
        [invitation.tenant_id],
      );
      if (tenant.rows.length === 0) fail(400, 'INVITATION_INVALID');

      let user = await this.findUserByEmail(email, tx);
      if (user) {
        const hintedUserId = user.id;
        await this.fenceUserAuthorization(tx, hintedUserId);
        user = await this.findUserByEmail(email, tx);
        if (!user || user.id !== hintedUserId) fail(400, 'INVITATION_INVALID');
        if (user.disabled_at !== null) fail(400, 'INVITATION_INVALID');
        if (user.id !== preflightUser?.id && !(await verifyPassword(input.password, user.password_hash))) {
          fail(400, 'INVITATION_INVALID');
        }
      } else {
        const passwordHash = newPasswordHash ?? (await hashPassword(input.password));
        const inserted = await this.query<UserRow>(
          tx,
          `INSERT INTO saas_users
           (id, email, password_hash, display_name, email_verified_at, disabled_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)
           RETURNING id, email_canonical AS email, display_name, password_hash,
                     disabled_at, email_verified_at, created_at`,
          [randomUUID(), email, passwordHash, displayName, now.toISOString()],
          'EMAIL_ALREADY_EXISTS',
        );
        user = inserted.rows[0];
        if (!user) fail(500, 'IDENTITY_STORAGE_ERROR');
      }

      const existingMembership = await this.query<{ tenant_id: string; user_id: string }>(
        tx,
        `SELECT tenant_id, user_id FROM saas_memberships
         WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
        [invitation.tenant_id, user.id],
      );
      if (existingMembership.rows.length > 0) fail(409, 'INVITATION_ALREADY_MEMBER');

      await this.query(
        tx,
        `INSERT INTO saas_memberships (tenant_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [invitation.tenant_id, user.id, invitation.role, now.toISOString()],
      );

      const defaultProject = await this.query<{ id: string }>(
        tx,
        `SELECT id FROM saas_projects
         WHERE tenant_id = $1 AND is_default = TRUE
         LIMIT 1`,
        [invitation.tenant_id],
      );
      const defaultProjectId = defaultProject.rows[0]?.id;
      if (!defaultProjectId) fail(400, 'INVITATION_INVALID');

      await this.query(
        tx,
        `INSERT INTO saas_project_memberships
         (tenant_id, project_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [invitation.tenant_id, defaultProjectId, user.id, invitation.role, now.toISOString()],
      );

      const accepted = await this.query<{ id: string }>(
        tx,
        `UPDATE saas_invitations
         SET accepted_at = $3, accepted_by_user_id = $4
         WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL
           AND revoked_at IS NULL AND expires_at > $3
         RETURNING id`,
        [invitation.tenant_id, invitation.id, now.toISOString(), user.id],
      );
      if (accepted.rows.length === 0) fail(400, 'INVITATION_INVALID');
      return user;
    }, 'INVITATION_ALREADY_MEMBER');

    return safeIdentity(createdUser);
  }
}
