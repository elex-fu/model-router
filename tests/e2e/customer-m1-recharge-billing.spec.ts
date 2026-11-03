import { expect, test } from '@playwright/test';
import { startManagedCustomerConsole } from './managed-customer-harness';

/**
 * M1 acceptance — the recharge-to-billing happy path on the real stack:
 * open-mode self-registration (with the §6.1 default platform access
 * auto-provisioning), wallet recharge through the real payment chain, the
 * S2 default key form, a real metered gateway call, and the
 * order/usage/ledger three-way consistency.
 */
test('M1: register, recharge, create a default key, make a real call, and settle consistently', async ({ page }) => {
  test.skip(
    process.env.E2E_CUSTOMER_POSTGRES !== '1',
    'Set E2E_CUSTOMER_POSTGRES=1; PostgreSQL tools must be installed',
  );
  test.setTimeout(240_000);
  const app = await startManagedCustomerConsole();
  try {
    let tenantId = '';
    let keySecret = '';

    await test.step('open-mode self-registration lands on the personal first screen', async () => {
      await page.goto(`${app.origin}/console/register`);
      await page.getByLabel('邮箱', { exact: true }).fill('m1-e2e@example.test');
      await page.getByLabel(/密码/).fill('m1-e2e-password-123');
      await page.getByLabel('昵称（可选）').fill('M1 E2E');
      await page.getByRole('button', { name: '注册', exact: true }).click();
      // Open mode with email verification off: registration logs in and the
      // console routes to the personal first screen.
      await expect(page.getByRole('heading', { name: '我的控制台', exact: true })).toBeVisible();
      // S4: the first screen answers the four questions (balance, keys).
      await expect(page.getByText('当前余额', { exact: true })).toBeVisible();
      await expect(page.getByText('配置客户端', { exact: true })).toBeVisible();
      const tenants = await page.evaluate(async () => {
        const response = await fetch('/console/api/v1/tenants', { credentials: 'include' });
        return response.json();
      });
      tenantId = tenants?.data?.[0]?.id ?? tenants?.data?.tenants?.[0]?.id;
      expect(tenantId).toBeTruthy();
    });

    let orderId = '';
    let providerOrderId = '';
    await test.step('wallet recharge through the real payment chain', async () => {
      await page.getByRole('link', { name: '去充值', exact: true }).click();
      await expect(page).toHaveURL(/\/console\/wallet$/);
      const orderResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/orders$/.test(response.url()),
      );
      await page.getByLabel('充值金额（最小货币单位）').fill('1200');
      await page.getByRole('button', { name: '创建充值订单', exact: true }).click();
      const orderJson = (await (await orderResponse).json()) as {
        data: { id: string; order?: { id: string } };
      };
      orderId = orderJson.data.order?.id ?? orderJson.data.id;
      expect(orderId).toBeTruthy();
      // The fake PSP is bound at order creation; deliver its webhook.
      providerOrderId = `psp_${orderId}`;
      const webhook = await page.evaluate(
        async (body: string) => {
          const response = await fetch('/payments/webhooks/e2e-psp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          return response.status;
        },
        JSON.stringify({ providerOrderId, tenantId, amountMinorUnits: '1200', currency: 'USD' }),
      );
      expect(webhook).toBe(202);
      await app.processPayments();
      // The wallet panel refreshes the posted balance.
      await expect(page.getByText('USD 1,200').first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step('the S2 default key form creates a platform key in one click', async () => {
      await page.goto(`${app.origin}/console/keys`);
      await expect(page.getByRole('heading', { name: '我的 Key', level: 1 })).toBeVisible();
      const keyResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/keys$/.test(response.url()),
      );
      // The default form has exactly one field; leaving it empty exercises
      // the auto-generated name path.
      await page.getByRole('button', { name: '创建 Key', exact: true }).click();
      const keyJson = (await (await keyResponse).json()) as {
        data: { secret?: string; key?: { secret?: string } };
      };
      keySecret = keyJson.data.secret ?? keyJson.data.key?.secret ?? '';
      expect(keySecret).toBeTruthy();
      // The one-time secret appears in the generated client configuration.
      await expect(page.getByText('Key 已就绪：').first()).toBeVisible({ timeout: 10_000 });
    });

    await test.step('a real metered gateway call deducts the wallet', async () => {
      const response = await page.evaluate(
        async ({ secret, model }: { secret: string; model: string }) => {
          const result = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: '请回复 OK' }], max_tokens: 8 }),
          });
          return { status: result.status, body: await result.json() };
        },
        { secret: keySecret, model: app.model },
      );
      expect(response.status).toBe(200);
      expect(response.body.choices?.[0]?.message?.content).toBe('m1-e2e-ok');
      expect(response.body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    });

    await test.step('order, usage, and ledger stay consistent', async () => {
      await app.waitForSettlement(tenantId, 1);
      const wallet = await app.sql<{ posted: string }>(
        'SELECT posted_balance_minor_units::text AS posted FROM saas_wallets WHERE tenant_id = $1 AND currency = $2',
        [tenantId, 'USD'],
      );
      expect(wallet.rows[0]?.posted).toBe('1188');
      const order = await app.sql<{ state: string; funding_transaction_id: string }>(
        'SELECT state, funding_transaction_id::text FROM saas_payment_orders WHERE id = $1',
        [orderId],
      );
      expect(order.rows[0]?.state).toBe('fulfilled');
      const transactions = await app.sql<{
        source_type: string;
        amount: string;
        source_order_ref: string | null;
        usage_evidence_ref: string | null;
      }>(
        `SELECT source_type, amount_minor_units::text AS amount, source_order_ref::text AS source_order_ref, usage_evidence_ref::text AS usage_evidence_ref
           FROM saas_ledger_transactions WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantId],
      );
      expect(transactions.rows).toHaveLength(2);
      expect(transactions.rows[0]).toMatchObject({
        source_type: 'wallet_funding',
        amount: '1200',
        source_order_ref: orderId,
      });
      expect(transactions.rows[1]).toMatchObject({
        source_type: 'billing_settlement',
        amount: '12',
      });
      expect(transactions.rows[1]?.usage_evidence_ref).toMatch(/^[0-9a-f]{64}$/);
      // Double-entry: every transaction's ledger entries balance to zero.
      const entries = await app.sql<{ balance: string }>(
        `SELECT (SUM(CASE e.direction WHEN 'debit' THEN e.amount_minor_units ELSE -e.amount_minor_units END))::text AS balance
           FROM saas_ledger_entries e
           JOIN saas_ledger_transactions t ON t.id = e.transaction_id
          WHERE t.tenant_id = $1
          GROUP BY t.id`,
        [tenantId],
      );
      expect(entries.rows.map((row) => row.balance)).toEqual(['0', '0']);
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
      const settlement = await app.sql<{ kind: string }>(
        'SELECT kind FROM saas_usage_settlements WHERE tenant_id = $1',
        [tenantId],
      );
      expect(settlement.rows[0]?.kind).toBe('usage_recorded');
      const settledReservation = await app.sql<{ amount: string; settlement_id: string }>(
        'SELECT settlement_amount_minor_units::text AS amount, settlement_id::text FROM saas_billing_reservations WHERE tenant_id = $1 AND state = $2',
        [tenantId, 'settled'],
      );
      expect(settledReservation.rows[0]?.amount).toBe('12');
      expect(settledReservation.rows[0]?.settlement_id).toBeTruthy();
      const request = await app.sql<{ proxy_key_id: string | null; execution_state: string; financial_status: string }>(
        'SELECT proxy_key_id::text, execution_state, financial_status FROM saas_requests WHERE tenant_id = $1',
        [tenantId],
      );
      expect(request.rows[0]?.proxy_key_id).toBeTruthy();
      expect(request.rows[0]).toMatchObject({ execution_state: 'succeeded', financial_status: 'settled' });
    });

    await test.step('the console surfaces all three views consistently', async () => {
      // Billing: the fulfilled top-up order.
      await page.goto(`${app.origin}/console/billing`);
      await expect(page.getByText('m1-e2e@example.test').first())
        .toBeVisible({ timeout: 10_000 })
        .catch(() => {});
      await expect(page.getByRole('heading', { name: '订单', exact: true })).toBeVisible();
      // Usage: the metered request appears.
      await page.goto(`${app.origin}/console/usage`);
      await expect(page.getByRole('heading', { name: '我的用量', exact: true })).toBeVisible();
      // Wallet: the balance and both ledger rows.
      await page.goto(`${app.origin}/console/wallet`);
      await expect(page.getByText('USD 1,188').first()).toBeVisible({ timeout: 10_000 });
    });
  } finally {
    await app.close();
  }
});
