import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { initializeQuotaStore } from '../../src/quota/store.js';
import { QuotaWriteClient } from '../../src/quota/write-client.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import { TelemetryWriteClient, TelemetryWriteQueueFullError } from '../../src/storage/telemetry-write-client.js';
import type { RequestRecord } from '../../src/telemetry/types.js';

const request = (id: string): RequestRecord => ({
  id,
  proxyKeyId: 'key-1',
  source: 'production',
  clientProtocol: 'openai',
  requestModel: 'alias',
  routeId: 'route-1',
  configRevision: 1,
  state: 'admitted',
  finalHttpStatus: null,
  startedAtMs: Date.now(),
  endedAtMs: null,
  durationMs: null,
  firstByteMs: null,
  firstEventMs: null,
  firstTextMs: null,
  finalUpstreamId: null,
});
const admission = (requestId: string) => ({
  requestId,
  proxyKeyId: 'key-1',
  atMs: Date.now(),
  periodId: 'current-test-period',
  periodStartMs: 0,
  periodEndMs: Date.now() + 86_400_000,
  reserveTokens: 100,
  dailyTokens: 1_000,
  rpm: 10,
});
const waitFor = async (condition: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test('writer batches events atomically, retains a failed batch, and resolves only after recovery commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-telemetry-batch-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const reader = new SQLiteTelemetryStore(dbPath);
  let client: TelemetryWriteClient | undefined;
  try {
    await reader.init();
    reader.connection.exec(`CREATE TRIGGER fail_batch BEFORE INSERT ON requests
      WHEN NEW.id='req-b' BEGIN SELECT RAISE(ABORT, 'forced batch failure'); END`);
    client = await TelemetryWriteClient.open(dbPath);
    const writes = [client.upsertRequest(request('req-a')), client.upsertRequest(request('req-b'))];
    await waitFor(() => client!.getStatus().degraded);
    assert.equal(client.getStatus().retainedEvents, 2);
    assert.equal(await reader.getRequest('req-a'), null, 'the first row must roll back with the failed batch');
    let resolved = false;
    void Promise.all(writes).then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(resolved, false, 'callers must wait for durable commit');

    reader.connection.exec('DROP TRIGGER fail_batch');
    await Promise.all(writes);
    assert.ok(await reader.getRequest('req-a'));
    assert.ok(await reader.getRequest('req-b'));
    await waitFor(() => !client!.getStatus().degraded);
    assert.equal(client.getStatus().retainedEvents, 0);
    assert.equal(client.getStatus().degraded, false);
  } finally {
    await client?.close().catch(() => {});
    await reader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queue overflow counts dropped observations and resumes accepting writes after drain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-telemetry-overflow-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const client = await TelemetryWriteClient.open(dbPath, { maxPending: 1 });
  let reader: SQLiteTelemetryStore | undefined;
  try {
    const first = client.upsertRequest(request('accepted'));
    await assert.rejects(client.upsertRequest(request('overflow')), TelemetryWriteQueueFullError);
    assert.equal(client.getStatus().degraded, true);
    assert.equal(client.getStatus().droppedEvents,1);
    await first;
    await client.upsertRequest(request('later'));
    reader = new SQLiteTelemetryStore(dbPath);
    await reader.init();
    assert.ok(await reader.getRequest('accepted'));
    assert.equal(await reader.getRequest('overflow'), null);
    assert.ok(await reader.getRequest('later'));
  } finally {
    await client.close();
    await reader?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed observation batches cannot block the independent business ledger or usage recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-telemetry-quota-rpc-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const store = new SQLiteTelemetryStore(dbPath);
  const business=new Database(path.join(dir,'control.sqlite'));
  business.pragma('journal_mode=WAL');
  initializeQuotaStore(business);
  const quota=await QuotaWriteClient.open(business.name);
  let client: TelemetryWriteClient | undefined;
  try {
    await store.init();
    store.connection.exec("CREATE TRIGGER fail_logs BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT,'injected log failure'); END");
    client = await TelemetryWriteClient.open(dbPath,{flushIntervalMs:10});
    const logged=client.upsertRequest(request('quota-request'));
    await waitFor(()=>client!.getStatus().degraded);
    assert.deepEqual(await quota.admit(admission('quota-request')), { allowed: true });
    await quota.markAttemptSent('quota-request','attempt');
    await quota.recordAttemptUsage('quota-request','attempt',37);
    const ledger=new SQLiteQuotaLedger({connection:business});
    assert.equal(await ledger.recoverInterrupted(),1);
    const balance = await ledger.balance('key-1', 'current-test-period');
    assert.deepEqual(balance, {
      reportedUsed: 37,
      estimatedUsed: 0,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
    assert.equal(await store.getRequest('quota-request'),null);
    store.connection.exec('DROP TRIGGER fail_logs');
    await logged;
  } finally {
    await client?.close();
    await quota.close();
    business.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
