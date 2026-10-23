import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { QuotaStateBatch, QuotaStatePersistence, QuotaStateRow } from './redis-state.js';

/** Standalone persistence adapter; production callers run it in the quota worker. */
export class SQLiteQuotaStatePersistence implements QuotaStatePersistence {
  constructor(
    private readonly db: Database.Database,
    private readonly namespace: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS quota_cache_metadata (
      namespace TEXT PRIMARY KEY, identity TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS quota_cache_state (
      namespace TEXT NOT NULL, key TEXT NOT NULL, generation INTEGER NOT NULL, version INTEGER NOT NULL,
      value_json TEXT NOT NULL, PRIMARY KEY(namespace,key)
    )`);
    db.prepare('INSERT OR IGNORE INTO quota_cache_metadata(namespace,identity) VALUES (?,?)').run(
      namespace,
      randomUUID(),
    );
  }
  async identity(): Promise<string> {
    return (
      this.db.prepare('SELECT identity FROM quota_cache_metadata WHERE namespace=?').get(this.namespace) as {
        identity: string;
      }
    ).identity;
  }
  async generation(): Promise<number> {
    return (
      this.db.prepare('SELECT generation FROM quota_cache_metadata WHERE namespace=?').get(this.namespace) as {
        generation: number;
      }
    ).generation;
  }
  async beginGeneration(expected: number): Promise<number> {
    const row = this.db
      .prepare(
        'UPDATE quota_cache_metadata SET generation=generation+1 WHERE namespace=? AND generation=? RETURNING generation',
      )
      .get(this.namespace, expected) as { generation: number } | undefined;
    if (!row) throw new Error('Concurrent quota generation changed');
    return row.generation;
  }
  async load(keys: string[]): Promise<QuotaStateRow[]> {
    return keys.flatMap((key) => {
      const row = this.db
        .prepare('SELECT version,value_json FROM quota_cache_state WHERE namespace=? AND key=?')
        .get(this.namespace, key) as { version: number; value_json: string } | undefined;
      if (row) return [{ key, version: row.version, value: JSON.parse(row.value_json) }];
      const value = this.legacy(key);
      return value === undefined ? [] : [{ key, value, version: 0 }];
    });
  }
  private legacy(key: string): unknown {
    const [kind, id, periodId] = JSON.parse(key) as string[];
    if (kind === 'account') {
      const active = this.db
        .prepare("SELECT COUNT(*) AS n FROM quota_reservations WHERE proxy_key_id=? AND state='active'")
        .get(id) as { n: number };
      const rows = this.db
        .prepare(
          'SELECT CAST(admitted_at_ms/1000 AS INTEGER) AS second,COUNT(*) AS n FROM quota_admissions WHERE proxy_key_id=? AND admitted_at_ms>? GROUP BY second',
        )
        .all(id, Date.now() - 61000) as { second: number; n: number }[];
      return {
        kind,
        proxyKeyId: id,
        activeRequests: active.n,
        rpm: Object.fromEntries(rows.map((row) => [String(row.second), row.n])),
      };
    }
    if (kind === 'period') {
      const p = this.db
        .prepare('SELECT * FROM quota_periods WHERE proxy_key_id=? AND period_id=?')
        .get(id, periodId) as any;
      if (!p) return undefined;
      const adjustment = this.db
        .prepare(
          'SELECT COALESCE(SUM(delta_tokens),0) AS n FROM quota_ledger_adjustments WHERE proxy_key_id=? AND period_id=?',
        )
        .get(id, periodId) as { n: number };
      return {
        kind,
        proxyKeyId: id,
        periodId,
        startMs: p.start_ms,
        endMs: p.end_ms,
        timezoneVersionId: p.timezone_version_id,
        reportedUsed: p.reported_used,
        estimatedUsed: p.estimated_used,
        reserved: p.reserved,
        adjustmentTokens: adjustment.n,
      };
    }
    if (kind === 'request') {
      const r = this.db.prepare('SELECT * FROM quota_reservations WHERE request_id=?').get(id) as any;
      if (!r) return undefined;
      const admitted = this.db.prepare('SELECT admitted_at_ms FROM quota_admissions WHERE request_id=?').get(id) as
        | { admitted_at_ms: number }
        | undefined;
      const usage = this.db
        .prepare('SELECT attempt_id,reported_tokens FROM quota_attempt_usage WHERE request_id=?')
        .all(id) as { attempt_id: string; reported_tokens: number }[];
      const period = this.db
        .prepare('SELECT end_ms FROM quota_periods WHERE proxy_key_id=? AND period_id=?')
        .get(r.proxy_key_id, r.period_id) as { end_ms: number };
      const sent = this.db.prepare('SELECT attempt_id FROM quota_attempt_dispatch WHERE request_id=?').all(id) as {
        attempt_id: string;
      }[];
      return {
        kind,
        requestId: id,
        proxyKeyId: r.proxy_key_id,
        periodId: r.period_id,
        reservedTokens: r.reserved_tokens,
        attemptReserveTokens: r.attempt_reserve_tokens,
        settledTokens: r.settled_tokens ?? 0,
        state: r.state,
        sent: r.attempt_sent,
        sentAttempts: Object.fromEntries(sent.map((row) => [row.attempt_id, true])),
        usage: Object.fromEntries(usage.map((row) => [row.attempt_id, row.reported_tokens])),
        missingUsagePolicy: r.missing_usage_policy,
        admittedAtMs: admitted?.admitted_at_ms ?? 0,
        deadlineMs: (admitted?.admitted_at_ms ?? 0) + 600000,
        periodEndMs: period.end_ms,
        evictAfterPersist: r.state !== 'active' && r.state !== 'retained',
      };
    }
    if (kind === 'adjustment') {
      const a = this.db.prepare('SELECT * FROM quota_ledger_adjustments WHERE id=?').get(id) as any;
      if (!a) return undefined;
      return {
        kind,
        id,
        proxyKeyId: a.proxy_key_id,
        periodId: a.period_id,
        deltaTokens: a.delta_tokens,
        reason: a.reason,
        createdAtMs: a.created_at_ms,
        evictAfterPersist: true,
      };
    }
    return undefined;
  }
  async apply(batches: QuotaStateBatch[]): Promise<void> {
    this.db
      .transaction(() => {
        const generation = (
          this.db.prepare('SELECT generation FROM quota_cache_metadata WHERE namespace=?').get(this.namespace) as {
            generation: number;
          }
        ).generation;
        const upsert =
          this.db.prepare(`INSERT INTO quota_cache_state(namespace,key,generation,version,value_json) VALUES (?,?,?,?,?)
        ON CONFLICT(namespace,key) DO UPDATE SET generation=excluded.generation,version=excluded.version,value_json=excluded.value_json
        WHERE excluded.generation>quota_cache_state.generation OR (excluded.generation=quota_cache_state.generation AND excluded.version>quota_cache_state.version)`);
        for (const batch of batches) {
          if (batch.generation !== generation) throw new Error('Stale quota persistence generation');
          // Period rows must precede request projections because legacy tables have a FK.
          const rows = [...batch.rows].sort(
            (a, b) => Number((b.value as any)?.kind === 'period') - Number((a.value as any)?.kind === 'period'),
          );
          for (const row of rows) {
            if (upsert.run(this.namespace, row.key, generation, row.version, JSON.stringify(row.value)).changes)
              this.project(row.value as any);
          }
        }
      })
      .immediate();
  }
  private project(value: any): void {
    if (value.kind === 'period')
      this.db
        .prepare(`INSERT INTO quota_periods(proxy_key_id,period_id,start_ms,end_ms,timezone_version_id,reported_used,estimated_used,reserved)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(proxy_key_id,period_id) DO UPDATE SET reported_used=excluded.reported_used,estimated_used=excluded.estimated_used,reserved=excluded.reserved`)
        .run(
          value.proxyKeyId,
          value.periodId,
          value.startMs,
          value.endMs,
          value.timezoneVersionId ?? null,
          value.reportedUsed,
          value.estimatedUsed,
          value.reserved,
        );
    if (value.kind === 'request') {
      this.db
        .prepare(`INSERT INTO quota_reservations(request_id,proxy_key_id,period_id,reserved_tokens,attempt_reserve_tokens,missing_usage_policy,state,attempt_sent,settled_tokens)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET reserved_tokens=excluded.reserved_tokens,state=excluded.state,attempt_sent=excluded.attempt_sent,settled_tokens=excluded.settled_tokens`)
        .run(
          value.requestId,
          value.proxyKeyId,
          value.periodId,
          value.reservedTokens,
          value.attemptReserveTokens,
          value.missingUsagePolicy,
          value.state,
          value.sent,
          value.settledTokens ?? 0,
        );
      this.db
        .prepare('INSERT OR IGNORE INTO quota_admissions(request_id,proxy_key_id,admitted_at_ms) VALUES (?,?,?)')
        .run(value.requestId, value.proxyKeyId, value.admittedAtMs);
      this.db.prepare('DELETE FROM quota_attempt_usage WHERE request_id=?').run(value.requestId);
      if (value.state === 'active')
        for (const [attemptId, tokens] of Object.entries(value.usage ?? {}))
          this.db
            .prepare('INSERT INTO quota_attempt_usage(request_id,attempt_id,reported_tokens) VALUES (?,?,?)')
            .run(value.requestId, attemptId, tokens);
    }
    if (value.kind === 'adjustment')
      this.db
        .prepare(
          'INSERT OR IGNORE INTO quota_ledger_adjustments(id,proxy_key_id,period_id,delta_tokens,reason,created_at_ms) VALUES (?,?,?,?,?,?)',
        )
        .run(value.id, value.proxyKeyId, value.periodId, value.deltaTokens, value.reason, value.createdAtMs);
  }
  async ping(generation?: number): Promise<void> {
    if (generation !== undefined && (await this.generation()) !== generation)
      throw new Error('Stale quota persistence generation');
    this.db.prepare('SELECT 1').get();
  }
  async expiredRequests(nowMs: number, limit: number): Promise<string[]> {
    const rows = this.db
      .prepare(`SELECT value_json FROM quota_cache_state WHERE namespace=? AND json_extract(value_json,'$.kind')='request'
      AND ((json_extract(value_json,'$.state')='active' AND json_extract(value_json,'$.deadlineMs')<=?)
        OR (json_extract(value_json,'$.state')='retained' AND json_extract(value_json,'$.periodEndMs')<=?)) LIMIT ?`)
      .all(this.namespace, nowMs, nowMs, limit) as { value_json: string }[];
    const ids = rows.map((row) => JSON.parse(row.value_json).requestId as string);
    if (ids.length < limit) {
      const legacy = this.db
        .prepare(`SELECT r.request_id FROM quota_reservations r
        JOIN quota_periods p ON p.proxy_key_id=r.proxy_key_id AND p.period_id=r.period_id
        LEFT JOIN quota_admissions a ON a.request_id=r.request_id
        WHERE ((r.state='active' AND COALESCE(a.admitted_at_ms,0)+600000<=?) OR (r.state='retained' AND p.end_ms<=?))
          AND NOT EXISTS (SELECT 1 FROM quota_cache_state s WHERE s.namespace=? AND s.key=json_array('request',r.request_id))
        LIMIT ?`)
        .all(nowMs, nowMs, this.namespace, limit - ids.length) as { request_id: string }[];
      ids.push(...legacy.map((row) => row.request_id));
    }
    return ids;
  }
}
