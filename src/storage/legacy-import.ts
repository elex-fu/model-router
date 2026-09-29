import type Database from 'better-sqlite3';
import type { NormalizedUsage, UsageProtocol } from '../telemetry/usage.js';
import type { SQLiteTelemetryStore } from './telemetry-store.js';

/** Never use this sentinel as a routable V2 upstream ID. */
export const LEGACY_UNKNOWN_UPSTREAM_ID = 'legacy:unmapped';
const IMPORT_ID = 'request_logs_to_v2_v1';
const BATCH_LIMIT = 1_000;

export class UnsafeLegacyImportError extends Error {
  readonly code = 'legacy_import_unsafe_native_requests';
  constructor() {
    super(
      'Automatic legacy import refused: requests already contains V2 rows and request_logs may include their compatibility copies. Preserve the current database; import a verified pre-V2 backup in a separate database and reconcile manually, or use a reviewed migration with a proven pre-V2 cutoff.',
    );
    this.name = 'UnsafeLegacyImportError';
  }
}

export interface LegacyImportOptions {
  /** Names in request_logs mapped to stable IDs from the migrated V2 config. */
  proxyKeyIdsByName?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  upstreamIdsByName?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Bounds each write transaction; defaults to 250, maximum 1000. */
  batchSize?: number;
}

export interface LegacyImportResult {
  completed: true;
  sourceCutoffId: number;
  importedRows: number;
  alreadyCompleted: boolean;
}

interface ImportState {
  cutoff_id: number;
  source_rows: number;
  last_id: number;
  imported_rows: number;
  status: 'running' | 'done';
}

interface LegacyRow {
  id: number;
  proxy_key_name: string | null;
  client_protocol: string | null;
  upstream_protocol: string | null;
  request_model: string | null;
  actual_model: string | null;
  upstream_name: string | null;
  status_code: number | null;
  request_tokens: number | null;
  response_tokens: number | null;
  total_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  created_at: string | null;
}

const optionalColumns = [
  'proxy_key_name',
  'client_protocol',
  'upstream_protocol',
  'request_model',
  'actual_model',
  'upstream_name',
  'status_code',
  'request_tokens',
  'response_tokens',
  'total_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'first_token_ms',
  'duration_ms',
  'created_at',
] as const;

function lookup(map: LegacyImportOptions['proxyKeyIdsByName'], name: string | null): string | null {
  if (!name || !map) return null;
  if (map instanceof Map) return map.get(name) ?? null;
  return Object.prototype.hasOwnProperty.call(map, name) ? ((map as Record<string, string>)[name] ?? null) : null;
}

function protocol(value: string | null): UsageProtocol | 'unknown' {
  return value === 'openai' || value === 'anthropic' || value === 'responses' || value === 'gemini' ? value : 'unknown';
}

function count(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function logTime(value: string | null, id: number): number {
  if (!value || !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(value))
    throw new Error(`legacy request_logs row ${id} has no parseable created_at`);
  const iso = value.replace(' ', 'T');
  const timestamp = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (!Number.isSafeInteger(timestamp)) throw new Error(`legacy request_logs row ${id} has invalid created_at`);
  return timestamp;
}

function legacyUsage(row: LegacyRow, upstreamProtocol: UsageProtocol | 'unknown'): NormalizedUsage {
  const usage: NormalizedUsage = {
    inputTotal: null,
    inputUncached: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: null,
    reasoningOutput: null,
    status: 'missing',
    source: 'legacy',
    semanticsVersion: 'legacy_v1',
  };
  if (upstreamProtocol === 'unknown') return usage;
  const input = count(row.request_tokens);
  usage.outputTotal = count(row.response_tokens);
  usage.cacheRead = count(row.cache_read_tokens);
  if (upstreamProtocol === 'anthropic') {
    usage.inputUncached = input;
    usage.cacheWrite = count(row.cache_creation_tokens);
    // Old input_tokens excluded cache input. A missing cache field is unknown, not zero.
    if (input !== null && usage.cacheRead !== null && usage.cacheWrite !== null)
      usage.inputTotal = input + usage.cacheRead + usage.cacheWrite;
  } else {
    usage.inputTotal = input;
    if (input !== null && usage.cacheRead !== null) usage.inputUncached = Math.max(0, input - usage.cacheRead);
  }
  usage.status =
    usage.inputTotal !== null && usage.outputTotal !== null
      ? 'reported'
      : input !== null || usage.outputTotal !== null || usage.cacheRead !== null
        ? 'partial'
        : 'missing';
  return usage;
}

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS legacy_import_state (
      id TEXT PRIMARY KEY, cutoff_id INTEGER NOT NULL, source_rows INTEGER NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0,
      imported_rows INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_request_metadata (
      request_id TEXT PRIMARY KEY, source_row_id INTEGER NOT NULL UNIQUE,
      measurement TEXT NOT NULL CHECK(measurement='legacy_log_rows'),
      proxy_key_name TEXT, upstream_name TEXT, client_protocol TEXT, upstream_protocol TEXT,
      created_at TEXT, request_tokens INTEGER, response_tokens INTEGER,
      total_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      first_token_ms INTEGER
    );
  `);
}

/**
 * Imports only rows present at the first call's atomic cutoff. Call after both stores
 * are initialized, before V2 traffic and before legacy retention/purge starts.
 * Each batch and its progress marker commit together; an interrupted run resumes.
 */
export async function importLegacyRequestLogs(
  store: SQLiteTelemetryStore,
  options: LegacyImportOptions = {},
): Promise<LegacyImportResult> {
  const db = store.connection;
  const size = options.batchSize ?? 250;
  if (!Number.isSafeInteger(size) || size < 1 || size > BATCH_LIMIT)
    throw new RangeError('legacy import batchSize must be 1..1000');
  createTables(db);
  const existed = db.prepare('SELECT status FROM legacy_import_state WHERE id=?').get(IMPORT_ID) as
    | { status: string }
    | undefined;
  const state = db
    .transaction((): ImportState => {
      const current = db.prepare('SELECT * FROM legacy_import_state WHERE id=?').get(IMPORT_ID) as
        | ImportState
        | undefined;
      if (current) return current;
      // Without a marker there is no reliable boundary between old rows and V2's
      // compatibility copies. Refuse even if the IDs/timestamps appear distinct.
      if (db.prepare('SELECT 1 FROM requests LIMIT 1').get()) throw new UnsafeLegacyImportError();
      const sourceExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'`).get();
      if (sourceExists) {
        const columns = db.prepare('PRAGMA table_info(request_logs)').all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'id')) throw new Error('request_logs table lacks id');
      }
      const cutoff = sourceExists
        ? (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM request_logs').get() as { id: number }).id
        : 0;
      const sourceRows = sourceExists
        ? (db.prepare('SELECT COUNT(*) AS n FROM request_logs').get() as { n: number }).n
        : 0;
      db.prepare(`INSERT INTO legacy_import_state (id, cutoff_id, source_rows, last_id, imported_rows, status)
      VALUES (?, ?, ?, 0, 0, ?)`).run(IMPORT_ID, cutoff, sourceRows, sourceRows === 0 ? 'done' : 'running');
      return {
        cutoff_id: cutoff,
        source_rows: sourceRows,
        last_id: 0,
        imported_rows: 0,
        status: sourceRows === 0 ? 'done' : 'running',
      };
    })
    .immediate();
  if (state.status === 'done')
    return {
      completed: true,
      sourceCutoffId: state.cutoff_id,
      importedRows: state.imported_rows,
      alreadyCompleted: Boolean(existed),
    };
  const sourceExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'`).get();
  if (!sourceExists) throw new Error('request_logs disappeared during legacy import');
  const available = new Set(
    (db.prepare('PRAGMA table_info(request_logs)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!available.has('id')) throw new Error('request_logs table lacks id');
  const columns = optionalColumns.map((name) => (available.has(name) ? name : `NULL AS ${name}`));
  const select = db.prepare(`SELECT id, ${columns.join(', ')} FROM request_logs
    WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`);
  const requestInsert = db.prepare(`INSERT INTO requests (
    id, proxy_key_id, source, client_protocol, request_model, route_id, config_revision,
    state, final_http_status, started_at_ms, ended_at_ms, duration_ms,
    first_byte_ms, first_event_ms, first_text_ms, final_upstream_id
  ) VALUES (?, ?, 'production', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`);
  const attemptInsert = db.prepare(`INSERT INTO attempts (
    id, request_id, ordinal, upstream_id, credential_id, resolved_model, reported_model,
    protocol, outcome, status, retry_reason, started_at_ms, ended_at_ms,
    usage_json, pricing_version, cost_micros, currency
  ) VALUES (?, ?, 1, ?, NULL, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)`);
  const metadataInsert = db.prepare(`INSERT INTO legacy_request_metadata (
    request_id, source_row_id, measurement, proxy_key_name, upstream_name,
    client_protocol, upstream_protocol, created_at, request_tokens, response_tokens,
    total_tokens, cache_read_tokens, cache_creation_tokens, first_token_ms
  ) VALUES (?, ?, 'legacy_log_rows', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  while (true) {
    const result = db
      .transaction((): ImportState => {
        const current = db.prepare('SELECT * FROM legacy_import_state WHERE id=?').get(IMPORT_ID) as ImportState;
        if (current.status === 'done') return current;
        const rows = select.all(current.last_id, current.cutoff_id, size) as LegacyRow[];
        for (const row of rows) {
          const timestamp = logTime(row.created_at, row.id);
          const clientProtocol = protocol(row.client_protocol);
          const upstreamProtocol = protocol(row.upstream_protocol);
          const upstreamId = lookup(options.upstreamIdsByName, row.upstream_name);
          const requestId = `legacy-log-row:${row.id}`;
          const attemptId = `legacy-log-attempt:${row.id}`;
          const status = count(row.status_code);
          const completed = status !== null && status >= 200 && status < 300;
          const state = completed ? 'completed' : status === null ? 'interrupted' : 'failed';
          const duration = count(row.duration_ms);
          const usage = legacyUsage(row, upstreamProtocol);
          requestInsert.run(
            requestId,
            lookup(options.proxyKeyIdsByName, row.proxy_key_name),
            clientProtocol,
            row.request_model,
            state,
            status,
            timestamp,
            timestamp,
            duration,
            upstreamId,
          );
          attemptInsert.run(
            attemptId,
            requestId,
            upstreamId ?? LEGACY_UNKNOWN_UPSTREAM_ID,
            row.actual_model,
            upstreamProtocol,
            state,
            status,
            timestamp,
            timestamp,
            JSON.stringify(usage),
          );
          metadataInsert.run(
            requestId,
            row.id,
            row.proxy_key_name,
            row.upstream_name,
            row.client_protocol,
            row.upstream_protocol,
            row.created_at,
            row.request_tokens,
            row.response_tokens,
            row.total_tokens,
            row.cache_read_tokens,
            row.cache_creation_tokens,
            row.first_token_ms,
          );
        }
        const last = rows.at(-1)?.id ?? current.last_id;
        const done = rows.length < size || last >= current.cutoff_id;
        if (done && current.imported_rows + rows.length !== current.source_rows)
          throw new Error('legacy request_logs changed during import; refusing incomplete marker');
        db.prepare(`UPDATE legacy_import_state SET last_id=?, imported_rows=imported_rows+?,
        status=? WHERE id=?`).run(last, rows.length, done ? 'done' : 'running', IMPORT_ID);
        return {
          cutoff_id: current.cutoff_id,
          source_rows: current.source_rows,
          last_id: last,
          imported_rows: current.imported_rows + rows.length,
          status: done ? 'done' : 'running',
        };
      })
      .immediate();
    if (result.status === 'done')
      return {
        completed: true,
        sourceCutoffId: result.cutoff_id,
        importedRows: result.imported_rows,
        alreadyCompleted: false,
      };
  }
}
