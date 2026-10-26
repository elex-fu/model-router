import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PlatformWalletLedgerService } from '../../../../src/saas/billing/service.js';
import { saasAdvisoryKey, WALLET_FENCE_SQL } from '../../../../src/saas/db/advisory-lock-keys.js';
import { createSaasDatabase } from '../../../../src/saas/db/index.js';
import { runSaasMigrations, verifySaasMigrations } from '../../../../src/saas/db/migrate.js';
import { SAAS_MIGRATIONS } from '../../../../src/saas/db/migrations/001_initial_schema.js';
import type { SaasDatabasePool, SqlExecutor, SqlResult } from '../../../../src/saas/db/types.js';
import {
  type FastIntent,
  type FastReceiptInput,
  fastJournalCanonicalJson,
  fastJournalDigest,
  PostgresFastGatewayJournal,
} from '../../../../src/saas/gateway/fast/journal.js';
import { anyRoleConfigured, REQUIRED_FLAG, roleUrls } from '../../metering/normal-success-postgres-fixture.js';
import { intentFixture, receiptFixture } from './journal-fixture.js';

const enabled = process.env[REQUIRED_FLAG] === '1' || anyRoleConfigured;
const legacyMigrations = SAAS_MIGRATIONS.filter(({ version }) => version <= 145);

// Frozen evaluated registry at pre-compaction 6d60a22, not a hash of TS files.
// Includes every historical name and SHA256(name + NUL + actual SQL bytes).
const legacyFingerprint = '2d6417c99a52ea10ca6c01de2c786afd95e1cd1d2cee1a8ddd9697877e9eac21';
function historyFingerprint(rows: Array<{ version: number; name: string; checksum: string }>): string {
  return createHash('sha256')
    .update(rows.map((row) => `${row.version}\0${row.name}\0${row.checksum}\n`).join(''))
    .digest('hex');
}
function migrationPool(pool: Pool): SaasDatabasePool {
  const query = async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
    const result = await pool.query(sql, values ? [...values] : undefined);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  };
  return {
    query,
    async connect() {
      const client = await pool.connect();
      return {
        async query<Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> {
          const result = await client.query(sql, values ? [...values] : undefined);
          return { rows: result.rows as Row[], rowCount: result.rowCount };
        },
        release: (error) => client.release(error),
      };
    },
    end: () => pool.end(),
  };
}

// Schema145's receipt writer: no v2 table, proof or fabricated migration rows.
// The ordinary restricted gateway performs these writes with all guards active.
async function appendLegacyReceipt(database: SqlExecutor, receipt: FastReceiptInput): Promise<void> {
  const result = await database.query(
    `WITH receipt AS (
      INSERT INTO saas_fast_gateway_receipts
        (intent_id,tenant_id,request_id,outcome,charge_minor_units,usage,usage_digest,receipt_digest,http_status)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING intent_id
    ) INSERT INTO saas_fast_billing_jobs(intent_id,state)
      SELECT intent_id,$10 FROM receipt`,
    [
      receipt.intentId,
      receipt.tenantId,
      receipt.requestId,
      receipt.outcome,
      receipt.chargeMinorUnits,
      fastJournalCanonicalJson(receipt.usage),
      receipt.usageDigest,
      fastJournalDigest(receipt),
      receipt.httpStatus,
      receipt.outcome === 'succeeded' ? 'pending' : 'blocked',
    ],
  );
  assert.equal(result.rowCount, 1);
}

// Minimal v1 completed-row fixture, using the same balanced ledger pair,
// wallet projection context and H=M restoration as the pre146 worker. No
// triggers/constraints are disabled, and no current v2 worker runs on schema145.
async function completeLegacyReceipt(tx: SqlExecutor, intent: FastIntent, receipt: FastReceiptInput): Promise<void> {
  const ledgerId = randomUUID();
  await tx.query(WALLET_FENCE_SQL, [saasAdvisoryKey.walletFence(intent.tenantId, 'USD')]);
  const wallet = (await tx.query<{ id: string }>('SELECT id FROM saas_wallets WHERE tenant_id=$1', [intent.tenantId]))
    .rows[0];
  assert.ok(wallet);
  await tx.query(
    `INSERT INTO saas_ledger_transactions(id,tenant_id,currency,idempotency_namespace,business_key,source_type,
      amount_minor_units,metadata_ref,price_snapshot_ref,usage_evidence_ref)
     VALUES ($1,$2,'USD','fast-journal-v1',$3,'billing_settlement',$4,$5,$6,$7)`,
    [
      ledgerId,
      intent.tenantId,
      intent.id,
      receipt.chargeMinorUnits,
      `fast-intent:${intent.id}`,
      `fast-price:${intent.id}`,
      `fast-receipt:${intent.id}:${receipt.usageDigest}`,
    ],
  );
  await tx.query(
    `INSERT INTO saas_ledger_entries(id,transaction_id,tenant_id,currency,direction,amount_minor_units,account_type,account_ref,wallet_id)
     VALUES ($1,$3,$4,'USD','debit',$5,'wallet',$6::text,$6::uuid),
            ($2,$3,$4,'USD','credit',$5,'billing_revenue','fast-journal-v1',NULL)`,
    [randomUUID(), randomUUID(), ledgerId, intent.tenantId, receipt.chargeMinorUnits, wallet.id],
  );
  await tx.query('SET CONSTRAINTS saas_ledger_transactions_balanced, saas_ledger_entries_balanced IMMEDIATE');
  await tx.query(
    `WITH context AS MATERIALIZED (
      SELECT set_config('saas.billing_ledger_projection_write','on',true),
        set_config('saas.billing_ledger_transaction_id',$3,true)
     ) UPDATE saas_wallets SET posted_balance_minor_units=posted_balance_minor_units-$2::bigint,updated_at=now()
       FROM context WHERE id=$1`,
    [wallet.id, receipt.chargeMinorUnits, ledgerId],
  );
  assert.equal(
    (
      await tx.query(
        `UPDATE saas_fast_credit_allocations SET backing_minor_units=backing_minor_units-$2::bigint,
      available_minor_units=available_minor_units+$3::bigint-$2::bigint
     WHERE id=(SELECT allocation_id FROM saas_fast_gateway_intents WHERE id=$1)`,
        [intent.id, receipt.chargeMinorUnits, intent.maxCostMinorUnits],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await tx.query(
        `UPDATE saas_fast_billing_jobs SET state='completed',attempts=1,ledger_transaction_id=$2,completed_at=now()
     WHERE intent_id=$1 AND state='pending'`,
        [intent.id, ledgerId],
      )
    ).rowCount,
    1,
  );
}

test('populated schema145 upgrades through the real migrator without rewriting money or legacy jobs', {
  skip: !enabled,
  timeout: 120_000,
}, async (t) => {
  const urls = roleUrls(); // Enforces designated roles and disposable CI/nondefault loopback targets.
  const adminValue = process.env.SAAS_TEST_DATABASE_ADMIN_URL;
  assert.ok(adminValue, 'SAAS_TEST_DATABASE_ADMIN_URL is required for the populated upgrade gate');
  const adminUrl = new URL(adminValue);
  const target = new URL(urls[0]);
  assert.ok(['postgres:', 'postgresql:'].includes(adminUrl.protocol));
  assert.equal(decodeURIComponent(adminUrl.username), 'postgres');
  assert.equal(adminUrl.hostname, target.hostname);
  assert.equal(adminUrl.port, target.port);
  assert.equal(adminUrl.pathname, target.pathname);
  assert.equal(adminUrl.search, '');
  assert.equal(adminUrl.hash, '');
  // Never reset/reuse the configured database, which may contain other gates.
  // Drop only this locally generated database after every owned pool closes.
  const name = `model_router_test_upgrade_${randomUUID().replaceAll('-', '')}`;
  const administrator = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  let created = false;
  let ownedJournal: PostgresFastGatewayJournal | undefined;
  const scoped = (url: string): string => {
    const value = new URL(url);
    value.pathname = `/${name}`;
    return value.toString();
  };
  const setup = new Pool({ connectionString: scoped(adminUrl.toString()), max: 1 });
  const rawMigrator = new Pool({ connectionString: scoped(urls[0]), max: 1 });
  const pool = migrationPool(rawMigrator);
  const migrator = createSaasDatabase({ connectionString: scoped(urls[0]), max: 2 });
  const gateway = createSaasDatabase({ connectionString: scoped(urls[2]), max: 2 });
  const control = createSaasDatabase({ connectionString: scoped(urls[1]), max: 1 });
  t.after(async () => {
    try {
      await ownedJournal?.close({ drain: false });
    } finally {
      try {
        await Promise.all([control.close(), gateway.close(), migrator.close(), rawMigrator.end(), setup.end()]);
      } finally {
        try {
          if (created) await administrator.query(`DROP DATABASE "${name}"`);
        } finally {
          await administrator.end();
        }
      }
    }
  });
  await administrator.query(`CREATE DATABASE "${name}"`);
  created = true;
  const rolesSql = await readFile('deploy/managed-saas-postgres-roles.sql', 'utf8');
  await setup.query(rolesSql);
  await runSaasMigrations(pool, legacyMigrations);
  await verifySaasMigrations(pool, legacyMigrations);
  await assert.rejects(verifySaasMigrations(pool), /out of date/);
  await setup.query(rolesSql);
  const history = async () =>
    (
      await migrator.query<{
        version: number;
        name: string;
        checksum: string;
        applied_at: Date;
      }>('SELECT version,name,checksum,applied_at FROM saas_schema_migrations ORDER BY version')
    ).rows;
  const beforeHistory = await history();
  assert.equal(beforeHistory.length, 126);
  assert.equal(beforeHistory.at(-1)?.version, 145);
  assert.equal(historyFingerprint(beforeHistory), legacyFingerprint);
  assert.equal(
    (
      await migrator.query<{ marker: string | null }>(
        "SELECT to_regclass('saas_fast_receipt_liability_releases') AS marker",
      )
    ).rows[0].marker,
    null,
  );
  for (const [db, role] of [
    [migrator, 'model_router_saas_migrator'],
    [gateway, 'model_router_saas_gateway'],
    [control, 'model_router_saas_control_plane'],
  ] as const) {
    assert.deepEqual(
      (
        await db.query(
          'SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user',
        )
      ).rows,
      [{ name: role, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }],
    );
  }
  const tenantId = randomUUID();
  const owner = randomUUID();
  await migrator.query("INSERT INTO saas_tenants(id,name,slug) VALUES ($1,'populated-upgrade',$2)", [
    tenantId,
    tenantId,
  ]);
  await migrator.transaction((tx) =>
    new PlatformWalletLedgerService().postVerifiedFunding(tx, {
      tenantId,
      currency: 'USD',
      amountMinorUnits: '500',
      sourceOrderRef: randomUUID(),
      idempotencyKey: randomUUID(),
    }),
  );
  const journal = new PostgresFastGatewayJournal(gateway, {
    allocationOwner: owner,
    allocationTrancheMinorUnits: '500',
    allocationStripes: 1,
  });
  ownedJournal = journal;
  await journal.replenish(tenantId, 'USD');
  const reserve = async () => {
    const input = intentFixture(tenantId, owner);
    const result = await journal.reserveIntent(input);
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('fixture reserve denied');
    return { input, intent: result.intent };
  };
  const completed = await reserve();
  const pending = await reserve();
  const unknown = await reserve();
  const missing = await reserve();
  const completedReceipt = receiptFixture(completed.intent);
  const pendingReceipt = receiptFixture(pending.intent);
  const unknownReceipt: FastReceiptInput = {
    ...receiptFixture(unknown.intent),
    outcome: 'unknown',
    chargeMinorUnits: null,
    httpStatus: null,
  };
  await appendLegacyReceipt(gateway, completedReceipt);
  await appendLegacyReceipt(gateway, pendingReceipt);
  await appendLegacyReceipt(gateway, unknownReceipt);

  async function assertMoney(upgraded: boolean, balance: string, available: string, held: string, charges: string) {
    const release = upgraded ? 'COALESCE(l.released_minor_units,0)' : '0';
    const join = upgraded ? 'LEFT JOIN saas_fast_receipt_liability_releases l ON l.intent_id=i.id' : '';
    const allocations = (
      await gateway.query<{ backing: string; available: string; held: string }>(
        `SELECT a.backing_minor_units::text AS backing,a.available_minor_units::text AS available,
        COALESCE(SUM(CASE WHEN j.state='completed' THEN 0 ELSE i.max_cost_minor_units-${release} END),0)::text AS held
       FROM saas_fast_credit_allocations a LEFT JOIN saas_fast_gateway_intents i ON i.allocation_id=a.id
       LEFT JOIN saas_fast_billing_jobs j ON j.intent_id=i.id ${join}
       WHERE a.tenant_id=$1 GROUP BY a.id`,
        [tenantId],
      )
    ).rows;
    assert.deepEqual(allocations, [{ backing: balance, available, held }]);
    for (const row of allocations)
      assert.equal(BigInt(row.backing), BigInt(row.available) + BigInt(row.held), 'B=A+sum(H)');
    const money = (
      await migrator.query(
        `SELECT w.posted_balance_minor_units::text AS balance,
        (SELECT count(*)::text FROM saas_ledger_transactions WHERE tenant_id=$1 AND idempotency_namespace='fast-journal-v1') AS charges,
        (SELECT COALESCE(sum(amount_minor_units),0)::text FROM saas_ledger_transactions WHERE tenant_id=$1 AND idempotency_namespace='fast-journal-v1') AS charged,
        (SELECT sum(CASE direction WHEN 'credit' THEN amount_minor_units ELSE -amount_minor_units END)::text
         FROM saas_ledger_entries WHERE wallet_id=w.id) AS ledger_balance
       FROM saas_wallets w WHERE tenant_id=$1`,
        [tenantId],
      )
    ).rows[0];
    assert.deepEqual(money, {
      balance,
      charges,
      charged: (500n - BigInt(balance)).toString(),
      ledger_balance: balance,
    });
    assert.equal(
      (
        await migrator.query(
          `SELECT t.id FROM saas_ledger_transactions t LEFT JOIN saas_ledger_entries e ON e.transaction_id=t.id
       WHERE t.tenant_id=$1 GROUP BY t.id HAVING count(e.id)<>2
         OR sum(CASE e.direction WHEN 'debit' THEN e.amount_minor_units ELSE -e.amount_minor_units END)<>0`,
          [tenantId],
        )
      ).rowCount,
      0,
      'every funding/charge transaction has one exact balanced pair',
    );
  }
  await assertMoney(false, '500', '180', '320', '0');
  await gateway.transaction((tx) => completeLegacyReceipt(tx, completed.intent, completedReceipt));
  await assertMoney(false, '480', '240', '240', '1');
  const legacyTables = [
    'saas_tenants',
    'saas_wallets',
    'saas_fast_gateway_owners',
    'saas_fast_credit_allocations',
    'saas_fast_gateway_intents',
    'saas_fast_gateway_receipts',
    'saas_fast_billing_jobs',
    'saas_ledger_transactions',
    'saas_ledger_entries',
  ];
  async function dataSnapshot() {
    return Promise.all(
      legacyTables.map(
        async (table) =>
          (
            await migrator.query(
              `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM ${table} t`,
            )
          ).rows,
      ),
    );
  }
  const beforeData = await dataSnapshot();
  const job = async (id: string) =>
    (
      await gateway.query<{
        state: string;
        attempts: number;
        ledger_transaction_id: string | null;
        completed_at: Date | null;
      }>('SELECT state,attempts,ledger_transaction_id,completed_at FROM saas_fast_billing_jobs WHERE intent_id=$1', [
        id,
      ])
    ).rows[0];
  const completedJob = await job(completed.intent.id);
  const unknownJob = await job(unknown.intent.id);
  assert.equal(completedJob.state, 'completed');
  assert.equal((await job(pending.intent.id)).state, 'pending');
  assert.equal(unknownJob.state, 'blocked');
  assert.equal(await job(missing.intent.id), undefined);

  await runSaasMigrations(pool); // Actual checksum/advisory-lock/transactional runner appends146.
  await verifySaasMigrations(pool);
  const afterHistory = await history();
  assert.deepEqual(
    afterHistory.filter(({ version }) => version <= 145),
    beforeHistory,
  );
  assert.equal(afterHistory.length, 127);
  assert.equal(afterHistory.at(-1)?.version, 146);
  assert.deepEqual(await dataSnapshot(), beforeData, 'upgrade changes no existing business row');
  assert.equal((await migrator.query('SELECT * FROM saas_fast_receipt_liability_releases')).rowCount, 0);
  await runSaasMigrations(pool); // Re-running the real migration path is a no-op.
  assert.deepEqual(await history(), afterHistory);
  await assert.rejects(runSaasMigrations(pool, legacyMigrations), /unknown SaaS migration version/);
  await assert.rejects(verifySaasMigrations(pool, legacyMigrations), /unknown SaaS migration version/);
  await setup.query(rolesSql); // Production role reconciliation, not broad test grants.
  await gateway.verifySchema();
  await assertMoney(true, '480', '240', '240', '1');
  assert.deepEqual(await dataSnapshot(), beforeData);
  assert.equal(
    (
      await migrator.query<{ owner: string }>(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='saas_fast_receipt_liability_releases'::regclass",
      )
    ).rows[0].owner,
    'model_router_saas_migrator',
  );

  // Even adding today's verification to an old receipt cannot retroactively
  // compact it. The old pending row still settles using its entire H=M=80.
  await journal.appendReceipt({ ...pendingReceipt, verification: { priceSnapshot: pending.input.priceSnapshot } });
  await journal.appendReceipt(completedReceipt);
  await journal.appendReceipt(unknownReceipt);
  assert.equal((await gateway.query('SELECT * FROM saas_fast_receipt_liability_releases')).rowCount, 0);
  assert.equal((await job(pending.intent.id)).state, 'pending');
  await assertMoney(true, '480', '240', '240', '1');
  assert.equal(await journal.runOnce(), 1);
  assert.equal(await journal.runOnce(), 0);
  await assertMoney(true, '460', '300', '160', '2');
  assert.deepEqual(await job(completed.intent.id), completedJob, 'already charged job is never reposted');
  assert.deepEqual(await job(unknown.intent.id), unknownJob, 'unknown outcome keeps its full M');
  assert.equal((await job(pending.intent.id)).attempts, 1);

  const fresh = await reserve();
  await assertMoney(true, '460', '220', '240', '2');
  const freshReceipt = { ...receiptFixture(fresh.intent), verification: { priceSnapshot: fresh.input.priceSnapshot } };
  await journal.appendReceipt(freshReceipt);
  assert.equal((await job(fresh.intent.id)).state, 'pending_v2');
  await assertMoney(true, '460', '280', '180', '2');
  const releases = (
    await gateway.query(
      `SELECT l.intent_id,l.tenant_id,l.request_id,l.allocation_id=i.allocation_id AS allocation_matches,
      l.allocation_epoch=i.allocation_epoch AS epoch_matches,l.currency,l.released_minor_units::text AS released,
      l.retained_minor_units::text AS retained,l.receipt_digest=r.receipt_digest AS digest_matches,l.protocol_version
     FROM saas_fast_receipt_liability_releases l JOIN saas_fast_gateway_intents i ON i.id=l.intent_id
     JOIN saas_fast_gateway_receipts r ON r.intent_id=i.id`,
    )
  ).rows;
  assert.deepEqual(releases, [
    {
      intent_id: fresh.intent.id,
      tenant_id: tenantId,
      request_id: fresh.intent.requestId,
      allocation_matches: true,
      epoch_matches: true,
      currency: 'USD',
      released: '60',
      retained: '20',
      digest_matches: true,
      protocol_version: 2,
    },
  ]);
  assert.equal(
    (
      await gateway.transaction((tx) =>
        tx.query(
          "SELECT intent_id FROM saas_fast_billing_jobs WHERE state='pending' ORDER BY created_at,intent_id LIMIT 128 FOR UPDATE SKIP LOCKED",
        ),
      )
    ).rowCount,
    0,
    'schema145 worker claim cannot see compacted v2 jobs',
  );
  for (const state of ['pending', 'blocked']) {
    await assert.rejects(
      gateway.query('UPDATE saas_fast_billing_jobs SET state=$2 WHERE intent_id=$1', [fresh.intent.id, state]),
      { code: '55000' },
    );
  }
  await assert.rejects(
    control.query(
      'INSERT INTO saas_fast_receipt_liability_releases SELECT * FROM saas_fast_receipt_liability_releases',
    ),
    { code: '42501' },
  );
  await assertMoney(true, '460', '280', '180', '2');
  assert.equal(await journal.runOnce(), 1);
  await journal.appendReceipt(freshReceipt);
  await journal.appendReceipt(pendingReceipt);
  await journal.appendReceipt(completedReceipt);
  assert.equal(await journal.runOnce(), 0);
  await assertMoney(true, '440', '280', '160', '3');
  assert.deepEqual(await job(completed.intent.id), completedJob);
  assert.deepEqual(await job(unknown.intent.id), unknownJob);
  assert.equal(await job(missing.intent.id), undefined);
  assert.equal((await job(fresh.intent.id)).attempts, 1);
  assert.equal((await gateway.query('SELECT * FROM saas_fast_receipt_liability_releases')).rowCount, 1);
  const charges = (
    await gateway.query(
      `SELECT business_key,amount_minor_units::text AS amount FROM saas_ledger_transactions
     WHERE tenant_id=$1 AND idempotency_namespace='fast-journal-v1' ORDER BY business_key`,
      [tenantId],
    )
  ).rows;
  assert.deepEqual(
    charges,
    [completed, pending, fresh]
      .map(({ intent }) => ({ business_key: intent.id, amount: '20' }))
      .sort((a, b) => a.business_key.localeCompare(b.business_key)),
  );
  assert.deepEqual(
    (await history()).filter(({ version }) => version <= 145),
    beforeHistory,
  );
});
