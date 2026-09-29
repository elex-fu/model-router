import { join } from 'node:path';
import { isMainThread, Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { AttemptRecord, RequestRecord, RequestState, TrafficSource } from '../telemetry/types.js';
import type { NormalizedUsage } from '../telemetry/usage.js';
import { DEFAULT_DB_PATH } from '../utils/paths.js';

export interface RequestFilter {
  fromMs?: number;
  toMs?: number;
  proxyKeyId?: string;
  state?: RequestState;
  source?: TrafficSource;
  finalUpstreamId?: string;
  cursor?: { startedAtMs: number; id: string };
  limit?: number;
}
export interface RequestPage {
  items: RequestRecord[];
  nextCursor: { startedAtMs: number; id: string } | null;
}
export interface UsageSummary {
  logicalRequests: number;
  /** Pre-V2 log rows cannot be reliably deduplicated into logical requests. */
  legacyLogRows: number;
  upstreamAttempts: number;
  completed: number;
  failed: number;
  cancelled: number;
  rejected: number;
  inProgress: number;
  inputTokens: number;
  outputTokens: number;
  missingUsageAttempts: number;
  observedAt: number;
  dataThrough: number | null;
  partial: boolean;
  grain: 'detail';
  coverage: 'full';
}

const requestColumns = `id, proxy_key_id, source, client_protocol, request_model, route_id,
 config_revision, state, final_http_status, started_at_ms, ended_at_ms, duration_ms,
 first_byte_ms, first_event_ms, first_text_ms, final_upstream_id, admitted, admission_known`;
const attemptColumns = `id, request_id, ordinal, upstream_id, credential_id, resolved_model,
 reported_model, protocol, outcome, status, retry_reason, started_at_ms, ended_at_ms,
 usage_json, pricing_version, cost_micros, currency`;

const req = (r: any): RequestRecord => ({
  id: r.id,
  proxyKeyId: r.proxy_key_id,
  source: r.source,
  clientProtocol: r.client_protocol,
  requestModel: r.request_model,
  routeId: r.route_id,
  configRevision: r.config_revision,
  state: r.state,
  finalHttpStatus: r.final_http_status,
  startedAtMs: r.started_at_ms,
  endedAtMs: r.ended_at_ms,
  durationMs: r.duration_ms,
  firstByteMs: r.first_byte_ms,
  firstEventMs: r.first_event_ms,
  firstTextMs: r.first_text_ms,
  finalUpstreamId: r.final_upstream_id,
});
const attempt = (r: any): AttemptRecord => ({
  id: r.id,
  requestId: r.request_id,
  ordinal: r.ordinal,
  upstreamId: r.upstream_id,
  credentialId: r.credential_id,
  resolvedModel: r.resolved_model,
  reportedModel: r.reported_model,
  protocol: r.protocol,
  outcome: r.outcome,
  status: r.status,
  retryReason: r.retry_reason,
  startedAtMs: r.started_at_ms,
  endedAtMs: r.ended_at_ms,
  usage: r.usage_json ? (JSON.parse(r.usage_json) as NormalizedUsage) : null,
  pricingVersion: r.pricing_version,
  costMicros: r.cost_micros,
  currency: r.currency,
});

const minute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
// Fixed millisecond upper bounds. The final bound is inclusive; bucket zero is [0, 1).
export const FIRST_EVENT_HISTOGRAM_BOUNDS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
  2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000, 200_000_000, 500_000_000, 1_000_000_000,
  2_000_000_000, 5_000_000_000, 10_000_000_000, 20_000_000_000, 50_000_000_000, 100_000_000_000, 200_000_000_000,
  500_000_000_000, 1_000_000_000_000, 2_000_000_000_000, 5_000_000_000_000, 9_007_199_254_740_991,
] as const;
export const FIRST_EVENT_HISTOGRAM_BUCKETS = FIRST_EVENT_HISTOGRAM_BOUNDS.length + 1;
function firstEventBin(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new RangeError('first-event latency must be a non-negative safe integer');
  const index = FIRST_EVENT_HISTOGRAM_BOUNDS.findIndex((bound) => ms < bound);
  if (index >= 0) return index;
  if (ms === Number.MAX_SAFE_INTEGER) return FIRST_EVENT_HISTOGRAM_BOUNDS.length - 1;
  throw new RangeError('first-event latency exceeds histogram maximum');
}
const dim = (value: string | null) => value ?? '';
const missing = (usage: NormalizedUsage | null) =>
  !usage || usage.status === 'missing' || usage.inputTotal === null || usage.outputTotal === null;
type Row = Record<string, any>;

/** All contributions are derived from persisted rows, never from a caller's proposed update. */
function requestDelta(db: Database.Database, row: Row, sign: 1 | -1): void {
  const terminal = ['completed', 'failed', 'cancelled', 'rejected'];
  const production = row.source === 'production';
  const ended = row.ended_at_ms !== null;
  const admitted = row.admitted === 1;
  const known = row.admission_known === 1;
  db.prepare(`INSERT INTO live_request_minute
    (bucket_ms,source,key_id,model,protocol,upstream_id,logical_requests,completed,failed,cancelled,rejected,in_progress,
     admitted_ended,admitted_completed,pre_admission_rejected,unknown_admission_ended,data_through_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bucket_ms,source,key_id,model,protocol,upstream_id) DO UPDATE SET
      logical_requests=logical_requests+excluded.logical_requests,
      completed=completed+excluded.completed,failed=failed+excluded.failed,
      cancelled=cancelled+excluded.cancelled,rejected=rejected+excluded.rejected,
      in_progress=in_progress+excluded.in_progress,
      admitted_ended=admitted_ended+excluded.admitted_ended,
      admitted_completed=admitted_completed+excluded.admitted_completed,
      pre_admission_rejected=pre_admission_rejected+excluded.pre_admission_rejected,
      unknown_admission_ended=unknown_admission_ended+excluded.unknown_admission_ended,
      data_through_ms=CASE WHEN excluded.data_through_ms IS NULL THEN data_through_ms
        WHEN data_through_ms IS NULL THEN excluded.data_through_ms
        ELSE MAX(data_through_ms,excluded.data_through_ms) END`).run(
    minute(row.started_at_ms),
    row.source,
    dim(row.proxy_key_id),
    dim(row.request_model),
    row.client_protocol,
    dim(row.final_upstream_id),
    sign,
    sign * Number(row.state === 'completed'),
    sign * Number(row.state === 'failed'),
    sign * Number(row.state === 'cancelled'),
    sign * Number(row.state === 'rejected'),
    sign * Number(!terminal.includes(row.state) && row.state !== 'interrupted'),
    sign * Number(production && ended && known && admitted),
    sign * Number(production && ended && known && admitted && row.state === 'completed'),
    sign * Number(production && ended && known && !admitted && row.state === 'rejected'),
    sign * Number(production && ended && !known),
    sign > 0 ? row.ended_at_ms : null,
  );
  const firstEventMs = row.first_text_ms ?? row.first_event_ms;
  if (firstEventMs !== null && firstEventMs !== undefined) {
    const key = [
      minute(row.started_at_ms),
      row.source,
      dim(row.proxy_key_id),
      dim(row.request_model),
      row.client_protocol,
      dim(row.final_upstream_id),
    ] as const;
    const counts = db
      .prepare(`SELECT histogram FROM live_first_event_minute
      WHERE bucket_ms=? AND source=? AND key_id=? AND model=? AND protocol=? AND upstream_id=?`)
      .get(...key) as { histogram: string } | undefined;
    const histogram = counts
      ? (JSON.parse(counts.histogram) as number[])
      : Array<number>(FIRST_EVENT_HISTOGRAM_BUCKETS).fill(0);
    histogram[firstEventBin(firstEventMs)] += sign;
    if (histogram.every((value) => value === 0)) {
      db.prepare(
        `DELETE FROM live_first_event_minute WHERE bucket_ms=? AND source=? AND key_id=? AND model=? AND protocol=? AND upstream_id=?`,
      ).run(...key);
    } else {
      db.prepare(`INSERT INTO live_first_event_minute(bucket_ms,source,key_id,model,protocol,upstream_id,histogram)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(bucket_ms,source,key_id,model,protocol,upstream_id) DO UPDATE SET histogram=excluded.histogram`).run(
        ...key,
        JSON.stringify(histogram),
      );
    }
  }
}

function attemptDelta(db: Database.Database, row: Row, parent: Row, sign: 1 | -1): void {
  const usage = row.usage_json ? (JSON.parse(row.usage_json) as NormalizedUsage) : null;
  db.prepare(`INSERT INTO live_attempt_minute
    (bucket_ms,source,key_id,model,protocol,upstream_id,currency,upstream_attempts,input_tokens,output_tokens,
     cache_read_tokens,cache_read_count,cache_write_tokens,cache_write_count,missing_usage_attempts,unpriced_attempts,cost_micros)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(bucket_ms,source,key_id,model,protocol,upstream_id,currency) DO UPDATE SET
      upstream_attempts=upstream_attempts+excluded.upstream_attempts,
      input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,cache_read_count=cache_read_count+excluded.cache_read_count,
      cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,cache_write_count=cache_write_count+excluded.cache_write_count,
      missing_usage_attempts=missing_usage_attempts+excluded.missing_usage_attempts,
      unpriced_attempts=unpriced_attempts+excluded.unpriced_attempts,cost_micros=cost_micros+excluded.cost_micros`).run(
    minute(row.started_at_ms),
    parent.source,
    dim(parent.proxy_key_id),
    dim(parent.request_model),
    parent.client_protocol,
    row.upstream_id,
    dim(row.currency),
    sign,
    sign * (usage?.inputTotal ?? 0),
    sign * (usage?.outputTotal ?? 0),
    sign * (usage?.cacheRead ?? 0),
    sign * Number(usage?.cacheRead !== null && usage?.cacheRead !== undefined),
    sign * (usage?.cacheWrite ?? 0),
    sign * Number(usage?.cacheWrite !== null && usage?.cacheWrite !== undefined),
    sign * Number(missing(usage)),
    sign * Number(row.cost_micros === null),
    sign * (row.cost_micros ?? 0),
  );
}

/** New request/attempt store. Legacy request_logs and LogStore remain independent. */
export class SQLiteTelemetryStore {
  private db?: Database.Database;
  private migration?: Promise<unknown>;
  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {}

  async init(): Promise<void> {
    if (this.db) return;
    const db = new Database(this.dbPath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      const hadFirstEventHistogram = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_first_event_minute'").get(),
      );
      const hadTelemetrySchema = Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='requests'").get(),
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS requests (
          id TEXT PRIMARY KEY, proxy_key_id TEXT, source TEXT NOT NULL,
          client_protocol TEXT NOT NULL, request_model TEXT, route_id TEXT,
          config_revision INTEGER, state TEXT NOT NULL, final_http_status INTEGER,
          started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, duration_ms INTEGER,
          first_byte_ms INTEGER, first_event_ms INTEGER, first_text_ms INTEGER,
          final_upstream_id TEXT,
          admitted INTEGER NOT NULL DEFAULT 0, admission_known INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_requests_time ON requests(started_at_ms, id);
        CREATE INDEX IF NOT EXISTS idx_requests_key_time ON requests(proxy_key_id, started_at_ms, id);
        CREATE INDEX IF NOT EXISTS idx_requests_state_time ON requests(state, started_at_ms, id);
        CREATE INDEX IF NOT EXISTS idx_requests_recent_errors ON requests(started_at_ms DESC)
          WHERE state IN ('failed','rejected');
        CREATE TABLE IF NOT EXISTS attempts (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id),
          ordinal INTEGER NOT NULL, upstream_id TEXT NOT NULL, credential_id TEXT,
          resolved_model TEXT, reported_model TEXT, protocol TEXT NOT NULL,
          outcome TEXT NOT NULL, status INTEGER, retry_reason TEXT,
          started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, usage_json TEXT,
          pricing_version TEXT, cost_micros INTEGER, currency TEXT,
          UNIQUE(request_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_upstream_time ON attempts(upstream_id, started_at_ms, id);
        CREATE INDEX IF NOT EXISTS idx_attempts_model_time ON attempts(resolved_model, started_at_ms, id);
        CREATE TABLE IF NOT EXISTS quota_periods (
          proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL,
          start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
          reported_used INTEGER NOT NULL DEFAULT 0, estimated_used INTEGER NOT NULL DEFAULT 0,
          reserved INTEGER NOT NULL DEFAULT 0, timezone_version_id INTEGER,
          PRIMARY KEY(proxy_key_id, period_id)
        );
        CREATE TABLE IF NOT EXISTS quota_timezone_versions (
          version_id INTEGER PRIMARY KEY AUTOINCREMENT,
          timezone TEXT NOT NULL,
          config_revision INTEGER,
          created_at_ms INTEGER NOT NULL,
          effective_from_ms INTEGER NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('active','scheduled','superseded'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_timezone_single_active
          ON quota_timezone_versions(state) WHERE state='active';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_timezone_single_scheduled
          ON quota_timezone_versions(state) WHERE state='scheduled';
        CREATE INDEX IF NOT EXISTS idx_quota_timezone_scheduled
          ON quota_timezone_versions(state,effective_from_ms);
        CREATE TABLE IF NOT EXISTS quota_reservations (
          request_id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL,
          reserved_tokens INTEGER NOT NULL, settled_tokens INTEGER,
          state TEXT NOT NULL, attempt_sent INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(proxy_key_id, period_id) REFERENCES quota_periods(proxy_key_id, period_id)
        );
        CREATE INDEX IF NOT EXISTS idx_reservation_key_state ON quota_reservations(proxy_key_id, state);
        CREATE TABLE IF NOT EXISTS quota_admissions (
          request_id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL,
          admitted_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_admissions_key_time ON quota_admissions(proxy_key_id, admitted_at_ms);
        CREATE TABLE IF NOT EXISTS quota_adjustments (
          id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL,
          delta_tokens INTEGER NOT NULL, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telemetry_write_watermark (
          id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO telemetry_write_watermark(id,sequence,updated_at_ms) VALUES(1,0,0);
        CREATE TRIGGER IF NOT EXISTS requests_watermark_insert AFTER INSERT ON requests BEGIN
          UPDATE telemetry_write_watermark SET sequence=sequence+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS requests_watermark_update AFTER UPDATE ON requests BEGIN
          UPDATE telemetry_write_watermark SET sequence=sequence+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS requests_watermark_delete AFTER DELETE ON requests BEGIN
          UPDATE telemetry_write_watermark SET sequence=sequence+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS attempts_watermark_insert AFTER INSERT ON attempts BEGIN
          UPDATE telemetry_write_watermark SET sequence=sequence+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS attempts_watermark_update AFTER UPDATE ON attempts BEGIN
          UPDATE telemetry_write_watermark SET sequence=sequence+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS attempts_watermark_delete AFTER DELETE ON attempts BEGIN
          UPDATE telemetry_write_watermark SET sequence=sequence+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=1;
        END;
        CREATE TABLE IF NOT EXISTS live_aggregate_state (
          id INTEGER PRIMARY KEY CHECK(id=1), covered_sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS live_request_minute (
          bucket_ms INTEGER NOT NULL, source TEXT NOT NULL, key_id TEXT NOT NULL,
          model TEXT NOT NULL, protocol TEXT NOT NULL, upstream_id TEXT NOT NULL,
          logical_requests INTEGER NOT NULL, completed INTEGER NOT NULL, failed INTEGER NOT NULL,
          cancelled INTEGER NOT NULL, rejected INTEGER NOT NULL, in_progress INTEGER NOT NULL,
          admitted_ended INTEGER NOT NULL DEFAULT 0, admitted_completed INTEGER NOT NULL DEFAULT 0,
          pre_admission_rejected INTEGER NOT NULL DEFAULT 0,
          unknown_admission_ended INTEGER NOT NULL DEFAULT 0,
          data_through_ms INTEGER,
          PRIMARY KEY(bucket_ms,source,key_id,model,protocol,upstream_id)
        );
        CREATE TABLE IF NOT EXISTS live_attempt_minute (
          bucket_ms INTEGER NOT NULL, source TEXT NOT NULL, key_id TEXT NOT NULL,
          model TEXT NOT NULL, protocol TEXT NOT NULL, upstream_id TEXT NOT NULL, currency TEXT NOT NULL,
          upstream_attempts INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL, cache_read_count INTEGER NOT NULL,
          cache_write_tokens INTEGER NOT NULL, cache_write_count INTEGER NOT NULL,
          missing_usage_attempts INTEGER NOT NULL, unpriced_attempts INTEGER NOT NULL,
          cost_micros INTEGER NOT NULL,
          PRIMARY KEY(bucket_ms,source,key_id,model,protocol,upstream_id,currency)
        );
        CREATE TABLE IF NOT EXISTS live_first_event_minute (
          bucket_ms INTEGER NOT NULL, source TEXT NOT NULL, key_id TEXT NOT NULL,
          model TEXT NOT NULL, protocol TEXT NOT NULL, upstream_id TEXT NOT NULL,
          histogram TEXT NOT NULL,
          PRIMARY KEY(bucket_ms,source,key_id,model,protocol,upstream_id)
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_missing_time ON attempts(started_at_ms,request_id)
          WHERE usage_json IS NULL OR json_extract(usage_json,'$.inputTotal') IS NULL
            OR json_extract(usage_json,'$.outputTotal') IS NULL;
        INSERT OR IGNORE INTO live_aggregate_state(id,covered_sequence)
          SELECT 1,CASE WHEN EXISTS(SELECT 1 FROM requests) OR EXISTS(SELECT 1 FROM attempts)
            THEN -1 ELSE (SELECT sequence FROM telemetry_write_watermark WHERE id=1) END;
      `);
      // Existing rows predate a durable admission marker. Do not scan/backfill
      // them on proxy startup; historical admission remains explicitly unknown.
      const requestFields = new Set(
        (db.pragma('table_info(requests)') as Array<{ name: string }>).map((row) => row.name),
      );
      const quotaPeriodFields = new Set(
        (db.pragma('table_info(quota_periods)') as Array<{ name: string }>).map((row) => row.name),
      );
      if (!quotaPeriodFields.has('timezone_version_id')) {
        // Existing quota balances and period IDs are deliberately left untouched.
        db.exec('ALTER TABLE quota_periods ADD COLUMN timezone_version_id INTEGER');
      }
      const bucketFields = new Set(
        (db.pragma('table_info(live_request_minute)') as Array<{ name: string }>).map((row) => row.name),
      );
      let admissionSchemaUpgraded = false;
      for (const column of ['admitted', 'admission_known'] as const) {
        if (!requestFields.has(column)) {
          db.exec(`ALTER TABLE requests ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
          admissionSchemaUpgraded = true;
        }
      }
      for (const column of [
        'admitted_ended',
        'admitted_completed',
        'pre_admission_rejected',
        'unknown_admission_ended',
      ] as const) {
        if (!bucketFields.has(column)) {
          db.exec(`ALTER TABLE live_request_minute ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
          admissionSchemaUpgraded = true;
        }
      }
      if (admissionSchemaUpgraded) {
        db.exec('UPDATE live_aggregate_state SET covered_sequence=-1 WHERE id=1');
      }
      // An existing database cannot claim coverage until the newly introduced histogram is rebuilt.
      if (hadTelemetrySchema && !hadFirstEventHistogram)
        db.exec('UPDATE live_aggregate_state SET covered_sequence=-1 WHERE id=1');
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get connection(): Database.Database {
    if (!this.db) throw new Error('telemetry store not initialized');
    return this.db;
  }

  get writeWatermark(): { sequence: number; updatedAtMs: number } {
    return this.connection
      .prepare('SELECT sequence,updated_at_ms AS updatedAtMs FROM telemetry_write_watermark WHERE id=1')
      .get() as { sequence: number; updatedAtMs: number };
  }

  private isLiveTimestamp(startedAtMs: number): boolean {
    const db = this.connection;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_usage_archive_state'").get())
      return true;
    const boundary = db.prepare('SELECT through_ms AS n FROM admin_usage_archive_state WHERE id=1').get() as
      | { n: number }
      | undefined;
    return !boundary || startedAtMs >= boundary.n;
  }

  /** Explicit offline entry: invoke before accepting proxy traffic. Work runs in a separate thread. */
  async rebuildLiveAggregates(options: {
    offline: true;
  }): Promise<{ requests: number; attempts: number; sequence: number }> {
    if (options?.offline !== true) throw new Error('Live aggregate rebuild requires explicit offline mode');
    if (this.migration) throw new Error('Live aggregate rebuild already running');
    const sourceMode = __filename.endsWith('.ts');
    const entry = join(__dirname, '..', 'admin', sourceMode ? 'telemetry-read-worker.ts' : 'telemetry-read-worker.js');
    const worker = new Worker(entry, {
      workerData: { kind: 'rebuildOffline', dbPath: this.dbPath },
      execArgv: sourceMode ? ['--require', 'tsx/cjs'] : [],
    });
    const pending = new Promise<{ requests: number; attempts: number; sequence: number }>((resolve, reject) => {
      let value: { requests: number; attempts: number; sequence: number } | undefined;
      let error: Error | undefined;
      worker.on('message', (message: { kind: string; value?: typeof value; message?: string }) => {
        if (message.kind === 'result') value = message.value;
        else if (message.kind === 'error') error = new Error(message.message ?? 'Live aggregate rebuild failed');
      });
      worker.once('error', (failure) => {
        error = failure;
      });
      worker.once('exit', (code) => {
        if (error) reject(error);
        else if (code !== 0 || !value) reject(new Error(`Live aggregate worker exited with code ${code}`));
        else resolve(value);
      });
    });
    this.migration = pending;
    try {
      return await pending;
    } finally {
      this.migration = undefined;
    }
  }

  /** Worker-only synchronous transaction; never call from a serving main thread. */
  rebuildLiveAggregatesInWorker(): { requests: number; attempts: number; sequence: number } {
    if (isMainThread) throw new Error('Live aggregate rebuild must run in a worker');
    const db = this.connection;
    return db
      .transaction(() => {
        const archive = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_usage_archive_state'")
          .get();
        const through = archive
          ? ((
              db.prepare('SELECT through_ms AS n FROM admin_usage_archive_state WHERE id=1').get() as
                | { n: number }
                | undefined
            )?.n ?? Number.MIN_SAFE_INTEGER)
          : Number.MIN_SAFE_INTEGER;
        if (db.prepare('SELECT 1 FROM requests WHERE started_at_ms<? LIMIT 1').get(through))
          throw new Error('LATE_ARCHIVED_DETAIL: cannot rebuild live aggregates over frozen detail');
        const legacy = Boolean(
          db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_request_metadata'").get(),
        );
        db.prepare('UPDATE live_aggregate_state SET covered_sequence=-1 WHERE id=1').run();
        db.prepare('DELETE FROM live_request_minute').run();
        db.prepare('DELETE FROM live_attempt_minute').run();
        db.prepare('DELETE FROM live_first_event_minute').run();
        const requestSql = `SELECT * FROM requests r WHERE r.id>? AND r.started_at_ms>=?${legacy ? ' AND NOT EXISTS (SELECT 1 FROM legacy_request_metadata m WHERE m.request_id=r.id)' : ''} ORDER BY r.id LIMIT 1000`;
        let requests = 0;
        let lastRequest = '';
        for (;;) {
          const batch = db.prepare(requestSql).all(lastRequest, through) as Row[];
          if (!batch.length) break;
          for (const row of batch) {
            requestDelta(db, row, 1);
            requests++;
          }
          lastRequest = batch[batch.length - 1].id;
        }
        const attemptSql = `SELECT a.*,r.source,r.proxy_key_id,r.request_model,r.client_protocol FROM attempts a
        JOIN requests r ON r.id=a.request_id WHERE a.id>? AND a.started_at_ms>=?${legacy ? ' AND NOT EXISTS (SELECT 1 FROM legacy_request_metadata m WHERE m.request_id=r.id)' : ''} ORDER BY a.id LIMIT 1000`;
        let attempts = 0;
        let lastAttempt = '';
        for (;;) {
          const batch = db.prepare(attemptSql).all(lastAttempt, through) as Row[];
          if (!batch.length) break;
          for (const row of batch) {
            attemptDelta(db, row, row, 1);
            attempts++;
          }
          lastAttempt = batch[batch.length - 1].id;
        }
        const sequence = this.writeWatermark.sequence;
        db.prepare('UPDATE live_aggregate_state SET covered_sequence=? WHERE id=1').run(sequence);
        return { requests, attempts, sequence };
      })
      .immediate();
  }

  private upsertRequestSync(r: RequestRecord): void {
    const db = this.connection;
    const liveTimestamp = this.isLiveTimestamp(r.startedAtMs);
    const beforeSequence = this.writeWatermark.sequence;
    const covered = (
      db.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as { n: number }
    ).n;
    const before = db.prepare('SELECT * FROM requests WHERE id=?').get(r.id) as Row | undefined;
    const result = db
      .prepare(`INSERT INTO requests (${requestColumns}) VALUES (${Array(18).fill('?').join(',')})
      ON CONFLICT(id) DO UPDATE SET
      state=excluded.state, final_http_status=excluded.final_http_status,
      ended_at_ms=excluded.ended_at_ms, duration_ms=excluded.duration_ms,
      first_byte_ms=excluded.first_byte_ms, first_event_ms=excluded.first_event_ms,
      first_text_ms=excluded.first_text_ms, final_upstream_id=excluded.final_upstream_id,
      admitted=MAX(requests.admitted,excluded.admitted),
      admission_known=MAX(requests.admission_known,excluded.admission_known)
      WHERE requests.state NOT IN ('completed','failed','cancelled','interrupted','rejected')`)
      .run(
        r.id,
        r.proxyKeyId,
        r.source,
        r.clientProtocol,
        r.requestModel,
        r.routeId,
        r.configRevision,
        r.state,
        r.finalHttpStatus,
        r.startedAtMs,
        r.endedAtMs,
        r.durationMs,
        r.firstByteMs,
        r.firstEventMs,
        r.firstTextMs,
        r.finalUpstreamId,
        Number(r.state === 'admitted'),
        Number(['received', 'rejected', 'admitted'].includes(r.state)),
      );
    if (result.changes && !liveTimestamp) {
      db.prepare('UPDATE live_aggregate_state SET covered_sequence=-1 WHERE id=1').run();
      return;
    }
    if (!result.changes || covered !== beforeSequence) return;
    // Terminal rows are immutable through this API. An unexpected edit to a row
    // with an end time would require recomputing MAX; invalidate instead.
    if (before?.ended_at_ms !== null && before?.ended_at_ms !== undefined) {
      db.prepare('UPDATE live_aggregate_state SET covered_sequence=-1 WHERE id=1').run();
      return;
    }
    if (before) requestDelta(db, before, -1);
    requestDelta(db, db.prepare('SELECT * FROM requests WHERE id=?').get(r.id) as Row, 1);
    db.prepare('UPDATE live_aggregate_state SET covered_sequence=? WHERE id=1').run(this.writeWatermark.sequence);
  }

  private upsertAttemptSync(a: AttemptRecord): void {
    const db = this.connection;
    const liveTimestamp = this.isLiveTimestamp(a.startedAtMs);
    const beforeSequence = this.writeWatermark.sequence;
    const covered = (
      db.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as { n: number }
    ).n;
    const before = db.prepare('SELECT * FROM attempts WHERE id=?').get(a.id) as Row | undefined;
    const result = db
      .prepare(`INSERT INTO attempts (${attemptColumns}) VALUES (${Array(17).fill('?').join(',')})
      ON CONFLICT(id) DO UPDATE SET outcome=excluded.outcome, status=excluded.status,
      retry_reason=excluded.retry_reason, ended_at_ms=excluded.ended_at_ms,
      usage_json=excluded.usage_json, reported_model=excluded.reported_model,
      pricing_version=excluded.pricing_version, cost_micros=excluded.cost_micros, currency=excluded.currency
      WHERE attempts.outcome='started'`)
      .run(
        a.id,
        a.requestId,
        a.ordinal,
        a.upstreamId,
        a.credentialId,
        a.resolvedModel,
        a.reportedModel,
        a.protocol,
        a.outcome,
        a.status,
        a.retryReason,
        a.startedAtMs,
        a.endedAtMs,
        a.usage ? JSON.stringify(a.usage) : null,
        a.pricingVersion,
        a.costMicros,
        a.currency,
      );
    if (result.changes && !liveTimestamp) {
      db.prepare('UPDATE live_aggregate_state SET covered_sequence=-1 WHERE id=1').run();
      return;
    }
    if (!result.changes || covered !== beforeSequence) return;
    const after = db.prepare('SELECT * FROM attempts WHERE id=?').get(a.id) as Row;
    const parent = db.prepare('SELECT * FROM requests WHERE id=?').get(after.request_id) as Row;
    if (before) attemptDelta(db, before, parent, -1);
    attemptDelta(db, after, parent, 1);
    db.prepare('UPDATE live_aggregate_state SET covered_sequence=? WHERE id=1').run(this.writeWatermark.sequence);
  }

  async upsertRequest(r: RequestRecord): Promise<void> {
    this.connection.transaction(() => this.upsertRequestSync(r))();
  }

  async upsertAttempt(a: AttemptRecord): Promise<void> {
    this.connection.transaction(() => this.upsertAttemptSync(a))();
  }

  async upsertBatch(
    events: Array<{ operation: 'request'; record: RequestRecord } | { operation: 'attempt'; record: AttemptRecord }>,
  ): Promise<void> {
    if (!events.length) return;
    if (events.length > 100) throw new RangeError('telemetry batch exceeds 100 events');
    this.connection
      .transaction(() => {
        for (const event of events) {
          if (event.operation === 'request') this.upsertRequestSync(event.record);
          else this.upsertAttemptSync(event.record);
        }
      })
      .immediate();
  }

  async getRequest(id: string): Promise<{ request: RequestRecord; attempts: AttemptRecord[] } | null> {
    const r = this.connection.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!r) return null;
    const rows = this.connection.prepare('SELECT * FROM attempts WHERE request_id = ? ORDER BY ordinal').all(id);
    return { request: req(r), attempts: rows.map(attempt) };
  }

  async listRequests(filter: RequestFilter = {}): Promise<RequestPage> {
    const where = ['started_at_ms >= ?', 'started_at_ms < ?'];
    const args: Array<string | number> = [filter.fromMs ?? 0, filter.toMs ?? Number.MAX_SAFE_INTEGER];
    for (const [column, value] of [
      ['proxy_key_id', filter.proxyKeyId],
      ['state', filter.state],
      ['source', filter.source],
      ['final_upstream_id', filter.finalUpstreamId],
    ] as const)
      if (value !== undefined) {
        where.push(`${column} = ?`);
        args.push(value);
      }
    if (filter.cursor) {
      where.push('(started_at_ms < ? OR (started_at_ms = ? AND id < ?))');
      args.push(filter.cursor.startedAtMs, filter.cursor.startedAtMs, filter.cursor.id);
    }
    const requestedLimit = filter.limit ?? 50;
    if (!Number.isFinite(requestedLimit)) throw new RangeError('invalid page limit');
    const limit = Math.max(1, Math.min(200, Math.trunc(requestedLimit)));
    const rows = this.connection
      .prepare(`SELECT * FROM requests WHERE ${where.join(' AND ')}
      ORDER BY started_at_ms DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as any[];
    const items = rows.slice(0, limit).map(req);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? { startedAtMs: last.startedAtMs, id: last.id } : null };
  }

  async summary(fromMs: number, toMs: number, source: TrafficSource = 'production'): Promise<UsageSummary> {
    const db = this.connection;
    const hasLegacy = Boolean(
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name='legacy_request_metadata'`)
        .get(),
    );
    const legacyJoin = hasLegacy ? 'LEFT JOIN legacy_request_metadata m ON m.request_id=r.id' : '';
    const native = hasLegacy ? 'm.request_id IS NULL' : '1=1';
    const requests = db
      .prepare(`SELECT
      SUM(CASE WHEN ${native} THEN 1 ELSE 0 END) AS n,
      SUM(CASE WHEN NOT (${native}) THEN 1 ELSE 0 END) AS legacyLogRows,
      SUM(CASE WHEN ${native} AND state='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN ${native} AND state='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN ${native} AND state='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN ${native} AND state='rejected' THEN 1 ELSE 0 END) AS rejected,
      SUM(CASE WHEN ${native} AND state NOT IN ('completed','failed','cancelled','interrupted','rejected')
        THEN 1 ELSE 0 END) AS inProgress,
      MAX(ended_at_ms) AS dataThrough FROM requests r ${legacyJoin}
      WHERE r.started_at_ms >= ? AND r.started_at_ms < ? AND r.source = ?`)
      .get(fromMs, toMs, source) as any;
    const attempts = db
      .prepare(`SELECT usage_json FROM attempts a
      JOIN requests r ON r.id=a.request_id WHERE a.started_at_ms >= ?
      AND a.started_at_ms < ? AND r.source = ?`)
      .all(fromMs, toMs, source) as Array<{ n: number; usage_json: string | null }>;
    // Fetch per attempt: JSON usage is not an additive SQL scalar.
    let inputTokens = 0,
      outputTokens = 0,
      missingUsageAttempts = 0;
    for (const row of attempts) {
      const u = row.usage_json ? (JSON.parse(row.usage_json) as NormalizedUsage) : null;
      if (!u || u.status === 'missing' || u.inputTotal === null || u.outputTotal === null) missingUsageAttempts++;
      inputTokens += u?.inputTotal ?? 0;
      outputTokens += u?.outputTotal ?? 0;
    }
    return {
      logicalRequests: requests.n ?? 0,
      legacyLogRows: requests.legacyLogRows ?? 0,
      upstreamAttempts: attempts.length,
      completed: requests.completed ?? 0,
      failed: requests.failed ?? 0,
      cancelled: requests.cancelled ?? 0,
      rejected: requests.rejected ?? 0,
      inProgress: requests.inProgress ?? 0,
      inputTokens,
      outputTokens,
      missingUsageAttempts,
      observedAt: Date.now(),
      dataThrough: requests.dataThrough,
      partial: missingUsageAttempts > 0 || (requests.inProgress ?? 0) > 0,
      grain: 'detail',
      coverage: 'full',
    };
  }

  async close(): Promise<void> {
    if (this.migration) await this.migration.catch(() => undefined);
    this.db?.close();
    this.db = undefined;
  }
}
