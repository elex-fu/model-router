import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  type CustomerRefundSummary,
  SaasApiError,
  type SafeTenant,
  saasClient,
} from '../../web/src/api/saas-client.ts';
import { CustomerRefundsPage, customerRefundHistoryKey } from '../../web/src/features/saas-console.tsx';

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

const walletRefund: CustomerRefundSummary = {
  id: 'refund-wallet-1',
  refundType: 'wallet_topup',
  originalOrderId: 'topup-order-1',
  amountMinorUnits: '900719925474099312345',
  currency: 'CNY',
  status: 'pending',
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
  completedAt: null,
};

const servicePlanRefund: CustomerRefundSummary = {
  ...walletRefund,
  id: 'refund-plan-1',
  refundType: 'byok_service_plan',
  originalOrderId: 'plan-order-1',
  amountMinorUnits: '12500',
  status: 'unknown',
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
        { initialEntries: ['/console/refunds'] },
        React.createElement(CustomerRefundsPage, { onLogout: async () => {} }),
      ),
    ),
  );
}

test('customer refund client uses the tenant route and allowlists exact minor-unit history fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(
      JSON.stringify({
        data: {
          items: [
            {
              ...walletRefund,
              tenantId: 'tenant-id-not-allowlisted',
              providerRefundId: 'psp-refund-id-must-not-escape',
              failureCode: 'private-failure-code-must-not-escape',
              blockedCode: 'private-blocked-code-must-not-escape',
              walletRefundTransactionId: 'wallet-transaction-id-must-not-escape',
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

  const page = await saasClient.getCustomerRefunds('tenant/one', {
    cursor: 'cursor/current',
    limit: 25,
    signal: controller.signal,
  });

  assert.deepEqual(page, { items: [walletRefund], nextCursor: 'cursor/next' });
  assert.deepEqual(JSON.parse(JSON.stringify(page)), {
    items: [walletRefund],
    nextCursor: 'cursor/next',
  });
  assert.equal(calls[0]?.url, '/console/api/v1/tenants/tenant%2Fone/refunds?cursor=cursor%2Fcurrent&limit=25');
  assert.equal(calls[0]?.init.method ?? 'GET', 'GET');
  assert.equal(calls[0]?.init.credentials, 'same-origin');
  assert.equal(calls[0]?.init.signal, controller.signal);
  assert.doesNotMatch(
    JSON.stringify(page),
    /tenant-id-not-allowlisted|psp-refund-id|private-failure-code|private-blocked-code|wallet-transaction-id|internal-detail/,
  );
});

test('customer refund client rejects malformed lifecycle data and redacts server errors', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: { items: [{ ...walletRefund, status: 'refunded' }], nextCursor: null } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    saasClient.getCustomerRefunds(TENANT_ID),
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
  await assert.rejects(saasClient.getCustomerRefunds(TENANT_ID), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.doesNotMatch(
      `${error.message} ${error.code} ${JSON.stringify(error.details)}`,
      /database-password|private-sql/,
    );
    return true;
  });
});

test('refund navigation is available only for owner, admin, and billing tenant roles', () => {
  for (const role of ['owner', 'admin', 'billing'] as const) {
    const queryClient = newQueryClient();
    seedTenant(queryClient, role);
    queryClient.setQueryData(customerRefundHistoryKey(TENANT_ID), { items: [], nextCursor: null });
    const markup = renderPage(queryClient);
    assert.match(markup, /aria-current="page" href="\/console\/refunds"/);
    assert.match(markup, /退款记录/);
  }

  for (const role of ['developer', 'viewer'] as const) {
    const queryClient = newQueryClient();
    seedTenant(queryClient, role);
    const markup = renderPage(queryClient);
    assert.doesNotMatch(markup, /href="\/console\/refunds"/);
    assert.match(markup, /仅对租户所有者、管理员和账单管理员开放/);
  }
});

test('refund history renders allowlisted types, exact money, non-final status clarity, and accessible pagination', async () => {
  const queryClient = newQueryClient();
  seedTenant(queryClient, 'billing');
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          items: [
            {
              ...walletRefund,
              providerRefundId: 'psp-wallet-reference-must-not-render',
              failureCode: 'wallet-failure-code-must-not-render',
              walletRefundTransactionId: 'wallet-ledger-id-must-not-render',
            },
            {
              ...servicePlanRefund,
              providerRefundId: 'psp-plan-reference-must-not-render',
              blockedCode: 'plan-blocked-code-must-not-render',
            },
          ],
          nextCursor: 'cursor/next',
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const safeHistory = await saasClient.getCustomerRefunds(TENANT_ID);
  queryClient.setQueryData(customerRefundHistoryKey(TENANT_ID), safeHistory);

  const markup = renderPage(queryClient);

  assert.match(markup, /钱包充值退款/);
  assert.match(markup, /BYOK 服务计划退款/);
  assert.match(markup, /CNY 900,719,925,474,099,312,345/);
  assert.match(markup, /最小货币单位/);
  assert.match(markup, /退款处理中 · 尚未完成/);
  assert.match(markup, /当前状态不是最终结果/);
  assert.match(markup, /状态未知 · 尚未确认/);
  assert.match(markup, /尚未确认最终结果/);
  assert.match(markup, /原订单 ID/);
  assert.match(markup, /创建时间/);
  assert.match(markup, /最近更新时间/);
  assert.match(markup, /完成时间/);
  assert.match(markup, /尚未完成/);
  assert.match(markup, /aria-label="退款记录列表"/);
  assert.match(markup, /aria-label="退款记录分页"/);
  assert.match(markup, /下一页/);
  assert.match(markup, /aria-current="page"/);
  assert.doesNotMatch(markup, /<button[^>]*>[^<]*(?:创建|发起|审批|批准|重试|PSP)/);
  assert.doesNotMatch(
    markup,
    /psp-wallet-reference|wallet-failure-code|wallet-ledger-id|psp-plan-reference|plan-blocked-code|providerRefundId|walletRefundTransactionId|failureCode|blockedCode|内部错误|internalError/,
  );
});

test('refund history has loading, empty, safe error, and expired-session states', () => {
  const loadingClient = newQueryClient();
  seedTenant(loadingClient);
  const loadingQuery = loadingClient.getQueryCache().build(loadingClient, {
    queryKey: customerRefundHistoryKey(TENANT_ID),
    queryFn: async () => ({ items: [], nextCursor: null }),
  });
  loadingQuery.setState({ status: 'pending', fetchStatus: 'fetching' });
  assert.match(renderPage(loadingClient), /role="status"[^>]*aria-label="正在加载退款记录"/);

  const emptyClient = newQueryClient();
  seedTenant(emptyClient);
  emptyClient.setQueryData(customerRefundHistoryKey(TENANT_ID), { items: [], nextCursor: null });
  const emptyMarkup = renderPage(emptyClient);
  assert.match(emptyMarkup, /暂无退款记录/);
  assert.match(emptyMarkup, /aria-label="客户控制台导航"/);

  const renderError = (error: SaasApiError) => {
    const queryClient = newQueryClient();
    seedTenant(queryClient);
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: customerRefundHistoryKey(TENANT_ID),
      queryFn: async () => ({ items: [], nextCursor: null }),
    });
    query.setState({ status: 'error', error, errorUpdatedAt: Date.now() });
    return renderPage(queryClient);
  };

  const failed = renderError(new SaasApiError(500, 'HTTP_ERROR', 'database-secret-must-not-render'));
  assert.match(failed, /退款记录读取失败/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(failed, /database-secret-must-not-render/);

  const expired = renderError(new SaasApiError(401, 'UNAUTHENTICATED', 'expired-session-secret-must-not-render'));
  assert.match(expired, /登录状态已过期/);
  assert.match(expired, /返回登录/);
  assert.doesNotMatch(expired, /expired-session-secret-must-not-render/);
});
