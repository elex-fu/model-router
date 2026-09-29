import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('native write watermark advances transactionally on late updates and ignores terminal replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-query-watermark-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  try {
    const at = Date.now();
    const request = {
      id: 'request-1',
      proxyKeyId: null,
      source: 'production' as const,
      clientProtocol: 'openai' as const,
      requestModel: 'model',
      routeId: null,
      configRevision: 1,
      state: 'received' as const,
      finalHttpStatus: null,
      startedAtMs: at,
      endedAtMs: null,
      durationMs: null,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    };
    const initial = store.writeWatermark.sequence;
    await store.upsertRequest(request);
    const inserted = store.writeWatermark.sequence;
    assert.equal(inserted, initial + 1);
    await store.upsertRequest({
      ...request,
      state: 'completed',
      finalHttpStatus: 200,
      endedAtMs: at + 10,
      durationMs: 10,
    });
    const completed = store.writeWatermark.sequence;
    assert.equal(completed, inserted + 1);
    await store.upsertRequest({
      ...request,
      state: 'completed',
      finalHttpStatus: 200,
      endedAtMs: at + 10,
      durationMs: 10,
    });
    assert.equal(store.writeWatermark.sequence, completed);
    const attempt = {
      id: 'attempt-1',
      requestId: request.id,
      ordinal: 1,
      upstreamId: 'up-1',
      credentialId: null,
      resolvedModel: 'model',
      reportedModel: null,
      protocol: 'openai' as const,
      outcome: 'started' as const,
      status: null,
      retryReason: null,
      startedAtMs: at,
      endedAtMs: null,
      usage: null,
      pricingVersion: null,
      costMicros: null,
      currency: null,
    };
    await store.upsertAttempt(attempt);
    const attemptStarted = store.writeWatermark.sequence;
    assert.equal(attemptStarted, completed + 1);
    await store.upsertAttempt({ ...attempt, outcome: 'completed', status: 200, endedAtMs: at + 10 });
    const attemptFinished = store.writeWatermark.sequence;
    assert.equal(attemptFinished, attemptStarted + 1);
    await store.upsertAttempt({ ...attempt, outcome: 'completed', status: 200, endedAtMs: at + 10 });
    assert.equal(store.writeWatermark.sequence, attemptFinished);
    store.connection.prepare('DELETE FROM attempts WHERE id=?').run(attempt.id);
    assert.equal(store.writeWatermark.sequence, attemptFinished + 1);
    store.connection.prepare('DELETE FROM requests WHERE id=?').run(request.id);
    assert.equal(store.writeWatermark.sequence, attemptFinished + 2);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
