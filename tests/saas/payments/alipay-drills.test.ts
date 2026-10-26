import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { ALIPAY_PROVIDER_KEY, createAlipayPaymentProvider } from '../../../src/saas/payments/providers/alipay/index.js';
import { PaymentRefundService } from '../../../src/saas/payments/refunds.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import type { PaymentRefundOperationsPort } from '../../../src/saas/payments/types.js';
import { type FakeFastCreditAllocation, REFUND_WALLET_COMMITMENTS_SQL } from './fake-refund-wallet.js';
import { createFakeFundingLedger, FakePaymentDatabase } from './fake-sql.js';
import {
  ALIPAY_TEST_GATEWAY_PUBLIC_KEY,
  ALIPAY_TEST_MERCHANT_PRIVATE_KEY,
  alipayGatewayEnvelope,
  alipayNotifyBody,
  type MockAlipay,
  startMockAlipay,
} from './mock-alipay.js';

// R3 drills: callback disorder against the programmable mock Alipay gateway
// with the real adapter and fulfillment service — RSA2 verification + the
// active trade.query confirmation fulfills exactly once, an unconfirmed
// signed success lands in reconciliation with zero wallet movement, duplicate
// delivery replays from the durable inbox, conflicting replay is refused. The
// refund drill proves the port abstraction holds for Alipay: the REAL
// fastpay.refund.query tri-state settles the freeze (succeeded → ledger +
// release, failed → release without ledger) where EasyPay's permanent unknown
// stays operator-bound (refunds.test.ts C4).

const APP_ID = '2021000123456789';
const SELLER_ID = '2088102171234567';
const TENANT_ID = 'tenant-1';
const TRADE_NO = '2026101122001456789012345678';

function tradeNoFor(orderId: string): string {
  return `${TRADE_NO.slice(0, TRADE_NO.length - orderId.length)}${orderId}`;
}

function signedSuccess(
  orderId: string,
  options: { notifyId?: string; totalAmount?: string; tradeNo?: string } = {},
): Buffer {
  return alipayNotifyBody({
    notify_id: options.notifyId ?? `notify-e2e-${orderId}`,
    notify_type: 'trade_status_sync',
    notify_time: '2026-10-11 08:00:00',
    app_id: APP_ID,
    seller_id: SELLER_ID,
    out_trade_no: orderId,
    trade_no: options.tradeNo ?? tradeNoFor(orderId),
    trade_status: 'TRADE_SUCCESS',
    total_amount: options.totalAmount ?? '12.34',
    passback_params: TENANT_ID,
    gmt_payment: '2026-10-11 07:59:30',
  });
}

async function createFixture(alipay: MockAlipay) {
  const clock = { value: Date.parse('2026-10-11T00:00:00.000Z') };
  const provider = createAlipayPaymentProvider({
    appId: APP_ID,
    sellerId: SELLER_ID,
    merchantPrivateKey: ALIPAY_TEST_MERCHANT_PRIVATE_KEY,
    alipayPublicKey: ALIPAY_TEST_GATEWAY_PUBLIC_KEY,
    gateway: alipay.url,
    notifyUrl: 'https://pay.example.com/notify',
    returnUrl: 'https://pay.example.com/return',
    now: () => new Date(clock.value),
  });
  const database = new FakePaymentDatabase();
  let nextId = 0;
  const service = new PaymentFulfillmentService(database, provider.adapter, {
    providerKey: ALIPAY_PROVIDER_KEY,
    merchantId: APP_ID,
    now: () => new Date(clock.value),
    idFactory: () => `local-${++nextId}`,
    walletFundingLedger: createFakeFundingLedger(database),
  });
  return { database, service, clock };
}

function programPrecreate(alipay: MockAlipay): void {
  alipay.setHandler('precreate', (call) => ({
    json: alipayGatewayEnvelope('alipay.trade.precreate', {
      code: '10000',
      msg: 'Success',
      out_trade_no: JSON.parse(call.params.biz_content ?? '{}').out_trade_no,
      qr_code: 'https://qr.alipay.com/bax01234mockqrcode',
    }),
  }));
}

function programTradeQuery(alipay: MockAlipay, tradeStatus: string): void {
  alipay.setHandler('tradeQuery', (call) => {
    const outTradeNo = JSON.parse(call.params.biz_content ?? '{}').out_trade_no as string;
    return {
      json: alipayGatewayEnvelope('alipay.trade.query', {
        code: '10000',
        msg: 'Success',
        out_trade_no: outTradeNo,
        trade_no: tradeNoFor(outTradeNo),
        trade_status: tradeStatus,
        total_amount: '12.34',
      }),
    };
  });
}

test('R3: a signed success fulfills only after the active trade.query confirms — exactly once', async () => {
  const alipay = await startMockAlipay();
  try {
    programPrecreate(alipay);
    const { database, service } = await createFixture(alipay);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    assert.equal(order.providerOrderId, order.id, 'the precreate identity anchor is the out_trade_no');
    assert.equal(order.checkout.status, 'ready');
    assert.equal(order.checkout.action?.kind, 'qr');

    programTradeQuery(alipay, 'TRADE_SUCCESS');
    const receipt = await service.handleWebhook({}, signedSuccess(order.id));
    assert.equal(receipt.outcome, 'accepted');
    const batch = await service.processPendingWebhooks();
    assert.equal(batch.processed, 1);
    assert.equal(database.state.funding.length, 1, 'the query-confirmed event credits the wallet exactly once');
    assert.equal(database.state.funding[0]?.amountMinorUnits, '1234');
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
    assert.equal(alipay.calls.tradeQuery.length, 1, 'fulfillment required the active trade.query');

    // A signed success the query does NOT confirm lands in reconciliation.
    const second = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-2',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    programTradeQuery(alipay, 'WAIT_BUYER_PAY');
    await service.handleWebhook({}, signedSuccess(second.id));
    await service.processPendingWebhooks();
    assert.equal(database.state.orders[1]?.state, 'pending', 'an unconfirmed signed success never fulfills');
    assert.equal(database.state.inbox[1]?.processing_outcome, 'reconciliation');
    assert.equal(database.state.inbox[1]?.outcome_code, 'ALIPAY_TRADE_NOT_SUCCESS');
    assert.equal(database.state.funding.length, 1, 'zero wallet movement without query confirmation');
  } finally {
    await alipay.close();
  }
});

test('R3: duplicate notifications replay from the durable inbox and credit the wallet exactly once', async () => {
  const alipay = await startMockAlipay();
  try {
    programPrecreate(alipay);
    const { database, service, clock } = await createFixture(alipay);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    programTradeQuery(alipay, 'TRADE_SUCCESS');
    const body = signedSuccess(order.id);
    const first = await service.handleWebhook({}, body);
    const second = await service.handleWebhook({}, body);
    assert.equal(first.outcome, 'accepted');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, 'byte-identical redelivery is a durable inbox replay');
    assert.equal(second.inboxId, first.inboxId);
    assert.equal(database.state.inbox.length, 1);
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    clock.value += 1_000;
    const third = await service.handleWebhook({}, body);
    assert.equal(third.replayed, true, 'redelivery after processing still replays, never re-enqueues');
    assert.equal((await service.processPendingWebhooks()).processed, 0);
    assert.equal(database.state.funding.length, 1);
    assert.equal(alipay.calls.tradeQuery.length, 1, 'the pre-fulfillment query ran exactly once');
  } finally {
    await alipay.close();
  }
});

test('R3: a signed but conflicting replay of the same notification identity is refused and never re-credits', async () => {
  const alipay = await startMockAlipay();
  try {
    programPrecreate(alipay);
    const { database, service } = await createFixture(alipay);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    programTradeQuery(alipay, 'TRADE_SUCCESS');
    await service.handleWebhook({}, signedSuccess(order.id));
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    // Same triple-anchored identity (notify id + out_trade_no + trade_no),
    // different signed amount: a valid RSA2 signature is not proof of
    // consistency — the inbox must refuse the drift.
    const conflict = signedSuccess(order.id, { totalAmount: '99.99' });
    await assert.rejects(
      service.handleWebhook({}, conflict),
      (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_EVENT_CONFLICT',
    );
    assert.equal(database.state.inbox.length, 1);
    assert.equal(database.state.funding.length, 1);
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
  } finally {
    await alipay.close();
  }
});

// --- Refund drill: slim wallet-only fake (mirrors the stripe-drills harness semantics) ---

const REFUND_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const REFUND_ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const TOP_UP_ID = '00000000-0000-4000-8000-000000000003';
const FUNDING_TX_ID = '00000000-0000-4000-8000-000000000004';
const WALLET_ID = '00000000-0000-4000-8000-000000000006';
// The real schema pins local_order_ref === order id, and the alipay precreate
// identity makes that same value the out_trade_no / provider_order_id.
const TOP_UP_OUT_TRADE_NO = TOP_UP_ID;

interface FakeRefundRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  refund_type: string;
  wallet_topup_order_id: string | null;
  service_plan_order_id: string | null;
  original_funding_transaction_id: string | null;
  wallet_id: string | null;
  provider_key: string;
  merchant_id: string;
  provider_order_id: string;
  original_local_order_ref: string;
  idempotency_namespace: string;
  client_request_id: string;
  requested_by_user_id: string;
  authorization_ref: string;
  reason_code: string;
  amount_minor_units: string;
  currency: string;
  state: string;
  provider_refund_id: string | null;
  failure_code: string | null;
  blocked_code: string | null;
  wallet_refund_transaction_id: string | null;
  service_plan_effect_ref: string | null;
  provider_attempts: number;
  lease_action: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  next_reconcile_at: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function result<Row>(rows: Row[] = []): SqlResult<Row> {
  return { rows: clone(rows), rowCount: rows.length };
}

function text(value: unknown): string {
  return String(value);
}

class FakeRefundDatabase {
  readonly state = {
    refunds: [] as FakeRefundRow[],
    walletFreezes: [] as Array<{
      refund_order_id: string;
      tenant_id: string;
      wallet_id: string;
      currency: string;
      amount_minor_units: string;
    }>,
    audit: [] as Array<Record<string, unknown>>,
    ledgerPostings: [] as Array<{ refundOrderId: string; amountMinorUnits: string; transactionId: string }>,
    walletBalance: 1_000n,
    requestHolds: 0n,
    fastCreditAllocations: [] as FakeFastCreditAllocation[],
  };

  readonly walletTopUp: Record<string, unknown> = {
    id: TOP_UP_ID,
    tenant_id: REFUND_TENANT_ID,
    order_type: 'wallet_topup',
    state: 'fulfilled',
    provider_key: ALIPAY_PROVIDER_KEY,
    merchant_id: APP_ID,
    provider_order_id: TOP_UP_OUT_TRADE_NO,
    local_order_ref: TOP_UP_OUT_TRADE_NO,
    funding_reference: 'funding-ref-1',
    amount_minor_units: '1000',
    currency: 'CNY',
    funding_transaction_id: FUNDING_TX_ID,
  };

  private tail: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<true>();

  get inTransaction(): boolean {
    return this.transactionContext.getStore() !== undefined;
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
    try {
      return await this.transactionContext.run(true, () =>
        work({ query: (sql, values = []) => this.execute(sql, values) }),
      );
    } catch (error) {
      Object.assign(this.state, before);
      throw error;
    } finally {
      release();
    }
  }

  async postFakeWalletRefund(
    executor: SqlExecutor,
    input: { tenantId: string; currency: string; amountMinorUnits: bigint | string; refundOrderId: string },
  ): Promise<{ transactionId: string; replayed: boolean }> {
    assert.equal(this.inTransaction, true);
    await executor.query('FAKE POST VERIFIED WALLET REFUND', [input.refundOrderId, input.amountMinorUnits.toString()]);
    return { transactionId: `wallet-refund-ledger-${input.refundOrderId}`, replayed: false };
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y] = values;

    if (
      statement.startsWith('set transaction isolation level') ||
      statement.startsWith('set local ') ||
      statement.startsWith('select set_config(')
    ) {
      return result<Row>();
    }
    if (statement.startsWith('select refund_type from saas_refund_orders where id = $1')) {
      const row = this.state.refunds.find((item) => item.id === a);
      return result<Row>(row ? [{ refund_type: row.refund_type } as Row] : []);
    }
    if (statement.startsWith('select id, tenant_id, refund_type') && statement.includes('idempotency_namespace =')) {
      const row = this.state.refunds.find(
        (item) => item.tenant_id === a && item.idempotency_namespace === b && item.client_request_id === c,
      );
      return result<Row>(row ? [row as Row] : []);
    }
    if (
      statement.startsWith('select id, tenant_id, refund_type') &&
      statement.includes('where tenant_id = $1 and id = $2')
    ) {
      const row = this.state.refunds.find((item) => item.tenant_id === a && item.id === b);
      return result<Row>(row ? [row as Row] : []);
    }
    if (statement.startsWith('select id, tenant_id, refund_type') && statement.includes('where id = $1 for update')) {
      const row = this.state.refunds.find((item) => item.id === a);
      return result<Row>(row ? [row as Row] : []);
    }
    if (statement.startsWith('select id from saas_refund_orders where state in')) {
      const now = text(a);
      const selected = this.state.refunds
        .filter((row) => {
          if (row.state === 'submitting')
            return row.lease_action === 'submit' && row.lease_expires_at !== null && row.lease_expires_at <= now;
          return (
            (row.state === 'pending' || row.state === 'unknown') &&
            row.next_reconcile_at <= now &&
            (row.lease_action === null || row.lease_expires_at === null || row.lease_expires_at <= now)
          );
        })
        .slice(0, Number(b))
        .map(({ id }) => ({ id }));
      return result<Row>(selected as Row[]);
    }
    if (statement.startsWith('select id, tenant_id, order_type, state, provider_key')) {
      const row = this.walletTopUp.tenant_id === a && this.walletTopUp.id === b ? this.walletTopUp : null;
      return result<Row>(row ? [row as Row] : []);
    }
    if (
      statement.startsWith(
        'select coalesce(sum(amount_minor_units), 0)::text as amount_minor_units from saas_refund_orders',
      )
    ) {
      const tenantId = text(a);
      const orderId = text(b);
      const sum = this.state.refunds
        .filter(
          (row) =>
            row.tenant_id === tenantId &&
            (row.wallet_topup_order_id === orderId || row.service_plan_order_id === orderId) &&
            ['submitting', 'pending', 'unknown', 'blocked', 'succeeded'].includes(row.state),
        )
        .reduce((total, row) => total + BigInt(row.amount_minor_units), 0n);
      return result<Row>([{ amount_minor_units: sum.toString() } as Row]);
    }
    if (statement.startsWith('select id, tenant_id, currency, source_type, source_order_ref, amount_minor_units')) {
      const row =
        this.walletTopUp.funding_transaction_id === a &&
        this.walletTopUp.tenant_id === b &&
        this.walletTopUp.currency === c
          ? {
              id: FUNDING_TX_ID,
              tenant_id: REFUND_TENANT_ID,
              currency: 'CNY',
              source_type: 'wallet_funding',
              source_order_ref: 'funding-ref-1',
              amount_minor_units: '1000',
            }
          : null;
      return result<Row>(row ? [row as Row] : []);
    }
    if (statement.startsWith('select id, tenant_id, currency, posted_balance_minor_units')) {
      const row =
        a === REFUND_TENANT_ID && b === 'CNY'
          ? {
              id: WALLET_ID,
              tenant_id: REFUND_TENANT_ID,
              currency: 'CNY',
              posted_balance_minor_units: this.state.walletBalance.toString(),
            }
          : null;
      return result<Row>(row ? [row as Row] : []);
    }
    if (statement === REFUND_WALLET_COMMITMENTS_SQL) {
      const backing = this.state.fastCreditAllocations
        .filter((allocation) => allocation.tenant_id === a && allocation.currency === b)
        .reduce((total, allocation) => total + allocation.backing_minor_units, 0n);
      return result<Row>([{ total: (this.state.requestHolds + backing).toString() } as Row]);
    }
    if (
      statement.startsWith('select coalesce(sum(amount_minor_units), 0)::text as total from saas_refund_wallet_freezes')
    ) {
      const sum = this.state.walletFreezes
        .filter((row) => row.tenant_id === a && row.currency === b)
        .reduce((total, row) => total + BigInt(row.amount_minor_units), 0n);
      return result<Row>([{ total: sum.toString() } as Row]);
    }
    if (statement.startsWith('insert into saas_refund_orders')) {
      const row: FakeRefundRow = {
        id: text(a),
        tenant_id: text(b),
        refund_type: text(c),
        wallet_topup_order_id: d === null ? null : text(d),
        service_plan_order_id: e === null ? null : text(e),
        original_funding_transaction_id: f === null ? null : text(f),
        wallet_id: g === null ? null : text(g),
        provider_key: text(h),
        merchant_id: text(i),
        provider_order_id: text(j),
        original_local_order_ref: text(k),
        idempotency_namespace: text(l),
        client_request_id: text(m),
        requested_by_user_id: text(n),
        authorization_ref: text(o),
        reason_code: text(p),
        amount_minor_units: text(q),
        currency: text(r),
        state: text(s),
        provider_refund_id: null,
        failure_code: null,
        blocked_code: null,
        wallet_refund_transaction_id: null,
        service_plan_effect_ref: t === null ? null : text(t),
        provider_attempts: Number(u),
        lease_action: 'submit',
        lease_token: v === null ? null : text(v),
        lease_expires_at: w === null ? null : text(w),
        next_reconcile_at: text(x),
        created_at: text(y),
        updated_at: text(y),
        completed_at: null,
      };
      this.state.refunds.push(row);
      return result<Row>([row as Row]);
    }
    if (statement.startsWith('insert into saas_refund_wallet_freezes')) {
      this.state.walletFreezes.push({
        refund_order_id: text(a),
        tenant_id: text(b),
        wallet_id: text(c),
        currency: text(d),
        amount_minor_units: text(e),
      });
      return result<Row>();
    }
    if (statement.startsWith('insert into fake_payment_refund_audit')) {
      this.state.audit.push(clone(a as Record<string, unknown>));
      return result<Row>();
    }
    if (statement === 'fake post verified wallet refund') {
      const refundOrderId = text(a);
      const amountMinorUnits = text(b);
      const transactionId = `wallet-refund-ledger-${refundOrderId}`;
      this.state.walletBalance -= BigInt(amountMinorUnits);
      this.state.ledgerPostings.push({ refundOrderId, amountMinorUnits, transactionId });
      return result<Row>();
    }
    if (statement.startsWith('update saas_refund_orders set state = $2, lease_action =')) {
      const row = this.state.refunds.find((item) => item.id === a);
      if (!row) return result<Row>();
      row.state = text(b);
      row.lease_action = 'query';
      row.lease_token = text(c);
      row.lease_expires_at = text(d);
      row.updated_at = text(e);
      return result<Row>([row as Row]);
    }
    if (statement.startsWith('update saas_refund_orders set state = $3,')) {
      const row = this.state.refunds.find((item) => item.id === a);
      if (!row || row.lease_action !== b || row.lease_token !== j) return result<Row>();
      row.state = text(c);
      if (row.provider_refund_id === null && d !== null) row.provider_refund_id = text(d);
      row.failure_code = e === null ? null : text(e);
      row.wallet_refund_transaction_id = f === null ? null : text(f);
      row.lease_action = null;
      row.lease_token = null;
      row.lease_expires_at = null;
      row.next_reconcile_at = text(g);
      row.updated_at = text(h);
      row.completed_at = i === null ? null : text(i);
      return result<Row>([row as Row]);
    }
    if (statement.startsWith('delete from saas_refund_wallet_freezes')) {
      this.state.walletFreezes = this.state.walletFreezes.filter((row) => row.refund_order_id !== a);
      return result<Row>();
    }
    // Wallet fence is a session-level advisory lock (P4 step3): the fake is
    // single-threaded per transaction, so acquiring it is a no-op here.
    if (statement.startsWith('select pg_advisory_xact_lock')) return result<Row>();
    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

function createRefundService(
  database: FakeRefundDatabase,
  provider: {
    readonly providerKey: string;
    readonly merchantId: string;
    readonly submitRefund: unknown;
    readonly queryRefund: unknown;
  },
  now: { value: number },
) {
  const operations: PaymentRefundOperationsPort = {
    async authorize(input, executor) {
      assert.equal(database.inTransaction, true, 'refund authorization must share the creation transaction');
      assert.equal(typeof executor.query, 'function');
      if (input.actorId !== REFUND_ACTOR_ID || input.tenantId !== REFUND_TENANT_ID) throw new Error('denied');
      return { authorizationRef: 'audit-auth-ref-1' };
    },
    async recordAudit(executor, event) {
      assert.equal(database.inTransaction, true, 'refund audit must share the state-change transaction');
      await executor.query('INSERT INTO fake_payment_refund_audit (event) VALUES ($1)', [event]);
    },
  };
  let counter = 100;
  return new PaymentRefundService(database, provider as never, {
    providerKey: ALIPAY_PROVIDER_KEY,
    merchantId: APP_ID,
    operations,
    walletRefundLedger: { postVerifiedWalletRefund: database.postFakeWalletRefund.bind(database) },
    now: () => new Date(now.value),
    idFactory: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
    leaseTtlMs: 1_000,
    reconcileDelayMs: 1_000,
  });
}

test('R3: an alipay refund settles through the REAL query tri-state — succeeded posts the ledger and releases the freeze, failed releases without posting', async () => {
  const alipay = await startMockAlipay();
  try {
    const now = { value: Date.parse('2026-10-11T00:00:00.000Z') };
    const provider = createAlipayPaymentProvider({
      appId: APP_ID,
      sellerId: SELLER_ID,
      merchantPrivateKey: ALIPAY_TEST_MERCHANT_PRIVATE_KEY,
      alipayPublicKey: ALIPAY_TEST_GATEWAY_PUBLIC_KEY,
      gateway: alipay.url,
      notifyUrl: 'https://pay.example.com/notify',
      returnUrl: 'https://pay.example.com/return',
      now: () => new Date(now.value),
    });
    const database = new FakeRefundDatabase();
    database.state.fastCreditAllocations.push({
      tenant_id: REFUND_TENANT_ID,
      currency: 'CNY',
      state: 'active',
      backing_minor_units: 200n,
      available_minor_units: 25n,
    });
    const allocations = clone(database.state.fastCreditAllocations);
    const service = createRefundService(database, provider.refundAdapter, now);
    const walletRefund = (clientRequestId: string) => ({
      actorId: REFUND_ACTOR_ID,
      tenantId: REFUND_TENANT_ID,
      orderId: TOP_UP_ID,
      clientRequestId,
      amountMinorUnits: '400',
      reasonCode: 'CUSTOMER_REQUEST',
    });
    const refundNode = (outRequestNo: string, fundChange: string) =>
      alipayGatewayEnvelope('alipay.trade.refund', {
        code: '10000',
        msg: 'Success',
        trade_no: tradeNoFor(TOP_UP_OUT_TRADE_NO),
        out_trade_no: TOP_UP_OUT_TRADE_NO,
        out_request_no: outRequestNo,
        fund_change: fundChange,
        refund_fee: '4.00',
      });
    const refundQueryNode = (outRequestNo: string, refundStatus: string | null) =>
      alipayGatewayEnvelope('alipay.trade.fastpay.refund.query', {
        code: '10000',
        msg: 'Success',
        trade_no: tradeNoFor(TOP_UP_OUT_TRADE_NO),
        out_trade_no: TOP_UP_OUT_TRADE_NO,
        out_request_no: outRequestNo,
        refund_amount: '4.00',
        ...(refundStatus === null ? {} : { refund_status: refundStatus }),
      });

    // First refund: PSP answers fund_change=N (the idempotent/asynchronous
    // shape) — provisional pending; the freeze stays while unproven.
    alipay.setHandler('refund', (call) => {
      const outRequestNo = JSON.parse(call.params.biz_content ?? '{}').out_request_no as string;
      return { json: refundNode(outRequestNo, 'N') };
    });
    const refund = await service.requestWalletTopUpRefund(walletRefund('alipay-refund-1'));
    assert.equal(refund.status, 'pending', 'PSP acceptance is provisional, never self-finalizing');
    assert.equal(alipay.calls.refund.length, 1);
    assert.equal(
      JSON.parse(alipay.calls.refund[0]?.params.biz_content ?? '{}').out_request_no,
      refund.id,
      'the out_request_no is the local refund id — the natural idempotency key',
    );
    assert.equal(database.state.walletFreezes.length, 1, 'the freeze stays while the outcome is unproven');
    assert.equal(database.state.ledgerPostings.length, 0);
    assert.equal(database.state.walletBalance, 1_000n);

    // The worker's fastpay.refund.query resolves the REAL tri-state:
    // REFUND_SUCCESS → ledger posted + freeze released.
    alipay.setHandler('refundQuery', (call) => {
      const outRequestNo = JSON.parse(call.params.biz_content ?? '{}').out_request_no as string;
      return { json: refundQueryNode(outRequestNo, 'REFUND_SUCCESS') };
    });
    now.value += 2_000;
    const batch = await service.processPendingRefunds();
    assert.equal(batch.queried, 1);
    assert.equal(batch.succeeded, 1);
    assert.equal(alipay.calls.refund.length, 1, 'reconciliation never resubmits the refund');
    assert.equal(alipay.calls.refundQuery.length, 1);
    assert.equal(database.state.ledgerPostings.length, 1);
    assert.equal(database.state.ledgerPostings[0]?.amountMinorUnits, '400');
    assert.equal(database.state.walletFreezes.length, 0, 'a proven success releases the freeze');
    assert.equal(database.state.walletBalance, 600n);
    assert.equal(database.state.refunds[0]?.state, 'succeeded');
    assert.equal(
      database.state.refunds[0]?.provider_refund_id,
      refund.id,
      'the out_request_no stays the refund identity',
    );

    // Second refund: the query proves a terminal failure → freeze released, wallet untouched.
    const second = await service.requestWalletTopUpRefund(walletRefund('alipay-refund-2'));
    assert.equal(second.status, 'pending');
    assert.equal(database.state.walletFreezes.length, 1);
    alipay.setHandler('refundQuery', (call) => {
      const outRequestNo = JSON.parse(call.params.biz_content ?? '{}').out_request_no as string;
      return { json: refundQueryNode(outRequestNo, 'REFUND_FAILED') };
    });
    now.value += 2_000;
    const failedBatch = await service.processPendingRefunds();
    assert.equal(failedBatch.failed, 1);
    assert.equal(database.state.walletFreezes.length, 0, 'a proven failure releases the freeze');
    assert.equal(database.state.ledgerPostings.length, 1, 'a failed refund never posts the wallet ledger');
    assert.equal(database.state.walletBalance, 600n);
    assert.equal(database.state.refunds[1]?.state, 'failed');
    await assert.rejects(
      service.requestWalletTopUpRefund({ ...walletRefund('alipay-refund-escrow'), amountMinorUnits: '401' }),
      (error: unknown) => error instanceof PaymentError && error.code === 'REFUND_AMOUNT_EXCEEDS_AVAILABLE',
    );
    assert.equal(alipay.calls.refund.length, 2, 'refund rejection never submits protected escrow to the PSP');
    assert.equal(database.state.refunds.length, 2);
    assert.equal(database.state.walletFreezes.length, 0);
    assert.equal(database.state.ledgerPostings.length, 1);
    assert.equal(database.state.walletBalance, 600n);
    assert.deepEqual(database.state.fastCreditAllocations, allocations);
  } finally {
    await alipay.close();
  }
});
