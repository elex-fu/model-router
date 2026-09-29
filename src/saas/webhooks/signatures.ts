import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertWebhookUuid } from './events.js';

export const CUSTOMER_WEBHOOK_SIGNATURE_HEADER = 'x-model-router-signature';
export const CUSTOMER_WEBHOOK_EVENT_ID_HEADER = 'x-model-router-event-id';
export const CUSTOMER_WEBHOOK_TIMESTAMP_HEADER = 'x-model-router-timestamp';
export const CUSTOMER_WEBHOOK_SIGNATURE_VERSION = 'v1' as const;
export const CUSTOMER_WEBHOOK_MAX_SIGNATURES = 2;

export interface CustomerWebhookSigningKey {
  readonly version: number;
  readonly secret: Uint8Array;
}

/**
 * Header contract:
 * - `X-Model-Router-Event-Id`: stable UUID used for receiver deduplication.
 * - `X-Model-Router-Timestamp`: Unix seconds for this delivery attempt.
 * - `X-Model-Router-Signature`: one or two comma-separated `v1=<key-version>:<lowercase-hex>` values.
 * During rotation, a receiver may verify either active overlap version.
 *
 * Canonical bytes are UTF-8 of:
 * `model-router-webhook-v1\n{unix-seconds}\n{event_id}\n` followed by the exact
 * transmitted request-body bytes. Signatures use HMAC-SHA256. Receivers should
 * compare in constant time and reject timestamps outside their replay window;
 * `event_id` must also be deduplicated for the receiver's retention period.
 */
export function customerWebhookCanonicalBytes(timestampSeconds: number, eventId: string, body: Uint8Array): Buffer {
  assertWebhookTimestampSeconds(timestampSeconds);
  assertWebhookUuid(eventId, 'event_id');
  if (!(body instanceof Uint8Array)) throw new TypeError('body must be bytes');
  return Buffer.concat([
    Buffer.from(`model-router-webhook-v1\n${timestampSeconds}\n${eventId}\n`, 'utf8'),
    Buffer.from(body),
  ]);
}

export function computeCustomerWebhookSignature(
  key: CustomerWebhookSigningKey,
  timestampSeconds: number,
  eventId: string,
  body: Uint8Array,
): string {
  assertSigningKey(key);
  const digest = createHmac('sha256', key.secret)
    .update(customerWebhookCanonicalBytes(timestampSeconds, eventId, body))
    .digest('hex');
  return `${CUSTOMER_WEBHOOK_SIGNATURE_VERSION}=${key.version}:${digest}`;
}

/** Compare a provided v1 signature without a timing leak. */
export function verifyCustomerWebhookSignature(
  provided: string,
  key: CustomerWebhookSigningKey,
  timestampSeconds: number,
  eventId: string,
  body: Uint8Array,
): boolean {
  if (typeof provided !== 'string' || provided.length > 80) return false;
  let expected: string;
  try {
    expected = computeCustomerWebhookSignature(key, timestampSeconds, eventId, body);
  } catch {
    return false;
  }
  const expectedBytes = Buffer.from(expected, 'ascii');
  const providedBytes = Buffer.from(provided, 'ascii');
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export function formatCustomerWebhookSignatureHeader(signatures: readonly string[]): string {
  if (signatures.length < 1 || signatures.length > CUSTOMER_WEBHOOK_MAX_SIGNATURES) {
    throw new RangeError('webhook signatures must contain one or two entries');
  }
  const uniqueVersions = new Set<number>();
  for (const signature of signatures) {
    const match = /^v1=([1-9][0-9]{0,8}):[0-9a-f]{64}$/.exec(signature);
    if (!match) throw new TypeError('webhook signature does not match the v1 header contract');
    const version = Number(match[1]);
    if (uniqueVersions.has(version)) throw new TypeError('duplicate webhook signing-key version');
    uniqueVersions.add(version);
  }
  return signatures.join(',');
}

export function assertWebhookTimestampSeconds(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999) {
    throw new RangeError('webhook timestamp must be Unix seconds');
  }
}

function assertSigningKey(value: CustomerWebhookSigningKey): void {
  if (
    !value ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    value.version > 999_999_999 ||
    !(value.secret instanceof Uint8Array) ||
    value.secret.byteLength < 32 ||
    value.secret.byteLength > 256
  ) {
    throw new TypeError('invalid webhook signing key');
  }
}
