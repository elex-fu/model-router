import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { MarketingPromoCodeService } from '../../../src/saas/marketing/promo-codes.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import { createFakeFundingLedger, FakePaymentDatabase, FakePaymentProvider } from './fake-sql.js';

// R1/G2 checkout seam integration (migration 090): the real
// MarketingPromoCodeService evaluator runs inside the payment order
// transaction against a promo-aware extension of FakePaymentDatabase. The
// promo tables roll back with the order transaction, the discounted amount is
// frozen on the order row, the original amount stays insert-only, and
// client-request replay never re-prices.

const NOW = '2026-10-11T00:00:00.000Z';
const CODE_ID = '00000000-0000-4000-8000-0000000000c1';

interface PromoCodeRow extends Record<string, unknown> {
  id: string;
  code: string;
  kind: string;
  percent_bp: number | null;
  amount_minor_units: string | null;
  currency: string | null;
  scope: string;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  per_tenant_once: boolean;
  status: string;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
}

interface PromoUsageRow extends Record<string, unknown> {
  id: string;
  code_id: string;
  tenant_id: string;
  order_id: string;
  discount_minor_units: string;
  per_tenant_once: boolean;
  created_at: string;
}

function promoCodeRow(overrides: Partial<PromoCodeRow> = {}): PromoCodeRow {
  return {
    id: CODE_ID,
    code: 'SAVE-25',
    kind: 'percent_off',
    percent_bp: 2500,
    amount_minor_units: null,
    currency: null,
    scope: 'wallet_topup',
    starts_at: null,
    ends_at: null,
    max_uses: null,
    per_tenant_once: true,
    status: 'active',
    created_by_user_id: '00000000-0000-4000-8000-0000000000a1',
    created_at: NOW,
    updated_at: NOW,
    disabled_at: null,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class PromoFakePaymentDatabase extends FakePaymentDatabase {
  promoCodes: PromoCodeRow[] = [];
  promoUsages: PromoUsageRow[] = [];
  promoAudit: Array<Record<string, unknown>> = [];

  override async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const before = {
      codes: clone(this.promoCodes),
      usages: clone(this.promoUsages),
      audit: clone(this.promoAudit),
    };
    try {
      return await super.transaction((executor) =>
        work({ query: (sql, values = []) => this.route(sql, values, executor) }),
      );
    } catch (error) {
      this.promoCodes = before.codes;
      this.promoUsages = before.usages;
      this.promoAudit = before.audit;
      throw error;
    }
  }

  private async route<Row>(sql: string, values: readonly unknown[], executor: SqlExecutor): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g] = values;
    const result = <R>(rows: R[] = []): SqlResult<R> => ({ rows: clone(rows), rowCount: rows.length });

    if (statement.includes('from model_router_saas.saas_marketing_promo_codes where code = $1 for update')) {
      const row = this.promoCodes.find((item) => item.code === a);
      return result<Row>(row ? [row as Row] : []);
    }

    if (
      statement.startsWith(
        'select id from model_router_saas.saas_marketing_promo_usages where code_id = $1 and tenant_id = $2',
      )
    ) {
      const row = this.promoUsages.find((item) => item.code_id === a && item.tenant_id === b);
      return result<Row>(row ? [{ id: row.id } as Row] : []);
    }

    if (statement.startsWith('select count(*)::text as used from model_router_saas.saas_marketing_promo_usages')) {
      const used = this.promoUsages.filter((item) => item.code_id === a).length;
      return result<Row>([{ used: String(used) } as Row]);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_promo_usages')) {
      if (this.promoUsages.some((item) => item.order_id === d)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      if (
        f === true &&
        this.promoUsages.some((item) => item.code_id === b && item.tenant_id === c && item.per_tenant_once)
      ) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      this.promoUsages.push({
        id: String(a),
        code_id: String(b),
        tenant_id: String(c),
        order_id: String(d),
        discount_minor_units: String(e),
        per_tenant_once: Boolean(f),
        created_at: String(g),
      });
      return result<Row>();
    }

    if (statement.startsWith('insert into model_router_saas.saas_audit_events')) {
      this.promoAudit.push({ id: a, tenant_id: b, actor_user_id: c, action: d, target_id: e, occurred_at: f });
      return result<Row>();
    }

    return executor.query<Row>(sql, values);
  }
}

function createFixture(options: { withPromo?: boolean; promoRows?: PromoCodeRow[] } = {}) {
  const database = new PromoFakePaymentDatabase();
  database.promoCodes.push(...(options.promoRows ?? []));
  const provider = new FakePaymentProvider();
  const ledger = createFakeFundingLedger(database);
  const clock = { value: new Date(NOW) };
  let nextId = 0;
  const idFactory = () => `order-${++nextId}`;
  const promo = new MarketingPromoCodeService({
    database,
    idFactory,
    now: () => new Date(clock.value.getTime()),
  });
  let evaluatorCalls = 0;
  const priceWalletTopUp = promo.priceWalletTopUp.bind(promo);
  promo.priceWalletTopUp = async (executor, input) => {
    evaluatorCalls += 1;
    return priceWalletTopUp(executor, input);
  };
  const service = new PaymentFulfillmentService(database, provider, {
    providerKey: provider.providerKey,
    merchantId: 'merchant-1',
    now: () => new Date(clock.value.getTime()),
    idFactory,
    walletFundingLedger: ledger,
    ...(options.withPromo === false ? {} : { walletTopUpPromo: promo }),
  });
  return {
    database,
    provider,
    service,
    evaluatorCalls: () => evaluatorCalls,
  };
}

function topUp(fixture: ReturnType<typeof createFixture>, input: Record<string, unknown> = {}) {
  return fixture.service.createWalletTopUp({
    tenantId: 'tenant-a',
    clientRequestId: 'request-1',
    amountMinorUnits: '10000',
    currency: 'USD',
    ...input,
  } as Parameters<PaymentFulfillmentService['createWalletTopUp']>[0]);
}

test('checkout freezes the discounted amount on the order and persists the original insert-only', async () => {
  const fixture = createFixture({ promoRows: [promoCodeRow()] });
  const order = await topUp(fixture, { promoCode: 'save-25' });

  assert.equal(order.amountMinorUnits, '7500', 'the customer-facing order carries the discounted snapshot');
  assert.equal(fixture.provider.calls.length, 1);
  assert.equal(fixture.provider.calls[0]?.amountMinorUnits, '7500', 'the provider sees the discounted amount');

  const stored = fixture.database.state.orders[0];
  assert.equal(stored?.amount_minor_units, '7500');
  assert.equal(stored?.original_amount_minor_units, '10000', 'the pre-discount amount is persisted');

  assert.equal(fixture.database.promoUsages.length, 1, 'the usage row lands in the order transaction');
  const usage = fixture.database.promoUsages[0];
  assert.equal(usage?.order_id, order.id);
  assert.equal(usage?.tenant_id, 'tenant-a');
  assert.equal(usage?.discount_minor_units, '2500');
  assert.equal(usage?.per_tenant_once, true, 'the frozen copy matches the code row');

  const used = fixture.database.promoAudit.find((entry) => entry.action === 'marketing.promo_code.used');
  assert.ok(used, 'the usage audit lands in the order transaction');
  assert.equal(used.tenant_id, 'tenant-a');
});

test('client-request replay returns the frozen snapshot and never re-prices', async () => {
  const fixture = createFixture({ promoRows: [promoCodeRow()] });
  const first = await topUp(fixture, { promoCode: 'SAVE-25' });
  const replay = await topUp(fixture, { promoCode: 'SAVE-25' });
  assert.equal(replay.id, first.id);
  assert.equal(replay.amountMinorUnits, '7500');
  assert.equal(fixture.evaluatorCalls(), 1, 'a replay never re-enters the evaluator');
  assert.equal(fixture.database.state.orders.length, 1);
  assert.equal(fixture.database.promoUsages.length, 1);
  assert.equal(fixture.provider.calls.length, 1, 'the provider is not re-submitted for a pending order');

  // Replay compares the customer's original input, not the frozen snapshot.
  await assert.rejects(topUp(fixture, { promoCode: 'SAVE-25', amountMinorUnits: '7500' }), isIdempotencyConflict);
  // The original commercial payload includes the normalized promo identity.
  await assert.rejects(topUp(fixture, { amountMinorUnits: '10000' }), isIdempotencyConflict);
  await assert.rejects(topUp(fixture, { amountMinorUnits: '10000', promoCode: 'SAVE-50' }), isIdempotencyConflict);
  const equivalent = await topUp(fixture, { amountMinorUnits: '10000', promoCode: ' save-25 ' });
  assert.equal(equivalent.id, first.id);
  assert.equal(equivalent.amountMinorUnits, '7500');
  assert.equal(fixture.database.state.orders[0]?.original_amount_minor_units, '10000');
  assert.equal(fixture.evaluatorCalls(), 1);
  assert.equal(fixture.database.state.orders.length, 1);
  assert.equal(fixture.database.promoUsages.length, 1);
  assert.equal(fixture.provider.calls.length, 1);
});

test('a promo code without the configured port fails closed with PROMO_UNAVAILABLE', async () => {
  const fixture = createFixture({ withPromo: false, promoRows: [promoCodeRow()] });
  await assert.rejects(
    topUp(fixture, { promoCode: 'SAVE-25' }),
    (error: unknown) => error instanceof PaymentError && error.code === 'PROMO_UNAVAILABLE',
  );
  assert.equal(fixture.database.state.orders.length, 0);
  assert.equal(fixture.database.promoUsages.length, 0);
  assert.equal(fixture.provider.calls.length, 0);
});

test('an unknown promo code refuses and writes neither order nor usage', async () => {
  const fixture = createFixture({ promoRows: [promoCodeRow()] });
  await assert.rejects(
    topUp(fixture, { promoCode: 'NOPE-123' }),
    (error: unknown) => error instanceof PaymentError && error.code === 'PROMO_CODE_INVALID',
  );
  assert.equal(fixture.database.state.orders.length, 0, 'the order insert rolls back with the refusal');
  assert.equal(fixture.database.promoUsages.length, 0);
  assert.equal(fixture.provider.calls.length, 0);
});

test('an amount_off currency mismatch refuses before any write', async () => {
  const fixture = createFixture({
    promoRows: [
      promoCodeRow({
        kind: 'amount_off',
        percent_bp: null,
        amount_minor_units: '500',
        currency: 'CNY',
        per_tenant_once: false,
      }),
    ],
  });
  await assert.rejects(
    topUp(fixture, { promoCode: 'SAVE-25' }),
    (error: unknown) => error instanceof PaymentError && error.code === 'PROMO_CODE_INVALID',
  );
  assert.equal(fixture.database.state.orders.length, 0);
  assert.equal(fixture.database.promoUsages.length, 0);

  const matched = await topUp(fixture, { promoCode: 'SAVE-25', currency: 'CNY', clientRequestId: 'request-2' });
  assert.equal(matched.amountMinorUnits, '9500');
  assert.equal(fixture.database.state.orders[0]?.original_amount_minor_units, '10000');
});

test('a per-tenant-once code refuses the tenant second checkout at the seam', async () => {
  const fixture = createFixture({ promoRows: [promoCodeRow()] });
  await topUp(fixture, { promoCode: 'SAVE-25' });
  await assert.rejects(
    topUp(fixture, { promoCode: 'SAVE-25', clientRequestId: 'request-2' }),
    (error: unknown) => error instanceof PaymentError && error.code === 'PROMO_CODE_INVALID',
  );
  assert.equal(fixture.database.state.orders.length, 1);
  assert.equal(fixture.database.promoUsages.length, 1);
});

test('orders without a promo code keep the original column empty', async () => {
  const fixture = createFixture({ promoRows: [promoCodeRow()] });
  const order = await topUp(fixture);
  assert.equal(order.amountMinorUnits, '10000');
  assert.equal(fixture.database.state.orders[0]?.original_amount_minor_units, null);
  assert.equal(fixture.evaluatorCalls(), 0);
  assert.equal(fixture.database.promoUsages.length, 0);
});

function isIdempotencyConflict(error: unknown): boolean {
  return error instanceof PaymentError && error.code === 'IDEMPOTENCY_CONFLICT';
}
