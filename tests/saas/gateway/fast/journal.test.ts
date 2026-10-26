import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setImmediate as flushMicrotasks } from 'node:timers/promises';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import {
  calculateFastReceiptCharge,
  fastJournalCanonicalJson,
  fastJournalDigest,
  PostgresFastGatewayJournal,
} from '../../../../src/saas/gateway/fast/journal.js';
import { priceFixture } from './journal-fixture.js';

test('fast receipt money remains exact beyond Number.MAX_SAFE_INTEGER and survives JSON', () => {
  const snapshot = priceFixture('9007199254740993');
  const roundtrip = JSON.parse(fastJournalCanonicalJson(snapshot));
  assert.equal(
    calculateFastReceiptCharge(roundtrip, { inputTotal: '9007199254740993', outputTotal: '0' }),
    9007199254740993n,
  );
  assert.equal(fastJournalDigest({ b: 2n, a: 'x' }), fastJournalDigest({ a: 'x', b: '2' }));
  assert.throws(() => fastJournalCanonicalJson({ lossy: Number.MAX_SAFE_INTEGER + 1 }), /INVALID_JSON/);
});

function schedulerFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const errors: string[] = [];
  const database: SaasDatabase = {
    async query<Row>(sql: string): Promise<SqlResult<Row>> {
      assert.ok(sql.startsWith('INSERT INTO saas_fast_gateway_owners') || sql.includes('fast-journal:append-receipt'));
      return { rows: [], rowCount: 1 };
    },
    transaction: async () => {
      throw new Error('scheduler fixture must not execute billing transactions');
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
  const journal = new PostgresFastGatewayJournal(database, {
    allocationOwner: 'scheduler-test',
    workerPollMs: 25,
    workerBatchSize: 128,
    onBackgroundError: (code) => errors.push(code),
  });
  const runs: {
    at: number;
    limit: number | undefined;
    resolve(count: number): void;
    reject(error: Error): void;
  }[] = [];
  t.mock.method(
    journal,
    'runOnce',
    (limit?: number) => new Promise<number>((resolve, reject) => runs.push({ at: Date.now(), limit, resolve, reject })),
  );
  t.after(async () => {
    for (const run of runs) run.resolve(0);
    await flushMicrotasks();
    await journal.close({ drain: false });
  });
  let receipts = 0;
  const notify = async (count = 1) => {
    for (let index = 0; index < count; index++) {
      await journal.appendReceipt({
        intentId: `intent-${++receipts}`,
        requestId: `request-${receipts}`,
        tenantId: 'tenant',
        outcome: 'succeeded',
        chargeMinorUnits: '1',
        usage: { inputTotal: '1', outputTotal: '0' },
        usageDigest: 'a'.repeat(64),
        httpStatus: 200,
      });
    }
  };
  const finish = async (count: number) => {
    assert.ok(runs.at(-1));
    runs.at(-1)?.resolve(count);
    await flushMicrotasks();
  };
  journal.start();
  return { journal, runs, notify, finish, errors };
}

test('fast journal scheduler preserves full-batch continuation and coalesces receipt wakes without overlap', async (t) => {
  const { runs, notify, finish } = schedulerFixture(t);
  t.mock.timers.tick(25);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.limit, 128);
  await notify(10);
  t.mock.timers.tick(500);
  assert.equal(runs.length, 1, 'receipt hints never overlap a running batch');
  await finish(128);
  assert.equal(runs.length, 1, 'continuation yields through a timer, not a synchronous busy loop');
  await notify(10);
  t.mock.timers.tick(0);
  assert.equal(runs.length, 2, 'neither in-flight nor later hints delay a full batch by 25ms');
  assert.equal(runs[1]?.at, 525);
  await finish(128);
  t.mock.timers.tick(0);
  assert.equal(runs.length, 3, 'a full batch also continues without a hint');
  await finish(0);
  t.mock.timers.tick(49);
  assert.equal(runs.length, 3, 'consumed hints do not keep an empty worker spinning');
  t.mock.timers.tick(1);
  assert.equal(runs.length, 4);
});

test('fast journal scheduler catches up a partial batch once, then backs off on empty work', async (t) => {
  const { runs, notify, finish } = schedulerFixture(t);
  t.mock.timers.tick(25);
  await notify(10);
  await finish(54);
  t.mock.timers.tick(0);
  assert.equal(runs.length, 2, 'new durable receipts need not wait for a batch to fill');
  assert.equal(runs[1]?.at, 25);
  await finish(0);
  t.mock.timers.tick(49);
  assert.equal(runs.length, 2, 'one catch-up consumes all coalesced hints');
  t.mock.timers.tick(1);
  assert.equal(runs.length, 3);
  await finish(54);
  t.mock.timers.tick(24);
  assert.equal(runs.length, 3, 'partial work without a new receipt retains the base poll');
  t.mock.timers.tick(1);
  assert.equal(runs.length, 4);
});

test('fast journal scheduler bounds idle polling and never immediately spins on empty receipt hints', async (t) => {
  const { runs, notify, finish } = schedulerFixture(t);
  t.mock.timers.tick(25);
  for (const delay of [50, 100, 200, 400, 800, 1000, 1000]) {
    const count = runs.length;
    await finish(0);
    t.mock.timers.tick(delay - 1);
    assert.equal(runs.length, count, `idle poll waits ${delay}ms`);
    t.mock.timers.tick(1);
    assert.equal(runs.length, count + 1);
  }
  for (let index = 0; index < 3; index++) {
    const count = runs.length;
    await notify(10);
    await finish(0);
    t.mock.timers.tick(24);
    assert.equal(runs.length, count, 'even repeated empty in-flight hints must wait the base interval');
    t.mock.timers.tick(1);
    assert.equal(runs.length, count + 1);
  }
  await finish(0);
  const count = runs.length;
  await notify(10);
  t.mock.timers.tick(24);
  assert.equal(runs.length, count, 'idle wakes coalesce rather than postponing or duplicating the timer');
  t.mock.timers.tick(1);
  assert.equal(runs.length, count + 1, 'durable work can still shorten an idle backoff');
});

test('fast journal scheduler preserves failure backoff against running and later receipt hints', async (t) => {
  const { runs, notify, finish, errors } = schedulerFixture(t);
  t.mock.timers.tick(25);
  for (let attempt = 0; attempt < 2; attempt++) {
    const count = runs.length;
    if (attempt === 0) await notify(10);
    runs.at(-1)?.reject(new Error('injected worker failure'));
    await flushMicrotasks();
    await notify(10);
    t.mock.timers.tick(999);
    assert.equal(runs.length, count, 'no receipt hint bypasses the failed worker retry delay');
    t.mock.timers.tick(1);
    assert.equal(runs.length, count + 1);
  }
  assert.deepEqual(errors, ['FAST_JOURNAL_WORKER_FAILED', 'FAST_JOURNAL_WORKER_FAILED']);
  await notify();
  await finish(54);
  t.mock.timers.tick(0);
  assert.equal(runs.length, 4, 'a successful retry restores normal catch-up scheduling');
});

test('fast journal scheduler never reschedules after close during a running hinted batch', async (t) => {
  const { journal, runs, notify, finish } = schedulerFixture(t);
  t.mock.timers.tick(25);
  await notify(10);
  const closed = journal.close({ drain: false });
  await finish(128);
  await closed;
  t.mock.timers.tick(10_000);
  assert.equal(runs.length, 1);
});
test('incomplete, unsupported, over-bound and multiplier usage cannot settle', () => {
  const snapshot = priceFixture();
  const invalid: Readonly<Record<string, string | null>>[] = [
    { inputTotal: null, outputTotal: '1' },
    { inputTotal: '81', outputTotal: '0' },
    { inputTotal: '2', outputTotal: '0', cacheRead: '1' },
  ];
  for (const usage of invalid) assert.throws(() => calculateFastReceiptCharge(snapshot, usage));
  assert.throws(() =>
    calculateFastReceiptCharge(
      { ...snapshot, customerPrice: { ...snapshot.customerPrice, tokenMultipliers: {} } },
      { inputTotal: '1', outputTotal: '0' },
    ),
  );
});

test('cache aggregate plus TTL detail is priced once, reasoning remains included in output and mismatched aggregates fail', () => {
  const snapshot = priceFixture('20', '10');
  const usage = {
    inputTotal: '10',
    inputUncached: '2',
    cacheRead: '3',
    cacheWrite: '5',
    cacheWrite5m: '4',
    cacheWrite1h: '1',
    outputTotal: '7',
    reasoningOutput: '6',
  };
  assert.equal(calculateFastReceiptCharge(snapshot, usage), 17n);
  assert.throws(() => calculateFastReceiptCharge(snapshot, { ...usage, cacheWrite: '6' }), /INCONSISTENT_USAGE/);
  assert.throws(() => calculateFastReceiptCharge(snapshot, { ...usage, reasoningOutput: '8' }));
});
