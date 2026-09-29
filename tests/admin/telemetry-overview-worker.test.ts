import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { detailFreshness, telemetryAdapters } from '../../src/admin/telemetry.js';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

test('overview/summary worker reflects late updates, separates retries, and flags unknown usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-overview-worker-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  const controlStore = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), controlStore);
  try {
    const now = Date.now();
    const from = new Date(now - 60_000).toISOString();
    const to = new Date(now + 60_000).toISOString();
    const request: RequestRecord = {
      id: 'logical-1',
      proxyKeyId: 'key-1',
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'alias',
      routeId: 'route-1',
      configRevision: 1,
      state: 'connecting',
      finalHttpStatus: null,
      startedAtMs: now - 1000,
      endedAtMs: null,
      durationMs: null,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    };
    const first: AttemptRecord = {
      id: 'try-1',
      requestId: request.id,
      ordinal: 1,
      upstreamId: 'up-1',
      credentialId: null,
      resolvedModel: 'real',
      reportedModel: null,
      protocol: 'openai',
      outcome: 'started',
      status: null,
      retryReason: null,
      startedAtMs: now - 900,
      endedAtMs: null,
      usage: null,
      pricingVersion: null,
      costMicros: null,
      currency: null,
    };
    await telemetry.upsertRequest(request);
    await telemetry.upsertAttempt(first);
    const adapters = telemetryAdapters(telemetry, control);
    const pending = adapters.usageSummary!({ from, to });
    let finished = false;
    void pending.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, 'detail scan must not finish synchronously on the proxy event loop');
    const initial = (await pending) as any;
    assert.equal(initial.logicalRequests, 1);
    assert.equal(initial.upstreamAttempts, 1);
    assert.equal(initial.inProgress, 1);
    assert.equal(initial.missingUsageAttempts, 1);
    assert.equal(initial.missingUsageRequests, 1);
    assert.equal(initial.inputTokens, 0);
    assert.equal(initial.partial, true);
    assert.equal(initial.freshness.coverage, 'exact-detail-snapshot');
    assert.equal(initial.freshness.status, 'current');

    await telemetry.upsertAttempt({ ...first, outcome: 'failed', status: 503, endedAtMs: now - 500 });
    await telemetry.upsertAttempt({
      ...first,
      id: 'try-2',
      ordinal: 2,
      startedAtMs: now - 400,
      outcome: 'completed',
      status: 200,
      endedAtMs: now,
      usage: {
        inputTotal: 7,
        inputUncached: 7,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: 3,
        reasoningOutput: null,
        status: 'reported',
        source: 'upstream',
        semanticsVersion: 'v2',
      },
    });
    await telemetry.upsertRequest({
      ...request,
      state: 'completed',
      finalHttpStatus: 200,
      endedAtMs: now,
      durationMs: 1000,
      firstByteMs: 12,
      firstEventMs: 25,
      firstTextMs: 42,
      finalUpstreamId: 'up-1',
    });
    const final = (await adapters.usageSummary!({ from, to })) as any;
    assert.equal(final.logicalRequests, 1); // two upstream attempts, one logical request
    assert.equal(final.upstreamAttempts, 2);
    assert.equal(final.completed, 1);
    assert.equal(final.inputTokens, 7);
    assert.equal(final.outputTokens, 3);
    assert.equal(final.missingUsageAttempts, 1);
    assert.equal(final.missingUsageRequests, 1);
    assert.ok(final.freshness.snapshotSequence > initial.freshness.snapshotSequence);
    assert.equal(final.freshness.stale, false);
    const overview = (await adapters.overview!({ from, to })) as any;
    assert.equal(overview.succeeded, 1);
    assert.equal(overview.firstTokenP95Ms, 42);
    assert.equal(overview.usage.upstreamAttempts, 2);
    assert.equal(overview.usage.partial, true);
    assert.equal(overview.freshness.coveredFromMs, Date.parse(from));

    const oldSnapshot = {
      watermark: { sequence: initial.freshness.snapshotSequence, updatedAtMs: 0 },
      snapshotStartedAtMs: Date.parse(from),
      snapshotCompletedAtMs: Date.parse(to),
      legacyMetadataCount: 0,
      legacyWritesTracked: true,
    };
    assert.equal(detailFreshness(telemetry, oldSnapshot, Date.parse(from), Date.parse(to)).status, 'stale');
  } finally {
    controlStore.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
