import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { QuotaTimezoneVersions } from '../../src/quota/timezone-versions.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('persistent quota admission, retry top-up, settlement and crash recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-quota-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  let store = new SQLiteTelemetryStore(dbPath);
  try {
    await store.init();
    let ledger = new SQLiteQuotaLedger(store);
    const base = {
      proxyKeyId: 'key-1',
      atMs: 100_000,
      periodId: '2026-09-23/UTC',
      periodStartMs: 0,
      periodEndMs: 86_400_000,
      reserveTokens: 60,
      dailyTokens: 100,
      rpm: 2,
      maxConcurrentRequests: 2,
    };
    assert.equal((await ledger.admit({ ...base, requestId: 'one' })).allowed, true);
    assert.equal((await ledger.admit({ ...base, requestId: 'one' })).allowed, true);
    assert.equal(
      (await ledger.admit({ ...base, requestId: 'zero', reserveTokens: 0, dailyTokens: 0 })).reason,
      'daily_tokens_exceeded',
    );
    assert.equal((await ledger.admit({ ...base, requestId: 'two' })).reason, 'daily_tokens_exceeded');
    assert.equal((await ledger.topUp('one', 41, 100)).allowed, false);
    assert.equal((await ledger.topUp('one', 20, 100)).allowed, true);
    await ledger.markAttemptSent('one');
    await store.close();
    store = new SQLiteTelemetryStore(dbPath);
    await store.init();
    ledger = new SQLiteQuotaLedger(store);
    assert.equal((await ledger.balance('key-1', base.periodId)).reserved, 80);
    assert.equal(await ledger.recoverInterrupted(), 1);
    assert.deepEqual(await ledger.balance('key-1', base.periodId), {
      reportedUsed: 0,
      estimatedUsed: 80,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
    await ledger.settle('one', 3);
    assert.equal((await ledger.balance('key-1', base.periodId)).estimatedUsed, 80);
    assert.equal((await ledger.admit({ ...base, requestId: 'two', reserveTokens: 20 })).allowed, true);
    await ledger.settle('two', 25);
    assert.equal((await ledger.balance('key-1', base.periodId)).reportedUsed, 25);
    await ledger.adjust('correction-1', 'key-1', base.periodId, -10, 'provider reconciliation');
    await ledger.adjust('correction-1', 'key-1', base.periodId, -10, 'provider reconciliation');
    assert.equal((await ledger.balance('key-1', base.periodId)).adjustmentTokens, -10);
    assert.equal((await ledger.balance('key-1', base.periodId)).reportedUsed, 25);
    assert.equal((await ledger.admit({ ...base, requestId: 'three', reserveTokens: 0 })).reason, 'rpm_exceeded');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('versioned quota admissions activate scheduled timezone only at the boundary and persist the version', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-quota-versions-'));
  const store = new SQLiteTelemetryStore(path.join(dir, 'logs.sqlite'));
  try {
    await store.init();
    const ledger = new SQLiteQuotaLedger(store);
    const versions = new QuotaTimezoneVersions(store);
    const scheduledAt = Date.parse('2026-09-23T12:00:00Z');
    const active = versions.initialize('UTC', scheduledAt);
    const scheduled = versions.schedule('Asia/Shanghai', scheduledAt).scheduled;
    assert.ok(scheduled);

    const before = versions.resolveForAdmission(scheduled.effectiveFromMs - 1);
    assert.equal(before.versionId, active.versionId);
    assert.equal(versions.list().find((version) => version.versionId === scheduled.versionId)?.state, 'scheduled');
    assert.equal(
      (
        await ledger.admit({
          requestId: 'before-boundary',
          proxyKeyId: 'key',
          atMs: scheduled.effectiveFromMs - 1,
          periodId: before.id,
          periodStartMs: before.startMs,
          periodEndMs: before.endMs,
          timezoneVersionId: before.versionId,
          reserveTokens: 10,
        })
      ).allowed,
      true,
    );

    const atBoundary = versions.resolveForAdmission(scheduled.effectiveFromMs);
    assert.equal(atBoundary.versionId, scheduled.versionId);
    assert.equal(atBoundary.timezone, 'Asia/Shanghai');
    assert.equal(versions.list().find((version) => version.versionId === scheduled.versionId)?.state, 'active');
    assert.equal(
      (
        await ledger.admit({
          requestId: 'at-boundary',
          proxyKeyId: 'key',
          atMs: scheduled.effectiveFromMs,
          periodId: atBoundary.id,
          periodStartMs: atBoundary.startMs,
          periodEndMs: atBoundary.endMs,
          timezoneVersionId: atBoundary.versionId,
          reserveTokens: 10,
        })
      ).allowed,
      true,
    );

    const persisted = store.connection
      .prepare('SELECT period_id, timezone_version_id FROM quota_periods ORDER BY period_id')
      .all() as Array<{ period_id: string; timezone_version_id: number | null }>;
    assert.equal(persisted.find((row) => row.period_id === before.id)?.timezone_version_id, active.versionId);
    assert.equal(persisted.find((row) => row.period_id === atBoundary.id)?.timezone_version_id, scheduled.versionId);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settlement and crash recovery keep an admitted request in its original versioned period', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-quota-boundary-'));
  const store = new SQLiteTelemetryStore(path.join(dir, 'logs.sqlite'));
  try {
    await store.init();
    const ledger = new SQLiteQuotaLedger(store);
    const versions = new QuotaTimezoneVersions(store);
    const scheduledAt = Date.parse('2026-09-23T12:00:00Z');
    versions.initialize('UTC', scheduledAt);
    const scheduled = versions.schedule('Asia/Shanghai', scheduledAt).scheduled;
    assert.ok(scheduled);
    const original = versions.resolveForAdmission(scheduled.effectiveFromMs - 10);
    const base = {
      proxyKeyId: 'key',
      atMs: scheduled.effectiveFromMs - 10,
      periodId: original.id,
      periodStartMs: original.startMs,
      periodEndMs: original.endMs,
      timezoneVersionId: original.versionId,
      reserveTokens: 20,
    };
    assert.equal((await ledger.admit({ ...base, requestId: 'settled-after-boundary' })).allowed, true);
    assert.equal((await ledger.admit({ ...base, requestId: 'recovered-after-boundary' })).allowed, true);
    await ledger.markAttemptSent('recovered-after-boundary');

    const next = versions.resolveForAdmission(scheduled.effectiveFromMs);
    assert.equal(next.versionId, scheduled.versionId);
    assert.equal(
      (
        await ledger.admit({
          requestId: 'new-version-request',
          proxyKeyId: 'key',
          atMs: scheduled.effectiveFromMs,
          periodId: next.id,
          periodStartMs: next.startMs,
          periodEndMs: next.endMs,
          timezoneVersionId: next.versionId,
          reserveTokens: 5,
        })
      ).allowed,
      true,
    );
    await ledger.markAttemptSent('new-version-request');

    await ledger.settle('settled-after-boundary', 13);
    assert.equal(await ledger.recoverInterrupted(), 2);
    assert.deepEqual(await ledger.balance('key', original.id), {
      reportedUsed: 13,
      estimatedUsed: 20,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
    assert.deepEqual(await ledger.balance('key', next.id), {
      reportedUsed: 0,
      estimatedUsed: 5,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
