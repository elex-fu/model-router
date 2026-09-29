import { expect, test } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

test('request filter deep link selects real telemetry rows and preserves detail filters', async ({ page }) => {
  const app = await startConsole(page, { withTelemetry: true });
  try {
    // The console rounds the upper bound down to the current minute.
    const now = Date.now() - 120_000;
    for (const [id, keyId, model, state, status] of [
      ['req-alpha', 'key-alpha', 'alpha', 'completed', 200],
      ['req-beta', 'key-beta', 'beta', 'failed', 502],
    ] as const) {
      await app.telemetry!.upsertRequest({
        id,
        proxyKeyId: keyId,
        source: 'production',
        clientProtocol: 'openai',
        requestModel: model,
        routeId: null,
        configRevision: 1,
        state,
        finalHttpStatus: status,
        startedAtMs: now - 1000,
        endedAtMs: now,
        durationMs: 1000,
        firstByteMs: null,
        firstEventMs: null,
        firstTextMs: null,
        finalUpstreamId: 'local-upstream',
      });
    }
    await app.telemetry!.upsertAttempt({
      id: 'attempt-alpha',
      requestId: 'req-alpha',
      ordinal: 1,
      upstreamId: 'local-upstream',
      credentialId: null,
      resolvedModel: 'alpha',
      reportedModel: null,
      protocol: 'openai',
      outcome: 'completed',
      status: 200,
      retryReason: null,
      startedAtMs: now - 1000,
      endedAtMs: now,
      usage: {
        inputTotal: 1,
        inputUncached: 1,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
        outputTotal: 1,
        reasoningOutput: null,
        status: 'reported',
        source: 'upstream',
        semanticsVersion: 'v2',
      },
      pricingVersion: null,
      costMicros: null,
      currency: null,
    });
    await setupAndLogin(page, app.site);
    const filters = '?status=succeeded&model=alpha&keyId=key-alpha';
    await page.goto(`${app.origin}/admin/requests${filters}`);
    await expect(page.getByLabel('模型筛选')).toHaveValue('alpha');
    await expect(page.getByLabel('Key ID 筛选')).toHaveValue('key-alpha');
    await expect(page.getByRole('link', { name: 'req-alpha' })).toBeVisible();
    await expect(page.getByText('req-beta')).toHaveCount(0);
    const filtered = await page.request.get(app.api(`/requests${filters}`));
    expect(filtered.status()).toBe(200);
    expect((await filtered.json()).data.map((row: { id: string }) => row.id)).toEqual(['req-alpha']);
    await page.getByRole('link', { name: 'req-alpha' }).click();
    await expect(page.getByRole('heading', { name: '请求详情' })).toBeVisible();
    await expect(page.locator('.timeline')).toContainText('local-upstream');
    expect(new URL(page.url()).search).toBe(filters);
    const detail = await page.request.get(app.api('/requests/req-alpha'));
    expect(detail.status()).toBe(200);
    expect((await detail.json()).data.id).toBe('req-alpha');
  } finally {
    await app.close();
  }
});

test('usage deep link applies key filters to summary and ranking and preserves the URL', async ({ page }) => {
  const app = await startConsole(page, { withTelemetry: true });
  try {
    const now = Date.now() - 120_000;
    const usage = {
      inputTotal: 3,
      inputUncached: 3,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      outputTotal: 2,
      reasoningOutput: null,
      status: 'reported' as const,
      source: 'upstream' as const,
      semanticsVersion: 'v2' as const,
    };
    for (const [id, keyId] of [
      ['usage-key-alpha', 'key-alpha'],
      ['usage-key-beta', 'key-beta'],
    ] as const) {
      await app.admin.control.createKey(
        { id: keyId, name: keyId },
        (await app.admin.control.raw()).revision,
        'admin',
      );
      await app.telemetry!.upsertRequest({
        id, proxyKeyId: keyId, source: 'production', clientProtocol: 'openai', requestModel: 'fixture-model',
        routeId: null, configRevision: 1, state: 'completed', finalHttpStatus: 200,
        startedAtMs: now - 1000, endedAtMs: now, durationMs: 1000,
        firstByteMs: null, firstEventMs: null, firstTextMs: null, finalUpstreamId: 'fixture-upstream',
      });
      await app.telemetry!.upsertAttempt({
        id: `${id}-attempt`, requestId: id, ordinal: 1, upstreamId: 'fixture-upstream', credentialId: null,
        resolvedModel: 'fixture-model', reportedModel: null, protocol: 'openai', outcome: 'completed', status: 200,
        retryReason: null, startedAtMs: now - 1000, endedAtMs: now,
        usage,
        pricingVersion: null, costMicros: null, currency: null,
      });
    }
    await setupAndLogin(page, app.site);
    const filters = '?range=24h&keyId=key-alpha&source=proxy&groupBy=keyId';
    await page.goto(`${app.origin}/admin/usage${filters}`);
    await expect(page.getByRole('heading', { name: '用量分析' })).toBeVisible();
    await expect(page.getByLabel('访问 Key')).toHaveValue('key-alpha');
    await expect(page.getByLabel('排行维度')).toHaveValue('keyId');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(`/admin/usage${filters}`);
    await expect(page.locator('.stats .stat').first()).toContainText('1 / 1');
    await expect(page.locator('.stats .stat').nth(1)).toContainText('3 / 2');
    await expect(page.getByRole('row').filter({ hasText: 'key-alpha' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'key-beta' })).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('访问 Key')).toHaveValue('key-alpha');
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(`/admin/usage${filters}`);
    await expect(page.getByRole('row').filter({ hasText: 'key-alpha' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'key-beta' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('disconnected overview API shows an error and recovers after retry', async ({ page }) => {
  const app = await startConsole(page, { withTelemetry: true });
  try {
    await setupAndLogin(page, app.site);
    await page.route('**/admin/api/v1/overview?*', (route) => route.abort('internetdisconnected'));
    await page.getByRole('link', { name: '总览' }).click();
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 15_000 });
    await page.unroute('**/admin/api/v1/overview?*');
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByRole('link', { name: /请求数/ })).toBeVisible();
    expect((await page.request.get(app.api('/overview'))).status()).toBe(200);
  } finally {
    await app.close();
  }
});

test('browser offline banner pauses overview polling and reconnect refreshes real data', async ({ page, context }) => {
  const app = await startConsole(page, { withTelemetry: true });
  try {
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '总览' }).click();
    const requestCount = page.locator('a.stat').filter({ hasText: '请求数' }).locator('strong');
    await expect(requestCount).toHaveText('0');
    let offlineOverviewRequests = 0;
    let countingOffline = false;
    page.on('request', (request) => {
      if (countingOffline && request.url().includes('/admin/api/v1/overview?')) {
        offlineOverviewRequests++;
      }
    });

    await context.setOffline(true);
    await expect(page.getByRole('alert').filter({ hasText: '浏览器已离线' })).toBeVisible();
    countingOffline = true;
    const now = Date.now() - 120_000;
    await app.telemetry!.upsertRequest({
      id: 'offline-reconnect-request',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'local-model',
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: now - 1000,
      endedAtMs: now,
      durationMs: 1000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });
    await page.waitForTimeout(5_500); // The overview normally polls every five seconds.
    expect(offlineOverviewRequests).toBe(0);
    await expect(requestCount).toHaveText('0');

    countingOffline = false;
    await context.setOffline(false);
    await expect(page.getByRole('alert').filter({ hasText: '浏览器已离线' })).toHaveCount(0);
    await expect(requestCount).toHaveText('1', { timeout: 15_000 });
  } finally {
    await context.setOffline(false);
    await app.close();
  }
});

test('event stream resync refreshes active overview data and closes on navigation', async ({ page }) => {
  const app = await startConsole(page, { withTelemetry: true });
  try {
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      const instances: Array<EventSource & { closeCalled?: boolean }> = [];
      Object.defineProperty(window, '__eventStreams', { value: instances });
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          const stream = this as EventSource & { closeCalled?: boolean };
          stream.closeCalled = false;
          const close = stream.close.bind(stream);
          stream.close = () => {
            stream.closeCalled = true;
            close();
          };
          instances.push(stream);
        }
      };
    });
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '总览' }).click();
    const requestCount = page.locator('a.stat').filter({ hasText: '请求数' }).locator('strong');
    await expect(requestCount).toHaveText('0');
    await expect
      .poll(() => page.evaluate(() => (window as Window & { __eventStreams: EventSource[] }).__eventStreams.length))
      .toBeGreaterThan(0);

    const overviewRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/admin/api/v1/overview?')) overviewRequests.push(request.url());
    });
    const now = Date.now() - 120_000;
    await app.telemetry!.upsertRequest({
      id: 'sse-resync-request',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'local-model',
      routeId: null,
      configRevision: 1,
      state: 'completed',
      finalHttpStatus: 200,
      startedAtMs: now - 1000,
      endedAtMs: now,
      durationMs: 1000,
      firstByteMs: null,
      firstEventMs: null,
      firstTextMs: null,
      finalUpstreamId: null,
    });

    const streamState = page.evaluate(() => {
      const streams = (window as Window & { __eventStreams: Array<EventSource & { closeCalled?: boolean }> })
        .__eventStreams;
      const activeStream = streams.at(-1)!;
      activeStream.dispatchEvent(new Event('open'));
      activeStream.dispatchEvent(new MessageEvent('resync', { data: '{}' }));
      return true;
    });
    await expect(requestCount).toHaveText('1', { timeout: 15_000 });
    expect(await streamState).toBe(true);
    await expect.poll(() => overviewRequests.length).toBeGreaterThan(0);
    const requestsAfterResync = overviewRequests.length;
    await page.getByRole('link', { name: '上游', exact: true }).click();
    await expect(page.getByRole('heading', { name: '上游', exact: true })).toBeVisible();
    const streamsBeforeCleanup = await page.evaluate(
      () =>
        (window as Window & { __eventStreams: Array<EventSource & { closeCalled?: boolean }> }).__eventStreams.length,
    );
    await expect
      .poll(() =>
        page.evaluate((index) => {
          const streams = (window as Window & { __eventStreams: Array<EventSource & { closeCalled?: boolean }> })
            .__eventStreams;
          return streams.slice(0, index).some((stream) => stream.closeCalled);
        }, streamsBeforeCleanup),
      )
      .toBe(true);
    const requestCountAfterCleanup = overviewRequests.length;
    await page.waitForTimeout(1_000);
    expect(overviewRequests.length).toBe(requestCountAfterCleanup);
    expect(requestCountAfterCleanup).toBeGreaterThanOrEqual(requestsAfterResync);
  } finally {
    await app.close();
  }
});

test('expired server session returns 401 and reload requires login', async ({ page }) => {
  const app = await startConsole(page);
  try {
    await setupAndLogin(page, app.site);
    app.admin.store.db.prepare('UPDATE sessions SET expires_at=0').run();
    expect((await page.request.get(app.api('/session'))).status()).toBe(401);
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
