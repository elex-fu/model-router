import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer as createViteServer } from 'vite';

test('first-run setup, login, navigation, config save and revision conflict', async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), 'model-router-e2e-'));
  const { createAdminServer } = await import('../../dist/admin/server.js');
  let adminOrigin = '';
  const admin = createAdminServer({
    configPath: join(directory, 'config.json'),
    bootstrapToken: 'local-e2e-bootstrap-token',
    bootstrapExpiresAt: Date.now() + 60_000,
    publicOrigin: () => adminOrigin,
  });
  let vite: ViteDevServer | undefined;
  let listening = false;
  try {
    admin.server.listen(0, '127.0.0.1');
    await once(admin.server, 'listening');
    listening = true;
    const address = (admin.server as Server).address();
    if (!address || typeof address === 'string') throw new Error('Admin listener did not get a TCP port');
    adminOrigin = `http://127.0.0.1:${address.port}`;

    process.env.ADMIN_API_TARGET = adminOrigin;
    process.env.ADMIN_PUBLIC_ORIGIN = adminOrigin;
    vite = await createViteServer({
      configFile: resolve('web/vite.config.ts'),
      root: resolve('web'),
      server: { host: '127.0.0.1', port: 0 },
    });
    await vite.listen();
    const site = vite.resolvedUrls?.local[0];
    if (!site) throw new Error('Vite did not expose a local URL');
    const siteOrigin = new URL(site).origin;
    const configUrl = `${siteOrigin}/admin/api/v1/config`;

    await page.goto(site);
    await expect(page.getByRole('heading', { name: '创建管理员' })).toBeVisible();
    await page.getByLabel('初始化令牌').fill('local-e2e-bootstrap-token');
    await page.getByLabel('管理员用户名').fill('admin');
    await page.getByLabel('管理员密码').fill('long-e2e-password');
    await page.getByRole('button', { name: '创建管理员' }).click();
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();

    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('long-e2e-password');
    await page.getByRole('button', { name: '登录' }).click();
    await expect(page.getByRole('heading', { name: '初始引导' })).toBeVisible();
    await page.getByRole('link', { name: '系统设置' }).click();
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

    const editor = page.getByLabel('脱敏配置 JSON');
    await expect(editor).toBeVisible();
    const first = JSON.parse(await editor.inputValue());
    expect(first.revision).toBe(1);
    first.quota.defaultMaxConcurrentRequests = 11;
    await editor.fill(JSON.stringify(first, null, 2));
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(async () => {
        const response = await page.request.get(configUrl);
        return (await response.json()).data.revision;
      })
      .toBe(2);

    await expect(editor).toBeVisible();
    const draft = JSON.parse(await editor.inputValue());
    draft.quota.defaultMaxConcurrentRequests = 12;
    await editor.fill(JSON.stringify(draft, null, 2));
    let injected = false;
    let putCount = 0;
    await page.route(configUrl, async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      putCount += 1;
      injected = true;
      const current = (await (await page.request.get(configUrl)).json()).data;
      const csrfToken = route.request().headers()['x-csrf-token'];
      expect(csrfToken).toBeTruthy();
      current.quota.defaultMaxConcurrentRequests = 13;
      const competing = await page.request.put(configUrl, {
        data: current,
        headers: {
          Origin: siteOrigin,
          'X-CSRF-Token': csrfToken,
          'If-Match': `"cfg-${current.revision}"`,
        },
      });
      expect(competing.status()).toBe(200);
      await route.continue();
    });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const conflictPanel = page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: '配置版本冲突' }) });
    await expect(conflictPanel).toBeVisible();
    await expect(conflictPanel).toContainText('草稿保留在当前页面');
    await expect(conflictPanel).toContainText('编辑基于 v2；最新配置为 v3。');
    const conflictedField = conflictPanel.locator('[data-conflict-path="quota.defaultMaxConcurrentRequests"]');
    await expect(conflictedField).toBeVisible();
    await expect(conflictedField).toContainText('我的草稿');
    await expect(conflictedField).toContainText('11');
    await expect(conflictedField).toContainText('12');
    await expect(conflictedField).toContainText('13');
    expect(injected).toBe(true);
    expect(putCount).toBe(1);
  } finally {
    await vite?.close();
    if (listening) await admin.close();
    else admin.store.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.ADMIN_API_TARGET;
    delete process.env.ADMIN_PUBLIC_ORIGIN;
  }
});
