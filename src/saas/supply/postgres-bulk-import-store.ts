import {
  SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL,
  SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL,
} from '../db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type {
  BulkImportClaimResult,
  BulkImportItemClaim,
  BulkImportItemFailure,
  BulkImportItemRecord,
  BulkImportItemStatus,
  BulkImportItemSuccess,
  BulkImportJobCreate,
  BulkImportJobRecord,
  BulkImportJobStatus,
  BulkImportOptionWarning,
  BulkImportProvider,
  BulkImportStore,
  BulkImportValidationState,
} from './bulk-import-service.js';

const JOB_COLUMNS = `id, status, total_count, success_count, failure_count, created_by,
  error_summary, created_at, updated_at, completed_at`;
const ITEM_COLUMNS = `job_id, item_index, provider, credential_fingerprint, status, account_ref,
  error_reason, display_name, egress_proxy_id, validation_state, option_warnings,
  created_at, updated_at, completed_at`;
const PROVIDERS = new Set<BulkImportProvider>(['codex', 'claude', 'gemini', 'grok']);
const ITEM_STATUSES = new Set<BulkImportItemStatus>(['pending', 'succeeded', 'deduplicated', 'failed']);
const VALIDATION_STATES = new Set<BulkImportValidationState>([
  'pending_validation',
  'queued',
  'queue_failed',
  'not_requested',
]);
const OPTION_WARNINGS = new Set<BulkImportOptionWarning>(['DISPLAY_NAME_UNSUPPORTED', 'EGRESS_PROXY_ID_UNSUPPORTED']);

export type PostgresBulkImportStoreErrorCode =
  | 'BULK_IMPORT_JOB_NOT_FOUND'
  | 'BULK_IMPORT_JOB_NOT_RUNNING'
  | 'BULK_IMPORT_ITEM_NOT_PENDING'
  | 'BULK_IMPORT_CREDENTIAL_IN_PROGRESS'
  | 'BULK_IMPORT_JOB_HAS_PENDING_ITEMS'
  | 'BULK_IMPORT_JOB_COUNTERS_INCOMPLETE'
  | 'BULK_IMPORT_ROW_INVALID';

export class PostgresBulkImportStoreError extends Error {
  constructor(readonly code: PostgresBulkImportStoreErrorCode) {
    super(code);
    this.name = 'PostgresBulkImportStoreError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type Row = Record<string, unknown>;

function invalidRow(): never {
  throw new PostgresBulkImportStoreError('BULK_IMPORT_ROW_INVALID');
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
    status: status as BulkImportJobStatus,
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
  if (!PROVIDERS.has(provider) || !ITEM_STATUSES.has(status) || !VALIDATION_STATES.has(validationState)) {
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

/** PostgreSQL state machine for migration 150. No credential material crosses this boundary. */
export class PostgresBulkImportStore implements BulkImportStore {
  constructor(private readonly database: SaasDatabase) {
    if (!database || typeof database.transaction !== 'function')
      throw new TypeError('bulk import database is required');
  }

  private async write<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => {
      await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_TIMEOUTS_SQL);
      await tx.query(SAAS_PLATFORM_AUTHORIZATION_WRITER_FENCE_SQL);
      return work(tx);
    });
  }

  private async lockRunningJob(tx: SqlExecutor, jobId: string): Promise<void> {
    const result = await tx.query<Row>(`SELECT ${JOB_COLUMNS} FROM saas_bulk_import_job WHERE id = $1 FOR UPDATE`, [
      jobId,
    ]);
    const row = result.rows[0];
    if (!row) throw new PostgresBulkImportStoreError('BULK_IMPORT_JOB_NOT_FOUND');
    if (mapJob(row).status !== 'running') throw new PostgresBulkImportStoreError('BULK_IMPORT_JOB_NOT_RUNNING');
  }

  private async incrementJob(
    tx: SqlExecutor,
    jobId: string,
    success: number,
    failure: number,
    updatedAt: string,
  ): Promise<void> {
    const result = await tx.query<Row>(
      `UPDATE saas_bulk_import_job
       SET success_count = success_count + $2,
           failure_count = failure_count + $3,
           updated_at = $4
       WHERE id = $1 AND status = 'running'
         AND success_count + failure_count + $2 + $3 <= total_count
       RETURNING ${JOB_COLUMNS}`,
      [jobId, success, failure, updatedAt],
    );
    if (!result.rows[0]) throw new PostgresBulkImportStoreError('BULK_IMPORT_JOB_COUNTERS_INCOMPLETE');
  }

  async createJob(input: BulkImportJobCreate): Promise<BulkImportJobRecord> {
    return this.write(async (tx) => {
      const result = await tx.query<Row>(
        `INSERT INTO saas_bulk_import_job
           (id, total_count, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)
         RETURNING ${JOB_COLUMNS}`,
        [input.id, input.totalCount, input.createdBy, input.createdAt],
      );
      const row = result.rows[0];
      if (!row) return invalidRow();
      return mapJob(row);
    });
  }

  async claimItem(input: BulkImportItemClaim): Promise<BulkImportClaimResult> {
    return this.write(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        `model-router:bulk-import:${input.provider}:${input.credentialFingerprint}`,
      ]);
      await this.lockRunningJob(tx, input.jobId);
      const active = await tx.query<Row>(
        `SELECT ${ITEM_COLUMNS}
         FROM saas_bulk_import_item
         WHERE provider = $1 AND credential_fingerprint = $2 AND status IN ('pending', 'succeeded')
         ORDER BY created_at, job_id, item_index
         LIMIT 1
         FOR UPDATE`,
        [input.provider, input.credentialFingerprint],
      );
      const existingRow = active.rows[0];
      if (existingRow) {
        const existing = mapItem(existingRow);
        if (existing.status === 'pending' || existing.accountRef === null) {
          throw new PostgresBulkImportStoreError('BULK_IMPORT_CREDENTIAL_IN_PROGRESS');
        }
        const inserted = await tx.query<Row>(
          `INSERT INTO saas_bulk_import_item
             (job_id, item_index, provider, credential_fingerprint, status, account_ref,
              display_name, egress_proxy_id, validation_state, option_warnings,
              created_at, updated_at, completed_at)
           VALUES ($1, $2, $3, $4, 'deduplicated', $5, $6, $7, 'not_requested', $8::jsonb,
                   $9, $9, $9)
           RETURNING ${ITEM_COLUMNS}`,
          [
            input.jobId,
            input.itemIndex,
            input.provider,
            input.credentialFingerprint,
            existing.accountRef,
            input.displayName,
            input.egressProxyId,
            JSON.stringify(input.optionWarnings),
            input.createdAt,
          ],
        );
        const row = inserted.rows[0];
        if (!row) return invalidRow();
        await this.incrementJob(tx, input.jobId, 1, 0, input.createdAt);
        return Object.freeze({ kind: 'deduplicated' as const, item: mapItem(row) });
      }
      const inserted = await tx.query<Row>(
        `INSERT INTO saas_bulk_import_item
           (job_id, item_index, provider, credential_fingerprint, status,
            display_name, egress_proxy_id, validation_state, option_warnings, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, 'pending_validation', $7::jsonb, $8, $8)
         RETURNING ${ITEM_COLUMNS}`,
        [
          input.jobId,
          input.itemIndex,
          input.provider,
          input.credentialFingerprint,
          input.displayName,
          input.egressProxyId,
          JSON.stringify(input.optionWarnings),
          input.createdAt,
        ],
      );
      if (!inserted.rows[0]) return invalidRow();
      return Object.freeze({ kind: 'claimed' as const });
    });
  }

  async succeedItem(input: BulkImportItemSuccess): Promise<BulkImportItemRecord> {
    return this.write(async (tx) => {
      await this.lockRunningJob(tx, input.jobId);
      const result = await tx.query<Row>(
        `UPDATE saas_bulk_import_item
         SET status = 'succeeded', account_ref = $3, validation_state = $4, error_reason = $5,
             updated_at = $6, completed_at = $6
         WHERE job_id = $1 AND item_index = $2 AND status = 'pending'
         RETURNING ${ITEM_COLUMNS}`,
        [input.jobId, input.itemIndex, input.accountRef, input.validationState, input.errorReason, input.completedAt],
      );
      const row = result.rows[0];
      if (!row) throw new PostgresBulkImportStoreError('BULK_IMPORT_ITEM_NOT_PENDING');
      await this.incrementJob(tx, input.jobId, 1, 0, input.completedAt);
      return mapItem(row);
    });
  }

  async failItem(input: BulkImportItemFailure): Promise<BulkImportItemRecord> {
    return this.write(async (tx) => {
      await this.lockRunningJob(tx, input.jobId);
      const result = await tx.query<Row>(
        `UPDATE saas_bulk_import_item
         SET status = 'failed', error_reason = $3, validation_state = 'not_requested',
             updated_at = $4, completed_at = $4
         WHERE job_id = $1 AND item_index = $2 AND status = 'pending'
         RETURNING ${ITEM_COLUMNS}`,
        [input.jobId, input.itemIndex, input.errorReason, input.completedAt],
      );
      const row = result.rows[0];
      if (!row) throw new PostgresBulkImportStoreError('BULK_IMPORT_ITEM_NOT_PENDING');
      await this.incrementJob(tx, input.jobId, 0, 1, input.completedAt);
      return mapItem(row);
    });
  }

  async completeJob(input: {
    readonly jobId: string;
    readonly errorSummary: Readonly<Record<string, number>>;
    readonly completedAt: string;
  }): Promise<BulkImportJobRecord> {
    return this.write(async (tx) => {
      await this.lockRunningJob(tx, input.jobId);
      const pending = await tx.query<{ readonly exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM saas_bulk_import_item WHERE job_id = $1 AND status = 'pending'
         ) AS exists`,
        [input.jobId],
      );
      if (pending.rows[0]?.exists !== false) {
        throw new PostgresBulkImportStoreError('BULK_IMPORT_JOB_HAS_PENDING_ITEMS');
      }
      const result = await tx.query<Row>(
        `UPDATE saas_bulk_import_job
         SET status = 'completed', error_summary = $2::jsonb, updated_at = $3, completed_at = $3
         WHERE id = $1 AND status = 'running' AND success_count + failure_count = total_count
         RETURNING ${JOB_COLUMNS}`,
        [input.jobId, JSON.stringify(input.errorSummary), input.completedAt],
      );
      const row = result.rows[0];
      if (!row) throw new PostgresBulkImportStoreError('BULK_IMPORT_JOB_COUNTERS_INCOMPLETE');
      return mapJob(row);
    });
  }
}
