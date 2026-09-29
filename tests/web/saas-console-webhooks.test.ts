import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  type CustomerWebhookDeliveryHistoryEntry,
  type CustomerWebhookEndpoint,
  type CustomerWebhookSecretMetadata,
  SaasApiError,
  saasClient,
} from '../../web/src/api/saas-client.ts';
import {
  CustomerWebhooksPage,
  customerWebhookDeliveryHistoryKey,
  customerWebhookEndpointsKey,
  customerWebhookSecretsKey,
  OneTimeWebhookSecretNotice,
} from '../../web/src/features/saas-console.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;
const queryClients = new Set<QueryClient>();

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
});

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';

const endpoint: CustomerWebhookEndpoint = {
  endpointId: ENDPOINT_ID,
  currentVersion: 2,
  state: 'active',
  targetUrl: 'https://hooks.example.test/customer-events',
  eventTypes: ['request.completed', 'usage.completed'],
  createdAt: '2026-09-28T10:00:00.000Z',
  updatedAt: '2026-09-29T10:00:00.000Z',
};

const currentSecret: CustomerWebhookSecretMetadata = {
  version: 2,
  state: 'current',
  overlapExpiresAt: null,
  createdAt: '2026-09-29T10:00:00.000Z',
};

const delivery: CustomerWebhookDeliveryHistoryEntry = {
  eventType: 'request.completed',
  occurredAt: '2026-09-29T11:58:00.000Z',
  status: 'delivered',
  attempts: 1,
  lastHttpStatus: 204,
  lastLatencyMs: 83,
  lastErrorCode: null,
};

const failedDelivery: CustomerWebhookDeliveryHistoryEntry = {
  ...delivery,
  status: 'dead_lettered',
  lastHttpStatus: 503,
  lastErrorCode: 'HTTP_STATUS_REJECTED',
};

function newQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, refetchOnMount: false } },
  });
  queryClients.add(queryClient);
  return queryClient;
}

function seedTenant(queryClient: QueryClient, role: 'owner' | 'admin' | 'developer' | 'viewer' = 'owner') {
  queryClient.setQueryData(
    ['saas-console', 'tenants'],
    [
      {
        id: TENANT_ID,
        name: '示例租户',
        slug: 'example-tenant',
        status: 'active',
        role,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
    ],
  );
}

function seedWebhookData(queryClient: QueryClient, role: 'owner' | 'admin' | 'developer' | 'viewer' = 'owner') {
  seedTenant(queryClient, role);
  queryClient.setQueryData(customerWebhookEndpointsKey(TENANT_ID), {
    pages: [{ items: [endpoint], nextCursor: null }],
    pageParams: [undefined],
  });
  queryClient.setQueryData(customerWebhookSecretsKey(TENANT_ID, ENDPOINT_ID), [currentSecret]);
  queryClient.setQueryData(customerWebhookDeliveryHistoryKey(TENANT_ID, ENDPOINT_ID), {
    pages: [{ items: [failedDelivery], nextCursor: null, hasMore: false }],
    pageParams: [undefined],
  });
}

function renderPage(queryClient: QueryClient): string {
  return renderToStaticMarkup(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/console/webhooks'] },
        React.createElement(CustomerWebhooksPage, { onLogout: async () => {} }),
      ),
    ),
  );
}

test('webhook client uses tenant-scoped routes, sends CSRF on mutations, and strips unapproved response fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const endpointResponse = {
    ...endpoint,
    tenantId: 'cross-tenant-id-must-not-be-retained',
    signingSecret: 'endpoint-list-secret-must-not-be-retained',
    payload: { private: 'endpoint-payload-must-not-be-retained' },
  };
  const data = [
    { items: [endpointResponse], nextCursor: null, internal: 'list-internal-must-not-be-retained' },
    {
      endpoint: endpointResponse,
      signingSecret: 'created-webhook-secret-shown-once',
      signingSecretVersion: 1,
      internal: 'create-internal-must-not-be-retained',
    },
    endpointResponse,
    endpointResponse,
    {
      items: [
        { ...currentSecret, signingSecret: 'metadata-secret-must-not-be-retained', encryptedEnvelope: 'private' },
      ],
      endpointId: ENDPOINT_ID,
    },
    { signingSecret: 'rotated-webhook-secret-shown-once', signingSecretVersion: 3, targetUrl: 'private' },
    { ...currentSecret, state: 'revoked', signingSecret: 'revoked-secret-must-not-be-retained' },
    {
      items: [
        {
          ...delivery,
          tenantId: 'cross-tenant-id-must-not-be-retained',
          eventId: 'internal-event-id-must-not-be-retained',
          payload: { private: 'delivery-payload-must-not-be-retained' },
          targetUrl: 'delivery-target-must-not-be-retained',
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  ];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=webhook-csrf-token' },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = data[calls.length - 1];
    assert.ok(next);
    return new Response(JSON.stringify({ data: next }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const listed = await saasClient.getCustomerWebhookEndpoints('tenant/one', { limit: 1 });
  const created = await saasClient.createCustomerWebhookEndpoint('tenant/one', {
    targetUrl: 'https://hooks.example.test/new',
    eventTypes: ['request.completed'],
  });
  const updated = await saasClient.updateCustomerWebhookEndpoint('tenant/one', ENDPOINT_ID, {
    targetUrl: 'https://hooks.example.test/updated',
    eventTypes: ['usage.completed'],
  });
  const disabled = await saasClient.setCustomerWebhookEndpointState('tenant/one', ENDPOINT_ID, 'disable');
  const secrets = await saasClient.getCustomerWebhookSigningSecrets('tenant/one', ENDPOINT_ID);
  const rotated = await saasClient.rotateCustomerWebhookSigningSecret('tenant/one', ENDPOINT_ID, 86_400_000);
  const revokedSecret = await saasClient.revokeCustomerWebhookSigningSecret('tenant/one', ENDPOINT_ID, 2);
  const history = await saasClient.getCustomerWebhookDeliveryHistory('tenant/one', ENDPOINT_ID, {
    cursor: 'cursor-value',
    limit: 20,
  });

  assert.deepEqual(listed.items, [endpoint]);
  assert.deepEqual(created, {
    endpoint,
    signingSecret: 'created-webhook-secret-shown-once',
    signingSecretVersion: 1,
  });
  assert.deepEqual(updated, endpoint);
  assert.deepEqual(disabled, endpoint);
  assert.deepEqual(secrets, [currentSecret]);
  assert.deepEqual(rotated, { signingSecret: 'rotated-webhook-secret-shown-once', signingSecretVersion: 3 });
  assert.deepEqual(revokedSecret, { ...currentSecret, state: 'revoked' });
  assert.deepEqual(history, { items: [delivery], nextCursor: null, hasMore: false });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/console/api/v1/tenants/tenant%2Fone/webhooks?limit=1',
      '/console/api/v1/tenants/tenant%2Fone/webhooks',
      `/console/api/v1/tenants/tenant%2Fone/webhooks/${ENDPOINT_ID}`,
      `/console/api/v1/tenants/tenant%2Fone/webhooks/${ENDPOINT_ID}/disable`,
      `/console/api/v1/tenants/tenant%2Fone/webhooks/${ENDPOINT_ID}/secrets`,
      `/console/api/v1/tenants/tenant%2Fone/webhooks/${ENDPOINT_ID}/rotate`,
      `/console/api/v1/tenants/tenant%2Fone/webhooks/${ENDPOINT_ID}/secrets/2/revoke`,
      `/console/api/v1/tenants/tenant%2Fone/webhooks/${ENDPOINT_ID}/deliveries?cursor=cursor-value&limit=20`,
    ],
  );
  assert.equal(calls[0]?.init.method ?? 'GET', 'GET');
  assert.equal(new Headers(calls[0]?.init.headers).get('x-csrf-token'), null);
  for (const index of [1, 2, 3, 5, 6]) {
    assert.equal(new Headers(calls[index]?.init.headers).get('x-csrf-token'), 'webhook-csrf-token');
  }
  assert.deepEqual(JSON.parse(String(calls[5]?.init.body)), { overlapMs: 86_400_000 });
  assert.deepEqual(JSON.parse(String(calls[6]?.init.body)), {});
  assert.doesNotMatch(
    JSON.stringify([listed, created.endpoint, updated, disabled, secrets, rotated, revokedSecret, history]),
    /cross-tenant-id|must-not-be-retained|encryptedEnvelope|delivery-target-must-not-be-retained/,
  );
});

test('webhook API errors never render internal response details', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'database password must not escape',
          details: { query: 'private SQL' },
        },
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  await assert.rejects(saasClient.getCustomerWebhookEndpoints(TENANT_ID), (error: unknown) => {
    assert.ok(error instanceof SaasApiError);
    assert.doesNotMatch(
      `${error.message} ${error.code} ${JSON.stringify(error.details)}`,
      /database password|private SQL/,
    );
    return true;
  });
});

test('webhook page has accessible loading, empty, and safe error states', () => {
  const loadingClient = newQueryClient();
  seedTenant(loadingClient);
  const loading = renderPage(loadingClient);
  assert.match(loading, /role="status"[^>]*aria-label="正在加载 Webhook 端点"/);
  loadingClient.clear();

  const emptyClient = newQueryClient();
  seedTenant(emptyClient);
  emptyClient.setQueryData(customerWebhookEndpointsKey(TENANT_ID), {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [undefined],
  });
  const empty = renderPage(emptyClient);
  assert.match(empty, /暂无 Webhook 端点/);
  assert.match(empty, /aria-current="page"/);
  assert.match(empty, /创建 Webhook 端点/);
  emptyClient.clear();

  const errorClient = newQueryClient();
  seedTenant(errorClient);
  const errorQuery = errorClient.getQueryCache().build(errorClient, {
    queryKey: customerWebhookEndpointsKey(TENANT_ID),
    queryFn: async () => ({ items: [], nextCursor: null }),
  });
  errorQuery.setState({
    status: 'error',
    error: new SaasApiError(500, 'HTTP_ERROR', 'raw database secret must not render'),
    errorUpdatedAt: Date.now(),
  });
  const failed = renderPage(errorClient);
  assert.match(failed, /无法读取 Webhook 端点/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(failed, /raw database secret must not render/);
  errorClient.clear();
});

test('webhook endpoint and delivery UI expose manager actions and only allowlisted history fields', () => {
  const ownerClient = newQueryClient();
  seedWebhookData(ownerClient, 'owner');
  const ownerMarkup = renderPage(ownerClient);
  assert.match(ownerMarkup, /Webhook 事件通知/);
  assert.match(ownerMarkup, /aria-label="Webhook 端点列表"/);
  assert.match(ownerMarkup, /aria-pressed="true"/);
  assert.match(ownerMarkup, /编辑配置/);
  assert.match(ownerMarkup, /停用/);
  assert.match(ownerMarkup, /撤销端点/);
  assert.match(ownerMarkup, /轮换签名密钥/);
  assert.match(ownerMarkup, /加载更多记录|Webhook 投递历史/);
  assert.match(ownerMarkup, /请求完成/);
  assert.match(ownerMarkup, /HTTP 结果/);
  assert.match(ownerMarkup, /HTTP_STATUS/);
  assert.doesNotMatch(ownerMarkup, /delivery-payload|delivery-target|cross-tenant-id|metadata-secret/);
  ownerClient.clear();

  const viewerClient = newQueryClient();
  seedWebhookData(viewerClient, 'developer');
  const viewerMarkup = renderPage(viewerClient);
  assert.match(viewerMarkup, /当前角色可查看 Webhook 配置和投递记录/);
  assert.doesNotMatch(viewerMarkup, /创建 Webhook 端点|编辑配置|撤销端点|轮换签名密钥/);
  viewerClient.clear();
});

test('one-time webhook secret notice shows the value once with copy and dismiss controls', () => {
  const secret = 'one-time-secret-display-test';
  const markup = renderToStaticMarkup(
    React.createElement(OneTimeWebhookSecretNotice, {
      value: secret,
      version: 4,
      action: 'rotated',
      onDismiss: () => {},
    }),
  );
  assert.equal(markup.split(secret).length - 1, 1);
  assert.match(markup, /签名密钥已轮换/);
  assert.match(markup, /此签名密钥只显示这一次/);
  assert.match(markup, /aria-label="一次性签名密钥"/);
  assert.match(markup, /复制密钥/);
  assert.match(markup, /关闭并清除/);
});
