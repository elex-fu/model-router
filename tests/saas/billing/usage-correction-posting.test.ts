import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SaasBillingError } from '../../../src/saas/billing/errors.js';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { FakeBillingDatabase } from './fake-sql.js';

const tenantId = 'tenant-1';
const currency = 'USD';
const CORRECTION_DIGEST = 'a'.repeat(64);

function createService(): PlatformWalletLedgerService {
  let nextId = 0;
  return new PlatformWalletLedgerService({
    now: () => new Date('2026-10-10T00:00:00.000Z'),
    idFactory: () => `id-${++nextId}`,
  });
}

async function fund(
  database: FakeBillingDatabase,
  service: PlatformWalletLedgerService,
  amount = '100',
): Promise<void> {
  await database.transaction((tx) =>
    service.postVerifiedFunding(tx, {
      tenantId,
      currency,
      amountMinorUnits: amount,
      sourceOrderRef: 'order-1',
      idempotencyKey: 'funding-order-1',
    }),
  );
}

function correctionInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId,
    currency,
    amountDeltaMinorUnits: 25n,
    correctionEventId: 'correction-event-1',
    correctionDigest: CORRECTION_DIGEST,
    ...overrides,
  };
}

test('positive delta credits the wallet and posts balanced double-entry records', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  const result = await database.transaction((tx) => service.postUsageCorrection(tx, correctionInput()));

  assert.equal(result.replayed, false);
  assert.equal(result.wallet.postedBalanceMinorUnits, 125n);
  const transactions = database.state.transactions.filter((row) => row.source_type === 'usage_correction');
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0]?.idempotency_namespace, 'metering.usage-correction');
  assert.equal(transactions[0]?.business_key, CORRECTION_DIGEST);
  assert.equal(transactions[0]?.amount_minor_units, '25');
  assert.equal(transactions[0]?.metadata_ref, CORRECTION_DIGEST);
  assert.equal(transactions[0]?.source_order_ref, 'usage-correction:correction-event-1');
  const entries = database.state.entries.filter((row) => row.transaction_id === result.transactionId);
  assert.equal(entries.length, 2);
  const walletEntry = entries.find((row) => row.account_type === 'wallet');
  const revenueEntry = entries.find((row) => row.account_type === 'billing_revenue');
  assert.equal(walletEntry?.direction, 'credit');
  assert.equal(revenueEntry?.direction, 'debit');
  assert.equal(revenueEntry?.account_ref, 'correction-event-1');
});

test('negative delta debits the wallet', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  const result = await database.transaction((tx) =>
    service.postUsageCorrection(tx, correctionInput({ amountDeltaMinorUnits: -30n })),
  );

  assert.equal(result.replayed, false);
  assert.equal(result.wallet.postedBalanceMinorUnits, 70n);
  const entries = database.state.entries.filter((row) => row.transaction_id === result.transactionId);
  const walletEntry = entries.find((row) => row.account_type === 'wallet');
  assert.equal(walletEntry?.direction, 'debit');
  assert.equal(walletEntry?.amount_minor_units, '30');
});

test('negative delta that would overdraw the wallet fails closed', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  await assert.rejects(
    database.transaction((tx) => service.postUsageCorrection(tx, correctionInput({ amountDeltaMinorUnits: -150n }))),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INSUFFICIENT_FUNDS',
  );
  const wallet = await database.transaction((tx) => service.getWallet(tx, tenantId, currency));
  assert.equal(wallet.postedBalanceMinorUnits, 100n);
});

test('the same correction digest replays without a second posting', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  const first = await database.transaction((tx) => service.postUsageCorrection(tx, correctionInput()));
  const second = await database.transaction((tx) => service.postUsageCorrection(tx, correctionInput()));

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(database.state.transactions.filter((row) => row.source_type === 'usage_correction').length, 1);
  assert.equal(second.wallet.postedBalanceMinorUnits, 125n);
});

test('a different digest with the same correction event is a distinct posting', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  await database.transaction((tx) => service.postUsageCorrection(tx, correctionInput()));
  const second = await database.transaction((tx) =>
    service.postUsageCorrection(
      tx,
      correctionInput({ correctionDigest: 'b'.repeat(64), correctionEventId: 'correction-event-2' }),
    ),
  );

  assert.equal(second.replayed, false);
  assert.equal(database.state.transactions.filter((row) => row.source_type === 'usage_correction').length, 2);
});

test('zero delta and malformed input are rejected before any write', async () => {
  const database = new FakeBillingDatabase();
  const service = createService();
  await fund(database, service);

  await assert.rejects(
    database.transaction((tx) => service.postUsageCorrection(tx, correctionInput({ amountDeltaMinorUnits: 0n }))),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INVALID_INPUT',
  );
  await assert.rejects(
    database.transaction((tx) =>
      service.postUsageCorrection(tx, correctionInput({ amountDeltaMinorUnits: 1.5 as unknown as bigint })),
    ),
    (error: unknown) => error instanceof SaasBillingError && error.code === 'INVALID_INPUT',
  );
  assert.equal(database.state.transactions.length, 1);
});
