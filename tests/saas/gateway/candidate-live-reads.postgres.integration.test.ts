import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { SaasDatabase, SqlResult } from '../../../src/saas/db/types.js';
import { PostgresProviderAccountRuntimeHealthStore } from '../../../src/saas/gateway/postgres-provider-account-runtime-health-store.js';
import { PostgresProviderAccountScheduler } from '../../../src/saas/gateway/postgres-provider-account-scheduler.js';
import { PostgresProviderAccountLeaseService } from '../../../src/saas/gateway/provider-account-lease-service.js';
import type { ProviderAccountSchedulerDependencies } from '../../../src/saas/gateway/provider-account-scheduler.js';
import type {
  RequestPreparationCaller,
  RequestPreparationCandidateAuthority,
} from '../../../src/saas/gateway/request-preparation-service.js';
import { seedFixture } from '../metering/normal-success-postgres-fixture.js';
import {
  HEALTH_CLOCK_REQUIRED,
  healthClockDatabases,
  healthClockPgConfigured,
  safeHealthClockFailure,
} from './runtime-health-clock-postgres-fixture.js';

type NativeReadDependencies = ProviderAccountSchedulerDependencies &
  Required<Pick<ProviderAccountSchedulerDependencies, 'health' | 'concurrency' | 'candidateReadScope'>>;

function dependencies(scheduler: PostgresProviderAccountScheduler): NativeReadDependencies {
  // Inspect the exact production native ports, never substitute an authority.
  const value = (scheduler as unknown as { scheduler: { dependencies: ProviderAccountSchedulerDependencies } })
    .scheduler.dependencies;
  assert.ok(value.health);
  assert.ok(value.concurrency);
  assert.ok(value.candidateReadScope);
  return value as NativeReadDependencies;
}

function observed(database: SaasDatabase, calls: string[], afterBatch?: () => Promise<void>): SaasDatabase {
  const query = async <R>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>> => {
    calls.push(sql);
    const result = await database.query<R>(sql, values);
    if (sql.includes('provider-account-runtime-health:scheduling-batch')) await afterBatch?.();
    return result;
  };
  return {
    query,
    queryReadCommitted: async (sql, values) => {
      calls.push(sql);
      return database.queryReadCommitted
        ? database.queryReadCommitted(sql, values)
        : database.transaction((tx) => tx.query(sql, values));
    },
    transaction: database.transaction.bind(database),
    migrate: database.migrate.bind(database),
    verifySchema: database.verifySchema.bind(database),
    ping: database.ping.bind(database),
    close: database.close.bind(database),
  };
}

const required = {
  skip:
    process.env[HEALTH_CLOCK_REQUIRED] !== '1' && !healthClockPgConfigured
      ? `set ${HEALTH_CLOCK_REQUIRED}=1 and the three disposable role URLs`
      : false,
  timeout: 120_000,
};

test(
  'restricted PostgreSQL native candidate snapshots preserve owner isolation and count 8 live reads as 2',
  required,
  async () => {
    const { databases, migrator, gateway } = await healthClockDatabases();
    try {
      const tenantId = randomUUID();
      const otherTenantId = randomUUID();
      for (const id of [tenantId, otherTenantId]) {
        await migrator.query('INSERT INTO saas_tenants (id, name, slug) VALUES ($1, $2, $2)', [
          id,
          `candidate-live-${id}`,
        ]);
      }
      for (const mode of ['byok', 'platform'] as const) {
        const calls: string[] = [];
        const database = observed(gateway, calls);
        const store = new PostgresProviderAccountRuntimeHealthStore({ database, maxHealthAgeMs: 60_000 });
        const caller = { tenantId, supplyMode: mode } as RequestPreparationCaller;
        const candidates = Array.from({ length: 4 }, (_, index) => ({
          tenantId,
          accountId: `candidate-live-${mode}-${index}-${randomUUID()}`,
          upstreamId: `candidate-live-upstream-${index}`,
          supplyMode: mode,
          accountOwnerKind: mode === 'byok' ? 'tenant' : 'platform',
        })) as RequestPreparationCandidateAuthority[];
        for (const candidate of candidates) {
          const attemptId = randomUUID();
          const lease = await migrator.query<{ fencing_token: string }>(
            `INSERT INTO saas_provider_account_leases
            (id,tenant_id,owner_kind,owner_tenant_id,account_id,upstream_id,attempt_id,slot,lease_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,0,clock_timestamp()+interval '5 minutes') RETURNING fencing_token::text`,
            [
              randomUUID(),
              tenantId,
              candidate.accountOwnerKind,
              mode === 'byok' ? tenantId : null,
              candidate.accountId,
              candidate.upstreamId,
              attemptId,
            ],
          );
          assert.equal(
            await store.recordRuntimeOutcome({
              candidate,
              attemptId,
              fencingToken: lease.rows[0].fencing_token,
              evidence: { source: 'gateway', result: 'success' },
            }),
            'applied',
          );
          // Another tenant's identically named BYOK account must not affect this count.
          if (mode === 'byok')
            await migrator.query(
              `INSERT INTO saas_provider_account_leases
            (id,tenant_id,owner_kind,owner_tenant_id,account_id,upstream_id,attempt_id,slot,lease_expires_at)
           VALUES ($1,$2,'tenant',$2,$3,$4,$5,0,clock_timestamp()+interval '5 minutes')`,
              [randomUUID(), otherTenantId, candidate.accountId, candidate.upstreamId, randomUUID()],
            );
        }
        const native = dependencies(
          new PostgresProviderAccountScheduler({ database, health: store, leaseConcurrencyLimit: 2 }),
        );
        const scope = native.candidateReadScope;
        const readHealth = async () =>
          Promise.all(
            candidates.map((candidate) =>
              native.health.get({ caller, candidate, now: new Date(), clock: () => new Date() }),
            ),
          );
        const readConcurrency = async () =>
          Promise.all(
            candidates.map((candidate) =>
              native.concurrency.get({ caller, candidate, requestId: randomUUID(), now: new Date() }),
            ),
          );
        calls.length = 0;
        const referenceHealth = await readHealth();
        const referenceConcurrency = await readConcurrency();
        assert.equal(calls.length, 8);
        calls.length = 0;
        assert.deepEqual(await scope({ phase: 'health', caller, candidates }, readHealth), referenceHealth);
        assert.deepEqual(
          await scope({ phase: 'concurrency', caller, candidates }, readConcurrency),
          referenceConcurrency,
        );
        assert.equal(calls.length, 2);
        for (const decision of referenceConcurrency) {
          assert.equal(decision.decision, 'allow');
          if (decision.decision === 'allow') assert.deepEqual(decision.value, { inFlight: 1, limit: 2 });
        }
        // No cross-selection cache: expiry is evaluated by the database clock.
        await migrator.query(
          `INSERT INTO saas_provider_account_leases
        (id,tenant_id,owner_kind,owner_tenant_id,account_id,upstream_id,attempt_id,slot,lease_expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,clock_timestamp()+interval '1000 milliseconds')`,
          [
            randomUUID(),
            tenantId,
            candidates[0].accountOwnerKind,
            mode === 'byok' ? tenantId : null,
            candidates[0].accountId,
            candidates[0].upstreamId,
            randomUUID(),
          ],
        );
        assert.equal((await scope({ phase: 'concurrency', caller, candidates }, readConcurrency))[0].decision, 'deny');
        await delay(1125);
        assert.equal((await scope({ phase: 'concurrency', caller, candidates }, readConcurrency))[0].decision, 'allow');
      }
    } catch (error) {
      throw safeHealthClockFailure(error);
    } finally {
      await Promise.allSettled(databases.map((database) => database.close()));
    }
  },
);

for (const mode of ['byok', 'platform'] as const)
  test(
    `three native PostgreSQL scheduler instances coalesce ${mode} batched stale probes without changing HTTP fixture history`,
    required,
    async () => {
      const { databases, migrator, gateway } = await healthClockDatabases();
      try {
        const httpHistory = () =>
          migrator.query<{ row: string }>(
            `SELECT to_jsonb(lease)::text AS row FROM saas_provider_account_leases lease
          WHERE account_id LIKE 'gateway-e2e-%' ORDER BY id`,
          );
        const originalHttpHistory = (await httpHistory()).rows;
        // Lease history is append-only. Own a complete tenant/account authority
        // instead of borrowing the HTTP tenant whose exact probe history is
        // checked by 056 and later gates. All ordinary setup guards stay enabled.
        const fixture = await seedFixture(migrator, gateway, mode);
        assert.ok(fixture.sent.accountId);
        const candidate = {
          tenantId: fixture.tenantId,
          accountId: fixture.sent.accountId,
          upstreamId: fixture.sent.upstreamId,
          accountOwnerKind: mode === 'byok' ? 'tenant' : 'platform',
          supplyMode: mode,
        } as RequestPreparationCandidateAuthority;
        const caller = { tenantId: fixture.tenantId, supplyMode: mode } as RequestPreparationCaller;
        const initialStore = new PostgresProviderAccountRuntimeHealthStore({ database: gateway, maxHealthAgeMs: 1000 });
        const initial = dependencies(
          new PostgresProviderAccountScheduler({
            database: gateway,
            health: initialStore,
            leaseConcurrencyLimit: 100,
            maxHealthAgeMs: 1000,
            healthProbe: {
              store: initialStore,
              leaseProvider: new PostgresProviderAccountLeaseService({
                database: gateway,
                maxConcurrency: 100,
                leaseTtlMs: 10_000,
              }),
            },
          }),
        );
        assert.equal(
          (await initial.health.get({ caller, candidate, now: new Date(), clock: () => new Date() })).decision,
          'allow',
          'warm the owned account through the real unobserved-health lease and probe path',
        );
        await delay(1100);
        const count = 24;
        let arrived = 0;
        let release!: () => void;
        const initialBarrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const calls: string[] = [];
        const database = observed(gateway, calls, async () => {
          if (++arrived === count) release();
          await initialBarrier;
        });
        const instances = Array.from({ length: 3 }, () => {
          const store = new PostgresProviderAccountRuntimeHealthStore({ database, maxHealthAgeMs: 1000 });
          return dependencies(
            new PostgresProviderAccountScheduler({
              database,
              health: store,
              leaseConcurrencyLimit: 100,
              maxHealthAgeMs: 1000,
              healthProbe: {
                store,
                leaseProvider: new PostgresProviderAccountLeaseService({
                  database,
                  maxConcurrency: 100,
                  leaseTtlMs: 10_000,
                }),
              },
            }),
          );
        });
        const results = await Promise.all(
          Array.from({ length: count }, (_, index) => {
            const native = instances[index % instances.length];
            return native.candidateReadScope({ phase: 'health', caller, candidates: [candidate] }, () =>
              native.health.get({ caller, candidate, now: new Date(), clock: () => new Date() }),
            );
          }),
        );
        assert.deepEqual(
          results.map((result) => result.decision),
          Array(count).fill('allow'),
        );
        assert.equal(
          calls.filter((sql) => sql.includes('authorized_lease AS')).length,
          1,
          'one fenced probe outcome across three instances',
        );
        assert.equal(
          calls.filter((sql) => sql.includes('SELECT state, observed_at, cooldown_until, failure_count')).length >=
            count,
          true,
          'every local waiter and remote CAS loser reads current authority after its initial snapshot',
        );
        for (const native of instances)
          assert.deepEqual(Reflect.ownKeys(native.health).sort(), ['leaseProvider', 'maxHealthAgeMs', 'store']);
        const ownLeases = await migrator.query<{ status: string; release_recorded: boolean }>(
          `SELECT status, released_at IS NOT NULL AS release_recorded FROM saas_provider_account_leases
          WHERE tenant_id = $1 AND account_id = $2 ORDER BY fencing_token`,
          [fixture.tenantId, candidate.accountId],
        );
        assert.deepEqual(
          ownLeases.rows,
          [
            { status: 'released', release_recorded: true },
            { status: 'released', release_recorded: true },
          ],
          'only the owned warmup and the single coalesced probe leave durable released history',
        );
        assert.deepEqual(
          (await httpHistory()).rows,
          originalHttpHistory,
          'the HTTP fixture lease history is untouched',
        );
      } catch (error) {
        throw safeHealthClockFailure(error);
      } finally {
        await Promise.allSettled(databases.map((database) => database.close()));
      }
    },
  );
