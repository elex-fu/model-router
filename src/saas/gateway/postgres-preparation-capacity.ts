import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import type {
  PostgresPreparationCapacityPort,
  PostgresPreparationCapacityReservation,
} from './postgres-preparation-ports.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationDecision,
  rejectRequestPreparation,
} from './request-preparation-service.js';

type Row = Record<string, unknown>;

const SAFE_CAPACITY_FAILURE = 'Request capacity authority could not be established.';
const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const JS_SAFE_INTEGER_MAX = BigInt(Number.MAX_SAFE_INTEGER);

interface CapacityAuthority extends Row {
  tenant_status: unknown;
  project_status: unknown;
  project_policy_version: unknown;
  policy_version: unknown;
  policy_status: unknown;
  key_status: unknown;
  key_authz_version: unknown;
  supply_mode: unknown;
  key_expires_at: unknown;
  tenant_requests_per_minute: unknown;
  tenant_tokens_per_minute: unknown;
  tenant_max_concurrent_requests: unknown;
  project_requests_per_minute: unknown;
  project_tokens_per_minute: unknown;
  project_max_concurrent_requests: unknown;
  key_requests_per_minute: unknown;
  key_tokens_per_minute: unknown;
  key_max_concurrent_requests: unknown;
}

interface ReservationRow extends Row {
  tenant_id: unknown;
  project_id: unknown;
  proxy_key_id: unknown;
  request_id: unknown;
  supply_mode: unknown;
  project_policy_version: unknown;
  key_authz_version: unknown;
  idempotency_scope_key: unknown;
  request_fingerprint: unknown;
  request_fingerprint_version: unknown;
  token_units: unknown;
  quota_reservation_id: unknown;
  rate_reservation_id: unknown;
  state: unknown;
}

type SafeReservationRow = ReservationRow & {
  tenant_id: string;
  project_id: string;
  proxy_key_id: string;
  request_id: string;
  idempotency_scope_key: string;
  request_fingerprint: string;
  request_fingerprint_version: string;
  quota_reservation_id: string;
  rate_reservation_id: string;
  state: 'reserved' | 'released' | 'retained_for_reconciliation';
};

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function exactInteger(value: unknown): bigint | null {
  try {
    if (typeof value === 'bigint') return value >= 0n && value <= PG_BIGINT_MAX ? value : null;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
      const parsed = BigInt(value);
      return parsed <= PG_BIGINT_MAX ? parsed : null;
    }
  } catch {
    return null;
  }
  return null;
}

function positiveLimit(value: unknown): bigint | null {
  const parsed = exactInteger(value);
  return parsed !== null && parsed > 0n ? parsed : null;
}

function payloadTokenUnits(bounds: unknown): bigint | null {
  if (!bounds || typeof bounds !== 'object') return null;
  const usage = bounds as Record<string, unknown>;
  const input = exactInteger(usage.inputTotalUpperBound);
  const inputUncached = exactInteger(usage.inputUncachedUpperBound);
  const cacheRead = exactInteger(usage.cacheReadUpperBound);
  const cacheWrite = exactInteger(usage.cacheWriteUpperBound);
  const cacheWrite5m = exactInteger(usage.cacheWrite5mUpperBound);
  const cacheWrite1h = exactInteger(usage.cacheWrite1hUpperBound);
  const output = exactInteger(usage.outputTotalUpperBound);
  const reasoning = exactInteger(usage.reasoningOutputUpperBound);
  const buckets = usage.feasibleInputBuckets;
  if (
    input === null ||
    inputUncached === null ||
    cacheRead === null ||
    cacheWrite === null ||
    cacheWrite5m === null ||
    cacheWrite1h === null ||
    output === null ||
    reasoning === null ||
    inputUncached > input ||
    cacheRead > input ||
    cacheWrite > input ||
    cacheWrite5m + cacheWrite1h > cacheWrite ||
    reasoning > output ||
    !Array.isArray(buckets) ||
    buckets.length === 0 ||
    buckets.some((bucket) => !text(bucket)) ||
    new Set(buckets).size !== buckets.length
  )
    return null;
  const units = input + output;
  return units > 0n && units <= PG_BIGINT_MAX ? units : null;
}

function oneRow<T extends Row>(rows: readonly T[]): T | null {
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

function safeReservation(row: ReservationRow): row is SafeReservationRow {
  return (
    text(row.tenant_id) &&
    text(row.project_id) &&
    text(row.proxy_key_id) &&
    text(row.request_id) &&
    text(row.idempotency_scope_key) &&
    /^[0-9a-f]{64}$/.test(row.idempotency_scope_key) &&
    text(row.request_fingerprint) &&
    text(row.request_fingerprint_version) &&
    text(row.quota_reservation_id) &&
    text(row.rate_reservation_id) &&
    text(row.state) &&
    (row.state === 'reserved' || row.state === 'released' || row.state === 'retained_for_reconciliation')
  );
}

function capacityValue(row: ReservationRow): PostgresPreparationCapacityReservation | null {
  if (!safeReservation(row) || row.state !== 'reserved') return null;
  const tokens = exactInteger(row.token_units);
  if (tokens === null || tokens > JS_SAFE_INTEGER_MAX) return null;
  return {
    quotaReservation: { reference: row.quota_reservation_id, state: 'reserved' },
    rateReservation: { reference: row.rate_reservation_id, state: 'reserved' },
    retryBudget: 0,
    remainingAttempts: 1,
    usageBudget: { unit: 'tokens', amount: Number(tokens), basis: 'reserved' },
  };
}

async function queryRows<T extends Row>(
  executor: SqlExecutor,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await executor.query<T>(sql, values);
  if (!result || !Array.isArray(result.rows)) throw new Error('Invalid capacity SQL result');
  return result.rows;
}

async function takeScopeLock(executor: SqlExecutor, scope: string, id: string): Promise<void> {
  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `model-router:request-capacity:${scope}:${id}`,
  ]);
}

function authorityLimits(authority: CapacityAuthority): {
  tenant: { rpm: bigint; tpm: bigint; concurrency: bigint };
  project: { rpm: bigint; tpm: bigint; concurrency: bigint };
  key: { rpm: bigint; tpm: bigint; concurrency: bigint };
} | null {
  const values = [
    positiveLimit(authority.tenant_requests_per_minute),
    positiveLimit(authority.tenant_tokens_per_minute),
    positiveLimit(authority.tenant_max_concurrent_requests),
    positiveLimit(authority.project_requests_per_minute),
    positiveLimit(authority.project_tokens_per_minute),
    positiveLimit(authority.project_max_concurrent_requests),
    positiveLimit(authority.key_requests_per_minute),
    positiveLimit(authority.key_tokens_per_minute),
    positiveLimit(authority.key_max_concurrent_requests),
  ];
  if (values.some((value) => value === null)) return null;
  const [
    tenantRpm,
    tenantTpm,
    tenantConcurrency,
    projectRpm,
    projectTpm,
    projectConcurrency,
    keyRpm,
    keyTpm,
    keyConcurrency,
  ] = values as bigint[];
  return {
    tenant: { rpm: tenantRpm, tpm: tenantTpm, concurrency: tenantConcurrency },
    project: { rpm: projectRpm, tpm: projectTpm, concurrency: projectConcurrency },
    key: { rpm: keyRpm, tpm: keyTpm, concurrency: keyConcurrency },
  };
}

function sameIdentity(row: ReservationRow, input: Parameters<PostgresPreparationCapacityPort['reserve']>[1]): boolean {
  return (
    row.tenant_id === input.tenantId &&
    row.project_id === input.projectId &&
    row.proxy_key_id === input.proxyKeyId &&
    row.request_id === input.requestId &&
    row.supply_mode === input.supplyMode &&
    row.idempotency_scope_key === input.idempotencyScopeKey &&
    row.request_fingerprint === input.requestFingerprint &&
    row.request_fingerprint_version === input.requestFingerprintVersion &&
    exactInteger(row.token_units) === payloadTokenUnits(input.payloadBounds)
  );
}

/** PostgreSQL request capacity implementation. It never touches wallet tables. */
export class PostgresPreparationCapacityAdapter implements PostgresPreparationCapacityPort {
  async reserve(
    executor: SqlExecutor,
    input: Parameters<PostgresPreparationCapacityPort['reserve']>[1],
  ): Promise<RequestPreparationDecision<PostgresPreparationCapacityReservation>> {
    if (
      !executor ||
      !input ||
      !text(input.tenantId) ||
      !text(input.projectId) ||
      !text(input.proxyKeyId) ||
      !text(input.requestId) ||
      !text(input.attemptId) ||
      !text(input.idempotencyScopeKey) ||
      !/^[0-9a-f]{64}$/.test(input.idempotencyScopeKey) ||
      !text(input.requestFingerprint) ||
      !/^[0-9a-f]{64}$/.test(input.requestFingerprint) ||
      !text(input.requestFingerprintVersion)
    ) {
      return rejectRequestPreparation('invalid_input', SAFE_CAPACITY_FAILURE);
    }

    const tokenUnits = payloadTokenUnits(input.payloadBounds);
    if (tokenUnits === null || tokenUnits > JS_SAFE_INTEGER_MAX) {
      return rejectRequestPreparation('payload_bounds_unavailable', SAFE_CAPACITY_FAILURE);
    }

    try {
      /* Stable tenant -> project -> key lock order serializes every shared bucket. */
      await takeScopeLock(executor, 'tenant', input.tenantId);
      await takeScopeLock(executor, 'project', `${input.tenantId}:${input.projectId}`);
      await takeScopeLock(executor, 'key', `${input.tenantId}:${input.projectId}:${input.proxyKeyId}`);

      const existingRows = await queryRows<ReservationRow>(
        executor,
        `SELECT tenant_id, project_id, proxy_key_id, request_id, supply_mode,
                project_policy_version, key_authz_version, idempotency_scope_key,
                request_fingerprint, request_fingerprint_version, token_units,
                quota_reservation_id, rate_reservation_id, state
           FROM saas_gateway_capacity_reservations
          WHERE tenant_id = $1 AND request_id = $2
          LIMIT 2`,
        [input.tenantId, input.requestId],
      );
      if (existingRows.length > 1) return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
      if (existingRows.length === 1) {
        const existing = existingRows[0];
        if (!existing || !safeReservation(existing) || !sameIdentity(existing, input)) {
          return rejectRequestPreparation('idempotency_conflict', SAFE_CAPACITY_FAILURE);
        }
        const replay = capacityValue(existing);
        return replay
          ? allowRequestPreparation(replay)
          : blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      }

      const authorities = await queryRows<CapacityAuthority>(
        executor,
        `SELECT t.status AS tenant_status,
                t.requests_per_minute AS tenant_requests_per_minute,
                t.tokens_per_minute AS tenant_tokens_per_minute,
                t.max_concurrent_requests AS tenant_max_concurrent_requests,
                p.inference_policy_status AS project_status,
                p.inference_policy_version AS project_policy_version,
                policy.version AS policy_version,
                policy.status AS policy_status,
                policy.requests_per_minute AS project_requests_per_minute,
                policy.tokens_per_minute AS project_tokens_per_minute,
                policy.max_concurrent_requests AS project_max_concurrent_requests,
                k.status AS key_status,
                k.authz_version AS key_authz_version,
                k.supply_mode,
                k.expires_at AS key_expires_at,
                k.requests_per_minute AS key_requests_per_minute,
                k.tokens_per_minute AS key_tokens_per_minute,
                k.max_concurrent_requests AS key_max_concurrent_requests
           FROM saas_tenants t
           JOIN saas_projects p ON p.tenant_id = t.id
           JOIN saas_project_inference_policy_versions policy
             ON policy.tenant_id = p.tenant_id
            AND policy.project_id = p.id
            AND policy.version = p.inference_policy_version
           JOIN saas_api_keys k
             ON k.tenant_id = p.tenant_id
            AND k.project_id = p.id
            AND k.id = $3
          WHERE t.id = $1 AND p.id = $2
          LIMIT 2`,
        [input.tenantId, input.projectId, input.proxyKeyId],
      );
      const authority = oneRow(authorities);
      if (!authority) return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      if (
        authority.tenant_status !== 'active' ||
        authority.project_status !== 'active' ||
        authority.policy_status !== 'active' ||
        exactInteger(authority.project_policy_version) === null ||
        exactInteger(authority.project_policy_version) !== exactInteger(authority.policy_version) ||
        authority.key_status !== 'active' ||
        authority.supply_mode !== input.supplyMode
      ) {
        return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      }
      if (authority.key_expires_at !== null && authority.key_expires_at !== undefined) {
        const expiresAt =
          authority.key_expires_at instanceof Date
            ? authority.key_expires_at.getTime()
            : typeof authority.key_expires_at === 'string'
              ? Date.parse(authority.key_expires_at)
              : Number.NaN;
        const clockRows = await queryRows<{ database_now: unknown }>(
          executor,
          'SELECT clock_timestamp() AS database_now',
        );
        const databaseNow = clockRows[0]?.database_now;
        const nowMs =
          databaseNow instanceof Date
            ? databaseNow.getTime()
            : typeof databaseNow === 'string'
              ? Date.parse(databaseNow)
              : Number.NaN;
        if (!Number.isFinite(expiresAt) || !Number.isFinite(nowMs) || expiresAt <= nowMs) {
          return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
        }
      }

      const limits = authorityLimits(authority);
      if (!limits) return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      const keyAuthzVersion = positiveLimit(authority.key_authz_version);
      const policyVersion = positiveLimit(authority.policy_version);
      if (keyAuthzVersion === null || policyVersion === null) {
        return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      }

      const countRows = await queryRows<Row>(
        executor,
        `WITH existing AS (
           /* Execution rows, not reservation leases, own the concurrency truth. */
           SELECT q.tenant_id, q.project_id, q.proxy_key_id, q.id
             FROM saas_requests q
            WHERE q.tenant_id = $1
              AND q.id <> $4
              AND q.execution_state IN ('pending', 'unknown')
              AND (
                q.execution_state = 'unknown'
                OR EXISTS (
                  SELECT 1
                    FROM saas_attempts a
                   WHERE a.tenant_id = q.tenant_id
                     AND a.request_id = q.id
                     AND (
                       a.dispatch_state IN ('not_sent', 'dispatching', 'unknown')
                       OR a.result_state IN ('pending', 'unknown')
                     )
                )
              )
         ), rate_window AS (
           /* RPM/TPM expire by database admission time, separately from activity. */
           SELECT r.tenant_id, r.project_id, r.proxy_key_id, r.token_units
             FROM saas_gateway_capacity_reservations r
            WHERE r.tenant_id = $1
              AND r.request_id <> $4
              AND r.state IN ('reserved', 'retained_for_reconciliation')
              AND r.reserved_at > clock_timestamp() - INTERVAL '60 seconds'
         )
         SELECT
           (SELECT COUNT(*) FROM rate_window WHERE tenant_id = $1)::text AS tenant_rate_count,
           (SELECT COUNT(*) FROM existing WHERE tenant_id = $1)::text AS tenant_concurrent_count,
           (SELECT COALESCE(SUM(token_units), 0) FROM rate_window WHERE tenant_id = $1)::text AS tenant_token_units,
           (SELECT COUNT(*) FROM rate_window WHERE project_id = $2)::text AS project_rate_count,
           (SELECT COUNT(*) FROM existing WHERE project_id = $2)::text AS project_concurrent_count,
           (SELECT COALESCE(SUM(token_units), 0) FROM rate_window WHERE project_id = $2)::text AS project_token_units,
           (SELECT COUNT(*) FROM rate_window WHERE project_id = $2 AND proxy_key_id = $3)::text AS key_rate_count,
           (SELECT COUNT(*) FROM existing WHERE project_id = $2 AND proxy_key_id = $3)::text AS key_concurrent_count,
           (SELECT COALESCE(SUM(token_units), 0) FROM rate_window WHERE project_id = $2 AND proxy_key_id = $3)::text AS key_token_units`,
        [input.tenantId, input.projectId, input.proxyKeyId, input.requestId],
      );
      const counts = oneRow(countRows);
      if (!counts) return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);

      const count = (name: string): bigint | null => exactInteger(counts[name]);
      const tenantRate = count('tenant_rate_count');
      const tenantConcurrency = count('tenant_concurrent_count');
      const tenantTokens = count('tenant_token_units');
      const projectRate = count('project_rate_count');
      const projectConcurrency = count('project_concurrent_count');
      const projectTokens = count('project_token_units');
      const keyRate = count('key_rate_count');
      const keyConcurrency = count('key_concurrent_count');
      const keyTokens = count('key_token_units');
      if (
        tenantRate === null ||
        tenantConcurrency === null ||
        tenantTokens === null ||
        projectRate === null ||
        projectConcurrency === null ||
        projectTokens === null ||
        keyRate === null ||
        keyConcurrency === null ||
        keyTokens === null
      ) {
        return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
      }

      if (
        tenantTokens + tokenUnits > limits.tenant.tpm ||
        projectTokens + tokenUnits > limits.project.tpm ||
        keyTokens + tokenUnits > limits.key.tpm
      ) {
        return rejectRequestPreparation('quota_exceeded', 'The request exceeds an authoritative token capacity limit.');
      }
      if (
        tenantRate + 1n > limits.tenant.rpm ||
        projectRate + 1n > limits.project.rpm ||
        keyRate + 1n > limits.key.rpm
      ) {
        return rejectRequestPreparation('rate_limited', 'The request exceeds an authoritative request rate limit.');
      }
      if (
        tenantConcurrency + 1n > limits.tenant.concurrency ||
        projectConcurrency + 1n > limits.project.concurrency ||
        keyConcurrency + 1n > limits.key.concurrency
      ) {
        return rejectRequestPreparation('rate_limited', 'The request exceeds an authoritative concurrency limit.');
      }

      const quotaReservationId = randomUUID();
      const rateReservationId = randomUUID();
      const inserted = await queryRows<ReservationRow>(
        executor,
        `INSERT INTO saas_gateway_capacity_reservations
           (tenant_id, project_id, proxy_key_id, request_id, attempt_id, supply_mode,
            project_policy_version, key_authz_version, idempotency_scope_key,
            request_fingerprint, request_fingerprint_version, token_units,
            quota_reservation_id, rate_reservation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id, request_id) DO NOTHING
         RETURNING tenant_id, project_id, proxy_key_id, request_id, supply_mode,
                   project_policy_version, key_authz_version, idempotency_scope_key,
                   request_fingerprint, request_fingerprint_version, token_units,
                   quota_reservation_id, rate_reservation_id, state`,
        [
          input.tenantId,
          input.projectId,
          input.proxyKeyId,
          input.requestId,
          input.attemptId,
          input.supplyMode,
          policyVersion.toString(),
          keyAuthzVersion.toString(),
          input.idempotencyScopeKey,
          input.requestFingerprint,
          input.requestFingerprintVersion,
          tokenUnits.toString(),
          quotaReservationId,
          rateReservationId,
        ],
      );
      const insertedRow = oneRow(inserted);
      if (inserted.length === 1 && insertedRow) {
        const value = capacityValue(insertedRow);
        return value
          ? allowRequestPreparation(value)
          : blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
      }
      const raced = await queryRows<ReservationRow>(
        executor,
        `SELECT tenant_id, project_id, proxy_key_id, request_id, supply_mode,
                project_policy_version, key_authz_version, idempotency_scope_key,
                request_fingerprint, request_fingerprint_version, token_units,
                quota_reservation_id, rate_reservation_id, state
           FROM saas_gateway_capacity_reservations
          WHERE tenant_id = $1 AND request_id = $2
          LIMIT 2`,
        [input.tenantId, input.requestId],
      );
      const racedRow = oneRow(raced);
      if (!racedRow || !safeReservation(racedRow) || !sameIdentity(racedRow, input)) {
        return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
      }
      const value = capacityValue(racedRow);
      return value
        ? allowRequestPreparation(value)
        : blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
    } catch {
      return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
    }
  }

  async release(
    executor: SqlExecutor,
    input: Parameters<PostgresPreparationCapacityPort['release']>[1],
  ): Promise<{
    readonly quotaReservation: 'released' | 'retained_for_reconciliation';
    readonly rateReservation: 'released' | 'retained_for_reconciliation';
  }> {
    const retained = {
      quotaReservation: 'retained_for_reconciliation' as const,
      rateReservation: 'retained_for_reconciliation' as const,
    };
    if (
      !executor ||
      !input ||
      !text(input.tenantId) ||
      !text(input.projectId) ||
      !text(input.requestId) ||
      !text(input.attemptId) ||
      !text(input.quotaReservation?.reference) ||
      !text(input.rateReservation?.reference)
    )
      return retained;

    try {
      const attemptRows = await queryRows<Row>(
        executor,
        `SELECT q.project_id, q.proxy_key_id, q.supply_mode, q.execution_state,
                q.financial_status, q.reconciliation_state,
                a.dispatch_state, a.result_state, a.response_started,
                EXISTS (
                  SELECT 1 FROM saas_attempts other
                   WHERE other.tenant_id = q.tenant_id AND other.request_id = q.id
                     AND other.dispatch_state <> 'not_sent'
                ) AS any_attempt_dispatched
           FROM saas_requests q
           JOIN saas_attempts a ON a.tenant_id = q.tenant_id AND a.request_id = q.id
          WHERE q.tenant_id = $1 AND q.id = $2 AND a.id = $3
          LIMIT 2
          FOR UPDATE OF q, a`,
        [input.tenantId, input.requestId, input.attemptId],
      );
      const attempt = oneRow(attemptRows);
      const reservationRows = await queryRows<ReservationRow>(
        executor,
        `SELECT tenant_id, project_id, proxy_key_id, request_id, supply_mode,
                project_policy_version, key_authz_version, idempotency_scope_key,
                request_fingerprint, request_fingerprint_version, token_units,
                quota_reservation_id, rate_reservation_id, state
           FROM saas_gateway_capacity_reservations
          WHERE tenant_id = $1 AND project_id = $2 AND request_id = $3
            AND quota_reservation_id = $4 AND rate_reservation_id = $5
          LIMIT 2
          FOR UPDATE`,
        [
          input.tenantId,
          input.projectId,
          input.requestId,
          input.quotaReservation.reference,
          input.rateReservation.reference,
        ],
      );
      const reservation = oneRow(reservationRows);
      if (!reservation || !safeReservation(reservation)) return retained;
      if (reservation.state === 'released') {
        return { quotaReservation: 'released', rateReservation: 'released' };
      }
      if (reservation.state === 'retained_for_reconciliation') return retained;
      if (!attempt || attempt.project_id !== input.projectId || attempt.proxy_key_id !== reservation.proxy_key_id) {
        return retained;
      }

      const notDispatched =
        attempt.dispatch_state === 'not_sent' &&
        attempt.result_state === 'pending' &&
        attempt.response_started === false &&
        attempt.execution_state === 'pending' &&
        attempt.reconciliation_state === 'none' &&
        attempt.any_attempt_dispatched === false &&
        ((attempt.supply_mode === 'byok' && attempt.financial_status === 'not_applicable') ||
          (attempt.supply_mode === 'platform' && attempt.financial_status === 'pending'));
      const nextState = notDispatched ? 'released' : 'retained_for_reconciliation';
      const updated = await queryRows<Row>(
        executor,
        `UPDATE saas_gateway_capacity_reservations
            SET state = $6, updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND project_id = $2 AND request_id = $3
            AND quota_reservation_id = $4 AND rate_reservation_id = $5
            AND state = 'reserved'
          RETURNING state`,
        [
          input.tenantId,
          input.projectId,
          input.requestId,
          input.quotaReservation.reference,
          input.rateReservation.reference,
          nextState,
        ],
      );
      if (updated.length === 1 && updated[0]?.state === 'released') {
        return { quotaReservation: 'released', rateReservation: 'released' };
      }
      if (updated.length === 1 && updated[0]?.state === 'retained_for_reconciliation') return retained;
      return retained;
    } catch {
      return retained;
    }
  }
}

export function createPostgresPreparationCapacityPort(): PostgresPreparationCapacityPort {
  return new PostgresPreparationCapacityAdapter();
}
