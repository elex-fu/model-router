import { expect, test } from '@playwright/test';
import { setupAndLogin, startConsole } from './harness';

test('shows forecast quota period dates without enabling adjustments before a ledger period exists', async ({
  page,
}) => {
  const app = await startConsole(page, { withQuota: true });
  try {
    await setupAndLogin(page, app.site);
    await page.getByRole('link', { name: '访问 Key' }).click();
    const create = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '创建访问 Key' }) });
    await create.getByLabel('名称').fill('Forecast quota fixture');
    await create.getByRole('button', { name: '创建 Key' }).click();
    await page.getByRole('button', { name: /Forecast quota fixture/ }).click();

    const keys = (await (await page.request.get(app.api('/keys'))).json()).data;
    const key = keys.find((item: { name: string }) => item.name === 'Forecast quota fixture');
    expect(key).toBeTruthy();
    const quotaResponse = await page.request.get(app.api(`/keys/${key.id}/quota`));
    expect(quotaResponse.ok()).toBeTruthy();
    const quota = (await quotaResponse.json()).data;
    expect(quota.periodId).toBeNull();
    expect(quota.periodStartMs).not.toBeNull();
    expect(quota.resetAtMs).not.toBeNull();

    const period = page.locator('div.panel').filter({ has: page.getByRole('heading', { name: '当前配额周期' }) });
    await expect(period.getByText('预计周期')).toBeVisible();
    await expect(period.getByText('预计开始')).toBeVisible();
    await expect(period.getByText('预计重置')).toBeVisible();
    const timezone = quota.periodTimezone;
    const expectedStart = new Date(quota.periodStartMs).toLocaleString('zh-CN', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    const expectedReset = new Date(quota.resetAtMs).toLocaleString('zh-CN', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    await expect(period).toContainText(expectedStart);
    await expect(period).toContainText(expectedReset);
    await expect(page.getByRole('button', { name: '提交修正' })).toBeDisabled();
  } finally {
    await app.close();
  }
});
