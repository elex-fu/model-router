import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../dist/config/v2-runtime.js';
import { proxyHandler } from '../../dist/server/proxy.js';
import { setupAndLogin, startConsole } from './harness';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Token usage listener unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
}

test('personal administrator setup issues a token that reaches a local provider; invalid, rotated and disabled tokens are rejected', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const providerCalls: Array<{ path?: string; model: string; authorization?: string }> = [];
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    providerCalls.push({ path: request.url, model: body.model, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-local-token-e2e',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Token E2E passed' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    );
  });
  const providerOrigin = await listen(provider);
  let runtime: RuntimeConfigStore | undefined;
  const app = await startConsole(page, {
    applyConfig: async (raw) => {
      if (runtime) runtime.replace(await compileRuntimeConfig(raw));
      return raw.revision;
    },
  });
  const gateway = createServer((request, response) => {
    if (!runtime) {
      response.writeHead(503).end();
      return;
    }
    const current = runtime;
    void proxyHandler(request, response, current, () => {}, {
      getRuntimeSnapshot: () => {
        const snapshot = current.load();
        return {
          routes: snapshot.routes ?? [],
          upstreams: snapshot.upstreams.map((upstream) => {
            if (!upstream.id) throw new Error('V2 fixture upstream identifier missing');
            return { ...upstream, id: upstream.id };
          }),
        };
      },
    }).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  try {
    const address = app.admin.server.address();
    if (!address || typeof address === 'string') throw new Error('Personal admin did not bind');
    const adminOrigin = `http://127.0.0.1:${address.port}`;
    await test.step('personal runtime has no ordinary user console', async () => {
      for (const path of ['/console/login', '/console/api/v1/auth/session']) {
        const unavailable = await fetch(`${adminOrigin}${path}`, { headers: { accept: 'text/html' } });
        expect(unavailable.status).toBe(404);
        await unavailable.arrayBuffer();
      }
    });

    await setupAndLogin(page, app.site);
    await expect(page.getByRole('heading', { name: '初始引导', exact: true })).toBeVisible();
    await test.step('administrator configures a loopback provider and a model alias', async () => {
      await page.getByRole('link', { name: '上游', exact: true }).click();
      await page.getByRole('button', { name: '新增上游', exact: true }).click();
      const form = page
        .locator('section.panel')
        .filter({ has: page.getByRole('heading', { name: '新增上游', exact: true }) });
      await form.getByLabel('供应商预设').selectOption('custom-openai');
      await form.getByLabel('名称', { exact: true }).fill('Token E2E provider');
      await form.getByLabel('认证方式').selectOption('none');
      await form.getByLabel('Base URL').fill(`${providerOrigin}/v1`);
      await form.getByLabel('我明确允许对此上游使用 HTTP 明文传输').check();
      await form.getByLabel('启用上游').check();
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await page.getByRole('link', { name: /Token E2E provider/ }).click();
      const models = page
        .locator('section.panel')
        .filter({ has: page.getByRole('heading', { name: '模型目录', exact: true }) });
      await models.getByLabel('模型 ID').fill('provider-e2e-model');
      await models.getByRole('button', { name: '添加模型', exact: true }).click();
      await models.getByRole('button', { name: '启用', exact: true }).click();
      const config = (await (await page.request.get(app.api('/config'))).json()).data;
      const upstream = config.upstreams.find((item: { name: string }) => item.name === 'Token E2E provider');
      await page.getByRole('link', { name: '模型与路由', exact: true }).click();
      for (const [name, model] of [
        ['Token E2E route', 'token-e2e-model'],
        ['Denied E2E route', 'out-of-scope-model'],
      ]) {
        await page.getByRole('button', { name: '新增路由', exact: true }).click();
        const route = page
          .locator('section.panel')
          .filter({ has: page.getByRole('heading', { name: '新增路由', exact: true }) });
        await route.getByLabel('名称', { exact: true }).fill(name);
        await route.getByLabel('客户端模型 / 匹配值').fill(model);
        await route.getByLabel('候选 1 上游').selectOption(upstream.id);
        await route.getByLabel('候选 1 模型').fill('provider-e2e-model');
        await route.getByRole('button', { name: '保存', exact: true }).click();
        await expect(page.locator('button.route-select').filter({ hasText: name })).toBeVisible();
      }
    });

    await test.step('administrator creates a model-scoped proxy token', async () => {
      await page.getByRole('link', { name: '访问 Key', exact: true }).click();
      const create = page
        .locator('section.panel')
        .filter({ has: page.getByRole('heading', { name: '创建访问 Key', exact: true }) });
      await create.getByLabel('名称', { exact: true }).fill('Token E2E key');
      await create.getByLabel('允许模型（逗号分隔）').fill('token-e2e-model');
      await create.getByRole('button', { name: '创建 Key', exact: true }).click();
      await expect(page.getByRole('status').locator('code')).not.toBeEmpty();
    });
    const firstSecret = await page.getByRole('status').locator('code').innerText();
    const raw = (await (await page.request.get(app.api('/config'))).json()).data;
    runtime = new RuntimeConfigStore(join(app.directory, 'config.json'), await compileRuntimeConfig(raw));
    const gatewayOrigin = await listen(gateway);
    const call = (token: string, model = 'token-e2e-model') =>
      fetch(`${gatewayOrigin}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello from token E2E' }] }),
      });

    await test.step('token calls the actual proxy and local provider; invalid or out-of-scope tokens cannot', async () => {
      const valid = await call(firstSecret);
      expect(valid.status).toBe(200);
      const reply = await valid.json();
      expect(reply.choices[0].message.content).toBe('Token E2E passed');
      expect(reply.usage.total_tokens).toBe(3);
      expect(providerCalls).toEqual([
        { path: '/v1/chat/completions', model: 'provider-e2e-model', authorization: undefined },
      ]);
      const invalid = await call('mr_invalid_token_e2e');
      expect(invalid.status).toBe(401);
      await invalid.arrayBuffer();
      const forbidden = await call(firstSecret, 'out-of-scope-model');
      expect(forbidden.status).toBe(404);
      await forbidden.arrayBuffer();
      expect(providerCalls).toHaveLength(1);
      const tokenLogin = await fetch(`${adminOrigin}/admin/api/v1/session`, {
        method: 'POST',
        headers: { origin: adminOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'admin', password: firstSecret }),
      });
      expect(tokenLogin.status).toBe(401);
      await tokenLogin.arrayBuffer();
    });

    await page.getByRole('button', { name: /Token E2E key/ }).click();
    await test.step('rotation and disabling are enforced by subsequent HTTP calls', async () => {
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: '轮换', exact: true }).click();
      const secret = page.getByRole('status').locator('code');
      await expect.poll(() => secret.innerText()).not.toBe(firstSecret);
      const replacement = await secret.innerText();
      const old = await call(firstSecret);
      expect(old.status).toBe(401);
      await old.arrayBuffer();
      const next = await call(replacement);
      expect(next.status).toBe(200);
      await next.arrayBuffer();
      await page.getByRole('button', { name: '我已保存', exact: true }).click();
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: '停用', exact: true }).click();
      await expect
        .poll(async () => {
          const disabled = await call(replacement);
          await disabled.arrayBuffer();
          return disabled.status;
        })
        .toBe(401);
      expect(providerCalls).toHaveLength(2);
    });
    await page.goto(new URL('/admin/register', app.site).toString());
    await expect(page.getByRole('heading', { name: '实例已完成注册', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建管理员', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('personal-registration-is-initialization.png') });
  } finally {
    await close(gateway);
    await app.close();
    await close(provider);
  }
});
