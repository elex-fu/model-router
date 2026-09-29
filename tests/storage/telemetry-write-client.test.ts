import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
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

test('queue overflow marks recorder degraded, refuses new writes/admission, and close drains accepted work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-telemetry-overflow-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const client = await TelemetryWriteClient.open(dbPath, { maxPending: 1 });
  let reader: SQLiteTelemetryStore | undefined;
  try {
    const first = client.upsertRequest(request('accepted'));
    await assert.rejects(client.upsertRequest(request('overflow')), TelemetryWriteQueueFullError);
    assert.equal(client.getStatus().degraded, true);
    assert.deepEqual(await client.admit(admission('blocked')), { allowed: false, reason: 'recorder_degraded' });
    await assert.rejects(client.upsertRequest(request('later')));
    await first;
    reader = new SQLiteTelemetryStore(dbPath);
    await reader.init();
    assert.ok(await reader.getRequest('accepted'));
    assert.equal(await reader.getRequest('overflow'), null);
  } finally {
    await client.close();
    await reader?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quota admission, attempt sent marker and settlement follow committed telemetry in worker order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-telemetry-quota-rpc-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const store = new SQLiteTelemetryStore(dbPath);
  let client: TelemetryWriteClient | undefined;
  try {
    await store.init();
    client = await TelemetryWriteClient.open(dbPath);
    await client.upsertRequest(request('quota-request'));
    assert.ok(await store.getRequest('quota-request'), 'request commit must precede the admission RPC');
    assert.deepEqual(await client.admit(admission('quota-request')), { allowed: true });
    await client.markAttemptSent('quota-request');
    await client.settle('quota-request', 37, 0);
    const balance = await new SQLiteQuotaLedger(store).balance('key-1', 'current-test-period');
    assert.deepEqual(balance, {
      reportedUsed: 37,
      estimatedUsed: 0,
      reserved: 0,
      adjustmentTokens: 0,
      activeRequests: 0,
    });
  } finally {
    await client?.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
