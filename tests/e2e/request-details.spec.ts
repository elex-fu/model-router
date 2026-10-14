import { expect, test } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`request details open at the top after clicking the end of a long list (${viewport.width}px)`, async ({
    page,
  }) => {
    const app = await startConsole(page, { withTelemetry: true });
    try {
      const telemetry = app.telemetry;
      if (!telemetry) throw new Error('Request detail fixture needs telemetry');
      const now = Date.now() - 120_000;
      const target = 'request-detail-35';
      for (let index = 0; index < 36; index++) {
        await telemetry.upsertRequest({
          id: `request-detail-${String(index).padStart(2, '0')}`,
          proxyKeyId: 'detail-key',
          source: 'production',
          clientProtocol: 'openai',
          requestModel: 'detail-model',
          routeId: null,
          configRevision: 1,
          state: 'completed',
          finalHttpStatus: 200,
          startedAtMs: now - index * 1000,
          endedAtMs: now - index * 1000 + 800,
          durationMs: 800,
          firstByteMs: null,
          firstEventMs: null,
          firstTextMs: null,
          finalUpstreamId: 'final-upstream',
        });
      }
      for (const [ordinal, upstreamId, outcome, status] of [
        [1, 'first-upstream', 'failed', 502],
        [2, 'final-upstream', 'completed', 200],
      ] as const) {
        await telemetry.upsertAttempt({
          id: `detail-attempt-${ordinal}`,
          requestId: target,
          ordinal,
          upstreamId,
          credentialId: null,
          resolvedModel: 'detail-provider-model',
          reportedModel: null,
          protocol: 'openai',
          outcome,
          status,
          retryReason: ordinal === 1 ? 'upstream_error' : null,
          startedAtMs: now - 35_000,
          endedAtMs: now - 34_200,
          usage:
            outcome === 'failed'
              ? null
              : {
                  inputTotal: 3,
                  inputUncached: 3,
                  cacheRead: null,
                  cacheWrite: null,
                  cacheWrite5m: null,
                  cacheWrite1h: null,
                  outputTotal: 2,
                  reasoningOutput: null,
                  status: 'reported',
                  source: 'upstream',
                  semanticsVersion: 'v2',
                },
          pricingVersion: null,
          costMicros: null,
          currency: null,
        });
      }
      await setupAndLogin(page, app.site);
      await expect(page.getByRole('heading', { name: '初始引导', exact: true })).toBeVisible();
      await page.setViewportSize(viewport);
      const filters = '?range=7d&status=succeeded&model=detail-model&keyId=detail-key&upstreamId=final-upstream';
      await page.goto(`${app.origin}/admin/requests${filters}`);
      await expect(page.getByRole('row')).toHaveCount(37);
      await page.getByRole('link', { name: target, exact: true }).click();
      await expect(page).toHaveURL(`${app.origin}/admin/requests/${target}${filters}`);
      const heading = page.getByRole('heading', { name: '请求详情', exact: true, level: 1 });
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expect(heading).toBeFocused();
      await expect(page.getByRole('heading', { name: '请求日志', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('模型筛选')).toHaveCount(0);
      const info = page
        .locator('section')
        .filter({ has: page.getByRole('heading', { name: '请求信息', exact: true }) });
      await expect(info).toContainText(target);
      await expect(info).toContainText('detail-provider-model');
      await expect(info).toContainText('succeeded');
      await expect(page.locator('.timeline li')).toHaveCount(2);
      await expect(page.locator('.timeline')).toContainText('first-upstream');
      await expect(page.locator('.timeline')).toContainText('final-upstream');

      await page.reload();
      await expect(heading).toBeInViewport({ ratio: 1 });
      await expect(info).toContainText(target);
      await expect(page.getByRole('heading', { name: '请求日志', exact: true })).toHaveCount(0);
      await page.getByRole('link', { name: '返回请求日志' }).click();
      await expect(page).toHaveURL(`${app.origin}/admin/requests${filters}`);
      await expect(page.getByLabel('模型筛选')).toHaveValue('detail-model');
      await expect(page.getByLabel('Key ID 筛选')).toHaveValue('detail-key');
      await expect(page.getByLabel('上游 ID 筛选')).toHaveValue('final-upstream');
      await expect(page.getByRole('heading', { name: '请求详情', exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: target, exact: true })).toBeVisible();
    } finally {
      await app.close();
    }
  });
}
