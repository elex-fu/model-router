import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import { FIRST_EVENT_HISTOGRAM_BOUNDS, SQLiteTelemetryStore } from '../storage/telemetry-store.js';

export interface DetailFilters {
  requestWhere: string;
  attemptWhere: string;
  requestArgs: Array<string | number>;
  attemptArgs: Array<string | number>;
  dimensions?: { source: string; keyId?: string; upstreamId?: string; model?: string; protocol?: string };
}
export type ReadTask =
  | { kind: 'overview'; dbPath: string; fromMs: number; toMs: number; selected: string }
  | { kind: 'usageSummary'; dbPath: string; filters: DetailFilters }
  | { kind: 'rebuildOffline'; dbPath: string };
type DetailTask = Exclude<ReadTask, { kind: 'rebuildOffline' }>;

if (!parentPort) throw new Error('Telemetry read worker must run in a worker thread');
const port = parentPort;
let db: Database.Database;
const perfEnabled = process.env.MODEL_ROUTER_PERF === '1';
const perfStages: Record<string, number> = {};
function timed<T>(name: string, fn: () => T): T {
  if (!perfEnabled) return fn();
  const start = performance.now();
  try { return fn(); } finally { perfStages[name] = (perfStages[name] ?? 0) + performance.now() - start; }
}
type Metrics = Record<string, number | null>;
const requestFields = [
  'logicalRequests',
  'completed',
  'failed',
  'cancelled',
  'rejected',
  'inProgress',
  'admittedEnded',
  'admittedCompleted',
  'preAdmissionRejected',
  'unknownAdmissionEnded',
] as const;
const attemptFields = [
  'upstreamAttempts',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheReadCount',
  'cacheWriteTokens',
  'cacheWriteCount',
  'missingUsageAttempts',
  'unpricedAttempts',
] as const;
function merge(rows: Metrics[], fields: readonly string[]): Metrics {
  const result: Metrics = {};
  for (const field of fields) result[field] = rows.reduce((sum, row) => sum + (row[field] ?? 0), 0);
  result.dataThrough = rows.reduce<number | null>(
    (max, row) =>
      row.dataThrough === null || row.dataThrough === undefined
        ? max
        : Math.max(max ?? row.dataThrough, row.dataThrough),
    null,
  );
  return result;
}
function liveWhere(dimensions: NonNullable<DetailFilters['dimensions']>) {
  const clauses: string[] = [];
  const args: string[] = [];
  for (const [field, column] of [
    ['source', 'source'],
    ['keyId', 'key_id'],
    ['upstreamId', 'upstream_id'],
    ['model', 'model'],
    ['protocol', 'protocol'],
  ] as const) {
    if (field === 'source' && dimensions.source === 'all') continue;
    const value = dimensions[field];
    if (value === undefined) continue;
    clauses.push(`${column}=?`);
    args.push(value);
  }
  return { suffix: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', args };
}
function liveRead(task: DetailTask, watermark: { sequence: number }, hasLegacyRows: boolean) {
  if (hasLegacyRows) return null;
  const state = timed('liveStateSqlMs', () => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_aggregate_state'").get());
  if (!state) return null;
  const covered = (
    db.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as { n: number }
  ).n;
  if (covered !== watermark.sequence) return null;
  const from = task.kind === 'overview' ? task.fromMs : Number(task.filters.requestArgs[0]);
  const to = task.kind === 'overview' ? task.toMs : Number(task.filters.requestArgs[1]);
  const fullStart = Math.ceil(from / 60_000) * 60_000;
  const fullEnd = Math.floor(to / 60_000) * 60_000;
  // For tiny windows an indexed detail read is cheaper and retains exact P95.
  if (fullEnd - fullStart < 5 * 60_000) return null;
  const dimensions = task.kind === 'overview' ? { source: task.selected } : task.filters.dimensions;
  if (!dimensions) return null;
  const requestFilter = liveWhere(dimensions);
  const attemptFilter = liveWhere(dimensions);
  const requestBucket = timed('liveRequestAggregateSqlMs', () => db
    .prepare(`SELECT SUM(logical_requests) AS logicalRequests,SUM(completed) AS completed,
    SUM(failed) AS failed,SUM(cancelled) AS cancelled,SUM(rejected) AS rejected,
    SUM(in_progress) AS inProgress,
    SUM(admitted_ended) AS admittedEnded,SUM(admitted_completed) AS admittedCompleted,
    SUM(pre_admission_rejected) AS preAdmissionRejected,
    SUM(unknown_admission_ended) AS unknownAdmissionEnded,
    MAX(data_through_ms) AS dataThrough
    FROM live_request_minute WHERE bucket_ms>=? AND bucket_ms<?${requestFilter.suffix}`)
    .get(fullStart, fullEnd, ...requestFilter.args) as Metrics);
  const attemptBucket = timed('liveAttemptAggregateSqlMs', () => db
    .prepare(`SELECT SUM(upstream_attempts) AS upstreamAttempts,
    SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,
    SUM(cache_read_tokens) AS cacheReadTokens,SUM(cache_read_count) AS cacheReadCount,
    SUM(cache_write_tokens) AS cacheWriteTokens,SUM(cache_write_count) AS cacheWriteCount,
    SUM(missing_usage_attempts) AS missingUsageAttempts,SUM(unpriced_attempts) AS unpricedAttempts
    FROM live_attempt_minute WHERE bucket_ms>=? AND bucket_ms<?${attemptFilter.suffix}`)
    .get(fullStart, fullEnd, ...attemptFilter.args) as Metrics);
  const intervals: Array<[number, number]> = [];
  if (from < fullStart) intervals.push([from, fullStart]);
  if (fullEnd < to) intervals.push([fullEnd, to]);
  const filters =
    task.kind === 'usageSummary'
      ? task.filters
      : {
          requestWhere: `r.started_at_ms>=? AND r.started_at_ms<?${task.selected === 'all' ? '' : ' AND r.source=?'}`,
          attemptWhere: `a.started_at_ms>=? AND a.started_at_ms<?${task.selected === 'all' ? '' : ' AND r.source=?'}`,
          requestArgs: task.selected === 'all' ? [from, to] : [from, to, task.selected],
          attemptArgs: task.selected === 'all' ? [from, to] : [from, to, task.selected],
        };
  const requestRows: Metrics[] = [requestBucket];
  const attemptRows: Metrics[] = [attemptBucket];
  const costs = new Map<string, number>();
  const addCosts = (rows: Array<{ currency: string; micros: number }>) => {
    for (const row of rows) costs.set(row.currency, (costs.get(row.currency) ?? 0) + row.micros);
  };
  if (task.kind === 'usageSummary') {
    timed('liveCostAggregateSqlMs', () => addCosts(
      db
        .prepare(`SELECT currency,SUM(cost_micros) AS micros FROM live_attempt_minute
    WHERE bucket_ms>=? AND bucket_ms<?${attemptFilter.suffix} AND currency<>''
    GROUP BY currency`)
        .all(fullStart, fullEnd, ...attemptFilter.args) as Array<{ currency: string; micros: number }>,
    ));
  }
  for (const [start, end] of intervals) {
    const ra = [start, end, ...filters.requestArgs.slice(2)];
    const aa = [start, end, ...filters.attemptArgs.slice(2)];
    requestRows.push(
      timed('detailRequestSqlMs', () => db
        .prepare(`SELECT COUNT(*) AS logicalRequests,
      SUM(r.state='completed') AS completed,SUM(r.state='failed') AS failed,
      SUM(r.state='cancelled') AS cancelled,SUM(r.state='rejected') AS rejected,
      SUM(r.state NOT IN ('completed','failed','cancelled','interrupted','rejected')) AS inProgress,
      SUM(r.source='production' AND r.admission_known=1 AND r.admitted=1 AND r.ended_at_ms IS NOT NULL) AS admittedEnded,
      SUM(r.source='production' AND r.admission_known=1 AND r.admitted=1 AND r.state='completed' AND r.ended_at_ms IS NOT NULL) AS admittedCompleted,
      SUM(r.source='production' AND r.admission_known=1 AND r.admitted=0 AND r.state='rejected' AND r.ended_at_ms IS NOT NULL) AS preAdmissionRejected,
      SUM(r.source='production' AND r.admission_known=0 AND r.ended_at_ms IS NOT NULL) AS unknownAdmissionEnded,
      MAX(r.ended_at_ms) AS dataThrough FROM requests r WHERE ${filters.requestWhere}`)
        .get(...ra) as Metrics),
    );
    attemptRows.push(
      timed('detailAttemptSqlMs', () => db
        .prepare(`SELECT COUNT(*) AS upstreamAttempts,
      COALESCE(SUM(json_extract(a.usage_json,'$.inputTotal')),0) AS inputTokens,
      COALESCE(SUM(json_extract(a.usage_json,'$.outputTotal')),0) AS outputTokens,
      COALESCE(SUM(json_extract(a.usage_json,'$.cacheRead')),0) AS cacheReadTokens,
      COUNT(json_extract(a.usage_json,'$.cacheRead')) AS cacheReadCount,
      COALESCE(SUM(json_extract(a.usage_json,'$.cacheWrite')),0) AS cacheWriteTokens,
      COUNT(json_extract(a.usage_json,'$.cacheWrite')) AS cacheWriteCount,
      SUM(a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
        OR json_extract(a.usage_json,'$.outputTotal') IS NULL) AS missingUsageAttempts,
      SUM(a.cost_micros IS NULL) AS unpricedAttempts
      FROM attempts a JOIN requests r ON r.id=a.request_id WHERE ${filters.attemptWhere}`)
        .get(...aa) as Metrics),
    );
    if (task.kind === 'usageSummary') {
      timed('detailCostSqlMs', () => addCosts(
        db
          .prepare(`SELECT a.currency,SUM(a.cost_micros) AS micros FROM attempts a
      JOIN requests r ON r.id=a.request_id WHERE ${filters.attemptWhere}
      AND a.currency IS NOT NULL AND a.cost_micros IS NOT NULL GROUP BY a.currency`)
          .all(...aa) as Array<{ currency: string; micros: number }>,
      ));
    }
  }
  const requests = merge(requestRows, requestFields);
  requests.legacyLogRows = 0;
  const attempts = merge(attemptRows, attemptFields);
  attempts.cacheReadTokens = attempts.cacheReadCount ? attempts.cacheReadTokens : null;
  attempts.cacheWriteTokens = attempts.cacheWriteCount ? attempts.cacheWriteTokens : null;
  if (task.kind === 'usageSummary') {
    // Exact distinct retry request IDs; partial index limits this to missing-usage attempts.
    const { attemptWhere, attemptArgs } = task.filters;
    attempts.missingUsageRequests = timed('missingUsageDistinctSqlMs', () => (
      db
        .prepare(`SELECT COUNT(DISTINCT a.request_id) AS n FROM attempts a
      JOIN requests r ON r.id=a.request_id WHERE ${attemptWhere} AND
      (a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
       OR json_extract(a.usage_json,'$.outputTotal') IS NULL)`)
        .get(...attemptArgs) as { n: number }
    ).n);
  }
  return {
    requests,
    attempts,
    costs: [...costs].map(([currency, micros]) => ({ currency, micros })),
    coverageMode: 'live-minute+detail-tails',
  };
}

function liveFirstEventP95(
  from: number,
  to: number,
  selected: string,
): { value: number | null; status: 'approximate' | 'unsupported_live_preaggregate' } {
  const fullStart = Math.ceil(from / 60_000) * 60_000;
  const fullEnd = Math.floor(to / 60_000) * 60_000;
  const bins = Array<number>(FIRST_EVENT_HISTOGRAM_BOUNDS.length + 1).fill(0);
  const rows = db
    .prepare(
      `SELECT histogram FROM live_first_event_minute WHERE bucket_ms>=? AND bucket_ms<?${selected === 'all' ? '' : ' AND source=?'}`,
    )
    .all(...(selected === 'all' ? [fullStart, fullEnd] : [fullStart, fullEnd, selected])) as Array<{
    histogram: string;
  }>;
  for (const row of rows) {
    const counts = JSON.parse(row.histogram) as number[];
    for (let index = 0; index < bins.length; index++) bins[index] += counts[index] ?? 0;
  }
  const exact: number[] = [];
  const tailBeforeFull: number[] = [];
  const tailAfterFull: number[] = [];
  const intervals: Array<[number, number]> = [];
  if (from < fullStart) intervals.push([from, fullStart]);
  if (fullEnd < to) intervals.push([fullEnd, to]);
  const whereSource = selected === 'all' ? '' : ' AND r.source=?';
  for (const [start, end] of intervals) {
    const args = selected === 'all' ? [start, end] : [start, end, selected];
    const values = (
      db
        .prepare(`SELECT COALESCE(r.first_text_ms,r.first_event_ms) AS ms FROM requests r
      WHERE r.started_at_ms>=? AND r.started_at_ms<? AND COALESCE(r.first_text_ms,r.first_event_ms) IS NOT NULL${whereSource}
      ORDER BY ms`)
        .all(...args) as Array<{ ms: number }>
    ).map((row) => row.ms);
    exact.push(...values);
    for (const value of values) (value < fullStart ? tailBeforeFull : tailAfterFull).push(value);
  }
  const count = bins.reduce((sum, value) => sum + value, 0) + exact.length;
  if (count === 0) return { value: null, status: 'approximate' };
  const rank = Math.ceil(count * 0.95) - 1;
  tailBeforeFull.sort((a, b) => a - b);
  tailAfterFull.sort((a, b) => a - b);
  let approximateValue: number | undefined;
  if (rank < tailBeforeFull.length) approximateValue = tailBeforeFull[rank];
  else {
    let seen = tailBeforeFull.length;
    for (let index = 0; index < bins.length; index++) {
      seen += bins[index];
      if (seen > rank) {
        approximateValue = FIRST_EVENT_HISTOGRAM_BOUNDS[index] ?? 0;
        break;
      }
    }
    if (approximateValue === undefined)
      approximateValue = tailAfterFull[rank - tailBeforeFull.length - bins.reduce((sum, value) => sum + value, 0)];
  }
  return { value: approximateValue ?? null, status: 'approximate' };
}
function executeDetail(task: DetailTask) {
  db = timed('sqliteOpenMs', () => new Database(task.dbPath, { readonly: true, fileMustExist: true }));
  try {
    timed('sqlitePragmaMs', () => db.pragma('busy_timeout = 5000'));
    return timed('detailQueriesSqlMs', () => db.transaction(() => {
      // First read pins one WAL snapshot for every number and its native write watermark.
      const watermark = timed('watermarkSqlMs', () => db
        .prepare('SELECT sequence,updated_at_ms AS updatedAtMs FROM telemetry_write_watermark WHERE id=1')
        .get() as { sequence: number; updatedAtMs: number });
      const snapshotStartedAtMs = Date.now();
      const hasLegacy = timed('legacySchemaSqlMs', () => Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_request_metadata'").get(),
      ));
      const legacyMetadataCount = hasLegacy
        ? timed('legacyMetadataSqlMs', () => (db.prepare('SELECT EXISTS(SELECT 1 FROM legacy_request_metadata) AS n').get() as { n: number }).n)
        : 0;
      const legacy = hasLegacy ? 'EXISTS (SELECT 1 FROM legacy_request_metadata m WHERE m.request_id=r.id)' : '0';
      const live = timed('liveAggregateSqlMs', () => liveRead(task, watermark, legacyMetadataCount > 0));
      if (task.kind === 'overview') {
        const sourceWhere = task.selected === 'all' ? '' : ' AND r.source=?';
        const args = task.selected === 'all' ? [task.fromMs, task.toMs] : [task.fromMs, task.toMs, task.selected];
        if (live) {
          const recentErrors = timed('recentErrorsSqlMs', () => db
            .prepare(`SELECT r.id AS requestId,r.state,r.final_http_status AS status
          FROM requests r WHERE r.state IN ('failed','rejected') AND r.started_at_ms>=? AND r.started_at_ms<?${sourceWhere}
          ORDER BY r.started_at_ms DESC LIMIT 5`)
            .all(...args) as Array<{ requestId: string; state: string; status: number | null }>);
          return {
            kind: 'overview', watermark, snapshotStartedAtMs, snapshotCompletedAtMs: Date.now(),
            legacyMetadataCount, legacyWritesTracked: !hasLegacy, requests: live.requests, attempts: live.attempts,
            ...(() => { const p95 = timed('firstEventP95SqlMs', () => liveFirstEventP95(task.fromMs, task.toMs, task.selected));
              return { firstTokenP95Ms: p95.value, firstTokenP95Status: p95.status }; })(),
            recentErrors, coverageMode: live.coverageMode,
          };
        }
        const requests = timed('overviewRequestSqlMs', () => db
          .prepare(`SELECT SUM(NOT (${legacy})) AS logicalRequests,
        SUM(${legacy}) AS legacyLogRows,
        SUM(NOT (${legacy}) AND r.state='completed') AS completed,
        SUM(NOT (${legacy}) AND r.state='failed') AS failed,
        SUM(NOT (${legacy}) AND r.state='cancelled') AS cancelled,
        SUM(NOT (${legacy}) AND r.state='rejected') AS rejected,
        SUM(NOT (${legacy}) AND r.state NOT IN ('completed','failed','cancelled','interrupted','rejected')) AS inProgress,
        SUM(NOT (${legacy}) AND r.source='production' AND r.admission_known=1 AND r.admitted=1 AND r.ended_at_ms IS NOT NULL) AS admittedEnded,
        SUM(NOT (${legacy}) AND r.source='production' AND r.admission_known=1 AND r.admitted=1 AND r.state='completed' AND r.ended_at_ms IS NOT NULL) AS admittedCompleted,
        SUM(NOT (${legacy}) AND r.source='production' AND r.admission_known=1 AND r.admitted=0 AND r.state='rejected' AND r.ended_at_ms IS NOT NULL) AS preAdmissionRejected,
        SUM(NOT (${legacy}) AND r.source='production' AND r.admission_known=0 AND r.ended_at_ms IS NOT NULL) AS unknownAdmissionEnded,
        MAX(CASE WHEN NOT (${legacy}) THEN r.ended_at_ms END) AS dataThrough
        FROM requests r WHERE r.started_at_ms>=? AND r.started_at_ms<?${sourceWhere}`)
          .get(...args) as Record<string, number | null>);
        const attempts = timed('overviewAttemptSqlMs', () => db
          .prepare(`SELECT COUNT(*) AS upstreamAttempts,
        COALESCE(SUM(json_extract(a.usage_json,'$.inputTotal')),0) AS inputTokens,
        COALESCE(SUM(json_extract(a.usage_json,'$.outputTotal')),0) AS outputTokens,
        SUM(CASE WHEN a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
          OR json_extract(a.usage_json,'$.outputTotal') IS NULL THEN 1 ELSE 0 END) AS missingUsageAttempts
        FROM attempts a JOIN requests r ON r.id=a.request_id WHERE a.started_at_ms>=?
        AND a.started_at_ms<?${sourceWhere} AND NOT (${legacy})`)
          .get(...args) as Record<string, number | null>);
        const firstEventCount = timed('overviewFirstEventCountSqlMs', () => db
          .prepare(`SELECT COUNT(*) AS n FROM requests r WHERE r.started_at_ms>=? AND r.started_at_ms<?
        AND COALESCE(r.first_text_ms,r.first_event_ms) IS NOT NULL${sourceWhere} AND NOT (${legacy})`)
          .get(...args) as { n: number });
        const firstTokenP95Ms = firstEventCount.n
          ? timed('overviewFirstEventP95SqlMs', () => (db.prepare(`SELECT COALESCE(r.first_text_ms,r.first_event_ms) AS ms FROM requests r
          WHERE r.started_at_ms>=? AND r.started_at_ms<?
          AND COALESCE(r.first_text_ms,r.first_event_ms) IS NOT NULL${sourceWhere} AND NOT (${legacy})
          ORDER BY ms LIMIT 1 OFFSET ?`).get(...args, Math.ceil(firstEventCount.n * 0.95) - 1) as { ms: number }).ms)
          : null;
        const recentErrors = timed('recentErrorsSqlMs', () => db
          .prepare(`SELECT r.id AS requestId,r.state,r.final_http_status AS status
        FROM requests r WHERE r.state IN ('failed','rejected') AND r.started_at_ms>=? AND r.started_at_ms<?${sourceWhere}
        AND NOT (${legacy}) ORDER BY r.started_at_ms DESC LIMIT 5`)
          .all(...args) as Array<{ requestId: string; state: string; status: number | null }>);
        return { kind: 'overview', watermark, snapshotStartedAtMs, snapshotCompletedAtMs: Date.now(),
          legacyMetadataCount, legacyWritesTracked: !hasLegacy, requests, attempts, firstTokenP95Ms,
          firstTokenP95Status: 'exact', recentErrors };
      }
      const { requestWhere, attemptWhere, requestArgs, attemptArgs } = task.filters;
      if (live) return { kind: 'usageSummary', watermark, snapshotStartedAtMs, snapshotCompletedAtMs: Date.now(),
        legacyMetadataCount, legacyWritesTracked: !hasLegacy, requests: live.requests, attempts: live.attempts,
        costs: live.costs, coverageMode: live.coverageMode };
      const requests = timed('summaryRequestSqlMs', () => db.prepare(`SELECT SUM(NOT (${legacy})) AS logicalRequests,
      SUM(${legacy}) AS legacyLogRows,
      SUM(NOT (${legacy}) AND r.state='completed') AS completed,
      SUM(NOT (${legacy}) AND r.state='failed') AS failed,
      SUM(NOT (${legacy}) AND r.state='cancelled') AS cancelled,
      SUM(NOT (${legacy}) AND r.state='rejected') AS rejected,
      SUM(NOT (${legacy}) AND r.state NOT IN ('completed','failed','cancelled','interrupted','rejected')) AS inProgress,
      MAX(CASE WHEN NOT (${legacy}) THEN r.ended_at_ms END) AS dataThrough
      FROM requests r WHERE ${requestWhere}`).get(...requestArgs) as Record<string, number | null>);
      const attempts = timed('summaryAttemptSqlMs', () => db.prepare(`SELECT COUNT(*) AS upstreamAttempts,
      COALESCE(SUM(json_extract(a.usage_json,'$.inputTotal')),0) AS inputTokens,
      COALESCE(SUM(json_extract(a.usage_json,'$.outputTotal')),0) AS outputTokens,
      SUM(CASE WHEN a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
        OR json_extract(a.usage_json,'$.outputTotal') IS NULL THEN 1 ELSE 0 END) AS missingUsageAttempts,
      SUM(json_extract(a.usage_json,'$.cacheRead')) AS cacheReadTokens,
      SUM(json_extract(a.usage_json,'$.cacheWrite')) AS cacheWriteTokens,
      SUM(CASE WHEN a.cost_micros IS NULL THEN 1 ELSE 0 END) AS unpricedAttempts,
      COUNT(DISTINCT CASE WHEN a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
        OR json_extract(a.usage_json,'$.outputTotal') IS NULL THEN a.request_id END) AS missingUsageRequests
      FROM attempts a JOIN requests r ON r.id=a.request_id WHERE ${attemptWhere} AND NOT (${legacy})`)
        .get(...attemptArgs) as Record<string, number | null>);
      const costs = timed('summaryCostSqlMs', () => db.prepare(`SELECT a.currency, SUM(a.cost_micros) AS micros FROM attempts a
      JOIN requests r ON r.id=a.request_id WHERE ${attemptWhere} AND a.currency IS NOT NULL
      AND a.cost_micros IS NOT NULL AND NOT (${legacy}) GROUP BY a.currency`).all(...attemptArgs) as Array<{ currency: string; micros: number }>);
      return { kind: 'usageSummary', watermark, snapshotStartedAtMs, snapshotCompletedAtMs: Date.now(),
        legacyMetadataCount, legacyWritesTracked: !hasLegacy, requests, attempts, costs };
    })());
  } finally {
    timed('sqliteCloseMs', () => db.close());
  }
}

const task = workerData as ReadTask;
const workerStart = performance.now();
void (async () => {
  try {
    let value: unknown;
    if (task.kind === 'rebuildOffline') {
      const store = new SQLiteTelemetryStore(task.dbPath);
      await store.init();
      try {
        value = await store.rebuildLiveAggregatesInWorker();
      } finally {
        await store.close();
      }
    } else {
      value = executeDetail(task);
    }
    if (perfEnabled && task.kind !== 'rebuildOffline') {
      port.postMessage({ kind: 'perf', value: { workerTotalMs: performance.now() - workerStart, endpoint: task.kind, stages: perfStages,
        sequence: (value as { watermark?: { sequence: number } }).watermark?.sequence ?? null } });
    }
    port.postMessage({ kind: 'result', value });
  } catch (error) {
    port.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Telemetry read failed' });
  }
})();
