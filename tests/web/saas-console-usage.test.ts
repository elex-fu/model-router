import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import * as React from 'react';
import type { Project } from '../../web/src/api/saas-client.ts';
import { saasClient } from '../../web/src/api/saas-client.ts';
import { formatExactDecimal, resolveProjectSelection } from '../../web/src/features/saas-console.tsx';

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
