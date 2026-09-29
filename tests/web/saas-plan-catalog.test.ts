import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import * as React from 'react';
import type { SafeTenant, ServicePlanCatalogItem } from '../../web/src/api/saas-client.ts';
import { saasClient } from '../../web/src/api/saas-client.ts';

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

const catalogItem: ServicePlanCatalogItem = {
  planVersionId: 'plan-version-1',
  planId: 'byok-standard',
  version: 1,
  supplyMode: 'byok',
  termDays: 30,
  fixedFeeMinorUnits: '1200',
  currency: 'USD',
  supportedProviderIds: ['provider-a'],
  supportedModels: ['model-a'],
  policyDescription: 'BYOK only; customer supplies provider credentials.',
};

test('service-plan client uses an authenticated tenant catalog GET and drops unmodeled fields', async () => {
  const calls: string[] = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=should-not-be-sent-for-get' },
  });
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: [{ ...catalogItem, supplyProfileId: 'must-not-leak' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const plans = await saasClient.getServicePlanCatalog('tenant/one');
  assert.deepEqual(plans, [catalogItem]);
  assert.deepEqual(calls, ['/console/api/v1/tenants/tenant%2Fone/service-plans/catalog']);
});

test('catalog UI explains BYOK billing semantics, enables activation, and renders empty state', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { MemoryRouter } = await import('react-router-dom');
  const { ServicePlanCatalogPage } = await import('../../web/src/features/saas-console.tsx');
  const tenant: SafeTenant = {
    id: 'tenant-one',
    name: 'Tenant One',
    slug: 'tenant-one',
    status: 'active',
    role: 'viewer',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    defaultProjectId: 'project-one',
  };
  const queryClient = new QueryClient();
  queryClient.setQueryData(['saas-console', 'tenants'], [tenant]);
  queryClient.setQueryData(['saas-console', 'service-plans', 'tenant-one'], [catalogItem]);
  const render = () =>
    renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(ServicePlanCatalogPage, { onLogout: async () => {} }),
        ),
      ),
    );

  const populated = render();
  assert.match(populated, /BYOK 服务计划目录/);
  assert.match(populated, /客户自有凭证/);
  assert.match(populated, /固定期限服务费/);
  assert.match(populated, /不会扣除平台 Token wallet/);
  assert.match(populated, /购买并开始结账/);
  assert.doesNotMatch(populated, /购买、下单和开通功能尚未开放/);
  assert.match(populated, /byok-standard/);
  assert.match(populated, /model-a/);

  queryClient.setQueryData(['saas-console', 'service-plans', 'tenant-one'], []);
  const empty = render();
  assert.match(empty, /当前没有可展示的已发布 BYOK 服务计划/);
});
