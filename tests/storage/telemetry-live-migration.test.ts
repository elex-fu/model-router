import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdminRollups } from '../../src/admin/rollups.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import type { RequestRecord } from '../../src/telemetry/types.js';

test('old database needs explicit worker migration; frozen archive purge preserves covered watermark', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mr-live-migrate-'));
  const path = join(dir, 'telemetry.sqlite');
  let store = new SQLiteTelemetryStore(path);
  try {
    await store.init();
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const old = day - 2 * 86_400_000;
    store.connection
      .prepare(`INSERT INTO requests(id,source,client_protocol,state,started_at_ms,ended_at_ms)
      VALUES('old','production','openai','completed',?,?)`)
      .run(old + 1000, old + 2000);
    store.connection
      .prepare(`INSERT INTO attempts(id,request_id,ordinal,upstream_id,protocol,outcome,started_at_ms)
      VALUES('old-attempt','old',1,'u','openai','completed',?)`)
      .run(old + 1100);
    // Simulate upgrading a database that predates live aggregate tables.
    store.connection.exec(
      `DROP TABLE live_request_minute; DROP TABLE live_attempt_minute; DROP TABLE live_aggregate_state`,
    );
    await store.close();
    store = new SQLiteTelemetryStore(path);
    await store.init();
    const coverage = () =>
      (
        store.connection.prepare('SELECT covered_sequence AS n FROM live_aggregate_state WHERE id=1').get() as {
          n: number;
        }
      ).n;
    assert.equal(coverage(), -1);
    assert.equal(store.writeWatermark.sequence, 2);
    await assert.rejects(store.rebuildLiveAggregates({ offline: false as true }), /offline mode/);
    const migration = store.rebuildLiveAggregates({ offline: true });
    let settled = false;
    void migration.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'migration must not execute synchronously on the serving thread');
    const rebuilt = await migration;
    assert.deepEqual({ requests: rebuilt.requests, attempts: rebuilt.attempts }, { requests: 1, attempts: 1 });
    assert.equal(coverage(), store.writeWatermark.sequence);
    assert.equal(
      (store.connection.prepare('SELECT SUM(logical_requests) AS n FROM live_request_minute').get() as { n: number }).n,
      1,
    );

    const rollups = new AdminRollups(store.connection);
    rollups.archiveAndPurge(day - 86_400_000);
    assert.equal(coverage(), store.writeWatermark.sequence);
    assert.equal(
      (store.connection.prepare('SELECT COUNT(*) AS n FROM live_request_minute').get() as { n: number }).n,
      0,
    );
    const frozen = rollups.read(old, old + 86_400_000, 'production');
    assert.equal(frozen.length, 1);
    assert.equal(frozen[0].logicalRequests, 1);
    assert.equal(frozen[0].frozen, true);
    const before = store.writeWatermark.sequence;
    const late: RequestRecord = {
      id: 'late',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: null,
      routeId: null,
      configRevision: null,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: old + 3000,
      endedAtMs: old + 4000,
      durationMs: 1000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    };
    await store.upsertRequest(late);
    assert.equal(store.writeWatermark.sequence, before + 1);
    assert.equal(coverage(), -1, 'late detail must invalidate live coverage');
    await assert.rejects(store.rebuildLiveAggregates({ offline: true }), /LATE_ARCHIVED_DETAIL/);
    assert.equal(rollups.read(old, old + 86_400_000, 'production')[0].logicalRequests, 1);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
