import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import type { ServicePlanPaymentService } from '../../../src/saas/payments/types.js';
import { ServicePlanError } from '../../../src/saas/plans/errors.js';
import type {
  ByokSubscriptionRecord,
  FulfilledServicePlanResult,
  ServicePlanOrderRecord,
  ServicePlanOrderState,
  ServicePlanSnapshotRecord,
  VerifiedServicePlanFulfillmentInput,
} from '../../../src/saas/plans/types.js';
import {
  createFakeFundingLedger,
  FakePaymentDatabase,
  FakePaymentProvider,
  type FakeServicePlanOrder,
  successWebhook,
} from './fake-sql.js';

const NOW = '2026-09-28T00:00:00.000Z';
const TENANT_ID = 'tenant-byok';
const PROJECT_ID = 'project-byok';
const PLAN_VERSION_ID = 'plan-version-byok';
const PLAN_ORDER_ID = 'service-plan-order-1';
const SNAPSHOT_ID = 'service-plan-snapshot-1';
const PROVIDER_ORDER_ID = `provider-${PLAN_ORDER_ID}`;
const MERCHANT_ID = 'merchant-byok';

const context: TenantContext = {
  userId: 'user-byok',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  tenantRole: 'owner',
  projectRole: 'owner',
};

interface PlanCalls {
  readonly fulfillments: VerifiedServicePlanFulfillmentInput[];
}

function snapshot(): ServicePlanSnapshotRecord {
  return {
    id: SNAPSHOT_ID,
    tenantId: TENANT_ID,
    orderId: PLAN_ORDER_ID,
    planVersionId: PLAN_VERSION_ID,
    planId: 'plan-byok',
    planVersion: 1,
    allowedProviderIds: ['provider-a'],
    allowedModels: ['model-a'],
    supplyMode: 'byok',
    supplyProfileId: 'byok-profile',
    priceVersion: 'price-v1',
    priceMinorUnits: '1200',
    currency: 'USD',
    termDays: 30,
    policyVersion: 'policy-v1',
    snapshotDigest: 'a'.repeat(64),
    createdAt: NOW,
  };
}

function planOrder(row: FakeServicePlanOrder): ServicePlanOrderRecord {
  const planSnapshot = snapshot();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    planVersionId: row.plan_version_id,
    operation: row.operation,
    renewalOfSubscriptionId: row.renewal_of_subscription_id,
    clientRequestId: row.client_request_id,
    state: row.state as ServicePlanOrderState,
    subscriptionId: row.subscription_id,
    snapshot: planSnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
  };
}

function subscription(row: FakeServicePlanOrder): ByokSubscriptionRecord {
  return {
    id: row.subscription_id ?? 'subscription-1',
    tenantId: row.tenant_id,
    projectId: row.project_id,
    orderId: row.id,
    snapshotId: SNAPSHOT_ID,
    entitlementId: 'entitlement-byok-1',
    previousSubscriptionId: row.renewal_of_subscription_id,
    operation: row.operation,
    status: 'active',
    effectiveAt: NOW,
    expiresAt: '2026-10-28T00:00:00.000Z',
    activatedAt: NOW,
    supersededAt: null,
    expiredAt: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    snapshot: snapshot(),
  };
}

function createPlanService(database: FakePaymentDatabase, calls: PlanCalls): ServicePlanPaymentService {
  return {
    async createOrder(_context, input) {
      const existing = database.state.servicePlanOrders.find(
        (row) => row.tenant_id === TENANT_ID && row.client_request_id === input.clientRequestId,
      );
      if (existing) return planOrder(existing);
      const row: FakeServicePlanOrder = {
        id: PLAN_ORDER_ID,
        tenant_id: TENANT_ID,
        project_id: PROJECT_ID,
        plan_version_id: input.planVersionId,
        operation: input.operation ?? 'activation',
        renewal_of_subscription_id: input.renewalOfSubscriptionId ?? null,
        client_request_id: input.clientRequestId,
        state: 'pending',
        subscription_id: null,
        provider_key: null,
        merchant_id: null,
        provider_order_id: null,
        provider_attempts: 0,
        provider_failure_code: null,
        verified_settlement_id: null,
        verified_provider_key: null,
        verified_merchant_id: null,
        verified_amount_minor_units: null,
        verified_currency: null,
        fulfillment_reference: null,
        created_at: NOW,
        updated_at: NOW,
        paid_at: null,
        fulfilled_at: null,
        snapshot_price_minor_units: '1200',
        snapshot_currency: 'USD',
      };
      database.state.servicePlanOrders.push(row);
      return planOrder(row);
    },

    async getOrder(_context, orderId) {
      const row = database.state.servicePlanOrders.find(
        (candidate) =>
          candidate.tenant_id === TENANT_ID && candidate.project_id === PROJECT_ID && candidate.id === orderId,
      );
      return row ? planOrder(row) : null;
    },

    async fulfillVerified(input): Promise<FulfilledServicePlanResult> {
      calls.fulfillments.push(input);
      const row = database.state.servicePlanOrders.find((candidate) => candidate.id === input.orderId);
      if (!row) throw new ServicePlanError('ORDER_NOT_FOUND');
      if (row.state === 'fulfilled') {
        if (row.verified_settlement_id !== input.settlementId) throw new ServicePlanError('FULFILLMENT_CONFLICT');
        return {
          order: planOrder(row),
          subscription: subscription(row),
          entitlementId: 'entitlement-byok-1',
          replayed: true,
        };
      }
      if (row.state !== 'pending') throw new ServicePlanError('ORDER_STATE_CONFLICT');
      row.state = 'fulfilled';
      row.subscription_id = 'subscription-1';
      row.verified_settlement_id = input.settlementId;
      row.verified_provider_key = input.providerKey;
      row.verified_merchant_id = input.merchantId;
      row.verified_amount_minor_units = String(input.amountMinorUnits);
      row.verified_currency = input.currency;
      row.fulfillment_reference = input.fulfillmentReference;
      row.paid_at = NOW;
      row.fulfilled_at = NOW;
      row.updated_at = NOW;
      return {
        order: planOrder(row),
        subscription: subscription(row),
        entitlementId: 'entitlement-byok-1',
        replayed: false,
      };
    },
  };
}

function createFixture() {
  const database = new FakePaymentDatabase();
  const provider = new FakePaymentProvider();
  const ledger = createFakeFundingLedger(database);
  const calls: PlanCalls = { fulfillments: [] };
  const clock = { value: new Date(NOW) };
  const planService = createPlanService(database, calls);
  const service = new PaymentFulfillmentService(database, provider, {
    providerKey: provider.providerKey,
    merchantId: MERCHANT_ID,
    now: () => new Date(clock.value.getTime()),
    idFactory: (() => {
      let next = 0;
      return () => `payment-${++next}`;
    })(),
    walletFundingLedger: ledger,
    servicePlanService: planService,
  });
  return { database, provider, ledger, calls, clock, planService, service };
}

async function createPayment(fixture: ReturnType<typeof createFixture>) {
  return fixture.service.createServicePlanPayment(context, {
    planVersionId: PLAN_VERSION_ID,
    clientRequestId: 'client-byok-1',
  });
}

test('verified BYOK success fulfills the fixed-term plan through the plan service and never touches the wallet', async () => {
  const fixture = createFixture();
  const order = await createPayment(fixture);
  assert.equal(order.providerKey, 'fake-psp');
  assert.equal(order.merchantId, MERCHANT_ID);
  assert.equal(order.providerOrderId, PROVIDER_ORDER_ID);
  assert.equal(order.snapshot.priceMinorUnits, '1200');
  assert.equal(order.snapshot.termDays, 30);

  const result = await fixture.service.handleWebhook(
    {},
    successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-1', '1200'),
  );

  assert.equal(result.outcome, 'accepted');
  assert.equal((await fixture.service.processPendingWebhooks()).processed, 1);
  assert.equal(fixture.database.state.inbox[0]?.local_order_id, null);
  assert.equal(fixture.calls.fulfillments.length, 1);
  assert.equal(fixture.calls.fulfillments[0]?.kind, 'server_verified_service_plan_fulfillment');
  assert.equal(fixture.database.state.servicePlanOrders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.servicePlanOrders[0]?.verified_settlement_id, 'settlement-byok-1');
  assert.equal(fixture.database.state.funding.length, 0);
  assert.equal(fixture.database.state.fundingCalls, 0);
});

test('replaying the verified BYOK webhook is idempotent and does not create another entitlement or wallet posting', async () => {
  const fixture = createFixture();
  await createPayment(fixture);
  const webhook = successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-replay', '1200');

  const first = await fixture.service.handleWebhook({}, webhook);
  const replay = await fixture.service.handleWebhook({}, webhook);

  assert.equal(first.outcome, 'accepted');
  assert.equal(replay.outcome, 'accepted');
  assert.equal(replay.replayed, true);
  await fixture.service.processPendingWebhooks();
  const completedReplay = await fixture.service.handleWebhook({}, webhook);
  assert.equal(completedReplay.outcome, 'fulfilled');
  assert.equal(completedReplay.replayed, true);
  assert.equal(fixture.calls.fulfillments.length, 1);
  assert.equal(fixture.database.state.funding.length, 0);
  assert.equal(fixture.database.state.inbox.length, 1);
});

test('recovers inbox completion idempotently if BYOK fulfillment committed before a worker crash', async () => {
  const fixture = createFixture();
  await createPayment(fixture);
  const webhook = successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-crash', '1200');
  await fixture.service.handleWebhook({}, webhook);

  const fulfill = fixture.planService.fulfillVerified.bind(fixture.planService);
  let failAfterCommit = true;
  fixture.planService.fulfillVerified = async (input) => {
    const result = await fulfill(input);
    if (failAfterCommit) {
      failAfterCommit = false;
      throw new Error('simulated worker interruption after domain commit');
    }
    return result;
  };

  assert.equal((await fixture.service.processPendingWebhooks()).retrying, 1);
  assert.equal(fixture.database.state.servicePlanOrders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.inbox[0]?.processing_state, 'pending');
  fixture.clock.value = new Date(fixture.clock.value.getTime() + 1_000);

  assert.equal((await fixture.service.processPendingWebhooks()).processed, 1);
  assert.equal(fixture.database.state.inbox[0]?.processing_outcome, 'fulfilled');
  assert.equal(fixture.database.state.servicePlanOrders[0]?.verified_settlement_id, 'settlement-byok-crash');
  assert.equal(fixture.calls.fulfillments.length, 1);
});

test('late BYOK success after fulfillment is reconciliation-only', async () => {
  const fixture = createFixture();
  await createPayment(fixture);
  await fixture.service.handleWebhook(
    {},
    successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-first', '1200'),
  );
  await fixture.service.processPendingWebhooks();

  const late = await fixture.service.handleWebhook(
    {},
    successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-late', '1200'),
  );

  assert.equal(late.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[1]?.processing_outcome, 'reconciliation');
  assert.equal(fixture.calls.fulfillments.length, 1);
  assert.equal(fixture.database.state.servicePlanOrders[0]?.state, 'fulfilled');
  assert.equal(fixture.database.state.funding.length, 0);
});

test('tenant and amount mismatches reconcile a BYOK payment without entitlement or wallet credit', async () => {
  const wrongTenant = createFixture();
  await createPayment(wrongTenant);
  const tenantMismatch = await wrongTenant.service.handleWebhook(
    {},
    successWebhook(PROVIDER_ORDER_ID, 'other-tenant', 'settlement-byok-wrong-tenant', '1200'),
  );
  assert.equal(tenantMismatch.outcome, 'accepted');
  await wrongTenant.service.processPendingWebhooks();
  assert.equal(wrongTenant.database.state.inbox[0]?.processing_outcome, 'reconciliation');
  assert.equal(wrongTenant.calls.fulfillments.length, 0);
  assert.equal(wrongTenant.database.state.servicePlanOrders[0]?.state, 'reconciliation_pending');
  assert.equal(wrongTenant.database.state.funding.length, 0);

  const wrongAmount = createFixture();
  await createPayment(wrongAmount);
  const amountMismatch = await wrongAmount.service.handleWebhook(
    {},
    successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-wrong-amount', '1201'),
  );
  assert.equal(amountMismatch.outcome, 'accepted');
  await wrongAmount.service.processPendingWebhooks();
  assert.equal(wrongAmount.database.state.inbox[0]?.processing_outcome, 'reconciliation');
  assert.equal(wrongAmount.calls.fulfillments.length, 0);
  assert.equal(wrongAmount.database.state.servicePlanOrders[0]?.state, 'reconciliation_pending');
  assert.equal(wrongAmount.database.state.funding.length, 0);
});

test('cancelled BYOK payment is reconciliation-only and cannot activate a plan', async () => {
  const fixture = createFixture();
  await createPayment(fixture);
  const cancelled = await fixture.service.handleWebhook(
    {},
    successWebhook(PROVIDER_ORDER_ID, TENANT_ID, 'settlement-byok-cancelled', '1200', 'USD', 'cancelled'),
  );

  assert.equal(cancelled.outcome, 'accepted');
  await fixture.service.processPendingWebhooks();
  assert.equal(fixture.database.state.inbox[0]?.processing_outcome, 'reconciliation');
  assert.equal(fixture.calls.fulfillments.length, 0);
  assert.equal(fixture.database.state.servicePlanOrders[0]?.state, 'reconciliation_pending');
  assert.equal(fixture.database.state.funding.length, 0);
  assert.equal(fixture.database.state.fundingCalls, 0);
});

test('BYOK public payment orders expose checkout without creating a second provider order', async () => {
  const fixture = createFixture();
  fixture.provider.checkoutAction = {
    kind: 'qr',
    text: 'weixin://wxpay/byok-token',
    expiresAt: '2026-09-28T00:05:00.000Z',
  };
  const order = await createPayment(fixture);
  assert.equal(order.checkout.status, 'ready');
  assert.equal(order.checkout.action?.kind, 'qr');

  fixture.provider.refreshedCheckoutAction = {
    kind: 'qr',
    text: 'weixin://wxpay/byok-refreshed-token',
    expiresAt: '2026-09-28T00:10:00.000Z',
  };
  const refreshed = await fixture.service.refreshServicePlanPaymentCheckout(context, {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    orderId: PLAN_ORDER_ID,
  });
  assert.equal(refreshed.checkout.status, 'ready');
  assert.equal(refreshed.checkout.action?.kind, 'qr');
  assert.equal(fixture.provider.refreshCalls.length, 0);
  assert.equal(fixture.provider.calls.length, 1);
});
