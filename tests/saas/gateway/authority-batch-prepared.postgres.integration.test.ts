import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { PreparedSqlStatement, SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  SaasPreparedRequestEvidenceError,
  SaasPreparedRequestEvidenceService,
} from '../../../src/saas/gateway/prepared-request-evidence-service.js';
import { ProviderSupplyService } from '../../../src/saas/supply/service.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../metering/normal-success-postgres-fixture.js';
import { safeCancellationFailure } from './pre-dispatch-postgres-fixture.js';
import { evidenceAuthorityFixture } from './prepared-evidence-authority-postgres-fixture.js';

type Kind = 'auth-admit' | 'auth-evidence';
type PlanMode = 'auto' | 'force_custom_plan' | 'force_generic_plan';
interface Call {
  kind: Kind;
  sql: string;
  values: readonly unknown[];
  statement?: PreparedSqlStatement;
  fence: { sql: string; values: readonly unknown[] };
}
const kind = (sql: string): Kind | undefined =>
  sql.startsWith('/* postgres-request-admission:authority-batch */')
    ? 'auth-admit'
    : sql.startsWith('/* prepared-evidence:authority-batch */')
      ? 'auth-evidence'
      : undefined;

// Full SQL/current synthetic values exist only inside this test process; TAP
// projects named-plan hashes and counts, never parameters or authority rows.
function observed(database: SaasDatabase, calls: Call[], mode: PlanMode = 'auto'): SaasDatabase {
  const wrap = (tx: SqlExecutor): SqlExecutor => {
    let fence: Call['fence'] | undefined;
    const run = async <Row>(
      sql: string,
      values: readonly unknown[] = [],
      statement?: PreparedSqlStatement,
    ): Promise<SqlResult<Row>> => {
      if (sql.includes('postgres-request-admission:fence-batch') || sql.includes('prepared-evidence:fence-batch'))
        fence = { sql, values };
      const selected = kind(sql);
      if (selected) {
        assert.ok(fence, 'authority batch must follow a separate ordered fence statement');
        if (statement) {
          assert.ok(Object.isFrozen(statement));
          assert.equal(statement.name, `mr_${selected}_${createHash('sha256').update(sql).digest('base64url')}`);
        }
        calls.push({ kind: selected, sql, values, statement, fence });
      }
      return statement ? tx.queryPrepared!<Row>(statement, values) : tx.query<Row>(sql, values);
    };
    const result: SqlExecutor = { query: (sql, values) => run(sql, values) };
    if (tx.queryPrepared) result.queryPrepared = (statement, values) => run(statement.text, values, statement);
    return result;
  };
  return {
    ...database,
    ...wrap(database),
    transaction: (work) =>
      database.transaction(async (tx) => {
        if (mode !== 'auto') await tx.query(`SET LOCAL plan_cache_mode = ${mode}`);
        await tx.query("SET LOCAL lock_timeout = '10s'");
        return work(wrap(tx));
      }),
  };
}

function onExecutor(database: SaasDatabase, executor: SqlExecutor): SaasDatabase {
  return { ...database, ...executor, query: executor.query.bind(executor), transaction: (work) => work(executor) };
}

async function plans(database: SaasDatabase) {
  const result = await database.query<{
    name: string;
    from_sql: boolean;
    parameter_count: number;
    generic_plans: string;
    custom_plans: string;
  }>(
    `SELECT name,from_sql,cardinality(parameter_types) AS parameter_count,
            generic_plans::text AS generic_plans,custom_plans::text AS custom_plans
       FROM pg_prepared_statements WHERE name LIKE 'mr_auth-%' ORDER BY name`,
  );
  assert.ok(result.rows.length <= 24, 'eight admission and sixteen evidence shapes are the fixed upper bound');
  for (const row of result.rows) {
    assert.match(row.name, /^mr_auth-(?:admit|evidence)_[A-Za-z0-9_-]{43}$/u);
    assert.equal(row.from_sql, false);
  }
  return result.rows;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('restricted PG authority batches keep anonymous/native facts, bounded names and post-fence generic freshness', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? 'designated disposable E2E role URLs not configured'
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 2, env: {} });
  const control = createSaasDatabase({ connectionString: urls[1], max: 1, env: {} });
  const off = createSaasDatabase({
    connectionString: urls[2],
    max: 1,
    idleTimeoutMillis: 0,
    env: {},
    preparedStatements: 'off',
  });
  const native = createSaasDatabase({
    connectionString: urls[2],
    max: 1,
    idleTimeoutMillis: 0,
    env: {},
    preparedStatements: 'native',
  });
  try {
    await migrator.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
    await verifySaasRuntimeDatabasePrivileges(off, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(native, 'gateway');
    assert.equal(off.queryPrepared, undefined);
    const nativeCalls: Call[] = [];
    const fixtures: Awaited<ReturnType<typeof evidenceAuthorityFixture>>[] = [];
    for (const mode of ['byok', 'platform'] as const) {
      const anonymous: Call[] = [];
      const start = nativeCalls.length;
      await evidenceAuthorityFixture(migrator, observed(off, anonymous), mode);
      fixtures.push(await evidenceAuthorityFixture(migrator, observed(native, nativeCalls), mode));
      const prepared = nativeCalls.slice(start).slice(-2);
      const anonymousBatches = anonymous.slice(-2);
      assert.deepEqual(
        anonymousBatches.map((call) => call.kind),
        ['auth-admit', 'auth-evidence'],
      );
      assert.deepEqual(
        prepared.map((call) => call.kind),
        ['auth-admit', 'auth-evidence'],
      );
      for (let index = 0; index < 2; index++) {
        const baseline = anonymousBatches[index]!;
        const current = prepared[index]!;
        assert.equal(baseline.statement, undefined);
        assert.ok(current.statement);
        assert.equal(baseline.sql, current.sql, 'native selection preserves exact SQL bytes');
        assert.equal(baseline.values.length, current.values.length);
        // Same current parameters on two real restricted connections must yield
        // identical facts; descriptors do not contain or cache those facts.
        const expected = await off.transaction(async (tx) => {
          await tx.query(baseline.fence.sql, baseline.fence.values);
          return tx.query(baseline.sql, baseline.values);
        });
        for (const planMode of ['force_custom_plan', 'force_generic_plan'] as const) {
          for (let round = 0; round < 6; round++) {
            const actual = await native.transaction(async (tx) => {
              await tx.query(`SET LOCAL plan_cache_mode = ${planMode}`);
              await tx.query(baseline.fence.sql, baseline.fence.values);
              return tx.queryPrepared!(current.statement!, baseline.values);
            });
            assert.deepEqual(actual.rows, expected.rows);
          }
        }
      }
    }
    assert.deepEqual(await plans(off), []);
    const warmed = await plans(native);
    assert.equal(warmed.length, 4, 'member BYOK/platform generate exactly two shapes per family');
    for (const row of warmed) {
      assert.ok(BigInt(row.generic_plans) >= 6n);
      assert.ok(BigInt(row.custom_plans) >= 6n);
      assert.equal(row.parameter_count, nativeCalls.find((call) => call.statement?.name === row.name)?.values.length);
    }
    t.diagnostic(
      JSON.stringify({
        scope: 'correctness only; forced plan modes do not establish automatic plan selection or performance',
        plans: warmed,
      }),
    );

    for (const fixture of fixtures) {
      const writerReady = deferred();
      const release = deferred();
      let writerPid = 0;
      const readerPid = (await native.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const writer = control.transaction(async (tx) => {
        writerPid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const supply = new ProviderSupplyService(onExecutor(control, tx), {
          deployment: 'fin057-test',
          environment: 'test',
          kmsKeyId: 'fin057-synthetic-kms',
        });
        await supply.disableProviderCredential({
          credentialId: fixture.input.credentialId,
          expectedAuthzVersion: Number(fixture.input.credentialAuthzVersion),
        });
        writerReady.resolve();
        await release.promise;
      });
      void writer.catch(() => writerReady.resolve());
      await writerReady.promise;
      const service = new SaasPreparedRequestEvidenceService(
        observed(native, [], 'force_generic_plan'),
        fixture.options,
      );
      const reader = service.preflightForDispatch(fixture.evidenceId, fixture.input.audit);
      void reader.catch(() => {});
      try {
        let blocked = false;
        const deadline = Date.now() + 5000;
        while (!blocked && Date.now() < deadline) {
          blocked =
            (
              await migrator.query<{ blocked: boolean }>('SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked', [
                writerPid,
                readerPid,
              ])
            ).rows[0]?.blocked === true;
          if (!blocked) await delay(10);
        }
        assert.equal(blocked, true, 'normal CP credential writer must block the preceding evidence fence');
        release.resolve();
        await writer;
        await assert.rejects(
          reader,
          (error: unknown) => error instanceof SaasPreparedRequestEvidenceError && error.code === 'AUTHORITY_MISMATCH',
        );
        const rows = await migrator.query<{ status: string }>(
          'SELECT status FROM saas_prepared_request_evidence WHERE id=$1',
          [fixture.evidenceId],
        );
        assert.equal(rows.rows[0]?.status, 'registered', 'failed fresh authority may not claim evidence');
      } finally {
        release.resolve();
        await Promise.allSettled([writer, reader]);
      }
    }
    assert.equal(
      (await native.query<{ mode: string }>("SELECT current_setting('plan_cache_mode') AS mode")).rows[0]?.mode,
      'auto',
    );
  } catch (error) {
    throw safeCancellationFailure(error);
  } finally {
    await Promise.allSettled([migrator, control, off, native].map((db) => db.close()));
  }
});
