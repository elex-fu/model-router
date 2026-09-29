import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import * as React from 'react';
import type { SafeTenant } from '../../web/src/api/saas-client.ts';
import {
  isSaasWalletUnavailable,
  SaasWalletApiError,
  type SaasWalletData,
  saasWalletClient,
} from '../../web/src/api/saas-wallet-client.ts';
import { formatMinorUnits } from '../../web/src/features/saas-wallet.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

const originalFetch = globalThis.fetch;
const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocumentDescriptor) {
    Object.defineProperty(globalThis, 'document', originalDocumentDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

const tenant: SafeTenant = {
  id: 'tenant/one',
  name: 'Tenant One',
  slug: 'tenant-one',
  status: 'active',
  role: 'owner',
  createdAt: '2026-09-28T00:00:00.000Z',
  updatedAt: '2026-09-28T00:00:00.000Z',
};

const walletData: SaasWalletData = {
  wallet: {
    currency: 'USD',
    postedBalanceMinorUnits: '900719925474099312345',
    activeHoldsMinorUnits: '345',
    frozenAmountMinorUnits: '800',
    availableMinorUnits: '900719925474099311200',
    spendingFrozen: true,
  },
  ledger: {
    items: [
      {
        id: 'ledger-entry-1',
        transactionId: 'transaction-1',
        currency: 'USD',
        direction: 'debit',
        amountMinorUnits: '1200',
        type: 'usage_charge',
        createdAt: '2026-09-28T12:00:00.000Z',
      },
    ],
    nextCursor: 'cursor/2',
    hasMore: true,
  },
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { requestId: 'request-1' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('wallet client calls the session-scoped route with currency, limit, and cursor', async () => {
  let requestedUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestInit = init;
    return jsonResponse(walletData);
  };

  const result = await saasWalletClient.getWallet(tenant, {
    currency: 'USD',
    cursor: 'cursor/1',
    limit: 25,
  });

  assert.equal(requestedUrl, '/console/api/v1/tenants/tenant%2Fone/wallet?currency=USD&limit=25&cursor=cursor%2F1');
  assert.equal(requestInit?.credentials, 'same-origin');
  assert.equal(requestInit?.method, 'GET');
  assert.equal(requestInit?.cache, 'no-store');
  assert.equal(result.wallet.frozenAmountMinorUnits, '800');
  assert.equal(result.ledger.items[0]?.transactionId, 'transaction-1');
  assert.equal(result.ledger.items[0]?.direction, 'debit');
  assert.equal(result.ledger.nextCursor, 'cursor/2');
  assert.equal(result.ledger.hasMore, true);
  assert.equal(formatMinorUnits(result.wallet.postedBalanceMinorUnits), '900,719,925,474,099,312,345');
});

test('wallet client requires an authorized SafeTenant and validates the wallet response', async () => {
  globalThis.fetch = async () => jsonResponse(walletData);
  const billingTenant = { ...tenant, role: 'billing' } as SafeTenant;
  assert.throws(
    () => saasWalletClient.getWallet(billingTenant, { currency: 'USD' }),
    (error: unknown) => error instanceof SaasWalletApiError && error.code === 'INVALID_TENANT_CONTEXT',
  );

  globalThis.fetch = async () => jsonResponse({ ...walletData, wallet: { ...walletData.wallet, currency: 'EUR' } });
  await assert.rejects(saasWalletClient.getWallet(tenant, { currency: 'USD' }), /币种与请求不匹配/);

  globalThis.fetch = async () =>
    jsonResponse({
      ...walletData,
      wallet: { ...walletData.wallet, availableMinorUnits: '900719925474099312345' },
    });
  await assert.rejects(saasWalletClient.getWallet(tenant, { currency: 'USD' }), /余额、hold、冻结资金和可用余额不一致/);
});

test('wallet unavailability preserves the service error and never implies payment configuration', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'CUSTOMER_WALLET_UNAVAILABLE', message: 'unavailable' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(saasWalletClient.getWallet(tenant, { currency: 'USD' }), (error: unknown) => {
    assert.ok(error instanceof SaasWalletApiError);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'CUSTOMER_WALLET_UNAVAILABLE');
    assert.equal(isSaasWalletUnavailable(error), true);
    return true;
  });
  assert.equal(isSaasWalletUnavailable(new SaasWalletApiError(503, 'PAYMENT_NOT_CONFIGURED', 'not configured')), false);
  assert.equal(isSaasWalletUnavailable(new Error('ordinary error')), false);
});

test('wallet top-up client uses the server policy, same-origin CSRF, idempotency, and durable order response', async () => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=csrf-token' },
  });
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const order = {
    id: 'order-1',
    orderType: 'wallet_topup',
    amountMinorUnits: '125',
    currency: 'USD',
    status: 'pending',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    paidAt: null,
    fulfilledAt: null,
    checkout: {
      status: 'ready',
      action: { kind: 'redirect', url: 'https://pay.example/checkout/one', expiresAt: '2026-09-28T01:00:00.000Z' },
    },
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/wallet-topups/policy')) {
      return jsonResponse({
        available: true,
        currency: 'USD',
        minAmountMinorUnits: '100',
        maxAmountMinorUnits: '100000',
      });
    }
    return jsonResponse(order);
  };

  const policy = await saasWalletClient.getWalletTopUpPolicy(tenant);
  assert.deepEqual(policy, {
    available: true,
    currency: 'USD',
    minAmountMinorUnits: '100',
    maxAmountMinorUnits: '100000',
  });
  const created = await saasWalletClient.createWalletTopUp(tenant, {
    amountMinorUnits: '125',
    currency: 'USD',
    idempotencyKey: 'request-stable-1',
  });
  assert.equal(created.id, 'order-1');
  assert.equal(created.status, 'pending');
  assert.deepEqual(created.checkout, order.checkout);
  const createRequest = requests[1];
  assert.equal(createRequest?.url, '/console/api/v1/tenants/tenant%2Fone/orders');
  assert.equal(createRequest?.init?.method, 'POST');
  assert.equal(createRequest?.init?.credentials, 'same-origin');
  assert.equal(new Headers(createRequest?.init?.headers).get('x-csrf-token'), 'csrf-token');
  assert.equal(new Headers(createRequest?.init?.headers).get('Idempotency-Key'), 'request-stable-1');
  assert.deepEqual(JSON.parse(String(createRequest?.init?.body)), { amountMinorUnits: '125', currency: 'USD' });

  await saasWalletClient.getWalletTopUp(tenant, 'order-1');
  assert.equal(requests[2]?.url, '/console/api/v1/tenants/tenant%2Fone/orders/order-1');
  await saasWalletClient.refreshWalletTopUpCheckout(tenant, 'order-1');
  assert.equal(requests[3]?.init?.method, 'POST');
});

test('wallet top-up client fails closed when the payment API is not mounted', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not configured' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  assert.deepEqual(await saasWalletClient.getWalletTopUpPolicy(tenant), {
    available: false,
    currency: null,
    minAmountMinorUnits: null,
    maxAmountMinorUnits: null,
  });
});

test('wallet page renders exact balances, holds, frozen funds, ledger IDs, and navigation', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MemoryRouter } = await import('react-router-dom');
  const { SaasWalletPage } = await import('../../web/src/features/saas-wallet.tsx');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  const authorizedTenant = { ...tenant, id: 'tenant-one' };
  queryClient.setQueryData(['saas-console', 'tenants'], [authorizedTenant]);
  queryClient.setQueryData(['saas-wallet', 'wallet', authorizedTenant.id, 'USD', ''], walletData);
  queryClient.setQueryData(['saas-wallet', 'topup-policy', authorizedTenant.id], {
    available: true,
    currency: 'USD',
    minAmountMinorUnits: '100',
    maxAmountMinorUnits: '100000',
  });

  const html = renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(MemoryRouter, null, React.createElement(SaasWalletPage, { onLogout: async () => {} })),
    ),
  );
  queryClient.clear();

  assert.match(html, /客户钱包/);
  assert.match(html, /900,719,925,474,099,312,345/);
  assert.match(html, /冻结资金/);
  assert.match(html, /800/);
  assert.match(html, /消费已冻结/);
  assert.match(html, /−1,200/);
  assert.match(html, /模型用量结算/);
  assert.match(html, /ledger-entry-1/);
  assert.match(html, /transaction-1/);
  assert.match(html, /aria-current="page" href="\/console\/wallet"/);
  assert.match(html, /创建充值订单/);
  assert.match(html, /100 至 100,000/);
});

test('wallet page limits tenant selection to owner/admin and renders empty and loading states', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MemoryRouter } = await import('react-router-dom');
  const { SaasWalletPage } = await import('../../web/src/features/saas-wallet.tsx');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  const render = () =>
    renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(MemoryRouter, null, React.createElement(SaasWalletPage, { onLogout: async () => {} })),
      ),
    );

  queryClient.setQueryData(['saas-console', 'tenants'], [{ ...tenant, role: 'billing' }]);
  const denied = render();
  assert.match(denied, /仅对租户 owner 或 admin 开放/);
  assert.doesNotMatch(denied, /选择已授权租户/);

  queryClient.clear();
  globalThis.fetch = () => new Promise<Response>(() => {});
  const loading = render();
  assert.match(loading, /正在加载已授权租户/);

  queryClient.clear();
  queryClient.setQueryData(['saas-console', 'tenants'], [tenant]);
  queryClient.setQueryData(['saas-wallet', 'topup-policy', tenant.id], {
    available: false,
    currency: null,
    minAmountMinorUnits: null,
    maxAmountMinorUnits: null,
  });
  queryClient.setQueryData(['saas-wallet', 'wallet', tenant.id, 'USD', ''], {
    ...walletData,
    ledger: { items: [], nextCursor: null, hasMore: false },
  });
  const emptyLedger = render();
  assert.match(emptyLedger, /当前筛选条件下没有钱包账本记录/);
  assert.match(emptyLedger, /充值暂不可用/);
  assert.match(emptyLedger, /aria-label="账本分页"/);
  queryClient.clear();
});
