import { expect, test } from '@playwright/test';
import { startManagedCustomerConsole } from './managed-customer-harness';

/**
 * M1 acceptance — multi-user usage attribution: two keys in the default
 * project ("one key per person"), with usage grouped per key and every
 * settlement landing in the ONE tenant wallet. Folds in the remaining
 * S1/S5/S6 simplicity assertions and one streaming call (streaming
 * settlement, webhook replay, and double-entry invariants are already
 * covered by FIN-01 and the per-PSP drills).
 */
test('M1: usage groups per key and per project into one tenant wallet', async ({ page }) => {
  test.skip(
    process.env.E2E_CUSTOMER_POSTGRES !== '1',
    'Set E2E_CUSTOMER_POSTGRES=1; PostgreSQL tools must be installed',
  );
  test.setTimeout(240_000);
  const app = await startManagedCustomerConsole();
  try {
    let tenantId = '';
    let defaultProjectId = '';
    let key1Secret = '';
    let key2Secret = '';

    const cookies = async () => {
      const values = await page.context().cookies();
      const session = values.find(({ name }) => name === 'mr_saas_session')?.value ?? '';
      const token = values.find(({ name }) => name === 'mr_saas_csrf')?.value ?? '';
      return { session, token };
    };

    const createKey = async (projectId: number | string, name: string) => {
      const { session, token } = await cookies();
      const response = await page.request.post(
        `${app.origin}/console/api/v1/tenants/${tenantId}/projects/${projectId}/keys`,
        {
          headers: {
            'content-type': 'application/json',
            origin: app.origin,
            cookie: `mr_saas_session=${session}; mr_saas_csrf=${token}`,
            'x-csrf-token': token,
          },
          data: { name, supplyMode: 'platform' },
        },
      );
      expect(response.status()).toBe(201);
      const json = (await response.json()) as { data: { secret?: string; key?: { secret?: string } } };
      const secret = json.data.secret ?? json.data.key?.secret ?? '';
      expect(secret).toBeTruthy();
      return secret;
    };

    const call = (secret: string, stream: boolean) =>
      page.evaluate(
        async ({ secret: key, model, stream }: { secret: string; model: string; stream: boolean }) => {
          const result = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: '请回复 OK' }],
              max_tokens: 8,
              stream,
            }),
          });
          let body: Record<string, unknown> = {};
          try {
            body = (await result.json()) as Record<string, unknown>;
          } catch {
            /* streaming or non-JSON bodies stay empty */
          }
          return { status: result.status, body };
        },
        { secret, model: app.model, stream },
      );

    await test.step('register and create the first key (S5 hint appears at exactly one key)', async () => {
      await page.goto(`${app.origin}/console/register`);
      await page.getByLabel('邮箱', { exact: true }).fill('m1-multi@example.test');
      await page.getByLabel(/密码/).fill('m1-multi-password-123');
      await page.getByRole('button', { name: '注册', exact: true }).click();
      await expect(page.getByRole('heading', { name: '我的控制台', exact: true })).toBeVisible();
      // S5: zero keys — no per-user hint yet.
      await expect(page.getByText('为每个使用人建一个 Key')).toHaveCount(0);

      const tenants = await page.evaluate(async () => {
        const response = await fetch('/console/api/v1/tenants', { credentials: 'include' });
        return response.json();
      });
      tenantId = tenants?.data?.[0]?.id ?? tenants?.data?.tenants?.[0]?.id;
      const projects = await page.evaluate(async (tenant: string) => {
        const response = await fetch(`/console/api/v1/tenants/${tenant}/projects`, { credentials: 'include' });
        return response.json();
      }, tenantId);
      const projectList = projects?.data ?? [];
      defaultProjectId = projectList[0]?.id;
      expect(defaultProjectId).toBeTruthy();

      await page.goto(`${app.origin}/console/keys`);
      key1Secret = await createKey(defaultProjectId, '妈妈的 Key');
      await page.reload();
      // S5: exactly one key — the per-user hint appears.
      await expect(page.getByText('为每个使用人建一个 Key')).toBeVisible();
    });

    await test.step('recharge and create the second key (S5 hint disappears)', async () => {
      await page.goto(`${app.origin}/console/wallet`);
      const orderResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && /\/orders$/.test(response.url()),
      );
      await page.getByLabel('充值金额（最小货币单位）').fill('2400');
      await page.getByRole('button', { name: '创建充值订单', exact: true }).click();
      const orderJson = (await (await orderResponse).json()) as {
        data: { id: string; order?: { id: string } };
      };
      const orderId = orderJson.data.order?.id ?? orderJson.data.id;
      const webhook = await page.evaluate(
        async ({ body }: { body: string }) => {
          const response = await fetch('/payments/webhooks/e2e-psp', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
          return response.status;
        },
        {
          body: JSON.stringify({
            providerOrderId: `psp_${orderId}`,
            tenantId,
            amountMinorUnits: '2400',
            currency: 'USD',
          }),
        },
      );
      expect(webhook).toBe(202);
      await app.processPayments();
      await expect(page.getByText('USD 2,400').first()).toBeVisible({ timeout: 15_000 });

      await page.goto(`${app.origin}/console/keys`);
      key2Secret = await createKey(defaultProjectId, '同事的 Key');
      await page.reload();
      // S5: two keys — the hint is gone.
      await expect(page.getByText('为每个使用人建一个 Key')).toHaveCount(0);
    });

    await test.step('make calls: two non-stream with key 1, one non-stream and one stream with key 2', async () => {
      expect((await call(key1Secret, false)).status).toBe(200);
      expect((await call(key1Secret, false)).status).toBe(200);
      expect((await call(key2Secret, false)).status).toBe(200);
      expect((await call(key2Secret, true)).status).toBe(200);
      await app.waitForSettlement(tenantId, 4);
    });

    await test.step('usage groups per key into one wallet', async () => {
      const byKey = await app.sql<{ proxy_key_id: string; requests: string }>(
        `SELECT proxy_key_id::text, count(*)::text AS requests
           FROM saas_requests WHERE tenant_id = $1 GROUP BY proxy_key_id`,
        [tenantId],
      );
      expect(byKey.rows).toHaveLength(2);
      const keyCounts = byKey.rows.map(({ requests }) => Number(requests)).sort();
      expect(keyCounts).toEqual([2, 2]);
      // Every settlement lands in the ONE tenant wallet: 2400 − 4×12.
      const wallet = await app.sql<{ count: string; posted: string }>(
        `SELECT count(*)::text AS count, min(posted_balance_minor_units)::text AS posted
           FROM saas_wallets WHERE tenant_id = $1 AND currency = $2`,
        [tenantId, 'USD'],
      );
      expect(wallet.rows[0]).toMatchObject({ count: '1', posted: '2352' });
      const settled = await app.sql<{ count: string; total: string }>(
        `SELECT count(*)::text AS count, sum(settlement_amount_minor_units)::text AS total
           FROM saas_billing_reservations WHERE tenant_id = $1 AND state = 'settled'`,
        [tenantId],
      );
      expect(settled.rows[0]).toMatchObject({ count: '4', total: '48' });
      // The streaming call settled through the same metering: 4 usage events
      // at 3/2 each, all attributed to a proxy key.
      const usage = await app.sql<{ count: string; attributed: string }>(
        `SELECT count(*)::text AS count,
                count(*) FILTER (WHERE r.proxy_key_id IS NOT NULL)::text AS attributed
           FROM saas_usage_events e JOIN saas_requests r ON r.id = e.request_id
          WHERE e.tenant_id = $1`,
        [tenantId],
      );
      expect(usage.rows[0]).toMatchObject({ count: '4', attributed: '4' });
    });

    await test.step('S1/S6: the simple form stays simple and the advanced form stays reachable', async () => {
      await page.goto(`${app.origin}/console/keys`);
      // S1: the creation form carries no model or limit <select> (the client
      // configuration panel's copy-helper selects are expected and fine).
      const creationForm = page.locator('form', { hasText: '名字（可选）' });
      await expect(creationForm.locator('select')).toHaveCount(0);
      // S6: the advanced key form is reachable from the same page and still
      // exposes the full field set (scope, supply mode, expiry).
      await page.getByRole('link', { name: '高级', exact: true }).click();
      await expect(page).toHaveURL(/\/console\/keys\/advanced$/);
      for (const field of ['模型范围', '供给模式', '有效期至']) {
        await expect(page.getByText(field, { exact: false }).first()).toBeVisible();
      }
    });
  } finally {
    await app.close();
  }
});
