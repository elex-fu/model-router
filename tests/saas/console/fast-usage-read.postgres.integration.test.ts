import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import {
  type ConsolePage,
  type ConsoleRequest,
  type ConsoleUsageSummaryBucket,
  SaasConsoleQueryError,
  SaasConsoleUsageQueryService,
} from '../../../src/saas/console/index.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import {
  type FastIntent,
  fastJournalDigest,
  PostgresFastGatewayJournal,
} from '../../../src/saas/gateway/fast/journal.js';
import { FastGatewayResolutionService } from '../../../src/saas/gateway/fast/resolution.js';
import { intentFixture, receiptFixture } from '../gateway/fast/journal-fixture.js';
import {
  anyRoleConfigured,
  completeLegacy,
  REQUIRED_FLAG,
  roleUrls,
  seedFixture,
} from '../metering/normal-success-postgres-fixture.js';

const enabled = process.env[REQUIRED_FLAG] === '1' || anyRoleConfigured;
test('fast and strict customer usage coexist under the restricted control-plane role', {
  skip: !enabled,
  timeout: 120_000,
}, async (t) => {
  const journals: PostgresFastGatewayJournal[] = [];
  const urls = roleUrls();
  const migrator = createSaasDatabase({ connectionString: urls[0], max: 1 });
  const control = createSaasDatabase({ connectionString: urls[1], max: 1 });
  const reader = createSaasDatabase({ connectionString: urls[1], max: 1 });
  const gateway = createSaasDatabase({ connectionString: urls[2], max: 2 });
  t.after(async () => {
    for (const journal of journals) await journal.close();
    await Promise.all([reader.close(), control.close(), gateway.close(), migrator.close()]);
  });
  await gateway.verifySchema();
  await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');
  await reader.query('SET SESSION default_transaction_read_only = on');
  const queries = new SaasConsoleUsageQueryService(reader);
  const strict = await seedFixture(migrator, gateway, 'platform');
  await completeLegacy(gateway, strict);
  const scope = { userId: strict.userId, tenantId: strict.tenantId, projectId: strict.projectId };
  const strictMetadata = await queries.getRequest({ ...scope, requestId: strict.input.requestId });
  assert.ok(strictMetadata);
  const model = strictMetadata.model;
  const range = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
  await migrator.transaction((tx) =>
    new PlatformWalletLedgerService().postVerifiedFunding(tx, {
      tenantId: strict.tenantId,
      currency: 'USD',
      amountMinorUnits: '2000',
      sourceOrderRef: randomUUID(),
      idempotencyKey: randomUUID(),
    }),
  );
  const owner = randomUUID();
  const journal = new PostgresFastGatewayJournal(gateway, {
    allocationOwner: owner,
    allocationTrancheMinorUnits: '1600',
    allocationStripes: 1,
  });
  journals.push(journal);
  await journal.replenish(strict.tenantId, 'USD');
  const authority = {
    modelResolution: { requestedModel: model, resolvedModel: 'private-provider-model' },
    route: { protocol: 'openai', publicModel: model },
    principal: { kind: 'member', id: strict.userId },
    authorizationVersions: { key: 1 },
    candidate: { accountId: 'private-account', credentialId: 'private-credential-identity' },
  };
  async function reserve(sendWithinMs = 60_000): Promise<FastIntent> {
    const result = await journal.reserveIntent({
      ...intentFixture(strict.tenantId, owner),
      projectId: strict.projectId,
      proxyKeyId: strict.keyId,
      authoritySnapshot: authority,
      sendDeadlineMs: Date.now() + sendWithinMs,
    });
    assert.equal(result.kind, 'created');
    if (result.kind !== 'created') throw new Error('fixture intent denied');
    return result.intent;
  }
  const detail = (intent: FastIntent) => queries.getRequestDetail({ ...scope, requestId: intent.requestId });
  const paid = await reserve();
  const paidPrice = (
    await gateway.query<{ price_snapshot: unknown }>(
      'SELECT price_snapshot FROM saas_fast_gateway_intents WHERE id=$1',
      [paid.id],
    )
  ).rows[0].price_snapshot;
  await journal.appendReceipt({ ...receiptFixture(paid, '7'), verification: { priceSnapshot: paidPrice } });
  await t.test('receipt success is not financial completion until the job acknowledges its exact ledger', async () => {
    assert.equal((await detail(paid))?.financialStatus, 'pending');
    assert.equal((await detail(paid))?.usageEvents[0]?.billableBasis, 'unknown');
    const cases = new FastGatewayResolutionService(control);
    const pending = await cases.getCase({ tenantId: strict.tenantId, intentId: paid.id });
    assert.equal(pending?.state, 'pending');
    assert.equal(pending?.maxCostMinorUnits, '80');
    assert.equal(pending?.retainedLiabilityMinorUnits, '7');
    await gateway.query("UPDATE saas_fast_billing_jobs SET state='blocked_v2' WHERE intent_id=$1", [paid.id]);
    assert.equal((await detail(paid))?.financialStatus, 'reconciliation_pending');
    assert.equal((await detail(paid))?.usageEvents[0]?.billableBasis, 'unknown');
    assert.equal((await cases.getCase({ tenantId: strict.tenantId, intentId: paid.id }))?.state, 'blocked');
    await gateway.query("UPDATE saas_fast_billing_jobs SET state='pending_v2' WHERE intent_id=$1", [paid.id]);
    // Fixture corruption drill: a completed flag alone is not acknowledgement
    // of a positive charge. Restore the pending job before the real worker runs.
    await gateway.query("UPDATE saas_fast_billing_jobs SET state='completed',completed_at=now() WHERE intent_id=$1", [
      paid.id,
    ]);
    assert.equal((await detail(paid))?.financialStatus, 'reconciliation_pending');
    assert.equal((await detail(paid))?.usageEvents[0]?.billableBasis, 'unknown');
    await gateway.query("UPDATE saas_fast_billing_jobs SET state='pending_v2',completed_at=NULL WHERE intent_id=$1", [
      paid.id,
    ]);
    await journal.runOnce();
    const result = await detail(paid);
    assert.equal(result?.financialStatus, 'settled');
    assert.equal(result?.status, 'succeeded');
    assert.deepEqual(result?.attempts, []);
    assert.equal(result?.usageEvents[0]?.inputTotal, '7');
    assert.equal(result?.usageEvents[0]?.billableBasis, 'exact');
    assert.deepEqual(await queries.getRequest({ ...scope, requestId: paid.id }), result);
    assert.ok((await queries.getRequest({ ...scope, requestId: strict.input.requestId }))?.attempts.length);
  });

  const unknown = await reserve();
  await journal.appendReceipt({
    ...receiptFixture(unknown, '9'),
    outcome: 'unknown',
    chargeMinorUnits: null,
    httpStatus: null,
  });
  const resolved = await reserve(100);
  await journal.appendReceipt({
    ...receiptFixture(resolved, '777'),
    outcome: 'unknown',
    chargeMinorUnits: null,
    httpStatus: null,
  });
  const failed = await reserve(100);
  await journal.appendReceipt({
    ...receiptFixture(failed, '0'),
    outcome: 'failed',
    httpStatus: 500,
    usage: {},
    usageDigest: fastJournalDigest({}),
  });
  const unsent = await reserve();
  await journal.appendReceipt({
    ...receiptFixture(unsent, '0'),
    outcome: 'failed',
    httpStatus: null,
    usage: {},
    usageDigest: fastJournalDigest({}),
  });
  const zero = await reserve();
  await journal.appendReceipt(receiptFixture(zero, '0'));
  await journal.runOnce();
  await t.test(
    'unknown/non-2xx retain reconciliation while never-sent and zero-success complete without ledger',
    async () => {
      for (const intent of [unknown, resolved, failed])
        assert.equal((await detail(intent))?.financialStatus, 'reconciliation_pending');
      assert.equal((await detail(unknown))?.status, 'unknown');
      assert.equal((await detail(failed))?.status, 'failed');
      assert.equal((await detail(unsent))?.financialStatus, 'released');
      assert.equal((await detail(zero))?.financialStatus, 'settled');
      const rows = await gateway.query<{ ledger_transaction_id: string | null }>(
        'SELECT ledger_transaction_id FROM saas_fast_billing_jobs WHERE intent_id = ANY($1::uuid[])',
        [[unsent.id, zero.id]],
      );
      assert.deepEqual(
        rows.rows.map((row) => row.ledger_transaction_id),
        [null, null],
      );
    },
  );

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
  await t.test(
    'only applied operator evidence replaces raw usage; it never invents successful response delivery',
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const usage = receiptFixture(resolved, '3').usage;
      await new FastGatewayResolutionService(control).resolve({
        tenantId: strict.tenantId,
        intentId: resolved.id,
        actorUserId,
        actorSessionId,
        idempotencyKey: randomUUID(),
        kind: 'verified_usage',
        chargeMinorUnits: '3',
        usage,
        evidenceReference: 'private-provider-case',
        evidenceSha256: 'e'.repeat(64),
        supportTicketRef: 'private-ticket',
        reason: 'private-operator-reason',
      });
      assert.equal((await detail(resolved))?.financialStatus, 'reconciliation_pending');
      assert.equal((await detail(resolved))?.usageEvents[0]?.inputTotal, '777');
      await journal.runOnce();
      const result = await detail(resolved);
      assert.equal(result?.financialStatus, 'settled');
      assert.equal(result?.status, 'unknown');
      assert.equal(result?.reconciliationState, 'pending');
      assert.equal(result?.usageEvents[0]?.inputTotal, '3');
      assert.match(result?.usageEvents[0]?.id ?? '', /^fast-resolution:/);
      assert.equal(JSON.stringify(result).includes('private-'), false);
      const original = await gateway.query<{ usage: { inputTotal: string } }>(
        'SELECT usage FROM saas_fast_gateway_receipts WHERE intent_id=$1',
        [resolved.id],
      );
      assert.equal(original.rows[0]?.usage.inputTotal, '777');
    },
  );

  // Direct immutable BYOK fixture inserts permit exact equal/microsecond times;
  // production still writes only via the journal. All receipts/settlements use GW.
  async function byokAt(
    offset: number,
    input: string,
    requestId: string = randomUUID(),
    intentId: string = randomUUID(),
    projectId = strict.projectId,
  ): Promise<FastIntent> {
    const attemptId = randomUUID();
    await gateway.query(
      `INSERT INTO saas_fast_gateway_intents
      (id,request_id,attempt_id,tenant_id,project_id,proxy_key_id,intent_digest,request_fingerprint,payload_sha256,account_id,max_cost_minor_units,authority_snapshot,send_deadline,created_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$7,$7,'fixture',0,$8::jsonb,now()+interval '1 minute',created_at + $9::integer * interval '1 microsecond'
      FROM saas_requests WHERE id=$10`,
      [
        intentId,
        requestId,
        attemptId,
        strict.tenantId,
        projectId,
        strict.keyId,
        'a'.repeat(64),
        JSON.stringify(authority),
        offset,
        strict.input.requestId,
      ],
    );
    const intent = { id: intentId, requestId, attemptId, tenantId: strict.tenantId, maxCostMinorUnits: '0' };
    const receipt = receiptFixture(intent, input);
    await journal.appendReceipt({ ...receipt, chargeMinorUnits: '0', usageDigest: fastJournalDigest(receipt.usage) });
    await journal.runOnce();
    return intent;
  }
  const byok1 = await byokAt(0, '13');
  const byok2 = await byokAt(1, '17');
  await t.test(
    'mixed keyset ordering, equal times, all filters and bucket cursors match exact SQL totals',
    async () => {
      assert.equal((await detail(byok1))?.financialStatus, 'not_applicable');
      assert.equal((await detail(byok2))?.usageEvents[0]?.inputTotal, '17');
      const expected = await gateway.query<{ id: string }>(
        `SELECT id FROM (
      SELECT id,created_at FROM saas_requests WHERE tenant_id=$1
      UNION ALL SELECT request_id AS id,created_at FROM saas_fast_gateway_intents WHERE tenant_id=$1
    ) records ORDER BY created_at DESC,id DESC`,
        [strict.tenantId],
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ConsolePage<ConsoleRequest> = await queries.listRequests({ ...scope, limit: 1, cursor });
        seen.push(...page.items.map((row) => row.id));
        cursor = page.nextCursor;
        assert.equal(page.hasMore, cursor !== null);
      } while (cursor);
      assert.deepEqual(
        seen,
        expected.rows.map((row) => row.id),
      );
      assert.equal(new Set(seen).size, seen.length);
      assert.equal(
        (await queries.listRequests({ ...scope, model, supplyMode: 'byok', status: 'succeeded', ...range })).items
          .length,
        2,
      );
      assert.equal((await queries.listRequests({ ...scope, model: 'not-the-pinned-model' })).items.length, 0);
      assert.equal((await queries.listRequests({ ...scope, status: 'unknown' })).items.length, 2);
      assert.equal((await queries.listRequests({ ...scope, from: '2000-01-01', to: '2000-01-02' })).items.length, 0);
      const summary = await queries.getUsageSummary({ ...scope, ...range });
      assert.equal(summary?.requestCount, '9');
      assert.equal(summary?.eventCount, '9');
      assert.equal(summary?.inputTotal, '52');
      assert.equal(summary?.outputTotal, '2');
      assert.equal(summary?.totalTokens, '54');
      assert.equal((await queries.getUsageSummary({ ...scope, ...range, status: 'unknown' }))?.inputTotal, '12');
      assert.equal((await queries.getUsageSummary({ ...scope, ...range, supplyMode: 'byok' }))?.inputTotal, '30');
      const buckets = [];
      cursor = null;
      do {
        const page: ConsolePage<ConsoleUsageSummaryBucket> = await queries.listUsageSummaries({
          ...scope,
          ...range,
          limit: 1,
          cursor,
        });
        buckets.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(
        buckets.reduce((total, row) => total + BigInt(row.inputTotal), 0n),
        52n,
      );
      assert.equal(
        buckets.reduce((total, row) => total + BigInt(row.eventCount), 0n),
        9n,
      );
    },
  );

  await t.test('tenant/project/user revocation and key ownership never widen historical access', async () => {
    for (const denied of [{ tenantId: randomUUID() }, { projectId: randomUUID() }, { userId: randomUUID() }]) {
      assert.deepEqual((await queries.listRequests({ ...scope, ...denied })).items, []);
      assert.equal(await queries.getRequest({ ...scope, ...denied, requestId: paid.id }), null);
      assert.equal(await queries.getUsageSummary({ ...scope, ...denied, ...range }), null);
      assert.deepEqual((await queries.listUsageSummaries({ ...scope, ...denied, ...range })).items, []);
    }
    const invalidScope = await byokAt(2, '99', randomUUID(), randomUUID(), randomUUID());
    assert.equal(await queries.getRequest({ ...scope, requestId: invalidScope.requestId }), null);
    await migrator.query(
      "UPDATE saas_project_memberships SET status='revoked',revoked_at=now() WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3",
      [strict.tenantId, strict.projectId, strict.userId],
    );
    assert.deepEqual((await queries.listRequests(scope)).items, []);
    assert.equal(await queries.getRequest({ ...scope, requestId: paid.id }), null);
    assert.equal(await queries.getUsageSummary({ ...scope, ...range }), null);
    // Preserve existing tenant-wide list/aggregate authority when no project
    // selector is present; detail still requires project membership.
    const tenantScope = { userId: strict.userId, tenantId: strict.tenantId };
    assert.equal((await queries.listRequests(tenantScope)).items.length, 9);
    assert.equal((await queries.getUsageSummary({ ...tenantScope, ...range }))?.inputTotal, '52');
    assert.equal(await queries.getRequest({ ...tenantScope, requestId: paid.id }), null);
    await migrator.query(
      "UPDATE saas_project_memberships SET status='active',revoked_at=NULL WHERE tenant_id=$1 AND project_id=$2 AND user_id=$3",
      [strict.tenantId, strict.projectId, strict.userId],
    );
  });

  await t.test('new read grants do not expose full intent rows or add financial mutation authority', async () => {
    const denied = [
      'SELECT * FROM saas_fast_gateway_intents',
      'SELECT account_id FROM saas_fast_gateway_intents',
      'SELECT payload_sha256 FROM saas_fast_gateway_intents',
      'UPDATE saas_fast_gateway_receipts SET usage=usage WHERE false',
      'UPDATE saas_fast_billing_jobs SET ledger_transaction_id=ledger_transaction_id WHERE false',
      'DELETE FROM saas_fast_gateway_intents WHERE false',
    ];
    for (const sql of denied) await assert.rejects(control.query(sql), { code: '42501' });
    const writes = await control.query<{ allowed: boolean }>(
      "SELECT has_any_column_privilege(current_user,'saas_fast_gateway_intents','INSERT') OR has_any_column_privilege(current_user,'saas_fast_gateway_receipts','INSERT') AS allowed",
    );
    assert.equal(writes.rows[0]?.allowed, false);
  });

  await t.test(
    'applied resolution replaces, rather than adds to, an observation across UTC day boundaries',
    async () => {
      const intent = await reserve(100);
      const raw = receiptFixture(intent, '70');
      await gateway.query(
        `INSERT INTO saas_fast_gateway_receipts
      (intent_id,tenant_id,request_id,outcome,usage,usage_digest,receipt_digest,created_at)
      VALUES($1,$2,$3,'unknown',$4::jsonb,$5,$5,date_trunc('day',now())-interval '12 hours')`,
        [intent.id, intent.tenantId, intent.requestId, JSON.stringify(raw.usage), raw.usageDigest],
      );
      await gateway.query("INSERT INTO saas_fast_billing_jobs(intent_id,state) VALUES($1,'blocked')", [intent.id]);
      const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const yesterday = new Date(today.getTime() - 86_400_000);
      const tomorrow = new Date(today.getTime() + 86_400_000);
      const older = { ...scope, from: yesterday, to: today };
      assert.equal((await queries.getUsageSummary(older))?.inputTotal, '70');
      await new Promise((resolve) => setTimeout(resolve, 120));
      await new FastGatewayResolutionService(control).resolve({
        tenantId: strict.tenantId,
        intentId: intent.id,
        actorUserId,
        actorSessionId,
        idempotencyKey: randomUUID(),
        kind: 'verified_usage',
        chargeMinorUnits: '4',
        usage: receiptFixture(intent, '4').usage,
        evidenceReference: 'private-day-boundary',
        evidenceSha256: 'e'.repeat(64),
        supportTicketRef: 'private-ticket',
        reason: 'private-reason',
      });
      assert.equal((await queries.getUsageSummary(older))?.inputTotal, '70');
      await journal.runOnce();
      assert.equal((await queries.getUsageSummary(older))?.inputTotal, '0');
      const newer = await queries.getUsageSummary({ ...scope, from: today, to: tomorrow });
      assert.equal(newer?.inputTotal, '56');
      assert.equal(newer?.eventCount, '10');
    },
  );

  await t.test(
    'expired missing receipt is unknown until applied non-execution evidence releases its maximum',
    async () => {
      const intent = await reserve(100);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal((await detail(intent))?.status, 'unknown');
      assert.equal((await detail(intent))?.financialStatus, 'reconciliation_pending');
      assert.deepEqual((await detail(intent))?.usageEvents, []);
      await new FastGatewayResolutionService(control).resolve({
        tenantId: strict.tenantId,
        intentId: intent.id,
        actorUserId,
        actorSessionId,
        idempotencyKey: randomUUID(),
        kind: 'non_execution',
        chargeMinorUnits: '0',
        usage: {},
        evidenceReference: 'private-no-execution',
        evidenceSha256: 'e'.repeat(64),
        supportTicketRef: 'private-ticket',
        reason: 'private-reason',
      });
      assert.equal((await detail(intent))?.status, 'unknown');
      await journal.runOnce();
      assert.equal((await detail(intent))?.status, 'failed');
      assert.equal((await detail(intent))?.financialStatus, 'released');
      assert.equal((await detail(intent))?.reconciliationState, 'resolved');
      assert.equal((await detail(intent))?.usageEvents[0]?.billableBasis, 'not_billable');
    },
  );

  await t.test(
    'verified usage on an original non-2xx failure settles money without fabricating HTTP success',
    async () => {
      await new FastGatewayResolutionService(control).resolve({
        tenantId: strict.tenantId,
        intentId: failed.id,
        actorUserId,
        actorSessionId,
        idempotencyKey: randomUUID(),
        kind: 'verified_usage',
        chargeMinorUnits: '2',
        usage: receiptFixture(failed, '2').usage,
        evidenceReference: 'private-failed-usage',
        evidenceSha256: 'e'.repeat(64),
        supportTicketRef: 'private-ticket',
        reason: 'private-reason',
      });
      await journal.runOnce();
      assert.equal((await detail(failed))?.status, 'failed');
      assert.equal((await detail(failed))?.financialStatus, 'settled');
      assert.equal((await detail(failed))?.usageEvents[0]?.inputTotal, '2');
    },
  );

  await t.test('fast numeric counts and mixed aggregates remain exact beyond JavaScript safe integers', async () => {
    const before = await queries.getUsageSummary({ ...scope, ...range });
    const big = await byokAt(5, '9007199254740993');
    assert.equal((await detail(big))?.usageEvents[0]?.inputTotal, '9007199254740993');
    const after = await queries.getUsageSummary({ ...scope, ...range });
    assert.equal(after?.inputTotal, (BigInt(before?.inputTotal ?? '0') + 9007199254740993n).toString());
  });

  await t.test('ambiguous aliases and cross-backend duplicate ids fail closed rather than double-count', async () => {
    const aliasCollision = await byokAt(3, '0', paid.id);
    await assert.rejects(
      queries.getRequest({ ...scope, requestId: paid.id }),
      (error: unknown) => error instanceof SaasConsoleQueryError,
    );
    assert.equal((await queries.getRequest({ ...scope, requestId: aliasCollision.id }))?.id, paid.id);
    await byokAt(4, '0', strict.input.requestId);
    await assert.rejects(
      queries.getRequest({ ...scope, requestId: strict.input.requestId }),
      (error: unknown) => error instanceof SaasConsoleQueryError,
    );
    await assert.rejects(queries.listRequests(scope), (error: unknown) => error instanceof SaasConsoleQueryError);
    await assert.rejects(
      queries.getUsageSummary({ ...scope, ...range }),
      (error: unknown) => error instanceof SaasConsoleQueryError,
    );
  });
});
