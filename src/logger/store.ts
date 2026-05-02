import Database from 'better-sqlite3';
import { DEFAULT_DB_PATH } from '../utils/paths.js';
import type { LogEntry, StatsResult } from './types.js';

export interface LogStore {
  init(): Promise<void>;
  insertBatch(entries: LogEntry[]): Promise<void>;
  queryLogs(limit: number, filter?: { keyName?: string; protocol?: 'anthropic' | 'openai' }): Promise<LogEntry[]>;
  stats(date: string): Promise<StatsResult>;
  close?(): Promise<void>;
}

export class SQLiteLogStore implements LogStore {
  private db?: Database.Database;

  async init(): Promise<void> {
    this.db = new Database(DEFAULT_DB_PATH);
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
