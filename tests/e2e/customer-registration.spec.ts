import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startCustomerConsole } from './customer-harness';

// Explicit opt-in: this creates and removes its own loopback PostgreSQL cluster.
// Real UI, identity routes, session cookies, restricted SQL and key services;
// no page.route mocks, live provider calls, or production gateway acceptance.
test('invited customer registers, logs in, creates a scoped token, rotates and revokes it with real PostgreSQL', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.E2E_CUSTOMER_POSTGRES !== '1',
    'Set E2E_CUSTOMER_POSTGRES=1; PostgreSQL tools must be installed',
  );
  test.setTimeout(120_000);
  const app = await startCustomerConsole();
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const email = 'developer@customer-e2e.test';
  const password = 'customer-e2e-member-password';
  const model = 'customer-e2e-model';
  try {
    await test.step('workspace owner issues a developer invitation', async () => {
      await page.goto(`${app.origin}/console/login`);
      await page.getByLabel('邮箱', { exact: true }).fill('owner@customer-e2e.test');
      await page.getByLabel('密码', { exact: true }).fill('customer-e2e-owner-password');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByRole('heading', { name: '客户控制台', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '邀请成员', exact: true }).click();
      await page.getByLabel('成员邮箱').fill(email);
      await page.getByLabel('邀请租户角色').selectOption('developer');
      await page.getByRole('button', { name: '创建一次性邀请', exact: true }).click();
      await expect(page.getByLabel('一次性邀请链接')).toBeVisible();
    });

    const invitationUrl = await page.getByLabel('一次性邀请链接').inputValue();
    const invitation = new URL(invitationUrl).hash.slice('#token='.length);
    await test.step('new member registers through the invitation and gets no automatic login', async () => {
      await guest.goto(invitationUrl);
      await expect(guest.getByRole('heading', { name: '接受邀请', exact: true })).toBeVisible();
      await expect(guest).toHaveURL(`${app.origin}/console/invitations/accept`);
      await guest.getByLabel('邮箱', { exact: true }).fill(email);
      await guest.getByLabel('姓名', { exact: true }).fill('E2E ordinary user');
      await guest.getByLabel(/^密码/).fill(password);
      await guest.getByRole('button', { name: '接受邀请', exact: true }).click();
      await expect(guest.getByRole('heading', { name: '邀请已接受', exact: true })).toBeVisible();
      const session = await guest.request.get(`${app.origin}/console/api/v1/auth/session`);
      expect(session.status()).toBe(401);
      const replay = await guest.request.post(`${app.origin}/console/api/v1/invitations/accept`, {
        headers: { origin: app.origin },
        data: { token: invitation, email, displayName: 'E2E ordinary user', password },
      });
      expect(replay.status()).toBe(400);
      expect((await replay.json()).error.code).toBe('REQUEST_REJECTED');
      const identities = await app.migrator.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM saas_users WHERE email_canonical = $1',
        [email],
      );
      expect(identities.rows).toEqual([{ count: '1' }]);
    });

    await test.step('member logs in and inherits developer access to the default project', async () => {
      await guest.getByRole('link', { name: '前往登录', exact: true }).click();
      await guest.getByLabel('邮箱', { exact: true }).fill(email);
      await guest.getByLabel('密码', { exact: true }).fill(password);
      await guest.getByRole('button', { name: '登录', exact: true }).click();
      await expect(guest.getByRole('heading', { name: '客户控制台', exact: true })).toBeVisible();
      const tenantResponse = await guest.request.get(`${app.origin}/console/api/v1/tenants`);
      expect((await tenantResponse.json()).data).toEqual([
        expect.objectContaining({ id: app.tenant.id, role: 'developer' }),
      ]);
      const projectResponse = await guest.request.get(`${app.origin}/console/api/v1/tenants/${app.tenant.id}/projects`);
      expect((await projectResponse.json()).data).toEqual([
        expect.objectContaining({ id: app.tenant.defaultProjectId, role: 'developer' }),
      ]);
      await guest.getByRole('link', { name: 'API Keys', exact: true }).click();
      await expect(guest.getByRole('heading', { name: '新建 API Key', exact: true })).toBeVisible();
    });

    const create = guest
      .locator('section.panel')
      .filter({ has: guest.getByRole('heading', { name: '新建 API Key', exact: true }) });
    await create.getByLabel('名称', { exact: true }).fill('E2E member token');
    await create.getByLabel('选择供给模式').selectOption('byok');
    await create.getByLabel('精确模型范围').fill(model);
    await test.step('registration alone cannot create a token without project entitlement', async () => {
      const response = guest.waitForResponse((res) => res.request().method() === 'POST' && /\/keys$/.test(res.url()));
      await create.getByRole('button', { name: '创建 API Key', exact: true }).click();
      const denied = await response;
      expect(denied.status()).toBe(403);
      expect((await denied.json()).error.code).toBe('FORBIDDEN');
      await expect(create.getByRole('alert')).toBeVisible();
      await expect(guest.getByLabel('一次性 API Key secret')).toHaveCount(0);
    });

    await app.provisionSupply(model);

    await test.step('entitled member creates a real token with the precise model scope', async () => {
      await create.getByRole('button', { name: '创建 API Key', exact: true }).click();
      await expect(guest.getByLabel('一次性 API Key secret')).toBeVisible();
    });
    const firstSecret = await guest.getByLabel('一次性 API Key secret').inputValue();
    const authenticated = await app.keys.authenticate(firstSecret);
    expect(authenticated).toMatchObject({
      authorization: {
        tenantId: app.tenant.id,
        projectId: app.tenant.defaultProjectId,
        principalKind: 'member',
        modelScopes: [model],
      },
    });
    if (!authenticated) throw new Error('Customer token authentication failed');
    expect(await app.keys.authenticate('mr_live_invalid_customer_e2e')).toBeNull();
    const stored = await app.migrator.query<{ key_hash: string }>('SELECT key_hash FROM saas_api_keys WHERE id = $1', [
      authenticated.metadata.id,
    ]);
    expect(stored.rows).toEqual([{ key_hash: createHash('sha256').update(firstSecret).digest('hex') }]);
    const metadata = await guest.request.get(
      `${app.origin}/console/api/v1/tenants/${app.tenant.id}/projects/${app.tenant.defaultProjectId}/keys`,
    );
    expect(await metadata.text()).not.toContain(firstSecret);
    guest.once('dialog', (dialog) => dialog.accept());
    await guest.getByRole('button', { name: '关闭面板', exact: true }).click();
    await expect(guest.getByLabel('一次性 API Key secret')).toHaveCount(0);
    const screenshot = testInfo.outputPath('customer-api-keys.png');
    await guest.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('Registered customer API Keys', { path: screenshot, contentType: 'image/png' });
    if (process.env.E2E_CUSTOMER_SCREENSHOT_DIR)
      await guest.screenshot({
        path: join(process.env.E2E_CUSTOMER_SCREENSHOT_DIR, 'model-router-customer-e2e.png'),
        fullPage: false,
      });

    await test.step('rotation invalidates the old token and revocation invalidates the replacement', async () => {
      const card = guest.locator('article').filter({ hasText: 'E2E member token' });
      guest.once('dialog', (dialog) => dialog.accept());
      await card.getByRole('button', { name: '轮换', exact: true }).click();
      await expect(guest.getByLabel('一次性 API Key secret')).toBeVisible();
      const rotatedSecret = await guest.getByLabel('一次性 API Key secret').inputValue();
      expect(rotatedSecret).not.toBe(firstSecret);
      expect(await app.keys.authenticate(firstSecret)).toBeNull();
      const rotated = await app.keys.authenticate(rotatedSecret);
      expect(rotated?.authorization.modelScopes).toEqual([model]);
      guest.once('dialog', (dialog) => dialog.accept());
      await guest.getByRole('button', { name: '关闭面板', exact: true }).click();
      const activeCard = guest
        .locator('article')
        .filter({ has: guest.getByRole('button', { name: '撤销', exact: true }) });
      const revoked = guest.waitForResponse((res) => res.request().method() === 'POST' && /\/revoke$/.test(res.url()));
      guest.once('dialog', (dialog) => dialog.accept());
      await activeCard.getByRole('button', { name: '撤销', exact: true }).click();
      expect((await revoked).status()).toBe(200);
      expect(await app.keys.authenticate(rotatedSecret)).toBeNull();
      const persisted = await guest.evaluate(() =>
        JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }),
      );
      for (const secret of [invitation, password, firstSecret, rotatedSecret]) expect(persisted).not.toContain(secret);
    });
  } finally {
    await guestContext.close();
    await app.close();
  }
});
