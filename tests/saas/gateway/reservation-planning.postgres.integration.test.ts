import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { saasAdvisoryKey } from '../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { createPostgresBillingGroupSpendAdmission } from '../../../src/saas/gateway/postgres-billing-group-spend.js';
import { createPostgresKeyBudgetAdmission } from '../../../src/saas/gateway/postgres-preparation-budget.js';
import { PostgresPreparationCapacityAdapter } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import { hasPreparationTransactionAuthority } from '../../../src/saas/gateway/postgres-request-admission-guard.js';
import { withPreparationTransactionFacts } from '../../../src/saas/gateway/preparation-transaction-facts.js';
import { sha256Hex } from '../../../src/saas/metering/digest.js';
import {
  anyRoleConfigured,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';
import { alignPlatformPool, createAdmissionHarness } from './admission-bench-fixture.js';

const skip = process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured;
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function waitForLock(database: SaasDatabase, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await database.query<{ locktype: string }>(
      'SELECT locktype FROM pg_locks WHERE pid=$1 AND NOT granted',
      [pid],
    );
    if (result.rows.length > 0) return;
    await delay(10);
  }
  assert.fail(`backend ${pid} never reached a PostgreSQL lock wait`);
}
async function noResidue(database: SaasDatabase, requestId: string) {
  const result = await database.query(
    `SELECT
    (SELECT count(*)::int FROM saas_requests WHERE id::text=$1::text) AS requests,
    (SELECT count(*)::int FROM saas_attempts WHERE request_id::text=$1::text) AS attempts,
    (SELECT count(*)::int FROM saas_billing_reservations WHERE request_id::text=$1::text) AS holds,
    (SELECT count(*)::int FROM saas_api_key_budget_reservations WHERE request_id::text=$1::text) AS budgets,
    (SELECT count(*)::int FROM saas_gateway_capacity_reservations WHERE request_id::text=$1::text) AS capacity,
    (SELECT count(*)::int FROM saas_request_admission_outbox WHERE request_id::text=$1::text) AS outbox`,
    [requestId],
  );
  assert.deepEqual(result.rows, [{ requests: 0, attempts: 0, holds: 0, budgets: 0, capacity: 0, outbox: 0 }]);
}
async function runner(migrator: SaasDatabase, gateway: SaasDatabase, options: { budgetNow?: () => Date } = {}) {
  const fixture = await seedFixture(migrator, gateway, 'platform');
  // The historical FIN fixture inserts its key directly rather than through the
  // modern key service that seeds an unlimited budget head.
  await migrator.query(
    `INSERT INTO saas_api_key_budget_policies
    (tenant_id, project_id, key_id, lineage_id, version)
    VALUES ($1,$2,$3,$3,1) ON CONFLICT DO NOTHING`,
    [fixture.tenantId, fixture.projectId, fixture.keyId],
  );
  const pool = await alignPlatformPool(migrator, fixture);
  const keyBudget = createPostgresKeyBudgetAdmission({ now: options.budgetNow ?? (() => new Date()) });
  const groupSpend = createPostgresBillingGroupSpendAdmission({ now: () => new Date() });
  const capacity = new PostgresPreparationCapacityAdapter();
  const prepareKey = keyBudget.prepareReserve,
    prepareGroup = groupSpend.prepareReserve;
  assert.ok(prepareKey);
  assert.ok(prepareGroup);
  type State = {
    planned: boolean;
    trace: string[];
    apply: Array<() => Promise<unknown>>;
    afterPlan?: (tx: SqlExecutor) => Promise<void>;
  };
  const states = new Map<string, State>();
  const harness = await createAdmissionHarness(migrator, gateway, fixture, 'platform', pool, {
    beforeReservations: async ({ executor, admission, platformPriceHold }) => {
      const state = states.get(admission.request.id);
      assert.ok(state);
      assert.ok(admission.initialAttempt);
      const request = admission.request;
      assert.ok(hasPreparationTransactionAuthority(executor, { tenantId: request.tenantId, requestId: request.id }));
      assert.ok(platformPriceHold);
      const charge = {
        currency: platformPriceHold.currency,
        amountMinorUnits: String(platformPriceHold.amountMinorUnits),
      };
      const keyFacts = {
        tenantId: request.tenantId,
        projectId: request.projectId,
        keyId: request.proxyKeyId,
        requestId: request.id,
        supplyMode: 'platform' as const,
        payloadBounds: harness.plan.payloadBounds,
        charge,
      };
      const groupFacts = { tenantId: request.tenantId, requestId: request.id, supplyMode: 'platform' as const, charge };
      const capacityFacts = {
        tenantId: request.tenantId,
        projectId: request.projectId,
        proxyKeyId: request.proxyKeyId,
        requestId: request.id,
        attemptId: admission.initialAttempt.id,
        supplyMode: 'platform' as const,
        newRequest: true,
        payloadBounds: harness.plan.payloadBounds,
        idempotencyScopeKey: sha256Hex(request.id),
        requestFingerprint: request.requestFingerprint,
        requestFingerprintVersion: request.requestFingerprintVersion,
      };
      state.apply = state.planned
        ? [
            await prepareKey(executor, keyFacts),
            await prepareGroup(executor, groupFacts),
            await capacity.prepareReserve(executor, capacityFacts),
          ]
        : [
            () => keyBudget.reserve(executor, keyFacts),
            () => groupSpend.reserve(executor, groupFacts),
            () => capacity.reserve(executor, capacityFacts),
          ];
      await state.afterPlan?.(executor);
    },
  });
  const run = async (
    options: {
      planned?: boolean;
      afterPlan?: State['afterPlan'];
      rollback?: boolean;
      requestId?: string;
      started?: (pid: number) => void;
      trace?: string[];
      afterQuery?: (tx: SqlExecutor, sql: string) => Promise<void>;
    } = {},
  ) => {
    const requestId = options.requestId ?? randomUUID(),
      attemptId = randomUUID(),
      label = `plan:${requestId}`;
    const built = harness.plan.command(requestId, attemptId, label);
    const candidate = built.request.initialAttempt as Record<string, unknown>;
    assert.equal(typeof candidate.payloadSha256, 'string');
    const state: State = {
      planned: options.planned !== false,
      trace: options.trace ?? [],
      apply: [],
      afterPlan: options.afterPlan,
    };
    states.set(requestId, state);
    try {
      await gateway.transaction(async (raw) => {
        const backend = await raw.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        assert.ok(backend.rows[0]);
        options.started?.(backend.rows[0].pid);
        let scoped: SqlExecutor | undefined;
        const tracing: SqlExecutor = {
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            state.trace.push(sql);
            const result = await raw.query<Row>(sql, values);
            if (scoped) await options.afterQuery?.(scoped, sql);
            return result;
          },
        };
        await withPreparationTransactionFacts(
          tracing,
          { tenantId: fixture.tenantId, requestId, attemptId, payloadSha256: candidate.payloadSha256 as string },
          async (tx) => {
            scoped = tx;
            const admitted = await harness.admit(tx, requestId, attemptId, label);
            assert.equal(admitted.kind, 'created');
            for (const apply of state.apply) {
              const result = await apply();
              if (result && typeof result === 'object' && 'decision' in result) assert.equal(result.decision, 'allow');
            }
            if (options.rollback) throw new Error('intentional rollback after every reservation');
          },
        );
      });
      return { requestId, trace: state.trace };
    } finally {
      states.delete(requestId);
    }
  };
  return { run, fixture };
}

test('real PostgreSQL fenced reservation plans move policy reads before hot locks without changing mutable order', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 6 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 6 });
  t.after(async () => {
    await Promise.all([migrator.close(), gateway.close()]);
  });
  const { run } = await runner(migrator, gateway);
  const baseline = await run({ planned: false });
  const optimized = await run();
  const index = (trace: string[], text: string) => trace.findIndex((sql) => sql.includes(text));
  const counter = 'INSERT INTO saas_provider_account_rate_counters';
  for (const read of [
    'FROM saas_api_key_budget_policies',
    'SELECT billing_group_id, group_daily_limit_minor_units',
    'SELECT t.status AS tenant_status',
    'postgres-preparation-capacity:billing-group-terms',
  ]) {
    assert.ok(index(baseline.trace, read) > index(baseline.trace, counter), read);
    assert.ok(index(optimized.trace, read) < index(optimized.trace, counter), read);
    assert.equal(optimized.trace.filter((sql) => sql.includes(read)).length, 1, `no hidden fallback: ${read}`);
  }
  const mutations = [
    counter,
    'INSERT INTO saas_billing_reservations',
    'INSERT INTO saas_api_key_budget_counters',
    'WITH existing AS (',
    'INSERT INTO saas_gateway_capacity_reservations',
  ];
  for (const trace of [baseline.trace, optimized.trace]) {
    const positions = mutations.map((text) => index(trace, text));
    assert.ok(positions.every((pos, i) => pos >= 0 && (i === 0 || pos > (positions[i - 1] ?? -1))));
    assert.ok(index(trace, 'WITH admitted_event AS (') < index(trace, counter));
  }
  const queriesAfter = (trace: string[]) => trace.length - index(trace, counter) - 1;
  assert.equal(
    queriesAfter(baseline.trace) - queriesAfter(optimized.trace),
    5,
    'five fenced reads leave account/wallet critical windows',
  );
  t.diagnostic(
    `post-counter statements ${queriesAfter(baseline.trace)} -> ${queriesAfter(optimized.trace)}; diagnostic statement placement, not a throughput claim`,
  );

  await t.test(
    'unknown same-transaction write forces fresh policy reads and rolls every reservation back',
    async () => {
      const requestId = randomUUID(),
        trace: string[] = [];
      await assert.rejects(
        run({
          requestId,
          trace,
          afterPlan: async (tx) => {
            await tx.query('SELECT 1 AS unfamiliar_reservation_plan_statement');
          },
          rollback: true,
        }),
        /intentional rollback/,
      );
      await noResidue(migrator, requestId);
      for (const marker of ['FROM saas_api_key_budget_policies', 'SELECT t.status AS tenant_status']) {
        assert.equal(
          trace.filter((sql) => sql.includes(marker)).length,
          2,
          'invalidated plans must perform fresh reads',
        );
      }
    },
  );
  for (const mutation of [
    'INSERT INTO saas_billing_reservations',
    'INSERT INTO saas_api_key_budget_counters',
    'INSERT INTO saas_gateway_capacity_reservations',
  ]) {
    await t.test(`unknown statement queued during ${mutation} apply forces rollback without retry`, async () => {
      const fresh = await runner(migrator, gateway);
      const requestId = randomUUID(),
        trace: string[] = [];
      let injected = false;
      await assert.rejects(
        fresh.run({
          requestId,
          trace,
          afterQuery: async (tx, sql) => {
            if (!injected && sql.includes(mutation)) {
              injected = true;
              await tx.query('SELECT 1 AS unreviewed_statement_queued_during_reservation_apply');
            }
          },
        }),
        /authority changed during apply/,
      );
      assert.equal(injected, true);
      await noResidue(migrator, requestId);
      assert.equal(
        trace.filter((sql) => sql.includes('FROM saas_api_key_budget_policies')).length,
        1,
        'post-mutation invalidation must never retry a fresh reservation',
      );
    });
  }
  await t.test(
    'concurrent same-account/wallet admissions complete with exact independent budget reservations',
    async () => {
      const fresh = await runner(migrator, gateway);
      const results = await Promise.all(Array.from({ length: 2 }, () => fresh.run()));
      const ids = results.map((result) => result.requestId);
      const counts = await migrator.query(
        `SELECT
      (SELECT count(*)::int FROM saas_billing_reservations WHERE request_id::text=ANY($1::text[])) AS holds,
      (SELECT count(*)::int FROM saas_api_key_budget_reservations WHERE request_id::text=ANY($1::text[])) AS budgets,
      (SELECT count(*)::int FROM saas_gateway_capacity_reservations WHERE request_id::text=ANY($1::text[])) AS capacity`,
        [ids],
      );
      assert.deepEqual(counts.rows, [{ holds: 2, budgets: 2, capacity: 2 }]);
    },
  );
  await t.test(
    'policy writer waits behind existing authority fences while planning holds no account/wallet lock',
    async () => {
      const { run, fixture } = await runner(migrator, gateway);
      const planned = deferred(),
        resume = deferred(),
        writerPid = deferred<number>();
      const admission = run({
        afterPlan: async () => {
          planned.resolve();
          await resume.promise;
        },
      });
      await planned.promise;
      let writerCompleted = false;
      const writer = migrator.transaction(async (tx) => {
        const backend = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0];
        assert.ok(backend);
        writerPid.resolve(backend.pid);
        // Same first exclusive fence as replaceBudgetPolicy; no lock upgrade.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          saasAdvisoryKey.tenant(fixture.tenantId),
        ]);
        await tx.query(
          `UPDATE saas_api_key_budget_policies SET version=version+1
        WHERE tenant_id=$1 AND project_id=$2 AND key_id=$3`,
          [fixture.tenantId, fixture.projectId, fixture.keyId],
        );
        writerCompleted = true;
      });
      try {
        await waitForLock(migrator, await writerPid.promise);
        assert.equal(writerCompleted, false);
        const locks = await migrator.query<{ available: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS available',
          [saasAdvisoryKey.walletFence(fixture.tenantId, 'USD')],
        );
        assert.equal(locks.rows[0]?.available, true, 'staged policy work precedes wallet lock');
      } finally {
        resume.resolve();
      }
      await Promise.all([admission, writer]);
      assert.equal(writerCompleted, true);
    },
  );
  await t.test(
    'finite group windows, group RPM, rolling key caps and a live expiry preserve native staged proofs',
    async () => {
      const fresh = await runner(migrator, gateway);
      const groupId = `fenced-plan-${randomUUID()}`;
      await migrator.query(
        `INSERT INTO saas_billing_groups
      (id, display_name, rpm_limit, daily_limit_minor_units, weekly_limit_minor_units, monthly_limit_minor_units)
      VALUES ($1,'Fenced plan test',20,1000000,2000000,3000000)`,
        [groupId],
      );
      await migrator.query(
        `UPDATE saas_api_keys SET billing_group_id=$3, expires_at=clock_timestamp()+interval '1 hour'
      WHERE tenant_id=$1 AND id=$2`,
        [fresh.fixture.tenantId, fresh.fixture.keyId, groupId],
      );
      await migrator.query(
        `UPDATE saas_api_key_budget_policies SET charge_5h=1000000, charge_7d=2000000
      WHERE tenant_id=$1 AND key_id=$2`,
        [fresh.fixture.tenantId, fresh.fixture.keyId],
      );
      const result = await fresh.run();
      for (const marker of [
        'FROM saas_api_key_budget_policies',
        'SELECT t.status AS tenant_status',
        'postgres-preparation-capacity:billing-group-rate',
        'SELECT clock_timestamp() AS database_now',
      ]) {
        assert.equal(result.trace.filter((sql) => sql.includes(marker)).length, 1, marker);
      }
      assert.equal(
        result.trace.filter((sql) => sql.includes('INSERT INTO saas_billing_group_spend_counters')).length,
        3,
      );
      assert.equal(result.trace.filter((sql) => sql.includes(') rolling')).length, 1);
      const stored = await migrator.query(
        `SELECT count(*)::int AS windows FROM saas_billing_group_spend_reservations
      WHERE tenant_id=$1 AND request_id=$2`,
        [fresh.fixture.tenantId, result.requestId],
      );
      assert.deepEqual(stored.rows, [{ windows: 3 }]);
    },
  );
  await t.test('key UTC day is sampled after staged planning, not before a midnight wait', async () => {
    let clock = new Date('2026-10-26T23:59:59.999Z');
    const fresh = await runner(migrator, gateway, { budgetNow: () => clock });
    const result = await fresh.run({
      afterPlan: async () => {
        clock = new Date('2026-10-27T00:00:00.001Z');
      },
    });
    const stored = await migrator.query<{ day: string }>(
      'SELECT day::text AS day FROM saas_api_key_budget_reservations WHERE request_id::text=$1::text',
      [result.requestId],
    );
    assert.deepEqual(stored.rows, [{ day: '2026-10-27' }]);
  });
  await t.test('concurrent planned admissions still enforce a finite key budget and roll back the loser', async () => {
    const fresh = await runner(migrator, gateway);
    await migrator.query('UPDATE saas_api_key_budget_policies SET token_daily=3000 WHERE tenant_id=$1 AND key_id=$2', [
      fresh.fixture.tenantId,
      fresh.fixture.keyId,
    ]);
    const ids = [randomUUID(), randomUUID()];
    const outcomes = await Promise.allSettled(ids.map((requestId) => fresh.run({ requestId })));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    const rejected = outcomes.findIndex((outcome) => outcome.status === 'rejected');
    assert.ok(rejected >= 0);
    const failure = outcomes[rejected];
    assert.ok(failure);
    assert.equal(failure.status === 'rejected' && failure.reason?.code, 'KEY_BUDGET_EXCEEDED');
    const rejectedId = ids[rejected];
    assert.ok(rejectedId);
    await noResidue(migrator, rejectedId);
    const counts = await migrator.query(
      `SELECT token_outstanding_reserved::text AS reserved
      FROM saas_api_key_budget_counters WHERE tenant_id=$1 AND lineage_id=$2 AND window_kind='daily'`,
      [fresh.fixture.tenantId, fresh.fixture.keyId],
    );
    assert.deepEqual(counts.rows, [{ reserved: '2000' }]);
  });
  await t.test(
    'key expiry crossed during a real wallet wait is rejected after planning, with full rollback',
    async () => {
      const fresh = await runner(migrator, gateway);
      await migrator.query(
        "UPDATE saas_api_keys SET expires_at=clock_timestamp()+interval '3 seconds' WHERE tenant_id=$1 AND id=$2",
        [fresh.fixture.tenantId, fresh.fixture.keyId],
      );
      const locked = deferred(),
        unlock = deferred(),
        backend = deferred<number>(),
        planned = deferred();
      const blocker = migrator.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          saasAdvisoryKey.walletFence(fresh.fixture.tenantId, 'USD'),
        ]);
        locked.resolve();
        await unlock.promise;
      });
      await locked.promise;
      const requestId = randomUUID();
      const admission = fresh.run({
        requestId,
        started: backend.resolve,
        afterPlan: async () => {
          planned.resolve();
        },
      });
      // Attach rejection immediately while the orchestrator establishes the wait.
      const denied = assert.rejects(admission, /'block' !== 'allow'/);
      try {
        await planned.promise;
        await waitForLock(migrator, await backend.promise);
        await migrator.query(
          `SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM expires_at-clock_timestamp())) + 0.02)
        FROM saas_api_keys WHERE tenant_id=$1 AND id=$2`,
          [fresh.fixture.tenantId, fresh.fixture.keyId],
        );
      } finally {
        unlock.resolve();
      }
      await Promise.all([blocker, denied]);
      await noResidue(migrator, requestId);
    },
  );
});
