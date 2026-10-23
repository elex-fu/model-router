import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';

export interface QuotaStore {
  connection: Database.Database;
}

/** Business state lives in control.sqlite, independently of the best-effort log database. */
export function initializeQuotaStore(db: Database.Database, legacyLogPath?: string): void {
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = FULL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_store_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quota_periods (
      proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
      reported_used INTEGER NOT NULL DEFAULT 0, estimated_used INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0, timezone_version_id INTEGER, PRIMARY KEY(proxy_key_id, period_id)
    );
    CREATE TABLE IF NOT EXISTS quota_timezone_versions (
      version_id INTEGER PRIMARY KEY AUTOINCREMENT, timezone TEXT NOT NULL, config_revision INTEGER,
      created_at_ms INTEGER NOT NULL, effective_from_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','scheduled','superseded'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_timezone_single_active
      ON quota_timezone_versions(state) WHERE state='active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_timezone_single_scheduled
      ON quota_timezone_versions(state) WHERE state='scheduled';
    CREATE TABLE IF NOT EXISTS quota_reservations (
      request_id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL, settled_tokens INTEGER, state TEXT NOT NULL,
      attempt_sent INTEGER NOT NULL DEFAULT 0, attempt_reserve_tokens INTEGER NOT NULL DEFAULT 0,
      missing_usage_policy TEXT NOT NULL DEFAULT 'estimate',
      FOREIGN KEY(proxy_key_id, period_id) REFERENCES quota_periods(proxy_key_id, period_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reservation_key_state ON quota_reservations(proxy_key_id,state);
    CREATE TABLE IF NOT EXISTS quota_admissions (
      request_id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, admitted_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admissions_key_time ON quota_admissions(proxy_key_id,admitted_at_ms);
    CREATE TABLE IF NOT EXISTS quota_ledger_adjustments (
      id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL,
      delta_tokens INTEGER NOT NULL, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota_attempt_usage (
      request_id TEXT NOT NULL, attempt_id TEXT NOT NULL, reported_tokens INTEGER NOT NULL CHECK(reported_tokens>=0),
      PRIMARY KEY(request_id,attempt_id)
    );
    CREATE TABLE IF NOT EXISTS response_ownership (
      response_id TEXT PRIMARY KEY, proxy_key_id TEXT NOT NULL, upstream_id TEXT NOT NULL,
      credential_id TEXT, expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_response_ownership_expiry ON response_ownership(expires_at_ms);
  `);
  const marker = db.prepare('SELECT version FROM quota_store_meta WHERE id=1').get() as { version: number } | undefined;
  if (marker) {
    if (marker.version !== 1) throw new Error('Unsupported quota store version');
    return;
  }

  // Only the stopped/startup instance migrates. The marker and all copied state commit together;
  // subsequent boots never read the log database to make a quota decision or recover usage.
  const attached = legacyLogPath !== undefined && existsSync(legacyLogPath);
  if (attached) db.prepare('ATTACH DATABASE ? AS legacy_quota').run(legacyLogPath);
  try {
    db.transaction(() => {
      const copies = [
        ['quota_periods', 'quota_periods'],
        ['quota_timezone_versions', 'quota_timezone_versions'],
        ['quota_reservations', 'quota_reservations'],
        ['quota_admissions', 'quota_admissions'],
        ['quota_adjustments', 'quota_ledger_adjustments'],
        ['response_ownership', 'response_ownership'],
      ] as const;
      for (const [source, target] of copies) {
        if (db.prepare(`SELECT 1 FROM ${target} LIMIT 1`).get())
          throw new Error('Unmarked quota store already contains business state; refusing migration');
        if (
          !attached ||
          !db.prepare("SELECT 1 FROM legacy_quota.sqlite_master WHERE type='table' AND name=?").get(source)
        )
          continue;
        const sourceColumns = new Set(
          (db.prepare(`PRAGMA legacy_quota.table_info(${source})`).all() as Array<{ name: string }>).map((c) => c.name),
        );
        const columns = (db.prepare(`PRAGMA main.table_info(${target})`).all() as Array<{ name: string }>)
          .map((c) => c.name)
          .filter((name) => sourceColumns.has(name));
        db.exec(
          `INSERT INTO main.${target} (${columns.join(',')}) SELECT ${columns.join(',')} FROM legacy_quota.${source}`,
        );
      }
      if (
        attached &&
        db.prepare("SELECT 1 FROM legacy_quota.sqlite_master WHERE type='table' AND name='attempts'").get()
      ) {
        const insert = db.prepare(
          'INSERT INTO quota_attempt_usage (request_id,attempt_id,reported_tokens) VALUES (?,?,?)',
        );
        const attempts = db.prepare(`SELECT a.id,a.request_id,a.usage_json FROM legacy_quota.attempts a
          JOIN main.quota_reservations r ON r.request_id=a.request_id
          WHERE r.state='active' AND a.outcome!='started' AND a.usage_json IS NOT NULL`);
        for (const row of attempts.iterate() as Iterable<{ id: string; request_id: string; usage_json: string }>) {
          const usage = JSON.parse(row.usage_json) as { inputTotal?: number | null; outputTotal?: number | null };
          if (usage.inputTotal == null || usage.outputTotal == null) continue;
          const tokens = usage.inputTotal + usage.outputTotal;
          if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid legacy quota usage');
          insert.run(row.request_id, row.id, tokens);
        }
      }
      db.prepare('INSERT INTO quota_store_meta (id,version) VALUES (1,1)').run();
    }).immediate();
  } finally {
    if (attached) db.exec('DETACH DATABASE legacy_quota');
  }
}
