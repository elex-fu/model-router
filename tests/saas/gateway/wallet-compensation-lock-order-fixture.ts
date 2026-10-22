import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SaasBillingError } from '../../../src/saas/billing/errors.js';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../../../src/saas/db/advisory-lock-keys.js';
import type { SaasDatabase, SqlExecutor } from '../../../src/saas/db/types.js';
import { PostgresPreDispatchCompensation } from '../../../src/saas/gateway/postgres-pre-dispatch-compensation.js';
import { createPostgresPreparationCapacityPort } from '../../../src/saas/gateway/postgres-preparation-capacity.js';
import { GatewayPreDispatchCompensationService } from '../../../src/saas/gateway/pre-dispatch-compensation-service.js';
import { DurableNormalSuccessSettlementPort } from '../../../src/saas/metering/conditional-settlement-port.js';
import { seedFixture } from '../metering/normal-success-postgres-fixture.js';
import {
  cancellationFixture,
  cancellationSnapshot,
  cancellationSqlState,
  cancellationTransaction,
} from './pre-dispatch-postgres-fixture.js';

// This exact source-selection adapter is test-only. All clone INSERTs, holds,
// signing, registration and idempotency still execute in the original helper.
export const WALLET_COMPENSATION_LEGACY_SOURCE_SQL = `SELECT e.* FROM saas_prepared_request_evidence e JOIN saas_requests r
      ON r.tenant_id = e.tenant_id AND r.id = e.request_id JOIN saas_projects p
      ON p.tenant_id = r.tenant_id AND p.id = r.project_id
     WHERE p.slug LIKE 'gateway-e2e-project-%' AND e.account_id LIKE 'gateway-e2e-%'
       AND e.credential_id LIKE 'gateway-e2e-%' AND e.supply_mode = $1 AND e.status = 'claimed'
       AND r.execution_state = 'succeeded' ORDER BY e.created_at DESC LIMIT 1`;
export const WALLET_COMPENSATION_PINNED_SOURCE_SQL = `SELECT e.* FROM saas_prepared_request_evidence e
     WHERE e.tenant_id = $1 AND e.request_id = $2 AND e.id = $3`;
const COMPENSATION_WALLET_ROW_SQL = 'SELECT id FROM saas_wallets WHERE tenant_id = $1 AND currency = $2 FOR UPDATE';
const LEDGER_ENTRY_SQL = `INSERT INTO saas_ledger_entries
          (id, transaction_id, tenant_id, currency, direction, amount_minor_units,
           account_type, account_ref, wallet_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
const WALLET_PROJECTION_SQL = `UPDATE saas_wallets
       SET posted_balance_minor_units = posted_balance_minor_units + $4, updated_at = $5
       WHERE id = $1 AND tenant_id = $2 AND currency = $3
         AND posted_balance_minor_units + $4 >= 0
       RETURNING id, tenant_id, currency, posted_balance_minor_units, created_at, updated_at`;

function mappedDatabase(
  database: SaasDatabase,
  query: SqlExecutor['query'],
  transaction = database.transaction.bind(database),
) {
  return {
    query,
    transaction,
    migrate: () => database.migrate(),
    verifySchema: () => database.verifySchema(),
    ping: () => database.ping(),
    close: () => database.close(),
  } satisfies SaasDatabase;
}

async function walletFixture(migrator: SaasDatabase, gateway: SaasDatabase) {
  const settlement = await seedFixture(migrator, gateway, 'platform');
  const evidenceId = settlement.sent.preparedEvidenceId;
  assert.ok(evidenceId, 'real claimed evidence identity from the FIN057 fixture is required');
  assert.equal(settlement.input.chargeAmountMinorUnits, '12');
  let selections = 0;
  const source = mappedDatabase(migrator, async <Row>(sql: string, values?: readonly unknown[]) => {
    if (selections === 0) {
      assert.equal(
        sql,
        WALLET_COMPENSATION_LEGACY_SOURCE_SQL,
        'the first helper read must retain its exact source SQL',
      );
    }
    if (sql !== WALLET_COMPENSATION_LEGACY_SOURCE_SQL) return migrator.query<Row>(sql, values);
    assert.deepEqual(values, ['platform'], 'only the original fixed source query and its platform binding may change');
    assert.equal(++selections, 1, 'the original helper must select its source exactly once');
    const selected = await migrator.query<Row>(WALLET_COMPENSATION_PINNED_SOURCE_SQL, [
      settlement.tenantId,
      settlement.input.requestId,
      evidenceId,
    ]);
    assert.equal(selected.rows.length, 1, 'the real A identity must select exactly one original evidence row');
    const row: unknown = selected.rows[0];
    assert.ok(row && typeof row === 'object');
    const expected = {
      id: evidenceId,
      tenant_id: settlement.tenantId,
      request_id: settlement.input.requestId,
      attempt_id: settlement.input.attemptId,
      project_id: settlement.projectId,
      proxy_key_id: settlement.keyId,
      account_id: settlement.sent.accountId,
      credential_id: settlement.sent.credentialId,
      provider_id: settlement.sent.providerId,
      product_id: settlement.sent.productId,
      supply_mode: 'platform',
      status: 'claimed',
    };
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(key in row, 'the original evidence projection must retain each expected identity field');
      assert.equal(Reflect.get(row, key), value, `pinned fixture ${key} must match A`);
    }
    return selected;
  });
  const cancellation = await cancellationFixture(source, gateway, 'platform');
  assert.equal(selections, 1, 'an unrecognized or unused source adapter must fail closed');
  assert.equal(cancellation.tenantId, settlement.tenantId);
  assert.notEqual(cancellation.requestId, settlement.input.requestId);
  const wallets = await migrator.query<{ id: string; currency: string }>(
    'SELECT id, currency FROM saas_wallets WHERE tenant_id = $1',
    [settlement.tenantId],
  );
  assert.equal(wallets.rows.length, 1);
  const wallet = wallets.rows[0];
  assert.ok(wallet);
  assert.equal(wallet.currency, 'USD');
  return { settlement, cancellation, walletId: wallet.id };
}
type WalletFixture = Awaited<ReturnType<typeof walletFixture>>;

function signal<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('signal was not initialized');
  };
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function compensationPort(fixture: WalletFixture) {
  return new PostgresPreDispatchCompensation({
    capacity: createPostgresPreparationCapacityPort(),
    billing: fixture.cancellation.billing,
  });
}
function compensationInput(fixture: WalletFixture) {
  return {
    prepared: fixture.cancellation.prepared,
    cause: 'client_cancelled',
    responseMayHaveStarted: false,
  } as const;
}
function compensationLocal(snapshot: Awaited<ReturnType<typeof cancellationSnapshot>>) {
  const { wallets: _wallets, settlements: _settlements, ...local } = snapshot;
  return local;
}

async function financialSnapshot(migrator: SqlExecutor, fixture: WalletFixture) {
  const result = await migrator.query<Record<string, string>>(
    `SELECT
      (SELECT count(*)::text FROM saas_wallets WHERE tenant_id = $1) AS wallets,
      (SELECT sum(posted_balance_minor_units)::text FROM saas_wallets WHERE tenant_id = $1) AS balance,
      (SELECT sum(CASE WHEN direction = 'credit' THEN amount_minor_units ELSE -amount_minor_units END)::text
         FROM saas_ledger_entries WHERE tenant_id = $1 AND wallet_id IS NOT NULL) AS wallet_ledger,
      (SELECT count(*)::text FROM saas_usage_events WHERE tenant_id = $1) AS usage,
      (SELECT count(*)::text FROM saas_usage_settlements WHERE tenant_id = $1) AS settlements,
      (SELECT count(*)::text FROM saas_ledger_transactions
        WHERE tenant_id = $1 AND source_type = 'billing_settlement') AS billing_transactions,
      (SELECT count(*)::text FROM saas_ledger_entries WHERE tenant_id = $1) AS entries,
      (SELECT COALESCE(sum(amount_minor_units), 0)::text FROM saas_billing_reservations
        WHERE tenant_id = $1 AND state IN ('reserved', 'reconciliation_pending')) AS active_hold,
      (SELECT count(*)::text FROM (
        SELECT l.id FROM saas_ledger_transactions l LEFT JOIN saas_ledger_entries e ON e.transaction_id = l.id
        WHERE l.tenant_id = $1 GROUP BY l.id, l.amount_minor_units
        HAVING count(e.id) <> 2 OR
          COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'credit'), 0) <> l.amount_minor_units OR
          COALESCE(sum(e.amount_minor_units) FILTER (WHERE e.direction = 'debit'), 0) <> l.amount_minor_units
      ) invalid) AS unbalanced,
      (SELECT state FROM saas_billing_reservations WHERE tenant_id = $1 AND request_id = $2::text) AS a_hold,
      (SELECT execution_state FROM saas_requests WHERE tenant_id = $1 AND id = $2::uuid) AS a_request,
      (SELECT financial_status FROM saas_requests WHERE tenant_id = $1 AND id = $2::uuid) AS a_financial,
      (SELECT state_version::text FROM saas_requests WHERE tenant_id = $1 AND id = $2::uuid) AS a_request_version,
      (SELECT result_state FROM saas_attempts WHERE tenant_id = $1 AND request_id = $2::uuid) AS a_attempt,
      (SELECT state_version::text FROM saas_attempts WHERE tenant_id = $1 AND request_id = $2::uuid) AS a_attempt_version,
      (SELECT state FROM saas_gateway_capacity_reservations WHERE tenant_id = $1 AND request_id = $2::uuid) AS a_capacity`,
    [fixture.settlement.tenantId, fixture.settlement.input.requestId],
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row);
  assert.equal(row.wallets, '1');
  assert.equal(row.balance, row.wallet_ledger, 'the committed wallet projection must equal its actual ledger');
  assert.equal(row.unbalanced, '0', 'all committed ledger transactions retain their balanced entry pair');
  return row;
}

async function assertBlocked(observer: SqlExecutor, holder: number, waiter: number, walletKey?: string) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ observer: number; blocked: boolean; wallet_advisory: boolean }>(
      `SELECT pg_backend_pid() AS observer, $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked,
        EXISTS (SELECT 1 FROM pg_locks h JOIN pg_locks w
          ON h.locktype = w.locktype AND h.database = w.database AND h.classid = w.classid
             AND h.objid = w.objid AND h.objsubid = w.objsubid
          WHERE h.pid = $1 AND w.pid = $2 AND h.locktype = 'advisory'
            AND h.mode = 'ExclusiveLock' AND h.granted AND w.mode = 'ExclusiveLock' AND NOT w.granted
            AND h.objsubid = 1 AND h.classid::bigint = ((hashtextextended($3, 0) >> 32) & 4294967295)
            AND h.objid::bigint = (hashtextextended($3, 0) & 4294967295)) AS wallet_advisory`,
      [holder, waiter, walletKey ?? 'unused-observer-key'],
    );
    assert.equal(result.rows.length, 1);
    assert.notEqual(result.rows[0]?.observer, holder, 'the read-only observer must be a third backend');
    assert.notEqual(result.rows[0]?.observer, waiter, 'the read-only observer must be a third backend');
    if (result.rows[0]?.blocked && (!walletKey || result.rows[0].wallet_advisory)) return;
    // Poll an actual server predicate; elapsed time alone never establishes blocking.
    await delay(10);
  }
  assert.fail(walletKey ? 'B must observably wait on A canonical wallet advisory' : 'A must observably wait on B');
}

async function backendPid(tx: SqlExecutor) {
  const result = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.ok(row && Number.isSafeInteger(row.pid) && row.pid > 0);
  return row.pid;
}

export type WalletCompensationMutation =
  | 'none'
  | 'test-only-missing-fence-for-update'
  | 'test-only-missing-fence-no-key-update';

/** Real services and roles; the two explicitly named mutations affect only B's test executor. */
export async function proveWalletCompensationLockOrder(
  migrator: SaasDatabase,
  gateway: SaasDatabase,
  mutation: WalletCompensationMutation,
) {
  const fixture = await walletFixture(migrator, gateway);
  const before = await financialSnapshot(migrator, fixture);
  const beforeB = await cancellationSnapshot(migrator, fixture.cancellation);
  assert.equal(before.balance, '100');
  assert.equal(before.active_hold, '100', 'both real holds must exist before either actor starts');
  const walletKey = saasAdvisoryKey.walletFence(fixture.settlement.tenantId, 'USD');
  const ledgerEntered = signal<void>();
  const continueLedger = signal<void>();
  const aPid = signal<number>();
  const bPid = signal<number>();
  const states: string[] = [];
  const events: string[] = [];
  let aCurrent = '';
  let ledgerAttempts = 0;
  let ledgerWrites = 0;
  let projectionAttempts = 0;
  let projectionWrites = 0;
  let bFences = 0;
  let bWalletLocks = 0;
  const aDatabase = mappedDatabase(gateway, gateway.query.bind(gateway), (work) =>
    cancellationTransaction(gateway, async (tx) => {
      aPid.resolve(await backendPid(tx));
      return work({
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const ledger = sql === LEDGER_ENTRY_SQL;
          const projection = sql === WALLET_PROJECTION_SQL;
          if (ledger && ++ledgerAttempts === 1) {
            assert.equal(values?.[2], fixture.settlement.tenantId);
            assert.equal(values?.[4], 'debit');
            assert.equal(values?.[5], fixture.settlement.input.chargeAmountMinorUnits);
            assert.equal(values?.[8], fixture.walletId);
            ledgerEntered.resolve(undefined);
            await continueLedger.promise;
          }
          if (projection) {
            assert.deepEqual(values?.slice(0, 4), [fixture.walletId, fixture.settlement.tenantId, 'USD', '-12']);
            projectionAttempts++;
          }
          aCurrent = ledger ? 'ledger-entry' : projection ? 'wallet-projection' : 'other';
          try {
            const result = await tx.query<Row>(sql, values);
            if (sql === WALLET_FENCE_SQL) {
              assert.deepEqual(values, [walletKey]);
              events.push('a-wallet-fence');
            }
            if (ledger) {
              assert.equal(result.rowCount, 1);
              ledgerWrites++;
            }
            if (projection) {
              assert.equal(result.rowCount, 1);
              projectionWrites++;
              events.push('a-wallet-projection');
            }
            aCurrent = '';
            return result;
          } catch (error) {
            const state = cancellationSqlState(error);
            if (state) states.push(state);
            throw error;
          }
        },
      });
    }),
  );
  const settlement = new DurableNormalSuccessSettlementPort(aDatabase, fixture.settlement);
  const a = settlement.complete(fixture.settlement.input).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason: unknown) => ({ status: 'rejected', reason }) as const,
  );
  let b: ReturnType<GatewayPreDispatchCompensationService['compensate']> | undefined;
  try {
    await Promise.race([ledgerEntered.promise, a.then(() => assert.fail('A must reach the real first ledger INSERT'))]);
    assert.ok(events.includes('a-wallet-fence'), 'the real billing wallet advisory must precede the A barrier');
    const service = new GatewayPreDispatchCompensationService(
      {
        transaction: (work) =>
          cancellationTransaction(gateway, async (tx) => {
            bPid.resolve(await backendPid(tx));
            return work({
              async query<Row>(sql: string, values?: readonly unknown[]) {
                if (sql === WALLET_FENCE_SQL) {
                  assert.deepEqual(values, [walletKey]);
                  bFences++;
                  if (bFences === 1 && mutation !== 'none') {
                    // Controlled test mutation of only the newly added first fence.
                    // This is not a replay of an older complete production source.
                    return { rows: [], rowCount: 0 };
                  }
                }
                if (sql === COMPENSATION_WALLET_ROW_SQL) {
                  assert.deepEqual(values, [fixture.settlement.tenantId, 'USD']);
                  if (mutation === 'test-only-missing-fence-no-key-update') {
                    sql = 'SELECT id FROM saas_wallets WHERE tenant_id = $1 AND currency = $2 FOR NO KEY UPDATE';
                  }
                  bWalletLocks++;
                }
                try {
                  const result = await tx.query<Row>(sql, values);
                  if (sql === WALLET_FENCE_SQL) events.push('b-wallet-fence');
                  return result;
                } catch (error) {
                  const state = cancellationSqlState(error);
                  if (state) states.push(state);
                  throw error;
                }
              },
            });
          }),
      },
      compensationPort(fixture),
    );
    b = service.compensate(compensationInput(fixture));
    const holder = await aPid.promise;
    const waiter = await Promise.race([bPid.promise, b.then(() => assert.fail('B must enter a fresh transaction'))]);
    assert.notEqual(holder, waiter);
    await assertBlocked(migrator, holder, waiter, walletKey);
    assert.equal(bWalletLocks, mutation === 'none' ? 0 : 1);
    continueLedger.resolve(undefined);
    if (mutation !== 'none') {
      await assertBlocked(migrator, waiter, holder);
      assert.equal(aCurrent, mutation === 'test-only-missing-fence-for-update' ? 'ledger-entry' : 'wallet-projection');
      if (mutation === 'test-only-missing-fence-no-key-update') {
        assert.equal(
          ledgerWrites,
          2,
          'NOKU control must really insert the balanced pair before blocking the debit UPDATE',
        );
        assert.equal(projectionAttempts, 1);
      }
    }
    const [aResult, bResult] = await Promise.all([a, b]);
    assert.equal(bFences, 2, 'assertHold and billing.release must each retain their canonical wallet fence');
    assert.equal(bWalletLocks, 1, 'only the exact compensation wallet row query is observed or mutated');
    const after = await financialSnapshot(migrator, fixture);
    const afterB = await cancellationSnapshot(migrator, fixture.cancellation);
    if (mutation === 'none') {
      assert.equal(aResult.status, 'fulfilled');
      if (aResult.status === 'fulfilled') assert.equal(aResult.value.kind, 'settled');
      assert.equal(bResult.disposition, 'released');
      assert.deepEqual(states, []);
      assert.equal(ledgerWrites, 2, 'the actual debit and credit entries must both be inserted');
      assert.equal(projectionWrites, 1, 'the actual positive charge must update the wallet projection');
      assert.ok(events.indexOf('a-wallet-projection') < events.indexOf('b-wallet-fence'));
      assert.equal(after.balance, '88');
      assert.equal(after.active_hold, '0');
      assert.equal(after.usage, '1');
      assert.equal(after.settlements, '1');
      assert.equal(after.billing_transactions, '1');
      assert.equal(after.entries, String(BigInt(before.entries) + 2n));
      assert.equal(after.a_hold, 'settled');
      assert.equal(after.a_request, 'succeeded');
      assert.equal(after.a_financial, 'settled');
      assert.equal(after.a_attempt, 'succeeded');
      assert.equal(
        after.a_capacity,
        before.a_capacity,
        'this settlement port must not mutate the separate capacity authority',
      );
      assert.equal(afterB.capacity_state, 'released');
      assert.equal(afterB.hold_state, 'released');
      assert.equal(afterB.execution_state, 'failed');
      assert.equal(afterB.financial_status, 'released');
      assert.equal(afterB.dispatch_state, 'not_sent');
      assert.equal(afterB.result_state, 'failed');
      assert.equal(afterB.response_started, false);
      assert.equal(afterB.idempotency_state, 'completed');
      assert.equal(afterB.released_audits, '1');
      const replaySettlement = await new DurableNormalSuccessSettlementPort(gateway, fixture.settlement).complete(
        fixture.settlement.input,
      );
      assert.equal(replaySettlement.kind, 'replayed');
      const replayCompensation = new GatewayPreDispatchCompensationService(
        { transaction: (work) => cancellationTransaction(gateway, work) },
        compensationPort(fixture),
      );
      assert.equal((await replayCompensation.compensate(compensationInput(fixture))).disposition, 'released');
      assert.deepEqual(await financialSnapshot(migrator, fixture), after);
      assert.deepEqual(await cancellationSnapshot(migrator, fixture.cancellation), afterB);
    } else {
      assert.ok(
        states.includes('40P01'),
        'the controlled reverse-order cycle must produce an actual PostgreSQL deadlock',
      );
      assert.ok(
        states.every((state) => state === '40P01'),
        'lock/statement timeouts are not an accepted counterexample',
      );
      const aSucceeded = aResult.status === 'fulfilled';
      const bSucceeded = bResult.disposition === 'released';
      assert.notEqual(
        aSucceeded,
        bSucceeded,
        'exactly one real transaction wins; the victim rolls back without a retry',
      );
      assert.equal(after.balance, aSucceeded ? '88' : '100');
      assert.equal(after.active_hold, '50');
      assert.equal(after.usage, aSucceeded ? '1' : '0');
      assert.equal(after.settlements, aSucceeded ? '1' : '0');
      assert.equal(after.billing_transactions, aSucceeded ? '1' : '0');
      assert.equal(after.entries, String(BigInt(before.entries) + (aSucceeded ? 2n : 0n)));
      assert.equal(after.a_hold, aSucceeded ? 'settled' : 'reserved');
      assert.equal(after.a_request, aSucceeded ? 'succeeded' : before.a_request);
      assert.equal(after.a_attempt, aSucceeded ? 'succeeded' : before.a_attempt);
      assert.equal(after.a_financial, aSucceeded ? 'settled' : before.a_financial);
      assert.equal(after.a_capacity, before.a_capacity);
      assert.equal(afterB.hold_state, bSucceeded ? 'released' : 'reserved');
      assert.equal(afterB.capacity_state, bSucceeded ? 'released' : 'reserved');
      assert.equal(afterB.released_audits, bSucceeded ? '1' : '0');
      assert.equal(afterB.execution_state, bSucceeded ? 'failed' : beforeB.execution_state);
      assert.equal(afterB.financial_status, bSucceeded ? 'released' : beforeB.financial_status);
      assert.equal(afterB.idempotency_state, bSucceeded ? 'completed' : beforeB.idempotency_state);
      if (!bSucceeded) assert.deepEqual(compensationLocal(afterB), compensationLocal(beforeB));
      if (!aSucceeded) {
        assert.equal(after.a_request_version, before.a_request_version);
        assert.equal(after.a_attempt_version, before.a_attempt_version);
      }
    }
  } finally {
    continueLedger.resolve(undefined);
    await Promise.allSettled([a, ...(b ? [b] : [])]);
  }
}

export async function proveWalletSettlementRollback(migrator: SaasDatabase, gateway: SaasDatabase) {
  const fixture = await walletFixture(migrator, gateway);
  const before = await financialSnapshot(migrator, fixture);
  const beforeB = await cancellationSnapshot(migrator, fixture.cancellation);
  const sentinel = new Error('test-only fault after actual first settlement ledger entry');
  let inserted = 0;
  let faultThrown: Error | undefined;
  const database = mappedDatabase(gateway, gateway.query.bind(gateway), (work) =>
    cancellationTransaction(gateway, (tx) =>
      work({
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await tx.query<Row>(sql, values);
          if (sql === LEDGER_ENTRY_SQL && ++inserted === 1) {
            assert.equal(result.rowCount, 1);
            faultThrown = sentinel;
            throw sentinel;
          }
          return result;
        },
      }),
    ),
  );
  await assert.rejects(
    new DurableNormalSuccessSettlementPort(database, fixture.settlement).complete(fixture.settlement.input),
    (error: unknown) => {
      assert.equal(inserted, 1, 'the fault must follow the actual first ledger INSERT');
      assert.equal(faultThrown, sentinel, 'the exact fault must be thrown after the successful INSERT assertion');
      assert.ok(error instanceof SaasBillingError);
      assert.equal(error.code, 'BILLING_STORAGE_ERROR');
      assert.equal(error.cause, undefined, 'the billing public error intentionally does not retain its internal cause');
      return true;
    },
  );
  assert.equal(inserted, 1);
  assert.deepEqual(await financialSnapshot(migrator, fixture), before);
  assert.deepEqual(await cancellationSnapshot(migrator, fixture.cancellation), beforeB);
  const service = new GatewayPreDispatchCompensationService(
    { transaction: (work) => cancellationTransaction(gateway, work) },
    compensationPort(fixture),
  );
  assert.equal((await service.compensate(compensationInput(fixture))).disposition, 'released');
  const released = await financialSnapshot(migrator, fixture);
  const releasedB = await cancellationSnapshot(migrator, fixture.cancellation);
  assert.equal(released.balance, '100');
  assert.equal(released.active_hold, '50');
  assert.equal(released.billing_transactions, '0');
  assert.equal(releasedB.released_audits, '1');
  for (const [sql, values, expected] of [
    [
      'UPDATE saas_wallets SET posted_balance_minor_units = posted_balance_minor_units + 1 WHERE tenant_id = $1',
      [fixture.settlement.tenantId],
      '55000',
    ],
    [
      "UPDATE saas_billing_reservations SET state = 'reserved' WHERE tenant_id = $1 AND request_id = $2",
      [fixture.settlement.tenantId, fixture.cancellation.requestId],
      '55000',
    ],
    ['DELETE FROM saas_ledger_entries WHERE tenant_id = $1', [fixture.settlement.tenantId], '42501'],
  ] as const) {
    const unexpected = new Error('forbidden gateway writer unexpectedly succeeded');
    await assert.rejects(
      cancellationTransaction(gateway, async (tx) => {
        await tx.query(sql, values);
        throw unexpected;
      }),
      (error: unknown) => {
        assert.notEqual(error, unexpected);
        assert.equal(cancellationSqlState(error), expected);
        return true;
      },
    );
    assert.deepEqual(await financialSnapshot(migrator, fixture), released);
    assert.deepEqual(await cancellationSnapshot(migrator, fixture.cancellation), releasedB);
  }
}
