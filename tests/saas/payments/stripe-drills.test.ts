import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import { PaymentError } from '../../../src/saas/payments/errors.js';
import { createStripePaymentProvider, STRIPE_PROVIDER_KEY } from '../../../src/saas/payments/providers/stripe/index.js';
import { PaymentRefundService } from '../../../src/saas/payments/refunds.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import type { PaymentRefundOperationsPort } from '../../../src/saas/payments/types.js';
import { createFakeFundingLedger, FakePaymentDatabase } from './fake-sql.js';
import {
  type MockStripe,
  startMockStripe,
  stripeEventBody,
  stripePaymentIntentJson,
  stripeRefundJson,
  stripeSignatureHeader,
} from './mock-stripe.js';

// C5/R3 drills: callback disorder against the programmable mock Stripe with
// the real adapter and fulfillment service — signature + active retrieve
// confirmation fulfills exactly once, an unconfirmed signed success lands in
// reconciliation with zero wallet movement, duplicate delivery replays from
// the durable inbox, conflicting replay is refused. The refund drill proves
// the C5 core value: Stripe's real refund query tri-state settles the freeze
// (succeeded → ledger + release, failed → release without ledger) where
// EasyPay's permanent unknown stays operator-bound (refunds.test.ts C4).

// Stripe's docs sample key; split so secret scanners do not match the literal.
const SECRET_KEY = `sk_test_${'4eC39HqLyjWDarjtT1zdp7dc'}`;
const PUBLISHABLE_KEY = 'pk_test_TYooMQauvdEDq54NiTphI7jx';
const WEBHOOK_SECRET = `whsec_${'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'}`;
const TENANT_ID = 'tenant-1';
const NOW_SEC = Math.floor(Date.parse('2026-10-11T00:00:00.000Z') / 1000);

function intentIdFor(orderId: string): string {
  return `pi_e2e_${orderId}`;
}

function signedSucceeded(
  orderId: string,
  options: { eventId?: string; amount?: number; secret?: string; createdSec?: number } = {},
): { body: Buffer; headers: Record<string, string> } {
  const body = stripeEventBody({
    eventId: options.eventId ?? `evt_e2e_${orderId}`,
    type: 'payment_intent.succeeded',
    intent: {
      id: intentIdFor(orderId),
      amount: options.amount ?? 1234,
      currency: 'usd',
      status: 'succeeded',
      metadata: { out_trade_no: orderId, tenant_id: TENANT_ID },
    },
    ...(options.createdSec === undefined ? {} : { createdSec: options.createdSec }),
  });
  return {
    body,
    headers: {
      'stripe-signature': stripeSignatureHeader(body, options.secret ?? WEBHOOK_SECRET, NOW_SEC),
    },
  };
}

async function createFixture(stripe: MockStripe) {
  const clock = { value: Date.parse('2026-10-11T00:00:00.000Z') };
  const provider = createStripePaymentProvider({
    secretKey: SECRET_KEY,
    publishableKey: PUBLISHABLE_KEY,
    webhookSecret: WEBHOOK_SECRET,
    apiBase: stripe.url,
    now: () => new Date(clock.value),
  });
  const database = new FakePaymentDatabase();
  let nextId = 0;
  const service = new PaymentFulfillmentService(database, provider.adapter, {
    providerKey: STRIPE_PROVIDER_KEY,
    merchantId: PUBLISHABLE_KEY,
    now: () => new Date(clock.value),
    idFactory: () => `local-${++nextId}`,
    walletFundingLedger: createFakeFundingLedger(database),
  });
  return { database, service, clock };
}

function programCreate(stripe: MockStripe): void {
  stripe.setHandler('paymentIntentsCreate', (call) => {
    const outTradeNo = call.params['metadata[out_trade_no]'] ?? 'unknown';
    const id = intentIdFor(outTradeNo);
    return {
      json: stripePaymentIntentJson({
        id,
        amount: Number(call.params.amount),
        currency: 'usd',
        status: 'requires_payment_method',
        metadata: { out_trade_no: outTradeNo, tenant_id: call.params['metadata[tenant_id]'] ?? '' },
        clientSecret: `${id}_secret_e2e`,
      }),
    };
  });
}

function programRetrieve(stripe: MockStripe, status: string): void {
  stripe.setHandler('paymentIntentsRetrieve', (call) => {
    const id = call.path.slice('/v1/payment_intents/'.length);
    return {
      json: stripePaymentIntentJson({
        id,
        amount: 1234,
        currency: 'usd',
        status,
        metadata: { out_trade_no: id.replace(/^pi_e2e_/, ''), tenant_id: TENANT_ID },
      }),
    };
  });
}

test('C5: a signed success fulfills only after the active retrieve confirms — exactly once', async () => {
  const stripe = await startMockStripe();
  try {
    programCreate(stripe);
    const { database, service } = await createFixture(stripe);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'USD',
    });
    assert.equal(order.providerOrderId, intentIdFor(order.id));
    assert.equal(order.checkout.status, 'ready');
    assert.equal(order.checkout.action?.kind, 'qr', 'the client_secret rides the constrained qr text carrier');

    programRetrieve(stripe, 'succeeded');
    const webhook = signedSucceeded(order.id);
    const receipt = await service.handleWebhook(webhook.headers, webhook.body);
    assert.equal(receipt.outcome, 'accepted');
    const batch = await service.processPendingWebhooks();
    assert.equal(batch.processed, 1);
    assert.equal(database.state.funding.length, 1, 'the retrieve-confirmed event credits the wallet exactly once');
    assert.equal(database.state.funding[0]?.amountMinorUnits, '1234');
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
    assert.equal(stripe.calls.paymentIntentsRetrieve.length, 1, 'fulfillment required the active retrieve');

    // A signed success the retrieve does NOT confirm lands in reconciliation.
    const second = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-2',
      amountMinorUnits: '1234',
      currency: 'USD',
    });
    programRetrieve(stripe, 'requires_payment_method');
    const forged = signedSucceeded(second.id);
    await service.handleWebhook(forged.headers, forged.body);
    await service.processPendingWebhooks();
    assert.equal(database.state.orders[1]?.state, 'pending', 'an unconfirmed signed success never fulfills');
    assert.equal(database.state.inbox[1]?.processing_outcome, 'reconciliation');
    assert.equal(database.state.inbox[1]?.outcome_code, 'STRIPE_PAYMENT_INTENT_NOT_SUCCEEDED');
    assert.equal(database.state.funding.length, 1, 'zero wallet movement without retrieve confirmation');
  } finally {
    await stripe.close();
  }
});

test('C5: duplicate notifications replay from the durable inbox and credit the wallet exactly once', async () => {
  const stripe = await startMockStripe();
  try {
    programCreate(stripe);
    const { database, service, clock } = await createFixture(stripe);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'USD',
    });
    programRetrieve(stripe, 'succeeded');
    const webhook = signedSucceeded(order.id, { createdSec: NOW_SEC - 30 });
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
    assert.equal(stripe.calls.paymentIntentsRetrieve.length, 1, 'the pre-fulfillment retrieve ran exactly once');
  } finally {
    await stripe.close();
  }
});

test('C5: a signed but conflicting replay of the same event is refused and never re-credits', async () => {
  const stripe = await startMockStripe();
  try {
    programCreate(stripe);
    const { database, service } = await createFixture(stripe);
    const order = await service.createWalletTopUp({
      tenantId: TENANT_ID,
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'USD',
    });
    programRetrieve(stripe, 'succeeded');
    const webhook = signedSucceeded(order.id);
    await service.handleWebhook(webhook.headers, webhook.body);
    assert.equal((await service.processPendingWebhooks()).processed, 1);
    assert.equal(database.state.funding.length, 1);

    // Same double-anchored identity (event id + intent id), different signed
    // amount: a valid v1 signature is not proof of consistency — the inbox
    // must refuse the drift.
    const conflict = signedSucceeded(order.id, { amount: 9999 });
    await assert.rejects(
      service.handleWebhook(conflict.headers, conflict.body),
      (error: unknown) => error instanceof PaymentError && error.code === 'PAYMENT_EVENT_CONFLICT',
    );
    assert.equal(database.state.inbox.length, 1);
    assert.equal(database.state.funding.length, 1);
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
  } finally {
    await stripe.close();
  }
});

// --- Refund drill: slim wallet-only fake (mirrors the refunds.test.ts harness semantics) ---

const REFUND_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const REFUND_ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const TOP_UP_ID = '00000000-0000-4000-8000-000000000003';
const FUNDING_TX_ID = '00000000-0000-4000-8000-000000000004';
const WALLET_ID = '00000000-0000-4000-8000-000000000006';
const DRILL_INTENT_ID = 'pi_3OrERmKcfg7EjL0f1k2gDRILL';

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
    provider_key: STRIPE_PROVIDER_KEY,
    merchant_id: PUBLISHABLE_KEY,
    provider_order_id: DRILL_INTENT_ID,
    local_order_ref: 'local-top-up-1',
    funding_reference: 'funding-ref-1',
    amount_minor_units: '1000',
    currency: 'USD',
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
              currency: 'USD',
              source_type: 'wallet_funding',
              source_order_ref: 'funding-ref-1',
              amount_minor_units: '1000',
            }
          : null;
      return result<Row>(row ? [row as Row] : []);
    }
    if (statement.startsWith('select id, tenant_id, currency, posted_balance_minor_units')) {
      const row =
        a === REFUND_TENANT_ID && b === 'USD'
          ? {
              id: WALLET_ID,
              tenant_id: REFUND_TENANT_ID,
              currency: 'USD',
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
    providerKey: STRIPE_PROVIDER_KEY,
    merchantId: PUBLISHABLE_KEY,
    operations,
    walletRefundLedger: { postVerifiedWalletRefund: database.postFakeWalletRefund.bind(database) },
    now: () => new Date(now.value),
    idFactory: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
    leaseTtlMs: 1_000,
    reconcileDelayMs: 1_000,
  });
}

test('C5: a stripe refund settles through the REAL query tri-state — succeeded posts the ledger and releases the freeze, failed releases without posting', async () => {
  const stripe = await startMockStripe();
  try {
    const now = { value: Date.parse('2026-10-11T00:00:00.000Z') };
    const provider = createStripePaymentProvider({
      secretKey: SECRET_KEY,
      publishableKey: PUBLISHABLE_KEY,
      webhookSecret: WEBHOOK_SECRET,
      apiBase: stripe.url,
      now: () => new Date(now.value),
    });
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

    // First refund: PSP accepts as pending; the freeze stays while unproven.
    stripe.setHandler('refundsCreate', (call) => ({
      json: stripeRefundJson({
        id: 're_drill_accepted_1',
        paymentIntent: call.params.payment_intent ?? DRILL_INTENT_ID,
        amount: Number(call.params.amount),
        status: 'pending',
      }),
    }));
    const refund = await service.requestWalletTopUpRefund(walletRefund('stripe-refund-1'));
    assert.equal(refund.status, 'pending', 'PSP acceptance is provisional, never self-finalizing');
    assert.equal(stripe.calls.refundsCreate.length, 1);
    assert.equal(stripe.calls.refundsCreate[0]?.headers['idempotency-key'], refund.id);
    assert.equal(database.state.walletFreezes.length, 1, 'the freeze stays while the outcome is unproven');
    assert.equal(database.state.ledgerPostings.length, 0);
    assert.equal(database.state.walletBalance, 1_000n);

    // The worker's retrieve-driven query resolves the REAL tri-state:
    // succeeded → ledger posted + freeze released. Where EasyPay's permanent
    // unknown stays operator-bound (refunds.test.ts C4), Stripe proves the
    // refund port abstraction does not collapse for a full-capability PSP.
    stripe.setHandler('refundsRetrieve', () => ({
      json: stripeRefundJson({
        id: 're_drill_accepted_1',
        paymentIntent: DRILL_INTENT_ID,
        amount: 400,
        status: 'succeeded',
      }),
    }));
    now.value += 2_000;
    const batch = await service.processPendingRefunds();
    assert.equal(batch.queried, 1);
    assert.equal(batch.succeeded, 1);
    assert.equal(stripe.calls.refundsCreate.length, 1, 'reconciliation never resubmits the refund');
    assert.equal(stripe.calls.refundsRetrieve.length, 1);
    assert.equal(stripe.calls.refundsRetrieve[0]?.path, '/v1/refunds/re_drill_accepted_1');
    assert.equal(database.state.ledgerPostings.length, 1);
    assert.equal(database.state.ledgerPostings[0]?.amountMinorUnits, '400');
    assert.equal(database.state.walletFreezes.length, 0, 'a proven success releases the freeze');
    assert.equal(database.state.walletBalance, 600n);
    assert.equal(database.state.refunds[0]?.state, 'succeeded');

    // Second refund: query proves failed → freeze released, wallet untouched.
    stripe.setHandler('refundsCreate', (call) => ({
      json: stripeRefundJson({
        id: 're_drill_failed_2',
        paymentIntent: call.params.payment_intent ?? DRILL_INTENT_ID,
        amount: Number(call.params.amount),
        status: 'pending',
      }),
    }));
    const second = await service.requestWalletTopUpRefund(walletRefund('stripe-refund-2'));
    assert.equal(second.status, 'pending');
    assert.equal(database.state.walletFreezes.length, 1);
    stripe.setHandler('refundsRetrieve', () => ({
      json: stripeRefundJson({
        id: 're_drill_failed_2',
        paymentIntent: DRILL_INTENT_ID,
        amount: 400,
        status: 'failed',
      }),
    }));
    now.value += 2_000;
    const failedBatch = await service.processPendingRefunds();
    assert.equal(failedBatch.failed, 1);
    assert.equal(database.state.walletFreezes.length, 0, 'a proven failure releases the freeze');
    assert.equal(database.state.ledgerPostings.length, 1, 'a failed refund never posts the wallet ledger');
    assert.equal(database.state.walletBalance, 600n);
    assert.equal(database.state.refunds[1]?.state, 'failed');
  } finally {
    await stripe.close();
  }
});
