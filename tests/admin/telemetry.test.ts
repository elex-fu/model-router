import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';
import { telemetryAdapters } from '../../src/admin/telemetry.js';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('injected telemetry backs overview, usage and request chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admin-data-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'logs.sqlite'));
  await telemetry.init();
  const now = Date.now();
  await telemetry.upsertRequest({
    id: 'req-1',
    proxyKeyId: 'key-1',
    source: 'production',
    clientProtocol: 'openai',
    requestModel: 'qwen',
    routeId: 'route-1',
    configRevision: 1,
    state: 'completed',
    finalHttpStatus: 200,
    startedAtMs: now - 1000,
    endedAtMs: now,
    durationMs: 1000,
    firstByteMs: 100,
    firstEventMs: null,
    firstTextMs: 200,
    finalUpstreamId: 'ollama',
  });
  await telemetry.upsertAttempt({
    id: 'attempt-1',
    requestId: 'req-1',
    ordinal: 1,
    upstreamId: 'ollama',
    credentialId: null,
    resolvedModel: 'qwen2.5-coder:7b',
    reportedModel: null,
    protocol: 'openai',
    outcome: 'completed',
    status: 200,
    retryReason: null,
    startedAtMs: now - 1000,
    endedAtMs: now,
    usage: {
      inputTotal: 10,
      inputUncached: 10,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      outputTotal: 5,
      reasoningOutput: null,
      status: 'reported',
      source: 'upstream',
      semanticsVersion: 'v2',
    },
    pricingVersion: null,
    costMicros: null,
    currency: null,
  });
  let publicOrigin = 'http://127.0.0.1:15006';
  const app = createAdminServer({
    configPath: join(dir, 'config.json'),
    bootstrapToken: 'token',
    bootstrapExpiresAt: now + 60_000,
    publicOrigin: () => publicOrigin,
    telemetryStore: telemetry,
    quotaLedger: new SQLiteQuotaLedger(telemetry),
  });
  await app.control.createKey({ id: 'key-1', name: 'Client', dailyTokens: 100 }, 1, 'admin');
  const ledger = new SQLiteQuotaLedger(telemetry);
  assert.equal(
    (
      await ledger.admit({
        requestId: 'reservation-1',
        proxyKeyId: 'key-1',
        atMs: now,
        periodId: 'current',
        periodStartMs: now - 60_000,
        periodEndMs: now + 3_600_000,
        reserveTokens: 20,
        dailyTokens: 100,
      })
    ).allowed,
    true,
  );
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const addr = app.server.address();
  assert.ok(addr && typeof addr !== 'string');
  publicOrigin = `http://127.0.0.1:${addr.port}`;
  const base = `${publicOrigin}/admin/api/v1`;
  try {
    await fetch(base + '/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token', name: 'admin', password: 'long-password-123' }),
    });
    const login = await fetch(base + '/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'admin', password: 'long-password-123' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const loginData = (await login.json()) as { data: { csrfToken: string } };
    const get = async (path: string) => {
      const response = await fetch(base + path, { headers: { cookie } });
      return { status: response.status, body: (await response.json()) as any };
    };
    const usage = await get('/usage/summary');
    assert.equal(usage.status, 200);
    assert.equal(usage.body.data.logicalRequests, 1);
    assert.equal(usage.body.data.upstreamAttempts, 1);
    assert.equal(usage.body.data.inputTokens, 10);
    assert.equal(usage.body.data.unpricedAttempts, 1);
    assert.equal(usage.body.data.partial, true);
    assert.equal((await get('/usage/summary?source=proxy&model=qwen')).body.data.logicalRequests, 1);
    assert.equal((await get('/usage/summary?source=all')).body.data.logicalRequests, 1);
    const series = await get('/usage/timeseries?grain=hour');
    assert.equal(series.status, 200);
    assert.equal(series.body.data[0].requests, 1);
    assert.equal(series.body.data[0].inputTokens, 10);
    assert.equal((await get('/usage/timeseries?source=proxy&model=qwen')).status, 200);
    const breakdown = await get('/usage/breakdown?groupBy=upstreamId');
    assert.equal(breakdown.status, 200);
    assert.equal(breakdown.body.data[0].id, 'ollama');
    assert.equal(breakdown.body.data[0].upstreamAttempts, 1);
    assert.equal((await get('/usage/breakdown?groupBy=upstream&source=proxy')).body.data[0].requests, 1);
    assert.equal((await get('/overview')).body.data.succeeded, 1);
    const listed = await get('/requests?limit=1');
    assert.equal(listed.body.data[0].id, 'req-1');
    assert.equal((await get('/requests?status=succeeded&model=qwen')).body.data[0].status, 'succeeded');
    assert.equal(listed.body.meta.nextCursor ?? null, null);
    assert.equal((await get('/requests/req-1')).body.data.attempts[0].id, 'attempt-1');
    assert.equal((await get('/requests/req-1/attempts')).body.data.length, 1);
    assert.equal((await get('/requests/missing')).status, 404);
    const quota = await get('/keys/key-1/quota');
    assert.equal(quota.body.data.reserved, 20);
    assert.equal(quota.body.data.activeRequests, 1);
    const adjustment = async (id: string) => {
      const response = await fetch(`${base}/keys/key-1/quota-adjustments`, {
        method: 'POST',
        headers: {
          cookie,
          origin: publicOrigin,
          'x-csrf-token': loginData.data.csrfToken,
          'idempotency-key': id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ periodId: 'current', deltaTokens: -5, reason: 'correction' }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    assert.equal((await adjustment('adjust-1')).body.data.applied, true);
    assert.equal((await adjustment('adjust-1')).body.data.applied, false);
    assert.equal((await get('/keys/key-1/quota')).body.data.adjustmentTokens, -5);
    const uiAdjustment = await fetch(`${base}/keys/key-1/quota-adjustments`, {
      method: 'POST',
      headers: {
        cookie,
        origin: publicOrigin,
        'x-csrf-token': loginData.data.csrfToken,
        'idempotency-key': 'adjust-2',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ amount: 2, period: new Date().toISOString().slice(0, 10), reason: 'manual' }),
    });
    assert.equal(uiAdjustment.status, 201);
    assert.equal((await get('/keys/key-1/quota')).body.data.adjustmentTokens, -3);
    assert.equal((await get('/usage/summary?from=2026-01-01')).status, 400);
  } finally {
    await app.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('breakdown preserves currencies and marks missing prices as partial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admin-cost-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  const store = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), store);
  try {
    const now = Date.now();
    await telemetry.upsertRequest({
      id: 'cost-req',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'model',
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: now - 1000,
      endedAtMs: now,
      durationMs: 1000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: 'up',
    });
    const usage = {
      inputTotal: 1,
      inputUncached: 1,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      outputTotal: 1,
      reasoningOutput: null,
      status: 'reported' as const,
      source: 'upstream' as const,
      semanticsVersion: 'v2' as const,
    };
    for (const [ordinal, currency, costMicros] of [
      [1, 'USD', 1000000],
      [2, 'EUR', 2000000],
      [3, null, null],
    ] as const)
      await telemetry.upsertAttempt({
        id: `cost-${ordinal}`,
        requestId: 'cost-req',
        ordinal,
        upstreamId: 'up',
        credentialId: null,
        resolvedModel: 'model',
        reportedModel: null,
        protocol: 'openai',
        outcome: 'completed',
        status: 200,
        retryReason: null,
        startedAtMs: now - 1000,
        endedAtMs: now,
        usage,
        pricingVersion: null,
        costMicros,
        currency,
      });
    const adapters = telemetryAdapters(telemetry, control);
    const summary = await adapters.usageSummary!({});
    assert.equal((summary as any).unpricedAttempts, 1);
    assert.equal((summary as any).partial, true);
    const rows = await adapters.usageBreakdown!({});
    const row = (rows as any[])[0];
    assert.equal(row.cost, null);
    assert.deepEqual(row.costByCurrency, { USD: 1, EUR: 2 });
    assert.equal(row.unpricedAttempts, 1);
    assert.equal(row.partial, true);
    assert.deepEqual(row.costByCurrency, { USD: 1, EUR: 2 });
  } finally {
    store.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage breakdown supports source grouping and safe labels across all dimensions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admin-group-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  const store = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), store);
  try {
    const now = Date.now();
    for (const [id, source, keyId, model, protocol, upstreamId] of [
      ['prod', 'production', 'key-a', 'model-a', 'openai', 'up-a'],
      ['play', 'playground', 'key-b', null, 'anthropic', 'up-b'],
    ] as const) {
      await telemetry.upsertRequest({
        id,
        proxyKeyId: keyId,
        source,
        clientProtocol: protocol,
        requestModel: model,
        routeId: null,
        configRevision: 1,
        state: 'completed',
        finalHttpStatus: 200,
        startedAtMs: now - 1000,
        endedAtMs: now,
        durationMs: 1000,
        firstByteMs: null,
        firstEventMs: null,
        firstTextMs: null,
        finalUpstreamId: upstreamId,
      });
      await telemetry.upsertAttempt({
        id: `attempt-${id}`,
        requestId: id,
        ordinal: 1,
        upstreamId,
        credentialId: null,
        resolvedModel: model,
        reportedModel: null,
        protocol,
        outcome: 'completed',
        status: 200,
        retryReason: null,
        startedAtMs: now - 1000,
        endedAtMs: now,
        usage: null,
        pricingVersion: null,
        costMicros: null,
        currency: null,
      });
    }
    const adapters = telemetryAdapters(telemetry, control);
    const grouped = async (groupBy: string) => adapters.usageBreakdown!({ groupBy, source: 'all' }) as Promise<any[]>;
    for (const dimension of ['keyId', 'upstreamId', 'model', 'protocol', 'source']) {
      const rows = await grouped(dimension);
      assert.ok(rows.length >= 1, `${dimension} should return its groups`);
      assert.ok(rows.every((row) => typeof row.label === 'string' && row.label.length > 0));
      assert.ok(rows.every((row) => row.unpricedAttempts === 1));
    }
    const sources = await grouped('source');
    assert.ok(sources.some((row) => row.label === '生产代理'));
    assert.ok(sources.some((row) => row.label === '测试台'));
    await telemetry.upsertRequest({
      id: 'missing-key',
      proxyKeyId: null,
      source: 'health',
      clientProtocol: 'unknown',
      requestModel: null,
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: now - 1000,
      endedAtMs: now,
      durationMs: 1000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    const keys = await grouped('keyId');
    assert.ok(keys.some((row) => row.label === '未关联 Key'));
    await assert.rejects(grouped('credentialId'), /groupBy must be/);
  } finally {
    store.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upstream breakdown separates final request ownership from actual fallback attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admin-fallback-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  const store = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), store);
  try {
    const now = Date.now();
    await telemetry.upsertRequest({
      id: 'fallback-req',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'model',
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: now - 2000,
      endedAtMs: now,
      durationMs: 2000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: 'upstream-B',
    });
    const reportedUsage = {
      inputTotal: 10,
      inputUncached: 10,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      outputTotal: 5,
      reasoningOutput: null,
      status: 'reported' as const,
      source: 'upstream' as const,
      semanticsVersion: 'v2' as const,
    };
    for (const attempt of [
      {
        id: 'fallback-A',
        ordinal: 1,
        upstreamId: 'upstream-A',
        outcome: 'failed' as const,
        usage: null,
        costMicros: 300_000,
        currency: 'USD',
      },
      {
        id: 'fallback-B',
        ordinal: 2,
        upstreamId: 'upstream-B',
        outcome: 'completed' as const,
        usage: reportedUsage,
        costMicros: 700_000,
        currency: 'USD',
      },
    ])
      await telemetry.upsertAttempt({
        ...attempt,
        requestId: 'fallback-req',
        credentialId: null,
        resolvedModel: 'model',
        reportedModel: null,
        protocol: 'openai',
        status: attempt.outcome === 'failed' ? 502 : 200,
        retryReason: null,
        startedAtMs: now - 2000 + attempt.ordinal * 500,
        endedAtMs: now - 2000 + attempt.ordinal * 500 + 400,
        pricingVersion: null,
      });
    const adapters = telemetryAdapters(telemetry, control);
    const rows = (await adapters.usageBreakdown!({ groupBy: 'upstreamId', source: 'all' })) as any[];
    const upstreamA = rows.find((row) => row.id === 'upstream-A');
    const upstreamB = rows.find((row) => row.id === 'upstream-B');
    assert.equal(upstreamA.requestMetrics.logicalRequests, 0);
    assert.equal(upstreamA.attemptMetrics.upstreamAttempts, 1);
    assert.equal(upstreamA.attemptMetrics.inputTokens, 0);
    assert.deepEqual(upstreamA.attemptMetrics.costByCurrency, { USD: 0.3 });
    assert.equal(upstreamB.requestMetrics.logicalRequests, 1);
    assert.equal(upstreamB.attemptMetrics.upstreamAttempts, 1);
    assert.equal(upstreamB.attemptMetrics.inputTokens, 10);
    assert.equal(upstreamB.attemptMetrics.outputTokens, 5);
    assert.deepEqual(upstreamB.attemptMetrics.costByCurrency, { USD: 0.7 });
    assert.equal(upstreamA.metricsSemantics.requests, 'final_upstream_id');
    assert.equal(upstreamA.metricsSemantics.attempts, 'attempts.upstream_id');
    const byFinalFilter = (await adapters.usageBreakdown!({
      groupBy: 'upstreamId',
      upstreamId: 'upstream-A',
      upstreamFilterMode: 'final',
      source: 'all',
    })) as any[];
    assert.equal(byFinalFilter.length, 0);
    const byAttemptFilter = (await adapters.usageBreakdown!({
      groupBy: 'upstreamId',
      upstreamId: 'upstream-A',
      upstreamFilterMode: 'attempt',
      source: 'all',
    })) as any[];
    assert.equal(byAttemptFilter.find((row) => row.id === 'upstream-B')?.requestMetrics.logicalRequests, 1);
    assert.equal(byAttemptFilter.find((row) => row.id === 'upstream-A')?.attemptMetrics.upstreamAttempts, 1);
  } finally {
    store.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
