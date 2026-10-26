import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { type TestContext, test } from 'node:test';
import { Pool } from 'pg';
import { createSaasDatabase } from '../../../src/saas/db/database.js';
import { createPreparedSqlStatement } from '../../../src/saas/db/prepared-statements.js';

// These tests use the real default wrapper constructor. Only driver I/O is
// replaced; injected SaasDatabasePool objects would bypass the relevant seam.
function captureNativePool(t: TestContext) {
  let pool: Pool | undefined;
  const originalOn = EventEmitter.prototype.on;
  t.mock.method(Pool.prototype, 'on', function (this: Pool, event: string, listener: (...args: unknown[]) => void) {
    if (event === 'error') pool = this;
    originalOn.call(this, event, listener);
    return this;
  });
  return () => {
    assert.ok(pool, 'default native pool must install its error listener during construction');
    return pool;
  };
}

function nativeOptions(preparedStatements: 'off' | 'native' = 'off') {
  return { connectionString: 'postgresql://unused/native_pool_unit', env: {}, preparedStatements };
}

test('idle native pool errors are contained without logging or retrying explicit query failures', async (t) => {
  const pool = captureNativePool(t);
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    errors.push(args);
  });
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    errors.push(args);
  });
  t.mock.method(console, 'log', (...args: unknown[]) => {
    errors.push(args);
  });
  const failure = new Error('synthetic confidential driver error');
  let calls = 0;
  t.mock.method(Pool.prototype, 'query', async () => {
    calls++;
    if (calls === 1) throw failure;
    return { rows: [{ ok: true }], rowCount: 1 };
  });
  const database = createSaasDatabase(nativeOptions());
  try {
    const unsafeClient = { connectionParameters: { password: 'synthetic-never-log' } };
    assert.doesNotThrow(() => pool().emit('error', failure, unsafeClient));
    assert.doesNotThrow(() => pool().emit('error', new Error('another idle error'), unsafeClient));
    await assert.rejects(database.query('SELECT unit'), (error) => error === failure);
    assert.equal(calls, 1, 'an operation failure must not trigger an automatic retry');
    assert.equal((await database.query('SELECT explicit_next_operation')).rowCount, 1);
    assert.equal(calls, 2);
    assert.equal(errors.length, 0);
  } finally {
    await database.close();
  }
});

test('native prepared query errors preserve the original failure without anonymous fallback', async (t) => {
  captureNativePool(t);
  const failure = new Error('prepared execution failed');
  const calls: unknown[][] = [];
  t.mock.method(Pool.prototype, 'query', async (...args: unknown[]) => {
    calls.push(args);
    throw failure;
  });
  const database = createSaasDatabase(nativeOptions('native'));
  try {
    const statement = createPreparedSqlStatement('proof-core', 'SELECT $1');
    assert.ok(database.queryPrepared);
    await assert.rejects(database.queryPrepared(statement, [1]), (error) => error === failure);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][0], { name: statement.name, text: statement.text, values: [1] });
  } finally {
    await database.close();
  }
});

function checkedOutClient(t: TestContext, work: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const pool = captureNativePool(t);
  const releases: Array<Error | boolean | undefined> = [];
  const handoffs: number[][] = [];
  const client = Object.assign(new EventEmitter(), {
    query: work,
    release(error?: Error | boolean) {
      const before = client.listenerCount('error');
      releases.push(error);
      // Match pg-pool's synchronous listener ownership transfer on release.
      client.on('error', idle);
      handoffs.push([before, client.listenerCount('error')]);
    },
  });
  const idle = (error: Error) => {
    pool().emit('error', error, client);
  };
  t.mock.method(Pool.prototype, 'connect', async () => {
    client.removeListener('error', idle); // pg-pool does this on checkout.
    return client;
  });
  return { client, releases, handoffs };
}

test('active checked-out driver rejection keeps its identity and discards the disconnected client', async (t) => {
  const failure = new Error('synthetic connection termination');
  const statements: string[] = [];
  let thrownEvent: unknown;
  const f = checkedOutClient(t, async (sql) => {
    statements.push(sql);
    if (sql === 'SELECT active') {
      // Native pg rejects the active query and also emits client error. The
      // wrapper must contain the event without swallowing the Promise rejection.
      try {
        f.client.emit('error', failure);
      } catch (error) {
        thrownEvent = error;
      }
      throw failure;
    }
    return { rows: [], rowCount: 0 };
  });
  const database = createSaasDatabase(nativeOptions());
  try {
    await assert.rejects(
      database.transaction((tx) => tx.query('SELECT active')),
      (error) => error === failure,
    );
    assert.equal(thrownEvent, undefined);
    assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT active']);
    assert.deepEqual(f.releases, [true]);
    assert.deepEqual(f.handoffs, [[1, 2]]);
    assert.equal(f.client.listenerCount('error'), 1, 'only driver ownership remains after release');
  } finally {
    await database.close();
  }
});

test('statement gaps retain the first connection failure and never send another statement on that checkout', async (t) => {
  const first = new Error('first connection failure');
  const second = new Error('later connection failure');
  const statements: string[] = [];
  const f = checkedOutClient(t, async (sql) => {
    statements.push(sql);
    return { rows: [], rowCount: 0 };
  });
  const database = createSaasDatabase(nativeOptions('native'));
  try {
    await assert.rejects(
      database.transaction(async (tx) => {
        assert.doesNotThrow(() => f.client.emit('error', first));
        assert.doesNotThrow(() => f.client.emit('error', second));
        assert.ok(tx.queryPrepared);
        await tx.queryPrepared(createPreparedSqlStatement('proof-core', 'SELECT must_not_execute'));
      }),
      (error) => error === first,
    );
    assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL READ COMMITTED']);
    assert.deepEqual(f.releases, [true]);
    assert.doesNotThrow(() => f.client.emit('error', second));
  } finally {
    await database.close();
  }
});

test('COMMIT failure remains the original error when rollback also fails, without retrying COMMIT', async (t) => {
  const commitFailure = new Error('COMMIT failure');
  const rollbackFailure = new Error('ROLLBACK failure');
  const statements: string[] = [];
  const f = checkedOutClient(t, async (sql) => {
    statements.push(sql);
    if (sql === 'COMMIT') throw commitFailure;
    if (sql === 'ROLLBACK') throw rollbackFailure;
    return { rows: [], rowCount: 0 };
  });
  const database = createSaasDatabase(nativeOptions());
  try {
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.query('SELECT unit');
      }),
      (error) => error === commitFailure,
    );
    assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT unit', 'COMMIT', 'ROLLBACK']);
    assert.deepEqual(f.releases, [true], 'rollback failure must discard the checkout');
  } finally {
    await database.close();
  }
});

test('connection loss during COMMIT stays rejected and never retries the ambiguous commit', async (t) => {
  const failure = new Error('connection lost during COMMIT');
  const statements: string[] = [];
  let thrownEvent: unknown;
  const f = checkedOutClient(t, async (sql) => {
    statements.push(sql);
    if (sql === 'COMMIT') {
      try {
        f.client.emit('error', failure);
      } catch (error) {
        thrownEvent = error;
      }
      throw failure;
    }
    return { rows: [], rowCount: 0 };
  });
  const database = createSaasDatabase(nativeOptions());
  try {
    await assert.rejects(
      database.transaction(async () => {}),
      (error) => error === failure,
    );
    assert.equal(thrownEvent, undefined);
    assert.deepEqual(statements, ['BEGIN ISOLATION LEVEL READ COMMITTED', 'COMMIT']);
    assert.deepEqual(f.releases, [true]);
  } finally {
    await database.close();
  }
});

test('checkout listener ownership is handed back to pg-pool without gaps or accumulation', async (t) => {
  const f = checkedOutClient(t, async () => ({ rows: [], rowCount: 0 }));
  const database = createSaasDatabase(nativeOptions());
  try {
    for (let index = 0; index < 3; index++) {
      await database.transaction(async () => {
        assert.equal(f.client.listenerCount('error'), 1);
      });
      assert.equal(f.client.listenerCount('error'), 1);
    }
    assert.deepEqual(f.handoffs, [
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    assert.deepEqual(f.releases, [false, false, false]);
    assert.doesNotThrow(() => f.client.emit('error', new Error('post-release idle failure')));
  } finally {
    await database.close();
  }
});

test('atomic checked-out statement retains connection error ownership between isolation check and write', async (t) => {
  const failure = new Error('synthetic atomic connection termination');
  const statements: string[] = [];
  const f = checkedOutClient(t, async (sql) => {
    statements.push(sql);
    if (sql === 'SHOW default_transaction_isolation') {
      queueMicrotask(() => f.client.emit('error', failure));
      return { rows: [{ default_transaction_isolation: 'read committed' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const database = createSaasDatabase(nativeOptions());
  try {
    await assert.rejects(database.queryReadCommitted!('UPDATE must_not_execute'), (error) => error === failure);
    assert.deepEqual(statements, ['SHOW default_transaction_isolation']);
    assert.deepEqual(f.releases, [true]);
    assert.equal(f.client.listenerCount('error'), 1);
  } finally {
    await database.close();
  }
});
