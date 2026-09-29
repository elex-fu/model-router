import type { SQLiteTelemetryStore } from '../storage/telemetry-store.js';

export interface QuotaAdmission {
  requestId: string;
  proxyKeyId: string;
  atMs: number;
  periodId: string;
  periodStartMs: number;
  periodEndMs: number;
  timezoneVersionId?: number;
  reserveTokens: number;
  dailyTokens?: number;
  rpm?: number;
  maxConcurrentRequests?: number;
  missingUsagePolicy?: 'retain-reservation' | 'release-reservation';
}
export interface QuotaDecision {
  allowed: boolean;
  reason?: 'rpm_exceeded' | 'daily_tokens_exceeded' | 'concurrency_exceeded' | 'recorder_degraded';
  retryAfterMs?: number;
}
export interface QuotaBalance {
  reportedUsed: number;
  estimatedUsed: number;
  reserved: number;
  adjustmentTokens: number;
  activeRequests: number;
}

function nonnegative(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('token count must be a nonnegative safe integer');
}

/** One SQLite transaction owns admission checks and reservation writes. */
export class SQLiteQuotaLedger {
  constructor(private readonly store: SQLiteTelemetryStore) {
    const db = store.connection;
    const columns = db.prepare('PRAGMA table_info(quota_reservations)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'attempt_reserve_tokens'))
      db.exec('ALTER TABLE quota_reservations ADD COLUMN attempt_reserve_tokens INTEGER NOT NULL DEFAULT 0');
    if (!columns.some((column) => column.name === 'missing_usage_policy'))
      db.exec("ALTER TABLE quota_reservations ADD COLUMN missing_usage_policy TEXT NOT NULL DEFAULT 'estimate'");
  }

  private expireRetained(nowMs: number): void {
    const db = this.store.connection;
    const rows = db
      .prepare(`SELECT r.request_id, r.proxy_key_id, r.period_id, r.reserved_tokens
      FROM quota_reservations r JOIN quota_periods p
      ON p.proxy_key_id=r.proxy_key_id AND p.period_id=r.period_id
      WHERE r.state='retained' AND p.end_ms<=?`)
      .all(nowMs) as Array<{
      request_id: string;
      proxy_key_id: string;
      period_id: string;
      reserved_tokens: number;
    }>;
    for (const row of rows) {
      db.prepare(`UPDATE quota_periods SET reserved=reserved-?, estimated_used=estimated_used+?
        WHERE proxy_key_id=? AND period_id=?`).run(
        row.reserved_tokens,
        row.reserved_tokens,
        row.proxy_key_id,
        row.period_id,
      );
      db.prepare(`UPDATE quota_reservations SET state='estimated', reserved_tokens=0,
        settled_tokens=settled_tokens+? WHERE request_id=?`).run(row.reserved_tokens, row.request_id);
    }
  }

  async admit(a: QuotaAdmission): Promise<QuotaDecision> {
    nonnegative(a.reserveTokens);
    for (const limit of [a.dailyTokens, a.rpm, a.maxConcurrentRequests]) {
      if (limit !== undefined) nonnegative(limit);
    }
    if (a.periodEndMs <= a.atMs || a.periodStartMs > a.atMs) throw new RangeError('invalid quota period');
    const db = this.store.connection;
    return db
      .transaction((): QuotaDecision => {
        this.expireRetained(a.atMs);
        const previous = db.prepare('SELECT state FROM quota_reservations WHERE request_id=?').get(a.requestId) as
          | { state: string }
          | undefined;
        if (previous)
          return previous.state === 'active' ? { allowed: true } : { allowed: false, reason: 'daily_tokens_exceeded' };
        const active = db
          .prepare(`SELECT COUNT(*) AS n FROM quota_reservations
        WHERE proxy_key_id=? AND state='active'`)
          .get(a.proxyKeyId) as { n: number };
        if (a.maxConcurrentRequests !== undefined && active.n >= a.maxConcurrentRequests)
          return { allowed: false, reason: 'concurrency_exceeded' };
        const oldest = db
          .prepare(`SELECT admitted_at_ms FROM quota_admissions WHERE proxy_key_id=?
        AND admitted_at_ms > ? ORDER BY admitted_at_ms LIMIT 1`)
          .get(a.proxyKeyId, a.atMs - 60_000) as { admitted_at_ms: number } | undefined;
        const rpm = db
          .prepare(`SELECT COUNT(*) AS n FROM quota_admissions WHERE proxy_key_id=?
        AND admitted_at_ms > ?`)
          .get(a.proxyKeyId, a.atMs - 60_000) as { n: number };
        if (a.rpm !== undefined && rpm.n >= a.rpm)
          return {
            allowed: false,
            reason: 'rpm_exceeded',
            retryAfterMs: oldest ? Math.max(0, oldest.admitted_at_ms + 60_000 - a.atMs) : 60_000,
          };
        db.prepare(`INSERT OR IGNORE INTO quota_periods
        (proxy_key_id, period_id, start_ms, end_ms, timezone_version_id)
        VALUES (?, ?, ?, ?, ?)`).run(
          a.proxyKeyId,
          a.periodId,
          a.periodStartMs,
          a.periodEndMs,
          a.timezoneVersionId ?? null,
        );
        const period = db
          .prepare(`SELECT reported_used, estimated_used, reserved FROM quota_periods
        WHERE proxy_key_id=? AND period_id=?`)
          .get(a.proxyKeyId, a.periodId) as any;
        const adjustment = db
          .prepare(`SELECT COALESCE(SUM(delta_tokens), 0) AS n FROM quota_adjustments
        WHERE proxy_key_id=? AND period_id=?`)
          .get(a.proxyKeyId, a.periodId) as { n: number };
        if (
          a.dailyTokens !== undefined &&
          (a.dailyTokens === 0 ||
            period.reported_used + period.estimated_used + adjustment.n + period.reserved + a.reserveTokens >
              a.dailyTokens)
        )
          return { allowed: false, reason: 'daily_tokens_exceeded', retryAfterMs: a.periodEndMs - a.atMs };
        db.prepare(`INSERT INTO quota_reservations (request_id, proxy_key_id, period_id, reserved_tokens,
        attempt_reserve_tokens, missing_usage_policy, state)
        VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(
          a.requestId,
          a.proxyKeyId,
          a.periodId,
          a.reserveTokens,
          a.reserveTokens,
          a.missingUsagePolicy ?? 'estimate',
        );
        db.prepare(`UPDATE quota_periods SET reserved=reserved+? WHERE proxy_key_id=? AND period_id=?`).run(
          a.reserveTokens,
          a.proxyKeyId,
          a.periodId,
        );
        db.prepare(`INSERT INTO quota_admissions (request_id, proxy_key_id, admitted_at_ms) VALUES (?, ?, ?)`).run(
          a.requestId,
          a.proxyKeyId,
          a.atMs,
        );
        return { allowed: true };
      })
      .immediate();
  }

  async topUp(
    requestId: string,
    extraTokens: number,
    dailyTokens?: number,
    reportedTokensSoFar = 0,
  ): Promise<QuotaDecision> {
    nonnegative(extraTokens);
    nonnegative(reportedTokensSoFar);
    if (dailyTokens !== undefined) nonnegative(dailyTokens);
    const db = this.store.connection;
    return db
      .transaction((): QuotaDecision => {
        const r = db
          .prepare(`SELECT proxy_key_id, period_id, reserved_tokens FROM quota_reservations
        WHERE request_id=? AND state='active'`)
          .get(requestId) as
          | {
              proxy_key_id: string;
              period_id: string;
              reserved_tokens: number;
            }
          | undefined;
        if (!r) throw new Error('active reservation not found');
        const p = db
          .prepare(`SELECT reported_used, estimated_used, reserved, end_ms FROM quota_periods
        WHERE proxy_key_id=? AND period_id=?`)
          .get(r.proxy_key_id, r.period_id) as any;
        const adjustment = db
          .prepare(`SELECT COALESCE(SUM(delta_tokens), 0) AS n FROM quota_adjustments
        WHERE proxy_key_id=? AND period_id=?`)
          .get(r.proxy_key_id, r.period_id) as { n: number };
        const knownOverflow = Math.max(0, reportedTokensSoFar - r.reserved_tokens);
        if (
          dailyTokens !== undefined &&
          p.reported_used + p.estimated_used + adjustment.n + p.reserved + knownOverflow + extraTokens > dailyTokens
        )
          return { allowed: false, reason: 'daily_tokens_exceeded', retryAfterMs: Math.max(0, p.end_ms - Date.now()) };
        db.prepare(`UPDATE quota_reservations SET reserved_tokens=reserved_tokens+? WHERE request_id=?`).run(
          extraTokens,
          requestId,
        );
        db.prepare(`UPDATE quota_periods SET reserved=reserved+? WHERE proxy_key_id=? AND period_id=?`).run(
          extraTokens,
          r.proxy_key_id,
          r.period_id,
        );
        return { allowed: true };
      })
      .immediate();
  }

  async markAttemptSent(requestId: string): Promise<void> {
    this.store.connection
      .prepare(`UPDATE quota_reservations SET attempt_sent=attempt_sent+1
      WHERE request_id=? AND state='active'`)
      .run(requestId);
  }

  /** Known attempts are charged once; unknown sent attempts retain at most their per-attempt reserve. */
  async settle(requestId: string, reportedTokens: number | null, unknownSentAttempts?: number): Promise<void> {
    if (reportedTokens !== null) nonnegative(reportedTokens);
    if (unknownSentAttempts !== undefined) nonnegative(unknownSentAttempts);
    const db = this.store.connection;
    db.transaction(() => {
      const r = db.prepare(`SELECT * FROM quota_reservations WHERE request_id=?`).get(requestId) as any;
      if (!r || r.state !== 'active') return;
      const known = reportedTokens ?? 0;
      const unknown = unknownSentAttempts ?? (reportedTokens === null ? Number(r.attempt_sent) : 0);
      const policy = r.missing_usage_policy as string;
      const bound =
        policy === 'estimate'
          ? r.reserved_tokens
          : Math.min(r.reserved_tokens, unknown * (r.attempt_reserve_tokens || r.reserved_tokens));
      const retained = unknown > 0 && policy === 'retain-reservation' ? bound : 0;
      const estimated = unknown > 0 && policy === 'estimate' ? bound : 0;
      db.prepare(`UPDATE quota_periods SET reserved=reserved-?+?, reported_used=reported_used+?,
        estimated_used=estimated_used+? WHERE proxy_key_id=? AND period_id=?`).run(
        r.reserved_tokens,
        retained,
        known,
        estimated,
        r.proxy_key_id,
        r.period_id,
      );
      db.prepare(`UPDATE quota_reservations SET settled_tokens=?, reserved_tokens=?, state=? WHERE request_id=?`).run(
        known + estimated,
        retained,
        retained ? 'retained' : estimated ? 'estimated' : unknown ? 'released_unknown' : 'settled',
        requestId,
      );
      this.expireRetained(Date.now());
    }).immediate();
  }

  async recoverInterrupted(): Promise<number> {
    const db = this.store.connection;
    db.transaction(() => this.expireRetained(Date.now())).immediate();
    const rows = db.prepare(`SELECT request_id FROM quota_reservations WHERE state='active'`).all() as Array<{
      request_id: string;
    }>;
    for (const row of rows) {
      const attempts = db
        .prepare(`SELECT usage_json FROM attempts WHERE request_id=? AND outcome!='started'`)
        .all(row.request_id) as Array<{ usage_json: string | null }>;
      let known = 0;
      let reported = 0;
      for (const attempt of attempts) {
        const usage = attempt.usage_json
          ? (JSON.parse(attempt.usage_json) as { inputTotal?: number | null; outputTotal?: number | null })
          : null;
        if (usage?.inputTotal != null && usage.outputTotal != null) {
          known += usage.inputTotal + usage.outputTotal;
          reported++;
        }
      }
      const sent = db.prepare('SELECT attempt_sent FROM quota_reservations WHERE request_id=?').get(row.request_id) as {
        attempt_sent: number;
      };
      await this.settle(row.request_id, reported ? known : null, Math.max(0, sent.attempt_sent - reported));
    }
    return rows.length;
  }

  async balance(proxyKeyId: string, periodId: string): Promise<QuotaBalance> {
    const db = this.store.connection;
    db.transaction(() => this.expireRetained(Date.now())).immediate();
    const p = db
      .prepare(`SELECT reported_used, estimated_used, reserved FROM quota_periods
      WHERE proxy_key_id=? AND period_id=?`)
      .get(proxyKeyId, periodId) as any;
    const active = db
      .prepare(`SELECT COUNT(*) AS n FROM quota_reservations WHERE proxy_key_id=?
      AND state='active'`)
      .get(proxyKeyId) as { n: number };
    const adjustment = db
      .prepare(`SELECT COALESCE(SUM(delta_tokens), 0) AS n FROM quota_adjustments
      WHERE proxy_key_id=? AND period_id=?`)
      .get(proxyKeyId, periodId) as { n: number };
    return {
      reportedUsed: p?.reported_used ?? 0,
      estimatedUsed: p?.estimated_used ?? 0,
      reserved: p?.reserved ?? 0,
      adjustmentTokens: adjustment.n,
      activeRequests: active.n,
    };
  }

  async adjust(id: string, proxyKeyId: string, periodId: string, deltaTokens: number, reason: string): Promise<void> {
    if (!Number.isSafeInteger(deltaTokens) || !reason.trim()) throw new RangeError('invalid adjustment');
    const db = this.store.connection;
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO quota_adjustments
        (id, proxy_key_id, period_id, delta_tokens, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)`).run(
        id,
        proxyKeyId,
        periodId,
        deltaTokens,
        reason,
        Date.now(),
      );
    }).immediate();
  }
}
