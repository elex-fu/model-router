import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createSign,
  createVerify,
  type KeyObject,
  X509Certificate,
} from 'node:crypto';

// WeChat Pay v3 (微信支付) protocol primitives for the R3 adapter review
// checklist: direct api.mch.weixin.qq.com v3 JSON access with NO official SDK
// (undici fetch + node:crypto only), WECHATPAY2-SHA256-RSA2048 request signing,
// platform-certificate webhook verification (RSA-SHA256 over
// "timestamp\nnonce\nbody\n" with a 300s tolerance), AES-256-GCM resource
// decryption under the merchant apiV3Key, and strict fixed-point minor-units
// money (WeChat bills integer fen — floats, exponents and extra precision are
// rejected in both directions).
//
// Configuration fails closed: mchid/appid/serial shapes are enforced, the
// merchant private key must be an RSA PKCS8 PEM and is parsed + frozen at
// config time (it never leaves the module and never enters a log line), the
// apiV3Key must be exactly 32 bytes, the gateway requires https off-loopback
// and only the native prepay mode is accepted. jsapi/app modes are extension
// points deliberately refused at the configuration layer this phase: jsapi
// needs a payer openid plus a frontend JSSDK signature collection flow and app
// needs a mobile SDK handoff — neither checkout collapses onto the closed
// qr/redirect action union, and neither can complete server-side only, so a
// partial implementation would weaken the fail-closed contract.
//
// Platform-certificate trust model (documented per the review checklist): the
// /v3/certificates response CANNOT be signature-verified at bootstrap — the
// certificate needed for verification is exactly what is being fetched. Trust
// therefore rests on (a) TLS to the configured https gateway (SSRF egress
// allowlisting is deployment-level), (b) AES-256-GCM authenticated decryption
// of each certificate under the merchant-held apiV3Key (a forged cert body
// fails GCM authentication), (c) X.509 validity-window + RSA key-type +
// 40-hex serial pinning at use time, and (d) serial-mismatch-triggered
// refresh. Full CA-chain verification to the WeChat root certificate is a
// deployment-level pinning extension (COM-01) and intentionally not
// reimplemented here.

export const WXPAY_PROVIDER_KEY = 'wxpay' as const;
export const WXPAY_DEFAULT_GATEWAY = 'https://api.mch.weixin.qq.com' as const;
export const WXPAY_DEFAULT_CURRENCY = 'CNY' as const;
export const WXPAY_WEBHOOK_TOLERANCE_MS = 300_000;
export const WXPAY_APIV3_KEY_BYTES = 32;
export const WXPAY_AUTH_SCHEME = 'WECHATPAY2-SHA256-RSA2048' as const;
export const WXPAY_AEAD_ALGORITHM = 'AEAD_AES_256_GCM' as const;

const MAX_CONFIG_TEXT_BYTES = 1024;
const MAX_NOTIFY_URL_BYTES = 255;
const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const MCHID_PATTERN = /^[0-9]{1,32}$/;
const APPID_PATTERN = /^wx[0-9a-f]{16}$/;
const SERIAL_NO_PATTERN = /^[0-9A-Fa-f]{40}$/;
const OUT_TRADE_NO_DIRECT_PATTERN = /^[0-9A-Za-z_-]{6,32}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class WxpayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WxpayConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function configurationInvalid(message: string): never {
  throw new WxpayConfigurationError(message);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') configurationInvalid(`wxpay ${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > MAX_CONFIG_TEXT_BYTES || trimmed.includes(' ')) {
    configurationInvalid(`wxpay ${label} is invalid`);
  }
  return trimmed;
}

function keyedText(value: unknown, label: string, pattern: RegExp): string {
  const text = requiredText(value, label);
  if (!pattern.test(text)) configurationInvalid(`wxpay ${label} is invalid`);
  return text;
}

/** Absolute https base URL (loopback http allowed for tests); no path/query/credentials are carried. */
export function normalizeWxpayGateway(value: unknown): string {
  const raw = value === undefined ? WXPAY_DEFAULT_GATEWAY : requiredText(value, 'gateway');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    configurationInvalid('wxpay gateway must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    configurationInvalid('wxpay gateway requires https outside loopback');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    configurationInvalid('wxpay gateway is invalid');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/') configurationInvalid('wxpay gateway must not carry a path');
  return `${parsed.protocol}//${parsed.host}`;
}

/** The webhook receiver URL is forwarded to WeChat; it must be an absolute https URL (WeChat requirement). */
export function normalizeWxpayNotifyUrl(value: unknown): string {
  const raw = requiredText(value, 'notifyUrl');
  if (Buffer.byteLength(raw, 'utf8') > MAX_NOTIFY_URL_BYTES) configurationInvalid('wxpay notifyUrl is invalid');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    configurationInvalid('wxpay notifyUrl must be an absolute https URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    configurationInvalid('wxpay notifyUrl must be an absolute https URL');
  }
  return raw;
}

/** Parses and freezes the RSA PKCS8 merchant private key; the PEM itself is never retained. */
function parseMerchantPrivateKey(value: unknown): KeyObject {
  if (typeof value !== 'string') configurationInvalid('wxpay merchantPrivateKey is required');
  const pem = value.trim();
  if (!pem.startsWith('-----BEGIN PRIVATE KEY-----') || !pem.includes('-----END PRIVATE KEY-----')) {
    configurationInvalid('wxpay merchantPrivateKey must be a PKCS8 PEM');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    configurationInvalid('wxpay merchantPrivateKey is not a parseable private key');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    configurationInvalid('wxpay merchantPrivateKey must be an RSA key');
  }
  return key;
}

/** The apiV3Key is exactly 32 bytes of AES-256-GCM key material; it is frozen into a Buffer and never logged. */
function parseApiV3Key(value: unknown): Buffer {
  if (typeof value !== 'string') configurationInvalid('wxpay apiV3Key is required');
  if (Buffer.byteLength(value, 'utf8') !== WXPAY_APIV3_KEY_BYTES) {
    configurationInvalid('wxpay apiV3Key must be exactly 32 bytes');
  }
  return Buffer.from(value, 'utf8');
}

export interface WxpayMerchantConfig {
  readonly mchid: string;
  readonly appid: string;
  /** Merchant API certificate serial (40-hex, uppercase). Sent as serial_no in the Authorization header. */
  readonly merchantSerialNo: string;
  /** Parsed RSA private key. Never logged, never serialized, never leaves the module. */
  readonly merchantPrivateKey: KeyObject;
  /** 32-byte AES-256-GCM key for notification/certificate resource decryption. Never logged. */
  readonly apiV3Key: Buffer;
  readonly gateway: string;
  readonly notifyUrl: string;
  readonly currency: string;
  /** Only `native` prepay is supported; jsapi/app are refused at the configuration layer. */
  readonly paymentMode: 'native';
}

export interface WxpayProviderOptions extends WxpayMerchantConfig {
  readonly checkoutTtlMs: number;
  readonly requestTimeoutMs: number;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
}

export interface WxpayProviderConfigInput {
  readonly mchid?: unknown;
  readonly appid?: unknown;
  readonly merchantSerialNo?: unknown;
  readonly merchantPrivateKey?: unknown;
  readonly apiV3Key?: unknown;
  readonly gateway?: unknown;
  readonly notifyUrl?: unknown;
  readonly currency?: unknown;
  /** Only `native` is supported; `jsapi`/`app`/anything else fails closed (extension point). */
  readonly paymentMode?: unknown;
  readonly checkoutTtlMs?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

function optionalPositiveInt(value: unknown, label: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    configurationInvalid(`wxpay ${label} is invalid`);
  }
  return value;
}

function parsePaymentMode(value: unknown): 'native' {
  if (value === undefined) return 'native';
  const mode = requiredText(value, 'paymentMode');
  if (mode !== 'native') {
    configurationInvalid(
      'wxpay paymentMode only supports native: jsapi/app checkout cannot collapse onto the closed action union this phase',
    );
  }
  return 'native';
}

export function parseWxpayProviderConfig(input: WxpayProviderConfigInput): WxpayProviderOptions {
  if (!input || typeof input !== 'object') configurationInvalid('wxpay configuration is required');
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') configurationInvalid('wxpay fetch implementation is unavailable');
  const currency = input.currency === undefined ? WXPAY_DEFAULT_CURRENCY : requiredText(input.currency, 'currency');
  if (currency !== WXPAY_DEFAULT_CURRENCY) {
    configurationInvalid('wxpay currency only supports CNY this phase');
  }
  return {
    mchid: keyedText(input.mchid, 'mchid', MCHID_PATTERN),
    appid: keyedText(input.appid, 'appid', APPID_PATTERN),
    merchantSerialNo: keyedText(input.merchantSerialNo, 'merchantSerialNo', SERIAL_NO_PATTERN).toUpperCase(),
    merchantPrivateKey: parseMerchantPrivateKey(input.merchantPrivateKey),
    apiV3Key: parseApiV3Key(input.apiV3Key),
    gateway: normalizeWxpayGateway(input.gateway),
    notifyUrl: normalizeWxpayNotifyUrl(input.notifyUrl),
    currency,
    paymentMode: parsePaymentMode(input.paymentMode),
    checkoutTtlMs: optionalPositiveInt(input.checkoutTtlMs, 'checkoutTtlMs', 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000),
    requestTimeoutMs: optionalPositiveInt(input.requestTimeoutMs, 'requestTimeoutMs', 10_000, 60_000),
    now: input.now ?? (() => new Date()),
    fetchImpl,
  };
}

/**
 * WeChat out_trade_no is [0-9A-Za-z_-]{6,32}; local order ids (uuid-shaped,
 * 36 chars) exceed the wire limit. Ids already inside the alphabet and length
 * pass through unchanged; anything else maps deterministically onto
 * 'h' + sha256(id)[0:31] so the out_trade_no is always locally recoverable
 * without provider state (collision resistance is inherited from the hash).
 */
export function wxpayOutTradeNo(localOrderId: string): string {
  if (typeof localOrderId !== 'string' || localOrderId.length === 0 || localOrderId.length > 256) {
    configurationInvalid('wxpay local order id is invalid');
  }
  if (OUT_TRADE_NO_DIRECT_PATTERN.test(localOrderId)) return localOrderId;
  const digest = createHash('sha256').update(localOrderId, 'utf8').digest('hex');
  return `h${digest.slice(0, 31)}`;
}

/**
 * Validates a local minor-units decimal string for the WeChat wire. WeChat
 * bills integer fen directly, so the value passes through unchanged as a RAW
 * JSON integer token (never a float); floats, exponents, signs and extra
 * precision are rejected.
 */
export function wxpayMinorUnitsToWire(amountMinorUnits: string): string {
  if (typeof amountMinorUnits !== 'string' || !MINOR_UNITS_PATTERN.test(amountMinorUnits)) {
    configurationInvalid('wxpay amount must be a minor-units integer string');
  }
  return amountMinorUnits;
}

/**
 * WeChat JSON amount (integer fen) → minor-units string. Number values must
 * be safe integers — that guard is airtight: every integer ≤ 2^53-1 is
 * exactly representable, so a parsed number can never be a float-rounded
 * stand-in for a different true amount; larger values fail closed.
 */
export function wxpayAmountToMinorUnits(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value.toString(10);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return MINOR_UNITS_PATTERN.test(trimmed) ? trimmed : null;
  }
  return null;
}

export interface WxpayRequestSignatureInput {
  readonly method: string;
  /** Request path including the query string, e.g. `/v3/pay/transactions/native`. */
  readonly urlPath: string;
  readonly timestamp: string;
  readonly nonce: string;
  /** Exact request body; the empty string for GET. */
  readonly body: string;
  readonly privateKey: KeyObject;
}

/** WECHATPAY2-SHA256-RSA2048 request signature: RSA-SHA256 over "METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n". */
export function signWxpayRequest(input: WxpayRequestSignatureInput): string {
  const message = `${input.method.toUpperCase()}\n${input.urlPath}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;
  return createSign('RSA-SHA256').update(message, 'utf8').sign(input.privateKey, 'base64');
}

export interface WxpayAuthorizationInput {
  readonly mchid: string;
  readonly serialNo: string;
  readonly nonce: string;
  readonly timestamp: string;
  readonly signature: string;
}

/** Assembles the v3 Authorization header value from signed parts. */
export function buildWxpayAuthorization(input: WxpayAuthorizationInput): string {
  return (
    `${WXPAY_AUTH_SCHEME} mchid="${input.mchid}",nonce_str="${input.nonce}",` +
    `signature="${input.signature}",timestamp="${input.timestamp}",serial_no="${input.serialNo}"`
  );
}

export interface WxpayNotificationSignatureInput {
  readonly rawBody: Buffer;
  readonly timestamp: string;
  readonly nonce: string;
  /** Base64 RSA-SHA256 signature from the Wechatpay-Signature header. */
  readonly signature: string;
  readonly publicKey: KeyObject;
  readonly nowMs: number;
  readonly toleranceMs?: number;
}

/**
 * Verifies a payment notification signature: RSA-SHA256 over
 * "timestamp\nnonce\nbody\n" against the platform certificate public key, with
 * a ±300s timestamp tolerance. Every malformed component fails closed.
 */
export function verifyWxpayNotificationSignature(input: WxpayNotificationSignatureInput): boolean {
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length === 0) return false;
  if (!TIMESTAMP_PATTERN.test(input.timestamp)) return false;
  if (input.nonce.length === 0 || input.nonce.length > 128) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.signature) || input.signature.length > 1024) return false;
  const timestampMs = Number(input.timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs)) return false;
  const toleranceMs = input.toleranceMs ?? WXPAY_WEBHOOK_TOLERANCE_MS;
  if (Math.abs(input.nowMs - timestampMs) > toleranceMs) return false;
  try {
    return createVerify('RSA-SHA256')
      .update(input.timestamp, 'utf8')
      .update('\n', 'utf8')
      .update(input.nonce, 'utf8')
      .update('\n', 'utf8')
      .update(input.rawBody)
      .update('\n', 'utf8')
      .verify(input.publicKey, input.signature, 'base64');
  } catch {
    return false;
  }
}

export interface WxpayAesGcmDecryptInput {
  readonly apiV3Key: Buffer;
  readonly nonce: string;
  readonly associatedData: string;
  /** Base64 ciphertext with the 16-byte GCM auth tag appended (WeChat wire form). */
  readonly ciphertext: string;
}

/**
 * Decrypts an AEAD_AES_256_GCM resource (notification body or platform
 * certificate) with the merchant apiV3Key. Any authentication or shape
 * failure answers null — a tampered ciphertext is never partially trusted.
 */
export function decryptWxpayAesGcm(input: WxpayAesGcmDecryptInput): Buffer | null {
  if (input.apiV3Key.length !== WXPAY_APIV3_KEY_BYTES) return null;
  const nonceBytes = Buffer.byteLength(input.nonce, 'utf8');
  if (nonceBytes < 1 || nonceBytes > 64) return null;
  if (Buffer.byteLength(input.associatedData, 'utf8') > 256) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.ciphertext)) return null;
  let packed: Buffer;
  try {
    packed = Buffer.from(input.ciphertext, 'base64');
  } catch {
    return null;
  }
  if (packed.length <= 16 || packed.length > 1024 * 1024) return null;
  const tag = packed.subarray(packed.length - 16);
  const data = packed.subarray(0, packed.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.apiV3Key, Buffer.from(input.nonce, 'utf8'));
    decipher.setAuthTag(tag);
    decipher.setAAD(Buffer.from(input.associatedData, 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    return null;
  }
}

export interface WxpayPlatformCertificate {
  readonly serialNo: string;
  readonly publicKey: KeyObject;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
}

/**
 * Parses a decrypted platform certificate PEM: the serial must be 40-hex, the
 * key must be RSA and the validity window must contain `nowMs`. Chain-of-trust
 * bootstrap is documented at module scope (TLS + GCM + serial pinning).
 */
export function parseWxpayPlatformCertificate(pem: Buffer, nowMs: number): WxpayPlatformCertificate | null {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem.toString('utf8'));
  } catch {
    return null;
  }
  const serialNo = cert.serialNumber.replaceAll(':', '').toUpperCase();
  if (!SERIAL_NO_PATTERN.test(serialNo)) return null;
  if (cert.publicKey.asymmetricKeyType !== 'rsa') return null;
  const notBeforeMs = Date.parse(cert.validFrom);
  const notAfterMs = Date.parse(cert.validTo);
  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(notAfterMs)) return null;
  if (nowMs < notBeforeMs || nowMs > notAfterMs) return null;
  return { serialNo, publicKey: cert.publicKey, notBeforeMs, notAfterMs };
}

/** WeChat refund wire statuses collapse onto the provider refund tri-state; anything unrecognized stays provisional. */
export function wxpayRefundStatusToTriState(value: string | null): 'pending' | 'succeeded' | 'failed' | null {
  if (value === 'SUCCESS') return 'succeeded';
  if (value === 'CLOSED' || value === 'ABNORMAL') return 'failed';
  if (value === 'PROCESSING') return 'pending';
  return null;
}

/** Payment trade_state mapping for notification normalization (review checklist freeze). */
export function wxpayTradeStateToEventStatus(value: string | null): 'pending' | 'succeeded' | 'failed' {
  if (value === 'SUCCESS') return 'succeeded';
  if (value === 'CLOSED' || value === 'REVOKED') return 'failed';
  return 'pending';
}
