import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../../src/saas/billing/service.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlResult } from '../../../../src/saas/db/types.js';
import {
  createFastGatewayJournal,
  type FastIntent,
  fastJournalCanonicalJson,
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
        'fast-journal:worker-ledger',
        'fast-journal:worker-wallet',
        'fast-journal:worker-credit',
        'fast-journal:worker-complete',
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
  await t.test(
    'a true worker batch amortizes wallet fencing and ledger writes without weakening per-intent dedup',
    async () => {
      const { tenantId, owner, journal } = await setup('10000');
      const inputs = Array.from({ length: 40 }, () => intentFixture(tenantId, owner, priceFixture('10')));
      const intents = await Promise.all(inputs.map((input) => reserve(journal, input)));
      await Promise.all(intents.map((intent) => journal.appendReceipt(receiptFixture(intent, '7'))));
      const statements: string[] = [];
      const measured: SaasDatabase = {
        ...gateway,
        transaction: (work) =>
          gateway.transaction((tx) =>
            work({
              query: <Row>(sql: string, values?: readonly unknown[]) => {
                statements.push(sql);
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      };
      const worker = new PostgresFastGatewayJournal(measured, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
      });
      assert.equal(await worker.runOnce(128), 40);
      assert.equal(
        statements.length,
        8,
        'one claim/read/fence/allocation read/ledger/wallet/credit/completion for the entire wallet batch',
      );
      assert.equal((await facts(tenantId)).charges, '40');
      assert.equal((await facts(tenantId)).balance, '9720');
      assert.equal(await worker.runOnce(), 0);
      await journal.close();
      await worker.close();
    },
  );

  await t.test(
    'SIGKILL at real journal and worker boundaries retains durable replay and never duplicates a debit',
    { timeout: 60_000 },
    async () => {
      async function killAt(boundary: string, payload: Record<string, unknown> = {}) {
        const child = fork(resolve('tests/saas/gateway/fast/journal-crash-child.ts'), [], {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: process.env,
        });
        let diagnostics = '';
        child.stderr?.on('data', (bytes) => {
          diagnostics += bytes.toString();
        });
        const waitMessage = () =>
          new Promise<{ kind: string }>((resolve, reject) => {
            const timeout = setTimeout(() => {
              child.kill('SIGKILL');
              reject(new Error(`child timeout: ${diagnostics}`));
            }, 10_000);
            child.once('message', (message) => {
              clearTimeout(timeout);
              resolve(message as { kind: string });
            });
            child.once('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            child.once('exit', (code, signal) => {
              clearTimeout(timeout);
              reject(new Error(`child exited ${code}/${signal}: ${diagnostics}`));
            });
          });
        assert.equal((await waitMessage()).kind, 'ready');
        const paused = waitMessage();
        child.send(JSON.parse(fastJournalCanonicalJson({ boundary, ...payload })));
        assert.equal((await paused).kind, 'paused');
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        const [, signal] = await exited;
        assert.equal(signal, 'SIGKILL');
      }
      for (const boundary of [
        'fast-journal:worker-claim',
        'fast-journal:worker-ledger',
        'fast-journal:worker-wallet',
        'fast-journal:worker-credit',
        'fast-journal:worker-complete',
      ]) {
        const { tenantId, owner, journal } = await setup();
        const intent = await reserve(journal, intentFixture(tenantId, owner));
        await journal.appendReceipt(receiptFixture(intent));
        await killAt(boundary);
        assert.deepEqual(await facts(tenantId), {
          balance: '100',
          backing: '100',
          available: '20',
          intents: '1',
          charges: '0',
          completed: '0',
        });
        await journal.runOnce();
        await journal.runOnce();
        assert.equal((await facts(tenantId)).balance, '80');
        assert.equal((await facts(tenantId)).charges, '1');
        await journal.close();
      }
      const receiptFixtureScope = await setup();
      const intent = await reserve(
        receiptFixtureScope.journal,
        intentFixture(receiptFixtureScope.tenantId, receiptFixtureScope.owner),
      );
      const receipt = receiptFixture(intent);
      await killAt('fast-journal:append-receipt', { receipt });
      await receiptFixtureScope.journal.appendReceipt(receipt);
      await receiptFixtureScope.journal.runOnce();
      assert.equal((await facts(receiptFixtureScope.tenantId)).charges, '1');
      await receiptFixtureScope.journal.close();

      const intentScope = await setup();
      const input = intentFixture(intentScope.tenantId, intentScope.owner);
      await killAt('fast-journal:reserve-intent', { intent: input });
      assert.equal((await intentScope.journal.reserveIntent(input)).kind, 'existing');
      const restarted = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: intentScope.owner,
        allocationTrancheMinorUnits: '100',
      });
      await restarted.replenish(intentScope.tenantId, 'USD');
      await restarted.close();
      assert.equal(
        (await facts(intentScope.tenantId)).backing,
        '80',
        'no terminal receipt: the unknown hold survives process death and generation retirement',
      );
      assert.equal((await facts(intentScope.tenantId)).charges, '0');
    },
  );

  await t.test('BYOK uses the same durable intent and receipt without a wallet or ledger charge', async () => {
    const tenantId = randomUUID();
    const owner = randomUUID();
    await migrator.query("INSERT INTO saas_tenants(id,name,slug) VALUES ($1,'byok-journal-test',$2)", [
      tenantId,
      tenantId,
    ]);
    const journal = new PostgresFastGatewayJournal(gateway, {
      allocationOwner: owner,
      allocationTrancheMinorUnits: '100',
    });
    const input = { ...intentFixture(tenantId, owner), currency: null, priceSnapshot: null, maxCostMinorUnits: '0' };
    const intent = await reserve(journal, input);
    await journal.appendReceipt(receiptFixture(intent, '0'));
    assert.equal(await journal.runOnce(), 1);
    const count = await gateway.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM saas_ledger_transactions WHERE tenant_id=$1',
      [tenantId],
    );
    assert.equal(count.rows[0]?.n, '0');
    await journal.close();
  });
  await t.test(
    'opposite-order concurrent multi-wallet batches preserve every ledger pair and recover a lost COMMIT acknowledgment',
    async () => {
      const left = await setup('1000');
      const right = await setup('1000');
      for (let index = 0; index < 12; index++) {
        for (const scope of index % 2 ? [left, right] : [right, left]) {
          const intent = await reserve(scope.journal, intentFixture(scope.tenantId, scope.owner, priceFixture('10')));
          await scope.journal.appendReceipt(receiptFixture(intent, '7'));
        }
      }
      let lost = true;
      const uncertain: SaasDatabase = {
        ...gateway,
        transaction: async (work) => {
          const result = await gateway.transaction(work);
          if (lost) {
            lost = false;
            throw new Error('lost batch COMMIT ACK');
          }
          return result;
        },
      };
      const first = new PostgresFastGatewayJournal(uncertain, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
      });
      const second = new PostgresFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
      });
      const outcomes = await Promise.allSettled([first.runOnce(7), second.runOnce(7)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
      await Promise.all([first.drain(), second.drain()]);
      for (const scope of [left, right]) {
        assert.equal((await facts(scope.tenantId)).charges, '12');
        assert.equal((await facts(scope.tenantId)).balance, '916');
        const balance = await migrator.query<{ debit: string; credit: string }>(
          `SELECT
        SUM(e.amount_minor_units) FILTER(WHERE e.direction='debit')::text AS debit,
        SUM(e.amount_minor_units) FILTER(WHERE e.direction='credit')::text AS credit
        FROM saas_ledger_entries e JOIN saas_ledger_transactions l ON l.id=e.transaction_id
        WHERE l.tenant_id=$1 AND l.idempotency_namespace='fast-journal-v1'`,
          [scope.tenantId],
        );
        assert.deepEqual(balance.rows[0], { debit: '84', credit: '84' });
        await scope.journal.close();
      }
      await first.close();
      await second.close();
    },
  );

  await t.test(
    'automatic worker wakes from idle backoff without a RAM work queue or postponing a continuous receipt stream',
    async () => {
      const { tenantId, owner, journal } = await setup('1000');
      const worker = createFastGatewayJournal(gateway, {
        allocationOwner: randomUUID(),
        allocationTrancheMinorUnits: '100',
        workerPollMs: 10,
      });
      const intent = await reserve(journal, intentFixture(tenantId, owner));
      await journal.appendReceipt(receiptFixture(intent));
      const deadline = Date.now() + 3000;
      while ((await facts(tenantId)).completed !== '1' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        (await facts(tenantId)).completed,
        '1',
        'a different process owner discovers durable jobs even without a local notification',
      );
      await worker.close();
      await journal.close();
    },
  );
});
