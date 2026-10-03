import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SaasApiError, saasClient, type Project, type SafeSession, type SafeTenant } from '../../web/src/api/saas-client.ts';
import { WorkspaceContent, WorkspaceErrorNotice, WorkspaceInvitationAcceptance } from '../../web/src/features/saas-workspace.tsx';
import {
  canManageWorkspace, clearWorkspaceDrafts, readWorkspaceDraft, removeWorkspaceDraft, selectWorkspaceProject,
  selectWorkspaceTenant, workspaceErrorMessage, workspaceInvitationLink, workspaceInvitationRoles,
  workspaceMembersKey, workspaceMutationUnknown, workspaceProjectsKey, workspaceTenantsKey, writeWorkspaceDraft,
  type WorkspaceDraft, type WorkspaceDraftScope,
} from '../../web/src/features/saas-workspace-state.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React; reactGlobal.React = React;
after(() => { if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React'); else reactGlobal.React = originalReact; });
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

const userId = '10000000-0000-4000-8000-000000000001';
const disabledId = '10000000-0000-4000-8000-000000000002';
const tenantA = '20000000-0000-4000-8000-000000000001';
const tenantB = '20000000-0000-4000-8000-000000000002';
const date = '2026-10-01T00:00:00.000Z';
const session: SafeSession = { userId, activeTenantId: null, createdAt: date, expiresAt: '2099-01-01T00:00:00.000Z' };
const owner: SafeTenant = { id: tenantA, name: 'Owner workspace', slug: 'owner-team', role: 'owner', status: 'active', createdAt: date, updatedAt: date, defaultProjectId: 'project-a' };
const viewer: SafeTenant = { ...owner, id: tenantB, name: 'Viewer workspace', slug: 'viewer-team', role: 'viewer', defaultProjectId: 'project-b' };
const projectA: Project = { id: 'project-a', tenantId: tenantA, name: 'Owner tenant viewer project', slug: 'viewer-project', role: 'viewer', createdAt: date, updatedAt: date };
const projectB: Project = { ...projectA, id: 'project-b', tenantId: tenantB, name: 'Viewer tenant developer project', role: 'developer' };
const poisoned = 'raw-email-password-session-key-error-must-not-leak';
const noRefetch = { retry: false, retryOnMount: false, refetchOnMount: false, staleTime: Infinity };

function clientWithWorkspace() {
  const client = new QueryClient({ defaultOptions: { queries: noRefetch } });
  client.setQueryData(workspaceTenantsKey(userId), [owner, viewer]);
  client.setQueryData(workspaceProjectsKey(userId, tenantA), [projectA]);
  client.setQueryData(workspaceProjectsKey(userId, tenantB), [projectB]);
  client.setQueryData(workspaceMembersKey(userId, tenantA), {
    items: [{ userId, displayName: 'Current owner', role: 'owner', status: 'active' },
      { userId: disabledId, displayName: null, role: 'billing', status: 'disabled' }], nextCursor: null,
  });
  return client;
}

function renderWorkspace(client: QueryClient, entry = '/console'): string {
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter,
    { initialEntries: [entry] }, React.createElement(WorkspaceContent, { session, onSessionExpired: () => {} }))));
}

test('workspace separates two tenants, tenant/project authority and current membership from unavailable lifecycle state', () => {
  const client = clientWithWorkspace();
  try {
    const html = renderWorkspace(client, `/console?tenantId=${tenantA}&projectId=project-a`);
    assert.match(html, /Owner workspace/); assert.match(html, /Viewer workspace/);
    assert.match(html, /我的租户角色/); assert.match(html, /我的项目角色/);
    assert.match(html, /Owner tenant viewer project/); assert.doesNotMatch(html, /Viewer tenant developer project/);
    assert.match(html, /有效成员 · active/); assert.match(html, /项目生命周期状态/); assert.match(html, /当前 API 未提供/);
    assert.match(html, /Current owner/); assert.match(html, /账户已禁用/);
    assert.match(html, /创建项目/); assert.match(html, /邀请成员/);
    assert.match(html, /成员变更、移除和 Owner 转移尚未提供/);
    assert.doesNotMatch(html, /type="email"/); // Invite entry is reused and closed by default.

    const viewerHtml = renderWorkspace(client, `/console?tenantId=${tenantB}`);
    assert.match(viewerHtml, /Viewer tenant developer project/); assert.doesNotMatch(viewerHtml, /Owner tenant viewer project/);
    assert.match(viewerHtml, /当前租户角色不能创建项目或邀请成员/);
    assert.doesNotMatch(viewerHtml, /Current owner/); assert.equal(viewerHtml.includes(disabledId), false);
    assert.match(viewerHtml, /只有当前有效租户的所有者或管理员可以查看成员目录/);
    assert.doesNotMatch(viewerHtml, />创建项目<|>邀请成员</);
  } finally { client.clear(); }
});

test('explicit inaccessible tenant/project selectors do not inherit authority or silently fall back', () => {
  assert.equal(selectWorkspaceTenant([owner, viewer], 'tenant-other'), undefined);
  assert.equal(selectWorkspaceTenant([owner, viewer], ''), undefined);
  assert.equal(selectWorkspaceTenant([owner, viewer], null), owner);
  assert.equal(selectWorkspaceProject(owner, [projectA, projectB], 'project-b'), undefined);
  assert.equal(selectWorkspaceProject(owner, [projectB], null), undefined);
  const client = clientWithWorkspace();
  try {
    const denied = renderWorkspace(client, '/console?tenantId=tenant-other');
    assert.match(denied, /指定租户不可访问；不会自动切换到其他租户/);
    assert.doesNotMatch(denied, /租户详情|当前租户项目|Current owner|邀请成员/);
    const wrongProject = renderWorkspace(client, `/console?tenantId=${tenantA}&projectId=project-b`);
    assert.match(wrongProject, /指定项目不在当前租户的可访问列表中/);
    assert.doesNotMatch(wrongProject, /aria-label="项目详情"|Viewer tenant developer project/);
  } finally { client.clear(); }
});

test('invitation roles mirror actual service restrictions, without owner invitation or project-derived privileges', () => {
  assert.deepEqual(workspaceInvitationRoles('owner'), ['admin', 'developer', 'billing', 'viewer']);
  assert.deepEqual(workspaceInvitationRoles('admin'), ['developer', 'billing', 'viewer']);
  for (const role of ['developer', 'billing', 'viewer'] as const) {
    assert.equal(canManageWorkspace(role), false); assert.deepEqual(workspaceInvitationRoles(role), []);
  }
  assert.equal(canManageWorkspace('owner'), true); assert.equal(canManageWorkspace('admin'), true);
  assert.deepEqual(workspaceProjectsKey('other-user', tenantA), ['saas-console', 'projects', 'workspace', 'other-user', tenantA]);
});

test('workspace loading/empty/error states never expose cached authority controls or raw errors', () => {
  const loadingClient = new QueryClient({ defaultOptions: { queries: noRefetch } });
  const loadingQuery = loadingClient.getQueryCache().build(loadingClient, { queryKey: workspaceTenantsKey(userId), queryFn: async () => [] as SafeTenant[] });
  loadingQuery.setState({ status: 'pending', fetchStatus: 'fetching' });
  try { assert.match(renderWorkspace(loadingClient), /aria-label="正在加载租户"/); } finally { loadingClient.clear(); }
  const emptyClient = new QueryClient({ defaultOptions: { queries: noRefetch } }); emptyClient.setQueryData(workspaceTenantsKey(userId), []);
  try { assert.match(renderWorkspace(emptyClient), /暂无可访问租户/); } finally { emptyClient.clear(); }
  const errorClient = clientWithWorkspace();
  const errorQuery = errorClient.getQueryCache().find({ queryKey: workspaceTenantsKey(userId) });
  assert.ok(errorQuery);
  errorQuery.setState({ status: 'error', error: new SaasApiError(403, poisoned, poisoned, { token: poisoned }), fetchStatus: 'idle' });
  try {
    const html = renderWorkspace(errorClient);
    assert.match(html, /权限不足或安全校验已失效/); assert.doesNotMatch(html, /租户详情|Current owner/);
    assert.equal(html.includes(poisoned), false);
  } finally { errorClient.clear(); }
  for (const status of [401, 403, 409, 429, 500, 0]) {
    const error = new SaasApiError(status, poisoned, poisoned, { rawEmail: poisoned });
    const html = renderToStaticMarkup(React.createElement(WorkspaceErrorNotice, { error }));
    assert.match(html, /role="alert"/); assert.equal(html.includes(poisoned), false);
  }
  assert.match(workspaceErrorMessage(new SaasApiError(401, 'UNAUTHENTICATED', poisoned)), /重新登录/);
  assert.match(workspaceErrorMessage(new SaasApiError(409, 'CONFLICT', poisoned)), /核对后再提交/);
  assert.equal(workspaceMutationUnknown(new SaasApiError(409, 'CONFLICT', poisoned)), false);
  assert.equal(workspaceMutationUnknown(new SaasApiError(500, 'INTERNAL_ERROR', poisoned)), true);
  assert.equal(workspaceMutationUnknown(new SaasApiError(200, 'INVALID_RESPONSE', poisoned)), true);
  assert.equal(workspaceMutationUnknown(new Error(poisoned)), true);
});

test('member directory loading, denial and empty states use the real route contract, with no member mutation affordance', () => {
  for (const state of ['loading', 'empty', 'denied'] as const) {
    const client = clientWithWorkspace();
    const key = workspaceMembersKey(userId, tenantA);
    const query = client.getQueryCache().find({ queryKey: key }); assert.ok(query);
    if (state === 'loading') query.setState({ status: 'pending', data: undefined, fetchStatus: 'fetching' });
    else if (state === 'denied') query.setState({ status: 'error', error: new SaasApiError(403, poisoned, poisoned), fetchStatus: 'idle' });
    else client.setQueryData(key, { items: [], nextCursor: null });
    try {
      const html = renderWorkspace(client, `/console?tenantId=${tenantA}`);
      assert.match(html, state === 'loading' ? /正在加载租户成员/ : state === 'empty' ? /当前页暂无成员/ : /权限不足或安全校验已失效/);
      assert.doesNotMatch(html, /Current owner/); assert.equal(html.includes(disabledId), false); assert.equal(html.includes(poisoned), false);
      assert.doesNotMatch(html, />(?:移除成员|变更角色|转移 Owner)</);
    } finally { client.clear(); }
  }
});

test('project loading, empty and denied reads never assert authority from stale project facts or enable writes', () => {
  for (const state of ['loading', 'empty', 'denied'] as const) {
    const client = clientWithWorkspace();
    const key = workspaceProjectsKey(userId, tenantA);
    const query = client.getQueryCache().find({ queryKey: key }); assert.ok(query);
    if (state === 'loading') query.setState({ status: 'pending', data: undefined, fetchStatus: 'fetching' });
    else if (state === 'denied') query.setState({ status: 'error', error: new SaasApiError(403, poisoned, poisoned), fetchStatus: 'idle' });
    else client.setQueryData(key, []);
    try {
      const html = renderWorkspace(client, `/console?tenantId=${tenantA}`);
      assert.match(html, state === 'loading' ? /正在加载项目/ : state === 'empty' ? /当前租户暂无可访问项目/ : /权限不足或安全校验已失效/);
      assert.doesNotMatch(html, /aria-label="项目详情"/); assert.equal(html.includes(poisoned), false);
      if (state !== 'empty') {
        assert.match(html, /<button[^>]*disabled=""[^>]*>创建项目<\/button>/);
        assert.match(html, /<button[^>]*disabled=""[^>]*>邀请成员<\/button>/);
      }
    } finally { client.clear(); }
  }
});

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test('safe drafts are bounded tab storage, scoped across users/tenants, expire and exclude all invite secrets', () => {
  const storage = new MemoryStorage(); const now = 123_000;
  const projectScope: WorkspaceDraftScope = { userId, tenantId: tenantA, kind: 'project' };
  writeWorkspaceDraft(projectScope, { name: 'Draft project', slug: 'draft-project' }, storage, now);
  assert.deepEqual(readWorkspaceDraft(projectScope, storage, now + 1), { name: 'Draft project', slug: 'draft-project' });
  assert.deepEqual(readWorkspaceDraft({ ...projectScope, tenantId: tenantB }, storage, now), {});
  assert.deepEqual(readWorkspaceDraft({ ...projectScope, userId: 'other-user' }, storage, now), {});
  const inviteScope: WorkspaceDraftScope = { userId, tenantId: tenantA, kind: 'invitation' };
  writeWorkspaceDraft(inviteScope, { role: 'viewer', uncertain: true }, storage, now);
  assert.deepEqual(readWorkspaceDraft(inviteScope, storage, now), { role: 'viewer', uncertain: true });
  writeWorkspaceDraft(inviteScope, { role: 'viewer', email: poisoned, token: poisoned, password: poisoned } as WorkspaceDraft, storage, now);
  assert.deepEqual(readWorkspaceDraft(inviteScope, storage, now), {});
  for (const name of ['sk_fixtureabcdefghijkl', 'password=' + poisoned, 'authorization: ' + poisoned]) {
    writeWorkspaceDraft(projectScope, { name, uncertain: true }, storage, now);
    assert.deepEqual(readWorkspaceDraft(projectScope, storage, now), { uncertain: true });
  }
  assert.equal(JSON.stringify([...storage.values]).includes(poisoned), false);
  writeWorkspaceDraft(projectScope, { name: 'Short-lived' }, storage, now);
  assert.deepEqual(readWorkspaceDraft(projectScope, storage, now + 30 * 60_000), {});
  storage.setItem('unrelated-feature', 'keep');
  const otherScope = { ...projectScope, userId: 'other-user' };
  writeWorkspaceDraft(otherScope, { name: 'Other user draft' }, storage, now);
  clearWorkspaceDrafts(userId, storage);
  assert.deepEqual(readWorkspaceDraft(otherScope, storage, now), { name: 'Other user draft' });
  assert.equal(storage.getItem('unrelated-feature'), 'keep');
  removeWorkspaceDraft(otherScope, storage); assert.deepEqual(readWorkspaceDraft(otherScope, storage, now), {});
});

test('corrupt/future/oversized storage and disabled storage never expose errors or prevent use', () => {
  const storage = new MemoryStorage(); const scope: WorkspaceDraftScope = { userId, kind: 'tenant' };
  writeWorkspaceDraft(scope, { name: 'Valid' }, storage, 0);
  const key = storage.key(0); assert.ok(key);
  for (const raw of ['not-json', 'x'.repeat(2049), JSON.stringify({ value: { name: poisoned }, expiresAt: Infinity }),
    JSON.stringify({ value: { name: 'Future' }, expiresAt: 99999999 }), JSON.stringify({ value: { name: 'Past' }, expiresAt: -1 })]) {
    storage.setItem(key, raw); assert.deepEqual(readWorkspaceDraft(scope, storage, 0), {});
  }
  const blocked = { length: 0, key: () => null, getItem: () => { throw new Error(poisoned); }, setItem: () => { throw new Error(poisoned); }, removeItem: () => { throw new Error(poisoned); } };
  assert.deepEqual(readWorkspaceDraft(scope, blocked), {});
  assert.doesNotThrow(() => writeWorkspaceDraft(scope, { name: 'Valid' }, blocked));
  assert.doesNotThrow(() => clearWorkspaceDrafts(userId, blocked));
});

test('one-time invite link uses a fragment, drops selectors and keeps the existing mounted accept route', () => {
  const link = new URL(workspaceInvitationLink('test_only_invite_token', `https://workspace.example.test/admin/console?tenantId=${tenantA}&projectId=project-a`));
  assert.equal(link.pathname, '/admin/console/invitations/accept'); assert.equal(link.search, '');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), 'test_only_invite_token');
  assert.equal(workspaceInvitationLink('test_only_invite_token', 'https://workspace.example.test/console').includes('/admin/'), false);
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/console/invitations/accept'] }, React.createElement(WorkspaceInvitationAcceptance)));
  assert.match(html, /<h1>接受邀请<\/h1>/); assert.match(html, /邀请邮箱和个人信息/); assert.match(html, /不会重置已有密码/);
  assert.match(html, /邮箱、密码和邀请令牌不持久化/); assert.doesNotMatch(html, /公开注册入口|创建会话/);
});

test('workspace client uses real existing write/read routes, CSRF and strict allowlisted responses', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: 'mr_saas_csrf=test_only_csrf' } });
  const identity = { id: userId, email: 'invited@example.test', displayName: 'Invited', status: 'active', emailVerifiedAt: null, createdAt: date };
  const invitation = { invitationId: 'test-invitation', token: 'test_only_invitation', expiresAt: '2099-01-01T00:00:00.000Z' };
  const responses = [[{ ...owner, passwordHash: poisoned }], { ...owner, session: poisoned }, [{ ...projectA, token: poisoned }],
    { ...projectA, key: poisoned }, { ...invitation, digest: poisoned }, { ...identity, password: poisoned },
    { items: [{ userId, displayName: 'Owner', role: 'owner', status: 'active', email: poisoned, passwordHash: poisoned }], nextCursor: null, secret: poisoned }];
  globalThis.fetch = async (input, init) => {
    const data = responses[calls.length]; calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ data }), { status: 200 });
  };
  const tenants = await saasClient.getTenants(); const createdTenant = await saasClient.createTenant({ name: owner.name });
  const projects = await saasClient.getProjects(tenantA); const createdProject = await saasClient.createProject(tenantA, { name: projectA.name });
  const issued = await saasClient.createInvitation(tenantA, { email: 'invited@example.test', role: 'viewer' });
  const accepted = await saasClient.acceptInvitation({ token: invitation.token, email: identity.email, displayName: 'Invited', password: 'test-only-current-password' });
  const members = await saasClient.getTenantMembers(tenantA, { limit: 25, cursor: 'tm1.test_cursor' });
  assert.deepEqual(tenants, [owner]); assert.deepEqual(createdTenant, owner); assert.deepEqual(projects, [projectA]); assert.deepEqual(createdProject, projectA);
  assert.deepEqual(issued, invitation); assert.deepEqual(accepted, identity);
  assert.deepEqual(members, { items: [{ userId, displayName: 'Owner', role: 'owner', status: 'active' }], nextCursor: null });
  assert.equal(JSON.stringify([tenants, createdTenant, projects, createdProject, issued, accepted, members]).includes(poisoned), false);
  assert.deepEqual(calls.map(call => [call.url, call.init.method]), [
    ['/console/api/v1/tenants', 'GET'], ['/console/api/v1/tenants', 'POST'],
    [`/console/api/v1/tenants/${tenantA}/projects`, 'GET'], [`/console/api/v1/tenants/${tenantA}/projects`, 'POST'],
    [`/console/api/v1/tenants/${tenantA}/invitations`, 'POST'], ['/console/api/v1/invitations/accept', 'POST'],
    [`/console/api/v1/tenants/${tenantA}/members?limit=25&cursor=tm1.test_cursor`, 'GET'],
  ]);
  assert.equal(new Headers(calls[6]!.init.headers).get('x-csrf-token'), null);
  for (const index of [1, 3, 4, 5]) assert.equal(new Headers(calls[index]!.init.headers).get('x-csrf-token'), 'test_only_csrf');
  assert.equal(calls[6]!.init.body, undefined);
});

test('workspace client rejects malformed success metadata and sanitizes network/HTTP failures including unknown codes', async () => {
  for (const [request, data] of [
    [() => saasClient.getTenants(), [{ ...owner, role: 'superadmin' }]],
    [() => saasClient.getTenants(), [owner, owner]],
    [() => saasClient.getProjects(tenantA), [projectB]],
    [() => saasClient.createInvitation(tenantA, { email: 'invited@example.test', role: 'viewer' }), { invitationId: 'id', token: '<invalid>', expiresAt: date }],
    [() => saasClient.getTenantMembers(tenantA), { items: [{ userId, displayName: null, role: 'owner', status: 'unreviewed' }], nextCursor: null }],
    [() => saasClient.getTenantMembers(tenantA), { items: Array.from({ length: 101 }, () => ({ userId, displayName: null, role: 'owner', status: 'active' })), nextCursor: null }],
  ] as Array<[() => Promise<unknown>, unknown]>) {
    globalThis.fetch = async () => new Response(JSON.stringify({ data }), { status: 200 });
    await assert.rejects(request, (error: unknown) => error instanceof SaasApiError && error.code === 'INVALID_RESPONSE' && !String(error).includes(poisoned));
  }
  for (const status of [401, 403, 409, 429, 500]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: poisoned, message: poisoned, details: { rawEmail: poisoned } }, data: { token: poisoned } }), { status });
    await assert.rejects(saasClient.getTenantMembers(tenantA), (error: unknown) => {
      assert.ok(error instanceof SaasApiError); assert.equal(error.status, status); assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.details, undefined); assert.equal(error.data, undefined); assert.equal(String(error).includes(poisoned), false); return true;
    });
  }
  globalThis.fetch = async () => { throw new Error(poisoned); };
  await assert.rejects(saasClient.getTenants(), (error: unknown) => error instanceof SaasApiError && error.code === 'NETWORK' && !String(error).includes(poisoned));
  let requests = 0; globalThis.fetch = async () => { requests++; return new Response('{}'); };
  assert.throws(() => saasClient.getTenantMembers(tenantA, { limit: 101 }), SaasApiError);
  assert.throws(() => saasClient.getTenantMembers(tenantA, { cursor: 'not-canonical' }), SaasApiError);
  assert.equal(requests, 0);
});
