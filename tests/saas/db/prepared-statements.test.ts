import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createPreparedSqlStatement, queryPreparedOrAnonymous } from '../../../src/saas/db/prepared-statements.js';
import type { PreparedSqlStatement, SqlExecutor } from '../../../src/saas/db/types.js';

test('fixed prepared descriptors are frozen, SQL-hashed and shorter than the wire name limit', () => {
  const sql = 'SELECT $1::text';
  const digest = createHash('sha256').update(sql).digest('base64url');
  for (const label of [
    'cm-final',
    'sched-byok',
    'sched-platform',
    'prep-byok',
    'prep-platform',
    'proof-core',
    'proof-tenant',
    'proof-platform',
  ] as const) {
    const statement = createPreparedSqlStatement(label, sql);
    assert.ok(Object.isFrozen(statement));
    assert.equal(statement.text, sql);
    assert.equal(statement.name, `mr_${label}_${digest}`);
    assert.ok(statement.name.length <= 63);
    assert.equal(createPreparedSqlStatement(label, sql).name, statement.name);
    assert.notEqual(createPreparedSqlStatement(label, `${sql} `).name, statement.name);
  }
});

test('query-only executors receive the exact SQL and current values on every call', async () => {
  const statement = createPreparedSqlStatement('cm-final', 'SELECT $1::text');
  const calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  const executor: SqlExecutor = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  };
  for (const value of ['first-identity', 'second-identity']) {
    const values = Object.freeze([value]);
    await queryPreparedOrAnonymous(executor, statement, values);
    assert.equal(calls.at(-1)?.values, values);
  }
  assert.deepEqual(
    calls.map(({ sql }) => sql),
    [statement.text, statement.text],
  );
});

test('native capability receives the same descriptor and never replays an error anonymously', async () => {
  const statement = createPreparedSqlStatement('sched-byok', 'SELECT $1::text');
  const failure = new Error('expected prepared execution failure');
  const calls: PreparedSqlStatement[] = [];
  let anonymousCalls = 0;
  const executor: SqlExecutor = {
    async query() {
      anonymousCalls += 1;
      return { rows: [], rowCount: 0 };
    },
    async queryPrepared(actual, values) {
      assert.equal(this, executor);
      assert.equal(values?.[0], 'current-identity');
      calls.push(actual);
      throw failure;
    },
  };
  await assert.rejects(
    queryPreparedOrAnonymous(executor, statement, ['current-identity']),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [statement]);
  assert.equal(anonymousCalls, 0);
});
