import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS,
  DEFAULT_SAAS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS,
  DEFAULT_SAAS_DATABASE_POOL_MAX,
  resolveSaasDatabasePoolSettings,
  resolveSaasDatabasePreparedStatements,
  SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV,
  SAAS_DATABASE_POOL_MAX_ENV,
  SAAS_DATABASE_PREPARED_STATEMENTS_ENV,
} from '../../../src/saas/db/database.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import { createPreparedSqlStatement, queryPreparedOrAnonymous } from '../../../src/saas/db/prepared-statements.js';
import type {
  PreparedSqlStatement,
  SaasDatabaseClient,
  SaasDatabaseOptions,
  SaasDatabasePool,
  SqlResult,
} from '../../../src/saas/db/types.js';

class FakeClient implements SaasDatabaseClient {
  readonly statements: string[] = [];
  releases: Array<Error | boolean | undefined> = [];
  beginFailure?: Error;

  async query<Row>(sql: string): Promise<SqlResult<Row>> {
    this.statements.push(sql);
    if (sql.startsWith('BEGIN') && this.beginFailure) throw this.beginFailure;
    return { rows: [], rowCount: 0 };
  }

  release(error?: Error | boolean): void {
    this.releases.push(error);
  }
}

class FakePool implements SaasDatabasePool {
  readonly queries: string[] = [];
  readonly client = new FakeClient();
  endCalls = 0;
  connectCalls = 0;

  async query<Row>(sql: string): Promise<SqlResult<Row>> {
    this.queries.push(sql);
    return { rows: [], rowCount: 1 };
  }

  async connect(): Promise<SaasDatabaseClient> {
    this.connectCalls += 1;
    return this.client;
  }

  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

class PreparedClient extends FakeClient {
  readonly prepared: Array<{ statement: PreparedSqlStatement; values: readonly unknown[] | undefined }> = [];
  failure?: Error;

  async queryPrepared<Row>(statement: PreparedSqlStatement, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    this.prepared.push({ statement, values });
    if (this.failure) throw this.failure;
    return { rows: [], rowCount: 0 };
  }
}

class PreparedPool extends FakePool {
  override readonly client = new PreparedClient();
  readonly prepared: Array<{ statement: PreparedSqlStatement; values: readonly unknown[] | undefined }> = [];

  async queryPrepared<Row>(statement: PreparedSqlStatement, values?: readonly unknown[]): Promise<SqlResult<Row>> {
    this.prepared.push({ statement, values });
    return { rows: [], rowCount: 0 };
  }
}

function options(pool: SaasDatabasePool, overrides: Partial<SaasDatabaseOptions> = {}): SaasDatabaseOptions {
  return {
    connectionString: 'postgresql://saas-user:secret@localhost/saas',
    pool,
    ...overrides,
  };
}

test('validates PostgreSQL configuration without exposing connection details', () => {
  const secretDsn = 'mysql://saas-user:top-secret@db.example/private';

  assert.throws(
    () => createSaasDatabase({ connectionString: secretDsn }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes('top-secret'), false);
      assert.equal(error.message.includes(secretDsn), false);
      return true;
    },
  );
  assert.throws(
    () => createSaasDatabase({ connectionString: 'postgresql://user:pass@db/saas', max: 0 }),
    /max must be a positive integer/,
  );
  assert.throws(() => createSaasDatabase({ connectionString: 'not-a-url' }), /valid PostgreSQL URL/);
});

test('does not use the pool until an explicit operation and closes idempotently', async () => {
  const pool = new FakePool();
  const database = createSaasDatabase(options(pool));

  assert.equal(pool.connectCalls, 0);
  assert.deepEqual(pool.queries, []);
  await database.ping();
  assert.deepEqual(pool.queries, ['SELECT 1']);

  await Promise.all([database.close(), database.close()]);
  assert.equal(pool.endCalls, 1);
});

test('rolls back a failed transaction and releases its client', async () => {
  const pool = new FakePool();
  const database = createSaasDatabase(options(pool));
  const failure = new Error('expected transaction failure');

  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.query<{ value: number }>('SELECT 1');
      throw failure;
    }),
    (error: unknown) => error === failure,
  );

  assert.deepEqual(pool.client.statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT 1', 'ROLLBACK']);
  assert.deepEqual(pool.client.releases, [false]);
});

test('explicitly starts READ COMMITTED before work, commits, and releases its client', async () => {
  const pool = new FakePool();
  const database = createSaasDatabase(options(pool));
  const result = await database.transaction(async (tx) => {
    await tx.query('SELECT 1');
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.deepEqual(pool.client.statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT 1', 'COMMIT']);
  assert.deepEqual(pool.client.releases, [false]);
});

test('does not invoke transaction work when the explicit isolation boundary fails', async () => {
  const pool = new FakePool();
  const database = createSaasDatabase(options(pool));
  const failure = new Error('isolation boundary failed');
  pool.client.beginFailure = failure;
  let workInvoked = false;

  await assert.rejects(
    database.transaction(async () => {
      workInvoked = true;
    }),
    (error: unknown) => error === failure,
  );

  assert.equal(workInvoked, false);
  assert.deepEqual(pool.client.statements, ['BEGIN ISOLATION LEVEL READ COMMITTED']);
  assert.deepEqual(pool.client.releases, [true]);
});

test('pool settings default to the documented PostgreSQL budget shape', () => {
  assert.deepEqual(resolveSaasDatabasePoolSettings({}, {}), {
    max: DEFAULT_SAAS_DATABASE_POOL_MAX,
    idleTimeoutMillis: DEFAULT_SAAS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS,
    connectionTimeoutMillis: DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS,
  });
  // The default aggregate must fit PostgreSQL 16 defaults: five reference
  // deployment processes at max_connections 100 minus 3 reserved.
  assert.ok(5 * DEFAULT_SAAS_DATABASE_POOL_MAX <= 100 - 3);
});

test('environment overrides apply to pool max and acquisition timeout', () => {
  assert.deepEqual(
    resolveSaasDatabasePoolSettings(
      {},
      { [SAAS_DATABASE_POOL_MAX_ENV]: '32', [SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV]: '15000' },
    ),
    { max: 32, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 },
  );
  // Whitespace is tolerated; 0 disables the acquisition timeout.
  assert.deepEqual(
    resolveSaasDatabasePoolSettings(
      {},
      { [SAAS_DATABASE_POOL_MAX_ENV]: ' 8 ', [SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV]: '0' },
    ),
    { max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 0 },
  );
});

test('explicit options win over environment overrides', () => {
  assert.deepEqual(
    resolveSaasDatabasePoolSettings(
      { max: 4, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 2_000 },
      { [SAAS_DATABASE_POOL_MAX_ENV]: '32', [SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV]: '15000' },
    ),
    { max: 4, idleTimeoutMillis: 1_000, connectionTimeoutMillis: 2_000 },
  );
});

test('malformed or out-of-range pool environment overrides fail closed', () => {
  for (const value of ['abc', '-1', '1.5', '0', '10001', '']) {
    assert.throws(
      () => resolveSaasDatabasePoolSettings({}, { [SAAS_DATABASE_POOL_MAX_ENV]: value }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.ok(error.message.includes(SAAS_DATABASE_POOL_MAX_ENV));
        return true;
      },
      `expected ${JSON.stringify(value)} to fail for ${SAAS_DATABASE_POOL_MAX_ENV}`,
    );
  }
  for (const value of ['soon', '-100', '3600001']) {
    assert.throws(
      () => resolveSaasDatabasePoolSettings({}, { [SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV]: value }),
      (error: unknown) => {
        assert.ok(error instanceof TypeError);
        assert.ok(error.message.includes(SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV));
        return true;
      },
      `expected ${JSON.stringify(value)} to fail for ${SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV}`,
    );
  }
});

test('an injected pool ignores pool environment overrides entirely', () => {
  const pool = new FakePool();
  const database = createSaasDatabase(
    options(pool, {
      env: { [SAAS_DATABASE_POOL_MAX_ENV]: 'garbage-that-would-throw' },
    }),
  );
  assert.equal(pool.connectCalls, 0);
  assert.equal(typeof database.ping, 'function');
});

test('native prepared mode is an explicit strict opt-in with option precedence', () => {
  assert.equal(resolveSaasDatabasePreparedStatements({}, {}), 'off');
  assert.equal(
    resolveSaasDatabasePreparedStatements({}, { [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: 'native' }),
    'native',
  );
  assert.equal(resolveSaasDatabasePreparedStatements({}, { [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: 'off' }), 'off');
  assert.equal(
    resolveSaasDatabasePreparedStatements(
      { preparedStatements: 'off' },
      { [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: 'native' },
    ),
    'off',
  );
  assert.equal(
    resolveSaasDatabasePreparedStatements(
      { preparedStatements: 'native' },
      { [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: 'invalid' },
    ),
    'native',
  );
  for (const value of ['', 'true', 'false', '1', '0', 'NATIVE', ' native', 'native ', 'automatic']) {
    assert.throws(
      () =>
        createSaasDatabase({
          connectionString: 'postgresql://router@localhost/unused',
          env: { [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: value },
        }),
      /must be off or native/,
    );
  }
  assert.throws(
    () =>
      createSaasDatabase({
        connectionString: 'postgresql://router@localhost/unused',
        preparedStatements: 'automatic',
      } as unknown as SaasDatabaseOptions),
    /preparedStatements must be off or native/,
  );
});

test('off hides pool and transaction prepared capabilities even when an injected adapter provides them', async () => {
  const statement = createPreparedSqlStatement('cm-final', 'SELECT $1::text');
  for (const preparedStatements of [undefined, 'off'] as const) {
    const pool = new PreparedPool();
    const database = createSaasDatabase(
      options(pool, { preparedStatements, env: { [SAAS_DATABASE_PREPARED_STATEMENTS_ENV]: 'native' } }),
    );
    assert.equal(Object.hasOwn(database, 'queryPrepared'), false);
    assert.equal(database.queryPrepared, undefined);
    await database.query(statement.text, ['ordinary-pool-query']);
    await queryPreparedOrAnonymous(database, statement, ['pool-fallback']);
    await database.transaction(async (tx) => {
      assert.equal(Object.hasOwn(tx, 'queryPrepared'), false);
      assert.equal(tx.queryPrepared, undefined);
      await tx.query(statement.text, ['ordinary-client-query']);
      await queryPreparedOrAnonymous(tx, statement, ['client-fallback']);
    });
    assert.deepEqual(pool.prepared, []);
    assert.deepEqual(pool.client.prepared, []);
    assert.deepEqual(pool.queries, [statement.text, statement.text]);
    assert.deepEqual(pool.client.statements, [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      statement.text,
      statement.text,
      'COMMIT',
    ]);
  }
});

test('native forwards only the actual executor capability and keeps ordinary query anonymous', async () => {
  const pool = new PreparedPool();
  const database = createSaasDatabase(options(pool, { preparedStatements: 'native' }));
  const statement = createPreparedSqlStatement('sched-platform', 'SELECT $1::text');
  const values = Object.freeze(['current-identity']);
  assert.equal(typeof database.queryPrepared, 'function');
  await database.query(statement.text, values);
  await queryPreparedOrAnonymous(database, statement, values);
  await database.transaction(async (tx) => {
    assert.equal(typeof tx.queryPrepared, 'function');
    await tx.query(statement.text, values);
    await queryPreparedOrAnonymous(tx, statement, values);
  });
  assert.deepEqual(pool.prepared, [{ statement, values }]);
  assert.equal(pool.prepared[0].values, values);
  assert.deepEqual(pool.client.prepared, [{ statement, values }]);
  assert.equal(pool.client.prepared[0].values, values);
  assert.deepEqual(pool.queries, [statement.text]);
  assert.deepEqual(pool.client.statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', statement.text, 'COMMIT']);

  const legacy = new FakePool();
  const legacyDatabase = createSaasDatabase(options(legacy, { preparedStatements: 'native' }));
  assert.equal(legacyDatabase.queryPrepared, undefined);
  await queryPreparedOrAnonymous(legacyDatabase, statement, values);
  await legacyDatabase.transaction(async (tx) => {
    assert.equal(tx.queryPrepared, undefined);
    await queryPreparedOrAnonymous(tx, statement, values);
  });
  assert.deepEqual(legacy.queries, [statement.text]);
  assert.deepEqual(legacy.client.statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', statement.text, 'COMMIT']);
});

test('prepared transaction failures roll back once and never replay through query', async () => {
  const pool = new PreparedPool();
  const failure = new Error('expected native failure');
  pool.client.failure = failure;
  const database = createSaasDatabase(options(pool, { preparedStatements: 'native' }));
  const statement = createPreparedSqlStatement('sched-byok', 'SELECT $1::text');
  await assert.rejects(
    database.transaction((tx) => queryPreparedOrAnonymous(tx, statement, ['identity'])),
    (error) => error === failure,
  );
  assert.equal(pool.client.prepared.length, 1);
  assert.deepEqual(pool.client.statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'ROLLBACK']);
  assert.deepEqual(pool.client.releases, [false]);
});

test('native capability is discovered independently for an injected pool and its clients', async () => {
  const statement = createPreparedSqlStatement('sched-byok', 'SELECT $1::text');
  for (const poolHasCapability of [false, true]) {
    const pool = new PreparedPool();
    const anonymous = new FakePool();
    const injected: SaasDatabasePool = poolHasCapability
      ? {
          query: (sql) => pool.query(sql),
          queryPrepared: (prepared, values) => pool.queryPrepared(prepared, values),
          connect: () => anonymous.connect(),
          end: () => pool.end(),
        }
      : {
          query: (sql) => anonymous.query(sql),
          connect: () => pool.connect(),
          end: () => anonymous.end(),
        };
    const database = createSaasDatabase(options(injected, { preparedStatements: 'native' }));
    assert.equal(typeof database.queryPrepared === 'function', poolHasCapability);
    await queryPreparedOrAnonymous(database, statement, []);
    await database.transaction(async (tx) => {
      assert.equal(typeof tx.queryPrepared === 'function', !poolHasCapability);
      await queryPreparedOrAnonymous(tx, statement, []);
    });
    assert.equal(pool.prepared.length, poolHasCapability ? 1 : 0);
    assert.equal(pool.client.prepared.length, poolHasCapability ? 0 : 1);
  }
});
