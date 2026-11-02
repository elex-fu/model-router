import type { SqlExecutor } from '../db/types.js';
import type {
  BulkImportItemRecord,
  BulkImportItemStatus,
  BulkImportJobRecord,
  BulkImportOptionWarning,
  BulkImportProvider,
  BulkImportValidationState,
} from './bulk-import-service.js';

const JOB_COLUMNS = `id, status, total_count, success_count, failure_count, created_by,
  error_summary, created_at, updated_at, completed_at`;
const ITEM_COLUMNS = `job_id, item_index, provider, credential_fingerprint, status, account_ref,
  error_reason, display_name, egress_proxy_id, validation_state, option_warnings,
  created_at, updated_at, completed_at`;
const PROVIDERS = new Set<BulkImportProvider>(['codex', 'claude', 'gemini', 'grok']);
const ITEM_STATUSES = ['pending', 'succeeded', 'deduplicated', 'failed'] as const;
const ITEM_STATUS_SET = new Set<BulkImportItemStatus>(ITEM_STATUSES);
const VALIDATION_STATES = new Set<BulkImportValidationState>([
  'pending_validation',
  'queued',
  'queue_failed',
  'not_requested',
]);
const OPTION_WARNINGS = new Set<BulkImportOptionWarning>(['DISPLAY_NAME_UNSUPPORTED', 'EGRESS_PROXY_ID_UNSUPPORTED']);

export type BulkImportItemCounts = Readonly<Record<BulkImportItemStatus, number>>;

export interface BulkImportJobStatusSnapshot {
  readonly job: BulkImportJobRecord;
  readonly counts: BulkImportItemCounts;
}

export interface BulkImportItemListQuery {
  readonly jobId: string;
  /** Exclusive zero-based item-index cursor. */
  readonly afterItemIndex?: number;
  /** Maximum rows returned. */
  readonly limit: number;
}

/** Metadata-only reads for the admin transport; credential material is never selected. */
export interface BulkImportReadStore {
  getJobStatus(jobId: string): Promise<BulkImportJobStatusSnapshot | null>;
  listItems(query: BulkImportItemListQuery): Promise<readonly BulkImportItemRecord[]>;
}

export class PostgresBulkImportReadStoreError extends Error {
  constructor(readonly code: 'BULK_IMPORT_READ_ROW_INVALID') {
    super(code);
    this.name = 'PostgresBulkImportReadStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Row = Record<string, unknown>;

function invalidRow(): never {
  throw new PostgresBulkImportReadStoreError('BULK_IMPORT_READ_ROW_INVALID');
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return invalidRow();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return invalidRow();
  return parsed;
}

function timestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') return invalidRow();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalidRow();
  return parsed.toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function json(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return invalidRow();
  }
}

function mapJob(row: Row): BulkImportJobRecord {
  const status = text(row.status);
  if (status !== 'running' && status !== 'completed') return invalidRow();
  const summary = json(row.error_summary);
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return invalidRow();
  const errorSummary: Record<string, number> = {};
  for (const [key, value] of Object.entries(summary)) errorSummary[key] = integer(value);
  return Object.freeze({
    id: text(row.id),
    status,
    totalCount: integer(row.total_count),
    successCount: integer(row.success_count),
    failureCount: integer(row.failure_count),
    createdBy: text(row.created_by),
    errorSummary: Object.freeze(errorSummary),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: nullableTimestamp(row.completed_at),
  });
}

function mapItem(row: Row): BulkImportItemRecord {
  const provider = text(row.provider) as BulkImportProvider;
  const status = text(row.status) as BulkImportItemStatus;
  const validationState = text(row.validation_state) as BulkImportValidationState;
  if (!PROVIDERS.has(provider) || !ITEM_STATUS_SET.has(status) || !VALIDATION_STATES.has(validationState)) {
    return invalidRow();
  }
  const rawWarnings = json(row.option_warnings);
  if (!Array.isArray(rawWarnings)) return invalidRow();
  const optionWarnings = rawWarnings.map((warning) => {
    if (typeof warning !== 'string' || !OPTION_WARNINGS.has(warning as BulkImportOptionWarning)) return invalidRow();
    return warning as BulkImportOptionWarning;
  });
  return Object.freeze({
    jobId: text(row.job_id),
    itemIndex: integer(row.item_index),
    provider,
    credentialFingerprint: text(row.credential_fingerprint),
    status,
    accountRef: nullableText(row.account_ref),
    errorReason: nullableText(row.error_reason),
    displayName: nullableText(row.display_name),
    egressProxyId: nullableText(row.egress_proxy_id),
    validationState,
    optionWarnings: Object.freeze(optionWarnings),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    completedAt: nullableTimestamp(row.completed_at),
  });
}

function mapCounts(row: Row): BulkImportItemCounts {
  const counts: Record<BulkImportItemStatus, number> = {
    pending: integer(row.pending_count),
    succeeded: integer(row.succeeded_count),
    deduplicated: integer(row.deduplicated_count),
    failed: integer(row.failed_count),
  };
  return Object.freeze(counts);
}

/** Separate read side so the transactional import state machine remains unchanged. */
export class PostgresBulkImportReadStore implements BulkImportReadStore {
  constructor(private readonly database: Pick<SqlExecutor, 'query'>) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('bulk import read database is required');
    }
  }

  async getJobStatus(jobId: string): Promise<BulkImportJobStatusSnapshot | null> {
    const result = await this.database.query<Row>(
      `SELECT ${JOB_COLUMNS},
         (SELECT COUNT(*) FROM saas_bulk_import_item WHERE job_id = $1 AND status = 'pending') AS pending_count,
         (SELECT COUNT(*) FROM saas_bulk_import_item WHERE job_id = $1 AND status = 'succeeded') AS succeeded_count,
         (SELECT COUNT(*) FROM saas_bulk_import_item WHERE job_id = $1 AND status = 'deduplicated') AS deduplicated_count,
         (SELECT COUNT(*) FROM saas_bulk_import_item WHERE job_id = $1 AND status = 'failed') AS failed_count
       FROM saas_bulk_import_job
       WHERE id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (result.rows.length !== 1) return invalidRow();
    return Object.freeze({ job: mapJob(row), counts: mapCounts(row) });
  }

  async listItems(query: BulkImportItemListQuery): Promise<readonly BulkImportItemRecord[]> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 101) {
      throw new TypeError('bulk import read limit is invalid');
    }
    if (
      query.afterItemIndex !== undefined &&
      (!Number.isSafeInteger(query.afterItemIndex) || query.afterItemIndex < 0)
    ) {
      throw new TypeError('bulk import read cursor is invalid');
    }
    const after = query.afterItemIndex ?? -1;
    const result = await this.database.query<Row>(
      `SELECT ${ITEM_COLUMNS}
       FROM saas_bulk_import_item
       WHERE job_id = $1 AND item_index > $2
       ORDER BY item_index
       LIMIT $3`,
      [query.jobId, after, query.limit],
    );
    return Object.freeze(result.rows.map(mapItem));
  }
}
