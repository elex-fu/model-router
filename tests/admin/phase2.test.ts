import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

test('playground, redacted export, runtime bridge, maintenance and pricing APIs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-admin-phase2-'));
  const configDir = join(dir, 'config');
  const dataDir = join(dir, 'data');
  mkdirSync(configDir);
  const configPath = join(configDir, 'config.json');
  const initialConfig = defaultConfigV2(configPath, 'phase2-test');
  initialConfig.storage.dataDir = dataDir;
  writeFileSync(configPath, JSON.stringify(initialConfig), { mode: 0o600 });
  const controlStore = new ControlStore(dataDir);
  const upstream = createServer(async (req, res) => {
    let payload = '';
    for await (const chunk of req) payload += chunk.toString();
    if (payload.includes('wait-for-cancel')) await new Promise((resolve) => setTimeout(resolve, 500));
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'model-1',
        choices: [{ message: { content: 'Hello from test' } }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  let origin = 'http://127.0.0.1:15006';
  let resets = 0;
  const app = createAdminServer({
    configPath,
    controlStore,
    telemetryStore: telemetry,
    quotaLedger: new SQLiteQuotaLedger(telemetry),
    bootstrapToken: 'token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => origin,
    runtime: {
      getUpstreamStatus: () => ({ healthStatus: 'healthy', circuitState: resets ? 'closed' : 'open' }),
      resetCircuit: () => {
        resets++;
      },
    },
  });
  try {
    await app.control.entity(
      'upstreams',
      'create',
      undefined,
      {
        id: 'up',
        name: 'Local',
        provider: 'custom',
        protocol: 'openai',
        enabled: true,
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}/v1`,
        endpoints: { generate: 'chat/completions' },
        auth: { mode: 'none' },
        credentials: [],
        models: [{ id: 'model-1', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
        priority: 0,
        sortIndex: 0,
        policy: { allowInsecureHttp: true },
      },
      1,
      'test',
    );
    await app.control.entity(
      'routes',
      'create',
      undefined,
      {
        id: 'route-1',
        name: 'Route',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'public-model' },
        order: 0,
        publishedModels: ['public-model'],
        targets: [{ upstreamId: 'up', model: 'model-1' }],
      },
      2,
      'test',
    );
    await app.control.createKey({ id: 'test-key', name: 'Test Key' }, 3, 'test');
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const base = `${origin}/admin/api/v1`;
    const raw = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) =>
      fetch(base + path, {
        method,
        headers: { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    assert.equal(
      (await raw('/bootstrap', 'POST', { token: 'token', name: 'admin', password: 'secure-password-123' })).status,
      201,
    );
    const login = await raw('/session', 'POST', { name: 'admin', password: 'secure-password-123' });
    const session = (await login.json()) as { data: { csrfToken: string } };
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const auth = { cookie, origin, 'x-csrf-token': session.data.csrfToken };
    const json = async (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = auth) => {
      const response = await raw(path, method, data, headers);
      return { response, body: (await response.json()) as any };
    };
    const badRun = await json('/playground/runs', 'POST', {
      keyId: 'missing',
      model: 'public-model',
      protocol: 'openai',
      input: 'Hi',
    });
    assert.equal(badRun.response.status, 403);
    const run = await json('/playground/runs', 'POST', {
      keyId: 'test-key',
      model: 'public-model',
      protocol: 'openai',
      input: 'Hi',
      maxOutputTokens: 16,
    });
    assert.equal(run.response.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.data.output, 'Hello from test');
    const runId = run.body.data.runId as string;
    assert.equal((await json(`/playground/runs/${runId}`)).body.data.state, 'completed');
    assert.equal((await telemetry.getRequest(runId))?.request.source, 'playground');
    assert.deepEqual(
      telemetry.connection
        .prepare('SELECT state,settled_tokens AS tokens FROM quota_reservations WHERE request_id=?')
        .get(runId),
      { state: 'settled', tokens: 7 },
    );
    const streamed = await raw(
      '/playground/runs',
      'POST',
      { keyId: 'test-key', model: 'public-model', protocol: 'openai', input: 'Hi', stream: true },
      { ...auth, accept: 'text/event-stream' },
    );
    assert.match(streamed.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.match(await streamed.text(), /Hello from test/);
    const slow = await raw(
      '/playground/runs',
      'POST',
      { keyId: 'test-key', model: 'public-model', protocol: 'openai', input: 'wait-for-cancel', stream: true },
      { ...auth, accept: 'text/event-stream' },
    );
    const slowId = slow.headers.get('x-run-id');
    assert.ok(slowId);
    assert.equal((await json(`/playground/runs/${slowId}/cancel`, 'POST', {})).body.data.state, 'cancelled');
    await slow.text();
    assert.deepEqual(
      telemetry.connection
        .prepare('SELECT state,settled_tokens AS tokens FROM quota_reservations WHERE request_id=?')
        .get(slowId),
      { state: 'estimated', tokens: 256 },
    );
    const runtime = await json('/upstreams/up/runtime');
    assert.equal(runtime.body.data.circuitState, 'open');
    assert.equal((await json('/upstreams/up/health-events')).body.data.length >= 1, true);
    assert.equal((await json('/upstreams/up/circuit-reset', 'POST', {})).response.status, 200);
    assert.equal(resets, 1);
    assert.equal((await json('/upstreams/up/runtime')).body.data.circuitState, 'closed');
    assert.equal((await json('/overview')).body.data.upstreamHealth[0].status, 'healthy');

    const price = {
      id: 'price-1',
      model: 'model-1',
      provider: 'custom',
      upstreamId: 'up',
      currency: 'USD',
      inputPerMillion: 1.25,
      outputPerMillion: '2.500001',
      cacheWrite5mPerMillion: '3.125',
      cacheWrite1hPerMillion: '4.25',
      cacheWriteIncludedInInput: false,
      effectiveFrom: '2026-01-01T00:00:00Z',
    };
    assert.equal((await json('/pricing', 'POST', { ...price, currency: 'usd' })).response.status, 422);
    assert.equal((await json('/pricing', 'POST', { ...price, inputPerMillion: -1 })).response.status, 422);
    assert.equal((await json('/pricing', 'POST', price)).response.status, 201);
    assert.equal((await json('/pricing/price-1', 'PATCH', { cacheReadPerMillion: '0.123456' })).response.status, 200);
    assert.equal((await json('/pricing/price-1', 'PATCH', { cacheWriteIncludedInInput: true })).response.status, 200);
    assert.equal((await json('/pricing/price-1', 'PATCH', { outputPerMillion: '1.1234567' })).response.status, 422);
    const priceVersions = (await json('/pricing')).body.data as Array<Record<string, unknown>>;
    assert.equal(priceVersions.length, 3);
    assert.equal(priceVersions.some((version) => version.cacheWrite5mPerMillion === '3.125'), true);
    assert.equal(priceVersions.some((version) => version.provider === 'custom' && version.upstreamId === 'up'), true);
    assert.equal(priceVersions.every((version) => typeof version.effectiveFrom === 'string' && typeof version.versionId === 'string'), true);
    assert.equal(new Set(priceVersions.map((version) => version.versionId)).size, 3);
    assert.equal(priceVersions.every((version) => typeof version.versionSequence === 'number'), true);
    assert.equal(priceVersions.some((version) => version.cacheReadPerMillion === undefined && version.cacheWriteIncludedInInput === false), true);

    const exportJob = await json('/exports', 'POST', {
      type: 'usage',
      format: 'csv',
      filters: {
        source: 'playground',
        from: new Date(Date.now() - 3_600_000).toISOString(),
        to: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    assert.equal(exportJob.response.status, 202, JSON.stringify(exportJob.body));
    const exportId = exportJob.body.data.exportId as string;
    const waitJob = async (jobId: string) => {
      for (let n = 0; n < 100; n++) {
        const current = (await json(`/jobs/${jobId}`)).body.data;
        if (['completed', 'failed'].includes(current.state)) return current;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Job did not complete');
    };
    assert.equal((await waitJob(exportJob.body.data.jobId)).state, 'completed');
    assert.equal((await raw(`/exports/${exportId}/download`)).status, 401);
    const download = await raw(`/exports/${exportId}/download`, 'GET', undefined, { cookie });
    assert.equal(download.status, 200);
    const csv = await download.text();
    assert.match(csv, /requestId,source,startedAt/);
    assert.match(csv, /playground/);
    assert.doesNotMatch(csv, /secure-password|mr_/);
    const exportPath = join(dataDir, 'admin-exports', `${exportId}.csv`);
    assert.equal(statSync(exportPath).mode & 0o777, 0o600);

    await telemetry.upsertRequest({
      id: 'unknown-usage-export',
      proxyKeyId: 'test-key',
      source: 'playground',
      clientProtocol: 'openai',
      requestModel: 'unknown-usage-model',
      routeId: 'route-1',
      configRevision: 4,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: Date.now(),
      endedAtMs: Date.now(),
      durationMs: 1,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: 'up',
    });
    const unknownExport = await json('/exports', 'POST', {
      type: 'usage',
      format: 'json',
      filters: { source: 'playground', model: 'unknown-usage-model' },
    });
    assert.equal(unknownExport.response.status, 202);
    assert.equal((await waitJob(unknownExport.body.data.jobId)).state, 'completed');
    const unknownDownload = await raw(`/exports/${unknownExport.body.data.exportId}/download`, 'GET', undefined, {
      cookie,
    });
    assert.equal(unknownDownload.status, 200);
    const unknownRows = (await unknownDownload.json()) as {
      rows: Array<{ inputTokens: number | null; outputTokens: number | null }>;
    };
    assert.equal(unknownRows.rows.length, 1);
    assert.equal(unknownRows.rows[0].inputTokens, null);
    assert.equal(unknownRows.rows[0].outputTokens, null);

    const backup = await json('/maintenance/jobs', 'POST', { type: 'backup' });
    assert.equal(backup.response.status, 202);
    const backupResult = await waitJob(backup.body.data.jobId);
    assert.equal(backupResult.state, 'completed', backupResult.error);
    const backupId = backupResult.result.backupId as string;
    assert.equal(
      JSON.parse(readFileSync(join(dataDir, 'admin-backups', backupId, 'manifest.json'), 'utf8')).revision,
      4,
    );
    assert.equal(statSync(join(dataDir, 'admin-backups', backupId, 'master.key')).mode & 0o777, 0o600);
    await app.control.entity('routes', 'update', 'route-1', { name: 'Changed' }, 4, 'test');
    const restore = await json('/maintenance/jobs', 'POST', { type: 'restore', backupId, expectedRevision: 5 });
    const restored = await waitJob(restore.body.data.jobId);
    assert.equal(restored.state, 'completed', restored.error);
    assert.equal((await app.control.raw()).routes[0].name, 'Route');
    await telemetry.upsertRequest({
      id: 'old-log',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'old',
      routeId: null,
      configRevision: null,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: Date.now() - 40 * 86_400_000,
      endedAtMs: Date.now() - 40 * 86_400_000,
      durationMs: 0,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    const purge = await json('/maintenance/jobs', 'POST', { type: 'purge' });
    assert.equal((await waitJob(purge.body.data.jobId)).state, 'completed');
    assert.equal(await telemetry.getRequest('old-log'), null);
    const oldDay = Math.floor((Date.now() - 40 * 86_400_000) / 86_400_000) * 86_400_000;
    const archivedRange = `from=${encodeURIComponent(new Date(oldDay).toISOString())}&to=${encodeURIComponent(new Date(oldDay + 86_400_000).toISOString())}`;
    const archivedSummary = await json(`/usage/summary?${archivedRange}`);
    assert.equal(archivedSummary.response.status, 200);
    assert.equal(archivedSummary.body.data.logicalRequests, 1);
    assert.equal(archivedSummary.body.meta.coverage, 'archived');
    const archivedSeries = await json(`/usage/timeseries?${archivedRange}`);
    assert.equal(archivedSeries.response.status, 200);
    assert.ok(Array.isArray(archivedSeries.body.data));
    assert.equal(archivedSeries.body.data[0].requests, 1);
    assert.equal(archivedSeries.body.meta.grain, 'utc-day');
    assert.equal(archivedSeries.body.meta.coverage, 'archived');
    assert.equal((await json(`/usage/summary?${archivedRange}&model=old`)).response.status, 422);
    const aggregate = await json('/maintenance/jobs', 'POST', { type: 'aggregate' });
    assert.equal((await waitJob(aggregate.body.data.jobId)).state, 'completed');
    const rollup = telemetry.connection
      .prepare("SELECT logical_requests AS requests FROM admin_usage_daily_v2 WHERE source='playground'")
      .get() as { requests: number };
    assert.ok(rollup.requests >= 2);
  } finally {
    const cleanupErrors: unknown[] = [];
    app.server.closeAllConnections();
    try {
      await app.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') cleanupErrors.push(error);
    }
    try {
      controlStore.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await telemetry.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    upstream.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      cleanupErrors.push(error);
    }
    rmSync(dir, { recursive: true, force: true });
    if (cleanupErrors.length) {
      process.emitWarning(new AggregateError(cleanupErrors, 'Admin phase2 test cleanup failed'));
    }
  }
});
