import type Database from 'better-sqlite3';
import { ControlError } from '../control/service.js';

export const UTC_DAY_MS = 86_400_000;
const dayStart = (ms: number) => Math.floor(ms / UTC_DAY_MS) * UTC_DAY_MS;
const MAX_DAYS = 400;

export interface DailyRollup {
  day: number;
  source: string;
  logicalRequests: number;
  legacyLogRows: number;
  completed: number;
  failed: number;
  cancelled: number;
  rejected: number;
  inProgress: number;
  upstreamAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  missingUsageAttempts: number;
  unpricedAttempts: number;
  costByCurrencyMicros: Record<string, number>;
  dataThrough: number | null;
  frozen: boolean;
  verified: boolean;
}

export type MutableRollup = Omit<DailyRollup, 'frozen' | 'verified'>;
export interface RollupRebuildPlan {
  rows: MutableRollup[];
}
interface RequestAggregate {
  day: number;
  source: string;
  logicalRequests: number;
  legacyLogRows: number;
  completed: number;
  failed: number;
  cancelled: number;
  rejected: number;
  inProgress: number;
  dataThrough: number | null;
}
interface AttemptAggregate {
  day: number;
  source: string;
  currency: string | null;
  upstreamAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  missingUsageAttempts: number;
  unpricedAttempts: number;
  costMicros: number;
}
interface ArchiveState {
  fromMs: number;
  throughMs: number;
}

function empty(day: number, source: string): MutableRollup {
  return {
    day,
    source,
    logicalRequests: 0,
    legacyLogRows: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    rejected: 0,
    inProgress: 0,
    upstreamAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingUsageAttempts: 0,
    unpricedAttempts: 0,
    costByCurrencyMicros: {},
    dataThrough: null,
  };
}

/** UTC-day rollups are materialized from detail and frozen only by an atomic purge. */
export class AdminRollups {
  constructor(private readonly db: Database.Database) {
    this.ensure();
  }

  private ensure(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS admin_usage_daily_v2 (
      day_start_ms INTEGER NOT NULL, source TEXT NOT NULL, logical_requests INTEGER NOT NULL,
      upstream_attempts INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cost_by_currency_json TEXT NOT NULL, unpriced_attempts INTEGER NOT NULL,
      rebuilt_at_ms INTEGER NOT NULL, PRIMARY KEY(day_start_ms,source)
    );
    CREATE TABLE IF NOT EXISTS admin_usage_archive_state (
      id INTEGER PRIMARY KEY CHECK(id=1), from_ms INTEGER NOT NULL, through_ms INTEGER NOT NULL
    )`);
    const columns = new Set(
      (this.db.pragma('table_info(admin_usage_daily_v2)') as Array<{ name: string }>).map((r) => r.name),
    );
    for (const [name, definition] of [
      ['completed', 'INTEGER NOT NULL DEFAULT 0'],
      ['failed', 'INTEGER NOT NULL DEFAULT 0'],
      ['cancelled', 'INTEGER NOT NULL DEFAULT 0'],
      ['rejected', 'INTEGER NOT NULL DEFAULT 0'],
      ['in_progress', 'INTEGER NOT NULL DEFAULT 0'],
      ['cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0'],
      ['cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0'],
      ['missing_usage_attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['data_through_ms', 'INTEGER'],
      ['frozen', 'INTEGER NOT NULL DEFAULT 0'],
      ['verified', 'INTEGER NOT NULL DEFAULT 0'],
      ['legacy_log_rows', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const)
      if (!columns.has(name)) this.db.exec(`ALTER TABLE admin_usage_daily_v2 ADD COLUMN ${name} ${definition}`);
    // Legacy rollups with no remaining detail cannot be rebuilt; preserve them but do not claim verified coverage.
    this.db.exec(`UPDATE admin_usage_daily_v2 SET frozen=1 WHERE frozen=0 AND
      NOT EXISTS (SELECT 1 FROM requests r WHERE r.source=admin_usage_daily_v2.source
        AND r.started_at_ms>=admin_usage_daily_v2.day_start_ms
        AND r.started_at_ms<admin_usage_daily_v2.day_start_ms+86400000)`);
  }

  private state(): ArchiveState | null {
    return (
      (this.db
        .prepare('SELECT from_ms AS fromMs,through_ms AS throughMs FROM admin_usage_archive_state WHERE id=1')
        .get() as ArchiveState | undefined) ?? null
    );
  }

  /** Returns archive-only coverage. Mixed or sub-day requests must be rejected by callers. */
  classify(fromMs: number, toMs: number): 'detail' | 'archived' {
    const state = this.state();
    if (!state || fromMs >= state.throughMs) return 'detail';
    if (fromMs < state.fromMs || toMs > state.throughMs)
      throw new ControlError(422, 'ARCHIVE_RANGE_UNAVAILABLE', 'Range crosses or precedes archived detail boundary');
    if (dayStart(fromMs) !== fromMs || dayStart(toMs) !== toMs)
      throw new ControlError(422, 'ARCHIVE_DAY_ALIGNMENT_REQUIRED', 'Archived queries require complete UTC days');
    return 'archived';
  }

  read(fromMs: number, toMs: number, source: string | 'all'): DailyRollup[] {
    const where = source === 'all' ? '' : ' AND source=?';
    const args = source === 'all' ? [fromMs, toMs] : [fromMs, toMs, source];
    const rows = this.db
      .prepare(`SELECT * FROM admin_usage_daily_v2 WHERE day_start_ms>=?
      AND day_start_ms<? AND verified=1${where} ORDER BY day_start_ms,source`)
      .all(...args) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      day: Number(row.day_start_ms),
      source: String(row.source),
      logicalRequests: Number(row.logical_requests),
      completed: Number(row.completed),
      legacyLogRows: Number(row.legacy_log_rows),
      failed: Number(row.failed),
      cancelled: Number(row.cancelled),
      rejected: Number(row.rejected),
      inProgress: Number(row.in_progress),
      upstreamAttempts: Number(row.upstream_attempts),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
      missingUsageAttempts: Number(row.missing_usage_attempts),
      unpricedAttempts: Number(row.unpriced_attempts),
      costByCurrencyMicros: JSON.parse(String(row.cost_by_currency_json)) as Record<string, number>,
      dataThrough: row.data_through_ms === null ? null : Number(row.data_through_ms),
      frozen: Boolean(row.frozen),
      verified: Boolean(row.verified),
    }));
  }

  /** Refresh only days represented by raw detail; never delete a frozen or orphaned historical row. */
  rebuild(signal?: AbortSignal) {
    return this.applyRebuildPlan(AdminRollups.computeRebuildPlan(this.db, signal), signal);
  }

  /** Heavy read phase. Safe to run on a separate, read-only SQLite connection. */
  static computeRebuildPlan(db: Database.Database, signal?: AbortSignal): RollupRebuildPlan {
    if (signal?.aborted) throw new Error('Aggregate cancelled');
    const lateDetail = db
      .prepare(`SELECT 1 FROM admin_usage_daily_v2 d JOIN requests r
      ON r.source=d.source AND r.started_at_ms>=d.day_start_ms
      AND r.started_at_ms<d.day_start_ms+86400000 WHERE d.frozen=1 LIMIT 1`)
      .get();
    if (lateDetail) throw new ControlError(409, 'LATE_ARCHIVED_DETAIL', 'Raw detail exists in a frozen rollup day');
    const earliest = db.prepare('SELECT MIN(started_at_ms) AS ms FROM requests').get() as { ms: number | null };
    if (earliest.ms === null) return { rows: [] };
    const firstDay = dayStart(earliest.ms);
    if (dayStart(Date.now()) - firstDay > MAX_DAYS * UTC_DAY_MS)
      throw new ControlError(413, 'AGGREGATE_RANGE_TOO_LARGE', 'Raw telemetry exceeds 400 UTC days');
    const hasLegacy = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_request_metadata'").get(),
    );
    const legacy = hasLegacy ? 'EXISTS (SELECT 1 FROM legacy_request_metadata m WHERE m.request_id=r.id)' : '0';
    const requestRows = db
      .prepare(`SELECT CAST(r.started_at_ms/86400000 AS INTEGER)*86400000 AS day,
      r.source,SUM(NOT (${legacy})) AS logicalRequests,SUM(${legacy}) AS legacyLogRows,
      SUM(NOT (${legacy}) AND r.state='completed') AS completed,
      SUM(NOT (${legacy}) AND r.state='failed') AS failed,
      SUM(NOT (${legacy}) AND r.state='cancelled') AS cancelled,
      SUM(NOT (${legacy}) AND r.state='rejected') AS rejected,
      SUM(NOT (${legacy}) AND r.state NOT IN ('completed','failed','cancelled','interrupted','rejected')) AS inProgress,
      MAX(CASE WHEN NOT (${legacy}) THEN r.ended_at_ms END) AS dataThrough
      FROM requests r GROUP BY day,r.source`)
      .all() as RequestAggregate[];
    if (signal?.aborted) throw new Error('Aggregate cancelled');
    const attemptRows = db
      .prepare(`SELECT CAST(a.started_at_ms/86400000 AS INTEGER)*86400000 AS day,
      r.source,a.currency,COUNT(*) AS upstreamAttempts,
      COALESCE(SUM(json_extract(a.usage_json,'$.inputTotal')),0) AS inputTokens,
      COALESCE(SUM(json_extract(a.usage_json,'$.outputTotal')),0) AS outputTokens,
      COALESCE(SUM(json_extract(a.usage_json,'$.cacheRead')),0) AS cacheReadTokens,
      COALESCE(SUM(json_extract(a.usage_json,'$.cacheWrite')),0) AS cacheWriteTokens,
      SUM(CASE WHEN a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
        OR json_extract(a.usage_json,'$.outputTotal') IS NULL THEN 1 ELSE 0 END) AS missingUsageAttempts,
      SUM(CASE WHEN a.cost_micros IS NULL OR a.currency IS NULL THEN 1 ELSE 0 END) AS unpricedAttempts,
      COALESCE(SUM(a.cost_micros),0) AS costMicros
      FROM attempts a JOIN requests r ON r.id=a.request_id WHERE NOT (${legacy})
      GROUP BY day,r.source,a.currency`)
      .all() as AttemptAggregate[];
    if (signal?.aborted) throw new Error('Aggregate cancelled');
    const rows = new Map<string, MutableRollup>();
    for (const r of requestRows)
      rows.set(`${r.day}:${r.source}`, {
        ...empty(r.day, r.source),
        logicalRequests: r.logicalRequests,
        completed: r.completed,
        failed: r.failed,
        legacyLogRows: r.legacyLogRows,
        cancelled: r.cancelled,
        rejected: r.rejected,
        inProgress: r.inProgress,
        dataThrough: r.dataThrough,
      });
    for (const a of attemptRows) {
      const key = `${a.day}:${a.source}`;
      const row = rows.get(key) ?? empty(a.day, a.source);
      row.upstreamAttempts += a.upstreamAttempts;
      row.inputTokens += a.inputTokens;
      row.outputTokens += a.outputTokens;
      row.cacheReadTokens += a.cacheReadTokens;
      row.cacheWriteTokens += a.cacheWriteTokens;
      row.missingUsageAttempts += a.missingUsageAttempts;
      row.unpricedAttempts += a.unpricedAttempts;
      if (a.currency) row.costByCurrencyMicros[a.currency] = (row.costByCurrencyMicros[a.currency] ?? 0) + a.costMicros;
      rows.set(key, row);
    }
    if (rows.size > (MAX_DAYS + 1) * 3)
      throw new ControlError(413, 'AGGREGATE_TOO_LARGE', 'Aggregate exceeds bounded day/source rows');
    return { rows: [...rows.values()] };
  }

  /** Bounded write phase; never touches frozen or orphaned historical rows. */
  applyRebuildPlan(plan: RollupRebuildPlan, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error('Aggregate cancelled');
    const lateDetail = this.db
      .prepare(`SELECT 1 FROM admin_usage_daily_v2 d JOIN requests r
      ON r.source=d.source AND r.started_at_ms>=d.day_start_ms
      AND r.started_at_ms<d.day_start_ms+86400000 WHERE d.frozen=1 LIMIT 1`)
      .get();
    if (lateDetail) throw new ControlError(409, 'LATE_ARCHIVED_DETAIL', 'Raw detail exists in a frozen rollup day');
    if (plan.rows.length > (MAX_DAYS + 1) * 3)
      throw new ControlError(413, 'AGGREGATE_TOO_LARGE', 'Aggregate exceeds bounded day/source rows');
    if (plan.rows.length === 0) return { rows: 0, refreshed: 0, preserved: this.countFrozen(), grain: 'UTC-day' };
    const upsert = this.db.prepare(`INSERT INTO admin_usage_daily_v2 (
      day_start_ms,source,logical_requests,upstream_attempts,input_tokens,output_tokens,
      cost_by_currency_json,unpriced_attempts,rebuilt_at_ms,completed,failed,cancelled,rejected,
      in_progress,cache_read_tokens,cache_write_tokens,missing_usage_attempts,data_through_ms,
      legacy_log_rows,frozen,verified
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)
    ON CONFLICT(day_start_ms,source) DO UPDATE SET
      logical_requests=excluded.logical_requests,upstream_attempts=excluded.upstream_attempts,
      input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
      cost_by_currency_json=excluded.cost_by_currency_json,unpriced_attempts=excluded.unpriced_attempts,
      rebuilt_at_ms=excluded.rebuilt_at_ms,completed=excluded.completed,failed=excluded.failed,
      cancelled=excluded.cancelled,rejected=excluded.rejected,in_progress=excluded.in_progress,
      cache_read_tokens=excluded.cache_read_tokens,cache_write_tokens=excluded.cache_write_tokens,
      missing_usage_attempts=excluded.missing_usage_attempts,data_through_ms=excluded.data_through_ms
      ,legacy_log_rows=excluded.legacy_log_rows
    WHERE admin_usage_daily_v2.frozen=0`);
    let refreshed = 0;
    this.db.transaction(() => {
      for (const r of plan.rows) {
        if (signal?.aborted) throw new Error('Aggregate cancelled');
        const result = upsert.run(
          r.day,
          r.source,
          r.logicalRequests,
          r.upstreamAttempts,
          r.inputTokens,
          r.outputTokens,
          JSON.stringify(r.costByCurrencyMicros),
          r.unpricedAttempts,
          Date.now(),
          r.completed,
          r.failed,
          r.cancelled,
          r.rejected,
          r.inProgress,
          r.cacheReadTokens,
          r.cacheWriteTokens,
          r.missingUsageAttempts,
          r.dataThrough,
          r.legacyLogRows,
        );
        refreshed += result.changes;
      }
    })();
    return { rows: plan.rows.length, refreshed, preserved: this.countFrozen(), grain: 'UTC-day' };
  }

  /** Archive complete UTC days and purge detail atomically. */
  archiveAndPurge(cutoffMs: number, signal?: AbortSignal) {
    const cutoff = dayStart(cutoffMs);
    return this.db.transaction(() => {
      const liveState = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_aggregate_state'")
        .get()
        ? (this.db.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as { n: number })
            .n
        : null;
      const initialSequence =
        liveState === null
          ? null
          : (this.db.prepare('SELECT sequence AS n FROM telemetry_write_watermark WHERE id=1').get() as { n: number })
              .n;
      const state = this.state();
      const stale = this.db
        .prepare('SELECT 1 FROM requests WHERE started_at_ms<? LIMIT 1')
        .get(state?.throughMs ?? Number.MIN_SAFE_INTEGER);
      if (state && stale)
        throw new ControlError(409, 'LATE_ARCHIVED_DETAIL', 'Late detail exists in a frozen archive day');
      const nonterminal = this.db
        .prepare(`SELECT 1 FROM requests WHERE started_at_ms<?
        AND state NOT IN ('completed','failed','cancelled','interrupted','rejected') LIMIT 1`)
        .get(cutoff);
      if (nonterminal) throw new ControlError(409, 'ACTIVE_OLD_REQUEST', 'Cannot purge nonterminal requests');
      const crossing = this.db
        .prepare(`SELECT 1 FROM attempts a JOIN requests r ON r.id=a.request_id
        WHERE (r.started_at_ms<? AND a.started_at_ms>=?)
          OR (r.started_at_ms>=? AND a.started_at_ms<?) LIMIT 1`)
        .get(cutoff, cutoff, cutoff, cutoff);
      if (crossing) throw new ControlError(409, 'CROSS_DAY_ATTEMPT', 'Cannot purge cross-boundary attempts');
      const earliest = this.db
        .prepare(`SELECT MIN(ms) AS ms FROM (
          SELECT started_at_ms AS ms FROM requests WHERE started_at_ms<?
          UNION ALL SELECT a.started_at_ms AS ms FROM attempts a JOIN requests r ON r.id=a.request_id
          WHERE r.started_at_ms<?)`)
        .get(cutoff, cutoff) as { ms: number | null };
      const rebuilt = this.rebuild(signal);
      if (signal?.aborted) throw new Error('Purge cancelled');
      const fromMs = state?.fromMs ?? (earliest.ms === null ? cutoff : dayStart(earliest.ms));
      const ambiguous = this.db
        .prepare(`SELECT 1 FROM admin_usage_daily_v2 WHERE frozen=1 AND verified=0
        AND day_start_ms>=? AND day_start_ms<? LIMIT 1`)
        .get(fromMs, cutoff);
      if (ambiguous) throw new ControlError(409, 'UNVERIFIED_ARCHIVE_DAY', 'Legacy frozen rollup cannot be verified');
      this.db
        .prepare('UPDATE admin_usage_daily_v2 SET frozen=1,verified=1 WHERE day_start_ms>=? AND day_start_ms<?')
        .run(fromMs, cutoff);
      const attempts = this.db
        .prepare('DELETE FROM attempts WHERE request_id IN (SELECT id FROM requests WHERE started_at_ms<?)')
        .run(cutoff);
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_request_metadata'").get())
        this.db
          .prepare(
            'DELETE FROM legacy_request_metadata WHERE request_id IN (SELECT id FROM requests WHERE started_at_ms<?)',
          )
          .run(cutoff);
      const requests = this.db.prepare('DELETE FROM requests WHERE started_at_ms<?').run(cutoff);
      // Archived buckets are immutable. Their detail is gone, so remove only
      // the corresponding live buckets, never rewriting a frozen daily row.
      if (liveState !== null) {
        this.db.prepare('DELETE FROM live_request_minute WHERE bucket_ms<?').run(cutoff);
        this.db.prepare('DELETE FROM live_attempt_minute WHERE bucket_ms<?').run(cutoff);
        if (liveState === initialSequence) {
          const current = (
            this.db.prepare('SELECT sequence AS n FROM telemetry_write_watermark WHERE id=1').get() as { n: number }
          ).n;
          this.db.prepare('UPDATE live_aggregate_state SET covered_sequence=? WHERE id=1').run(current);
        }
      }
      const throughMs = Math.max(state?.throughMs ?? cutoff, cutoff);
      this.db
        .prepare(`INSERT INTO admin_usage_archive_state(id,from_ms,through_ms) VALUES(1,?,?)
        ON CONFLICT(id) DO UPDATE SET from_ms=MIN(from_ms,excluded.from_ms),
        through_ms=MAX(through_ms,excluded.through_ms)`)
        .run(fromMs, throughMs);
      return {
        cutoff: new Date(cutoff).toISOString(),
        requests: requests.changes,
        attempts: attempts.changes,
        rollups: rebuilt.rows,
        archiveFrom: new Date(fromMs).toISOString(),
        archiveThrough: new Date(throughMs).toISOString(),
      };
    })();
  }

  private countFrozen(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM admin_usage_daily_v2 WHERE frozen=1').get() as { n: number }).n;
  }
}
