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

test('spending freezes use the wallet fence before reservation locks without UPDATE row-lock rights', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service, '100');

  const statements: string[] = [];
  await database.transaction((tx) => service.reserve(observeQueries(tx, statements), reserveInput()));

  const walletLock = statements.findIndex((sql) => sql.includes('from saas_wallets') && sql.includes('for update'));
  const freezeRead = statements.find((sql) => sql.includes('from saas_billing_spending_freezes'));
  const reservationLock = statements.findIndex(
    (sql) => sql.includes('from saas_billing_reservations') && sql.includes('for update'),
  );
  assert.ok(walletLock >= 0);
  assert.ok(freezeRead);
  assert.ok(!freezeRead.includes('for update'));
  assert.ok(reservationLock > walletLock);
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
  const walletLock = statements.findIndex((sql) => sql.includes('from saas_wallets') && sql.includes('for update'));
  const refundFreezeRead = statements.findIndex((sql) => sql.includes('from saas_refund_wallet_freezes'));
  assert.ok(walletLock >= 0);
  assert.ok(refundFreezeRead > walletLock);
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
  const replayWalletLock = statements.findIndex(
    (sql) => sql.includes('from saas_wallets') && sql.includes('for update'),
  );
  const identityReadIndex = statements.findIndex(
    (sql) => sql.includes('from saas_ledger_transactions') && sql.includes('business_key'),
  );
  assert.ok(identityRead);
  assert.ok(!identityRead.includes('for update'));
  assert.ok(replayWalletLock >= 0 && replayWalletLock < identityReadIndex);

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
  const conflictWalletLock = statements.findIndex(
    (sql) => sql.includes('from saas_wallets') && sql.includes('for update'),
  );
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
        query<Row>(sql, values = []) {
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
