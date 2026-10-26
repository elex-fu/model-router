import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  createLockWindowCollector,
  installLockWindowObserver,
} = require('../../../scripts/ops/pg-lock-window-observer.cjs');
const walletSql = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
const counterSql = 'INSERT INTO saas_provider_account_rate_counters (example) VALUES ($1)';

test('diagnostic windows start on successful acquisition completion and end on COMMIT acknowledgement', () => {
  let now = 0;
  const observer = createLockWindowCollector({ now: () => now });
  const client = {};
  const run = (sql: string, start: number, end: number, command: string, values?: unknown[]) => {
    now = start;
    const finish = observer.start(client, sql, values);
    now = end;
    finish(null, { command });
  };
  run('BEGIN ISOLATION LEVEL READ COMMITTED', 0, 2, 'BEGIN');
  run(counterSql, 3, 13, 'INSERT', ['never-report-sensitive-value']);
  run(walletSql, 14, 34, 'SELECT', ['model-router:wallet-fence:sensitive-tenant:sensitive-currency']);
  run(walletSql, 35, 36, 'SELECT', ['model-router:wallet-fence:sensitive-tenant:sensitive-currency']);
  run('COMMIT', 40, 45, 'COMMIT');
  const result = observer.snapshot();
  assert.equal(result.committed, 1);
  assert.equal(result.activeTransactions, 0);
  assert.equal(result.queries.successfulElapsedMs.count, 5);
  assert.equal(result.queries.successfulElapsedMs.sumMs, 38);
  assert.equal(result.transactions.committedDurationMs.sumMs, 43);
  assert.equal(result.transactions.committedQueryElapsedTotalMs.sumMs, 36);
  assert.equal(result.transactions.committedQueryCount, 4);
  assert.equal(result.domains.accountCounter.acquisitionQueryElapsedMs.sumMs, 10);
  assert.equal(result.domains.accountCounter.acquiredToCommitAckMs.sumMs, 32);
  assert.equal(result.domains.walletFence.acquisitionQueryElapsedMs.sumMs, 21);
  assert.equal(result.domains.walletFence.acquiredToCommitAckMs.sumMs, 11);
  assert.equal(result.domains.walletFence.repeatedAcquisitionQueries, 1);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('rollback, failed acquisition/commit, implicit operations and reset-crossing transactions never become commit windows', () => {
  let now = 0;
  const observer = createLockWindowCollector({ now: () => now });
  const client = {};
  const run = (sql: string, error: Error | null, command: string, values?: unknown[]) => {
    const finish = observer.start(client, sql, values);
    now += 10;
    finish(error, { command });
  };
  run(counterSql, null, 'INSERT'); // no explicit BEGIN
  run('BEGIN', null, 'BEGIN');
  run(counterSql, new Error('synthetic'), '');
  run(walletSql, null, 'SELECT', ['not-a-wallet-fence']);
  run(counterSql, null, 'INSERT');
  run('COMMIT', null, 'ROLLBACK'); // aborted PostgreSQL transaction
  run('BEGIN', null, 'BEGIN');
  run(counterSql, null, 'INSERT');
  run('COMMIT', new Error('ambiguous'), '');
  let result = observer.snapshot();
  assert.equal(result.rolledBack, 1);
  assert.equal(result.commitFailures, 1);
  assert.equal(result.domains.accountCounter.failedAcquisitionQueries, 1);
  assert.equal(result.domains.accountCounter.acquiredToCommitAckMs.count, 0);
  assert.equal(result.domains.accountCounter.acquiredToRollbackAckMs.count, 1);
  assert.equal(result.domains.walletFence.successfulAcquisitionQueries, 0);
  run('BEGIN', null, 'BEGIN');
  run(counterSql, null, 'INSERT');
  observer.reset();
  run('COMMIT', null, 'COMMIT');
  result = observer.snapshot();
  assert.equal(result.resetCrossingTransactions, 1);
  assert.equal(result.committed, 0);
  assert.equal(result.domains.accountCounter.acquiredToCommitAckMs.count, 0);
});

test('client wrapper preserves native promise identity, prepared config, callback context/results and original errors', async () => {
  let resolve!: (result: unknown) => void;
  let returned: Promise<unknown>;
  const selected: unknown[] = [];
  const failure = new Error('original failure');
  const callbackContext = {};
  class Client {
    query(...args: unknown[]) {
      selected.push(...args);
      if (args[0] === 'throw') throw failure;
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        callback.call(callbackContext, null, { command: 'BEGIN' });
        return callbackContext;
      }
      returned = new Promise((r) => {
        resolve = r;
      });
      return returned;
    }
  }
  const observer = installLockWindowObserver(Client);
  try {
    const client = new Client();
    let callbackThis: unknown;
    assert.equal(
      client.query('BEGIN', function (this: unknown, error: unknown, result: unknown) {
        callbackThis = this;
        assert.equal(error, null);
        assert.deepEqual(result, { command: 'BEGIN' });
      }),
      callbackContext,
    );
    assert.equal(callbackThis, callbackContext);
    const config = { name: 'prepared-name', text: counterSql, values: ['secret'] };
    const promise = client.query(config);
    assert.equal(promise, returned);
    assert.ok(selected.includes(config), 'pass the original config to pg unchanged');
    resolve({ command: 'INSERT' });
    await promise;
    const committed = client.query('COMMIT');
    resolve({ command: 'COMMIT' });
    await committed;
    assert.equal(observer.snapshot().domains.accountCounter.acquiredToCommitAckMs.count, 1);
    assert.throws(
      () => client.query('throw'),
      (error) => error === failure,
    );
  } finally {
    observer.uninstall();
  }
});

test('bounded quantile samples disclose truncation while all-event count/sum remain exact', () => {
  let now = 0;
  const observer = createLockWindowCollector({ now: () => now, sampleLimit: 2 });
  for (let i = 0; i < 3; i++) {
    const client = {};
    observer.start(client, 'BEGIN')(null, { command: 'BEGIN' });
    const acquired = observer.start(client, counterSql);
    now += 5;
    acquired(null, { command: 'INSERT' });
    const commit = observer.start(client, 'COMMIT');
    now += 10;
    commit(null, { command: 'COMMIT' });
  }
  const stats = observer.snapshot().domains.accountCounter.acquiredToCommitAckMs;
  assert.equal(stats.count, 3);
  assert.equal(stats.sumMs, 30);
  assert.equal(stats.quantileSampleCount, 2);
  assert.equal(stats.quantilesTruncated, true);
});

test('savepoint-controlled transactions do not overstate a lock retained until final commit', () => {
  const observer = createLockWindowCollector();
  const client = {};
  observer.start(client, 'BEGIN')(null, { command: 'BEGIN' });
  observer.start(client, counterSql)(null, { command: 'INSERT' });
  observer.start(client, 'SAVEPOINT nested')(null, { command: 'SAVEPOINT' });
  observer.start(client, 'ROLLBACK TO SAVEPOINT nested')(null, { command: 'ROLLBACK' });
  observer.start(client, 'COMMIT')(null, { command: 'COMMIT' });
  const result = observer.snapshot();
  assert.equal(result.committed, 1);
  assert.equal(result.savepointTransactions, 1);
  assert.equal(result.domains.accountCounter.acquiredToCommitAckMs.count, 0);
});

test('all-query and transaction totals include unclassified SQL but exclude BEGIN from per-transaction sums', () => {
  let now = 0;
  const observer = createLockWindowCollector({ now: () => now });
  const client = {};
  const run = (sql: string, command: string, error: Error | null = null) => {
    const finish = observer.start(client, sql);
    now += 5;
    finish(error, { command });
  };
  run('SELECT outside_transaction', 'SELECT');
  run('BEGIN', 'BEGIN');
  run('SELECT private_payload_not_emitted', 'SELECT');
  run('SELECT failing_statement_not_emitted', '', new Error('private error text'));
  run('ROLLBACK', 'ROLLBACK');
  const result = observer.snapshot();
  assert.equal(result.queries.successfulElapsedMs.count, 4);
  assert.equal(result.queries.failedElapsedMs.sumMs, 5);
  assert.equal(result.transactions.rolledBackDurationMs.sumMs, 15);
  assert.equal(result.transactions.rolledBackQueryElapsedTotalMs.sumMs, 15);
  assert.equal(result.transactions.rolledBackQueryCount, 3);
  assert.ok(!JSON.stringify(result).includes('private_payload'));
});
