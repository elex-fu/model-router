import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SQLiteLogStore } from '../../src/logger/store.js';
import type { LogEntry } from '../../src/logger/types.js';

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = path.join(os.tmpdir(), `mr-logstore-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    path: path.join(dir, 'logs.sqlite'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function logEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    proxy_key_name: 'alice',
    client_ip: '127.0.0.1',
    client_protocol: 'anthropic',
    upstream_protocol: 'anthropic',
    request_model: 'claude',
    actual_model: 'claude',
    upstream_name: 'u1',
    status_code: 200,
    error_message: null,
    request_tokens: 100,
    response_tokens: 50,
    total_tokens: 150,
    duration_ms: 80,
    is_streaming: false,
    ...overrides,
  };
}

test('todayTokensByKey: returns empty when no logs exist', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.todayTokensByKey(today);
    assert.deepEqual(rows, []);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('todayTokensByKey: groups by proxy_key_name and sums tokens', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    await store.insertBatch([
      logEntry({ proxy_key_name: 'alice', request_tokens: 100, response_tokens: 50 }),
      logEntry({ proxy_key_name: 'alice', request_tokens: 30, response_tokens: 20 }),
      logEntry({ proxy_key_name: 'bob', request_tokens: 999, response_tokens: 1 }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.todayTokensByKey(today);
    const byName = new Map(rows.map((r) => [r.keyName, r.tokensUsed]));
    assert.equal(byName.get('alice'), 200);
    assert.equal(byName.get('bob'), 1000);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('todayTokensByKey: treats null tokens as zero', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    await store.insertBatch([
      logEntry({ proxy_key_name: 'alice', request_tokens: null, response_tokens: null }),
      logEntry({ proxy_key_name: 'alice', request_tokens: 50, response_tokens: null }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.todayTokensByKey(today);
    const byName = new Map(rows.map((r) => [r.keyName, r.tokensUsed]));
    assert.equal(byName.get('alice'), 50);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('statsByKey: counts requests, errors, rate_limited, tokens, latency', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    await store.insertBatch([
      logEntry({ proxy_key_name: 'alice', status_code: 200, duration_ms: 100, request_tokens: 50, response_tokens: 30 }),
      logEntry({ proxy_key_name: 'alice', status_code: 200, duration_ms: 200, request_tokens: 10, response_tokens: 5 }),
      logEntry({ proxy_key_name: 'alice', status_code: 500, duration_ms: 50, request_tokens: 0, response_tokens: 0 }),
      logEntry({ proxy_key_name: 'alice', status_code: 429, duration_ms: 5, request_tokens: 0, response_tokens: 0 }),
      logEntry({ proxy_key_name: 'bob', status_code: 200, duration_ms: 1, request_tokens: 1, response_tokens: 1 }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const stats = await store.statsByKey('alice', today, today);
    assert.equal(stats.requests, 4);
    assert.equal(stats.errors, 1);
    assert.equal(stats.rateLimited, 1);
    assert.equal(stats.inputTokens, 60);
    assert.equal(stats.outputTokens, 35);
    assert.equal(stats.totalTokens, 95);
    assert.ok(stats.avgLatencyMs > 0);
    assert.ok(stats.lastSeen);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('statsByKey: returns zeros when key has no logs in range', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const stats = await store.statsByKey('ghost', today, today);
    assert.equal(stats.requests, 0);
    assert.equal(stats.totalTokens, 0);
    assert.equal(stats.lastSeen, null);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('statsAllKeys: returns one row per key, ordered by total tokens desc', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    await store.insertBatch([
      logEntry({ proxy_key_name: 'low', request_tokens: 1, response_tokens: 0 }),
      logEntry({ proxy_key_name: 'high', request_tokens: 1000, response_tokens: 1000 }),
      logEntry({ proxy_key_name: 'mid', request_tokens: 100, response_tokens: 50 }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.statsAllKeys(today, today);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].keyName, 'high');
    assert.equal(rows[1].keyName, 'mid');
    assert.equal(rows[2].keyName, 'low');
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('purgeOlderThan: deletes logs older than N days, keeps recent', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    // direct SQL for timestamp control
    const dbAny = (store as any).db;
    dbAny
      .prepare(
        "INSERT INTO request_logs (proxy_key_name, is_streaming, created_at, status_code, duration_ms) VALUES ('old', 0, datetime('now', '-100 days'), 200, 1)"
      )
      .run();
    dbAny
      .prepare(
        "INSERT INTO request_logs (proxy_key_name, is_streaming, created_at, status_code, duration_ms) VALUES ('young', 0, datetime('now', '-1 days'), 200, 1)"
      )
      .run();
    const deleted = await store.purgeOlderThan(90);
    assert.equal(deleted, 1);
    const remaining = await store.queryLogs(10);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].proxy_key_name, 'young');
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('vacuum: runs without error on a non-empty db', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    await store.insertBatch([logEntry()]);
    await store.vacuum();
    const rows = await store.queryLogs(10);
    assert.equal(rows.length, 1);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('keyActivitySummary: returns usedToday and lastUsed per key', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    const dbAny = (store as any).db;
    dbAny
      .prepare(
        "INSERT INTO request_logs (proxy_key_name, is_streaming, created_at, status_code, request_tokens, response_tokens) VALUES ('alice', 0, datetime('now', '-2 days'), 200, 100, 50)"
      )
      .run();
    await store.insertBatch([
      logEntry({ proxy_key_name: 'alice', request_tokens: 30, response_tokens: 20 }),
      logEntry({ proxy_key_name: 'bob', request_tokens: 5, response_tokens: 5 }),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.keyActivitySummary(today);
    const byName = new Map(rows.map((r) => [r.keyName, r]));
    assert.equal(byName.get('alice')?.usedToday, 50);
    assert.ok(byName.get('alice')?.lastUsed);
    assert.equal(byName.get('bob')?.usedToday, 10);
    assert.ok(byName.get('bob')?.lastUsed);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('keyActivitySummary: lastUsed reflects all-time max not just today', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    const dbAny = (store as any).db;
    dbAny
      .prepare(
        "INSERT INTO request_logs (proxy_key_name, is_streaming, created_at, status_code) VALUES ('charlie', 0, datetime('now', '-30 days'), 200)"
      )
      .run();
    const today = new Date().toISOString().slice(0, 10);
    const rows = await store.keyActivitySummary(today);
    const charlie = rows.find((r) => r.keyName === 'charlie');
    assert.ok(charlie?.lastUsed);
    assert.equal(charlie?.usedToday, 0);
  } finally {
    await store.close?.();
    t.cleanup();
  }
});

test('init sets WAL mode', async () => {
  const t = tmpDb();
  const store = new SQLiteLogStore(t.path);
  await store.init();
  try {
    const db = (store as any).db;
    const mode = db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');
  } finally {
    await store.close?.();
    t.cleanup();
  }
});
