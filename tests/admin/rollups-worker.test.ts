import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { AdminJobs } from '../../src/admin/jobs.js';
import { AdminMaintenance } from '../../src/admin/maintenance.js';
import { AdminRollups } from '../../src/admin/rollups.js';
import type { ControlService } from '../../src/control/service.js';
import type { ControlStore } from '../../src/control/store.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mr-rollup-worker-'));
  const dbPath = join(dir, 'telemetry.sqlite');
  const telemetry = new SQLiteTelemetryStore(dbPath);
  await telemetry.init();
  const audits: Array<{ actor: string; action: string; detail: unknown }> = [];
  const store = {
    dataDir: dir,
    keyPath: join(dir, 'master.key'),
    audit: (actor: string, action: string, detail: unknown) => {
      audits.push({ actor, action, detail });
    },
  } as unknown as ControlStore;
  const maintenance = new AdminMaintenance({} as ControlService, store, telemetry);
  const close = async () => {
    await telemetry.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { telemetry, dbPath, maintenance, audits, close };
}

async function seed(telemetry: SQLiteTelemetryStore) {
  const at = Date.now() - 60_000;
  await telemetry.upsertRequest({
    id: 'req_1',
    proxyKeyId: 'key_1',
    source: 'production',
    clientProtocol: 'openai',
    requestModel: 'model',
    routeId: 'route',
    configRevision: 1,
    state: 'completed',
    finalHttpStatus: 200,
    startedAtMs: at,
    endedAtMs: at + 100,
    durationMs: 100,
    firstByteMs: 10,
    firstEventMs: null,
    firstTextMs: null,
    finalUpstreamId: 'up_1',
  });
  await telemetry.upsertAttempt({
    id: 'attempt_1',
    requestId: 'req_1',
    ordinal: 1,
    upstreamId: 'up_1',
    credentialId: null,
    resolvedModel: 'model',
    reportedModel: null,
    protocol: 'openai',
    outcome: 'completed',
    status: 200,
    retryReason: null,
    startedAtMs: at,
    endedAtMs: at + 100,
    usage: {
      inputTotal: 3,
      inputUncached: 3,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      outputTotal: 2,
      reasoningOutput: null,
      status: 'reported',
      source: 'upstream',
      semanticsVersion: 'v2',
    },
    pricingVersion: null,
    costMicros: 100,
    currency: 'USD',
  });
}

test('aggregate computes on independent worker connection and preserves result shape', async () => {
  const f = await fixture();
  try {
    await seed(f.telemetry);
    const original = AdminRollups.computeRebuildPlan;
    AdminRollups.computeRebuildPlan = () => {
      throw new Error('main-thread compute must not run');
    };
    let result: Awaited<ReturnType<AdminMaintenance['aggregate']>>;
    try {
      result = await f.maintenance.aggregate('admin', new AbortController().signal);
    } finally {
      AdminRollups.computeRebuildPlan = original;
    }
    assert.deepEqual(result, { rows: 1, refreshed: 1, preserved: 0, grain: 'UTC-day', sourceSeparated: true });
    assert.equal(f.audits.length, 1);
    assert.equal(f.audits[0]?.action, 'usage.aggregate_rebuild');
    const row = f.telemetry.connection.prepare('SELECT * FROM admin_usage_daily_v2').get() as any;
    assert.equal(row.logical_requests, 1);
    assert.equal(row.upstream_attempts, 1);
    assert.equal(row.input_tokens, 3);
    assert.equal(row.output_tokens, 2);
  } finally {
    await f.close();
  }
});

test('abort waits for worker exit and leaves no rollup writes after telemetry closes', async () => {
  const f = await fixture();
  try {
    await seed(f.telemetry);
    const controller = new AbortController();
    const running = f.maintenance.aggregate('admin', controller.signal);
    controller.abort();
    await assert.rejects(running, /Aggregate cancelled/);
    assert.equal(f.audits.length, 0);
    assert.equal((f.telemetry.connection.prepare('SELECT COUNT(*) AS n FROM admin_usage_daily_v2').get() as any).n, 0);
    // The worker owns only a read-only connection and has exited before rejection.
    await f.telemetry.close();
    const reopened = new SQLiteTelemetryStore(f.dbPath);
    await reopened.init();
    try {
      assert.equal((reopened.connection.prepare('SELECT COUNT(*) AS n FROM admin_usage_daily_v2').get() as any).n, 0);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('AdminJobs.cancel and close abort running aggregate workers before writeback', async () => {
  const f = await fixture();
  const jobDb = new Database(':memory:');
  const jobs = new AdminJobs({ db: jobDb, audit: () => {} } as unknown as ControlStore);
  try {
    await seed(f.telemetry);
    const run = () => {
      let done!: () => void;
      const settled = new Promise<void>((resolve) => {
        done = resolve;
      });
      const started = jobs.start('aggregate', 'admin', async (signal) => {
        try {
          return await f.maintenance.aggregate('admin', signal);
        } finally {
          done();
        }
      });
      return { id: started.jobId, settled };
    };
    const cancelled = run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(jobs.get(cancelled.id).state, 'running');
    jobs.cancel(cancelled.id, 'admin');
    await cancelled.settled;
    assert.equal(jobs.get(cancelled.id).state, 'cancelled');

    const interrupted = run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(jobs.get(interrupted.id).state, 'running');
    jobs.close();
    await interrupted.settled;
    assert.equal(jobs.get(interrupted.id).state, 'interrupted');
    assert.equal(f.audits.length, 0);
    assert.equal((f.telemetry.connection.prepare('SELECT COUNT(*) AS n FROM admin_usage_daily_v2').get() as any).n, 0);
  } finally {
    jobs.close();
    jobDb.close();
    await f.close();
  }
});
