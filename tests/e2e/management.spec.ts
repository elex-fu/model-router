import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

test('create, edit, preview and delete a local upstream and route', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '上游', exact: true }).click();
    await page.getByRole('button', { name: '新增上游' }).click();
    const form = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '新增上游' }) });
    await form.getByLabel('供应商预设').selectOption('custom-openai');
    await form.getByLabel('名称').fill('Local fixture');
    await form.getByLabel('认证方式').selectOption('none');
    await form.getByLabel('Base URL').fill('http://127.0.0.1:9/v1');
    await form.getByLabel('我明确允许对此上游使用 HTTP 明文传输').check();
    await form.getByLabel('启用上游').check();
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('link', { name: /Local fixture/ })).toBeVisible();
    let config = (await (await page.request.get(app.api('/config'))).json()).data;
    const upstream = config.upstreams.find((item: { name: string }) => item.name === 'Local fixture');
    expect(upstream).toMatchObject({
      auth: { mode: 'none' },
      baseUrl: 'http://127.0.0.1:9/v1',
      enabled: true,
      policy: { allowInsecureHttp: true },
    });
    expect(upstream.credentials).toEqual([]);

    await page.getByRole('link', { name: /Local fixture/ }).click();
    const basic = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '基本配置' }) });
    await basic.getByLabel('名称').fill('Local fixture edited');
    await basic.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('link', { name: /Local fixture edited/ })).toBeVisible();
    const models = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '模型目录' }) });
    await models.getByLabel('模型 ID').fill('local-model');
    await models.getByRole('button', { name: '添加模型' }).click();
    await expect(models.getByText('local-model')).toBeVisible();
    await models.getByRole('button', { name: '启用', exact: true }).click();
    await expect
      .poll(async () => {
        config = (await (await page.request.get(app.api('/config'))).json()).data;
        return config.upstreams.find((item: { id: string }) => item.id === upstream.id)?.models[0]?.enabled;
      })
      .toBe(true);

    await page.getByRole('link', { name: '模型与路由' }).click();
    await page.getByRole('button', { name: '新增路由' }).click();
    const routeForm = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '新增路由' }) });
    await routeForm.getByLabel('名称').fill('Local route');
    await routeForm.getByLabel('客户端模型 / 匹配值').fill('fixture-client-model');
    await routeForm.getByLabel('候选 1 上游').selectOption(upstream.id);
    await routeForm.getByLabel('候选 1 模型').fill('local-model');
    await routeForm.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('button.route-select').filter({ hasText: 'Local route' })).toBeVisible();
    config = (await (await page.request.get(app.api('/config'))).json()).data;
    const route = config.routes.find((item: { name: string }) => item.name === 'Local route');
    expect(route.targets).toEqual([{ upstreamId: upstream.id, model: 'local-model' }]);

    const preview = page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: '路由配置预览', exact: true }) });
    await preview.getByLabel('客户端模型').fill('fixture-client-model');
    await expect(preview.getByLabel('访问 Key')).toBeVisible();
    await preview.getByRole('button', { name: '预览' }).click();
    await expect(preview.locator('.notice')).toContainText('匹配路由：Local route');
    await expect(preview.locator('.notice')).toContainText('local-model');
    await expect(preview.locator('.notice')).toContainText('仅为配置预览');
    await expect(preview.locator('.notice')).toContainText('当前首选');

    await page.locator('button.route-select').filter({ hasText: 'Local route' }).click();
    const editRoute = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '编辑路由' }) });
    await editRoute.getByLabel('名称').fill('Local route edited');
    await editRoute.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('button.route-select').filter({ hasText: 'Local route edited' })).toBeVisible();
    config = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(config.routes.find((item: { id: string }) => item.id === route.id)?.name).toBe('Local route edited');
    await page.locator('button.route-select').filter({ hasText: 'Local route edited' }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await editRoute.getByRole('button', { name: '删除' }).click();
    await expect
      .poll(async () =>
        (await (await page.request.get(app.api('/config'))).json()).data.routes.some(
          (item: { id: string }) => item.id === route.id,
        ),
      )
      .toBe(false);

    await page.getByRole('link', { name: '上游', exact: true }).click();
    await page.getByRole('link', { name: /Local fixture edited/ }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '删除上游' }).click();
    await expect
      .poll(async () =>
        (await (await page.request.get(app.api('/config'))).json()).data.upstreams.some(
          (item: { id: string }) => item.id === upstream.id,
        ),
      )
      .toBe(false);
  } finally {
    await app.close();
  }
});

test('clone an upstream without inheriting credentials or enabling its copy', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.goto(new URL('/admin/upstreams', app.site).toString());
    await expect(page.getByRole('heading', { name: '上游', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '上游', exact: true }).click();
    await page.getByRole('button', { name: '新增上游' }).click();
    const create = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '新增上游' }) });
    await create.getByLabel('供应商预设').selectOption('custom-openai');
    await create.getByLabel('名称').fill('Clone source');
    await create.getByLabel('认证方式').selectOption('bearer');
    await create.getByLabel('Base URL').fill('https://provider.example/v1');
    await create.getByRole('button', { name: '保存' }).click();
    await page.getByRole('link', { name: /Clone source/ }).click();

    const credentials = page.locator('section.panel').filter({ has: page.getByLabel('标签') });
    await credentials.getByLabel('标签').fill('source-token');
    await credentials.getByLabel('来源').selectOption('env');
    await credentials.getByLabel('环境变量名').fill('SOURCE_PROVIDER_TOKEN');
    await credentials.getByRole('button', { name: '添加凭证' }).click();
    const models = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '模型目录' }) });
    await models.getByLabel('模型 ID').fill('clone-model');
    await models.getByRole('button', { name: '添加模型' }).click();
    await models.getByRole('button', { name: '启用', exact: true }).click();

    const before = (await (await page.request.get(app.api('/config'))).json()).data;
    const source = before.upstreams.find((item: { name: string }) => item.name === 'Clone source');
    expect(source.credentials).toHaveLength(1);
    expect(source.credentials[0].secret).toEqual({ type: 'env', name: 'SOURCE_PROVIDER_TOKEN' });
    const sourceSnapshot = JSON.stringify(source);
    const routeIdsBefore = before.routes.map((route: { id: string }) => route.id);

    await page.getByRole('button', { name: '克隆上游' }).click();
    await expect(page).toHaveURL(/\/upstreams$/);
    const cloneForm = page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: '确认克隆上游' }) });
    await expect(cloneForm.getByText('不会复制凭证或 Secret 引用')).toBeVisible();
    await expect(cloneForm.getByLabel('名称')).toHaveValue('Clone source 副本');
    await expect(cloneForm.getByLabel('Base URL')).toHaveValue(source.baseUrl);
    await expect(cloneForm.getByLabel('认证方式')).toHaveValue('bearer');
    await expect(cloneForm.getByLabel('启用上游')).not.toBeChecked();
    const cloneModels = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '模型目录' }) });
    await expect(cloneModels.getByText('clone-model')).toHaveCount(0);
    await cloneForm.getByLabel('名称').fill('Clone copy');
    await cloneForm.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('link', { name: /Clone copy/ })).toBeVisible();

    const after = (await (await page.request.get(app.api('/config'))).json()).data;
    const unchangedSource = after.upstreams.find((item: { id: string }) => item.id === source.id);
    expect(JSON.stringify(unchangedSource)).toBe(sourceSnapshot);
    const copy = after.upstreams.find((item: { name: string }) => item.name === 'Clone copy');
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      provider: source.provider,
      protocol: source.protocol,
      baseUrl: source.baseUrl,
      endpoints: source.endpoints,
      auth: { mode: 'bearer' },
      enabled: false,
      credentials: [],
      models: [],
    });
    expect(JSON.stringify(copy)).not.toContain('SOURCE_PROVIDER_TOKEN');
    expect(after.routes.map((route: { id: string }) => route.id)).toEqual(routeIdsBefore);
  } finally {
    await app.close();
  }
});

test('stop a running upstream test and show its cancelled state', async ({ page }) => {
  const mock = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
      });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('Mock upstream has no TCP port');
  const app = await startConsole(page);
  try {
    const current = await app.admin.control.raw();
    await app.admin.control.entity('upstreams', 'create', undefined, {
      id: 'cancel-fixture', name: 'Cancel fixture', provider: 'custom', protocol: 'openai', enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`, endpoints: { generate: 'chat/completions' },
      auth: { mode: 'none' }, credentials: [],
      models: [{ id: 'local-model', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
      priority: 0, sortIndex: 0, policy: { allowInsecureHttp: true },
    }, current.revision, 'admin');
    await setupAndLogin(page, app.site);
    await page.goto(new URL('/admin/upstreams/cancel-fixture', app.site).toString());
    await expect(page.getByRole('heading', { name: '上游', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '测试连接' }).click();
    const notice = page.locator('.notice').filter({ hasText: '测试任务' });
    await expect(notice).toContainText('running', { timeout: 10_000 });
    await page.getByRole('button', { name: '停止测试' }).click();
    await expect(notice).toContainText('cancelled', { timeout: 10_000 });
    await expect(notice).toContainText('测试已取消');
    await expect(page.getByRole('button', { name: '停止测试' })).toHaveCount(0);
    const jobId = (await notice.innerText()).match(/job_[0-9a-f-]+/)?.[0];
    expect(jobId).toBeTruthy();
    const job = (await (await page.request.get(app.api(`/jobs/${jobId}`))).json()).data;
    expect(job).toMatchObject({ type: 'upstream-test', status: 'cancelled', resourceId: 'cancel-fixture' });
  } finally {
    await app.close();
    mock.closeAllConnections();
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  }
});

test('model capability declarations stay manual while test jobs and health history show real API state', async ({
  page,
}) => {
  const calls: string[] = [];
  const mock = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        model: 'local-model',
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
    );
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('Local mock listener has no port');
  const app = await startConsole(page, { withTelemetry: true });
  try {
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '上游', exact: true }).click();
    await page.getByRole('button', { name: '新增上游' }).click();
    const form = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '新增上游' }) });
    await form.getByLabel('供应商预设').selectOption('custom-openai');
    await form.getByLabel('名称').fill('Capability fixture');
    await form.getByLabel('认证方式').selectOption('none');
    await form.getByLabel('Base URL').fill(`http://127.0.0.1:${address.port}/v1`);
    await form.getByLabel('我明确允许对此上游使用 HTTP 明文传输').check();
    await form.getByLabel('启用上游').check();
    await form.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('link', { name: /Capability fixture/ })).toBeVisible();
    const created = (await (await page.request.get(app.api('/config'))).json()).data;
    const upstream = created.upstreams.find((item: { name: string }) => item.name === 'Capability fixture');
    expect(upstream).toBeTruthy();
    await page.getByRole('link', { name: /Capability fixture/ }).click();

    const models = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '模型目录' }) });
    await models.getByLabel('模型 ID').fill('local-model');
    await models.getByRole('button', { name: '添加模型' }).click();
    const editor = models.locator('.rows > .row').filter({ hasText: 'local-model' });
    await expect(editor).toBeVisible();
    await editor.getByText('编辑能力声明').click();
    await editor.getByLabel('local-model 文本').selectOption('supported');
    await editor.getByLabel('local-model 图片输入').selectOption('unsupported');
    await editor.getByLabel('local-model 工具调用').selectOption('supported');
    await editor.getByRole('button', { name: '保存能力声明' }).click();
    await expect(editor.getByText('能力来源：手动声明')).toBeVisible();
    await editor.getByLabel('local-model 工具调用').selectOption('unknown');
    await editor.getByRole('button', { name: '保存能力声明' }).click();
    await expect
      .poll(async () => {
        const config = (await (await page.request.get(app.api('/config'))).json()).data;
        return config.upstreams.find((item: { id: string }) => item.id === upstream.id)?.models[0]?.capabilities;
      })
      .toMatchObject({ text: 'supported', imageInput: 'unsupported', tools: 'unknown' });
    const saved = (await (await page.request.get(app.api('/config'))).json()).data;
    const model = saved.upstreams.find((item: { id: string }) => item.id === upstream.id).models[0];
    expect(model.capabilitiesSource).toBe('manual');
    expect(model.verifiedAt).toBeUndefined();
    await editor.getByRole('button', { name: '启用', exact: true }).click();

    const now = Date.now() - 10_000;
    await app.telemetry!.upsertRequest({
      id: 'health-fixture-request',
      proxyKeyId: null,
      source: 'health',
      clientProtocol: 'openai',
      requestModel: 'local-model',
      routeId: null,
      configRevision: saved.revision,
      state: 'failed',
      finalHttpStatus: 503,
      startedAtMs: now - 1000,
      endedAtMs: now,
      durationMs: 1000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: upstream.id,
    });
    await app.telemetry!.upsertAttempt({
      id: 'health-fixture-attempt',
      requestId: 'health-fixture-request',
      ordinal: 1,
      upstreamId: upstream.id,
      credentialId: null,
      resolvedModel: 'local-model',
      reportedModel: null,
      protocol: 'openai',
      outcome: 'failed',
      status: 503,
      retryReason: null,
      startedAtMs: now - 1000,
      endedAtMs: now,
      usage: {
        inputTotal: null,
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: null,
        reasoningOutput: null,
        status: 'missing',
        source: 'upstream',
        semanticsVersion: 'v2',
      },
      pricingVersion: null,
      costMicros: null,
      currency: null,
    });
    const history = page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: '健康事件与最近尝试' }) });
    await page.getByRole('button', { name: '刷新' }).click();
    await expect(history.locator('.timeline')).toContainText('HTTP 503');
    const events = (await (await page.request.get(app.api(`/upstreams/${upstream.id}/health-events`))).json()).data;
    expect(events[0]).toMatchObject({ id: 'health-fixture-attempt', outcome: 'failed', status: 503, source: 'health' });

    await page.getByRole('button', { name: '测试连接' }).click();
    const jobNotice = page.locator('.notice').filter({ hasText: '测试任务' });
    await expect(jobNotice).toContainText('completed', { timeout: 15_000 });
    const jobId = (await jobNotice.innerText()).match(/job_[0-9a-f-]+/)?.[0];
    expect(jobId).toBeTruthy();
    const job = (await (await page.request.get(app.api(`/jobs/${jobId}`))).json()).data;
    expect(job).toMatchObject({ status: 'completed', result: { ok: true, model: 'local-model', status: 200 } });
    expect(calls).toContain('POST /v1/chat/completions');
    const afterTest = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(afterTest.upstreams.find((item: { id: string }) => item.id === upstream.id).models[0]).toMatchObject({
      capabilitiesSource: 'manual',
      capabilities: { text: 'supported', imageInput: 'unsupported', tools: 'unknown' },
    });
    await expect(editor.getByText('能力来源：手动声明')).toBeVisible();
    await expect(editor.getByText('能力来源：已验证')).toHaveCount(0);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => mock.close((error) => (error ? reject(error) : resolve())));
  }
});

test('rotate a proxy Key and persist a different hash without exposing it in the list', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '访问 Key' }).click();
    const create = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '创建访问 Key' }) });
    await create.getByLabel('名称').fill('Rotating fixture');
    await create.getByRole('button', { name: '创建 Key' }).click();
    const secret = page.getByRole('status').locator('code');
    await expect(secret).not.toBeEmpty();
    const firstSecret = await secret.innerText();
    let config = (await (await page.request.get(app.api('/config'))).json()).data;
    const key = config.proxyKeys.find((item: { name: string }) => item.name === 'Rotating fixture');
    expect(key.keyHash).toBe(createHash('sha256').update(firstSecret).digest('hex'));
    await page.getByRole('button', { name: /Rotating fixture/ }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '轮换' }).click();
    await expect.poll(async () => secret.innerText()).not.toBe(firstSecret);
    const nextSecret = await secret.innerText();
    config = (await (await page.request.get(app.api('/config'))).json()).data;
    const rotated = config.proxyKeys.find((item: { id: string }) => item.id === key.id);
    expect(rotated.keyHash).toBe(createHash('sha256').update(nextSecret).digest('hex'));
    expect(rotated.keyHash).not.toBe(key.keyHash);
    const list = (await (await page.request.get(app.api('/keys'))).json()).data;
    expect(list.find((item: { id: string }) => item.id === key.id)).not.toHaveProperty('keyHash');
    await page.getByRole('button', { name: '我已保存' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByText(nextSecret, { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
