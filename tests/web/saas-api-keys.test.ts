import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ApiKeyMetadata, ApiKeyPrincipalKind, Project, SafeTenant } from '../../web/src/api/saas-client.ts';

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
    const key = keyPrincipalFixture('member', 'tenant/one', 'project one');
    const data = calls.length === 1 ? [] : calls.length === 4
      ? { ...key, status: 'revoked', revokedAt: '2026-10-04T00:00:00.000Z' }
      : { ...key, secret: 'mr_live_ABCDEFGHIJKLMNOPQRSTUVWX' };
    return new Response(JSON.stringify({ data }), {
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

function renderKeyManagementPage(role: SafeTenant['role'], projectRole: SafeTenant['role'] = role, keys: ApiKeyMetadata[] = []) {
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
        role: projectRole,
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
      } satisfies Project,
    ],
  );
  queryClient.setQueryData(['saas-console', 'api-keys', 'tenant-one', 'project-one'], keys);
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

function keyPrincipalFixture(
  kind: ApiKeyPrincipalKind = 'member', tenantId = 'tenant-one', projectId = 'project-one',
): ApiKeyMetadata {
  const base = {
    id: 'key-one', tenantId, projectId, supplyProfileId: 'profile-one',
    supplyMode: 'platform' as const, name: 'Owned unit key', prefix: 'mr_live_ABCDEFGHIJKL',
    modelScopes: ['model-scope-a'], status: 'active' as const,
    createdAt: '2026-10-04T00:00:00.000Z', expiresAt: null, revokedAt: null, lastUsedAt: null, authzVersion: 1,
  };
  return kind === 'project_service'
    ? { ...base, executionPrincipalType: 'project_service', executionPrincipalId: projectId, principalUserId: null }
    : { ...base, executionPrincipalType: 'member', executionPrincipalId: 'member-one', principalUserId: 'member-one' };
}

function keyResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('API key client accepts legal project-service null binding and strips secrets from list metadata', async () => {
  const key = keyPrincipalFixture('project_service');
  globalThis.fetch = async () => keyResponse([{ ...key, secret: 'unit-secret-must-not-cache', keyHash: 'unit-hash-must-not-cache' }]);
  const listed = await saasClientModule.saasClient.getApiKeys('tenant-one', 'project-one');
  assert.deepEqual(listed, [key]);
  assert.equal(listed[0].executionPrincipalType, 'project_service');
  assert.equal(listed[0].principalUserId, null);
  assert.equal(listed[0].executionPrincipalId, 'project-one');
  assert.equal('secret' in listed[0], false);
  assert.equal('keyHash' in listed[0], false);
  assert.equal(saasConsole.keyPrincipalLabel(listed[0]), '项目服务 · project-one');
});

test('API key client preserves member principal independently of creator or current operator', async () => {
  const key = keyPrincipalFixture('member');
  globalThis.fetch = async () => keyResponse([{ ...key, createdByUserId: 'different-operator', rotatedByUserId: 'another-operator' }]);
  const listed = await saasClientModule.saasClient.getApiKeys('tenant-one', 'project-one');
  assert.deepEqual(listed, [key]);
  assert.equal(listed[0].principalUserId, 'member-one');
  assert.equal(saasConsole.keyPrincipalLabel(listed[0]), '成员用户 · member-one');
});

test('API key client rejects missing unknown and mixed execution-principal bindings without exposing response secrets', async () => {
  const member = keyPrincipalFixture('member');
  const service = keyPrincipalFixture('project_service');
  const poison = 'unit-private-secret-do-not-render';
  const missing = { ...member };
  Reflect.deleteProperty(missing, 'executionPrincipalType');
  for (const invalid of [
    { ...member, principalUserId: null },
    { ...member, executionPrincipalId: 'other-member' },
    { ...service, principalUserId: 'member-one' },
    { ...service, executionPrincipalId: 'foreign-project' },
    { ...member, executionPrincipalType: 'user' },
    missing,
  ]) {
    globalThis.fetch = async () => keyResponse([{ ...invalid, secret: poison }]);
    await assert.rejects(saasClientModule.saasClient.getApiKeys('tenant-one', 'project-one'), error => {
      assert.ok(error instanceof saasClientModule.SaasApiError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.details, undefined);
      assert.equal(error.data, undefined);
      assert.equal(error.message.includes(poison), false);
      return true;
    });
  }
});

test('API key client rejects foreign tenant or project response metadata instead of rebinding it', async () => {
  for (const key of [
    keyPrincipalFixture('project_service', 'foreign-tenant', 'project-one'),
    keyPrincipalFixture('project_service', 'tenant-one', 'foreign-project'),
  ]) {
    globalThis.fetch = async () => keyResponse([key]);
    await assert.rejects(saasClientModule.saasClient.getApiKeys('tenant-one', 'project-one'), error => {
      assert.ok(error instanceof saasClientModule.SaasApiError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      return true;
    });
  }
});

test('API key create preserves omitted member default and sends only the explicit project-service selector', async () => {
  const calls: RequestInit[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'mr_saas_csrf=csrf-token' } });
  globalThis.fetch = async (_input, init) => {
    calls.push(init ?? {});
    return keyResponse({ ...keyPrincipalFixture(calls.length === 1 ? 'member' : 'project_service'), secret: 'unit-one-time-secret' });
  };
  const input = { name: 'unit key', modelScopes: ['model-scope-a'], supplyMode: 'platform' as const };
  const member = await saasClientModule.saasClient.createApiKey('tenant-one', 'project-one', input);
  const service = await saasClientModule.saasClient.createApiKey('tenant-one', 'project-one', { ...input, principalKind: 'project_service' });
  assert.equal(member.executionPrincipalType, 'member');
  assert.equal(service.executionPrincipalType, 'project_service');
  assert.equal(service.principalUserId, null);
  assert.deepEqual(JSON.parse(String(calls[0].body)), input);
  assert.deepEqual(JSON.parse(String(calls[1].body)), { ...input, principalKind: 'project_service' });
  for (const call of calls) {
    assert.equal(new Headers(call.headers).get('x-csrf-token'), 'csrf-token');
    assert.equal(call.credentials, 'same-origin');
    const body = JSON.parse(String(call.body));
    for (const field of ['principalUserId','executionPrincipalId','tenantId','projectId','budget','ipPolicy']) assert.equal(field in body, false);
  }
});

test('API key create rejects an invalid principal selector locally and a contradictory successful response', async () => {
  let calls = 0;
  const input = { name: 'unit key', modelScopes: ['model-scope-a'], supplyMode: 'platform' as const, principalKind: 'member' as const };
  Reflect.set(input, 'principalKind', 'user');
  globalThis.fetch = async () => { calls += 1; return keyResponse({ ...keyPrincipalFixture('project_service'), secret: 'unit-secret' }); };
  await assert.rejects(saasClientModule.saasClient.createApiKey('tenant-one', 'project-one', input), error => {
    assert.ok(error instanceof saasClientModule.SaasApiError);
    assert.equal(error.code, 'KEY_INVALID_INPUT');
    return true;
  });
  assert.equal(calls, 0);
  await assert.rejects(saasClientModule.saasClient.createApiKey('tenant-one', 'project-one', {
    name: 'unit key', modelScopes: ['model-scope-a'], supplyMode: 'platform', principalKind: 'member',
  }), error => {
    assert.ok(error instanceof saasClientModule.SaasApiError);
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.data, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('API key rotation exposes one-time secret but sends no replacement principal or new policy body', async () => {
  const calls: RequestInit[] = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'mr_saas_csrf=csrf-token' } });
  const original = keyPrincipalFixture('project_service');
  globalThis.fetch = async (_input, init) => {
    calls.push(init ?? {});
    return keyResponse({ ...original, id: 'replacement-key', secret: 'unit-one-time-secret' });
  };
  const rotated = await saasClientModule.saasClient.rotateApiKey('tenant-one', 'project-one', original.id);
  assert.equal(rotated.executionPrincipalType, original.executionPrincipalType);
  assert.equal(rotated.executionPrincipalId, original.executionPrincipalId);
  assert.equal(rotated.principalUserId, original.principalUserId);
  assert.equal(rotated.secret, 'unit-one-time-secret');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, undefined);
  assert.equal(new Headers(calls[0].headers).get('x-csrf-token'), 'csrf-token');
});

test('project-service selector defaults to member and requires owner or admin in both current scopes', () => {
  for (const tenantRole of ['owner','admin','developer','billing','viewer'] as const) {
    for (const projectRole of ['owner','admin','developer','billing','viewer'] as const) {
      assert.equal(saasConsole.canIssueProjectServiceKey(tenantRole, projectRole),
        ['owner','admin'].includes(tenantRole) && ['owner','admin'].includes(projectRole));
    }
  }
  assert.equal(saasConsole.canIssueProjectServiceKey(undefined, 'owner'), false);
  assert.equal(saasConsole.isApiKeyPrincipalKind('member'), true);
  assert.equal(saasConsole.isApiKeyPrincipalKind('project_service'), true);
  assert.equal(saasConsole.isApiKeyPrincipalKind('user'), false);
  for (const [tenantRole, projectRole] of [['owner','owner'], ['admin','owner'], ['developer','owner'], ['owner','developer']] as const) {
    const html = renderKeyManagementPage(tenantRole, projectRole);
    assert.match(html, /aria-label="选择执行主体"/);
    assert.match(html, /<option value="member" selected="">成员用户 — 当前登录成员<\/option>/);
    assert.match(html, /轮换继承原执行主体/);
    if (saasConsole.canIssueProjectServiceKey(tenantRole, projectRole)) assert.match(html, /<option value="project_service">/);
    else assert.match(html, /<option value="project_service" disabled="">/);
  }
});

test('API key list renders actual member and project-service principals without exposing cached secrets', () => {
  const keys = [keyPrincipalFixture('member'), keyPrincipalFixture('project_service')];
  keys[1].id = 'service-key';
  const html = renderKeyManagementPage('owner', 'admin', keys);
  assert.match(html, /成员用户 · member-one/);
  assert.match(html, /项目服务 · project-one/);
  assert.doesNotMatch(html, /一次性 API Key secret/);
  assert.doesNotMatch(html, /unit-one-time-secret/);
  const developer = renderKeyManagementPage('developer', 'owner', [keys[1]]);
  assert.match(developer, /<button[^>]*disabled=""[^>]*>轮换<\/button>/);
  assert.doesNotMatch(developer, /<button[^>]*disabled=""[^>]*>撤销<\/button>/);
});

function originalPrincipalSelectorDom(value: ApiKeyPrincipalKind, canIssueServiceKey: boolean) {
  return React.createElement('label', { className: 'field' },
    React.createElement('span', null, '执行主体'),
    React.createElement('select', {
      'aria-label': '选择执行主体', value, onChange: () => {},
    },
      React.createElement('option', { value: 'member' }, '成员用户 — 当前登录成员'),
      React.createElement('option', { value: 'project_service', disabled: !canIssueServiceKey }, '项目服务 — 当前项目'),
    ),
    React.createElement('small', null, '默认绑定当前登录成员；项目服务绑定当前项目，仅两级 Owner/Admin 可创建和轮换。'),
  );
}

// Literal DOM reference from the original metadata block, not an auth/API oracle.
function originalKeyMetadataDom(key: ApiKeyMetadata) {
  const h = React.createElement;
  const date = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '—';
  const badge = (text: string, tone = 'neutral') => h('span', { className: `badge ${tone}` }, text);
  const row = (label: string, content: React.ReactNode) =>
    h('div', null, h('span', null, label), content);
  return h(React.Fragment, null,
    h('div', { className: 'saas-tenant-heading' },
      h('div', null, h('h3', null, key.name), h('small', null, h('code', null, key.prefix))),
      badge(key.status === 'active' ? '有效' : '已撤销', key.status === 'active' ? 'good' : 'bad'),
    ),
    h('div', { className: 'summary-list' },
      row('供给模式', badge(key.supplyMode === 'byok' ? 'BYOK' : '平台供给')),
      row('执行主体', h('strong', null,
        (key.executionPrincipalType === 'project_service' ? '项目服务' : '成员用户') + ' · ' + key.executionPrincipalId)),
      row('模型范围', h('span', null, key.modelScopes.map(scope => h('code', { key: scope }, scope, ' ')))),
      row('创建时间', h('strong', null, date(key.createdAt))),
      row('过期时间', h('strong', null, date(key.expiresAt))),
      row('最近使用', h('strong', null, key.lastUsedAt ? date(key.lastUsedAt) : '尚未使用')),
      key.revokedAt ? row('撤销时间', h('strong', null, date(key.revokedAt))) : null,
    ),
  );
}

test('API key principal selector leaf preserves original labelled DOM and controlled options', async () => {
  const leaf = await import('../../web/src/features/saas-api-key-ui.tsx');
  assert.equal(leaf.isApiKeyPrincipalKind, saasConsole.isApiKeyPrincipalKind);
  for (const value of ['member', 'project_service'] as const) {
    for (const canIssueServiceKey of [true, false]) {
      const actual = renderToStaticMarkup(React.createElement(leaf.ApiKeyPrincipalSelector, {
        value, canIssueServiceKey, onChange: () => {},
      }));
      assert.equal(actual, renderToStaticMarkup(originalPrincipalSelectorDom(value, canIssueServiceKey)));
    }
  }
});

test('API key metadata leaf preserves original member and service DOM with optional lifecycle fields', async () => {
  const leaf = await import('../../web/src/features/saas-api-key-ui.tsx');
  assert.equal(leaf.keyPrincipalLabel, saasConsole.keyPrincipalLabel);
  for (const kind of ['member', 'project_service'] as const) {
    const active = keyPrincipalFixture(kind);
    const revoked: ApiKeyMetadata = {
      ...keyPrincipalFixture(kind), status: 'revoked', supplyMode: 'byok',
      modelScopes: ['model-scope-a', 'model-scope-b'],
      expiresAt: '2026-10-05T00:00:00.000Z',
      lastUsedAt: '2026-10-04T01:00:00.000Z',
      revokedAt: '2026-10-04T02:00:00.000Z',
    };
    for (const apiKey of [active, revoked]) {
      const actual = renderToStaticMarkup(React.createElement(leaf.ApiKeyMetadataDetails, { apiKey }));
      assert.equal(actual, renderToStaticMarkup(originalKeyMetadataDom(apiKey)));
    }
  }
});
