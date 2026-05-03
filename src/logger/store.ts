import Database from 'better-sqlite3';
import { DEFAULT_DB_PATH } from '../utils/paths.js';
import type { KeyStats, LogEntry, StatsResult } from './types.js';

export interface LogStore {
  init(): Promise<void>;
  insertBatch(entries: LogEntry[]): Promise<void>;
  queryLogs(limit: number, filter?: { keyName?: string; protocol?: 'anthropic' | 'openai' }): Promise<LogEntry[]>;
  stats(date: string): Promise<StatsResult>;
  todayTokensByKey(date: string): Promise<Array<{ keyName: string; tokensUsed: number }>>;
  statsByKey(keyName: string, fromDate: string, toDate: string): Promise<Omit<KeyStats, 'keyName'>>;
  statsAllKeys(fromDate: string, toDate: string): Promise<KeyStats[]>;
  keyActivitySummary(today: string): Promise<Array<{ keyName: string; usedToday: number; lastUsed: string | null }>>;
  purgeOlderThan(days: number): Promise<number>;
  vacuum(): Promise<void>;
  ping(): Promise<void>;
  close?(): Promise<void>;
}

export class SQLiteLogStore implements LogStore {
  private db?: Database.Database;

  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {}

  async init(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          proxy_key_name TEXT NOT NULL,
          client_ip TEXT,
          client_protocol TEXT,
          upstream_protocol TEXT,
          request_model TEXT,
          actual_model TEXT,
          upstream_name TEXT,
          status_code INTEGER,
          error_message TEXT,
          request_tokens INTEGER,
          response_tokens INTEGER,
          total_tokens INTEGER,
          duration_ms INTEGER,
          is_streaming BOOLEAN NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(proxy_key_name);
      CREATE INDEX IF NOT EXISTS idx_logs_time ON request_logs(created_at);
    `);

    // Backwards-compat migration: pre-existing dbs lack the protocol columns.
    addColumnIfMissing(this.db, 'request_logs', 'client_protocol', 'TEXT');
    addColumnIfMissing(this.db, 'request_logs', 'upstream_protocol', 'TEXT');
  }

  async insertBatch(entries: LogEntry[]): Promise<void> {
    if (!this.db || entries.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO request_logs (
        proxy_key_name, client_ip, client_protocol, upstream_protocol,
        request_model, actual_model, upstream_name,
        status_code, error_message, request_tokens, response_tokens, total_tokens,
        duration_ms, is_streaming
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((rows: LogEntry[]) => {
      for (const row of rows) {
        stmt.run(
          row.proxy_key_name,
          row.client_ip,
          row.client_protocol,
          row.upstream_protocol,
          row.request_model,
          row.actual_model,
          row.upstream_name,
          row.status_code,
          row.error_message,
          row.request_tokens,
          row.response_tokens,
          row.total_tokens,
          row.duration_ms,
          row.is_streaming ? 1 : 0
        );
      }
    });
    insertMany(entries);
  }

  async queryLogs(
    limit: number,
    filter?: { keyName?: string; protocol?: 'anthropic' | 'openai' }
  ): Promise<LogEntry[]> {
    if (!this.db) return [];
    let sql = 'SELECT * FROM request_logs';
    const params: any[] = [];
    const where: string[] = [];
    if (filter?.keyName) {
      where.push('proxy_key_name = ?');
      params.push(filter.keyName);
    }
    if (filter?.protocol) {
      where.push('(client_protocol = ? OR upstream_protocol = ?)');
      params.push(filter.protocol, filter.protocol);
    }
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      proxy_key_name: r.proxy_key_name,
      client_ip: r.client_ip,
      client_protocol: r.client_protocol ?? null,
      upstream_protocol: r.upstream_protocol ?? null,
      request_model: r.request_model,
      actual_model: r.actual_model,
      upstream_name: r.upstream_name,
      status_code: r.status_code,
      error_message: r.error_message,
      request_tokens: r.request_tokens,
      response_tokens: r.response_tokens,
      total_tokens: r.total_tokens,
      duration_ms: r.duration_ms,
      is_streaming: Boolean(r.is_streaming),
      created_at: r.created_at,
    }));
  }

  async stats(date: string): Promise<StatsResult> {
    if (!this.db) {
      return { totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, avgLatencyMs: 0 };
    }
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS totalRequests,
          COALESCE(SUM(request_tokens), 0) AS totalInputTokens,
          COALESCE(SUM(response_tokens), 0) AS totalOutputTokens,
          COALESCE(AVG(duration_ms), 0) AS avgLatencyMs
        FROM request_logs
        WHERE DATE(created_at) = ?`
      )
      .get(date) as any;
    return {
      totalRequests: row.totalRequests,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      avgLatencyMs: Math.round(row.avgLatencyMs),
    };
  }

  async todayTokensByKey(
    date: string
  ): Promise<Array<{ keyName: string; tokensUsed: number }>> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT proxy_key_name AS keyName,
                COALESCE(SUM(COALESCE(request_tokens, 0) + COALESCE(response_tokens, 0)), 0) AS tokensUsed
         FROM request_logs
         WHERE DATE(created_at) = ?
         GROUP BY proxy_key_name`
      )
      .all(date) as Array<{ keyName: string; tokensUsed: number }>;
    return rows;
  }

  async statsByKey(
    keyName: string,
    fromDate: string,
    toDate: string
  ): Promise<Omit<KeyStats, 'keyName'>> {
    if (!this.db) {
      return {
        requests: 0,
        errors: 0,
        rateLimited: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        avgLatencyMs: 0,
        lastSeen: null,
      };
    }
    const row = this.db
      .prepare(
        `SELECT
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code <> 429 THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END), 0) AS rateLimited,
            COALESCE(SUM(COALESCE(request_tokens, 0)), 0) AS inputTokens,
            COALESCE(SUM(COALESCE(response_tokens, 0)), 0) AS outputTokens,
            COALESCE(AVG(duration_ms), 0) AS avgLatencyMs,
            MAX(created_at) AS lastSeen
         FROM request_logs
         WHERE proxy_key_name = ?
           AND DATE(created_at) >= ?
           AND DATE(created_at) <= ?`
      )
      .get(keyName, fromDate, toDate) as any;
    const inputTokens = Number(row.inputTokens) || 0;
    const outputTokens = Number(row.outputTokens) || 0;
    return {
      requests: Number(row.requests) || 0,
      errors: Number(row.errors) || 0,
      rateLimited: Number(row.rateLimited) || 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      avgLatencyMs: Math.round(Number(row.avgLatencyMs) || 0),
      lastSeen: row.lastSeen ?? null,
    };
  }

  async statsAllKeys(fromDate: string, toDate: string): Promise<KeyStats[]> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT
            proxy_key_name AS keyName,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status_code >= 400 AND status_code <> 429 THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(SUM(CASE WHEN status_code = 429 THEN 1 ELSE 0 END), 0) AS rateLimited,
            COALESCE(SUM(COALESCE(request_tokens, 0)), 0) AS inputTokens,
            COALESCE(SUM(COALESCE(response_tokens, 0)), 0) AS outputTokens,
            COALESCE(AVG(duration_ms), 0) AS avgLatencyMs,
            MAX(created_at) AS lastSeen
         FROM request_logs
         WHERE DATE(created_at) >= ?
           AND DATE(created_at) <= ?
         GROUP BY proxy_key_name
         ORDER BY (COALESCE(SUM(COALESCE(request_tokens, 0)), 0) + COALESCE(SUM(COALESCE(response_tokens, 0)), 0)) DESC`
      )
      .all(fromDate, toDate) as any[];
    return rows.map((row) => {
      const inputTokens = Number(row.inputTokens) || 0;
      const outputTokens = Number(row.outputTokens) || 0;
      return {
        keyName: row.keyName,
        requests: Number(row.requests) || 0,
        errors: Number(row.errors) || 0,
        rateLimited: Number(row.rateLimited) || 0,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        avgLatencyMs: Math.round(Number(row.avgLatencyMs) || 0),
        lastSeen: row.lastSeen ?? null,
      };
    });
  }

  async purgeOlderThan(days: number): Promise<number> {
    if (!this.db) return 0;
    const result = this.db
      .prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', ?)`)
      .run(`-${days} days`);
    return Number(result.changes) || 0;
  }

  async keyActivitySummary(
    today: string
  ): Promise<Array<{ keyName: string; usedToday: number; lastUsed: string | null }>> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT proxy_key_name AS keyName,
                COALESCE(SUM(CASE WHEN DATE(created_at) = ?
                                  THEN COALESCE(request_tokens, 0) + COALESCE(response_tokens, 0)
                                  ELSE 0 END), 0) AS usedToday,
                MAX(created_at) AS lastUsed
         FROM request_logs
         GROUP BY proxy_key_name`
      )
      .all(today) as Array<{ keyName: string; usedToday: number; lastUsed: string | null }>;
    return rows.map((r) => ({
      keyName: r.keyName,
      usedToday: Number(r.usedToday) || 0,
      lastUsed: r.lastUsed ?? null,
    }));
  }

  async vacuum(): Promise<void> {
    if (!this.db) return;
    this.db.exec('VACUUM');
  }

  async ping(): Promise<void> {
    if (!this.db) throw new Error('database not initialized');
    this.db.prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export async function logStoreFromConfig(_configPath?: string): Promise<LogStore> {
  const store = new SQLiteLogStore();
  await store.init();
  return store;
}
