import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PlatformWalletLedgerService } from '../../../src/saas/billing/service.js';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { MarketingAffiliateError, MarketingAffiliateService } from '../../../src/saas/marketing/affiliate.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
} from '../metering/normal-success-postgres-fixture.js';

// R2/G3 real-PG gate: marketing affiliate rebates (migration 091) under the
// preprovisioned restricted roles. Binding, policy CAS and the fulfillment
// accrual hook run as control_plane; the inviter reward posts through the
// real PlatformWalletLedgerService (contract C-6, namespace
// marketing.affiliate, business key <source funding ref>:<inviter tenant>)
// inside the same transaction as the invitee's verified funding posting —
// the exact WalletFundingHook seam the payment fulfillment worker calls.
// No bootstrap, HTTP fixture, migrations, DDL, role changes or provider
// traffic; the migrator authority seeds only the identity rows the flow
// needs.

const SALT = 'affiliate-pg-gate-deployment-salt';

interface Seed {
  opsUserId: string;
  customerUserId: string;
  inviterTenantId: string;
  inviteeTenantId: string;
  thirdTenantId: string;
}

async function seedIdentities(migrator: SaasDatabase, label: string): Promise<Seed> {
  const opsUserId = randomUUID();
  const customerUserId = randomUUID();
  const inviterTenantId = randomUUID();
  const inviteeTenantId = randomUUID();
  const thirdTenantId = randomUUID();
  await migrator.query(
    `INSERT INTO model_router_saas.saas_users (id, email, password_hash, display_name, created_at, updated_at)
     VALUES ($1, $2, 'x', 'r2-ops', now(), now()), ($3, $4, 'x', 'r2-customer', now(), now())`,
    [opsUserId, `r2-ops-${label}@example.invalid`, customerUserId, `r2-customer-${label}@example.invalid`],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_tenants (id, name, slug, status, created_at, updated_at)
     VALUES ($1, 'r2-inviter', $2, 'active', now(), now()),
            ($3, 'r2-invitee', $4, 'active', now(), now()),
            ($5, 'r2-third', $6, 'active', now(), now())`,
    [
      inviterTenantId,
      `r2-inviter-${label}`,
      inviteeTenantId,
      `r2-invitee-${label}`,
      thirdTenantId,
      `r2-third-${label}`,
    ],
  );
  return { opsUserId, customerUserId, inviterTenantId, inviteeTenantId, thirdTenantId };
}

test('R2 marketing affiliate runs end-to-end under the restricted control-plane role with real ledger posting', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require R2-091`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const seed = await seedIdentities(migrator.database, randomUUID().slice(0, 8));
  const service = new MarketingAffiliateService({
    database: control.database,
    fundingLedger: new PlatformWalletLedgerService(),
    inviteCodeSalt: SALT,
  });
  try {
    await t.test('invite code derivation, binding invariants and replay', async () => {
      const mine = await service.getMyAffiliate({ tenantId: seed.inviterTenantId, userId: seed.customerUserId }, {});
      assert.match(mine.inviteCode, /^[A-Z2-7]{16}$/);
      assert.equal(mine.invitedCount, 0);
      assert.equal(mine.rewards.length, 0);

      const bound = await service.bindInviter(
        { tenantId: seed.inviteeTenantId, userId: seed.customerUserId },
        { inviteCode: mine.inviteCode },
      );
      assert.deepEqual(bound, { outcome: 'bound', inviterTenantId: seed.inviterTenantId });
      const attribution = await migrator.database.query<{ inviter_tenant_id: string; invite_code: string }>(
        `SELECT inviter_tenant_id, invite_code FROM model_router_saas.saas_marketing_affiliate_attributions
         WHERE invitee_tenant_id = $1`,
        [seed.inviteeTenantId],
      );
      assert.equal(attribution.rows[0]?.inviter_tenant_id, seed.inviterTenantId);
      assert.equal(attribution.rows[0]?.invite_code, mine.inviteCode, 'the presented code is snapshotted');

      const replay = await service.bindInviter(
        { tenantId: seed.inviteeTenantId, userId: seed.customerUserId },
        { inviteCode: mine.inviteCode },
      );
      assert.deepEqual(replay, { outcome: 'replayed', inviterTenantId: seed.inviterTenantId });

      // The third tenant binds to the invitee, then the inviter trying to
      // bind back down the chain would close a cycle and is refused.
      const inviteeView = await service.getMyAffiliate(
        { tenantId: seed.inviteeTenantId, userId: seed.customerUserId },
        {},
      );
      await service.bindInviter(
        { tenantId: seed.thirdTenantId, userId: seed.customerUserId },
        { inviteCode: inviteeView.inviteCode },
      );
      await assert.rejects(
        service.bindInviter(
          { tenantId: seed.inviterTenantId, userId: seed.customerUserId },
          {
            inviteCode: (
              await service.getMyAffiliate({ tenantId: seed.thirdTenantId, userId: seed.customerUserId }, {})
            ).inviteCode,
          },
        ),
        (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_CYCLE',
      );
      await assert.rejects(
        service.bindInviter(
          { tenantId: seed.inviterTenantId, userId: seed.customerUserId },
          { inviteCode: mine.inviteCode },
        ),
        (error: unknown) => error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_SELF_INVITE',
      );

      const after = await service.getMyAffiliate({ tenantId: seed.inviterTenantId, userId: seed.customerUserId }, {});
      assert.equal(after.invitedCount, 1);
    });

    await t.test('policy CAS, fulfillment accrual, replay idempotency and policy snapshot history', async () => {
      // The template may carry a leftover policy head from an earlier probe,
      // so the CAS is anchored to the live version instead of assuming an
      // empty head; the v0-first-write branch is covered by the unit suite.
      const head = await service.getAffiliatePolicy({ userId: seed.opsUserId });
      const created = await service.replaceAffiliatePolicy(
        { userId: seed.opsUserId },
        { rewardBp: 250, enabled: true, expectedVersion: head.version },
      );
      assert.equal(created.version, head.version + 1);
      assert.equal(created.rewardBp, 250);
      assert.equal(created.enabled, true);
      await assert.rejects(
        service.replaceAffiliatePolicy(
          { userId: seed.opsUserId },
          { rewardBp: 999, enabled: true, expectedVersion: head.version },
        ),
        (error: unknown) =>
          error instanceof MarketingAffiliateError && error.code === 'AFFILIATE_POLICY_VERSION_CONFLICT',
      );

      const ledger = new PlatformWalletLedgerService();
      const sourceOrderRef = randomUUID();
      // The payment fulfillment seam: the invitee's verified funding posting
      // and the affiliate hook share one transaction, exactly as the
      // walletFundingHook call site wires them.
      await control.database.transaction(async (executor) => {
        const funding = await ledger.postVerifiedFunding(executor, {
          tenantId: seed.inviteeTenantId,
          currency: 'CNY',
          amountMinorUnits: '10000',
          sourceOrderRef,
          idempotencyKey: sourceOrderRef,
          idempotencyNamespace: 'saas.payment.wallet_topup',
          metadataRef: `payment-order:${sourceOrderRef}`,
        });
        await service.afterVerifiedFunding(executor, {
          tenantId: seed.inviteeTenantId,
          currency: 'CNY',
          amountMinorUnits: '10000',
          sourceOrderRef,
          fundingTransactionId: funding.transactionId,
        });
      });

      const inviterWallet = await migrator.database.query<{ posted_balance_minor_units: string }>(
        `SELECT posted_balance_minor_units FROM model_router_saas.saas_wallets
         WHERE tenant_id = $1 AND currency = 'CNY'`,
        [seed.inviterTenantId],
      );
      assert.equal(inviterWallet.rows[0]?.posted_balance_minor_units, '250', 'floor(10000 * 250 / 10000)');

      const rewards = await migrator.database.query<{
        id: string;
        inviter_tenant_id: string;
        invitee_tenant_id: string;
        source_amount_minor_units: string;
        reward_amount_minor_units: string;
        currency: string;
        reward_bp_snapshot: number;
        ledger_transaction_id: string;
      }>(
        `SELECT id, inviter_tenant_id, invitee_tenant_id, source_amount_minor_units, reward_amount_minor_units,
                currency, reward_bp_snapshot, ledger_transaction_id
         FROM model_router_saas.saas_marketing_affiliate_rewards WHERE source_funding_ref = $1`,
        [sourceOrderRef],
      );
      assert.equal(rewards.rows.length, 1);
      assert.equal(rewards.rows[0]?.inviter_tenant_id, seed.inviterTenantId);
      assert.equal(rewards.rows[0]?.invitee_tenant_id, seed.inviteeTenantId);
      assert.equal(rewards.rows[0]?.source_amount_minor_units, '10000');
      assert.equal(rewards.rows[0]?.reward_amount_minor_units, '250');
      assert.equal(rewards.rows[0]?.reward_bp_snapshot, 250, 'the policy basis points are snapshotted');

      const ledgerTx = await migrator.database.query<{ idempotency_namespace: string; business_key: string }>(
        `SELECT idempotency_namespace, business_key FROM model_router_saas.saas_ledger_transactions WHERE id = $1`,
        [rewards.rows[0]?.ledger_transaction_id as string],
      );
      assert.equal(ledgerTx.rows[0]?.idempotency_namespace, 'marketing.affiliate');
      assert.equal(ledgerTx.rows[0]?.business_key, `${sourceOrderRef}:${seed.inviterTenantId}`);

      const accrualAudit = await migrator.database.query<{ action: string; tenant_id: string }>(
        `SELECT action, tenant_id FROM model_router_saas.saas_audit_events
         WHERE action = 'marketing.affiliate.reward_accrued' AND target_id = $1`,
        [rewards.rows[0]?.id as string],
      );
      assert.equal(accrualAudit.rows.length, 1);
      assert.equal(accrualAudit.rows[0]?.tenant_id, seed.inviterTenantId);

      // Inbox-retry replay of the hook: no duplicate reward, no wallet drift.
      await control.database.transaction(async (executor) => {
        await service.afterVerifiedFunding(executor, {
          tenantId: seed.inviteeTenantId,
          currency: 'CNY',
          amountMinorUnits: '10000',
          sourceOrderRef,
          fundingTransactionId: randomUUID(),
        });
      });
      const rewardCount = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_marketing_affiliate_rewards
         WHERE source_funding_ref = $1`,
        [sourceOrderRef],
      );
      assert.equal(rewardCount.rows[0]?.count, '1', 'ON CONFLICT absorbs the replay');
      const walletAfterReplay = await migrator.database.query<{ posted_balance_minor_units: string }>(
        `SELECT posted_balance_minor_units FROM model_router_saas.saas_wallets
         WHERE tenant_id = $1 AND currency = 'CNY'`,
        [seed.inviterTenantId],
      );
      assert.equal(walletAfterReplay.rows[0]?.posted_balance_minor_units, '250', 'a replay never re-posts');

      // Policy replacement never rewrites the stored snapshot; the next
      // funding accrues at the new rate.
      await service.replaceAffiliatePolicy(
        { userId: seed.opsUserId },
        { rewardBp: 1000, enabled: true, expectedVersion: created.version },
      );
      const secondRef = randomUUID();
      await control.database.transaction(async (executor) => {
        const funding = await ledger.postVerifiedFunding(executor, {
          tenantId: seed.thirdTenantId,
          currency: 'CNY',
          amountMinorUnits: '1000',
          sourceOrderRef: secondRef,
          idempotencyKey: secondRef,
          idempotencyNamespace: 'saas.payment.wallet_topup',
          metadataRef: `payment-order:${secondRef}`,
        });
        await service.afterVerifiedFunding(executor, {
          tenantId: seed.thirdTenantId,
          currency: 'CNY',
          amountMinorUnits: '1000',
          sourceOrderRef: secondRef,
          fundingTransactionId: funding.transactionId,
        });
      });
      const secondReward = await migrator.database.query<{
        inviter_tenant_id: string;
        reward_amount_minor_units: string;
        reward_bp_snapshot: number;
      }>(
        `SELECT inviter_tenant_id, reward_amount_minor_units, reward_bp_snapshot
         FROM model_router_saas.saas_marketing_affiliate_rewards WHERE source_funding_ref = $1`,
        [secondRef],
      );
      assert.equal(secondReward.rows[0]?.inviter_tenant_id, seed.inviteeTenantId, 'the third tenant invites upward');
      assert.equal(secondReward.rows[0]?.reward_amount_minor_units, '100', 'floor(1000 * 1000 / 10000)');
      assert.equal(secondReward.rows[0]?.reward_bp_snapshot, 1000);
      const firstReward = await migrator.database.query<{
        reward_bp_snapshot: number;
        reward_amount_minor_units: string;
      }>(
        `SELECT reward_bp_snapshot, reward_amount_minor_units
         FROM model_router_saas.saas_marketing_affiliate_rewards WHERE source_funding_ref = $1`,
        [sourceOrderRef],
      );
      assert.equal(firstReward.rows[0]?.reward_bp_snapshot, 250, 'history is never rewritten');
      assert.equal(firstReward.rows[0]?.reward_amount_minor_units, '250');

      const listed = await service.listRewards({ userId: seed.opsUserId }, { inviterTenantId: seed.inviterTenantId });
      assert.equal(listed.rewards.length, 1);
      assert.equal(listed.rewards[0]?.sourceFundingRef, sourceOrderRef);
    });

    await t.test('gateway role has zero affiliate privileges and the runtime probe covers the grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      for (const table of [
        'saas_marketing_affiliate_attributions',
        'saas_marketing_affiliate_policies',
        'saas_marketing_affiliate_rewards',
      ]) {
        await assert.rejects(
          gateway.database.query(`SELECT * FROM model_router_saas.${table} LIMIT 1`, []),
          (error: unknown) => (error as { code?: string }).code === '42501',
          table,
        );
      }
      await assert.rejects(
        gateway.database.query(
          `INSERT INTO model_router_saas.saas_marketing_affiliate_attributions
             (invitee_tenant_id, inviter_tenant_id, invite_code) VALUES ($1, $2, 'ABCDEFGH')`,
          [randomUUID(), seed.inviterTenantId],
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
