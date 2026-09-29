import { expect, test } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

test('configuration import preview is side-effect free and imported values can be rolled back', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '系统设置' }).click();

    const configUrl = app.api('/config');
    const initial = (await (await page.request.get(configUrl)).json()).data;
    const originalLimit = initial.quota.defaultMaxConcurrentRequests;
    const imported = { ...initial, quota: { ...initial.quota, defaultMaxConcurrentRequests: originalLimit + 2 } };
    const importPanel = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '导入配置' }) });
    await importPanel.getByLabel('导入模式').selectOption('replace');
    await importPanel.getByLabel('配置 JSON').fill(JSON.stringify(imported, null, 2));
    await importPanel.getByRole('button', { name: '预览差异' }).click();
    await expect(importPanel.getByText(/"baseRevision":\s*1/)).toBeVisible();
    await expect(importPanel.getByRole('button', { name: '确认导入' })).toBeEnabled();
    let config = (await (await page.request.get(configUrl)).json()).data;
    expect(config.revision).toBe(1);
    expect(config.quota.defaultMaxConcurrentRequests).toBe(originalLimit);

    await importPanel.getByRole('button', { name: '确认导入' }).click();
    await expect.poll(async () => (await (await page.request.get(configUrl)).json()).data.revision).toBe(2);
    config = (await (await page.request.get(configUrl)).json()).data;
    expect(config.quota.defaultMaxConcurrentRequests).toBe(originalLimit + 2);

    const history = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '配置历史' }) });
    await expect(history.locator('.row').filter({ hasText: 'v1' })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await history.locator('.row').filter({ hasText: 'v1' }).getByRole('button', { name: '回退' }).click();
    await expect.poll(async () => (await (await page.request.get(configUrl)).json()).data.revision).toBe(3);
    config = (await (await page.request.get(configUrl)).json()).data;
    expect(config.quota.defaultMaxConcurrentRequests).toBe(originalLimit);
  } finally {
    await app.close();
  }
});

test('configuration history rollback restores persisted values with a new revision', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '系统设置' }).click();
    const editor = page.getByLabel('脱敏配置 JSON');
    const initial = JSON.parse(await editor.inputValue());
    const originalLimit = initial.quota.defaultMaxConcurrentRequests;
    initial.quota.defaultMaxConcurrentRequests = originalLimit + 1;
    await editor.fill(JSON.stringify(initial));
    await page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: '配置校验与提交' }) })
      .getByRole('button', { name: '保存' })
      .click();
    await expect.poll(async () => (await (await page.request.get(app.api('/config'))).json()).data.revision).toBe(2);
    let config = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(config.quota.defaultMaxConcurrentRequests).toBe(originalLimit + 1);
    const history = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '配置历史' }) });
    await expect(history.locator('.row').filter({ hasText: 'v1' })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await history.locator('.row').filter({ hasText: 'v1' }).getByRole('button', { name: '回退' }).click();
    await expect.poll(async () => (await (await page.request.get(app.api('/config'))).json()).data.revision).toBe(3);
    config = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(config.quota.defaultMaxConcurrentRequests).toBe(originalLimit);
    const historyRows = (await (await page.request.get(app.api('/config/history'))).json()).data;
    expect(historyRows.map((row: { revision: number }) => row.revision)).toEqual([3, 2, 1]);
  } finally {
    await app.close();
  }
});

test('revision conflict shows field differences and requires an explicit choice before rebase', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '系统设置' }).click();
    const editor = page.getByLabel('脱敏配置 JSON');
    const base = JSON.parse(await editor.inputValue());
    const mine = structuredClone(base);
    mine.quota.defaultMaxConcurrentRequests = base.quota.defaultMaxConcurrentRequests + 1;
    mine.storage.dailyRetentionDays = base.storage.dailyRetentionDays + 1;
    await editor.fill(JSON.stringify(mine, null, 2));

    const latest = structuredClone(base);
    latest.quota.defaultMaxConcurrentRequests = base.quota.defaultMaxConcurrentRequests + 2;
    latest.storage.hourRetentionDays = base.storage.hourRetentionDays + 5;
    await app.admin.control.commit(latest, base.revision, 'e2e');
    const latestPersisted = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(latestPersisted.revision).toBe(base.revision + 1);

    let failLatestRead = false;
    await page.route(app.api('/config'), async (route) => {
      if (route.request().method() === 'PUT') {
        const response = await route.fetch();
        if (response.status() === 412) failLatestRead = true;
        await route.fulfill({ response });
        return;
      }
      if (route.request().method() === 'GET' && failLatestRead) {
        failLatestRead = false;
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: '保存', exact: true }).click();
    const conflictPanel = page
      .locator('section.panel')
      .filter({ has: page.getByRole('heading', { name: '配置版本冲突' }) });
    await expect(conflictPanel).toBeVisible();
    await expect(conflictPanel.getByRole('alert')).toContainText('草稿仍保留');
    await conflictPanel.getByRole('button', { name: '重试读取最新配置' }).click();
    const conflictedField = conflictPanel.locator('[data-conflict-path="quota.defaultMaxConcurrentRequests"]');
    await expect(conflictedField).toContainText(String(base.quota.defaultMaxConcurrentRequests));
    await expect(conflictedField).toContainText(String(mine.quota.defaultMaxConcurrentRequests));
    await expect(conflictedField).toContainText(String(latest.quota.defaultMaxConcurrentRequests));
    await expect(conflictPanel.locator('[data-conflict-path="storage.dailyRetentionDays"]')).toContainText(
      String(mine.storage.dailyRetentionDays),
    );
    await expect(conflictPanel.locator('[data-conflict-path="storage.hourRetentionDays"]')).toContainText(
      String(latest.storage.hourRetentionDays),
    );

    const reapply = conflictPanel.getByRole('button', { name: '重新应用到最新配置' });
    await expect(reapply).toBeDisabled();
    await conflictedField.getByLabel('保留我的值').check();
    await expect(reapply).toBeEnabled();
    await reapply.click();

    const rebased = JSON.parse(await editor.inputValue());
    expect(rebased.revision).toBe(latestPersisted.revision);
    expect(rebased.quota.defaultMaxConcurrentRequests).toBe(mine.quota.defaultMaxConcurrentRequests);
    expect(rebased.storage.dailyRetentionDays).toBe(mine.storage.dailyRetentionDays);
    expect(rebased.storage.hourRetentionDays).toBe(latest.storage.hourRetentionDays);
    let persisted = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(persisted.revision).toBe(latestPersisted.revision);
    expect(persisted.quota.defaultMaxConcurrentRequests).toBe(latest.quota.defaultMaxConcurrentRequests);

    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect
      .poll(async () => (await (await page.request.get(app.api('/config'))).json()).data.revision)
      .toBe(latestPersisted.revision + 1);
    persisted = (await (await page.request.get(app.api('/config'))).json()).data;
    expect(persisted.quota.defaultMaxConcurrentRequests).toBe(mine.quota.defaultMaxConcurrentRequests);
    expect(persisted.storage.dailyRetentionDays).toBe(mine.storage.dailyRetentionDays);
    expect(persisted.storage.hourRetentionDays).toBe(latest.storage.hourRetentionDays);
  } finally {
    await app.close();
  }
});

test('backup job failure is visible and recorded when telemetry is unavailable', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '系统设置' }).click();
    const maintenance = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '维护任务' }) });
    await maintenance.getByRole('button', { name: '创建备份' }).click();
    await expect(maintenance).toContainText('failed');
    const jobId = await maintenance.locator('.notice code').first().innerText();
    const job = await page.request.get(app.api(`/jobs/${jobId}`));
    expect(job.status()).toBe(200);
    expect((await job.json()).data).toMatchObject({ status: 'failed' });
    await expect(maintenance).toContainText('Complete backup requires a telemetry store');
  } finally {
    await app.close();
  }
});

test('stopping a streaming playground run cancels the backend job without external calls', async ({ page }) => {
  let executorAborted = false;
  const app = await startConsole(page, {
    playgroundExecutor: async ({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('cancelled'));
        signal.addEventListener(
          'abort',
          () => {
            executorAborted = true;
            reject(new Error('cancelled'));
          },
          { once: true },
        );
      }),
  });
  try {
    await setupAndLogin(page, app.site);
    const config = await app.admin.control.raw();
    config.upstreams.push({
      id: 'local-playground',
      name: 'Local playground',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'http://127.0.0.1:9/v1',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'none' },
      credentials: [],
      priority: 0,
      sortIndex: 0,
      policy: { allowInsecureHttp: true },
      models: [{ id: 'local-model', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
    });
    config.routes.push({
      id: 'local-playground-route',
      name: 'Local playground route',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'exact', value: 'playground-model' },
      order: 0,
      publishedModels: ['playground-model'],
      targets: [{ upstreamId: 'local-playground', model: 'local-model' }],
    });
    await app.admin.control.commit(config, 1, 'e2e');
    await app.admin.control.createKey({ id: 'playground-key', name: 'Playground fixture' }, 2, 'e2e');
    await page.getByRole('link', { name: '测试台' }).click();
    await page.getByLabel('访问身份').selectOption('playground-key');
    await page.getByLabel('客户端模型').fill('playground-model');
    await page.getByLabel('输入').fill('Wait until cancelled');
    await page.getByLabel('流式响应').check();
    const started = page.waitForResponse(
      (response) => response.url().endsWith('/playground/runs') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送测试' }).click();
    const response = await started;
    expect(response.status()).toBe(200);
    const runId = response.headers()['x-run-id'];
    expect(runId).toMatch(/^run_/);
    await page.getByRole('button', { name: '停止' }).click();
    await expect
      .poll(async () => (await (await page.request.get(app.api(`/playground/runs/${runId}`))).json()).data.state)
      .toBe('cancelled');
    expect(executorAborted).toBe(true);
    const audit = (await (await page.request.get(app.api('/audit-events'))).json()).data;
    expect(audit.some((event: { action: string }) => event.action === 'playground.cancel')).toBe(true);
  } finally {
    await app.close();
  }
});

test('setup guide verification completion persists after a successful mock playground run and reload', async ({
  page,
}) => {
  const app = await startConsole(page, {
    playgroundExecutor: async ({ target }) => ({
      output: 'mock response',
      status: 200,
      upstreamId: target.upstreamId,
      model: target.model,
      durationMs: 4,
      usage: { inputTotal: 2, outputTotal: 3 },
    }),
  });
  try {
    await setupAndLogin(page, app.site);
    const config = await app.admin.control.raw();
    config.upstreams.push({
      id: 'local-success',
      name: 'Local success',
      provider: 'custom',
      protocol: 'openai',
      enabled: true,
      baseUrl: 'http://127.0.0.1:9/v1',
      endpoints: { generate: 'chat/completions' },
      auth: { mode: 'none' },
      credentials: [],
      priority: 0,
      sortIndex: 0,
      policy: { allowInsecureHttp: true },
      models: [{ id: 'local-model', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
    });
    config.routes.push({
      id: 'local-success-route',
      name: 'Local success route',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'exact', value: 'playground-model' },
      order: 0,
      publishedModels: ['playground-model'],
      targets: [{ upstreamId: 'local-success', model: 'local-model' }],
    });
    await app.admin.control.commit(config, 1, 'e2e');
    await app.admin.control.createKey({ id: 'playground-key', name: 'Playground fixture' }, 2, 'e2e');

    const guide = `${app.site}setup/guide?step=5`;
    await page.goto(guide);
    const lastStep = page.locator('.setup-steps li').nth(5);
    await expect(lastStep).toContainText('待完成');
    await expect(page).toHaveURL(/\/setup\/guide\?step=5$/);
    await page.reload();
    await expect(page).toHaveURL(/\/setup\/guide\?step=5$/);
    await expect(lastStep).toContainText('待完成');
    await expect(page.getByRole('heading', { name: '6 / 6 · 验证调用' })).toBeVisible();

    await page.getByRole('link', { name: '打开测试台 →', exact: true }).click();
    await page.getByLabel('访问身份').selectOption('playground-key');
    await page.getByLabel('客户端模型').fill('playground-model');
    await page.getByLabel('输入').fill('Local mock verification');
    const runResponse = page.waitForResponse(
      (response) => response.url().endsWith('/playground/runs') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送测试' }).click();
    expect((await runResponse).status()).toBe(200);
    await expect(page.getByText('mock response')).toBeVisible();

    const status = await page.request.get(app.api('/playground/status'));
    expect(status.status()).toBe(200);
    expect((await status.json()).data).toMatchObject({ completed: true, successfulRuns: 1 });
    await page.goto(guide);
    await expect(page.locator('.setup-steps li').nth(5)).toContainText('已配置');
  } finally {
    await app.close();
  }
});
