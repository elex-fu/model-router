import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as React from 'react';
import {
  parseServicePlanOrder,
  SaasApiError,
  type ServicePlanOrder,
  saasClient,
  servicePlanOrderFromError,
} from '../../web/src/api/saas-client.ts';

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

function checkout(status: 'ready' | 'pending' | 'unavailable' | 'expired' | 'closed' = 'ready') {
  return status === 'ready'
    ? {
        status,
        action: {
          kind: 'redirect' as const,
          url: 'https://pay.example.test/order-1',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }
    : { status, action: null };
}

function order(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    tenantId: 'tenant-one',
    projectId: 'default-project',
    planVersionId: 'plan-version-1',
    operation: 'activation',
    renewalOfSubscriptionId: null,
    clientRequestId: 'byok-intent-1',
    state: 'pending',
    subscriptionId: null,
    snapshot: {
      id: 'snapshot-1',
      tenantId: 'tenant-one',
      orderId: 'order-1',
      planVersionId: 'plan-version-1',
      planId: 'byok-standard',
      planVersion: 1,
      allowedProviderIds: ['provider-a'],
      allowedModels: ['model-a'],
      supplyMode: 'byok',
      supplyProfileId: 'internal-profile-must-not-leak',
      priceVersion: 'price-v1',
      priceMinorUnits: '1200',
      currency: 'USD',
      termDays: 30,
      policyVersion: 'policy-v1',
      snapshotDigest: 'a'.repeat(64),
      createdAt: '2026-09-29T00:00:00.000Z',
    },
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    paidAt: null,
    fulfilledAt: null,
    orderType: 'byok_service_plan',
    providerKey: 'fake-psp',
    merchantId: 'merchant-1',
    providerOrderId: null,
    providerAttempts: 1,
    providerFailureCode: null,
    checkout: checkout(),
    ...overrides,
  };
}

test('service-plan order DTO validation accepts checkout union and drops internal snapshot fields', () => {
  const parsed = parseServicePlanOrder(order());
  assert.equal(parsed.checkout.status, 'ready');
  assert.equal(parsed.snapshot?.supplyMode, 'byok');
  assert.equal('supplyProfileId' in (parsed.snapshot ?? {}), false);
});

test('service-plan order DTO validation rejects an invalid checkout action', () => {
  assert.throws(
    () => parseServicePlanOrder(order({ checkout: { status: 'ready', action: { kind: 'card', text: 'nope' } } })),
    (error: unknown) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('service-plan create sends CSRF and one stable idempotency key without client project fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=csrf-token' },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: order() }), { status: 201 });
  };

  const created = await saasClient.createServicePlanOrder(
    'tenant-one',
    { planVersionId: 'plan-version-1', operation: 'activation' },
    'stable-purchase-intent-1',
  );

  assert.equal(created.id, 'order-1');
  assert.equal(calls[0]?.url, '/console/api/v1/tenants/tenant-one/service-plan-orders');
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get('x-csrf-token'), 'csrf-token');
  assert.equal(headers.get('idempotency-key'), 'stable-purchase-intent-1');
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    planVersionId: 'plan-version-1',
    operation: 'activation',
  });
});

test('service-plan get, retry, and checkout methods use tenant-scoped order routes', async () => {
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'mr_saas_csrf=csrf-token' } });
  const responseOrder = order({
    tenantId: 'tenant/one',
    snapshot: { ...(order().snapshot as Record<string, unknown>), tenantId: 'tenant/one' },
  });
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: responseOrder }), { status: 200 });
  };

  await saasClient.getServicePlanOrder('tenant/one', 'order/one');
  await saasClient.retryServicePlanOrder('tenant/one', 'order/one');
  const checkoutView = await saasClient.getServicePlanOrderCheckout('tenant/one', 'order/one');

  assert.equal(checkoutView.status, 'ready');
  assert.deepEqual(calls, [
    '/console/api/v1/tenants/tenant%2Fone/service-plan-orders/order%2Fone',
    '/console/api/v1/tenants/tenant%2Fone/service-plan-orders/order%2Fone/retry',
    '/console/api/v1/tenants/tenant%2Fone/service-plan-orders/order%2Fone',
  ]);
});

test('safe provider 503 keeps the sanitized order DTO available to the caller', async () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'mr_saas_csrf=csrf-token' } });
  const preserved = order({ providerFailureCode: 'PROVIDER_CREATE_FAILED', checkout: checkout('unavailable') });
  globalThis.fetch = async () => new Response(JSON.stringify({ data: preserved }), { status: 503 });

  await assert.rejects(
    saasClient.createServicePlanOrder(
      'tenant-one',
      { planVersionId: 'plan-version-1', operation: 'activation' },
      'stable-intent',
    ),
    (error: unknown) => {
      assert.ok(error instanceof SaasApiError);
      assert.equal(error.status, 503);
      const recovered = servicePlanOrderFromError(error, 'tenant-one');
      assert.equal(recovered?.id, 'order-1');
      assert.equal(recovered?.providerFailureCode, 'PROVIDER_CREATE_FAILED');
      return true;
    },
  );
});

test('checkout states distinguish unavailable, expired, and ready without implying payment success', async () => {
  const { checkoutDisplayStatus, servicePlanOrderPresentation } = await import(
    '../../web/src/features/service-plan-purchase.tsx'
  );
  assert.equal(checkoutDisplayStatus(checkout('unavailable')), 'unavailable');
  assert.equal(
    checkoutDisplayStatus(
      { status: 'ready', action: { kind: 'qr', text: 'qr-payload', expiresAt: '2020-01-01T00:00:00.000Z' } },
      Date.parse('2026-09-29T00:00:00.000Z'),
    ),
    'expired',
  );
  assert.equal(checkoutDisplayStatus(checkout('ready'), Date.parse('2020-01-01T00:00:00.000Z')), 'ready');
  assert.equal(servicePlanOrderPresentation(parseServicePlanOrder(order())).kind, 'pending');
  assert.equal(
    servicePlanOrderPresentation(parseServicePlanOrder(order({ state: 'reconciliation_pending' }))).kind,
    'reconciliation',
  );
  assert.equal(servicePlanOrderPresentation(parseServicePlanOrder(order({ state: 'fulfilled' }))).kind, 'fulfilled');
  assert.equal(
    servicePlanOrderPresentation(parseServicePlanOrder(order({ providerFailureCode: 'PROVIDER_CREATE_FAILED' }))).kind,
    'failure',
  );
});

test('redirect checkout is an explicit safe new-tab click and QR payload stays local text', async () => {
  reactGlobal.React = React;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { PaymentCheckoutActionView } = await import('../../web/src/features/service-plan-purchase.tsx');
  const redirect = renderToStaticMarkup(React.createElement(PaymentCheckoutActionView, { checkout: checkout() }));
  assert.match(redirect, /target="_blank"/);
  assert.match(redirect, /rel="noopener noreferrer"/);
  assert.match(redirect, /打开支付页面/);

  const qr = renderToStaticMarkup(
    React.createElement(PaymentCheckoutActionView, {
      checkout: {
        status: 'ready',
        action: { kind: 'qr', text: 'local-qr-payload', expiresAt: '2099-01-01T00:00:00.000Z' },
      },
    }),
  );
  assert.match(qr, /local-qr-payload/);
  assert.doesNotMatch(qr, /<img|dangerouslySetInnerHTML/);
});

test('bounded order polling stops when hidden, terminal, exhausted, or provider-failed and cleans up its timer', async () => {
  const { SERVICE_PLAN_POLL_LIMIT, scheduleServicePlanPoll, shouldPollServicePlanOrder } = await import(
    '../../web/src/features/service-plan-purchase.tsx'
  );
  const validOrder = parseServicePlanOrder(order()) as ServicePlanOrder;
  assert.equal(shouldPollServicePlanOrder(validOrder, true, 0), true);
  assert.equal(shouldPollServicePlanOrder(validOrder, false, 0), false);
  assert.equal(shouldPollServicePlanOrder({ ...validOrder, state: 'fulfilled' }, true, 0), false);
  assert.equal(
    shouldPollServicePlanOrder({ ...validOrder, providerFailureCode: 'PROVIDER_CREATE_FAILED' }, true, 0),
    false,
  );
  assert.equal(shouldPollServicePlanOrder(validOrder, true, SERVICE_PLAN_POLL_LIMIT), false);

  let callback: (() => void) | undefined;
  let cleared: number | undefined;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(next: () => void, _delay: number) {
        callback = next;
        return 42;
      },
      clearTimeout(timer: number) {
        cleared = timer;
      },
    },
  });
  const cancel = scheduleServicePlanPoll(() => {}, 1);
  cancel();
  assert.equal(typeof callback, 'function');
  assert.equal(cleared, 42);
});
