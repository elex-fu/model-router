import type { SaasDatabase } from '../db/types.js';

export type MediaTaskKind = 'image' | 'video';
export interface MediaTaskOperationsRow {
  readonly kind: MediaTaskKind;
  readonly taskId: string;
  readonly tenantId: string;
  readonly proxyKeyId: string;
  /** Image lifecycle or video billing state; upstream video progress is not persisted. */
  readonly status: string;
  readonly statusSource: 'image_lifecycle' | 'video_billing';
  readonly diagnostic:
    | 'image_processing'
    | 'image_stuck'
    | 'image_failed'
    | 'complete'
    | 'poll_leased'
    | 'poll_overdue'
    | 'poll_waiting'
    | 'billing_skipped';
  readonly requestId: string | null;
  readonly accountId: string | null;
  readonly financialStatus: string | null;
  readonly executionState: string | null;
  readonly recovery: {
    readonly leaseOwner: string | null;
    readonly leaseEpoch: number;
    readonly leaseUntil: string | null;
    readonly nextPollAt: string | null;
    readonly pollFailures: number;
    readonly canRequeue: boolean;
  } | null;
  readonly latestRequeue: { readonly auditEventId: string; readonly queuedAt: string } | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string;
}
export interface MediaTaskOperationsPage {
  readonly snapshotAt: string;
  readonly limit: number;
  readonly rows: readonly MediaTaskOperationsRow[];
  readonly counts: {
    readonly total: number;
    readonly processing: number;
    readonly terminalUnsettled: number;
    readonly recoveryActive: number;
    readonly overdue: number;
  };
}
function iso(value: Date | string): string;
function iso(value: Date | string | null): string | null;
function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** Bounded safe task facts, with separate task/billing/request states and no payload or content URL. */
export async function getMediaTaskOperationsPage(
  database: SaasDatabase,
  query: { readonly kind?: MediaTaskKind; readonly limit?: number; readonly includeTerminal?: boolean } = {},
): Promise<MediaTaskOperationsPage> {
  const limit = Math.min(Math.max(Number.isSafeInteger(query.limit) ? (query.limit as number) : 50, 1), 200);
  const now = Date.now();
  const rows: MediaTaskOperationsRow[] = [];
  if (query.kind === undefined || query.kind === 'image') {
    const images = await database.query<{
      id: string;
      tenant_id: string;
      proxy_key_id: string;
      status: string;
      created_at: Date | string;
      completed_at: Date | string | null;
      expires_at: Date | string;
    }>(
      `SELECT id, tenant_id, proxy_key_id, status, created_at, completed_at, expires_at FROM saas_image_tasks
        WHERE expires_at > clock_timestamp() ${query.includeTerminal === false ? "AND status = 'processing'" : ''}
        ORDER BY (status = 'processing') DESC, created_at LIMIT $1`,
      [limit],
    );
    for (const row of images.rows) {
      rows.push({
        kind: 'image',
        taskId: row.id,
        tenantId: row.tenant_id,
        proxyKeyId: row.proxy_key_id,
        status: row.status,
        statusSource: 'image_lifecycle',
        diagnostic:
          row.status === 'processing'
            ? now - new Date(row.created_at).getTime() > 10 * 60_000
              ? 'image_stuck'
              : 'image_processing'
            : row.status === 'failed'
              ? 'image_failed'
              : 'complete',
        requestId: null,
        accountId: null,
        financialStatus: null,
        executionState: null,
        recovery: null,
        latestRequeue: null,
        createdAt: iso(row.created_at),
        completedAt: iso(row.completed_at),
        expiresAt: iso(row.expires_at),
      });
    }
  }
  if (query.kind === undefined || query.kind === 'video') {
    const videos = await database.query<{
      request_id: string;
      tenant_id: string;
      proxy_key_id: string;
      billing_state: string;
      provider_account_id: string;
      gateway_request_id: string;
      financial_status: string | null;
      execution_state: string | null;
      lease_owner: string | null;
      lease_epoch: string | number;
      lease_until: Date | string | null;
      next_poll_at: Date | string;
      poll_failures: number;
      billed_at: Date | string | null;
      audit_event_id: string | null;
      queued_at: Date | string | null;
      created_at: Date | string;
      expires_at: Date | string;
    }>(
      `SELECT task.request_id, task.tenant_id, task.proxy_key_id, task.billing_state, task.provider_account_id,
              task.gateway_request_id, request.financial_status, request.execution_state,
              task.lease_owner, task.lease_epoch, task.lease_until, task.next_poll_at, task.poll_failures,
              task.billed_at, task.created_at, task.expires_at, receipt.audit_event_id, receipt.recorded_at AS queued_at
         FROM saas_video_tasks task
         LEFT JOIN saas_requests request ON request.id::text = task.gateway_request_id AND request.tenant_id::text = task.tenant_id
         LEFT JOIN LATERAL (SELECT audit_event_id, recorded_at FROM saas_ops_media_requeue_requests
           WHERE tenant_id = task.tenant_id AND task_id = task.request_id ORDER BY recorded_at DESC LIMIT 1) receipt ON true
        WHERE task.expires_at > clock_timestamp() ${query.includeTerminal === false ? "AND task.billing_state = 'pending'" : ''}
        ORDER BY (task.billing_state = 'pending') DESC, task.next_poll_at, task.created_at LIMIT $1`,
      [limit],
    );
    for (const row of videos.rows) {
      const live = row.lease_owner !== null && row.lease_until !== null && new Date(row.lease_until).getTime() > now;
      const overdue = row.billing_state === 'pending' && !live && now - new Date(row.next_poll_at).getTime() > 60_000;
      rows.push({
        kind: 'video',
        taskId: row.request_id,
        tenantId: row.tenant_id,
        proxyKeyId: row.proxy_key_id,
        status: row.billing_state,
        statusSource: 'video_billing',
        diagnostic:
          row.billing_state === 'pending'
            ? live
              ? 'poll_leased'
              : overdue
                ? 'poll_overdue'
                : 'poll_waiting'
            : row.billing_state === 'skipped'
              ? 'billing_skipped'
              : 'complete',
        requestId: row.gateway_request_id,
        accountId: row.provider_account_id,
        financialStatus: row.financial_status,
        executionState: row.execution_state,
        recovery: {
          leaseOwner: row.lease_owner,
          leaseEpoch: Number(row.lease_epoch),
          leaseUntil: iso(row.lease_until),
          nextPollAt: iso(row.next_poll_at),
          pollFailures: Number(row.poll_failures),
          canRequeue:
            row.billing_state === 'pending' &&
            !live &&
            (row.lease_until === null || new Date(row.lease_until).getTime() <= now),
        },
        latestRequeue:
          row.audit_event_id === null || row.queued_at === null
            ? null
            : { auditEventId: row.audit_event_id, queuedAt: iso(row.queued_at) },
        createdAt: iso(row.created_at),
        completedAt: iso(row.billed_at),
        expiresAt: iso(row.expires_at),
      });
    }
  }
  const priority = (row: MediaTaskOperationsRow) =>
    row.diagnostic === 'poll_overdue' || row.diagnostic === 'image_stuck'
      ? 0
      : row.status === 'processing' || row.status === 'pending'
        ? 1
        : 2;
  rows.sort((a, b) => priority(a) - priority(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const page = rows.slice(0, limit);
  return {
    snapshotAt: new Date(now).toISOString(),
    limit,
    rows: page,
    counts: {
      total: page.length,
      processing: page.filter((row) => row.status === 'processing' || row.status === 'pending').length,
      terminalUnsettled: page.filter(
        (row) =>
          row.kind === 'video' &&
          (row.executionState === 'succeeded' || row.executionState === 'failed') &&
          (row.financialStatus === 'pending' || row.financialStatus === 'reconciliation_pending'),
      ).length,
      recoveryActive: page.filter((row) => row.diagnostic === 'poll_leased').length,
      overdue: page.filter((row) => row.diagnostic === 'poll_overdue' || row.diagnostic === 'image_stuck').length,
    },
  };
}
