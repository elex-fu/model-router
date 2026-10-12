import assert from 'node:assert/strict';
import { createCipheriv, createPrivateKey, createPublicKey } from 'node:crypto';
import { test } from 'node:test';
import type { PaymentProviderEventConfirmationInput } from '../../../src/saas/payments/adapter.js';
import {
  buildWxpayAuthorization,
  createWxpayPaymentProvider,
  decryptWxpayAesGcm,
  parseWxpayPlatformCertificate,
  signWxpayRequest,
  verifyWxpayNotificationSignature,
  WXPAY_PROVIDER_KEY,
  WXPAY_WEBHOOK_TOLERANCE_MS,
  WxpayConfigurationError,
  WxpayProviderError,
  wxpayAmountToMinorUnits,
  wxpayMinorUnitsToWire,
  wxpayOutTradeNo,
} from '../../../src/saas/payments/providers/wxpay/index.js';
import {
  type MockWxpay,
  startMockWxpay,
  WXPAY_TEST_APIV3_KEY,
  WXPAY_TEST_APPID,
  WXPAY_TEST_MCHID,
  WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM,
  WXPAY_TEST_MERCHANT_SERIAL,
  WXPAY_TEST_PLATFORM_ALT_CERTIFICATE_PEM,
  WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM,
  WXPAY_TEST_PLATFORM_ALT_SERIAL,
  WXPAY_TEST_PLATFORM_CERTIFICATE_PEM,
  WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM,
  WXPAY_TEST_PLATFORM_SERIAL,
  wxpayCertificatesJson,
  wxpayNotification,
  wxpayNotificationSignature,
  wxpayRefundJson,
  wxpayTransactionJson,
} from './mock-wxpay.js';

// R3 wxpay adapter against the programmable mock WeChat Pay v3 server. Covers
// fail-closed configuration, the WECHATPAY2-SHA256-RSA2048 request-signature
// known-answer vectors (openssl-derived), strict fixed-point fen money, the
// out_trade_no local mapping, the create acceptance tri-state (with the active
// out-trade-no recheck), platform-certificate fetch/cache + RSA webhook
// verification + AES-256-GCM resource decryption, normalization, the
// pre-fulfillment query red line, recovery that never creates, the refund
// submit/query REAL tri-state and secret redaction.

const NOW = new Date('2026-10-12T00:00:00.000Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);
const TENANT_ID = 'tenant-1';
const LOCAL_ORDER_ID = 'order-local-1';
const TRANSACTION_ID = '4200000000000000000000000001';
const CODE_URL = 'weixin://wxpay/bizpayurl?pr=abc123XYZ';

// openssl-derived known-answer vectors (RSA-SHA256, PKCS1v1.5 is deterministic):
// message = "POST\n/v3/pay/transactions/native\n1791532800\n<nonce>\n<body>\n" signed by
// the test merchant key and independently produced with `openssl dgst -sha256 -sign`.
const KAT_POST_BODY =
  `{"appid":"${WXPAY_TEST_APPID}","mchid":"${WXPAY_TEST_MCHID}","description":"Order order-local-1",` +
  `"out_trade_no":"order-local-1","notify_url":"https://payments.example.com/webhooks/wxpay",` +
  `"attach":"tenant-1","amount":{"total":1234,"currency":"CNY"}}`;
const KAT_POST_SIGNATURE =
  'lEk0rNvKzsSsKO00euGSVTk1rGOvdc7PepA1qetNvnsqk6jQg9+XsJT+q2xCOV/v3xhNtSd3qDr7OawHbZszW4gtzaKQq9LalL4O5iiY7s2Vc2cclcmbcI5F552UcfqdxJjL4DskLasNjWqmtd2Jpi+f9J0dKcZ+e2BIvYKdtkrO6yUSDjo+sbow/A1loyXOnP2JxNKEtY/9g/4XL9n5bg/6WbKbbgAUYzuS0n1rouPJjxwbypJZNXwTYoqw48S0oDad1q3BTBhEGQwnX+TJ9rnITexLBYcHe3J3Yka7KSwPcvaWoe5cFYoc3U6Xhqt/w9bDidb7RSq2tujHhoc/zA==';
const KAT_GET_SIGNATURE =
  'AbxagLphHoFCJyJ9epKbIRspGy1VBqdYpcOnfKaWUjOjoX/piTPm4wmDqlayaEhh9WeYAyt5eOtfyx7PW57usCfCyhCCPFY1wXibkvHNJkCvlZEnmBCmvYVn57tVJNhofeKkmh4S1EPzFPHu4zHKJgB6gB7ieBpRpUELDDV7FP/Xt0iiXDAm14mOrOqWCiZe8FRRQqjcdn1Ap/ZOJVu+ZQaL4lo/zNBxLB3bkXBoRGzYQaUCIwn32WYx8neOpgBMbMZuRyDtdK1nzqDQUlTcdwH56KiJGCHV/pOGNO6dTSAe++KeU2f/bH1Wjvd3G/vXud6U6HiNeMId7IhNTpw8mA==';

function config(wxpay: MockWxpay, overrides: Record<string, unknown> = {}) {
  return {
    mchid: WXPAY_TEST_MCHID,
    appid: WXPAY_TEST_APPID,
    merchantSerialNo: WXPAY_TEST_MERCHANT_SERIAL.toLowerCase(),
    merchantPrivateKey: WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM,
    apiV3Key: WXPAY_TEST_APIV3_KEY,
    gateway: wxpay.url,
    notifyUrl: 'https://payments.example.com/webhooks/wxpay',
    now: () => new Date(NOW.getTime()),
    ...overrides,
  };
}

function deadConfig(overrides: Record<string, unknown> = {}) {
  return config({ url: 'http://127.0.0.1:1' } as MockWxpay, overrides);
}

function createOrderInput(overrides: Record<string, unknown> = {}) {
  return {
    localOrderId: LOCAL_ORDER_ID,
    tenantId: TENANT_ID,
    amountMinorUnits: '1234',
    currency: 'CNY',
    merchantId: WXPAY_TEST_MCHID,
    idempotencyReference: LOCAL_ORDER_ID,
    ...overrides,
  };
}

function refundInput(overrides: Record<string, unknown> = {}) {
  return {
    localRefundId: 'refund-1',
    idempotencyReference: 'refund-1',
    tenantId: TENANT_ID,
    originalLocalOrderId: LOCAL_ORDER_ID,
    providerKey: WXPAY_PROVIDER_KEY,
    merchantId: WXPAY_TEST_MCHID,
    providerOrderId: LOCAL_ORDER_ID,
    amountMinorUnits: '400',
    currency: 'CNY',
    providerRefundId: null as string | null,
    ...overrides,
  };
}

function paidTransaction(overrides: Record<string, unknown> = {}) {
  return {
    outTradeNo: LOCAL_ORDER_ID,
    transactionId: TRANSACTION_ID,
    tradeState: 'SUCCESS',
    total: 1234,
    attach: TENANT_ID,
    ...overrides,
  } as const;
}

function programSuccessQuery(wxpay: MockWxpay, overrides: Record<string, unknown> = {}): void {
  wxpay.setHandler('transactionsQuery', () => ({ json: wxpayTransactionJson(paidTransaction(overrides)) }));
}

test('configuration fails closed on identity shapes, key material, gateway, currency and payment mode', () => {
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ mchid: 'mch-1' })), WxpayConfigurationError);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ mchid: '' })), WxpayConfigurationError);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ appid: 'app_123' })), WxpayConfigurationError);
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ appid: 'wx1234567890abcd' })),
    WxpayConfigurationError,
    'appid must be wx + 16 hex chars',
  );
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ merchantSerialNo: 'abcdef' })),
    WxpayConfigurationError,
    'merchant serial must be 40-hex',
  );
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ merchantSerialNo: 'g'.repeat(40) })),
    WxpayConfigurationError,
  );
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ merchantPrivateKey: 'not a pem' })), /PKCS8/);
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ merchantPrivateKey: WXPAY_TEST_APIV3_KEY.repeat(40) })),
    WxpayConfigurationError,
  );
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ apiV3Key: 'short' })), /exactly 32 bytes/);
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ apiV3Key: `${WXPAY_TEST_APIV3_KEY}x` })),
    /exactly 32 bytes/,
  );
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ gateway: 'http://api.mch.weixin.qq.com' })),
    /https outside loopback/,
  );
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ gateway: 'https://api.mch.weixin.qq.com/v3' })),
    WxpayConfigurationError,
  );
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ notifyUrl: 'http://example.com/hook' })), /https/);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ notifyUrl: 'relative/path' })), WxpayConfigurationError);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ currency: 'USD' })), /only supports CNY/);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ paymentMode: 'jsapi' })), /only supports native/);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ paymentMode: 'app' })), /only supports native/);
  assert.throws(() => createWxpayPaymentProvider(deadConfig({ checkoutTtlMs: 0 })), WxpayConfigurationError);

  const provider = createWxpayPaymentProvider(deadConfig());
  assert.equal(provider.refundAdapter.merchantId, WXPAY_TEST_MCHID);
  const defaulted = createWxpayPaymentProvider(deadConfig({ gateway: undefined, paymentMode: undefined }));
  assert.ok(defaulted.adapter);
  assert.throws(
    () => createWxpayPaymentProvider(deadConfig({ merchantSerialNo: undefined })),
    WxpayConfigurationError,
    'the merchant serial is required configuration (sent as serial_no on every signed request)',
  );
});

test('request signing matches the openssl known-answer vectors and assembles the Authorization header', () => {
  const privateKey = createPrivateKey(WXPAY_TEST_MERCHANT_PRIVATE_KEY_PEM);
  const postSignature = signWxpayRequest({
    method: 'POST',
    urlPath: '/v3/pay/transactions/native',
    timestamp: '1791532800',
    nonce: '0123456789abcdef0123456789abcdef',
    body: KAT_POST_BODY,
    privateKey,
  });
  assert.equal(postSignature, KAT_POST_SIGNATURE, 'POST signature must match the openssl vector byte for byte');
  const getSignature = signWxpayRequest({
    method: 'get',
    urlPath: '/v3/certificates',
    timestamp: '1791532800',
    nonce: 'fedcba9876543210fedcba9876543210',
    body: '',
    privateKey,
  });
  assert.equal(getSignature, KAT_GET_SIGNATURE, 'GET (empty body) signature must match the openssl vector');
  const authorization = buildWxpayAuthorization({
    mchid: WXPAY_TEST_MCHID,
    serialNo: WXPAY_TEST_MERCHANT_SERIAL,
    nonce: '0123456789abcdef0123456789abcdef',
    timestamp: '1791532800',
    signature: postSignature,
  });
  assert.equal(
    authorization,
    `WECHATPAY2-SHA256-RSA2048 mchid="${WXPAY_TEST_MCHID}",nonce_str="0123456789abcdef0123456789abcdef",` +
      `signature="${postSignature}",timestamp="1791532800",serial_no="${WXPAY_TEST_MERCHANT_SERIAL}"`,
  );
});

test('money is strict fixed-point fen in both directions', () => {
  assert.equal(wxpayMinorUnitsToWire('0'), '0');
  assert.equal(wxpayMinorUnitsToWire('1234'), '1234');
  assert.equal(wxpayMinorUnitsToWire('9007199254740991'), '9007199254740991');
  for (const bad of ['12.34', '1e3', '-1', '', '01', '1.0', ' 1', '1 ', '1,234']) {
    assert.throws(() => wxpayMinorUnitsToWire(bad), WxpayConfigurationError, bad);
  }
  assert.equal(wxpayAmountToMinorUnits(1234), '1234');
  assert.equal(wxpayAmountToMinorUnits('1234'), '1234');
  assert.equal(wxpayAmountToMinorUnits(0), '0');
  assert.equal(wxpayAmountToMinorUnits(12.5), null);
  assert.equal(wxpayAmountToMinorUnits('1e3'), null);
  assert.equal(wxpayAmountToMinorUnits('12.34'), null);
  assert.equal(wxpayAmountToMinorUnits(-1), null);
  assert.equal(wxpayAmountToMinorUnits(2 ** 53), null, 'float-rounding territory fails closed');
  assert.equal(wxpayAmountToMinorUnits(null), null);
});

test('out_trade_no mapping is identity inside the wire alphabet and deterministic hashing outside it', () => {
  assert.equal(wxpayOutTradeNo('order-local-1'), 'order-local-1');
  assert.equal(wxpayOutTradeNo('abc123'), 'abc123');
  const uuid = '00000000-0000-4000-8000-000000000001';
  const mapped = wxpayOutTradeNo(uuid);
  assert.match(mapped, /^h[0-9a-f]{31}$/, 'uuid-shaped ids map onto a 32-char digest form');
  assert.equal(wxpayOutTradeNo(uuid), mapped, 'the mapping is deterministic (locally recoverable)');
  assert.notEqual(wxpayOutTradeNo(`${uuid}x`), mapped);
  assert.match(wxpayOutTradeNo('short'), /^h[0-9a-f]{31}$/, 'short ids below the wire minimum hash too');
  assert.throws(() => wxpayOutTradeNo(''), WxpayConfigurationError);
});

test('createOrder posts the merchant-signed native prepay and normalizes the code_url qr checkout', async () => {
  const wxpay = await startMockWxpay();
  try {
    wxpay.setHandler('transactionsNativeCreate', () => ({ json: { code_url: CODE_URL } }));
    const provider = createWxpayPaymentProvider(config(wxpay));
    const result = await provider.adapter.createOrder(createOrderInput());
    assert.equal(result.providerOrderId, LOCAL_ORDER_ID, 'the provider order id IS the out_trade_no');
    assert.equal(result.amountMinorUnits, '1234');
    assert.equal(result.currency, 'CNY');
    assert.deepEqual(result.checkoutAction, {
      kind: 'qr',
      text: CODE_URL,
      expiresAt: '2026-10-12T02:00:00.000Z',
    });
    const [sent] = wxpay.calls.transactionsNativeCreate;
    assert.ok(sent);
    assert.equal(sent.path, '/v3/pay/transactions/native');
    // Raw-token interpolation keeps the amount an unquoted JSON integer.
    assert.match(sent.rawBody, /"amount":\{"total":1234,"currency":"CNY"\}/);
    assert.match(sent.rawBody, /"out_trade_no":"order-local-1"/);
    assert.match(sent.rawBody, /"attach":"tenant-1"/);
    assert.match(sent.rawBody, /"notify_url":"https:\/\/payments\.example\.com\/webhooks\/wxpay"/);
    const authorization = sent.headers.authorization ?? '';
    assert.ok(authorization.startsWith('WECHATPAY2-SHA256-RSA2048 '));
    assert.match(authorization, new RegExp(`mchid="${WXPAY_TEST_MCHID}"`));
    assert.match(authorization, new RegExp(`serial_no="${WXPAY_TEST_MERCHANT_SERIAL}"`));
    assert.match(authorization, new RegExp(`timestamp="${NOW_SEC}"`));
    assert.equal(wxpay.calls.transactionsQuery.length, 0, 'a clean create never queries');
  } finally {
    await wxpay.close();
  }
});

test('createOrder acceptance: a business 4xx is rejected only when the active query proves 404', async () => {
  const wxpay = await startMockWxpay();
  try {
    wxpay.setHandler('transactionsNativeCreate', () => ({
      status: 400,
      json: { code: 'PARAM_ERROR', message: 'amount invalid' },
    }));
    const provider = createWxpayPaymentProvider(config(wxpay));
    const attempt = () =>
      provider.adapter.createOrder(createOrderInput()).then(
        () => null,
        (error: unknown) => error,
      );

    wxpay.setHandler('transactionsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'order not exists' },
    }));
    const rejected = await attempt();
    assert.ok(rejected instanceof WxpayProviderError);
    assert.equal(rejected.acceptance, 'rejected', 'business 4xx + proven 404 is the only definitive rejection');
    assert.match(rejected.message, /amount invalid/);
    assert.equal(wxpay.calls.transactionsQuery.length, 1);
    assert.equal(wxpay.calls.transactionsQuery[0]?.path, `/v3/pay/transactions/out-trade-no/${LOCAL_ORDER_ID}`);
    assert.equal(wxpay.calls.transactionsQuery[0]?.query.mchid, WXPAY_TEST_MCHID);

    wxpay.setHandler('transactionsQuery', () => ({
      json: wxpayTransactionJson(paidTransaction({ tradeState: 'USERPAYING' })),
    }));
    const existing = await attempt();
    assert.ok(existing instanceof WxpayProviderError);
    assert.equal(existing.acceptance, 'unknown', 'an order the query can see is never a definitive rejection');

    wxpay.setHandler('transactionsQuery', () => ({ raw: 'query down', status: 500 }));
    const unproven = await attempt();
    assert.ok(unproven instanceof WxpayProviderError);
    assert.equal(unproven.acceptance, 'unknown', 'an unproven query keeps acceptance unknown');
  } finally {
    await wxpay.close();
  }
});

test('createOrder acceptance: 5xx, transport, bad JSON and missing code_url are all unknown', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const attempt = () =>
      provider.adapter.createOrder(createOrderInput()).then(
        () => null,
        (error: unknown) => error,
      );

    wxpay.setHandler('transactionsNativeCreate', () => ({ raw: '<html>bad gateway</html>', status: 502 }));
    assert.equal(((await attempt()) as WxpayProviderError).acceptance, 'unknown');

    wxpay.setHandler('transactionsNativeCreate', () => ({ raw: 'not json', status: 200 }));
    assert.equal(((await attempt()) as WxpayProviderError).acceptance, 'unknown');

    wxpay.setHandler('transactionsNativeCreate', () => ({ json: {} }));
    assert.equal(((await attempt()) as WxpayProviderError).acceptance, 'unknown', 'a missing code_url is unknown');

    wxpay.setHandler('transactionsNativeCreate', () => ({ json: { code_url: 'https://evil.example.com/qr' } }));
    assert.equal(((await attempt()) as WxpayProviderError).acceptance, 'unknown', 'a non-weixin code_url is refused');

    wxpay.setHandler('transactionsNativeCreate', () => ({
      status: 400,
      json: { code: 'PARAM_ERROR', message: 'echo' },
    }));
    wxpay.setHandler('transactionsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'x' },
    }));
    const rejected = await attempt();
    assert.ok(rejected instanceof WxpayProviderError && rejected.acceptance === 'rejected');

    const unreachable = createWxpayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockWxpay));
    const transport = await unreachable.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof WxpayProviderError && transport.acceptance === 'unknown');
  } finally {
    await wxpay.close();
  }
});

test('createOrder rejects identity, currency and amount mismatches without any provider call', async () => {
  const wxpay = await startMockWxpay();
  try {
    wxpay.setHandler('transactionsNativeCreate', () => ({ json: {} }));
    const provider = createWxpayPaymentProvider(config(wxpay));
    for (const input of [
      createOrderInput({ idempotencyReference: 'other' }),
      createOrderInput({ merchantId: '1900009999' }),
      createOrderInput({ currency: 'USD' }),
      createOrderInput({ amountMinorUnits: '12.34' }),
    ]) {
      const failure = await provider.adapter.createOrder(input).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof WxpayProviderError && failure.acceptance === 'unknown');
    }
    assert.equal(wxpay.calls.transactionsNativeCreate.length, 0);
  } finally {
    await wxpay.close();
  }
});

test('platform certificate parsing enforces serial shape, RSA keys and the validity window', () => {
  const pem = Buffer.from(WXPAY_TEST_PLATFORM_CERTIFICATE_PEM, 'utf8');
  const parsed = parseWxpayPlatformCertificate(pem, NOW.getTime());
  assert.ok(parsed);
  assert.equal(parsed.serialNo, WXPAY_TEST_PLATFORM_SERIAL);
  const expired = parseWxpayPlatformCertificate(pem, Date.parse('2037-01-01T00:00:00.000Z'));
  assert.equal(expired, null, 'a certificate outside its validity window is refused');
  const premature = parseWxpayPlatformCertificate(pem, Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(premature, null);
  assert.equal(parseWxpayPlatformCertificate(Buffer.from('garbage', 'utf8'), NOW.getTime()), null);
});

test('notification signature verification follows the v3 scheme and fails closed', () => {
  const publicKey = createPublicKey(WXPAY_TEST_PLATFORM_PRIVATE_KEY_PEM);
  const body = Buffer.from('{"id":"evt-1"}', 'utf8');
  const timestamp = String(NOW_SEC);
  const nonce = 'nonce-1';
  const signature = wxpayNotificationSignature(body, timestamp, nonce);
  const base = { rawBody: body, timestamp, nonce, publicKey, nowMs: NOW.getTime() };
  assert.equal(verifyWxpayNotificationSignature({ ...base, signature }), true);
  assert.equal(
    verifyWxpayNotificationSignature({ ...base, rawBody: Buffer.from('{"id":"evt-2"}', 'utf8'), signature }),
    false,
    'a tampered body fails',
  );
  assert.equal(
    verifyWxpayNotificationSignature({
      ...base,
      signature: wxpayNotificationSignature(body, timestamp, nonce, WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM),
    }),
    false,
    'the wrong platform key fails',
  );
  assert.equal(
    verifyWxpayNotificationSignature({ ...base, signature, nowMs: NOW.getTime() + WXPAY_WEBHOOK_TOLERANCE_MS + 1 }),
    false,
    'a timestamp outside the 300s tolerance is rejected',
  );
  assert.equal(
    verifyWxpayNotificationSignature({ ...base, signature, nowMs: NOW.getTime() - WXPAY_WEBHOOK_TOLERANCE_MS }),
    true,
    'the tolerance boundary is inclusive',
  );
  assert.equal(verifyWxpayNotificationSignature({ ...base, signature: 'not-base64!!!' }), false);
  assert.equal(verifyWxpayNotificationSignature({ ...base, timestamp: 'abc', signature }), false);
  assert.equal(verifyWxpayNotificationSignature({ ...base, rawBody: Buffer.alloc(0), signature }), false);
});

test('AES-256-GCM resource decryption round-trips and fails closed on tampering or wrong keys', () => {
  const plaintext = Buffer.from('{"out_trade_no":"order-local-1"}', 'utf8');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(WXPAY_TEST_APIV3_KEY, 'utf8'), 'nonce-123');
  cipher.setAAD(Buffer.from('transaction', 'utf8'));
  const packed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const base = {
    apiV3Key: Buffer.from(WXPAY_TEST_APIV3_KEY, 'utf8'),
    nonce: 'nonce-123',
    associatedData: 'transaction',
  };
  const decrypted = decryptWxpayAesGcm({ ...base, ciphertext: packed.toString('base64') });
  assert.ok(decrypted);
  assert.equal(decrypted.toString('utf8'), plaintext.toString('utf8'));
  assert.equal(
    decryptWxpayAesGcm({
      ...base,
      apiV3Key: Buffer.from('abcdef0123456789abcdef0123456789', 'utf8'),
      ciphertext: packed.toString('base64'),
    }),
    null,
    'the wrong apiV3Key fails GCM authentication',
  );
  const tampered = Buffer.from(packed);
  tampered[0] = tampered[0] === 65 ? 66 : 65;
  assert.equal(decryptWxpayAesGcm({ ...base, ciphertext: tampered.toString('base64') }), null);
  assert.equal(
    decryptWxpayAesGcm({ ...base, associatedData: 'certificate', ciphertext: packed.toString('base64') }),
    null,
  );
  assert.equal(decryptWxpayAesGcm({ ...base, ciphertext: '!!!' }), null);
});

function signedNotification(
  transaction: Parameters<typeof wxpayNotification>[0]['transaction'],
  options: Partial<Parameters<typeof wxpayNotification>[0]> = {},
): { body: Buffer; headers: Record<string, string> } {
  return wxpayNotification({
    transaction,
    eventId: options.eventId ?? `evt-${transaction.outTradeNo}`,
    timestampSec: NOW_SEC,
    createTime: '2026-10-12T00:00:00+08:00',
    ...options,
  });
}

test('verifyWebhook fetches + caches the platform certificate, verifies RSA and decrypts the resource', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const { body, headers } = signedNotification(paidTransaction());
    const verified = await provider.adapter.verifyWebhook({ headers, rawBody: body, merchantId: WXPAY_TEST_MCHID });
    assert.equal(verified.providerKey, WXPAY_PROVIDER_KEY);
    assert.equal(verified.merchantId, WXPAY_TEST_MCHID);
    assert.equal(wxpay.calls.certificates.length, 1, 'the first verification fetches the platform certificates');

    const second = signedNotification(paidTransaction({ outTradeNo: 'order-local-2', transactionId: null }), {
      eventType: 'TRANSACTION.CLOSED',
    });
    await provider.adapter.verifyWebhook({
      headers: second.headers,
      rawBody: second.body,
      merchantId: WXPAY_TEST_MCHID,
    });
    assert.equal(wxpay.calls.certificates.length, 1, 'the certificate cache serves later verifications');

    const mixedCase = await provider.adapter.verifyWebhook({
      headers: {
        'Wechatpay-Signature': headers['wechatpay-signature'] as string,
        'Wechatpay-Timestamp': headers['wechatpay-timestamp'] as string,
        'Wechatpay-Nonce': headers['wechatpay-nonce'] as string,
        'Wechatpay-Serial': headers['wechatpay-serial'] as string,
      },
      rawBody: body,
      merchantId: WXPAY_TEST_MCHID,
    });
    assert.equal(mixedCase.providerKey, WXPAY_PROVIDER_KEY, 'header lookup is case-insensitive');

    await assert.rejects(
      provider.adapter.verifyWebhook({ headers, rawBody: body, merchantId: '1900009999' }),
      /merchant mismatch/,
    );
    await assert.rejects(provider.adapter.verifyWebhook({ headers: {}, rawBody: body, merchantId: WXPAY_TEST_MCHID }));
  } finally {
    await wxpay.close();
  }
});

test('verifyWebhook rejects tampered bodies, wrong keys, stale timestamps and unknown serials', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const good = signedNotification(paidTransaction());

    const tampered = Buffer.from(
      good.body.toString('utf8').replace('TRANSACTION.SUCCESS', 'TRANSACTION.CLOSED'),
      'utf8',
    );
    await assert.rejects(
      provider.adapter.verifyWebhook({ headers: good.headers, rawBody: tampered, merchantId: WXPAY_TEST_MCHID }),
    );

    const wrongKey = signedNotification(paidTransaction(), {
      platformPrivateKeyPem: WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM,
    });
    await assert.rejects(
      provider.adapter.verifyWebhook({
        headers: wrongKey.headers,
        rawBody: wrongKey.body,
        merchantId: WXPAY_TEST_MCHID,
      }),
      /signature is invalid/,
      'a notification signed by an unknown platform key fails against the served certificate',
    );

    const stale = signedNotification(paidTransaction(), { timestampSec: NOW_SEC - 400 });
    await assert.rejects(
      provider.adapter.verifyWebhook({ headers: stale.headers, rawBody: stale.body, merchantId: WXPAY_TEST_MCHID }),
    );

    const unknownSerial = signedNotification(paidTransaction(), { serialNo: WXPAY_TEST_PLATFORM_ALT_SERIAL });
    const certificatesBefore = wxpay.calls.certificates.length;
    await assert.rejects(
      provider.adapter.verifyWebhook({
        headers: unknownSerial.headers,
        rawBody: unknownSerial.body,
        merchantId: WXPAY_TEST_MCHID,
      }),
      /platform certificate is unavailable/,
    );
    assert.equal(
      wxpay.calls.certificates.length,
      certificatesBefore + 1,
      'an unknown serial triggers exactly one certificate refresh before failing closed',
    );
  } finally {
    await wxpay.close();
  }
});

test('verifyWebhook rejects a wrong apiV3Key, tampered ciphertext and resource merchant mismatch', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));

    const wrongKey = signedNotification(paidTransaction(), {
      apiV3Key: 'abcdef0123456789abcdef0123456789',
    });
    await assert.rejects(
      provider.adapter.verifyWebhook({
        headers: wrongKey.headers,
        rawBody: wrongKey.body,
        merchantId: WXPAY_TEST_MCHID,
      }),
      /decryption failed/,
      'a resource encrypted under another apiV3Key fails GCM authentication',
    );

    // Re-sign a body whose ciphertext is bit-flipped: a VALID signature over a
    // tampered resource must still fail at the GCM layer.
    const good = signedNotification(paidTransaction());
    const envelope = JSON.parse(good.body.toString('utf8')) as {
      resource: { ciphertext: string };
    };
    const packed = Buffer.from(envelope.resource.ciphertext, 'base64');
    packed[3] = packed[3] === 65 ? 66 : 65;
    envelope.resource.ciphertext = packed.toString('base64');
    const tamperedBody = Buffer.from(JSON.stringify(envelope), 'utf8');
    const timestamp = String(NOW_SEC);
    const nonce = 'nonce-tampered';
    const tampered = {
      body: tamperedBody,
      headers: {
        'wechatpay-signature': wxpayNotificationSignature(tamperedBody, timestamp, nonce),
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-serial': WXPAY_TEST_PLATFORM_SERIAL,
      },
    };
    await assert.rejects(
      provider.adapter.verifyWebhook({
        headers: tampered.headers,
        rawBody: tampered.body,
        merchantId: WXPAY_TEST_MCHID,
      }),
      /decryption failed/,
    );

    const foreignMerchant = signedNotification(paidTransaction({ mchid: '1900009999' }));
    await assert.rejects(
      provider.adapter.verifyWebhook({
        headers: foreignMerchant.headers,
        rawBody: foreignMerchant.body,
        merchantId: WXPAY_TEST_MCHID,
      }),
      /merchant mismatch/,
    );
  } finally {
    await wxpay.close();
  }
});

test('verifyWebhook serves a rotated certificate after a refresh when the serial is new', async () => {
  const wxpay = await startMockWxpay();
  try {
    wxpay.setHandler('certificates', () => ({
      json: wxpayCertificatesJson({
        certificatePem: WXPAY_TEST_PLATFORM_ALT_CERTIFICATE_PEM,
        serialNo: WXPAY_TEST_PLATFORM_ALT_SERIAL,
      }),
    }));
    const provider = createWxpayPaymentProvider(config(wxpay));
    const rotated = signedNotification(paidTransaction(), {
      platformPrivateKeyPem: WXPAY_TEST_PLATFORM_ALT_PRIVATE_KEY_PEM,
      serialNo: WXPAY_TEST_PLATFORM_ALT_SERIAL,
    });
    const verified = await provider.adapter.verifyWebhook({
      headers: rotated.headers,
      rawBody: rotated.body,
      merchantId: WXPAY_TEST_MCHID,
    });
    assert.equal(verified.providerKey, WXPAY_PROVIDER_KEY, 'a rotated platform certificate verifies after refresh');
  } finally {
    await wxpay.close();
  }
});

test('normalizeEvent maps trade states and keeps the double-anchored identity', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const verify = (rawBody: Buffer, headers: Record<string, string>) =>
      provider.adapter.verifyWebhook({ headers, rawBody, merchantId: WXPAY_TEST_MCHID });

    const succeeded = signedNotification(paidTransaction(), { createTime: '2026-10-12T01:23:45+08:00' });
    const event = provider.adapter.normalizeEvent(await verify(succeeded.body, succeeded.headers));
    assert.equal(event.status, 'succeeded');
    assert.equal(event.providerOrderId, LOCAL_ORDER_ID);
    assert.equal(event.providerEventId, `evt-${LOCAL_ORDER_ID}:${TRANSACTION_ID}`);
    assert.equal(event.eventType, 'TRANSACTION.SUCCESS');
    assert.equal(event.tenantId, TENANT_ID);
    assert.equal(event.merchantId, WXPAY_TEST_MCHID);
    assert.equal(event.amountMinorUnits, '1234');
    assert.equal(event.currency, 'CNY');
    assert.equal(new Date(event.occurredAt).toISOString(), '2026-10-11T17:23:45.000Z');

    for (const [tradeState, status] of [
      ['CLOSED', 'failed'],
      ['REVOKED', 'failed'],
      ['USERPAYING', 'pending'],
      ['NOTPAY', 'pending'],
      ['PAYERROR', 'pending'],
    ] as const) {
      const sample = signedNotification(paidTransaction({ tradeState, outTradeNo: `o-${tradeState.toLowerCase()}` }));
      const normalized = provider.adapter.normalizeEvent(await verify(sample.body, sample.headers));
      assert.equal(normalized.status, status, `${tradeState} maps onto ${status}`);
    }

    const noAttach = signedNotification(paidTransaction({ attach: null }));
    const orphan = provider.adapter.normalizeEvent(await verify(noAttach.body, noAttach.headers));
    assert.equal(orphan.tenantId, 'unresolved-tenant', 'a missing attach routes to reconciliation');

    assert.throws(() =>
      provider.adapter.normalizeEvent({
        providerKey: WXPAY_PROVIDER_KEY,
        merchantId: WXPAY_TEST_MCHID,
        payload: { notification: { id: 'evt-x', eventType: 'TRANSACTION.SUCCESS', createTime: null }, transaction: {} },
      }),
    );
  } finally {
    await wxpay.close();
  }
});

test('confirmEvent enforces the pre-fulfillment active-query red line', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const confirmEvent = provider.adapter.confirmEvent;
    assert.ok(confirmEvent);
    const input = (
      orderOverrides: Partial<PaymentProviderEventConfirmationInput['order']> = {},
      eventOverrides: Partial<PaymentProviderEventConfirmationInput['event']> = {},
    ): PaymentProviderEventConfirmationInput => ({
      event: {
        providerEventId: `evt-${LOCAL_ORDER_ID}:${TRANSACTION_ID}`,
        eventType: 'TRANSACTION.SUCCESS',
        providerOrderId: LOCAL_ORDER_ID,
        tenantId: TENANT_ID,
        merchantId: WXPAY_TEST_MCHID,
        status: 'succeeded',
        amountMinorUnits: '1234',
        currency: 'CNY',
        occurredAt: NOW,
        ...eventOverrides,
      },
      order: {
        localOrderId: LOCAL_ORDER_ID,
        tenantId: TENANT_ID,
        merchantId: WXPAY_TEST_MCHID,
        amountMinorUnits: '1234',
        currency: 'CNY',
        providerOrderId: LOCAL_ORDER_ID,
        ...orderOverrides,
      },
    });

    programSuccessQuery(wxpay);
    assert.deepEqual(await confirmEvent(input()), { confirmed: true });
    assert.equal(wxpay.calls.transactionsQuery[0]?.path, `/v3/pay/transactions/out-trade-no/${LOCAL_ORDER_ID}`);

    wxpay.setHandler('transactionsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'order not exists' },
    }));
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_ORDER_NOT_FOUND' });

    programSuccessQuery(wxpay, { tradeState: 'USERPAYING' });
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_TRADE_NOT_SUCCESS' });

    programSuccessQuery(wxpay, { mchid: '1900009999' });
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_MERCHANT_MISMATCH' });

    programSuccessQuery(wxpay, { outTradeNo: 'order-OTHER' });
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_ORDER_REF_MISMATCH' });

    programSuccessQuery(wxpay, { attach: 'tenant-2' });
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_TENANT_MISMATCH' });

    programSuccessQuery(wxpay, { total: 9999 });
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_AMOUNT_MISMATCH' });

    programSuccessQuery(wxpay);
    assert.deepEqual(await confirmEvent(input({}, { amountMinorUnits: '9999' })), {
      confirmed: false,
      code: 'WXPAY_AMOUNT_MISMATCH',
    });

    programSuccessQuery(wxpay, { currency: 'USD' });
    assert.deepEqual(await confirmEvent(input()), { confirmed: false, code: 'WXPAY_CURRENCY_MISMATCH' });

    assert.deepEqual(await confirmEvent(input({ currency: 'USD' })), {
      confirmed: false,
      code: 'WXPAY_CURRENCY_MISMATCH',
    });

    programSuccessQuery(wxpay);
    assert.deepEqual(await confirmEvent(input({}, { providerOrderId: 'order-OTHER' })), {
      confirmed: false,
      code: 'WXPAY_ORDER_REF_MISMATCH',
    });

    programSuccessQuery(wxpay, { transactionId: '4200000000000000000000009999' });
    assert.deepEqual(await confirmEvent(input()), {
      confirmed: false,
      code: 'WXPAY_TRANSACTION_MISMATCH',
    });

    wxpay.setHandler('transactionsQuery', () => ({ raw: '<html>down</html>', status: 502 }));
    await assert.rejects(confirmEvent(input()), (error: unknown) => {
      assert.ok(error instanceof WxpayProviderError && error.acceptance === 'unknown');
      return true;
    });
  } finally {
    await wxpay.close();
  }
});

test('recoverOrder queries by out_trade_no, answers null on a proven 404 and never creates', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const recoverOrder = provider.adapter.recoverOrder;
    assert.ok(recoverOrder);
    const recovery = (extra: Record<string, unknown> = {}) => ({
      localOrderId: LOCAL_ORDER_ID,
      tenantId: TENANT_ID,
      amountMinorUnits: '1234',
      currency: 'CNY',
      merchantId: WXPAY_TEST_MCHID,
      idempotencyReference: LOCAL_ORDER_ID,
      ...extra,
    });

    wxpay.setHandler('transactionsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'order not exists' },
    }));
    assert.equal(await recoverOrder(recovery()), null);
    assert.equal(wxpay.calls.transactionsNativeCreate.length, 0, 'recovery never submits a create');

    programSuccessQuery(wxpay, { tradeState: 'USERPAYING' });
    const recovered = await recoverOrder(recovery());
    assert.deepEqual(recovered, { providerOrderId: LOCAL_ORDER_ID, amountMinorUnits: '1234', currency: 'CNY' });
    assert.equal(wxpay.calls.transactionsNativeCreate.length, 0);

    programSuccessQuery(wxpay, { attach: 'tenant-2' });
    await assert.rejects(
      recoverOrder(recovery()),
      (error: unknown) => error instanceof WxpayProviderError && error.acceptance === 'unknown',
    );

    programSuccessQuery(wxpay, { mchid: '1900009999' });
    await assert.rejects(
      recoverOrder(recovery()),
      (error: unknown) => error instanceof WxpayProviderError && error.acceptance === 'unknown',
    );

    wxpay.setHandler('transactionsQuery', () => ({ raw: 'down', status: 500 }));
    await assert.rejects(
      recoverOrder(recovery()),
      (error: unknown) => error instanceof WxpayProviderError && error.acceptance === 'unknown',
    );

    const callsBefore = wxpay.calls.transactionsQuery.length;
    for (const bad of [recovery({ merchantId: '1900009999' }), recovery({ idempotencyReference: 'other' })]) {
      await assert.rejects(
        recoverOrder(bad),
        (error: unknown) => error instanceof WxpayProviderError && error.acceptance === 'unknown',
      );
    }
    assert.equal(wxpay.calls.transactionsQuery.length, callsBefore, 'identity failures never reach the provider');
  } finally {
    await wxpay.close();
  }
});

test('submitRefund looks up the order total, posts out_refund_no idempotency and maps the acceptance tri-state', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    wxpay.setHandler('transactionsQuery', () => ({
      json: wxpayTransactionJson(paidTransaction({ total: 1234 })),
    }));
    wxpay.setHandler('refundsCreate', (call) => {
      const body = call.json as Record<string, unknown>;
      const amount = body.amount as Record<string, unknown>;
      return {
        json: wxpayRefundJson({
          outRefundNo: String(body.out_refund_no),
          outTradeNo: String(body.out_trade_no),
          status: 'PROCESSING',
          refund: Number(amount.refund),
          total: Number(amount.total),
        }),
      };
    });
    const submitted = await provider.refundAdapter.submitRefund(refundInput());
    assert.equal(submitted.status, 'pending');
    assert.equal(submitted.localRefundId, 'refund-1');
    assert.ok(submitted.providerRefundId);
    const [sent] = wxpay.calls.refundsCreate;
    assert.ok(sent);
    assert.match(sent.rawBody, /"out_refund_no":"refund-1"/, 'out_refund_no carries the local refund id');
    assert.match(sent.rawBody, /"out_trade_no":"order-local-1"/);
    assert.match(sent.rawBody, /"refund":400/, 'the refund fen amount is a raw integer token');
    assert.match(sent.rawBody, /"total":1234/, 'the order total is sourced from the active query, never the caller');
    assert.equal(wxpay.calls.transactionsQuery.length, 1, 'the refund required the order-total lookup');

    for (const [upstream, mapped] of [
      ['SUCCESS', 'succeeded'],
      ['PROCESSING', 'pending'],
      ['CLOSED', 'failed'],
      ['ABNORMAL', 'failed'],
    ] as const) {
      wxpay.setHandler('refundsCreate', () => ({
        json: wxpayRefundJson({ outRefundNo: 'refund-1', outTradeNo: LOCAL_ORDER_ID, status: upstream, refund: 400 }),
      }));
      assert.equal((await provider.refundAdapter.submitRefund(refundInput())).status, mapped);
    }

    wxpay.setHandler('refundsCreate', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'order not exists' },
    }));
    const notAccepted = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(notAccepted instanceof WxpayProviderError && notAccepted.acceptance === 'not_accepted');

    wxpay.setHandler('refundsCreate', () => ({
      status: 400,
      json: { code: 'FREQUENCY_LIMIT_EXCEED', message: 'too many refunds' },
    }));
    const ambiguous = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(ambiguous instanceof WxpayProviderError && ambiguous.acceptance === 'unknown');

    wxpay.setHandler('refundsCreate', () => ({ raw: '<html>proxy error</html>', status: 502 }));
    const transport = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(transport instanceof WxpayProviderError && transport.acceptance === 'unknown');

    wxpay.setHandler('transactionsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'order not exists' },
    }));
    const noOrder = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(
      noOrder instanceof WxpayProviderError && noOrder.acceptance === 'not_accepted',
      'a proven-missing original order means the refund was definitively not accepted',
    );
    const refundCallsBefore = wxpay.calls.refundsCreate.length;
    for (const bad of [
      refundInput({ providerKey: 'stripe' }),
      refundInput({ merchantId: '1900009999' }),
      refundInput({ idempotencyReference: 'other' }),
      refundInput({ currency: 'USD' }),
    ]) {
      const failure = await provider.refundAdapter.submitRefund(bad).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof WxpayProviderError && failure.acceptance === 'unknown');
    }
    assert.equal(wxpay.calls.refundsCreate.length, refundCallsBefore, 'identity failures never reach the provider');
  } finally {
    await wxpay.close();
  }
});

test('queryRefund retrieves the real tri-state by out_refund_no, maps 404 to not_found and never fabricates', async () => {
  const wxpay = await startMockWxpay();
  try {
    const provider = createWxpayPaymentProvider(config(wxpay));
    const query = (overrides: Record<string, unknown> = {}) =>
      provider.refundAdapter.queryRefund(refundInput({ providerRefundId: '5030refund-1', ...overrides }));

    wxpay.setHandler('refundsQuery', () => ({
      json: wxpayRefundJson({ outRefundNo: 'refund-1', outTradeNo: LOCAL_ORDER_ID, status: 'SUCCESS', refund: 400 }),
    }));
    const succeeded = await query();
    assert.equal(succeeded.status, 'succeeded');
    assert.equal(wxpay.calls.refundsQuery[0]?.path, '/v3/refund/domestic/refunds/refund-1');

    for (const [upstream, mapped] of [
      ['PROCESSING', 'pending'],
      ['CLOSED', 'failed'],
      ['ABNORMAL', 'failed'],
    ] as const) {
      wxpay.setHandler('refundsQuery', () => ({
        json: wxpayRefundJson({ outRefundNo: 'refund-1', outTradeNo: LOCAL_ORDER_ID, status: upstream, refund: 400 }),
      }));
      assert.equal((await query()).status, mapped);
    }

    wxpay.setHandler('refundsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'refund not exists' },
    }));
    assert.equal((await query()).status, 'not_found');

    wxpay.setHandler('refundsQuery', () => ({
      json: wxpayRefundJson({ outRefundNo: 'refund-1', outTradeNo: 'order-OTHER', status: 'SUCCESS', refund: 400 }),
    }));
    assert.equal((await query()).status, 'unknown', 'an out_trade_no mismatch is never a verdict');

    wxpay.setHandler('refundsQuery', () => ({
      json: wxpayRefundJson({ outRefundNo: 'refund-1', outTradeNo: LOCAL_ORDER_ID, status: 'SUCCESS', refund: 9999 }),
    }));
    assert.equal((await query()).status, 'unknown', 'an amount mismatch is never a verdict');

    wxpay.setHandler('refundsQuery', () => ({
      json: wxpayRefundJson({
        outRefundNo: 'refund-OTHER',
        outTradeNo: LOCAL_ORDER_ID,
        status: 'SUCCESS',
        refund: 400,
      }),
    }));
    assert.equal((await query()).status, 'unknown', 'an out_refund_no mismatch is never a verdict');

    wxpay.setHandler('refundsQuery', () => ({ raw: 'down', status: 500 }));
    assert.equal((await query()).status, 'unknown');

    const unreachable = createWxpayPaymentProvider(config({ url: 'http://127.0.0.1:1' } as MockWxpay));
    assert.equal(
      (await unreachable.refundAdapter.queryRefund(refundInput({ providerRefundId: 'x' }))).status,
      'unknown',
      'a transport failure answers unknown instead of throwing the worker off course',
    );

    const callsBefore = wxpay.calls.refundsQuery.length;
    assert.equal((await query({ providerKey: 'stripe' })).status, 'unknown');
    assert.equal((await query({ merchantId: '1900009999' })).status, 'unknown');
    assert.equal((await query({ idempotencyReference: 'other' })).status, 'unknown');
    assert.equal(wxpay.calls.refundsQuery.length, callsBefore, 'identity mismatches never query the provider');
  } finally {
    await wxpay.close();
  }
});

test('upstream error text never leaks the apiV3Key', async () => {
  const wxpay = await startMockWxpay();
  try {
    wxpay.setHandler('transactionsNativeCreate', () => ({
      status: 400,
      json: { code: 'PARAM_ERROR', message: `echoed ${WXPAY_TEST_APIV3_KEY} verbatim` },
    }));
    wxpay.setHandler('transactionsQuery', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: 'x' },
    }));
    const provider = createWxpayPaymentProvider(config(wxpay));
    const failure = await provider.adapter.createOrder(createOrderInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof WxpayProviderError);
    assert.equal(failure.message.includes(WXPAY_TEST_APIV3_KEY), false);
    assert.match(failure.message, /\*\*\*/);

    wxpay.setHandler('transactionsQuery', () => ({
      json: wxpayTransactionJson(paidTransaction({ total: 1234 })),
    }));
    wxpay.setHandler('refundsCreate', () => ({
      status: 404,
      json: { code: 'RESOURCE_NOT_EXISTS', message: `no such order ${WXPAY_TEST_APIV3_KEY}` },
    }));
    const refundFailure = await provider.refundAdapter.submitRefund(refundInput()).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(refundFailure instanceof WxpayProviderError);
    assert.equal(refundFailure.message.includes(WXPAY_TEST_APIV3_KEY), false);
  } finally {
    await wxpay.close();
  }
});
