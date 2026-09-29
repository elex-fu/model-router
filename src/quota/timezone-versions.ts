import type Database from 'better-sqlite3';
import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';
import { type QuotaPeriod, quotaPeriod } from './period.js';

export type QuotaTimezoneVersionState = 'active' | 'scheduled' | 'superseded';

export interface QuotaTimezoneVersion {
  versionId: number;
  timezone: string;
  configRevision: number | null;
  createdAtMs: number;
  effectiveFromMs: number;
  state: QuotaTimezoneVersionState;
}

export interface VersionedQuotaPeriod extends QuotaPeriod {
  versionId: number;
  timezone: string;
  effectiveFromMs: number;
}

type VersionRow = {
  version_id: number;
  timezone: string;
  config_revision: number | null;
  created_at_ms: number;
  effective_from_ms: number;
  state: QuotaTimezoneVersionState;
};

const fromRow = (row: VersionRow): QuotaTimezoneVersion => ({
  versionId: row.version_id,
  timezone: row.timezone,
  configRevision: row.config_revision,
  createdAtMs: row.created_at_ms,
  effectiveFromMs: row.effective_from_ms,
  state: row.state,
});

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
}

function assertTimezone(timezone: string, atMs: number): void {
  // Intl validates IANA timezone names; constructing the period also validates conversion behavior.
  quotaPeriod(atMs, timezone);
}

/**
 * Persistent quota-cycle timezone schedule. Call initialize after SQLiteTelemetryStore.init().
 * Startup only creates the initial active version; it never activates a due scheduled version.
 */
export class QuotaTimezoneVersions {
  constructor(private readonly store: SQLiteTelemetryStore) {}

  /** Initialize the first active version, or return the existing version state unchanged. */
  initialize(timezone: string, nowMs = Date.now(), configRevision: number | null = null): QuotaTimezoneVersion {
    assertTimestamp(nowMs, 'nowMs');
    assertTimezone(timezone, nowMs);
    const db = this.store.connection;
    return db.transaction(() => {
      const existing = db.prepare("SELECT * FROM quota_timezone_versions WHERE state='active' LIMIT 1").get() as
        | VersionRow
        | undefined;
      if (existing) return fromRow(existing);
      const anyVersions = db.prepare('SELECT 1 FROM quota_timezone_versions LIMIT 1').get();
      if (anyVersions) throw new Error('quota timezone versions have no active version');
      const result = db
        .prepare(`INSERT INTO quota_timezone_versions
          (timezone,config_revision,created_at_ms,effective_from_ms,state) VALUES (?,?,?,?, 'active')`)
        .run(timezone, configRevision, nowMs, 0);
      return fromRow(
        db
          .prepare('SELECT * FROM quota_timezone_versions WHERE version_id=?')
          .get(result.lastInsertRowid) as VersionRow,
      );
    })();
  }

  /**
   * Schedule a timezone change for the end of the active timezone's current calendar period.
   * Repeating the same desired timezone is idempotent; choosing the active timezone cancels a pending change.
   */
  schedule(
    timezone: string,
    nowMs = Date.now(),
    configRevision: number | null = null,
  ): { active: QuotaTimezoneVersion; scheduled: QuotaTimezoneVersion | null } {
    assertTimestamp(nowMs, 'nowMs');
    assertTimezone(timezone, nowMs);
    const db = this.store.connection;
    return db.transaction(() => {
      const activeRow = db.prepare("SELECT * FROM quota_timezone_versions WHERE state='active' LIMIT 1").get() as
        | VersionRow
        | undefined;
      if (!activeRow) throw new Error('quota timezone versions have not been initialized');
      const active = fromRow(activeRow);
      const pendingRows = db
        .prepare("SELECT * FROM quota_timezone_versions WHERE state='scheduled' ORDER BY version_id DESC")
        .all() as VersionRow[];

      if (timezone === active.timezone) {
        db.prepare("UPDATE quota_timezone_versions SET state='superseded' WHERE state='scheduled'").run();
        return { active, scheduled: null };
      }

      const boundary = quotaPeriod(nowMs, active.timezone).endMs;
      const identical = pendingRows.find((row) => row.timezone === timezone && row.effective_from_ms === boundary);
      if (identical) return { active, scheduled: fromRow(identical) };

      db.prepare("UPDATE quota_timezone_versions SET state='superseded' WHERE state='scheduled'").run();
      const result = db
        .prepare(`INSERT INTO quota_timezone_versions
          (timezone,config_revision,created_at_ms,effective_from_ms,state) VALUES (?,?,?,?, 'scheduled')`)
        .run(timezone, configRevision, nowMs, boundary);
      return {
        active,
        scheduled: fromRow(
          db
            .prepare('SELECT * FROM quota_timezone_versions WHERE version_id=?')
            .get(result.lastInsertRowid) as VersionRow,
        ),
      };
    })();
  }

  /** Cancel any pending timezone change without changing the active period version. */
  cancelPending(): number {
    return this.store.connection
      .prepare("UPDATE quota_timezone_versions SET state='superseded' WHERE state='scheduled'")
      .run().changes;
  }

  list(): QuotaTimezoneVersion[] {
    const rows = this.store.connection
      .prepare('SELECT * FROM quota_timezone_versions ORDER BY version_id')
      .all() as VersionRow[];
    return rows.map(fromRow);
  }

  /**
   * Resolve the billable period at request admission. This is the sole operation that activates
   * a scheduled version, and it does so atomically when atMs reaches the persisted boundary.
   */
  resolveForAdmission(atMs: number): VersionedQuotaPeriod {
    assertTimestamp(atMs, 'atMs');
    const db: Database.Database = this.store.connection;
    return db.transaction(() => {
      let active = db.prepare("SELECT * FROM quota_timezone_versions WHERE state='active' LIMIT 1").get() as
        | VersionRow
        | undefined;
      if (!active) throw new Error('quota timezone versions have not been initialized');
      const due = db
        .prepare(
          "SELECT * FROM quota_timezone_versions WHERE state='scheduled' AND effective_from_ms<=? ORDER BY version_id LIMIT 1",
        )
        .get(atMs) as VersionRow | undefined;
      if (due) {
        db.prepare("UPDATE quota_timezone_versions SET state='superseded' WHERE version_id=? AND state='active'").run(
          active.version_id,
        );
        db.prepare("UPDATE quota_timezone_versions SET state='active' WHERE version_id=? AND state='scheduled'").run(
          due.version_id,
        );
        active = db
          .prepare('SELECT * FROM quota_timezone_versions WHERE version_id=?')
          .get(due.version_id) as VersionRow;
      }

      const period = quotaPeriod(atMs, active.timezone, active.version_id);
      const startMs = Math.max(period.startMs, active.effective_from_ms);
      return {
        ...period,
        startMs,
        versionId: active.version_id,
        timezone: active.timezone,
        effectiveFromMs: active.effective_from_ms,
      };
    })();
  }
}
