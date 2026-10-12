import {
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  type KeyObject,
  timingSafeEqual,
} from 'node:crypto';

// Alipay (支付宝) open-platform protocol primitives for the R3 adapter review
// checklist: RSA2 (SHA256withRSA, PKCS#1 v1.5) request signing and async
// notification verification, strict fixed-point money (yuan decimal strings ↔
// minor units, no float ever enters the path), canonical biz_content JSON and
// fail-closed merchant configuration. Only the server-direct creation mode
// `alipay.trade.precreate` is supported — popup/pagepay/wappay hand the
// creation to the buyer's browser, so no synchronous server response exists
// and the acceptance tri-state / same-order recovery red line (EasyPay
// mapi-only analogue) cannot hold; those modes fail closed at the config layer.
//
// Key custody: both PEMs are parsed ONCE here into frozen KeyObjects. The raw
// merchant private key material is never retained, never logged and never
// leaves this module's config boundary (the provider only sees KeyObjects).

export const ALIPAY_PROVIDER_KEY = 'alipay' as const;
export const ALIPAY_DEFAULT_GATEWAY = 'https://openapi.alipay.com' as const;
export const ALIPAY_GATEWAY_PATH = '/gateway.do' as const;
export const ALIPAY_DEFAULT_CURRENCY = 'CNY' as const;
export const ALIPAY_SIGN_TYPE = 'RSA2' as const;
export const ALIPAY_API_VERSION = '1.0' as const;
export const ALIPAY_CHARSET = 'utf-8' as const;

export const ALIPAY_METHOD_PRECREATE = 'alipay.trade.precreate' as const;
export const ALIPAY_METHOD_QUERY = 'alipay.trade.query' as const;
export const ALIPAY_METHOD_REFUND = 'alipay.trade.refund' as const;
export const ALIPAY_METHOD_REFUND_QUERY = 'alipay.trade.fastpay.refund.query' as const;

export const ALIPAY_CODE_SUCCESS = '10000' as const;
export const ALIPAY_SUB_CODE_TRADE_NOT_EXIST = 'ACQ.TRADE_NOT_EXIST' as const;
export const ALIPAY_SUB_CODE_REFUND_NOT_EXIST = 'ACQ.REFUND_NOT_EXIST' as const;

export const ALIPAY_TRADE_SUCCESS = 'TRADE_SUCCESS' as const;
export const ALIPAY_TRADE_FINISHED = 'TRADE_FINISHED' as const;
export const ALIPAY_TRADE_CLOSED = 'TRADE_CLOSED' as const;
export const ALIPAY_WAIT_BUYER_PAY = 'WAIT_BUYER_PAY' as const;

export const ALIPAY_REFUND_STATUS_SUCCESS = 'REFUND_SUCCESS' as const;
export const ALIPAY_FUND_CHANGE_YES = 'Y' as const;

const MAX_CONFIG_TEXT_BYTES = 1024;
const MAX_PEM_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const YUAN_PATTERN = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,2})?$/;
const APP_ID_PATTERN = /^[0-9]{10,20}$/;
const SELLER_ID_PATTERN = /^[0-9]{1,32}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MIN_RSA_MODULUS_BITS = 2048;

export class AlipayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlipayConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function configurationInvalid(message: string): never {
  throw new AlipayConfigurationError(message);
}

function requiredText(value: unknown, label: string, maxBytes = MAX_CONFIG_TEXT_BYTES): string {
  if (typeof value !== 'string') configurationInvalid(`alipay ${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > maxBytes || trimmed.includes(' ')) {
    configurationInvalid(`alipay ${label} is invalid`);
  }
  return trimmed;
}

function keyedText(value: unknown, label: string, pattern: RegExp): string {
  const text = requiredText(value, label);
  if (!pattern.test(text)) configurationInvalid(`alipay ${label} is invalid`);
  return text;
}

/**
 * Absolute http(s) gateway base URL; https is mandatory outside loopback. A
 * trailing `/gateway.do` and trailing slashes are stripped so the provider can
 * append the single fixed gateway path. Userinfo, query and hash fail closed.
 */
export function normalizeAlipayGateway(value: unknown): string {
  const raw = value === undefined ? ALIPAY_DEFAULT_GATEWAY : requiredText(value, 'gateway');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    configurationInvalid('alipay gateway must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    configurationInvalid('alipay gateway requires https outside loopback');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    configurationInvalid('alipay gateway is invalid');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith(ALIPAY_GATEWAY_PATH)) {
    path = path.slice(0, path.length - ALIPAY_GATEWAY_PATH.length).replace(/\/+$/, '');
  }
  if (path !== '') configurationInvalid('alipay gateway must not carry a path');
  return `${parsed.protocol}//${parsed.host}`;
}

/** Absolute callback URL (notify/return); https is mandatory outside loopback. */
function normalizeCallbackUrl(value: unknown, label: string): string {
  const raw = requiredText(value, label, 512);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    configurationInvalid(`alipay ${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    configurationInvalid(`alipay ${label} requires https outside loopback`);
  }
  if (parsed.username !== '' || parsed.password !== '') configurationInvalid(`alipay ${label} is invalid`);
  return parsed.toString();
}

function assertRsaKey(key: KeyObject, label: string, expect: 'private' | 'public'): KeyObject {
  if (key.type !== expect || key.asymmetricKeyType !== 'rsa') {
    configurationInvalid(`alipay ${label} must be an RSA ${expect} key`);
  }
  const modulus = key.asymmetricKeyDetails?.modulusLength;
  if (typeof modulus !== 'number' || modulus < MIN_RSA_MODULUS_BITS) {
    configurationInvalid(`alipay ${label} must be at least ${MIN_RSA_MODULUS_BITS} bits`);
  }
  return key;
}

/**
 * Parses the merchant RSA2 private key. Only PKCS#8 PEM (`BEGIN PRIVATE KEY`)
 * is accepted — the PKCS#1 (`BEGIN RSA PRIVATE KEY`) form fails closed so key
 * provenance stays unambiguous. Returns a KeyObject; the PEM text is dropped.
 */
export function parseAlipayMerchantPrivateKey(value: unknown): KeyObject {
  if (typeof value !== 'string') configurationInvalid('alipay merchantPrivateKey is required');
  const pem = value.trim();
  if (pem.length === 0 || Buffer.byteLength(pem, 'utf8') > MAX_PEM_BYTES) {
    configurationInvalid('alipay merchantPrivateKey is invalid');
  }
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    configurationInvalid('alipay merchantPrivateKey must be PKCS#8 PEM, not PKCS#1');
  }
  if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+-----END PRIVATE KEY-----\s*$/.test(pem)) {
    configurationInvalid('alipay merchantPrivateKey must be PKCS#8 PEM');
  }
  try {
    return assertRsaKey(createPrivateKey(pem), 'merchantPrivateKey', 'private');
  } catch (error) {
    if (error instanceof AlipayConfigurationError) throw error;
    configurationInvalid('alipay merchantPrivateKey is not a parseable PKCS#8 RSA key');
  }
}

/** Parses the Alipay RSA2 public key (SPKI `BEGIN PUBLIC KEY` PEM). */
export function parseAlipayPublicKey(value: unknown): KeyObject {
  if (typeof value !== 'string') configurationInvalid('alipay alipayPublicKey is required');
  const pem = value.trim();
  if (pem.length === 0 || Buffer.byteLength(pem, 'utf8') > MAX_PEM_BYTES) {
    configurationInvalid('alipay alipayPublicKey is invalid');
  }
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+-----END PUBLIC KEY-----\s*$/.test(pem)) {
    configurationInvalid('alipay alipayPublicKey must be SPKI PEM');
  }
  try {
    return assertRsaKey(createPublicKey(pem), 'alipayPublicKey', 'public');
  } catch (error) {
    if (error instanceof AlipayConfigurationError) throw error;
    configurationInvalid('alipay alipayPublicKey is not a parseable SPKI RSA key');
  }
}

/** Only the server-direct precreate mode preserves the acceptance tri-state and recovery red line. */
function parseCreateMethod(value: unknown): typeof ALIPAY_METHOD_PRECREATE {
  if (value === undefined) return ALIPAY_METHOD_PRECREATE;
  const raw = requiredText(value, 'createMethod', 128).toLowerCase();
  if (raw === 'precreate' || raw === ALIPAY_METHOD_PRECREATE) return ALIPAY_METHOD_PRECREATE;
  if (
    ['popup', 'pagepay', 'page_pay', 'wappay', 'wap_pay', 'alipay.trade.page.pay', 'alipay.trade.wap.pay'].includes(raw)
  ) {
    configurationInvalid(
      'alipay createMethod popup/pagepay/wappay is unsupported: only server-direct precreate preserves order recovery',
    );
  }
  configurationInvalid('alipay createMethod is invalid');
}

export interface AlipayMerchantConfig {
  readonly appId: string;
  /** Alipay merchant UID (2088…); checked against every async notification. */
  readonly sellerId: string;
  /** Frozen KeyObject parsed once at config time; the only signing identity. Never logged, never serialized. */
  readonly merchantPrivateKey: KeyObject;
  /**
   * The source PEM, retained solely so error summaries can redact an
   * adversarial upstream echo (Stripe-secret analogue). It is never used for
   * signing, never returned and never included in any message.
   */
  readonly merchantPrivateKeyPem: string;
  /** Frozen KeyObject for notification RSA2 verification. */
  readonly alipayPublicKey: KeyObject;
  readonly gateway: string;
  readonly notifyUrl: string;
  readonly returnUrl: string;
  readonly createMethod: typeof ALIPAY_METHOD_PRECREATE;
  /** Settlement currency is fixed CNY. */
  readonly currency: typeof ALIPAY_DEFAULT_CURRENCY;
}

export interface AlipayProviderOptions extends AlipayMerchantConfig {
  readonly checkoutTtlMs: number;
  readonly requestTimeoutMs: number;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
}

export interface AlipayProviderConfigInput {
  readonly appId?: unknown;
  readonly sellerId?: unknown;
  readonly merchantPrivateKey?: unknown;
  readonly alipayPublicKey?: unknown;
  readonly gateway?: unknown;
  readonly notifyUrl?: unknown;
  readonly returnUrl?: unknown;
  /** Only `precreate` is supported; popup/pagepay/wappay fail closed. */
  readonly createMethod?: unknown;
  /** Settlement currency; only `CNY` is accepted. */
  readonly currency?: unknown;
  readonly checkoutTtlMs?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

function optionalPositiveInt(value: unknown, label: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    configurationInvalid(`alipay ${label} is invalid`);
  }
  return value;
}

export function parseAlipayProviderConfig(input: AlipayProviderConfigInput): AlipayProviderOptions {
  if (!input || typeof input !== 'object') configurationInvalid('alipay configuration is required');
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') configurationInvalid('alipay fetch implementation is unavailable');
  const currency = input.currency === undefined ? ALIPAY_DEFAULT_CURRENCY : requiredText(input.currency, 'currency');
  if (currency !== ALIPAY_DEFAULT_CURRENCY) {
    configurationInvalid('alipay currency is fixed to CNY');
  }
  const merchantPrivateKey = parseAlipayMerchantPrivateKey(input.merchantPrivateKey);
  return Object.freeze({
    appId: keyedText(input.appId, 'appId', APP_ID_PATTERN),
    sellerId: keyedText(input.sellerId, 'sellerId', SELLER_ID_PATTERN),
    merchantPrivateKey,
    merchantPrivateKeyPem: (input.merchantPrivateKey as string).trim(),
    alipayPublicKey: parseAlipayPublicKey(input.alipayPublicKey),
    gateway: normalizeAlipayGateway(input.gateway),
    notifyUrl: normalizeCallbackUrl(input.notifyUrl, 'notifyUrl'),
    returnUrl: normalizeCallbackUrl(input.returnUrl, 'returnUrl'),
    createMethod: parseCreateMethod(input.createMethod),
    currency: ALIPAY_DEFAULT_CURRENCY,
    checkoutTtlMs: optionalPositiveInt(input.checkoutTtlMs, 'checkoutTtlMs', 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000),
    requestTimeoutMs: optionalPositiveInt(input.requestTimeoutMs, 'requestTimeoutMs', 10_000, 60_000),
    now: input.now ?? (() => new Date()),
    fetchImpl,
  });
}

/** Sorted `k=v&…` content for REQUEST signing: excludes only `sign`; empty values are skipped. */
export function alipayRequestSignContent(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** Sorted `k=v&…` content for NOTIFICATION verification: excludes `sign` AND `sign_type`. */
export function alipayNotifySignContent(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
}

/** RSA2 (SHA256withRSA, PKCS#1 v1.5) base64 signature over the sign content. */
export function alipayRsa2Sign(content: string, merchantPrivateKey: KeyObject): string {
  return createSign('RSA-SHA256').update(content, 'utf8').sign(merchantPrivateKey, 'base64');
}

/** RSA2 verification of a base64 signature over the sign content. Parse failures fail closed. */
export function alipayRsa2Verify(content: string, signatureBase64: string, alipayPublicKey: KeyObject): boolean {
  if (
    typeof signatureBase64 !== 'string' ||
    signatureBase64.length === 0 ||
    Buffer.byteLength(signatureBase64, 'utf8') > MAX_SIGNATURE_BYTES ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)
  ) {
    return false;
  }
  try {
    return createVerify('RSA-SHA256').update(content, 'utf8').verify(alipayPublicKey, signatureBase64, 'base64');
  } catch {
    return false;
  }
}

/**
 * Verifies an async notification: sign_type must be RSA2 and the RSA2
 * signature must cover every posted parameter except sign/sign_type (sorted
 * `k=v` pairs, empty values skipped — the Alipay notification rule).
 */
export function verifyAlipayNotificationSignature(
  params: Readonly<Record<string, string>>,
  alipayPublicKey: KeyObject,
): boolean {
  const sign = params.sign;
  if (typeof sign !== 'string' || sign === '') return false;
  if (params.sign_type !== ALIPAY_SIGN_TYPE) return false;
  return alipayRsa2Verify(alipayNotifySignContent(params), sign, alipayPublicKey);
}

/** Constant-time text comparison for app_id/seller_id notification identity checks. */
export function alipayConstantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Minor units (e.g. cents) → Alipay yuan decimal string with exactly two decimals. Fixed-point only. */
export function alipayMinorUnitsToYuan(amountMinorUnits: string | bigint): string {
  if (typeof amountMinorUnits === 'string' && !MINOR_UNITS_PATTERN.test(amountMinorUnits)) {
    configurationInvalid('alipay amount must be a minor-units integer string');
  }
  const minor = typeof amountMinorUnits === 'bigint' ? amountMinorUnits : BigInt(amountMinorUnits);
  if (minor < 0n) configurationInvalid('alipay amount must not be negative');
  const yuan = minor / 100n;
  const fraction = (minor % 100n).toString(10).padStart(2, '0');
  return `${yuan.toString(10)}.${fraction}`;
}

/** Alipay yuan decimal string → minor units. Rejects exponents, extra precision and floats. */
export function alipayYuanToMinorUnits(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!YUAN_PATTERN.test(trimmed)) return null;
  const [yuanPart, fractionPart = ''] = trimmed.split('.');
  const fraction = `${fractionPart}00`.slice(0, 2);
  return BigInt(yuanPart) * 100n + BigInt(fraction);
}

/**
 * Canonical biz_content JSON: object keys sorted recursively, no whitespace,
 * strings through JSON.stringify. Only plain objects/arrays/strings are
 * allowed — anything else fails closed so the signed bytes stay deterministic.
 */
export function alipayCanonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => alipayCanonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${alipayCanonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  configurationInvalid('alipay biz_content contains an unsupported value type');
}

const SHANGHAI_TIME_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Alipay wire timestamp `yyyy-MM-dd HH:mm:ss` in Asia/Shanghai; deterministic for an injected clock. */
export function alipayTimestamp(date: Date): string {
  const parts: Record<string, string> = {};
  for (const part of SHANGHAI_TIME_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
