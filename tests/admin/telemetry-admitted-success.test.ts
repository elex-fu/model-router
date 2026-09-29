import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { telemetryAdapters } from '../../src/admin/telemetry.js';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord, RequestState, TrafficSource } from '../../src/telemetry/types.js';

test('overview uses completed / ended admitted production requests on detail and live paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admitted-rate-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  const controlStore = new ControlStore(dir);
  try {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const startedAtMs = base - 60_000;
    const make = (id: string, source: TrafficSource = 'production'): RequestRecord => ({
      id,
      proxyKeyId: id === 'auth' ? null : 'key',
      source,
      clientProtocol: 'openai',
      requestModel: 'alias',
      routeId: 'route',
      configRevision: 1,
      state: 'received',
      finalHttpStatus: null,
      startedAtMs,
      endedAtMs: null,
      durationMs: null,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    const finish = async (record: RequestRecord, state: RequestState, status: number) => {
      await store.upsertRequest({
        ...record,
        state,
        finalHttpStatus: status,
        endedAtMs: startedAtMs + 1000,
        durationMs: 1000,
      });
    };
    const auth = make('auth');
    await store.upsertRequest({
      ...auth,
      state: 'rejected',
      finalHttpStatus: 401,
      endedAtMs: startedAtMs + 1000,
      durationMs: 1000,
    });
    const quota = make('quota');
    await store.upsertRequest(quota);
    await finish(quota, 'rejected', 429);

    for (const [id, state, status] of [
      ['success', 'completed', 200],
      ['failed', 'failed', 502],
      ['cancelled', 'cancelled', 499],
      ['after-admission-reject', 'rejected', 429],
    ] as const) {
      const record = make(id);
      await store.upsertRequest(record);
      await store.upsertRequest({ ...record, state: 'admitted' });
      await finish(record, state, status);
    }
    const playground = make('playground', 'playground');
    await store.upsertRequest(playground);
    await store.upsertRequest({ ...playground, state: 'admitted' });
    await finish(playground, 'completed', 200);

    const attempt = (id: string, ordinal: number): AttemptRecord => ({
      id,
      requestId: 'success',
      ordinal,
      upstreamId: 'upstream',
      credentialId: null,
      resolvedModel: 'real',
      reportedModel: null,
      protocol: 'openai',
      outcome: ordinal === 1 ? 'failed' : 'completed',
      status: ordinal === 1 ? 503 : 200,
      retryReason: null,
      startedAtMs: startedAtMs + ordinal,
      endedAtMs: startedAtMs + 100 + ordinal,
      usage: null,
      pricingVersion: null,
      costMicros: null,
      currency: null,
    });
    await store.upsertAttempt(attempt('try-1', 1));
    await store.upsertAttempt(attempt('try-2', 2));
    const adapters = telemetryAdapters(store, new ControlService(join(dir, 'config.json'), controlStore));
    const detail = (await adapters.overview!({
      from: new Date(base - 2 * 60_000).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    })) as any;
    assert.equal(detail.freshness.coverage, 'exact-detail-snapshot');
    assert.equal(detail.logicalRequests, 6);
    assert.equal(detail.usage.upstreamAttempts, 2);
    assert.deepEqual(detail.productionSuccessRate, {
      scope: 'production',
      definition: 'completed / ended admitted production logical requests',
      status: 'exact',
      value: 0.25,
      completed: 1,
      endedAdmitted: 4,
      excludedPreAdmissionRejected: 2,
      unknownAdmissionEnded: 0,
      excludedLegacyLogRows: 0,
      measurement: 'exact_detail_snapshot',
    });
    const live = (await adapters.overview!({
      from: new Date(base - 12 * 60_000).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    })) as any;
    assert.equal(live.freshness.coverage, 'live-minute+detail-tails');
    assert.equal(live.productionSuccessRate.value, 0.25);
    assert.equal(live.productionSuccessRate.endedAdmitted, 4);
    assert.equal(live.productionSuccessRate.excludedPreAdmissionRejected, 2);
    assert.equal(live.productionSuccessRate.measurement, 'covered_live_minute_plus_detail_tails');
    assert.equal(live.firstTokenP95Ms, null);
    assert.equal(live.firstTokenP95Status, 'approximate');
    const all = (await adapters.overview!({
      source: 'all',
      from: new Date(base - 12 * 60_000).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    })) as any;
    assert.equal(all.succeeded, 2, 'all-source count includes playground');
    assert.equal(all.productionSuccessRate.value, 0.25, 'rate remains production-only');

    // A historical row without durable admission evidence must not be assumed rejected or admitted.
    store.connection
      .prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms,ended_at_ms)
      VALUES('unknown','production','openai','completed',?,?)`)
      .run(startedAtMs, startedAtMs + 1000);
    const unknownDetail = (await adapters.overview!({
      from: new Date(base - 2 * 60_000).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    })) as any;
    assert.equal(unknownDetail.productionSuccessRate.status, 'partial_unknown_admission');
    assert.equal(unknownDetail.productionSuccessRate.value, null);
    assert.equal(unknownDetail.productionSuccessRate.unknownAdmissionEnded, 1);
    await store.rebuildLiveAggregates({ offline: true });
    const unknownLive = (await adapters.overview!({
      from: new Date(base - 12 * 60_000).toISOString(),
      to: new Date(base + 60_000).toISOString(),
    })) as any;
    assert.equal(unknownLive.freshness.coverage, 'live-minute+detail-tails');
    assert.equal(unknownLive.productionSuccessRate.status, 'partial_unknown_admission');
    assert.equal(unknownLive.productionSuccessRate.value, null);
    assert.equal(unknownLive.productionSuccessRate.unknownAdmissionEnded, 1);
  } finally {
    controlStore.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
