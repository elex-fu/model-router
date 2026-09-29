import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

export interface ExportWorkerInput {
  dbPath: string;
  destination: string;
  temporary: string;
  format: 'csv' | 'json';
  from: number;
  to: number;
  source: string;
  keyId?: string;
  upstreamId?: string;
  model?: string;
  protocol?: string;
}

type Row = Record<string, string | number | null>;
const fields = [
  'requestId',
  'source',
  'startedAt',
  'state',
  'keyId',
  'protocol',
  'model',
  'routeId',
  'upstreamId',
  'httpStatus',
  'inputTokens',
  'outputTokens',
] as const;
const MAX_ROWS = 10_000;
const MAX_BYTES = 5_000_000;

class ExportLimitError extends Error {
  readonly status = 413;
  readonly code = 'EXPORT_TOO_LARGE';
}

function csvCell(value: string | number | null): string {
  const raw = value === null ? '' : String(value);
  const safe = /^[=+@-]/.test(raw.replace(/^[\p{Cc}\s]+/u, '')) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function exportToFile(input: ExportWorkerInput): number {
  const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
  let descriptor: number | undefined;
  let created = false;
  let operationError: unknown;
  let cleanupError: AggregateError | undefined;
  let rowsWritten = 0;
  try {
    db.pragma('query_only = ON');
    db.pragma('busy_timeout = 5000');
    const clauses = ['r.started_at_ms>=?', 'r.started_at_ms<?'];
    const args: Array<string | number> = [input.from, input.to];
    for (const [column, value] of [
      ['r.source', input.source === 'all' ? undefined : input.source],
      ['r.proxy_key_id', input.keyId],
      ['r.final_upstream_id', input.upstreamId],
      ['r.request_model', input.model],
      ['r.client_protocol', input.protocol],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column}=?`);
        args.push(value);
      }
    }
    const where = clauses.join(' AND ');
    const count = db.prepare(`SELECT COUNT(*) AS count FROM requests r WHERE ${where}`).get(...args) as {
      count: number;
    };
    if (count.count > MAX_ROWS) throw new ExportLimitError('Export exceeds 10,000 requests');

    const query = db.prepare(`SELECT r.id AS requestId,r.source,r.started_at_ms AS startedAtMs,
      r.state,r.proxy_key_id AS keyId,r.client_protocol AS protocol,r.request_model AS model,
      r.route_id AS routeId,r.final_upstream_id AS upstreamId,r.final_http_status AS httpStatus,
      CASE WHEN COUNT(a.id)=0 OR SUM(CASE WHEN json_extract(a.usage_json,'$.inputTotal') IS NULL THEN 1 ELSE 0 END)>0
        THEN NULL ELSE SUM(json_extract(a.usage_json,'$.inputTotal')) END AS inputTokens,
      CASE WHEN COUNT(a.id)=0 OR SUM(CASE WHEN json_extract(a.usage_json,'$.outputTotal') IS NULL THEN 1 ELSE 0 END)>0
        THEN NULL ELSE SUM(json_extract(a.usage_json,'$.outputTotal')) END AS outputTokens
      FROM requests r LEFT JOIN attempts a ON a.request_id=r.id
      WHERE ${where} GROUP BY r.id ORDER BY r.started_at_ms DESC,r.id DESC LIMIT ?`);
    descriptor = openSync(input.temporary, 'wx', 0o600);
    created = true;
    let bytes = 0;
    const write = (chunk: string) => {
      const size = Buffer.byteLength(chunk);
      if (bytes + size > MAX_BYTES) throw new ExportLimitError('Export exceeds 5 MB');
      const data = Buffer.from(chunk);
      for (let offset = 0; offset < data.length; ) offset += writeSync(descriptor!, data, offset);
      bytes += size;
    };
    write(input.format === 'csv' ? `${fields.join(',')}\r\n` : '{"schemaVersion":1,"rows":[');
    let rows = 0;
    for (const record of query.iterate(...args, MAX_ROWS + 1) as Iterable<
      Omit<Row, 'startedAt'> & { startedAtMs: number }
    >) {
      if (++rows > MAX_ROWS) throw new ExportLimitError('Export exceeds 10,000 requests');
      const { startedAtMs, ...other } = record;
      const row: Row = { ...other, startedAt: new Date(startedAtMs).toISOString() };
      write(
        input.format === 'csv'
          ? `${fields.map((field) => csvCell(row[field] ?? null)).join(',')}\r\n`
          : `${rows === 1 ? '' : ','}${JSON.stringify(row)}`,
      );
    }
    if (input.format === 'json') write(']}');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(input.temporary, input.destination);
    created = false;
    rowsWritten = rows;
  } catch (error) {
    operationError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (created) {
      try {
        unlinkSync(input.temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(error);
      }
    }
    try {
      db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      cleanupError = new AggregateError(cleanupErrors, 'Export worker cleanup failed');
    }
  }
  if (operationError !== undefined) {
    if (cleanupError && operationError instanceof Error) {
      Object.defineProperty(operationError, 'cleanupError', { value: cleanupError });
    }
    throw operationError;
  }
  if (cleanupError) throw cleanupError;
  return rowsWritten;
}

if (!parentPort) throw new Error('Export worker must run in a worker thread');
try {
  const rows = exportToFile(workerData as ExportWorkerInput);
  parentPort.postMessage({ kind: 'result', rows });
} catch (error) {
  const failure = error instanceof Error ? error : new Error('Export worker failed');
  const structured = failure as Error & { status?: number; code?: string };
  parentPort.postMessage({
    kind: 'error',
    message: failure.message,
    ...(structured.status && structured.code ? { status: structured.status, code: structured.code } : {}),
  });
}
