import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Project, SafeTenant } from '../../web/src/api/saas-client.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
reactGlobal.React = React;
let saasConsole: typeof import('../../web/src/features/saas-console.tsx');
let saasClientModule: typeof import('../../web/src/api/saas-client.ts');
let reactQuery: typeof import('@tanstack/react-query');
let reactRouter: typeof import('react-router-dom');

before(async () => {
  [saasConsole, saasClientModule, reactQuery, reactRouter] = await Promise.all([
    import('../../web/src/features/saas-console.tsx'),
    import('../../web/src/api/saas-client.ts'),
    import('@tanstack/react-query'),
    import('react-router-dom'),
  ]);
});

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

test('API key client uses tenant/project routes and CSRF header for writes', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=csrf-token' },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await saasClientModule.saasClient.getApiKeys('tenant/one', 'project one');
  await saasClientModule.saasClient.createApiKey('tenant/one', 'project one', {
    name: 'console',
    modelScopes: ['model-scope-a', 'model-scope-b'],
    supplyMode: 'platform',
    expiresAt: '2026-10-01T00:00:00.000Z',
  });
  await saasClientModule.saasClient.rotateApiKey('tenant/one', 'project one', 'key/one');
  await saasClientModule.saasClient.revokeApiKey('tenant/one', 'project one', 'key/one');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/console/api/v1/tenants/tenant%2Fone/projects/project%20one/keys',
      '/console/api/v1/tenants/tenant%2Fone/projects/project%20one/keys',
      '/console/api/v1/tenants/tenant%2Fone/projects/project%20one/keys/key%2Fone/rotate',
      '/console/api/v1/tenants/tenant%2Fone/projects/project%20one/keys/key%2Fone/revoke',
    ],
  );
  const headers = calls.map((call) => new Headers(call.init.headers));
  assert.equal(headers[0].get('x-csrf-token'), null);
  assert.equal(headers[1].get('x-csrf-token'), 'csrf-token');
  assert.equal(headers[2].get('x-csrf-token'), 'csrf-token');
  assert.equal(headers[3].get('x-csrf-token'), 'csrf-token');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    name: 'console',
    modelScopes: ['model-scope-a', 'model-scope-b'],
    supplyMode: 'platform',
    expiresAt: '2026-10-01T00:00:00.000Z',
  });
});

test('project client uses the fixed tenant-scoped DTO and never exposes extra fields', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'mr_saas_csrf=csrf-token' },
  });
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const project = {
      id: 'project-one',
      tenantId: 'tenant/one',
      name: 'Project One',
      slug: 'project-one',
      role: 'admin',
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      secret: 'must-not-leak',
    };
    return new Response(JSON.stringify({ data: calls.length === 1 ? [project] : project }), {
      status: calls.length === 1 ? 200 : 201,
      headers: { 'content-type': 'application/json' },
    });
  };

  const projects = await saasClientModule.saasClient.getProjects('tenant/one');
  const created = await saasClientModule.saasClient.createProject('tenant/one', {
    name: 'Project One',
    slug: 'project-one',
  });
  const expected = {
    id: 'project-one',
    tenantId: 'tenant/one',
    name: 'Project One',
    slug: 'project-one',
    role: 'admin',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  } satisfies Project;
  assert.deepEqual(projects, [expected]);
  assert.deepEqual(created, expected);
  assert.deepEqual(
    calls.map((call) => call.url),
    ['/console/api/v1/tenants/tenant%2Fone/projects', '/console/api/v1/tenants/tenant%2Fone/projects'],
  );
  assert.equal(new Headers(calls[0].init.headers).get('x-csrf-token'), null);
  assert.equal(new Headers(calls[1].init.headers).get('x-csrf-token'), 'csrf-token');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { name: 'Project One', slug: 'project-one' });
});

test('model scope input is explicit and entitlement errors are explained in Chinese', () => {
  assert.deepEqual(saasConsole.parseModelScopes('model-scope-a\n model-scope-b'), {
    scopes: ['model-scope-a', 'model-scope-b'],
  });
  assert.equal(saasConsole.parseModelScopes(' \n , ').error, '请至少填写一个模型 scope。');
  assert.equal(saasConsole.parseModelScopes('model-scope-a\nmodel-scope-a').error, '模型 scope 不能重复。');

  const error = new saasClientModule.SaasApiError(403, 'KEY_NO_ENTITLEMENT', 'No entitlement');
  assert.match(saasConsole.keyErrorMessage(error), /所选供给模式的 entitlement/);
  assert.match(saasConsole.keyErrorMessage(error), /KEY_NO_ENTITLEMENT/);
});

test('requires an explicit supply mode before creating an API key', () => {
  assert.equal(saasConsole.isApiKeySupplyMode(''), false);
  assert.equal(saasConsole.isApiKeySupplyMode('byok'), true);
  assert.equal(saasConsole.isApiKeySupplyMode('platform'), true);

  const html = renderKeyManagementPage('developer');
  assert.match(html, /<option value="" selected="">请选择供给模式<\/option>/);
});

function renderKeyManagementPage(role: SafeTenant['role']) {
  const queryClient = new reactQuery.QueryClient();
  queryClient.setQueryData(
    ['saas-console', 'tenants'],
    [
      {
        id: 'tenant-one',
        name: 'Tenant One',
        slug: 'tenant-one',
        status: 'active',
        role,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
        defaultProjectId: 'project-one',
      } satisfies SafeTenant,
    ],
  );
  queryClient.setQueryData(
    ['saas-console', 'projects', 'tenant-one'],
    [
      {
        id: 'project-one',
        tenantId: 'tenant-one',
        name: 'Project One',
        slug: 'project-one',
        role,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
      } satisfies Project,
    ],
  );
  const html = renderToStaticMarkup(
    React.createElement(
      reactQuery.QueryClientProvider,
      { client: queryClient },
      React.createElement(
        reactRouter.MemoryRouter,
        null,
        React.createElement(saasConsole.KeyManagementPage, { onLogout: async () => {} }),
      ),
    ),
  );
  queryClient.clear();
  return html;
}

test('does not render misleading API key list states for viewer or billing roles', () => {
  for (const role of ['viewer', 'billing'] as const) {
    const html = renderKeyManagementPage(role);
    assert.match(html, /当前角色无权查看 API Keys/);
    assert.match(html, /前端显隐不替代服务端对租户和项目角色的重新授权/);
    assert.doesNotMatch(html, /<h2>API Keys<\/h2>/);
    assert.doesNotMatch(html, /正在加载 API Keys|当前项目暂无 API Key/);
  }
});

test('renders a generic exact-scope placeholder and explicit supply mode for management roles', () => {
  const html = renderKeyManagementPage('developer');
  assert.match(html, /<h2>API Keys<\/h2>/);
  assert.match(html, /aria-label="选择项目"/);
  assert.match(html, /Project One/);
  assert.match(html, /当前项目/);
  assert.match(html, /aria-label="选择供给模式"/);
  assert.match(html, /BYOK — 租户自有上游凭证/);
  assert.match(html, /平台供给 — 平台授权池/);
  assert.match(html, /当前项目无所选模式 entitlement 时，服务端会拒绝创建/);
  assert.match(html, /placeholder="例如：model-scope-a(?:\\n|\s+)model-scope-b"/);
  assert.doesNotMatch(html, /gpt-5\.6/);
});

test('setup guidance is CLI-only and invitation acceptance renders without bootstrap status', () => {
  assert.equal('getBootstrapStatus' in saasClientModule.saasClient, false);
  assert.equal('bootstrap' in saasClientModule.saasClient, false);

  const setup = renderConsolePath('/console/setup');
  assert.match(setup, /首次平台管理员设置仅通过 CLI 完成/);
  assert.match(setup, /model-router saas:bootstrap-admin/);
  assert.match(setup, /客户访问保持邀请制/);
  assert.doesNotMatch(setup, /<form|创建平台管理员|平台 bootstrap 令牌/);

  const invitation = renderConsolePath('/console/invitations/accept');
  assert.match(invitation, /<h1>接受邀请<\/h1>/);
  assert.match(invitation, /邀请邮箱和个人信息/);
});

test('login and invitation acceptance use their own API routes without bootstrap', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const data = url.endsWith('/auth/session')
      ? {
          session: {
            userId: 'user-1',
            activeTenantId: null,
            expiresAt: '2030-01-01T00:00:00.000Z',
            createdAt: '2029-01-01T00:00:00.000Z',
          },
        }
      : {
          id: 'user-1',
          email: 'person@example.test',
          displayName: 'Person',
          status: 'active',
          emailVerifiedAt: null,
          createdAt: '2029-01-01T00:00:00.000Z',
        };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  await saasClientModule.saasClient.login({ email: 'person@example.test', password: 'correct horse battery staple' });
  await saasClientModule.saasClient.acceptInvitation({
    token: 'invite-token',
    email: 'person@example.test',
    displayName: 'Person',
    password: 'correct horse battery staple',
  });

  assert.deepEqual(calls, ['/console/api/v1/auth/session', '/console/api/v1/invitations/accept']);
});

function renderConsolePath(path: string) {
  const queryClient = new reactQuery.QueryClient();
  const html = renderToStaticMarkup(
    React.createElement(
      reactQuery.QueryClientProvider,
      { client: queryClient },
      React.createElement(
        reactRouter.MemoryRouter,
        { initialEntries: [path] },
        React.createElement(saasConsole.SaasConsoleApp),
      ),
    ),
  );
  queryClient.clear();
  return html;
}
