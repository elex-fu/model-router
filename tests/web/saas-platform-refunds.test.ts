import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  clearPlatformCsrfToken,
  PlatformApiError,
  type PlatformRefundRecord,
  platformClient,
} from '../../web/src/api/saas-platform-client.ts';

const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
const originalReact = reactGlobal.React;
const originalFetch = globalThis.fetch;
let platformFeature: typeof import('../../web/src/features/saas-platform.tsx');

const REFUND: PlatformRefundRecord = {
  id: 'refund one',
  tenantId: 'tenant one',
  refundType: 'wallet_topup',
  originalOrderId: 'order-1',
  amountMinorUnits: '12500',
  currency: 'CNY',
  status: 'unknown',
  providerRefundId: 'psp-refund-private',
  failureCode: null,
  blockedCode: null,
  walletRefundTransactionId: 'wallet-transaction-private',
  createdAt: '2026-09-29T01:00:00.000Z',
  updatedAt: '2026-09-29T01:01:00.000Z',
  completedAt: null,
};

before(async () => {
  reactGlobal.React = React;
  platformFeature = await import('../../web/src/features/saas-platform.tsx');
});

after(() => {
  clearPlatformCsrfToken();
  if (originalReact === undefined) Reflect.deleteProperty(reactGlobal, 'React');
  else reactGlobal.React = originalReact;
});

afterEach(() => {
  clearPlatformCsrfToken();
  globalThis.fetch = originalFetch;
});

test('refund client sends the safe body, idempotency header, and tenant-scoped lookup route', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const call = calls.length;
    const data =
      call === 1
        ? { session: { userId: 'finance-admin' }, csrfToken: 'csrf-token' }
        : { ...REFUND, secret: 'must-not-be-exposed', paymentMethod: { lastFour: '4242' } };
    return new Response(JSON.stringify({ data }), {
      status: call === 2 ? 200 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await platformClient.login({ email: 'finance@example.test', password: 'not-retained', code: '123456' });
  const created = await platformClient.requestWalletTopUpRefund({
    tenantId: 'tenant one',
    orderId: 'order-1',
    reasonCode: 'duplicate_charge',
    idempotencyKey: 'refund-request-123',
  });
  const lookedUp = await platformClient.getRefund('tenant one', 'refund one');

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      '/admin/api/v1/auth/session',
      '/admin/api/v1/payments/refunds',
      '/admin/api/v1/payments/refunds/tenant%20one/refund%20one',
    ],
  );
  const createHeaders = new Headers(calls[1]?.init.headers);
  assert.equal(createHeaders.get('x-csrf-token'), 'csrf-token');
  assert.equal(createHeaders.get('idempotency-key'), 'refund-request-123');
  assert.equal(calls[1]?.init.credentials, 'same-origin');
  assert.equal(calls[1]?.init.cache, 'no-store');
  assert.equal(calls[2]?.init.credentials, 'same-origin');
  assert.equal(calls[2]?.init.cache, 'no-store');
  assert.equal(new Headers(calls[2]?.init.headers).get('x-csrf-token'), null);
  assert.equal(calls[1]?.init.method, 'POST');
  assert.equal(calls[2]?.init.method ?? 'GET', 'GET');
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    tenantId: 'tenant one',
    orderId: 'order-1',
    reasonCode: 'duplicate_charge',
  });
  assert.equal('actorId' in JSON.parse(String(calls[1]?.init.body)), false);
  assert.equal('amountMinorUnits' in JSON.parse(String(calls[1]?.init.body)), false);
  assert.equal(lookedUp.status, 'unknown');
  assert.equal('secret' in created, false);
  assert.equal('paymentMethod' in created, false);
  assert.equal('providerRefundId' in created, true);
});

test('refund client rejects invalid idempotency keys and malformed refund statuses', async () => {
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ data: { ...REFUND, status: 'refunded' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  assert.throws(
    () =>
      platformClient.requestWalletTopUpRefund({
        tenantId: 'tenant',
        orderId: 'order',
        reasonCode: 'reason',
        idempotencyKey: ' ',
      }),
    (error) => error instanceof PlatformApiError && error.code === 'IDEMPOTENCY_KEY_REQUIRED',
  );
  assert.equal(fetchCount, 0);

  await assert.rejects(
    platformClient.getRefund('tenant', 'refund'),
    (error) => error instanceof PlatformApiError && error.code === 'INVALID_RESPONSE',
  );
});

test('refund write controls are limited to finance and superadmin roles', () => {
  const render = (roles: Array<'finance' | 'superadmin' | 'security' | 'operations' | 'support-readonly'>) =>
    renderToStaticMarkup(
      React.createElement(platformFeature.RefundsPage, {
        me: { kind: 'ready', me: { userId: 'admin-user', roles } },
      }),
    );

  for (const roles of [['finance'], ['superadmin']] as const) {
    const html = render([...roles]);
    assert.match(html, /申请钱包充值全额退款/);
    assert.match(html, /租户 ID/);
    assert.match(html, /退款原因代码/);
    assert.match(html, /幂等键/);
    assert.match(html, /查询退款状态/);
    assert.match(html, /BYOK 服务套餐退款不受支持/);
  }
  for (const roles of [['security'], ['operations'], ['support-readonly']] as const) {
    const html = render([...roles]);
    assert.doesNotMatch(html, /<form|<input|<button/);
    assert.match(html, /当前角色只读/);
  }
});

test('refund status panel presents every server lifecycle status', () => {
  const cases: Array<[PlatformRefundRecord['status'], string]> = [
    ['submitting', '正在提交'],
    ['pending', '处理中'],
    ['succeeded', '已成功'],
    ['failed', '失败'],
    ['unknown', '状态未知'],
    ['blocked', '已冻结'],
  ];
  for (const [status, label] of cases) {
    const html = renderToStaticMarkup(
      React.createElement(platformFeature.PlatformRefundRecordPanel, { record: { ...REFUND, status } }),
    );
    assert.match(html, new RegExp(label));
  }
});

test('unknown and BYOK refund results warn against retry and mask payment references', () => {
  const unknown = renderToStaticMarkup(
    React.createElement(platformFeature.PlatformRefundRecordPanel, { record: REFUND }),
  );
  assert.match(unknown, /状态未知/);
  assert.match(unknown, /请勿重复发起此订单退款/);
  assert.doesNotMatch(unknown, /重试|psp-refund-private|wallet-transaction-private/);

  const blocked = renderToStaticMarkup(
    React.createElement(platformFeature.PlatformRefundRecordPanel, {
      record: {
        ...REFUND,
        id: 'byok-refund',
        refundType: 'byok_service_plan',
        status: 'blocked',
        blockedCode: 'SERVICE_PLAN_REFUND_UNSUPPORTED',
      },
    }),
  );
  assert.match(blocked, /BYOK 服务套餐退款/);
  assert.match(blocked, /服务端冻结/);
  assert.match(blocked, /请勿重试/);
  assert.doesNotMatch(blocked, /psp-refund-private|wallet-transaction-private/);
});
