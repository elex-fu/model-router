import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdminRollups, UTC_DAY_MS } from '../../src/admin/rollups.js';
import { telemetryAdapters } from '../../src/admin/telemetry.js';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

const oldDay = Math.floor((Date.now() - 40 * UTC_DAY_MS) / UTC_DAY_MS) * UTC_DAY_MS;
const inputTime = { from: new Date(oldDay).toISOString(), to: new Date(oldDay + UTC_DAY_MS).toISOString() };

async function request(store: SQLiteTelemetryStore, id: string, at: number, state = 'completed') {
  await store.upsertRequest({
    id,
    proxyKeyId: 'key',
    source: 'production',
    clientProtocol: 'openai',
    requestModel: 'model',
    routeId: 'route',
    configRevision: 1,
    state: state as 'completed',
    finalHttpStatus: 200,
    startedAtMs: at,
    endedAtMs: at + 1000,
    durationMs: 1000,
    firstByteMs: null,
    firstEventMs: null,
    firstTextMs: null,
    finalUpstreamId: 'up',
  });
}

async function attempt(store: SQLiteTelemetryStore, id: string, requestId: string, at: number) {
  await store.upsertAttempt({
    id,
    requestId,
    ordinal: 1,
    upstreamId: 'up',
    credentialId: null,
    resolvedModel: 'model',
    reportedModel: null,
    protocol: 'openai',
    outcome: 'completed',
    status: 200,
    retryReason: null,
    startedAtMs: at,
    endedAtMs: at + 1000,
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
    costMicros: 100_000,
    currency: 'USD',
  });
}

test('purge archives native and legacy separately; later aggregate preserves frozen history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-rollups-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  const controlStore = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), controlStore);
  try {
    telemetry.connection.exec(`CREATE TABLE legacy_request_metadata (
      request_id TEXT PRIMARY KEY, source_row_id INTEGER NOT NULL UNIQUE,
      measurement TEXT NOT NULL CHECK(measurement='legacy_log_rows')
    )`);
    await request(telemetry, 'native-old', oldDay + 1000);
    await attempt(telemetry, 'native-attempt', 'native-old', oldDay + 1000);
    await request(telemetry, 'legacy-old', oldDay + 2000);
    await attempt(telemetry, 'legacy-attempt', 'legacy-old', oldDay + 2000);
    telemetry.connection
      .prepare(`INSERT INTO legacy_request_metadata(request_id,source_row_id,measurement)
      VALUES('legacy-old',1,'legacy_log_rows')`)
      .run();
    await request(telemetry, 'recent', Date.now() - 1000);
    const adapters = telemetryAdapters(telemetry, control);
    const detail = (await adapters.usageSummary!(inputTime)) as any;
    assert.equal(detail.logicalRequests, 1);
    assert.equal(detail.completed, 1);
    assert.equal(detail.upstreamAttempts, 1);
    assert.equal(detail.inputTokens, 10);
    assert.equal(detail.legacyLogRows, 1);
    assert.equal(detail.partial, true);
    const detailSeries = (await adapters.usageTimeseries!({ ...inputTime, grain: 'day' })) as any;
    assert.equal(detailSeries.items[0].requests, 1);
    assert.equal(detailSeries.items[0].legacyLogRows, 1);
    const breakdown = (await adapters.usageBreakdown!(inputTime)) as any[];
    assert.equal(breakdown[0].requests, 1);
    assert.equal(breakdown[0].legacyLogRows, 1);
    assert.equal(breakdown[0].cost, 0.1);
    const overview = (await adapters.overview!(inputTime)) as any;
    assert.equal(overview.logicalRequests, 1);
    assert.equal(overview.succeeded, 1);
    assert.equal(overview.legacyLogRows, 1);

    const rollups = new AdminRollups(telemetry.connection);
    const purged = rollups.archiveAndPurge(Date.now() - 30 * UTC_DAY_MS);
    assert.equal(purged.requests, 2);
    assert.equal(purged.attempts, 2);
    assert.equal(await telemetry.getRequest('native-old'), null);
    assert.equal(await telemetry.getRequest('legacy-old'), null);
    assert.ok(await telemetry.getRequest('recent'));
    assert.equal((telemetry.connection.prepare('SELECT COUNT(*) AS n FROM legacy_request_metadata').get() as any).n, 0);
    const archived = (await adapters.usageSummary!(inputTime)) as any;
    assert.equal(archived.logicalRequests, 1);
    assert.equal(archived.legacyLogRows, 1);
    assert.equal(archived.upstreamAttempts, 1);
    assert.equal(archived.costByCurrency.USD, 0.1);
    assert.equal(archived.coverage, 'archived');
    assert.equal(archived.grain, 'utc-day');
    const series = (await adapters.usageTimeseries!(inputTime)) as any;
    assert.equal(series.items[0].requests, 1);
    assert.equal(series.items[0].legacyLogRows, 1);
    assert.equal(series.coverage, 'archived');
    assert.throws(() => rollups.classify(oldDay + 1, oldDay + UTC_DAY_MS), /complete UTC days/);
    assert.throws(() => rollups.classify(oldDay, Date.now()), /crosses or precedes/);
    await assert.rejects(adapters.usageSummary!({ ...inputTime, model: 'model' }), /Filter is not available/);
    await assert.rejects(adapters.usageBreakdown!(inputTime), /Archived rollups have no dimension breakdown/);
    rollups.rebuild();
    rollups.rebuild();
    assert.equal(rollups.read(oldDay, oldDay + UTC_DAY_MS, 'production')[0].logicalRequests, 1);
    assert.equal(rollups.read(oldDay, oldDay + UTC_DAY_MS, 'production')[0].legacyLogRows, 1);
    await request(telemetry, 'late', oldDay + 3000);
    assert.throws(() => rollups.rebuild(), /Raw detail exists in a frozen rollup day/);
    assert.throws(() => rollups.archiveAndPurge(Date.now() - 30 * UTC_DAY_MS), /Late detail exists/);
    assert.ok(await telemetry.getRequest('late'));
  } finally {
    controlStore.close();
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('purge refuses active old requests and cross-boundary attempts without deleting detail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-rollups-guard-'));
  const telemetry = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await telemetry.init();
  try {
    const rollups = new AdminRollups(telemetry.connection);
    await request(telemetry, 'active', oldDay + 1000, 'routing');
    assert.throws(() => rollups.archiveAndPurge(Date.now() - 30 * UTC_DAY_MS), /nonterminal/);
    assert.ok(await telemetry.getRequest('active'));
    telemetry.connection.prepare("UPDATE requests SET state='completed' WHERE id='active'").run();
    await attempt(telemetry, 'crossing', 'active', Date.now());
    assert.throws(() => rollups.archiveAndPurge(Date.now() - 30 * UTC_DAY_MS), /cross-boundary attempts/);
    assert.ok(await telemetry.getRequest('active'));
    assert.equal(
      (telemetry.connection.prepare('SELECT COUNT(*) AS n FROM admin_usage_archive_state').get() as any).n,
      0,
    );
  } finally {
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
