import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresPreparationCapacityAdapter } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import {
  anyRoleConfigured,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';
import { alignPlatformPool, createAdmissionHarness } from './admission-bench-fixture.js';

/**
 * R9 P4/P16 (admission de-serialization) — admission statement budget.
 *
 * Every statement on the admission transaction is a PostgreSQL round trip on
 * the pool's critical path. This gate drives one fresh member-principal
 * platform admission (prelock → metering → guard → wallet hold → capacity
 * reservation) on the disposable E2E database through a counting executor and
 * fails when the round-trip count grows past the budget. Raise the budget only
 * with a deliberate statement-count increase; lower it when an optimization
 * lands (this is the regression tripwire for roadmap batch 1.2 step 2).
 *
 * Attribution buckets: queries tagged with the `postgres-request-admission`
 * marker come from the admission guard, `postgres-preparation-capacity` from
 * the capacity adapter; everything else on the transaction is the
 * authorization prelock plus metering/billing writes.
 */

function countingExecutor(inner: SqlExecutor): { executor: SqlExecutor; counts: () => number } {
  let total = 0;
  const executor: SqlExecutor = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      total += 1;
      return inner.query<Row>(sql, values);
    },
  };
  return { executor, counts: () => total };
}

interface AdmissionStatementProfile {
  readonly total: number;
  readonly guardFences: number;
  readonly guardReads: number;
  readonly capacity: number;
  readonly other: number;
}

function profileStatements(sql: readonly string[]): AdmissionStatementProfile {
  const isGuardFence = (statement: string) => statement.includes('postgres-request-admission:fence-');
  const isGuard = (statement: string) => statement.includes('postgres-request-admission:');
  const isCapacity = (statement: string) => statement.includes('postgres-preparation-capacity:');
  return {
    total: sql.length,
    guardFences: sql.filter(isGuardFence).length,
    guardReads: sql.filter((statement) => isGuard(statement) && !isGuardFence(statement)).length,
    capacity: sql.filter(isCapacity).length,
    other: sql.filter((statement) => !isGuard(statement) && !isCapacity(statement)).length,
  };
}

test('admission statement budget: one fresh platform member admission stays within the round-trip budget', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to run the admission statement budget`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = observedDatabase(urls[0]);
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  t.after(async () => {
    await Promise.allSettled([migrator.database.close(), gateway.close()]);
  });
  await phase('readiness', async () => {
    await gateway.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway, 'gateway');
  });

  const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
  const pool = await phase('pool-align', () => alignPlatformPool(migrator.database, fixture));
  const harness = await phase('harness', () =>
    createAdmissionHarness(migrator.database, gateway, fixture, 'platform', pool),
  );
  const capacity = new PostgresPreparationCapacityAdapter();

  const requestId = randomUUID();
  const attemptId = randomUUID();
  const label = `budget-${requestId}`;
  const idempotencyScopeKey = createHash('sha256').update(`budget-idem:${requestId}`).digest('hex');
  const requestFingerprint = createHash('sha256').update(`budget-fingerprint:${requestId}`).digest('hex');
  const sqlTrace: string[] = [];
  let afterAdmission = -1;
  let admissionKind = '';
  let capacityDecision = '';

  await phase('admission-transaction', () =>
    gateway.transaction(async (tx) => {
      const counting = countingExecutor(tx);
      const tracing: SqlExecutor = {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          sqlTrace.push(sql.replace(/\s+/g, ' ').trim());
          return counting.executor.query<Row>(sql, values);
        },
      };
      const admitted = await harness.admit(tracing, requestId, attemptId, label);
      afterAdmission = counting.counts();
      admissionKind = admitted.kind;
      const decision = await capacity.reserve(tracing, {
        tenantId: fixture.tenantId,
        projectId: fixture.projectId,
        proxyKeyId: fixture.keyId,
        requestId,
        attemptId,
        supplyMode: 'platform',
        payloadBounds: harness.plan.payloadBounds,
        idempotencyScopeKey,
        requestFingerprint,
        requestFingerprintVersion: 'canonical-v1',
      });
      capacityDecision = decision.decision;
      if (counting.counts() !== sqlTrace.length) throw new Error('counting mismatch');
    }),
  );

  assert.equal(admissionKind, 'created', 'the budget admission must be a fresh create');
  assert.equal(capacityDecision, 'allow', 'the capacity reservation must be admitted');
  assert.ok(afterAdmission > 0);

  const profile = profileStatements(sqlTrace);
  t.diagnostic(
    `admission statements=${afterAdmission} total=${profile.total} ` +
      `(guard fences=${profile.guardFences}, guard reads=${profile.guardReads}, ` +
      `capacity=${profile.capacity}, prelock+metering+billing=${profile.other})`,
  );

  // Budget history:
  // - 2026-10-17 pre-step-2 baseline: total=93, admission phase=88
  //   (12 guard fence statements + a 12-statement prelock).
  // - Step 2 (P4, batched fences + merged prelock read): total=72,
  //   admission=66, guard fences=1, guard reads=32.
  // The counts are deterministic for this fixture (no key expiry, no group
  // RPM ceiling), so any increase is a real regression or a deliberate
  // statement-count change that must raise this budget consciously.
  assert.equal(
    profile.guardFences,
    1,
    `admission guard must batch its shared advisory fences into one statement (got ${profile.guardFences})`,
  );
  assert.ok(
    profile.guardReads <= 32,
    `admission guard authority reads must stay within the statement budget (got ${profile.guardReads})`,
  );
  assert.ok(
    afterAdmission <= 66,
    `admission phase (prelock+metering+guard+billing) must stay within the statement budget (got ${afterAdmission})`,
  );
  assert.ok(
    profile.total <= 72,
    `full admission transaction must stay within the statement budget (got ${profile.total})`,
  );
});
