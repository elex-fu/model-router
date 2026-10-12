import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe protocol primitives for the C5/R3 contract: direct v1 form-encoded
// API access with NO official SDK (undici fetch + node:crypto only), strict
// fixed-point minor-units money (Stripe charges integer minor units — never
// the yuan decimal strings EasyPay uses) and v1 webhook signature
// verification (HMAC-SHA256 over "<t>.<rawBody>" with a 300s tolerance).
// Configuration fails closed: key prefixes are enforced, the API base
// requires https off-loopback and only the `card` payment method is allowed.

export const STRIPE_PROVIDER_KEY = 'stripe' as const;
export const STRIPE_DEFAULT_API_BASE = 'https://api.stripe.com' as const;
export const STRIPE_DEFAULT_CURRENCY = 'usd' as const;
export const STRIPE_WEBHOOK_TOLERANCE_MS = 300_000;
export const STRIPE_PAYMENT_METHOD_TYPES = ['card'] as const;

const MAX_CONFIG_TEXT_BYTES = 1024;
const MINOR_UNITS_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const SECRET_KEY_PATTERN = /^sk_(test|live)_[A-Za-z0-9]{8,}$/;
const PUBLISHABLE_KEY_PATTERN = /^pk_(test|live)_[A-Za-z0-9]{8,}$/;
const WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9]{8,}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class StripeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeConfigurationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function configurationInvalid(message: string): never {
  throw new StripeConfigurationError(message);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') configurationInvalid(`stripe ${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > MAX_CONFIG_TEXT_BYTES || trimmed.includes(' ')) {
    configurationInvalid(`stripe ${label} is invalid`);
  }
  return trimmed;
}

function keyedText(value: unknown, label: string, pattern: RegExp): string {
  const text = requiredText(value, label);
  if (!pattern.test(text)) configurationInvalid(`stripe ${label} is invalid`);
  return text;
}

/** Absolute http(s) base URL; https is mandatory outside loopback. Trailing slashes are stripped. */
export function normalizeStripeApiBase(value: unknown): string {
  const raw = value === undefined ? STRIPE_DEFAULT_API_BASE : requiredText(value, 'apiBase');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    configurationInvalid('stripe apiBase must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    configurationInvalid('stripe apiBase requires https outside loopback');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    configurationInvalid('stripe apiBase is invalid');
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== '/') configurationInvalid('stripe apiBase must not carry a path');
  return `${parsed.protocol}//${parsed.host}`;
}

/** Stripe settles in lowercase ISO 4217; configuration is normalized to the wire form. */
export function normalizeStripeCurrency(value: unknown): string {
  const raw = value === undefined ? STRIPE_DEFAULT_CURRENCY : requiredText(value, 'currency');
  const lowered = raw.toLowerCase();
  if (!/^[a-z]{3}$/.test(lowered)) configurationInvalid('stripe currency is invalid');
  return lowered;
}

export interface StripeMerchantConfig {
  /** Secret API key (sk_test_/sk_live_). Never logged, never included in error messages. */
  readonly secretKey: string;
  /** Publishable key (pk_test_/pk_live_). Doubles as the adapter's public merchant identity. */
  readonly publishableKey: string;
  /** Webhook endpoint signing secret (whsec_). Never logged. */
  readonly webhookSecret: string;
  readonly apiBase: string;
  /** Lowercase ISO 4217 wire currency. */
  readonly currency: string;
  readonly paymentMethodTypes: readonly ['card'];
}

export interface StripeProviderOptions extends StripeMerchantConfig {
  readonly checkoutTtlMs: number;
  readonly requestTimeoutMs: number;
  readonly now: () => Date;
  readonly fetchImpl: typeof fetch;
}

export interface StripeProviderConfigInput {
  readonly secretKey?: unknown;
  readonly publishableKey?: unknown;
  readonly webhookSecret?: unknown;
  readonly apiBase?: unknown;
  readonly currency?: unknown;
  /** Only `['card']` is supported; anything else fails closed. */
  readonly paymentMethodTypes?: unknown;
  readonly checkoutTtlMs?: unknown;
  readonly requestTimeoutMs?: unknown;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
}

function optionalPositiveInt(value: unknown, label: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    configurationInvalid(`stripe ${label} is invalid`);
  }
  return value;
}

function parsePaymentMethodTypes(value: unknown): readonly ['card'] {
  if (value === undefined) return STRIPE_PAYMENT_METHOD_TYPES;
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'card') {
    configurationInvalid('stripe paymentMethodTypes only supports [card]');
  }
  return STRIPE_PAYMENT_METHOD_TYPES;
}

export function parseStripeProviderConfig(input: StripeProviderConfigInput): StripeProviderOptions {
  if (!input || typeof input !== 'object') configurationInvalid('stripe configuration is required');
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') configurationInvalid('stripe fetch implementation is unavailable');
  return {
    secretKey: keyedText(input.secretKey, 'secretKey', SECRET_KEY_PATTERN),
    publishableKey: keyedText(input.publishableKey, 'publishableKey', PUBLISHABLE_KEY_PATTERN),
    webhookSecret: keyedText(input.webhookSecret, 'webhookSecret', WEBHOOK_SECRET_PATTERN),
    apiBase: normalizeStripeApiBase(input.apiBase),
    currency: normalizeStripeCurrency(input.currency),
    paymentMethodTypes: parsePaymentMethodTypes(input.paymentMethodTypes),
    checkoutTtlMs: optionalPositiveInt(input.checkoutTtlMs, 'checkoutTtlMs', 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000),
    requestTimeoutMs: optionalPositiveInt(input.requestTimeoutMs, 'requestTimeoutMs', 10_000, 60_000),
    now: input.now ?? (() => new Date()),
    fetchImpl,
  };
}

/**
 * Validates a local minor-units decimal string for the Stripe wire. Stripe
 * charges integer minor units directly, so the value passes through
 * unchanged; floats, exponents, signs and extra precision are rejected.
 */
export function stripeMinorUnitsToWire(amountMinorUnits: string): string {
  if (typeof amountMinorUnits !== 'string' || !MINOR_UNITS_PATTERN.test(amountMinorUnits)) {
    configurationInvalid('stripe amount must be a minor-units integer string');
  }
  return amountMinorUnits;
}

/** Stripe JSON amount (integer minor units, number or string form) → minor-units string. */
export function stripeAmountToMinorUnits(value: unknown): string | null {
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

export interface StripeWebhookSignatureInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string;
  readonly webhookSecret: string;
  readonly nowMs: number;
  readonly toleranceMs?: number;
}

/**
 * Verifies the `stripe-signature` v1 scheme: `t=<unix seconds>,v1=<hex
 * HMAC-SHA256>` over `"<t>.<rawBody>"`. Multiple v1 values are only accepted
 * when they are identical; inconsistent v1 values, a missing header
 * component, a malformed signature or a timestamp outside the tolerance
 * window all fail closed.
 */
export function verifyStripeWebhookSignature(input: StripeWebhookSignatureInput): boolean {
  if (!Buffer.isBuffer(input.rawBody) || input.rawBody.length === 0) return false;
  if (typeof input.signatureHeader !== 'string' || input.signatureHeader.length > MAX_CONFIG_TEXT_BYTES) return false;
  const toleranceMs = input.toleranceMs ?? STRIPE_WEBHOOK_TOLERANCE_MS;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const item of input.signatureHeader.split(',')) {
    const separator = item.indexOf('=');
    if (separator <= 0) return false;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== null) return false;
      timestamp = value;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }
  if (timestamp === null || !/^[0-9]{1,12}$/.test(timestamp)) return false;
  if (signatures.length === 0 || new Set(signatures).size !== 1) return false;
  const signature = signatures[0] as string;
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const timestampMs = Number(timestamp) * 1000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(input.nowMs - timestampMs) > toleranceMs) return false;
  const expected = createHmac('sha256', input.webhookSecret)
    .update(timestamp, 'utf8')
    .update('.')
    .update(input.rawBody)
    .digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature.toLowerCase(), 'utf8'));
}
