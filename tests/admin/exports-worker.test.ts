import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { AdminExports, runExportWorker } from '../../src/admin/exports.js';
import { AdminJobs } from '../../src/admin/jobs.js';
import type { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mr-export-worker-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const telemetry = new SQLiteTelemetryStore(dbPath);
  await telemetry.init();
  const controlDb = new Database(':memory:');
  const audits: Array<{ actor: string; action: string }> = [];
  const store = {
    db: controlDb,
    audit: (actor: string, action: string) => {
      audits.push({ actor, action });
    },
  } as ControlStore;
  const jobs = new AdminJobs(store);
  const exports = new AdminExports(store, telemetry, jobs, dir);
  const now = Date.now();
  const insert = telemetry.connection.prepare(`INSERT INTO requests
    (id,source,client_protocol,request_model,state,started_at_ms,proxy_key_id,final_http_status)
    VALUES (?,?,?,?,?,?,?,?)`);
  const seed = (id: string, model = 'model') =>
    insert.run(id, 'production', 'openai', model, 'completed', now, 'key', 200);
  const input = (format: 'csv' | 'json', name: string) => ({
    dbPath,
    destination: join(dir, 'admin-exports', `${name}.${format}`),
    temporary: join(dir, 'admin-exports', `.${name}.${format}.part`),
    format,
    from: now - 1000,
    to: now + 1000,
    source: 'production',
  });
  const close = async () => {
    jobs.close();
    controlDb.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, dbPath, telemetry, exports, jobs, audits, seed, input, close };
}

test('worker uses file-backed read-only SQLite and preserves CSV escaping and permissions', async () => {
  const f = await fixture();
  try {
    f.seed('req_1', '  =HYPERLINK("bad")');
    const input = f.input('csv', 'csv');
    const rows = await runExportWorker(input, new AbortController().signal);
    assert.equal(rows, 1);
    const csv = readFileSync(input.destination, 'utf8');
    assert.match(csv, /requestId,source,startedAt/);
    assert.match(csv, /'  =HYPERLINK\(""bad""\)/);
    assert.equal(statSync(input.destination).mode & 0o777, 0o600);
    assert.equal(existsSync(input.temporary), false);
  } finally {
    await f.close();
  }
});

test('10k row and 5 MB limits fail without leaving output files', async () => {
  const f = await fixture();
  try {
    const insertMany = f.telemetry.connection.transaction(() => {
      for (let i = 0; i < 10_001; i++) f.seed(`req_${i}`);
    });
    insertMany();
    const tooMany = f.input('json', 'too-many');
    await assert.rejects(runExportWorker(tooMany, new AbortController().signal), /10,000 requests/);
    assert.equal(existsSync(tooMany.destination), false);
    assert.equal(existsSync(tooMany.temporary), false);
    f.telemetry.connection.prepare("DELETE FROM requests WHERE id='req_10000'").run();
    const boundary = f.input('csv', 'boundary');
    assert.equal(await runExportWorker(boundary, new AbortController().signal), 10_000);
    f.telemetry.connection.prepare('DELETE FROM requests').run();
    f.seed('large', 'x'.repeat(5_000_000));
    const tooLarge = f.input('csv', 'too-large');
    await assert.rejects(runExportWorker(tooLarge, new AbortController().signal), /5 MB/);
    assert.equal(existsSync(tooLarge.destination), false);
    assert.equal(existsSync(tooLarge.temporary), false);
  } finally {
    await f.close();
  }
});

test('query failure after opening output removes the partial file', async () => {
  const f = await fixture();
  try {
    const invalidDate = 8_640_000_000_000_001;
    f.telemetry.connection
      .prepare(`INSERT INTO requests
      (id,source,client_protocol,request_model,state,started_at_ms)
      VALUES ('bad-date','production','openai','model','completed',?)`)
      .run(invalidDate);
    const input = { ...f.input('csv', 'failed-query'), from: invalidDate - 100, to: invalidDate + 100 };
    await assert.rejects(runExportWorker(input, new AbortController().signal), /Invalid time value/);
    assert.equal(existsSync(input.destination), false);
    assert.equal(existsSync(input.temporary), false);
  } finally {
    await f.close();
  }
});

test('abort and timeout wait for worker exit and remove partial files', async () => {
  const f = await fixture();
  try {
    f.seed('req_1');
    const cancelled = f.input('json', 'cancelled');
    const controller = new AbortController();
    const pending = runExportWorker(cancelled, controller.signal);
    controller.abort();
    await assert.rejects(pending, /Export cancelled/);
    assert.equal(existsSync(cancelled.destination), false);
    assert.equal(existsSync(cancelled.temporary), false);
    const timedOut = f.input('json', 'timed-out');
    await assert.rejects(runExportWorker(timedOut, new AbortController().signal, 1), /Export timed out/);
    assert.equal(existsSync(timedOut.destination), false);
    assert.equal(existsSync(timedOut.temporary), false);
  } finally {
    await f.close();
  }
});

test('AdminExports records actor and audit while job runs worker', async () => {
  const f = await fixture();
  try {
    f.seed('req_1');
    const created = f.exports.create(
      {
        type: 'usage',
        format: 'json',
        filters: {
          from: new Date(Date.now() - 1000).toISOString(),
          to: new Date(Date.now() + 1000).toISOString(),
        },
      },
      'admin',
    );
    assert.equal(created.status, 'queued');
    assert.ok(f.audits.some((entry) => entry.actor === 'admin' && entry.action === 'export.create'));
    let job = f.jobs.get(created.jobId);
    for (let i = 0; i < 200 && !['completed', 'failed'].includes(job.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = f.jobs.get(created.jobId);
    }
    assert.equal(job.state, 'completed', job.error ?? '');
    assert.equal((job.result as { rows: number }).rows, 1);
    assert.equal(
      readdirSync(join(f.dir, 'admin-exports')).some((name) => name.includes('.part')),
      false,
    );
    assert.throws(() => f.exports.download(created.exportId, 'other', {} as never), /Export belongs to another user/);
  } finally {
    await f.close();
  }
});

test('memory-backed telemetry fails export explicitly without a main-thread query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-export-memory-'));
  const telemetry = new SQLiteTelemetryStore(':memory:');
  await telemetry.init();
  const controlDb = new Database(':memory:');
  const store = { db: controlDb, audit: () => {} } as unknown as ControlStore;
  const jobs = new AdminJobs(store);
  const exports = new AdminExports(store, telemetry, jobs, dir);
  try {
    assert.throws(
      () => exports.create({ type: 'requests' }, 'admin'),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 503,
    );
    assert.deepEqual(readdirSync(join(dir, 'admin-exports')), []);
  } finally {
    jobs.close();
    controlDb.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
