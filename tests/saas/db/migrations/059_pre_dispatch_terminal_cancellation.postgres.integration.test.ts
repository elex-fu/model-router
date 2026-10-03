import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION,
  PRE_DISPATCH_ATTEMPT_GUARD_SOURCE,
} from '../../../../src/saas/db/migrations/059_pre_dispatch_terminal_cancellation.js';
import { PostgresPreDispatchCompensation } from '../../../../src/saas/gateway/postgres-pre-dispatch-compensation.js';
import { createPostgresPreparationCapacityPort } from '../../../../src/saas/gateway/postgres-preparation-capacity.js';
import {
  CANCELLATION_PG_REQUIRED, cancellationPgConfigured, cancellationDatabases, cancellationFixture,
  cancellationTransaction, cancellationSqlState, safeCancellationFailure,
} from '../../gateway/pre-dispatch-postgres-fixture.js';

test('059 actual restricted PostgreSQL terminal cancellation and redispatch guard', {
  skip: process.env[CANCELLATION_PG_REQUIRED] !== '1' && !cancellationPgConfigured
    ? `set ${CANCELLATION_PG_REQUIRED}=1 and disposable E2E URLs` : false,
  timeout: 120000,
}, async (t) => {
  const { databases, migrator, gateway } = await cancellationDatabases();
  try {
    const catalog = async () => (await migrator.query<{
      source: string; owner: string; definer: boolean; config: string[] | null; check_def: string; validated: boolean; acl: unknown;
    }>(`SELECT p.prosrc AS source, p.proowner::regrole::text AS owner, p.prosecdef AS definer, p.proconfig AS config,
      pg_get_constraintdef(c.oid) AS check_def, c.convalidated AS validated,
      jsonb_build_array(p.proacl, (SELECT relacl FROM pg_class WHERE oid = c.conrelid),
        (SELECT jsonb_agg(jsonb_build_array(attnum, attacl) ORDER BY attnum) FROM pg_attribute WHERE attrelid = c.conrelid)) AS acl
      FROM pg_proc p JOIN pg_constraint c ON c.conrelid = 'saas_attempts'::regclass
       AND c.conname = 'saas_attempts_status_consistency'
      WHERE p.oid = 'saas_metering_guard_attempt_update()'::regprocedure`)).rows[0]!;
    await t.test('installed body and CHECK are exact; no function or column ACL expansion', async () => {
      const actual = await catalog(); assert.equal(actual.source, PRE_DISPATCH_ATTEMPT_GUARD_SOURCE);
      assert.equal(actual.owner, 'model_router_saas_migrator'); assert.equal(actual.definer, false); assert.equal(actual.config, null);
      assert.equal(actual.validated, true); assert.match(actual.check_def, /result_state = 'failed'::text/);
      const privileges = (await gateway.query<{ key_update: boolean; direct_guard: boolean }>(
        `SELECT has_any_column_privilege(current_user, 'saas_api_keys', 'UPDATE') AS key_update,
          has_function_privilege(current_user, 'saas_metering_guard_attempt_update()', 'EXECUTE') AS direct_guard`)).rows[0];
      assert.deepEqual(privileges, { key_update: false, direct_guard: false });
      const before = await catalog();
      await assert.rejects(cancellationTransaction(migrator, (tx) => tx.query(PRE_DISPATCH_TERMINAL_CANCELLATION_SAAS_MIGRATION.sql)),
        (error: unknown) => cancellationSqlState(error) === '55000');
      assert.deepEqual(await catalog(), before, 'precondition failure must leave body/CHECK/ACL unchanged');
    });
    for (const mode of ['byok', 'platform'] as const) {
      await t.test(`${mode}: real cancellation is terminal; direct DB dispatch/pending revival is rejected`, async () => {
        const fixture = await cancellationFixture(migrator, gateway, mode);
        const port = new PostgresPreDispatchCompensation({ capacity: createPostgresPreparationCapacityPort(), billing: fixture.billing });
        const result = await cancellationTransaction(gateway, (executor) => port.releasePreDispatch(fixture.command, { executor }));
        assert.equal(result.decision, 'allow');
        if (result.decision === 'allow') assert.equal(result.value.disposition, 'released');
        for (const [dispatch, status, response] of [
          ['dispatching', 'pending', false], ['sent', 'failed', false], ['unknown', 'unknown', false],
          ['not_sent', 'pending', false], ['not_sent', 'failed', true], ['not_sent', 'succeeded', false],
        ] as const) {
          await assert.rejects(cancellationTransaction(gateway, (tx) => tx.query(
            `UPDATE saas_attempts SET dispatch_state = $4, result_state = $5, response_started = $6,
              state_version = state_version + 1, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND request_id = $2 AND id = $3`,
            [fixture.tenantId, fixture.requestId, fixture.attemptId, dispatch, status, response])),
          (error: unknown) => ['55000', '23514'].includes(cancellationSqlState(error) ?? ''));
        }
      });
      await t.test(`${mode}: pending cannot become not_sent success/unknown/response or skip CAS version`, async () => {
        const fixture = await cancellationFixture(migrator, gateway, mode);
        for (const [status, response] of [['succeeded', false], ['unknown', false], ['pending', true]] as const) {
          await assert.rejects(cancellationTransaction(gateway, (tx) => tx.query(
            `UPDATE saas_attempts SET result_state = $4, response_started = $5,
              state_version = state_version + 1, updated_at = clock_timestamp()
             WHERE tenant_id = $1 AND request_id = $2 AND id = $3`,
            [fixture.tenantId, fixture.requestId, fixture.attemptId, status, response])),
          (error: unknown) => ['55000', '23514'].includes(cancellationSqlState(error) ?? ''));
        }
        await assert.rejects(cancellationTransaction(gateway, (tx) => tx.query(
          `UPDATE saas_attempts SET result_state = 'failed', updated_at = clock_timestamp()
            WHERE tenant_id = $1 AND request_id = $2 AND id = $3`, [fixture.tenantId, fixture.requestId, fixture.attemptId])),
        (error: unknown) => cancellationSqlState(error) === '55000');
      });
    }
  } catch (error) { throw safeCancellationFailure(error); }
  finally { await Promise.all(databases.map((db) => db.close())); }
});
