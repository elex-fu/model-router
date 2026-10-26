import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saasFastBillingWorker } from '../../../../src/cli/saas-fast-billing-worker.js';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';

const url =
  'postgres://model_router_saas_gateway:test-password@127.0.0.1:15432/model_router_test_worker?sslmode=disable';
function fixture(onQuery?: (sql: string) => void) {
  const calls: string[] = [];
  const owners: unknown[] = [];
  const database: SaasDatabase = {
    async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
      calls.push(sql);
      onQuery?.(sql);
      if (sql.startsWith('INSERT INTO saas_fast_gateway_owners')) owners.push(values?.[0]);
      return { rows: [], rowCount: 0 };
    },
    transaction: (work) => work(database),
    migrate: async () => {
      throw new Error('must never migrate');
    },
    verifySchema: async () => {
      calls.push('schema');
    },
    ping: async () => {},
    close: async () => {
      calls.push('close');
    },
  };
  return { calls, owners, database };
}
test('explicit drain command validates role/options, loads no unrelated environment and does not admit or allocate', async () => {
  const { calls, owners, database } = fixture();
  const lines: string[] = [];
  await saasFastBillingWorker(
    { once: true, allowLocalPlaintext: true },
    {
      env: {
        MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: url,
        MODEL_ROUTER_SAAS_REDIS_URL: 'invalid',
        MODEL_ROUTER_SAAS_KMS_PROVIDER: 'does-not-exist',
      },
      createDatabase: () => database,
      verifyGatewayPrivileges: async () => {
        calls.push('privileges');
      },
      writeLine: (line) => lines.push(line),
    },
  );
  assert.deepEqual(calls.slice(0, 2), ['schema', 'privileges']);
  assert.equal(owners.length, 1);
  assert.match(String(owners[0]), /^billing-drain:[a-f0-9-]{36}$/);
  assert.ok(
    !calls.some(
      (sql) =>
        sql.includes('fast-journal:reserve-intent') || sql.startsWith('INSERT INTO saas_fast_credit_allocations'),
    ),
  );
  assert.equal(calls.at(-1), 'close');
  assert.deepEqual(JSON.parse(lines.at(-1) ?? ''), { event: 'stopped', mode: 'once', processedJobs: '0' });
  let connections = 0;
  const dependencies = {
    env: { MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: url },
    createDatabase: () => {
      connections++;
      return database;
    },
  };
  await assert.rejects(saasFastBillingWorker({ once: true }, dependencies), /explicit PostgreSQL server/);
  await assert.rejects(
    saasFastBillingWorker({ once: true, allowLocalPlaintext: true, batchSize: '0' }, dependencies),
    /Invalid fast billing/,
  );
  await assert.rejects(
    saasFastBillingWorker(
      { once: true, allowLocalPlaintext: true },
      {
        ...dependencies,
        env: { MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: url.replace('model_router_saas_gateway:', 'postgres:') },
      },
    ),
    /gateway login/,
  );
  assert.equal(connections, 0);
});
test('background poll failure aborts, closes and rejects even when error reporting throws', {
  timeout: 3000,
}, async () => {
  for (const throwDiagnostic of [false, true]) {
    const { database, calls } = fixture((sql) => {
      if (sql.includes('fast-journal:worker-claim')) throw new Error('sensitive-pool-failure');
    });
    const lines: string[] = [];
    await assert.rejects(
      saasFastBillingWorker(
        { allowLocalPlaintext: true, pollMs: 10 },
        {
          env: { MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: url },
          signal: new AbortController().signal,
          createDatabase: () => database,
          verifyGatewayPrivileges: async () => {},
          writeLine: (line) => {
            lines.push(line);
            if (throwDiagnostic && JSON.parse(line).event === 'error') throw new Error('broken diagnostic sink');
          },
        },
      ),
      (error) =>
        error instanceof Error &&
        error.message.includes('durable jobs remain retryable') &&
        !error.message.includes('sensitive'),
    );
    assert.equal(calls.at(-1), 'close');
    assert.equal(
      calls.filter((sql) => sql.includes('fast-journal:worker-claim')).length,
      1,
      'fatal cleanup must not claim another job',
    );
    assert.equal(lines.filter((line) => JSON.parse(line).event === 'error').length, 1);
    assert.ok(!lines.some((line) => JSON.parse(line).event === 'stopped'));
    assert.ok(!calls.some((sql) => sql.includes('fast-journal:worker-ledger')));
  }
});
test('poll stop and privilege failures close resources without leaking raw database errors', async () => {
  const { calls, database } = fixture();
  const controller = new AbortController();
  await saasFastBillingWorker(
    { allowLocalPlaintext: true },
    {
      env: { MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: url },
      signal: controller.signal,
      createDatabase: () => database,
      verifyGatewayPrivileges: async () => {},
      writeLine: (line) => {
        if (JSON.parse(line).event === 'ready') controller.abort();
      },
    },
  );
  assert.equal(calls.at(-1), 'close');
  const denied = fixture();
  await assert.rejects(
    saasFastBillingWorker(
      { once: true, allowLocalPlaintext: true },
      {
        env: { MODEL_ROUTER_SAAS_GATEWAY_DATABASE_URL: url },
        createDatabase: () => denied.database,
        verifyGatewayPrivileges: async () => {
          throw new Error('sensitive-connection-material');
        },
      },
    ),
    (error) =>
      error instanceof Error &&
      error.message.includes('durable jobs remain retryable') &&
      !error.message.includes('sensitive'),
  );
  assert.deepEqual(denied.calls, ['schema', 'close']);
});
