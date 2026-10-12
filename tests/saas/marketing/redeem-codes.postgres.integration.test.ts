import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { MarketingRedeemCodeService, MarketingRedeemError } from '../../../src/saas/marketing/redeem-codes.js';
import { ByokServicePlanService } from '../../../src/saas/plans/service.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// G1 real-PG gate: marketing redeem codes (migration 089) under the
// preprovisioned restricted roles. The customer redemption posts into the
// platform wallet through the real PlatformWalletLedgerService (contract
// C-6, namespace marketing.redeem). G1.5: subscription codes grant through
// the real ByokServicePlanService marketing grant port inside the redeem
// transaction — subscription + entitlement rows land, the wallet never
// moves. No bootstrap, HTTP fixture, migrations, DDL, role changes or
// provider traffic; the fixture authority seeds only the identity, project
// and plan-catalog rows the flow needs.

interface Seed {
  actorUserId: string;
  tenantId: string;
  userId: string;
  otherTenantId: string;
}

async function seedIdentities(migrator: SaasDatabase, label: string): Promise<Seed> {
  const actorUserId = randomUUID();
  const userId = randomUUID();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  await migrator.query(
    `INSERT INTO model_router_saas.saas_users (id, email, password_hash, display_name, created_at, updated_at)
     VALUES ($1, $2, 'x', 'g1-actor', now(), now()), ($3, $4, 'x', 'g1-user', now(), now())`,
    [actorUserId, `g1-actor-${label}@example.invalid`, userId, `g1-user-${label}@example.invalid`],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_tenants (id, name, slug, status, created_at, updated_at)
     VALUES ($1, 'g1-tenant', $2, 'active', now(), now()), ($3, 'g1-other', $4, 'active', now(), now())`,
    [tenantId, `g1-tenant-${label}`, otherTenantId, `g1-other-${label}`],
  );
  return { actorUserId, tenantId, userId, otherTenantId };
}

test('G1 marketing redeem codes run end-to-end under the restricted control-plane role with real ledger posting', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require G1-089`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const seed = await seedIdentities(migrator.database, randomUUID().slice(0, 8));
  const service = new MarketingRedeemCodeService({
    database: control.database,
    fundingLedger: new PlatformWalletLedgerService(),
    subscriptionGrants: new ByokServicePlanService(control.database),
  });
  try {
    await t.test('generate, redeem, replay, concurrent and disable lifecycle with wallet posting', async () => {
      const { batchRef, codes } = await service.generateBalanceCodes(
        { userId: seed.actorUserId },
        { count: 2, amountMinorUnits: '2500', currency: 'CNY', batchRef: `g1-${randomUUID().slice(0, 8)}` },
      );
      assert.equal(codes.length, 2);
      assert.match(batchRef, /^g1-/);

      const result = await service.redeem(
        { tenantId: seed.tenantId, userId: seed.userId },
        { code: codes[0] as string },
      );
      assert.equal(result.outcome, 'redeemed');
      assert.equal(result.amountMinorUnits, '2500');

      const wallet = await migrator.database.query<{ posted_balance_minor_units: string }>(
        `SELECT posted_balance_minor_units FROM model_router_saas.saas_wallets WHERE tenant_id = $1 AND currency = 'CNY'`,
        [seed.tenantId],
      );
      assert.equal(wallet.rows[0]?.posted_balance_minor_units, '2500');
      const ledger = await migrator.database.query<{ idempotency_namespace: string; business_key: string }>(
        `SELECT idempotency_namespace, business_key FROM model_router_saas.saas_ledger_transactions WHERE id = $1`,
        [result.ledgerTransactionId],
      );
      assert.equal(ledger.rows[0]?.idempotency_namespace, 'marketing.redeem');
      assert.equal(ledger.rows[0]?.business_key, `${result.codeId}:${seed.tenantId}`);

      const replay = await service.redeem(
        { tenantId: seed.tenantId, userId: seed.userId },
        { code: codes[0] as string },
      );
      assert.equal(replay.outcome, 'replayed');
      assert.equal(replay.ledgerTransactionId, result.ledgerTransactionId);
      const balanceAfterReplay = await migrator.database.query<{ posted_balance_minor_units: string }>(
        `SELECT posted_balance_minor_units FROM model_router_saas.saas_wallets WHERE tenant_id = $1 AND currency = 'CNY'`,
        [seed.tenantId],
      );
      assert.equal(balanceAfterReplay.rows[0]?.posted_balance_minor_units, '2500', 'a replay never re-posts');

      await assert.rejects(
        service.redeem({ tenantId: seed.otherTenantId, userId: seed.userId }, { code: codes[0] as string }),
        (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
      );

      // Concurrent same-tenant redemption of the second code: exactly one
      // winner, the loser replays, and the wallet moves exactly once.
      const [first, second] = await Promise.allSettled([
        service.redeem({ tenantId: seed.tenantId, userId: seed.userId }, { code: codes[1] as string }),
        service.redeem({ tenantId: seed.tenantId, userId: seed.userId }, { code: codes[1] as string }),
      ]);
      const outcomes = [first, second].map((entry) => {
        assert.equal(entry.status, 'fulfilled');
        return entry.value.outcome;
      });
      assert.deepEqual([...outcomes].sort(), ['redeemed', 'replayed']);
      const finalBalance = await migrator.database.query<{ posted_balance_minor_units: string }>(
        `SELECT posted_balance_minor_units FROM model_router_saas.saas_wallets WHERE tenant_id = $1 AND currency = 'CNY'`,
        [seed.tenantId],
      );
      assert.equal(finalBalance.rows[0]?.posted_balance_minor_units, '5000');
      const postingCount = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_ledger_transactions
            WHERE tenant_id = $1 AND idempotency_namespace = 'marketing.redeem'`,
        [seed.tenantId],
      );
      assert.equal(postingCount.rows[0]?.count, '2', 'two codes, two postings — never a duplicate');

      // A third code exercises the disable path: redeemed codes cannot be
      // disabled (STATE_CONFLICT), a disabled code redeems as INVALID.
      const third = await service.generateBalanceCodes(
        { userId: seed.actorUserId },
        { count: 1, amountMinorUnits: '700', currency: 'CNY' },
      );
      const thirdCodeId = await migrator.database.query<{ id: string }>(
        `SELECT id FROM model_router_saas.saas_marketing_redeem_codes WHERE batch_ref = $1`,
        [third.batchRef],
      );
      const thirdId = thirdCodeId.rows[0]?.id as string;
      await assert.rejects(
        service.disableCode({ userId: seed.actorUserId }, result.codeId),
        (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
      );
      const disabled = await service.disableCode({ userId: seed.actorUserId }, thirdId);
      assert.equal(disabled.status, 'disabled');
      await assert.rejects(
        service.redeem({ tenantId: seed.tenantId, userId: seed.userId }, { code: third.codes[0] as string }),
        (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_INVALID',
      );
    });

    await t.test('G1.5 subscription codes grant a plan subscription inside the redeem transaction', async () => {
      const label = randomUUID().slice(0, 8);
      const subSeed = await seedIdentities(migrator.database, label);
      const projectId = randomUUID();
      const profileId = `g1-profile-${label}`;
      const planId = `g1-plan-${label}`;
      const planVersionId = randomUUID();
      await migrator.database.query(
        `INSERT INTO model_router_saas.saas_projects (tenant_id, id, name, slug, is_default, created_at, updated_at)
         VALUES ($1, $2, 'g1-project', $3, TRUE, now(), now())`,
        [subSeed.tenantId, projectId, `g1-project-${label}`],
      );
      await migrator.database.query(
        `INSERT INTO model_router_saas.saas_supply_profiles
           (tenant_id, id, supply_mode, status, model_scopes, authz_version, created_at, updated_at, last_audited_at)
         VALUES ($1, $2, 'byok', 'active', $3, 1, now(), now(), now())`,
        [subSeed.tenantId, profileId, ['g1-model-a', 'g1-model-b']],
      );
      await migrator.database.query(
        `INSERT INTO model_router_saas.saas_service_plans (id, slug, display_name, status, created_at, updated_at)
         VALUES ($1, $2, 'G1.5 grant plan', 'published', now(), now())`,
        [planId, `g1-plan-slug-${label}`],
      );
      await migrator.database.query(
        `INSERT INTO model_router_saas.saas_service_plan_versions
           (id, plan_id, version, supply_mode, supply_profile_id, allowed_provider_ids, allowed_models,
            price_version, price_minor_units, currency, term_days, policy_version, status, created_at, published_at)
         VALUES ($1, $2, 1, 'byok', $3, $4, $5, 'price-v1', 1200, 'USD', 30, 'policy-v1', 'published', now(), now())`,
        [planVersionId, planId, profileId, ['provider-a'], ['g1-model-a', 'g1-model-b']],
      );

      // Generation validates the plan version: an unknown version refuses
      // before any code row is written.
      await assert.rejects(
        service.generateSubscriptionCodes(
          { userId: subSeed.actorUserId },
          { count: 1, servicePlanVersionId: randomUUID() },
        ),
        (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_INVALID_INPUT',
      );

      const generated = await service.generateSubscriptionCodes(
        { userId: subSeed.actorUserId },
        { count: 2, servicePlanVersionId: planVersionId, batchRef: `g1-sub-${label}` },
      );
      assert.equal(generated.codes.length, 2);

      const result = await service.redeem(
        { tenantId: subSeed.tenantId, userId: subSeed.userId },
        { code: generated.codes[0] as string },
      );
      if (result.kind !== 'subscription') assert.fail('expected a subscription-kind redeem result');
      assert.equal(result.outcome, 'redeemed');
      assert.equal(result.servicePlanVersionId, planVersionId);

      const orders = await migrator.database.query<{
        id: string;
        state: string;
        client_request_id: string;
        subscription_id: string | null;
        verified_settlement_id: string | null;
      }>(
        `SELECT id, state, client_request_id, subscription_id, verified_settlement_id
         FROM model_router_saas.saas_service_plan_orders WHERE tenant_id = $1`,
        [subSeed.tenantId],
      );
      assert.equal(orders.rows.length, 1);
      assert.equal(orders.rows[0]?.state, 'cancelled', 'the grant order shell is terminal and unpayable');
      assert.equal(orders.rows[0]?.client_request_id, `marketing-redeem:${result.codeId}`);
      assert.equal(orders.rows[0]?.subscription_id, result.subscriptionId);
      assert.equal(orders.rows[0]?.verified_settlement_id, null, 'no payment evidence is fabricated');

      const subscriptions = await migrator.database.query<{
        project_id: string;
        entitlement_id: string;
        status: string;
        term_matches: boolean;
      }>(
        `SELECT project_id, entitlement_id, status,
                (expires_at = effective_at + interval '30 days') AS term_matches
         FROM model_router_saas.saas_service_plan_subscriptions WHERE id = $1`,
        [result.subscriptionId],
      );
      assert.equal(subscriptions.rows[0]?.project_id, projectId, 'the grant lands on the default project');
      assert.equal(subscriptions.rows[0]?.status, 'active');
      assert.equal(subscriptions.rows[0]?.term_matches, true, 'term_days runs from the redemption instant');
      assert.equal(subscriptions.rows[0]?.entitlement_id, result.entitlementId);

      const entitlements = await migrator.database.query<{
        status: string;
        source_type: string;
        source_ref: string;
        service_plan_snapshot_id: string | null;
        authz_version: string;
        model_scopes: string[];
      }>(
        `SELECT status, source_type, source_ref, service_plan_snapshot_id, authz_version::text, model_scopes
         FROM model_router_saas.saas_project_entitlements WHERE id = $1`,
        [result.entitlementId],
      );
      assert.equal(entitlements.rows[0]?.status, 'active');
      assert.equal(entitlements.rows[0]?.source_type, 'service_plan');
      assert.equal(
        entitlements.rows[0]?.source_ref,
        orders.rows[0]?.id,
        'the entitlement chain resolves through the grant order shell',
      );
      assert.ok(entitlements.rows[0]?.service_plan_snapshot_id);
      assert.equal(entitlements.rows[0]?.authz_version, '1');
      assert.deepEqual(entitlements.rows[0]?.model_scopes, ['g1-model-a', 'g1-model-b']);

      const redemption = await migrator.database.query<{ ledger_transaction_id: string | null }>(
        `SELECT ledger_transaction_id FROM model_router_saas.saas_marketing_redeem_redemptions WHERE code_id = $1`,
        [result.codeId],
      );
      assert.equal(
        redemption.rows[0]?.ledger_transaction_id,
        null,
        'subscription redemptions carry no ledger reference',
      );

      const walletRows = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_wallets WHERE tenant_id = $1`,
        [subSeed.tenantId],
      );
      assert.equal(walletRows.rows[0]?.count, '0', 'the grant never opens a wallet');
      const ledgerRows = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_ledger_transactions WHERE tenant_id = $1`,
        [subSeed.tenantId],
      );
      assert.equal(ledgerRows.rows[0]?.count, '0', 'the grant never posts to the ledger');

      const audits = await migrator.database.query<{ action: string; entry_point: string; target_id: string }>(
        `SELECT action, entry_point, target_id FROM model_router_saas.saas_audit_events
         WHERE tenant_id = $1 ORDER BY occurred_at, id`,
        [subSeed.tenantId],
      );
      const grantAudit = audits.rows.find((row) => row.action === 'service_plan.marketing_grant');
      assert.ok(grantAudit, 'the grant carries its own distinguishable audit action');
      assert.equal(grantAudit.entry_point, 'saas_plans');
      assert.equal(grantAudit.target_id, result.subscriptionId);
      assert.ok(audits.rows.some((row) => row.action === 'marketing.redeem.completed'));

      // Replay: the same tenant re-redeems and reads back the original grant.
      const replay = await service.redeem(
        { tenantId: subSeed.tenantId, userId: subSeed.userId },
        { code: generated.codes[0] as string },
      );
      assert.equal(replay.outcome, 'replayed');
      if (replay.kind !== 'subscription') assert.fail('expected a subscription-kind replay result');
      assert.equal(replay.subscriptionId, result.subscriptionId);
      const subscriptionCount = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_service_plan_subscriptions WHERE tenant_id = $1`,
        [subSeed.tenantId],
      );
      assert.equal(subscriptionCount.rows[0]?.count, '1', 'a replay never grants twice');
      const orderCount = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_service_plan_orders WHERE tenant_id = $1`,
        [subSeed.tenantId],
      );
      assert.equal(orderCount.rows[0]?.count, '1');

      // A second subscription code collides with the now-active grant: the
      // redemption refuses and rolls back, leaving the second code active.
      await assert.rejects(
        service.redeem({ tenantId: subSeed.tenantId, userId: subSeed.userId }, { code: generated.codes[1] as string }),
        (error: unknown) => error instanceof MarketingRedeemError && error.code === 'REDEEM_CODE_STATE_CONFLICT',
      );
      const secondCode = await migrator.database.query<{ status: string }>(
        `SELECT c.status FROM model_router_saas.saas_marketing_redeem_codes c
         WHERE c.batch_ref = $1 AND c.id <> $2 ORDER BY c.created_at, c.id`,
        [generated.batchRef, result.codeId],
      );
      assert.equal(secondCode.rows[0]?.status, 'active', 'the failed grant rolls the whole redemption back');
      const entitlementCount = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_project_entitlements WHERE tenant_id = $1`,
        [subSeed.tenantId],
      );
      assert.equal(entitlementCount.rows[0]?.count, '1', 'no partial entitlement survives the rollback');
    });

    await t.test('gateway role has zero marketing privileges and the runtime probe covers the grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await assert.rejects(
        gateway.database.query(`SELECT id FROM model_router_saas.saas_marketing_redeem_codes LIMIT 1`, []),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
      await assert.rejects(
        gateway.database.query(
          `INSERT INTO model_router_saas.saas_marketing_redeem_redemptions
               (id, code_id, tenant_id, user_id) VALUES ($1, $2, $3, $4)`,
          [randomUUID(), randomUUID(), seed.tenantId, seed.userId],
        ),
        (error: unknown) => (error as { code?: string }).code === '42501',
      );
    });
  } finally {
    await migrator.database.close();
    await control.database.close();
    await gateway.database.close();
  }
});
