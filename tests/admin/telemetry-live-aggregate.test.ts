import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdminRollups } from '../../src/admin/rollups.js';
import { telemetryAdapters } from '../../src/admin/telemetry.js';
import { ControlService } from '../../src/control/service.js';
import { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

test('live minute buckets subtract late attempt/request contributions and preserve retry identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-aggregate-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  const controlStore = new ControlStore(dir);
  const control = new ControlService(join(dir, 'config.json'), controlStore);
  try {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const from = new Date(base - 12 * 60_000).toISOString();
    const to = new Date(base + 60_000).toISOString();
    const request: RequestRecord = {
      id: 'logical',
      proxyKeyId: 'key',
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'alias',
      routeId: 'route',
      configRevision: 1,
      state: 'connecting',
      finalHttpStatus: null,
      startedAtMs: base - 8 * 60_000,
      endedAtMs: null,
      durationMs: null,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    };
    const first: AttemptRecord = {
      id: 'attempt-1',
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
      startedAtMs: base - 8 * 60_000 + 1,
      endedAtMs: null,
      usage: null,
      pricingVersion: null,
      costMicros: null,
      currency: null,
    };
    await store.upsertRequest(request);
    await store.upsertAttempt(first);
    await store.upsertAttempt({ ...first, outcome: 'failed', status: 503, endedAtMs: first.startedAtMs + 10 });
    await store.upsertAttempt({
      ...first,
      id: 'attempt-2',
      ordinal: 2,
      upstreamId: 'up-2',
      startedAtMs: first.startedAtMs + 20,
      outcome: 'completed',
      status: 200,
      usage: {
        inputTotal: 11,
        inputUncached: 11,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: 4,
        reasoningOutput: null,
        status: 'reported',
        source: 'upstream',
        semanticsVersion: 'v1',
      },
      costMicros: 200,
      currency: 'USD',
    });
    await store.upsertRequest({
      ...request,
      state: 'completed',
      endedAtMs: base - 7 * 60_000,
      finalHttpStatus: 200,
      finalUpstreamId: 'up-2',
      firstTextMs: 19,
    });
    const adapters = telemetryAdapters(store, control);
    const result = (await adapters.usageSummary!({ from, to })) as any;
    assert.equal(result.freshness.coverage, 'live-minute+detail-tails');
    assert.equal(result.logicalRequests, 1);
    assert.equal(result.completed, 1);
    assert.equal(result.upstreamAttempts, 2);
    assert.equal(result.inputTokens, 11);
    assert.equal(result.outputTokens, 4);
    assert.equal(result.missingUsageAttempts, 1);
    assert.equal(result.missingUsageRequests, 1);
    assert.equal(result.unpricedAttempts, 1);
    assert.deepEqual(result.costByCurrency, { USD: 0.0002 });
    assert.equal(((await adapters.usageSummary!({ from, to, upstreamId: 'up-1' })) as any).upstreamAttempts, 1);
    assert.equal(((await adapters.usageSummary!({ from, to, upstreamId: 'up-2' })) as any).logicalRequests, 1);
    const priorPerf = process.env.MODEL_ROUTER_PERF;
    let perfOutput = '';
    const stderrWrite = process.stderr.write;
    process.env.MODEL_ROUTER_PERF = '1';
    process.stderr.write = ((chunk: unknown) => {
      perfOutput += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let overview: any;
    try {
      overview = await adapters.overview!({ from, to });
    } finally {
      process.stderr.write = stderrWrite;
      if (priorPerf === undefined) delete process.env.MODEL_ROUTER_PERF;
      else process.env.MODEL_ROUTER_PERF = priorPerf;
    }
    assert.doesNotMatch(perfOutput, /liveCostAggregateSqlMs|detailCostSqlMs/);
    assert.equal(overview.firstTokenP95Ms, 20);
    assert.equal(overview.firstTokenP95Status, 'approximate');

    // Raw/import writes cannot silently retain a valid aggregate watermark.
    store.connection
      .prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms)
      VALUES('raw','production','openai','completed',?)`)
      .run(base - 7 * 60_000);
    const fallback = (await adapters.usageSummary!({ from, to })) as any;
    assert.equal(fallback.freshness.coverage, 'exact-detail-snapshot');
    assert.equal(fallback.logicalRequests, 2);
    const rebuilt = await store.rebuildLiveAggregates({ offline: true });
    assert.equal(rebuilt.requests, 2);
    const after = (await adapters.usageSummary!({ from, to })) as any;
    assert.equal(after.freshness.coverage, 'live-minute+detail-tails');
    assert.equal(after.logicalRequests, 2);
    const plan = store.connection
      .prepare(`EXPLAIN QUERY PLAN SELECT SUM(logical_requests)
      FROM live_request_minute WHERE bucket_ms>=? AND bucket_ms<?`)
      .all(base - 12 * 60_000, base + 60_000);
    assert.match(
      JSON.stringify(plan),
      /SEARCH live_request_minute USING INDEX|SEARCH live_request_minute USING COVERING INDEX/i,
    );
    const missingPlan = store.connection
      .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT a.request_id)
      FROM attempts a JOIN requests r ON r.id=a.request_id WHERE a.started_at_ms>=?
      AND a.started_at_ms<? AND (a.usage_json IS NULL OR json_extract(a.usage_json,'$.inputTotal') IS NULL
      OR json_extract(a.usage_json,'$.outputTotal') IS NULL)`)
      .all(base - 12 * 60_000, base + 60_000);
    assert.match(JSON.stringify(missingPlan), /idx_attempts_missing_time/);
  } finally {
    controlStore.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate body and exact edge tails form a non-overlapping half-open range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-tail-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  const controlStore = new ControlStore(dir);
  try {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const fromMs = base - 12 * 60_000 + 10_000;
    const toMs = base + 30_000;
    const insert = store.connection.prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms)
      VALUES(?,'production','openai','completed',?)`);
    insert.run('before', fromMs - 1);
    insert.run('left', fromMs);
    insert.run('middle', base - 6 * 60_000);
    insert.run('right', toMs - 1);
    insert.run('after', toMs);
    await store.rebuildLiveAggregates({ offline: true });
    const adapters = telemetryAdapters(store, new ControlService(join(dir, 'config.json'), controlStore));
    const summary = (await adapters.usageSummary!({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    })) as any;
    assert.equal(summary.freshness.coverage, 'live-minute+detail-tails');
    assert.equal(summary.logicalRequests, 3);
  } finally {
    controlStore.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live first-event histogram merges minutes, exact tails, upserts, deletes, and rebuilds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-first-event-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  const controlStore = new ControlStore(dir);
  try {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const fromMs = base - 12 * 60_000 + 10_000;
    const toMs = base + 30_000;
    const insert =
      store.connection.prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms,first_event_ms)
      VALUES(?,'production','openai','completed',?,?)`);
    for (let index = 0; index < 20; index++) {
      const startedAt = base - (11 - (index % 10)) * 60_000;
      insert.run(`h${index}`, startedAt, index < 19 ? 150 + index : 9_000);
    }
    insert.run('left-tail', fromMs, 1);
    insert.run('right-tail', toMs - 1, 2);
    await store.rebuildLiveAggregates({ offline: true });
    const adapters = telemetryAdapters(store, new ControlService(join(dir, 'config.json'), controlStore));
    const range = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    const first = (await adapters.overview!(range)) as any;
    assert.equal(first.firstTokenP95Status, 'approximate');
    assert.equal(first.firstTokenP95Ms, 200);

    await store.upsertRequest({
      id: 'h19',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: null,
      routeId: null,
      configRevision: null,
      state: 'completed',
      finalHttpStatus: null,
      startedAtMs: base - 2 * 60_000,
      endedAtMs: null,
      durationMs: null,
      firstByteMs: null,
      firstEventMs: 5,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    const updated = (await adapters.overview!(range)) as any;
    assert.equal(updated.firstTokenP95Status, 'approximate');
    assert.equal(updated.firstTokenP95Ms, 200);
    store.connection.prepare("DELETE FROM requests WHERE id='h19'").run();
    assert.notEqual(
      (store.connection.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as any).n,
      store.writeWatermark.sequence,
      'direct deletes invalidate live coverage',
    );
    const rebuilt = await store.rebuildLiveAggregates({ offline: true });
    assert.equal(rebuilt.requests, 21);
    const afterRebuild = (await adapters.overview!(range)) as any;
    assert.equal(afterRebuild.firstTokenP95Status, 'approximate');
  } finally {
    controlStore.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live first-event P95 does not understate samples above 1,000,000 ms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-first-event-long-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  const controlStore = new ControlStore(dir);
  try {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const startedAt = base - 5 * 60_000;
    store.connection
      .prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms,first_event_ms)
        VALUES('long-timeout','production','openai','completed',?,?)`)
      .run(startedAt, 1_500_000);
    await store.rebuildLiveAggregates({ offline: true });
    const adapters = telemetryAdapters(store, new ControlService(join(dir, 'config.json'), controlStore));
    const range = {
      from: new Date(base - 12 * 60_000).toISOString(),
      to: new Date(base + 30_000).toISOString(),
    };
    const result = (await adapters.overview!(range)) as any;
    assert.equal(result.firstTokenP95Status, 'approximate');
    assert.ok(result.firstTokenP95Ms >= 1_500_000);
  } finally {
    controlStore.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a legacy database without the first-event table invalidates live coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-first-event-migrate-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const store = new SQLiteTelemetryStore(dbPath);
  await store.init();
  store.connection
    .prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms)
    VALUES('old-row','production','openai','completed',?)`)
    .run(Date.now());
  store.connection
    .prepare('UPDATE live_aggregate_state SET covered_sequence=? WHERE id=1')
    .run(store.writeWatermark.sequence);
  await store.close();
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  db.exec('DROP TABLE live_first_event_minute');
  db.close();
  const reopened = new SQLiteTelemetryStore(dbPath);
  await reopened.init();
  try {
    assert.equal(
      (reopened.connection.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as any).n,
      -1,
    );
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty legacy metadata table after archive permits covered live reads without rewriting frozen days', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-empty-legacy-'));
  const store = new SQLiteTelemetryStore(join(dir, 'telemetry.sqlite'));
  await store.init();
  const controlStore = new ControlStore(dir);
  try {
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    const today = Math.floor(base / 86_400_000) * 86_400_000;
    const oldDay = today - 2 * 86_400_000;
    const from = new Date(base - 12 * 60_000).toISOString();
    const to = new Date(base + 60_000).toISOString();
    const request: RequestRecord = {
      id: 'native',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'alias',
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: base - 8 * 60_000,
      endedAtMs: base - 7 * 60_000,
      durationMs: 60_000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    };
    await store.upsertRequest(request);
    store.connection.exec('CREATE TABLE legacy_request_metadata(request_id TEXT PRIMARY KEY)');
    store.connection
      .prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms)
      VALUES('legacy','production','openai','completed',?)`)
      .run(oldDay + 1000);
    store.connection.prepare('INSERT INTO legacy_request_metadata(request_id) VALUES(?)').run('legacy');
    await store.rebuildLiveAggregates({ offline: true });
    const adapters = telemetryAdapters(store, new ControlService(join(dir, 'config.json'), controlStore));
    const conservative = (await adapters.usageSummary!({ from, to })) as any;
    assert.equal(conservative.freshness.coverage, 'exact-detail-snapshot');
    assert.equal(conservative.freshness.legacyMetadataCount, 1);

    const rollups = new AdminRollups(store.connection);
    rollups.archiveAndPurge(today - 86_400_000);
    const frozenBefore = rollups.read(oldDay, oldDay + 86_400_000, 'production');
    assert.equal(frozenBefore.length, 1);
    assert.equal(frozenBefore[0].legacyLogRows, 1);
    assert.equal(frozenBefore[0].frozen, true);
    assert.equal(
      (store.connection.prepare('SELECT COUNT(*) AS n FROM legacy_request_metadata').get() as { n: number }).n,
      0,
    );
    await store.rebuildLiveAggregates({ offline: true });
    const current = (await adapters.usageSummary!({ from, to })) as any;
    assert.equal(current.freshness.coverage, 'live-minute+detail-tails');
    assert.equal(current.freshness.legacyMetadataCount, 0);
    assert.equal(
      current.freshness.legacyWritesTracked,
      false,
      'metadata writes are not included in the native watermark',
    );
    assert.equal(current.logicalRequests, 1);
    assert.equal(current.legacyLogRows, 0);
    assert.deepEqual(rollups.read(oldDay, oldDay + 86_400_000, 'production'), frozenBefore);
  } finally {
    controlStore.close();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
