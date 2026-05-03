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
