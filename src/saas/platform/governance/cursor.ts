import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { governanceInvalid } from './errors.js';

/** Cursors are session artifacts; a process restart simply invalidates them. */
const PROCESS_CURSOR_SECRET = randomBytes(32);

const MAX_CURSOR_LENGTH = 2048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;
const CURSOR_KEYS = ['filterHash', 'id', 'occurredAt', 'version'].sort();

export interface GovernanceCursor {
  readonly version: 1;
  readonly filterHash: string;
  readonly occurredAt: string;
  readonly id: string;
}

export function governanceFilterHash(kind: string, filters: Record<string, string>): string {
  const entries = Object.entries(filters).sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify(['platform-governance', kind, entries]), 'utf8')
    .digest('hex');
}

function cursorPayload(cursor: GovernanceCursor): string {
  return JSON.stringify({
    version: cursor.version,
    filterHash: cursor.filterHash,
    occurredAt: cursor.occurredAt,
    id: cursor.id,
  });
}

function sign(secret: Uint8Array, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function encodeGovernanceCursor(secret: Uint8Array, prefix: string, cursor: GovernanceCursor): string {
  const payload = Buffer.from(cursorPayload(cursor), 'utf8').toString('base64url');
  return `${prefix}${payload}.${sign(secret, `${prefix}${payload}`)}`;
}

export function decodeGovernanceCursor(
  secret: Uint8Array,
  prefix: string,
  value: unknown,
  filterHash: string,
): GovernanceCursor | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CURSOR_LENGTH) governanceInvalid();
  if (!value.startsWith(prefix)) governanceInvalid();
  const body = value.slice(prefix.length);
  const separator = body.lastIndexOf('.');
  if (separator <= 0 || separator === body.length - 1) governanceInvalid();
  const encodedPayload = body.slice(0, separator);
  const suppliedSignature = body.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[0-9a-f]{64}$/.test(suppliedSignature)) governanceInvalid();

  const expectedSignature = sign(secret, `${prefix}${encodedPayload}`);
  const expectedBytes = Buffer.from(expectedSignature, 'hex');
  const suppliedBytes = Buffer.from(suppliedSignature, 'hex');
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    governanceInvalid();
  }

  let candidate: unknown;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url');
    if (decoded.length === 0 || decoded.toString('base64url') !== encodedPayload) governanceInvalid();
    candidate = JSON.parse(decoded.toString('utf8'));
  } catch {
    return governanceInvalid();
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) governanceInvalid();
  const object = candidate as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== CURSOR_KEYS.join(',')) governanceInvalid();
  if (object.version !== 1 || object.filterHash !== filterHash) governanceInvalid();
  if (
    typeof object.occurredAt !== 'string' ||
    object.occurredAt.length > 64 ||
    !UTC_TIMESTAMP_PATTERN.test(object.occurredAt) ||
    !Number.isFinite(Date.parse(object.occurredAt)) ||
    typeof object.id !== 'string' ||
    !UUID_PATTERN.test(object.id)
  ) {
    governanceInvalid();
  }
  return { version: 1, filterHash, occurredAt: object.occurredAt, id: object.id };
}

export function governanceCursorSecret(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return PROCESS_CURSOR_SECRET;
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  if (bytes.length < 16 || bytes.length > 4096) {
    throw new TypeError('cursorSecret must contain between 16 and 4096 bytes');
  }
  return bytes;
}
