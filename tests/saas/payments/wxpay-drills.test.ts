import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { createWxpayPaymentProvider, WXPAY_PROVIDER_KEY } from '../../../src/saas/payments/providers/wxpay/index.js';
import { PaymentRefundService } from '../../../src/saas/payments/refunds.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import type { PaymentRefundOperationsPort } from '../../../src/saas/payments/types.js';
import { createFakeFundingLedger, FakePaymentDatabase } from './fake-sql.js';
import {
  type MockWxpay,
  startMockWxpay,
  WXPAY_TEST_APIV3_KEY,
  WXPAY_TEST_APPID,
  WXPAY_TEST_MCHID,
  WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM,
  WXPAY_TEST_MERCHANT_SERIAL,
  wxpayNotification,
  wxpayRefundJson,
  wxpayTransactionJson,
} from './mock-wxpay.js';

// R3 wxpay drills: callback disorder against the programmable mock WeChat Pay
// v3 with the real adapter and fulfillment service — platform-certificate RSA
// verification + AES-256-GCM decryption + the active out-trade-no query
// confirms before the wallet credits, exactly once; an unconfirmed signed
// success lands in reconciliation with zero wallet movement; duplicate
// delivery replays from the durable inbox; conflicting replay is refused. The
// refund drill proves the real query tri-state (SUCCESS → ledger + release,
// ABNORMAL → release without ledger) where EasyPay's permanent unknown stays
// operator-bound.

const TENANT_ID = 'tenant-1';
const TRANSACTION_ID = '4200000000000000000000000001';
const CODE_URL = 'weixin://wxpay/bizpayurl?pr=drillCodeUrl1';
const NOW = new Date('2026-10-12T00:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function providerConfig(wxpay: MockWxpay, clock: { value: number }) {
  return {
    mchid: WXPAY_TEST_MCHID,
    appid: WXPAY_TEST_APPID,
    merchantSerialNo: WXPAY_TEST_MERCHANT_SERIAL,
    merchantPrivateKey: WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM,
    apiV3Key: WXPAY_TEST_APIV3_KEY,
    gateway: wxpay.url,
    notifyUrl: 'https://payments.example.com/webhooks/wxpay',
    now: () => new Date(clock.value),
  };
}

function signedSuccess(
  orderId: string,
  options: { eventId?: string; total?: number; apiV3Key?: string } = {},
): { body: Buffer; headers: Record<string, string> } {
  return wxpayNotification({
    transaction: {
      outTradeNo: orderId,
      transactionId: TRANSACTION_ID,
      tradeState: 'SUCCESS',
      total: options.total ?? 1234,
      attach: TENANT_ID,
      successTime: '2026-10-12T00:00:00+08:00',
    },
    eventId: options.eventId ?? `evt-${orderId}`,
    timestampSec: NOW_SEC,
    createTime: '2026-10-12T00:00:00+08:00',
    ...(options.apiV3Key === undefined ? {} : { apiV3Key: options.apiV3Key }),
  });
}

async function createFixture(wxpay: MockWxpay) {
  const clock = { value: NOW.getTime() };
  const provider = createWxpayPaymentProvider(providerConfig(wxpay, clock));
  const database = new FakePaymentDatabase();
  let nextId = 0;
  const service = new PaymentFulfillmentService(database, provider.adapter, {
    providerKey: WXPAY_PROVIDER_KEY,
    merchantId: WXPAY_TEST_MCHID,
    now: () => new Date(clock.value),
    idFactory: () => `local-${++nextId}`,
    walletFundingLedger: createFakeFundingLedger(database),
  });
  return { database, service, clock };
}

function programCreate(wxpay: MockWxpay): void {
  wxpay.setHandler('transactionsNativeCreate', () => ({ json: { code_url: CODE_URL } }));
}

function programQuery(wxpay: MockWxpay, tradeState: string): void {
  wxpay.setHandler('transactionsQuery', (call) => {
    const outTradeNo = call.path.slice('/v3/pay/transactions/out-trade-no/'.length);
    return {
      json: wxpayTransactionJson({
        outTradeNo,
        transactionId: TRANSACTION_ID,
        tradeState,
        total: 1234,
        attach: TENANT_ID,
      }),
    };
  });
}

test('R3 wxpay: a verified + decrypted success fulfills only after the active query confirms — exactly once', async () => {
  const wxpay = await startMockWxpay();
  try {
    programCreate(wxpay);
    const { database, service } = await createFixture(wxpay);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    assert.equal(order.providerOrderId, order.id, 'the provider order id is the out_trade_no');
    assert.equal(order.checkout.status, 'ready');
    assert.equal(order.checkout.action?.kind, 'qr');
    assert.equal(order.checkout.action?.kind === 'qr' ? order.checkout.action.text : null, CODE_URL);

    programQuery(wxpay, 'SUCCESS');
    const webhook = signedSuccess(order.id);
    const receipt = await service.handleWebhook(webhook.headers, webhook.body);
    assert.equal(receipt.outcome, 'accepted');
    const batch = await service.processPendingWebhooks();
    assert.equal(batch.processed, 1);
    assert.equal(database.state.funding.length, 1, 'the query-confirmed event credits the wallet exactly once');
    assert.equal(database.state.funding[0]?.amountMinorUnits, '1234');
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
    assert.equal(wxpay.calls.certificates.length, 1, 'the platform certificate was fetched once and cached');
    assert.equal(wxpay.calls.transactionsQuery.length, 1, 'fulfillment required the active out-trade-no query');

    // A signed + decrypted success the query does NOT confirm lands in reconciliation.
    const second = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-2',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    programQuery(wxpay, 'USERPAYING');
    const unconfirmed = signedSuccess(second.id);
    await service.handleWebhook(unconfirmed.headers, unconfirmed.body);
    await service.processPendingWebhooks();
    assert.equal(database.state.orders[1]?.state, 'pending', 'an unconfirmed signed success never fulfills');
    assert.equal(database.state.inbox[1]?.processing_outcome, 'reconciliation');
    assert.equal(database.state.inbox[1]?.outcome_code, 'WXPAY_TRADE_NOT_SUCCESS');
    assert.equal(database.state.funding.length, 1, 'zero wallet movement without query confirmation');
  } finally {
    await wxpay.close();
  }
});

test('R3 wxpay: duplicate notifications replay from the durable inbox and credit the wallet exactly once', async () => {
  const wxpay = await startMockWxpay();
  try {
    programCreate(wxpay);
    const { database, service, clock } = await createFixture(wxpay);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    programQuery(wxpay, 'SUCCESS');
    const webhook = signedSuccess(order.id);
    const first = await service.handleWebhook(webhook.headers, webhook.body);
    const second = await service.handleWebhook(webhook.headers, webhook.body);
    assert.equal(first.outcome, 'accepted');
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, 'byte-identical redelivery is a durable inbox replay');
    assert.equal(second.inboxId, first.inboxId);
    assert.equal(database.state.inbox.length, 1);
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    clock.value += 1_000;
    const third = await service.handleWebhook(webhook.headers, webhook.body);
    assert.equal(third.replayed, true, 'redelivery after processing still replays, never re-enqueues');
    assert.equal((await service.processPendingWebhooks()).processed, 0);
    assert.equal(database.state.funding.length, 1);
    assert.equal(wxpay.calls.transactionsQuery.length, 1, 'the pre-fulfillment query ran exactly once');
  } finally {
    await wxpay.close();
  }
});

test('R3 wxpay: a signed but conflicting replay of the same event is refused and never re-credits', async () => {
  const wxpay = await startMockWxpay();
  try {
    programCreate(wxpay);
    const { database, service } = await createFixture(wxpay);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    programQuery(wxpay, 'SUCCESS');
    const webhook = signedSuccess(order.id);
    await service.handleWebhook(webhook.headers, webhook.body);
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    // Same double-anchored identity (notification id + transaction id),
    // different signed amount: a valid platform signature is not proof of
    // consistency — the inbox must refuse the drift.
    const conflict = signedSuccess(order.id, { total: 9999 });
    await assert.rejects(
      service.handleWebhook(conflict.headers, conflict.body),
      (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_EVENT_CONFLICT',
    );
    assert.equal(database.state.inbox.length, 1);
    assert.equal(database.state.funding.length, 1);
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
  } finally {
    await wxpay.close();
  }
});

// --- Refund drill: slim wallet-only fake (mirrors the refunds.test.ts harness semantics) ---

const REFUND_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const REFUND_ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const TOP_UP_ID = '00000000-0000-4000-8000-000000000003';
const FUNDING_TX_ID = '00000000-0000-4000-8000-000000000004';
const WALLET_ID = '00000000-0000-4000-8000-000000000006';
const DRILL_OUT_TRADE_NO = 'local-top-up-1';

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
  };

  readonly walletTopUp: Record<string, unknown> = {
    id: TOP_UP_ID,
    tenant_id: REFUND_TENANT_ID,
    order_type: 'wallet_topup',
    state: 'fulfilled',
    provider_key: WXPAY_PROVIDER_KEY,
    merchant_id: WXPAY_TEST_MCHID,
    provider_order_id: DRILL_OUT_TRADE_NO,
    local_order_ref: DRILL_OUT_TRADE_NO,
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
    if (
      statement.startsWith('select coalesce(sum(amount_minor_units), 0)::text as total from saas_billing_reservations')
    ) {
      return result<Row>([{ total: this.state.requestHolds.toString() } as Row]);
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
    providerKey: WXPAY_PROVIDER_KEY,
    merchantId: WXPAY_TEST_MCHID,
    operations,
    walletRefundLedger: { postVerifiedWalletRefund: database.postFakeWalletRefund.bind(database) },
    now: () => new Date(now.value),
    idFactory: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
    leaseTtlMs: 1_000,
    reconcileDelayMs: 1_000,
  });
}

test('R3 wxpay: a refund settles through the REAL query tri-state — SUCCESS posts the ledger and releases the freeze, ABNORMAL releases without posting', async () => {
  const wxpay = await startMockWxpay();
  try {
    const now = { value: NOW.getTime() };
    const provider = createWxpayPaymentProvider(providerConfig(wxpay, now));
    const database = new FakeRefundDatabase();
    const service = createRefundService(database, provider.refundAdapter, now);
    const walletRefund = (clientRequestId: string) => ({
      actorId: REFUND_ACTOR_ID,
      tenantId: REFUND_TENANT_ID,
      orderId: TOP_UP_ID,
      clientRequestId,
      amountMinorUnits: '400',
      reasonCode: 'CUSTOMER_REQUEST',
    });

    // First refund: PSP accepts as PROCESSING; the freeze stays while unproven.
    wxpay.setHandler('transactionsQuery', () => ({
      json: wxpayTransactionJson({
        outTradeNo: DRILL_OUT_TRADE_NO,
        transactionId: TRANSACTION_ID,
        tradeState: 'SUCCESS',
        total: 1000,
        attach: REFUND_TENANT_ID,
      }),
    }));
    wxpay.setHandler('refundsCreate', (call) => {
      const body = call.json as Record<string, unknown>;
      const amount = body.amount as Record<string, unknown>;
      return {
        json: wxpayRefundJson({
          outRefundNo: String(body.out_refund_no),
          outTradeNo: String(body.out_trade_no),
          status: 'PROCESSING',
          refund: Number(amount.refund),
          total: Number(amount.total),
        }),
      };
    });
    const refund = await service.requestWalletTopUpRefund(walletRefund('wxpay-refund-1'));
    assert.equal(refund.status, 'pending', 'PSP acceptance is provisional, never self-finalizing');
    assert.equal(wxpay.calls.refundsCreate.length, 1);
    assert.match(wxpay.calls.refundsCreate[0]?.rawBody ?? '', /"out_refund_no":"00000000-0000-4000-8000-000000000100"/);
    assert.match(wxpay.calls.refundsCreate[0]?.rawBody ?? '', /"refund":400,"total":1000/);
    assert.equal(database.state.walletFreezes.length, 1, 'the freeze stays while the outcome is unproven');
    assert.equal(database.state.ledgerPostings.length, 0);
    assert.equal(database.state.walletBalance, 1_000n);

    // The worker's query-by-out_refund_no resolves the REAL tri-state:
    // SUCCESS → ledger posted + freeze released.
    wxpay.setHandler('refundsQuery', (call) => ({
      json: wxpayRefundJson({
        outRefundNo: call.path.slice('/v3/refund/domestic/refunds/'.length),
        outTradeNo: DRILL_OUT_TRADE_NO,
        status: 'SUCCESS',
        refund: 400,
        total: 1000,
      }),
    }));
    now.value += 2_000;
    const batch = await service.processPendingRefunds();
    assert.equal(batch.queried, 1);
    assert.equal(batch.succeeded, 1);
    assert.equal(wxpay.calls.refundsCreate.length, 1, 'reconciliation never resubmits the refund');
    assert.equal(wxpay.calls.refundsQuery.length, 1);
    assert.equal(database.state.ledgerPostings.length, 1);
    assert.equal(database.state.ledgerPostings[0]?.amountMinorUnits, '400');
    assert.equal(database.state.walletFreezes.length, 0, 'a proven success releases the freeze');
    assert.equal(database.state.walletBalance, 600n);
    assert.equal(database.state.refunds[0]?.state, 'succeeded');

    // Second refund: query proves ABNORMAL → freeze released, wallet untouched.
    const second = await service.requestWalletTopUpRefund(walletRefund('wxpay-refund-2'));
    assert.equal(second.status, 'pending');
    assert.equal(database.state.walletFreezes.length, 1);
    wxpay.setHandler('refundsQuery', (call) => ({
      json: wxpayRefundJson({
        outRefundNo: call.path.slice('/v3/refund/domestic/refunds/'.length),
        outTradeNo: DRILL_OUT_TRADE_NO,
        status: 'ABNORMAL',
        refund: 400,
        total: 1000,
      }),
    }));
    now.value += 2_000;
    const failedBatch = await service.processPendingRefunds();
    assert.equal(failedBatch.failed, 1);
    assert.equal(database.state.walletFreezes.length, 0, 'a proven failure releases the freeze');
    assert.equal(database.state.ledgerPostings.length, 1, 'a failed refund never posts the wallet ledger');
    assert.equal(database.state.walletBalance, 600n);
    assert.equal(database.state.refunds[1]?.state, 'failed');

    // Third refund: the query answers 404 → not_found is never proof of
    // rejection; the refund stays operator-bound with the freeze intact.
    const third = await service.requestWalletTopUpRefund(walletRefund('wxpay-refund-3'));
    assert.equal(third.status, 'pending');
    assert.equal(database.state.walletFreezes.length, 1);
    wxpay.setHandler('refundsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'refund not exists' },
    }));
    now.value += 2_000;
    const unresolvedBatch = await service.processPendingRefunds();
    assert.equal(unresolvedBatch.unresolved, 1, 'a not_found query keeps the refund operator-bound');
    assert.equal(database.state.walletFreezes.length, 1, 'the freeze survives an unproven query');
    assert.equal(database.state.ledgerPostings.length, 1);
    assert.equal(database.state.refunds[2]?.state, 'unknown');
  } finally {
    await wxpay.close();
  }
});
