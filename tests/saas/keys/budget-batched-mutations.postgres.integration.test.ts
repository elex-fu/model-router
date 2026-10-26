import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import {
  createPostgresKeyBudgetAdmission,
  KeyBudgetAdmissionDeniedError,
} from '../../../src/saas/gateway/postgres-preparation-budget.js';
import {
  applyKeyBudgetCorrection,
  KEY_BUDGET_LIFETIME_DAY,
  type KeyBudgetReservationFacts,
  KeyBudgetStoreError,
  keyBudgetUtcDayFrom,
  releaseKeyBudgetReservation,
  reserveKeyBudgetCounters,
  selectKeyBudgetCounters,
  selectKeyBudgetReservation,
  settleKeyBudgetReservation,
} from '../../../src/saas/keys/budget-store.js';
import { alignPlatformPool, createAdmissionHarness } from '../gateway/admission-bench-fixture.js';
import {
  anyRoleConfigured,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

const skip = process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured;
const now = new Date('2026-10-26T23:59:59.999Z');
const day = keyBudgetUtcDayFrom(now);
const nextDay = keyBudgetUtcDayFrom(new Date('2026-10-27T00:00:00.000Z'));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function waitForLock(database: SaasDatabase, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await database.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted', [pid]);
    if (result.rows.length > 0) return;
    await delay(10);
  }
  assert.fail(`backend ${pid} never reached a PostgreSQL lock wait`);
}
async function storeError(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => error instanceof KeyBudgetStoreError && error.code === code);
}

// Real previous implementation, retained only as a mixed-version lock-order
// oracle. No schema/trigger/privilege changes or lock retries in this gate.
async function legacyReserve(tx: SqlExecutor, facts: KeyBudgetReservationFacts): Promise<void> {
  for (const [kind, date] of [
    ['daily', facts.day.startInclusive.slice(0, 10)],
    ['lifetime', KEY_BUDGET_LIFETIME_DAY],
  ]) {
    await tx.query(
      `INSERT INTO saas_api_key_budget_counters
      (tenant_id, project_id, lineage_id, window_kind, day, token_outstanding_reserved, charge_outstanding_reserved, charge_currency)
      VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8)
      ON CONFLICT (tenant_id,lineage_id,window_kind,day) DO UPDATE SET
      token_outstanding_reserved=saas_api_key_budget_counters.token_outstanding_reserved+EXCLUDED.token_outstanding_reserved,
      charge_outstanding_reserved=saas_api_key_budget_counters.charge_outstanding_reserved+EXCLUDED.charge_outstanding_reserved`,
      [
        facts.tenantId,
        facts.projectId,
        facts.lineageId,
        kind,
        date,
        facts.tokenUnits,
        facts.chargeMinorUnits,
        facts.chargeCurrency,
      ],
    );
  }
  await tx.query(
    `INSERT INTO saas_api_key_budget_reservations
    (tenant_id,project_id,lineage_id,request_id,day,token_units,charge_minor_units,charge_currency)
    VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8)`,
    [
      facts.tenantId,
      facts.projectId,
      facts.lineageId,
      facts.requestId,
      facts.day.startInclusive.slice(0, 10),
      facts.tokenUnits,
      facts.chargeMinorUnits,
      facts.chargeCurrency,
    ],
  );
}

async function legacyResolve(
  tx: SqlExecutor,
  tenantId: string,
  requestId: string,
  state: 'settled' | 'released',
): Promise<boolean> {
  const row = await selectKeyBudgetReservation(tx, tenantId, requestId, 'UPDATE');
  if (row?.state !== 'outstanding') return false;
  const actual = state === 'settled' ? '1' : '0';
  for (const [kind, date] of [
    ['daily', row.day],
    ['lifetime', KEY_BUDGET_LIFETIME_DAY],
  ]) {
    const result: { rowCount: number | null } = await tx.query(
      `UPDATE saas_api_key_budget_counters SET
      token_outstanding_reserved=token_outstanding_reserved-$5::bigint,
      charge_outstanding_reserved=charge_outstanding_reserved-$6::bigint,
      token_settled=token_settled+$7::bigint, charge_settled=charge_settled+$7::bigint
      WHERE tenant_id=$1 AND lineage_id=$2 AND window_kind=$3 AND day=$4
      AND token_outstanding_reserved >= $5::bigint AND charge_outstanding_reserved >= $6::bigint`,
      [row.tenantId, row.lineageId, kind, date, row.tokenUnits, row.chargeMinorUnits, actual],
    );
    assert.equal(result.rowCount, 1);
  }
  const result = await tx.query(
    `UPDATE saas_api_key_budget_reservations SET state=$3,
    settled_charge_minor_units=$4::bigint WHERE tenant_id=$1 AND request_id=$2 AND state='outstanding'`,
    [row.tenantId, row.requestId, state, state === 'settled' ? actual : null],
  );
  assert.equal(result.rowCount, 1);
  return true;
}

test('real PostgreSQL batched key budgets preserve caps, lock order and atomic financial evidence', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 8 });
  const control = createSaasDatabase({ connectionString: urls[1], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 8 });
  t.after(async () => {
    await Promise.all([migrator.close(), control.close(), gateway.close()]);
  });
  await migrator.verifySchema();
  const seed = await seedFixture(migrator, gateway, 'platform');
  await migrator.transaction((tx) =>
    seed.billing.postVerifiedFunding(tx, {
      tenantId: seed.tenantId,
      currency: 'USD',
      amountMinorUnits: '10000',
      sourceOrderRef: `budget-test-funding:${seed.tenantId}`,
      idempotencyKey: `budget-test-funding:${seed.tenantId}`,
    }),
  );
  await migrator.query(
    `INSERT INTO saas_api_key_budget_policies (tenant_id,project_id,key_id,lineage_id,version)
    VALUES ($1,$2,$3,$3,1)`,
    [seed.tenantId, seed.projectId, seed.keyId],
  );
  const pool = await alignPlatformPool(migrator, seed);
  const harness = await createAdmissionHarness(migrator, gateway, seed, 'platform', pool);
  const facts = (requestId: string, changes: Partial<KeyBudgetReservationFacts> = {}): KeyBudgetReservationFacts => ({
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    lineageId: seed.keyId,
    requestId,
    day,
    tokenUnits: '10',
    chargeMinorUnits: '10',
    chargeCurrency: 'USD',
    ...changes,
  });
  const request = async () => {
    const id = randomUUID();
    await gateway.transaction(async (tx) => {
      const result = await harness.admit(tx, id, randomUUID(), `budget-batch:${id}`);
      assert.equal(result.kind, 'created');
    });
    return id;
  };
  const snapshot = () =>
    gateway.transaction(async (tx) => ({
      counters: await selectKeyBudgetCounters(tx, seed.tenantId, seed.keyId, day),
      reservations: (
        await tx.query(
          `SELECT request_id, day::text, token_units::text, charge_minor_units::text, state
      FROM saas_api_key_budget_reservations WHERE tenant_id=$1 AND lineage_id=$2 ORDER BY request_id`,
          [seed.tenantId, seed.keyId],
        )
      ).rows,
    }));

  await t.test(
    'each finite daily/lifetime token/charge cap has one concurrent winner and clean denial rollback',
    async () => {
      for (const cap of ['token_daily', 'token_lifetime', 'charge_daily', 'charge_lifetime'] as const) {
        await migrator.query(
          `UPDATE saas_api_key_budget_policies SET version=version+1,
        token_daily=NULL,token_lifetime=NULL,charge_daily=NULL,charge_lifetime=NULL WHERE tenant_id=$1 AND key_id=$2`,
          [seed.tenantId, seed.keyId],
        );
        await migrator.query(
          `UPDATE saas_api_key_budget_policies SET version=version+1,${cap}=100 WHERE tenant_id=$1 AND key_id=$2`,
          [seed.tenantId, seed.keyId],
        );
        const ids = [await request(), await request()];
        const admission = createPostgresKeyBudgetAdmission({ now: () => now });
        const start = deferred();
        const races = ids.map((requestId) =>
          (async () => {
            await start.promise;
            try {
              await gateway.transaction((tx) =>
                admission.reserve(tx, {
                  tenantId: seed.tenantId,
                  projectId: seed.projectId,
                  keyId: seed.keyId,
                  requestId,
                  supplyMode: 'platform',
                  payloadBounds: { inputTotalUpperBound: '60', outputTotalUpperBound: '0' },
                  charge: { currency: 'USD', amountMinorUnits: '60' },
                }),
              );
              return true;
            } catch (error) {
              assert.ok(error instanceof KeyBudgetAdmissionDeniedError);
              return false;
            }
          })(),
        );
        start.resolve();
        const outcomes = await Promise.all(races);
        assert.equal(outcomes.filter(Boolean).length, 1, cap);
        const counters = (await snapshot()).counters;
        assert.equal(counters.daily.tokenOutstandingReserved, '60');
        assert.equal(counters.lifetime.chargeOutstandingReserved, '60');
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          assert.ok(id);
          assert.equal((await selectKeyBudgetReservation(gateway, seed.tenantId, id)) !== null, outcomes[i]);
          assert.equal(
            await gateway.transaction((tx) => releaseKeyBudgetReservation(tx, seed.tenantId, id)),
            outcomes[i],
          );
        }
      }
    },
  );

  await t.test('daily then lifetime row lock order is observable for reserve, settle and release', async () => {
    for (const operation of ['reserve', 'settle', 'release'] as const) {
      for (const blocked of ['daily', 'lifetime'] as const) {
        const id = await request();
        if (operation !== 'reserve') await gateway.transaction((tx) => reserveKeyBudgetCounters(tx, facts(id)));
        const held = deferred(),
          release = deferred();
        const blocker = gateway.transaction(async (tx) => {
          const result = await tx.query(
            `SELECT 1 FROM saas_api_key_budget_counters WHERE tenant_id=$1 AND lineage_id=$2 AND window_kind=$3 AND day=$4 FOR UPDATE`,
            [seed.tenantId, seed.keyId, blocked, blocked === 'daily' ? '2026-10-26' : KEY_BUDGET_LIFETIME_DAY],
          );
          assert.equal(result.rows.length, 1);
          held.resolve();
          await release.promise;
        });
        await held.promise;
        let pid = 0;
        const started = deferred();
        const work = gateway
          .transaction(async (tx) => {
            pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
            started.resolve();
            if (operation === 'reserve') await reserveKeyBudgetCounters(tx, facts(id));
            else if (operation === 'settle')
              assert.equal(await settleKeyBudgetReservation(tx, seed.tenantId, id, '0', '0'), true);
            else assert.equal(await releaseKeyBudgetReservation(tx, seed.tenantId, id), true);
          })
          .then(
            () => ({ error: undefined }),
            (error: unknown) => ({ error }),
          );
        try {
          await started.promise;
          await waitForLock(migrator, pid);
          const other = blocked === 'daily' ? 'lifetime' : 'daily';
          const probe = () =>
            gateway.transaction((tx) =>
              tx.query(
                `SELECT 1 FROM saas_api_key_budget_counters
            WHERE tenant_id=$1 AND lineage_id=$2 AND window_kind=$3 AND day=$4 FOR UPDATE NOWAIT`,
                [seed.tenantId, seed.keyId, other, other === 'daily' ? '2026-10-26' : KEY_BUDGET_LIFETIME_DAY],
              ),
            );
          if (blocked === 'daily')
            assert.equal((await probe()).rows.length, 1, 'lifetime is not locked ahead of daily');
          else await assert.rejects(probe, (error: unknown) => (error as { code?: string }).code === '55P03');
        } finally {
          release.resolve();
          await blocker;
        }
        const outcome = await work;
        if (outcome.error) throw outcome.error;
        if (operation === 'reserve')
          await gateway.transaction((tx) => releaseKeyBudgetReservation(tx, seed.tenantId, id));
      }
    }
  });

  await t.test(
    'same-lineage legacy/new operations across midnight finish without deadlock and retain original days',
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) ids.push(await request());
      await Promise.all(
        ids.map((id, i) =>
          gateway.transaction(async (tx) => {
            if (i % 2 === 0) await legacyReserve(tx, facts(id, { day: i % 4 < 2 ? day : nextDay }));
            else await reserveKeyBudgetCounters(tx, facts(id, { day: i % 4 < 2 ? day : nextDay }));
          }),
        ),
      );
      await Promise.all(
        ids.map((id, i) =>
          gateway.transaction((tx) =>
            i % 4 < 2
              ? legacyResolve(tx, seed.tenantId, id, i % 2 === 0 ? 'settled' : 'released')
              : i % 2 === 0
                ? settleKeyBudgetReservation(tx, seed.tenantId, id, '1', '1')
                : releaseKeyBudgetReservation(tx, seed.tenantId, id),
          ),
        ),
      );
      const original = await selectKeyBudgetCounters(gateway, seed.tenantId, seed.keyId, day);
      const next = await selectKeyBudgetCounters(gateway, seed.tenantId, seed.keyId, nextDay);
      assert.equal(original.daily.tokenSettled, '2');
      assert.equal(next.daily.tokenSettled, '2');
      assert.equal(next.lifetime.tokenSettled, '4');
      assert.equal(next.lifetime.tokenOutstandingReserved, '0');
    },
  );

  await t.test(
    'duplicate, currency, negative, partial-counter and terminal failures roll back every mutation',
    async () => {
      const id = await request();
      await gateway.transaction((tx) => reserveKeyBudgetCounters(tx, facts(id)));
      const before = await snapshot();
      await assert.rejects(
        gateway.transaction((tx) => reserveKeyBudgetCounters(tx, facts(id))),
        (error: unknown) => (error as { code?: string }).code === '23505',
      );
      await storeError(
        () => gateway.transaction((tx) => reserveKeyBudgetCounters(tx, facts(id, { chargeCurrency: 'EUR' }))),
        'CURRENCY_MISMATCH',
      );
      await storeError(
        () => gateway.transaction((tx) => reserveKeyBudgetCounters(tx, facts(id, { tokenUnits: '-1' }))),
        'INVALID_INPUT',
      );
      assert.deepEqual(await snapshot(), before);
      for (const kind of ['daily', 'lifetime'] as const) {
        const date = kind === 'daily' ? '2026-10-26' : KEY_BUDGET_LIFETIME_DAY;
        await storeError(
          () =>
            migrator.transaction(async (tx) => {
              await tx.query(
                'DELETE FROM saas_api_key_budget_counters WHERE tenant_id=$1 AND lineage_id=$2 AND window_kind=$3 AND day=$4',
                [seed.tenantId, seed.keyId, kind, date],
              );
              await settleKeyBudgetReservation(tx, seed.tenantId, id, '5', '5');
            }),
          'STORAGE_ERROR',
        );
        assert.deepEqual(await snapshot(), before, `${kind} missing: earlier writes must roll back`);
        await storeError(
          () =>
            migrator.transaction(async (tx) => {
              await tx.query(
                'UPDATE saas_api_key_budget_counters SET token_outstanding_reserved=0 WHERE tenant_id=$1 AND lineage_id=$2 AND window_kind=$3 AND day=$4',
                [seed.tenantId, seed.keyId, kind, date],
              );
              await settleKeyBudgetReservation(tx, seed.tenantId, id, '5', '5');
            }),
          'STORAGE_ERROR',
        );
        assert.deepEqual(await snapshot(), before, `${kind} insufficient: never negative`);
      }
      await storeError(
        () =>
          gateway.transaction(async (tx) => {
            const wrapped: SqlExecutor = {
              async query<Row>(sql: string, values?: readonly unknown[]) {
                const result = await tx.query<Row>(sql, values);
                if (sql.startsWith('SELECT tenant_id, project_id, lineage_id, request_id')) {
                  await tx.query(
                    "UPDATE saas_api_key_budget_reservations SET state='released' WHERE tenant_id=$1 AND request_id=$2",
                    [seed.tenantId, id],
                  );
                }
                return result;
              },
            };
            await settleKeyBudgetReservation(wrapped, seed.tenantId, id, '5', '5');
          }),
        'RESERVATION_STATE_CONFLICT',
      );
      assert.deepEqual(await snapshot(), before, 'zero terminal rows roll back both counter updates');
      await gateway.transaction((tx) => releaseKeyBudgetReservation(tx, seed.tenantId, id));
    },
  );

  await t.test('bigint maximum is exact and arithmetic overflow rolls back the whole statement', async () => {
    const id = await request(),
      overflowId = await request();
    const maximum = '9223372036854775807';
    const result = await gateway.transaction((tx) =>
      reserveKeyBudgetCounters(
        tx,
        facts(id, {
          tokenUnits: maximum,
          chargeMinorUnits: maximum,
        }),
      ),
    );
    assert.equal(result.daily.outstandingReserved, maximum);
    assert.equal(result.lifetime.charge.outstandingReserved, maximum);
    const before = await snapshot();
    const overflow = (error: unknown) => (error as { code?: string }).code === '22003';
    await assert.rejects(
      gateway.transaction((tx) =>
        reserveKeyBudgetCounters(
          tx,
          facts(overflowId, {
            tokenUnits: '1',
            chargeMinorUnits: '1',
          }),
        ),
      ),
      overflow,
    );
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(
      gateway.transaction((tx) => settleKeyBudgetReservation(tx, seed.tenantId, id, maximum, maximum)),
      overflow,
    );
    assert.deepEqual(await snapshot(), before);
    assert.equal(await gateway.transaction((tx) => releaseKeyBudgetReservation(tx, seed.tenantId, id)), true);
  });

  await t.test(
    'bigint exactness, concurrent replay and restricted control-plane correction/release survive batching',
    async () => {
      const id = await request(),
        big = '9007199254740993';
      await gateway.transaction((tx) =>
        reserveKeyBudgetCounters(tx, facts(id, { tokenUnits: big, chargeMinorUnits: big })),
      );
      const reserved = await selectKeyBudgetCounters(gateway, seed.tenantId, seed.keyId, day);
      assert.equal(reserved.daily.tokenOutstandingReserved, big);
      assert.equal(reserved.lifetime.chargeOutstandingReserved, big);
      const outcomes = await Promise.all(
        [0, 1, 2].map(() => gateway.transaction((tx) => settleKeyBudgetReservation(tx, seed.tenantId, id, big, big))),
      );
      assert.equal(outcomes.filter(Boolean).length, 1);
      assert.equal(await control.transaction((tx) => applyKeyBudgetCorrection(tx, seed.tenantId, id, '1', '1')), true);
      const settled = await selectKeyBudgetCounters(gateway, seed.tenantId, seed.keyId, day);
      assert.equal(settled.daily.tokenSettled, (BigInt(big) + 3n).toString());
      assert.equal(settled.lifetime.chargeSettled, (BigInt(big) + 5n).toString());
      assert.equal(settled.daily.tokenOutstandingReserved, '0');
      const releaseId = await request();
      await gateway.transaction((tx) => reserveKeyBudgetCounters(tx, facts(releaseId)));
      const releases = await Promise.all(
        [0, 1].map(() => control.transaction((tx) => releaseKeyBudgetReservation(tx, seed.tenantId, releaseId))),
      );
      assert.equal(releases.filter(Boolean).length, 1);
      assert.equal(
        await settleKeyBudgetReservation(gateway, seed.tenantId, id, '-1', '-1'),
        false,
        'resolved replay preserves old validation order',
      );
    },
  );
});
