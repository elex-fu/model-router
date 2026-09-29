import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import type { SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import type {
  PaymentProviderRefundAdapter,
  PaymentProviderRefundInput,
  PaymentProviderRefundQueryResult,
  PaymentProviderRefundResult,
  PaymentRefundOperationsPort,
} from '../../../src/saas/payments/index.js';
import { PaymentRefundService } from '../../../src/saas/payments/refunds.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';
const TOP_UP_ID = '00000000-0000-4000-8000-000000000003';
const FUNDING_TX_ID = '00000000-0000-4000-8000-000000000004';
const PLAN_ORDER_ID = '00000000-0000-4000-8000-000000000005';
const WALLET_ID = '00000000-0000-4000-8000-000000000006';
const PROVIDER_KEY = 'fake-psp';
const MERCHANT_ID = 'merchant-test';
const PROVIDER_ORDER_ID = 'psp-payment-123';

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

interface FakeRefundState {
  refunds: FakeRefundRow[];
  servicePlanEffects: Array<Record<string, unknown>>;
  servicePlanSubscription: Record<string, unknown>;
  servicePlanEntitlement: Record<string, unknown>;
  otherActiveSubscriptionId: string | null;
  otherActiveEntitlementId: string | null;
  walletFreezes: Array<{
    refund_order_id: string;
    tenant_id: string;
    wallet_id: string;
    currency: string;
    amount_minor_units: string;
  }>;
  audit: Array<Record<string, unknown>>;
  ledgerPostings: Array<{ refundOrderId: string; amountMinorUnits: string; transactionId: string }>;
  walletBalance: bigint;
  requestHolds: bigint;
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
  readonly state: FakeRefundState = {
    refunds: [],
    servicePlanEffects: [],
    servicePlanSubscription: {
      id: 'subscription-byok-1',
      tenant_id: TENANT_ID,
      project_id: 'project-byok-1',
      order_id: PLAN_ORDER_ID,
      snapshot_id: 'snapshot-byok-1',
      entitlement_id: 'entitlement-byok-1',
      status: 'active',
      effective_at: '2026-09-28T00:00:00.000Z',
      expires_at: '2026-10-28T00:00:00.000Z',
    },
    servicePlanEntitlement: {
      id: 'entitlement-byok-1',
      tenant_id: TENANT_ID,
      project_id: 'project-byok-1',
      supply_mode: 'byok',
      status: 'active',
      authz_version: '1',
      effective_at: '2026-09-28T00:00:00.000Z',
      expires_at: '2026-10-28T00:00:00.000Z',
      superseded_at: null,
      disabled_at: null,
      source_type: 'service_plan',
      source_ref: PLAN_ORDER_ID,
      service_plan_snapshot_id: 'snapshot-byok-1',
    },
    otherActiveSubscriptionId: null,
    otherActiveEntitlementId: null,
    walletFreezes: [],
    audit: [],
    ledgerPostings: [],
    walletBalance: 1_000n,
    requestHolds: 0n,
  };
  walletReads = 0;
  failServicePlanEffectInsert = false;
  rejectRefundAuthorization = false;
  private readonly calls: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly transactionContext = new AsyncLocalStorage<string[]>();
  private readonly transactionTraces: string[][] = [];

  get inTransaction(): boolean {
    return this.transactionContext.getStore() !== undefined;
  }

  walletRelatedCalls(): string[] {
    return this.calls.filter((statement) =>
      /(?:from|into|update|delete from) saas_(?:wallets|ledger_transactions|billing_reservations|refund_wallet_freezes)|fake post verified wallet refund/i.test(
        statement,
      ),
    );
  }

  sqlStatements(): string[] {
    return [...this.calls];
  }

  transactionSqlStatements(): string[][] {
    return this.transactionTraces.map((statements) => [...statements]);
  }

  readonly walletTopUp = {
    id: TOP_UP_ID,
    tenant_id: TENANT_ID,
    order_type: 'wallet_topup',
    state: 'fulfilled',
    provider_key: PROVIDER_KEY,
    merchant_id: MERCHANT_ID,
    provider_order_id: PROVIDER_ORDER_ID,
    local_order_ref: 'local-top-up-1',
    funding_reference: 'funding-ref-1',
    amount_minor_units: '1000',
    currency: 'USD',
    funding_transaction_id: FUNDING_TX_ID,
  };

  readonly servicePlanOrder = {
    id: PLAN_ORDER_ID,
    tenant_id: TENANT_ID,
    project_id: 'project-byok-1',
    state: 'fulfilled',
    subscription_id: 'subscription-byok-1',
    provider_key: PROVIDER_KEY,
    merchant_id: MERCHANT_ID,
    provider_order_id: PROVIDER_ORDER_ID,
    verified_provider_key: PROVIDER_KEY,
    verified_merchant_id: MERCHANT_ID,
    verified_amount_minor_units: '1200',
    verified_currency: 'USD',
    snapshot_id: 'snapshot-byok-1',
    snapshot_price_minor_units: '1200',
    snapshot_currency: 'USD',
    snapshot_policy_version: 'policy-v1',
    local_order_ref: PLAN_ORDER_ID,
  };

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
    const statements: string[] = [];
    this.transactionTraces.push(statements);
    try {
      return await this.transactionContext.run(statements, () =>
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
    input: {
      tenantId: string;
      currency: string;
      amountMinorUnits: bigint | string;
      refundOrderId: string;
    },
  ): Promise<{ transactionId: string; replayed: boolean }> {
    assert.equal(this.inTransaction, true);
    await executor.query('FAKE POST VERIFIED WALLET REFUND', [input.refundOrderId, input.amountMinorUnits.toString()]);
    return { transactionId: `wallet-refund-ledger-${input.refundOrderId}`, replayed: false };
  }

  private async execute<Row>(sql: string, values: readonly unknown[]): Promise<SqlResult<Row>> {
    const statement = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.calls.push(statement);
    const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y] = values;
    this.transactionContext.getStore()?.push(statement);

    if (
      statement.startsWith('set transaction isolation level') ||
      statement.startsWith('set local ') ||
      statement.startsWith('select set_config(') ||
      statement.startsWith('select pg_advisory_xact_lock(1396788563, 46)')
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
    if (statement.startsWith('select o.id, o.tenant_id, o.project_id, o.state, o.subscription_id')) {
      const row =
        this.servicePlanOrder.tenant_id === a && this.servicePlanOrder.id === b ? this.servicePlanOrder : null;
      if (!row || statement.includes('o.verified_provider_key')) return result<Row>(row ? [row as Row] : []);
      return result<Row>([
        {
          id: row.id,
          tenant_id: row.tenant_id,
          project_id: row.project_id,
          state: row.state,
          subscription_id: row.subscription_id,
          snapshot_id: row.snapshot_id,
          snapshot_order_id: row.id,
          snapshot_supply_mode: 'byok',
          snapshot_policy_version: row.snapshot_policy_version,
          snapshot_price_minor_units: row.snapshot_price_minor_units,
          snapshot_currency: row.snapshot_currency,
        } as Row,
      ]);
    }
    if (statement.startsWith('select id from saas_projects where tenant_id = $1 and id = $2 for share')) {
      return result<Row>(a === TENANT_ID && b === 'project-byok-1' ? [{ id: b } as Row] : []);
    }
    if (
      statement.startsWith(
        'select id, tenant_id, project_id, order_id, snapshot_id, entitlement_id, status, effective_at, expires_at from saas_service_plan_subscriptions',
      )
    ) {
      const row = this.state.servicePlanSubscription;
      return result<Row>(
        row.tenant_id === a && row.project_id === b && row.id === c && row.order_id === d ? [row as Row] : [],
      );
    }
    if (
      statement.startsWith(
        'select id, tenant_id, order_id, supply_mode, policy_version, price_minor_units, currency from saas_service_plan_snapshots',
      )
    ) {
      const row = this.servicePlanOrder;
      return result<Row>(
        row.tenant_id === a && row.snapshot_id === b && row.id === c
          ? [
              {
                id: row.snapshot_id,
                tenant_id: row.tenant_id,
                order_id: row.id,
                supply_mode: 'byok',
                policy_version: row.snapshot_policy_version,
                price_minor_units: row.snapshot_price_minor_units,
                currency: row.snapshot_currency,
              } as Row,
            ]
          : [],
      );
    }
    if (
      statement.startsWith(
        'select id, tenant_id, project_id, supply_mode, status, authz_version, effective_at, expires_at',
      )
    ) {
      const row = this.state.servicePlanEntitlement;
      return result<Row>(row.tenant_id === a && row.project_id === b && row.id === c ? [row as Row] : []);
    }
    if (statement.startsWith('select * from saas_refund_service_plan_effects')) {
      const row = this.state.servicePlanEffects.find(
        (effect) => effect.tenant_id === a && effect.refund_order_id === b && effect.effect_ref === c,
      );
      return result<Row>(row ? [row as Row] : []);
    }
    if (
      statement.startsWith('select id from saas_refund_orders') &&
      statement.includes("state in ('submitting', 'pending', 'unknown')")
    ) {
      const row = this.state.refunds.find(
        (refund) =>
          refund.tenant_id === a &&
          refund.service_plan_order_id === b &&
          refund.refund_type === 'byok_service_plan' &&
          ['submitting', 'pending', 'unknown'].includes(refund.state),
      );
      return result<Row>(row ? [{ id: row.id } as Row] : []);
    }
    if (
      statement.startsWith(
        "select id from saas_service_plan_subscriptions where tenant_id = $1 and project_id = $2 and status = 'active' and id <> $3",
      )
    ) {
      return result<Row>(
        this.state.otherActiveSubscriptionId === null ? [] : [{ id: this.state.otherActiveSubscriptionId } as Row],
      );
    }
    if (
      statement.startsWith(
        "select id from saas_project_entitlements where tenant_id = $1 and project_id = $2 and supply_mode = 'byok'",
      )
    ) {
      return result<Row>(
        this.state.otherActiveEntitlementId === null ? [] : [{ id: this.state.otherActiveEntitlementId } as Row],
      );
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
            ['submitting', 'pending', 'unknown', 'blocked', 'succeeded'].includes(row.state) &&
            !(
              row.refund_type === 'byok_service_plan' &&
              row.state === 'blocked' &&
              row.blocked_code === 'SERVICE_PLAN_REFUND_ENTITLEMENT_SEAM_REQUIRED'
            ),
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
              tenant_id: TENANT_ID,
              currency: 'USD',
              source_type: 'wallet_funding',
              source_order_ref: 'funding-ref-1',
              amount_minor_units: '1000',
            }
          : null;
      return result<Row>(row ? [row as Row] : []);
    }
    if (statement.startsWith('select id, tenant_id, currency, posted_balance_minor_units')) {
      this.walletReads += 1;
      const row =
        a === TENANT_ID && b === 'USD'
          ? {
              id: WALLET_ID,
              tenant_id: TENANT_ID,
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
    if (statement.startsWith('insert into saas_refund_service_plan_effects')) {
      if (this.failServicePlanEffectInsert) throw new Error('simulated effect insert failure');
      const effect: Record<string, unknown> = {
        effect_ref: text(a),
        tenant_id: text(b),
        refund_order_id: text(c),
        project_id: text(d),
        source_service_plan_order_id: text(e),
        source_subscription_id: text(f),
        source_snapshot_id: text(g),
        source_entitlement_id: text(h),
        refund_policy_version: text(i),
        service_plan_policy_version: text(j),
        amount_minor_units: text(k),
        currency: text(l),
        cutoff_at: text(m),
        requested_by_user_id: text(n),
        reason_code: text(o),
        state: text(p),
        suspended_authz_version: q === null ? null : text(q),
        suspended_at: r === null ? null : text(r),
        suspension_released_at: null,
        released_authz_version: null,
        request_audit_event_id: text(s),
        outcome_audit_event_id: null,
        created_at: text(t),
        updated_at: text(u),
        completed_at: null,
      };
      this.state.servicePlanEffects.push(effect);
      return result<Row>();
    }
    if (statement.startsWith('insert into saas_audit_events')) {
      this.state.audit.push({
        id: a,
        tenant_id: b,
        actor_user_id: c,
        action: d,
        target_type: e,
        target_id: f,
        occurred_at: g,
      });
      return result<Row>();
    }
    if (statement.startsWith("update saas_project_entitlements set status = 'disabled'")) {
      const entitlement = this.state.servicePlanEntitlement;
      const expectedVersion = statement.includes('authz_version = $5') ? e : f;
      if (
        entitlement.tenant_id !== a ||
        entitlement.project_id !== b ||
        entitlement.id !== c ||
        entitlement.status !== 'active' ||
        String(entitlement.authz_version) !== String(expectedVersion)
      ) {
        return result<Row>();
      }
      entitlement.status = 'disabled';
      entitlement.disabled_at = text(d);
      entitlement.authz_version = String(Number(entitlement.authz_version) + 1);
      return result<Row>([{ authz_version: entitlement.authz_version } as Row]);
    }
    if (statement.startsWith("update saas_project_entitlements set status = 'active'")) {
      const entitlement = this.state.servicePlanEntitlement;
      if (
        entitlement.tenant_id !== a ||
        entitlement.project_id !== b ||
        entitlement.id !== c ||
        entitlement.status !== 'disabled' ||
        String(entitlement.disabled_at) !== String(e) ||
        String(entitlement.authz_version) !== String(f)
      ) {
        return result<Row>();
      }
      entitlement.status = 'active';
      entitlement.disabled_at = null;
      entitlement.authz_version = String(Number(entitlement.authz_version) + 1);
      return result<Row>([{ authz_version: entitlement.authz_version } as Row]);
    }
    if (statement.startsWith("update saas_service_plan_subscriptions set status = 'cancelled'")) {
      const subscription = this.state.servicePlanSubscription;
      if (
        subscription.tenant_id !== a ||
        subscription.project_id !== b ||
        subscription.id !== c ||
        subscription.status !== 'active'
      ) {
        return result<Row>();
      }
      subscription.status = 'cancelled';
      return result<Row>([{ id: subscription.id } as Row]);
    }
    if (statement.startsWith('update saas_refund_service_plan_effects')) {
      const effect = this.state.servicePlanEffects.find(
        (candidate) => candidate.tenant_id === a && candidate.refund_order_id === b && candidate.effect_ref === c,
      );
      if (!effect || !['provisionally_suspended', 'not_suspended'].includes(String(effect.state))) {
        return result<Row>();
      }
      effect.state = text(d);
      effect.suspension_released_at = e === null ? null : text(e);
      effect.released_authz_version = f === null ? null : text(f);
      effect.outcome_audit_event_id = text(g);
      effect.updated_at = text(h);
      effect.completed_at = text(h);
      return result<Row>([{ effect_ref: effect.effect_ref } as Row]);
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

class FakeRefundProvider implements PaymentProviderRefundAdapter {
  readonly providerKey = PROVIDER_KEY;
  readonly merchantId = MERCHANT_ID;
  submitCalls: PaymentProviderRefundInput[] = [];
  queryCalls: PaymentProviderRefundInput[] = [];
  submitResult: 'pending' | 'succeeded' | 'failed' = 'succeeded';
  queryResult: 'pending' | 'succeeded' | 'failed' | 'not_found' | 'unknown' = 'not_found';
  submitError: unknown = null;
  queryError: unknown = null;
  submitEchoMismatch = false;
  queryEchoMismatch = false;
  submitHook?: (input: PaymentProviderRefundInput) => Promise<void>;
  database?: FakeRefundDatabase;

  async submitRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundResult> {
    assert.equal(this.database?.inTransaction, false, 'PSP submit must run outside DB transaction');
    this.submitCalls.push(clone(input));
    await this.submitHook?.(input);
    if (this.submitError !== null) throw this.submitError;
    return {
      ...input,
      tenantId: this.submitEchoMismatch ? 'different-tenant' : input.tenantId,
      providerRefundId: 'psp-refund-456',
      status: this.submitResult,
    };
  }

  async queryRefund(input: PaymentProviderRefundInput): Promise<PaymentProviderRefundQueryResult> {
    assert.equal(this.database?.inTransaction, false, 'PSP query must run outside DB transaction');
    this.queryCalls.push(clone(input));
    if (this.queryError !== null) throw this.queryError;
    return {
      ...input,
      tenantId: this.queryEchoMismatch ? 'different-tenant' : input.tenantId,
      providerRefundId: input.providerRefundId ?? (this.queryResult === 'not_found' ? null : 'psp-refund-456'),
      status: this.queryResult,
    };
  }
}

function uuidFactory(): () => string {
  let counter = 100;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function createService(
  database: FakeRefundDatabase,
  provider = new FakeRefundProvider(),
  now = { value: Date.parse('2026-09-29T00:00:00.000Z') },
) {
  provider.database = database;
  const operations: PaymentRefundOperationsPort = {
    async authorize(input, executor) {
      assert.equal(database.inTransaction, true, 'refund authorization must share the creation transaction');
      assert.equal(typeof executor.query, 'function');
      if (database.rejectRefundAuthorization) throw new Error('operator approval denied');
      if (input.actorId !== ACTOR_ID || input.tenantId !== TENANT_ID) throw new Error('denied');
      return { authorizationRef: 'audit-auth-ref-1' };
    },
    async recordAudit(executor, event) {
      assert.equal(database.inTransaction, true, 'refund audit must share the state-change transaction');
      await executor.query('INSERT INTO fake_payment_refund_audit (event) VALUES ($1)', [event]);
    },
  };
  const walletRefundLedger = {
    postVerifiedWalletRefund: database.postFakeWalletRefund.bind(database),
  };
  return new PaymentRefundService(database, provider, {
    providerKey: PROVIDER_KEY,
    merchantId: MERCHANT_ID,
    operations,
    walletRefundLedger,
    now: () => new Date(now.value),
    idFactory: uuidFactory(),
    leaseTtlMs: 1_000,
    reconcileDelayMs: 1_000,
  });
}

function walletRefund(clientRequestId: string, amountMinorUnits: string, orderId = TOP_UP_ID) {
  return {
    actorId: ACTOR_ID,
    tenantId: TENANT_ID,
    orderId,
    clientRequestId,
    amountMinorUnits,
    reasonCode: 'CUSTOMER_REQUEST',
  };
}

test('wallet refund succeeds once with immutable PSP identity, balanced ledger handoff and freeze release', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);

  const refund = await service.requestWalletTopUpRefund(walletRefund('refund-request-1', '400'));

  assert.equal(refund.status, 'succeeded');
  assert.equal(refund.amountMinorUnits, '400');
  assert.equal(refund.walletRefundTransactionId, `wallet-refund-ledger-${refund.id}`);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(provider.submitCalls[0]?.providerOrderId, PROVIDER_ORDER_ID);
  assert.equal(provider.submitCalls[0]?.merchantId, MERCHANT_ID);
  assert.equal(provider.submitCalls[0]?.idempotencyReference, refund.id);
  assert.equal(database.state.walletBalance, 600n);
  assert.equal(database.state.ledgerPostings.length, 1);
  assert.equal(database.state.walletFreezes.length, 0);
  assert.deepEqual(
    database.state.ledgerPostings.map((entry) => entry.amountMinorUnits),
    ['400'],
  );
  assert.deepEqual(
    database.state.audit.map((entry) => entry.action),
    ['payment.refund.requested', 'payment.refund.succeeded'],
  );
});

test('platform full refund derives its amount from the locked order and replays without resubmitting', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);
  const request = {
    actorId: ACTOR_ID,
    sessionId: 'platform-session-1',
    actorRoles: ['finance'],
    tenantId: TENANT_ID,
    orderId: TOP_UP_ID,
    clientRequestId: 'platform-full-refund-1',
    reasonCode: 'OPERATOR_APPROVED',
  };

  const first = await service.requestPlatformWalletTopUpRefund(request);
  const replay = await service.requestPlatformWalletTopUpRefund(request);

  assert.equal(first.amountMinorUnits, '1000');
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.id, first.id);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(database.state.audit.filter((event) => event.action === 'payment.refund.requested').length, 1);
  assert.equal(database.state.walletFreezes.length, 0);
});

test('a definitive PSP rejection marks failed and releases the freeze without a wallet posting', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitError = Object.assign(new Error('provider detail is not persisted'), { acceptance: 'not_accepted' });
  const service = createService(database, provider);

  const refund = await service.requestWalletTopUpRefund(walletRefund('refund-request-rejected', '250'));

  assert.equal(refund.status, 'failed');
  assert.equal(refund.failureCode, 'PROVIDER_REFUND_NOT_ACCEPTED');
  assert.equal(database.state.walletFreezes.length, 0);
  assert.equal(database.state.ledgerPostings.length, 0);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(provider.queryCalls.length, 0);
});

test('ambiguous submit is queried first, stays frozen on not-found, then finalizes only after PSP confirmation', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitError = new Error('timeout after request write');
  provider.queryResult = 'not_found';
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);

  const unknown = await service.requestWalletTopUpRefund(walletRefund('refund-request-unknown', '300'));
  assert.equal(unknown.status, 'unknown');
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(provider.queryCalls.length, 1);
  assert.equal(database.state.walletFreezes.length, 1);
  assert.equal(database.state.ledgerPostings.length, 0);

  const replay = await service.requestWalletTopUpRefund(walletRefund('refund-request-unknown', '300'));
  assert.equal(replay.id, unknown.id);
  assert.equal(provider.submitCalls.length, 1, 'idempotent replay never resubmits');

  now.value += 1_001;
  provider.queryResult = 'succeeded';
  const batch = await service.processPendingRefunds(10);
  const completed = await service.getRefund(TENANT_ID, unknown.id);
  assert.equal(batch.queried, 1);
  assert.equal(batch.succeeded, 1);
  assert.equal(completed?.status, 'succeeded');
  assert.equal(database.state.walletFreezes.length, 0);
  assert.equal(database.state.walletBalance, 700n);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(provider.queryCalls.length, 2);
});

test('expired submitting claim is recovered by query only and remains frozen while pending', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.queryResult = 'pending';
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);
  const refund = await service.requestWalletTopUpRefund(walletRefund('refund-request-crash', '200'));
  assert.equal(refund.status, 'succeeded');

  // Seed the crash window: PSP call may have run, but only the submitting claim was committed.
  database.state.walletBalance = 1_000n;
  database.state.ledgerPostings = [];
  database.state.walletFreezes.push({
    refund_order_id: refund.id,
    tenant_id: TENANT_ID,
    wallet_id: WALLET_ID,
    currency: 'USD',
    amount_minor_units: '200',
  });
  Object.assign(database.state.refunds[0], {
    state: 'submitting',
    lease_action: 'submit',
    lease_token: 'expired-submit-token',
    lease_expires_at: '2026-09-28T23:59:59.000Z',
    provider_refund_id: null,
    wallet_refund_transaction_id: null,
    completed_at: null,
    next_reconcile_at: '2026-09-29T00:00:00.000Z',
  });
  provider.submitCalls = [];
  provider.queryCalls = [];

  const batch = await service.processPendingRefunds();
  const recovered = await service.getRefund(TENANT_ID, refund.id);
  assert.equal(batch.queried, 1);
  assert.equal(recovered?.status, 'pending');
  assert.equal(provider.submitCalls.length, 0);
  assert.equal(provider.queryCalls.length, 1);
  assert.equal(database.state.walletFreezes.length, 1);
});

test('partial refunds serialize on the original order and cannot exceed unrefunded capture', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'pending';
  const service = createService(database, provider);

  const [first, replay] = await Promise.all([
    service.requestWalletTopUpRefund(walletRefund('refund-request-race', '600')),
    service.requestWalletTopUpRefund(walletRefund('refund-request-race', '600')),
  ]);
  assert.equal(first.id, replay.id);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(database.state.walletFreezes.length, 1);

  await assert.rejects(
    service.requestWalletTopUpRefund(walletRefund('refund-request-overflow', '401')),
    (error: unknown) => (error as { code?: string }).code === 'REFUND_AMOUNT_EXCEEDS_AVAILABLE',
  );
  assert.equal(provider.submitCalls.length, 1);
});

test('concurrent distinct partial refunds serialize on the source order without locking immutable ledger history', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'pending';
  const service = createService(database, provider);

  const results = await Promise.allSettled([
    service.requestWalletTopUpRefund(walletRefund('refund-request-partial-a', '600')),
    service.requestWalletTopUpRefund(walletRefund('refund-request-partial-b', '600')),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'REFUND_AMOUNT_EXCEEDS_AVAILABLE');
  assert.equal(database.state.refunds.length, 1);
  assert.equal(database.state.walletFreezes.length, 1);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(BigInt(database.state.walletFreezes[0]?.amount_minor_units ?? '0'), 600n);

  const statements = database.sqlStatements();
  const sourceOrderLockIndexes = statements.flatMap((statement, index) =>
    statement.includes('from saas_payment_orders') && /\bfor update\b/.test(statement) ? [index] : [],
  );
  const eligibilityCheckIndexes = statements.flatMap((statement, index) =>
    statement.startsWith(
      'select coalesce(sum(amount_minor_units), 0)::text as amount_minor_units from saas_refund_orders',
    )
      ? [index]
      : [],
  );
  assert.equal(sourceOrderLockIndexes.length, 2);
  assert.equal(eligibilityCheckIndexes.length, 2);
  assert.ok(
    sourceOrderLockIndexes.every((lockIndex, index) => lockIndex < (eligibilityCheckIndexes[index] ?? -1)),
    'each refund eligibility sum must run after locking its mutable source payment order',
  );

  const ledgerReads = statements.filter((statement) => statement.includes('from saas_ledger_transactions'));
  assert.equal(ledgerReads.length, 1);
  assert.match(ledgerReads[0] ?? '', /^select\b/);
  assert.doesNotMatch(ledgerReads[0] ?? '', /\bfor\s+(?:share|update)\b/);
});

test('wallet refund admission subtracts request holds before freezing PSP refundable value', async () => {
  const database = new FakeRefundDatabase();
  database.state.requestHolds = 750n;
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);

  await assert.rejects(
    service.requestWalletTopUpRefund(walletRefund('refund-request-held', '300')),
    (error: unknown) => (error as { code?: string }).code === 'REFUND_AMOUNT_EXCEEDS_AVAILABLE',
  );
  assert.equal(provider.submitCalls.length, 0);
  assert.equal(database.state.refunds.length, 0);
  assert.equal(database.state.walletFreezes.length, 0);
});

test('provider and merchant snapshot mismatch fails closed before PSP I/O', async () => {
  const database = new FakeRefundDatabase();
  database.walletTopUp.merchant_id = 'different-merchant';
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);

  await assert.rejects(
    service.requestWalletTopUpRefund(walletRefund('refund-request-mismatch', '100')),
    (error: unknown) => (error as { code?: string }).code === 'ORDER_STATE_CONFLICT',
  );
  assert.equal(provider.submitCalls.length, 0);
  assert.equal(database.state.refunds.length, 0);
});

function servicePlanRefund(clientRequestId: string, amountMinorUnits: string) {
  return {
    actorId: ACTOR_ID,
    tenantId: TENANT_ID,
    orderId: PLAN_ORDER_ID,
    clientRequestId,
    amountMinorUnits,
    reasonCode: 'CUSTOMER_REQUEST',
  };
}

test('approved BYOK refund provisionally suspends only its source entitlement until PSP success', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'pending';
  const service = createService(database, provider);
  const beforeWalletReads = database.walletReads;

  const refund = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-pending', '500'));

  assert.equal(refund.status, 'pending');
  assert.equal(refund.refundType, 'byok_service_plan');
  assert.equal(refund.walletRefundTransactionId, null);
  const refundRow = database.state.refunds[0];
  assert.ok(refundRow?.service_plan_effect_ref);
  assert.equal(refundRow?.wallet_topup_order_id, null);
  assert.equal(refundRow?.original_funding_transaction_id, null);
  assert.equal(refundRow?.wallet_id, null);
  assert.equal(refundRow?.wallet_refund_transaction_id, null);
  assert.equal(refundRow?.provider_attempts, 1);
  assert.equal(database.state.servicePlanEffects[0]?.effect_ref, refundRow?.service_plan_effect_ref);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(provider.submitCalls[0]?.originalLocalOrderId, PLAN_ORDER_ID);
  assert.equal(provider.submitCalls[0]?.amountMinorUnits, '500');
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.equal(database.state.servicePlanEntitlement.authz_version, '2');
  assert.equal(database.state.servicePlanSubscription.status, 'active');
  assert.equal(database.state.servicePlanEffects[0]?.source_entitlement_id, 'entitlement-byok-1');
  assert.equal(database.state.servicePlanEffects[0]?.amount_minor_units, '500');
  assert.equal(database.state.servicePlanEffects[0]?.refund_policy_version, 'byok_cancel_only_v1');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'provisionally_suspended');
  assert.equal(database.walletReads, beforeWalletReads);
  assert.deepEqual(database.walletRelatedCalls(), []);
  assert.equal(database.state.walletFreezes.length, 0);
  assert.equal(database.state.ledgerPostings.length, 0);

  const createStatements = database.transactionSqlStatements()[0] ?? [];
  const createGlobalFenceIndexes = createStatements.flatMap((statement, index) =>
    statement.includes('select pg_advisory_xact_lock(1396788563, 46)') ? [index] : [],
  );
  const createIdempotencyLockIndex = createStatements.findIndex(
    (statement) =>
      statement.includes('from saas_refund_orders') &&
      statement.includes('idempotency_namespace =') &&
      statement.includes('for update'),
  );
  const createOrderLockIndex = createStatements.findIndex(
    (statement) => statement.includes('from saas_service_plan_orders') && statement.includes('for update of o'),
  );
  assert.equal(createGlobalFenceIndexes.length, 2, 'outer and effect-level global fences are both retained');
  assert.ok(
    createGlobalFenceIndexes[0] !== undefined &&
      createGlobalFenceIndexes[0] < createIdempotencyLockIndex &&
      createIdempotencyLockIndex < createOrderLockIndex,
    'BYOK create must order global fence -> refund idempotency row -> service-plan order row',
  );
});

test('an unapproved BYOK request has no refund row, provisional suspension, or PSP call', async () => {
  const database = new FakeRefundDatabase();
  database.rejectRefundAuthorization = true;
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);

  await assert.rejects(service.requestServicePlanRefund(servicePlanRefund('byok-refund-denied', '500')));
  assert.equal(database.state.refunds.length, 0);
  assert.equal(database.state.servicePlanEffects.length, 0);
  assert.equal(database.state.servicePlanEntitlement.status, 'active');
  assert.equal(provider.submitCalls.length, 0);
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('a second BYOK refund cannot overlap an unresolved effect for the same entitlement', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'pending';
  const service = createService(database, provider);

  const first = await service.requestServicePlanRefund(servicePlanRefund('byok-overlap-first', '300'));
  await assert.rejects(
    service.requestServicePlanRefund(servicePlanRefund('byok-overlap-second', '200')),
    (error: unknown) => (error as { code?: string }).code === 'REFUND_STATE_CONFLICT',
  );

  assert.equal(first.status, 'pending');
  assert.equal(database.state.refunds.length, 1);
  assert.equal(database.state.servicePlanEffects.length, 1);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('an active future-start entitlement stays suspended while pending and is released after verified failure', async () => {
  const database = new FakeRefundDatabase();
  database.state.servicePlanSubscription.effective_at = '2026-10-01T00:00:00.000Z';
  database.state.servicePlanEntitlement.effective_at = '2026-10-01T00:00:00.000Z';
  const provider = new FakeRefundProvider();
  provider.submitResult = 'pending';
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);

  const refund = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-future-start', '500'));
  assert.equal(refund.status, 'pending');
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'provisionally_suspended');

  now.value = Date.parse('2026-10-02T00:00:00.000Z');
  provider.queryResult = 'failed';
  const batch = await service.processPendingRefunds(10);

  assert.equal(batch.failed, 1);
  assert.equal(database.state.servicePlanEntitlement.status, 'active');
  assert.equal(database.state.servicePlanEntitlement.authz_version, '3');
  assert.ok(database.state.servicePlanEffects[0]?.suspension_released_at);
  assert.deepEqual(database.walletRelatedCalls(), []);
});

for (const [label, amount] of [
  ['partial', '500'],
  ['full', '1200'],
] as const) {
  test(`verified ${label} BYOK monetary refund cancels future access without pro-rata service days`, async () => {
    const database = new FakeRefundDatabase();
    const provider = new FakeRefundProvider();
    provider.submitResult = 'succeeded';
    const service = createService(database, provider);

    const refund = await service.requestServicePlanRefund(servicePlanRefund(`byok-refund-${label}`, amount));

    assert.equal(refund.status, 'succeeded');
    assert.equal(refund.amountMinorUnits, amount);
    assert.equal(refund.walletRefundTransactionId, null);
    assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
    assert.equal(database.state.servicePlanEntitlement.authz_version, '2');
    assert.equal(database.state.servicePlanSubscription.status, 'cancelled');
    assert.equal(database.state.servicePlanEffects[0]?.state, 'succeeded');
    assert.equal(database.state.servicePlanEffects[0]?.suspension_released_at, null);
    assert.deepEqual(database.walletRelatedCalls(), []);
    assert.equal(database.state.walletBalance, 1_000n);
    assert.equal(database.state.ledgerPostings.length, 0);
    assert.equal(database.state.walletFreezes.length, 0);

    const outcomeStatements = database.transactionSqlStatements().at(-1) ?? [];
    const outcomeGlobalFenceIndexes = outcomeStatements.flatMap((statement, index) =>
      statement.includes('select pg_advisory_xact_lock(1396788563, 46)') ? [index] : [],
    );
    const outcomeHintIndex = outcomeStatements.findIndex((statement) =>
      statement.startsWith('select refund_type from saas_refund_orders where id = $1'),
    );
    const outcomeRefundRowLockIndex = outcomeStatements.findIndex(
      (statement) => statement.includes('from saas_refund_orders') && statement.includes('where id = $1 for update'),
    );
    const outcomeOrderLockIndex = outcomeStatements.findIndex(
      (statement) => statement.includes('from saas_service_plan_orders') && statement.includes('for update of o'),
    );
    assert.equal(outcomeGlobalFenceIndexes.length, 2, 'outer and finalizer global fences are both retained');
    assert.ok(
      outcomeHintIndex >= 0 &&
        outcomeGlobalFenceIndexes[0] !== undefined &&
        outcomeGlobalFenceIndexes[1] !== undefined &&
        outcomeGlobalFenceIndexes[0] > outcomeHintIndex &&
        outcomeGlobalFenceIndexes[0] < outcomeRefundRowLockIndex &&
        outcomeRefundRowLockIndex < outcomeGlobalFenceIndexes[1] &&
        outcomeGlobalFenceIndexes[1] < outcomeOrderLockIndex,
      'BYOK outcome must order hint -> global fence -> refund row -> defensive global fence -> service-plan order row',
    );
  });
}

test('pending and unknown PSP results keep the provisional suspension and do not finalize access', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitError = new Error('provider outcome may have been accepted');
  provider.queryError = new Error('PSP status lookup is unavailable');
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);

  const unknown = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-unknown', '500'));
  assert.equal(unknown.status, 'unknown');
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'provisionally_suspended');

  now.value += 1_001;
  provider.queryError = null;
  provider.queryResult = 'pending';
  const batch = await service.processPendingRefunds(10);
  const pending = await service.getRefund(TENANT_ID, unknown.id);
  assert.equal(batch.unresolved, 1);
  assert.equal(pending?.status, 'pending');
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'provisionally_suspended');
  assert.equal(database.state.servicePlanEffects[0]?.outcome_audit_event_id, null);
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('unknown PSP outcome resolves only on a verified successful query; replays do not resubmit or reapply', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitError = new Error('timeout after request write');
  provider.queryResult = 'not_found';
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);

  const unknown = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-replay', '500'));
  const replay = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-replay', '500'));
  assert.equal(replay.id, unknown.id);
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(database.state.servicePlanEntitlement.authz_version, '2');

  now.value += 1_001;
  provider.queryResult = 'succeeded';
  const batch = await service.processPendingRefunds(10);
  assert.equal(batch.succeeded, 1);
  assert.equal((await service.getRefund(TENANT_ID, unknown.id))?.status, 'succeeded');
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.equal(database.state.servicePlanEntitlement.authz_version, '2');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'succeeded');
  assert.equal(provider.submitCalls.length, 1);
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('definitive PSP failure releases its current suspension with a fresh authz version, never reviving old keys', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'failed';
  const service = createService(database, provider);

  const refund = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-failed', '500'));

  assert.equal(refund.status, 'failed');
  assert.equal(database.state.servicePlanEntitlement.status, 'active');
  assert.equal(database.state.servicePlanEntitlement.disabled_at, null);
  assert.equal(database.state.servicePlanEntitlement.authz_version, '3');
  assert.equal(database.state.servicePlanSubscription.status, 'active');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'failed');
  assert.ok(database.state.servicePlanEffects[0]?.suspension_released_at);
  assert.equal(database.state.servicePlanEffects[0]?.released_authz_version, '3');
  assert.ok(
    Number(database.state.servicePlanEntitlement.authz_version) >
      Number(database.state.servicePlanEffects[0]?.suspended_authz_version),
    'pre-suspension authorization versions remain stale after a definitive failure',
  );
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('a failure after independent renewal never revives the superseded source entitlement', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'pending';
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);

  const refund = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-renewal', '500'));
  database.state.servicePlanSubscription.status = 'superseded';
  database.state.servicePlanEntitlement.status = 'superseded';
  database.state.servicePlanEntitlement.superseded_at = '2026-09-29T00:00:00.500Z';
  database.state.servicePlanEntitlement.disabled_at = null;
  database.state.otherActiveSubscriptionId = 'subscription-byok-renewal';
  database.state.otherActiveEntitlementId = 'entitlement-byok-renewal';
  now.value += 1_001;
  provider.queryResult = 'failed';

  const batch = await service.processPendingRefunds(10);

  assert.equal(batch.failed, 1);
  assert.equal((await service.getRefund(TENANT_ID, refund.id))?.status, 'failed');
  assert.equal(database.state.servicePlanEntitlement.status, 'superseded');
  assert.equal(database.state.servicePlanEntitlement.disabled_at, null);
  assert.equal(database.state.servicePlanEffects[0]?.state, 'failed');
  assert.equal(database.state.servicePlanEffects[0]?.suspension_released_at, null);
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('a stale or conflicting PSP echo remains unknown and cannot finalize or release access', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitEchoMismatch = true;
  provider.queryEchoMismatch = true;
  provider.queryResult = 'failed';
  const service = createService(database, provider);

  const refund = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-conflict', '500'));

  assert.equal(refund.status, 'unknown');
  assert.equal(database.state.servicePlanEntitlement.status, 'disabled');
  assert.equal(database.state.servicePlanEffects[0]?.state, 'provisionally_suspended');
  assert.equal(database.state.servicePlanEffects[0]?.outcome_audit_event_id, null);
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('verified failure from an expired-query lease wins over a conflicting stale submit-success callback', async () => {
  const database = new FakeRefundDatabase();
  const provider = new FakeRefundProvider();
  provider.submitResult = 'succeeded';
  provider.queryResult = 'failed';
  const now = { value: Date.parse('2026-09-29T00:00:00.000Z') };
  const service = createService(database, provider, now);
  provider.submitHook = async () => {
    // Model a long-running submit whose lease expires while another worker queries PSP state.
    now.value += 1_001;
    const batch = await service.processPendingRefunds(10);
    assert.equal(batch.failed, 1);
  };

  const refund = await service.requestServicePlanRefund(servicePlanRefund('byok-refund-conflicting-callback', '500'));

  assert.equal(refund.status, 'failed');
  assert.equal(provider.submitCalls.length, 1);
  assert.equal(provider.queryCalls.length, 1);
  assert.equal(database.state.servicePlanEffects[0]?.state, 'failed');
  assert.equal(database.state.servicePlanEntitlement.status, 'active');
  assert.equal(database.state.servicePlanEntitlement.authz_version, '3');
  assert.equal(database.state.servicePlanSubscription.status, 'active');
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('a historical blocked BYOK row is excluded from capacity and a fresh audited request is allowed', async () => {
  const database = new FakeRefundDatabase();
  database.state.refunds.push({
    id: 'legacy-blocked-refund',
    tenant_id: TENANT_ID,
    refund_type: 'byok_service_plan',
    wallet_topup_order_id: null,
    service_plan_order_id: PLAN_ORDER_ID,
    original_funding_transaction_id: null,
    wallet_id: null,
    provider_key: PROVIDER_KEY,
    merchant_id: MERCHANT_ID,
    provider_order_id: PROVIDER_ORDER_ID,
    original_local_order_ref: PLAN_ORDER_ID,
    idempotency_namespace: 'payment_refund_v1',
    client_request_id: 'old-blocked-request',
    requested_by_user_id: ACTOR_ID,
    authorization_ref: 'old-auth-ref',
    reason_code: 'CUSTOMER_REQUEST',
    amount_minor_units: '500',
    currency: 'USD',
    state: 'blocked',
    provider_refund_id: null,
    failure_code: null,
    blocked_code: 'SERVICE_PLAN_REFUND_ENTITLEMENT_SEAM_REQUIRED',
    wallet_refund_transaction_id: null,
    service_plan_effect_ref: null,
    provider_attempts: 0,
    lease_action: null,
    lease_token: null,
    lease_expires_at: null,
    next_reconcile_at: '2026-09-28T00:00:00.000Z',
    created_at: '2026-09-28T00:00:00.000Z',
    updated_at: '2026-09-28T00:00:00.000Z',
    completed_at: null,
  });
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);

  const fresh = await service.requestServicePlanRefund(servicePlanRefund('fresh-after-legacy-block', '1200'));

  assert.equal(fresh.status, 'succeeded');
  assert.notEqual(fresh.id, 'legacy-blocked-refund');
  assert.equal(database.state.refunds.length, 2);
  assert.equal(database.state.servicePlanEffects.length, 1);
  assert.equal(database.state.servicePlanEffects[0]?.amount_minor_units, '1200');
  assert.equal(database.state.servicePlanEffects[0]?.requested_by_user_id, ACTOR_ID);
  assert.equal(database.state.servicePlanEffects[0]?.reason_code, 'CUSTOMER_REQUEST');
  assert.equal(database.state.servicePlanEffects[0]?.service_plan_policy_version, 'policy-v1');
  assert.deepEqual(database.walletRelatedCalls(), []);
});

test('effect insertion failure rolls back refund, audit, and provisional suspension before PSP I/O', async () => {
  const database = new FakeRefundDatabase();
  database.failServicePlanEffectInsert = true;
  const provider = new FakeRefundProvider();
  const service = createService(database, provider);

  await assert.rejects(service.requestServicePlanRefund(servicePlanRefund('byok-refund-rollback', '500')));

  assert.equal(database.state.refunds.length, 0);
  assert.equal(database.state.servicePlanEffects.length, 0);
  assert.equal(database.state.servicePlanEntitlement.status, 'active');
  assert.equal(database.state.servicePlanEntitlement.authz_version, '1');
  assert.equal(database.state.audit.length, 0);
  assert.equal(provider.submitCalls.length, 0);
  assert.deepEqual(database.walletRelatedCalls(), []);
});
