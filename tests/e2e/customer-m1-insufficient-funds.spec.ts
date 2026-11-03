import { expect, test } from '@playwright/test';
import { startManagedCustomerConsole } from './managed-customer-harness';

/**
 * M1 acceptance — insufficient funds rejects stably: a freshly registered
 * tenant with an empty wallet gets HTTP 402 PAYMENT_REQUIRED from the real
 * admission path (INSUFFICIENT_FUNDS → hold_denied → 402), a retried request
 * with the same idempotency key stays a durable replay (no new effects), and
 * the database never shows a reservation, ledger row, or usage event. The
 * balance never goes negative.
 */
test('M1: an empty wallet rejects gateway calls stably with no side effects', async ({ page }) => {
  test.skip(
    process.env.E2E_CUSTOMER_POSTGRES !== '1',
    'Set E2E_CUSTOMER_POSTGRES=1; PostgreSQL tools must be installed',
  );
  test.setTimeout(240_000);
  const app = await startManagedCustomerConsole();
  try {
    let tenantId = '';
    let keySecret = '';

    await test.step('register and create a key without recharging', async () => {
      await page.goto(`${app.origin}/console/register`);
      await page.getByLabel('邮箱', { exact: true }).fill('m1-402@example.test');
      await page.getByLabel(/密码/).fill('m1-402-password-123');
      await page.getByRole('button', { name: '注册', exact: true }).click();
      await expect(page.getByRole('heading', { name: '我的控制台', exact: true })).toBeVisible();
      // The first screen shows the empty balance, never a negative one.
      await expect(page.getByText('当前余额', { exact: true })).toBeVisible();
      await expect(page.getByText(/USD -\d/)).toHaveCount(0);
      const tenants = await page.evaluate(async () => {
        const response = await fetch('/console/api/v1/tenants', { credentials: 'include' });
        return response.json();
      });
      tenantId = tenants?.data?.[0]?.id ?? tenants?.data?.tenants?.[0]?.id;
      expect(tenantId).toBeTruthy();

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

    const call = (idempotencyKey: string) =>
      page.evaluate(
        async ({ secret, model, idempotencyKey: key }: { secret: string; model: string; idempotencyKey: string }) => {
          const result = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${secret}`,
              ...(key === '' ? {} : { 'idempotency-key': key }),
            },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: '请回复 OK' }], max_tokens: 8 }),
          });
          let body: Record<string, unknown> = {};
          try {
            body = (await result.json()) as Record<string, unknown>;
          } catch {
            /* non-JSON bodies stay empty */
          }
          return { status: result.status, body };
        },
        { secret: keySecret, model: app.model, idempotencyKey },
      );

    await test.step('an empty wallet is rejected with a stable 402 envelope', async () => {
      const first = await call('m1-402-first');
      expect(first.status).toBe(402);
      const error = first.body.error as { code?: string } | undefined;
      expect(error?.code).toBe('PAYMENT_REQUIRED');
    });

    await test.step('the same idempotency key replays the rejection without new effects', async () => {
      const replay = await call('m1-402-first');
      expect(replay.status).toBe(402);
      expect((replay.body.error as { code?: string } | undefined)?.code).toBe('PAYMENT_REQUIRED');
      // A fresh idempotency key is rejected again the same way.
      const fresh = await call('m1-402-second');
      expect(fresh.status).toBe(402);
      expect((fresh.body.error as { code?: string } | undefined)?.code).toBe('PAYMENT_REQUIRED');
    });

    await test.step('the database shows no billing, ledger, or usage effects', async () => {
      const reservations = await app.sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_billing_reservations
          WHERE tenant_id = $1 AND state IN ('reserved', 'settled', 'reconciliation_pending')`,
        [tenantId],
      );
      expect(reservations.rows[0]?.count).toBe('0');
      const transactions = await app.sql<{ count: string }>(
        'SELECT count(*)::text AS count FROM saas_ledger_transactions WHERE tenant_id = $1',
        [tenantId],
      );
      expect(transactions.rows[0]?.count).toBe('0');
      const entries = await app.sql<{ count: string }>(
        `SELECT count(*)::text AS count FROM saas_ledger_entries e
           JOIN saas_ledger_transactions t ON t.id = e.transaction_id
          WHERE t.tenant_id = $1`,
        [tenantId],
      );
      expect(entries.rows[0]?.count).toBe('0');
      const usage = await app.sql<{ count: string }>(
        'SELECT count(*)::text AS count FROM saas_usage_events WHERE tenant_id = $1',
        [tenantId],
      );
      expect(usage.rows[0]?.count).toBe('0');
      const wallet = await app.sql<{ count: string; posted: string | null }>(
        'SELECT count(*)::text AS count, min(posted_balance_minor_units)::text AS posted FROM saas_wallets WHERE tenant_id = $1',
        [tenantId],
      );
      // No wallet row exists (nothing was ever funded) — never a negative balance.
      expect(wallet.rows[0]?.count).toBe('0');
      const orders = await app.sql<{ count: string }>(
        'SELECT count(*)::text AS count FROM saas_payment_orders WHERE tenant_id = $1',
        [tenantId],
      );
      expect(orders.rows[0]?.count).toBe('0');
    });
  } finally {
    await app.close();
  }
});
