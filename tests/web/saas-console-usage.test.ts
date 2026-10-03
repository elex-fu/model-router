import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import * as React from 'react';
import type { ConsoleRequest, ConsoleRequestDetail, Project } from '../../web/src/api/saas-client.ts';
import { SaasApiError, saasClient } from '../../web/src/api/saas-client.ts';
import { formatExactDecimal, RequestFinancialStatus, RequestReconciliationStatus, resolveProjectSelection } from '../../web/src/features/saas-console.tsx';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;

after(() => {
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as typeof globalThis & { document?: unknown }).document;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
});

test('customer usage and request clients use tenant-scoped GET filters', async () => {
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=should-not-be-sent-for-get' },
  });
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({ data: calls.length === 1 ? null : { items: [], nextCursor: null, hasMore: false } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  await saasClient.getUsageSummary('tenant/one', {
    from: '2026-09-27T00:00:00.000Z',
    to: '2026-09-28T00:00:00.000Z',
    projectId: 'project one',
    model: 'model-a',
    status: 'succeeded',
    supplyMode: 'byok',
  });
  await saasClient.listRequests('tenant/one', { limit: 50, cursor: 'c1.cursor', supplyMode: 'platform' });

  assert.match(calls[0], /^\/console\/api\/v1\/tenants\/tenant%2Fone\/usage\?/);
  assert.match(calls[0], /from=2026-09-27T00%3A00%3A00.000Z/);
  assert.match(calls[0], /projectId=project\+one/);
  assert.match(calls[0], /supplyMode=byok/);
  assert.match(calls[1], /\/requests\?limit=50&cursor=c1.cursor&supplyMode=platform$/);
});

test('project selection is tenant-bound and supports an explicit all-projects value', () => {
  const projects = [
    {
      id: 'project-two',
      tenantId: 'tenant-two',
      name: 'Project Two',
      slug: 'project-two',
      role: 'viewer',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    },
  ] satisfies Project[];

  assert.equal(resolveProjectSelection('tenant-two', 'tenant-one', 'project-one', projects, false), '');
  assert.equal(resolveProjectSelection('tenant-two', 'tenant-one', 'project-one', projects, true), 'project-two');
  assert.equal(resolveProjectSelection('tenant-two', 'tenant-two', '', projects, false), '');
  assert.equal(resolveProjectSelection('tenant-two', 'tenant-two', 'project-two', projects, false), 'project-two');
});

test('usage and request filters do not require a hand-entered project ID in the console UI', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MemoryRouter } = await import('react-router-dom');
  const { UsagePage, RequestsPage } = await import('../../web/src/features/saas-console.tsx');
  const queryClient = new QueryClient();
  const tenant = {
    id: 'tenant-one',
    name: 'Tenant One',
    slug: 'tenant-one',
    status: 'active',
    role: 'developer',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    defaultProjectId: 'project-one',
  } as const;
  const project = {
    id: 'project-one',
    tenantId: 'tenant-one',
    name: 'Project One',
    slug: 'project-one',
    role: 'developer',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  } satisfies Project;
  queryClient.setQueryData(['saas-console', 'tenants'], [tenant]);
  queryClient.setQueryData(['saas-console', 'projects', 'tenant-one'], [project]);
  const render = (element: React.ReactElement) =>
    renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(MemoryRouter, null, element),
      ),
    );
  const usage = render(React.createElement(UsagePage, { onLogout: async () => {} }));
  const requests = render(React.createElement(RequestsPage, { onLogout: async () => {} }));
  queryClient.clear();
  const html = `${usage}\n${requests}`;
  assert.match(html, /aria-label="选择项目"/);
  assert.match(html, /全部项目/);
  assert.match(html, /Project One/);
  assert.doesNotMatch(html, /项目 ID（可选）/);
});

test('token presentation keeps large decimal strings exact', () => {
  assert.equal(formatExactDecimal('900719925474099312345'), '900,719,925,474,099,312,345');
  assert.equal(formatExactDecimal('0'), '0');
  assert.equal(formatExactDecimal(null), '—');
  assert.equal(formatExactDecimal('not-a-decimal'), '—');
});

function stateRequest(): ConsoleRequestDetail {
  return {
    id: 'request-pending', projectId: 'project-one', model: 'model-one',
    protocol: 'openai', supplyMode: 'platform', status: 'succeeded',
    financialStatus: 'reconciliation_pending', reconciliationState: 'resolved',
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:01.000Z',
    attempts: [], usageEvents: [],
  };
}

function respondWith(data: unknown): void {
  globalThis.fetch = async () => new Response(JSON.stringify({ data }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

test('HTTP 200 request metadata and both detail aliases preserve financial pending independently of execution success', async () => {
  const pending = stateRequest();
  respondWith({ items: [pending], hasMore: false, nextCursor: null });
  const list = await saasClient.listRequests('tenant-one', { projectId: 'project-one', status: 'succeeded' });
  assert.equal(list.items[0]?.status, 'succeeded');
  assert.equal(list.items[0]?.financialStatus, 'reconciliation_pending');
  assert.equal(list.items[0]?.reconciliationState, 'resolved');
  for (const getDetail of [saasClient.getRequest, saasClient.getRequestDetail]) {
    respondWith(pending);
    const detail = await getDetail('tenant-one', pending.id, 'project-one');
    assert.equal(detail.financialStatus, 'reconciliation_pending');
    assert.equal(detail.status, 'succeeded');
    assert.equal(detail.reconciliationState, 'resolved');
  }
});

test('older API responses leave new axes absent, while malformed or mode-conflicting axes reject safely', async () => {
  const legacy = stateRequest();
  delete legacy.financialStatus;
  delete legacy.reconciliationState;
  respondWith(legacy);
  const detail = await saasClient.getRequestDetail('tenant-one', legacy.id);
  assert.equal(Object.hasOwn(detail, 'financialStatus'), false);
  assert.equal(Object.hasOwn(detail, 'reconciliationState'), false);
  const malformed = [
    { financialStatus: null }, { financialStatus: 'future-state' },
    { reconciliationState: null }, { reconciliationState: 'settled' },
    { supplyMode: 'byok', financialStatus: 'settled' },
    { supplyMode: 'platform', financialStatus: 'not_applicable' },
    { status: 'unknown', reconciliationState: 'resolved' },
    { status: 'unknown', reconciliationState: 'none' },
  ];
  for (const invalid of malformed) {
    const value = { ...stateRequest(), ...invalid };
    respondWith({ items: [value], hasMore: false, nextCursor: null });
    await assert.rejects(saasClient.listRequests('tenant-one'), (error: unknown) =>
      error instanceof SaasApiError && error.code === 'INVALID_RESPONSE' &&
      error.message === '服务返回了无效请求状态');
    for (const getDetail of [saasClient.getRequest, saasClient.getRequestDetail]) {
      respondWith(value);
      await assert.rejects(getDetail('tenant-one', value.id), (error: unknown) =>
        error instanceof SaasApiError && error.code === 'INVALID_RESPONSE');
    }
  }
});

test('financial and execution-reconciliation labels never turn resolved or missing metadata into settled', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const renderStates = (request: ConsoleRequest) => renderToStaticMarkup(React.createElement(
    React.Fragment, null,
    React.createElement(RequestFinancialStatus, { request }),
    React.createElement(RequestReconciliationStatus, { request }),
  ));
  const pending = renderStates(stateRequest());
  assert.match(pending, /财务待对账（尚未结算）/);
  assert.match(pending, /执行对账已完成/);
  assert.doesNotMatch(pending, />已结算</);
  const legacy = stateRequest();
  delete legacy.financialStatus;
  delete legacy.reconciliationState;
  const absent = renderStates(legacy);
  assert.match(absent, /财务状态未提供/);
  assert.match(absent, /执行对账状态未提供/);
  assert.doesNotMatch(absent, /已结算|无平台 Token 扣费|执行对账已完成/);
  const byok = renderStates({ ...stateRequest(), supplyMode: 'byok', financialStatus: 'not_applicable' });
  assert.match(byok, /BYOK 无平台 Token 扣费/);
  assert.doesNotMatch(byok, /已结算|待结算/);
  for (const [financialStatus, label] of [
    ['pending', '待结算'], ['settled', '已结算'], ['released', '预留已释放'],
  ] as const) {
    assert.ok(renderStates({ ...stateRequest(), financialStatus }).includes(label));
  }
  for (const [reconciliationState, label] of [
    ['none', '未进入执行对账'], ['pending', '执行结果待对账'],
  ] as const) {
    assert.ok(renderStates({ ...stateRequest(), reconciliationState }).includes(label));
  }
});

test('actual customer list and detail render separate axes with safe explanations and unchanged exact usage', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MemoryRouter } = await import('react-router-dom');
  const { RequestsPage, RequestDetailPage } = await import('../../web/src/features/saas-console.tsx');
  const request = stateRequest();
  const byok = { ...request, id: 'request-byok', supplyMode: 'byok', financialStatus: 'not_applicable' } satisfies ConsoleRequestDetail;
  const detail = {
    ...request,
    attempts: [{
      id: 'attempt-one', sequence: 1, status: 'succeeded', responseStarted: true,
      responseStartedAt: request.updatedAt, httpStatus: 200,
      createdAt: request.createdAt, updatedAt: request.updatedAt,
    }],
    usageEvents: [{
      id: 'usage-one', supplyMode: 'platform',
      inputTotal: '900719925474099312345', inputUncached: null, cacheRead: null,
      cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null, outputTotal: '2',
      reasoningOutput: null, status: 'reported', source: 'upstream',
      measurementKind: 'snapshot', billableBasis: 'exact', createdAt: request.updatedAt,
    }],
  } satisfies ConsoleRequestDetail;
  const tenant = {
    id: 'tenant-one', name: 'Tenant One', slug: 'tenant-one', status: 'active',
    role: 'developer', defaultProjectId: 'project-one',
    createdAt: request.createdAt, updatedAt: request.updatedAt,
  } as const;
  const project = {
    id: 'project-one', tenantId: tenant.id, name: 'Project One', slug: 'project-one',
    role: 'developer', createdAt: request.createdAt, updatedAt: request.updatedAt,
  } satisfies Project;
  for (const page of ['list', 'detail'] as const) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    try {
      queryClient.setQueryData(['saas-console', 'tenants'], [tenant]);
      queryClient.setQueryData(['saas-console', 'projects', tenant.id], [project]);
      if (page === 'list') {
        // Match the request prefix, not a wall-clock-sensitive date filter key.
        queryClient.setQueryDefaults(['saas-console', 'requests'], {
          initialData: { items: [request, byok], nextCursor: null, hasMore: false },
        });
      } else {
        queryClient.setQueryData(['saas-console', 'requests', 'detail', tenant.id, request.id, ''], detail);
      }
      const element = React.createElement(page === 'list' ? RequestsPage : RequestDetailPage, { onLogout: async () => {} });
      const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(MemoryRouter, { initialEntries: [`/console/requests/${request.id}?tenantId=${tenant.id}`] }, element)));
      assert.match(html, /执行状态/);
      assert.match(html, /财务状态/);
      assert.match(html, /执行对账/);
      assert.match(html, /财务待对账（尚未结算）/);
      assert.match(html, /执行对账已完成/);
      assert.match(html, /执行成功或重放 HTTP 200 不代表平台 Token 费用已结算/);
      assert.doesNotMatch(html, />已结算</);
      if (page === 'list') {
        assert.match(html, /BYOK 无平台 Token 扣费/);
        assert.match(html, /查看/);
      } else {
        assert.match(html, /HTTP 200/);
        assert.match(html, /900,719,925,474,099,312,345/);
      }
    } finally {
      queryClient.clear();
    }
  }
});
