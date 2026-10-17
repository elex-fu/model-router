import type { SaasDatabase } from '../../db/types.js';

/**
 * Roadmap batch 4 §4.2 (task #16) async image task store (sub2api
 * `image_task.go` ImageTaskStore ported to the hosted PG discipline).
 *
 * A task row records one accepted async image generation: identity (opaque
 * `imgtask_<32-hex>` id), ownership (tenant + proxy key — the
 * sub2api user_id/api_key_id pair), the state machine
 * (processing → completed|failed), the HTTP status the upstream produced,
 * the (post-offload) result JSON or the failure envelope, and the 24-hour
 * TTL (`expires_at`).
 *
 * TTL enforcement is lazy-read plus an explicit sweep hook: reads treat
 * expired rows as absent and delete them; deployments can additionally call
 * `purgeExpired` from a janitor cadence. No Redis anywhere: the durable PG
 * row is the store of record (sub2api's Redis store is an equivalent
 * private representation).
 */

export type SaasImageTaskStatus = 'processing' | 'completed' | 'failed';

export const IMAGE_TASK_ID_PATTERN = /^imgtask_[0-9a-f]{32}$/;

export interface SaasImageTaskRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly proxyKeyId: string;
  readonly status: SaasImageTaskStatus;
  readonly httpStatus: number | null;
  /** The (offloaded, compact) result JSON text; null while processing/failed. */
  readonly result: string | null;
  /** The failure envelope JSON text; null while processing/completed. */
  readonly error: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly expiresAt: string;
}

export interface SaasImageTaskFinishInput {
  readonly status: 'completed' | 'failed';
  readonly httpStatus: number;
  readonly result: string | null;
  readonly error: string | null;
  readonly completedAt: string;
  /** A finished task's TTL restarts from completion (sub2api finish()). */
  readonly expiresAt: string;
}

export interface SaasImageTaskStore {
  create(record: SaasImageTaskRecord): Promise<void>;
  get(id: string): Promise<SaasImageTaskRecord | null>;
  /** finish returns false when the task id is absent (never a silent no-op). */
  finish(id: string, input: SaasImageTaskFinishInput): Promise<boolean>;
  /** Deletes rows past their TTL; returns the number removed. */
  purgeExpired?(now: string): Promise<number>;
}

export class SaasImageTaskStoreError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'SaasImageTaskStoreError';
  }
}

function validRecord(record: SaasImageTaskRecord): boolean {
  if (!record || typeof record !== 'object') return false;
  if (!IMAGE_TASK_ID_PATTERN.test(record.id)) return false;
  if (typeof record.tenantId !== 'string' || record.tenantId.trim() === '') return false;
  if (typeof record.proxyKeyId !== 'string' || record.proxyKeyId.trim() === '') return false;
  if (record.status !== 'processing' && record.status !== 'completed' && record.status !== 'failed') return false;
  if (
    record.httpStatus !== null &&
    (typeof record.httpStatus !== 'number' ||
      !Number.isInteger(record.httpStatus) ||
      record.httpStatus < 100 ||
      record.httpStatus > 599)
  ) {
    return false;
  }
  if (record.result !== null && typeof record.result !== 'string') return false;
  if (record.error !== null && typeof record.error !== 'string') return false;
  return (
    typeof record.createdAt === 'string' &&
    !Number.isNaN(Date.parse(record.createdAt)) &&
    typeof record.expiresAt === 'string' &&
    !Number.isNaN(Date.parse(record.expiresAt)) &&
    (record.completedAt === null ||
      (typeof record.completedAt === 'string' && !Number.isNaN(Date.parse(record.completedAt))))
  );
}

/**
 * The production PostgreSQL store. Every statement is parameterized; the
 * gateway runtime role holds exactly the column-scoped INSERT/UPDATE grants
 * (the SELECT/DELETE rides the table grants) mirrored in
 * runtime-privileges.ts and deploy/managed-saas-postgres-roles.sql.
 */
export class PostgresImageTaskStore implements SaasImageTaskStore {
  constructor(private readonly database: SaasDatabase) {
    if (!database || typeof database.query !== 'function') {
      throw new SaasImageTaskStoreError('INVALID_INPUT', 'image task store requires a database');
    }
  }

  async create(record: SaasImageTaskRecord): Promise<void> {
    if (!validRecord(record)) {
      throw new SaasImageTaskStoreError('INVALID_INPUT', 'image task record is invalid');
    }
    await this.database.query(
      `INSERT INTO saas_image_tasks
         (id, tenant_id, proxy_key_id, status, http_status, result, error, created_at, completed_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        record.id,
        record.tenantId,
        record.proxyKeyId,
        record.status,
        record.httpStatus,
        record.result === null ? null : record.result,
        record.error === null ? null : record.error,
        record.createdAt,
        record.completedAt,
        record.expiresAt,
      ],
    );
  }

  async get(id: string): Promise<SaasImageTaskRecord | null> {
    if (!IMAGE_TASK_ID_PATTERN.test(id)) return null;
    const result = await this.database.query<{
      id: string;
      tenant_id: string;
      proxy_key_id: string;
      status: SaasImageTaskStatus;
      http_status: number | null;
      result: unknown;
      error: unknown;
      created_at: string;
      completed_at: string | null;
      expires_at: string;
    }>(
      `SELECT id, tenant_id, proxy_key_id, status, http_status, result, error, created_at, completed_at, expires_at
         FROM saas_image_tasks
        WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      proxyKeyId: row.proxy_key_id,
      status: row.status,
      httpStatus: row.http_status,
      result: row.result === null ? null : JSON.stringify(row.result),
      error: row.error === null ? null : JSON.stringify(row.error),
      createdAt: new Date(row.created_at).toISOString(),
      completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async finish(id: string, input: SaasImageTaskFinishInput): Promise<boolean> {
    if (!IMAGE_TASK_ID_PATTERN.test(id)) return false;
    if (!input || (input.status !== 'completed' && input.status !== 'failed')) {
      throw new SaasImageTaskStoreError('INVALID_INPUT', 'image task finish input is invalid');
    }
    const result = await this.database.query(
      `UPDATE saas_image_tasks
          SET status = $2,
              http_status = $3,
              result = $4,
              error = $5,
              completed_at = $6,
              expires_at = $7
        WHERE id = $1 AND status = 'processing'`,
      [
        id,
        input.status,
        input.httpStatus,
        input.result === null ? null : input.result,
        input.error === null ? null : input.error,
        input.completedAt,
        input.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async purgeExpired(now: string): Promise<number> {
    const result = await this.database.query(`DELETE FROM saas_image_tasks WHERE expires_at <= $1`, [now]);
    return result.rowCount ?? 0;
  }
}

/**
 * The in-memory store for unit tests and single-process dev wiring; expiry
 * is enforced lazily on read (the production TTL is the PG row's
 * expires_at plus the purge sweep).
 */
export interface InMemoryImageTaskStoreOptions {
  /** Clock for lazy TTL enforcement; defaults to the wall clock. */
  readonly now?: () => number;
}

export class InMemoryImageTaskStore implements SaasImageTaskStore {
  private readonly records = new Map<string, SaasImageTaskRecord>();
  private readonly now: () => number;

  constructor(options: InMemoryImageTaskStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async create(record: SaasImageTaskRecord): Promise<void> {
    if (!validRecord(record)) {
      throw new SaasImageTaskStoreError('INVALID_INPUT', 'image task record is invalid');
    }
    if (this.records.has(record.id)) {
      throw new SaasImageTaskStoreError('UNAVAILABLE', 'image task id already exists');
    }
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<SaasImageTaskRecord | null> {
    const record = this.records.get(id) ?? null;
    if (record !== null && Date.parse(record.expiresAt) <= this.now()) {
      this.records.delete(id);
      return null;
    }
    return record === null ? null : { ...record };
  }

  async finish(id: string, input: SaasImageTaskFinishInput): Promise<boolean> {
    const record = this.records.get(id) ?? null;
    if (record === null || record.status !== 'processing') return false;
    this.records.set(id, {
      ...record,
      status: input.status,
      httpStatus: input.httpStatus,
      result: input.result,
      error: input.error,
      completedAt: input.completedAt,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  async purgeExpired(now: string): Promise<number> {
    const cutoff = Date.parse(now);
    let removed = 0;
    for (const [id, record] of this.records) {
      if (Date.parse(record.expiresAt) <= cutoff) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
