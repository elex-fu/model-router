import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { ViteDevServer } from 'vite';
import { createServer as createViteServer } from 'vite';
import type { AdminServerOptions } from '../../src/admin/server';

export async function startConsole(
  page: Page,
  options: Partial<AdminServerOptions> & { withTelemetry?: boolean; withQuota?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'model-router-e2e-'));
  const previousTarget = process.env.ADMIN_API_TARGET;
  const previousOrigin = process.env.ADMIN_PUBLIC_ORIGIN;
  const { createAdminServer } = await import('../../dist/admin/server.js');
  const { withTelemetry, withQuota, ...adminOptions } = options;
  const { SQLiteTelemetryStore } = await import('../../dist/storage/telemetry-store.js');
  const telemetry =
    withTelemetry || withQuota ? new SQLiteTelemetryStore(join(directory, 'telemetry.sqlite')) : undefined;
  await telemetry?.init();
  const quotaLedger =
    withQuota && telemetry ? new (await import('../../dist/quota/ledger.js')).SQLiteQuotaLedger(telemetry) : undefined;
  const quotaTimezoneVersions =
    withQuota && telemetry
      ? new (await import('../../dist/quota/timezone-versions.js')).QuotaTimezoneVersions(telemetry)
      : undefined;
  if (quotaTimezoneVersions) quotaTimezoneVersions.initialize('UTC');
  let adminOrigin = '';
  const admin = createAdminServer({
    ...adminOptions,
    ...(telemetry ? { telemetryStore: telemetry } : {}),
    ...(quotaLedger ? { quotaLedger } : {}),
    ...(quotaTimezoneVersions ? { quotaTimezoneVersions } : {}),
    configPath: join(directory, 'config.json'),
    bootstrapToken: 'local-e2e-bootstrap-token',
    bootstrapExpiresAt: Date.now() + 120_000,
    publicOrigin: () => adminOrigin,
  });
  let vite: ViteDevServer | undefined;
  let listening = false;
  try {
    admin.server.listen(0, '127.0.0.1');
    await once(admin.server, 'listening');
    listening = true;
    const address = (admin.server as Server).address();
    if (!address || typeof address === 'string') throw new Error('Admin listener has no TCP port');
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
    if (!site) throw new Error('Vite has no local URL');
    const origin = new URL(site).origin;
    return {
      directory,
      admin,
      telemetry,
      origin,
      site,
      api: (path: string) => `${origin}/admin/api/v1${path}`,
      async close() {
        try {
          await vite?.close();
        } finally {
          try {
            await admin.close();
          } finally {
            await telemetry?.close();
            rmSync(directory, { recursive: true, force: true });
            if (previousTarget === undefined) delete process.env.ADMIN_API_TARGET;
            else process.env.ADMIN_API_TARGET = previousTarget;
            if (previousOrigin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN;
            else process.env.ADMIN_PUBLIC_ORIGIN = previousOrigin;
          }
        }
      },
    };
  } catch (error) {
    await vite?.close();
    if (listening) await admin.close();
    else admin.store.close();
    await telemetry?.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousTarget === undefined) delete process.env.ADMIN_API_TARGET;
    else process.env.ADMIN_API_TARGET = previousTarget;
    if (previousOrigin === undefined) delete process.env.ADMIN_PUBLIC_ORIGIN;
    else process.env.ADMIN_PUBLIC_ORIGIN = previousOrigin;
    throw error;
  }
}

export async function setupAndLogin(page: Page, site: string) {
  await page.goto(site);
  await page.getByLabel('初始化令牌').fill('local-e2e-bootstrap-token');
  await page.getByLabel('管理员用户名').fill('admin');
  await page.getByLabel('管理员密码').fill('long-e2e-password');
  await page.getByRole('button', { name: '创建管理员' }).click();
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('long-e2e-password');
  await page.getByRole('button', { name: '登录' }).click();
}
