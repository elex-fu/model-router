import type { SaasDatabase } from '../db/types.js';

/**
 * Gap-remediation plan G-C2 (§9): the media-task operations projection —
 * the read model the task-operations console page consumes (the plan's
 * 任务运营 row: 已接受/发送未知/生成中/交付失败/待结算 → 自动恢复记录).
 *
 * Read-only, secret-free, and deliberately COARSE: per-task rows carry the
 * lifecycle state, ownership scoping (tenant + proxy key prefix only — no
 * key material), the G-A1 recovery facts (lease owner/epoch, due cursor,
 * poll failures), and bounded timestamps. No payloads, no URLs, no
 * settlement amounts (the 账务核对 view owns those; this is scheduling
 * health).
 */

export type MediaTaskKind = 'image' | 'video';

export interface MediaTaskOperationsRow {
  readonly kind: MediaTaskKind;
  readonly taskId: string;
  readonly tenantId: string;
  readonly proxyKeyId: string;
  /** The client-visible lifecycle state (kind-specific vocabulary). */
  readonly status: string;
  /** The G-A1 recovery state (video only; images are sweep-terminated). */
  readonly recovery: {
    readonly leaseOwner: string | null;
    readonly leaseEpoch: number | null;
    readonly leaseUntil: string | null;
    readonly nextPollAt: string | null;
    readonly pollFailures: number | null;
  } | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string;
}

export interface MediaTaskOperationsPage {
  readonly rows: readonly MediaTaskOperationsRow[];
  readonly counts: {
    readonly total: number;
    readonly processing: number;
    readonly terminalUnsettled: number;
    readonly recoveryActive: number;
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * One read-only page over BOTH task tables. Ordering: the operational
 * horizon first — processing/not-yet-billed rows by their due/creation
 * time, then terminal rows newest-first (the operator's queue view).
 */
export async function getMediaTaskOperationsPage(
  database: SaasDatabase,
  query: { readonly kind?: MediaTaskKind; readonly limit?: number; readonly includeTerminal?: boolean } = {},
): Promise<MediaTaskOperationsPage> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const kinds: readonly MediaTaskKind[] = query.kind === undefined ? ['image', 'video'] : [query.kind];
  const includeTerminal = query.includeTerminal ?? true;
  const rows: MediaTaskOperationsRow[] = [];

  if (kinds.includes('image')) {
    const filter = includeTerminal
      ? ''
      : "AND status = 'processing'";
    const result = await database.query<{
      id: string;
      tenant_id: string;
      proxy_key_id: string;
      status: string;
      created_at: Date | string;
      completed_at: Date | string | null;
      expires_at: Date | string;
    }>(
      `SELECT id, tenant_id, proxy_key_id, status, created_at, completed_at, expires_at
         FROM saas_image_tasks
        WHERE expires_at > now()
          ${filter}
        ORDER BY (status = 'processing') DESC, created_at DESC
        LIMIT ${limit}`,
    );
    for (const row of result.rows) {
      rows.push({
        kind: 'image',
        taskId: row.id,
        tenantId: row.tenant_id,
        proxyKeyId: row.proxy_key_id,
        status: row.status,
        recovery: null,
        createdAt: iso(row.created_at) ?? '',
        completedAt: iso(row.completed_at),
        expiresAt: iso(row.expires_at) ?? '',
      });
    }
  }

  if (kinds.includes('video')) {
    const filter = includeTerminal
      ? ''
      : "AND billing_state = 'pending'";
    const result = await database.query<{
      request_id: string;
      tenant_id: string;
      proxy_key_id: string;
      billing_state: string;
      lease_owner: string | null;
      lease_epoch: string | number | null;
      lease_until: Date | string | null;
      next_poll_at: Date | string | null;
      poll_failures: string | number | null;
      created_at: Date | string;
      expires_at: Date | string;
    }>(
      `SELECT request_id, tenant_id, proxy_key_id, billing_state,
              lease_owner, lease_epoch, lease_until, next_poll_at, poll_failures,
              created_at, expires_at
         FROM saas_video_tasks
        WHERE expires_at > now()
          ${filter}
        ORDER BY (billing_state = 'pending') DESC, next_poll_at ASC NULLS LAST, created_at DESC
        LIMIT ${limit}`,
    );
    for (const row of result.rows) {
      const epoch = row.lease_epoch === null ? null : Number(row.lease_epoch);
      const failures = row.poll_failures === null ? null : Number(row.poll_failures);
      rows.push({
        kind: 'video',
        taskId: row.request_id,
        tenantId: row.tenant_id,
        proxyKeyId: row.proxy_key_id,
        status: row.billing_state,
        recovery: {
          leaseOwner: row.lease_owner,
          leaseEpoch: epoch,
          leaseUntil: iso(row.lease_until),
          nextPollAt: iso(row.next_poll_at),
          pollFailures: failures,
        },
        createdAt: iso(row.created_at) ?? '',
        completedAt: null,
        expiresAt: iso(row.expires_at) ?? '',
      });
    }
  }

  const processing = rows.filter((row) => row.status === 'processing' || row.status === 'pending').length;
  const terminalUnsettled = rows.filter((row) => row.kind === 'video' && row.status === 'pending' && row.completedAt !== null)
    .length;
  const recoveryActive = rows.filter((row) => row.recovery?.leaseOwner !== null && row.recovery?.leaseOwner !== undefined)
    .length;
  return {
    rows,
    counts: {
      total: rows.length,
      processing,
      terminalUnsettled,
      recoveryActive,
    },
  };
}
