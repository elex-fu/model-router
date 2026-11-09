import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/index.js';
import {
  AuthorityInvalidationPoller,
  recordAuthorityInvalidation,
} from '../../../src/saas/gateway/authority-invalidation-events.js';

/*
 * §12.2 Phase A2b (D2): the authority/entitlement invalidation broadcast.
 * The table is an at-least-once, coarsely-scoped outbox: control-plane
 * revocation mutations append one row inside the revocation transaction;
 * gateways that opt in poll it and flush their local version-keyed caches.
 * These tests pin the writer contract, the cursor semantics, and the
 * flush-on-observe contract of the poller itself. The admission guard never
 * consults this table — the broadcast is an availability optimization only.
 */

const TENANT_ID = '3f6f8ec7-1a2b-4c5d-9e0f-a1b2c3d4e5f6';

interface CapturedQuery {
  sql: string;
  values: readonly unknown[];
}

function fakeDatabase(rows: Array<Record<string, unknown>> = []) {
  const captured: CapturedQuery[] = [];
  const database = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      captured.push({ sql, values });
      if (sql.includes('COALESCE(MAX(id)')) {
        const highest = rows.reduce((max, row) => (BigInt(String(row.id)) > max ? BigInt(String(row.id)) : max), 0n);
        return { rows: [{ max_id: highest === 0n ? 0 : highest.toString(10) }] as Row[], rowCount: 1 };
      }
      if (sql.includes('WHERE id > $1')) {
        // SQL-level LIMIT emulation WITHOUT parsing ids: the poller itself is
        // responsible for rejecting malformed ids, so the fake passes them
        // through for the real parser to see.
        const after = rows.filter((row) => {
          try {
            return BigInt(String(row.id)) > BigInt(String(values[0]));
          } catch {
            return true;
          }
        });
        const limit = Number(values[1]);
        return { rows: after.slice(0, limit) as Row[], rowCount: Math.min(after.length, limit) };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  } as unknown as SaasDatabase;
  return { database, captured };
}

function countingTarget() {
  let flushes = 0;
  return {
    target: {
      invalidateAll: () => {
        flushes += 1;
      },
    },
    flushes: () => flushes,
  };
}

/** Manual scheduler: captures the scheduled callback for deterministic ticks. */
function manualSchedule() {
  let pending: (() => void) | undefined;
  const schedule = (callback: () => void, _milliseconds: number) => {
    pending = callback;
    return {
      clear: () => {
        pending = undefined;
      },
    };
  };
  return {
    schedule,
    tick: () => {
      const callback = pending;
      pending = undefined;
      if (callback === undefined) throw new Error('no scheduled tick pending');
      callback();
    },
    hasPending: () => pending !== undefined,
  };
}

test('recordAuthorityInvalidation inserts inside the caller transaction with exact sql', async () => {
  const writes: CapturedQuery[] = [];
  const executor = {
    query: async (_sql: string, values: readonly unknown[] = []) => {
      writes.push({ sql: _sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as SqlExecutor;
  await recordAuthorityInvalidation(executor, { tenantId: TENANT_ID, kind: 'api_key.revoked', reason: 'rotated' });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].sql, 'SELECT pg_catalog.pg_advisory_xact_lock(1396788563, 156)');
  assert.ok(writes[1].sql.startsWith('INSERT INTO saas_authority_invalidation_events'));
  assert.deepEqual(writes[1].values, [TENANT_ID, 'api_key.revoked', 'rotated']);
});

test('recordAuthorityInvalidation passes a null reason when omitted', async () => {
  const writes: CapturedQuery[] = [];
  const executor = {
    query: async (_sql: string, values: readonly unknown[] = []) => {
      writes.push({ sql: _sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as SqlExecutor;
  await recordAuthorityInvalidation(executor, { tenantId: TENANT_ID, kind: 'membership.revoked' });
  assert.deepEqual(writes[1].values, [TENANT_ID, 'membership.revoked', null]);
});

test('recordAuthorityInvalidation rejects malformed input before touching the database', async () => {
  let calls = 0;
  const executor = {
    query: async () => {
      calls += 1;
      return { rows: [], rowCount: 0 };
    },
  } as SqlExecutor;
  await assert.rejects(recordAuthorityInvalidation(executor, { tenantId: '', kind: 'api_key.revoked' }), TypeError);
  await assert.rejects(
    recordAuthorityInvalidation(executor, { tenantId: 'x'.repeat(65), kind: 'api_key.revoked' }),
    TypeError,
  );
  await assert.rejects(
    recordAuthorityInvalidation(executor, { tenantId: TENANT_ID, kind: 'api_key.deleted' as never }),
    TypeError,
  );
  await assert.rejects(
    recordAuthorityInvalidation(executor, { tenantId: TENANT_ID, kind: 'api_key.revoked', reason: ' padded ' }),
    TypeError,
  );
  await assert.rejects(
    recordAuthorityInvalidation(executor, { tenantId: TENANT_ID, kind: 'api_key.revoked', reason: 'x'.repeat(256) }),
    TypeError,
  );
  assert.equal(calls, 0);
});

test('poller start initializes the cursor at the table head and defensively flushes', async () => {
  const { database, captured } = fakeDatabase([
    { id: '7', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null },
  ]);
  const clock = manualSchedule();
  const target = countingTarget();
  const poller = new AuthorityInvalidationPoller(database, { schedule: clock.schedule });
  poller.register(target.target);
  await poller.start();
  assert.equal(target.flushes(), 1, 'start performs one defensive flush');
  assert.ok(captured.some((query) => query.sql.includes('COALESCE(MAX(id)')));
  // The head event is BEFORE the cursor: the first poll must not observe it.
  assert.equal(await poller.pollOnce(), 0);
  assert.equal(target.flushes(), 1, 'no new events, no additional flush');
  await poller.stop();
});

test('pollOnce flushes every registered target once when a new event arrives', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const { database } = fakeDatabase(rows);
  const clock = manualSchedule();
  const first = countingTarget();
  const second = countingTarget();
  const poller = new AuthorityInvalidationPoller(database, { schedule: clock.schedule });
  poller.register(first.target);
  poller.register(second.target);
  // Duplicate registration of the same instance is a no-op (Set semantics).
  poller.register(first.target);
  assert.equal(poller.targetCount, 2);
  await poller.start();
  assert.equal(first.flushes(), 1);
  // The event lands after the startup cursor, so the poll observes it.
  rows.push({ id: '3', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: 'rotated' });
  assert.equal(await poller.pollOnce(), 1);
  assert.equal(first.flushes(), 2);
  assert.equal(second.flushes(), 2);
  // The cursor advanced past the batch: a second poll sees nothing.
  assert.equal(await poller.pollOnce(), 0);
  assert.equal(first.flushes(), 2);
  await poller.stop();
});

test('pollOnce advances only past a fully parsed batch and respects the batch limit', async () => {
  const rows: Array<Record<string, unknown>> = [];
  const { database } = fakeDatabase(rows);
  const clock = manualSchedule();
  const target = countingTarget();
  const poller = new AuthorityInvalidationPoller(database, { schedule: clock.schedule, batchLimit: 2 });
  poller.register(target.target);
  await poller.start();
  // Three events land after the cursor; the batch limit (2) defers the third.
  rows.push(
    { id: '31', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null },
    { id: '32', tenant_id: TENANT_ID, kind: 'membership.revoked', reason: null },
    { id: '33', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null },
  );
  assert.equal(await poller.pollOnce(), 2, 'first poll consumes the batch limit only');
  assert.equal(target.flushes(), 2);
  assert.equal(await poller.pollOnce(), 1, 'the next poll continues from the advanced cursor');
  assert.equal(target.flushes(), 3);
  assert.equal(await poller.pollOnce(), 0, 'cursor is now past every event');
  assert.equal(target.flushes(), 3);
  await poller.stop();
});

test('pollOnce leaves the cursor untouched on a malformed batch and does not flush', async () => {
  const { database, captured } = fakeDatabase([
    { id: 'garbage', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null },
  ]);
  const clock = manualSchedule();
  const target = countingTarget();
  const errors: unknown[] = [];
  const poller = new AuthorityInvalidationPoller(database, {
    schedule: clock.schedule,
    onError: (error) => errors.push(error),
  });
  poller.register(target.target);
  // A direct pollOnce surfaces the parse error to its caller.
  await assert.rejects(poller.pollOnce(), TypeError);
  assert.equal(target.flushes(), 0, 'malformed batch never flushes');
  // The cursor is unchanged: the same malformed row is re-read next poll.
  await assert.rejects(poller.pollOnce(), TypeError);
  assert.ok(captured.filter((query) => query.sql.includes('WHERE id > $1')).length >= 2);
  assert.equal(errors.length, 0);
  await poller.stop();
});

test('a failed scheduled tick routes through onError and the next tick retries the unchanged cursor', async () => {
  const { database } = fakeDatabase([{ id: '21', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null }]);
  const clock = manualSchedule();
  const target = countingTarget();
  const errors: unknown[] = [];
  const poller = new AuthorityInvalidationPoller(database, {
    schedule: clock.schedule,
    onError: (error) => errors.push(error),
  });
  poller.register(target.target);
  await poller.start();
  assert.equal(target.flushes(), 1);
  // Simulate database loss: swap the query to reject.
  (database as { query: unknown }).query = async () => {
    throw new Error('database down');
  };
  clock.tick();
  // The in-flight tick completes asynchronously; give it one microtask flush.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.ok(String(errors[0]).includes('database down'));
  assert.equal(target.flushes(), 1, 'a failed poll never flushes');
  assert.ok(clock.hasPending(), 'the next tick is still scheduled');
  // Database recovers: the unchanged cursor re-reads the event stream, and a
  // post-outage event (id past the pre-outage head of 21) is observed.
  const { database: recovered } = fakeDatabase([
    { id: '21', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null },
    { id: '22', tenant_id: TENANT_ID, kind: 'api_key.revoked', reason: null },
  ]);
  (poller as unknown as { database: SaasDatabase }).database = recovered;
  clock.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(target.flushes(), 2, 'recovery observes the event and flushes');
  await poller.stop();
});

test('stop clears the pending tick, waits for in-flight work, and is idempotent', async () => {
  const { database } = fakeDatabase([]);
  const clock = manualSchedule();
  const poller = new AuthorityInvalidationPoller(database, { schedule: clock.schedule });
  await poller.start();
  assert.ok(clock.hasPending());
  await poller.stop();
  assert.equal(clock.hasPending(), false);
  await poller.stop();
  // After stop, a captured tick must not schedule another cycle.
  assert.ok(clock.hasPending() === false);
});

test('stop during cursor initialization prevents a poll from starting after close', async () => {
  const { database } = fakeDatabase();
  let releaseHead: () => void = () => {};
  const waitForHead = new Promise<void>((resolve) => {
    releaseHead = resolve;
  });
  const clock = manualSchedule();
  const target = countingTarget();
  const poller = new AuthorityInvalidationPoller(
    {
      ...database,
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        await waitForHead;
        return database.query<Row>(sql, values);
      },
    },
    { schedule: clock.schedule },
  );
  poller.register(target.target);
  const start = poller.start();
  const shutdown = poller.stop();
  releaseHead();
  await Promise.all([start, shutdown]);
  assert.equal(clock.hasPending(), false);
  assert.equal(target.flushes(), 0);
});

test('double start is a no-op and the poller validates its bounds', async () => {
  const { database, captured } = fakeDatabase([]);
  const clock = manualSchedule();
  const poller = new AuthorityInvalidationPoller(database, { schedule: clock.schedule });
  await poller.start();
  const headQueries = captured.filter((query) => query.sql.includes('COALESCE(MAX(id)')).length;
  await poller.start();
  assert.equal(captured.filter((query) => query.sql.includes('COALESCE(MAX(id)')).length, headQueries);
  await poller.stop();
  assert.throws(() => new AuthorityInvalidationPoller(database, { intervalMs: 0 }), RangeError);
  assert.throws(() => new AuthorityInvalidationPoller(database, { batchLimit: 0.5 }), RangeError);
});
