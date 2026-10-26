import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../../src/saas/billing/service.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import { type FastIntent, PostgresFastGatewayJournal } from '../../../../src/saas/gateway/fast/journal.js';
import { FastGatewayResolutionService } from '../../../../src/saas/gateway/fast/resolution.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../../metering/normal-success-postgres-fixture.js';
import { intentFixture, receiptFixture } from './journal-fixture.js';

const enabled = process.env[REQUIRED_FLAG] === '1' || anyRoleConfigured;
test('versioned fast resolution preserves immutable paid evidence and retained liability', {
  skip: !enabled,
  timeout: 120_000,
}, async (t) => {
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 4 });
  const control = createSaasDatabase({ connectionString: urls[1], max: 4 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 4 });
  const journals: PostgresFastGatewayJournal[] = [];
  t.after(async () => {
    for (const journal of journals) await journal.close();
    await Promise.all([migrator.close(), control.close(), gateway.close()]);
  });
  await gateway.verifySchema();
  const actorUserId = randomUUID(),
    actorSessionId = randomUUID(),
    credentialId = randomUUID();
  await migrator.transaction(async (tx) => {
    await tx.query('INSERT INTO saas_users(id,email) VALUES($1,$2)', [actorUserId, `${actorUserId}@example.test`]);
    await tx.query("INSERT INTO saas_platform_role_assignments(user_id,role) VALUES($1,'operations')", [actorUserId]);
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
  function resolution(intent: FastIntent, charge?: string) {
    return {
      tenantId: intent.tenantId,
      intentId: intent.id,
      actorUserId,
      actorSessionId,
      idempotencyKey: randomUUID(),
      kind: charge === undefined ? ('non_execution' as const) : ('verified_usage' as const),
      chargeMinorUnits: charge ?? '0',
      usage: charge === undefined ? {} : receiptFixture(intent, charge).usage,
      evidenceReference: 'provider-case:verified-evidence',
      evidenceSha256: 'e'.repeat(64),
      supportTicketRef: 'support:synthetic-case',
      reason: 'Provider evidence independently verified by operations.',
    };
  }
  async function setup() {
    const tenantId = randomUUID(),
      owner = randomUUID();
    await migrator.query("INSERT INTO saas_tenants(id,name,slug) VALUES($1,'resolution-v2',$2)", [tenantId, tenantId]);
    await migrator.transaction((tx) =>
      new PlatformWalletLedgerService().postVerifiedFunding(tx, {
        tenantId,
        currency: 'USD',
        amountMinorUnits: '100',
        sourceOrderRef: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    const journal = new PostgresFastGatewayJournal(gateway, {
      allocationOwner: owner,
      allocationTrancheMinorUnits: '100',
      allocationStripes: 1,
    });
    journals.push(journal);
    await journal.replenish(tenantId, 'USD');
    const input = { ...intentFixture(tenantId, owner), sendDeadlineMs: Date.now() + 100 };
    const reserved = await journal.reserveIntent(input);
    assert.equal(reserved.kind, 'created');
    if (reserved.kind !== 'created') throw new Error('fixture reserve denied');
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { journal, input, intent: reserved.intent };
  }
  async function job(intent: FastIntent) {
    return (
      await gateway.query<{ state: string }>('SELECT state FROM saas_fast_billing_jobs WHERE intent_id=$1', [intent.id])
    ).rows[0]?.state;
  }
  async function amounts(intent: FastIntent) {
    return (
      await gateway.query<{
        backing: string;
        available: string;
        balance: string;
        releases: string;
        resolutions: string;
        charges: string;
      }>(
        `SELECT
      a.backing_minor_units::text AS backing,a.available_minor_units::text AS available,w.posted_balance_minor_units::text AS balance,
      (SELECT count(*)::text FROM saas_fast_receipt_liability_releases WHERE intent_id=i.id) AS releases,
      (SELECT count(*)::text FROM saas_fast_gateway_resolutions WHERE intent_id=i.id) AS resolutions,
      (SELECT count(*)::text FROM saas_ledger_transactions WHERE business_key=i.id::text AND idempotency_namespace='fast-journal-v1') AS charges
      FROM saas_fast_gateway_intents i JOIN saas_fast_credit_allocations a ON a.id=i.allocation_id
      JOIN saas_wallets w ON w.tenant_id=i.tenant_id AND w.currency=i.currency WHERE i.id=$1`,
        [intent.id],
      )
    ).rows[0];
  }
  async function proven(scope: Awaited<ReturnType<typeof setup>>) {
    await scope.journal.appendReceipt({
      ...receiptFixture(scope.intent),
      verification: { priceSnapshot: scope.input.priceSnapshot },
    });
  }
  await t.test(
    'pending/blocked v2 are public pending/blocked; proven paid success cannot be overridden even if blocked',
    async () => {
      const scope = await setup();
      await proven(scope);
      assert.equal(await job(scope.intent), 'pending_v2');
      const pending = await service.getCase({ tenantId: scope.intent.tenantId, intentId: scope.intent.id });
      assert.equal(pending?.state, 'pending');
      assert.equal(pending?.maxCostMinorUnits, '80');
      assert.equal(pending?.retainedLiabilityMinorUnits, '20');
      assert.equal(await service.getCase({ tenantId: randomUUID(), intentId: scope.intent.id }), null);
      await assert.rejects(service.resolve({ ...resolution(scope.intent), tenantId: randomUUID() }), {
        code: 'NOT_FOUND',
      });
      await gateway.query("UPDATE saas_fast_billing_jobs SET state='blocked_v2' WHERE intent_id=$1", [scope.intent.id]);
      assert.equal((await service.listCases({ tenantId: scope.intent.tenantId }))[0]?.state, 'blocked');
      for (const charge of [undefined, '19', '20', '21']) {
        await assert.rejects(service.resolve(resolution(scope.intent, charge)), { code: 'NOT_ELIGIBLE' });
      }
      await assert.rejects(
        gateway.query("UPDATE saas_fast_billing_jobs SET state='pending' WHERE intent_id=$1", [scope.intent.id]),
      );
      assert.equal((await amounts(scope.intent)).resolutions, '0');
      await gateway.query("UPDATE saas_fast_billing_jobs SET state='pending_v2' WHERE intent_id=$1", [scope.intent.id]);
      await scope.journal.runOnce();
      assert.equal(
        (await service.getCase({ tenantId: scope.intent.tenantId, intentId: scope.intent.id }))
          ?.retainedLiabilityMinorUnits,
        '0',
      );
      assert.equal((await amounts(scope.intent)).balance, '80');
    },
  );
  await t.test(
    'legacy proven success also cannot be overwritten, but a success flag with invalid usage remains resolvable',
    async () => {
      const valid = await setup();
      await valid.journal.appendReceipt(receiptFixture(valid.intent));
      await gateway.query("UPDATE saas_fast_billing_jobs SET state='blocked' WHERE intent_id=$1", [valid.intent.id]);
      await assert.rejects(service.resolve(resolution(valid.intent)), { code: 'NOT_ELIGIBLE' });
      for (const state of ['blocked', 'blocked_v2']) {
        const invalid = await setup();
        await invalid.journal.appendReceipt({ ...receiptFixture(invalid.intent), usage: {} });
        await gateway.query('UPDATE saas_fast_billing_jobs SET state=$2 WHERE intent_id=$1', [
          invalid.intent.id,
          state,
        ]);
        const input = resolution(invalid.intent, '10');
        assert.equal((await service.resolve(input)).state, 'pending');
        assert.equal(await job(invalid.intent), state === 'blocked_v2' ? 'pending_v2' : 'pending');
        assert.equal((await service.resolve(input)).state, 'pending');
        await invalid.journal.runOnce();
        assert.equal((await service.resolve(input)).state, 'completed');
        assert.equal((await amounts(invalid.intent)).balance, '90');
      }
    },
  );
  await t.test(
    'a consistent H marker on unverified evidence bounds every new resolution and cannot downgrade its job',
    async () => {
      for (const charge of ['0', '19', '20', '21']) {
        const scope = await setup();
        // Deliberately model a faulty historical producer: receipt charge=20 but
        // priced usage=30. The marker tuple remains valid and is NOT rewritten.
        // New producers never compact this evidence; the resolver must still
        // respect already-released money if such evidence needs repair.
        await scope.journal.appendReceipt({ ...receiptFixture(scope.intent, '30'), chargeMinorUnits: '20' });
        await gateway.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO saas_fast_receipt_liability_releases
          (intent_id,tenant_id,request_id,allocation_id,allocation_epoch,currency,released_minor_units,retained_minor_units,receipt_digest,protocol_version)
          SELECT i.id,i.tenant_id,i.request_id,i.allocation_id,i.allocation_epoch,i.currency,60,20,r.receipt_digest,2
          FROM saas_fast_gateway_intents i JOIN saas_fast_gateway_receipts r ON r.intent_id=i.id WHERE i.id=$1`,
            [scope.intent.id],
          );
          await tx.query(
            'UPDATE saas_fast_credit_allocations SET available_minor_units=available_minor_units+60 WHERE id=(SELECT allocation_id FROM saas_fast_gateway_intents WHERE id=$1)',
            [scope.intent.id],
          );
          await tx.query("UPDATE saas_fast_billing_jobs SET state='blocked_v2' WHERE intent_id=$1", [scope.intent.id]);
        });
        const input = resolution(scope.intent, charge === '0' ? undefined : charge);
        if (charge === '21') {
          await assert.rejects(service.resolve(input), { code: 'INVALID_INPUT' });
          assert.equal(await job(scope.intent), 'blocked_v2');
          assert.deepEqual(await amounts(scope.intent), {
            backing: '100',
            available: '80',
            balance: '100',
            releases: '1',
            resolutions: '0',
            charges: '0',
          });
        } else {
          assert.equal((await service.resolve(input)).state, 'pending');
          assert.equal(await job(scope.intent), 'pending_v2');
          await scope.journal.runOnce();
          assert.equal(await job(scope.intent), 'completed');
          const expected = String(100 - Number(charge));
          assert.deepEqual(await amounts(scope.intent), {
            backing: expected,
            available: expected,
            balance: expected,
            releases: '1',
            resolutions: '1',
            charges: charge === '0' ? '0' : '1',
          });
        }
      }
    },
  );
  await t.test(
    'resolution ownership first prevents late paid receipts from compacting before or after completion',
    async () => {
      for (const completeFirst of [false, true]) {
        const scope = await setup();
        const input = resolution(scope.intent);
        await service.resolve(input);
        if (completeFirst) await scope.journal.runOnce();
        await proven(scope);
        assert.equal((await amounts(scope.intent)).releases, '0');
        await scope.journal.runOnce();
        assert.equal((await service.resolve(input)).state, 'completed');
        assert.deepEqual(await amounts(scope.intent), {
          backing: '100',
          available: '100',
          balance: '100',
          releases: '0',
          resolutions: '1',
          charges: '0',
        });
      }
    },
  );
  await t.test(
    'receipt wins between missing-job eligibility and upsert, then blocks: final proof/H check rolls resolution back',
    async () => {
      for (const verified of [true, false]) {
        const scope = await setup();
        let inserted = false;
        const racing: SaasDatabase = {
          query: control.query.bind(control),
          migrate: control.migrate.bind(control),
          ping: control.ping.bind(control),
          verifySchema: control.verifySchema.bind(control),
          close: async () => {},
          transaction: <T>(work: (tx: SqlExecutor) => Promise<T>) =>
            control.transaction((tx) =>
              work({
                query: async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
                  if (!inserted && sql.includes('INSERT INTO saas_fast_gateway_resolutions')) {
                    inserted = true;
                    if (verified) await proven(scope);
                    else {
                      await scope.journal.appendReceipt({
                        ...receiptFixture(scope.intent, '30'),
                        chargeMinorUnits: '20',
                      });
                      await gateway.transaction(async (other) => {
                        await other.query(
                          `INSERT INTO saas_fast_receipt_liability_releases
                        (intent_id,tenant_id,request_id,allocation_id,allocation_epoch,currency,released_minor_units,retained_minor_units,receipt_digest,protocol_version)
                        SELECT i.id,i.tenant_id,i.request_id,i.allocation_id,i.allocation_epoch,i.currency,60,20,r.receipt_digest,2
                        FROM saas_fast_gateway_intents i JOIN saas_fast_gateway_receipts r ON r.intent_id=i.id WHERE i.id=$1`,
                          [scope.intent.id],
                        );
                        await other.query(
                          'UPDATE saas_fast_credit_allocations SET available_minor_units=available_minor_units+60 WHERE id=(SELECT allocation_id FROM saas_fast_gateway_intents WHERE id=$1)',
                          [scope.intent.id],
                        );
                      });
                    }
                    await gateway.query("UPDATE saas_fast_billing_jobs SET state='blocked_v2' WHERE intent_id=$1", [
                      scope.intent.id,
                    ]);
                  }
                  return tx.query<Row>(sql, values);
                },
              }),
            ),
        };
        await assert.rejects(
          new FastGatewayResolutionService(racing).resolve(resolution(scope.intent, verified ? undefined : '21')),
          {
            code: verified ? 'NOT_ELIGIBLE' : 'INVALID_INPUT',
          },
        );
        assert.ok(inserted);
        assert.equal(await job(scope.intent), 'blocked_v2');
        assert.deepEqual(await amounts(scope.intent), {
          backing: '100',
          available: '80',
          balance: '100',
          releases: '1',
          resolutions: '0',
          charges: '0',
        });
      }
    },
  );
});
