import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SQLiteLogStore } from '../../src/logger/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import { TelemetryWriteClient } from '../../src/storage/telemetry-write-client.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';
import { normalizeUsage } from '../../src/telemetry/usage.js';

export function fixtureRequest(id: string, startedAtMs = 1000): RequestRecord {
  return {
    id,
    proxyKeyId: 'key-1',
    source: 'production',
    clientProtocol: 'openai',
    requestModel: 'alias',
    routeId: 'route-1',
    configRevision: 2,
    state: 'admitted',
    finalHttpStatus: null,
    startedAtMs,
    endedAtMs: null,
    durationMs: null,
    firstByteMs: null,
    firstEventMs: null,
    firstTextMs: null,
    finalUpstreamId: null,
  };
}
export function fixtureAttempt(id: string, requestId: string, ordinal: number): AttemptRecord {
  return {
    id,
    requestId,
    ordinal,
    upstreamId: 'upstream-1',
    credentialId: 'credential-1',
    resolvedModel: 'real',
    reportedModel: null,
    protocol: 'openai',
    outcome: 'started',
    status: null,
    retryReason: null,
    startedAtMs: 1000,
    endedAtMs: null,
    usage: null,
    pricingVersion: null,
    costMicros: null,
    currency: null,
  };
}

test('request/attempt upsert is idempotent, paginates ties, and coexists with legacy logs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-telemetry-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const legacy = new SQLiteLogStore(dbPath);
  const store = new SQLiteTelemetryStore(dbPath);
  try {
    await legacy.init();
    await store.init();
    await store.upsertRequest(fixtureRequest('a'));
    await store.upsertRequest(fixtureRequest('b'));
    await store.upsertRequest(fixtureRequest('c', 2000));
    const first = await store.listRequests({ limit: 2 });
    assert.deepEqual(
      first.items.map((r) => r.id),
      ['c', 'b'],
    );
    assert.deepEqual(
      (await store.listRequests({ limit: 2, cursor: first.nextCursor! })).items.map((r) => r.id),
      ['a'],
    );
    const a = fixtureRequest('a');
    a.state = 'completed';
    a.finalHttpStatus = 200;
    a.endedAtMs = 1100;
    await store.upsertRequest(a);
    await store.upsertRequest(a);
    await store.upsertRequest(fixtureRequest('a'));
    const fail = fixtureAttempt('attempt-1', 'a', 1);
    fail.outcome = 'failed';
    fail.status = 500;
    fail.usage = normalizeUsage('openai', { prompt_tokens: 5, completion_tokens: 1 });
    await store.upsertAttempt(fail);
    const success = fixtureAttempt('attempt-2', 'a', 2);
    await store.upsertAttempt(success);
    const completedSuccess = {
      ...success,
      outcome: 'completed' as const,
      status: 200,
      endedAtMs: 1100,
      usage: normalizeUsage('openai', { prompt_tokens: 10, completion_tokens: 2 }),
      pricingVersion: 'pv_attempt_2',
      costMicros: 125,
      currency: 'USD',
    };
    await store.upsertAttempt(completedSuccess);
    await store.upsertAttempt(completedSuccess);
    await store.upsertAttempt(fixtureAttempt('attempt-2', 'a', 2));
    const detail = await store.getRequest('a');
    assert.equal(detail?.attempts.length, 2);
    assert.equal(detail?.request.state, 'completed');
    assert.equal(detail?.attempts[1].outcome, 'completed');
    assert.equal(detail?.attempts[1].pricingVersion, 'pv_attempt_2');
    assert.equal(detail?.attempts[1].costMicros, 125);
    const summary = await store.summary(0, 3000);
    assert.equal(summary.logicalRequests, 3);
    assert.equal(summary.upstreamAttempts, 2);
    assert.equal(summary.inputTokens, 15);
    assert.equal(summary.outputTokens, 3);
    assert.equal(summary.completed, 1);
    assert.equal((await legacy.queryLogs(10)).length, 0);
  } finally {
    await store.close();
    await legacy.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy log batches coexist with concurrent telemetry writes under transient SQLite writer contention', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-shared-writers-'));
  const dbPath = path.join(dir, 'logs.sqlite');
  const legacy = new SQLiteLogStore(dbPath);
  const telemetry = await TelemetryWriteClient.open(dbPath);
  const verify = new Database(dbPath);
  let lockHolder: Worker | undefined;
  try {
    await legacy.init();
    assert.equal((legacy as any).db.pragma('busy_timeout', { simple: true }), 5000);
    lockHolder = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       const Database = require('better-sqlite3');
       const db = new Database(workerData.dbPath);
       db.exec('BEGIN IMMEDIATE');
       parentPort.postMessage('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }, 150);`,
      { eval: true, workerData: { dbPath } },
    );
    await new Promise<void>((resolve, reject) => {
      lockHolder!.once('message', (message) => (message === 'locked' ? resolve() : reject(new Error(String(message)))));
      lockHolder!.once('error', reject);
    });

    const telemetryWrites = Array.from({ length: 100 }, (_, i) =>
      telemetry.upsertRequest({
        ...fixtureRequest(`concurrent-${i}`),
        startedAtMs: 10_000 + i,
      }),
    );
    const quotaAdmission = telemetry.admit({
      requestId: 'quota-during-contention',
      proxyKeyId: 'key-1',
      atMs: 10_000,
      periodId: 'test-period',
      periodStartMs: 0,
      periodEndMs: 60_000,
      reserveTokens: 10,
    });
    for (let batch = 0; batch < 20; batch++) {
      await legacy.insertBatch(
        Array.from({ length: 5 }, (_, i) => ({
          proxy_key_name: 'legacy',
          client_ip: '127.0.0.1',
          client_protocol: 'openai' as const,
          upstream_protocol: 'openai' as const,
          request_model: `test-${batch}-${i}`,
          actual_model: `test-${batch}-${i}`,
          upstream_name: 'mock',
          status_code: 200,
          error_message: null,
          request_tokens: 1,
          response_tokens: 1,
          total_tokens: 2,
          cache_read_tokens: null,
          cache_creation_tokens: null,
          first_token_ms: null,
          duration_ms: 1,
          is_streaming: false,
        })),
      );
    }
    await Promise.all(telemetryWrites);
    assert.equal((await quotaAdmission).allowed, true);
    assert.equal(telemetry.getStatus().degraded, false);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM request_logs').get().count, 100);
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM requests').get().count, 100);
  } finally {
    await lockHolder?.terminate();
    verify.close();
    await telemetry.close();
    await legacy.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
