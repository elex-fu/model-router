import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresPreparationCapacityAdapter } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import type { PostgresPreparationObservation } from '../../../src/saas/gateway/postgres-preparation-observer.js';
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
    // Schema readiness only: the runtime-privilege production-policy gate
    // tracks grant additions from parallel work streams and is unrelated to
    // the statement budget under test here.
    await gateway.verifySchema();
  });

  const fixture = await phase('seed', () => seedFixture(migrator.database, gateway, 'platform'));
  const pool = await phase('pool-align', () => alignPlatformPool(migrator.database, fixture));
  const observations: PostgresPreparationObservation[] = [];
  const harness = await phase('harness', () =>
    createAdmissionHarness(migrator.database, gateway, fixture, 'platform', pool, {
      observe: (observation) => observations.push(observation),
    }),
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
          const result = await counting.executor.query<Row>(sql, values);
          if (sql.includes('postgres-request-admission:authority-batch')) {
            const key = (result.rows as Array<{ stage: string; facts: Array<Record<string, unknown>> }>).find(
              (row) => row.stage === 'key',
            )?.facts[0];
            assert.ok(key, 'the live batch must retain the key authority fact');
            for (const field of [
              'authz_version',
              'entitlement_authz_version',
              'supply_profile_authz_version',
              'model_scope_version',
            ]) {
              assert.equal(typeof key[field], 'string', `${field} must retain pg int8 decimal text`);
            }
          }
          return result;
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

  const bookkeeping = sqlTrace.filter((sql) => sql.includes('WITH admitted_event AS ('));
  assert.equal(bookkeeping.length, 1, 'one statement must persist both outbox and audit');
  const facts = await migrator.database.query<{ outbox_count: string; audit_count: string; same_time: boolean }>(
    `SELECT (SELECT count(*)::text FROM saas_request_admission_outbox WHERE request_id = $1) AS outbox_count,
            (SELECT count(*)::text FROM saas_audit_events WHERE request_id = $1::text AND action = 'request.admitted') AS audit_count,
            EXISTS (SELECT 1 FROM saas_request_admission_outbox o JOIN saas_audit_events a
                      ON a.request_id = o.request_id::text AND a.tenant_id = o.tenant_id
                     AND a.occurred_at = o.created_at
                    WHERE o.request_id = $1 AND a.action = 'request.admitted') AS same_time`,
    [requestId],
  );
  assert.deepEqual(facts.rows, [{ outbox_count: '1', audit_count: '1', same_time: true }]);

  await t.test('audit insert failure rolls back the combined outbox and all admission state', async () => {
    const failedRequestId = randomUUID();
    const failedAttemptId = randomUUID();
    await assert.rejects(
      gateway.transaction(async (tx) => {
        const rejectingAudit: SqlExecutor = {
          query<Row>(sql: string, values?: readonly unknown[]) {
            if (sql.includes('WITH admitted_event AS (')) {
              const rejected = [...(values ?? [])];
              // A valid UUID with no user row reaches the audit FK check,
              // after the dependent outbox INSERT has executed.
              rejected[11] = randomUUID();
              return tx.query<Row>(sql, rejected);
            }
            return tx.query<Row>(sql, values);
          },
        };
        await harness.admit(rejectingAudit, failedRequestId, failedAttemptId, `audit-failure-${failedRequestId}`);
      }),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '23503',
    );
    const residue = await migrator.database.query<{ requests: string; outbox: string; audits: string }>(
      `SELECT (SELECT count(*)::text FROM saas_requests WHERE id = $1) AS requests,
              (SELECT count(*)::text FROM saas_request_admission_outbox WHERE request_id = $1) AS outbox,
              (SELECT count(*)::text FROM saas_audit_events WHERE request_id = $1::text AND action = 'request.admitted') AS audits`,
      [failedRequestId],
    );
    assert.deepEqual(residue.rows, [{ requests: '0', outbox: '0', audits: '0' }]);
  });

  const profile = profileStatements(sqlTrace);
  t.diagnostic(
    `admission statements=${afterAdmission} total=${profile.total} ` +
      `(guard fences=${profile.guardFences}, guard reads=${profile.guardReads}, ` +
      `capacity=${profile.capacity}, prelock+metering+billing=${profile.other})`,
  );
  const guardPhase = observations.find(
    (observation) => observation.kind === 'phase' && observation.phase === 'admission-guard',
  );
  const batch = observations.find(
    (observation) => observation.operation === 'postgres-request-admission:authority-batch',
  );
  assert.ok(guardPhase?.outcome === 'ok' && batch?.outcome === 'ok');
  t.diagnostic(`guard phase=${guardPhase.durationMs.toFixed(2)}ms authority batch=${batch.durationMs.toFixed(2)}ms`);

  // Budget history:
  // - 2026-10-17 pre-step-2 baseline: total=93, admission phase=88
  //   (12 guard fence statements + a 12-statement prelock).
  // - Step 2 (P4, batched fences + merged prelock read): total=72,
  //   admission=66, guard fences=1, guard reads=32.
  // - Step 3 (P4, wallet advisory fence replaces the saas_wallets row FOR
  //   UPDATE): total=73, admission=67 — exactly one added statement, the
  //   pg_advisory_xact_lock acquisition inside billing.reserve.
  // - 2026-10-21 section 15.5: fenced authority facts share one fresh PG
  //   snapshot, without caching mutable state: total=49, admission=43,
  //   guard reads=8 (the catalog/price service reads remain additional).
  // - 2026-10-26: outbox + audit dependent INSERT CTE saves one round trip:
  //   total=48, admission=42, with both facts still synchronous and atomic.
  // The counts are deterministic for this fixture (no key expiry, no group
  // RPM ceiling), so any increase is a real regression or a deliberate
  // statement-count change that must raise this budget consciously.
  assert.equal(
    profile.guardFences,
    1,
    `admission guard must batch its shared advisory fences into one statement (got ${profile.guardFences})`,
  );
  assert.ok(
    profile.guardReads <= 8,
    `admission guard authority reads must stay within the statement budget (got ${profile.guardReads})`,
  );
  assert.ok(
    afterAdmission <= 42,
    `admission phase (prelock+metering+guard+billing) must stay within the statement budget (got ${afterAdmission})`,
  );
  assert.ok(
    profile.total <= 48,
    `full admission transaction must stay within the statement budget (got ${profile.total})`,
  );
});
