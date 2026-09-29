import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type { PaymentProviderAdapter } from '../../../src/saas/payments/adapter.js';
import type {
  NormalizedPaymentProviderEvent,
  PaymentCheckoutAction,
  PaymentProviderCreateOrderInput,
  PaymentProviderCreateOrderResult,
  PaymentProviderWebhookVerificationInput,
  PaymentWalletFundingLedger,
  VerifiedPaymentProviderWebhook,
} from '../../../src/saas/payments/types.js';

export interface FakePaymentOrder {
  id: string;
  tenant_id: string;
  order_type: 'wallet_topup';
  provider_key: string;
  merchant_id: string;
  client_request_id: string;
  local_order_ref: string;
  funding_reference: string;
  amount_minor_units: string;
  currency: string;
  state: string;
  provider_order_id: string | null;
  provider_attempts: number;
  provider_failure_code: string | null;
  funding_transaction_id: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  checkout_kind?: string | null;
  checkout_url?: string | null;
  checkout_text?: string | null;
  checkout_expires_at?: string | null;
  provider_submission_state?: string | null;
  provider_submission_lease_token?: string | null;
  provider_submission_lease_expires_at?: string | null;
}

export interface FakeServicePlanOrder {
  id: string;
  tenant_id: string;
  project_id: string;
  plan_version_id: string;
  operation: 'activation' | 'renewal';
  renewal_of_subscription_id: string | null;
  client_request_id: string;
  state: string;
  subscription_id: string | null;
  provider_key: string | null;
  merchant_id: string | null;
  provider_order_id: string | null;
  provider_attempts: number;
  provider_failure_code: string | null;
  verified_settlement_id: string | null;
  verified_provider_key: string | null;
  verified_merchant_id: string | null;
  verified_amount_minor_units: string | null;
  verified_currency: string | null;
  fulfillment_reference: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  snapshot_price_minor_units: string;
  snapshot_currency: string;
  checkout_kind?: string | null;
  checkout_url?: string | null;
  checkout_text?: string | null;
  checkout_expires_at?: string | null;
  provider_submission_state?: string | null;
  provider_submission_lease_token?: string | null;
  provider_submission_lease_expires_at?: string | null;
}

export interface FakePaymentInbox {
  id: string;
  provider_key: string;
  merchant_id: string;
  provider_event_id: string;
  event_type: string;
  provider_order_id: string;
  event_tenant_id: string;
  received_at: string;
  tenant_id: string | null;
  local_order_id: string | null;
  event_status: string;
  amount_minor_units: string;
  currency: string;
  occurred_at: string;
  processing_outcome: string;
  outcome_code: string | null;
  processing_state: string;
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
  processed_at: string | null;
  last_error_code: string | null;
  updated_at: string;
}

export interface FakeFundingPosting {
  transactionId: string;
  tenantId: string;
  currency: string;
  amountMinorUnits: string;
  sourceOrderRef: string;
}

export interface FakePaymentState {
  orders: FakePaymentOrder[];
  servicePlanOrders: FakeServicePlanOrder[];
  inbox: FakePaymentInbox[];
  funding: FakeFundingPosting[];
  fundingCalls: number;
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

export class FakePaymentDatabase {
  state: FakePaymentState = { orders: [], servicePlanOrders: [], inbox: [], funding: [], fundingCalls: 0 };
  inTransaction = false;

  private transactionTail: Promise<void> = Promise.resolve();

  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
    return this.execute<Row>(sql, values);
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const before = clone(this.state);
    this.inTransaction = true;
    try {
      return await work({ query: (sql, values = []) => this.execute(sql, values) });
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      this.inTransaction = false;
      release();
    }
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const [a, b, c, d, e, f, g, h, i, j, k, l, m] = values;

    if (statement.startsWith('set transaction isolation level') || statement.startsWith('set local ')) {
      return result<Row>();
    }

    if (statement.startsWith('select o.id, o.tenant_id, o.project_id')) {
      const order = statement.includes('where o.provider_key =')
        ? this.state.servicePlanOrders.find(
            (row) => row.provider_key === a && row.merchant_id === b && row.provider_order_id === c,
          )
        : this.state.servicePlanOrders.find((row) => row.tenant_id === a && row.project_id === b && row.id === c);
      return result<Row>(order ? [order as Row] : []);
    }

    if (statement.startsWith('select id, tenant_id, order_type') && statement.includes('where provider_key =')) {
      const order = this.state.orders.find(
        (row) => row.provider_key === a && row.merchant_id === b && row.provider_order_id === c,
      );
      return result<Row>(order ? [order as Row] : []);
    }

    if (statement.startsWith('select id, tenant_id, order_type')) {
      const order = statement.includes('client_request_id =')
        ? this.state.orders.find((row) => row.tenant_id === a && row.client_request_id === b)
        : this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      return result<Row>(order ? [order as Row] : []);
    }

    if (statement.startsWith('insert into saas_payment_orders')) {
      const existing = this.state.orders.find((row) => row.tenant_id === b && row.client_request_id === e);
      if (existing) return result<Row>();
      const order: FakePaymentOrder = {
        id: text(a),
        tenant_id: text(b),
        order_type: 'wallet_topup',
        provider_key: text(c),
        merchant_id: text(d),
        client_request_id: text(e),
        local_order_ref: text(a),
        funding_reference: text(a),
        amount_minor_units: text(f),
        currency: text(g),
        state: 'created',
        provider_order_id: null,
        provider_attempts: 0,
        provider_failure_code: null,
        funding_transaction_id: null,
        created_at: text(h),
        updated_at: text(h),
        paid_at: null,
        fulfilled_at: null,
        checkout_kind: null,
        checkout_url: null,
        checkout_text: null,
        checkout_expires_at: null,
        provider_submission_state: 'idle',
        provider_submission_lease_token: null,
        provider_submission_lease_expires_at: null,
      };
      this.state.orders.push(order);
      return result<Row>([order as Row]);
    }

    if (statement.startsWith("update saas_payment_orders set state = 'created'")) {
      const order = this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      if (!order || !['created', 'provider_failed'].includes(order.state)) return result<Row>();
      order.state = 'created';
      order.provider_attempts += 1;
      order.provider_failure_code = null;
      order.provider_submission_state = 'submitting';
      order.provider_submission_lease_token = text(d);
      order.provider_submission_lease_expires_at = text(e);
      order.updated_at = text(c);
      return result<Row>([order as Row]);
    }

    if (statement.startsWith("update saas_payment_orders set state = 'provider_failed'")) {
      const order = this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      if (order?.state !== 'created') return result<Row>();
      order.state = 'provider_failed';
      order.provider_failure_code = text(c);
      order.provider_submission_state = 'failed';
      order.provider_submission_lease_token = null;
      order.provider_submission_lease_expires_at = null;
      order.updated_at = text(d);
      return result<Row>([order as Row]);
    }

    if (statement.startsWith("update saas_payment_orders set state = 'pending'")) {
      const order = this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      if (order?.state !== 'created') return result<Row>();
      order.state = 'pending';
      order.provider_order_id = text(c);
      order.provider_failure_code = null;
      order.checkout_kind = f === null ? null : text(f);
      order.checkout_url = g === null ? null : text(g);
      order.checkout_text = h === null ? null : text(h);
      order.checkout_expires_at = i === null ? null : text(i);
      order.provider_submission_state = 'idle';
      order.provider_submission_lease_token = null;
      order.provider_submission_lease_expires_at = null;
      order.updated_at = text(d);
      return result<Row>([order as Row]);
    }

    if (statement.startsWith('update saas_payment_orders set checkout_kind')) {
      const order = this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      if (!order || order.provider_order_id !== h || order.state !== 'pending') return result<Row>();
      order.checkout_kind = c === null ? null : text(c);
      order.checkout_url = d === null ? null : text(d);
      order.checkout_text = e === null ? null : text(e);
      order.checkout_expires_at = f === null ? null : text(f);
      order.updated_at = text(g);
      return result<Row>([order as Row]);
    }

    if (statement.startsWith("update saas_payment_orders set state = 'reconciliation_pending'")) {
      const order = this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      if (order?.state !== 'created') return result<Row>();
      order.state = 'reconciliation_pending';
      order.provider_failure_code = 'PROVIDER_ACCEPTANCE_UNKNOWN';
      order.provider_submission_state = 'unknown';
      order.provider_submission_lease_token = null;
      order.provider_submission_lease_expires_at = null;
      order.updated_at = text(c);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith('update saas_payment_orders set state = $3')) {
      const order = this.state.orders.find((row) => row.tenant_id === a && row.id === b);
      if (!order) return result<Row>();
      order.state = text(c);
      if (['paid', 'fulfilling', 'fulfilled'].includes(order.state)) order.paid_at ??= d === null ? null : text(d);
      if (e !== null) order.funding_transaction_id = text(e);
      if (order.state === 'fulfilled') order.fulfilled_at ??= d === null ? null : text(d);
      order.updated_at = text(f);
      return result<Row>([order as Row]);
    }

    if (statement.startsWith('update saas_service_plan_orders set provider_key')) {
      const order = this.state.servicePlanOrders.find(
        (row) => row.tenant_id === a && row.project_id === b && row.id === f,
      );
      if (order?.state !== 'pending' || order.provider_order_id !== null) return result<Row>();
      if (order.provider_key !== null && order.provider_key !== c) return result<Row>();
      if (order.merchant_id !== null && order.merchant_id !== d) return result<Row>();
      order.provider_key = text(c);
      order.merchant_id = text(d);
      order.provider_attempts += 1;
      order.provider_failure_code = null;
      order.provider_submission_state = 'submitting';
      order.provider_submission_lease_token = text(g);
      order.provider_submission_lease_expires_at = text(h);
      order.updated_at = text(e);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith('update saas_service_plan_orders set provider_failure_code')) {
      const order = this.state.servicePlanOrders.find(
        (row) => row.tenant_id === a && row.project_id === b && row.id === e,
      );
      if (order?.state !== 'pending' || order.provider_order_id !== null) return result<Row>();
      order.provider_failure_code = text(c);
      order.provider_submission_state = 'failed';
      order.provider_submission_lease_token = null;
      order.provider_submission_lease_expires_at = null;
      order.updated_at = text(d);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith('update saas_service_plan_orders set provider_order_id')) {
      const order = this.state.servicePlanOrders.find(
        (row) => row.tenant_id === a && row.project_id === b && row.id === e,
      );
      if (order?.state !== 'pending' || order.provider_order_id !== null) return result<Row>();
      order.provider_order_id = text(c);
      order.provider_failure_code = null;
      order.checkout_kind = f === null ? null : text(f);
      order.checkout_url = g === null ? null : text(g);
      order.checkout_text = h === null ? null : text(h);
      order.checkout_expires_at = i === null ? null : text(i);
      order.provider_submission_state = 'idle';
      order.provider_submission_lease_token = null;
      order.provider_submission_lease_expires_at = null;
      order.updated_at = text(d);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith('update saas_service_plan_orders set checkout_kind')) {
      const order = this.state.servicePlanOrders.find(
        (row) => row.tenant_id === a && row.project_id === b && row.id === c,
      );
      if (!order || order.provider_order_id !== i || order.state !== 'pending') return result<Row>();
      order.checkout_kind = d === null ? null : text(d);
      order.checkout_url = e === null ? null : text(e);
      order.checkout_text = f === null ? null : text(f);
      order.checkout_expires_at = g === null ? null : text(g);
      order.updated_at = text(h);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith("update saas_service_plan_orders set state = 'reconciliation_pending'")) {
      const order = this.state.servicePlanOrders.find(
        (row) => row.tenant_id === a && row.project_id === b && row.id === c,
      );
      if (order?.state !== 'pending') return result<Row>();
      order.state = 'reconciliation_pending';
      order.provider_failure_code = 'PROVIDER_ACCEPTANCE_UNKNOWN';
      order.provider_submission_state = 'unknown';
      order.provider_submission_lease_token = null;
      order.provider_submission_lease_expires_at = null;
      order.updated_at = text(d);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith("update saas_service_plan_orders set state = 'reconciliation_pending'")) {
      const order = this.state.servicePlanOrders.find(
        (row) => row.tenant_id === a && row.project_id === b && row.id === c,
      );
      if (!order || !['pending', 'paid', 'fulfilling'].includes(order.state)) return result<Row>();
      order.state = 'reconciliation_pending';
      order.updated_at = text(d);
      return result<Row>([{ id: order.id } as Row]);
    }

    if (statement.startsWith('select id, provider_key, merchant_id, provider_event_id')) {
      if (statement.includes('where provider_key =')) {
        const inbox = this.state.inbox.find(
          (row) => row.provider_key === a && row.merchant_id === b && row.provider_event_id === c,
        );
        return result<Row>(inbox ? [inbox as Row] : []);
      }
      if (statement.includes('where id =')) {
        const inbox = this.state.inbox.find((row) => row.id === a);
        return result<Row>(inbox ? [inbox as Row] : []);
      }
      if (statement.includes("processing_state = 'pending'")) {
        const inboxes = this.state.inbox
          .filter(
            (row) =>
              (row.processing_state === 'pending' && row.next_attempt_at <= text(a)) ||
              (row.processing_state === 'processing' &&
                row.lease_expires_at !== null &&
                row.lease_expires_at <= text(a)),
          )
          .sort((left, right) => left.received_at.localeCompare(right.received_at) || left.id.localeCompare(right.id))
          .slice(0, Number(b));
        return result<Row>(inboxes as Row[]);
      }
    }

    if (statement.startsWith('insert into saas_payment_inbox')) {
      const existing = this.state.inbox.find(
        (row) => row.provider_key === b && row.merchant_id === c && row.provider_event_id === d,
      );
      if (existing) return result<Row>();
      const inbox: FakePaymentInbox = {
        id: text(a),
        provider_key: text(b),
        merchant_id: text(c),
        provider_event_id: text(d),
        event_type: text(e),
        provider_order_id: text(f),
        event_tenant_id: text(g),
        tenant_id: h === null ? null : text(h),
        local_order_id: i === null ? null : text(i),
        event_status: text(j),
        amount_minor_units: text(k),
        currency: text(l),
        occurred_at: text(m),
        processing_outcome: 'accepted',
        outcome_code: null,
        processing_state: 'pending',
        attempt_count: 0,
        next_attempt_at: text(values[13]),
        lease_token: null,
        lease_expires_at: null,
        processed_at: null,
        last_error_code: null,
        updated_at: text(values[13]),
        received_at: text(values[13]),
      };
      this.state.inbox.push(inbox);
      return result<Row>([inbox as Row]);
    }

    if (statement.startsWith("update saas_payment_inbox set processing_state = 'processing'")) {
      const inbox = this.state.inbox.find((row) => row.id === a);
      if (!inbox) return result<Row>();
      inbox.processing_state = 'processing';
      inbox.attempt_count += 1;
      inbox.lease_token = text(b);
      inbox.lease_expires_at = text(c);
      inbox.updated_at = text(d);
      inbox.last_error_code = null;
      return result<Row>([inbox as Row]);
    }

    if (statement.startsWith("update saas_payment_inbox set processing_state = 'pending'")) {
      const inbox = this.state.inbox.find(
        (row) => row.id === a && row.processing_state === 'processing' && row.lease_token === b,
      );
      if (!inbox) return result<Row>();
      inbox.processing_state = 'pending';
      inbox.next_attempt_at = text(c);
      inbox.last_error_code = text(d);
      inbox.updated_at = text(e);
      inbox.lease_token = null;
      inbox.lease_expires_at = null;
      return result<Row>([{ id: inbox.id } as Row]);
    }

    if (statement.startsWith("update saas_payment_inbox set processing_state = 'processed'")) {
      const inbox = this.state.inbox.find(
        (row) => row.id === a && row.processing_state === 'processing' && row.lease_token === b,
      );
      if (!inbox) return result<Row>();
      inbox.processing_state = 'processed';
      inbox.processing_outcome = 'reconciliation';
      inbox.outcome_code = 'WORKER_RETRIES_EXHAUSTED';
      inbox.last_error_code = text(c);
      inbox.processed_at = text(d);
      inbox.updated_at = text(d);
      inbox.lease_token = null;
      inbox.lease_expires_at = null;
      return result<Row>([{ id: inbox.id } as Row]);
    }

    if (statement.startsWith('update saas_payment_inbox set processing_outcome')) {
      const inbox = this.state.inbox.find((row) => row.id === a);
      if (!inbox) return result<Row>();
      inbox.processing_outcome = text(b);
      inbox.outcome_code = c === null ? null : text(c);
      inbox.processing_state = 'processed';
      inbox.processed_at = text(d);
      inbox.updated_at = text(d);
      inbox.lease_token = null;
      inbox.lease_expires_at = null;
      inbox.last_error_code = null;
      return result<Row>([inbox as Row]);
    }

    throw new Error(`Unhandled fake SQL: ${statement}`);
  }
}

export function createFakeFundingLedger(database: FakePaymentDatabase): {
  shouldFail: boolean;
  calls: Array<{ tenantId: string; amountMinorUnits: string; sourceOrderRef: string }>;
  postVerifiedFunding: PaymentWalletFundingLedger['postVerifiedFunding'];
} {
  const ledger = {
    shouldFail: false,
    calls: [] as Array<{ tenantId: string; amountMinorUnits: string; sourceOrderRef: string }>,
    async postVerifiedFunding(
      _executor: SqlExecutor,
      input: {
        tenantId: string;
        currency: string;
        amountMinorUnits: string;
        sourceOrderRef: string;
        idempotencyKey: string;
        idempotencyNamespace: string;
        metadataRef: string;
      },
    ): Promise<{ outcome: 'posted'; replayed: boolean; transactionId: string }> {
      database.state.fundingCalls += 1;
      ledger.calls.push({
        tenantId: input.tenantId,
        amountMinorUnits: input.amountMinorUnits,
        sourceOrderRef: input.sourceOrderRef,
      });
      if (ledger.shouldFail) throw new Error('ledger failure');
      const existing = database.state.funding.find((row) => row.sourceOrderRef === input.sourceOrderRef);
      if (existing) return { outcome: 'posted', replayed: true, transactionId: existing.transactionId };
      const transactionId = `funding-${database.state.funding.length + 1}`;
      database.state.funding.push({
        transactionId,
        tenantId: input.tenantId,
        currency: input.currency,
        amountMinorUnits: input.amountMinorUnits,
        sourceOrderRef: input.sourceOrderRef,
      });
      return { outcome: 'posted', replayed: false, transactionId };
    },
  };
  return ledger;
}

export class FakePaymentProvider implements PaymentProviderAdapter {
  readonly providerKey: string;
  readonly calls: PaymentProviderCreateOrderInput[] = [];
  readonly webhookCalls: PaymentProviderWebhookVerificationInput[] = [];
  shouldFailCreate = false;
  safeRejectCreate = false;
  unknownCreateAcceptance = false;
  shouldRejectWebhook = false;
  createGate: Promise<void> | undefined;
  createStarted: (() => void) | undefined;
  checkoutAction: PaymentCheckoutAction | undefined;
  refreshedCheckoutAction: PaymentCheckoutAction | undefined;
  shouldFailRefresh = false;
  readonly refreshCalls: string[] = [];

  constructor(providerKey = 'fake-psp') {
    this.providerKey = providerKey;
  }

  async createOrder(input: PaymentProviderCreateOrderInput): Promise<PaymentProviderCreateOrderResult> {
    this.calls.push(input);
    this.createStarted?.();
    if (this.createGate) await this.createGate;
    if (this.safeRejectCreate) {
      throw Object.assign(new Error('provider definitively rejected the order'), {
        acceptance: 'rejected' as const,
        retryable: true as const,
      });
    }
    if (this.unknownCreateAcceptance) {
      throw Object.assign(new Error('provider acceptance is unknown'), { acceptance: 'unknown' as const });
    }
    if (this.shouldFailCreate) throw new Error('provider failure');
    return {
      providerOrderId: `provider-${input.localOrderId}`,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction: this.checkoutAction,
    };
  }

  async refreshCheckout(input: {
    localOrderId: string;
    tenantId: string;
    providerOrderId: string;
    amountMinorUnits: string;
    currency: string;
    merchantId: string;
  }): Promise<PaymentProviderCreateOrderResult> {
    this.refreshCalls.push(input.providerOrderId);
    if (this.shouldFailRefresh) throw new Error('refresh failure');
    return {
      providerOrderId: input.providerOrderId,
      amountMinorUnits: input.amountMinorUnits,
      currency: input.currency,
      checkoutAction: this.refreshedCheckoutAction ?? this.checkoutAction,
    };
  }

  async verifyWebhook(input: PaymentProviderWebhookVerificationInput): Promise<VerifiedPaymentProviderWebhook> {
    this.webhookCalls.push(input);
    if (this.shouldRejectWebhook) throw new Error('bad signature');
    return {
      providerKey: this.providerKey,
      merchantId: input.merchantId,
      payload: JSON.parse(input.rawBody.toString('utf8')) as unknown,
    };
  }

  normalizeEvent(input: VerifiedPaymentProviderWebhook): NormalizedPaymentProviderEvent {
    const value = input.payload as Record<string, unknown>;
    return {
      providerEventId: String(value.eventId),
      eventType: String(value.eventType ?? 'payment.updated'),
      providerOrderId: String(value.providerOrderId),
      tenantId: String(value.tenantId),
      merchantId: input.merchantId,
      status: value.status as NormalizedPaymentProviderEvent['status'],
      amountMinorUnits: String(value.amountMinorUnits),
      currency: String(value.currency),
      occurredAt: String(value.occurredAt),
    };
  }
}

export function successWebhook(
  providerOrderId: string,
  tenantId: string,
  eventId = 'event-1',
  amountMinorUnits = '125',
  currency = 'USD',
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId,
      eventType: 'payment.updated',
      providerOrderId,
      tenantId,
      status,
      amountMinorUnits,
      currency,
      occurredAt: '2026-09-28T00:01:00.000Z',
    }),
  );
}
