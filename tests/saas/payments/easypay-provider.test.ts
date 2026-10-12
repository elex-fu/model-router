import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PaymentProviderEventConfirmationInput } from '../../../src/saas/payments/adapter.js';
import {
  createEasyPayPaymentProvider,
  EASY_PAY_PROVIDER_KEY,
  EasyPayConfigurationError,
  EasyPayProviderError,
  easyPayMinorUnitsToYuan,
  easyPaySign,
  easyPayYuanToMinorUnits,
  normalizeEasyPayApiBase,
} from '../../../src/saas/payments/providers/easypay/index.js';
import { PaymentFulfillmentService } from '../../../src/saas/payments/service.js';
import { createFakeFundingLedger, FakePaymentDatabase } from './fake-sql.js';
import { type MockPsp, startMockPsp } from './mock-psp.js';

// C2/C-3: the EasyPay adapter against a programmable mock PSP server. Covers
// mapi-only configuration, MD5 signing, fixed-point money, the acceptance
// tri-state, the pre-fulfillment QueryOrder red line and the refund downgrade.

const PID = '1001';
const PKEY = 'test-merchant-pkey-0123456789abcdef';
const NOW = new Date('2026-10-10T00:00:00.000Z');

function config(psp: MockPsp, overrides: Record<string, unknown> = {}) {
  return {
    pid: PID,
    pkey: PKEY,
    apiBase: psp.url,
    notifyUrl: 'https://app.example.com/payments/notify',
    returnUrl: 'https://app.example.com/payments/return',
    paymentType: 'alipay',
    now: () => new Date(NOW.getTime()),
    ...overrides,
  };
}

function createOrderInput(overrides: Record<string, unknown> = {}) {
  return {
    localOrderId: 'order-local-1',
    tenantId: 'tenant-1',
    amountMinorUnits: '1234',
    currency: 'CNY',
    merchantId: PID,
    idempotencyReference: 'order-local-1',
    ...overrides,
  };
}

function signedNotify(params: Record<string, string>, pkey = PKEY): Buffer {
  const body: Record<string, string> = { ...params };
  body.sign = easyPaySign(body, pkey);
  body.sign_type = 'MD5';
  return Buffer.from(new URLSearchParams(body).toString(), 'utf8');
}

function paidQuery(order: { outTradeNo: string; tradeNo?: string; money?: string }) {
  return {
    code: 1,
    trade_status: 'TRADE_SUCCESS',
    trade_no: order.tradeNo ?? 'TRADE-1',
    out_trade_no: order.outTradeNo,
    money: order.money ?? '12.34',
  };
}

test('configuration fails closed on popup mode, missing keys and non-loopback http', () => {
  assert.throws(() => normalizeEasyPayApiBase('http://pay.example.com'), EasyPayConfigurationError);
  assert.equal(normalizeEasyPayApiBase('https://pay.example.com/mapi.php/'), 'https://pay.example.com');
  assert.equal(normalizeEasyPayApiBase('https://pay.example.com/epay/submit.php'), 'https://pay.example.com/epay');
  assert.equal(normalizeEasyPayApiBase('http://127.0.0.1:8080/api.php'), 'http://127.0.0.1:8080');
  assert.throws(
    () => createEasyPayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockPsp, { paymentMode: 'popup' })),
    /popup is unsupported/,
  );
  assert.throws(
    () => createEasyPayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockPsp, { pid: '' })),
    EasyPayConfigurationError,
  );
  assert.throws(
    () => createEasyPayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockPsp, { currency: 'usd' })),
    EasyPayConfigurationError,
  );
});

test('md5 signing follows the epay concatenation and verifies timing-safely', () => {
  const source = `a=1&b=2&z=last${PKEY}`;
  const expected = createHash('md5').update(source, 'utf8').digest('hex');
  assert.equal(
    easyPaySign({ z: 'last', a: '1', b: '2', sign: 'ignore', sign_type: 'ignore', empty: '' }, PKEY),
    expected,
  );
});

test('money conversion is strict fixed-point in both directions', () => {
  assert.equal(easyPayMinorUnitsToYuan('5'), '0.05');
  assert.equal(easyPayMinorUnitsToYuan('100'), '1.00');
  assert.equal(easyPayMinorUnitsToYuan('123456789'), '1234567.89');
  assert.equal(easyPayYuanToMinorUnits('0.05'), 5n);
  assert.equal(easyPayYuanToMinorUnits('1'), 100n);
  assert.equal(easyPayYuanToMinorUnits('1.2'), 120n);
  assert.equal(easyPayYuanToMinorUnits('1234567.89'), 123456789n);
  for (const bad of ['1.234', 'abc', '1e2', '-1', '', '0.', '01.00', '1.']) {
    assert.equal(easyPayYuanToMinorUnits(bad), null, bad);
  }
});

test('createOrder signs the mapi request, carries the tenant pass-through and normalizes checkout', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({ json: { code: 1, trade_no: 'TRADE-1', payurl: '/pay/toapp/TRADE-1' } }));
    const provider = createEasyPayPaymentProvider(config(psp));
    const result = await provider.adapter.createOrder(createOrderInput());
    assert.equal(result.providerOrderId, 'TRADE-1');
    assert.deepEqual(result.checkoutAction, {
      kind: 'redirect',
      url: `${psp.url}/pay/toapp/TRADE-1`,
      expiresAt: '2026-10-10T02:00:00.000Z',
    });
    const [sent] = psp.calls.mapi;
    assert.ok(sent);
    assert.equal(sent.out_trade_no, 'order-local-1');
    assert.equal(sent.param, 'tenant-1');
    assert.equal(sent.money, '12.34');
    assert.equal(sent.sign_type, 'MD5');
    assert.equal(
      sent.sign,
      easyPaySign(
        Object.fromEntries(Object.entries(sent).filter(([key]) => key !== 'sign' && key !== 'sign_type')) as Record<
          string,
          string
        >,
        PKEY,
      ),
    );
    assert.equal(psp.calls.query.length, 0, 'a successful create never requeries');
  } finally {
    await psp.close();
  }
});

test('createOrder acceptance: business failure is rejected only when the requery proves no order', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({ json: { code: 0, msg: 'channel unavailable' } }));
    psp.setHandler('query', () => ({ json: { code: 0, msg: '订单不存在' } }));
    const provider = createEasyPayPaymentProvider(config(psp));
    const rejected = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(rejected instanceof EasyPayProviderError);
    assert.equal(rejected.acceptance, 'rejected');
    assert.equal(psp.calls.query.length, 1);

    psp.setHandler('query', () => ({ json: paidQuery({ outTradeNo: 'order-local-1' }) }));
    const unknown = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(unknown instanceof EasyPayProviderError);
    assert.equal(unknown.acceptance, 'unknown', 'an order the requery can see is never a definitive rejection');
  } finally {
    await psp.close();
  }
});

test('createOrder acceptance: transport failure, invalid JSON and missing trade number are unknown', async () => {
  const psp = await startMockPsp();
  try {
    const provider = createEasyPayPaymentProvider(config(psp));
    psp.setHandler('mapi', () => ({ raw: '<html>gateway error</html>', status: 502 }));
    const transport = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof EasyPayProviderError && transport.acceptance === 'unknown');
    assert.equal(psp.calls.query.length, 0, 'no requery without an upstream business answer');

    psp.setHandler('mapi', () => ({ json: { code: 1, payurl: 'https://pay.example.com/x' } }));
    const noTradeNo = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(noTradeNo instanceof EasyPayProviderError && noTradeNo.acceptance === 'unknown');
  } finally {
    await psp.close();
  }
});

test('createOrder rejects identity and currency mismatches without any provider call', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({ json: { code: 1, trade_no: 'T' } }));
    const provider = createEasyPayPaymentProvider(config(psp));
    for (const input of [
      createOrderInput({ idempotencyReference: 'other' }),
      createOrderInput({ merchantId: 'other' }),
      createOrderInput({ currency: 'USD' }),
    ]) {
      const failure = await provider.adapter.createOrder(input).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof EasyPayProviderError && failure.acceptance === 'unknown');
    }
    assert.equal(psp.calls.mapi.length, 0);
  } finally {
    await psp.close();
  }
});

test('verifyWebhook verifies the MD5 signature, the merchant and rejects tampering', async () => {
  const provider = createEasyPayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockPsp));
  const body = signedNotify({
    pid: PID,
    trade_no: 'TRADE-1',
    out_trade_no: 'order-local-1',
    trade_status: 'TRADE_SUCCESS',
    money: '12.34',
    param: 'tenant-1',
  });
  const verified = await provider.adapter.verifyWebhook({ headers: {}, rawBody: body, merchantId: PID });
  assert.equal(verified.providerKey, EASY_PAY_PROVIDER_KEY);
  assert.equal(verified.merchantId, PID);

  await assert.rejects(
    provider.adapter.verifyWebhook({
      headers: {},
      rawBody: signedNotify({ pid: PID, out_trade_no: 'x' }, 'wrong-key'),
      merchantId: PID,
    }),
  );
  const tampered = Buffer.from(body.toString('utf8').replace('12.34', '99.99'), 'utf8');
  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: tampered, merchantId: PID }));
  await assert.rejects(
    provider.adapter.verifyWebhook({ headers: {}, rawBody: Buffer.from('out_trade_no=x'), merchantId: PID }),
  );
});

test('normalizeEvent maps the signed payload and keeps a stable event identity', async () => {
  const provider = createEasyPayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockPsp));
  const verify = async (rawBody: Buffer) => provider.adapter.verifyWebhook({ headers: {}, rawBody, merchantId: PID });
  const event = provider.adapter.normalizeEvent(
    await verify(
      signedNotify({
        pid: PID,
        trade_no: 'TRADE-1',
        out_trade_no: 'order-local-1',
        trade_status: 'TRADE_SUCCESS',
        money: '12.34',
        param: 'tenant-1',
        notify_time: '2026-10-10 01:02:03',
      }),
    ),
  );
  assert.equal(event.status, 'succeeded');
  assert.equal(event.providerOrderId, 'TRADE-1');
  assert.equal(event.tenantId, 'tenant-1');
  assert.equal(event.amountMinorUnits, '1234');
  assert.equal(event.currency, 'CNY');
  assert.equal(event.providerEventId, 'TRADE-1:TRADE_SUCCESS');
  assert.equal(new Date(event.occurredAt).getFullYear(), 2026);

  const noParam = provider.adapter.normalizeEvent(
    await verify(
      signedNotify({ pid: PID, out_trade_no: 'order-local-1', trade_status: 'WAIT_BUYER_PAY', money: '12.34' }),
    ),
  );
  assert.equal(noParam.status, 'pending');
  assert.equal(noParam.tenantId, 'unresolved-tenant', 'a missing pass-through routes to reconciliation, never a crash');
  assert.equal(noParam.providerOrderId, 'order-local-1');

  assert.throws(() =>
    provider.adapter.normalizeEvent({
      providerKey: EASY_PAY_PROVIDER_KEY,
      merchantId: PID,
      payload: { out_trade_no: 'x', money: 'not-money' },
    } as never),
  );
});

test('confirmEvent enforces the pre-fulfillment requery red line', async () => {
  const psp = await startMockPsp();
  try {
    const provider = createEasyPayPaymentProvider(config(psp));
    const confirmEvent = provider.adapter.confirmEvent;
    assert.ok(confirmEvent);
    const input = (
      overrides: Partial<PaymentProviderEventConfirmationInput['order']> = {},
    ): PaymentProviderEventConfirmationInput => ({
      event: {
        providerEventId: 'TRADE-1:TRADE_SUCCESS',
        eventType: 'payment.notify',
        providerOrderId: 'TRADE-1',
        tenantId: 'tenant-1',
        merchantId: PID,
        status: 'succeeded',
        amountMinorUnits: '1234',
        currency: 'CNY',
        occurredAt: NOW,
      },
      order: {
        localOrderId: 'order-local-1',
        tenantId: 'tenant-1',
        merchantId: PID,
        amountMinorUnits: '1234',
        currency: 'CNY',
        providerOrderId: 'TRADE-1',
        ...overrides,
      },
    });

    psp.setHandler('query', () => ({ json: paidQuery({ outTradeNo: 'order-local-1' }) }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: true });
    assert.equal(psp.calls.query[0]?.out_trade_no, 'order-local-1');

    psp.setHandler('query', () => ({ json: { code: 0, msg: '订单不存在' } }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'EASYPAY_ORDER_NOT_FOUND',
    });

    psp.setHandler('query', () => ({
      json: { code: 1, trade_status: 'WAIT_BUYER_PAY', trade_no: 'TRADE-1', money: '12.34' },
    }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'EASYPAY_TRADE_NOT_SUCCESS',
    });

    psp.setHandler('query', () => ({ json: paidQuery({ outTradeNo: 'order-local-1', money: '99.99' }) }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'EASYPAY_AMOUNT_MISMATCH',
    });

    psp.setHandler('query', () => ({ json: paidQuery({ outTradeNo: 'order-local-1', tradeNo: 'TRADE-OTHER' }) }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'EASYPAY_TRADE_NO_MISMATCH',
    });

    assert.deepEqual(await confirmEvent(input({ currency: 'USD' })), {
      confirmed: false,
      code: 'EASYPAY_CURRENCY_MISMATCH',
    });

    psp.setHandler('query', () => ({ raw: '<html>down</html>', status: 502 }));
    await assert.rejects(confirmEvent(input()), (error: unknown) => {
      assert.ok(error instanceof EasyPayProviderError && error.acceptance === 'unknown');
      return true;
    });
  } finally {
    await psp.close();
  }
});

test('recoverOrder returns the upstream order or null, never a new charge', async () => {
  const psp = await startMockPsp();
  try {
    const provider = createEasyPayPaymentProvider(config(psp));
    const recoverOrder = provider.adapter.recoverOrder;
    assert.ok(recoverOrder);
    psp.setHandler('query', () => ({ json: { code: 0, msg: '订单不存在' } }));
    const missing = await recoverOrder({
      localOrderId: 'order-local-1',
      tenantId: 'tenant-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
      merchantId: PID,
      idempotencyReference: 'order-local-1',
    });
    assert.equal(missing, null);

    psp.setHandler('query', () => ({
      json: paidQuery({ outTradeNo: 'order-local-1', tradeNo: 'TRADE-9', money: '12.34' }),
    }));
    const recovered = await recoverOrder({
      localOrderId: 'order-local-1',
      tenantId: 'tenant-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
      merchantId: PID,
      idempotencyReference: 'order-local-1',
    });
    assert.deepEqual(recovered, { providerOrderId: 'TRADE-9', amountMinorUnits: '1234', currency: 'CNY' });
    assert.equal(psp.calls.mapi.length, 0, 'recovery never submits mapi');

    psp.setHandler('query', () => ({ raw: 'upstream down', status: 500 }));
    await assert.rejects(
      recoverOrder({
        localOrderId: 'order-local-1',
        tenantId: 'tenant-1',
        amountMinorUnits: '1234',
        currency: 'CNY',
        merchantId: PID,
        idempotencyReference: 'order-local-1',
      }),
      (error: unknown) => error instanceof EasyPayProviderError && error.acceptance === 'unknown',
    );
  } finally {
    await psp.close();
  }
});

test('refreshCheckout re-calls mapi with the same out_trade_no and never creates a charge', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({
      json: { code: 1, trade_no: 'TRADE-1', qrcode: 'weixin://wxpay/bizpayurl?pr=abc' },
    }));
    const provider = createEasyPayPaymentProvider(config(psp));
    const refreshCheckout = provider.adapter.refreshCheckout;
    assert.ok(refreshCheckout);
    const refreshed = await refreshCheckout({
      localOrderId: 'order-local-1',
      tenantId: 'tenant-1',
      providerOrderId: 'TRADE-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
      merchantId: PID,
    });
    assert.equal(refreshed.providerOrderId, 'TRADE-1');
    assert.deepEqual(refreshed.checkoutAction, {
      kind: 'qr',
      text: 'weixin://wxpay/bizpayurl?pr=abc',
      expiresAt: '2026-10-10T02:00:00.000Z',
    });
    assert.equal(psp.calls.mapi[0]?.out_trade_no, 'order-local-1');
  } finally {
    await psp.close();
  }
});

test('submitRefund tries out_trade_no then trade_no and maps the acceptance tri-state', async () => {
  const psp = await startMockPsp();
  try {
    const provider = createEasyPayPaymentProvider(config(psp));
    const input = {
      localRefundId: 'refund-1',
      idempotencyReference: 'refund-1',
      tenantId: 'tenant-1',
      originalLocalOrderId: 'order-local-1',
      providerKey: EASY_PAY_PROVIDER_KEY,
      merchantId: PID,
      providerOrderId: 'TRADE-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
      providerRefundId: null,
    };

    psp.setHandler('refund', () => ({ json: { code: 1 } }));
    const refunded = await provider.refundAdapter.submitRefund(input);
    assert.equal(refunded.status, 'pending', 'an accepted refund is unprovable and stays provisional');
    assert.equal(refunded.providerRefundId, 'order-local-1');
    assert.equal(refunded.localRefundId, 'refund-1');
    assert.equal(psp.calls.refund[0]?.money, '12.34');
    assert.equal(psp.calls.refund[0]?.out_trade_no, 'order-local-1');
    assert.equal(psp.calls.refund[0]?.key, PKEY, 'upstream protocol passes the pkey unsigned (COM-01 record)');

    let refundCalls = 0;
    psp.setHandler('refund', (params) => {
      refundCalls += 1;
      return params.out_trade_no ? { json: { code: 0, msg: '订单编号不存在' } } : { json: { code: 1 } };
    });
    const fallback = await provider.refundAdapter.submitRefund(input);
    assert.equal(fallback.providerRefundId, 'TRADE-1');
    assert.equal(refundCalls, 2);

    psp.setHandler('refund', () => ({ json: { code: 0, msg: '订单编号不存在' } }));
    const notAccepted = await provider.refundAdapter.submitRefund(input).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(notAccepted instanceof EasyPayProviderError && notAccepted.acceptance === 'not_accepted');

    psp.setHandler('refund', () => ({ json: { code: 0, msg: 'merchant balance insufficient' } }));
    const business = await provider.refundAdapter.submitRefund(input).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(business instanceof EasyPayProviderError && business.acceptance === 'not_accepted');

    psp.setHandler('refund', () => ({ raw: '<html>proxy error</html>', status: 502 }));
    const transport = await provider.refundAdapter.submitRefund(input).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof EasyPayProviderError && transport.acceptance === 'unknown');
  } finally {
    await psp.close();
  }
});

test('queryRefund always answers unknown without any provider call', async () => {
  const psp = await startMockPsp();
  try {
    const provider = createEasyPayPaymentProvider(config(psp));
    const result = await provider.refundAdapter.queryRefund({
      localRefundId: 'refund-1',
      idempotencyReference: 'refund-1',
      tenantId: 'tenant-1',
      originalLocalOrderId: 'order-local-1',
      providerKey: EASY_PAY_PROVIDER_KEY,
      merchantId: PID,
      providerOrderId: 'TRADE-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
      providerRefundId: 'TRADE-1',
    });
    assert.equal(result.status, 'unknown');
    assert.equal(result.localRefundId, 'refund-1');
    assert.equal(psp.calls.refund.length + psp.calls.query.length + psp.calls.mapi.length, 0);
  } finally {
    await psp.close();
  }
});

test('upstream error text never leaks the merchant key', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({ json: { code: 0, msg: `failure echoed ${PKEY} verbatim` } }));
    psp.setHandler('query', () => ({ json: { code: 0, msg: '订单不存在' } }));
    const provider = createEasyPayPaymentProvider(config(psp));
    const failure = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof EasyPayProviderError);
    assert.equal(failure.message.includes(PKEY), false);
    assert.match(failure.message, /\*\*\*/);
  } finally {
    await psp.close();
  }
});

test('end to end: easypay webhook fulfills only after the mock-PSP requery confirms', async () => {
  const psp = await startMockPsp();
  try {
    psp.setHandler('mapi', () => ({
      json: { code: 1, trade_no: 'TRADE-1', payurl: 'https://pay.example.com/cashier/TRADE-1' },
    }));
    psp.setHandler('query', () => ({
      json: paidQuery({ outTradeNo: 'will-set-later', tradeNo: 'TRADE-1', money: '12.34' }),
    }));
    const provider = createEasyPayPaymentProvider(config(psp));
    const database = new FakePaymentDatabase();
    let nextId = 0;
    const service = new PaymentFulfillmentService(database, provider.adapter, {
      providerKey: EASY_PAY_PROVIDER_KEY,
      merchantId: PID,
      now: () => new Date(NOW.getTime()),
      idFactory: () => `local-${++nextId}`,
      walletFundingLedger: createFakeFundingLedger(database),
      checkout: {
        redirectPolicies: [
          { providerKey: EASY_PAY_PROVIDER_KEY, origin: 'https://pay.example.com', pathPrefixes: ['/'] },
        ],
      },
    });

    const order = await service.createWalletTopUp({
      tenantId: 'tenant-1',
      clientRequestId: 'request-1',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    assert.equal(order.providerOrderId, 'TRADE-1');
    assert.equal(order.checkout.status, 'ready');

    psp.setHandler('query', (params) => ({
      json: paidQuery({ outTradeNo: params.out_trade_no, tradeNo: 'TRADE-1', money: '12.34' }),
    }));
    const webhook = await service.handleWebhook(
      {},
      signedNotify({
        pid: PID,
        trade_no: 'TRADE-1',
        out_trade_no: order.id,
        trade_status: 'TRADE_SUCCESS',
        money: '12.34',
        param: 'tenant-1',
      }),
    );
    assert.equal(webhook.outcome, 'accepted');
    const batch = await service.processPendingWebhooks();
    assert.equal(batch.processed, 1);
    assert.equal(database.state.funding.length, 1, 'the requery-confirmed event credits the wallet exactly once');
    assert.equal(database.state.funding[0]?.amountMinorUnits, '1234');
    assert.equal(database.state.orders[0]?.state, 'fulfilled');
    assert.equal(psp.calls.query.length, 1, 'fulfillment required the active requery');

    // A forged-but-signed success the PSP does not confirm lands in reconciliation.
    psp.setHandler('mapi', () => ({
      json: { code: 1, trade_no: 'TRADE-2', payurl: 'https://pay.example.com/cashier/TRADE-2' },
    }));
    const second = await service.createWalletTopUp({
      tenantId: 'tenant-1',
      clientRequestId: 'request-2',
      amountMinorUnits: '1234',
      currency: 'CNY',
    });
    psp.setHandler('query', () => ({
      json: { code: 1, trade_status: 'WAIT_BUYER_PAY', trade_no: 'TRADE-2', money: '12.34' },
    }));
    await service.handleWebhook(
      {},
      signedNotify({
        pid: PID,
        trade_no: 'TRADE-2',
        out_trade_no: second.id,
        trade_status: 'TRADE_SUCCESS',
        money: '12.34',
        param: 'tenant-1',
      }),
    );
    await service.processPendingWebhooks();
    assert.equal(database.state.orders[1]?.state, 'pending', 'an unconfirmed success never fulfills');
    assert.equal(database.state.inbox[1]?.processing_outcome, 'reconciliation');
    assert.equal(database.state.inbox[1]?.outcome_code, 'EASYPAY_TRADE_NOT_SUCCESS');
    assert.equal(database.state.funding.length, 1);
  } finally {
    await psp.close();
  }
});
