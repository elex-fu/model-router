import type { SqlExecutor } from '../../db/types.js';

/** The read-only database contract required by the platform audit query. */
export type PlatformAuditQueryDatabase = Pick<SqlExecutor, 'query'>;
export type PlatformAuditHistoryQueryDatabase = PlatformAuditQueryDatabase;

export type PlatformAuditDateInput = string | Date;

/**
 * Filters for the platform-wide audit history.
 *
 * `createdFrom` is inclusive and `createdTo` is exclusive. The `from`/`to`
 * spellings are accepted as compatibility aliases for callers that use the
 * same range vocabulary as the other SaaS query services.
 */
export interface PlatformAuditHistoryListQuery {
  readonly actorId?: string;
  readonly action?: string;
  readonly entityType?: string;
  readonly createdFrom?: PlatformAuditDateInput;
  readonly createdTo?: PlatformAuditDateInput;
  readonly from?: PlatformAuditDateInput;
  readonly to?: PlatformAuditDateInput;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly pageSize?: number;
}

export type PlatformAuditListQuery = PlatformAuditHistoryListQuery;
export type PlatformAuditHistoryQuery = PlatformAuditHistoryListQuery;

/**
 * Safe audit metadata. Payloads, details, credentials, request bodies, and
 * user-agent/source-IP data are intentionally not part of this contract.
 */
export interface PlatformAuditEventRecord {
  readonly id: string;
  readonly tenantId: string | null;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly occurredAt: string;
  readonly entryPoint: string;
  readonly requestId: string | null;
}

export type PlatformAuditHistoryRecord = PlatformAuditEventRecord;
export type PlatformAuditRecord = PlatformAuditEventRecord;

export interface PlatformAuditPage<Item = PlatformAuditEventRecord> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type PlatformAuditHistoryPage = PlatformAuditPage<PlatformAuditEventRecord>;
export type PlatformAuditEventPage = PlatformAuditHistoryPage;

/** A stable HMAC key supplied by the runtime, or a process-local fallback. */
export interface PlatformAuditQueryServiceOptions {
  readonly cursorSecret?: string | Uint8Array;
}

export type PlatformAuditHistoryQueryServiceOptions = PlatformAuditQueryServiceOptions;
