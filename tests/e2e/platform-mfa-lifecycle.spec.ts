import { resolve } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { createServer as createViteServer } from 'vite';

const TOKEN = 'synthetic-browser-cli-enrollment-token';
const CONFIRMATION = 'synthetic-browser-confirmation-token';
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/model-router:operator%40example.test?secret=${SECRET}&issuer=model-router`;
const START = '/admin/api/v1/auth/mfa/enrollment/start';
const CONFIRM = '/admin/api/v1/auth/mfa/enrollment/confirm';
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
let origin = '';

test.beforeAll(async () => {
  vite = await createViteServer({
    configFile: resolve('web/vite.config.ts'), root: resolve('web'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const site = vite.resolvedUrls?.local[0];
  if (!site) throw new Error('MFA browser fixture did not expose a local URL');
  origin = new URL(site).origin;
});

test.afterAll(async () => { await vite?.close(); });

function gate() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release() { if (!release) throw new Error('MFA fixture gate unavailable'); release(); } };
}

function enrollment(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  return { otpauthUri: URI, confirmationToken: CONFIRMATION, expiresAt };
}

async function mockApi(page: Page, handlers: {
  start?: (route: Route) => Promise<void>;
  confirm?: (route: Route) => Promise<void>;
} = {}) {
  const calls: { starts: number; confirms: number; logins: number; urls: string[]; unexpected: string[] } = {
    starts: 0, confirms: 0, logins: 0, urls: [], unexpected: [],
  };
  await page.route('**/admin/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    calls.urls.push(request.url());
    if (url.pathname === '/admin/api/v1/auth/session') {
      if (request.method() === 'POST') {
        ++calls.logins;
        // Enrollment is not login, and this unconfigured fixture cannot grant a session.
        return route.fulfill({ status: 401, json: { error: { code: 'INVALID_CREDENTIALS' } } });
      }
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } });
    }
    if (url.pathname === START) {
      ++calls.starts;
      expect(request.method()).toBe('POST');
      expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.postDataJSON()).toEqual({ issuer: 'model-router' });
      if (handlers.start) return handlers.start(route);
      return route.fulfill({ status: 200, json: { data: enrollment() } });
    }
    if (url.pathname === CONFIRM) {
      ++calls.confirms;
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({ confirmationToken: CONFIRMATION, code: '123456' });
      if (handlers.confirm) return handlers.confirm(route);
      return route.fulfill({ status: 200, json: { data: { confirmed: true } } });
    }
    calls.unexpected.push(url.pathname);
    return route.fulfill({ status: 503, json: { error: { code: 'MFA_FIXTURE_UNEXPECTED_ROUTE' } } });
  });
  return calls;
}

async function openEnrollment(page: Page) {
  await page.goto(`${origin}/admin/platform/mfa/enroll`);
  await expect(page.getByRole('heading', { name: '配置平台 MFA', exact: true })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('unrelated-lifecycle-fixture', 'preserve-local');
    sessionStorage.setItem('unrelated-lifecycle-fixture', 'preserve-session');
  });
  await page.getByLabel('一次性配置令牌', { exact: true }).fill(TOKEN);
}

async function assertNoPersistence(page: Page, urls: readonly string[]) {
  const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).toEqual({
    local: { 'unrelated-lifecycle-fixture': 'preserve-local' },
    session: { 'unrelated-lifecycle-fixture': 'preserve-session' },
  });
  const locations = [page.url(), ...urls];
  for (const value of locations) {
    expect(new URL(value).search).toBe('');
    expect(new URL(value).hash).toBe('');
    for (const sensitive of [TOKEN, CONFIRMATION, SECRET, '123456', URI]) expect(value).not.toContain(sensitive);
  }
  const cookies = JSON.stringify(await page.context().cookies());
  for (const sensitive of [TOKEN, CONFIRMATION, SECRET, '123456']) expect(cookies).not.toContain(sensitive);
}

async function assertNoSensitiveDisplay(page: Page) {
  await expect(page.getByLabel('MFA 配置 URI', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('认证器验证码', { exact: true })).toHaveCount(0);
  for (const sensitive of [TOKEN, CONFIRMATION, SECRET, URI, '123456']) {
    await expect(page.locator('body')).not.toContainText(sensitive);
  }
}

test('double submit dispatches once per operation, clears submission secrets, and confirmation never grants login', async ({ page }) => {
  const startGate = gate();
  const confirmGate = gate();
  const calls = await mockApi(page, {
    start: async route => { await startGate.promise; await route.fulfill({ status: 200, json: { data: enrollment() } }); },
    confirm: async route => { await confirmGate.promise; await route.fulfill({ status: 200, json: { data: { confirmed: true } } }); },
  });
  try {
    await openEnrollment(page);
    const startRequest = page.waitForRequest(request => new URL(request.url()).pathname === START);
    await page.locator('form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await startRequest;
    await expect(page.getByLabel('一次性配置令牌', { exact: true })).toHaveValue('');
    expect(calls.starts).toBe(1);
    startGate.release();
    await expect(page.getByLabel('MFA 配置 URI', { exact: true })).toHaveText(URI);
    await page.getByLabel('认证器验证码', { exact: true }).fill('123456');
    const confirmRequest = page.waitForRequest(request => new URL(request.url()).pathname === CONFIRM);
    await page.locator('form').evaluate(form => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await confirmRequest;
    await expect(page.getByRole('status')).toContainText('正在确认 MFA');
    await assertNoSensitiveDisplay(page);
    expect(calls.confirms).toBe(1);
    confirmGate.release();
    await expect(page.getByRole('heading', { name: 'MFA 已配置', exact: true })).toBeVisible();
    await assertNoSensitiveDisplay(page);
    expect(calls).toMatchObject({ starts: 1, confirms: 1, logins: 0, unexpected: [] });
    await assertNoPersistence(page, calls.urls);
    await page.getByRole('link', { name: '返回登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '平台管理员登录', exact: true })).toBeVisible();
    await page.getByLabel('管理员邮箱').fill('operator@example.test');
    await page.getByLabel('密码', { exact: true }).fill('synthetic-browser-password');
    await page.getByLabel(/^MFA 验证码/).fill('123456');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('邮箱、密码或 MFA 验证码不正确');
    await expect(page.getByRole('heading', { name: '平台管理员工作区', exact: true })).toHaveCount(0);
    expect(calls.logins).toBe(1);
  } finally {
    startGate.release(); confirmGate.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('expiry removes URI and an unsubmitted OTP without another start or confirm request', async ({ page }) => {
  const time = new Date('2030-01-01T00:00:00.000Z');
  await page.clock.install({ time });
  const calls = await mockApi(page, {
    start: route => route.fulfill({ status: 200, json: { data: enrollment(new Date(time.getTime() + 10_000).toISOString()) } }),
  });
  await openEnrollment(page);
  await page.getByRole('button', { name: '生成 MFA 配置', exact: true }).click();
  await expect(page.getByLabel('MFA 配置 URI', { exact: true })).toHaveText(URI);
  await page.getByLabel('认证器验证码', { exact: true }).fill('123456');
  await page.clock.runFor(10_001);
  await expect(page.getByRole('alert')).toContainText('配置已过期');
  await expect(page.getByRole('alert')).toContainText('安全 CLI');
  await assertNoSensitiveDisplay(page);
  await expect(page.getByRole('button', { name: '确认 MFA', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成 MFA 配置', exact: true })).toHaveCount(0);
  expect(calls).toMatchObject({ starts: 1, confirms: 0, logins: 0, unexpected: [] });
  await assertNoPersistence(page, calls.urls);
});

test('cancelled start stays unknown and a late reply cannot repopulate the current or revisited page', async ({ page }) => {
  const startGate = gate();
  const calls = await mockApi(page, {
    start: async route => { await startGate.promise; await route.fulfill({ status: 200, json: { data: enrollment() } }); },
  });
  try {
    await openEnrollment(page);
    const request = page.waitForRequest(request => new URL(request.url()).pathname === START);
    await page.getByRole('button', { name: '生成 MFA 配置', exact: true }).click();
    await request;
    await page.getByRole('button', { name: '取消并清除配置', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('操作结果未知');
    await expect(page.getByRole('alert')).toContainText('不能证明服务端未生效');
    await assertNoSensitiveDisplay(page);
    startGate.release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('alert')).toContainText('操作结果未知');
    await page.getByRole('link', { name: '返回登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '平台管理员登录', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '首次配置 MFA', exact: true }).click();
    await expect(page.getByLabel('一次性配置令牌', { exact: true })).toHaveValue('');
    await assertNoSensitiveDisplay(page);
    expect(calls).toMatchObject({ starts: 1, confirms: 0, logins: 0, unexpected: [] });
    await assertNoPersistence(page, calls.urls);
  } finally { startGate.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('leaving a pending confirmation isolates late success from a fresh enrollment page', async ({ page }) => {
  const confirmGate = gate();
  const calls = await mockApi(page, {
    confirm: async route => { await confirmGate.promise; await route.fulfill({ status: 200, json: { data: { confirmed: true } } }); },
  });
  try {
    await openEnrollment(page);
    await page.getByRole('button', { name: '生成 MFA 配置', exact: true }).click();
    await expect(page.getByLabel('MFA 配置 URI', { exact: true })).toHaveText(URI);
    await page.getByLabel('认证器验证码', { exact: true }).fill('123456');
    const request = page.waitForRequest(request => new URL(request.url()).pathname === CONFIRM);
    await page.getByRole('button', { name: '确认 MFA', exact: true }).click();
    await request;
    await page.getByRole('link', { name: '返回登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '平台管理员登录', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '首次配置 MFA', exact: true }).click();
    await expect(page.getByLabel('一次性配置令牌', { exact: true })).toHaveValue('');
    confirmGate.release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('heading', { name: '配置平台 MFA', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'MFA 已配置', exact: true })).toHaveCount(0);
    await assertNoSensitiveDisplay(page);
    expect(calls).toMatchObject({ starts: 1, confirms: 1, logins: 0, unexpected: [] });
    await assertNoPersistence(page, calls.urls);
  } finally { confirmGate.release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('raw sensitive confirmation errors are never rendered and a rejected confirmation clears the configuration', async ({ page }) => {
  const raw = `${TOKEN} ${CONFIRMATION} ${URI} 123456 <img src=x onerror=window.mfaErrorLeak=1>`;
  const calls = await mockApi(page, {
    confirm: route => route.fulfill({ status: 401, json: { error: { code: 'MFA_CONFIRMATION_INVALID', message: raw, requestId: raw } } }),
  });
  await openEnrollment(page);
  await page.getByRole('button', { name: '生成 MFA 配置', exact: true }).click();
  await expect(page.getByLabel('MFA 配置 URI', { exact: true })).toHaveText(URI);
  await page.getByLabel('认证器验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '确认 MFA', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('服务端拒绝了验证码或确认令牌');
  await expect(page.getByRole('alert')).toContainText('先返回登录验证');
  await assertNoSensitiveDisplay(page);
  await expect(page.locator('body')).not.toContainText(raw);
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'mfaErrorLeak'))).toBeUndefined();
  expect(calls).toMatchObject({ starts: 1, confirms: 1, logins: 0, unexpected: [] });
  await assertNoPersistence(page, calls.urls);
});

test('network loss is unknown, not permission to retry or reissue', async ({ page }) => {
  const calls = await mockApi(page, { start: route => route.abort('failed') });
  await openEnrollment(page);
  await page.getByRole('button', { name: '生成 MFA 配置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果未知');
  await expect(page.getByRole('alert')).toContainText('请勿直接重试');
  await assertNoSensitiveDisplay(page);
  await expect(page.getByRole('button', { name: '生成 MFA 配置', exact: true })).toHaveCount(0);
  expect(calls).toMatchObject({ starts: 1, confirms: 0, logins: 0, unexpected: [] });
  await assertNoPersistence(page, calls.urls);
});

test('malformed confirmation response is unknown and clears secrets without treating it as a failed enrollment', async ({ page }) => {
  const raw = `${TOKEN} ${CONFIRMATION} ${URI} 123456`;
  const calls = await mockApi(page, {
    confirm: route => route.fulfill({ status: 200, contentType: 'text/plain', body: raw }),
  });
  await openEnrollment(page);
  await page.getByRole('button', { name: '生成 MFA 配置', exact: true }).click();
  await expect(page.getByLabel('MFA 配置 URI', { exact: true })).toHaveText(URI);
  await page.getByLabel('认证器验证码', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '确认 MFA', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果未知');
  await expect(page.getByRole('alert')).toContainText('先返回登录验证');
  await assertNoSensitiveDisplay(page);
  await expect(page.getByRole('heading', { name: 'MFA 已配置', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认 MFA', exact: true })).toHaveCount(0);
  expect(calls).toMatchObject({ starts: 1, confirms: 1, logins: 0, unexpected: [] });
  await assertNoPersistence(page, calls.urls);
});
