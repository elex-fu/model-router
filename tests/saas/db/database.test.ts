import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS,
  DEFAULT_SAAS_DATABASE_POOL_IDLE_TIMEOUT_MILLIS,
  DEFAULT_SAAS_DATABASE_POOL_MAX,
  resolveSaasDatabasePoolSettings,
  SAAS_DATABASE_POOL_ACQUISITION_TIMEOUT_MILLIS_ENV,
  SAAS_DATABASE_POOL_MAX_ENV,
} from '../../../src/saas/db/database.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type {
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
