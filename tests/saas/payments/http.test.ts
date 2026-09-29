import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { afterEach, test } from 'node:test';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import {
  createSaasCustomerRefundHistoryHandler,
  createSaasPaymentHandler,
  type SaasPaymentHttpOptions,
} from '../../../src/saas/payments/http.js';
import type { PaymentOrderRecord, PaymentWebhookResult } from '../../../src/saas/payments/types.js';

const SESSION = 'session-for-payments';
const CSRF = 'csrf-for-payments';
const USER_ID = 'user-1';

let server: Server | undefined;

afterEach(async () => {
  if (!server?.listening) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

function order(tenantId = 'tenant-a'): PaymentOrderRecord {
  return {
    id: 'order-1',
    tenantId,
    orderType: 'wallet_topup',
    providerKey: 'fake-psp',
    merchantId: 'merchant-1',
    clientRequestId: 'client-1',
    localOrderRef: 'order-1',
    fundingReference: 'order-1',
    amountMinorUnits: '125',
    currency: 'USD',
    status: 'pending',
    providerOrderId: 'provider-1',
    providerAttempts: 1,
    providerFailureCode: null,
    fundingTransactionId: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    paidAt: null,
    fulfilledAt: null,
    checkout: {
      status: 'expired',
      action: null,
    },
  };
}

async function createTestServer(
  role: 'owner' | 'admin' | 'billing' | 'viewer' = 'owner',
  mismatchedTenantContext = false,
  topUpPolicyEnabled = true,
  refundQueryServiceEnabled = true,
) {
  const calls: {
    create?: unknown;
    read?: unknown;
    checkout?: unknown;
    webhook?: Buffer;
    refunds?: unknown;
  } = {};
  let durableOrder = order();
  const paymentService = {
    providerKey: 'fake-psp',
    createWalletTopUp: async (input: unknown) => {
      calls.create = input;
      return durableOrder;
    },
    getWalletTopUp: async (input: unknown) => {
      calls.read = input;
      return durableOrder;
    },
    retryProviderOrder: async () => order(),
    refreshWalletTopUpCheckout: async (input: unknown) => {
      calls.checkout = input;
      return {
        ...order(),
        checkout: {
          status: 'ready' as const,
          action: {
            kind: 'qr' as const,
            text: 'weixin://wxpay/test-token',
            expiresAt: '2026-09-28T00:05:00.000Z',
          },
        },
      };
    },
    handleWebhook: async (_headers: unknown, body: Buffer): Promise<PaymentWebhookResult> => {
      calls.webhook = body;
      return {
        outcome: 'accepted',
        replayed: false,
        inboxId: 'inbox-1',
        orderId: null,
        fundingTransactionId: null,
      };
    },
  };
  const identity = {
    getSession: async (token: string) =>
      token === SESSION
        ? {
            userId: USER_ID,
            activeTenantId: null,
            expiresAt: '2099-01-01T00:00:00.000Z',
            createdAt: '2026-09-28T00:00:00.000Z',
          }
        : undefined,
    verifyCsrfToken: async (token: string, csrf: string) => token === SESSION && csrf === CSRF,
    resolveTenantContext: async ({
      userId,
      tenantId,
    }: {
      userId: string;
      tenantId: string;
    }): Promise<TenantContext> => ({
      userId: mismatchedTenantContext ? 'another-user' : userId,
      tenantId: mismatchedTenantContext ? 'tenant-a' : tenantId,
      projectId: 'project-1',
      tenantRole: role,
      projectRole: role,
    }),
    resolveTenantBillingContext: async ({
      userId,
      tenantId,
    }: {
      userId: string;
      tenantId: string;
    }): Promise<Pick<TenantContext, 'userId' | 'tenantId' | 'tenantRole'>> => ({
      userId: mismatchedTenantContext ? 'another-user' : userId,
      tenantId: mismatchedTenantContext ? 'tenant-a' : tenantId,
      tenantRole: role,
    }),
  };
  const options: SaasPaymentHttpOptions = {
    service: identity,
    paymentService,
    ...(topUpPolicyEnabled
      ? {
          walletTopUpPolicy: {
            currency: 'USD',
            minAmountMinorUnits: '100',
            maxAmountMinorUnits: '100000',
          },
        }
      : {}),
    publicOrigin: 'http://payments.test',
  };
  let handler: ReturnType<typeof createSaasPaymentHandler>;
  let refundHistoryHandler: ReturnType<typeof createSaasCustomerRefundHistoryHandler>;
  server = http.createServer((req, res) => {
    void (async () => {
      if (await refundHistoryHandler(req, res)) return;
      if (await handler(req, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  handler = createSaasPaymentHandler({ ...options, publicOrigin: origin });
  refundHistoryHandler = createSaasCustomerRefundHistoryHandler({
    service: identity,
    ...(refundQueryServiceEnabled
      ? {
          refundQueryService: {
            listRefunds: async (context, query) => {
              calls.refunds = { userId: context.userId, tenantId: context.tenantId, query };
              return {
                items: [
                  {
                    id: '00000000-0000-4000-8000-000000000001',
                    refundType: 'wallet_topup',
                    originalOrderId: '10000000-0000-4000-8000-000000000001',
                    amountMinorUnits: '12500',
                    currency: 'USD',
                    status: 'succeeded',
                    createdAt: '2026-09-28T12:00:00.000000Z',
                    updatedAt: '2026-09-28T12:00:01.000000Z',
                    completedAt: '2026-09-28T12:00:02.000000Z',
                  },
                ],
                nextCursor: 'r1.opaque-cursor-value',
              };
            },
          },
        }
      : {}),
    publicOrigin: origin,
  });
  return {
    origin,
    calls,
    setDurableOrder: (value: PaymentOrderRecord) => {
      durableOrder = value;
    },
  };
}

function sessionHeaders(origin: string): HeadersInit {
  return {
    cookie: `mr_saas_session=${SESSION}; mr_saas_csrf=${CSRF}`,
    origin,
    'x-csrf-token': CSRF,
  };
}

test('authorizes owner/admin top-ups and enforces the configured currency, range, and idempotency input', async () => {
  const app = await createTestServer();
  const policy = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/wallet-topups/policy`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(policy.status, 200);
  assert.deepEqual(((await policy.json()) as { data: unknown }).data, {
    available: true,
    currency: 'USD',
    minAmountMinorUnits: '100',
    maxAmountMinorUnits: '100000',
  });

  const missingCsrf = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      cookie: `mr_saas_session=${SESSION}; mr_saas_csrf=${CSRF}`,
      origin: app.origin,
      'content-type': 'application/json',
      'idempotency-key': 'missing-csrf-header',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
  });
  assert.equal(missingCsrf.status, 403);

  const response = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(app.origin),
      'content-type': 'application/json',
      'idempotency-key': 'client-1',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(app.calls.create, {
    tenantId: 'tenant-a',
    clientRequestId: 'client-1',
    amountMinorUnits: '125',
    currency: 'USD',
  });

  const invalidNumber = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(app.origin),
      'content-type': 'application/json',
      'idempotency-key': 'client-2',
    },
    body: JSON.stringify({ amountMinorUnits: 125, currency: 'USD' }),
  });
  assert.equal(invalidNumber.status, 400);

  const belowMinimum = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(app.origin),
      'content-type': 'application/json',
      'idempotency-key': 'client-3',
    },
    body: JSON.stringify({ amountMinorUnits: '99', currency: 'USD' }),
  });
  assert.equal(belowMinimum.status, 400);

  const wrongCurrency = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(app.origin),
      'content-type': 'application/json',
      'idempotency-key': 'client-4',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'EUR' }),
  });
  assert.equal(wrongCurrency.status, 400);

  const aboveMaximum = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(app.origin),
      'content-type': 'application/json',
      'idempotency-key': 'client-6',
    },
    body: JSON.stringify({ amountMinorUnits: '100001', currency: 'USD' }),
  });
  assert.equal(aboveMaximum.status, 400);

  const clientPricing = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(app.origin),
      'content-type': 'application/json',
      'idempotency-key': 'client-5',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD', providerKey: 'client', merchantId: 'client' }),
  });
  assert.equal(clientPricing.status, 400);
  assert.equal((app.calls.create as { tenantId: string }).tenantId, 'tenant-a');
});

test('reads only through the authorized tenant context and keeps webhooks public', async () => {
  const billing = await createTestServer('billing');
  const read = await fetch(`${billing.origin}/console/api/v1/tenants/tenant-a/orders/order-1`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(read.status, 200);
  assert.deepEqual(billing.calls.read, { tenantId: 'tenant-a', orderId: 'order-1' });
  const readBody = (await read.json()) as { data: Record<string, unknown> };
  assert.equal(readBody.data.status, 'expired');
  assert.equal(readBody.data.orderType, 'wallet_topup');
  assert.equal(Object.hasOwn(readBody.data, 'providerOrderId'), false);
  assert.equal(Object.hasOwn(readBody.data, 'merchantId'), false);

  const policy = await fetch(`${billing.origin}/console/api/v1/tenants/tenant-a/wallet-topups/policy`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(policy.status, 403);

  const webhook = await fetch(`${billing.origin}/payments/webhooks/fake-psp`, {
    method: 'POST',
    body: 'provider-body',
  });
  assert.equal(webhook.status, 202);
  assert.equal(billing.calls.webhook?.toString(), 'provider-body');

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  const viewer = await createTestServer('viewer');
  const forbidden = await fetch(`${viewer.origin}/console/api/v1/tenants/tenant-a/orders/order-1`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(forbidden.status, 403);
});

test('rejects billing writes, mismatched resolved tenant contexts, and missing top-up policy', async () => {
  const billing = await createTestServer('billing');
  const denied = await fetch(`${billing.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(billing.origin),
      'content-type': 'application/json',
      'idempotency-key': 'billing-create',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
  });
  assert.equal(denied.status, 403);
  assert.equal(billing.calls.create, undefined);

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  const mismatched = await createTestServer('owner', true);
  const crossTenant = await fetch(`${mismatched.origin}/console/api/v1/tenants/tenant-b/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(mismatched.origin),
      'content-type': 'application/json',
      'idempotency-key': 'cross-tenant',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
  });
  assert.equal(crossTenant.status, 403);
  assert.equal(mismatched.calls.create, undefined);

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  const noPolicy = await createTestServer('owner', false, false);
  const policyResponse = await fetch(`${noPolicy.origin}/console/api/v1/tenants/tenant-a/wallet-topups/policy`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(policyResponse.status, 200);
  assert.deepEqual(((await policyResponse.json()) as { data: unknown }).data, {
    available: false,
    currency: null,
    minAmountMinorUnits: null,
    maxAmountMinorUnits: null,
  });
  const rejected = await fetch(`${noPolicy.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(noPolicy.origin),
      'content-type': 'application/json',
      'idempotency-key': 'no-policy',
    },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
  });
  assert.equal(rejected.status, 503);
  assert.equal(noPolicy.calls.create, undefined);
});

test('only reports paid after durable wallet fulfillment; intermediate paid and unknown states stay distinct', async () => {
  const app = await createTestServer('owner');
  const readOrder = async () => {
    const response = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders/order-1`, {
      headers: { cookie: `mr_saas_session=${SESSION}` },
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { data: { status: string } }).data.status;
  };

  app.setDurableOrder({ ...order(), status: 'paid', paidAt: '2026-09-28T00:01:00.000Z' });
  assert.equal(await readOrder(), 'pending');
  app.setDurableOrder({ ...order(), status: 'reconciliation_pending', checkout: { status: 'pending', action: null } });
  assert.equal(await readOrder(), 'unknown');
  app.setDurableOrder({
    ...order(),
    status: 'fulfilled',
    fulfilledAt: '2026-09-28T00:02:00.000Z',
  });
  assert.equal(await readOrder(), 'unknown');
  app.setDurableOrder({
    ...order(),
    status: 'fulfilled',
    fundingTransactionId: 'ledger-transaction-1',
    paidAt: '2026-09-28T00:01:00.000Z',
    fulfilledAt: '2026-09-28T00:02:00.000Z',
  });
  assert.equal(await readOrder(), 'paid');
});

test('rejects missing console authentication, missing idempotency, and unknown webhook providers', async () => {
  const app = await createTestServer();
  const unauthenticated = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders/order-1`);
  assert.equal(unauthenticated.status, 401);

  const missingIdempotency = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders`, {
    method: 'POST',
    headers: { ...sessionHeaders(app.origin), 'content-type': 'application/json' },
    body: JSON.stringify({ amountMinorUnits: '125', currency: 'USD' }),
  });
  assert.equal(missingIdempotency.status, 400);

  const unknownProvider = await fetch(`${app.origin}/payments/webhooks/not-configured`, {
    method: 'POST',
    body: 'provider-body',
  });
  assert.equal(unknownProvider.status, 404);
});

test('refresh checkout is billing-role, same-origin, CSRF protected, and returns no-store JSON', async () => {
  const app = await createTestServer();
  const response = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders/order-1/checkout`, {
    method: 'POST',
    headers: sessionHeaders(app.origin),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(app.calls.checkout, { tenantId: 'tenant-a', orderId: 'order-1' });
  const body = (await response.json()) as { data: PaymentOrderRecord };
  assert.equal(body.data.checkout.status, 'ready');

  const missingCsrf = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/orders/order-1/checkout`, {
    method: 'POST',
    headers: { cookie: `mr_saas_session=${SESSION}`, origin: app.origin },
  });
  assert.equal(missingCsrf.status, 403);

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  const viewer = await createTestServer('viewer');
  const forbidden = await fetch(`${viewer.origin}/console/api/v1/tenants/tenant-a/orders/order-1/checkout`, {
    method: 'POST',
    headers: sessionHeaders(viewer.origin),
  });
  assert.equal(forbidden.status, 403);
});

test('refund history returns the locked envelope and safe summary for an authorized billing session', async () => {
  const app = await createTestServer('billing');
  const response = await fetch(
    `${app.origin}/console/api/v1/tenants/tenant-a/refunds?limit=2&cursor=r1.opaque-cursor-value`,
    { headers: { cookie: `mr_saas_session=${SESSION}` } },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as {
    data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    meta: { requestId: string };
  };
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.deepEqual(body.data, {
    items: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        refundType: 'wallet_topup',
        originalOrderId: '10000000-0000-4000-8000-000000000001',
        amountMinorUnits: '12500',
        currency: 'USD',
        status: 'succeeded',
        createdAt: '2026-09-28T12:00:00.000000Z',
        updatedAt: '2026-09-28T12:00:01.000000Z',
        completedAt: '2026-09-28T12:00:02.000000Z',
      },
    ],
    nextCursor: 'r1.opaque-cursor-value',
  });
  assert.equal(typeof body.meta.requestId, 'string');
  assert.deepEqual(app.calls.refunds, {
    userId: USER_ID,
    tenantId: 'tenant-a',
    query: { limit: 2, cursor: 'r1.opaque-cursor-value' },
  });
  for (const key of ['create', 'read', 'checkout', 'webhook'] as const) {
    assert.equal(app.calls[key], undefined, `${key} must not call payment or PSP operations`);
  }
});

test('refund history requires a session and rejects roles outside owner/admin/billing', async () => {
  const unauthenticatedApp = await createTestServer();
  const unauthenticated = await fetch(`${unauthenticatedApp.origin}/console/api/v1/tenants/tenant-a/refunds`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticatedApp.calls.refunds, undefined);

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  const viewerApp = await createTestServer('viewer');
  const viewer = await fetch(`${viewerApp.origin}/console/api/v1/tenants/tenant-a/refunds`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(viewer.status, 403);
  assert.equal(viewerApp.calls.refunds, undefined);
});

test('refund history treats the path tenant as a selector and fails closed on a mismatched server context', async () => {
  const app = await createTestServer('owner', true);
  const response = await fetch(`${app.origin}/console/api/v1/tenants/tenant-b/refunds`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(response.status, 403);
  assert.equal(app.calls.refunds, undefined);
});

test('refund history validates query parameters and returns unavailable when its read service is absent', async () => {
  const app = await createTestServer();
  for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?cursor=', '?unexpected=x']) {
    const response = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/refunds${query}`, {
      headers: { cookie: `mr_saas_session=${SESSION}` },
    });
    assert.equal(response.status, 400, query);
  }
  assert.equal(app.calls.refunds, undefined);

  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  const unavailableApp = await createTestServer('owner', false, true, false);
  const unavailable = await fetch(`${unavailableApp.origin}/console/api/v1/tenants/tenant-a/refunds`, {
    headers: { cookie: `mr_saas_session=${SESSION}` },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableApp.calls.refunds, undefined);
});

test('refund history rejects request bodies and non-GET methods without payment or PSP calls', async () => {
  const app = await createTestServer();
  const request = new URL(`${app.origin}/console/api/v1/tenants/tenant-a/refunds`);
  const bodyResponse = await new Promise<number>((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: request.hostname,
        port: request.port,
        path: `${request.pathname}${request.search}`,
        method: 'GET',
        headers: {
          cookie: `mr_saas_session=${SESSION}`,
          'content-length': '3',
        },
      },
      (incoming) => {
        incoming.resume();
        incoming.on('end', () => resolve(incoming.statusCode ?? 0));
      },
    );
    outgoing.on('error', reject);
    outgoing.end('bad');
  });
  assert.equal(bodyResponse, 400);
  assert.equal(app.calls.refunds, undefined);

  const mutation = await fetch(`${app.origin}/console/api/v1/tenants/tenant-a/refunds`, {
    method: 'POST',
    headers: sessionHeaders(app.origin),
  });
  assert.equal(mutation.status, 405);
  for (const key of ['create', 'read', 'checkout', 'webhook'] as const) {
    assert.equal(app.calls[key], undefined, `${key} must not call payment or PSP operations`);
  }
});
