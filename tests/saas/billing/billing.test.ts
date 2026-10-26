import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasBillingError } from '../../../src/saas/billing/errors.js';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import type {
  BillingReservationResult,
  BillingTransactionExecutor,
  ReleaseBillingInput,
  ReserveBillingInput,
  SettleBillingInput,
} from '../../../src/saas/billing/types.js';
import type { SqlResult } from '../../../src/saas/db/types.js';
import { FakeBillingDatabase } from './fake-sql.js';

const tenantId = 'tenant-1';
const currency = 'USD';

function createService(now = new Date('2026-09-28T00:00:00.000Z')): PlatformWalletLedgerService {
  let nextId = 0;
  return new PlatformWalletLedgerService({
    now: () => new Date(now),
    idFactory: () => `id-${++nextId}`,
  });
}

function observeQueries(executor: BillingTransactionExecutor, statements: string[]): BillingTransactionExecutor {
  return {
    query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      statements.push(sql.replace(/\s+/g, ' ').trim().toLowerCase());
      return executor.query<Row>(sql, values);
    },
  };
}

async function fund(
  database: FakeBillingDatabase,
  service: PlatformWalletLedgerService,
  amount = '100',
  sourceOrderRef = 'order-1',
): Promise<void> {
  await database.transaction((tx) =>
    service.postVerifiedFunding(tx, {
      tenantId,
      currency,
      amountMinorUnits: amount,
      sourceOrderRef,
      idempotencyKey: `funding-${sourceOrderRef}`,
    }),
  );
}

function reserveInput(overrides: Partial<ReserveBillingInput> = {}): ReserveBillingInput {
  return {
    supplyMode: 'platform',
    tenantId,
    requestId: 'request-1',
    currency,
    amountMinorUnits: '40',
    priceSnapshotRef: 'price-v1',
    metadataRef: 'price-v1',
    businessKey: 'billing-request-1',
    expiresAt: '2026-09-28T01:00:00.000Z',
    ...overrides,
  };
}

async function reserve(
  database: FakeBillingDatabase,
  service: PlatformWalletLedgerService,
  overrides: Partial<ReserveBillingInput> = {},
): Promise<BillingReservationResult> {
  return database.transaction((tx) => service.reserve(tx, reserveInput(overrides)));
}

function settlementInput(overrides: Partial<SettleBillingInput> = {}): SettleBillingInput {
  return {
    supplyMode: 'platform',
    tenantId,
    requestId: 'request-1',
    currency,
    businessKey: 'billing-request-1',
    priceSnapshotRef: 'price-v1',
    settlementId: 'settlement-1',
    usageEvidenceRef: 'usage-1',
    actualAmountMinorUnits: '20',
    ...overrides,
  };
}

test('funding posts balanced positive double-entry records and is replay-safe', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();

  await fund(database, service, '125');
  const replay = await database.transaction((tx) =>
    service.postVerifiedFunding(tx, {
      tenantId,
      currency,
      amountMinorUnits: '125',
      sourceOrderRef: 'order-1',
      idempotencyKey: 'funding-order-1',
    }),
  );

  assert.equal(replay.replayed, true);
  assert.equal(database.state.transactions.length, 1);
  assert.equal(database.state.entries.length, 2);
  assert.deepEqual(
    database.state.entries.map(({ direction, amount_minor_units }) => ({ direction, amount_minor_units })),
    [
      { direction: 'credit', amount_minor_units: '125' },
      { direction: 'debit', amount_minor_units: '125' },
    ],
  );
  assert.equal(replay.wallet.postedBalanceMinorUnits, 125n);
  assert.equal(replay.wallet.availableMinorUnits, 125n);
});

test('spending freezes use the wallet advisory fence before reservation reads without UPDATE row-lock rights', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');

  const statements: string[] = [];
  await database.transaction((tx) => service.reserve(observeQueries(tx, statements), reserveInput()));

  // The per-wallet fence is the EXCLUSIVE transaction-scoped advisory lock
  // (batch 1.2 step 3), taken BEFORE the wallet row read.
  const walletFence = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const walletRead = statements.findIndex((sql) => sql.includes('from saas_wallets') && !sql.includes('pg_advisory'));
  const freezeRead = statements.find((sql) => sql.includes('from saas_billing_spending_freezes'));
  const reservationLock = statements.findIndex(
    (sql) => sql.includes('from saas_billing_reservations') && sql.includes('for update'),
  );
  assert.ok(walletFence >= 0, 'the wallet advisory fence must be taken');
  assert.ok(walletRead > walletFence, 'the wallet row read must follow the fence');
  assert.ok(
    !statements.some((sql) => sql.includes('from saas_wallets') && sql.includes('for update')),
    'the wallet row is no longer tuple-locked',
  );
  assert.ok(freezeRead);
  assert.ok(!freezeRead.includes('for update'));
  assert.ok(freezeRead && statements.indexOf(freezeRead) > walletFence);
  assert.equal(reservationLock, -1, 'a missing reservation needs no separate row lock under its wallet fence');
  assert.ok(statements[walletRead]?.includes('as reservation_exists'));
});

test('reserve reads the spending freeze exactly once inside the wallet critical section', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');

  const statements: string[] = [];
  await database.transaction((tx) => service.reserve(observeQueries(tx, statements), reserveInput()));

  const walletFence = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const freezeReads = statements
    .map((sql, index) => ({ sql, index }))
    .filter(({ sql }) => sql.includes('from saas_billing_spending_freezes'));
  assert.ok(walletFence >= 0);
  // Exactly one freeze read, after the wallet fence and before the insert.
  assert.equal(freezeReads.length, 1);
  assert.ok(freezeReads[0] && freezeReads[0].index > walletFence);
  const insertAt = statements.findIndex((sql) => sql.startsWith('insert into saas_billing_reservations'));
  assert.ok(insertAt > (freezeReads[0]?.index ?? -1));
});

test('refund-freeze and immutable ledger reads do not request row-update locks', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  const wallet = database.state.wallets[0];
  assert.ok(wallet);
  database.state.refundWalletFreezes.push({
    refund_order_id: 'refund-1',
    tenant_id: tenantId,
    wallet_id: wallet.id,
    currency,
    amount_minor_units: '10',
  });

  const statements: string[] = [];
  await database.transaction((tx) =>
    service.postVerifiedWalletRefund(observeQueries(tx, statements), {
      tenantId,
      currency,
      amountMinorUnits: '10',
      refundOrderId: 'refund-1',
    }),
  );
  const walletFence = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const refundFreezeRead = statements.findIndex((sql) => sql.includes('from saas_refund_wallet_freezes'));
  assert.ok(walletFence >= 0);
  assert.ok(refundFreezeRead > walletFence);
  assert.ok(!statements[refundFreezeRead]?.includes('for update'));

  statements.length = 0;
  await database.transaction((tx) =>
    service.postVerifiedFunding(observeQueries(tx, statements), {
      tenantId,
      currency,
      amountMinorUnits: '100',
      sourceOrderRef: 'order-1',
      idempotencyKey: 'funding-order-1',
    }),
  );
  const identityRead = statements.find(
    (sql) => sql.includes('from saas_ledger_transactions') && sql.includes('business_key'),
  );
  const replayWalletFence = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const identityReadIndex = statements.findIndex(
    (sql) => sql.includes('from saas_ledger_transactions') && sql.includes('business_key'),
  );
  assert.ok(identityRead);
  assert.ok(!identityRead.includes('for update'));
  assert.ok(replayWalletFence >= 0 && replayWalletFence < identityReadIndex);

  statements.length = 0;
  await assert.rejects(
    database.transaction((tx) =>
      service.postVerifiedFunding(observeQueries(tx, statements), {
        tenantId,
        currency,
        amountMinorUnits: '100',
        sourceOrderRef: 'order-1',
        idempotencyKey: 'funding-order-reused',
      }),
    ),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  const sourceOrderRead = statements.find(
    (sql) => sql.includes('from saas_ledger_transactions') && sql.includes('source_order_ref'),
  );
  const conflictWalletLock = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const sourceOrderReadIndex = statements.findIndex(
    (sql) => sql.includes('from saas_ledger_transactions') && sql.includes('source_order_ref'),
  );
  assert.ok(sourceOrderRead);
  assert.ok(!sourceOrderRead.includes('for update'));
  assert.ok(conflictWalletLock >= 0 && conflictWalletLock < sourceOrderReadIndex);
});

test('competing reservations serialize on the locked wallet and never make availability negative', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');

  const results = await Promise.allSettled([
    reserve(database, service, { requestId: 'request-a', businessKey: 'key-a', amountMinorUnits: '70' }),
    reserve(database, service, { requestId: 'request-b', businessKey: 'key-b', amountMinorUnits: '70' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof SaasBillingError);
  assert.equal(rejected.reason.code, 'INSUFFICIENT_FUNDS');
  const wallet = await database.transaction((tx) => service.getWallet(tx, tenantId, currency));
  assert.equal(wallet.activeHoldsMinorUnits, 70n);
  assert.equal(wallet.availableMinorUnits, 30n);
});

test('duplicate reserve replays the current outcome and payload changes conflict', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  const first = await reserve(database, service);
  const replay = await reserve(database, service);
  assert.equal(replay.id, first.id);
  assert.equal(replay.state, 'reserved');

  await assert.rejects(
    reserve(database, service, { amountMinorUnits: '41' }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  await assert.rejects(
    reserve(database, service, { priceSnapshotRef: 'price-v2' }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('settlement and release have exactly-once terminal transitions', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  await reserve(database, service);

  const settled = await database.transaction((tx) => service.settle(tx, settlementInput()));
  const settledReplay = await database.transaction((tx) => service.settle(tx, settlementInput()));
  assert.equal(settled.state, 'settled');
  assert.equal(settledReplay.id, settled.id);
  assert.equal(database.state.transactions.length, 2);
  assert.equal(database.state.entries.length, 4);
  await assert.rejects(
    database.transaction((tx) =>
      service.release(tx, {
        supplyMode: 'platform',
        tenantId,
        requestId: 'request-1',
        currency,
        businessKey: 'billing-request-1',
        releaseId: 'release-after-settle',
        releaseEvidenceRef: 'confirmed-not-dispatched-after-settle',
      }),
    ),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'RESERVATION_STATE_CONFLICT',
  );

  const releasedReservation = await reserve(database, service, {
    requestId: 'request-2',
    businessKey: 'billing-request-2',
    amountMinorUnits: '10',
  });
  const releaseInput = {
    supplyMode: 'platform' as const,
    tenantId,
    requestId: 'request-2',
    currency,
    businessKey: 'billing-request-2',
    releaseId: 'release-2',
    releaseEvidenceRef: '  confirmed-not-dispatched-2  ',
  };
  const released = await database.transaction((tx) => service.release(tx, releaseInput));
  const releasedReplay = await database.transaction((tx) => service.release(tx, releaseInput));
  assert.equal(released.id, releasedReservation.id);
  assert.equal(released.state, 'released');
  assert.equal(released.releaseEvidenceRef, 'confirmed-not-dispatched-2');
  assert.equal(releasedReplay.state, 'released');
  assert.equal(releasedReplay.releaseEvidenceRef, 'confirmed-not-dispatched-2');
  assert.equal(
    database.state.reservations.find((reservation) => reservation.id === releasedReservation.id)?.release_evidence_ref,
    'confirmed-not-dispatched-2',
  );
});

test('release requires explicit non-dispatch evidence before any state change', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  await reserve(database, service);

  const releaseWithoutEvidence: Omit<ReleaseBillingInput, 'releaseEvidenceRef'> = {
    supplyMode: 'platform',
    tenantId,
    requestId: 'request-1',
    currency,
    businessKey: 'billing-request-1',
    releaseId: 'release-missing-evidence',
  };
  const stateBeforeAttempt = structuredClone(database.state);
  let queryCount = 0;

  const attemptRelease = (input: ReleaseBillingInput) =>
    database.transaction((tx) => {
      const observedExecutor: BillingTransactionExecutor = {
        query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
          queryCount += 1;
          return tx.query<Row>(sql, values);
        },
      };
      return service.release(observedExecutor, input);
    });

  await assert.rejects(
    attemptRelease(releaseWithoutEvidence as unknown as ReleaseBillingInput),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INVALID_INPUT',
  );
  assert.equal(queryCount, 0);
  assert.deepEqual(database.state, stateBeforeAttempt);

  await assert.rejects(
    attemptRelease({ ...releaseWithoutEvidence, releaseEvidenceRef: '   ' }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INVALID_INPUT',
  );
  assert.equal(queryCount, 0);
  assert.deepEqual(database.state, stateBeforeAttempt);
});

test('unknown upstream results retain the hold even after TTL passes', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  await reserve(database, service, { expiresAt: '2026-09-28T00:00:01.000Z' });

  const pending = await database.transaction((tx) =>
    service.markReconciliationPending(tx, {
      supplyMode: 'platform',
      tenantId,
      requestId: 'request-1',
      currency,
      businessKey: 'billing-request-1',
      evidenceRef: 'upstream-result-unknown-1',
    }),
  );
  assert.equal(pending.state, 'reconciliation_pending');
  assert.equal(pending.activeHoldsMinorUnits, 40n);
  assert.equal(pending.availableMinorUnits, 60n);

  const wallet = await database.transaction((tx) => service.getWallet(tx, tenantId, currency));
  assert.equal(wallet.activeHoldsMinorUnits, 40n);
  assert.equal(wallet.availableMinorUnits, 60n);
});

test('provider reconciliation evidence cannot settle or release an over-hold reservation', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  await reserve(database, service, { amountMinorUnits: '70' });

  const pending = await database.transaction((tx) =>
    service.settle(
      tx,
      settlementInput({
        actualAmountMinorUnits: '90',
        usageEvidenceRef: 'usage-over-1',
        settlementId: 'settlement-over-1',
        reconciliationEvidenceRef: 'provider-reconciled-1',
      }),
    ),
  );
  assert.equal(pending.state, 'reconciliation_pending');
  assert.equal(pending.settlementAmountMinorUnits, 90n);
  assert.equal(pending.reconciliationEvidenceRef, 'provider-reconciled-1');
  assert.equal(pending.activeHoldsMinorUnits, 70n);
  assert.equal(pending.availableMinorUnits, 30n);
  assert.equal(pending.spendingFrozen, true);

  await assert.rejects(
    reserve(database, service, {
      requestId: 'request-new',
      businessKey: 'billing-request-new',
      amountMinorUnits: '1',
    }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'SPENDING_FROZEN',
  );

  await fund(database, service, '30', 'order-2');
  const settled = await database.transaction((tx) =>
    service.settle(
      tx,
      settlementInput({
        actualAmountMinorUnits: '90',
        usageEvidenceRef: 'usage-over-1',
        settlementId: 'settlement-over-1',
        reconciliationEvidenceRef: 'provider-reconciled-1',
      }),
    ),
  );
  assert.equal(settled.state, 'reconciliation_pending');
  assert.equal(settled.reconciliationEvidenceRef, 'provider-reconciled-1');
  assert.equal(settled.activeHoldsMinorUnits, 70n);
  assert.equal(settled.availableMinorUnits, 60n);
  assert.equal(settled.spendingFrozen, true);
  assert.equal(settled.walletPostedBalanceMinorUnits, 130n);
  assert.equal(database.state.transactions.length, 2);

  const replay = await database.transaction((tx) =>
    service.settle(
      tx,
      settlementInput({
        actualAmountMinorUnits: '90',
        usageEvidenceRef: 'usage-over-1',
        settlementId: 'settlement-over-1',
        reconciliationEvidenceRef: 'provider-reconciled-1',
      }),
    ),
  );
  assert.equal(replay.state, 'reconciliation_pending');
  assert.equal(replay.spendingFrozen, true);
  assert.equal(replay.walletPostedBalanceMinorUnits, 130n);
  assert.equal(database.state.transactions.length, 2);

  await assert.rejects(
    database.transaction((tx) =>
      service.release(tx, {
        supplyMode: 'platform',
        tenantId,
        requestId: 'request-1',
        currency,
        businessKey: 'billing-request-1',
        releaseId: 'release-over-hold',
        releaseEvidenceRef: 'provider-reconciled-1',
        reconciliationEvidenceRef: 'provider-reconciled-1',
      }),
    ),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'RECONCILIATION_REQUIRED',
  );
  const stillFrozen = await database.transaction((tx) => service.getWallet(tx, tenantId, currency));
  assert.equal(stillFrozen.spendingFrozen, true);
  assert.equal(stillFrozen.postedBalanceMinorUnits, 130n);
  assert.equal(stillFrozen.activeHoldsMinorUnits, 70n);
  assert.equal(database.state.transactions.length, 2);

  await assert.rejects(
    reserve(database, service, {
      requestId: 'request-after-provider-evidence',
      businessKey: 'billing-request-after-provider-evidence',
      amountMinorUnits: '1',
    }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'SPENDING_FROZEN',
  );

  await assert.rejects(
    database.transaction((tx) =>
      service.settle(
        tx,
        settlementInput({
          actualAmountMinorUnits: '90',
          usageEvidenceRef: 'usage-over-1',
          settlementId: 'settlement-over-1',
          reconciliationEvidenceRef: 'provider-reconciled-2',
        }),
      ),
    ),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('verified in-hold settlement resolves a pending reconciliation and replays safely', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  await reserve(database, service, { amountMinorUnits: '40' });

  await database.transaction((tx) =>
    service.markReconciliationPending(tx, {
      supplyMode: 'platform',
      tenantId,
      requestId: 'request-1',
      currency,
      businessKey: 'billing-request-1',
      evidenceRef: 'upstream-result-unknown-1',
    }),
  );

  const input = settlementInput({
    actualAmountMinorUnits: '20',
    usageEvidenceRef: 'usage-verified-1',
    settlementId: 'settlement-verified-1',
    reconciliationEvidenceRef: 'provider-success-1',
  });
  const settled = await database.transaction((tx) => service.settle(tx, input));
  const replay = await database.transaction((tx) => service.settle(tx, input));

  assert.equal(settled.state, 'settled');
  assert.equal(settled.activeHoldsMinorUnits, 0n);
  assert.equal(settled.walletPostedBalanceMinorUnits, 80n);
  assert.equal(settled.reconciliationEvidenceRef, 'provider-success-1');
  assert.equal(replay.state, 'settled');
  assert.equal(replay.id, settled.id);
  assert.equal(database.state.transactions.length, 2);
});

test('insufficient funds, invalid amount input, and BYOK are rejected before wallet writes', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '10');

  await assert.rejects(
    reserve(database, service, { amountMinorUnits: '11' }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INSUFFICIENT_FUNDS',
  );
  await assert.rejects(
    reserve(database, service, { amountMinorUnits: 1 as never }),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INVALID_AMOUNT',
  );
  await assert.rejects(
    database.transaction((tx) => service.reserve(tx, { ...reserveInput(), supplyMode: 'byok' as never })),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'BYOK_WALLET_FORBIDDEN',
  );
  assert.equal(database.state.reservations.length, 0);
  assert.equal(database.state.transactions.length, 1);
});

test('rebuilding the projection derives balance from ledger entries', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '55');
  const walletRow = database.state.wallets[0];
  assert.ok(walletRow);
  walletRow.posted_balance_minor_units = '999';

  const rebuilt = await database.transaction((tx) => service.rebuildWalletProjection(tx, { tenantId, currency }));
  assert.equal(rebuilt.postedBalanceMinorUnits, 55n);
  assert.equal(rebuilt.availableMinorUnits, 55n);
});

test('mutating billing operations require an explicit executor', async () => {
  const service = createService();
  await assert.rejects(
    service.reserve(undefined as never, reserveInput()),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'EXECUTOR_REQUIRED',
  );
});

test('wallet summary combines both exact sums at the original reserve observation points', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  const wallet = database.state.wallets[0];
  assert.ok(wallet);
  database.state.refundWalletFreezes.push({
    refund_order_id: 'refund-summary',
    tenant_id: tenantId,
    wallet_id: wallet.id,
    currency,
    amount_minor_units: '10',
  });

  const statements: string[] = [];
  const observations: Array<{ sql: string; values: readonly unknown[]; rows: readonly unknown[] }> = [];
  const reserved = await database.transaction((tx) =>
    service.reserve(
      {
        async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
          const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
          statements.push(statement);
          const result = await tx.query<Row>(sql, values);
          if (
            statement.includes('as active_hold_minor_units') &&
            statement.includes('as active_refund_freeze_minor_units')
          ) {
            observations.push({ sql: statement, values: [...values], rows: result.rows });
          }
          return result;
        },
      },
      reserveInput(),
    ),
  );

  const expectedSql =
    'select ((select coalesce(sum(amount_minor_units), 0) from saas_billing_reservations ' +
    "where tenant_id = $1 and currency = $2 and state in ('reserved', 'reconciliation_pending')) " +
    '+ (select coalesce(sum(backing_minor_units), 0) from saas_fast_credit_allocations ' +
    'where tenant_id = $1 and currency = $2))::text as active_hold_minor_units, (select coalesce(sum(amount_minor_units), 0)::text ' +
    'from saas_refund_wallet_freezes where tenant_id = $1 and currency = $2 ) as active_refund_freeze_minor_units';
  assert.equal(observations.length, 2);
  assert.match(observations[0]!.sql, /billing:reserve-wallet-snapshot/);
  assert.deepEqual(observations[0]!.values, [tenantId, currency, 'saas.billing.reservation', 'billing-request-1']);
  assert.equal((observations[0]!.rows[0] as Record<string, unknown>).active_hold_minor_units, '0');
  assert.equal((observations[0]!.rows[0] as Record<string, unknown>).active_refund_freeze_minor_units, '10');
  assert.deepEqual(observations[1], {
    sql: expectedSql,
    values: [tenantId, currency],
    rows: [{ active_hold_minor_units: '40', active_refund_freeze_minor_units: '10' }],
  });
  const summaryReads = statements
    .map((sql, index) => ({ sql, index }))
    .filter(
      ({ sql }) => sql.includes('as active_hold_minor_units') || sql.includes('as active_refund_freeze_minor_units'),
    );
  assert.equal(summaryReads.length, 2);
  const walletFence = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  const freezeRead = statements.findIndex((sql) => sql.includes('from saas_billing_spending_freezes'));
  const insertAt = statements.findIndex((sql) => sql.startsWith('insert into saas_billing_reservations'));
  assert.ok(walletFence >= 0 && freezeRead > walletFence);
  assert.equal(summaryReads[0]?.index, freezeRead);
  assert.ok(insertAt > (summaryReads[0]?.index ?? -1));
  assert.ok((summaryReads[1]?.index ?? -1) > insertAt);
  assert.equal(reserved.walletPostedBalanceMinorUnits, 100n);
  assert.equal(reserved.activeHoldsMinorUnits, 40n);
  assert.equal(reserved.availableMinorUnits, 50n);
  assert.equal(reserved.spendingFrozen, false);
});

test('combined wallet sums retain tenant, currency, and active reservation state filters', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '1000');
  await reserve(database, service, { amountMinorUnits: '40' });
  const seed = database.state.reservations[0];
  const wallet = database.state.wallets[0];
  assert.ok(seed && wallet);
  database.state.reservations.push(
    {
      ...seed,
      id: 'pending',
      state: 'reconciliation_pending',
      amount_minor_units: '20',
      expires_at: '2020-01-01T00:00:00.000Z',
    },
    { ...seed, id: 'settled', state: 'settled', amount_minor_units: '300' },
    { ...seed, id: 'released', state: 'released', amount_minor_units: '300' },
    { ...seed, id: 'foreign-tenant', tenant_id: 'tenant-other', amount_minor_units: '400' },
    { ...seed, id: 'foreign-currency', currency: 'EUR', amount_minor_units: '400' },
  );
  for (const [refundOrderId, refundTenantId, refundCurrency, amount] of [
    ['refund-a', tenantId, currency, '50'],
    ['refund-b', tenantId, currency, '70'],
    ['refund-foreign-tenant', 'tenant-other', currency, '500'],
    ['refund-foreign-currency', tenantId, 'EUR', '500'],
  ] as const) {
    database.state.refundWalletFreezes.push({
      refund_order_id: refundOrderId,
      tenant_id: refundTenantId,
      wallet_id: wallet.id,
      currency: refundCurrency,
      amount_minor_units: amount,
    });
  }
  const stateBefore = structuredClone(database.state);
  const statements: string[] = [];
  const summary = await database.transaction((tx) =>
    service.getWallet(observeQueries(tx, statements), tenantId, currency),
  );
  assert.equal(summary.postedBalanceMinorUnits, 1000n);
  assert.equal(summary.activeHoldsMinorUnits, 60n);
  assert.equal(summary.activeRefundFreezesMinorUnits, 120n);
  assert.equal(summary.availableMinorUnits, 820n);
  assert.equal(summary.spendingFrozen, false);
  assert.equal(summary.spendingFreezeReference, null);
  assert.equal(statements.filter((sql) => sql.includes('as active_hold_minor_units')).length, 1);
  assert.equal(statements.filter((sql) => sql.includes('as active_refund_freeze_minor_units')).length, 1);
  assert.equal(
    statements.some((sql) => sql.includes('pg_advisory_xact_lock')),
    false,
  );
  assert.deepEqual(database.state, stateBefore);
});

test('combined wallet sums preserve zero values and integers beyond the JavaScript safe range', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  const maximum = 9_223_372_036_854_775_807n;
  await fund(database, service, maximum.toString());
  const empty = await database.transaction((tx) => service.getWallet(tx, tenantId, currency));
  assert.equal(empty.activeHoldsMinorUnits, 0n);
  assert.equal(empty.activeRefundFreezesMinorUnits, 0n);
  assert.equal(empty.availableMinorUnits, maximum);

  const hold = 9_007_199_254_740_993n;
  const refund = 9_007_199_254_740_995n;
  const first = await reserve(database, service, { amountMinorUnits: hold.toString() });
  assert.equal(first.activeHoldsMinorUnits, hold);
  await reserve(database, service, { requestId: 'request-small', businessKey: 'request-small', amountMinorUnits: '7' });
  const wallet = database.state.wallets[0];
  assert.ok(wallet);
  database.state.refundWalletFreezes.push({
    refund_order_id: 'large-refund',
    tenant_id: tenantId,
    wallet_id: wallet.id,
    currency,
    amount_minor_units: refund.toString(),
  });
  const summary = await database.transaction((tx) => service.getWallet(tx, tenantId, currency));
  assert.equal(summary.postedBalanceMinorUnits, maximum);
  assert.equal(summary.activeHoldsMinorUnits, hold + 7n);
  assert.equal(summary.activeRefundFreezesMinorUnits, refund);
  assert.equal(summary.availableMinorUnits, maximum - hold - 7n - refund);
});

test('combined wallet sums exclude only the fulfilled refund from the post-debit observation', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  await reserve(database, service, { amountMinorUnits: '40' });
  const wallet = database.state.wallets[0];
  assert.ok(wallet);
  for (const [refundOrderId, amount] of [
    ['refund-target', '40'],
    ['refund-other', '20'],
  ] as const) {
    database.state.refundWalletFreezes.push({
      refund_order_id: refundOrderId,
      tenant_id: tenantId,
      wallet_id: wallet.id,
      currency,
      amount_minor_units: amount,
    });
  }
  const observations: Array<{ values: readonly unknown[]; rows: readonly unknown[]; excluded: boolean }> = [];
  const posted = await database.transaction((tx) =>
    service.postVerifiedWalletRefund(
      {
        async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
          const result = await tx.query<Row>(sql, values);
          if (sql.includes('AS active_hold_minor_units') && sql.includes('AS active_refund_freeze_minor_units')) {
            observations.push({
              values: [...values],
              rows: result.rows,
              excluded: sql.includes('AND refund_order_id <> $3'),
            });
          }
          return result;
        },
      },
      { tenantId, currency, amountMinorUnits: '40', refundOrderId: 'refund-target' },
    ),
  );
  assert.deepEqual(observations, [
    {
      values: [tenantId, currency],
      rows: [
        {
          active_hold_minor_units: '40',
          active_refund_freeze_minor_units: '60',
          freeze_tenant_id: null,
          freeze_reason_ref: null,
          freeze_frozen_at: null,
        },
      ],
      excluded: false,
    },
    {
      values: [tenantId, currency, 'refund-target'],
      rows: [
        {
          active_hold_minor_units: '40',
          active_refund_freeze_minor_units: '20',
          freeze_tenant_id: null,
          freeze_reason_ref: null,
          freeze_frozen_at: null,
        },
      ],
      excluded: true,
    },
  ]);
  assert.equal(posted.wallet.postedBalanceMinorUnits, 60n);
  assert.equal(posted.wallet.activeHoldsMinorUnits, 40n);
  assert.equal(posted.wallet.activeRefundFreezesMinorUnits, 20n);
  assert.equal(posted.wallet.availableMinorUnits, 0n);
  assert.equal(database.state.refundWalletFreezes.length, 2);
});

test('combined wallet sum failures preserve safe billing errors and roll back either observation point', async (t) => {
  for (const failAt of [1, 2]) {
    for (const errorKind of ['billing', 'storage']) {
      await t.test(`${errorKind} error at summary ${failAt}`, async () => {
        const database = new FakeBillingDatabase();
        const service = createService();
        await fund(database, service, '100');
        const wallet = database.state.wallets[0]!;
        database.state.refundWalletFreezes.push({
          refund_order_id: 'failure-branch-refund',
          tenant_id: tenantId,
          wallet_id: wallet.id,
          currency,
          amount_minor_units: '10',
        });
        const stateBefore = structuredClone(database.state);
        const injected =
          errorKind === 'billing'
            ? new SaasBillingError('BILLING_STORAGE_ERROR')
            : new Error('private injected storage failure');
        const statements: string[] = [];
        let summaryReads = 0;
        await assert.rejects(
          database.transaction((tx) =>
            service.reserve(
              {
                async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
                  statements.push(sql.replace(/\s+/g, ' ').trim().toLowerCase());
                  if (
                    sql.includes('AS active_hold_minor_units') &&
                    sql.includes('AS active_refund_freeze_minor_units')
                  ) {
                    summaryReads += 1;
                    if (summaryReads === failAt) throw injected;
                  }
                  return tx.query<Row>(sql, values);
                },
              },
              reserveInput(),
            ),
          ),
          (error: unknown) => {
            assert.ok(error instanceof SaasBillingError);
            assert.equal(error.code, 'BILLING_STORAGE_ERROR');
            assert.equal(error.status, 500);
            if (errorKind === 'billing') assert.strictEqual(error, injected);
            else {
              assert.notStrictEqual(error, injected);
              assert.equal(error.message.includes('private injected'), false);
            }
            return true;
          },
        );
        assert.equal(summaryReads, failAt);
        assert.equal(
          statements.filter((sql) => sql.startsWith('insert into saas_billing_reservations')).length,
          failAt - 1,
        );
        assert.ok(statements.at(-1)?.includes('as active_hold_minor_units'));
        assert.ok(statements.at(-1)?.includes('as active_refund_freeze_minor_units'));
        assert.deepEqual(database.state, stateBefore);
      });
    }
  }
});

test('fresh reserve uses four statements and derives the post-insert zero-refund summary exactly', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '9223372036854775807');
  const statements: string[] = [];
  const value = await database.transaction((tx) =>
    service.reserve(observeQueries(tx, statements), reserveInput({ amountMinorUnits: '9007199254740993' })),
  );
  assert.equal(statements.length, 4);
  assert.equal(statements.filter((sql) => sql.includes('as active_hold_minor_units')).length, 1);
  assert.equal(value.activeHoldsMinorUnits, 9007199254740993n);
  assert.equal(value.availableMinorUnits, 9223372036854775807n - 9007199254740993n);
  assert.ok(statements[1]?.includes('pg_advisory_xact_lock'));
  assert.ok(statements[2]?.includes('billing:reserve-wallet-snapshot'));
});

test('nonzero refund snapshot keeps a fresh fifth read and observes an unfenced failed-refund deletion', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');
  const wallet = database.state.wallets[0]!;
  database.state.refundWalletFreezes.push({
    refund_order_id: 'concurrent-failed-refund',
    tenant_id: tenantId,
    wallet_id: wallet.id,
    currency,
    amount_minor_units: '10',
  });
  const statements: string[] = [];
  const value = await database.transaction((tx) =>
    service.reserve(
      {
        async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
          statements.push(sql);
          const result = await tx.query<Row>(sql, values);
          if (sql.startsWith('INSERT INTO saas_billing_reservations')) database.state.refundWalletFreezes.length = 0;
          return result;
        },
      },
      reserveInput(),
    ),
  );
  assert.equal(statements.length, 5);
  assert.equal(value.activeHoldsMinorUnits, 40n);
  assert.equal(value.availableMinorUnits, 60n);
  assert.ok(statements.at(-1)?.includes('AS active_refund_freeze_minor_units'));
});

test('positive settlement batches six round trips under the wallet fence without caching final funds', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);
  await reserve(database, service);
  const statements: string[] = [];
  const settled = await database.transaction((tx) => service.settle(observeQueries(tx, statements), settlementInput()));
  assert.equal(statements.length, 9);
  const fence = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
  assert.equal(fence, 1);
  assert.equal(statements.length - fence - 1, 7, 'seven operations after the wallet fence, formerly thirteen');
  assert.equal(statements.filter((sql) => sql.includes('billing:post-ledger-pair')).length, 1);
  assert.equal(statements.filter((sql) => sql.includes('billing:project-ledger')).length, 1);
  const summaries = statements.filter((sql) => sql.includes('as active_hold_minor_units'));
  assert.equal(summaries.length, 2, 'fresh pre-charge and post-settlement observations are retained');
  assert.ok(summaries.every((sql) => sql.includes('left join saas_billing_spending_freezes')));
  assert.equal(settled.walletPostedBalanceMinorUnits, 80n);
  assert.equal(settled.activeHoldsMinorUnits, 0n);
  assert.equal(database.state.entries.length, 4);
});

test('staged reserve caches no financial facts and is single-use', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);
  const statements: string[] = [];
  await database.transaction(async (tx) => {
    const apply = await service.prepareReserve(observeQueries(tx, statements), reserveInput());
    assert.equal(statements.length, 1);
    assert.ok(!statements[0]?.includes('pg_advisory'));
    database.state.freezes.push({
      tenant_id: tenantId,
      reason_ref: 'after-staging',
      frozen_at: '2026-09-28T00:00:00.000Z',
    });
    await assert.rejects(
      apply,
      (error: unknown) => error instanceof SaasBillingError && error.code === 'SPENDING_FROZEN',
    );
    const failedCount = statements.length;
    await assert.rejects(
      apply,
      (error: unknown) => error instanceof SaasBillingError && error.code === 'BILLING_STORAGE_ERROR',
    );
    assert.equal(statements.length, failedCount, 'a repeated closure performs no further SQL');
    assert.equal(database.state.reservations.length, 0);
  });
});

test('staged reserve rechecks later holds and rejects delayed expiry before taking locks', async () => {
  const database = new FakeBillingDatabase();
  let now = new Date('2026-09-28T00:00:00.000Z');
  const service = new PlatformWalletLedgerService({ now: () => now });
  await fund(database, service);
  await database.transaction(async (tx) => {
    const apply = await service.prepareReserve(tx, reserveInput({ amountMinorUnits: '80' }));
    await service.reserve(
      tx,
      reserveInput({ businessKey: 'competing', requestId: 'request-competing', amountMinorUnits: '30' }),
    );
    await assert.rejects(
      apply,
      (error: unknown) => error instanceof SaasBillingError && error.code === 'INSUFFICIENT_FUNDS',
    );
    const queries: string[] = [];
    const delayed = await service.prepareReserve(observeQueries(tx, queries), reserveInput());
    now = new Date('2026-09-28T01:00:01.000Z');
    await assert.rejects(
      delayed,
      (error: unknown) => error instanceof SaasBillingError && error.code === 'INVALID_INPUT',
    );
    assert.equal(queries.length, 1, 'expired staged input fails before acquiring locks');
  });
});

test('staged reserve captures immutable input and only a copied existing wallet identity hint', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);
  const reserved = await reserve(database, service);
  await database.transaction(async (tx) => {
    const input = { ...reserveInput() };
    let observedRow: Record<string, unknown> | undefined;
    const apply = await service.prepareReserve(
      {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
          const result = await tx.query<Row>(sql, values);
          if (sql.includes('FROM saas_billing_reservations') && !sql.includes('FOR UPDATE')) {
            observedRow = result.rows[0] as Record<string, unknown>;
          }
          return result;
        },
      },
      input,
    );
    input.currency = 'EUR';
    input.amountMinorUnits = '99';
    input.businessKey = 'mutated-business-key';
    assert.ok(observedRow);
    observedRow.tenant_id = 'mutated-tenant';
    observedRow.currency = 'EUR';
    observedRow.state = 'settled';
    const replay = await apply();
    assert.equal(replay.id, reserved.id);
    assert.equal(replay.state, 'reserved');
    assert.equal(replay.currency, 'USD');
    assert.equal(replay.amountMinorUnits, 40n);
    assert.equal(replay.availableMinorUnits, 60n);
  });
});
