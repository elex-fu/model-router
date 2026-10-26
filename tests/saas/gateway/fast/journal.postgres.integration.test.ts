import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../../src/saas/billing/service.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import {
  createFastGatewayJournal,
  type FastIntent,
  PostgresFastGatewayJournal,
} from '../../../../src/saas/gateway/fast/journal.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../../metering/normal-success-postgres-fixture.js';
import { intentFixture, priceFixture, receiptFixture } from './journal-fixture.js';

const enabled = process.env[REQUIRED_FLAG] === '1' || anyRoleConfigured;
test('fast money journal real PostgreSQL: atomic reserve, durable completion, exact idempotent settlement and legacy coexistence', {
  skip: !enabled,
  timeout: 120_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 8 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 16 });
  t.after(async () => {
    await gateway.close();
    await migrator.close();
  });
  await gateway.verifySchema();
  const billing = new PlatformWalletLedgerService();
  async function setup(balance = '100', tranche = balance, owner = randomUUID(), db = gateway) {
    const tenantId = randomUUID();
    await migrator.query("INSERT INTO saas_tenants(id,name,slug) VALUES ($1,'fast-journal-test',$2)", [
      tenantId,
      tenantId,
    ]);
    await migrator.transaction((tx) =>
      billing.postVerifiedFunding(tx, {
        tenantId,
        currency: 'USD',
        amountMinorUnits: balance,
        sourceOrderRef: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    const journal = new PostgresFastGatewayJournal(db, {
      allocationOwner: owner,
      allocationTrancheMinorUnits: tranche,
    });
    await journal.replenish(tenantId, 'USD');
    return { tenantId, owner, journal };
  }
  async function facts(tenantId: string) {
    return (
      await gateway.query<{
        balance: string;
        backing: string;
        available: string;
        intents: string;
        charges: string;
        completed: string;
      }>(
        `SELECT w.posted_balance_minor_units::text AS balance,
       (SELECT COALESCE(SUM(backing_minor_units),0)::text FROM saas_fast_credit_allocations WHERE tenant_id=$1) AS backing,
       (SELECT COALESCE(SUM(available_minor_units),0)::text FROM saas_fast_credit_allocations WHERE tenant_id=$1) AS available,
       (SELECT COUNT(*)::text FROM saas_fast_gateway_intents WHERE tenant_id=$1) AS intents,
       (SELECT COUNT(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1 AND idempotency_namespace='fast-journal-v1') AS charges,
       (SELECT COUNT(*)::text FROM saas_fast_billing_jobs j JOIN saas_fast_gateway_intents i ON i.id=j.intent_id WHERE i.tenant_id=$1 AND j.state='completed') AS completed
       FROM saas_wallets w WHERE w.tenant_id=$1 AND w.currency='USD'`,
        [tenantId],
      )
    ).rows[0];
  }
  async function reserve(
    journal: PostgresFastGatewayJournal,
    input: ReturnType<typeof intentFixture>,
  ): Promise<FastIntent> {
    const result = await journal.reserveIntent(input);
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('reserve denied');
    return result.intent;
  }
  await t.test(
    'same-wallet concurrent reservations cannot exceed escrow; strict holds and negative correction cannot spend backing',
    async () => {
      const { tenantId, owner, journal } = await setup();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => journal.reserveIntent(intentFixture(tenantId, owner))),
      );
      assert.equal(results.filter((r) => r.kind === 'created').length, 1);
      const before = await facts(tenantId);
      assert.equal(before.available, '20');
      assert.equal(before.backing, '100');
      const wallet = await gateway.transaction((tx) => billing.getWallet(tx, tenantId, 'USD'));
      assert.equal(wallet.availableMinorUnits, 0n);
      assert.equal(wallet.activeHoldsMinorUnits, 100n);
      await assert.rejects(
        gateway.transaction((tx) =>
          billing.reserve(tx, {
            supplyMode: 'platform',
            tenantId,
            requestId: randomUUID(),
            currency: 'USD',
            amountMinorUnits: '1',
            priceSnapshotRef: 'fixture',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            businessKey: randomUUID(),
          }),
        ),
        { code: 'INSUFFICIENT_FUNDS' },
      );
      await assert.rejects(
        gateway.transaction((tx) =>
          billing.postUsageCorrection(tx, {
            tenantId,
            currency: 'USD',
            amountDeltaMinorUnits: -1n,
            correctionEventId: randomUUID(),
            correctionDigest: randomUUID(),
          }),
        ),
        { code: 'INSUFFICIENT_FUNDS' },
      );
      assert.equal((await facts(tenantId)).balance, '100');
      await journal.close();
      assert.equal(
        (await facts(tenantId)).backing,
        '80',
        'retirement retains unresolved maximum, not TTL-based release',
      );
    },
  );
  await t.test(
    'same fingerprint duplicates roll back dependent CAS; immutable receipt conflict never double-charges',
    async () => {
      const { tenantId, owner, journal } = await setup();
      const input = intentFixture(tenantId, owner, priceFixture('10'));
      const results = await Promise.all(Array.from({ length: 8 }, () => journal.reserveIntent(input)));
      assert.equal(results.filter((r) => r.kind === 'created').length, 1);
      assert.equal(results.filter((r) => r.kind === 'existing').length, 7);
      const created = results.find((r) => r.kind === 'created');
      assert.ok(created && created.kind === 'created');
      assert.equal((await facts(tenantId)).available, '90');
      assert.deepEqual(await journal.reserveIntent({ ...input, requestFingerprint: 'c'.repeat(64) }), {
        kind: 'denied',
        reason: 'identity_conflict',
      });
      const receipt = receiptFixture(created.intent, '7');
      await Promise.all([journal.appendReceipt(receipt), journal.appendReceipt(receipt)]);
      await assert.rejects(journal.appendReceipt({ ...receipt, httpStatus: 201 }), /RECEIPT_CONFLICT/);
      await Promise.all([journal.runOnce(), journal.runOnce(), journal.runOnce()]);
      assert.deepEqual(await facts(tenantId), {
        balance: '93',
        backing: '93',
        available: '93',
        intents: '1',
        charges: '1',
        completed: '1',
      });
      await journal.close();
      assert.equal((await facts(tenantId)).backing, '0');
    },
  );
  await t.test(
    'lost intent ACK and stale owner epoch never issue a second upstream authority; late receipt releases retired maximum safely',
    async () => {
      let loseAck = false;
      const uncertain: SaasDatabase = {
        ...gateway,
        query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
          const result = await gateway.query<Row>(sql, values);
          if (loseAck && sql.includes('fast-journal:reserve-intent')) {
            loseAck = false;
            throw new Error('simulated lost commit ACK');
          }
          return result;
        },
      };
      const { tenantId, owner, journal } = await setup('100', '100', randomUUID(), uncertain);
      const input = intentFixture(tenantId, owner);
      loseAck = true;
      await assert.rejects(journal.reserveIntent(input), /lost commit ACK/);
      assert.equal((await journal.reserveIntent(input)).kind, 'existing');
      const saved = (
        await gateway.query<{ id: string }>('SELECT id FROM saas_fast_gateway_intents WHERE request_id=$1', [
          input.requestId,
        ])
      ).rows[0];
      const restarted = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: owner,
        allocationTrancheMinorUnits: '100',
      });
      await restarted.replenish(tenantId, 'USD');
      assert.equal((await journal.reserveIntent(intentFixture(tenantId, owner))).kind, 'denied');
      await restarted.appendReceipt(
        receiptFixture({
          id: saved.id,
          requestId: input.requestId,
          attemptId: input.attemptId,
          tenantId,
          maxCostMinorUnits: '80',
        }),
      );
      await restarted.runOnce();
      assert.equal((await facts(tenantId)).balance, '80');
      assert.equal((await facts(tenantId)).backing, '20');
      await restarted.close();
    },
  );
  await t.test(
    'receipt ACK loss is replayable and a worker crash after ledger insert, wallet debit or credit restoration rolls back every effect',
    async () => {
      const { tenantId, owner, journal } = await setup();
      const intent = await reserve(journal, intentFixture(tenantId, owner));
      let loseReceiptAck = true;
      const uncertain: SaasDatabase = {
        ...gateway,
        query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
          const result = await gateway.query<Row>(sql, values);
          if (loseReceiptAck && sql.includes('fast-journal:append-receipt')) {
            loseReceiptAck = false;
            throw new Error('lost receipt ACK');
          }
          return result;
        },
      };
      const receipts = new PostgresFastGatewayJournal(uncertain, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
      });
      const receipt = receiptFixture(intent);
      await assert.rejects(receipts.appendReceipt(receipt), /lost receipt ACK/);
      await receipts.appendReceipt(receipt);
      for (const boundary of [
        'INSERT INTO saas_ledger_entries',
        'UPDATE saas_wallets SET posted_balance',
        'SET backing_minor_units=backing_minor_units-$2',
        "SET state='completed'",
      ]) {
        const crashing: SaasDatabase = {
          ...gateway,
          transaction: (work) =>
            gateway.transaction((tx) =>
              work({
                query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
                  const result = await tx.query<Row>(sql, values);
                  if (sql.includes(boundary)) throw new Error('injected crash');
                  return result;
                },
              }),
            ),
        };
        const worker = new PostgresFastGatewayJournal(crashing, {
          allocationOwner: randomUUID(),
          allocationTrancheMinorUnits: '100',
        });
        await assert.rejects(worker.runOnce(), /injected crash/);
        assert.deepEqual(await facts(tenantId), {
          balance: '100',
          backing: '100',
          available: '20',
          intents: '1',
          charges: '0',
          completed: '0',
        });
      }
      await journal.runOnce();
      await journal.runOnce();
      assert.equal((await facts(tenantId)).charges, '1');
      assert.equal((await facts(tenantId)).balance, '80');
      await journal.close();
    },
  );
  await t.test(
    'unknown, missing receipt, oversized usage, price mismatch remain backed while durable worker factory settles successes automatically',
    async () => {
      const { tenantId, owner, journal } = await setup('1000');
      const first = await reserve(journal, intentFixture(tenantId, owner));
      await journal.appendReceipt({ ...receiptFixture(first), outcome: 'unknown', chargeMinorUnits: null });
      await reserve(journal, intentFixture(tenantId, owner));
      const mismatch = await reserve(journal, intentFixture(tenantId, owner));
      await journal.appendReceipt({ ...receiptFixture(mismatch), chargeMinorUnits: '1' });
      const good = await reserve(journal, intentFixture(tenantId, owner));
      await journal.appendReceipt(receiptFixture(good));
      const worker = createFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
        workerPollMs: 10,
      });
      await worker.drain();
      assert.equal((await facts(tenantId)).charges, '1');
      await journal.close();
      await worker.close();
      assert.equal((await facts(tenantId)).backing, '240');
    },
  );
  await t.test(
    'large exact financial values and multiple gateway escrows cannot overallocate the same wallet',
    async () => {
      const amount = '9007199254740993';
      const { tenantId, owner, journal } = await setup(amount);
      const other = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: amount,
      });
      await other.replenish(tenantId, 'USD');
      assert.equal((await facts(tenantId)).backing, amount);
      const intent = await reserve(journal, intentFixture(tenantId, owner, priceFixture(amount)));
      await journal.appendReceipt(receiptFixture(intent, amount));
      await Promise.all([journal.runOnce(), other.runOnce()]);
      assert.equal((await facts(tenantId)).balance, '0');
      assert.equal((await facts(tenantId)).backing, '0');
      await journal.close();
      await other.close();
    },
  );
});
