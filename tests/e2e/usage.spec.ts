import { expect, test } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

test('usage ranking selector stays in the URL, separates fallback request and attempt metrics, and shows costs', async ({
  page,
}) => {
  const app = await startConsole(page, { withTelemetry: true });
  try {
    // Keep fixture rows safely inside the UI's minute-rounded 24h window.
    const now = Date.now() - 60_000;
    await app.telemetry!.upsertRequest({
      id: 'usage-e2e-request',
      proxyKeyId: null,
      source: 'production',
      clientProtocol: 'openai',
      requestModel: 'e2e-model',
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
      finalUpstreamId: 'upstream-B',
    });
    const usage = {
      inputTotal: 1,
      inputUncached: 1,
      cacheRead: null,
      cacheWrite: null,
      cacheWrite5m: null,
      cacheWrite1h: null,
      outputTotal: 1,
      reasoningOutput: null,
      status: 'reported' as const,
      source: 'upstream' as const,
      semanticsVersion: 'v2' as const,
    };
    for (const [ordinal, upstreamId, outcome, currency, costMicros, attemptUsage] of [
      [1, 'upstream-A', 'failed', 'USD', 1_000_000, null],
      [2, 'upstream-B', 'completed', 'EUR', 2_000_000, usage],
      [3, 'upstream-B', 'completed', null, null, usage],
    ] as const) {
      await app.telemetry!.upsertAttempt({
        id: `usage-e2e-attempt-${ordinal}`,
        requestId: 'usage-e2e-request',
        ordinal,
        upstreamId,
        credentialId: null,
        resolvedModel: 'e2e-model',
        reportedModel: null,
        protocol: 'openai',
        outcome,
        status: outcome === 'failed' ? 502 : 200,
        retryReason: null,
        startedAtMs: now - 1000,
        endedAtMs: now,
        usage: attemptUsage,
        pricingVersion: null,
        costMicros,
        currency,
      });
    }
    await setupAndLogin(page, app.site);
    await expect(page.getByRole('heading', { name: '初始引导' })).toBeVisible();

    const summaryResponse = await page.request.get(
      app.api(
        '/usage/summary?from=' +
          encodeURIComponent(new Date(now - 86_400_000).toISOString()) +
          '&to=' +
          encodeURIComponent(new Date(now + 86_400_000).toISOString()) +
          '&source=proxy',
      ),
    );
    expect(summaryResponse.ok()).toBeTruthy();
    const summary = (await summaryResponse.json()).data;
    expect(summary.costByCurrency).toMatchObject({ USD: 1, EUR: 2 });
    expect(summary.unpricedAttempts).toBe(1);

    await page.getByRole('link', { name: '用量分析' }).click();
    await expect(page.getByRole('heading', { name: '用量分析' })).toBeVisible();
    await expect(page.getByText('USD 小计')).toBeVisible();
    await expect(page.getByText('EUR 小计')).toBeVisible();
    await expect(page.getByText(/缺少价格/)).toBeVisible();

    await page.getByLabel('排行维度').selectOption('upstreamId');
    await expect(page.getByText(/请求数按最终上游归属；尝试数、Token 与费用按实际参与尝试的上游统计/)).toBeVisible();
    const rowA = page.getByRole('row').filter({ hasText: 'upstream-A' });
    const rowB = page.getByRole('row').filter({ hasText: 'upstream-B' });
    await expect(rowA.getByRole('cell').nth(1)).toHaveText('0');
    await expect(rowA.getByRole('cell').nth(2)).toHaveText('1');
    await expect(rowA.getByRole('cell').nth(5)).toContainText('USD');
    await expect(rowB.getByRole('cell').nth(1)).toHaveText('1');
    await expect(rowB.getByRole('cell').nth(2)).toHaveText('2');
    await expect(rowB.getByRole('cell').nth(3)).toHaveText('2');
    await expect(rowB.getByRole('cell').nth(5)).toContainText('EUR');
    await page.getByLabel('上游筛选口径').selectOption('attempt');
    await expect(page).toHaveURL(/upstreamFilterMode=attempt/);

    await page.getByLabel('排行维度').selectOption('source');
    await expect(page).toHaveURL(/groupBy=source/);
    await expect(page.getByRole('heading', { name: '用量排行' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '生产代理' })).toBeVisible();
    await expect(page.getByRole('cell', { name: /USD/ })).toBeVisible();

    await page.getByLabel('排行维度').selectOption('keyId');
    await expect(page).toHaveURL(/groupBy=keyId/);
    await page.reload();
    await expect(page.getByLabel('排行维度')).toHaveValue('keyId');
  } finally {
    await app.close();
  }
});
