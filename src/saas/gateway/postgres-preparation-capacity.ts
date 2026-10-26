import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '../db/types.js';
import { prepareFencedReservation } from './fenced-reservation-plan.js';
import type {
  PostgresPreparationCapacityPort,
  PostgresPreparationCapacityReservation,
} from './postgres-preparation-ports.js';
import type { RedisPreparationCapacity } from './redis-preparation-capacity.js';
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
/**
 * R9 P10: staleness horizon for the in-flight concurrency truth. The provider
 * HTTP transport hard-caps every dispatched request at 300_000 ms
 * (provider-http-transport.ts MAX_TIMEOUT_MS) and that timeout spans the entire
 * response body, so no legal in-flight request — however slow its stream — can
 * outlive it. The horizon is twice that ceiling: a merely slow stream still has
 * a full timeout window of margin, while a pending/unknown row whose last state
 * transition is older than the horizon can no longer be legally executing
 * upstream and must stop blocking admission (a crashed gateway or a settle
 * failure must not poison the ledger forever). The exclusion drops no billing
 * truth: financial_status, reconciliation_state and the billing reservation
 * stay authoritative, and the unknown-outcome recovery worker's stale-admission
 * sweep (same horizon, STALE_ADMISSION_HORIZON_MS) reconciles the rows.
 */
export const CONCURRENCY_INFLIGHT_HORIZON_SECONDS = 600;

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

/**
 * R1 (roadmap 1.3, phase 2): the billing-group RPM terms frozen on this
 * request's customer price snapshot (migration 112). Enforcement reads these
 * frozen values only — never the mutable saas_billing_groups table (the R1
 * red line: a later group edit must never reprice or re-limit an admission).
 */
interface FrozenBillingGroupRateTerms {
  readonly billingGroupId: string;
  /** Null means no RPM ceiling was frozen (unlimited; skip the counter entirely). */
  readonly rpmLimit: bigint | null;
}

/*
 * Per-request snapshot read: the platform admission guard creates the
 * customer price snapshot earlier on this same transaction, so exactly one
 * row must exist. A missing, duplicated or malformed row is authority drift
 * and blocks (fail closed).
 */
const SNAPSHOT_GROUP_TERMS_SQL = `/* postgres-preparation-capacity:billing-group-terms */
SELECT billing_group_id, group_rpm_limit
  FROM saas_request_customer_price_snapshots
 WHERE tenant_id = $1 AND request_id = $2
 LIMIT 2`;

/*
 * R1 group RPM counter upsert (the migration-098 account-counter pattern at
 * group scope). The returned count includes THIS admission; the surrounding
 * admission transaction holds the counter row until COMMIT, and a rejection
 * rolls the increment back with the transaction. window_start is truncated
 * to the second from the database clock so every writer in a UTC second
 * shares one row.
 */
const GROUP_RATE_UPSERT_SQL = `/* postgres-preparation-capacity:billing-group-rate */
INSERT INTO saas_billing_group_rate_counters (group_id, window_start, requests)
VALUES ($1, date_trunc('second', clock_timestamp()), 1)
ON CONFLICT (group_id, window_start)
DO UPDATE SET requests = saas_billing_group_rate_counters.requests + 1
RETURNING requests`;

function frozenGroupRateTerms(row: Row | null): FrozenBillingGroupRateTerms | null | 'malformed' {
  if (row === null) return null;
  const billingGroupId = row.billing_group_id;
  const rpmLimit = row.group_rpm_limit;
  if (!text(billingGroupId)) return 'malformed';
  if (rpmLimit === null || rpmLimit === undefined) return { billingGroupId, rpmLimit: null };
  const limit = exactInteger(rpmLimit);
  if (limit === null || limit > JS_SAFE_INTEGER_MAX) return 'malformed';
  return { billingGroupId, rpmLimit: limit };
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
  /*
   * §4.1 (task #15) TPM semantics: a media envelope (per-unit upper bound
   * present) may carry all-zero token bounds — image generation reports no
   * tokens at all. Media units are NOT tokens and never enter the TPM
   * count; the envelope stays admissible with a zero token reservation.
   */
  const media = usage.perUnitUnitsUpperBound !== undefined && usage.perUnitUnitsUpperBound !== null;
  if (
    media &&
    input === 0n &&
    inputUncached === 0n &&
    cacheRead === 0n &&
    cacheWrite === 0n &&
    cacheWrite5m === 0n &&
    cacheWrite1h === 0n &&
    output === 0n &&
    reasoning === 0n &&
    Array.isArray(buckets) &&
    buckets.length > 0 &&
    buckets.every((bucket) => text(bucket)) &&
    new Set(buckets).size === buckets.length
  ) {
    // Pure media envelope: zero tokens, valid shape, zero TPM reservation.
    return 0n;
  }
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
    // These are independent verifier upper bounds, not realized TTL splits.
    cacheWrite5m > input ||
    cacheWrite1h > input ||
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

/**
 * R9 P4/P16 (de-serialized admission): the capacity scope fence is a single
 * tenant-scoped EXCLUSIVE transaction advisory lock, and it is acquired as
 * late as possible — immediately before the shared-counter read — so the
 * exclusive window covers only: counter CTE → limit check → reservation
 * INSERT → raced re-read (plus whatever the caller still does before COMMIT).
 *
 * Why one tenant-scoped fence is sufficient (equivalence proof):
 * the previous design took three fences in stable order
 * tenant → project(tenant:project) → key(tenant:project:key). Every admission
 * always took the tenant fence first, so the set of admission pairs serialized
 * by the three-fence stack was exactly the set serialized by the tenant fence
 * alone (project/key scopes are strict subsets of the tenant scope: two
 * admissions sharing a project or key necessarily share the tenant). Dropping
 * the project/key fences removes two lock round trips and two lock-manager
 * queue entries per admission without changing which admissions can run
 * concurrently — the mutual-exclusion invariant behind every limit check
 * (tenant, project, and key RPM/TPM/concurrency) is preserved verbatim.
 *
 * Why the fence is acquired after the replay check and the authority read:
 * neither touches shared mutable capacity state. The replay check reads this
 * request's own reservation row (unique key tenant_id+request_id); a
 * concurrent duplicate admission that passes the empty replay check is
 * serialized by the fence before its INSERT and resolved by the existing
 * ON CONFLICT (tenant_id, request_id) DO NOTHING + raced re-read path below.
 * The authority read (limits, statuses, versions) is protected by the
 * admission authorization prelock's SHARED authz fences, which the caller
 * acquires before this port runs — strictly stronger isolation than the old
 * order, where the authority read ran before any authz fence was held.
 * Only the read-check-write of the shared counters (CTE over
 * saas_requests/saas_attempts/saas_gateway_capacity_reservations) requires
 * mutual exclusion, so only it sits inside the fence.
 *
 * Lock ordering (deadlock safety): admission is the sole taker of the
 * `model-router:request-capacity:*` advisory namespace. All locks acquired
 * before this fence (idempotency row, shared authz fences, per-request
 * metering rows, per-candidate guard rows, the billing wallet advisory fence
 * — model-router:wallet-fence:*, see saasAdvisoryKey.walletFence) are taken
 * in the same relative order by every admission, and no other transaction
 * class (control plane, settlement, compensation, release, refunds) ever
 * takes a capacity advisory lock — so no wait cycle can pass through this
 * fence. The wallet fence namespace is disjoint from every authz namespace:
 * billing operations take only the wallet fence (+ per-reservation tuple
 * locks) and refunds take the refund order row then the wallet fence, both
 * strictly inside-out; admission takes the wallet fence after its authority
 * fences and before this capacity fence, so the global order is consistent.
 * Within a tenant, the exclusive fence linearizes the capacity read/check/write
 * and this reservation INSERT. Key-budget and group-spend mutations precede
 * this fence and retain their own counter-row serialization; they are not
 * protected by a capacity lock acquired later.
 */
async function takeScopeLock(executor: SqlExecutor, tenantId: string): Promise<void> {
  await executor.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `model-router:request-capacity:tenant:${tenantId}`,
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

type CapacityInput = Parameters<PostgresPreparationCapacityPort['reserve']>[1];
type CapacityDecision = RequestPreparationDecision<PostgresPreparationCapacityReservation>;
type CapacityPlan =
  | { readonly kind: 'replayed'; readonly reservation: PostgresPreparationCapacityReservation }
  | {
      readonly kind: 'new';
      readonly tokenUnits: bigint;
      readonly limits: NonNullable<ReturnType<typeof authorityLimits>>;
      readonly keyAuthzVersion: bigint;
      readonly policyVersion: bigint;
      readonly groupRateTerms: FrozenBillingGroupRateTerms | null;
      readonly keyExpiresAt: unknown;
    };

/**
 * PostgreSQL request capacity implementation. It never touches wallet
 * tables. R1 (roadmap 1.3, phase 2) documented exception: it reads the
 * billing-group RPM terms from this request's own customer price snapshot
 * row (evidence frozen by the admission guard, not a wallet table and not
 * the mutable group table) and writes the saas_billing_group_rate_counters
 * admission counter — capacity-side rate evidence, never billing state.
 */
export class PostgresPreparationCapacityAdapter implements PostgresPreparationCapacityPort {
  readonly cachedReservation?: (requestId: string) => Promise<Record<string, unknown> | null>;
  constructor(private readonly redis?: RedisPreparationCapacity) {
    this.cachedReservation = redis ? (requestId) => redis.find(requestId) : undefined;
  }
  async reserve(executor: SqlExecutor, input: CapacityInput): Promise<CapacityDecision> {
    return this.applyPlan(executor, input, await this.readPlan(executor, input));
  }

  async prepareReserve(executor: SqlExecutor, input: CapacityInput): Promise<() => Promise<CapacityDecision>> {
    // A replay row can be released by another transaction; stage only our own
    // newly inserted request, whose visibility and lifetime this transaction owns.
    const snapshot = structuredClone(input);
    if (snapshot.newRequest !== true) return () => this.reserve(executor, snapshot);
    return prepareFencedReservation(
      executor,
      snapshot,
      () => this.readPlan(executor, snapshot),
      (plan) => this.applyPlan(executor, snapshot, plan),
      () => this.reserve(executor, snapshot),
    );
  }

  private async readPlan(
    executor: SqlExecutor,
    input: CapacityInput,
  ): Promise<RequestPreparationDecision<CapacityPlan>> {
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
      /* Per-request replay check, then per-scope authority: both run OUTSIDE
         the exclusive fence (see takeScopeLock for the proof). */
      const existingRows = this.redis
        ? []
        : await queryRows<ReservationRow>(
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
        if (replay && this.redis)
          await this.redis.receipt(
            executor,
            input.tenantId,
            input.requestId,
            replay.quotaReservation.reference,
            replay.rateReservation.reference,
          );
        return replay
          ? allowRequestPreparation({ kind: 'replayed', reservation: replay })
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

      const limits = authorityLimits(authority);
      if (!limits) return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      const keyAuthzVersion = positiveLimit(authority.key_authz_version);
      const policyVersion = positiveLimit(authority.policy_version);
      if (keyAuthzVersion === null || policyVersion === null) {
        return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
      }

      /* R1 (roadmap 1.3, phase 2): the frozen billing-group RPM terms for
         platform admissions. The admission guard created this request's
         customer price snapshot earlier on the same transaction, so the row
         must exist; the group terms are read from the frozen snapshot —
         never the mutable group table (the R1 red line). BYOK admissions
         carry no price snapshot and no group. This is a per-request read
         (unique tenant_id + request_id), so it stays outside the fence. */
      let groupRateTerms: FrozenBillingGroupRateTerms | null = null;
      if (input.supplyMode === 'platform') {
        const snapshotRows = await queryRows<Row>(executor, SNAPSHOT_GROUP_TERMS_SQL, [
          input.tenantId,
          input.requestId,
        ]);
        const snapshotRow = oneRow(snapshotRows);
        if (snapshotRow === null) {
          return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
        }
        const terms = frozenGroupRateTerms(snapshotRow);
        if (terms === 'malformed' || terms === null) {
          return blockRequestPreparation('capability_unavailable', SAFE_CAPACITY_FAILURE);
        }
        groupRateTerms = terms;
      }

      return allowRequestPreparation({
        kind: 'new',
        tokenUnits,
        limits,
        keyAuthzVersion,
        policyVersion,
        groupRateTerms,
        keyExpiresAt: authority.key_expires_at,
      });
    } catch {
      return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
    }
  }

  private async applyPlan(
    executor: SqlExecutor,
    input: CapacityInput,
    decision: RequestPreparationDecision<CapacityPlan>,
  ): Promise<CapacityDecision> {
    if (decision.decision !== 'allow') return decision;
    const plan = decision.value;
    if (plan.kind === 'replayed') return allowRequestPreparation(plan.reservation);
    const { limits, policyVersion, keyAuthzVersion, groupRateTerms, tokenUnits } = plan;
    try {
      // A hot wallet/key/group wait may cross expiry. Never cache this clock in the read plan.
      if (plan.keyExpiresAt !== null && plan.keyExpiresAt !== undefined) {
        const expiresAt =
          plan.keyExpiresAt instanceof Date
            ? plan.keyExpiresAt.getTime()
            : typeof plan.keyExpiresAt === 'string'
              ? Date.parse(plan.keyExpiresAt)
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

      if (this.redis)
        return this.redis.reserve(executor, input, limits, policyVersion, keyAuthzVersion, groupRateTerms, tokenUnits);

      /* R9 P4/P16: the exclusive tenant-scope fence starts HERE. Everything
         above is per-request or protected by the caller's shared authz
         fences; everything below reads or writes shared capacity state and
         must stay inside the fence until COMMIT. */
      await takeScopeLock(executor, input.tenantId);

      const countRows = await queryRows<Row>(
        executor,
        `WITH existing AS (
           /* Execution rows, not reservation leases, own the concurrency truth.
              Rows past the in-flight horizon can no longer be legally executing
              upstream (the provider transport timeout ceiling has long passed),
              so they stop blocking admission while the recovery worker
              reconciles them; see CONCURRENCY_INFLIGHT_HORIZON_SECONDS. */
           SELECT q.tenant_id, q.project_id, q.proxy_key_id, q.id
             FROM saas_requests q
            WHERE q.tenant_id = $1
              AND q.id <> $4
              AND q.execution_state IN ('pending', 'unknown')
              AND q.updated_at > clock_timestamp() - INTERVAL '${CONCURRENCY_INFLIGHT_HORIZON_SECONDS} seconds'
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

      /* R1 (roadmap 1.3, phase 2): group RPM enforcement, inside the fence.
         Only a group with a frozen ceiling touches the counter table — an
         unlimited group performs no extra write (the seeded 'default' group
         ships with rpm_limit NULL). The upsert counts THIS admission; a
         rejection rolls the increment back with the admission transaction,
         and the replay path above returned before the fence, so replays
         never double-count. A zero ceiling is finite: it rejects the very
         first request. */
      if (groupRateTerms !== null && groupRateTerms.rpmLimit !== null) {
        const counterRows = await queryRows<Row>(executor, GROUP_RATE_UPSERT_SQL, [groupRateTerms.billingGroupId]);
        const counterRow = oneRow(counterRows);
        const requests = counterRow === null ? null : exactInteger(counterRow.requests);
        if (requests === null) return blockRequestPreparation('storage_failure', SAFE_CAPACITY_FAILURE);
        if (requests > groupRateTerms.rpmLimit) {
          return rejectRequestPreparation('rate_limited', 'The request exceeds the billing group request rate limit.');
        }
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
      if (this.redis) {
        const reservation = await this.redis.find(input.requestId);
        if (
          !reservation ||
          reservation.tenant_id !== input.tenantId ||
          reservation.project_id !== input.projectId ||
          reservation.quota_reservation_id !== input.quotaReservation.reference ||
          reservation.rate_reservation_id !== input.rateReservation.reference
        )
          return retained;
        if (reservation.state === 'released') return { quotaReservation: 'released', rateReservation: 'released' };
        if (
          !attempt ||
          attempt.project_id !== input.projectId ||
          attempt.proxy_key_id !== reservation.proxy_key_id ||
          attempt.dispatch_state !== 'not_sent' ||
          attempt.result_state !== 'pending' ||
          attempt.response_started !== false ||
          attempt.execution_state !== 'pending' ||
          attempt.reconciliation_state !== 'none' ||
          attempt.any_attempt_dispatched !== false
        )
          return retained;
        // PG cancellation must commit before the Redis reservation is freed.
        // The HTTP completion hook/recovery worker observes that terminal row;
        // rolling this transaction back therefore cannot release live capacity.
        return { quotaReservation: 'released', rateReservation: 'released' };
      }
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

export function createPostgresPreparationCapacityPort(
  redis?: RedisPreparationCapacity,
): PostgresPreparationCapacityPort {
  return new PostgresPreparationCapacityAdapter(redis);
}
