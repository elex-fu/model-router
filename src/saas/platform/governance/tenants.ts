import type { SaasDatabase, SqlExecutor } from '../../db/types.js';
import type { PlatformAdminActor } from '../access/index.js';
import { verifyGovernanceActor } from './actor.js';
import {
  decodeGovernanceCursor,
  encodeGovernanceCursor,
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
import { appendGovernanceAudit } from './users.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CURSOR_PREFIX = 'pt1.';
const MAX_SEARCH_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;

export type PlatformTenantStatus = 'active' | 'suspended' | 'closed';
export type PlatformTenantLifecycleAction = 'suspend' | 'resume' | 'close';

const TENANT_READ_ROLES = ['superadmin', 'security', 'operations', 'support-readonly'] as const;
const TENANT_WRITE_ROLES = ['superadmin', 'operations'] as const;
/** Takeover reassigns ownership without the current owner's consent. */
const TENANT_TAKEOVER_ROLES = ['superadmin'] as const;

export interface PlatformTenantSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: PlatformTenantStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformTenantPage {
  readonly items: readonly PlatformTenantSummary[];
  readonly nextCursor: string | null;
}

export interface PlatformTenantListQuery {
  readonly status?: PlatformTenantStatus;
  readonly slugContains?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export type PlatformTenantLifecycleDatabase = Pick<SaasDatabase, 'query' | 'transaction'>;

export interface PlatformTenantLifecycleServiceOptions {
  readonly cursorSecret?: string | Uint8Array;
  readonly currentDate?: () => Date;
}

interface TenantRow {
  readonly id: unknown;
  readonly name: unknown;
  readonly slug: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
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

function normalizeListQuery(value: unknown): {
  readonly limit: number;
  readonly status: PlatformTenantStatus | null;
  readonly slugContains: string | null;
} {
  if (value === undefined || value === null) return { limit: DEFAULT_PAGE_SIZE, status: null, slugContains: null };
  if (typeof value !== 'object' || Array.isArray(value)) governanceInvalid();
  const candidate = value as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key !== 'status' && key !== 'slugContains' && key !== 'cursor' && key !== 'limit') governanceInvalid();
  }
  const limit = candidate.limit === undefined ? DEFAULT_PAGE_SIZE : candidate.limit;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    governanceInvalid();
  }
  let status: PlatformTenantStatus | null = null;
  if (candidate.status !== undefined && candidate.status !== null) {
    if (candidate.status !== 'active' && candidate.status !== 'suspended' && candidate.status !== 'closed') {
      governanceInvalid();
    }
    status = candidate.status;
  }
  let slugContains: string | null = null;
  if (candidate.slugContains !== undefined && candidate.slugContains !== null) {
    if (
      typeof candidate.slugContains !== 'string' ||
      candidate.slugContains.length === 0 ||
      candidate.slugContains.length > MAX_SEARCH_LENGTH ||
      candidate.slugContains.trim() !== candidate.slugContains ||
      !hasSafeTextCharacters(candidate.slugContains)
    ) {
      governanceInvalid();
    }
    slugContains = candidate.slugContains.toLowerCase();
  }
  return { limit, status, slugContains };
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

function mapTenantRow(row: TenantRow): PlatformTenantSummary {
  if (row === null || typeof row !== 'object') governanceStorage();
  if (typeof row.id !== 'string' || !UUID_PATTERN.test(row.id)) governanceStorage();
  if (
    typeof row.name !== 'string' ||
    row.name.length === 0 ||
    row.name.length > MAX_NAME_LENGTH ||
    !hasSafeTextCharacters(row.name)
  ) {
    governanceStorage();
  }
  if (typeof row.slug !== 'string' || row.slug.length === 0 || row.slug.length > MAX_NAME_LENGTH) governanceStorage();
  if (row.status !== 'active' && row.status !== 'suspended' && row.status !== 'closed') governanceStorage();
  return {
    id: row.id.toLowerCase(),
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
  };
}

export class PlatformTenantLifecycleService {
  private readonly cursorSecret: Uint8Array;
  private readonly currentDate: () => Date;

  constructor(
    private readonly database: PlatformTenantLifecycleDatabase,
    options: PlatformTenantLifecycleServiceOptions = {},
  ) {
    if (!database || typeof database.query !== 'function' || typeof database.transaction !== 'function') {
      throw new TypeError('database must implement the SaaS database contract');
    }
    this.cursorSecret = governanceCursorSecret(options.cursorSecret);
    this.currentDate = options.currentDate ?? (() => new Date());
  }

  async listTenants(actor: PlatformAdminActor, queryInput?: PlatformTenantListQuery): Promise<PlatformTenantPage> {
    const verifiedActor = validateActor(actor);
    const query = normalizeListQuery(queryInput);
    const filterHash = governanceFilterHash('tenants', {
      ...(query.status === null ? {} : { status: query.status }),
      ...(query.slugContains === null ? {} : { slugContains: query.slugContains }),
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
        await verifyGovernanceActor(tx, verifiedActor, TENANT_READ_ROLES);

        const values: unknown[] = [];
        const conditions: string[] = ['TRUE'];
        if (query.status !== null) {
          values.push(query.status);
          conditions.push(`status = $${values.length}`);
        }
        if (query.slugContains !== null) {
          values.push(`%${query.slugContains.replace(/[%_\\]/g, (mark) => `\\${mark}`)}%`);
          conditions.push(`slug_canonical LIKE $${values.length} ESCAPE '\\'`);
        }
        if (cursor !== null) {
          values.push(cursor.occurredAt, cursor.id);
          conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
        }
        values.push(query.limit + 1);

        const result = await tx.query<TenantRow>(
          `SELECT id::text AS id,
                  name,
                  slug_canonical AS slug,
                  status,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
             FROM saas_tenants
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC, id DESC
            LIMIT $${values.length}`,
          values,
        );
        if (!result || !Array.isArray(result.rows)) governanceStorage();
        const rows = result.rows;
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit).map(mapTenantRow);
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
   * suspend: active -> suspended; resume: suspended -> active; close:
   * active|suspended -> closed (terminal). Tenant-scoped access already fails
   * closed for non-active tenants at the identity/billing boundaries.
   */
  async setTenantStatus(
    actor: PlatformAdminActor,
    tenantIdInput: unknown,
    actionInput: unknown,
  ): Promise<PlatformTenantSummary> {
    const verifiedActor = validateActor(actor);
    const tenantId = inputUuid(tenantIdInput);
    if (actionInput !== 'suspend' && actionInput !== 'resume' && actionInput !== 'close') governanceInvalid();
    const action: PlatformTenantLifecycleAction = actionInput;

    try {
      return await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, TENANT_WRITE_ROLES);
        const current = await lockTenant(tx, tenantId);

        const nextStatus: PlatformTenantStatus =
          action === 'suspend' ? 'suspended' : action === 'resume' ? 'active' : 'closed';
        const allowed =
          (action === 'suspend' && current === 'active') ||
          (action === 'resume' && current === 'suspended') ||
          (action === 'close' && current !== 'closed');
        if (!allowed) governanceConflict();

        const now = this.currentDate().toISOString();
        const updated = await tx.query(
          `UPDATE saas_tenants SET status = $2, updated_at = $3 WHERE id = $1 AND status = $4`,
          [tenantId, nextStatus, now, current],
        );
        if (!updated || updated.rowCount !== 1) governanceStorage();
        await appendGovernanceAudit(tx, {
          action: `platform_tenant.${action === 'suspend' ? 'suspended' : action === 'resume' ? 'resumed' : 'closed'}`,
          targetType: 'platform_tenant',
          targetId: tenantId,
          tenantId,
          actorUserId: verifiedActor.userId,
          occurredAt: now,
        });
        const row = await tx.query<TenantRow>(
          `SELECT id::text AS id, name, slug_canonical AS slug, status,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
             FROM saas_tenants WHERE id = $1`,
          [tenantId],
        );
        if (!row || !Array.isArray(row.rows) || row.rows.length !== 1) governanceStorage();
        return mapTenantRow(row.rows[0] as TenantRow);
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }

  /**
   * Superadmin-only ownership reassignment without the current owner's
   * consent: every current owner is demoted to admin and the target — who
   * must already be an active member — becomes owner in the same transaction,
   * preserving the at-least-one-owner invariant by construction.
   */
  async takeoverTenant(actor: PlatformAdminActor, tenantIdInput: unknown, targetUserIdInput: unknown): Promise<void> {
    const verifiedActor = validateActor(actor);
    const tenantId = inputUuid(tenantIdInput);
    const targetUserId = inputUuid(targetUserIdInput);
    if (targetUserId === verifiedActor.userId.toLowerCase()) governanceConflict();

    try {
      await this.database.transaction(async (tx) => {
        await verifyGovernanceActor(tx, verifiedActor, TENANT_TAKEOVER_ROLES);
        const tenantStatus = await lockTenant(tx, tenantId);
        if (tenantStatus === 'closed') governanceConflict();

        const target = await tx.query<{ readonly role: unknown }>(
          `SELECT m.role FROM saas_memberships m
             JOIN saas_users u ON u.id = m.user_id
            WHERE m.tenant_id = $1 AND m.user_id = $2
              AND m.status = 'active' AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
            LIMIT 1 FOR UPDATE OF m`,
          [tenantId, targetUserId],
        );
        if (!target || !Array.isArray(target.rows)) governanceStorage();
        if (target.rows.length !== 1) governanceNotFound();
        if (target.rows[0]?.role === 'owner') governanceConflict();

        const now = this.currentDate().toISOString();
        // Promote first, then demote: at no observable point does the tenant
        // have zero owners.
        const promoted = await tx.query(
          `UPDATE saas_memberships SET role = 'owner', updated_at = $3
            WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
          [tenantId, targetUserId, now],
        );
        if (!promoted || promoted.rowCount !== 1) governanceStorage();
        const demoted = await tx.query(
          `UPDATE saas_memberships SET role = 'admin', updated_at = $3
            WHERE tenant_id = $1 AND user_id <> $2 AND role = 'owner' AND status = 'active'`,
          [tenantId, targetUserId, now],
        );
        if (!demoted || typeof demoted.rowCount !== 'number') governanceStorage();
        await appendGovernanceAudit(tx, {
          action: 'platform_tenant.ownership_taken_over',
          targetType: 'platform_tenant',
          targetId: tenantId,
          tenantId,
          actorUserId: verifiedActor.userId,
          occurredAt: now,
        });
      });
    } catch (error) {
      if (error instanceof PlatformGovernanceError) throw error;
      return governanceStorage();
    }
  }
}

async function lockTenant(tx: SqlExecutor, tenantId: string): Promise<PlatformTenantStatus> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('saas-authz:tenant:' || $1::uuid::text, 0))", [
    tenantId,
  ]);
  const result = await tx.query<{ readonly status: unknown }>(
    `SELECT status FROM saas_tenants WHERE id = $1 LIMIT 1 FOR UPDATE`,
    [tenantId],
  );
  if (!result || !Array.isArray(result.rows)) governanceStorage();
  if (result.rows.length !== 1) governanceNotFound();
  const status = result.rows[0]?.status;
  if (status !== 'active' && status !== 'suspended' && status !== 'closed') governanceStorage();
  return status;
}
