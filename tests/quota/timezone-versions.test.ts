import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { QuotaTimezoneVersions } from '../../src/quota/timezone-versions.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

function temporaryDatabase(): { directory: string; dbPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-quota-zone-'));
  return { directory, dbPath: path.join(directory, 'telemetry.sqlite') };
}

test('initializes once and schedules, replaces, and cancels pending versions idempotently', async () => {
  const { directory, dbPath } = temporaryDatabase();
  const store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    const versions = new QuotaTimezoneVersions(store);
    const now = Date.parse('2026-09-23T12:00:00Z');
    const active = versions.initialize('UTC', now, 10);
    assert.equal(versions.initialize('Asia/Tokyo', now + 1000, 11).versionId, active.versionId);

    const scheduled = versions.schedule('Asia/Shanghai', now, 11);
    assert.equal(scheduled.active.versionId, active.versionId);
    assert.equal(scheduled.scheduled?.effectiveFromMs, Date.parse('2026-09-24T00:00:00Z'));
    assert.equal(versions.schedule('Asia/Shanghai', now, 12).scheduled?.versionId, scheduled.scheduled?.versionId);

    const replacement = versions.schedule('America/New_York', now + 1000, 13).scheduled;
    assert.ok(replacement);
    assert.notEqual(replacement.versionId, scheduled.scheduled?.versionId);
    assert.equal(
      versions.list().find((item) => item.versionId === scheduled.scheduled?.versionId)?.state,
      'superseded',
    );
    assert.equal(versions.schedule('UTC', now + 2000).scheduled, null);
    assert.equal(versions.cancelPending(), 0);
    assert.equal(versions.list().filter((item) => item.state === 'scheduled').length, 0);
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('restart preserves pending boundary without activating until admission reaches it', async () => {
  const { directory, dbPath } = temporaryDatabase();
  let store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    let versions = new QuotaTimezoneVersions(store);
    const now = Date.parse('2026-09-23T12:00:00Z');
    const active = versions.initialize('UTC', now);
    const scheduled = versions.schedule('Asia/Shanghai', now).scheduled;
    assert.ok(scheduled);
    await store.close();

    store = new SQLiteTelemetryStore(dbPath);
    await store.init();
    versions = new QuotaTimezoneVersions(store);
    assert.equal(versions.initialize('America/Los_Angeles', now + 1).timezone, 'UTC');
    assert.equal(versions.list().find((item) => item.versionId === scheduled.versionId)?.state, 'scheduled');

    const before = versions.resolveForAdmission(scheduled.effectiveFromMs - 1);
    assert.equal(before.versionId, active.versionId);
    assert.equal(versions.list().find((item) => item.versionId === scheduled.versionId)?.state, 'scheduled');
    const atBoundary = versions.resolveForAdmission(scheduled.effectiveFromMs);
    assert.equal(atBoundary.versionId, scheduled.versionId);
    assert.equal(atBoundary.timezone, 'Asia/Shanghai');
    assert.equal(atBoundary.startMs, scheduled.effectiveFromMs);
    assert.match(atBoundary.id, new RegExp(`^v${scheduled.versionId}:`));
    assert.equal(versions.list().find((item) => item.versionId === scheduled.versionId)?.state, 'active');
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('adds version metadata without rewriting legacy quota period rows or balances', async () => {
  const { directory, dbPath } = temporaryDatabase();
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE quota_periods (
    proxy_key_id TEXT NOT NULL, period_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
    reported_used INTEGER NOT NULL DEFAULT 0, estimated_used INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(proxy_key_id,period_id)
  )`);
  legacy
    .prepare(`INSERT INTO quota_periods
    (proxy_key_id,period_id,start_ms,end_ms,reported_used,estimated_used,reserved)
    VALUES ('key-legacy','2026-09-23',100,200,71,13,5)`)
    .run();
  legacy.close();

  const store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    const versions = new QuotaTimezoneVersions(store);
    versions.initialize('UTC', 150);
    const row = store.connection
      .prepare(`SELECT period_id,start_ms,end_ms,reported_used,estimated_used,reserved,timezone_version_id
        FROM quota_periods WHERE proxy_key_id='key-legacy'`)
      .get() as Record<string, unknown>;
    assert.deepEqual(row, {
      period_id: '2026-09-23',
      start_ms: 100,
      end_ms: 200,
      reported_used: 71,
      estimated_used: 13,
      reserved: 5,
      timezone_version_id: null,
    });
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('timezone change period IDs differ even when local date is the same', async () => {
  const { directory, dbPath } = temporaryDatabase();
  const store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    const versions = new QuotaTimezoneVersions(store);
    const now = Date.parse('2026-09-23T12:00:00Z');
    const old = versions.initialize('UTC', now);
    const scheduled = versions.schedule('America/Chicago', now).scheduled;
    assert.ok(scheduled);
    const before = versions.resolveForAdmission(now);
    const after = versions.resolveForAdmission(scheduled.effectiveFromMs);
    assert.equal(old.timezone, 'UTC');
    assert.equal(before.id.slice(before.id.indexOf(':') + 1), '2026-09-23');
    assert.equal(after.id.slice(after.id.indexOf(':') + 1), '2026-09-23');
    assert.notEqual(before.id, after.id);
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('scheduled boundary follows the active timezone calendar across DST', async () => {
  const { directory, dbPath } = temporaryDatabase();
  const store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    const versions = new QuotaTimezoneVersions(store);
    const atMs = Date.parse('2026-03-08T16:00:00Z');
    versions.initialize('America/New_York', atMs);
    const pending = versions.schedule('Asia/Shanghai', atMs).scheduled;
    assert.ok(pending);
    assert.equal(pending.effectiveFromMs, Date.parse('2026-03-09T04:00:00Z'));
  } finally {
    await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
