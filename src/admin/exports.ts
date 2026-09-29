import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ControlError } from '../control/service.js';
import type { ControlStore } from '../control/store.js';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import type { TrafficSource } from '../telemetry/types.js';
import type { ExportWorkerInput } from './exports-worker.js';
import type { AdminJobs } from './jobs.js';

type WorkerMessage =
  | { kind: 'result'; rows: number }
  | { kind: 'error'; message: string; status?: number; code?: string };
const EXPORT_TIMEOUT_MS = 30_000;

/** Resolves only after worker exit, so failed and cancelled jobs leave no export file. */
export function runExportWorker(
  input: ExportWorkerInput,
  signal: AbortSignal,
  timeoutMs = EXPORT_TIMEOUT_MS,
): Promise<number> {
  if (signal.aborted) return Promise.reject(new Error('Export cancelled'));
  return new Promise((resolve, reject) => {
    const sourceMode = __filename.endsWith('.ts');
    const entry = join(__dirname, sourceMode ? 'exports-worker.ts' : 'exports-worker.js');
    const worker = new Worker(entry, { workerData: input, execArgv: sourceMode ? ['--require', 'tsx/cjs'] : [] });
    let message: WorkerMessage | undefined;
    let workerError: Error | undefined;
    let cancelled = false;
    let timedOut = false;
    const stop = () => {
      void worker.terminate().catch((error: unknown) => {
        workerError = error instanceof Error ? error : new Error('Export worker termination failed');
      });
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    worker.on('message', (value: WorkerMessage) => {
      message = value;
    });
    worker.once('error', (error) => {
      workerError = error;
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      let cleanupError: unknown;
      if (cancelled || timedOut || workerError || code !== 0 || message?.kind !== 'result') {
        try {
          rmSync(input.temporary, { force: true });
          rmSync(input.destination, { force: true });
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError) reject(new Error('Export file cleanup failed', { cause: cleanupError }));
      else if (cancelled || signal.aborted) reject(new Error('Export cancelled'));
      else if (timedOut) reject(new ControlError(504, 'EXPORT_TIMEOUT', 'Export timed out'));
      else if (workerError) reject(workerError);
      else if (code !== 0) reject(new Error(`Export worker exited with code ${code}`));
      else if (message?.kind === 'error')
        reject(
          message.code && message.status
            ? new ControlError(message.status, message.code, message.message)
            : new Error(message.message),
        );
      else if (message?.kind === 'result') resolve(message.rows);
      else reject(new Error('Export worker exited without a result'));
    });
  });
}
function parseTime(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value))
    throw new ControlError(400, 'INVALID_EXPORT_RANGE', 'Export times must be ISO8601 with timezone');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ControlError(400, 'INVALID_EXPORT_RANGE', 'Invalid export time');
  return parsed;
}

/** Bounded, private, redacted request/usage exports. No prompt, response, credential or hash columns. */
export class AdminExports {
  private readonly directory: string;
  constructor(
    private readonly store: ControlStore,
    private readonly telemetry: SQLiteTelemetryStore,
    private readonly jobs: AdminJobs,
    dataDir: string,
  ) {
    this.directory = join(dataDir, 'admin-exports');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    store.db.exec(`CREATE TABLE IF NOT EXISTS admin_exports (
      id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, job_id TEXT NOT NULL, format TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
    )`);
  }

  create(input: Record<string, unknown>, actor: string) {
    const format = input.format === undefined ? 'csv' : input.format;
    if (format !== 'csv' && format !== 'json') throw new ControlError(400, 'INVALID_EXPORT_FORMAT', 'Use csv or json');
    if (input.type !== 'usage' && input.type !== 'requests')
      throw new ControlError(400, 'INVALID_EXPORT_TYPE', 'Use usage or requests');
    const filters =
      input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters)
        ? (input.filters as Record<string, unknown>)
        : {};
    const to = parseTime(filters.to, Date.now());
    const from = parseTime(filters.from, to - 86_400_000);
    if (from >= to || to - from > 31 * 86_400_000)
      throw new ControlError(400, 'INVALID_EXPORT_RANGE', 'Export range must be at most 31 days');
    const requestedSource = filters.source === 'proxy' || filters.source === undefined ? 'production' : filters.source;
    if (!['production', 'playground', 'health', 'all'].includes(String(requestedSource)))
      throw new ControlError(400, 'INVALID_EXPORT_SOURCE', 'Unknown source');
    const source = requestedSource as TrafficSource | 'all';
    const keyId = filters.keyId === '' ? undefined : filters.keyId;
    const upstreamId = filters.upstreamId === '' ? undefined : filters.upstreamId;
    const model = filters.model === '' ? undefined : filters.model;
    const protocol = filters.protocol === '' ? undefined : filters.protocol;
    for (const value of [keyId, upstreamId, model, protocol])
      if (value !== undefined && (typeof value !== 'string' || value.length > 200))
        throw new ControlError(400, 'INVALID_EXPORT_FILTER', 'Invalid export filter');
    let dbPath: string;
    try {
      dbPath = this.telemetry.connection.name;
    } catch {
      throw new ControlError(503, 'TELEMETRY_UNAVAILABLE', 'Export requires an initialized telemetry database');
    }
    if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath))
      throw new ControlError(503, 'EXPORT_FILE_DB_REQUIRED', 'Export requires a file-backed telemetry database');
    const id = `exp_${randomUUID()}`;
    const job = this.jobs.start('export', actor, async (signal) => {
      const destination = join(this.directory, `${id}.${format}`);
      const temporary = join(this.directory, `.${id}.${format}.part`);
      const rows = await runExportWorker(
        {
          dbPath,
          destination,
          temporary,
          format,
          from,
          to,
          source,
          keyId: keyId as string | undefined,
          upstreamId: upstreamId as string | undefined,
          model: model as string | undefined,
          protocol: protocol as string | undefined,
        },
        signal,
      );
      if (signal.aborted) {
        rmSync(destination, { force: true });
        throw new Error('Export cancelled');
      }
      return { exportId: id, rows, downloadUrl: `/admin/api/v1/exports/${id}/download` };
    });
    const now = Date.now();
    this.store.db
      .prepare('INSERT INTO admin_exports VALUES(?,?,?,?,?,?)')
      .run(id, actor, job.jobId, format, now, now + 86_400_000);
    this.store.audit(actor, 'export.create', { id, jobId: job.jobId, type: input.type, format });
    return { exportId: id, jobId: job.jobId, status: 'queued', downloadUrl: `/admin/api/v1/exports/${id}/download` };
  }

  download(id: string, actor: string, res: ServerResponse): void {
    const row = this.store.db
      .prepare(
        'SELECT actor_id AS actorId,job_id AS jobId,format,expires_at_ms AS expiresAt FROM admin_exports WHERE id=?',
      )
      .get(id) as { actorId: string; jobId: string; format: string; expiresAt: number } | undefined;
    if (!row) throw new ControlError(404, 'NOT_FOUND', 'Export not found');
    if (row.actorId !== actor) throw new ControlError(403, 'FORBIDDEN', 'Export belongs to another user');
    if (row.expiresAt <= Date.now()) throw new ControlError(410, 'EXPORT_EXPIRED', 'Export expired');
    if (this.jobs.get(row.jobId).state !== 'completed')
      throw new ControlError(409, 'EXPORT_NOT_READY', 'Export is not ready');
    const path = join(this.directory, `${id}.${row.format}`);
    if (!existsSync(path)) throw new ControlError(410, 'EXPORT_GONE', 'Export file is missing');
    res.writeHead(200, {
      'content-type': row.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="model-router-${id}.${row.format}"`,
      'content-length': statSync(path).size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    createReadStream(path)
      .on('error', () => res.destroy())
      .pipe(res);
  }
}
