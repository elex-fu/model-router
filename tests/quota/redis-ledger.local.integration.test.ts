import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createClient } from '@redis/client';
import Database from 'better-sqlite3';
import { SQLiteQuotaLedger } from '../../src/quota/ledger.js';
import { RedisQuotaLedger } from '../../src/quota/redis-ledger.js';
import { RedisQuotaState, type QuotaStatePersistence } from '../../src/quota/redis-state.js';
import { initializeQuotaStore } from '../../src/quota/store.js';
import { QuotaWriteClient } from '../../src/quota/write-client.js';
import type { SaasDatabase, SqlExecutor } from '../../src/saas/db/types.js';
import { PostgresPreparationCapacityAdapter } from '../../src/saas/gateway/postgres-preparation-capacity.js';
import { RedisPreparationCapacity } from '../../src/saas/gateway/redis-preparation-capacity.js';

const enabled = process.env.MODEL_ROUTER_QUOTA_REDIS_TEST === '1';

async function fixture(t: TestContext, options: { maxPending?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mr-quota-redis-'));
  const reserve = createServer();
  await new Promise<void>((resolve, reject) => {
    reserve.once('error', reject);
    reserve.listen(0, '127.0.0.1', resolve);
  });
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const binary = process.env.MODEL_ROUTER_TEST_REDIS_BIN ?? '/opt/homebrew/bin/redis-server';
  assert.ok(existsSync(binary), 'an explicit local Redis binary is required');
  let child = spawn(
    binary,
    ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned Redis startup timed out')), 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Owned Redis exited before readiness'));
    });
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('Ready to accept connections')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const url = `redis://127.0.0.1:${port}`;
  const inspect = createClient({ url });
  inspect.on('error', () => {});
  await inspect.connect();
  const databasePath = join(directory, 'control.sqlite');
  const db = new Database(databasePath);
  db.pragma('journal_mode=WAL');
  initializeQuotaStore(db);
  const namespace = randomUUID();
  const writers = [
    await QuotaWriteClient.open(databasePath, namespace),
    await QuotaWriteClient.open(databasePath, namespace),
  ];
  const stores: RedisQuotaState[] = [];
  let failDb = false;
  let failAfterCommit = false;
  let delayed: Promise<void> | undefined;
  const persistence: QuotaStatePersistence = {
    identity: () => writers[0]!.identity(),
    generation: () => writers[0]!.generation(),
    beginGeneration: (expected) => writers[0]!.beginGeneration(expected),
    load: (keys) => {
      if (failDb) throw new Error('injected DB outage');
      return writers[0]!.load(keys);
    },
    apply: async (batches) => {
      if (delayed) await delayed;
      if (failDb) throw new Error('injected DB outage');
      await writers[0]!.apply(batches);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error('lost commit acknowledgement');
      }
    },
    ping: async (generation) => {
      if (failDb) throw new Error('injected DB outage');
      await writers[0]!.ping(generation);
    },
    expiredRequests: (nowMs, limit) => writers[0]!.expiredRequests(nowMs, limit),
  };
  const open = async (p: QuotaStatePersistence = persistence) => {
    const state = await RedisQuotaState.open({
      url,
      namespace,
      persistence: p,
      background: false,
      maxPending: options.maxPending,
    });
    stores.push(state);
    return new RedisQuotaLedger(state, p);
  };
  t.after(async () => {
    failDb = false;
    delayed = undefined;
    for (const state of stores) await state.close().catch(() => {});
    for (const writer of writers) await writer.close();
    db.close();
    inspect.destroy();
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });
  const now = Date.now();
  const admission = (requestId: string, extra: Record<string, unknown> = {}) => ({
    requestId,
    newRequest: true,
    proxyKeyId: 'shared-key',
    atMs: now,
    periodId: 'today',
    periodStartMs: now - 1000,
    periodEndMs: now + 86400000,
    reserveTokens: 10,
    dailyTokens: 100,
    ...extra,
  });
  return {
    open,
    db,
    admission,
    writers,
    persistence,
    namespace,
    inspect,
    stores,
    redisKey: `mr:quota:{${createHash('sha256').update(namespace).digest('hex')}}`,
    setFailure: (value: boolean) => {
      failDb = value;
    },
    loseCommitAck: () => {
      failAfterCommit = true;
    },
    delayWrites: (value: Promise<void> | undefined) => {
      delayed = value;
    },
    restartFromSnapshot: async () => {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
      child = spawn(
        binary,
        ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let restarted = '';
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis restart timed out')), 5000);
        child.once('error', reject);
        child.stdout.on('data', (chunk) => {
          restarted += String(chunk);
          if (restarted.includes('Ready to accept connections')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    },
  };
}

test('shared Redis quota uses one atomic budget across two gateway instances and writes SQL asynchronously', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const b = await f.open(f.writers[1]);
  const decisions = await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).admit(f.admission(`request-${i}`))),
  );
  assert.equal(decisions.filter((d) => d.allowed).length, 10);
  assert.equal((await a.balance('shared-key', 'today')).reserved, 100);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM quota_reservations').get()!.n,
    0,
    'request admission does not await a DB write',
  );
  const admitted = decisions.flatMap((d, i) => (d.allowed ? [`request-${i}`] : []));
  await Promise.all(
    admitted.map(async (id) => {
      await a.markAttemptSent(id, 'attempt');
      await b.markAttemptSent(id, 'attempt');
      await b.recordAttemptUsage(id, 'attempt', 5);
      await a.settle(id, 5);
      await b.settle(id, 5);
    }),
  );
  assert.deepEqual(await b.balance('shared-key', 'today'), {
    reportedUsed: 50,
    estimatedUsed: 0,
    reserved: 0,
    adjustmentTokens: 0,
    activeRequests: 0,
  });
  await a.state.flush();
  assert.equal((f.db.prepare('SELECT reported_used FROM quota_periods').get() as any).reported_used, 50);
  assert.equal(
    (await b.admit({ ...f.admission(admitted[0]!), newRequest: false })).allowed,
    false,
    'DB read-through preserves terminal replay after cache eviction',
  );
});

test('DB outage stops new admissions but permits in-flight settlement, then replay converges once', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  await a.admit(f.admission('one'));
  await a.state.flush();
  f.setFailure(true);
  await assert.rejects(a.state.flushOnce(), /persistence unavailable/);
  assert.equal((await a.admit(f.admission('two'))).reason, 'quota_unavailable');
  await a.markAttemptSent('one', 'attempt');
  await a.recordAttemptUsage('one', 'attempt', 7);
  await a.settle('one', 7);
  assert.equal((await a.balance('shared-key', 'today')).reportedUsed, 7);
  f.setFailure(false);
  f.loseCommitAck();
  await assert.rejects(a.state.flushOnce(), /persistence unavailable/);
  await a.state.flush();
  assert.equal((f.db.prepare('SELECT reported_used FROM quota_periods').get() as any).reported_used, 7);
  assert.equal((await a.admit(f.admission('two'))).allowed, true);
});

test('slow persistence is outside warmed admission; queue bounds reject only new work', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t, { maxPending: 2 });
  const a = await f.open();
  await a.admit(f.admission('warm'));
  await a.settle('warm', 0);
  await a.state.flush();
  let release!: () => void;
  f.delayWrites(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await a.admit(f.admission('one'));
  const draining = a.state.flushOnce();
  const started = performance.now();
  assert.equal((await a.admit(f.admission('two'))).allowed, true);
  assert.ok(performance.now() - started < 150, 'warmed admission must not wait for held DB persistence');
  assert.equal((await a.admit(f.admission('three'))).reason, 'quota_unavailable');
  await a.settle('one', 3);
  await a.settle('two', 4);
  release();
  f.delayWrites(undefined);
  await draining;
  await a.state.flush();
  assert.equal((await a.balance('shared-key', 'today')).reportedUsed, 7);
});

test('Redis state loss reloads persisted quotas and fences old-generation writes', { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  await a.admit(f.admission('one'));
  await a.settle('one', 80);
  await a.state.flush();
  const generation = Number(await f.inspect.hGet(f.redisKey, 'generation'));
  await f.inspect.del(f.redisKey);
  const b = await f.open(f.writers[1]);
  assert.equal((await b.balance('shared-key', 'today')).reportedUsed, 80);
  assert.equal((await b.admit(f.admission('two', { reserveTokens: 30 }))).reason, 'daily_tokens_exceeded');
  await assert.rejects(f.writers[0]!.apply([{ generation, version: 999, rows: [] }]), /Stale quota/);
});

test('Redis restart with an older disk snapshot cannot roll back SQL-confirmed usage', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  await a.admit(f.admission('one'));
  await a.settle('one', 80);
  await a.state.flush();
  await f.inspect.sendCommand(['SAVE']);
  await a.admit(f.admission('two'));
  await a.settle('two', 10);
  await a.state.flush();
  await f.restartFromSnapshot();
  let used: number | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      used = (await a.balance('shared-key', 'today')).reportedUsed;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(used, 90, 'reconnected instances must reload the newer SQL state, not the older Redis snapshot');
  await a.state.flush();
  assert.equal((await a.admit(f.admission('three', { reserveTokens: 20 }))).reason, 'daily_tokens_exceeded');
});

test('different per-server databases cannot silently share one Redis quota namespace', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  await f.open();
  const wrong = { ...f.persistence, identity: async () => randomUUID() };
  await assert.rejects(f.open(wrong), /Shared quota store unavailable/);
});

test('switching existing quotas to Redis recovers interrupted usage without observation logs', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  const legacy = new SQLiteQuotaLedger({ connection: f.db });
  const atMs = Date.now() - 700000;
  await legacy.admit(f.admission('interrupted', { atMs, periodStartMs: atMs - 1000 }));
  await legacy.markAttemptSent('interrupted', 'sent');
  await legacy.recordAttemptUsage('interrupted', 'sent', 37);
  const a = await f.open();
  assert.equal(await a.recoverInterrupted(), 1);
  assert.deepEqual(await a.balance('shared-key', 'today'), {
    reportedUsed: 37,
    estimatedUsed: 0,
    reserved: 0,
    adjustmentTokens: 0,
    activeRequests: 0,
  });
  await a.state.flush();
  assert.equal(await a.recoverInterrupted(), 0);
});

test('SaaS instances share capacity and only release cancellation after SQL terminal commit', {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  const a = await f.open();
  const b = await f.open(f.writers[1]);
  const committed = new Map<string, { execution_state: string; any_sent: boolean }>();
  const database = {
    query: async (_sql: string, values: readonly unknown[]) => ({
      rows: committed.has(String(values[1])) ? [committed.get(String(values[1]))] : [],
      rowCount: 1,
    }),
  } as unknown as SaasDatabase;
  const first = new RedisPreparationCapacity(a.state, database, f.namespace);
  const second = new RedisPreparationCapacity(b.state, database, f.namespace);
  const executor: SqlExecutor = {
    query: async <Row>(_sql: string, values: readonly unknown[] = []) => ({
      rows: [{ id: values[1] }] as Row[],
      rowCount: 1,
    }),
  };
  const limits = {
    tenant: { rpm: 100n, tpm: 10000n, concurrency: 3n },
    project: { rpm: 100n, tpm: 10000n, concurrency: 100n },
    key: { rpm: 100n, tpm: 10000n, concurrency: 100n },
  };
  const input = (i: number) => ({
    tenantId: 'tenant',
    projectId: `project-${i % 2}`,
    proxyKeyId: `key-${i % 2}`,
    requestId: `capacity-${i}`,
    attemptId: `attempt-${i}`,
    supplyMode: 'byok' as const,
    newRequest: true,
    idempotencyScopeKey: `scope-${i}`,
    requestFingerprint: `fingerprint-${i}`,
    requestFingerprintVersion: 'v1',
    payloadBounds: {
      inputTotalUpperBound: '10',
      inputUncachedUpperBound: '10',
      cacheReadUpperBound: '0',
      cacheWriteUpperBound: '0',
      cacheWrite5mUpperBound: '0',
      cacheWrite1hUpperBound: '0',
      outputTotalUpperBound: '0',
      reasoningOutputUpperBound: '0',
      feasibleInputBuckets: ['input'],
    },
  });
  const decisions = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      (i % 2 ? second : first).reserve(executor, input(i), limits, 1n, 1n, null, 10n),
    ),
  );
  assert.equal(decisions.filter((d) => d.decision === 'allow').length, 3);
  const chosen = decisions.findIndex((d) => d.decision === 'allow');
  const admitted = input(chosen);
  const owner = chosen % 2 ? second : first;
  const reservation = await owner.find(admitted.requestId);
  assert.ok(reservation);
  committed.set(admitted.requestId, { execution_state: 'pending', any_sent: false });
  const releaseExecutor: SqlExecutor = {
    query: async <Row>() => ({
      rows: [
        {
          project_id: admitted.projectId,
          proxy_key_id: admitted.proxyKeyId,
          dispatch_state: 'not_sent',
          result_state: 'pending',
          response_started: false,
          execution_state: 'pending',
          reconciliation_state: 'none',
          any_attempt_dispatched: false,
        },
      ] as Row[],
      rowCount: 1,
    }),
  };
  const adapter = new PostgresPreparationCapacityAdapter(owner);
  const release = await adapter.release(releaseExecutor, {
    ...admitted,
    quotaReservation: { reference: String(reservation.quota_reservation_id), state: 'reserved' },
    rateReservation: { reference: String(reservation.rate_reservation_id), state: 'reserved' },
  });
  assert.equal(release.quotaReservation, 'released');
  await owner.complete(admitted.requestId);
  assert.equal(
    (await owner.find(admitted.requestId))?.state,
    'reserved',
    'a rolled-back/pending SQL cancellation keeps capacity',
  );
  assert.notEqual((await first.reserve(executor, input(30), limits, 1n, 1n, null, 10n)).decision, 'allow');
  committed.set(admitted.requestId, { execution_state: 'failed', any_sent: false });
  await owner.complete(admitted.requestId);
  await owner.complete(admitted.requestId);
  assert.equal((await owner.find(admitted.requestId))?.state, 'released');
  assert.equal((await first.reserve(executor, input(30), limits, 1n, 1n, null, 10n)).decision, 'allow');
  const scope = await a.state.read<{ active: number; windows: Record<string, { requests: number; tokens: number }> }>(
    JSON.stringify(['capacityScope', 'tenant', 'tenant']),
  );
  assert.equal(scope?.active, 3);
  assert.equal(
    Object.values(scope!.windows).reduce((n, v) => n + v.tokens, 0),
    30,
    'cancelled tokens refunded exactly once',
  );
});
