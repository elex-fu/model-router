import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresQuotaStatePersistence } from '../../../src/quota/postgres-state.js';
import { createSaasDatabase } from '../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresCapacityStatePersistence } from '../../../src/saas/gateway/redis-preparation-capacity.js';
import {
  DurableConditionalSettlementPort,
  DurableNormalSuccessSettlementPort,
} from '../../../src/saas/metering/conditional-settlement-port.js';
import { SaasMeteringService } from '../../../src/saas/metering/service.js';
import type { ConditionalSettlementInput } from '../../../src/saas/metering/unknown-outcome-reconciliation-service.js';
import {
  anyRoleConfigured,
  type Fixture,
  observedUsage,
  REQUIRED_FLAG,
  roleUrls,
  safeCodes,
  seedFixture,
} from './normal-success-postgres-fixture.js';

function adapt(database: SaasDatabase, overrides: Partial<SaasDatabase>): SaasDatabase {
  return {
    query: database.query.bind(database),
    transaction: database.transaction.bind(database),
    migrate: database.migrate.bind(database),
    verifySchema: database.verifySchema.bind(database),
    ping: database.ping.bind(database),
    close: database.close.bind(database),
    ...overrides,
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Seed the normal production Redis-receipt path, not a deleted PG reservation. */
async function redisFixture(migrator: SaasDatabase, gateway: SaasDatabase, resultHttpStatus = 200) {
  const namespace = `projection-lock-${randomUUID()}`;
  const persistence = new PostgresQuotaStatePersistence(gateway, namespace);
  await persistence.identity();
  const generation = await persistence.beginGeneration(0);
  let intercepted = 0;
  const fixtureGateway = adapt(gateway, {
    transaction: (work) =>
      gateway.transaction((tx) =>
        work({
          query: (sql, values = []) => {
            // Observe the intended HTTP outcome on the first response. Migration
            // 010 correctly prevents changing an already-observed 200 into a 503.
            const observed =
              sql.includes('SET dispatch_state = $4') && values[7] === 200
                ? values.map((value, index) => (index === 7 ? resultHttpStatus : value))
                : values;
            return tx.query(sql, observed);
          },
        }),
      ),
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (!sql.includes('INSERT INTO saas_gateway_capacity_reservations')) return gateway.query<Row>(sql, values);
      intercepted++;
      const [
        tenantId,
        projectId,
        proxyKeyId,
        requestId,
        attemptId,
        supplyMode,
        projectPolicyVersion,
        keyAuthzVersion,
        idempotencyScopeKey,
        requestFingerprint,
        requestFingerprintVersion,
        tokenUnits,
        quotaReservationId,
        rateReservationId,
      ] = values;
      // Migration 138 permits this only before dispatch and preserves immutable
      // receipt/authority guards. The actual projection has not happened yet.
      await gateway.query(
        `UPDATE saas_requests SET capacity_backend='redis',
        redis_quota_reservation_id=$3, redis_rate_reservation_id=$4,
        state_version=state_version+1, updated_at=GREATEST(updated_at,clock_timestamp())
        WHERE tenant_id=$1 AND id=$2`,
        [tenantId, requestId, quotaReservationId, rateReservationId],
      );
      const now = Date.now();
      await persistence.apply([
        {
          generation,
          rows: [
            {
              key: JSON.stringify(['capacityRequest', requestId]),
              version: 1,
              value: {
                kind: 'capacityRequest',
                tenantId,
                projectId,
                proxyKeyId,
                requestId,
                attemptId,
                supplyMode,
                projectPolicyVersion: String(projectPolicyVersion),
                keyAuthzVersion: String(keyAuthzVersion),
                idempotencyScopeKey,
                requestFingerprint,
                requestFingerprintVersion,
                tokenUnits,
                quotaReservationId,
                rateReservationId,
                state: 'active',
                admittedAtMs: now,
                deadlineMs: now + 600_000,
                scopes: [],
              },
            },
          ],
        },
      ]);
      return { rows: [] as Row[], rowCount: 1 };
    },
  });
  const fixture = await seedFixture(migrator, fixtureGateway, 'platform');
  assert.equal(intercepted, 1);
  assert.equal(
    (
      await gateway.query('SELECT request_id FROM saas_gateway_capacity_reservations WHERE tenant_id=$1', [
        fixture.tenantId,
      ])
    ).rowCount,
    0,
  );
  return { fixture, namespace };
}

/**
 * Exactly two concurrent transactions. Split the REAL deferred FK checks at
 * their natural request->attempt boundary; split the REAL joined settlement
 * lock after its first attempt lock. No timers decide the interleaving, no
 * constraints/triggers are disabled, and no simplified substitute FK exists.
 */
async function raceProjection<T>(
  gateway: SaasDatabase,
  fixture: Fixture,
  namespace: string,
  work: (database: SaasDatabase) => Promise<T>,
  oldLock = false,
) {
  const requestHeld = barrier(),
    attemptHeld = barrier(),
    continueSettlement = barrier();
  let intercepted = 0;
  const projection = gateway.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout='8s'");
    const db = adapt(gateway, {
      query: tx.query.bind(tx),
      ping: async () => {
        await tx.query('SELECT 1');
      },
    });
    await new PostgresCapacityStatePersistence(db, namespace).ping();
    await tx.query('SET CONSTRAINTS saas_gateway_capacity_reservations_request_fk IMMEDIATE');
    requestHeld.release();
    await attemptHeld.promise;
    const attemptFk = tx.query('SET CONSTRAINTS saas_gateway_capacity_reservations_attempt_fk IMMEDIATE');
    continueSettlement.release();
    await attemptFk;
  });
  // Attach rejection handlers immediately, including during barrier setup.
  const projectionResult = projection.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason) => {
      requestHeld.release();
      continueSettlement.release();
      return { status: 'rejected' as const, reason };
    },
  );
  await requestHeld.promise;
  const database = adapt(gateway, {
    transaction: (workInTransaction) =>
      gateway.transaction(async (tx) => {
        await tx.query("SET LOCAL lock_timeout='8s'");
        const hooked: SqlExecutor = {
          async query<Row>(sql: string, values: readonly unknown[] = []) {
            const match = /FOR (NO KEY UPDATE|UPDATE) OF a, r/.exec(sql);
            if (match && intercepted++ === 0) {
              const mode = oldLock ? 'UPDATE' : match[1];
              await tx.query(
                `SELECT id FROM saas_attempts WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR ${mode}`,
                [fixture.tenantId, fixture.input.requestId, fixture.input.attemptId],
              );
              attemptHeld.release();
              await continueSettlement.promise;
              if (oldLock) sql = sql.replace('FOR NO KEY UPDATE OF a, r', 'FOR UPDATE OF a, r');
            }
            return tx.query<Row>(sql, values);
          },
        };
        return workInTransaction(hooked);
      }),
  });
  const settlement = work(database).finally(() => attemptHeld.release());
  const settlementResult = settlement.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason) => ({ status: 'rejected' as const, reason }),
  );
  const results = await Promise.all([projectionResult, settlementResult]);
  assert.equal(intercepted, 1, 'the production joined lock must run exactly once');
  return results;
}

async function financialSnapshot(migrator: SqlExecutor, fixture: Fixture) {
  const {
    rows: [row],
  } = await migrator.query<{
    usage: string;
    settlements: string;
    charges: string;
    balance: string;
    ledger: string;
    held: string;
    unbalanced: string;
    holdState: string;
  }>(
    `SELECT
    (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id=$1) AS usage,
    (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id=$1) AS settlements,
    (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1 AND source_type='billing_settlement') AS charges,
    (SELECT posted_balance_minor_units::text FROM saas_wallets WHERE tenant_id=$1) AS balance,
    (SELECT sum(CASE WHEN direction='credit' THEN amount_minor_units ELSE -amount_minor_units END)::text
      FROM saas_ledger_entries WHERE tenant_id=$1 AND wallet_id IS NOT NULL) AS ledger,
    (SELECT COALESCE(sum(amount_minor_units),0)::text FROM saas_billing_reservations
      WHERE tenant_id=$1 AND state IN ('reserved','reconciliation_pending')) AS held,
    (SELECT state FROM saas_billing_reservations WHERE tenant_id=$1) AS "holdState",
    (SELECT count(*)::text FROM (SELECT transaction_id FROM saas_ledger_entries WHERE tenant_id=$1
      GROUP BY transaction_id HAVING count(*)<>2 OR sum(CASE WHEN direction='credit'
        THEN amount_minor_units ELSE -amount_minor_units END)<>0) bad) AS unbalanced`,
    [fixture.tenantId],
  );
  assert.ok(row);
  assert.equal(row.balance, row.ledger);
  assert.equal(row.unbalanced, '0');
  return row;
}

function successPort(database: SaasDatabase, fixture: Fixture) {
  return new DurableNormalSuccessSettlementPort(database, { metering: fixture.metering, billing: fixture.billing });
}

test('settlement locks coexist with real deferred Redis projection FKs and still serialize writers', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and disposable role URLs`
      : false,
  timeout: 180_000,
}, async (t) => {
  const [migratorUrl, , gatewayUrl] = roleUrls();
  const migrator = createSaasDatabase({ connectionString: migratorUrl, max: 1 });
  const gateway = createSaasDatabase({ connectionString: gatewayUrl, max: 4 });
  t.after(async () => {
    await Promise.all([gateway.close(), migrator.close()]);
  });
  await gateway.verifySchema();

  await t.test('negative control: old FOR UPDATE deterministically deadlocks (40P01)', async () => {
    const { fixture, namespace } = await redisFixture(migrator, gateway);
    const results = await raceProjection(
      gateway,
      fixture,
      namespace,
      (db) => successPort(db, fixture).complete(fixture.input),
      true,
    );
    assert.ok(
      results.some((result) => result.status === 'rejected' && safeCodes(result.reason).sqlState === '40P01'),
      'the controlled interleaving must reproduce the observed PostgreSQL deadlock, not a lock timeout',
    );
  });

  await t.test(
    'normal success: projection commits, concurrent retries charge exactly once and leave no billing hold',
    async () => {
      const { fixture, namespace } = await redisFixture(migrator, gateway);
      const results = await raceProjection(gateway, fixture, namespace, (db) =>
        successPort(db, fixture).complete(fixture.input),
      );
      for (const result of results)
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      const port = successPort(gateway, fixture);
      assert.deepEqual(
        (await Promise.all(Array.from({ length: 8 }, () => port.complete(fixture.input)))).map((row) => row.kind),
        Array(8).fill('replayed'),
      );
      const snapshot = await financialSnapshot(migrator, fixture);
      assert.deepEqual(snapshot, {
        usage: '1',
        settlements: '1',
        charges: '1',
        balance: '88',
        ledger: '88',
        held: '0',
        holdState: 'settled',
        unbalanced: '0',
      });
      await assert.rejects(() => port.complete({ ...fixture.input, chargeAmountMinorUnits: '13' }));
      assert.deepEqual(await financialSnapshot(migrator, fixture), snapshot);
      assert.equal(
        (
          await gateway.query<{ projection_pending: boolean }>(
            'SELECT projection_pending FROM saas_redis_quota_state WHERE namespace=$1',
            [namespace],
          )
        ).rows[0]?.projection_pending,
        false,
      );
    },
  );

  await t.test(
    'retainUnknown: projection commits and uncertain cancellation retains, never charges or releases, the hold',
    async () => {
      const { fixture, namespace } = await redisFixture(migrator, gateway);
      const input = { ...fixture.input, reason: 'dispatch_uncertain' as const };
      const results = await raceProjection(gateway, fixture, namespace, (db) =>
        successPort(db, fixture).retainUnknown(input),
      );
      for (const result of results)
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      const again = await successPort(gateway, fixture).retainUnknown(input);
      assert.equal(again.resultState, 'unknown');
      const snapshot = await financialSnapshot(migrator, fixture);
      assert.equal(snapshot.held, '50');
      assert.equal(snapshot.holdState, 'reconciliation_pending');
      assert.equal(snapshot.charges, '0');
      assert.equal(snapshot.balance, '100');
    },
  );

  await t.test(
    'known HTTP failure: projection commits, replay preserves reconciliation hold without a charge',
    async () => {
      const { fixture, namespace } = await redisFixture(migrator, gateway, 503);
      const input = { ...fixture.input, resultHttpStatus: 503 };
      const results = await raceProjection(gateway, fixture, namespace, (db) =>
        new SaasMeteringService(db).recordKnownNonSuccessHttpResponse(input),
      );
      for (const result of results)
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      assert.equal((await fixture.metering.recordKnownNonSuccessHttpResponse(input)).resultState, 'failed');
      const snapshot = await financialSnapshot(migrator, fixture);
      assert.equal(snapshot.held, '50');
      assert.equal(snapshot.holdState, 'reconciliation_pending');
      assert.equal(snapshot.charges, '0');
    },
  );

  await t.test('competing first completions serialize to one charge and seven replays', async () => {
    const { fixture, namespace } = await redisFixture(migrator, gateway);
    await new PostgresCapacityStatePersistence(gateway, namespace).ping();
    const port = successPort(gateway, fixture);
    const results = await Promise.all(Array.from({ length: 8 }, () => port.complete(fixture.input)));
    assert.equal(results.filter((result) => result.kind === 'settled').length, 1);
    assert.equal(results.filter((result) => result.kind === 'replayed').length, 7);
    const snapshot = await financialSnapshot(migrator, fixture);
    assert.equal(snapshot.usage, '1');
    assert.equal(snapshot.settlements, '1');
    assert.equal(snapshot.charges, '1');
    assert.equal(snapshot.held, '0');
    assert.equal(snapshot.balance, '88');
  });

  await t.test('conditional reconciliation: stale CAS stays fail-closed while projection commits', async () => {
    const { fixture, namespace } = await redisFixture(migrator, gateway);
    const attempt = await successPort(gateway, fixture).retainUnknown({
      ...fixture.input,
      reason: 'dispatch_uncertain',
    });
    const request = await fixture.metering.getRequest(fixture.tenantId, fixture.input.requestId);
    assert.ok(request);
    assert.ok(fixture.input.priceSnapshotRef);
    const input: ConditionalSettlementInput = {
      tenantId: fixture.tenantId,
      requestId: fixture.input.requestId,
      attemptId: fixture.input.attemptId,
      idempotencyKey: fixture.input.settlementKey,
      providerOperationId: `projection-reconciled-${randomUUID()}`,
      usage: observedUsage(),
      charge: {
        amountMinorUnits: '12',
        currency: 'USD',
        rateCardId: fixture.input.priceSnapshotRef,
        rateCardVersion: '1',
      },
      expectedState: { attempt: { ...attempt, stateVersion: attempt.stateVersion - 1 }, request },
    };
    const port = (db: SaasDatabase) =>
      new DurableConditionalSettlementPort(db, { metering: fixture.metering, billing: fixture.billing });
    const before = await financialSnapshot(migrator, fixture);
    const results = await raceProjection(gateway, fixture, namespace, (db) => port(db).submit(input));
    for (const result of results)
      assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
    assert.equal(results[1].status === 'fulfilled' && results[1].value.status, 'conflict');
    assert.equal((await port(gateway).submit(input)).status, 'conflict');
    assert.deepEqual(await financialSnapshot(migrator, fixture), before);
  });

  await t.test(
    'conditional reconciliation accepts native PG integer versions and settles/replays exactly once',
    async () => {
      const { fixture, namespace } = await redisFixture(migrator, gateway);
      const attempt = await successPort(gateway, fixture).retainUnknown({
        ...fixture.input,
        reason: 'dispatch_uncertain',
      });
      const request = await fixture.metering.getRequest(fixture.tenantId, fixture.input.requestId);
      assert.ok(request);
      assert.ok(fixture.input.priceSnapshotRef);
      // These are native int4 columns. Do not add a parser or test adapter that
      // stringifies them: the original decoder incorrectly rejected real rows.
      const native = (
        await gateway.query<{ credential_version: number; route_public_model_version: number }>(
          'SELECT credential_version, route_public_model_version FROM saas_attempts WHERE tenant_id=$1 AND id=$2',
          [fixture.tenantId, fixture.input.attemptId],
        )
      ).rows[0];
      assert.equal(typeof native?.credential_version, 'number');
      assert.equal(typeof native?.route_public_model_version, 'number');
      const input: ConditionalSettlementInput = {
        tenantId: fixture.tenantId,
        requestId: fixture.input.requestId,
        attemptId: fixture.input.attemptId,
        idempotencyKey: fixture.input.settlementKey,
        providerOperationId: `projection-reconciled-${randomUUID()}`,
        usage: observedUsage(),
        charge: {
          amountMinorUnits: '12',
          currency: 'USD',
          rateCardId: fixture.input.priceSnapshotRef,
          rateCardVersion: '1',
        },
        expectedState: { attempt, request },
      };
      const port = (db: SaasDatabase) =>
        new DurableConditionalSettlementPort(db, { metering: fixture.metering, billing: fixture.billing });
      const results = await raceProjection(gateway, fixture, namespace, (db) => port(db).submit(input));
      for (const result of results)
        assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : '');
      assert.equal(results[1].status === 'fulfilled' && results[1].value.status, 'settled');
      const replays = await Promise.all(Array.from({ length: 8 }, () => port(gateway).submit(input)));
      assert.ok(replays.every((result) => result.status === 'replayed'));
      const snapshot = await financialSnapshot(migrator, fixture);
      assert.deepEqual(snapshot, {
        usage: '1',
        settlements: '1',
        charges: '1',
        balance: '88',
        ledger: '88',
        held: '0',
        holdState: 'settled',
        unbalanced: '0',
      });
      assert.equal(
        (await port(gateway).submit({ ...input, charge: { ...input.charge, amountMinorUnits: '13' } })).status,
        'conflict',
      );
      await assert.rejects(() =>
        successPort(gateway, fixture).retainUnknown({ ...fixture.input, reason: 'settlement_failed' }),
      );
      assert.deepEqual(await financialSnapshot(migrator, fixture), snapshot);
    },
  );
});
