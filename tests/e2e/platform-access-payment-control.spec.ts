import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

const actorId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const csrf = 'local-platform-access-fixture-csrf';
const artifact = {
  operationKey: 'reviewed-original-operation-key', tenantId, projectId,
  pool: { id: 'reviewed-platform-pool', expectedAuthzVersion: '3' },
  capacity: { tenantExpectedRevision: '4', projectExpectedRevision: '5', projectLimits: { requestsPerMinute: 60, tokensPerMinute: 12000, maxConcurrentRequests: 2 } },
  routes: [{ routeId: 'reviewed-new-route', definition: { publicModelId: 'public-model-review', publicModelVersion: '1', protocol: 'openai', endpoint: 'chat-completions', supplyMode: 'platform', targetMode: 'platform_pool', upstreamId: 'reviewed-platform-pool' }, customerPolicy: { policyId: 'reviewed-new-customer-policy', definition: { customerPriceVersion: 'customer-price-reviewed' } }, providerPolicy: { policyId: 'reviewed-new-provider-policy', definition: { providerId: 'provider-reviewed', productId: 'product-reviewed', supplierCostVersion: 'supplier-price-reviewed' } }, attestation: { signatureBase64: 'original-reviewed-artifact-signature', contractDigest: 'a'.repeat(64), verifierKeyId: 'reviewed-verifier' } }],
};
function operation(phase: 'assembling' | 'failed' | 'completed' | 'disabled') {
  return { id: operationId, tenantId, projectId, profileId: 'profile-reviewed', entitlementId: 'entitlement-reviewed', phase, receipts: { pool: '3', 'capacity:project': '6' }, lastErrorCode: phase === 'failed' ? 'DEPENDENCY_UNAVAILABLE' : null, entitlementAuthzVersion: phase === 'disabled' ? '3' : '2' };
}
function price(kind: 'customer' | 'supplier') {
  return { kind, id: `${kind}-price-reviewed`, version: 1, publicModelId: 'public-model-review', publicModelVersion: 1, providerId: 'provider-reviewed', productId: 'product-reviewed', ...(kind === 'supplier' ? { resolvedModel: 'upstream-model-reviewed' } : {}), protocol: 'openai', endpoint: 'chat-completions', currency: 'CNY', commercialPolicyVersion: 'commercial-v1', calculatorVersion: 'calculator-v1', roundingVersion: 'rounding-v1', roundingMode: 'ceil', roundingBoundary: 'total', rates: { input: { numeratorMinorUnits: '2', denominatorUnits: '1000' }, output: { numeratorMinorUnits: '6', denominatorUnits: '1000' }, cache_read: null, cache_write: null, cache_write_5m: null, cache_write_1h: null }, effectiveAt: '2026-01-01T00:00:00Z', expiresAt: null, definitionDigest: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00Z' };
}
let vite: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  vite = await createViteServer({ configFile: resolve('web/vite.config.ts'), root: resolve('web'), server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const site = vite.resolvedUrls?.local[0];
  if (!site) throw new Error('Local operations browser fixture did not expose a URL');
  origin = new URL(site).origin;
});
test.afterAll(async () => { await vite?.close(); });

async function fixture(page: Page, roles = ['operations']) {
  const state = { signedIn: false, phase: 'completed' as 'failed' | 'completed' | 'disabled', failCreate: false, failQuery: false, conflictPatch: false, controlReads: 0, createBodies: [] as unknown[], disableBodies: [] as unknown[], patchBodies: [] as unknown[], unexpected: [] as string[], control: { mode: 'disabled', activeBindingId: null as string | null, revision: '7' } };
  await page.route('**/admin/api/v1/**', async route => {
    const req = route.request(); const url = new URL(req.url());
    const send = (data: unknown) => route.fulfill({ status: 200, json: { data, meta: { requestId: 'local-fixture-request' } } });
    if (url.pathname === '/admin/api/v1/auth/session') {
      if (req.method() === 'POST') { state.signedIn = true; return send({ session: { userId: actorId }, csrfToken: csrf }); }
      if (state.signedIn) return send({ session: { userId: actorId }, csrfToken: csrf });
      return route.fulfill({ status: 401, json: { error: { code: 'UNAUTHENTICATED' } } });
    }
    if (url.pathname === '/admin/api/v1/me') return send({ userId: actorId, roles });
    if (url.pathname === '/admin/api/v1/capacity/targets/tenants') return send({ items: [{ id: tenantId }], nextCursor: null });
    if (url.pathname === `/admin/api/v1/capacity/targets/tenants/${tenantId}/projects`) return send({ items: [{ id: projectId }], nextCursor: null });
    if (url.pathname === '/admin/api/v1/supply/accounts') return send([]);
    if (url.pathname === '/admin/api/v1/pricing/versions') {
      expect(url.searchParams.get('currency')).toBe('CNY');
      expect(url.searchParams.get('publicModelId')).toBe('public-model-review');
      return send({ items: [price(url.searchParams.get('kind') as 'customer' | 'supplier')], hasMore: false, nextCursor: null });
    }
    if (url.pathname === '/admin/api/v1/supply/platform-access/operations' && req.method() === 'POST') {
      state.createBodies.push(req.postDataJSON()); expect(req.headers()['x-csrf-token']).toBe(csrf);
      if (state.failCreate) return route.fulfill({ status: 503, json: { error: { code: 'PLATFORM_ACCESS_DEPENDENCY_UNAVAILABLE' } } });
      return send(operation('assembling'));
    }
    if (url.pathname === `/admin/api/v1/supply/platform-access/operations/${operationId}`) {
      if (state.failQuery) return route.fulfill({ status: 503, json: { error: { code: 'PLATFORM_ACCESS_DEPENDENCY_UNAVAILABLE' } } });
      return send(operation(state.phase));
    }
    if (url.pathname === '/admin/api/v1/supply/platform-access/disable') {
      state.disableBodies.push(req.postDataJSON()); expect(req.headers()['x-csrf-token']).toBe(csrf); state.phase = 'disabled'; return send(operation('disabled'));
    }
    if (url.pathname === '/admin/api/v1/payments/control') {
      if (req.method() === 'GET') { state.controlReads++; return send(state.control); }
      expect(req.method()).toBe('PATCH'); expect(req.headers()['x-csrf-token']).toBe(csrf); state.patchBodies.push(req.postDataJSON());
      if (state.conflictPatch) { state.control = { mode: 'draining', activeBindingId: 'merchant-binding-other', revision: '9' }; return route.fulfill({ status: 409, json: { error: { code: 'PAYMENT_CONTROL_CONFLICT' } } }); }
      const body = req.postDataJSON(); state.control = { mode: body.mode, activeBindingId: body.activeBindingId, revision: '8' }; return send(state.control);
    }
    state.unexpected.push(`${req.method()} ${url.pathname}`);
    return route.fulfill({ status: 503, json: { error: { code: 'LOCAL_FIXTURE_UNEXPECTED_ROUTE' } } });
  });
  return state;
}
async function login(page: Page, path = '/platform/platform-access') {
  await page.goto(`${origin}/admin${path}`);
  await page.getByLabel('管理员邮箱').fill('local-operator@example.test');
  await page.getByLabel('密码', { exact: true }).fill('local-fixture-password');
  await page.getByLabel(/^MFA 验证码/).fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin${path}$`));
}
async function reviewArtifact(page: Page) {
  await page.getByRole('combobox', { name: /^租户/ }).selectOption(tenantId);
  await page.getByRole('combobox', { name: /^项目/ }).selectOption(projectId);
  await page.getByLabel('已审核的开通配置文件').setInputFiles({ name: 'reviewed-access.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(artifact)) });
  await expect(page.getByRole('table', { name: '模型和价格确认' })).toContainText('public-model-review');
  await expect(page.getByText(/客户价格 customer-price-reviewed：CNY/)).toBeVisible();
  await expect(page.getByText(/供给成本 supplier-price-reviewed：CNY/)).toBeVisible();
  await expect(page.getByText(/项目容量：每分钟请求 60；每分钟 Token 12000；同时请求 2/)).toBeVisible();
  await page.getByRole('checkbox', { name: '已核对模型、币种、价格、容量和供给，确认提交已审核配置' }).check();
}

test('operator imports and confirms original access artifact, queries completion, recovers and explicitly disables', async ({ page }) => {
  const state = await fixture(page); await login(page);
  await expect(page.getByRole('navigation', { name: '平台管理导航' }).getByRole('link', { name: '平台模型访问开通' })).toBeVisible();
  await reviewArtifact(page);
  await expect(page.getByText('已开通', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '开通 / 使用原配置恢复', exact: true }).click();
  await expect(page.getByText('已开通', { exact: true })).toBeVisible();
  expect(state.createBodies).toEqual([artifact]);
  await page.getByRole('link', { name: '支付控制', exact: true }).click();
  await page.getByRole('link', { name: '平台模型访问开通', exact: true }).click();
  await expect(page.getByLabel('操作 ID', { exact: true })).toHaveValue(operationId);
  await expect(page.getByText('已开通', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查询 / 刷新操作', exact: true }).click();
  await expect(page.getByText('已开通', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '确认停用此操作关联的项目平台访问' }).check();
  await page.getByRole('button', { name: '确认停用平台访问', exact: true }).click();
  await expect(page.getByText('已停用', { exact: true })).toBeVisible();
  expect(state.disableBodies).toEqual([{ operationId, expectedEntitlementVersion: '2', reason: 'customer_request' }]);
  expect(state.unexpected).toEqual([]);
});

test('unconfirmed access request retries the exact original intent and server failure never displays completion', async ({ page }) => {
  const state = await fixture(page); state.failCreate = true; await login(page); await reviewArtifact(page);
  await page.getByRole('button', { name: '开通 / 使用原配置恢复', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('开通暂未完成');
  await expect(page.getByText('已开通', { exact: true })).toHaveCount(0);
  state.failCreate = false; state.phase = 'failed';
  await page.getByRole('button', { name: '开通 / 使用原配置恢复', exact: true }).click();
  await expect(page.getByText('开通未完成', { exact: true })).toBeVisible();
  await expect(page.getByText('已开通', { exact: true })).toHaveCount(0);
  expect(state.createBodies).toEqual([artifact, artifact]);
  state.failQuery = true;
  await page.getByRole('button', { name: '查询 / 刷新操作', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('开通暂未完成');
  await expect(page.getByText('已开通', { exact: true })).toHaveCount(0);
  state.failQuery = false; state.phase = 'completed';
  await page.getByRole('button', { name: '查询 / 刷新操作', exact: true }).click();
  await expect(page.getByText('已开通', { exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test('payment control submits closed CAS input and refreshes server state after conflict', async ({ page }) => {
  const state = await fixture(page); await login(page, '/platform/payments/control');
  await expect(page.getByText('关闭新支付', { exact: true }).first()).toBeVisible();
  await page.getByRole('combobox', { name: /^目标模式/ }).selectOption('enabled');
  await page.getByLabel('目标商户绑定 ID').fill('merchant-binding-reviewed');
  await page.getByRole('checkbox', { name: '已核对目标商户，并确认运维已完成所有副本的商户绑定部署' }).check();
  await page.getByRole('button', { name: '确认更新支付控制', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('支付控制已更新');
  expect(state.patchBodies).toEqual([{ expectedRevision: '7', mode: 'enabled', activeBindingId: 'merchant-binding-reviewed' }]);
  await expect(page.getByText('控制版本', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('8');
  state.conflictPatch = true;
  await page.getByRole('combobox', { name: /^目标模式/ }).selectOption('draining');
  await page.getByRole('checkbox', { name: '已核对目标商户，并确认运维已完成所有副本的商户绑定部署' }).check();
  await page.getByRole('button', { name: '确认更新支付控制', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已刷新最新状态');
  await expect(page.getByLabel('目标商户绑定 ID')).toHaveValue('merchant-binding-other');
  await expect(page.getByText('控制版本', { exact: true }).locator('xpath=following-sibling::dd[1]')).toHaveText('9');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('button', { name: '确认更新支付控制', exact: true })).toBeDisabled();
  await expect(page.getByText(/支付控制已更新/)).toHaveCount(0);
  expect(state.patchBodies[1]).toEqual({ expectedRevision: '8', mode: 'draining', activeBindingId: 'merchant-binding-reviewed' });
  expect(state.controlReads).toBeGreaterThanOrEqual(2);
  expect(state.unexpected).toEqual([]);
});

test('other roles cannot see operations navigation or mutation controls through deep links', async ({ page }) => {
  const state = await fixture(page, ['security']); await login(page);
  const navigation = page.getByRole('navigation', { name: '平台管理导航' });
  await expect(navigation.getByRole('link', { name: '平台模型访问开通', exact: true })).toHaveCount(0);
  await expect(navigation.getByRole('link', { name: '支付控制', exact: true })).toHaveCount(0);
  await expect(page.getByText('仅运营管理员和超级管理员可开通平台模型访问。')).toBeVisible();
  await expect(page.getByRole('button', { name: '开通 / 使用原配置恢复', exact: true })).toHaveCount(0);
  await login(page, '/platform/payments/control');
  await expect(page.getByText('仅运营管理员和超级管理员可管理支付控制。')).toBeVisible();
  await expect(page.getByRole('button', { name: '确认更新支付控制', exact: true })).toHaveCount(0);
  expect(state.controlReads).toBe(0); expect(state.patchBodies).toEqual([]); expect(state.createBodies).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
