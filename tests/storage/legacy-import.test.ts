import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SQLiteLogStore } from '../../src/logger/store.js';
import type { LogEntry } from '../../src/logger/types.js';
import {
  importLegacyRequestLogs,
  LEGACY_UNKNOWN_UPSTREAM_ID,
  UnsafeLegacyImportError,
} from '../../src/storage/legacy-import.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    proxy_key_name: 'Alice',
    client_ip: null,
    client_protocol: 'openai',
    upstream_protocol: 'openai',
    request_model: 'alias',
    actual_model: 'real',
    upstream_name: 'Provider A',
    status_code: 200,
    error_message: null,
    request_tokens: 100,
    response_tokens: 20,
    total_tokens: 120,
    cache_read_tokens: 60,
    cache_creation_tokens: null,
    first_token_ms: 4,
    duration_ms: 10,
    is_streaming: false,
    created_at: '2026-09-23T00:00:00.000Z',
    ...overrides,
  };
}

test('imports bounded batches once, maps names, and never imports later V2 log copies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-legacy-import-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const logs = new SQLiteLogStore(dbPath);
  const telemetry = new SQLiteTelemetryStore(dbPath);
  try {
    await logs.init();
    await telemetry.init();
    await logs.insertBatch([
      entry(),
      entry({
        upstream_protocol: 'anthropic',
        client_protocol: 'anthropic',
        request_tokens: 40,
        response_tokens: 20,
        cache_read_tokens: 60,
        cache_creation_tokens: 10,
      }),
      entry({
        proxy_key_name: 'unmapped',
        upstream_name: 'unknown supplier',
        client_protocol: null,
        upstream_protocol: null,
        request_tokens: 9,
        response_tokens: 2,
        cache_read_tokens: null,
        cache_creation_tokens: null,
      }),
    ]);
    const options = {
      batchSize: 1,
      proxyKeyIdsByName: { Alice: 'key-alice' },
      upstreamIdsByName: new Map([['Provider A', 'up-a']]),
    };
    const first = await importLegacyRequestLogs(telemetry, options);
    assert.deepEqual(first, { completed: true, sourceCutoffId: 3, importedRows: 3, alreadyCompleted: false });
    const one = await telemetry.getRequest('legacy-log-row:1');
    assert.equal(one?.request.proxyKeyId, 'key-alice');
    assert.equal(one?.request.finalUpstreamId, 'up-a');
    assert.equal(one?.attempts[0].usage?.inputTotal, 100);
    assert.equal(one?.attempts[0].usage?.status, 'reported');
    assert.equal(one?.attempts[0].usage?.source, 'legacy');
    assert.equal(one?.request.firstTextMs, null);
    const two = await telemetry.getRequest('legacy-log-row:2');
    assert.equal(two?.attempts[0].usage?.inputTotal, 110);
    const three = await telemetry.getRequest('legacy-log-row:3');
    assert.equal(three?.request.clientProtocol, 'unknown');
    assert.equal(three?.attempts[0].protocol, 'unknown');
    assert.equal(three?.attempts[0].upstreamId, LEGACY_UNKNOWN_UPSTREAM_ID);
    assert.equal(three?.request.proxyKeyId, null);
    assert.equal(three?.attempts[0].usage?.inputTotal, null);
    assert.equal(three?.attempts[0].usage?.status, 'missing');
    const summary = await telemetry.summary(Date.parse('2026-09-23T00:00:00Z'), Date.parse('2026-09-24T00:00:00Z'));
    assert.equal(summary.logicalRequests, 0);
    assert.equal(summary.legacyLogRows, 3);
    assert.equal(summary.upstreamAttempts, 3);
    const meta = telemetry.connection
      .prepare(`SELECT measurement, proxy_key_name,
      upstream_name, request_tokens, first_token_ms FROM legacy_request_metadata
      WHERE source_row_id=3`)
      .get() as any;
    assert.deepEqual(meta, {
      measurement: 'legacy_log_rows',
      proxy_key_name: 'unmapped',
      upstream_name: 'unknown supplier',
      request_tokens: 9,
      first_token_ms: 4,
    });
    await logs.insertBatch([entry({ request_tokens: 999 })]);
    const second = await importLegacyRequestLogs(telemetry, options);
    assert.equal(second.alreadyCompleted, true);
    assert.equal(second.sourceCutoffId, 3);
    assert.equal(await telemetry.getRequest('legacy-log-row:4'), null);
  } finally {
    await telemetry.close();
    await logs.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resumes after a failed batch without duplicating committed rows or expanding cutoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-legacy-restart-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const logs = new SQLiteLogStore(dbPath);
  let telemetry = new SQLiteTelemetryStore(dbPath);
  try {
    await logs.init();
    await telemetry.init();
    await logs.insertBatch([entry(), entry({ created_at: 'not-a-date' })]);
    await assert.rejects(importLegacyRequestLogs(telemetry, { batchSize: 1 }), /row 2/);
    const state = telemetry.connection
      .prepare(`SELECT cutoff_id, last_id, imported_rows,
      status FROM legacy_import_state`)
      .get() as any;
    assert.deepEqual(state, { cutoff_id: 2, last_id: 1, imported_rows: 1, status: 'running' });
    await logs.insertBatch([entry()]);
    telemetry.connection.prepare(`UPDATE request_logs SET created_at=? WHERE id=2`).run('2026-09-23 01:02:03');
    await telemetry.close();
    telemetry = new SQLiteTelemetryStore(dbPath);
    await telemetry.init();
    const done = await importLegacyRequestLogs(telemetry, { batchSize: 1 });
    assert.equal(done.importedRows, 2);
    assert.equal(done.sourceCutoffId, 2);
    assert.equal(await telemetry.getRequest('legacy-log-row:3'), null);
    assert.equal((await telemetry.listRequests()).items.length, 2);
    assert.equal(
      (await telemetry.getRequest('legacy-log-row:2'))?.request.startedAtMs,
      Date.parse('2026-09-23T01:02:03Z'),
    );
  } finally {
    await telemetry.close();
    await logs.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old narrow request_logs schema preserves unknown fields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-legacy-narrow-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE request_logs (id INTEGER PRIMARY KEY, proxy_key_name TEXT,
    created_at TEXT, status_code INTEGER);`);
  db.prepare(`INSERT INTO request_logs VALUES (1, 'old', '2026-09-23 02:00:00', 503)`).run();
  db.close();
  const telemetry = new SQLiteTelemetryStore(dbPath);
  try {
    await telemetry.init();
    await importLegacyRequestLogs(telemetry);
    const row = await telemetry.getRequest('legacy-log-row:1');
    assert.equal(row?.request.state, 'failed');
    assert.equal(row?.request.clientProtocol, 'unknown');
    assert.equal(row?.attempts[0].usage?.status, 'missing');
    assert.equal(row?.attempts[0].usage?.inputTotal, null);
  } finally {
    await telemetry.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh database records a completed zero-row marker before V2 creates request_logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-legacy-fresh-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const telemetry = new SQLiteTelemetryStore(dbPath);
  const logs = new SQLiteLogStore(dbPath);
  try {
    await telemetry.init();
    const first = await importLegacyRequestLogs(telemetry);
    assert.equal(first.sourceCutoffId, 0);
    assert.equal(first.alreadyCompleted, false);
    await logs.init();
    await logs.insertBatch([entry()]);
    const second = await importLegacyRequestLogs(telemetry);
    assert.equal(second.alreadyCompleted, true);
    assert.equal(second.importedRows, 0);
    assert.equal(await telemetry.getRequest('legacy-log-row:1'), null);
  } finally {
    await telemetry.close();
    await logs.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses first import when native V2 requests predate its marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-legacy-unsafe-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const telemetry = new SQLiteTelemetryStore(dbPath);
  const logs = new SQLiteLogStore(dbPath);
  try {
    await telemetry.init();
    await logs.init();
    await telemetry.upsertRequest({
      id: 'native-v2-request',
      proxyKeyId: 'key-1',
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'alias',
      routeId: null,
      configRevision: 2,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: 1_000,
      endedAtMs: 1_100,
      durationMs: 100,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    await logs.insertBatch([entry(), entry({ request_tokens: 999 })]);
    for (let run = 0; run < 2; run++) {
      await assert.rejects(importLegacyRequestLogs(telemetry, { batchSize: 1 }), (error: unknown) => {
        assert.ok(error instanceof UnsafeLegacyImportError);
        assert.equal(error.code, 'legacy_import_unsafe_native_requests');
        assert.match(error.message, /pre-V2 backup/);
        return true;
      });
    }
    assert.equal(
      (telemetry.connection.prepare('SELECT COUNT(*) AS n FROM legacy_import_state').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (telemetry.connection.prepare('SELECT COUNT(*) AS n FROM legacy_request_metadata').get() as { n: number }).n,
      0,
    );
    assert.equal((await telemetry.listRequests()).items.length, 1);
    assert.equal(await telemetry.getRequest('legacy-log-row:1'), null);
    assert.equal((await logs.queryLogs(10)).length, 2);
  } finally {
    await telemetry.close();
    await logs.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
