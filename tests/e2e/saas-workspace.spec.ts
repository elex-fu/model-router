import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

// Browser contract fixtures exercise real UI and existing identity routes,
// including the implemented readonly directory. They do not assert PG/ACL proof.
const userId = '10000000-0000-4000-8000-000000000001';
const disabledId = '10000000-0000-4000-8000-000000000002';
const tenantA = '20000000-0000-4000-8000-000000000001';
const tenantB = '20000000-0000-4000-8000-000000000002';
const date = '2026-10-01T00:00:00.000Z';
const owner = { id: tenantA, name: 'Owner workspace', slug: 'owner-team', role: 'owner', status: 'active', createdAt: date, updatedAt: date, defaultProjectId: 'project-a' };
const viewer = { ...owner, id: tenantB, name: 'Viewer workspace', slug: 'viewer-team', role: 'viewer', defaultProjectId: 'project-b' };
const projectA = { id: 'project-a', tenantId: tenantA, name: 'Viewer scoped project', slug: 'viewer-project', role: 'viewer', createdAt: date, updatedAt: date };
const projectB = { ...projectA, id: 'project-b', tenantId: tenantB, name: 'Developer scoped project', role: 'developer' };
const fakeToken = 'test_only_workspace_invitation_token';
const fakePassword = 'test-only-existing-account-password';
const unsafeBody = 'raw-error-password-key-email-must-not-leak';
const nextCursor = 'tm1.' + Buffer.from(JSON.stringify({ kind: 'tenant-members', version: 1,
  scopeHash: createHash('sha256').update(JSON.stringify(['tenant-members', userId, tenantA])).digest('hex'), userId,
})).toString('base64url');

let vite: ViteDevServer | undefined;
let site = '';
test.beforeAll(async () => {
  vite = await createViteServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web'), server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const local = vite.resolvedUrls?.local[0];
  if (!local) throw new Error('Workspace browser fixture did not expose a local URL');
  site = new URL(local).origin;
});
test.afterAll(async () => { await vite?.close(); });

interface FixtureState {
  authenticated: boolean;
  tenants: Array<typeof owner>;
  tenantError?: number;
  projectError?: number;
  memberError?: number;
  invitationError?: number;
  acceptError?: number;
  abortInvitation?: boolean;
  issued: number;
  accepted: number;
  projectWrites: number;
  directoryReads: Array<{ tenant: string; cursor: string | null }>;
  unexpected: string[];
}

async function installIdentity(page: Page, input: Partial<FixtureState> = {}) {
  const state: FixtureState = {
    authenticated: true, tenants: [owner, viewer], issued: 0, accepted: 0, projectWrites: 0,
    directoryReads: [], unexpected: [], ...input,
  };
  await page.route('**/console/api/v1/**', async route => {
    const request = route.request(); const url = new URL(request.url()); const method = request.method();
    const send = (data: unknown, status = 200) => route.fulfill({ status, json: { data } });
    const deny = (status: number) => {
      const codes: Record<number, string> = { 400: 'REQUEST_REJECTED', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 409: 'CONFLICT', 429: 'RATE_LIMITED', 500: 'INTERNAL_ERROR' };
      return route.fulfill({ status, json: { error: { code: codes[status] ?? 'HTTP_ERROR', message: unsafeBody, details: { rawEmail: unsafeBody } } } });
    };
    if (url.pathname === '/console/api/v1/auth/session') {
      if (method === 'DELETE') { state.authenticated = false; return send({ loggedOut: true }); }
      if (!state.authenticated) return deny(401);
      return send({ session: { userId, activeTenantId: null, createdAt: date, expiresAt: '2099-01-01T00:00:00.000Z' } });
    }
    if (url.pathname === '/console/api/v1/invitations/accept' && method === 'POST') {
      state.accepted++;
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['displayName', 'email', 'password', 'token']);
      expect(body.token).toBe(fakeToken); expect(body.password).toBe(fakePassword);
      if (state.acceptError) return deny(state.acceptError);
      return send({ id: userId, email: 'invited@example.test', displayName: String(body.displayName), status: 'active', emailVerifiedAt: null, createdAt: date });
    }
    if (url.pathname === '/console/api/v1/tenants' && method === 'GET') {
      if (state.tenantError) return deny(state.tenantError);
      return send(state.tenants);
    }
    const projectMatch = /^\/console\/api\/v1\/tenants\/([^/]+)\/projects$/.exec(url.pathname);
    if (projectMatch) {
      if (method === 'POST') {
        state.projectWrites++;
        return deny(state.projectError ?? 403);
      }
      if (state.projectError) return deny(state.projectError);
      return send(projectMatch[1] === tenantA ? [projectA] : [projectB]);
    }
    const memberMatch = /^\/console\/api\/v1\/tenants\/([^/]+)\/members$/.exec(url.pathname);
    if (memberMatch && method === 'GET') {
      state.directoryReads.push({ tenant: memberMatch[1], cursor: url.searchParams.get('cursor') });
      expect(url.searchParams.get('limit')).toBe('25');
      expect([...url.searchParams.keys()].every(key => key === 'limit' || key === 'cursor')).toBe(true);
      if (memberMatch[1] !== tenantA) return deny(403);
      if (state.memberError) return deny(state.memberError);
      return url.searchParams.has('cursor') ? send({ items: [{ userId: disabledId, displayName: null, role: 'billing', status: 'disabled' }], nextCursor: null }) :
        send({ items: [{ userId, displayName: 'Current owner', role: 'owner', status: 'active', email: unsafeBody, passwordHash: unsafeBody, session: unsafeBody, key: unsafeBody }], nextCursor });
    }
    if (url.pathname === `/console/api/v1/tenants/${tenantA}/invitations` && method === 'POST') {
      state.issued++;
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['email', 'role']); expect(body.role).not.toBe('owner');
      if (state.abortInvitation) return route.abort('failed');
      if (state.invitationError) return deny(state.invitationError);
      return send({ invitationId: 'test-only-invitation', token: fakeToken, expiresAt: '2099-01-01T00:00:00.000Z' }, 201);
    }
    state.unexpected.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Unexpected test route' } } });
  });
  await page.context().addCookies([{ name: 'mr_saas_csrf', value: 'test_only_csrf', url: site }]);
  return state;
}

function workspaceSection(page: Page, title: string) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

async function storageSnapshot(page: Page) {
  return page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
}

test('workspace switches two tenants without leaking project roles/members and preserves only scoped safe drafts', async ({ page }) => {
  const state = await installIdentity(page);
  await page.goto(`${site}/admin/console?tenantId=${tenantA}&projectId=project-a`);
  await expect(page.getByRole('heading', { name: '客户控制台' })).toBeVisible();
  await expect(workspaceSection(page, '租户详情')).toContainText('所有者');
  await expect(page.getByLabel('项目详情')).toContainText('只读成员');
  await expect(page.getByLabel('项目详情')).toContainText('项目生命周期状态');
  await expect(workspaceSection(page, '租户成员目录')).toContainText('Current owner');
  await expect(page.locator('body')).not.toContainText(unsafeBody);
  await page.getByRole('button', { name: '下一页成员' }).click();
  await expect(workspaceSection(page, '租户成员目录')).toContainText('账户已禁用');
  expect(state.directoryReads.some(read => read.cursor === nextCursor)).toBe(true);

  await page.getByLabel('项目名称').fill('Owner scoped draft');
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  await page.getByLabel('成员邮箱').fill('private-invited@example.test');
  await page.getByLabel('邀请租户角色').selectOption('billing');
  await page.reload();
  await expect(page.getByLabel('项目名称')).toHaveValue('Owner scoped draft');
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  await expect(page.getByLabel('邀请租户角色')).toHaveValue('billing');
  await expect(page.getByLabel('成员邮箱')).toHaveValue('');
  expect(await storageSnapshot(page)).not.toContain('private-invited@example.test');

  await workspaceSection(page, '我的租户').getByRole('button', { name: /Viewer workspace/ }).click();
  await expect(page).toHaveURL(new RegExp(`tenantId=${tenantB}`));
  expect(new URL(page.url()).searchParams.has('projectId')).toBe(false);
  await expect(page.getByLabel('项目详情')).toContainText('开发者');
  await expect(workspaceSection(page, '租户详情')).toContainText('只读成员');
  await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建项目', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Current owner');
  expect(state.directoryReads.every(read => read.tenant === tenantA)).toBe(true);

  await workspaceSection(page, '我的租户').getByRole('button', { name: /Owner workspace/ }).click();
  await expect(page.getByLabel('项目名称')).toHaveValue('Owner scoped draft');
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  await page.getByLabel('成员邮箱').fill('invited@example.test');
  await page.getByRole('button', { name: '创建一次性邀请' }).click();
  await expect(page.getByLabel('一次性邀请链接')).toHaveValue(new RegExp(`#token=${fakeToken}$`));
  const link = new URL(await page.getByLabel('一次性邀请链接').inputValue());
  expect(link.search).toBe(''); expect(link.pathname).toBe('/admin/console/invitations/accept');
  expect(await storageSnapshot(page)).not.toContain(fakeToken);
  expect(await storageSnapshot(page)).not.toContain('invited@example.test');
  await page.reload();
  await expect(page.getByLabel('一次性邀请链接')).toHaveCount(0);
  expect(state.issued).toBe(1); expect(state.projectWrites).toBe(0);
  expect(state.unexpected).toEqual([]);
});

test('admin invite scope, explicit selector refusal and 409/403 failure keep safe drafts without exposing response bodies', async ({ page }) => {
  const state = await installIdentity(page, { tenants: [{ ...owner, role: 'admin' }, viewer], invitationError: 409 });
  await page.goto(`${site}/admin/console?tenantId=${tenantA}`);
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  const options = page.getByLabel('邀请租户角色').locator('option');
  expect(await options.evaluateAll(items => items.map(item => (item as HTMLOptionElement).value))).toEqual(['developer', 'billing', 'viewer']);
  await page.getByLabel('成员邮箱').fill('invited@example.test');
  await page.getByLabel('邀请租户角色').selectOption('viewer');
  await page.getByRole('button', { name: '创建一次性邀请' }).click();
  await expect(page.getByRole('alert')).toContainText('操作冲突');
  await expect(page.getByLabel('成员邮箱')).toHaveValue('invited@example.test');
  await expect(page.getByLabel('邀请租户角色')).toHaveValue('viewer');
  await expect(page.getByLabel('一次性邀请链接')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(unsafeBody);
  state.invitationError = 403;
  await page.getByRole('button', { name: '创建一次性邀请' }).click();
  await expect(page.getByRole('alert')).toContainText('权限不足');
  await expect(page.getByLabel('邀请租户角色')).toHaveValue('viewer');
  expect(state.issued).toBe(2);
  await page.goto(`${site}/admin/console?tenantId=30000000-0000-4000-8000-000000000001`);
  await expect(page.getByRole('alert')).toContainText('指定租户不可访问');
  await expect(page.getByRole('heading', { name: '租户详情' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '邀请成员', exact: true })).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
});

test('lost invitation response blocks automatic/remount duplicate submission and never persists secrets', async ({ page }) => {
  const state = await installIdentity(page, { abortInvitation: true });
  await page.goto(`${site}/admin/console?tenantId=${tenantA}`);
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  await page.getByLabel('成员邮箱').fill('invited@example.test');
  await page.getByRole('button', { name: '创建一次性邀请' }).click();
  await expect(page.getByText('上次提交结果尚未确认，请勿直接重复提交。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建一次性邀请' })).toBeDisabled();
  expect(state.issued).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: '邀请成员', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建一次性邀请' })).toBeDisabled();
  await expect(page.getByLabel('成员邮箱')).toHaveValue('');
  expect(await storageSnapshot(page)).not.toContain('invited@example.test');
  expect(await storageSnapshot(page)).not.toContain(fakeToken);
  expect(state.issued).toBe(1);
  await page.getByRole('button', { name: '我已核对上次结果，允许手动重试' }).click();
  await expect(page.getByRole('button', { name: '创建一次性邀请' })).toBeEnabled();
  expect(state.issued).toBe(1); expect(state.unexpected).toEqual([]);
});

test('existing accept route scrubs the fragment, keeps only name draft, clears password on denial and never creates a session', async ({ page }) => {
  const state = await installIdentity(page, { authenticated: false, acceptError: 400 });
  await page.goto(`${site}/admin/console/invitations/accept#token=${fakeToken}`);
  await expect(page.getByRole('heading', { name: '接受邀请' })).toBeVisible();
  await expect(page.getByLabel('邀请令牌')).toHaveValue(fakeToken);
  await expect(page).toHaveURL(/\/admin\/console\/invitations\/accept$/);
  await page.getByLabel('邮箱', { exact: true }).fill('invited@example.test');
  await page.getByLabel('姓名').fill('Invited display name');
  await page.getByLabel(/^密码/).fill(fakePassword);
  await page.getByRole('button', { name: '接受邀请', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邀请也可能已过期、已使用或与邮箱不匹配');
  await expect(page.getByLabel(/^密码/)).toHaveValue('');
  await expect(page.getByLabel('姓名')).toHaveValue('Invited display name');
  await expect(page.locator('body')).not.toContainText(unsafeBody);
  expect(await storageSnapshot(page)).not.toContain(fakeToken);
  expect(await storageSnapshot(page)).not.toContain(fakePassword);
  expect(await storageSnapshot(page)).not.toContain('invited@example.test');
  await page.reload();
  await expect(page.getByLabel('姓名')).toHaveValue('Invited display name');
  await expect(page.getByLabel('邀请令牌')).toHaveValue('');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue('');
  state.acceptError = undefined;
  await page.getByLabel('邀请令牌').fill(fakeToken);
  await page.getByLabel('邮箱', { exact: true }).fill('invited@example.test');
  await page.getByLabel(/^密码/).fill(fakePassword);
  await page.getByRole('button', { name: '接受邀请', exact: true }).click();
  await expect(page.getByRole('heading', { name: '邀请已接受' })).toBeVisible();
  await expect(page.locator('body')).toContainText('接受邀请不会自动创建会话');
  expect(state.authenticated).toBe(false); expect(state.accepted).toBe(2);
  expect(await storageSnapshot(page)).not.toContain('Invited display name');
  expect(state.unexpected).toEqual([]);
});

test('workspace empty/failed reads and 401 revocation use safe states and clear only owned drafts', async ({ page }) => {
  const state = await installIdentity(page, { tenants: [] });
  await page.goto(`${site}/admin/console`);
  await expect(page.getByText('暂无可访问租户；可创建租户，或通过有效邀请加入。', { exact: true })).toBeVisible();
  await page.getByLabel('租户名称').fill('Safe tenant draft');
  await page.evaluate(() => sessionStorage.setItem('unrelated-feature-draft', 'preserve-this'));
  state.tenants = [owner, viewer]; state.tenantError = 500;
  await page.getByRole('button', { name: '刷新工作空间' }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法完成工作空间请求');
  await expect(page.getByLabel('租户名称')).toHaveValue('Safe tenant draft');
  await expect(page.locator('body')).not.toContainText(unsafeBody);
  await expect(page.getByRole('heading', { name: '租户详情' })).toHaveCount(0);
  state.tenantError = undefined;
  await page.getByRole('button', { name: '刷新工作空间' }).click();
  await expect(workspaceSection(page, '租户成员目录')).toContainText('Current owner');
  state.memberError = 403;
  await page.getByRole('button', { name: '刷新成员' }).click();
  await expect(workspaceSection(page, '租户成员目录').getByRole('alert')).toContainText('权限不足');
  await expect(workspaceSection(page, '租户成员目录')).not.toContainText('Current owner');
  await expect(page.getByRole('button', { name: '下一页成员' })).toBeDisabled();
  state.memberError = undefined; state.tenantError = 401; state.authenticated = false;
  await page.getByRole('button', { name: '刷新工作空间' }).click();
  await expect(page).toHaveURL(/\/admin\/console\/login$/);
  expect(await storageSnapshot(page)).not.toContain('Safe tenant draft');
  expect(await storageSnapshot(page)).toContain('preserve-this');
  expect(state.unexpected).toEqual([]);
});
