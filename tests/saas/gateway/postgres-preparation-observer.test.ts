import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreparedSqlStatement, queryPreparedOrAnonymous } from '../../../src/saas/db/prepared-statements.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import {
  observePreparationExecutor,
  observePreparationPhase,
  type PostgresPreparationObservation,
} from '../../../src/saas/gateway/postgres-preparation-observer.js';

test('preparation observations expose fixed operation labels and durations without SQL or values', async () => {
  const events: PostgresPreparationObservation[] = [];
  const executor: SqlExecutor = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
  assert.equal(observePreparationExecutor(executor, 'authority', undefined), executor);
  const observed = observePreparationExecutor(executor, 'admission-guard', (event) => events.push(event));
  await observePreparationPhase(
    'admission-guard',
    'revalidate',
    (event) => events.push(event),
    () =>
      observed.query('/* postgres-request-admission:authority-batch */ SELECT $1 FROM saas_api_keys', [
        'private-input',
      ]),
  );
  assert.deepEqual(
    events.map(({ kind, operation, outcome }) => ({ kind, operation, outcome })),
    [
      { kind: 'query', operation: 'postgres-request-admission:authority-batch', outcome: 'ok' },
      { kind: 'phase', operation: 'revalidate', outcome: 'ok' },
    ],
  );
  assert.ok(events.every((event) => event.durationMs >= 0 && Number.isFinite(event.durationMs)));
  assert.doesNotMatch(JSON.stringify(events), /SELECT|private-input|saas_api_keys/);
});

test('observer failure cannot alter a query result or suppress its original error', async () => {
  const failure = new Error('storage failed');
  const executor: SqlExecutor = {
    async query() {
      throw failure;
    },
  };
  const observed = observePreparationExecutor(executor, 'authority', () => {
    throw new Error('observer failed');
  });
  await assert.rejects(observed.query('SELECT 1'), (error) => error === failure);
  const value = await observePreparationPhase(
    'authority',
    'resolve',
    () => {
      throw new Error('observer failed');
    },
    async () => 42,
  );
  assert.equal(value, 42);
});

test('orchestration phase classification records denied results and preserves thrown errors', async () => {
  const events: PostgresPreparationObservation[] = [];
  const observe = (event: PostgresPreparationObservation) => events.push(event);
  const denied = { decision: 'block' } as const;
  assert.equal(
    await observePreparationPhase(
      'preparation',
      'scheduler-select',
      observe,
      async () => denied,
      () => false,
    ),
    denied,
  );
  const failure = new Error('private original error');
  await assert.rejects(
    observePreparationPhase('preparation', 'affinity-bind', observe, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(
    await observePreparationPhase(
      'preparation',
      'preparation-total',
      observe,
      async () => 42,
      () => {
        throw new Error('private classifier error');
      },
    ),
    42,
  );
  assert.deepEqual(
    events.map(({ operation, outcome }) => [operation, outcome]),
    [
      ['scheduler-select', 'error'],
      ['affinity-bind', 'error'],
      ['preparation-total', 'error'],
    ],
  );
  assert.doesNotMatch(JSON.stringify(events), /private|decision/);
});

test('advisory lock labels use SQL form without reading bound authority keys', async () => {
  const events: PostgresPreparationObservation[] = [];
  const executor: SqlExecutor = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
  const observed = observePreparationExecutor(executor, 'admission-guard', (event) => events.push(event));
  await observed.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', ['private-scope']);
  await observed.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', ['987654321']);
  await observed.query('SELECT pg_advisory_xact_lock($1::bigint)', ['123456789']);
  await observed.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['private-wallet']);
  assert.deepEqual(
    events.map(({ operation }) => operation),
    ['advisory-lock-shared', 'advisory-lock-shared-int8', 'advisory-lock-exclusive-int8', 'advisory-lock-exclusive'],
  );
  assert.doesNotMatch(JSON.stringify(events), /private-|123456789|987654321|hashtextextended/);
});

test('different observers retain independent views without executing SQL twice', async () => {
  const outer: PostgresPreparationObservation[] = [];
  const inner: PostgresPreparationObservation[] = [];
  let queries = 0;
  const executor: SqlExecutor = {
    async query() {
      queries += 1;
      return { rows: [], rowCount: 0 };
    },
  };
  const admission = observePreparationExecutor(executor, 'admission', (event) => outer.push(event));
  const guard = observePreparationExecutor(admission, 'admission-guard', (event) => inner.push(event));
  await guard.query('SELECT 1');
  assert.equal(queries, 1);
  assert.equal(outer.length, 1);
  assert.equal(inner.length, 1);
  assert.equal(outer[0]?.phase, 'admission');
  assert.equal(inner[0]?.phase, 'admission-guard');
});

test('prepared capability is preserved through observer layers and identical observers see one execution', async () => {
  const events: PostgresPreparationObservation[] = [];
  let preparedCalls = 0;
  let anonymousCalls = 0;
  const statement = createPreparedSqlStatement(
    'cm-final',
    '/* commercial-final */ SELECT $1 FROM saas_route_config_dispatchable',
  );
  const executor: SqlExecutor = {
    async query() {
      anonymousCalls += 1;
      return { rows: [], rowCount: 0 };
    },
    async queryPrepared(actual, values) {
      assert.equal(this, executor);
      assert.equal(actual, statement);
      assert.equal(values?.[0], 'private-bound-identity');
      preparedCalls += 1;
      return { rows: [], rowCount: 0 };
    },
  };
  const observe = (event: PostgresPreparationObservation) => events.push(event);
  const authority = observePreparationExecutor(executor, 'authority', observe);
  const guard = observePreparationExecutor(authority, 'admission-guard', observe);
  assert.equal(typeof guard.queryPrepared, 'function');
  await queryPreparedOrAnonymous(guard, statement, ['private-bound-identity']);
  assert.equal(preparedCalls, 1);
  assert.equal(anonymousCalls, 0);
  assert.deepEqual(
    events.map(({ phase, operation, outcome }) => ({ phase, operation, outcome })),
    [{ phase: 'admission-guard', operation: 'commercial-final', outcome: 'ok' }],
  );
  assert.doesNotMatch(JSON.stringify(events), /private-bound|SELECT|mr_cm-final|saas_route_config_dispatchable/);
});

test('different prepared observers retain independent observations without duplicate SQL', async () => {
  const outer: PostgresPreparationObservation[] = [];
  const inner: PostgresPreparationObservation[] = [];
  let calls = 0;
  const executor: SqlExecutor = {
    async query() {
      assert.fail('prepared capability must not be replaced by anonymous execution');
    },
    async queryPrepared() {
      calls += 1;
      return { rows: [], rowCount: 0 };
    },
  };
  const admission = observePreparationExecutor(executor, 'admission', (event) => outer.push(event));
  const guard = observePreparationExecutor(admission, 'admission-guard', (event) => inner.push(event));
  await queryPreparedOrAnonymous(guard, createPreparedSqlStatement('sched-platform', 'SELECT $1'), ['private-input']);
  assert.equal(calls, 1);
  assert.equal(outer.length, 1);
  assert.equal(inner.length, 1);
});

test('observer capability absence stays anonymous and prepared errors remain the original error', async () => {
  let anonymousCalls = 0;
  const statement = createPreparedSqlStatement('sched-byok', 'SELECT $1');
  const anonymous = observePreparationExecutor(
    {
      async query() {
        anonymousCalls += 1;
        return { rows: [], rowCount: 0 };
      },
    },
    'authority',
    () => {},
  );
  assert.equal(Object.hasOwn(anonymous, 'queryPrepared'), false);
  await queryPreparedOrAnonymous(anonymous, statement, ['private-input']);
  assert.equal(anonymousCalls, 1);

  const failure = new Error('original prepared failure');
  let preparedCalls = 0;
  const events: PostgresPreparationObservation[] = [];
  const prepared = observePreparationExecutor(
    {
      async query() {
        assert.fail('a prepared error cannot retry anonymously');
      },
      async queryPrepared() {
        preparedCalls += 1;
        throw failure;
      },
    },
    'authority',
    (event) => {
      events.push(event);
      throw new Error('observer failure');
    },
  );
  await assert.rejects(queryPreparedOrAnonymous(prepared, statement, []), (error) => error === failure);
  assert.equal(preparedCalls, 1);
  assert.equal(events[0]?.outcome, 'error');
});
