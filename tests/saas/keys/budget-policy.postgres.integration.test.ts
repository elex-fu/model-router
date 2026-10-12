import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  applyKeyBudgetCorrection,
  KEY_BUDGET_LIFETIME_DAY,
  keyBudgetUtcDayFrom,
  releaseKeyBudgetReservation,
  reserveKeyBudgetCounters,
  selectKeyBudgetCounters,
  selectKeyBudgetPolicyHead,
  selectKeyBudgetReservation,
  settleKeyBudgetReservation,
} from '../../../src/saas/keys/budget-store.js';
import { KeyService } from '../../../src/saas/keys/service.js';
import { SaasKeyError } from '../../../src/saas/keys/types.js';
import {
  anyRoleConfigured,
  type Fixture,
  observedDatabase,
  phase,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

// KEY081 real-PG gate: per-lineage budget policy heads, counters and guarded
// reservation evidence (contract C-4, migration 081) under the restricted
// control-plane and gateway roles. The FIN057 fixture seeds the full route and
// commercial authority chain every saas_requests row requires. Registered
// schema and the three preprovisioned roles are required. No bootstrap, HTTP
// fixture dependency, migrations, DDL, role changes or provider traffic.

/** The fixture inserts its key row directly, so the gate mirrors the 081 backfill head. */
async function seedBudgetHead(migrator: SaasDatabase, seed: Fixture): Promise<void> {
  await phase('setup', () =>
    migrator.transaction((tx) =>
      tx.query(
        `INSERT INTO saas_api_key_budget_policies
           (tenant_id, project_id, key_id, lineage_id, version, created_at, updated_at)
         VALUES ($1, $2, $3, $3, 1, clock_timestamp(), clock_timestamp())`,
        [seed.tenantId, seed.projectId, seed.keyId],
      ),
    ),
  );
}

async function budgetAcl(controlPlane: SqlExecutor, gateway: SqlExecutor): Promise<void> {
  await phase('acl', async () => {
    // Column-level least privilege never rolls up to has_table_privilege in
    // PostgreSQL; probe representative columns for the granted privileges and
    // the table level for the mutation paths that must stay entirely absent.
    const control = await controlPlane.query<{
      role: string;
      selectPolicy: boolean;
      insertPolicy: boolean;
      updatePolicyCaps: boolean;
      updatePolicyCreatedAt: boolean;
      deletePolicy: boolean;
      selectCounter: boolean;
      updateCounterSettled: boolean;
      insertCounter: boolean;
      selectReservation: boolean;
      insertReservation: boolean;
      updateReservation: boolean;
    }>(`SELECT current_user AS role,
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'version', 'SELECT') AS "selectPolicy",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'token_daily', 'INSERT') AS "insertPolicy",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'token_daily', 'UPDATE') AS "updatePolicyCaps",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'created_at', 'UPDATE') AS "updatePolicyCreatedAt",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'DELETE') AS "deletePolicy",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'token_settled', 'SELECT') AS "selectCounter",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'token_settled', 'UPDATE') AS "updateCounterSettled",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'INSERT') AS "insertCounter",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'state', 'SELECT') AS "selectReservation",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'INSERT') AS "insertReservation",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'UPDATE') AS "updateReservation"`);
    assert.equal(control.rows.length, 1);
    const [controlRow] = control.rows;
    assert.ok(controlRow);
    assert.equal(controlRow.role, 'model_router_saas_control_plane');
    assert.equal(controlRow.selectPolicy, true);
    assert.equal(controlRow.insertPolicy, true);
    assert.equal(controlRow.updatePolicyCaps, true);
    assert.equal(controlRow.updatePolicyCreatedAt, false, 'policy head creation is insert-only evidence');
    assert.equal(controlRow.deletePolicy, false, 'policy heads are never deleted under the runtime roles');
    assert.equal(controlRow.selectCounter, true);
    assert.equal(controlRow.updateCounterSettled, true, 'settled corrections adjust counters via the control plane');
    assert.equal(controlRow.insertCounter, false, 'counter rows are gateway-only writes');
    assert.equal(controlRow.selectReservation, true);
    assert.equal(controlRow.insertReservation, false);
    assert.equal(controlRow.updateReservation, false);

    const gw = await gateway.query<{
      role: string;
      selectPolicy: boolean;
      insertPolicy: boolean;
      updatePolicy: boolean;
      deletePolicy: boolean;
      insertCounter: boolean;
      updateCounterOutstanding: boolean;
      updateCounterCreatedAt: boolean;
      deleteCounter: boolean;
      insertReservation: boolean;
      updateReservationState: boolean;
      updateReservationDay: boolean;
      deleteReservation: boolean;
    }>(`SELECT current_user AS role,
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'version', 'SELECT') AS "selectPolicy",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'INSERT') AS "insertPolicy",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'UPDATE') AS "updatePolicy",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_policies', 'DELETE') AS "deletePolicy",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'day', 'INSERT') AS "insertCounter",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'token_outstanding_reserved', 'UPDATE') AS "updateCounterOutstanding",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'created_at', 'UPDATE') AS "updateCounterCreatedAt",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_counters', 'DELETE') AS "deleteCounter",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'day', 'INSERT') AS "insertReservation",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'state', 'UPDATE') AS "updateReservationState",
         has_column_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'day', 'UPDATE') AS "updateReservationDay",
         has_table_privilege(current_user, 'model_router_saas.saas_api_key_budget_reservations', 'DELETE') AS "deleteReservation"`);
    assert.equal(gw.rows.length, 1);
    const [gwRow] = gw.rows;
    assert.ok(gwRow);
    assert.equal(gwRow.role, 'model_router_saas_gateway');
    assert.equal(gwRow.selectPolicy, true, 'admission reads the persisted policy head');
    assert.equal(gwRow.insertPolicy, false);
    assert.equal(gwRow.updatePolicy, false);
    assert.equal(gwRow.deletePolicy, false);
    assert.equal(gwRow.insertCounter, true, 'admission upserts outstanding counters');
    assert.equal(gwRow.updateCounterOutstanding, true, 'settle/release move outstanding counters');
    assert.equal(gwRow.updateCounterCreatedAt, false, 'counter creation is insert-only evidence');
    assert.equal(gwRow.deleteCounter, false);
    assert.equal(gwRow.insertReservation, true, 'admission records the per-request reservation');
    assert.equal(gwRow.updateReservationState, true, 'settle/release advance the guarded state column');
    assert.equal(gwRow.updateReservationDay, false, 'reservation days are immutable accounting facts');
    assert.equal(gwRow.deleteReservation, false, 'reservations are retained as conservative evidence');
  });
}

function context(seed: Fixture) {
  return {
    userId: seed.userId,
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    tenantRole: 'owner' as const,
    projectRole: 'owner' as const,
  };
}

async function assertBudgetConflict(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    if (error instanceof SaasKeyError && error.status === 409 && error.code === 'KEY_BUDGET_POLICY_VERSION_CONFLICT') {
      return true;
    }
    throw error;
  });
}

async function assertTriggerRejects(work: () => Promise<unknown>, fragment: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const record = error as { code?: string; message?: string };
    if (record.code === '55000' && typeof record.message === 'string' && record.message.includes(fragment)) {
      return true;
    }
    throw error;
  });
}

test('KEY081: real persistent key budget CAS and guarded counter flows under restricted roles', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require KEY081`
      : false,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls(); // Complete safety validation BEFORE constructing any pool.
  const migrator = observedDatabase(urls[0]);
  const controlPlane = observedDatabase(urls[1]);
  const controlPlanePeer = observedDatabase(urls[1]);
  const gateway = observedDatabase(urls[2]);
  t.after(async () => {
    await phase('cleanup', async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([
            gateway.database.close(),
            controlPlane.database.close(),
            controlPlanePeer.database.close(),
            migrator.database.close(),
          ]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('KEY081 cleanup deadline')), 30_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  });
  await phase('readiness', async () => {
    await migrator.database.verifySchema();
    await verifySaasRuntimeDatabasePrivileges(gateway.database, 'gateway');
    await verifySaasRuntimeDatabasePrivileges(controlPlane.database, 'control_plane');
  });
  await budgetAcl(controlPlane.database, gateway.database);

  await t.test(
    'control-plane CAS: get, advance, stale conflict, concurrent single-winner and platform currency',
    {
      timeout: 120_000,
    },
    async () => {
      const seed = await seedFixture(migrator.database, gateway.database, 'byok');
      await seedBudgetHead(migrator.database, seed);
      const service = new KeyService(controlPlane.database);

      const initial = await phase('snapshot', () => service.getKeyBudgetPolicy(context(seed), seed.keyId));
      assert.equal(initial.version, '1');
      assert.equal(initial.authzVersion, 1);
      assert.equal(initial.supplyMode, 'byok');
      assert.equal(initial.lineageId, seed.keyId);
      assert.equal(initial.tokenUnit, 'tokens');
      assert.equal(initial.tokenCountingSemanticsVersion, 'token-units-v1');
      assert.equal(initial.currentWindow?.timezone, 'UTC');
      assert.match(initial.currentWindow?.startInclusive ?? '', /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
      assert.deepEqual(initial.tokenCaps, { daily: null, lifetime: null });
      assert.deepEqual(initial.tokenUsage, {
        daily: { status: 'verified', settled: '0', outstandingReserved: '0' },
        lifetime: { status: 'verified', settled: '0', outstandingReserved: '0' },
      });
      assert.equal(initial.customerChargeBudget, null);

      const advanced = await phase('first_complete', () =>
        service.replaceKeyBudgetPolicy(context(seed), seed.keyId, {
          expectedVersion: '1',
          tokenCaps: { daily: '100', lifetime: '1000' },
          customerChargeCaps: null,
        }),
      );
      assert.equal(advanced.version, '2');
      assert.equal(advanced.authzVersion, 2, 'replacement atomically bumps the key authorization version');
      assert.deepEqual(advanced.tokenCaps, { daily: '100', lifetime: '1000' });
      const audits = await phase('snapshot', () =>
        migrator.database.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM saas_audit_events WHERE tenant_id = $1 AND action = 'api_key.budget_policy_replaced'",
          [seed.tenantId],
        ),
      );
      assert.equal(audits.rows[0]?.count, '1', 'every committed replacement appends its audit row');

      // A stale expectation cannot move the head and leaves every fact untouched.
      await assertBudgetConflict(() =>
        service.replaceKeyBudgetPolicy(context(seed), seed.keyId, {
          expectedVersion: '1',
          tokenCaps: { daily: '0', lifetime: null },
          customerChargeCaps: null,
        }),
      );
      const afterStale = await phase('snapshot', () => service.getKeyBudgetPolicy(context(seed), seed.keyId));
      assert.equal(afterStale.version, '2');
      assert.deepEqual(afterStale.tokenCaps, { daily: '100', lifetime: '1000' });

      // Two writers on the same expected version: exactly one advances the head.
      const peerService = new KeyService(controlPlanePeer.database);
      const raceInput = {
        expectedVersion: '2',
        tokenCaps: { daily: '200', lifetime: '2000' },
        customerChargeCaps: null,
      } as const;
      const outcomes = await Promise.allSettled([
        service.replaceKeyBudgetPolicy(context(seed), seed.keyId, raceInput),
        peerService.replaceKeyBudgetPolicy(context(seed), seed.keyId, raceInput),
      ]);
      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
      assert.equal(won.length, 1, 'exactly one concurrent replacement commits');
      assert.equal(lost.length, 1);
      assert.equal((won[0] as PromiseFulfilledResult<{ version: string }>).value.version, '3');
      const reason = (lost[0] as PromiseRejectedResult).reason;
      assert.ok(
        reason instanceof SaasKeyError && reason.status === 409 && reason.code === 'KEY_BUDGET_POLICY_VERSION_CONFLICT',
        'the losing racer observes the exact version conflict',
      );

      // The platform key binds its charge budget currency from the tenant wallet.
      const platformSeed = await seedFixture(migrator.database, gateway.database, 'platform');
      await seedBudgetHead(migrator.database, platformSeed);
      const platform = await phase('first_complete', () =>
        service.replaceKeyBudgetPolicy(context(platformSeed), platformSeed.keyId, {
          expectedVersion: '1',
          tokenCaps: { daily: '50', lifetime: null },
          customerChargeCaps: { daily: '500', lifetime: '9000' },
        }),
      );
      assert.equal(platform.supplyMode, 'platform');
      assert.deepEqual(platform.customerChargeBudget, {
        currency: 'USD',
        unit: 'minor_units',
        caps: { daily: '500', lifetime: '9000' },
        usage: {
          daily: { status: 'verified', settled: '0', outstandingReserved: '0' },
          lifetime: { status: 'verified', settled: '0', outstandingReserved: '0' },
        },
      });
    },
  );

  await t.test(
    'gateway counter flow: reserve, settle, release, correction and guarded evidence',
    {
      timeout: 120_000,
    },
    async () => {
      const settleSeed = await seedFixture(migrator.database, gateway.database, 'byok');
      const releaseSeed = await seedFixture(migrator.database, gateway.database, 'byok');
      const pastSeed = await seedFixture(migrator.database, gateway.database, 'byok');
      for (const seed of [settleSeed, releaseSeed, pastSeed]) {
        await seedBudgetHead(migrator.database, seed);
      }
      const today = keyBudgetUtcDayFrom(new Date());
      const todayColumn = today.startInclusive.slice(0, 10);

      // Admission-style conservative reservations on both windows (one lineage
      // per fixture seed; each scenario runs on its own lineage).
      await phase('capacity_reserve', () =>
        gateway.database.transaction(async (tx) => {
          // Production admission reads the head lock-free: the gateway role holds
          // no UPDATE privilege on policy heads, and the atomic counter upsert is
          // what serializes concurrent reservations on one lineage.
          const head = await selectKeyBudgetPolicyHead(tx, settleSeed.tenantId, settleSeed.projectId, settleSeed.keyId);
          assert.ok(head, 'the create/backfill head exists');
          assert.equal(head.lineageId, settleSeed.keyId);
          assert.deepEqual(
            [head.tokenDaily, head.tokenLifetime, head.chargeDaily, head.chargeLifetime],
            [null, null, null, null],
          );
          for (const [seed, units] of [
            [settleSeed, '15'],
            [releaseSeed, '10'],
          ] as const) {
            await reserveKeyBudgetCounters(tx, {
              tenantId: seed.tenantId,
              projectId: seed.projectId,
              lineageId: seed.keyId,
              requestId: seed.input.requestId,
              day: today,
              tokenUnits: units,
              chargeMinorUnits: '0',
              chargeCurrency: null,
            });
          }
        }),
      );
      const reserved = await phase('dispatch_observation', () =>
        gateway.database.transaction((tx) => selectKeyBudgetCounters(tx, settleSeed.tenantId, settleSeed.keyId, today)),
      );
      assert.deepEqual(reserved.daily, {
        tokenSettled: '0',
        tokenOutstandingReserved: '15',
        chargeSettled: '0',
        chargeOutstandingReserved: '0',
        chargeCurrency: null,
      });
      assert.equal(reserved.lifetime.tokenOutstandingReserved, '15');

      // Settlement moves the reservation to settled with the ACTUAL lower usage,
      // exactly once, on the original admission day.
      await phase('terminal_transition', () =>
        gateway.database.transaction(async (tx) => {
          assert.equal(
            await settleKeyBudgetReservation(tx, settleSeed.tenantId, settleSeed.input.requestId, '12', '0'),
            true,
          );
          assert.equal(
            await settleKeyBudgetReservation(tx, settleSeed.tenantId, settleSeed.input.requestId, '12', '0'),
            false,
            'settlement replay is a no-op',
          );
        }),
      );
      const settled = await phase('dispatch_observation', () =>
        gateway.database.transaction(async (tx) => ({
          counters: await selectKeyBudgetCounters(tx, settleSeed.tenantId, settleSeed.keyId, today),
          reservation: await selectKeyBudgetReservation(tx, settleSeed.tenantId, settleSeed.input.requestId),
        })),
      );
      assert.equal(settled.counters.daily.tokenSettled, '12');
      assert.equal(settled.counters.daily.tokenOutstandingReserved, '0');
      assert.equal(settled.counters.lifetime.tokenSettled, '12');
      assert.equal(settled.reservation?.state, 'settled');
      assert.equal(settled.reservation?.day, todayColumn);

      // Reservation facts and retention are guarded by the 081 triggers. The
      // probes run as the migrator (table owner): the runtime roles are denied
      // by privilege (42501, asserted in the ACL matrix) before a trigger could
      // fire, so only a privileged role can reach the trigger itself.
      await assertTriggerRejects(
        () =>
          migrator.database.transaction((tx) =>
            tx.query(
              `UPDATE saas_api_key_budget_reservations
             SET token_units = token_units + 1 WHERE tenant_id = $1 AND request_id = $2`,
              [settleSeed.tenantId, settleSeed.input.requestId],
            ),
          ),
        'immutable',
      );
      await assertTriggerRejects(
        () =>
          migrator.database.transaction((tx) =>
            tx.query('DELETE FROM saas_api_key_budget_reservations WHERE tenant_id = $1 AND request_id = $2', [
              settleSeed.tenantId,
              settleSeed.input.requestId,
            ]),
          ),
        'retained',
      );

      // Pre-dispatch release drops the outstanding reservation without usage.
      await phase('terminal_transition', () =>
        gateway.database.transaction(async (tx) => {
          assert.equal(await releaseKeyBudgetReservation(tx, releaseSeed.tenantId, releaseSeed.input.requestId), true);
          assert.equal(await releaseKeyBudgetReservation(tx, releaseSeed.tenantId, releaseSeed.input.requestId), false);
        }),
      );
      const released = await phase('dispatch_observation', () =>
        gateway.database.transaction(async (tx) => ({
          counters: await selectKeyBudgetCounters(tx, releaseSeed.tenantId, releaseSeed.keyId, today),
          reservation: await selectKeyBudgetReservation(tx, releaseSeed.tenantId, releaseSeed.input.requestId),
        })),
      );
      assert.deepEqual(released.counters.daily, {
        tokenSettled: '0',
        tokenOutstandingReserved: '0',
        chargeSettled: '0',
        chargeOutstandingReserved: '0',
        chargeCurrency: null,
      });
      assert.equal(released.counters.lifetime.tokenOutstandingReserved, '0');
      assert.equal(released.reservation?.state, 'released');

      // A settled correction adjusts the original day's settled counters.
      await phase('terminal_transition', () =>
        gateway.database.transaction(async (tx) => {
          assert.equal(
            await applyKeyBudgetCorrection(tx, settleSeed.tenantId, settleSeed.input.requestId, '5', '0'),
            true,
          );
        }),
      );
      const corrected = await phase('dispatch_observation', () =>
        gateway.database.transaction((tx) => selectKeyBudgetCounters(tx, settleSeed.tenantId, settleSeed.keyId, today)),
      );
      assert.equal(corrected.daily.tokenSettled, '17');
      assert.equal(corrected.daily.tokenOutstandingReserved, '0');
      assert.equal(corrected.lifetime.tokenSettled, '17');
      assert.equal(corrected.lifetime.tokenOutstandingReserved, '0');

      // A reservation admitted on a PREVIOUS UTC day settles into that original
      // day's window; the current day's counters never absorb stale usage.
      const yesterday = keyBudgetUtcDayFrom(new Date(Date.parse(today.startInclusive) - 86_400_000));
      const yesterdayColumn = yesterday.startInclusive.slice(0, 10);
      await phase('capacity_reserve', () =>
        gateway.database.transaction(async (tx) => {
          await reserveKeyBudgetCounters(tx, {
            tenantId: pastSeed.tenantId,
            projectId: pastSeed.projectId,
            lineageId: pastSeed.keyId,
            requestId: pastSeed.input.requestId,
            day: yesterday,
            tokenUnits: '7',
            chargeMinorUnits: '0',
            chargeCurrency: null,
          });
          assert.equal(
            await settleKeyBudgetReservation(tx, pastSeed.tenantId, pastSeed.input.requestId, '7', '0'),
            true,
          );
        }),
      );
      const afterPast = await phase('dispatch_observation', () =>
        gateway.database.transaction(async (tx) => ({
          today: await selectKeyBudgetCounters(tx, pastSeed.tenantId, pastSeed.keyId, today),
          past: await tx.query<{ token_settled: string; token_outstanding_reserved: string }>(
            `SELECT token_settled::text AS token_settled, token_outstanding_reserved::text AS token_outstanding_reserved
           FROM saas_api_key_budget_counters
           WHERE tenant_id = $1 AND lineage_id = $2 AND window_kind = 'daily' AND day = $3`,
            [pastSeed.tenantId, pastSeed.keyId, yesterdayColumn],
          ),
        })),
      );
      assert.equal(afterPast.today.daily.tokenSettled, '0', 'the current day never absorbs prior-day usage');
      assert.equal(afterPast.past.rows[0]?.token_settled, '7');
      assert.equal(afterPast.past.rows[0]?.token_outstanding_reserved, '0');
      assert.equal(afterPast.today.lifetime.tokenSettled, '7', 'the lifetime window spans every day');
      assert.equal(afterPast.today.lifetime.tokenOutstandingReserved, '0');
      assert.equal(KEY_BUDGET_LIFETIME_DAY, '0001-01-01');
    },
  );
});
