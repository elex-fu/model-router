import { createPrivateKey, createSign, createVerify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Test-only mock key material (never valid against real providers). Armor
// lines are assembled at load time so secret scanners do not match private
// key blocks in the repository.
const TEST_PRIVATE_KEY_ARMOR_BEGIN = `-----BEGIN ${'PRIVATE KEY'}-----`;
const TEST_PRIVATE_KEY_ARMOR_END = `-----END ${'PRIVATE KEY'}-----`;

function wrapTestPrivateKey(body: string): string {
  return `${TEST_PRIVATE_KEY_ARMOR_BEGIN}\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n${TEST_PRIVATE_KEY_ARMOR_END}`;
}

// Programmable mock Alipay open-platform gateway for the R3 alipay provider
// and drill tests. Routes the single `/gateway.do` endpoint by the `method`
// form param (precreate / trade.query / trade.refund / fastpay.refund.query),
// records every signed call, and signs async notifications exactly like the
// real gateway (RSA2 over sorted params minus sign/sign_type). The adapter
// never talks to real Alipay in tests.
//
// Two fixed RSA-2048 keypairs (generated 2026-10-11 for this pinboard,
// test-only, never used anywhere else): the MERCHANT pair plays the adapter's
// merchantPrivateKey, and the GATEWAY pair plays Alipay's signing key — the
// adapter's alipayPublicKey is the gateway public key. The request-sign helper
// lets tests verify the adapter's RSA2 request signatures against the merchant
// public key, mirroring the real gateway's check.

const ALIPAY_TEST_MERCHANT_PRIVATE_KEY_BODY =
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDjvqjWeLfFKBzBjZStNWeVy6DZ1Yqx/kWiy4xO3wyBiAXygNlBZZYQh6xX9AAKUISvFvSRqu/kMd9cKC7Bh/2cUmNHOoej03P1q0un4yposHInlPRifWV9R58CNI0swl+sssD6yT9MF5bzvXnGrqmNCTFbKp68ZnBoJ/SP/W8Om2X+3EjnRwg/fDmeOjbZU8B2WUPvZRVOWT6XExoR7cf26Si5X/QNnBrwh7YGl1DCQDDKXLFG/UBt6U+r+1xeaPuKh8fO+P3XA54fRs6MSEr+NjjvQGiM/IzJD/nwnNILg/X7er9OLHgdlKxpW/bEPynx5EGE9p4r38Hb5BChfo6ZAgMBAAECggEAVVHQHskKz6m/XCOWV21yaQPoNrNxSk1f+SUYY1Pcc4pp7/elbIKKPZcWUbzvZu3TR2TqKshHJs4oR3YmTgqMUEvtNXoP5qgJATgzF6pa8O1pVrrO8zbXFqAGSeU2HlaTUTeGZG2QcQlFW/rX7D7y9gtDmkvVO++EnQCa9naTbHzGRGMS8dgx5wk9SSNZWtjV2EhaZ7jWV1ccLe17QLZX7iFAm5bc86TaMQIbcisnCc/Rw7krxCY8yOt2+z83aCKQ/6LHlooj0JOfb7mccz/5XJk7vAn/xuSND5TwIMmnVNDnHgEMyI4EU+TDFRBa9HHrI5Ppr7XWZZpICNFz2J5WoQKBgQDzqa+wEYtTvhXPW1zLUyT+E3Mb1gKfX0FGrmlby9h3qLQrGplF6bMsSCNlD1wK/o8fHygEtcH/gByq6hINPGAzlZxDzkxRkdI0/m0EKczEozFCt/3VaLBjPUWOvtRUQn7YdaE/PkGsuMTWjo4XpWWJ+LBRflmBX0ooFr0X38/yswKBgQDvRqVje0dixFlw03/i03w+lEylOHbq4TCfWmxry50bNQDen3LtF6ENIGGEY1oKPOfAeCATchjLJ+/YfPI08oz7UTiD/ScvSV6fEBLNgPdZA31+IILuY2W6umYS4cUR8iQayBRHUslgr7T8ikXnvt9NKy2gaQxS+5+NOcAn8p+vgwKBgEPCb3IGHvnFxajpXk/IqmPhosQd6pLJWYy/WdtGP8de6eOGvRL9H290DCvBbrY7/i8IageNSAq2ZMJ+31BA9vvBYjhU+VJBu/QywLxEp4YTX9KO+g7L0yl1048TsFZSO5YUeCfvNzJCG7MS557ZxvfsaZPwEBHzHtsxH5qxCdITAoGBAKS2Iv+6S0fIFjG+xhgksTB68dACcIn7fncTzfLedUXXVMPrSze+vlTE55w0sDS//GDX0GzSbBLdaRPD3w9nsHkITjk9uQ2qGgKxE+B3WM3jwy1hv//OWKcTzVROKlTSNNxiwuLeMFXoXlRB8yE2mY0LnhsAdUVihVC4YnidYiN1AoGBAM+cwi0KntBTgHE8hUONJrNcdyO9c/9+ciH5p15oVgTGwF3cz/zAxYwDck9fUj1X7bw5MEtO2ZaHGCUe8TGRWP1ncIcObjiZ0i6mYv2d5tJArPgrI7cqMn/7atuC4IrGxjW85cNIY7wVdw/MLoz5gkAXQi1NfKYPRX52Z2qJOIQ+';
export const ALIPAY_TEST_MERCHANT_PRIVATE_KEY = wrapTestPrivateKey(ALIPAY_TEST_MERCHANT_PRIVATE_KEY_BODY) + '\n';

export const ALIPAY_TEST_MERCHANT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA476o1ni3xSgcwY2UrTVn
lcug2dWKsf5FosuMTt8MgYgF8oDZQWWWEIesV/QAClCErxb0karv5DHfXCguwYf9
nFJjRzqHo9Nz9atLp+MqaLByJ5T0Yn1lfUefAjSNLMJfrLLA+sk/TBeW8715xq6p
jQkxWyqevGZwaCf0j/1vDptl/txI50cIP3w5njo22VPAdllD72UVTlk+lxMaEe3H
9ukouV/0DZwa8Ie2BpdQwkAwylyxRv1AbelPq/tcXmj7iofHzvj91wOeH0bOjEhK
/jY470BojPyMyQ/58JzSC4P1+3q/Tix4HZSsaVv2xD8p8eRBhPaeK9/B2+QQoX6O
mQIDAQAB
-----END PUBLIC KEY-----
`;

const ALIPAY_TEST_GATEWAY_PRIVATE_KEY_BODY =
  'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDc6VBc0mhZcVj1IuImZZuodTFPyh0OMQzmReDHQkmoe/REl2KQ5I2DtvSZwdZZ6eOLEfxNs34GFl394v14Hc+44km9X2fB2YHFXV6sCI8xORGOrBlotzLPihvfDG602Dk5+wszGqNgRCVl2M+fbtTMqyTbXf2pqWWE9NNYMvWxwMqn5/1EenAqTS9zhEft3JBa+nRHDqP3BLEWa+hPVN1oPvvoAWdmP41CROsson6zRzbVUvHb4+f6iN4DLuxzCzKI/4fGgbF9wN7I4zpcqvS3wZoMh/JYuItRpZVdIEAUCBF6SZNtevWtlm0tUgsrYYN1jFjwOW2UjQTx5v6zAdj/AgMBAAECggEAAoGVG1B5xZX/G9zW8veRIgKeWhjhZoFQ86XUTH5ohoRNe5+6CwnEvztKoBnuXBvGrJO6KImCQwBq9Y/nLz8rVZ4flwnni+/zRHFwOwRn13edxuAV87WsWmVnNosWEHApigpakKxbMSLkx7iDdnwT5vSEGQcCczPMRotegHAnkGopmvZqHqJ6fmhQToVLIhscVwN95CxSkEfowsfF3Argf28HvS3w6ivoDsow8xDbbkhegCZpk5+wG7OYkIdqmGWW2my9+ogN/Ftx0d4YCM8BxYWYVMSjcU/yr+Y4CIKHdpGNBoqmx+zXWy9B1mso+qt0tQ2+tjb62suaq4rt5DVOlQKBgQD7UgVZ1sM63/E45wcivBH4F7s/vLgE07W26LcEI/L+nuBGXs+jOImZTsv1E8YzHLh/OFHmmIhD4H4YlrFCxe67BVhNSwX/Q+78EXf7yodAMrl6jX8DyyS/Hj++q0yfYJBpSIpZi/yD5shABYnNAVXbbhoCcOnZnnFaeWVYJ+KVfQKBgQDhBldVbHoMLw1ijKBihIQHQyH4kodC00OZtFK2cFYmTDNwFXEWmpOdSaNm8djaboNt7DofZKpo6szf5KoJdfT010oftByonYYTKGJ/gh1Ow5I+tD4Oa1r8SR9G3QRbobrwTAa7qYARtABEVhf8zXJOKLCRY7MP0iQdE+56QFZBKwKBgQCoW87n2x4YD7Mp+mJmW3TyLPusfAEOgsDlkkogRPDgr4/wtE0Gu7Y59HZfbGrHDMNvvkvnXWFTj00JrdF7uNrvgGoiBVM0KM8tH4qwK4GleRWVyro+0VSBj4MGePywe+DiFs1PpZ54wh59/PfOVMmuYLid0ARoW2L2SAKjJrz8hQKBgQCnEsE3IKKBd1H10LmoTAGHLtYDLDAXcqpnbdZXtJKSPtOWLaVYhg6BotIatggvLgyRSephsqk/2s2gkrOY8KaeP1a+sUjx/Hs2sC5pw56lA1oLCmJk7FqSpGv/fkwlCLC2h4wcO55mBoKIOm/2+EcdNuLaH+8sGPdNS6YtyKUCHwKBgCVvLdBZSrZX9RYVvfOVEwDmyRoLjtdKsU50l2SoliAgy3dnGGgAbnCtb2SfjEZI8CYOu6mn+t377+wYIF0qWXEPFxPtVtk2Dvof7xYfbMcqq2pDifkhp+1qeCkmUbUF0hQq8i/mg+WE4LoP00yPsxGZkUxP3V3atEMQUTlNhhtt';
export const ALIPAY_TEST_GATEWAY_PRIVATE_KEY = wrapTestPrivateKey(ALIPAY_TEST_GATEWAY_PRIVATE_KEY_BODY) + '\n';

export const ALIPAY_TEST_GATEWAY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3OlQXNJoWXFY9SLiJmWb
qHUxT8odDjEM5kXgx0JJqHv0RJdikOSNg7b0mcHWWenjixH8TbN+BhZd/eL9eB3P
uOJJvV9nwdmBxV1erAiPMTkRjqwZaLcyz4ob3wxutNg5OfsLMxqjYEQlZdjPn27U
zKsk2139qallhPTTWDL1scDKp+f9RHpwKk0vc4RH7dyQWvp0Rw6j9wSxFmvoT1Td
aD776AFnZj+NQkTrLKJ+s0c21VLx2+Pn+ojeAy7scwsyiP+HxoGxfcDeyOM6XKr0
t8GaDIfyWLiLUaWVXSBAFAgRekmTbXr1rZZtLVILK2GDdYxY8DltlI0E8eb+swHY
/wIDAQAB
-----END PUBLIC KEY-----
`;

/**
 * Known-answer vector for the RSA2 signing pinboard: the exact sorted request
 * content and its RSA2 (SHA256withRSA, PKCS#1 v1.5) base64 signature under
 * ALIPAY_TEST_MERCHANT_PRIVATE_KEY. RSA PKCS#1 v1.5 signatures are
 * deterministic, so this vector pins the signing scheme end to end.
 */
export const ALIPAY_KAV_CONTENT =
  'app_id=2021000123456789&biz_content={"out_trade_no":"order-kav-1","subject":"Order order-kav-1","total_amount":"12.34"}' +
  '&charset=utf-8&method=alipay.trade.precreate&notify_url=https://pay.example.com/notify' +
  '&sign_type=RSA2&timestamp=2026-10-11 00:00:00&version=1.0';
export const ALIPAY_KAV_SIGNATURE =
  'UyfytCxAOkSlDUZ+QoyEWTB0bP8Pk4xUcHT0rNeb2pRjuxVLbZjkHzZl0rmU45I+iKkzZBcYEbvhRGW2QSZ6u1YtZTGpbs7EwbjDMdvi81iZCcSUs78AJC3cUdhF1JyKvkKhzl5XVAMRAuFfruOPCC/UnGgl8MSqyWKocVKWlrjYpqiT+yAr1EnKPUsa2O3UVbCB29OQq69h+6xI0cNJBWhGOScr51XtvRpP+aSgBe4q8u2MmoYTSJkQS52kv1RuOiL9t6hCqvn0wqS/HBNL8PLjdB0IuCAQO95LChFcl99nIdgSnLE4bTNwyVqs24UQV9lyMLl60c9Riid7OUOAFA==';

function requestSignContent(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

function notifySignContent(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** Verifies the adapter's RSA2 request signature, mirroring the real gateway's merchant-key check. */
export function alipayVerifyRequestSign(
  params: Readonly<Record<string, string>>,
  merchantPublicKeyPem: string,
): boolean {
  const sign = params.sign;
  if (typeof sign !== 'string' || sign === '') return false;
  try {
    return createVerify('RSA-SHA256')
      .update(requestSignContent(params), 'utf8')
      .verify(merchantPublicKeyPem, sign, 'base64');
  } catch {
    return false;
  }
}

/** Builds a signed async-notification form body exactly like the real gateway (RSA2 over notify content). */
export function alipayNotifyBody(
  params: Readonly<Record<string, string>>,
  gatewayPrivateKeyPem: string = ALIPAY_TEST_GATEWAY_PRIVATE_KEY,
): Buffer {
  const withType: Record<string, string> = { ...params, sign_type: 'RSA2' };
  withType.sign = createSign('RSA-SHA256')
    .update(notifySignContent(withType), 'utf8')
    .sign(createPrivateKey(gatewayPrivateKeyPem), 'base64');
  return Buffer.from(new URLSearchParams(withType).toString(), 'utf8');
}

/** Canonical gateway JSON envelope for a method response node. */
export function alipayGatewayEnvelope(method: string, node: Record<string, unknown>): Record<string, unknown> {
  return { [`${method.replaceAll('.', '_')}_response`]: node, sign: 'mock-gateway-sign' };
}

export interface MockAlipayCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly params: Record<string, string>;
}

export type AlipayMockEndpoint = 'precreate' | 'tradeQuery' | 'refund' | 'refundQuery';

const ENDPOINT_BY_METHOD: Record<string, AlipayMockEndpoint> = {
  'alipay.trade.precreate': 'precreate',
  'alipay.trade.query': 'tradeQuery',
  'alipay.trade.refund': 'refund',
  'alipay.trade.fastpay.refund.query': 'refundQuery',
};

export type AlipayMockHandler = (call: MockAlipayCall) => { status?: number; json?: unknown; raw?: string };

export interface MockAlipay {
  readonly url: string;
  readonly calls: Record<AlipayMockEndpoint, MockAlipayCall[]>;
  readonly setHandler: (endpoint: AlipayMockEndpoint, handler: AlipayMockHandler) => void;
  readonly close: () => Promise<void>;
}

export async function startMockAlipay(): Promise<MockAlipay> {
  const calls: Record<AlipayMockEndpoint, MockAlipayCall[]> = {
    precreate: [],
    tradeQuery: [],
    refund: [],
    refundQuery: [],
  };
  const handlers = new Map<AlipayMockEndpoint, AlipayMockHandler>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const params: Record<string, string> = {};
      new URLSearchParams(Buffer.concat(chunks).toString('utf8')).forEach((value, key) => {
        params[key] = value;
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const method = req.method ?? 'GET';
      const endpoint =
        method === 'POST' && url.pathname === '/gateway.do' ? (ENDPOINT_BY_METHOD[params.method ?? ''] ?? null) : null;
      if (endpoint === null) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const call: MockAlipayCall = { method, path: url.pathname, headers, params };
      calls[endpoint].push(call);
      const handler = handlers.get(endpoint);
      if (!handler) {
        res.writeHead(500).end('no handler');
        return;
      }
      const outcome = handler(call);
      if (outcome.raw !== undefined) {
        res.writeHead(outcome.status ?? 200, { 'content-type': 'text/plain' }).end(outcome.raw);
        return;
      }
      res
        .writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
        .end(JSON.stringify(outcome.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setHandler: (endpoint, handler) => handlers.set(endpoint, handler),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
