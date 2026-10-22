import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { SaasPricingError } from '../../../src/saas/pricing/errors.js';
import { SaasPricingService } from '../../../src/saas/pricing/service.js';
import type { CustomerPriceVersionRecord, SupplierCostVersionRecord } from '../../../src/saas/pricing/types.js';
import {
  anyRoleConfigured,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('pricing lineage concurrency deadline exceeded')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBlockedWriter(database: SaasDatabase, writerPid: number, readerPids: readonly number[]) {
  const deadline = Date.now() + 5000;
  do {
    const result = await database.query<{ blockers: number[] }>(
      `SELECT pg_blocking_pids($1) AS blockers
       WHERE EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory'
         AND mode = 'ExclusiveLock' AND NOT granted)`,
      [writerPid],
    );
    const blockers = result.rows[0]?.blockers;
    if (blockers && readerPids.every((pid) => blockers.includes(pid))) return;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('same-lineage append must wait on every active shared price reader');
}

test('real PG price readers overlap while same-lineage appends retain the exclusive fence', {
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
  const fixture = await seedFixture(migrator, gateway, 'platform');
  const pricing = new SaasPricingService(migrator);
  assert.ok(fixture.input.customerPriceVersion);
  assert.ok(fixture.sent.supplierCostVersion);
  const customer = await pricing.getCustomerPriceVersion(fixture.input.customerPriceVersion);
  const supplier = await pricing.getSupplierCostVersion(fixture.sent.supplierCostVersion);

  for (const kind of ['customer', 'supplier'] as const) {
    for (const missing of [false, true]) {
      await t.test(
        `${kind}: ${missing ? 'absent' : 'existing'} lineage has concurrent readers and fenced append`,
        async () => {
          const clock = await migrator.query<{ now: Date }>('SELECT clock_timestamp() AS now');
          const at = clock.rows[0]?.now;
          assert.ok(at instanceof Date);
          const customerInput = { ...customer, currency: missing ? 'EUR' : customer.currency, at };
          const supplierInput = { ...supplier, currency: missing ? 'EUR' : supplier.currency, at };
          const ready = [deferred<number>(), deferred<number>()];
          const release = [deferred<void>(), deferred<void>()];
          const readers: Promise<void>[] = [];
          const resolve = (executor?: SqlExecutor) =>
            kind === 'customer'
              ? pricing.resolveCustomerPriceVersion(customerInput, { executor })
              : pricing.resolveSupplierCostVersion(supplierInput, { executor });
          const writerReady = deferred<number>();
          const writerDatabase: SaasDatabase = {
            ...migrator,
            transaction: (work) =>
              migrator.transaction(async (executor) => {
                const pid = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                assert.ok(pid.rows[0]);
                writerReady.resolve(pid.rows[0].pid);
                return work(executor);
              }),
          };
          const writer = new SaasPricingService(writerDatabase);
          let write: Promise<CustomerPriceVersionRecord | SupplierCostVersionRecord> | undefined;
          try {
            for (let index = 0; index < 2; index += 1) {
              const acquired = ready[index];
              const unblock = release[index];
              assert.ok(acquired && unblock);
              const reading = gateway.transaction(async (executor) => {
                if (missing) {
                  await assert.rejects(
                    resolve(executor),
                    (error: unknown) =>
                      error instanceof SaasPricingError && error.code === 'PRICE_VERSION_NOT_EFFECTIVE',
                  );
                } else {
                  assert.equal((await resolve(executor)).id, kind === 'customer' ? customer.id : supplier.id);
                }
                const pid = await executor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
                assert.ok(pid.rows[0]);
                acquired.resolve(pid.rows[0].pid);
                await unblock.promise;
              });
              reading.catch(acquired.reject);
              readers.push(reading);
              // Reader two must resolve while reader one's transaction still
              // holds its lock. An exclusive reader fence fails this deadline.
              await bounded(acquired.promise);
            }
            const readerPids = await Promise.all(ready.map(({ promise }) => promise));
            write =
              kind === 'customer'
                ? writer.appendCustomerPriceVersion({ ...customerInput, effectiveAt: at, idempotencyKey: randomUUID() })
                : writer.appendSupplierCostVersion({ ...supplierInput, effectiveAt: at, idempotencyKey: randomUUID() });
            // Observe the actual PostgreSQL wait graph rather than assuming a
            // scheduling delay means the append is fenced.
            write.catch(writerReady.reject);
            const writerPid = await bounded(writerReady.promise);
            await waitForBlockedWriter(migrator, writerPid, readerPids);
            release[0]?.resolve();
            await bounded(readers[0] as Promise<void>);
            await waitForBlockedWriter(migrator, writerPid, readerPids.slice(1));
            release[1]?.resolve();
            await bounded(Promise.all(readers));
            const appended = await bounded(write);
            assert.equal(appended.version, missing ? 1 : 2);
            assert.equal((await resolve()).id, appended.id, 'next read must observe the committed effective version');
          } finally {
            for (const unblock of release) unblock.resolve();
            await Promise.allSettled(readers);
            if (write) await Promise.allSettled([write]);
          }
        },
      );
    }
  }

  const frozen = await migrator.query<{ customer_price_version: string; supplier_cost_version: string }>(
    `SELECT r.customer_price_version, a.supplier_cost_version
     FROM saas_requests r JOIN saas_attempts a ON a.tenant_id = r.tenant_id AND a.request_id = r.id
     WHERE r.tenant_id = $1 AND r.id = $2 AND a.id = $3`,
    [fixture.tenantId, fixture.input.requestId, fixture.input.attemptId],
  );
  assert.equal(frozen.rows[0]?.customer_price_version, customer.id);
  assert.equal(frozen.rows[0]?.supplier_cost_version, supplier.id);
});
