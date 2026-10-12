import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  type CustomerPaymentOrderSummary,
  SaasApiError,
  type SafeTenant,
  saasClient,
} from '../../web/src/api/saas-client.ts';
import { CustomerPaymentOrdersPage, customerPaymentOrderHistoryKey } from '../../web/src/features/saas-console.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

const originalFetch = globalThis.fetch;
const queryClients = new Set<QueryClient>();
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantQueryKey = ['saas-console', 'tenants'] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
});

const fulfilledOrder: CustomerPaymentOrderSummary = {
  id: 'topup-order-1',
  orderType: 'wallet_topup',
  amountMinorUnits: '900719925474099312345',
  currency: 'CNY',
  status: 'fulfilled',
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  paidAt: '2026-09-28T10:01:00.000Z',
  fulfilledAt: '2026-09-28T10:02:00.000Z',
};

const pendingOrder: CustomerPaymentOrderSummary = {
  ...fulfilledOrder,
  id: 'topup-order-2',
  amountMinorUnits: '12500',
  status: 'reconciliation_pending',
  paidAt: null,
  fulfilledAt: null,
};

function newQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, refetchOnMount: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClients.add(queryClient);
  return queryClient;
}

function makeTenant(role: SafeTenant['role']): SafeTenant {
  return {
    id: TENANT_ID,
    name: '示例租户',
    slug: 'example-tenant',
    status: 'active',
    role,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };
}

function seedTenant(queryClient: QueryClient, role: SafeTenant['role'] = 'owner') {
  queryClient.setQueryData(tenantQueryKey, [makeTenant(role)]);
}

function renderPage(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/console/billing'] },
        React.createElement(CustomerPaymentOrdersPage, { onLogout: async () => {} }),
      ),
    ),
  );
}

test('customer payment order client uses the tenant route and allowlists exact minor-unit history fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        data: {
          items: [
            {
              ...fulfilledOrder,
              tenantId: 'tenant-id-not-allowlisted',
              providerKey: 'psp-key-must-not-escape',
              merchantId: 'merchant-id-must-not-escape',
              providerOrderId: 'psp-order-id-must-not-escape',
              checkoutUrl: 'https://psp.example.test/pay/must-not-escape',
              providerSubmissionLeaseToken: 'lease-token-must-not-escape',
            },
          ],
          nextCursor: 'cursor/next',
          internalError: 'private-internal-detail-must-not-escape',
        },
        meta: { requestId: 'request-id' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const page = await saasClient.getCustomerPaymentOrders('tenant/one', {
    cursor: 'cursor/current',
    limit: 25,
    signal: controller.signal,
  });

  assert.deepEqual(page, { items: [fulfilledOrder], nextCursor: 'cursor/next' });
  assert.deepEqual(JSON.parse(JSON.stringify(page)), {
    items: [fulfilledOrder],
    nextCursor: 'cursor/next',
  });
  assert.equal(calls[0]?.url, '/console/api/v1/tenants/tenant%2Fone/payment-orders?cursor=cursor%2Fcurrent&limit=25');
  assert.equal(calls[0]?.init.method ?? 'GET', 'GET');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  assert.equal(calls[0]?.init.signal, controller.signal);
  assert.doesNotMatch(
    JSON.stringify(page),
    /tenant-id-not-allowlisted|psp-key|merchant-id|psp-order-id|must-not-escape|internal-detail/,
  );
});

test('customer payment order client rejects malformed lifecycle data and redacts server errors', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { items: [{ ...fulfilledOrder, status: 'refunded' }], nextCursor: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    saasClient.getCustomerPaymentOrders(TENANT_ID),
    (error: unknown) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE',
  );

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'database-password-must-not-escape',
          details: { query: 'private-sql-must-not-escape' },
        },
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  await assert.rejects(saasClient.getCustomerPaymentOrders(TENANT_ID), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.doesNotMatch(
      `${error.message} ${error.code} ${JSON.stringify(error.details)}`,
      /database-password|private-sql/,
    );
    return true;
  });
});

test('billing navigation is available only for owner, admin, and billing tenant roles', () => {
  for (const role of ['owner', 'admin', 'billing'] as const) {
    const queryClient = newQueryClient();
    seedTenant(queryClient, role);
    queryClient.setQueryData(customerPaymentOrderHistoryKey(TENANT_ID), { items: [], nextCursor: null });
    const markup = renderPage(queryClient);
    assert.match(markup, /aria-current="page" href="\/console\/billing"/);
    assert.match(markup, /充值订单/);
  }

  for (const role of ['developer', 'viewer'] as const) {
    const queryClient = newQueryClient();
    seedTenant(queryClient, role);
    const markup = renderPage(queryClient);
    assert.doesNotMatch(markup, /href="\/console\/billing"/);
    assert.match(markup, /仅对租户所有者、管理员和账单管理员开放/);
  }
});

test('billing history renders exact money, non-final status clarity, and accessible pagination', async () => {
  const queryClient = newQueryClient();
  seedTenant(queryClient, 'billing');
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          items: [
            {
              ...fulfilledOrder,
              providerOrderId: 'psp-order-reference-must-not-render',
              checkoutUrl: 'https://psp.example.test/pay/must-not-render',
            },
            {
              ...pendingOrder,
              providerSubmissionLeaseToken: 'lease-token-must-not-render',
              merchantId: 'merchant-id-must-not-render',
            },
          ],
          nextCursor: 'cursor/next',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const safeHistory = await saasClient.getCustomerPaymentOrders(TENANT_ID);
  queryClient.setQueryData(customerPaymentOrderHistoryKey(TENANT_ID), safeHistory);

  const markup = renderPage(queryClient);

  assert.match(markup, /钱包充值/);
  assert.match(markup, /CNY 900,719,925,474,099,312,345/);
  assert.match(markup, /最小货币单位/);
  assert.match(markup, /已入账/);
  assert.match(markup, /对账确认中 · 尚未最终确认/);
  assert.match(markup, /请勿重复支付/);
  assert.match(markup, /创建时间/);
  assert.match(markup, /最近更新时间/);
  assert.match(markup, /支付时间/);
  assert.match(markup, /入账时间/);
  assert.match(markup, /尚未支付/);
  assert.match(markup, /尚未入账/);
  assert.match(markup, /aria-label="充值订单列表"/);
  assert.match(markup, /aria-label="账单分页"/);
  assert.match(markup, /下一页/);
  assert.match(markup, /aria-current="page"/);
  assert.doesNotMatch(markup, /<button[^>]*>[^<]*(?:创建|发起|取消|重试|PSP)/);
  assert.doesNotMatch(
    markup,
    /psp-order-reference|must-not-render|merchant-id|providerOrderId|checkoutUrl|providerSubmissionLeaseToken|内部错误|internalError/,
  );
});

test('billing history has loading, empty, safe error, and expired-session states', () => {
  const loadingClient = newQueryClient();
  seedTenant(loadingClient);
  const loadingQuery = loadingClient.getQueryCache().build(loadingClient, {
    queryKey: customerPaymentOrderHistoryKey(TENANT_ID),
    queryFn: async () => ({ items: [], nextCursor: null }),
  });
  loadingQuery.setState({ status: 'pending', fetchStatus: 'fetching' });
  assert.match(renderPage(loadingClient), /role="status"[^>]*aria-label="正在加载账单"/);

  const emptyClient = newQueryClient();
  seedTenant(emptyClient);
  emptyClient.setQueryData(customerPaymentOrderHistoryKey(TENANT_ID), { items: [], nextCursor: null });
  const emptyMarkup = renderPage(emptyClient);
  assert.match(emptyMarkup, /暂无充值订单/);
  assert.match(emptyMarkup, /aria-label="客户控制台导航"/);

  const renderError = (error: SaasApiError) => {
    const queryClient = newQueryClient();
    seedTenant(queryClient);
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: customerPaymentOrderHistoryKey(TENANT_ID),
      queryFn: async () => ({ items: [], nextCursor: null }),
    });
    query.setState({ status: 'error', error, errorUpdatedAt: Date.now() });
    return renderPage(queryClient);
  };

  const failed = renderError(new SaasApiError(500, 'HTTP_ERROR', 'database-secret-must-not-render'));
  assert.match(failed, /账单读取失败/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(failed, /database-secret-must-not-render/);

  const expired = renderError(new SaasApiError(401, 'UNAUTHENTICATED', 'expired-session-secret-must-not-render'));
  assert.match(expired, /登录状态已过期/);
  assert.match(expired, /返回登录/);
  assert.doesNotMatch(expired, /expired-session-secret-must-not-render/);
});
