import { expect, test } from '@playwright/test';
import { startManagedCustomerConsole } from './managed-customer-harness';

/**
 * R8 minimal proof — the generic (non-codex) `/v1/responses` protocol bills
 * end-to-end on the real stack: bounded admission, exact settlement, and
 * upstream usage accounting through the responses JSON usage observer.
 * Non-streaming on purpose: the generic SSE usage observer does not support
 * providerProtocol 'responses', so a streaming call would never settle usage.
 */
test('R8: a /v1/responses call admits, bills, and settles exactly', async ({ page }) => {
  test.skip(
    process.env.E2E_CUSTOMER_POSTGRES !== '1',
    'Set E2E_CUSTOMER_POSTGRES=1; PostgreSQL tools must be installed',
  );
  test.setTimeout(240_000);
  const app = await startManagedCustomerConsole();
  try {
    let tenantId = '';
    let keySecret = '';

    await test.step('register and recharge the wallet', async () => {
      await page.goto(`${app.origin}/console/register`);
      await page.getByLabel('邮箱', { exact: true }).fill('m1-responses@example.test');
      await page.getByLabel(/密码/).fill('m1-responses-password-123');
      await page.getByRole('button', { name: '注册', exact: true }).click();
      await expect(page.getByRole('heading', { name: '我的控制台', exact: true })).toBeVisible();
      const tenants = await page.evaluate(async () => {
        const response = await fetch('/console/api/v1/tenants', { credentials: 'include' });
        return response.json();
      });
      tenantId = tenants?.data?.[0]?.id ?? tenants?.data?.tenants?.[0]?.id;
      expect(tenantId).toBeTruthy();

      await page.goto(`${app.origin}/console/wallet`);
      const orderResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/orders$/.test(response.url()),
      );
      await page.getByLabel('充值金额（最小货币单位）').fill('1200');
      await page.getByRole('button', { name: '创建充值订单', exact: true }).click();
      const orderJson = (await (await orderResponse).json()) as {
        data: { id: string; order?: { id: string } };
      };
      const orderId = orderJson.data.order?.id ?? orderJson.data.id;
      const webhook = await page.evaluate(
        async (body: string) => {
          const response = await fetch('/payments/webhooks/e2e-psp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          return response.status;
        },
        JSON.stringify({
          providerOrderId: `psp_${orderId}`,
          tenantId,
          amountMinorUnits: '1200',
          currency: 'USD',
        }),
      );
      expect(webhook).toBe(202);
      await app.processPayments();
      await expect(page.getByText('USD 1,200').first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step('create a default platform key', async () => {
      await page.goto(`${app.origin}/console/keys`);
      const keyResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/keys$/.test(response.url()),
      );
      await page.getByRole('button', { name: '创建 Key', exact: true }).click();
      const keyJson = (await (await keyResponse).json()) as {
        data: { secret?: string; key?: { secret?: string } };
      };
      keySecret = keyJson.data.secret ?? keyJson.data.key?.secret ?? '';
      expect(keySecret).toBeTruthy();
    });

    await test.step('one non-streaming /v1/responses call settles exactly', async () => {
      const response = await page.evaluate(
        async ({ secret, model }: { secret: string; model: string }) => {
          const result = await fetch('/v1/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
            body: JSON.stringify({ model, input: '请回复 OK', max_output_tokens: 8 }),
          });
          return { status: result.status, body: await result.json() };
        },
        { secret: keySecret, model: app.responsesModel },
      );
      expect(response.status).toBe(200);
      expect(response.body.usage).toEqual({
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
      });

      await app.waitForSettlement(tenantId, 1);
      const wallet = await app.sql<{ posted: string }>(
        'SELECT posted_balance_minor_units::text AS posted FROM saas_wallets WHERE tenant_id = $1 AND currency = $2',
        [tenantId, 'USD'],
      );
      expect(wallet.rows[0]?.posted).toBe('1188');
      const usage = await app.sql<{ input_total: string; output_total: string; status: string; source: string }>(
        'SELECT input_total::text, output_total::text, status, source FROM saas_usage_events WHERE tenant_id = $1',
        [tenantId],
      );
      expect(usage.rows[0]).toMatchObject({
        input_total: '3',
        output_total: '2',
        status: 'reported',
        source: 'upstream',
      });
      const settled = await app.sql<{ amount: string }>(
        'SELECT settlement_amount_minor_units::text AS amount FROM saas_billing_reservations WHERE tenant_id = $1 AND state = $2',
        [tenantId, 'settled'],
      );
      expect(settled.rows[0]?.amount).toBe('12');
      const request = await app.sql<{ execution_state: string; financial_status: string }>(
        'SELECT execution_state, financial_status FROM saas_requests WHERE tenant_id = $1',
        [tenantId],
      );
      expect(request.rows[0]).toMatchObject({ execution_state: 'succeeded', financial_status: 'settled' });
    });
  } finally {
    await app.close();
  }
});
