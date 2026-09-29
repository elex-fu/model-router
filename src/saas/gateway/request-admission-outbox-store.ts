import { randomUUID } from 'node:crypto';
import type { SaasDatabase } from '../db/types.js';

const REQUEST_ADMISSION_OUTBOX_TABLE = 'saas_request_admission_outbox';
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE = 'request.admitted' as const;
const SUPPLY_MODES = ['byok', 'platform'] as const;
const MAX_CLAIM_BATCH_SIZE = 100;
const MAX_LEASE_MS = 5 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 2_147_483_647;

type SupplyMode = (typeof SUPPLY_MODES)[number];

export interface RequestAdmissionOutboxPayload {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly request_id: string;
  readonly attempt_id: string;
  readonly supply_mode: SupplyMode;
  readonly schema_version: number;
}

export interface RequestAdmissionOutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly supplyMode: SupplyMode;
  readonly eventKey: string;
  readonly eventType: typeof EVENT_TYPE;
  readonly schemaVersion: number;
  readonly payload: RequestAdmissionOutboxPayload;
  readonly leaseToken: string;
  readonly deliveryAttempts: number;
}

interface ClaimRow {
  id: unknown;
  tenant_id: unknown;
  project_id: unknown;
  request_id: unknown;
  attempt_id: unknown;
  supply_mode: unknown;
  event_key: unknown;
  event_type: unknown;
  schema_version: unknown;
  payload: unknown;
  lease_token: unknown;
  delivery_attempts: unknown;
}

function assertPositiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (value > maximum) {
    throw new RangeError(`${name} must be at most ${maximum}`);
  }
}

function assertNonEmptyText(value: unknown, name: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new TypeError(`Invalid ${name}`);
  }
}

function assertUuidText(value: unknown, name: string): asserts value is string {
  assertNonEmptyText(value, name, 255);
  if (!UUID_TEXT.test(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
}

function copyAndValidatePayload(
  value: unknown,
  expected: Pick<
    RequestAdmissionOutboxEvent,
    'tenantId' | 'projectId' | 'requestId' | 'attemptId' | 'supplyMode' | 'schemaVersion'
  >,
): RequestAdmissionOutboxPayload {
  const payload = typeof value === 'string' ? parsePayload(value) : value;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Outbox payload must be a JSON object');
  }

  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['attempt_id', 'project_id', 'request_id', 'schema_version', 'supply_mode', 'tenant_id'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError('Outbox payload contains unsupported fields');
  }

  assertUuidText(record.tenant_id, 'payload.tenant_id');
  assertUuidText(record.project_id, 'payload.project_id');
  assertUuidText(record.request_id, 'payload.request_id');
  assertUuidText(record.attempt_id, 'payload.attempt_id');
  if (!SUPPLY_MODES.includes(record.supply_mode as SupplyMode)) {
    throw new TypeError('Invalid payload.supply_mode');
  }
  if (
    typeof record.schema_version !== 'number' ||
    !Number.isInteger(record.schema_version) ||
    record.schema_version < 1 ||
    record.schema_version > 1000
  ) {
    throw new TypeError('Invalid payload.schema_version');
  }

  if (
    record.tenant_id !== expected.tenantId ||
    record.project_id !== expected.projectId ||
    record.request_id !== expected.requestId ||
    record.attempt_id !== expected.attemptId ||
    record.supply_mode !== expected.supplyMode ||
    record.schema_version !== expected.schemaVersion
  ) {
    throw new TypeError('Outbox payload does not match its row identity');
  }

  return {
    tenant_id: record.tenant_id,
    project_id: record.project_id,
    request_id: record.request_id,
    attempt_id: record.attempt_id,
    supply_mode: record.supply_mode as SupplyMode,
    schema_version: record.schema_version,
  };
}

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError('Outbox payload must be valid JSON');
  }
}

function rowToEvent(row: ClaimRow): RequestAdmissionOutboxEvent {
  assertUuidText(row.id, 'id');
  assertUuidText(row.tenant_id, 'tenant_id');
  assertUuidText(row.project_id, 'project_id');
  assertUuidText(row.request_id, 'request_id');
  assertUuidText(row.attempt_id, 'attempt_id');
  assertNonEmptyText(row.supply_mode, 'supply_mode', 16);
  if (!SUPPLY_MODES.includes(row.supply_mode as SupplyMode)) {
    throw new TypeError('Invalid supply_mode');
  }
  assertNonEmptyText(row.event_key, 'event_key', 512);
  if (row.event_type !== EVENT_TYPE) {
    throw new TypeError('Invalid event_type');
  }
  if (
    typeof row.schema_version !== 'number' ||
    !Number.isInteger(row.schema_version) ||
    row.schema_version < 1 ||
    row.schema_version > 1000
  ) {
    throw new TypeError('Invalid schema_version');
  }
  if (!Number.isSafeInteger(row.delivery_attempts) || (row.delivery_attempts as number) < 1) {
    throw new TypeError('Invalid delivery_attempts');
  }
  assertNonEmptyText(row.lease_token, 'lease_token', 255);

  const tenantId = row.tenant_id;
  const projectId = row.project_id;
  const requestId = row.request_id;
  const attemptId = row.attempt_id;
  const supplyMode = row.supply_mode as SupplyMode;
  const schemaVersion = row.schema_version;

  return {
    id: row.id,
    tenantId,
    projectId,
    requestId,
    attemptId,
    supplyMode,
    eventKey: row.event_key,
    eventType: EVENT_TYPE,
    schemaVersion,
    payload: copyAndValidatePayload(row.payload, {
      tenantId,
      projectId,
      requestId,
      attemptId,
      supplyMode,
      schemaVersion,
    }),
    leaseToken: row.lease_token,
    deliveryAttempts: row.delivery_attempts as number,
  };
}

function assertId(value: string, name: string): void {
  assertUuidText(value, name);
}

function assertLeaseToken(value: string): void {
  assertNonEmptyText(value, 'leaseToken', 255);
}

function assertAvailableAt(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('availableAt must be a valid Date');
  }
}

/**
 * Metadata-only outbox lease store; it never dispatches requests.
 * Delivery is at-least-once, so consumers must dedupe by `(tenantId, eventKey)`.
 */
export class PostgresRequestAdmissionOutboxStore {
  constructor(private readonly database: SaasDatabase) {}

  async claimReady(limit: number, leaseMs: number): Promise<RequestAdmissionOutboxEvent[]> {
    assertPositiveInteger(limit, 'limit', MAX_CLAIM_BATCH_SIZE);
    assertPositiveInteger(leaseMs, 'leaseMs', MAX_LEASE_MS);

    return this.database.transaction(async (tx) => {
      const ready = await tx.query<Pick<ClaimRow, 'id'>>(
        `SELECT id
         FROM ${REQUEST_ADMISSION_OUTBOX_TABLE}
         WHERE (
           (delivery_state IN ('pending', 'failed') AND available_at <= clock_timestamp())
           OR
           (delivery_state = 'leased' AND lease_expires_at <= clock_timestamp())
         )
           AND delivery_attempts < ${MAX_DELIVERY_ATTEMPTS}
         ORDER BY created_at ASC, id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );

      const claimed: RequestAdmissionOutboxEvent[] = [];
      for (const row of ready.rows) {
        assertUuidText(row.id, 'id');
        const leaseToken = randomUUID();
        const result = await tx.query<ClaimRow>(
          `UPDATE ${REQUEST_ADMISSION_OUTBOX_TABLE}
           SET delivery_state = 'leased',
               lease_token = $2,
               lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
               delivery_attempts = delivery_attempts + 1,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING id, tenant_id, project_id, request_id, attempt_id, supply_mode,
                     event_key, event_type, schema_version, payload, lease_token, delivery_attempts`,
          [row.id, leaseToken, leaseMs],
        );

        if (result.rowCount !== 1 || result.rows.length !== 1) {
          throw new Error('Request admission outbox claim did not update exactly one row');
        }
        claimed.push(rowToEvent(result.rows[0]));
      }
      return claimed;
    });
  }

  async markDelivered(id: string, leaseToken: string): Promise<boolean> {
    assertId(id, 'id');
    assertLeaseToken(leaseToken);

    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE ${REQUEST_ADMISSION_OUTBOX_TABLE}
         SET delivery_state = 'delivered',
             delivered_at = clock_timestamp(),
             lease_token = NULL,
             lease_expires_at = NULL,
             last_error_code = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND lease_token = $2
           AND delivery_state = 'leased'
           AND lease_expires_at > clock_timestamp()`,
        [id, leaseToken],
      );
      return result.rowCount === 1;
    });
  }

  async rescheduleFailure(id: string, leaseToken: string, availableAt: Date, safeErrorCode: string): Promise<boolean> {
    assertId(id, 'id');
    assertLeaseToken(leaseToken);
    assertAvailableAt(availableAt);
    if (!SAFE_ERROR_CODE.test(safeErrorCode)) {
      throw new TypeError('safeErrorCode must match ^[A-Z][A-Z0-9_]{0,63}$');
    }

    return this.database.transaction(async (tx) => {
      const result = await tx.query(
        `UPDATE ${REQUEST_ADMISSION_OUTBOX_TABLE}
         SET delivery_state = 'failed',
             available_at = $3,
             last_error_code = $4,
             lease_token = NULL,
             lease_expires_at = NULL,
             delivered_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND lease_token = $2
           AND delivery_state = 'leased'
           AND lease_expires_at > clock_timestamp()`,
        [id, leaseToken, availableAt, safeErrorCode],
      );
      return result.rowCount === 1;
    });
  }
}
