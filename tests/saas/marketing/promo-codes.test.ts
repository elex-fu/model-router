import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  type CreatePromoCodeInput,
  MarketingPromoCodeService,
  MarketingPromoError,
  normalizePromoCode,
  type PromoCodeView,
} from '../../../src/saas/marketing/promo-codes.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';

// R1/G2 promo-code service unit tests (migration 090). The fake database
// models each production statement by normalized prefix; transactions are
// serialized (tail promise) and roll back on error, which is enough to prove
// the single-winner oversell guard, the frozen per-tenant-once copy and the
// audit writes. The evaluator port runs on the caller's executor exactly like
// the payment order transaction hands it over.

const ACTOR = '00000000-0000-4000-8000-0000000000a1';
const TENANT = '00000000-0000-4000-8000-0000000000b1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000b2';
const CODE_ID = '00000000-0000-4000-8000-0000000000c1';
const ORDER_ID = '00000000-0000-4000-8000-0000000000d1';
const NOW = '2026-10-11T00:00:00.000Z';

interface CodeRow extends Record<string, unknown> {
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

interface UsageRow extends Record<string, unknown> {
  id: string;
  code_id: string;
  tenant_id: string;
  order_id: string;
  discount_minor_units: string;
  per_tenant_once: boolean;
  created_at: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakePromoDatabase {
  readonly state = {
    codes: [] as CodeRow[],
    usages: [] as UsageRow[],
    audit: [] as Array<Record<string, unknown>>,
  };
  loseDisableCas = false;
  private tail: Promise<void> = Promise.resolve();

  seedCode(overrides: Partial<CodeRow> = {}): CodeRow {
    const row: CodeRow = {
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
      created_by_user_id: ACTOR,
      created_at: NOW,
      updated_at: NOW,
      disabled_at: null,
      ...overrides,
    };
    this.state.codes.push(row);
    return row;
  }

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = clone(this.state);
    const executor: SqlExecutor = { query: (sql, values = []) => this.execute(sql, values) };
    try {
      return await work(executor);
    } catch (error) {
      this.state.codes = before.codes;
      this.state.usages = before.usages;
      this.state.audit = before.audit;
      throw error;
    } finally {
      release();
    }
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l] = values;
    const result = <R>(rows: R[] = []): SqlResult<R> => ({ rows: clone(rows), rowCount: rows.length });

    if (statement.startsWith('set local ')) return result<Row>();

    if (statement.startsWith('insert into model_router_saas.saas_marketing_promo_codes')) {
      if (this.state.codes.some((row) => row.code === b)) return result<Row>();
      const row: CodeRow = {
        id: String(a),
        code: String(b),
        kind: String(c),
        percent_bp: d === null ? null : Number(d),
        amount_minor_units: e === null ? null : String(e),
        currency: f === null ? null : String(f),
        scope: 'wallet_topup',
        starts_at: g === null ? null : String(g),
        ends_at: h === null ? null : String(h),
        max_uses: i === null ? null : Number(i),
        per_tenant_once: j as boolean,
        status: 'active',
        created_by_user_id: String(k),
        created_at: String(l),
        updated_at: String(l),
        disabled_at: null,
      };
      this.state.codes.push(row);
      return result<Row>([row as Row]);
    }

    if (statement.includes('from model_router_saas.saas_marketing_promo_codes where id = $1 for update')) {
      const row = this.state.codes.find((item) => item.id === a);
      return result<Row>(row ? [row as Row] : []);
    }

    if (statement.includes('from model_router_saas.saas_marketing_promo_codes where code = $1 for update')) {
      const row = this.state.codes.find((item) => item.code === a);
      return result<Row>(row ? [row as Row] : []);
    }

    if (statement.startsWith("update model_router_saas.saas_marketing_promo_codes set status = 'disabled'")) {
      const row = this.state.codes.find((item) => item.id === a && item.status === 'active');
      if (!row || this.loseDisableCas) return result<Row>();
      row.status = 'disabled';
      row.disabled_at = String(b);
      row.updated_at = String(b);
      return result<Row>([row as Row]);
    }

    if (statement.includes('where ($1::text is null or status = $1)')) {
      let rows = this.state.codes.filter((row) => a === null || row.status === a);
      if (b !== null) {
        rows = rows.filter((row) => row.created_at < String(b) || (row.created_at === String(b) && row.id < String(c)));
      }
      rows = [...rows].sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
      );
      return result<Row>(rows.slice(0, Number(d)) as Row[]);
    }

    if (
      statement.startsWith(
        'select id from model_router_saas.saas_marketing_promo_usages where code_id = $1 and tenant_id = $2',
      )
    ) {
      const row = this.state.usages.find((item) => item.code_id === a && item.tenant_id === b);
      return result<Row>(row ? [{ id: row.id } as Row] : []);
    }

    if (statement.startsWith('select count(*)::text as used from model_router_saas.saas_marketing_promo_usages')) {
      const used = this.state.usages.filter((item) => item.code_id === a).length;
      return result<Row>([{ used: String(used) } as Row]);
    }

    if (statement.startsWith('insert into model_router_saas.saas_marketing_promo_usages')) {
      if (this.state.usages.some((item) => item.order_id === d)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      if (
        f === true &&
        this.state.usages.some((item) => item.code_id === b && item.tenant_id === c && item.per_tenant_once)
      ) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      this.state.usages.push({
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
      this.state.audit.push({
        id: a,
        tenant_id: b,
        actor_user_id: c,
        action: d,
        target_id: e,
        occurred_at: f,
      });
      return result<Row>();
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

function createFixture(now = NOW) {
  const database = new FakePromoDatabase();
  let nextId = 0;
  const service = new MarketingPromoCodeService({
    database,
    idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => new Date(now),
  });
  return { database, service };
}

function percentInput(overrides: Record<string, unknown> = {}): CreatePromoCodeInput {
  return { kind: 'percent_off', code: 'save-25', percentBp: 2500, ...overrides } as CreatePromoCodeInput;
}

async function price(
  fixture: ReturnType<typeof createFixture>,
  input: {
    orderId?: string;
    tenantId?: string;
    amountMinorUnits?: string;
    currency?: string;
    promoCode?: string;
  } = {},
) {
  return fixture.database.transaction((executor) =>
    fixture.service.priceWalletTopUp(executor, {
      orderId: input.orderId ?? ORDER_ID,
      tenantId: input.tenantId ?? TENANT,
      amountMinorUnits: input.amountMinorUnits ?? '10000',
      currency: input.currency ?? 'USD',
      promoCode: input.promoCode ?? 'SAVE-25',
    }),
  );
}

test('normalizePromoCode trims, uppercases and enforces the stored format', () => {
  assert.equal(normalizePromoCode('  save-25 '), 'SAVE-25');
  assert.equal(normalizePromoCode('ABCD'), 'ABCD');
  for (const bad of ['abc', 'a'.repeat(33), 'SAVE_25', 'SAVE 25', '', 42, null]) {
    assert.throws(
      () => normalizePromoCode(bad),
      (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_INVALID_INPUT',
      String(bad),
    );
  }
});

test('createPromoCode persists both kinds, normalizes the code and audits the creation', async () => {
  const { database, service } = createFixture();
  const percent = await service.createPromoCode({ userId: ACTOR }, percentInput());
  assert.equal(percent.code, 'SAVE-25');
  assert.equal(percent.kind, 'percent_off');
  assert.equal(percent.percentBp, 2500);
  assert.equal(percent.amountMinorUnits, null);
  assert.equal(percent.currency, null);
  assert.equal(percent.scope, 'wallet_topup');
  assert.equal(percent.status, 'active');
  assert.equal(percent.perTenantOnce, true);
  assert.equal(percent.maxUses, null);
  assert.equal(percent.createdByUserId, ACTOR);

  const amount = await service.createPromoCode(
    { userId: ACTOR },
    {
      kind: 'amount_off',
      code: 'TAKE500',
      amountMinorUnits: '0500',
      currency: 'USD',
      startsAt: '2026-10-01T00:00:00Z',
      endsAt: '2026-12-01T00:00:00Z',
      maxUses: 10,
      perTenantOnce: false,
    },
  );
  assert.equal(amount.kind, 'amount_off');
  assert.equal(amount.amountMinorUnits, '500', 'leading zeros are normalized');
  assert.equal(amount.currency, 'USD');
  assert.equal(amount.startsAt, '2026-10-01T00:00:00.000Z');
  assert.equal(amount.endsAt, '2026-12-01T00:00:00.000Z');
  assert.equal(amount.maxUses, 10);
  assert.equal(amount.perTenantOnce, false);

  assert.equal(database.state.audit.length, 2);
  assert.equal(database.state.audit[0]?.action, 'marketing.promo_code.created');
  assert.equal(database.state.audit[0]?.actor_user_id, ACTOR);
  assert.equal(database.state.audit[0]?.tenant_id, null);
  assert.equal(database.state.audit[0]?.target_id, percent.id);
});

test('createPromoCode validation matrix refuses malformed definitions', async () => {
  const { database, service } = createFixture();
  const reject = (input: unknown) =>
    assert.rejects(
      service.createPromoCode({ userId: ACTOR }, input as CreatePromoCodeInput),
      (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_INVALID_INPUT',
    );

  await reject(percentInput({ code: 'ab' }));
  await reject(percentInput({ code: 'has space' }));
  await reject(percentInput({ percentBp: 0 }));
  await reject(percentInput({ percentBp: 10000 }));
  await reject(percentInput({ percentBp: 12.5 }));
  await reject(percentInput({ percentBp: '2500' }));
  await reject({ kind: 'percent_off', code: 'SAVE-25' });
  await reject({ kind: 'amount_off', code: 'TAKE500', amountMinorUnits: '500', currency: 'USD', percentBp: 100 });
  await reject({ kind: 'amount_off', code: 'TAKE500', amountMinorUnits: '0', currency: 'USD' });
  await reject({ kind: 'amount_off', code: 'TAKE500', amountMinorUnits: '500', currency: 'usd' });
  await reject({ kind: 'amount_off', code: 'TAKE500', amountMinorUnits: '500' });
  await reject(percentInput({ startsAt: 'not-a-date' }));
  await reject(percentInput({ startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }));
  await reject(percentInput({ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }));
  await reject(percentInput({ maxUses: 0 }));
  await reject(percentInput({ maxUses: -3 }));
  await reject(percentInput({ maxUses: 1.5 }));
  await reject(percentInput({ maxUses: 2_147_483_648 }));
  await reject(percentInput({ perTenantOnce: 'yes' }));
  await reject({ kind: 'balance', code: 'SAVE-25' });
  assert.equal(database.state.codes.length, 0);
  assert.equal(database.state.audit.length, 0);
});

test('createPromoCode maps a duplicate code to PROMO_CODE_CONFLICT and a bad actor to PROMO_FORBIDDEN', async () => {
  const { service } = createFixture();
  await service.createPromoCode({ userId: ACTOR }, percentInput());
  await assert.rejects(
    service.createPromoCode({ userId: ACTOR }, percentInput({ percentBp: 1000 })),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_CODE_CONFLICT',
  );
  await assert.rejects(
    service.createPromoCode({ userId: 'not-a-uuid' }, percentInput({ code: 'OTHER-1' })),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_FORBIDDEN',
  );
});

test('disablePromoCode transitions active codes once, stays idempotent and audits', async () => {
  const { database, service } = createFixture();
  const created = await service.createPromoCode({ userId: ACTOR }, percentInput());

  await assert.rejects(
    service.disablePromoCode({ userId: ACTOR }, '00000000-0000-4000-8000-0000000000ff'),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_CODE_NOT_FOUND',
  );

  const disabled = await service.disablePromoCode({ userId: ACTOR }, created.id);
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.disabledAt, NOW);
  assert.equal(database.state.audit.at(-1)?.action, 'marketing.promo_code.disabled');

  const again = await service.disablePromoCode({ userId: ACTOR }, created.id);
  assert.equal(again.status, 'disabled');
  assert.equal(
    database.state.audit.filter((entry) => entry.action === 'marketing.promo_code.disabled').length,
    1,
    'a repeated disable never re-audits',
  );

  const second = await service.createPromoCode({ userId: ACTOR }, percentInput({ code: 'SECOND-1' }));
  database.loseDisableCas = true;
  await assert.rejects(
    service.disablePromoCode({ userId: ACTOR }, second.id),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_CODE_STATE_CONFLICT',
  );
});

test('listPromoCodes paginates by keyset and filters status', async () => {
  const { database, service } = createFixture();
  const created: PromoCodeView[] = [];
  for (const [index, code] of ['CODE-AAA', 'CODE-BBB', 'CODE-CCC'].entries()) {
    database.seedCode({
      id: `00000000-0000-4000-8000-0000000000e${index}`,
      code,
      created_at: `2026-10-1${index}T00:00:00.000Z`,
      updated_at: `2026-10-1${index}T00:00:00.000Z`,
      status: index === 1 ? 'disabled' : 'active',
      disabled_at: index === 1 ? NOW : null,
    });
    created.push({} as PromoCodeView);
  }

  const first = await service.listPromoCodes({ userId: ACTOR }, { limit: 2 });
  assert.deepEqual(
    first.codes.map((row) => row.code),
    ['CODE-CCC', 'CODE-BBB'],
  );
  assert.ok(first.nextCursor);
  const second = await service.listPromoCodes({ userId: ACTOR }, { limit: 2, cursor: first.nextCursor as string });
  assert.deepEqual(
    second.codes.map((row) => row.code),
    ['CODE-AAA'],
  );
  assert.equal(second.nextCursor, null);

  const activeOnly = await service.listPromoCodes({ userId: ACTOR }, { status: 'active' });
  assert.deepEqual(
    activeOnly.codes.map((row) => row.code),
    ['CODE-CCC', 'CODE-AAA'],
  );

  await assert.rejects(
    service.listPromoCodes({ userId: ACTOR }, { cursor: 'not-a-cursor' }),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_INVALID_INPUT',
  );
  await assert.rejects(
    service.listPromoCodes({ userId: ACTOR }, { limit: 0 }),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_INVALID_INPUT',
  );
  await assert.rejects(
    service.listPromoCodes({ userId: ACTOR }, { limit: 101 }),
    (error: unknown) => error instanceof MarketingPromoError && error.code === 'PROMO_INVALID_INPUT',
  );
});

test('evaluator percent matrix floors the discount and freezes both amounts', async () => {
  const matrix: Array<{ amount: string; bp: number; discounted: string; discount: string }> = [
    { amount: '10000', bp: 2500, discounted: '7500', discount: '2500' },
    { amount: '333', bp: 3333, discounted: '223', discount: '110' },
    { amount: '1', bp: 9999, discounted: '1', discount: '0' },
    { amount: '7', bp: 100, discounted: '7', discount: '0' },
  ];
  for (const [index, entry] of matrix.entries()) {
    const { database, service } = createFixture();
    database.seedCode({ percent_bp: entry.bp, per_tenant_once: false });
    const priced = await price(
      { database, service },
      { amountMinorUnits: entry.amount, orderId: `00000000-0000-4000-8000-00000000010${index}` },
    );
    assert.equal(priced.amountMinorUnits, entry.discounted, JSON.stringify(entry));
    assert.equal(priced.originalAmountMinorUnits, entry.amount);
    assert.equal(database.state.usages[0]?.discount_minor_units, entry.discount, JSON.stringify(entry));
  }
});

test('evaluator amount_off clamps at the full amount and refuses a zero-priced order', async () => {
  const { database, service } = createFixture();
  database.seedCode({
    kind: 'amount_off',
    percent_bp: null,
    amount_minor_units: '500',
    currency: 'USD',
    per_tenant_once: false,
  });
  const priced = await price({ database, service }, { amountMinorUnits: '1000' });
  assert.equal(priced.amountMinorUnits, '500');
  assert.equal(priced.originalAmountMinorUnits, '1000');
  assert.equal(database.state.usages[0]?.discount_minor_units, '500');

  // amount_off >= order amount would price the order at zero; orders are
  // CHECK (amount > 0), so the checkout refuses instead of crashing.
  for (const off of ['1000', '1500']) {
    const fixture = createFixture();
    fixture.database.seedCode({
      kind: 'amount_off',
      percent_bp: null,
      amount_minor_units: off,
      currency: 'USD',
      per_tenant_once: false,
    });
    await assert.rejects(price(fixture, { amountMinorUnits: '1000' }), isPromoInvalid);
    assert.equal(fixture.database.state.usages.length, 0);
  }
});

test('evaluator refuses a currency mismatch for amount_off codes', async () => {
  const fixture = createFixture();
  fixture.database.seedCode({
    kind: 'amount_off',
    percent_bp: null,
    amount_minor_units: '500',
    currency: 'CNY',
    per_tenant_once: false,
  });
  await assert.rejects(price(fixture, { currency: 'USD' }), isPromoInvalid);
  const matched = await price(fixture, { currency: 'CNY', orderId: '00000000-0000-4000-8000-000000000111' });
  assert.equal(matched.amountMinorUnits, '9500');
});

test('evaluator enforces the validity window with an exclusive end', async () => {
  const fixture = createFixture('2026-10-15T00:00:00.000Z');
  fixture.database.seedCode({
    starts_at: '2026-10-20T00:00:00.000Z',
    per_tenant_once: false,
  });
  await assert.rejects(price(fixture, {}), isPromoInvalid);

  const ended = createFixture('2026-10-20T00:00:00.000Z');
  ended.database.seedCode({ ends_at: '2026-10-20T00:00:00.000Z', per_tenant_once: false });
  await assert.rejects(price(ended, {}), isPromoInvalid);

  const inside = createFixture('2026-10-20T00:00:00.000Z');
  inside.database.seedCode({
    starts_at: '2026-10-20T00:00:00.000Z',
    ends_at: '2026-10-21T00:00:00.000Z',
    per_tenant_once: false,
  });
  const priced = await price(inside, {});
  assert.equal(priced.amountMinorUnits, '7500');
});

test('evaluator enforces max_uses and per-tenant-once under the row lock', async () => {
  const exhausted = createFixture();
  exhausted.database.seedCode({ max_uses: 1, per_tenant_once: false });
  await price(exhausted, {});
  await assert.rejects(
    price(exhausted, { orderId: '00000000-0000-4000-8000-000000000121', tenantId: OTHER_TENANT }),
    isPromoInvalid,
  );

  const once = createFixture();
  once.database.seedCode({ per_tenant_once: true });
  await price(once, {});
  await assert.rejects(
    price(once, { orderId: '00000000-0000-4000-8000-000000000122' }),
    isPromoInvalid,
    'the same tenant cannot redeem a per-tenant-once code twice',
  );
  const otherTenant = await price(once, {
    orderId: '00000000-0000-4000-8000-000000000123',
    tenantId: OTHER_TENANT,
  });
  assert.equal(otherTenant.amountMinorUnits, '7500');

  const repeat = createFixture();
  repeat.database.seedCode({ per_tenant_once: false });
  await price(repeat, {});
  const repeated = await price(repeat, { orderId: '00000000-0000-4000-8000-000000000124' });
  assert.equal(repeated.amountMinorUnits, '7500');
  assert.equal(repeat.database.state.usages.length, 2);
});

test('evaluator concurrent checkouts on a single-use code have exactly one winner', async () => {
  const fixture = createFixture();
  fixture.database.seedCode({ max_uses: 1, per_tenant_once: false });
  const [first, second] = await Promise.allSettled([
    price(fixture, { orderId: '00000000-0000-4000-8000-000000000131' }),
    price(fixture, { orderId: '00000000-0000-4000-8000-000000000132' }),
  ]);
  const outcomes = [first, second].map((entry) => entry.status).sort();
  assert.deepEqual(outcomes, ['fulfilled', 'rejected']);
  const rejected = [first, second].find((entry) => entry.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof PaymentError && rejected.reason.code === 'PROMO_CODE_INVALID');
  assert.equal(fixture.database.state.usages.length, 1, 'never oversold');
});

test('evaluator refusals collapse to one PROMO_CODE_INVALID and write nothing', async () => {
  const cases: Array<{ name: string; seed?: Partial<CodeRow>; promoCode?: string }> = [
    { name: 'unknown code', seed: undefined },
    { name: 'disabled code', seed: { status: 'disabled', disabled_at: NOW } },
    { name: 'not yet valid', seed: { starts_at: '2026-12-01T00:00:00.000Z' } },
    { name: 'expired', seed: { ends_at: '2026-10-01T00:00:00.000Z' } },
    { name: 'malformed code', promoCode: 'bad code!' },
  ];
  for (const entry of cases) {
    const fixture = createFixture();
    if (entry.seed !== undefined) fixture.database.seedCode({ per_tenant_once: false, ...entry.seed });
    await assert.rejects(
      price(fixture, entry.promoCode === undefined ? {} : { promoCode: entry.promoCode }),
      isPromoInvalid,
      entry.name,
    );
    assert.equal(fixture.database.state.usages.length, 0, entry.name);
    assert.equal(
      fixture.database.state.audit.filter((row) => row.action === 'marketing.promo_code.used').length,
      0,
      entry.name,
    );
  }
});

test('evaluator maps the order-id unique backstop to the unified refusal', async () => {
  const fixture = createFixture();
  fixture.database.seedCode({ per_tenant_once: false });
  fixture.database.state.usages.push({
    id: '00000000-0000-4000-8000-000000000141',
    code_id: CODE_ID,
    tenant_id: OTHER_TENANT,
    order_id: ORDER_ID,
    discount_minor_units: '1',
    per_tenant_once: false,
    created_at: NOW,
  });
  await assert.rejects(price(fixture, {}), isPromoInvalid);
  assert.equal(fixture.database.state.usages.length, 1);
});

test('evaluator writes the usage and the used-audit in the caller transaction', async () => {
  const fixture = createFixture();
  fixture.database.seedCode({ per_tenant_once: true });
  const priced = await price(fixture, { amountMinorUnits: '4000' });
  assert.equal(priced.amountMinorUnits, '3000');
  assert.equal(fixture.database.state.usages.length, 1);
  const usage = fixture.database.state.usages[0];
  assert.equal(usage?.code_id, CODE_ID);
  assert.equal(usage?.tenant_id, TENANT);
  assert.equal(usage?.order_id, ORDER_ID);
  assert.equal(usage?.discount_minor_units, '1000');
  assert.equal(usage?.per_tenant_once, true, 'the frozen copy matches the code row');

  const used = fixture.database.state.audit.find((entry) => entry.action === 'marketing.promo_code.used');
  assert.ok(used, 'the usage audit is recorded');
  assert.equal(used.tenant_id, TENANT);
  assert.equal(used.actor_user_id, null, 'checkout has no user identity');
  assert.equal(used.target_id, CODE_ID);
});

test('evaluator translates storage-shape damage into PAYMENT_STORAGE_ERROR', async () => {
  const fixture = createFixture();
  fixture.database.seedCode({ percent_bp: '2500' as unknown as number });
  await assert.rejects(
    price(fixture, {}),
    (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_STORAGE_ERROR',
  );
});

function isPromoInvalid(error: unknown): boolean {
  return error instanceof PaymentError && error.code === 'PROMO_CODE_INVALID';
}
