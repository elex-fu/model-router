import { randomUUID } from 'node:crypto';
import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import type { CustomerWebhookActorContext } from './endpoint-service.js';
import {
  assertWebhookTimestamp,
  assertWebhookUuid,
  CUSTOMER_WEBHOOK_EVENT_TYPES,
  CUSTOMER_WEBHOOK_SCHEMA_VERSION,
  type CustomerWebhookEventDataByType,
  type CustomerWebhookEventType,
  createCustomerWebhookEnvelope,
  validateCustomerWebhookEventData,
} from './events.js';

export const CUSTOMER_WEBHOOK_MAX_ATTEMPTS = 12;
export const CUSTOMER_WEBHOOK_MAX_REPLAYS = 9;
export const CUSTOMER_WEBHOOK_MAX_CLAIM_BATCH_SIZE = 32;
export const CUSTOMER_WEBHOOK_MAX_LEASE_MS = 5 * 60 * 1000;
export const CUSTOMER_WEBHOOK_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const CUSTOMER_WEBHOOK_DEFAULT_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const CUSTOMER_WEBHOOK_MIN_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CUSTOMER_WEBHOOK_MAX_HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,255}$/;

export interface EnqueueCustomerWebhookEventInput<T extends CustomerWebhookEventType> {
  readonly tenantId: string;
  readonly eventId?: string;
  readonly idempotencyKey: string;
  readonly eventType: T;
  readonly schemaVersion?: 1;
  readonly occurredAt: Date | string;
  readonly data: CustomerWebhookEventDataByType[T];
}

export interface EnqueueCustomerWebhookEventResult {
  readonly eventId: string;
  readonly created: boolean;
  readonly deliveryCount: number;
}

/**
 * The caller must inject the current plan/tenant/project event-entitlement
 * authority. It receives the business transaction and must fail closed. This
 * deliberately avoids treating an endpoint subscription as a purchased
 * feature grant.
 */
export interface CustomerWebhookEventEntitlementPolicy {
  assertEntitled<T extends CustomerWebhookEventType>(input: {
    readonly tx: SqlExecutor;
    readonly tenantId: string;
    readonly eventType: T;
    readonly data: CustomerWebhookEventDataByType[T];
  }): Promise<void>;
}

interface EventRow {
  event_id: unknown;
  event_type: unknown;
  schema_version: unknown;
  occurred_at: unknown;
  payload: unknown;
  tenant_id: unknown;
  idempotency_key: unknown;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw new TypeError('idempotencyKey must be 1-255 safe ASCII characters');
  }
  return value;
}

function isoTimestamp(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : value;
  assertWebhookTimestamp(result, 'occurredAt');
  return result;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored webhook ${field} is invalid`);
  }
}

function matchingIdempotentEventId<T extends CustomerWebhookEventType>(input: {
  readonly row: EventRow | undefined;
  readonly eventType: T;
  readonly occurredAt: string;
  readonly data: CustomerWebhookEventDataByType[T];
  readonly eventId?: string;
}): string {
  const { row } = input;
  if (!row || row.event_type !== input.eventType || Number(row.schema_version) !== CUSTOMER_WEBHOOK_SCHEMA_VERSION) {
    throw new Error('WEBHOOK_IDEMPOTENCY_CONFLICT');
  }
  const eventId = row.event_id;
  assertWebhookUuid(eventId, 'stored event_id');
  const storedPayload = JSON.stringify(
    validateCustomerWebhookEventData(input.eventType, parseJson(row.payload, 'event payload')),
  );
  const storedTime =
    row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(String(row.occurred_at)).toISOString();
  if (
    storedTime !== input.occurredAt ||
    storedPayload !== JSON.stringify(input.data) ||
    (input.eventId !== undefined && input.eventId !== eventId)
  ) {
    throw new Error('WEBHOOK_IDEMPOTENCY_CONFLICT');
  }
  return eventId;
}

function eventDataReferences<T extends CustomerWebhookEventType>(
  type: T,
  data: CustomerWebhookEventDataByType[T],
): {
  apiKeyId: string | null;
  servicePlanOrderId: string | null;
  refundId: string | null;
  requestId: string | null;
  projectId: string | null;
  requestSupplyMode: 'byok' | 'platform' | null;
} {
  const fields = data as unknown as Record<string, unknown>;
  switch (type) {
    case 'api_key.expiring':
      return {
        apiKeyId: String(fields.api_key_id),
        servicePlanOrderId: null,
        refundId: null,
        requestId: null,
        projectId: null,
        requestSupplyMode: null,
      };
    case 'service_plan_order.status_changed':
      return {
        apiKeyId: null,
        servicePlanOrderId: String(fields.service_plan_order_id),
        refundId: null,
        requestId: null,
        projectId: null,
        requestSupplyMode: null,
      };
    case 'refund.status_changed':
      return {
        apiKeyId: null,
        servicePlanOrderId: null,
        refundId: String(fields.refund_id),
        requestId: null,
        projectId: null,
        requestSupplyMode: null,
      };
    case 'request.completed':
    case 'usage.completed':
      return {
        apiKeyId: null,
        servicePlanOrderId: null,
        refundId: null,
        requestId: String(fields.request_id),
        projectId: String(fields.project_id),
        requestSupplyMode: fields.supply_mode as 'byok' | 'platform',
      };
    default:
      return {
        apiKeyId: null,
        servicePlanOrderId: null,
        refundId: null,
        requestId: null,
        projectId: null,
        requestSupplyMode: null,
      };
  }
}

async function assertEventResourceTenant<T extends CustomerWebhookEventType>(
  tx: SqlExecutor,
  tenantId: string,
  eventType: T,
  data: CustomerWebhookEventDataByType[T],
): Promise<void> {
  const fields = data as unknown as Record<string, unknown>;
  let sql: string | undefined;
  let resourceId: string | undefined;
  switch (eventType) {
    case 'api_key.expiring':
      sql = `SELECT 1 FROM saas_api_keys WHERE tenant_id = $1 AND id = $2 AND status = 'active' AND expires_at IS NOT NULL AND expires_at = $3::timestamptz`;
      resourceId = String(fields.api_key_id);
      break;
    case 'service_plan_order.status_changed':
      sql = `SELECT 1 FROM saas_service_plan_orders WHERE tenant_id = $1 AND id = $2 AND state = $3`;
      resourceId = String(fields.service_plan_order_id);
      break;
    case 'refund.status_changed':
      sql = `SELECT 1 FROM saas_refund_orders WHERE tenant_id = $1 AND id = $2 AND state = $3 AND amount_minor_units = $4::bigint AND currency = $5`;
      resourceId = String(fields.refund_id);
      break;
    case 'request.completed':
      sql = `SELECT 1 FROM saas_requests
             WHERE tenant_id = $1 AND id = $2 AND project_id = $3 AND supply_mode = $4 AND execution_state = $5`;
      resourceId = String(fields.request_id);
      break;
    case 'usage.completed':
      sql = `SELECT 1 FROM saas_requests WHERE tenant_id = $1 AND id = $2 AND project_id = $3 AND supply_mode = $4`;
      resourceId = String(fields.request_id);
      break;
    default:
      return;
  }
  const values: unknown[] = [tenantId, resourceId];
  if (eventType === 'api_key.expiring') values.push(fields.expires_at);
  if (eventType === 'service_plan_order.status_changed') values.push(fields.status);
  if (eventType === 'refund.status_changed') values.push(fields.status, fields.amount_minor_units, fields.currency);
  if (eventType === 'request.completed') {
    values.push(fields.project_id, fields.supply_mode, fields.status);
  }
  if (eventType === 'usage.completed') values.push(fields.project_id, fields.supply_mode);
  const result = await tx.query(sql, values);
  if (result.rowCount !== 1) throw new Error('WEBHOOK_EVENT_RESOURCE_TENANT_MISMATCH');
}

async function withWebhookEnqueueSavepoint<T>(tx: SqlExecutor, work: () => Promise<T>): Promise<T> {
  const savepoint = 'model_router_customer_webhook_enqueue';
  await tx.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await work();
    await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try {
      await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch {
      // Keep the original failure; the caller still owns the outer transaction.
    }
    try {
      await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // A transaction-level failure is surfaced by the caller's transaction wrapper.
    }
    throw error;
  }
}

/**
 * Enqueue inside an existing business SqlExecutor transaction. It performs
 * only SQL work; endpoint snapshots and event facts commit atomically with the
 * caller's business state and no network call is made.
 */
export async function enqueueCustomerWebhookEvent<T extends CustomerWebhookEventType>(
  tx: SqlExecutor,
  input: EnqueueCustomerWebhookEventInput<T>,
  entitlement: CustomerWebhookEventEntitlementPolicy,
): Promise<EnqueueCustomerWebhookEventResult> {
  assertWebhookUuid(input.tenantId, 'tenantId');
  const key = idempotencyKey(input.idempotencyKey);
  const eventType = input.eventType;
  if (!CUSTOMER_WEBHOOK_EVENT_TYPES.includes(eventType)) throw new TypeError('unsupported webhook event type');
  if (input.schemaVersion !== undefined && input.schemaVersion !== CUSTOMER_WEBHOOK_SCHEMA_VERSION) {
    throw new TypeError('unsupported webhook schema version');
  }
  const occurredAt = isoTimestamp(input.occurredAt);
  const data = validateCustomerWebhookEventData(eventType, input.data);
  if (!entitlement || typeof entitlement.assertEntitled !== 'function') {
    throw new TypeError('a tenant webhook event-entitlement policy is required');
  }
  await entitlement.assertEntitled({ tx, tenantId: input.tenantId, eventType, data });
  const eventId = input.eventId ?? randomUUID();
  assertWebhookUuid(eventId, 'eventId');
  const existingBeforeResourceCheck = await tx.query<EventRow>(
    `SELECT event_id, event_type, schema_version, occurred_at, payload, tenant_id, idempotency_key
     FROM saas_customer_webhook_events WHERE tenant_id = $1 AND idempotency_key = $2`,
    [input.tenantId, key],
  );
  if ((existingBeforeResourceCheck.rowCount ?? 0) > 0) {
    if (existingBeforeResourceCheck.rowCount !== 1) throw new Error('WEBHOOK_IDEMPOTENCY_CONFLICT');
    const existingEventId = matchingIdempotentEventId({
      row: existingBeforeResourceCheck.rows[0],
      eventType,
      occurredAt,
      data,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    });
    return Object.freeze({ eventId: existingEventId, created: false, deliveryCount: 0 });
  }
  const quota = await lockEnabledTenantQuota(tx, input.tenantId);
  const targetCountResult = await tx.query<{ target_count: unknown }>(
    `SELECT count(*) AS target_count
     FROM saas_customer_webhook_endpoints e
     JOIN saas_customer_webhook_endpoint_versions v
       ON v.tenant_id = e.tenant_id AND v.endpoint_id = e.id AND v.version = e.current_version
     JOIN saas_customer_webhook_signing_secrets current_secret
       ON current_secret.tenant_id = e.tenant_id AND current_secret.endpoint_id = e.id
        AND current_secret.state = 'current'
     WHERE e.tenant_id = $1 AND e.state = 'active' AND $2 = ANY(v.event_types)`,
    [input.tenantId, eventType],
  );
  const targetCount = Number(targetCountResult.rows[0]?.target_count ?? 0);
  if (!Number.isSafeInteger(targetCount) || targetCount < 0 || targetCount > 100) {
    throw new Error('WEBHOOK_ENDPOINT_TARGET_COUNT_INVALID');
  }
  const references = eventDataReferences(eventType, data);
  return withWebhookEnqueueSavepoint(tx, async () => {
    const inserted = await tx.query<{ event_id: unknown }>(
      `INSERT INTO saas_customer_webhook_events
       (tenant_id, event_id, idempotency_key, event_type, schema_version, occurred_at, payload,
        api_key_id, service_plan_order_id, refund_id, request_id, project_id, request_supply_mode)
     VALUES ($1, $2, $3, $4, 1, $5::timestamptz, $6::jsonb,
             $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
     RETURNING event_id`,
      [
        input.tenantId,
        eventId,
        key,
        eventType,
        occurredAt,
        JSON.stringify(data),
        references.apiKeyId,
        references.servicePlanOrderId,
        references.refundId,
        references.requestId,
        references.projectId,
        references.requestSupplyMode,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await tx.query<EventRow>(
        `SELECT event_id, event_type, schema_version, occurred_at, payload, tenant_id, idempotency_key
       FROM saas_customer_webhook_events WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, key],
      );
      if (existing.rowCount !== 1) throw new Error('WEBHOOK_IDEMPOTENCY_CONFLICT');
      const existingEventId = matchingIdempotentEventId({
        row: existing.rows[0],
        eventType,
        occurredAt,
        data,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      });
      return Object.freeze({ eventId: existingEventId, created: false, deliveryCount: 0 });
    }
    assertWebhookUuid(inserted.rows[0]?.event_id, 'inserted event_id');
    // A retry that conflicts on the tenant-scoped idempotency key returns the
    // already-validated immutable event even if its source row has advanced.
    await assertEventResourceTenant(tx, input.tenantId, eventType, data);
    if (targetCount > 0) await reserveTenantWebhookQuota(tx, input.tenantId, targetCount, quota);
    const deliveries = await tx.query(
      `INSERT INTO saas_customer_webhook_deliveries
       (tenant_id, id, event_id, endpoint_id, endpoint_version, secret_version, overlap_secret_version, payload_version)
     SELECT e.tenant_id, gen_random_uuid(), $2, e.id, v.version, current_secret.secret_version,
            overlap_secret.secret_version, 1
     FROM saas_customer_webhook_endpoints e
     JOIN saas_customer_webhook_endpoint_versions v
       ON v.tenant_id = e.tenant_id AND v.endpoint_id = e.id AND v.version = e.current_version
     JOIN saas_customer_webhook_signing_secrets current_secret
       ON current_secret.tenant_id = e.tenant_id AND current_secret.endpoint_id = e.id
      AND current_secret.state = 'current'
     LEFT JOIN LATERAL (
       SELECT secret_version FROM saas_customer_webhook_signing_secrets
       WHERE tenant_id = e.tenant_id AND endpoint_id = e.id AND state = 'overlap'
         AND overlap_expires_at > clock_timestamp()
       ORDER BY secret_version DESC LIMIT 1
     ) overlap_secret ON TRUE
     WHERE e.tenant_id = $1 AND e.state = 'active' AND $3 = ANY(v.event_types)
     ON CONFLICT (tenant_id, event_id, endpoint_id) DO NOTHING`,
      [input.tenantId, eventId, eventType],
    );
    const deliveryCount = deliveries.rowCount ?? 0;
    if (deliveryCount !== targetCount) throw new Error('WEBHOOK_ENDPOINT_SNAPSHOT_CHANGED');
    return Object.freeze({ eventId, created: true, deliveryCount });
  });
}

export interface CustomerWebhookSecretEnvelopeSnapshot {
  readonly version: number;
  readonly envelope: Uint8Array;
}

export interface ClaimedCustomerWebhookDelivery {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly event: ReturnType<typeof createCustomerWebhookEnvelope>;
  readonly targetUrl: string;
  readonly endpointId: string;
  readonly endpointVersion: number;
  readonly payloadVersion: 1;
  readonly signingSecrets: readonly CustomerWebhookSecretEnvelopeSnapshot[];
  readonly attemptNumber: number;
  readonly attemptSequence: number;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

interface DeliveryCandidateRow {
  tenant_id: unknown;
  id: unknown;
  event_id: unknown;
  endpoint_id: unknown;
  endpoint_version: unknown;
  secret_version: unknown;
  overlap_secret_version: unknown;
  payload_version: unknown;
  attempt_count: unknown;
  attempt_sequence: unknown;
  lease_token: unknown;
  fencing_token: unknown;
}

interface DeliverySnapshotRow extends DeliveryCandidateRow {
  event_type: unknown;
  schema_version: unknown;
  occurred_at: unknown;
  payload: unknown;
  target_url: unknown;
  secret_envelope: unknown;
  overlap_secret_envelope: unknown;
}

function dbNumber(value: unknown, field: string, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`Stored webhook ${field} is invalid`);
  return number;
}

function dbText(value: unknown, field: string, max = 2048): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new Error(`Stored webhook ${field} is invalid`);
  return value;
}

function dbBytes(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 16_384) {
    throw new Error(`Stored webhook ${field} is invalid`);
  }
  return Buffer.from(value);
}

function dbIso(value: unknown, field: string): string {
  const timestamp = value instanceof Date ? value.toISOString() : String(value);
  assertWebhookTimestamp(timestamp, field);
  return timestamp;
}

function dbEventType(value: unknown): CustomerWebhookEventType {
  if (typeof value !== 'string' || !CUSTOMER_WEBHOOK_EVENT_TYPES.includes(value as CustomerWebhookEventType)) {
    throw new Error('Stored webhook event type is unsupported');
  }
  return value as CustomerWebhookEventType;
}

function mapDelivery(row: DeliverySnapshotRow): ClaimedCustomerWebhookDelivery {
  assertWebhookUuid(row.tenant_id, 'stored tenant_id');
  assertWebhookUuid(row.id, 'stored delivery id');
  assertWebhookUuid(row.event_id, 'stored event id');
  assertWebhookUuid(row.endpoint_id, 'stored endpoint id');
  const eventType = dbEventType(row.event_type);
  if (dbNumber(row.schema_version, 'schema_version', 1, 1) !== 1)
    throw new Error('Stored webhook schema version is invalid');
  const payload = validateCustomerWebhookEventData(eventType, parseJson(row.payload, 'payload'));
  const envelope = createCustomerWebhookEnvelope({
    eventId: row.event_id,
    eventType,
    occurredAt: dbIso(row.occurred_at, 'occurred_at'),
    data: payload,
  });
  const secretVersion = dbNumber(row.secret_version, 'secret_version', 1, 999_999_999);
  const signingSecrets: CustomerWebhookSecretEnvelopeSnapshot[] = [
    { version: secretVersion, envelope: dbBytes(row.secret_envelope, 'secret envelope') },
  ];
  if (row.overlap_secret_version !== null && row.overlap_secret_version !== undefined) {
    signingSecrets.push({
      version: dbNumber(row.overlap_secret_version, 'overlap secret version', 1, 999_999_999),
      envelope: dbBytes(row.overlap_secret_envelope, 'overlap secret envelope'),
    });
  }
  const attemptNumber = dbNumber(row.attempt_count, 'attempt_count', 1, CUSTOMER_WEBHOOK_MAX_ATTEMPTS);
  const attemptSequence = dbNumber(row.attempt_sequence, 'attempt_sequence', 1, 120);
  const fencingToken = dbNumber(row.fencing_token, 'fencing_token', 1, 120);
  const endpointVersion = dbNumber(row.endpoint_version, 'endpoint_version', 1, 999_999_999);
  const payloadVersion = dbNumber(row.payload_version, 'payload_version', 1, 1) as 1;
  return Object.freeze({
    tenantId: row.tenant_id,
    deliveryId: row.id,
    event: envelope,
    targetUrl: dbText(row.target_url, 'target_url'),
    endpointId: row.endpoint_id,
    endpointVersion,
    payloadVersion,
    signingSecrets: Object.freeze(signingSecrets),
    attemptNumber,
    attemptSequence,
    leaseToken: dbText(row.lease_token, 'lease_token', 64),
    fencingToken,
  });
}

export interface CustomerWebhookDeliveryFailure {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly latencyMs?: number;
}

function boundedLatency(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) throw new RangeError('latencyMs is invalid');
  return value;
}

function boundedHttpStatus(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) throw new RangeError('httpStatus is invalid');
  return value;
}

function validateClaim(limit: number, leaseMs: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CUSTOMER_WEBHOOK_MAX_CLAIM_BATCH_SIZE) {
    throw new RangeError(`limit must be between 1 and ${CUSTOMER_WEBHOOK_MAX_CLAIM_BATCH_SIZE}`);
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > CUSTOMER_WEBHOOK_MAX_LEASE_MS) {
    throw new RangeError(`leaseMs must be between 1 and ${CUSTOMER_WEBHOOK_MAX_LEASE_MS}`);
  }
}

function validateRetryPolicy(baseBackoffMs: number, maxBackoffMs: number): void {
  if (
    !Number.isSafeInteger(baseBackoffMs) ||
    baseBackoffMs < 10 ||
    !Number.isSafeInteger(maxBackoffMs) ||
    maxBackoffMs < baseBackoffMs ||
    maxBackoffMs > CUSTOMER_WEBHOOK_MAX_BACKOFF_MS
  ) {
    throw new RangeError('webhook retry backoff must be bounded and exponentially increasing');
  }
}

function retryDelayMs(attemptNumber: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attemptNumber - 1, 30));
}

interface TenantWebhookQuota {
  readonly maxEventsPerMinute: number;
  readonly maxPendingDeliveries: number;
}

async function lockEnabledTenantQuota(tx: SqlExecutor, tenantId: string): Promise<TenantWebhookQuota> {
  const result = await tx.query<{ enabled: unknown; max_events_per_minute: unknown; max_pending_deliveries: unknown }>(
    `SELECT enabled, max_events_per_minute, max_pending_deliveries
     FROM saas_customer_webhook_tenant_policies WHERE tenant_id = $1 FOR UPDATE`,
    [tenantId],
  );
  const row = result.rows[0];
  const maxEventsPerMinute = Number(row?.max_events_per_minute);
  const maxPendingDeliveries = Number(row?.max_pending_deliveries);
  if (result.rowCount !== 1 || row?.enabled !== true) throw new Error('WEBHOOK_TENANT_POLICY_DISABLED');
  if (
    !Number.isSafeInteger(maxEventsPerMinute) ||
    maxEventsPerMinute < 1 ||
    maxEventsPerMinute > 10_000 ||
    !Number.isSafeInteger(maxPendingDeliveries) ||
    maxPendingDeliveries < 1 ||
    maxPendingDeliveries > 100_000
  ) {
    throw new Error('WEBHOOK_TENANT_POLICY_INVALID');
  }
  return { maxEventsPerMinute, maxPendingDeliveries };
}

async function reserveTenantWebhookQuota(
  tx: SqlExecutor,
  tenantId: string,
  deliveryCount: number,
  quota: TenantWebhookQuota,
): Promise<void> {
  if (!Number.isSafeInteger(deliveryCount) || deliveryCount < 1) throw new RangeError('deliveryCount must be positive');
  await tx.query(
    `INSERT INTO saas_customer_webhook_tenant_usage (tenant_id, minute_bucket, events_in_bucket, pending_deliveries)
     VALUES ($1, date_trunc('minute', clock_timestamp()), 0, 0)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
  const reserved = await tx.query(
    `UPDATE saas_customer_webhook_tenant_usage
     SET minute_bucket = date_trunc('minute', clock_timestamp()),
         events_in_bucket = CASE
           WHEN minute_bucket = date_trunc('minute', clock_timestamp()) THEN events_in_bucket + 1
           ELSE 1 END,
         pending_deliveries = pending_deliveries + $2,
         updated_at = clock_timestamp()
     WHERE tenant_id = $1
       AND (minute_bucket <> date_trunc('minute', clock_timestamp()) OR events_in_bucket < $3)
       AND pending_deliveries + $2 <= $4
     RETURNING tenant_id`,
    [tenantId, deliveryCount, quota.maxEventsPerMinute, quota.maxPendingDeliveries],
  );
  if (reserved.rowCount !== 1) throw new Error('WEBHOOK_TENANT_QUOTA_EXCEEDED');
}

async function adjustPendingDeliveryQuota(tx: SqlExecutor, tenantId: string, delta: number): Promise<void> {
  if (delta === 0) return;
  if (!Number.isSafeInteger(delta) || Math.abs(delta) > 100_000) throw new RangeError('pending quota delta is invalid');
  if (delta > 0) {
    await tx.query(
      `INSERT INTO saas_customer_webhook_tenant_usage (tenant_id, minute_bucket, events_in_bucket, pending_deliveries)
       VALUES ($1, date_trunc('minute', clock_timestamp()), 0, 0)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }
  const result = await tx.query(
    `UPDATE saas_customer_webhook_tenant_usage
     SET pending_deliveries = pending_deliveries + $2, updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND pending_deliveries + $2 BETWEEN 0 AND 100000
     RETURNING tenant_id`,
    [tenantId, delta],
  );
  if (result.rowCount !== 1) throw new Error('WEBHOOK_TENANT_QUOTA_ACCOUNTING_FAILED');
}

async function reserveReplayDeliveryQuota(tx: SqlExecutor, tenantId: string, quota: TenantWebhookQuota): Promise<void> {
  await tx.query(
    `INSERT INTO saas_customer_webhook_tenant_usage (tenant_id, minute_bucket, events_in_bucket, pending_deliveries)
     VALUES ($1, date_trunc('minute', clock_timestamp()), 0, 0)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
  const result = await tx.query(
    `UPDATE saas_customer_webhook_tenant_usage
     SET pending_deliveries = pending_deliveries + 1, updated_at = clock_timestamp()
     WHERE tenant_id = $1 AND pending_deliveries < $2 RETURNING tenant_id`,
    [tenantId, quota.maxPendingDeliveries],
  );
  if (result.rowCount !== 1) throw new Error('WEBHOOK_TENANT_QUOTA_EXCEEDED');
}

/** PostgreSQL transactional-outbox store and fenced delivery state machine. */
export class PostgresCustomerWebhookDeliveryStore {
  constructor(private readonly database: SaasDatabase) {}

  async claimReady(limit: number, leaseMs: number): Promise<ClaimedCustomerWebhookDelivery[]> {
    validateClaim(limit, leaseMs);
    return this.database.transaction(async (tx) => {
      await this.cancelInvalidSnapshots(tx);
      await this.deadLetterExhaustedLeases(tx);
      const candidates = await tx.query<DeliveryCandidateRow>(
        `SELECT d.tenant_id, d.id, d.event_id, d.endpoint_id, d.endpoint_version,
                d.secret_version, d.overlap_secret_version, d.payload_version,
                d.attempt_count, d.attempt_sequence, d.lease_token, d.fencing_token
         FROM saas_customer_webhook_deliveries d
         JOIN saas_customer_webhook_endpoints e
           ON e.tenant_id = d.tenant_id AND e.id = d.endpoint_id
         JOIN saas_customer_webhook_signing_secrets s
           ON s.tenant_id = d.tenant_id AND s.endpoint_id = d.endpoint_id AND s.secret_version = d.secret_version
         WHERE e.state = 'active' AND e.current_version = d.endpoint_version
           AND (s.state = 'current' OR (s.state = 'overlap' AND s.overlap_expires_at > clock_timestamp()))
           AND (d.overlap_secret_version IS NULL OR EXISTS (
             SELECT 1 FROM saas_customer_webhook_signing_secrets os
             WHERE os.tenant_id = d.tenant_id AND os.endpoint_id = d.endpoint_id
               AND os.secret_version = d.overlap_secret_version
               AND (os.state = 'current' OR (os.state = 'overlap' AND os.overlap_expires_at > clock_timestamp()))
           ))
           AND d.attempt_count < ${CUSTOMER_WEBHOOK_MAX_ATTEMPTS}
           AND d.attempt_sequence < 120
           AND ((d.state = 'pending' AND d.available_at <= clock_timestamp())
             OR (d.state = 'leased' AND d.lease_expires_at <= clock_timestamp()))
         ORDER BY d.available_at ASC, d.created_at ASC, d.id ASC
         LIMIT $1
         FOR UPDATE OF d SKIP LOCKED`,
        [limit],
      );
      const claimed: ClaimedCustomerWebhookDelivery[] = [];
      for (const candidate of candidates.rows) {
        assertWebhookUuid(candidate.tenant_id, 'candidate tenant_id');
        assertWebhookUuid(candidate.id, 'candidate delivery id');
        const oldAttempt = dbNumber(candidate.attempt_count, 'attempt_count', 0, CUSTOMER_WEBHOOK_MAX_ATTEMPTS - 1);
        const oldSequence = dbNumber(candidate.attempt_sequence, 'attempt_sequence', 0, 119);
        const oldLeaseToken = candidate.lease_token;
        const oldFence = dbNumber(candidate.fencing_token, 'fencing_token', 0, 119);
        if (oldLeaseToken !== null && oldLeaseToken !== undefined) {
          const expired = await tx.query(
            `UPDATE saas_customer_webhook_delivery_attempts
             SET state = 'retrying', error_code = 'LEASE_EXPIRED', finished_at = clock_timestamp()
             WHERE tenant_id = $1 AND delivery_id = $2 AND fencing_token = $3
               AND lease_token = $4 AND state = 'started'`,
            [candidate.tenant_id, candidate.id, oldFence, oldLeaseToken],
          );
          if (expired.rowCount !== 1) throw new Error('WEBHOOK_LEASE_ATTEMPT_MISSING');
        }
        const nextAttempt = oldAttempt + 1;
        const nextSequence = oldSequence + 1;
        const nextFence = oldFence + 1;
        const leaseToken = randomUUID();
        const updated = await tx.query(
          `UPDATE saas_customer_webhook_deliveries
           SET state = 'leased', attempt_count = $3, attempt_sequence = $4,
               fencing_token = $5, lease_token = $6,
               lease_expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
               updated_at = clock_timestamp()
           WHERE tenant_id = $1 AND id = $2
           RETURNING id`,
          [candidate.tenant_id, candidate.id, nextAttempt, nextSequence, nextFence, leaseToken, leaseMs],
        );
        if (updated.rowCount !== 1) throw new Error('WEBHOOK_DELIVERY_CLAIM_FAILED');
        const attemptInserted = await tx.query(
          `INSERT INTO saas_customer_webhook_delivery_attempts
             (tenant_id, delivery_id, attempt_sequence, fencing_token, lease_token, state)
           VALUES ($1, $2, $3, $4, $5, 'started')`,
          [candidate.tenant_id, candidate.id, nextSequence, nextFence, leaseToken],
        );
        if (attemptInserted.rowCount !== 1) throw new Error('WEBHOOK_DELIVERY_ATTEMPT_WRITE_FAILED');
        const snapshot = await tx.query<DeliverySnapshotRow>(
          `SELECT d.tenant_id, d.id, d.event_id, d.endpoint_id, d.endpoint_version,
                  d.secret_version, d.overlap_secret_version, d.payload_version,
                  d.attempt_count, d.attempt_sequence, d.lease_token, d.fencing_token,
                  ev.event_type, ev.schema_version, ev.occurred_at, ev.payload,
                  endpoint_version.target_url, primary_secret.encrypted_envelope AS secret_envelope,
                  overlap_secret.encrypted_envelope AS overlap_secret_envelope
           FROM saas_customer_webhook_deliveries d
           JOIN saas_customer_webhook_events ev
             ON ev.tenant_id = d.tenant_id AND ev.event_id = d.event_id
           JOIN saas_customer_webhook_endpoint_versions endpoint_version
             ON endpoint_version.tenant_id = d.tenant_id AND endpoint_version.endpoint_id = d.endpoint_id
              AND endpoint_version.version = d.endpoint_version
           JOIN saas_customer_webhook_signing_secrets primary_secret
             ON primary_secret.tenant_id = d.tenant_id AND primary_secret.endpoint_id = d.endpoint_id
              AND primary_secret.secret_version = d.secret_version
           LEFT JOIN saas_customer_webhook_signing_secrets overlap_secret
             ON overlap_secret.tenant_id = d.tenant_id AND overlap_secret.endpoint_id = d.endpoint_id
              AND overlap_secret.secret_version = d.overlap_secret_version
           WHERE d.tenant_id = $1 AND d.id = $2 AND d.lease_token = $3 AND d.fencing_token = $4`,
          [candidate.tenant_id, candidate.id, leaseToken, nextFence],
        );
        if (snapshot.rowCount !== 1) throw new Error('WEBHOOK_DELIVERY_SNAPSHOT_MISSING');
        claimed.push(mapDelivery(snapshot.rows[0]));
      }
      return claimed;
    });
  }

  async markDelivered(input: {
    tenantId: string;
    deliveryId: string;
    leaseToken: string;
    fencingToken: number;
    httpStatus: number;
    latencyMs: number;
  }): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const status = boundedHttpStatus(input.httpStatus);
      const latency = boundedLatency(input.latencyMs);
      if (status === null || status < 200 || status > 299 || latency === null)
        throw new RangeError('delivered outcome is invalid');
      const updated = await tx.query(
        `UPDATE saas_customer_webhook_deliveries
         SET state = 'delivered', delivered_at = clock_timestamp(),
             last_http_status = $5, last_latency_ms = $6, last_error_code = NULL,
             lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND fencing_token = $4
           AND state = 'leased' AND lease_expires_at > clock_timestamp()`,
        [input.tenantId, input.deliveryId, input.leaseToken, input.fencingToken, status, latency],
      );
      if (updated.rowCount !== 1) return false;
      const attempt = await tx.query(
        `UPDATE saas_customer_webhook_delivery_attempts
         SET state = 'delivered', http_status = $5, latency_ms = $6, finished_at = clock_timestamp()
         WHERE tenant_id = $1 AND delivery_id = $2 AND lease_token = $3
           AND fencing_token = $4 AND state = 'started'`,
        [input.tenantId, input.deliveryId, input.leaseToken, input.fencingToken, status, latency],
      );
      if (attempt.rowCount !== 1) throw new Error('WEBHOOK_DELIVERY_ATTEMPT_FENCE_MISMATCH');
      await adjustPendingDeliveryQuota(tx, input.tenantId, -1);
      return true;
    });
  }

  async recordFailure(
    input: CustomerWebhookDeliveryFailure,
    retryPolicy: { readonly baseBackoffMs: number; readonly maxBackoffMs: number } = {
      baseBackoffMs: 1_000,
      maxBackoffMs: 60 * 60 * 1000,
    },
  ): Promise<'retrying' | 'dead_lettered' | 'stale'> {
    if (!SAFE_ERROR_CODE.test(input.errorCode)) throw new TypeError('errorCode must be a safe code');
    validateRetryPolicy(retryPolicy.baseBackoffMs, retryPolicy.maxBackoffMs);
    const httpStatus = boundedHttpStatus(input.httpStatus);
    const latencyMs = boundedLatency(input.latencyMs);
    return this.database.transaction(async (tx) => {
      const current = await tx.query<{ attempt_count: unknown }>(
        `SELECT attempt_count FROM saas_customer_webhook_deliveries
         WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND fencing_token = $4
           AND state = 'leased' AND lease_expires_at > clock_timestamp()
         FOR UPDATE`,
        [input.tenantId, input.deliveryId, input.leaseToken, input.fencingToken],
      );
      if (current.rowCount !== 1) return 'stale';
      const attempts = dbNumber(current.rows[0]?.attempt_count, 'attempt_count', 1, CUSTOMER_WEBHOOK_MAX_ATTEMPTS);
      const terminal = !input.retryable || attempts >= CUSTOMER_WEBHOOK_MAX_ATTEMPTS;
      const state = terminal ? 'dead_lettered' : 'pending';
      const delay = terminal ? 0 : retryDelayMs(attempts, retryPolicy.baseBackoffMs, retryPolicy.maxBackoffMs);
      const updated = await tx.query(
        `UPDATE saas_customer_webhook_deliveries
         SET state = $5, last_http_status = $6, last_latency_ms = $7, last_error_code = $8,
             available_at = CASE WHEN $5 = 'pending'
               THEN clock_timestamp() + ($9::bigint * interval '1 millisecond') ELSE available_at END,
             delivered_at = NULL, lease_token = NULL, lease_expires_at = NULL,
             updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND lease_token = $3 AND fencing_token = $4
           AND state = 'leased' AND lease_expires_at > clock_timestamp()`,
        [
          input.tenantId,
          input.deliveryId,
          input.leaseToken,
          input.fencingToken,
          state,
          httpStatus,
          latencyMs,
          input.errorCode,
          delay,
        ],
      );
      if (updated.rowCount !== 1) return 'stale';
      const attempt = await tx.query(
        `UPDATE saas_customer_webhook_delivery_attempts
         SET state = $5, http_status = $6, latency_ms = $7, error_code = $8,
             finished_at = clock_timestamp()
         WHERE tenant_id = $1 AND delivery_id = $2 AND lease_token = $3
           AND fencing_token = $4 AND state = 'started'`,
        [
          input.tenantId,
          input.deliveryId,
          input.leaseToken,
          input.fencingToken,
          state === 'pending' ? 'retrying' : state,
          httpStatus,
          latencyMs,
          input.errorCode,
        ],
      );
      if (attempt.rowCount !== 1) throw new Error('WEBHOOK_DELIVERY_ATTEMPT_FENCE_MISMATCH');
      if (terminal) await adjustPendingDeliveryQuota(tx, input.tenantId, -1);
      return terminal ? 'dead_lettered' : 'retrying';
    });
  }

  /**
   * Delete bounded terminal delivery/attempt metadata after the configured
   * retention window. Immutable event facts and their tenant idempotency keys
   * remain as dedupe tombstones; active leases and retryable deliveries never
   * qualify for pruning.
   */
  async pruneTerminalHistory(
    input: { readonly retentionMs?: number; readonly limit?: number; readonly now?: Date } = {},
  ): Promise<{ readonly deliveries: number; readonly attempts: number }> {
    const retentionMs = input.retentionMs ?? CUSTOMER_WEBHOOK_DEFAULT_HISTORY_RETENTION_MS;
    const limit = input.limit ?? 100;
    const now = input.now ?? new Date();
    if (
      !Number.isSafeInteger(retentionMs) ||
      retentionMs < CUSTOMER_WEBHOOK_MIN_HISTORY_RETENTION_MS ||
      retentionMs > CUSTOMER_WEBHOOK_MAX_HISTORY_RETENTION_MS
    ) {
      throw new RangeError('webhook delivery retention must be between 7 and 365 days');
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError('retention batch limit must be between 1 and 1000');
    }
    const cutoff = new Date(now.getTime() - retentionMs);
    return this.database.transaction(async (tx) => {
      const old = await tx.query<{ tenant_id: unknown; id: unknown }>(
        `SELECT tenant_id, id
         FROM saas_customer_webhook_deliveries
         WHERE state IN ('delivered','dead_lettered','cancelled') AND updated_at <= $1
         ORDER BY updated_at ASC, tenant_id ASC, id ASC
         LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [cutoff, limit],
      );
      let attemptCount = 0;
      let deliveryCount = 0;
      for (const row of old.rows) {
        assertWebhookUuid(row.tenant_id, 'retention tenant_id');
        assertWebhookUuid(row.id, 'retention delivery_id');
        const removedAttempts = await tx.query(
          `DELETE FROM saas_customer_webhook_delivery_attempts
           WHERE tenant_id = $1 AND delivery_id = $2 AND state <> 'started'`,
          [row.tenant_id, row.id],
        );
        const pendingAttempt = await tx.query(
          `SELECT 1 FROM saas_customer_webhook_delivery_attempts
           WHERE tenant_id = $1 AND delivery_id = $2 AND state = 'started' LIMIT 1`,
          [row.tenant_id, row.id],
        );
        if (pendingAttempt.rowCount !== 0) throw new Error('WEBHOOK_RETENTION_FOUND_ACTIVE_ATTEMPT');
        const removedDelivery = await tx.query(
          `DELETE FROM saas_customer_webhook_deliveries
           WHERE tenant_id = $1 AND id = $2
             AND state IN ('delivered','dead_lettered','cancelled') AND updated_at <= $3`,
          [row.tenant_id, row.id, cutoff],
        );
        if (removedDelivery.rowCount !== 1) throw new Error('WEBHOOK_RETENTION_DELETE_CONFLICT');
        attemptCount += removedAttempts.rowCount ?? 0;
        deliveryCount += 1;
      }
      return Object.freeze({ deliveries: deliveryCount, attempts: attemptCount });
    });
  }

  async replayDeadLetter(actor: CustomerWebhookActorContext, deliveryId: string): Promise<boolean> {
    assertWebhookUuid(actor.tenantId, 'tenantId');
    assertWebhookUuid(actor.actorUserId, 'actorUserId');
    assertWebhookUuid(deliveryId, 'deliveryId');
    if (!actor.requestId || actor.requestId.length > 255) throw new TypeError('requestId is invalid');
    return this.database.transaction(async (tx) => {
      const member = await tx.query(
        `SELECT 1 FROM saas_memberships
         WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND role IN ('owner','admin') LIMIT 1`,
        [actor.tenantId, actor.actorUserId],
      );
      if (member.rowCount !== 1) throw new Error('WEBHOOK_FORBIDDEN');
      const quota = await lockEnabledTenantQuota(tx, actor.tenantId);
      const eligible = await tx.query(
        `SELECT 1
         FROM saas_customer_webhook_deliveries d
         JOIN saas_customer_webhook_endpoints e
           ON e.tenant_id = d.tenant_id AND e.id = d.endpoint_id
         JOIN saas_customer_webhook_signing_secrets s
           ON s.tenant_id = d.tenant_id AND s.endpoint_id = d.endpoint_id AND s.secret_version = d.secret_version
         WHERE d.tenant_id = $1 AND d.id = $2 AND d.state = 'dead_lettered'
           AND d.replay_count < ${CUSTOMER_WEBHOOK_MAX_REPLAYS} AND d.attempt_sequence < 120
           AND e.state = 'active' AND e.current_version = d.endpoint_version
           AND (s.state = 'current' OR (s.state = 'overlap' AND s.overlap_expires_at > clock_timestamp()))
         FOR UPDATE OF d`,
        [actor.tenantId, deliveryId],
      );
      if (eligible.rowCount !== 1) return false;
      await reserveReplayDeliveryQuota(tx, actor.tenantId, quota);
      const audit = await tx.query(
        `INSERT INTO saas_audit_events
           (id, tenant_id, actor_user_id, action, target_type, target_id, entry_point, request_id)
         VALUES ($1, $2, $3, 'customer_webhook.delivery_replayed', 'customer_webhook_delivery', $4, 'customer_webhook', $5)`,
        [randomUUID(), actor.tenantId, actor.actorUserId, deliveryId, actor.requestId],
      );
      if (audit.rowCount !== 1) throw new Error('WEBHOOK_AUDIT_WRITE_FAILED');
      const updated = await tx.query(
        `UPDATE saas_customer_webhook_deliveries
         SET state = 'pending', attempt_count = 0, replay_count = replay_count + 1,
             available_at = clock_timestamp(), last_http_status = NULL, last_latency_ms = NULL,
             last_error_code = NULL, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND id = $2 AND state = 'dead_lettered'
           AND replay_count < ${CUSTOMER_WEBHOOK_MAX_REPLAYS} AND attempt_sequence < 120`,
        [actor.tenantId, deliveryId],
      );
      if (updated.rowCount !== 1) throw new Error('WEBHOOK_REPLAY_STATE_CONFLICT');
      return true;
    });
  }

  private async cancelInvalidSnapshots(tx: SqlExecutor): Promise<void> {
    const cancelled = await tx.query<{ tenant_id: unknown }>(
      `UPDATE saas_customer_webhook_deliveries d
       SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           delivered_at = NULL,
           last_error_code = CASE
             WHEN e.state = 'revoked' THEN 'ENDPOINT_REVOKED'
             WHEN e.current_version <> d.endpoint_version THEN 'ENDPOINT_CONFIG_CHANGED'
             ELSE 'SIGNING_SECRET_REVOKED' END,
           updated_at = clock_timestamp()
       FROM saas_customer_webhook_endpoints e
       WHERE d.tenant_id = e.tenant_id AND d.endpoint_id = e.id
         AND d.state = 'pending'
         AND (e.state = 'revoked' OR e.current_version <> d.endpoint_version
           OR NOT EXISTS (
             SELECT 1 FROM saas_customer_webhook_signing_secrets s
             WHERE s.tenant_id = d.tenant_id AND s.endpoint_id = d.endpoint_id
               AND s.secret_version = d.secret_version
               AND (s.state = 'current' OR (s.state = 'overlap' AND s.overlap_expires_at > clock_timestamp()))
           )
           OR (d.overlap_secret_version IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM saas_customer_webhook_signing_secrets os
             WHERE os.tenant_id = d.tenant_id AND os.endpoint_id = d.endpoint_id
               AND os.secret_version = d.overlap_secret_version
               AND (os.state = 'current' OR (os.state = 'overlap' AND os.overlap_expires_at > clock_timestamp()))
           )))
       RETURNING d.tenant_id`,
      [],
    );
    const counts = new Map<string, number>();
    for (const row of cancelled.rows) {
      assertWebhookUuid(row.tenant_id, 'cancelled tenant_id');
      counts.set(row.tenant_id, (counts.get(row.tenant_id) ?? 0) + 1);
    }
    for (const [tenantId, count] of counts) await adjustPendingDeliveryQuota(tx, tenantId, -count);
  }

  private async deadLetterExhaustedLeases(tx: SqlExecutor): Promise<void> {
    const attempts = await tx.query(
      `UPDATE saas_customer_webhook_delivery_attempts a
       SET state = 'dead_lettered', error_code = 'ATTEMPTS_EXHAUSTED', finished_at = clock_timestamp()
       FROM saas_customer_webhook_deliveries d
       WHERE a.tenant_id = d.tenant_id AND a.delivery_id = d.id
         AND a.fencing_token = d.fencing_token AND a.lease_token = d.lease_token
         AND a.state = 'started' AND d.state = 'leased'
         AND d.attempt_count >= ${CUSTOMER_WEBHOOK_MAX_ATTEMPTS}
         AND d.lease_expires_at <= clock_timestamp()`,
      [],
    );
    if (attempts.rowCount && attempts.rowCount > 0) {
      const deliveries = await tx.query<{ tenant_id: unknown }>(
        `UPDATE saas_customer_webhook_deliveries
         SET state = 'dead_lettered', last_error_code = 'ATTEMPTS_EXHAUSTED',
             lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
         WHERE state = 'leased' AND attempt_count >= ${CUSTOMER_WEBHOOK_MAX_ATTEMPTS}
           AND lease_expires_at <= clock_timestamp()
         RETURNING tenant_id`,
        [],
      );
      if (deliveries.rowCount !== attempts.rowCount) throw new Error('WEBHOOK_EXHAUSTED_LEASE_RECONCILIATION_FAILED');
      for (const row of deliveries.rows) {
        assertWebhookUuid(row.tenant_id, 'exhausted tenant_id');
        await adjustPendingDeliveryQuota(tx, row.tenant_id, -1);
      }
    }
  }
}
