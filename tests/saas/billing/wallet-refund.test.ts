import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { FakeBillingDatabase } from './fake-sql.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000011';
const REFUND_ID = '00000000-0000-4000-8000-000000000012';

test('wallet refund freeze reduces available value and posts a balanced immutable contra-entry', async () => {
  const database = new FakeBillingDatabase();
  const ledger = new PlatformWalletLedgerService({
    now: () => new Date('2026-09-29T00:00:00.000Z'),
    idFactory: (() => {
      let index = 0;
      return () => `00000000-0000-4000-8000-${String(100 + index++).padStart(12, '0')}`;
    })(),
  });

  await database.transaction((tx) =>
    ledger.postVerifiedFunding(tx, {
      tenantId: TENANT_ID,
      currency: 'USD',
      amountMinorUnits: '1000',
      sourceOrderRef: 'original-funding-order',
      idempotencyKey: 'original-funding-order',
    }),
  );
  const wallet = database.state.wallets[0];
  if (!wallet) throw new Error('expected seeded wallet');
  database.state.refundWalletFreezes.push({
    refund_order_id: REFUND_ID,
    tenant_id: TENANT_ID,
    wallet_id: wallet.id,
    currency: 'USD',
    amount_minor_units: '400',
  });

  const frozenWallet = await database.transaction((tx) => ledger.getWallet(tx, TENANT_ID, 'USD'));
  assert.equal(frozenWallet.activeRefundFreezesMinorUnits, 400n);
  assert.equal(frozenWallet.availableMinorUnits, 600n);
  await assert.rejects(
    database.transaction((tx) =>
      ledger.reserve(tx, {
        supplyMode: 'platform',
        tenantId: TENANT_ID,
        requestId: 'held-request',
        currency: 'USD',
        amountMinorUnits: '601',
        priceSnapshotRef: 'price-v1',
        expiresAt: '2026-09-29T00:01:00.000Z',
        businessKey: 'held-request',
      }),
    ),
    (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_FUNDS',
  );
  await database.transaction((tx) =>
    ledger.reserve(tx, {
      supplyMode: 'platform',
      tenantId: TENANT_ID,
      requestId: 'compatible-hold',
      currency: 'USD',
      amountMinorUnits: '500',
      priceSnapshotRef: 'price-v1',
      expiresAt: '2026-09-29T00:01:00.000Z',
      businessKey: 'compatible-hold',
    }),
  );

  const posting = await database.transaction((tx) =>
    ledger.postVerifiedWalletRefund(tx, {
      tenantId: TENANT_ID,
      currency: 'USD',
      amountMinorUnits: '400',
      refundOrderId: REFUND_ID,
    }),
  );
  const transaction = database.state.transactions.find((row) => row.id === posting.transactionId);
  const entries = database.state.entries.filter((row) => row.transaction_id === posting.transactionId);
  assert.equal(transaction?.source_type, 'wallet_refund');
  assert.equal(entries.length, 2);
  assert.equal(
    entries
      .filter((entry) => entry.direction === 'debit')
      .reduce((sum, entry) => sum + BigInt(entry.amount_minor_units), 0n),
    400n,
  );
  assert.equal(
    entries
      .filter((entry) => entry.direction === 'credit')
      .reduce((sum, entry) => sum + BigInt(entry.amount_minor_units), 0n),
    400n,
  );
  assert.equal(posting.wallet.availableMinorUnits, 100n);
  assert.equal(database.state.wallets[0]?.posted_balance_minor_units, '600');
});
