import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  SaasCommercialMeteringPolicyError,
  SaasCommercialMeteringPolicyService,
} from '../../../src/saas/gateway/commercial-metering-policy-service.js';
import { SaasRouteConfigService } from '../../../src/saas/gateway/route-config-service.js';
import {
  anyRoleConfigured,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

function onExecutor(database: SaasDatabase, executor: SqlExecutor): SaasDatabase {
  return {
    ...database,
    query: (sql, values) => executor.query(sql, values),
    transaction: (work) => work(executor),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('real PG immutable hints retain final dispatchability and committed revocation fences in both supply modes', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and the three disposable gateway E2E role URLs`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.close(), gateway.close()]);
  });
  await gateway.verifySchema();
  const commercial = new SaasCommercialMeteringPolicyService(gateway);

  for (const mode of ['byok', 'platform'] as const) {
    const fixture = await seedFixture(migrator, gateway, mode);
    const { tenantId, projectId, userId, sent } = fixture;
    assert.ok(sent.routeConfigId && sent.routeConfigVersion);
    assert.ok(sent.customerMeteringPolicyId && sent.customerMeteringPolicyVersion);
    assert.ok(sent.providerMeteringPolicyId && sent.providerMeteringPolicyVersion);
    const routeId = sent.routeConfigId,
      routeVersion = sent.routeConfigVersion;
    const customerPolicyId = sent.customerMeteringPolicyId,
      customerPolicyVersion = sent.customerMeteringPolicyVersion;
    const providerPolicyId = sent.providerMeteringPolicyId,
      providerPolicyVersion = sent.providerMeteringPolicyVersion;
    const audit = { actorUserId: userId, entryPoint: 'commercial-hint-postgres-regression' };
    const resolve = (executor?: SqlExecutor) =>
      commercial.resolveDispatchableRoute(tenantId, projectId, routeId, routeVersion, executor);
    await t.test(`${mode}: scoped hint and one final view retain exact bound commercial terms`, async () => {
      const trace: string[] = [];
      const resolved = await gateway.transaction((executor) =>
        resolve({
          async query(sql, values) {
            trace.push(sql.replace(/\s+/g, ' '));
            return executor.query(sql, values);
          },
        }),
      );
      assert.ok(resolved);
      assert.equal(resolved.customerPriceVersion, fixture.input.customerPriceVersion);
      assert.equal(resolved.supplierCostVersion, sent.supplierCostVersion);
      const hint = trace.findIndex((sql) => sql.includes('FROM saas_route_config_commercial_authorities'));
      const view = trace.findIndex((sql) => sql.includes('FROM saas_route_config_dispatchable'));
      const lastFence = trace.findLastIndex((sql) => sql.includes('pg_advisory_xact_lock_shared'));
      assert.ok(hint >= 0 && hint < lastFence && view > lastFence);
      assert.equal(trace.filter((sql) => sql.includes('FROM saas_route_config_dispatchable')).length, 1);
      assert.equal(await commercial.resolveDispatchableRoute(randomUUID(), projectId, routeId, routeVersion), null);
      assert.equal(
        await commercial.resolveDispatchableRoute(tenantId, projectId, routeId, BigInt(routeVersion) + 1n),
        null,
      );
      await assert.rejects(
        migrator.query(
          `UPDATE saas_route_config_commercial_authorities SET provider_policy_id = provider_policy_id
         WHERE tenant_id = $1 AND project_id = $2 AND route_id = $3 AND route_version = $4`,
          [tenantId, projectId, routeId, routeVersion],
        ),
        (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '55000'),
      );
    });

    const disable = async (database: SaasDatabase, kind: 'customer' | 'provider' | 'route') => {
      if (kind === 'route') {
        return new SaasRouteConfigService(database).disable({
          tenantId,
          projectId,
          routeId,
          expectedVersion: routeVersion,
          audit,
        });
      }
      const policies = new SaasCommercialMeteringPolicyService(database);
      return kind === 'customer'
        ? policies.disableCustomerPolicy({
            tenantId,
            projectId,
            policyId: customerPolicyId,
            expectedVersion: customerPolicyVersion,
            audit,
          })
        : policies.disableProviderPolicy({
            tenantId,
            projectId,
            policyId: providerPolicyId,
            expectedVersion: providerPolicyVersion,
            audit,
          });
    };
    for (const kind of ['customer', 'provider', 'route'] as const) {
      await t.test(`${mode}: final view denies disabled ${kind} despite the immutable hint`, async () => {
        const rollback = new Error('rollback scoped lifecycle change');
        await assert.rejects(
          migrator.transaction(async (executor) => {
            await disable(onExecutor(migrator, executor), kind);
            assert.equal(await resolve(executor), null);
            throw rollback;
          }),
          (error) => error === rollback,
        );
        assert.ok(await resolve(), 'rolled-back lifecycle change must leave the original route dispatchable');
      });
    }

    await t.test(`${mode}: cancelling a blocked reader rolls back without a final authority read`, async () => {
      const writerReady = deferred<number>(),
        readerReady = deferred<number>(),
        release = deferred<void>();
      const rollback = new Error('rollback cancelled-reader writer');
      // This existing root calls the real service as migrator; this is not a new CP-role proof.
      const writer = migrator.transaction(async (executor) => {
        await disable(onExecutor(migrator, executor), 'customer');
        const pid = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        assert.ok(pid.rows[0]);
        writerReady.resolve(pid.rows[0].pid);
        await release.promise;
        throw rollback;
      });
      void writer.catch((error) => {
        if (error !== rollback) writerReady.reject(error);
      });
      let reader: ReturnType<typeof resolve> | undefined;
      const trace: string[] = [];
      try {
        const writerPid = await writerReady.promise;
        reader = gateway.transaction(async (executor) => {
          const pid = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          assert.ok(pid.rows[0]);
          readerReady.resolve(pid.rows[0].pid);
          return resolve({
            query: (sql, values) => {
              trace.push(sql.replace(/\s+/g, ' '));
              return executor.query(sql, values);
            },
          });
        });
        void reader.catch(readerReady.reject);
        const readerPid = await readerReady.promise;
        let blocked = false;
        const deadline = Date.now() + 5000;
        do {
          const wait = await migrator.query<{ blocked: boolean }>(
            'SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked',
            [writerPid, readerPid],
          );
          blocked = wait.rows[0]?.blocked === true;
          if (!blocked) await delay(10);
        } while (!blocked && Date.now() < deadline);
        assert.equal(blocked, true, 'reader must reach an actual writer lock wait before cancellation');
        const cancelled = await gateway.query<{ cancelled: boolean }>('SELECT pg_cancel_backend($1) AS cancelled', [
          readerPid,
        ]);
        assert.equal(cancelled.rows[0]?.cancelled, true);
        await assert.rejects(
          reader,
          (error: unknown) =>
            error instanceof SaasCommercialMeteringPolicyError &&
            error.code === 'STORAGE_ERROR' &&
            error.cause !== null &&
            typeof error.cause === 'object' &&
            'code' in error.cause &&
            error.cause.code === '57014',
        );
        const locks = await migrator.query<{ locks: string }>(
          "SELECT count(*)::text AS locks FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'",
          [readerPid],
        );
        assert.equal(locks.rows[0]?.locks, '0', 'reader transaction rollback must release all advisory locks');
        assert.equal(trace.filter((sql) => sql.includes('WITH ORDINALITY')).length, 1);
        assert.equal(
          trace.some((sql) => sql.includes('FROM saas_route_config_dispatchable')),
          false,
        );
        release.resolve();
        await assert.rejects(writer, (error) => error === rollback);
        assert.ok(await resolve(), 'writer rollback must preserve the original dispatchable route');
      } finally {
        release.resolve();
        await Promise.allSettled(reader ? [writer, reader] : [writer]);
      }
    });

    await t.test(`${mode}: a waiting reader observes committed policy revocation after its fence`, async () => {
      const writerReady = deferred<number>(),
        readerReady = deferred<number>(),
        release = deferred<void>();
      const writer = migrator.transaction(async (executor) => {
        await disable(onExecutor(migrator, executor), 'customer');
        const pid = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        assert.ok(pid.rows[0]);
        writerReady.resolve(pid.rows[0].pid);
        await release.promise;
      });
      writer.catch(writerReady.reject);
      let reader: ReturnType<typeof resolve> | undefined;
      try {
        const writerPid = await writerReady.promise;
        reader = gateway.transaction(async (executor) => {
          const pid = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          assert.ok(pid.rows[0]);
          readerReady.resolve(pid.rows[0].pid);
          return resolve(executor);
        });
        reader.catch(readerReady.reject);
        const readerPid = await readerReady.promise;
        let blocked = false;
        const deadline = Date.now() + 5000;
        do {
          const wait = await migrator.query<{ blocked: boolean }>(
            'SELECT $1::integer = ANY(pg_blocking_pids($2)) AS blocked',
            [writerPid, readerPid],
          );
          blocked = wait.rows[0]?.blocked === true;
          if (!blocked) await delay(10);
        } while (!blocked && Date.now() < deadline);
        assert.equal(blocked, true, 'reader must wait for the actual policy writer transaction');
        release.resolve();
        await writer;
        assert.equal(await reader, null, 'fresh post-fence read must reject the committed disabled policy');
      } finally {
        release.resolve();
        await Promise.allSettled(reader ? [writer, reader] : [writer]);
      }
    });
  }
});
