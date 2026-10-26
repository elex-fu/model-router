import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
import { FastGatewayResolutionService } from '../../../../src/saas/gateway/fast/resolution.js';
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
  const control = createSaasDatabase({ connectionString: urls[1], max: 4 });
  t.after(async () => {
    await control.close();
    await gateway.close();
    await migrator.close();
  });
  await gateway.verifySchema();
  const billing = new PlatformWalletLedgerService();
  async function setup(
    balance = '100',
    tranche = balance,
    owner = randomUUID(),
    db = gateway,
    stripes = 1,
    prewarm = true,
    automatic = false,
  ) {
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
      ...(automatic ? {} : { allocationTrancheMinorUnits: tranche }),
      allocationStripes: stripes,
    });
    if (prewarm) await journal.replenish(tenantId, 'USD');
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
      await receipts.appendReceipt(receipt); // exact retry verifies the committed row before returning success
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
  await t.test(
    'only exact trusted definitely-unsent receipts release active or retired credit; provider failures stay backed',
    async () => {
      for (const retired of [false, true]) {
        const { tenantId, owner, journal } = await setup();
        const intent = await reserve(journal, intentFixture(tenantId, owner));
        if (retired) await journal.retireAllocations();
        const receipt = {
          ...receiptFixture(intent),
          outcome: 'failed' as const,
          chargeMinorUnits: '0',
          httpStatus: null,
          usage: {},
        };
        await journal.appendReceipt(receipt);
        await journal.appendReceipt(receipt);
        await journal.runOnce();
        await journal.runOnce();
        const current = await facts(tenantId);
        assert.equal(current.balance, '100');
        assert.equal(current.charges, '0');
        assert.equal(current.completed, '1');
        assert.equal(current.backing, retired ? '0' : '100');
        assert.equal(current.available, retired ? '0' : '100');
        await journal.close();
      }
      const { tenantId, owner, journal } = await setup();
      const intent = await reserve(journal, intentFixture(tenantId, owner));
      await journal.appendReceipt({
        ...receiptFixture(intent),
        outcome: 'failed',
        chargeMinorUnits: '0',
        httpStatus: 500,
        usage: {},
      });
      await journal.close();
      assert.equal((await facts(tenantId)).backing, '80');
    },
  );
  await t.test(
    'eight stripes conserve one tranche under uniform, adversarial skew and near-tranche rebalancing',
    async () => {
      for (const skewed of [false, true]) {
        const scope = await setup('2560', '2560', randomUUID(), gateway, 8);
        const requests = Array.from({ length: 32 }, () => {
          let input = intentFixture(scope.tenantId, scope.owner);
          if (skewed)
            while (createHash('sha256').update(input.requestId).digest().readUInt32BE(0) % 8 !== 0)
              input = { ...input, requestId: randomUUID() };
          return input;
        });
        const results = await Promise.all(requests.map((input) => scope.journal.reserveIntent(input)));
        assert.equal(
          results.filter((result) => result.kind === 'created').length,
          32,
          'all global capacity remains usable despite hash skew',
        );
        assert.equal((await facts(scope.tenantId)).backing, '2560');
        assert.equal((await facts(scope.tenantId)).available, '0');
        assert.equal((await scope.journal.reserveIntent(intentFixture(scope.tenantId, scope.owner))).kind, 'denied');
        const distribution = await gateway.query<{ stripes: string }>(
          'SELECT count(DISTINCT allocation_id)::text AS stripes FROM saas_fast_gateway_intents WHERE tenant_id=$1',
          [scope.tenantId],
        );
        assert.equal(distribution.rows[0]?.stripes, '8');
        await Promise.all(
          results.map((result) =>
            result.kind === 'created' ? scope.journal.appendReceipt(receiptFixture(result.intent)) : Promise.resolve(),
          ),
        );
        await scope.journal.drain();
        assert.equal((await facts(scope.tenantId)).balance, '1920');
        await scope.journal.close();
      }
      const small = await setup('100', '100', randomUUID(), gateway, 8);
      const input = intentFixture(small.tenantId, small.owner);
      const intent = await reserve(small.journal, input);
      assert.equal((await facts(small.tenantId)).backing, '100');
      assert.equal((await facts(small.tenantId)).available, '20');
      await small.journal.appendReceipt(receiptFixture(intent));
      await small.journal.drain();
      await small.journal.close();
    },
  );
  await t.test(
    'two striped owners admit c32 varying maxima with delayed receipts at normal and sustained tranche budgets',
    async () => {
      for (const tranche of ['1000000', '1000000000']) {
        const initial = (BigInt(tranche) * 2n).toString();
        const a = await setup(initial, tranche, randomUUID(), gateway, 8);
        const otherOwner = randomUUID();
        const b = new PostgresFastGatewayJournal(gateway, {
          allocationOwner: otherOwner,
          allocationTrancheMinorUnits: tranche,
        });
        await b.replenish(a.tenantId, 'USD', '30720');
        const requests = [a.journal, b].flatMap((journal, index) =>
          Array.from({ length: 32 }, (_, i) => ({
            journal,
            input: intentFixture(
              a.tenantId,
              index === 0 ? a.owner : otherOwner,
              priceFixture(['10000', '20480', '30720'][i % 3]),
            ),
          })),
        );
        const results = await Promise.all(
          requests.map(async (request) => ({ ...request, result: await request.journal.reserveIntent(request.input) })),
        );
        assert.equal(
          results.filter(({ result }) => result.kind === 'created').length,
          64,
          'ample globally-backed c32 per owner must not have false denials',
        );
        const maximum = requests.reduce((sum, { input }) => sum + BigInt(input.maxCostMinorUnits), 0n);
        assert.equal((await facts(a.tenantId)).backing, initial);
        assert.equal((await facts(a.tenantId)).available, (BigInt(initial) - maximum).toString());
        assert.equal((await a.journal.reserveIntent(requests[0].input)).kind, 'existing');
        await Promise.all([a.journal.replenish(a.tenantId, 'USD'), b.replenish(a.tenantId, 'USD')]);
        assert.equal(
          (await facts(a.tenantId)).backing,
          initial,
          'refill/rebalance cannot multiply total tranche or release unresolved money',
        );
        assert.equal((await facts(a.tenantId)).available, (BigInt(initial) - maximum).toString());
        await new Promise((resolve) => setTimeout(resolve, 25));
        await Promise.all(
          results.map(({ journal, result }) =>
            result.kind === 'created' ? journal.appendReceipt(receiptFixture(result.intent)) : Promise.resolve(),
          ),
        );
        await Promise.all([a.journal.runOnce(), b.runOnce()]);
        assert.equal((await facts(a.tenantId)).balance, (BigInt(initial) - 1280n).toString());
        assert.equal((await facts(a.tenantId)).charges, '64');
        await Promise.all([a.journal.close(), b.close()]);
        assert.equal((await facts(a.tenantId)).backing, '0');
      }
    },
  );
  await t.test(
    'cold funded c32 shares one preparation transaction, warm admission stays one SQL, and cold expiry writes no intent',
    async () => {
      let transactions = 0,
        intentStatements = 0;
      const measured: SaasDatabase = {
        ...gateway,
        query: <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
          if (sql.includes('fast-journal:reserve-intent')) intentStatements++;
          return gateway.query<Row>(sql, values);
        },
        transaction: (work) => {
          transactions++;
          return gateway.transaction(work);
        },
      };
      const scope = await setup('1000000', '1000000', randomUUID(), measured, 8, false);
      const results = await Promise.all(
        Array.from({ length: 32 }, (_, i) =>
          scope.journal.reserveIntent(
            intentFixture(scope.tenantId, scope.owner, priceFixture(['10000', '20480', '30720'][i % 3])),
          ),
        ),
      );
      assert.equal(results.filter((result) => result.kind === 'created').length, 32);
      assert.equal(transactions, 1, 'funded first admissions singleflight the cold preparation');
      assert.equal(intentStatements, 32);
      const warm = await scope.journal.reserveIntent(intentFixture(scope.tenantId, scope.owner, priceFixture('20480')));
      assert.equal(warm.kind, 'created');
      assert.equal(transactions, 1, 'warm credit hints never add a SQL readiness check');
      assert.equal(intentStatements, 33);
      await Promise.all(
        [...results, warm].map((result) =>
          result.kind === 'created' ? scope.journal.appendReceipt(receiptFixture(result.intent)) : Promise.resolve(),
        ),
      );
      await scope.journal.close();
      const delayed: SaasDatabase = {
        ...gateway,
        transaction: async (work) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return gateway.transaction(work);
        },
      };
      const expired = await setup('100', '100', randomUUID(), delayed, 8, false);
      const result = await expired.journal.reserveIntent({
        ...intentFixture(expired.tenantId, expired.owner),
        sendDeadlineMs: Date.now() + 30,
      });
      assert.deepEqual(result, { kind: 'denied', reason: 'send_deadline' });
      assert.equal((await facts(expired.tenantId)).intents, '0');
      await expired.journal.close();
      assert.equal((await facts(expired.tenantId)).backing, '0');
    },
  );
  await t.test(
    'unset cap auto-funds two trusted concurrency waves at builtin M without overriding explicit caps or legacy backing',
    async () => {
      const maximum = '524480';
      for (const concurrency of [32, 64]) {
        const target = BigInt(maximum) * BigInt(concurrency) * 2n;
        const auto = await setup('1000000000', 'unused', randomUUID(), gateway, 8, false, true);
        const request = () => ({
          ...intentFixture(auto.tenantId, auto.owner, priceFixture(maximum)),
          allocationTargetConcurrency: concurrency,
        });
        assert.deepEqual(
          await auto.journal.reserveIntent({
            ...intentFixture(auto.tenantId, auto.owner, priceFixture('80', '0', '0')),
            allocationTargetConcurrency: concurrency,
          }),
          { kind: 'denied', reason: 'strict_zero_maximum_required' },
        );
        assert.equal(
          (await facts(auto.tenantId)).intents,
          '0',
          'free platform must strict-fallback before fast admission',
        );
        await assert.rejects(
          auto.journal.reserveIntent(intentFixture(auto.tenantId, auto.owner, priceFixture(maximum))),
          /TRUSTED_CONCURRENCY_REQUIRED/,
        );
        for (const invalid of [0, 1.5, 1025, Infinity])
          await assert.rejects(
            auto.journal.reserveIntent({ ...request(), allocationTargetConcurrency: invalid }),
            /TRUSTED_CONCURRENCY_REQUIRED/,
          );
        const first = await Promise.all(
          Array.from({ length: concurrency }, () => auto.journal.reserveIntent(request())),
        );
        assert.equal(first.filter((result) => result.kind === 'created').length, concurrency);
        assert.equal((await facts(auto.tenantId)).backing, target.toString());
        const second = await Promise.all(
          Array.from({ length: concurrency }, () => auto.journal.reserveIntent(request())),
        );
        assert.equal(
          second.filter((result) => result.kind === 'created').length,
          concurrency,
          '2x policy includes one wave of receipt lag',
        );
        assert.equal((await facts(auto.tenantId)).available, '0');
        assert.equal(
          (await auto.journal.reserveIntent(request())).kind,
          'denied',
          'auto is a defined backed budget, not unbounded credit',
        );
        await Promise.all(
          [...first, ...second].map((result) =>
            result.kind === 'created' ? auto.journal.appendReceipt(receiptFixture(result.intent)) : Promise.resolve(),
          ),
        );
        await auto.journal.drain();
        assert.equal((await facts(auto.tenantId)).balance, (1000000000n - BigInt(concurrency) * 40n).toString());
        await auto.journal.close();
        assert.equal(
          (await facts(auto.tenantId)).backing,
          '0',
          'explicit shutdown retires unused escrow operationally',
        );
      }
      const concurrency = 32;

      const fixed = await setup('1000000000', '1000000', randomUUID(), gateway, 8, false);
      const fixedRequest = () => ({
        ...intentFixture(fixed.tenantId, fixed.owner, priceFixture(maximum)),
        allocationTargetConcurrency: concurrency,
      });
      const fixedFirst = await fixed.journal.reserveIntent(fixedRequest());
      assert.equal(fixedFirst.kind, 'created');
      assert.equal((await fixed.journal.reserveIntent(fixedRequest())).kind, 'denied');
      assert.equal((await facts(fixed.tenantId)).backing, '1000000', 'explicit cap is never multiplied');
      if (fixedFirst.kind === 'created') await fixed.journal.appendReceipt(receiptFixture(fixedFirst.intent));
      await fixed.journal.close();

      const limited = await setup('1000', 'unused', randomUUID(), gateway, 8, false, true);
      await gateway.transaction((tx) =>
        billing.reserve(tx, {
          supplyMode: 'platform',
          tenantId: limited.tenantId,
          requestId: randomUUID(),
          currency: 'USD',
          amountMinorUnits: '400',
          priceSnapshotRef: 'fixture',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          businessKey: randomUUID(),
        }),
      );
      const bounded = await limited.journal.reserveIntent({
        ...intentFixture(limited.tenantId, limited.owner),
        allocationTargetConcurrency: 32,
      });
      assert.equal(bounded.kind, 'created');
      assert.equal(
        (await facts(limited.tenantId)).backing,
        '600',
        'real wallet free funds, not desired target, bound allocation',
      );
      const anotherOwner = randomUUID();
      const another = new PostgresFastGatewayJournal(gateway, { allocationOwner: anotherOwner });
      const anotherInput = { ...intentFixture(limited.tenantId, anotherOwner), allocationTargetConcurrency: 32 };
      assert.equal(
        (await another.reserveIntent(anotherInput)).kind,
        'denied',
        'another owner cannot double allocate backing',
      );
      assert.equal((await facts(limited.tenantId)).backing, '600');
      await another.close();
      if (bounded.kind === 'created') await limited.journal.appendReceipt(receiptFixture(bounded.intent));
      await limited.journal.close();
    },
  );
  await t.test(
    'audited control-plane resolutions recover unknown, failed and missing receipts without changing original evidence',
    async () => {
      const actorUserId = randomUUID(),
        actorSessionId = randomUUID(),
        credentialId = randomUUID();
      await migrator.transaction(async (tx) => {
        await tx.query('INSERT INTO saas_users(id,email) VALUES($1,$2)', [actorUserId, `${actorUserId}@example.test`]);
        await tx.query("INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,'operations')", [
          actorUserId,
        ]);
        await tx.query(
          "INSERT INTO saas_mfa_credentials(id,user_id,kind,encrypted_secret,verified_at) VALUES($1,$2,'totp',decode('7b7d','hex'),clock_timestamp())",
          [credentialId, actorUserId],
        );
        await tx.query(
          "INSERT INTO saas_platform_sessions(id,user_id,credential_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')",
          [
            actorSessionId,
            actorUserId,
            credentialId,
            createHash('sha256').update(actorSessionId).digest('hex'),
            'c'.repeat(64),
          ],
        );
      });
      const service = new FastGatewayResolutionService(control);
      const resolution = (tenantId: string, intentId: string) => ({
        tenantId,
        intentId,
        actorUserId,
        actorSessionId,
        idempotencyKey: randomUUID(),
        kind: 'non_execution' as const,
        chargeMinorUnits: '0',
        usage: {},
        evidenceReference: 'provider-case:verified-not-executed',
        evidenceSha256: 'e'.repeat(64),
        supportTicketRef: 'support:synthetic-case',
        reason: 'Provider verified no execution; release the retained hard maximum.',
      });
      async function held(mode: 'unknown' | 'failed' | 'missing') {
        const scope = await setup();
        const intent = await reserve(scope.journal, {
          ...intentFixture(scope.tenantId, scope.owner),
          sendDeadlineMs: Date.now() + 100,
        });
        if (mode !== 'missing')
          await scope.journal.appendReceipt({
            ...receiptFixture(intent),
            outcome: mode,
            chargeMinorUnits: mode === 'unknown' ? null : '0',
            httpStatus: mode === 'failed' ? 500 : null,
            usage: {},
          });
        await scope.journal.retireAllocations();
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { ...scope, intent };
      }
      for (const mode of ['unknown', 'failed', 'missing'] as const) {
        const scope = await held(mode);
        const input = resolution(scope.tenantId, scope.intent.id);
        const [a, b] = await Promise.all([service.resolve(input), service.resolve(input)]);
        assert.equal(a.resolutionId, b.resolutionId);
        assert.equal(Number(a.replayed) + Number(b.replayed), 1);
        await scope.journal.runOnce();
        assert.equal((await service.resolve(input)).state, 'completed');
        assert.deepEqual(await facts(scope.tenantId), {
          balance: '100',
          backing: '0',
          available: '0',
          intents: '1',
          charges: '0',
          completed: '1',
        });
        const original = await gateway.query<{ outcome: string }>(
          'SELECT outcome FROM saas_fast_gateway_receipts WHERE intent_id=$1',
          [scope.intent.id],
        );
        assert.equal(original.rows[0]?.outcome, mode === 'missing' ? undefined : mode);
        if (mode === 'missing') {
          // Retain genuine late provider evidence without replacing the audited
          // resolution or posting a second financial outcome.
          await scope.journal.appendReceipt(receiptFixture(scope.intent));
          await scope.journal.runOnce();
          assert.equal((await facts(scope.tenantId)).charges, '0');
          assert.equal(
            (
              await gateway.query<{ outcome: string }>(
                'SELECT outcome FROM saas_fast_gateway_receipts WHERE intent_id=$1',
                [scope.intent.id],
              )
            ).rows[0]?.outcome,
            'succeeded',
          );
        }
        await assert.rejects(
          migrator.query("UPDATE saas_fast_gateway_resolutions SET reason='rewrite' WHERE id=$1", [a.resolutionId]),
          { code: '55000' },
        );
        await assert.rejects(
          control.query("UPDATE saas_fast_gateway_receipts SET outcome='succeeded' WHERE intent_id=$1", [
            scope.intent.id,
          ]),
          { code: '42501' },
        );
        await scope.journal.close();
      }
      const billed = await held('unknown');
      const receipt = receiptFixture(billed.intent);
      const input = {
        ...resolution(billed.tenantId, billed.intent.id),
        kind: 'verified_usage' as const,
        chargeMinorUnits: receipt.chargeMinorUnits ?? '0',
        usage: receipt.usage,
        evidenceReference: 'provider-case:verified-exact-usage',
      };
      let loseAck = true;
      const uncertain: SaasDatabase = {
        ...control,
        transaction: async (work) => {
          const result = await control.transaction(work);
          if (loseAck) {
            loseAck = false;
            throw new Error('lost resolution COMMIT ACK');
          }
          return result;
        },
      };
      await assert.rejects(new FastGatewayResolutionService(uncertain).resolve(input), /lost resolution COMMIT ACK/);
      assert.equal((await service.resolve(input)).replayed, true);
      await billed.journal.runOnce();
      await billed.journal.runOnce();
      assert.equal((await facts(billed.tenantId)).balance, '80');
      assert.equal((await facts(billed.tenantId)).charges, '1');
      assert.equal(
        (await service.getCase({ tenantId: billed.tenantId, intentId: billed.intent.id }))?.state,
        'completed',
      );
      await assert.rejects(service.resolve({ ...input, chargeMinorUnits: '21' }), { code: 'CONFLICT' });
      await billed.journal.close();

      const expiring = await held('unknown');
      let release!: () => void;
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const releaseLock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = migrator.transaction(async (tx) => {
        await tx.query('SELECT state FROM saas_fast_billing_jobs WHERE intent_id=$1 FOR UPDATE', [expiring.intent.id]);
        locked();
        await releaseLock;
      });
      await lockReady;
      await migrator.query(
        "UPDATE saas_platform_sessions SET expires_at=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",
        [actorSessionId],
      );
      let waiting!: () => void;
      const lockWait = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const delayed: SaasDatabase = {
        ...control,
        transaction: (work) =>
          control.transaction((tx) =>
            work({
              query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
                if (sql.startsWith('SELECT state FROM saas_fast_billing_jobs')) waiting();
                return tx.query<Row>(sql, values);
              },
            }),
          ),
      };
      const expired = assert.rejects(
        new FastGatewayResolutionService(delayed).resolve(resolution(expiring.tenantId, expiring.intent.id)),
        { code: 'FORBIDDEN' },
      );
      await lockWait;
      await new Promise((resolve) => setTimeout(resolve, 700));
      release();
      await blocker;
      await expired;
      assert.equal((await facts(expiring.tenantId)).backing, '80');
      assert.equal(
        (await service.getCase({ tenantId: expiring.tenantId, intentId: expiring.intent.id }))?.resolutionId,
        null,
      );
      await migrator.query(
        "UPDATE saas_platform_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [actorSessionId],
      );
      await expiring.journal.close();

      const unauthorized = await held('unknown');
      await migrator.query('UPDATE saas_platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
        actorSessionId,
      ]);
      await assert.rejects(service.resolve(resolution(unauthorized.tenantId, unauthorized.intent.id)), {
        code: 'FORBIDDEN',
      });
      assert.equal((await facts(unauthorized.tenantId)).backing, '80');
      const acl = await gateway.query<{ allowed: boolean }>(
        "SELECT has_column_privilege(current_user,'saas_fast_gateway_resolutions','id','INSERT') AS allowed",
      );
      assert.equal(acl.rows[0]?.allowed, false, 'gateway may read resolutions but cannot create operator evidence');
      await unauthorized.journal.close();
    },
  );
});
