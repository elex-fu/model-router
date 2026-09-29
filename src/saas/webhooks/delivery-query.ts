import type { SaasDatabase } from '../db/types.js';
import { assertWebhookUuid, CUSTOMER_WEBHOOK_EVENT_TYPES, type CustomerWebhookEventType } from './events.js';

export type CustomerWebhookDeliveryState = 'pending' | 'leased' | 'delivered' | 'dead_lettered' | 'cancelled';

export interface CustomerWebhookDeliveryCursor {
  readonly createdAt: string;
  readonly eventId: string;
}

export interface CustomerWebhookDeliveryHistoryEntry {
  readonly eventType: CustomerWebhookEventType;
  readonly occurredAt: string;
  readonly status: CustomerWebhookDeliveryState;
  readonly attempts: number;
  readonly lastHttpStatus: number | null;
  readonly lastLatencyMs: number | null;
  readonly lastErrorCode: string | null;
}

export interface CustomerWebhookDeliveryHistoryPage {
  readonly items: readonly CustomerWebhookDeliveryHistoryEntry[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface CustomerWebhookDeliveryHistoryOptions {
  readonly cursor?: CustomerWebhookDeliveryCursor;
  readonly limit: number;
}

interface CustomerWebhookDeliveryHistoryRow {
  readonly event_type: unknown;
  readonly occurred_at: unknown;
  readonly cursor_created_at: unknown;
  readonly cursor_event_id: unknown;
  readonly status: unknown;
  readonly attempts: unknown;
  readonly last_http_status: unknown;
  readonly last_latency_ms: unknown;
  readonly last_error_code: unknown;
}

const DELIVERY_STATES = new Set<CustomerWebhookDeliveryState>([
  'pending',
  'leased',
  'delivered',
  'dead_lettered',
  'cancelled',
]);
const DELIVERY_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DELIVERY_CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_CURSOR_LENGTH = 256;

function invalidCursor(): never {
  throw new TypeError('webhook delivery cursor is invalid');
}

function canonicalTimestamp(value: unknown, field: string): string {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Stored webhook ${field} is invalid`);
  }
  return new Date(timestamp).toISOString();
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Stored webhook ${field} is invalid`);
  }
  return parsed;
}

function nullableInteger(value: unknown, minimum: number, maximum: number, field: string): number | null {
  return value === null ? null : integer(value, minimum, maximum, field);
}

/** The cursor is opaque to callers and contains only the stable sort key. */
export function encodeCustomerWebhookDeliveryCursor(cursor: CustomerWebhookDeliveryCursor): string {
  assertWebhookUuid(cursor.eventId, 'eventId');
  if (
    !DELIVERY_CURSOR_TIMESTAMP.test(cursor.createdAt) ||
    new Date(cursor.createdAt).toISOString() !== cursor.createdAt
  ) {
    throw new TypeError('webhook delivery cursor timestamp is invalid');
  }
  return Buffer.from(`${cursor.createdAt}\n${cursor.eventId}`, 'utf8').toString('base64url');
}

export function parseCustomerWebhookDeliveryCursor(value: string): CustomerWebhookDeliveryCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
  let decoded: string;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return invalidCursor();
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalidCursor();
  }
  const separator = decoded.indexOf('\n');
  if (separator < 0 || decoded.indexOf('\n', separator + 1) !== -1) return invalidCursor();
  const createdAt = decoded.slice(0, separator);
  const eventId = decoded.slice(separator + 1);
  try {
    assertWebhookUuid(eventId, 'eventId');
    if (
      !DELIVERY_CURSOR_TIMESTAMP.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt
    ) {
      return invalidCursor();
    }
  } catch {
    return invalidCursor();
  }
  return { createdAt, eventId };
}

function deliveryHistoryEntry(row: CustomerWebhookDeliveryHistoryRow): CustomerWebhookDeliveryHistoryEntry {
  if (
    typeof row.event_type !== 'string' ||
    !CUSTOMER_WEBHOOK_EVENT_TYPES.includes(row.event_type as CustomerWebhookEventType)
  ) {
    throw new Error('Stored webhook event type is invalid');
  }
  if (typeof row.status !== 'string' || !DELIVERY_STATES.has(row.status as CustomerWebhookDeliveryState)) {
    throw new Error('Stored webhook delivery state is invalid');
  }
  const lastErrorCode = row.last_error_code;
  return Object.freeze({
    eventType: row.event_type as CustomerWebhookEventType,
    occurredAt: canonicalTimestamp(row.occurred_at, 'event time'),
    status: row.status as CustomerWebhookDeliveryState,
    attempts: integer(row.attempts, 0, 12, 'attempt count'),
    lastHttpStatus: nullableInteger(row.last_http_status, 100, 599, 'HTTP status'),
    lastLatencyMs: nullableInteger(row.last_latency_ms, 0, 300_000, 'latency'),
    lastErrorCode: typeof lastErrorCode === 'string' && DELIVERY_ERROR_CODE.test(lastErrorCode) ? lastErrorCode : null,
  });
}

/** Read-only, tenant and endpoint scoped delivery history. This query never selects payload or target URL. */
export async function readCustomerWebhookDeliveryHistory(
  database: Pick<SaasDatabase, 'query'>,
  tenantId: string,
  endpointId: string,
  options: CustomerWebhookDeliveryHistoryOptions,
): Promise<CustomerWebhookDeliveryHistoryPage> {
  assertWebhookUuid(tenantId, 'tenantId');
  assertWebhookUuid(endpointId, 'endpointId');
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new RangeError('webhook delivery limit is invalid');
  }

  const selected = await database.query<CustomerWebhookDeliveryHistoryRow>(
    `SELECT event.event_type AS event_type,
            event.occurred_at AS occurred_at,
            delivery.created_at AS cursor_created_at,
            delivery.event_id::text AS cursor_event_id,
            delivery.state AS status,
            delivery.attempt_count AS attempts,
            delivery.last_http_status AS last_http_status,
            delivery.last_latency_ms AS last_latency_ms,
            delivery.last_error_code AS last_error_code
     FROM saas_customer_webhook_deliveries AS delivery
     JOIN saas_customer_webhook_events AS event
       ON event.tenant_id = delivery.tenant_id AND event.event_id = delivery.event_id
     WHERE delivery.tenant_id = $1 AND delivery.endpoint_id = $2
       AND ($3::timestamptz IS NULL OR (delivery.created_at, delivery.event_id) < ($3::timestamptz, $4::uuid))
     ORDER BY delivery.created_at DESC, delivery.event_id DESC
     LIMIT $5`,
    [tenantId, endpointId, options.cursor?.createdAt ?? null, options.cursor?.eventId ?? null, options.limit + 1],
  );

  const hasMore = selected.rows.length > options.limit;
  const pageRows = selected.rows.slice(0, options.limit);
  const items = pageRows.map(deliveryHistoryEntry);
  const lastRow = pageRows.at(-1);
  let nextCursor: string | null = null;
  if (hasMore && lastRow) {
    const createdAt = canonicalTimestamp(lastRow.cursor_created_at, 'delivery creation time');
    if (typeof lastRow.cursor_event_id !== 'string') throw new Error('Stored webhook event id is invalid');
    assertWebhookUuid(lastRow.cursor_event_id, 'stored event id');
    nextCursor = encodeCustomerWebhookDeliveryCursor({ createdAt, eventId: lastRow.cursor_event_id });
  }

  return Object.freeze({ items: Object.freeze(items), nextCursor, hasMore });
}
