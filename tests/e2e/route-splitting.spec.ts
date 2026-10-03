import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

// Real existing admin HTTP/UI, no provider calls or fake CRUD. Vite's native
// module requests prove demand loading in development, not production bytes.
// Luna must separately build and inspect the fresh initial/chunk sizes.
function observe(page: Page) {
  const modules = new Map<string, number>(); const mutations: string[] = [];
  let sequence = 0;
  const moduleEvents: Array<{ name: string; sequence: number }> = [];
  const sessionEvents: Array<{ sequence: number; confirmedUser: Promise<boolean> }> = [];
  const onRequest = (request: Request) => {
    const path = new URL(request.url()).pathname;
    const match = /\/src\/features\/([^/]+)\.tsx$/.exec(path);
    if (request.resourceType() === 'script' && match) {
      modules.set(match[1], (modules.get(match[1]) ?? 0) + 1);
      moduleEvents.push({ name: match[1], sequence: ++sequence });
    }
    if (path.includes('/api/v1/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(request.method());
  };
  const onResponse = (response: Response) => {
    if (new URL(response.url()).pathname !== '/admin/api/v1/session' || response.request().method() !== 'GET' || response.status() !== 200) return;
    // Capture response-event order synchronously, before parsing its body.
    // Retain only a boolean authority proof, never userId, CSRF/cookies/body.
    const order = ++sequence;
    const confirmedUser = response.json().then((body: unknown) => {
      if (!body || typeof body !== 'object' || !('data' in body)) return false;
      const data = body.data;
      return Boolean(data && typeof data === 'object' && 'userId' in data && typeof data.userId === 'string' && data.userId.length > 0);
    }).catch(() => false); // Missing/malformed proof fails the assertion, not an auth bypass.
    sessionEvents.push({ sequence: order, confirmedUser });
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  return { modules, mutations, moduleEvents, sessionEvents, checkpoint: () => sequence,
    close: () => { page.off('request', onRequest); page.off('response', onResponse); } };
}

test('auth gating defers feature modules; pending routes keep Shell, then cache the module and safe draft', async ({ page }) => {
  const app = await startConsole(page); const seen = observe(page);
  let release = () => {};
  try {
    await page.goto(app.site);
    await expect(page.getByRole('heading', { name: '创建管理员' })).toBeVisible();
    expect([...seen.modules.keys()]).toEqual(['auth']);
    await page.getByLabel('初始化令牌').fill('local-e2e-bootstrap-token');
    await page.getByLabel('管理员用户名').fill('admin');
    await page.getByLabel('管理员密码').fill('long-e2e-password');
    await page.getByRole('button', { name: '创建管理员' }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect([...seen.modules.keys()]).toEqual(['auth']);
    await page.getByLabel('用户名').fill('admin'); await page.getByLabel('密码', { exact: true }).fill('long-e2e-password');
    const loginStarted = seen.checkpoint();
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '初始引导' })).toBeVisible();
    // Unchanged legacy Login awaits session invalidation before config+guide
    // navigation. AdminApp may first navigate a now-authenticated /login to
    // its default overview. This optional authorized race is not preloading.
    const authorizedModules = ['auth', 'setup-guide', 'overview'];
    expect(seen.modules.has('auth')).toBe(true); expect(seen.modules.has('setup-guide')).toBe(true);
    expect([...seen.modules.keys()].filter(name => !authorizedModules.includes(name))).toEqual([]);
    const sessions = await Promise.all(seen.sessionEvents.map(async event => ({
      sequence: event.sequence, confirmedUser: await event.confirmedUser,
    })));
    const authorizedAfterLogin = sessions.filter(event => event.confirmedUser && event.sequence > loginStarted).map(event => event.sequence);
    expect(authorizedAfterLogin.length, 'a real successful GET session must confirm the authenticated actor').toBeGreaterThan(0);
    const authorizedAt = Math.min(...authorizedAfterLogin);
    for (const event of seen.moduleEvents.filter(event => event.name !== 'auth')) {
      expect(event.sequence, `${event.name} module must be requested after the confirmed authorized session response`).toBeGreaterThan(authorizedAt);
    }

    let imports = 0;
    const gate = new Promise<void>(resolve => { release = () => resolve(); });
    await page.route('**/src/features/routes.tsx*', async route => { imports++; await gate; await route.continue(); });
    const writes = seen.mutations.length;
    await page.getByRole('link', { name: '模型与路由', exact: true }).click();
    await expect.poll(() => imports).toBe(1);
    await expect(page.getByRole('status').filter({ hasText: '正在加载页面' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    expect(seen.mutations.length).toBe(writes);
    expect(seen.modules.has('keys')).toBe(false); expect(seen.modules.has('saas-console')).toBe(false);
    expect(seen.modules.has('saas-platform')).toBe(false);
    expect([...seen.modules.keys()].filter(name => ![...authorizedModules, 'routes'].includes(name))).toEqual([]);
    release();
    await expect(page.getByRole('heading', { name: '模型与路由', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新增路由', exact: true }).click();
    await page.getByLabel('名称', { exact: true }).fill('ENG-01 safe route draft');
    await page.getByLabel('客户端模型 / 匹配值').fill('eng-only-model');
    await page.getByRole('link', { name: '访问 Key', exact: true }).click();
    await expect(page.getByRole('heading', { name: '访问 Key', exact: true, level: 1 })).toBeVisible();
    expect(seen.modules.has('keys')).toBe(true);
    await page.getByRole('link', { name: '模型与路由', exact: true }).click();
    await expect(page.getByLabel('名称', { exact: true })).toHaveValue('ENG-01 safe route draft');
    await expect(page.getByLabel('客户端模型 / 匹配值')).toHaveValue('eng-only-model');
    expect(imports).toBe(1); expect(seen.mutations.length).toBe(writes);
    expect([...seen.modules.keys()].filter(name => ![...authorizedModules, 'routes', 'keys'].includes(name))).toEqual([]);
  } finally { release(); seen.close(); await app.close(); }
});

test('deep-link filters survive reload; revoked session still gates the module and returns through existing login', async ({ page }) => {
  const app = await startConsole(page, { withTelemetry: true }); const seen = observe(page);
  try {
    await setupAndLogin(page, app.site);
    await expect(page.getByRole('heading', { name: '初始引导' })).toBeVisible();
    const path = '/admin/requests/eng-route-missing'; const filters = '?status=failed&model=eng-model&keyId=eng-key';
    await page.goto(app.origin + path + filters);
    await expect(page.getByRole('heading', { name: '请求日志', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '请求详情', exact: true })).toBeVisible();
    await expect(page.getByLabel('模型筛选')).toHaveValue('eng-model');
    await expect(page.getByLabel('Key ID 筛选')).toHaveValue('eng-key');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path + filters);
    await page.reload();
    await expect(page.getByRole('heading', { name: '请求详情', exact: true })).toBeVisible();
    await expect(page.getByLabel('模型筛选')).toHaveValue('eng-model');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path + filters);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    const imports = seen.modules.get('requests') ?? 0;
    await page.goto(app.origin + path + filters);
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(seen.modules.get('requests') ?? 0).toBe(imports);
    await expect(page.getByRole('heading', { name: '请求详情', exact: true })).toHaveCount(0);
    await page.getByLabel('用户名').fill('admin'); await page.getByLabel('密码', { exact: true }).fill('long-e2e-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '请求详情', exact: true })).toBeVisible();
    // The existing safeReturnPath stores only pathname, not arbitrary search.
    expect(new URL(page.url()).pathname).toBe(path); expect(new URL(page.url()).search).toBe('');
  } finally { seen.close(); await app.close(); }
});

test('failed native page load is safe, has no automatic retry, and leaves authenticated navigation usable', async ({ page }) => {
  const app = await startConsole(page); const seen = observe(page);
  try {
    await setupAndLogin(page, app.site);
    await expect(page.getByRole('heading', { name: '初始引导' })).toBeVisible();
    let attempts = 0;
    await page.route('**/src/features/settings.tsx*', route => { attempts++; return route.abort('failed'); });
    const writes = seen.mutations.length;
    await page.getByRole('link', { name: '系统设置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('页面加载失败');
    await expect(page.getByRole('button', { name: '重新加载页面', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.locator('#main')).not.toContainText('Failed to fetch');
    await expect(page.locator('#main')).not.toContainText('/src/features/settings.tsx');
    expect(attempts).toBe(1); expect(seen.mutations.length).toBe(writes);
    await page.getByRole('link', { name: '模型与路由', exact: true }).click();
    await expect(page.getByRole('heading', { name: '模型与路由', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新加载页面', exact: true })).toHaveCount(0);
    expect(attempts).toBe(1); expect(seen.mutations.length).toBe(writes);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
  } finally { seen.close(); await app.close(); }
});

test('lazy customer namespace preserves invitation fragment scrubbing, safe name draft and secret clearing', async ({ page }) => {
  const app = await startConsole(page); const seen = observe(page);
  try {
    const token = 'eng-test-only-invitation-token';
    await page.goto(`${app.origin}/admin/console/invitations/accept#token=${token}`);
    await expect(page.getByRole('heading', { name: '接受邀请', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/console\/invitations\/accept$/);
    await expect(page.getByLabel('邀请令牌')).toHaveValue(token);
    await page.getByLabel('姓名').fill('ENG safe invited name');
    await page.getByLabel('邮箱', { exact: true }).fill('eng-private@example.test');
    await page.getByLabel(/^密码/).fill('eng-test-only-password');
    const stored = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
    expect(stored).not.toContain(token); expect(stored).not.toContain('eng-private@example.test');
    expect(stored).not.toContain('eng-test-only-password');
    expect(seen.modules.has('saas-console')).toBe(true);
    expect(seen.modules.has('auth')).toBe(false); expect(seen.modules.has('saas-platform')).toBe(false);
    expect(seen.mutations).toEqual([]);
    await page.reload();
    await expect(page.getByRole('heading', { name: '接受邀请', exact: true })).toBeVisible();
    await expect(page.getByLabel('姓名')).toHaveValue('ENG safe invited name');
    await expect(page.getByLabel('邀请令牌')).toHaveValue('');
    await expect(page.getByLabel(/^密码/)).toHaveValue('');
    expect(seen.mutations).toEqual([]);
  } finally { seen.close(); await app.close(); }
});
