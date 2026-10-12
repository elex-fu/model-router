import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { verifySaasRuntimeDatabasePrivileges } from '../../../src/saas/db/index.js';
import type { SaasDatabase } from '../../../src/saas/db/types.js';
import { MarketingPromoCodeService, MarketingPromoError } from '../../../src/saas/marketing/promo-codes.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import {
  anyRoleConfigured,
  observedDatabase,
  REQUIRED_FLAG,
  roleUrls,
  safeCodes,
} from '../metering/normal-success-postgres-fixture.js';
import { FakePaymentProvider } from '../payments/fake-sql.js';

// R1/G2 real-PG gate: marketing promo codes (migration 090) under the
// preprovisioned restricted roles. The operations lifecycle and the checkout
// evaluator run under the restricted control-plane role against the real
// PaymentFulfillmentService: the discounted amount is frozen on the order,
// the original amount stays insert-only, concurrent single-use checkouts
// never oversell, and the gateway role has zero promo privileges. No
// bootstrap, HTTP fixture, migrations, DDL, role changes or provider
// traffic; the fixture authority seeds only the identity rows the flow needs.

interface Seed {
  actorUserId: string;
  tenantId: string;
  otherTenantId: string;
}

async function seedIdentities(migrator: SaasDatabase, label: string): Promise<Seed> {
  const actorUserId = randomUUID();
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  await migrator.query(
    `INSERT INTO model_router_saas.saas_users (id, email, password_hash, display_name, created_at, updated_at)
     VALUES ($1, $2, 'x', 'r1-actor', now(), now())`,
    [actorUserId, `r1-actor-${label}@example.invalid`],
  );
  await migrator.query(
    `INSERT INTO model_router_saas.saas_tenants (id, name, slug, status, created_at, updated_at)
     VALUES ($1, 'r1-tenant', $2, 'active', now(), now()), ($3, 'r1-other', $4, 'active', now(), now())`,
    [tenantId, `r1-tenant-${label}`, otherTenantId, `r1-other-${label}`],
  );
  return { actorUserId, tenantId, otherTenantId };
}

function checkoutService(database: SaasDatabase, promo: MarketingPromoCodeService, label: string) {
  const provider = new FakePaymentProvider(`r1-psp-${label}`);
  const service = new PaymentFulfillmentService(database, provider, {
    providerKey: provider.providerKey,
    merchantId: `r1-merchant-${label}`,
    walletTopUpPromo: promo,
  });
  return { provider, service };
}

test('R1 marketing promo codes run end-to-end under the restricted control-plane role with a frozen checkout snapshot', {
  skip:
    process.env[REQUIRED_FLAG] !== '1' && !anyRoleConfigured
      ? `set ${REQUIRED_FLAG}=1 and all three MODEL_ROUTER_SAAS_GATEWAY_E2E role URLs to require R1-090`
      : undefined,
}, async (t) => {
  const [migratorUrl, controlUrl, gatewayUrl] = roleUrls();
  const migrator = observedDatabase(migratorUrl);
  const control = observedDatabase(controlUrl);
  const controlSecond = observedDatabase(controlUrl);
  const gateway = observedDatabase(gatewayUrl);
  const label = randomUUID().slice(0, 8);
  const seed = await seedIdentities(migrator.database, label);
  const promo = new MarketingPromoCodeService({ database: control.database });
  try {
    await t.test('operations lifecycle: create, list and disable with audit under the control-plane role', async () => {
      const percent = await promo.createPromoCode(
        { userId: seed.actorUserId },
        { kind: 'percent_off', code: `r1-ops-${label}`, percentBp: 2000, maxUses: 100 },
      );
      assert.equal(percent.code, `r1-ops-${label}`.toUpperCase());
      assert.equal(percent.kind, 'percent_off');
      assert.equal(percent.percentBp, 2000);
      assert.equal(percent.maxUses, 100);
      assert.equal(percent.perTenantOnce, true);
      assert.equal(percent.status, 'active');

      const amount = await promo.createPromoCode(
        { userId: seed.actorUserId },
        {
          kind: 'amount_off',
          code: `R1-FLAT-${label}`.toUpperCase(),
          amountMinorUnits: '700',
          currency: 'USD',
          perTenantOnce: false,
        },
      );
      assert.equal(amount.amountMinorUnits, '700');
      assert.equal(amount.currency, 'USD');

      await assert.rejects(
        promo.createPromoCode(
          { userId: seed.actorUserId },
          { kind: 'percent_off', code: `r1-ops-${label}`, percentBp: 1000 },
        ),
        (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_CODE_CONFLICT',
      );

      const listed = await promo.listPromoCodes({ userId: seed.actorUserId }, { status: 'active' });
      assert.ok(listed.codes.some((row) => row.id === percent.id));
      assert.ok(listed.codes.some((row) => row.id === amount.id));

      const disabled = await promo.disablePromoCode({ userId: seed.actorUserId }, amount.id);
      assert.equal(disabled.status, 'disabled');
      const activeOnly = await promo.listPromoCodes({ userId: seed.actorUserId }, { status: 'active' });
      assert.ok(!activeOnly.codes.some((row) => row.id === amount.id));

      const audits = await migrator.database.query<{ action: string; actor_user_id: string | null }>(
        `SELECT action, actor_user_id FROM model_router_saas.saas_audit_events
          WHERE target_id IN ($1, $2) ORDER BY occurred_at, id`,
        [percent.id, amount.id],
      );
      assert.deepEqual(audits.rows.map((row) => row.action).sort(), [
        'marketing.promo_code.created',
        'marketing.promo_code.created',
        'marketing.promo_code.disabled',
      ]);
      assert.ok(audits.rows.every((row) => row.actor_user_id === seed.actorUserId));
    });

    await t.test(
      'checkout chain: the evaluator freezes the discounted snapshot inside the order transaction',
      async () => {
        const code = await promo.createPromoCode(
          { userId: seed.actorUserId },
          { kind: 'percent_off', code: `r1-pay-${label}`, percentBp: 2000 },
        );
        const { provider, service } = checkoutService(control.database, promo, label);
        const order = await service.createWalletTopUp({
          tenantId: seed.tenantId,
          clientRequestId: `r1-order-${label}`,
          amountMinorUnits: '5000',
          currency: 'USD',
          promoCode: `r1-pay-${label}`,
        });
        assert.equal(order.amountMinorUnits, '4000', 'the customer sees the frozen discounted snapshot');
        assert.equal(provider.calls.length, 1);
        assert.equal(provider.calls[0]?.amountMinorUnits, '4000', 'the provider is submitted the discounted amount');

        const stored = await migrator.database.query<{
          amount_minor_units: string;
          original_amount_minor_units: string | null;
        }>(
          `SELECT amount_minor_units, original_amount_minor_units
           FROM model_router_saas.saas_payment_orders WHERE id = $1`,
          [order.id],
        );
        assert.equal(stored.rows[0]?.amount_minor_units, '4000');
        assert.equal(stored.rows[0]?.original_amount_minor_units, '5000', 'the pre-discount amount is insert-only');

        const usages = await migrator.database.query<{
          code_id: string;
          tenant_id: string;
          discount_minor_units: string;
          per_tenant_once: boolean;
        }>(
          `SELECT code_id, tenant_id, discount_minor_units, per_tenant_once
           FROM model_router_saas.saas_marketing_promo_usages WHERE order_id = $1`,
          [order.id],
        );
        assert.equal(usages.rows.length, 1);
        assert.equal(usages.rows[0]?.code_id, code.id);
        assert.equal(usages.rows[0]?.tenant_id, seed.tenantId);
        assert.equal(usages.rows[0]?.discount_minor_units, '1000');
        assert.equal(usages.rows[0]?.per_tenant_once, true, 'the frozen copy matches the code row');

        const usedAudit = await migrator.database.query<{
          action: string;
          tenant_id: string;
          actor_user_id: string | null;
        }>(
          `SELECT action, tenant_id, actor_user_id FROM model_router_saas.saas_audit_events
          WHERE action = 'marketing.promo_code.used' AND target_id = $1`,
          [code.id],
        );
        assert.equal(usedAudit.rows.length, 1);
        assert.equal(usedAudit.rows[0]?.tenant_id, seed.tenantId);
        assert.equal(usedAudit.rows[0]?.actor_user_id, null, 'checkout has no user identity');

        // Client-request replay returns the frozen snapshot without re-pricing.
        const replay = await service.createWalletTopUp({
          tenantId: seed.tenantId,
          clientRequestId: `r1-order-${label}`,
          amountMinorUnits: '5000',
          currency: 'USD',
          promoCode: `r1-pay-${label}`,
        });
        assert.equal(replay.id, order.id);
        assert.equal(replay.amountMinorUnits, '4000');
        assert.equal(provider.calls.length, 1, 'the provider is never resubmitted');
        const usageCount = await migrator.database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM model_router_saas.saas_marketing_promo_usages WHERE code_id = $1`,
          [code.id],
        );
        assert.equal(usageCount.rows[0]?.count, '1', 'a replay never double-charges the code');

        // The same tenant cannot spend a per-tenant-once code twice.
        await assert.rejects(
          service.createWalletTopUp({
            tenantId: seed.tenantId,
            clientRequestId: `r1-order-again-${label}`,
            amountMinorUnits: '5000',
            currency: 'USD',
            promoCode: `r1-pay-${label}`,
          }),
          (error: unknown) => error instanceof PaymentError && error.code === 'PROMO_CODE_INVALID',
        );
        const orderCount = await migrator.database.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM model_router_saas.saas_payment_orders WHERE tenant_id = $1`,
          [seed.tenantId],
        );
        assert.equal(orderCount.rows[0]?.count, '1', 'the refused checkout leaves no order row');
      },
    );

    await t.test('concurrent single-use checkouts on separate connections never oversell', async () => {
      const code = await promo.createPromoCode(
        { userId: seed.actorUserId },
        { kind: 'percent_off', code: `r1-race-${label}`, percentBp: 1000, maxUses: 1, perTenantOnce: false },
      );
      const first = checkoutService(control.database, promo, `${label}-a`);
      const secondPromo = new MarketingPromoCodeService({ database: controlSecond.database });
      const second = checkoutService(controlSecond.database, secondPromo, `${label}-b`);
      const [winner, loser] = await Promise.allSettled([
        first.service.createWalletTopUp({
          tenantId: seed.tenantId,
          clientRequestId: `r1-race-a-${label}`,
          amountMinorUnits: '2000',
          currency: 'USD',
          promoCode: `r1-race-${label}`,
        }),
        second.service.createWalletTopUp({
          tenantId: seed.otherTenantId,
          clientRequestId: `r1-race-b-${label}`,
          amountMinorUnits: '2000',
          currency: 'USD',
          promoCode: `r1-race-${label}`,
        }),
      ]);
      const outcomes = [winner, loser].map((entry) => entry.status).sort();
      assert.deepEqual(outcomes, ['fulfilled', 'rejected']);
      const rejected = [winner, loser].find((entry) => entry.status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof PaymentError && rejected.reason.code === 'PROMO_CODE_INVALID');
      const usages = await migrator.database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM model_router_saas.saas_marketing_promo_usages WHERE code_id = $1`,
        [code.id],
      );
      assert.equal(usages.rows[0]?.count, '1', 'max_uses=1 admits exactly one checkout');
    });

    await t.test('the original amount is insert-only and the guard refuses rewrites', async () => {
      const order = await migrator.database.query<{ id: string }>(
        `SELECT id FROM model_router_saas.saas_payment_orders
          WHERE original_amount_minor_units IS NOT NULL ORDER BY created_at LIMIT 1`,
        [],
      );
      const orderId = order.rows[0]?.id as string;
      assert.ok(orderId);
      await assert.rejects(
        migrator.database.query(
          `UPDATE model_router_saas.saas_payment_orders SET original_amount_minor_units = '1' WHERE id = $1`,
          [orderId],
        ),
        (error: unknown) => safeCodes(error).sqlState === '55006',
      );
    });

    await t.test('gateway role has zero promo privileges and the runtime probe covers the grants', async () => {
      await verifySaasRuntimeDatabasePrivileges(control.database, 'control_plane');
      await assert.rejects(
        gateway.database.query(`SELECT id FROM model_router_saas.saas_marketing_promo_codes LIMIT 1`, []),
        (error: unknown) => safeCodes(error).sqlState === '42501',
      );
      await assert.rejects(
        gateway.database.query(
          `INSERT INTO model_router_saas.saas_marketing_promo_usages
             (id, code_id, tenant_id, order_id, discount_minor_units, per_tenant_once, created_at)
           VALUES ($1, $2, $3, $4, '1', false, now())`,
          [randomUUID(), randomUUID(), seed.tenantId, randomUUID()],
        ),
        (error: unknown) => safeCodes(error).sqlState === '42501',
      );
    });
  } finally {
    await migrator.database.close();
    await control.database.close();
    await controlSecond.database.close();
    await gateway.database.close();
  }
});
