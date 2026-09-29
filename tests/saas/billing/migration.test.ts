import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLATFORM_WALLET_LEDGER_SAAS_MIGRATION } from '../../../src/saas/db/migrations/011_platform_wallet_ledger.js';

test('migration 011 defines the platform wallet, holds, append-only ledger, and deferred balance checks', () => {
  const migration = PLATFORM_WALLET_LEDGER_SAAS_MIGRATION;
  assert.equal(migration.version, 11);
  assert.equal(migration.name, 'platform_wallet_billing_reservation_ledger');
  assert.match(migration.sql, /CREATE TABLE saas_wallets/);
  assert.match(migration.sql, /tenant_currency_unique UNIQUE \(tenant_id, currency\)/);
  assert.match(migration.sql, /posted_balance_minor_units bigint/);
  assert.match(migration.sql, /CREATE TABLE saas_billing_reservations/);
  assert.match(migration.sql, /state IN \('reserved', 'settled', 'released', 'reconciliation_pending'\)/);
  assert.match(migration.sql, /state IN \('reserved', 'reconciliation_pending'\)/);
  assert.match(migration.sql, /CREATE TABLE saas_ledger_transactions/);
  assert.match(migration.sql, /CREATE TABLE saas_ledger_entries/);
  assert.match(migration.sql, /amount_minor_units bigint NOT NULL\s+CHECK \(amount_minor_units > 0\)/);
  assert.match(migration.sql, /CREATE TRIGGER saas_ledger_transactions_immutable/);
  assert.match(migration.sql, /CREATE TRIGGER saas_ledger_entries_immutable/);
  assert.match(migration.sql, /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(migration.sql, /saas_billing_assert_ledger_transaction_balanced/);
  assert.match(migration.sql, /Wallet balance may only change with a ledger transaction/);
  assert.match(migration.sql, /CREATE UNIQUE INDEX saas_billing_reservations_idempotency_unique/);
});
