import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';

/**
 * Track G4 announcements (design: docs/marketing-domain-design-2026-10-11.md
 * §7). Operators create a draft, publish it once and may withdraw it; the
 * state machine draft -> published -> withdrawn is one-way and backed by the
 * migration 092 guard trigger (identity columns immutable, version must
 * increment by exactly one). Publish is the only transition that produces
 * the platform.maintenance webhook event: the event port runs inside the
 * same transaction as the guarded CAS, so the event commits or rolls back
 * with the transition and fires exactly once (only the draft -> published
 * CAS winner reaches the port). Withdraw and any later unpublish-window
 * adjustment never re-fire it.
 *
 * The event port is a seam: the F3 producer fan-out is wired in the managed
 * composition (managed-saas.ts); until then the port may be omitted and no
 * webhook event is produced. The audit row is always written in the same
 * transaction regardless of the port.
 *
 * Customer-side reads see only published announcements inside their
 * visibility window (publish_at <= now < unpublish_at when set), ordered by
 * severity then recency; read receipts are idempotent via INSERT ON
 * CONFLICT DO NOTHING on the (announcement, user) primary key.
 *
 * G4.5 fan-out cursor methods (migration 095): the published announcement
 * row itself is the fan-out cursor — `fanout_completed_at` NULL means the
 * platform.maintenance webhook event has not been fanned out to tenant
 * endpoints yet. The fan-out worker claims due rows with FOR UPDATE SKIP
 * LOCKED, enqueues per entitled tenant (idempotency key
 * `announcement:<id>:<tenant>`) and only then writes the completion
 * timestamp, so a crash mid-fan-out re-scans without duplicates. The
 * completion write bumps the version like every other update (the 092
 * guard trigger requires version + 1 on any UPDATE) and keeps the
 * published/fanout-NULL CAS predicate so concurrent completers have a
 * single winner.
 */

export type MarketingAnnouncementErrorCode =
  | 'ANNOUNCEMENT_INVALID_INPUT'
  | 'ANNOUNCEMENT_NOT_FOUND'
  | 'ANNOUNCEMENT_STATE_CONFLICT'
  | 'ANNOUNCEMENT_VERSION_CONFLICT'
  | 'ANNOUNCEMENT_FORBIDDEN'
  | 'ANNOUNCEMENT_STORAGE_ERROR';

export class MarketingAnnouncementError extends Error {
  constructor(
    readonly code: MarketingAnnouncementErrorCode,
    message = 'Marketing announcement operation failed',
  ) {
    super(message);
    this.name = 'MarketingAnnouncementError';
  }
}

export type AnnouncementKind = 'maintenance' | 'info' | 'billing';
export type AnnouncementSeverity = 'info' | 'warning' | 'critical';
export type AnnouncementStatus = 'draft' | 'published' | 'withdrawn';

export interface AnnouncementView {
  readonly id: string;
  readonly kind: AnnouncementKind;
  readonly severity: AnnouncementSeverity;
  readonly title: string;
  readonly body: string;
  readonly publishAt: string;
  readonly unpublishAt: string | null;
  readonly status: AnnouncementStatus;
  readonly version: number;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Customer-safe projection: the operator identity, lifecycle status, CAS
 * version and internal timestamps never cross the customer boundary.
 */
export interface PublishedAnnouncementView {
  readonly id: string;
  readonly kind: AnnouncementKind;
  readonly severity: AnnouncementSeverity;
  readonly title: string;
  readonly body: string;
  readonly publishAt: string;
  readonly unpublishAt: string | null;
  readonly readAt: string | null;
}

/** F3 webhook seam; invoked inside the publish transaction, exactly once per announcement. */
export interface MarketingAnnouncementEventPort {
  announcementPublished(
    executor: SqlExecutor,
    event: {
      readonly announcementId: string;
      readonly kind: AnnouncementKind;
      readonly severity: AnnouncementSeverity;
      readonly title: string;
      readonly publishAt: string;
      readonly unpublishAt: string | null;
      readonly occurredAt: string;
    },
  ): Promise<void>;
}

/** G4.5: the projection the fan-out worker turns into platform.maintenance event data. */
export interface AnnouncementFanoutView {
  readonly id: string;
  readonly kind: AnnouncementKind;
  readonly severity: AnnouncementSeverity;
  readonly title: string;
  readonly body: string;
  readonly publishAt: string;
  readonly unpublishAt: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KINDS: readonly AnnouncementKind[] = ['maintenance', 'info', 'billing'];
const SEVERITIES: readonly AnnouncementSeverity[] = ['info', 'warning', 'critical'];
const STATUSES: readonly AnnouncementStatus[] = ['draft', 'published', 'withdrawn'];
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 8000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_FANOUT_BATCH_SIZE = 500;
const SEVERITY_RANK: Readonly<Record<AnnouncementSeverity, number>> = { critical: 0, warning: 1, info: 2 };

function requireUuid(value: unknown, code: MarketingAnnouncementErrorCode = 'ANNOUNCEMENT_INVALID_INPUT'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new MarketingAnnouncementError(code);
  return value;
}

function requireKind(value: unknown): AnnouncementKind {
  if (typeof value !== 'string' || !(KINDS as readonly string[]).includes(value)) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return value as AnnouncementKind;
}

function requireSeverity(value: unknown): AnnouncementSeverity {
  if (typeof value !== 'string' || !(SEVERITIES as readonly string[]).includes(value)) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return value as AnnouncementSeverity;
}

function requireBoundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return normalized;
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return new Date(value).toISOString();
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return value;
}

function requireLimit(value: unknown): number {
  const limit = value ?? DEFAULT_LIST_LIMIT;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return limit;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** node-pg hands timestamptz back as Date; normalize instead of failing closed. */
function timestampText(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

/** node-pg hands bigint back as string; the version counter stays well inside 2^53. */
function versionNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

interface AnnouncementRow extends Record<string, unknown> {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  publish_at: string | Date;
  unpublish_at: string | Date | null;
  status: string;
  version: string | number;
  created_by_user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapAnnouncementRow(row: AnnouncementRow): AnnouncementView {
  const id = text(row.id);
  const kind = text(row.kind);
  const severity = text(row.severity);
  const title = text(row.title);
  const body = text(row.body);
  const publishAt = timestampText(row.publish_at);
  const status = text(row.status);
  const version = versionNumber(row.version);
  const createdByUserId = text(row.created_by_user_id);
  const createdAt = timestampText(row.created_at);
  const updatedAt = timestampText(row.updated_at);
  if (
    !id ||
    !(KINDS as readonly string[]).includes(kind ?? '') ||
    !(SEVERITIES as readonly string[]).includes(severity ?? '') ||
    !title ||
    !body ||
    !publishAt ||
    !(STATUSES as readonly string[]).includes(status ?? '') ||
    version === null ||
    !createdByUserId ||
    !createdAt ||
    !updatedAt
  ) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_STORAGE_ERROR');
  }
  return {
    id,
    kind: kind as AnnouncementKind,
    severity: severity as AnnouncementSeverity,
    title,
    body,
    publishAt,
    unpublishAt: timestampText(row.unpublish_at),
    status: status as AnnouncementStatus,
    version,
    createdByUserId,
    createdAt,
    updatedAt,
  };
}

const ANNOUNCEMENT_COLUMNS =
  'id, kind, severity, title, body, publish_at, unpublish_at, status, version, created_by_user_id, created_at, updated_at';

/** Severity-rank keyset cursor: `<rank>|<publishAt ISO>|<id>`, base64url. */
function encodeCursor(rank: number, publishAt: string, id: string): string {
  return Buffer.from(`${rank}|${publishAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { rank: number; publishAt: string; id: string } {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [rankText, publishAt, id] = decoded.split('|');
  const rank = typeof rankText === 'string' && /^[0-2]$/.test(rankText) ? Number(rankText) : null;
  if (
    rank === null ||
    typeof publishAt !== 'string' ||
    Number.isNaN(Date.parse(publishAt)) ||
    typeof id !== 'string' ||
    !UUID.test(id)
  ) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return { rank, publishAt: new Date(publishAt).toISOString(), id };
}

export interface MarketingAnnouncementServiceOptions {
  readonly database: SaasDatabase;
  readonly events?: MarketingAnnouncementEventPort;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

export class MarketingAnnouncementService {
  private readonly database: SaasDatabase;
  private readonly events: MarketingAnnouncementEventPort | undefined;
  private readonly idFactory: () => string;
  private readonly now: () => Date;

  constructor(options: MarketingAnnouncementServiceOptions) {
    this.database = options.database;
    this.events = options.events;
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
  }

  private async audit(
    executor: SqlExecutor,
    event: { action: string; actorUserId: string; targetId: string },
  ): Promise<void> {
    await executor.query(
      `INSERT INTO model_router_saas.saas_audit_events
         (id, tenant_id, actor_user_id, action, target_type, target_id, occurred_at, entry_point)
       VALUES ($1, NULL, $2, $3, 'marketing_announcement', $4, $5, 'platform_marketing')`,
      [this.idFactory(), event.actorUserId, event.action, event.targetId, this.now().toISOString()],
    );
  }

  /** Operations-side draft creation. The draft is never customer-visible. */
  async createDraft(
    actor: { userId: string },
    input: {
      kind: unknown;
      severity: unknown;
      title: unknown;
      body: unknown;
      publishAt: unknown;
      unpublishAt?: unknown;
    },
  ): Promise<AnnouncementView> {
    const actorId = requireUuid(actor.userId, 'ANNOUNCEMENT_FORBIDDEN');
    const kind = requireKind(input.kind);
    const severity = requireSeverity(input.severity);
    const title = requireBoundedText(input.title, MAX_TITLE_LENGTH);
    const body = requireBoundedText(input.body, MAX_BODY_LENGTH);
    const publishAt = requireTimestamp(input.publishAt);
    const unpublishAt =
      input.unpublishAt === undefined || input.unpublishAt === null ? null : requireTimestamp(input.unpublishAt);
    if (unpublishAt !== null && Date.parse(unpublishAt) <= Date.parse(publishAt)) {
      throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
    }

    return this.database.transaction(async (executor) => {
      const inserted = await executor.query<AnnouncementRow>(
        `INSERT INTO model_router_saas.saas_marketing_announcements
           (id, kind, severity, title, body, publish_at, unpublish_at, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         RETURNING ${ANNOUNCEMENT_COLUMNS}`,
        [this.idFactory(), kind, severity, title, body, publishAt, unpublishAt, actorId, this.now().toISOString()],
      );
      const row = inserted.rows[0];
      if (!row) throw new MarketingAnnouncementError('ANNOUNCEMENT_STORAGE_ERROR');
      const view = mapAnnouncementRow(row);
      await this.audit(executor, {
        action: 'marketing.announcement.created',
        actorUserId: actorId,
        targetId: view.id,
      });
      return view;
    });
  }

  private async lockAnnouncement(executor: SqlExecutor, id: string): Promise<AnnouncementView> {
    const locked = await executor.query<AnnouncementRow>(
      `SELECT ${ANNOUNCEMENT_COLUMNS} FROM model_router_saas.saas_marketing_announcements WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = locked.rows[0];
    if (!row) throw new MarketingAnnouncementError('ANNOUNCEMENT_NOT_FOUND');
    return mapAnnouncementRow(row);
  }

  /**
   * Operations-side publish (draft -> published). The CAS predicate carries
   * the expected version; only the single transition winner writes the audit
   * row and invokes the event port, both in the same transaction.
   */
  async publish(actor: { userId: string }, announcementId: string, expectedVersion: number): Promise<AnnouncementView> {
    const actorId = requireUuid(actor.userId, 'ANNOUNCEMENT_FORBIDDEN');
    const id = requireUuid(announcementId);
    const version = requireVersion(expectedVersion);
    return this.database.transaction(async (executor) => {
      const current = await this.lockAnnouncement(executor, id);
      if (current.version !== version) throw new MarketingAnnouncementError('ANNOUNCEMENT_VERSION_CONFLICT');
      if (current.status !== 'draft') throw new MarketingAnnouncementError('ANNOUNCEMENT_STATE_CONFLICT');
      const transitioned = await executor.query<AnnouncementRow>(
        `UPDATE model_router_saas.saas_marketing_announcements
            SET status = 'published', version = version + 1, updated_at = $2
          WHERE id = $1 AND status = 'draft' AND version = $3
          RETURNING ${ANNOUNCEMENT_COLUMNS}`,
        [id, this.now().toISOString(), version],
      );
      const row = transitioned.rows[0];
      if (!row) throw new MarketingAnnouncementError('ANNOUNCEMENT_STATE_CONFLICT');
      const view = mapAnnouncementRow(row);
      await this.audit(executor, {
        action: 'marketing.announcement.published',
        actorUserId: actorId,
        targetId: id,
      });
      await this.events?.announcementPublished(executor, {
        announcementId: view.id,
        kind: view.kind,
        severity: view.severity,
        title: view.title,
        publishAt: view.publishAt,
        unpublishAt: view.unpublishAt,
        occurredAt: this.now().toISOString(),
      });
      return view;
    });
  }

  /**
   * Operations-side withdraw (-> withdrawn, terminal). Withdrawing an
   * already-withdrawn announcement is an idempotent replay and returns the
   * current view; no webhook event is ever produced here.
   */
  async withdraw(
    actor: { userId: string },
    announcementId: string,
    expectedVersion: number,
  ): Promise<AnnouncementView> {
    const actorId = requireUuid(actor.userId, 'ANNOUNCEMENT_FORBIDDEN');
    const id = requireUuid(announcementId);
    const version = requireVersion(expectedVersion);
    return this.database.transaction(async (executor) => {
      const current = await this.lockAnnouncement(executor, id);
      if (current.status === 'withdrawn') return current;
      if (current.version !== version) throw new MarketingAnnouncementError('ANNOUNCEMENT_VERSION_CONFLICT');
      const transitioned = await executor.query<AnnouncementRow>(
        `UPDATE model_router_saas.saas_marketing_announcements
            SET status = 'withdrawn', version = version + 1, updated_at = $2
          WHERE id = $1 AND status IN ('draft', 'published') AND version = $3
          RETURNING ${ANNOUNCEMENT_COLUMNS}`,
        [id, this.now().toISOString(), version],
      );
      const row = transitioned.rows[0];
      if (!row) throw new MarketingAnnouncementError('ANNOUNCEMENT_STATE_CONFLICT');
      const view = mapAnnouncementRow(row);
      await this.audit(executor, {
        action: 'marketing.announcement.withdrawn',
        actorUserId: actorId,
        targetId: id,
      });
      return view;
    });
  }

  /** Operations-side listing with (created_at, id) keyset pagination. */
  async list(
    actor: { userId: string },
    input: { status?: unknown; kind?: unknown; limit?: unknown; cursor?: unknown } = {},
  ): Promise<{ announcements: AnnouncementView[]; nextCursor: string | null }> {
    requireUuid(actor.userId, 'ANNOUNCEMENT_FORBIDDEN');
    const status = input.status === undefined ? null : requireKind0(input.status, STATUSES);
    const kind = input.kind === undefined ? null : requireKind0(input.kind, KINDS);
    const limit = requireLimit(input.limit);
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string') throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
      const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
      const [createdAt, id] = decoded.split('|');
      cursorCreatedAt = typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null;
      cursorId = typeof id === 'string' && UUID.test(id) ? id : null;
      if (cursorCreatedAt === null || cursorId === null) {
        throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
      }
    }
    const rows = await this.database.query<AnnouncementRow>(
      `SELECT ${ANNOUNCEMENT_COLUMNS} FROM model_router_saas.saas_marketing_announcements
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::text IS NULL OR kind = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [status, kind, cursorCreatedAt, cursorId, limit + 1],
    );
    const page = rows.rows.slice(0, limit).map(mapAnnouncementRow);
    const last = page.at(-1);
    const nextCursor =
      rows.rows.length > limit && last
        ? Buffer.from(`${last.createdAt}|${last.id}`, 'utf8').toString('base64url')
        : null;
    return { announcements: page, nextCursor };
  }

  /**
   * Customer-side listing: published announcements inside their visibility
   * window, severity-first (critical, warning, info) then most recent, with
   * the caller's read receipt joined in. Keyset pagination follows the same
   * (severity rank, publish_at, id) ordering.
   */
  async listPublished(
    context: { tenantId: string; userId: string },
    input: { limit?: unknown; cursor?: unknown } = {},
  ): Promise<{ announcements: PublishedAnnouncementView[]; nextCursor: string | null }> {
    requireUuid(context.tenantId);
    const userId = requireUuid(context.userId);
    const limit = requireLimit(input.limit);
    let cursor: { rank: number; publishAt: string; id: string } | null = null;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== 'string') throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
      cursor = decodeCursor(input.cursor);
    }
    const rows = await this.database.query<AnnouncementRow & { read_at: string | Date | null }>(
      `SELECT ${ANNOUNCEMENT_COLUMNS}, read_at FROM (
         SELECT a.${ANNOUNCEMENT_COLUMNS.split(', ').join(', a.')},
           r.read_at AS read_at,
           CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END AS severity_rank
         FROM model_router_saas.saas_marketing_announcements AS a
         LEFT JOIN model_router_saas.saas_marketing_announcement_reads AS r
           ON r.announcement_id = a.id AND r.user_id = $1
         WHERE a.status = 'published'
           AND a.publish_at <= $2
           AND (a.unpublish_at IS NULL OR a.unpublish_at > $2)
       ) AS visible
       WHERE ($3::integer IS NULL OR severity_rank > $3
         OR (severity_rank = $3 AND publish_at < $4::timestamptz)
         OR (severity_rank = $3 AND publish_at = $4::timestamptz AND id < $5::uuid))
       ORDER BY severity_rank, publish_at DESC, id DESC
       LIMIT $6`,
      [
        userId,
        this.now().toISOString(),
        cursor?.rank ?? null,
        cursor?.publishAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const page = rows.rows.slice(0, limit).map((row) => {
      const full = mapAnnouncementRow(row);
      return {
        id: full.id,
        kind: full.kind,
        severity: full.severity,
        title: full.title,
        body: full.body,
        publishAt: full.publishAt,
        unpublishAt: full.unpublishAt,
        readAt: timestampText(row.read_at),
      };
    });
    const last = page.at(-1);
    const nextCursor =
      rows.rows.length > limit && last ? encodeCursor(SEVERITY_RANK[last.severity], last.publishAt, last.id) : null;
    return { announcements: page, nextCursor };
  }

  /**
   * Customer-side read receipt. Idempotent per (announcement, user): a repeat
   * is an ON CONFLICT no-op reporting 'already_read'. Only a published
   * announcement inside its visibility window can be marked; anything else is
   * indistinguishable from unknown (no existence leak for drafts).
   */
  async markRead(
    context: { tenantId: string; userId: string },
    announcementId: string,
  ): Promise<{ outcome: 'marked' | 'already_read'; announcementId: string; readAt: string }> {
    const tenantId = requireUuid(context.tenantId);
    const userId = requireUuid(context.userId);
    const id = requireUuid(announcementId);
    const now = this.now().toISOString();
    const visible = await this.database.query<{ id: string }>(
      `SELECT id FROM model_router_saas.saas_marketing_announcements
        WHERE id = $1 AND status = 'published' AND publish_at <= $2 AND (unpublish_at IS NULL OR unpublish_at > $2)`,
      [id, now],
    );
    if (!visible.rows[0]) throw new MarketingAnnouncementError('ANNOUNCEMENT_NOT_FOUND');
    const inserted = await this.database.query<{ read_at: string | Date }>(
      `INSERT INTO model_router_saas.saas_marketing_announcement_reads (announcement_id, user_id, tenant_id, read_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (announcement_id, user_id) DO NOTHING
       RETURNING read_at`,
      [id, userId, tenantId, now],
    );
    const row = inserted.rows[0];
    if (row) {
      const readAt = timestampText(row.read_at);
      if (!readAt) throw new MarketingAnnouncementError('ANNOUNCEMENT_STORAGE_ERROR');
      return { outcome: 'marked', announcementId: id, readAt };
    }
    const existing = await this.database.query<{ read_at: string | Date }>(
      `SELECT read_at FROM model_router_saas.saas_marketing_announcement_reads
        WHERE announcement_id = $1 AND user_id = $2`,
      [id, userId],
    );
    const readAt = timestampText(existing.rows[0]?.read_at ?? null);
    if (!readAt) throw new MarketingAnnouncementError('ANNOUNCEMENT_STORAGE_ERROR');
    return { outcome: 'already_read', announcementId: id, readAt };
  }

  /**
   * G4.5 fan-out claim: published announcements not yet fanned out, in
   * (publish_at, id) order — matching the 095 due partial index — locked
   * FOR UPDATE SKIP LOCKED inside the caller's transaction so concurrent
   * workers stride across announcements instead of contending on the same
   * row. The caller decides when the lock is released (claim-only or
   * claim-plus-fan-out transaction); the idempotency keys make any overlap
   * duplicate-free regardless.
   */
  async listDueFanouts(executor: SqlExecutor, batchSize: number): Promise<AnnouncementFanoutView[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_FANOUT_BATCH_SIZE) {
      throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
    }
    const rows = await executor.query<AnnouncementRow>(
      `SELECT ${ANNOUNCEMENT_COLUMNS} FROM model_router_saas.saas_marketing_announcements
        WHERE status = 'published' AND fanout_completed_at IS NULL
        ORDER BY publish_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );
    return rows.rows.map((row) => {
      const view = mapAnnouncementRow(row);
      return {
        id: view.id,
        kind: view.kind,
        severity: view.severity,
        title: view.title,
        body: view.body,
        publishAt: view.publishAt,
        unpublishAt: view.unpublishAt,
      };
    });
  }

  /**
   * G4.5 completion CAS: written only after every entitled tenant enqueue
   * for the announcement has been attempted. The published/fanout-NULL
   * predicate makes concurrent completers single-winner and excludes
   * announcements withdrawn mid-fan-out; version + 1 satisfies the 092
   * guard trigger that requires an exact increment on any update.
   * Returns false when the announcement was already completed or left the
   * published state.
   */
  async markFanoutCompleted(executor: SqlExecutor, announcementId: string): Promise<boolean> {
    const id = requireUuid(announcementId);
    const now = this.now().toISOString();
    const result = await executor.query(
      `UPDATE model_router_saas.saas_marketing_announcements
          SET fanout_completed_at = $2, version = version + 1, updated_at = $2
        WHERE id = $1 AND status = 'published' AND fanout_completed_at IS NULL`,
      [id, now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /**
   * G4.5 entitlement pre-filter: tenants whose webhook policy is enabled,
   * whitelists platform.maintenance, and has at least one active endpoint
   * subscribed to the event type. This mirrors the F3 scanner's scan-side
   * pre-join; the authoritative per-tenant verdict stays the F2 entitlement
   * port re-evaluated inside the producer's enqueue (entitlement is
   * enforced twice, so a policy race drops instead of failing the sweep).
   * Tenants without a subscribed active endpoint are skipped — no event
   * row is persisted for them. The set is announcement-independent today;
   * the announcement id anchors validation and future per-announcement
   * scoping.
   */
  async readFanoutEntitlements(executor: SqlExecutor, announcementId: string): Promise<string[]> {
    requireUuid(announcementId);
    const rows = await executor.query<{ tenant_id: unknown }>(
      `SELECT p.tenant_id
         FROM model_router_saas.saas_customer_webhook_tenant_policies p
        WHERE p.enabled = TRUE
          AND 'platform.maintenance' = ANY (p.allowed_event_types)
          AND EXISTS (
            SELECT 1 FROM model_router_saas.saas_customer_webhook_endpoints e
            JOIN model_router_saas.saas_customer_webhook_endpoint_versions v
              ON v.tenant_id = e.tenant_id AND v.endpoint_id = e.id AND v.version = e.current_version
            WHERE e.tenant_id = p.tenant_id AND e.state = 'active'
              AND 'platform.maintenance' = ANY (v.event_types)
          )
        ORDER BY p.tenant_id`,
      [],
    );
    return rows.rows.map((row) => {
      const tenantId = text(row.tenant_id);
      if (!tenantId || !UUID.test(tenantId)) throw new MarketingAnnouncementError('ANNOUNCEMENT_STORAGE_ERROR');
      return tenantId;
    });
  }
}

function requireKind0<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new MarketingAnnouncementError('ANNOUNCEMENT_INVALID_INPUT');
  }
  return value as T;
}
