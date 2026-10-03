import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createServer as createViteServer } from 'vite';

test('audit UI distinguishes declared operators from platform actors and safely rejects poisoned projections', async ({ page }) => {
  const actorId = '11111111-1111-4111-8111-111111111111';
  const issuedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deniedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const legacyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const xssText = '<img src=x onerror="window.auditXss=1">';
  const common = {
    tenantId: null, actorId: null,
    occurredAt: '2026-09-30T16:00:00.000Z', entryPoint: 'trusted_operator_cli:platform_mfa_enroll',
  };
  const issued = {
    ...common, id: issuedId, action: 'platform_mfa.enrollment_token.issued',
    entityType: 'platform_mfa_enrollment_user', entityId: actorId,
    operatorAttestation: { operatorId: 'ops:handoff-01', reasonCode: 'initial-enrollment', outcome: 'issued' },
    userAgent: 'raw-UA-browser-secret', sourceIp: '192.0.2.8', token: 'browser-token-secret',
  };
  const denied = {
    ...common, id: deniedId, action: 'platform_mfa.enrollment_token.denied',
    entityType: 'platform_mfa_enrollment_email_digest', entityId: null,
    operatorAttestation: { operatorId: 'ops:handoff-02', reasonCode: 'approved-enrollment', outcome: 'target-unavailable' },
  };
  const legacy = {
    id: legacyId, actorId, action: 'api_key.created', entityType: 'saas_api_key', entityId: xssText,
    occurredAt: common.occurredAt,
  };
  let signedIn = false;
  let poison = false;
  const auditUrls: URL[] = [];
  await page.route('**/admin/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const send = (data: unknown) => route.fulfill({ status: 200, json: { data } });
    if (url.pathname === '/admin/api/v1/auth/session') {
      if (route.request().method() === 'POST') {
        signedIn = true;
        return send({ session: { userId: actorId }, csrfToken: 'audit-browser-fixture-csrf' });
      }
      if (signedIn) return send({ session: { userId: actorId } });
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } });
    }
    if (url.pathname === '/admin/api/v1/me') return send({ userId: actorId, roles: ['security'] });
    if (url.pathname === '/admin/api/v1/audit/events') {
      auditUrls.push(url);
      const items = poison
        ? [{ ...issued, operatorAttestation: { ...issued.operatorAttestation, operatorId: xssText } }]
        : url.searchParams.has('actorId') ? [legacy] : [issued, denied, legacy];
      return send({ items, hasMore: false, nextCursor: null });
    }
    return route.fulfill({ status: 503, json: { error: { code: 'AUDIT_FIXTURE_UNEXPECTED_ROUTE' } } });
  });

  const vite = await createViteServer({
    configFile: resolve('web/vite.config.ts'), root: resolve('web'),
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await vite.listen();
    const site = vite.resolvedUrls?.local[0];
    if (!site) throw new Error('Audit browser fixture did not expose a local URL');
    await page.goto(`${new URL(site).origin}/admin/platform/login`);
    await expect(page.getByRole('heading', { name: '平台管理员登录' })).toBeVisible();
    await page.getByLabel('管理员邮箱').fill('audit-reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('audit-browser-fixture-password');
    await page.getByLabel(/^MFA 验证码/).fill('123456');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '平台管理员工作区', exact: true })).toBeVisible();
    // The overview's intentionally unhandled summary API is not an audit error.
    await expect(page.getByText('运营摘要读取失败', { exact: true })).toBeVisible();
    await expect(page.getByText('审计历史读取失败', { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: '平台管理导航' })
      .getByRole('link', { name: '审计历史', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/platform\/audit\/events$/);
    await expect(page.getByRole('heading', { name: '审计历史' })).toBeVisible();

    const issuedRow = page.locator('tbody tr').filter({ hasText: issuedId });
    await expect(issuedRow).toContainText('DECLARED TRUSTED OPERATOR');
    await expect(issuedRow).toContainText('ops:handoff-01');
    await expect(issuedRow).toContainText('initial-enrollment');
    await expect(issuedRow).toContainText('issued');
    const deniedRow = page.locator('tbody tr').filter({ hasText: deniedId });
    await expect(deniedRow).toContainText('ops:handoff-02');
    await expect(deniedRow).toContainText('target-unavailable');
    const legacyRow = page.locator('tbody tr').filter({ hasText: legacyId });
    await expect(legacyRow.locator('td').nth(1)).toHaveText(actorId);
    await expect(legacyRow).toContainText(xssText);
    await expect(page.locator('tbody img')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('raw-UA-browser-secret');
    await expect(page.locator('body')).not.toContainText('browser-token-secret');
    expect(await page.evaluate(() => Reflect.get(window, 'auditXss'))).toBeUndefined();

    await page.getByLabel('操作者 ID（精确匹配）').fill(actorId);
    await page.getByRole('button', { name: '应用筛选' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(1);
    expect(auditUrls[auditUrls.length - 1]?.searchParams.get('actorId')).toBe(actorId);
    expect(auditUrls.every(url => !url.searchParams.has('operatorId') && !url.searchParams.has('userAgent'))).toBe(true);
    await expect(page.locator('tbody').getByText('DECLARED TRUSTED OPERATOR')).toHaveCount(0);

    poison = true;
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(page.getByText('审计历史读取失败', { exact: true })).toBeVisible();
    await expect(page.locator('tbody')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'auditXss'))).toBeUndefined();
  } finally {
    await vite.close();
  }
});

test('platform login returns directly to the protected audit deep link without an overview redirect or navigation click', async ({ page }) => {
  const actorId = '11111111-1111-4111-8111-111111111111';
  const auditId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let signedIn = false;
  let auditReads = 0;
  const unexpectedPaths: string[] = [];
  await page.route('**/admin/api/v1/**', async route => {
    const url = new URL(route.request().url());
    const send = (data: unknown) => route.fulfill({ status: 200, json: { data } });
    if (url.pathname === '/admin/api/v1/auth/session') {
      if (route.request().method() === 'POST') {
        signedIn = true;
        return send({ session: { userId: actorId }, csrfToken: 'audit-return-fixture-csrf' });
      }
      if (signedIn) return send({ session: { userId: actorId } });
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } });
    }
    if (url.pathname === '/admin/api/v1/me') return send({ userId: actorId, roles: ['security'] });
    if (url.pathname === '/admin/api/v1/audit/events') {
      auditReads += 1;
      return send({
        items: [{
          id: auditId, actorId, action: 'api_key.created', entityType: 'saas_api_key',
          entityId: 'deep-link-audit-reference', occurredAt: '2026-09-30T16:00:00.000Z',
        }],
        hasMore: false, nextCursor: null,
      });
    }
    unexpectedPaths.push(url.pathname);
    return route.fulfill({ status: 503, json: { error: { code: 'AUDIT_RETURN_FIXTURE_UNEXPECTED_ROUTE' } } });
  });

  const vite = await createViteServer({
    configFile: resolve('web/vite.config.ts'), root: resolve('web'),
    server: { host: '127.0.0.1', port: 0 },
  });
  try {
    await vite.listen();
    const site = vite.resolvedUrls?.local[0];
    if (!site) throw new Error('Audit return fixture did not expose a local URL');
    await page.goto(`${new URL(site).origin}/admin/platform/audit/events`);
    await expect(page.getByRole('heading', { name: '平台管理员登录' })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/platform\/login$/);
    await page.getByLabel('管理员邮箱').fill('audit-reader@example.test');
    await page.getByLabel('密码', { exact: true }).fill('audit-return-fixture-password');
    await page.getByLabel(/^MFA 验证码/).fill('123456');
    await page.getByRole('button', { name: '登录', exact: true }).click();

    // No audit-link click or second goto: the login flow must preserve `from`.
    await expect(page).toHaveURL(/\/admin\/platform\/audit\/events$/);
    await expect(page.getByRole('heading', { name: '审计历史', exact: true })).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: auditId })).toContainText(actorId);
    expect(auditReads).toBeGreaterThan(0);
    expect(unexpectedPaths).toEqual([]);
    await expect(page.getByRole('heading', { name: '平台管理员工作区', exact: true })).toHaveCount(0);
    await expect(page.getByText('运营摘要读取失败', { exact: true })).toHaveCount(0);
    await expect(page.getByText('审计历史读取失败', { exact: true })).toHaveCount(0);
  } finally {
    await vite.close();
  }
});
