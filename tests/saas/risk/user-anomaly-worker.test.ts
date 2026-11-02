import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  DEFAULT_USER_ANOMALY_INTERVAL_MS,
  MIN_USER_ANOMALY_INTERVAL_MS,
  startUserAnomalyDetectionWorker,
} from '../../../src/saas/risk/user-anomaly-worker.js';
import type { UserAnomalyBatchResult } from '../../../src/saas/risk/user-risk.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class DetectorFake implements Pick<SqlExecutor, 'query'> {
  cycles = 0;

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: true }] as Row[], rowCount: 1 };
    if (sql.includes('WITH recent AS')) return { rows: [] as Row[], rowCount: 0 };
    if (sql.includes('INSERT INTO saas_user_risk_markers')) return { rows: [] as Row[], rowCount: 0 };
    if (sql.includes('INSERT INTO saas_audit_events')) return { rows: [] as Row[], rowCount: 0 };
    throw new Error(`unexpected statement: ${sql}`);
  }

  transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    this.cycles += 1;
    return work(this);
  }
}

test('interval bounds keep the detector cadence safe and bounded', () => {
  assert.equal(DEFAULT_USER_ANOMALY_INTERVAL_MS, 60_000);
  assert.equal(MIN_USER_ANOMALY_INTERVAL_MS, 15_000);
});

test('the worker delays its first cycle, then batches on the interval', async () => {
  const database = new DetectorFake();
  const cycles: UserAnomalyBatchResult[] = [];
  const worker = startUserAnomalyDetectionWorker(database, {
    pollIntervalMs: MIN_USER_ANOMALY_INTERVAL_MS,
    onCycle: (result) => cycles.push(result),
  });
  try {
    await sleep(5);
    assert.equal(database.cycles, 0, 'the first batch waits one interval (read-only startup)');
    // The window stays strictly below two intervals so only one cycle can fire.
    await sleep(MIN_USER_ANOMALY_INTERVAL_MS + 10);
    assert.ok(database.cycles >= 1, 'at least one batch runs after the first interval');
    assert.deepEqual(cycles[0], { detected: 0, rateLimited: 0, keysSuspended: 0, accountsSuspended: 0 });
    assert.ok(cycles.length <= 2, 'cycle count stays bounded by the interval');
  } finally {
    await worker.close();
  }
});

test('a failing cycle reports to onError and the loop reschedules', async () => {
  let failures = 0;
  let succeeded = false;
  let failFirst = true;
  const database = {
    transaction: (work: (executor: SqlExecutor) => Promise<unknown>) => {
      if (failFirst) {
        failFirst = false;
        return Promise.reject(new Error('batch failed'));
      }
      succeeded = true;
      return Promise.resolve(work(new DetectorFake()));
    },
    query: new DetectorFake().query.bind(new DetectorFake()),
  };
  const worker = startUserAnomalyDetectionWorker(database as never, {
    pollIntervalMs: MIN_USER_ANOMALY_INTERVAL_MS,
    onError: (error) => {
      failures += 1;
      assert.ok(error instanceof Error);
    },
  });
  try {
    await sleep(MIN_USER_ANOMALY_INTERVAL_MS + 25);
    assert.equal(failures, 1);
    await sleep(MIN_USER_ANOMALY_INTERVAL_MS + 25);
    assert.equal(succeeded, true, 'the loop reschedules after an error');
  } finally {
    await worker.close();
  }
});

test('close stops the loop and awaits an in-flight delay', async () => {
  const database = new DetectorFake();
  const worker = startUserAnomalyDetectionWorker(database, { pollIntervalMs: MIN_USER_ANOMALY_INTERVAL_MS });
  await sleep(5);
  await worker.close();
  const cyclesAtClose = database.cycles;
  await sleep(MIN_USER_ANOMALY_INTERVAL_MS * 2);
  assert.equal(database.cycles, cyclesAtClose, 'no cycles run after close');
});
