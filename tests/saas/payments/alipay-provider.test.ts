import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { PaymentProviderEventConfirmationInput } from '../../../src/saas/payments/adapter.js';
import {
  ALIPAY_PROVIDER_KEY,
  AlipayConfigurationError,
  AlipayProviderError,
  alipayCanonicalJson,
  alipayMinorUnitsToYuan,
  alipayNotifySignContent,
  alipayRequestSignContent,
  alipayRsa2Sign,
  alipayRsa2Verify,
  alipayTimestamp,
  alipayYuanToMinorUnits,
  createAlipayPaymentProvider,
  normalizeAlipayGateway,
  parseAlipayMerchantPrivateKey,
  parseAlipayProviderConfig,
  parseAlipayPublicKey,
} from '../../../src/saas/payments/providers/alipay/index.js';
import {
  ALIPAY_KAV_CONTENT,
  ALIPAY_KAV_SIGNATURE,
  ALIPAY_TEST_GATEWAY_PRIVATE_KEY,
  ALIPAY_TEST_GATEWAY_PUBLIC_KEY,
  ALIPAY_TEST_MERCHANT_PRIVATE_KEY,
  ALIPAY_TEST_MERCHANT_PUBLIC_KEY,
  alipayGatewayEnvelope,
  alipayNotifyBody,
  alipayVerifyRequestSign,
  type MockAlipay,
  startMockAlipay,
} from './mock-alipay.js';

// R3 checklist: the Alipay adapter against a programmable mock gateway.
// Covers fail-closed configuration (PEM provenance, gateway/URL egress rules,
// precreate-only red line, fixed CNY), the RSA2 signing scheme pinned by a
// known-answer vector, strict fixed-point money, the create acceptance
// tri-state (with the active trade.query recheck), notification verification
// (correct/tampered/wrong-key/key-order variants), the confirmEvent
// pre-fulfillment red line across every branch, recovery that never creates,
// and the real refund submit/query tri-states — with private-key custody
// asserted on every error surface.

const APP_ID = '2021000123456789';
const SELLER_ID = '2088102171234567';
const TENANT_ID = 'tenant-1';
const ORDER_ID = 'order-local-1';
const TRADE_NO = '2026101122001456789012345678';
const NOTIFY_URL = 'https://pay.example.com/notify';
const RETURN_URL = 'https://pay.example.com/return';
const NOW = new Date('2026-10-11T00:00:00.000Z');

function config(alipay: MockAlipay, overrides: Record<string, unknown> = {}) {
  return {
    appId: APP_ID,
    sellerId: SELLER_ID,
    merchantPrivateKey: ALIPAY_TEST_MERCHANT_PRIVATE_KEY,
    alipayPublicKey: ALIPAY_TEST_GATEWAY_PUBLIC_KEY,
    gateway: alipay.url,
    notifyUrl: NOTIFY_URL,
    returnUrl: RETURN_URL,
    now: () => new Date(NOW.getTime()),
    ...overrides,
  };
}

function deadConfig(overrides: Record<string, unknown> = {}) {
  return config({ url: 'http://127.0.0.1:1' } as MockAlipay, overrides);
}

function createOrderInput(overrides: Record<string, unknown> = {}) {
  return {
    localOrderId: ORDER_ID,
    tenantId: TENANT_ID,
    amountMinorUnits: '1234',
    currency: 'CNY',
    merchantId: APP_ID,
    idempotencyReference: ORDER_ID,
    ...overrides,
  };
}

function refundInput(overrides: Record<string, unknown> = {}) {
  return {
    localRefundId: 'refund-1',
    idempotencyReference: 'refund-1',
    tenantId: TENANT_ID,
    originalLocalOrderId: ORDER_ID,
    providerKey: ALIPAY_PROVIDER_KEY,
    merchantId: APP_ID,
    providerOrderId: ORDER_ID,
    amountMinorUnits: '1234',
    currency: 'CNY',
    providerRefundId: null as string | null,
    ...overrides,
  };
}

function precreateSuccess(overrides: Record<string, unknown> = {}) {
  return alipayGatewayEnvelope('alipay.trade.precreate', {
    code: '10000',
    msg: 'Success',
    out_trade_no: ORDER_ID,
    qr_code: 'https://qr.alipay.com/bax01234mockqrcode',
    ...overrides,
  });
}

function tradeQueryNode(overrides: Record<string, unknown> = {}) {
  return alipayGatewayEnvelope('alipay.trade.query', {
    code: '10000',
    msg: 'Success',
    out_trade_no: ORDER_ID,
    trade_no: TRADE_NO,
    trade_status: 'TRADE_SUCCESS',
    total_amount: '12.34',
    ...overrides,
  });
}

function tradeNotExistNode() {
  return alipayGatewayEnvelope('alipay.trade.query', {
    code: '40004',
    msg: 'Business Failed',
    sub_code: 'ACQ.TRADE_NOT_EXIST',
    sub_msg: '交易不存在',
  });
}

function signedNotify(overrides: Record<string, string> = {}, signKey?: string): Buffer {
  return alipayNotifyBody(
    {
      notify_id: 'notify-e2e-1',
      notify_type: 'trade_status_sync',
      notify_time: '2026-10-11 08:00:00',
      app_id: APP_ID,
      seller_id: SELLER_ID,
      out_trade_no: ORDER_ID,
      trade_no: TRADE_NO,
      trade_status: 'TRADE_SUCCESS',
      total_amount: '12.34',
      passback_params: TENANT_ID,
      gmt_payment: '2026-10-11 07:59:30',
      ...overrides,
    },
    signKey,
  );
}

test('configuration fails closed on identity fields, PEM provenance, gateway, URLs, mode and currency', () => {
  for (const bad of [
    { appId: '' },
    { appId: 'not-digits' },
    { appId: '12345' },
    { sellerId: '' },
    { sellerId: 'seller with space' },
    { merchantPrivateKey: '' },
    { merchantPrivateKey: 'not a pem' },
    { merchantPrivateKey: ALIPAY_TEST_MERCHANT_PUBLIC_KEY },
    { alipayPublicKey: '' },
    { alipayPublicKey: 'not a pem' },
    { alipayPublicKey: ALIPAY_TEST_GATEWAY_PRIVATE_KEY },
    { gateway: 'http://openapi.alipay.com' },
    { gateway: 'https://openapi.alipay.com/some/path' },
    { gateway: 'https://user:pw@openapi.alipay.com' },
    { gateway: 'not-a-url' },
    { notifyUrl: 'http://pay.example.com/notify' },
    { notifyUrl: '/relative/notify' },
    { returnUrl: 'http://pay.example.com/return' },
    { currency: 'USD' },
    { currency: 'cny' },
    { checkoutTtlMs: 0 },
    { requestTimeoutMs: 61_000 },
  ]) {
    assert.throws(() => createAlipayPaymentProvider(deadConfig(bad)), AlipayConfigurationError, JSON.stringify(bad));
  }
  for (const mode of ['popup', 'pagepay', 'page_pay', 'wappay', 'alipay.trade.page.pay', 'alipay.trade.wap.pay']) {
    assert.throws(
      () => createAlipayPaymentProvider(deadConfig({ createMethod: mode })),
      /only server-direct precreate preserves order recovery/,
      mode,
    );
  }
  assert.throws(
    () => createAlipayPaymentProvider(deadConfig({ createMethod: 'unknown-mode' })),
    AlipayConfigurationError,
  );

  const provider = createAlipayPaymentProvider(deadConfig({ createMethod: 'precreate' }));
  assert.equal(provider.adapter.providerKey, 'alipay');
  assert.equal(provider.refundAdapter.merchantId, APP_ID);
  const aliased = createAlipayPaymentProvider(deadConfig({ createMethod: 'alipay.trade.precreate' }));
  assert.ok(aliased.adapter);
  const defaulted = createAlipayPaymentProvider(deadConfig({ gateway: undefined }));
  assert.ok(defaulted.adapter);
});

test('PEM parsing requires PKCS#8 RSA private and SPKI RSA public, both at least 2048 bits', () => {
  assert.ok(parseAlipayMerchantPrivateKey(ALIPAY_TEST_MERCHANT_PRIVATE_KEY));
  assert.ok(parseAlipayPublicKey(ALIPAY_TEST_GATEWAY_PUBLIC_KEY));

  const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  });
  assert.throws(() => parseAlipayMerchantPrivateKey(pkcs1), /PKCS#8 PEM, not PKCS#1/);

  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => parseAlipayMerchantPrivateKey(ec), /RSA private key/);

  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(
    () => parseAlipayMerchantPrivateKey(weak.privateKey.export({ type: 'pkcs8', format: 'pem' })),
    /at least 2048 bits/,
  );
  assert.throws(
    () => parseAlipayPublicKey(weak.publicKey.export({ type: 'spki', format: 'pem' })),
    /at least 2048 bits/,
  );
  assert.throws(() => parseAlipayPublicKey(ALIPAY_TEST_MERCHANT_PRIVATE_KEY), AlipayConfigurationError);
});

test('gateway normalization strips the gateway.do suffix and keeps loopback http for tests', () => {
  assert.equal(normalizeAlipayGateway(undefined), 'https://openapi.alipay.com');
  assert.equal(normalizeAlipayGateway('https://openapi.alipay.com/'), 'https://openapi.alipay.com');
  assert.equal(normalizeAlipayGateway('https://openapi.alipay.com/gateway.do'), 'https://openapi.alipay.com');
  assert.equal(normalizeAlipayGateway('http://127.0.0.1:8080/gateway.do'), 'http://127.0.0.1:8080');
});

test('RSA2 signing is pinned by a known-answer vector and verification fails closed', () => {
  const configParsed = parseAlipayProviderConfig(deadConfig());
  const signature = alipayRsa2Sign(ALIPAY_KAV_CONTENT, configParsed.merchantPrivateKey);
  assert.equal(signature, ALIPAY_KAV_SIGNATURE, 'PKCS#1 v1.5 RSA2 signatures are deterministic');
  assert.equal(alipayRsa2Verify(ALIPAY_KAV_CONTENT, ALIPAY_KAV_SIGNATURE, configParsed.alipayPublicKey), false);
  const merchantPublic = parseAlipayPublicKey(ALIPAY_TEST_MERCHANT_PUBLIC_KEY);
  assert.equal(alipayRsa2Verify(ALIPAY_KAV_CONTENT, ALIPAY_KAV_SIGNATURE, merchantPublic), true);
  assert.equal(alipayRsa2Verify(`${ALIPAY_KAV_CONTENT}&x=1`, ALIPAY_KAV_SIGNATURE, merchantPublic), false);
  assert.equal(alipayRsa2Verify(ALIPAY_KAV_CONTENT, 'not-base64!!!', merchantPublic), false);
  assert.equal(alipayRsa2Verify(ALIPAY_KAV_CONTENT, '', merchantPublic), false);
});

test('sign content follows the alipay rules: sorted pairs, request keeps sign_type, notify drops it', () => {
  const params = { b: '2', sign_type: 'RSA2', a: '1', sign: 'ignored', empty: '' };
  assert.equal(alipayRequestSignContent(params), 'a=1&b=2&sign_type=RSA2');
  assert.equal(alipayNotifySignContent(params), 'a=1&b=2');
  const shuffled = { empty: '', sign: 'ignored', a: '1', sign_type: 'RSA2', b: '2' };
  assert.equal(alipayRequestSignContent(shuffled), alipayRequestSignContent(params), 'insertion order is irrelevant');
});

test('money is strict fixed-point in both directions and biz_content JSON is canonical', () => {
  assert.equal(alipayMinorUnitsToYuan('0'), '0.00');
  assert.equal(alipayMinorUnitsToYuan('1'), '0.01');
  assert.equal(alipayMinorUnitsToYuan('10'), '0.10');
  assert.equal(alipayMinorUnitsToYuan('1234'), '12.34');
  assert.equal(alipayMinorUnitsToYuan(9007199254740991n), '90071992547409.91');
  for (const bad of ['12.34', '1e3', '-1', '', '01', '1.0', ' 1', '1 ']) {
    assert.throws(() => alipayMinorUnitsToYuan(bad), AlipayConfigurationError, bad);
  }
  assert.equal(alipayYuanToMinorUnits('0.00'), 0n);
  assert.equal(alipayYuanToMinorUnits('12.34'), 1234n);
  assert.equal(alipayYuanToMinorUnits('12.3'), 1230n);
  assert.equal(alipayYuanToMinorUnits('12'), 1200n);
  for (const bad of ['12.345', '1e2', '-1.00', 'abc', '', '0.001', 12.34, 12, null]) {
    assert.equal(alipayYuanToMinorUnits(bad), null, String(bad));
  }
  assert.equal(alipayCanonicalJson({ z: '1', a: { b: 'x', a: ['y', 'z'] } }), '{"a":{"a":["y","z"],"b":"x"},"z":"1"}');
  assert.equal(alipayCanonicalJson('a"b'), '"a\\"b"');
  assert.throws(() => alipayCanonicalJson({ amount: 12.34 }), AlipayConfigurationError);
});

test('wire timestamp is Asia/Shanghai yyyy-MM-dd HH:mm:ss and deterministic for an injected clock', () => {
  assert.equal(alipayTimestamp(NOW), '2026-10-11 08:00:00');
  assert.equal(alipayTimestamp(new Date('2026-01-01T16:00:00.000Z')), '2026-01-02 00:00:00');
});

test('createOrder posts the RSA2-signed precreate form and normalizes the qr checkout action', async () => {
  const alipay = await startMockAlipay();
  try {
    alipay.setHandler('precreate', () => ({ json: precreateSuccess() }));
    const provider = createAlipayPaymentProvider(config(alipay));
    const result = await provider.adapter.createOrder(createOrderInput());
    assert.equal(result.providerOrderId, ORDER_ID);
    assert.equal(result.amountMinorUnits, '1234');
    assert.equal(result.currency, 'CNY');
    assert.deepEqual(result.checkoutAction, {
      kind: 'qr',
      text: 'https://qr.alipay.com/bax01234mockqrcode',
      expiresAt: '2026-10-11T02:00:00.000Z',
    });
    const [sent] = alipay.calls.precreate;
    assert.ok(sent);
    assert.equal(sent.path, '/gateway.do', 'the single fixed gateway path is the only egress target');
    assert.equal(sent.params.app_id, APP_ID);
    assert.equal(sent.params.method, 'alipay.trade.precreate');
    assert.equal(sent.params.sign_type, 'RSA2');
    assert.equal(sent.params.charset, 'utf-8');
    assert.equal(sent.params.version, '1.0');
    assert.equal(sent.params.timestamp, '2026-10-11 08:00:00');
    assert.equal(sent.params.notify_url, NOTIFY_URL);
    assert.equal(sent.params.return_url, RETURN_URL);
    assert.equal(
      sent.params.biz_content,
      '{"extend_params":{"tenant_id":"tenant-1"},"out_trade_no":"order-local-1","passback_params":"tenant-1",' +
        '"subject":"Order order-local-1","total_amount":"12.34"}',
    );
    assert.equal(
      alipayVerifyRequestSign(sent.params, ALIPAY_TEST_MERCHANT_PUBLIC_KEY),
      true,
      'the gateway-side RSA2 request verification accepts the adapter signature',
    );
    assert.equal(alipay.calls.tradeQuery.length, 0);
  } finally {
    await alipay.close();
  }
});

test('createOrder acceptance: a business failure is rejected only when the active query proves no trade', async () => {
  const alipay = await startMockAlipay();
  try {
    alipay.setHandler('precreate', () => ({
      json: alipayGatewayEnvelope('alipay.trade.precreate', {
        code: '40004',
        msg: 'Business Failed',
        sub_code: 'ACQ.INVALID_PARAMETER',
        sub_msg: '参数错误',
      }),
    }));
    alipay.setHandler('tradeQuery', () => ({ json: tradeNotExistNode() }));
    const provider = createAlipayPaymentProvider(config(alipay));
    const attempt = () =>
      provider.adapter.createOrder(createOrderInput()).then(
        () => null,
        (error: unknown) => error,
      );

    const rejected = await attempt();
    assert.ok(rejected instanceof AlipayProviderError);
    assert.equal(rejected.acceptance, 'rejected');
    assert.equal(alipay.calls.tradeQuery.length, 1);

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ trade_status: 'WAIT_BUYER_PAY' }) }));
    const visible = await attempt();
    assert.ok(visible instanceof AlipayProviderError);
    assert.equal(visible.acceptance, 'unknown', 'a trade the query can see is never a definitive rejection');

    alipay.setHandler('tradeQuery', () => ({ raw: 'query down', status: 502 }));
    const unproven = await attempt();
    assert.ok(unproven instanceof AlipayProviderError);
    assert.equal(unproven.acceptance, 'unknown', 'an unproven query keeps acceptance unknown');
  } finally {
    await alipay.close();
  }
});

test('createOrder acceptance: transport, non-2xx, bad JSON, missing node and bad success echoes are unknown', async () => {
  const alipay = await startMockAlipay();
  try {
    const provider = createAlipayPaymentProvider(config(alipay));
    const attempt = () =>
      provider.adapter.createOrder(createOrderInput()).then(
        () => null,
        (error: unknown) => error,
      );

    alipay.setHandler('precreate', () => ({ raw: '<html>bad gateway</html>', status: 502 }));
    assert.equal(((await attempt()) as AlipayProviderError).acceptance, 'unknown');
    alipay.setHandler('precreate', () => ({ raw: 'not json', status: 200 }));
    assert.equal(((await attempt()) as AlipayProviderError).acceptance, 'unknown');
    alipay.setHandler('precreate', () => ({ json: { sign: 'x' } }));
    assert.equal(((await attempt()) as AlipayProviderError).acceptance, 'unknown', 'missing response node');
    alipay.setHandler('precreate', () => ({ json: precreateSuccess({ out_trade_no: 'order-OTHER' }) }));
    assert.equal(((await attempt()) as AlipayProviderError).acceptance, 'unknown', 'out_trade_no echo mismatch');
    alipay.setHandler('precreate', () => ({ json: precreateSuccess({ qr_code: '' }) }));
    assert.equal(((await attempt()) as AlipayProviderError).acceptance, 'unknown', 'a missing qr_code is unknown');
    assert.equal(alipay.calls.tradeQuery.length, 0, 'non-business failures never trigger the query recheck');

    const unreachable = createAlipayPaymentProvider(deadConfig());
    const transport = await unreachable.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof AlipayProviderError && transport.acceptance === 'unknown');
  } finally {
    await alipay.close();
  }
});

test('createOrder rejects identity and currency mismatches without any provider call', async () => {
  const alipay = await startMockAlipay();
  try {
    alipay.setHandler('precreate', () => ({ json: precreateSuccess() }));
    const provider = createAlipayPaymentProvider(config(alipay));
    for (const input of [
      createOrderInput({ idempotencyReference: 'other' }),
      createOrderInput({ merchantId: '2021000999999999' }),
      createOrderInput({ currency: 'USD' }),
      createOrderInput({ amountMinorUnits: '12.34' }),
    ]) {
      const failure = await provider.adapter.createOrder(input).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'unknown');
    }
    assert.equal(alipay.calls.precreate.length, 0);
  } finally {
    await alipay.close();
  }
});

test('verifyWebhook verifies RSA2, app_id and seller_id, and rejects tampering, wrong keys and header games', async () => {
  const provider = createAlipayPaymentProvider(deadConfig());
  const body = signedNotify();
  const verified = await provider.adapter.verifyWebhook({ headers: {}, rawBody: body, merchantId: APP_ID });
  assert.equal(verified.providerKey, ALIPAY_PROVIDER_KEY);
  assert.equal(verified.merchantId, APP_ID);

  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: body, merchantId: '2021000999999999' }));
  const tampered = Buffer.from(body.toString('utf8').replace('12.34', '99.99'), 'utf8');
  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: tampered, merchantId: APP_ID }));
  const wrongKey = signedNotify({}, ALIPAY_TEST_MERCHANT_PRIVATE_KEY);
  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: wrongKey, merchantId: APP_ID }));
  const rsa1 = Buffer.from(`${body.toString('utf8').replace('sign_type=RSA2', 'sign_type=RSA1')}`, 'utf8');
  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: rsa1, merchantId: APP_ID }));
  await assert.rejects(
    provider.adapter.verifyWebhook({
      headers: {},
      rawBody: signedNotify({ app_id: '2021000999999999' }),
      merchantId: APP_ID,
    }),
    /app_id mismatch/,
  );
  await assert.rejects(
    provider.adapter.verifyWebhook({
      headers: {},
      rawBody: signedNotify({ seller_id: '2088999999999999' }),
      merchantId: APP_ID,
    }),
    /seller_id mismatch/,
  );
  const unsigned = Buffer.from('app_id=2021000123456789&seller_id=2088102171234567&out_trade_no=x', 'utf8');
  await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: unsigned, merchantId: APP_ID }));

  const pairs = new URLSearchParams(body.toString('utf8'));
  const shuffled = new URLSearchParams([...pairs.entries()].reverse()).toString();
  const reordered = await provider.adapter.verifyWebhook({
    headers: {},
    rawBody: Buffer.from(shuffled, 'utf8'),
    merchantId: APP_ID,
  });
  assert.equal(reordered.providerKey, ALIPAY_PROVIDER_KEY, 'posted parameter order is irrelevant to verification');
});

test('normalizeEvent maps trade statuses, anchors identity and recovers the tenant pass-through', async () => {
  const provider = createAlipayPaymentProvider(deadConfig());
  const verify = (rawBody: Buffer) => provider.adapter.verifyWebhook({ headers: {}, rawBody, merchantId: APP_ID });

  const succeeded = provider.adapter.normalizeEvent(await verify(signedNotify()));
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.providerOrderId, ORDER_ID, 'the precreate identity anchor is the out_trade_no');
  assert.equal(succeeded.providerEventId, `notify-e2e-1:${ORDER_ID}:${TRADE_NO}`);
  assert.equal(succeeded.eventType, 'alipay.trade.notify.TRADE_SUCCESS');
  assert.equal(succeeded.tenantId, TENANT_ID);
  assert.equal(succeeded.amountMinorUnits, '1234');
  assert.equal(succeeded.currency, 'CNY');
  assert.equal(new Date(succeeded.occurredAt).toISOString(), '2026-10-10T23:59:30.000Z');

  for (const [tradeStatus, mapped] of [
    ['TRADE_FINISHED', 'succeeded'],
    ['WAIT_BUYER_PAY', 'pending'],
    ['TRADE_CLOSED', 'failed'],
    ['SOMETHING_NEW', 'pending'],
  ] as const) {
    const event = provider.adapter.normalizeEvent(
      await verify(signedNotify({ trade_status: tradeStatus, notify_id: `notify-${tradeStatus}` })),
    );
    assert.equal(event.status, mapped, tradeStatus);
  }

  const unpaid = provider.adapter.normalizeEvent(
    await verify(signedNotify({ trade_status: 'WAIT_BUYER_PAY', trade_no: '' })),
  );
  assert.equal(unpaid.providerEventId, `notify-e2e-1:${ORDER_ID}:open`, 'an unpaid notify carries the open anchor');

  const orphan = provider.adapter.normalizeEvent(await verify(signedNotify({ passback_params: '' })));
  assert.equal(orphan.tenantId, 'unresolved-tenant', 'a missing tenant pass-through routes to reconciliation');
});

test('normalizeEvent throws on a signed payload whose fields are individually invalid', async () => {
  const provider = createAlipayPaymentProvider(deadConfig());
  const verify = (rawBody: Buffer) => provider.adapter.verifyWebhook({ headers: {}, rawBody, merchantId: APP_ID });
  // The mock signs whatever it is given, so these payloads carry VALID
  // signatures; the field-level validation lives in normalizeEvent.
  for (const broken of [
    signedNotify({ total_amount: '12.345' }),
    signedNotify({ total_amount: 'not-money' }),
    signedNotify({ notify_id: '' }),
    signedNotify({ out_trade_no: '' }),
    signedNotify({ trade_status: '' }),
  ]) {
    const verified = await verify(broken);
    assert.throws(() => provider.adapter.normalizeEvent(verified));
  }
  assert.throws(() =>
    provider.adapter.normalizeEvent({
      providerKey: ALIPAY_PROVIDER_KEY,
      merchantId: APP_ID,
      payload: { out_trade_no: ORDER_ID, notify_id: 'n1', trade_status: 'TRADE_SUCCESS', total_amount: '12.345' },
    }),
  );
});

test('confirmEvent enforces the active trade.query red line across every branch', async () => {
  const alipay = await startMockAlipay();
  try {
    const provider = createAlipayPaymentProvider(config(alipay));
    const confirmEvent = provider.adapter.confirmEvent;
    assert.ok(confirmEvent);
    const input = (
      orderOverrides: Partial<PaymentProviderEventConfirmationInput['order']> = {},
      eventOverrides: Partial<PaymentProviderEventConfirmationInput['event']> = {},
    ): PaymentProviderEventConfirmationInput => ({
      event: {
        providerEventId: `notify-e2e-1:${ORDER_ID}:${TRADE_NO}`,
        eventType: 'alipay.trade.notify.TRADE_SUCCESS',
        providerOrderId: ORDER_ID,
        tenantId: TENANT_ID,
        merchantId: APP_ID,
        status: 'succeeded',
        amountMinorUnits: '1234',
        currency: 'CNY',
        occurredAt: NOW,
        ...eventOverrides,
      },
      order: {
        localOrderId: ORDER_ID,
        tenantId: TENANT_ID,
        merchantId: APP_ID,
        amountMinorUnits: '1234',
        currency: 'CNY',
        providerOrderId: ORDER_ID,
        ...orderOverrides,
      },
    });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode() }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: true });
    assert.equal(alipay.calls.tradeQuery.length, 1);
    assert.equal(alipay.calls.tradeQuery[0]?.params.biz_content, '{"out_trade_no":"order-local-1"}');
    assert.equal(
      alipayVerifyRequestSign(alipay.calls.tradeQuery[0]?.params ?? {}, ALIPAY_TEST_MERCHANT_PUBLIC_KEY),
      true,
    );

    alipay.setHandler('tradeQuery', () => ({ json: tradeNotExistNode() }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'ALIPAY_TRADE_NOT_FOUND' });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ trade_status: 'WAIT_BUYER_PAY' }) }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'ALIPAY_TRADE_NOT_SUCCESS' });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ trade_status: 'TRADE_CLOSED' }) }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'ALIPAY_TRADE_NOT_SUCCESS' });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ total_amount: '99.99' }) }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'ALIPAY_AMOUNT_MISMATCH' });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode() }));
    assert.deepEqual(await confirmEvent(input({}, { amountMinorUnits: '9999' })), {
      confirmed: false,
      code: 'ALIPAY_AMOUNT_MISMATCH',
    });

    assert.deepEqual(await confirmEvent(input({ currency: 'USD' })), {
      confirmed: false,
      code: 'ALIPAY_CURRENCY_MISMATCH',
    });
    assert.deepEqual(await confirmEvent(input({}, { currency: 'USD' })), {
      confirmed: false,
      code: 'ALIPAY_CURRENCY_MISMATCH',
    });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ trade_no: '' }) }));
    // A paid trade without a trade number is a proven-content anomaly, never fulfillable.
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'ALIPAY_TRADE_NO_MISMATCH' });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ trade_no: '2099999999999999999999999999' }) }));
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'ALIPAY_TRADE_NO_MISMATCH',
    });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode() }));
    assert.deepEqual(
      await confirmEvent(input({}, { providerEventId: `notify-e2e-1:${ORDER_ID}:open` })),
      { confirmed: true },
      'an open trade anchor defers the trade_no proof to the active query',
    );

    assert.deepEqual(await confirmEvent(input({ providerOrderId: '2011111111111111111111111111' })), {
      confirmed: false,
      code: 'ALIPAY_TRADE_NO_MISMATCH',
    });

    alipay.setHandler('tradeQuery', () => ({ raw: '<html>down</html>', status: 502 }));
    await assert.rejects(confirmEvent(input()), (error: unknown) => {
      assert.ok(error instanceof AlipayProviderError && error.acceptance === 'unknown');
      return true;
    });
  } finally {
    await alipay.close();
  }
});

test('recoverOrder queries by out_trade_no, answers null when absent and never creates', async () => {
  const alipay = await startMockAlipay();
  try {
    const provider = createAlipayPaymentProvider(config(alipay));
    const recoverOrder = provider.adapter.recoverOrder;
    assert.ok(recoverOrder);
    const recovery = (extra: Record<string, unknown> = {}) => ({
      localOrderId: ORDER_ID,
      tenantId: TENANT_ID,
      amountMinorUnits: '1234',
      currency: 'CNY',
      merchantId: APP_ID,
      idempotencyReference: ORDER_ID,
      ...extra,
    });

    alipay.setHandler('tradeQuery', () => ({ json: tradeNotExistNode() }));
    assert.equal(await recoverOrder(recovery()), null);
    assert.equal(alipay.calls.precreate.length, 0, 'recovery never submits a precreate');

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode() }));
    assert.deepEqual(await recoverOrder(recovery()), {
      providerOrderId: ORDER_ID,
      amountMinorUnits: '1234',
      currency: 'CNY',
    });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ total_amount: '' }) }));
    const fallback = await recoverOrder(recovery());
    assert.deepEqual(fallback, { providerOrderId: ORDER_ID, amountMinorUnits: '1234', currency: 'CNY' });

    alipay.setHandler('tradeQuery', () => ({ json: tradeQueryNode({ total_amount: '56.78' }) }));
    const repriced = await recoverOrder(recovery());
    assert.equal(repriced?.amountMinorUnits, '5678', 'the recovered amount follows the provider echo');

    alipay.setHandler('tradeQuery', () => ({ raw: 'down', status: 500 }));
    await assert.rejects(
      recoverOrder(recovery()),
      (error: unknown) => error instanceof AlipayProviderError && error.acceptance === 'unknown',
    );

    const callsBefore = alipay.calls.tradeQuery.length;
    for (const bad of [recovery({ idempotencyReference: 'other' }), recovery({ merchantId: '2021000999999999' })]) {
      await assert.rejects(
        recoverOrder(bad),
        (error: unknown) => error instanceof AlipayProviderError && error.acceptance === 'unknown',
      );
    }
    assert.equal(alipay.calls.tradeQuery.length, callsBefore, 'identity failures never reach the provider');
  } finally {
    await alipay.close();
  }
});

test('submitRefund posts alipay.trade.refund with out_request_no idempotency and maps the tri-state', async () => {
  const alipay = await startMockAlipay();
  try {
    const provider = createAlipayPaymentProvider(config(alipay));
    const refundNode = (overrides: Record<string, unknown> = {}) =>
      alipayGatewayEnvelope('alipay.trade.refund', {
        code: '10000',
        msg: 'Success',
        trade_no: TRADE_NO,
        out_trade_no: ORDER_ID,
        out_request_no: 'refund-1',
        fund_change: 'Y',
        refund_fee: '12.34',
        ...overrides,
      });

    alipay.setHandler('refund', () => ({ json: refundNode() }));
    const succeeded = await provider.refundAdapter.submitRefund(refundInput());
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(succeeded.providerRefundId, 'refund-1', 'the out_request_no is the natural refund identity');
    assert.equal(succeeded.localRefundId, 'refund-1');
    const [sent] = alipay.calls.refund;
    assert.ok(sent);
    assert.equal(sent.params.method, 'alipay.trade.refund');
    assert.equal(
      sent.params.biz_content,
      '{"out_request_no":"refund-1","out_trade_no":"order-local-1","refund_amount":"12.34"}',
    );
    assert.equal(alipayVerifyRequestSign(sent.params, ALIPAY_TEST_MERCHANT_PUBLIC_KEY), true);

    alipay.setHandler('refund', () => ({ json: refundNode({ fund_change: 'N' }) }));
    assert.equal((await provider.refundAdapter.submitRefund(refundInput())).status, 'pending');

    alipay.setHandler('refund', () => ({ json: refundNode({ refund_fee: '99.99' }) }));
    let failure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'unknown', 'refund_fee echo mismatch');

    alipay.setHandler('refund', () => ({ json: refundNode({ out_trade_no: 'order-OTHER' }) }));
    failure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'unknown');

    alipay.setHandler('refund', () => ({ json: refundNode({ fund_change: '' }) }));
    failure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'unknown');

    alipay.setHandler('refund', () => ({
      json: alipayGatewayEnvelope('alipay.trade.refund', {
        code: '40004',
        msg: 'Business Failed',
        sub_code: 'ACQ.TRADE_NOT_EXIST',
        sub_msg: '交易不存在',
      }),
    }));
    failure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'not_accepted');

    alipay.setHandler('refund', () => ({
      json: alipayGatewayEnvelope('alipay.trade.refund', {
        code: '40004',
        msg: 'Business Failed',
        sub_code: 'ACQ.SELLER_BALANCE_NOT_ENOUGH',
        sub_msg: '卖家余额不足',
      }),
    }));
    failure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'unknown');

    alipay.setHandler('refund', () => ({ raw: '<html>proxy error</html>', status: 502 }));
    failure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError && failure.acceptance === 'unknown');

    const callsBefore = alipay.calls.refund.length;
    for (const bad of [
      refundInput({ providerKey: 'easypay' }),
      refundInput({ merchantId: '2021000999999999' }),
      refundInput({ idempotencyReference: 'other' }),
      refundInput({ currency: 'USD' }),
    ]) {
      const identityFailure = await provider.refundAdapter.submitRefund(bad).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(identityFailure instanceof AlipayProviderError && identityFailure.acceptance === 'unknown');
    }
    assert.equal(alipay.calls.refund.length, callsBefore, 'identity failures never reach the provider');
  } finally {
    await alipay.close();
  }
});

test('queryRefund resolves the real tri-state and never fabricates a verdict', async () => {
  const alipay = await startMockAlipay();
  try {
    const provider = createAlipayPaymentProvider(config(alipay));
    const query = (overrides: Record<string, unknown> = {}) =>
      provider.refundAdapter.queryRefund(refundInput({ providerRefundId: 'refund-1', ...overrides }));
    const queryNode = (overrides: Record<string, unknown> = {}) =>
      alipayGatewayEnvelope('alipay.trade.fastpay.refund.query', {
        code: '10000',
        msg: 'Success',
        trade_no: TRADE_NO,
        out_trade_no: ORDER_ID,
        out_request_no: 'refund-1',
        refund_amount: '12.34',
        refund_status: 'REFUND_SUCCESS',
        ...overrides,
      });

    alipay.setHandler('refundQuery', () => ({ json: queryNode() }));
    assert.equal((await query()).status, 'succeeded');
    assert.equal(
      alipay.calls.refundQuery[0]?.params.biz_content,
      '{"out_request_no":"refund-1","out_trade_no":"order-local-1"}',
    );

    alipay.setHandler('refundQuery', () => ({ json: queryNode({ refund_status: '' }) }));
    assert.equal((await query()).status, 'pending', 'a success envelope without a status is still in flight');

    for (const failed of ['REFUND_FAIL', 'REFUND_FAILED', 'REFUND_CLOSED'] as const) {
      alipay.setHandler('refundQuery', () => ({ json: queryNode({ refund_status: failed }) }));
      assert.equal((await query()).status, 'failed', failed);
    }

    alipay.setHandler('refundQuery', () => ({ json: queryNode({ refund_status: 'SOMETHING_NEW' }) }));
    assert.equal((await query()).status, 'unknown', 'an unrecognized status is never a verdict');

    alipay.setHandler('refundQuery', () => ({
      json: alipayGatewayEnvelope('alipay.trade.fastpay.refund.query', {
        code: '40004',
        msg: 'Business Failed',
        sub_code: 'ACQ.REFUND_NOT_EXIST',
        sub_msg: '退款不存在',
      }),
    }));
    assert.equal((await query()).status, 'not_found');

    alipay.setHandler('refundQuery', () => ({ json: queryNode({ out_request_no: 'refund-OTHER' }) }));
    assert.equal((await query()).status, 'unknown', 'an out_request_no echo mismatch is never a verdict');

    alipay.setHandler('refundQuery', () => ({ json: queryNode({ refund_amount: '99.99' }) }));
    assert.equal((await query()).status, 'unknown', 'a refund amount mismatch is never a verdict');

    alipay.setHandler('refundQuery', () => ({ raw: 'down', status: 500 }));
    assert.equal((await query()).status, 'unknown');

    const unreachable = createAlipayPaymentProvider(deadConfig());
    assert.equal(
      (await unreachable.refundAdapter.queryRefund(refundInput({ providerRefundId: 'refund-1' }))).status,
      'unknown',
      'a transport failure answers unknown instead of throwing the worker off course',
    );

    const callsBefore = alipay.calls.refundQuery.length;
    assert.equal((await query({ providerRefundId: 'refund-DRIFT' })).status, 'unknown');
    assert.equal((await query({ merchantId: '2021000999999999' })).status, 'unknown');
    assert.equal((await query({ providerKey: 'easypay' })).status, 'unknown');
    assert.equal(alipay.calls.refundQuery.length, callsBefore, 'identity drift never reaches the provider');
  } finally {
    await alipay.close();
  }
});

test('error surfaces never leak the merchant private key, even when the upstream echoes it', async () => {
  const alipay = await startMockAlipay();
  try {
    const pemBody = ALIPAY_TEST_MERCHANT_PRIVATE_KEY.split('\n')
      .filter((line) => !line.startsWith('-----'))
      .join('');
    alipay.setHandler('precreate', () => ({
      json: alipayGatewayEnvelope('alipay.trade.precreate', {
        code: '40004',
        msg: 'Business Failed',
        sub_code: 'ACQ.INVALID_PARAMETER',
        sub_msg: `echoed ${ALIPAY_TEST_MERCHANT_PRIVATE_KEY} verbatim`,
      }),
    }));
    alipay.setHandler('tradeQuery', () => ({ json: tradeNotExistNode() }));
    const provider = createAlipayPaymentProvider(config(alipay));
    const failure = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof AlipayProviderError);
    assert.equal(failure.message.includes('PRIVATE KEY'), false);
    assert.equal(failure.message.includes(pemBody), false);
    assert.match(failure.message, /\*\*\*/);

    assert.throws(
      () => createAlipayPaymentProvider(deadConfig({ merchantPrivateKey: ALIPAY_TEST_MERCHANT_PUBLIC_KEY })),
      (error: unknown) => {
        assert.ok(error instanceof AlipayConfigurationError);
        assert.equal(error.message.includes('MII'), false, 'config errors carry static labels, never key material');
        return true;
      },
    );
  } finally {
    await alipay.close();
  }
});
