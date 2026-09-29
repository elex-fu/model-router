import { isIP } from 'node:net';

export const CUSTOMER_WEBHOOK_EVENT_TYPES = Object.freeze([
  'wallet.low_balance',
  'api_key.expiring',
  'service_plan_order.status_changed',
  'refund.status_changed',
  'request.completed',
  'usage.completed',
  'platform.maintenance',
] as const);

export type CustomerWebhookEventType = (typeof CUSTOMER_WEBHOOK_EVENT_TYPES)[number];
export type CustomerWebhookSupplyMode = 'byok' | 'platform';

export interface WalletLowBalanceEventData {
  readonly supply_mode: 'platform';
  readonly balance_minor_units: number;
  readonly threshold_minor_units: number;
  readonly currency: string;
}

export interface ApiKeyExpiringEventData {
  readonly api_key_id: string;
  readonly expires_at: string;
}

export interface ServicePlanOrderStatusChangedEventData {
  readonly service_plan_order_id: string;
  readonly status: 'pending' | 'paid' | 'fulfilling' | 'fulfilled' | 'cancelled' | 'reconciliation_pending';
}

export interface RefundStatusChangedEventData {
  readonly refund_id: string;
  readonly status: 'submitting' | 'pending' | 'succeeded' | 'failed' | 'unknown' | 'blocked';
  readonly amount_minor_units: number;
  readonly currency: string;
}

export interface RequestCompletedEventData {
  readonly request_id: string;
  readonly project_id: string;
  readonly supply_mode: CustomerWebhookSupplyMode;
  readonly status: 'succeeded' | 'failed';
  readonly duration_ms: number;
}

export interface UsageCompletedEventData {
  readonly request_id: string;
  readonly project_id: string;
  readonly supply_mode: CustomerWebhookSupplyMode;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

export interface PlatformMaintenanceEventData {
  readonly starts_at: string;
  readonly ends_at: string;
  readonly impact: 'none' | 'degraded' | 'outage';
}

export type CustomerWebhookEventDataByType = {
  'wallet.low_balance': WalletLowBalanceEventData;
  'api_key.expiring': ApiKeyExpiringEventData;
  'service_plan_order.status_changed': ServicePlanOrderStatusChangedEventData;
  'refund.status_changed': RefundStatusChangedEventData;
  'request.completed': RequestCompletedEventData;
  'usage.completed': UsageCompletedEventData;
  'platform.maintenance': PlatformMaintenanceEventData;
};

export interface CustomerWebhookEnvelope<T extends CustomerWebhookEventType = CustomerWebhookEventType> {
  readonly event_id: string;
  readonly event_type: T;
  readonly schema_version: 1;
  readonly occurred_at: string;
  readonly data: CustomerWebhookEventDataByType[T];
}

export const CUSTOMER_WEBHOOK_SCHEMA_VERSION = 1 as const;
export const CUSTOMER_WEBHOOK_MAX_PAYLOAD_BYTES = 8 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER;

export function assertWebhookUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError(`${field} must be a UUID`);
}

export function assertWebhookTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !ISO_UTC_MILLIS.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be an ISO-8601 UTC timestamp with milliseconds`);
  }
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > MAX_SAFE_AMOUNT) {
    throw new TypeError(`${field} must be a bounded integer`);
  }
}

function assertCurrency(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CURRENCY.test(value)) throw new TypeError('currency must be a 3-letter code');
}

function plainRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('webhook event data must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('webhook event data must be plain');
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) throw new TypeError('webhook event data has unsupported keys');
  const keys = (ownKeys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('webhook event data contains unsupported or missing fields');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new TypeError('webhook event data fields must be enumerable values');
    }
  }
  return value as Record<string, unknown>;
}

function assertSupplyMode(value: unknown): asserts value is CustomerWebhookSupplyMode {
  if (value !== 'byok' && value !== 'platform') throw new TypeError('supply_mode is invalid');
}

/**
 * Validate and copy the entire event-specific payload. Exact key sets prevent
 * prompt/response bodies, credentials, arbitrary metadata and cross-tenant IDs
 * from being added. Resource references are additionally tenant-FK checked by
 * the PostgreSQL event store before persistence.
 */
export function validateCustomerWebhookEventData<T extends CustomerWebhookEventType>(
  eventType: T,
  value: unknown,
): CustomerWebhookEventDataByType[T] {
  switch (eventType) {
    case 'wallet.low_balance': {
      const record = plainRecord(value, ['supply_mode', 'balance_minor_units', 'threshold_minor_units', 'currency']);
      if (record.supply_mode !== 'platform')
        throw new TypeError('wallet.low_balance is only valid for platform supply');
      assertSafeInteger(record.balance_minor_units, 'balance_minor_units');
      assertSafeInteger(record.threshold_minor_units, 'threshold_minor_units', 1);
      if ((record.balance_minor_units as number) > (record.threshold_minor_units as number)) {
        throw new TypeError('wallet.low_balance balance cannot exceed the threshold');
      }
      assertCurrency(record.currency);
      return {
        supply_mode: 'platform',
        balance_minor_units: record.balance_minor_units,
        threshold_minor_units: record.threshold_minor_units,
        currency: record.currency,
      } as CustomerWebhookEventDataByType[T];
    }
    case 'api_key.expiring': {
      const record = plainRecord(value, ['api_key_id', 'expires_at']);
      assertWebhookUuid(record.api_key_id, 'api_key_id');
      assertWebhookTimestamp(record.expires_at, 'expires_at');
      return { api_key_id: record.api_key_id, expires_at: record.expires_at } as CustomerWebhookEventDataByType[T];
    }
    case 'service_plan_order.status_changed': {
      const record = plainRecord(value, ['service_plan_order_id', 'status']);
      assertWebhookUuid(record.service_plan_order_id, 'service_plan_order_id');
      if (
        !['pending', 'paid', 'fulfilling', 'fulfilled', 'cancelled', 'reconciliation_pending'].includes(
          record.status as string,
        )
      ) {
        throw new TypeError('service plan order status is invalid');
      }
      return {
        service_plan_order_id: record.service_plan_order_id,
        status: record.status,
      } as CustomerWebhookEventDataByType[T];
    }
    case 'refund.status_changed': {
      const record = plainRecord(value, ['refund_id', 'status', 'amount_minor_units', 'currency']);
      assertWebhookUuid(record.refund_id, 'refund_id');
      if (!['submitting', 'pending', 'succeeded', 'failed', 'unknown', 'blocked'].includes(record.status as string)) {
        throw new TypeError('refund status is invalid');
      }
      assertSafeInteger(record.amount_minor_units, 'amount_minor_units', 1);
      assertCurrency(record.currency);
      return {
        refund_id: record.refund_id,
        status: record.status,
        amount_minor_units: record.amount_minor_units,
        currency: record.currency,
      } as CustomerWebhookEventDataByType[T];
    }
    case 'request.completed': {
      const record = plainRecord(value, ['request_id', 'project_id', 'supply_mode', 'status', 'duration_ms']);
      assertWebhookUuid(record.request_id, 'request_id');
      assertWebhookUuid(record.project_id, 'project_id');
      assertSupplyMode(record.supply_mode);
      if (record.status !== 'succeeded' && record.status !== 'failed') throw new TypeError('request status is invalid');
      assertSafeInteger(record.duration_ms, 'duration_ms');
      if ((record.duration_ms as number) > 86_400_000) throw new TypeError('duration_ms exceeds the event limit');
      return {
        request_id: record.request_id,
        project_id: record.project_id,
        supply_mode: record.supply_mode,
        status: record.status,
        duration_ms: record.duration_ms,
      } as CustomerWebhookEventDataByType[T];
    }
    case 'usage.completed': {
      const record = plainRecord(value, [
        'request_id',
        'project_id',
        'supply_mode',
        'input_tokens',
        'output_tokens',
        'total_tokens',
      ]);
      assertWebhookUuid(record.request_id, 'request_id');
      assertWebhookUuid(record.project_id, 'project_id');
      assertSupplyMode(record.supply_mode);
      assertSafeInteger(record.input_tokens, 'input_tokens');
      assertSafeInteger(record.output_tokens, 'output_tokens');
      assertSafeInteger(record.total_tokens, 'total_tokens');
      if ((record.input_tokens as number) + (record.output_tokens as number) !== record.total_tokens) {
        throw new TypeError('total_tokens must equal input_tokens plus output_tokens');
      }
      return {
        request_id: record.request_id,
        project_id: record.project_id,
        supply_mode: record.supply_mode,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        total_tokens: record.total_tokens,
      } as CustomerWebhookEventDataByType[T];
    }
    case 'platform.maintenance': {
      const record = plainRecord(value, ['starts_at', 'ends_at', 'impact']);
      assertWebhookTimestamp(record.starts_at, 'starts_at');
      assertWebhookTimestamp(record.ends_at, 'ends_at');
      if (Date.parse(record.ends_at) <= Date.parse(record.starts_at)) {
        throw new TypeError('maintenance end must follow its start');
      }
      if (record.impact !== 'none' && record.impact !== 'degraded' && record.impact !== 'outage') {
        throw new TypeError('maintenance impact is invalid');
      }
      return {
        starts_at: record.starts_at,
        ends_at: record.ends_at,
        impact: record.impact,
      } as CustomerWebhookEventDataByType[T];
    }
    default: {
      const exhaustive: never = eventType;
      throw new TypeError(`unsupported webhook event type: ${String(exhaustive)}`);
    }
  }
}

export function createCustomerWebhookEnvelope<T extends CustomerWebhookEventType>(input: {
  readonly eventId: string;
  readonly eventType: T;
  readonly occurredAt: string;
  readonly data: unknown;
}): CustomerWebhookEnvelope<T> {
  assertWebhookUuid(input.eventId, 'event_id');
  assertWebhookTimestamp(input.occurredAt, 'occurred_at');
  return Object.freeze({
    event_id: input.eventId,
    event_type: input.eventType,
    schema_version: CUSTOMER_WEBHOOK_SCHEMA_VERSION,
    occurred_at: input.occurredAt,
    data: validateCustomerWebhookEventData(input.eventType, input.data),
  });
}

export function customerWebhookDataReferencesTenantScopedResource(
  eventType: CustomerWebhookEventType,
  data: CustomerWebhookEventDataByType[CustomerWebhookEventType],
): boolean {
  // Branded by the caller's composite tenant-scoped lookup before insert.
  return (
    (eventType === 'api_key.expiring' && 'api_key_id' in data) ||
    (eventType === 'service_plan_order.status_changed' && 'service_plan_order_id' in data) ||
    (eventType === 'refund.status_changed' && 'refund_id' in data) ||
    ((eventType === 'request.completed' || eventType === 'usage.completed') && 'request_id' in data)
  );
}

export function isWebhookTargetIpLiteral(hostname: string): boolean {
  return isIP(hostname) !== 0;
}
