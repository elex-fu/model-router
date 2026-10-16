import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { parseHealthScoreColumn } from './health-score.js';
import {
  MAX_HEALTH_OBSERVED_AT_SKEW_MS,
  type ProviderAccountSchedulerFailureFeedbackPort,
  type ProviderAccountSchedulerHealthDecision,
  type ProviderAccountSchedulerHealthPort,
} from './provider-account-scheduler.js';
import type { RequestPreparationCaller, RequestPreparationCandidateAuthority } from './request-preparation-service.js';

type HealthState = 'healthy' | 'degraded' | 'cooldown' | 'unhealthy';
type HealthSource = 'gateway' | 'probe';
type RetryableFailureKind = 'network' | 'provider_5xx' | 'protocol';

/** Runtime evidence excludes caller validation and non-retryable 4xx outcomes. */
export type ProviderAccountRuntimeHealthEvidence =
  | { readonly source: HealthSource; readonly result: 'success' }
  | {
      readonly source: HealthSource;
      readonly result: 'retryable_failure';
      readonly failureKind: RetryableFailureKind;
    };

export interface ProviderAccountRuntimeHealthStoreOptions {
  readonly database: SaasDatabase;
  readonly maxHealthAgeMs?: number;
}

export class ProviderAccountRuntimeHealthStoreError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'STORAGE_ERROR') {
    super(
      code === 'INVALID_INPUT' ? 'invalid provider runtime health evidence' : 'provider runtime health storage failed',
    );
    this.name = 'ProviderAccountRuntimeHealthStoreError';
  }
}

interface RuntimeHealthRow {
  readonly state: unknown;
  readonly observed_at: unknown;
  readonly cooldown_until: unknown;
}

interface SchedulingHealthRow extends RuntimeHealthRow {
  readonly failure_count: unknown;
  readonly health_score: unknown;
  readonly half_open_probe_at: unknown;
}

interface RevisionRow {
  readonly revision: unknown;
}

interface HealthScope {
  readonly ownerKind: 'tenant' | 'platform';
  readonly ownerTenantId: string | null;
  readonly ownerScopeKey: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly upstreamId: string;
}

/** The immutable account identity required to scope a dispatch outcome. */
export type ProviderAccountRuntimeHealthCandidate = Pick<
  RequestPreparationCandidateAuthority,
  'tenantId' | 'accountId' | 'upstreamId' | 'supplyMode' | 'accountOwnerKind'
>;

export interface ProviderAccountRuntimeHealthWriter {
  recordRuntimeOutcome(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    readonly attemptId: string;
    readonly fencingToken: string;
    readonly evidence: ProviderAccountRuntimeHealthEvidence;
  }): Promise<'applied' | 'stale'>;
}

/**
 * R7/D6 scheduling read model: the binary decision fields plus the
 * continuous score and half-open probe facts. The scheduling integration
 * consumes `healthScore` via `effectiveWeight` (NULL = pre-R7 binary
 * behavior) and admits a single half-open probe through the admission
 * port below; a malformed persisted score blocks instead of being treated
 * as NULL.
 */
export interface ProviderAccountHealthSchedulingSnapshot {
  readonly status: HealthState;
  readonly observedAt: Date;
  /** Raw persisted cooldown deadline; non-null only while state is 'cooldown', including after expiry. */
  readonly cooldownUntil: Date | null;
  readonly healthScore: number | null;
  readonly halfOpenProbeAt: Date | null;
  readonly consecutiveFailures: number;
}

export type ProviderAccountHealthSchedulingView =
  | { readonly decision: 'allow'; readonly value: ProviderAccountHealthSchedulingSnapshot }
  | { readonly decision: 'block'; readonly reason: string; readonly code: ProviderAccountHealthSchedulingBlockCode };

/**
 * H5a: why a scheduling view blocked. The half-open probe wiring only acts
 * on 'stale' — a well-formed row whose observation is merely older than the
 * freshness bound. Every other code keeps the fail-closed block.
 */
export type ProviderAccountHealthSchedulingBlockCode = 'input' | 'unknown' | 'stale' | 'malformed' | 'unavailable';

/**
 * The minimal scheduling-candidate shape the health scope resolution actually
 * reads. The dispatch authority candidate is structurally compatible, and
 * health-scoped probes can pass the smaller shape directly.
 */
export interface ProviderAccountHealthSchedulingCandidate {
  readonly accountId: string;
  readonly tenantId: string;
  readonly upstreamId: string;
  readonly supplyMode: 'byok' | 'platform';
  readonly accountOwnerKind: 'tenant' | 'platform';
}

export interface ProviderAccountHealthSchedulingPort {
  getSchedulingView(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: ProviderAccountHealthSchedulingCandidate;
    readonly now: Date;
  }): Promise<ProviderAccountHealthSchedulingView>;
}

/**
 * R7/D6 half-open probe admission. Admitting a probe is a single-winner
 * CAS on `half_open_probe_at` gated by the expired-cooldown row state and
 * the probe cadence; the admission fence is drawn fresh from the lease
 * fencing sequence. Integration contract: admit first, then acquire the
 * probe dispatch lease (its token is necessarily newer), dispatch, and
 * record the probe outcome through the normal lease-authorized write.
 * 'closed' conflates every losing case (still cooling, probe in flight,
 * healthy row, missing row) — the caller must not probe.
 *
 * H5a (R9 bench finding P5a): the admission gate additionally admits a
 * STALE fresh-state row — `state` in ('healthy','degraded') whose
 * `observed_at` is older than `staleAfterMs` (default: the store's
 * maxHealthAgeMs). Staleness is the same circuit the cooldown columns
 * encode for failures: with no in-product refresher, any quiet phase
 * longer than the freshness bound permanently walled the account behind
 * 'stale or malformed'. The single-winner CAS, the 30 s crash-recovery
 * lease, and the fence ordering all apply unchanged to this branch.
 */
export interface ProviderAccountHalfOpenProbeAdmissionPort {
  tryAdmitHalfOpenProbe(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    /** H5a: staleness bound for the fresh-state probe branch; defaults to the store's maxHealthAgeMs. */
    readonly staleAfterMs?: number;
  }): Promise<'admitted' | 'closed'>;
}

/**
 * H5a: the minimal lease surface a health probe needs — acquire a
 * short-lived, account-scoped lease whose fencing token authorizes the
 * probe outcome write, then release it. Structurally satisfied by
 * PostgresProviderAccountLeaseService; declared here so the health module
 * owns no dispatch-service imports.
 */
export interface ProviderAccountHealthProbeLease {
  readonly fencingToken: string;
  release(): Promise<void>;
}

export interface ProviderAccountHealthProbeLeaseProvider {
  acquire(input: {
    readonly tenantId: string;
    readonly accountId: string;
    readonly upstreamId: string;
    readonly attemptId: string;
    readonly evidence: {
      readonly tenantId: string;
      readonly accountId: string;
      readonly upstreamId: string;
      readonly attemptId: string;
      readonly supplyMode: 'byok' | 'platform';
    };
  }): Promise<ProviderAccountHealthProbeLease | null>;
}

interface NormalizedEvidence {
  readonly state: 'healthy' | 'cooldown';
  readonly outcome: string;
}

const HEALTH_TABLE = 'saas_provider_account_runtime_health';
const LEASE_TABLE = 'saas_provider_account_leases';
const DEFAULT_MAX_HEALTH_AGE_MS = 30_000;
const MAX_HEALTH_AGE_MS = 86_400_000;
const MAX_FENCING_TOKEN = 9_223_372_036_854_775_807n;
/**
 * H5b (R9 bench finding P6): a failed health write closes the runtime to
 * future selections for a bounded, exponentially backed-off window instead
 * of the process lifetime. A transient PostgreSQL blip must not permanently
 * wedge scheduling (the R9 bench needed a gateway force-recreate to
 * recover); a sustained outage still fails closed on every call because each
 * write failure re-latches and every read fails per-call.
 */
const WRITE_FAILURE_LATCH_BASE_MS = 1_000;
const WRITE_FAILURE_LATCH_MAX_MS = 60_000;

const READ_HEALTH_SQL = `
  SELECT state, observed_at, cooldown_until
    FROM ${HEALTH_TABLE}
   WHERE owner_scope_key = $1
     AND account_id = $2
     AND owner_kind = $3
     AND owner_tenant_id IS NOT DISTINCT FROM $4`;

const READ_SCHEDULING_SQL = `
  SELECT state, observed_at, cooldown_until, failure_count, health_score, half_open_probe_at
    FROM ${HEALTH_TABLE}
   WHERE owner_scope_key = $1
     AND account_id = $2
     AND owner_kind = $3
     AND owner_tenant_id IS NOT DISTINCT FROM $4`;

/*
 * R7/D6: the binary state/failure_count/cooldown expressions are unchanged;
 * health_score is an additional EMA column updated in the same statement
 * (alpha = 0.2, optimistic NULL seed = 1.000, three-decimal numeric grid).
 * The INSERT seed applies one EMA step from 1.000 so the first failure
 * lands at 0.800, matching recordOutcomeEma in ./health-score.js.
 */
const WRITE_HEALTH_SQL = `
  WITH observation AS (
    SELECT clock_timestamp() AS observed_at
  ), authorized_lease AS (
    SELECT 1
      FROM ${LEASE_TABLE}
     WHERE tenant_id = $1
       AND owner_kind = $2
       AND owner_tenant_id IS NOT DISTINCT FROM $3
       AND account_id = $4
       AND upstream_id = $5
       AND attempt_id = $6
       AND fencing_token = $7::bigint
  )
  INSERT INTO ${HEALTH_TABLE} AS current_health
    (owner_scope_key, owner_kind, owner_tenant_id, account_id, state, failure_count,
     observed_at, cooldown_until, last_outcome, source_fencing_token, revision, health_score)
  SELECT $8::text, $2, $3, $4, $9::text,
         CASE WHEN $9::text = 'cooldown' THEN 1 ELSE 0 END,
         observation.observed_at,
         CASE WHEN $9::text = 'cooldown'
           THEN observation.observed_at + interval '1 second' ELSE NULL END,
         $10::text, $7::bigint, 1,
         ROUND((1.000 + 0.2 * (CASE WHEN $9::text = 'cooldown' THEN 0.000 ELSE 1.000 END
                 - 1.000))::numeric, 3)
    FROM observation
   WHERE EXISTS (SELECT 1 FROM authorized_lease)
  ON CONFLICT (owner_scope_key, account_id) DO UPDATE
    SET state = EXCLUDED.state,
        failure_count = CASE WHEN EXCLUDED.state = 'healthy' THEN 0
          ELSE LEAST(current_health.failure_count + 1, 8) END,
        observed_at = EXCLUDED.observed_at,
        cooldown_until = CASE WHEN EXCLUDED.state = 'healthy' THEN NULL
          ELSE EXCLUDED.observed_at +
            LEAST(300000::bigint, 1000::bigint * (1::bigint << LEAST(current_health.failure_count, 8)))
              * interval '1 millisecond' END,
        last_outcome = EXCLUDED.last_outcome,
        source_fencing_token = EXCLUDED.source_fencing_token,
        revision = current_health.revision + 1,
        health_score = ROUND(LEAST(1.000, GREATEST(0.000,
          COALESCE(current_health.health_score, 1.000)
            + 0.2 * (CASE WHEN EXCLUDED.state = 'cooldown' THEN 0.000 ELSE 1.000 END
                - COALESCE(current_health.health_score, 1.000))))::numeric, 3)
  WHERE current_health.source_fencing_token < EXCLUDED.source_fencing_token
  RETURNING revision`;

/*
 * R7/D6 half-open probe admission: a single-winner CAS on the expired-
 * cooldown row. The admission fence is drawn fresh from the lease fencing
 * sequence, so it is always greater than any previously issued lease
 * token — and always SMALLER than the token of any lease acquired after
 * the admission. That ordering is the integration contract: admit the
 * probe first, then acquire the probe dispatch lease, then record the
 * probe outcome through the normal lease-authorized path, whose strictly
 * greater token passes the row fence. (Tying the admission itself to a
 * lease token would fence out that same lease's outcome write.) The
 * binary columns are untouched — only half_open_probe_at moves, with the
 * fencing token and revision keeping the row guard satisfied
 * (observed_at is deliberately not bumped: the cooldown shape constraint
 * requires cooldown_until >= observed_at, and observed_at remains the
 * last OUTCOME timestamp, which is exactly what distinguishes a concluded
 * probe from an in-flight one). The gate mirrors isHalfOpenProbeAllowed
 * in ./health-score.js: cooldown expired AND (never probed OR previous
 * probe concluded — its outcome bumped observed_at past the admission —
 * OR the in-flight admission is older than the 30s crash-recovery lease).
 * Inter-probe backoff rides on the persisted cooldown, which already
 * doubles per consecutive failure.
 *
 * H5a (R9 bench finding P5a): the second OR branch admits a fresh-STATE
 * row whose last outcome is merely STALE ($5 = the caller's freshness
 * bound, defaulting to the store's maxHealthAgeMs). Without an in-product
 * refresher, any quiet phase longer than the freshness bound permanently
 * walled the account; the same single-winner CAS, crash-recovery lease,
 * and fence ordering govern this branch.
 */
const ADMIT_HALF_OPEN_PROBE_SQL = `
  WITH observation AS (
    SELECT clock_timestamp() AS observed_at,
           nextval('saas_provider_account_lease_fencing_seq') AS fencing_token
  )
  UPDATE ${HEALTH_TABLE} AS current_health
     SET half_open_probe_at = observation.observed_at,
         source_fencing_token = observation.fencing_token,
         revision = current_health.revision + 1
    FROM observation
   WHERE current_health.owner_scope_key = $1::text
     AND current_health.owner_kind = $2
     AND current_health.owner_tenant_id IS NOT DISTINCT FROM $3
     AND current_health.account_id = $4
     AND (
          (current_health.state = 'cooldown'
       AND current_health.cooldown_until IS NOT NULL
       AND current_health.cooldown_until <= observation.observed_at)
       OR (current_health.state IN ('healthy', 'degraded')
       AND current_health.observed_at + $5::bigint * interval '1 millisecond'
            <= observation.observed_at)
     )
     AND (current_health.half_open_probe_at IS NULL
       OR current_health.half_open_probe_at <= current_health.observed_at
       OR current_health.half_open_probe_at + 30000::bigint * interval '1 millisecond'
            <= observation.observed_at)
     AND current_health.source_fencing_token < observation.fencing_token
  RETURNING revision`;

function invalidInput(): never {
  throw new ProviderAccountRuntimeHealthStoreError('INVALID_INPUT');
}

function storageError(): ProviderAccountRuntimeHealthStoreError {
  return new ProviderAccountRuntimeHealthStoreError('STORAGE_ERROR');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 512 && !value.includes('\u0000');
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function accountScope(candidate: unknown, caller?: RequestPreparationCaller): HealthScope | null {
  if (!record(candidate)) return null;
  const { accountId, tenantId, upstreamId, supplyMode, accountOwnerKind } = candidate;
  if (!nonEmpty(accountId) || !nonEmpty(tenantId) || !nonEmpty(upstreamId)) return null;
  if (caller && (caller.supplyMode !== supplyMode || caller.tenantId !== tenantId)) return null;
  if (supplyMode === 'byok' && accountOwnerKind === 'tenant') {
    return {
      ownerKind: 'tenant',
      ownerTenantId: tenantId,
      ownerScopeKey: tenantId,
      accountId,
      tenantId,
      upstreamId,
    };
  }
  if (supplyMode === 'platform' && accountOwnerKind === 'platform') {
    return {
      ownerKind: 'platform',
      ownerTenantId: null,
      ownerScopeKey: 'platform',
      accountId,
      tenantId,
      upstreamId,
    };
  }
  return null;
}

function normalizedEvidence(value: unknown): NormalizedEvidence | null {
  if (!record(value) || (value.source !== 'gateway' && value.source !== 'probe')) return null;
  const prefix = value.source;
  if (value.result === 'success' && Object.keys(value).every((key) => key === 'source' || key === 'result')) {
    return { state: 'healthy', outcome: `${prefix}_success` };
  }
  if (
    value.result !== 'retryable_failure' ||
    (value.failureKind !== 'network' && value.failureKind !== 'provider_5xx' && value.failureKind !== 'protocol') ||
    Object.keys(value).some((key) => !['source', 'result', 'failureKind'].includes(key))
  ) {
    return null;
  }
  return { state: 'cooldown', outcome: `${prefix}_${value.failureKind}_failure` };
}

function validFence(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return false;
  try {
    return BigInt(value) <= MAX_FENCING_TOKEN;
  } catch {
    return false;
  }
}

function validRevision(value: unknown): boolean {
  if (typeof value === 'bigint') return value > 0n;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function validState(value: unknown): value is HealthState {
  return value === 'healthy' || value === 'degraded' || value === 'cooldown' || value === 'unhealthy';
}

function asFailureCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 8 ? value : null;
  }
  if (typeof value === 'string' && /^[0-8]$/.test(value)) return Number(value);
  return null;
}

export class PostgresProviderAccountRuntimeHealthStore
  implements
    ProviderAccountSchedulerHealthPort,
    ProviderAccountRuntimeHealthWriter,
    ProviderAccountHealthSchedulingPort,
    ProviderAccountHalfOpenProbeAdmissionPort
{
  private readonly database: SaasDatabase;
  private readonly maxHealthAgeMs: number;
  /** H5b: epoch-ms deadline of the bounded write-failure latch; 0 = not latched. */
  private writeFailedUntil = 0;
  private writeFailureCount = 0;

  constructor(options: ProviderAccountRuntimeHealthStoreOptions) {
    if (
      !options?.database ||
      typeof options.database.query !== 'function' ||
      typeof options.database.transaction !== 'function'
    ) {
      throw new TypeError('a transactional SaaS database is required');
    }
    const configuredAge = options.maxHealthAgeMs;
    this.maxHealthAgeMs =
      configuredAge !== undefined && Number.isSafeInteger(configuredAge) && configuredAge > 0
        ? Math.min(configuredAge, MAX_HEALTH_AGE_MS)
        : DEFAULT_MAX_HEALTH_AGE_MS;
    this.database = options.database;
  }

  /** H5b: a failed write latches fail-closed for a bounded, doubling window. */
  private storageFailed(): void {
    this.writeFailureCount += 1;
    const backoffMs = Math.min(
      WRITE_FAILURE_LATCH_MAX_MS,
      WRITE_FAILURE_LATCH_BASE_MS * 2 ** Math.min(this.writeFailureCount - 1, 16),
    );
    this.writeFailedUntil = Date.now() + backoffMs;
  }

  /**
   * H5b: any successful statement against the same pool proves the storage
   * recovered, so the latch (and its escalation counter) resets immediately
   * rather than waiting out the full backoff window.
   */
  private storageRecovered(): void {
    this.writeFailedUntil = 0;
    this.writeFailureCount = 0;
  }

  async get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerHealthDecision> {
    if (Date.now() < this.writeFailedUntil) {
      return { decision: 'block', reason: 'provider account runtime health authority is unavailable' };
    }
    const scope = accountScope(input?.candidate, input?.caller);
    if (!scope || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
      return { decision: 'block', reason: 'provider account runtime health input is invalid' };
    }
    try {
      const result = await this.database.query<RuntimeHealthRow>(READ_HEALTH_SQL, [
        scope.ownerScopeKey,
        scope.accountId,
        scope.ownerKind,
        scope.ownerTenantId,
      ]);
      this.storageRecovered();
      if (result.rows.length !== 1) {
        return { decision: 'block', reason: 'provider account runtime health is unknown' };
      }
      const row = result.rows[0];
      const observedAt = asDate(row.observed_at);
      const cooldownUntil = row.cooldown_until === null ? null : asDate(row.cooldown_until);
      if (
        !validState(row.state) ||
        !observedAt ||
        // H1 (P5b): observed_at is written by the PostgreSQL clock while the
        // gate compares against the gateway clock; small negative age from
        // cross-process clock dispersion is clamped, a genuinely future
        // timestamp beyond the tolerance stays malformed (fail-closed).
        observedAt.getTime() - input.now.getTime() > MAX_HEALTH_OBSERVED_AT_SKEW_MS ||
        input.now.getTime() - observedAt.getTime() > this.maxHealthAgeMs ||
        (row.cooldown_until !== null && !cooldownUntil)
      ) {
        return { decision: 'block', reason: 'provider account runtime health is stale or malformed' };
      }
      const status =
        row.state === 'cooldown' && cooldownUntil && cooldownUntil.getTime() <= input.now.getTime()
          ? 'degraded'
          : row.state;
      return {
        decision: 'allow',
        value: {
          status,
          observedAt,
          cooldownUntil: status === 'cooldown' ? cooldownUntil : null,
        },
      };
    } catch {
      return { decision: 'block', reason: 'provider account runtime health authority is unavailable' };
    }
  }

  /**
   * R7/D6 scheduling read: the same freshness/malformation rules as get(),
   * plus the continuous score, probe admission timestamp and failure count.
   * A malformed persisted score blocks fail-closed; it is never silently
   * reinterpreted as the NULL (pre-R7 binary) case.
   */
  async getSchedulingView(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: ProviderAccountHealthSchedulingCandidate;
    readonly now: Date;
  }): Promise<ProviderAccountHealthSchedulingView> {
    if (Date.now() < this.writeFailedUntil) {
      return {
        decision: 'block',
        reason: 'provider account runtime health authority is unavailable',
        code: 'unavailable',
      };
    }
    const scope = accountScope(input?.candidate, input?.caller);
    if (!scope || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
      return { decision: 'block', reason: 'provider account runtime health input is invalid', code: 'input' };
    }
    try {
      const result = await this.database.query<SchedulingHealthRow>(READ_SCHEDULING_SQL, [
        scope.ownerScopeKey,
        scope.accountId,
        scope.ownerKind,
        scope.ownerTenantId,
      ]);
      this.storageRecovered();
      if (result.rows.length !== 1) {
        return { decision: 'block', reason: 'provider account runtime health is unknown', code: 'unknown' };
      }
      const row = result.rows[0];
      const observedAt = asDate(row.observed_at);
      const cooldownUntil = row.cooldown_until === null ? null : asDate(row.cooldown_until);
      const halfOpenProbeAt = row.half_open_probe_at === null ? null : asDate(row.half_open_probe_at);
      const consecutiveFailures = asFailureCount(row.failure_count);
      let healthScore: number | null;
      try {
        healthScore = parseHealthScoreColumn(row.health_score);
      } catch {
        return {
          decision: 'block',
          reason: 'provider account runtime health score is malformed',
          code: 'malformed',
        };
      }
      if (
        !validState(row.state) ||
        !observedAt ||
        (row.cooldown_until !== null && !cooldownUntil) ||
        (row.half_open_probe_at !== null && !halfOpenProbeAt) ||
        consecutiveFailures === null
      ) {
        return {
          decision: 'block',
          reason: 'provider account runtime health is stale or malformed',
          code: 'malformed',
        };
      }
      // H1 (P5b): a genuinely future timestamp beyond the dispersion
      // tolerance is malformed data, not staleness — it must never reach the
      // half-open probe path. Only a merely-old observation is 'stale'.
      if (observedAt.getTime() - input.now.getTime() > MAX_HEALTH_OBSERVED_AT_SKEW_MS) {
        return {
          decision: 'block',
          reason: 'provider account runtime health is stale or malformed',
          code: 'malformed',
        };
      }
      if (input.now.getTime() - observedAt.getTime() > this.maxHealthAgeMs) {
        return { decision: 'block', reason: 'provider account runtime health is stale or malformed', code: 'stale' };
      }
      const status =
        row.state === 'cooldown' && cooldownUntil && cooldownUntil.getTime() <= input.now.getTime()
          ? 'degraded'
          : row.state;
      return {
        decision: 'allow',
        value: {
          status,
          observedAt,
          // Raw persisted value, never masked by the status mapping: an
          // expired cooldown (status 'degraded' with a non-null
          // cooldownUntil) is exactly the half-open probe candidate the
          // scheduling integration evaluates via isHalfOpenProbeAllowed.
          cooldownUntil,
          healthScore,
          halfOpenProbeAt,
          consecutiveFailures,
        },
      };
    } catch {
      return {
        decision: 'block',
        reason: 'provider account runtime health authority is unavailable',
        code: 'unavailable',
      };
    }
  }

  /** Record only outcomes tied to a persisted, account-scoped gateway lease. */
  async recordRuntimeOutcome(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    readonly attemptId: string;
    readonly fencingToken: string;
    readonly evidence: ProviderAccountRuntimeHealthEvidence;
  }): Promise<'applied' | 'stale'> {
    const scope = accountScope(input?.candidate);
    const evidence = normalizedEvidence(input?.evidence);
    if (!scope || !nonEmpty(input?.attemptId) || !validFence(input?.fencingToken) || !evidence) invalidInput();
    try {
      const result = await this.database.transaction((tx: SqlExecutor) =>
        tx.query<RevisionRow>(WRITE_HEALTH_SQL, [
          scope.tenantId,
          scope.ownerKind,
          scope.ownerTenantId,
          scope.accountId,
          scope.upstreamId,
          input.attemptId,
          input.fencingToken,
          scope.ownerScopeKey,
          evidence.state,
          evidence.outcome,
        ]),
      );
      // Any completed statement (including a fenced-out no-op) proves the
      // storage path works; H5b: the bounded latch resets immediately.
      this.storageRecovered();
      if (result.rows.length === 0) return 'stale';
      if (result.rows.length !== 1 || !validRevision(result.rows[0].revision)) throw storageError();
      return 'applied';
    } catch {
      this.storageFailed();
      throw storageError();
    }
  }

  /**
   * R7/D6 half-open probe admission: at most one concurrent probe per
   * account. Losing cases (still cooling, live probe, healthy or missing
   * row) all return 'closed'. A storage failure closes this runtime to
   * future selections for a bounded window (H5b), mirroring
   * recordRuntimeOutcome.
   */
  async tryAdmitHalfOpenProbe(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    readonly staleAfterMs?: number;
  }): Promise<'admitted' | 'closed'> {
    const scope = accountScope(input?.candidate);
    if (!scope) invalidInput();
    const staleAfterMs =
      input.staleAfterMs !== undefined && Number.isSafeInteger(input.staleAfterMs) && input.staleAfterMs > 0
        ? Math.min(input.staleAfterMs, MAX_HEALTH_AGE_MS)
        : this.maxHealthAgeMs;
    try {
      const result = await this.database.transaction((tx: SqlExecutor) =>
        tx.query<RevisionRow>(ADMIT_HALF_OPEN_PROBE_SQL, [
          scope.ownerScopeKey,
          scope.ownerKind,
          scope.ownerTenantId,
          scope.accountId,
          staleAfterMs,
        ]),
      );
      // A completed admission statement (including a losing CAS) proves the
      // storage path works; H5b: the bounded latch resets immediately.
      this.storageRecovered();
      if (result.rows.length === 0) return 'closed';
      if (result.rows.length !== 1 || !validRevision(result.rows[0].revision)) throw storageError();
      return 'admitted';
    } catch {
      this.storageFailed();
      throw storageError();
    }
  }
}

/*
 * ---------------------------------------------------------------------------
 * H5c (R9 bench finding P8): in-process short-term dispatch failure feedback.
 *
 * The durable runtime-health classification deliberately excludes
 * non-retryable provider 4xx outcomes (401/403/429 — "caller validation and
 * non-retryable 4xx outcomes" are not runtime evidence), so during a fault
 * window the scheduler kept dispatching to accounts returning 401/429/403
 * (25–88 dispatches per 20 s window in the R9 chaos run) because nothing
 * de-prioritized the account within the window. This registry is the
 * process-local complement: consecutive account-attributable failures put
 * the account in a short, exponentially backed-off scheduling cooldown.
 *
 * Scope discipline (fail-closed posture preserved):
 * - Only statuses the durable classification EXCLUDES and that are
 *   account-attributable count as feedback failures: 401/403 (credential or
 *   permission revoked — a hard signal) and 429 (rate limited — a soft
 *   signal). 5xx/network/protocol failures already produce a durable
 *   PostgreSQL cooldown via recordRuntimeOutcome in the same dispatch
 *   completion path; other 4xx are request-attributable and must not cool
 *   an account.
 * - The registry is a scheduling HINT only, like priority/weight: it never
 *   writes the health table, never feeds billing, and never grants access.
 *   The durable 401/403/429 classification matrix stays authoritative.
 * - In-memory only: a process restart forgets everything, and the bounded
 *   cooldowns (≤60 s) expire on their own.
 * ---------------------------------------------------------------------------
 */

/** The dispatch outcomes the failure-feedback registry understands. */
export type ProviderAccountDispatchFeedbackOutcome = 'success' | 'auth_or_permission_failure' | 'rate_limited';

/**
 * Maps a provider HTTP status to a feedback outcome. Null means "no feedback
 * signal": 5xx and unclassified statuses (plus transport errors, decided by
 * the caller) are left to the durable health classification.
 */
export function providerDispatchFeedbackOutcome(
  status: number | null | undefined,
): ProviderAccountDispatchFeedbackOutcome | null {
  if (status === 401 || status === 403) return 'auth_or_permission_failure';
  if (status === 429) return 'rate_limited';
  if (typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 299) {
    return 'success';
  }
  return null;
}

/** The dispatch-side seam: record outcomes; the scheduler side reads isExcluded. */
export interface ProviderAccountDispatchFailureFeedbackPort extends ProviderAccountSchedulerFailureFeedbackPort {
  recordDispatchOutcome(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    readonly outcome: ProviderAccountDispatchFeedbackOutcome;
  }): void;
}

/** A feedback failure with no cooldown yet cools from the second consecutive occurrence. */
const FEEDBACK_RATE_FAILURE_THRESHOLD = 2;
/** 401/403 base cooldown: a revoked credential is a hard signal — cool immediately. */
const FEEDBACK_AUTH_BASE_COOLDOWN_MS = 10_000;
const FEEDBACK_AUTH_MAX_COOLDOWN_MS = 60_000;
/** 429 base cooldown: routine rate limiting deserves only a short backoff. */
const FEEDBACK_RATE_BASE_COOLDOWN_MS = 1_000;
const FEEDBACK_RATE_MAX_COOLDOWN_MS = 30_000;
/** Consecutive failures from longer ago than this are forgotten (fresh start). */
const FEEDBACK_STALE_AFTER_MS = 300_000;
/** Hard bound on tracked accounts; the registry is a bounded process-local hint. */
const FEEDBACK_MAX_TRACKED_ACCOUNTS = 10_000;

interface FeedbackEntry {
  consecutiveFailures: number;
  lastOutcomeAt: number;
  cooledUntil: number;
}

/**
 * H5c: the in-process failure-feedback registry. Never throws, never touches
 * PostgreSQL, and resets entirely on a successful dispatch outcome.
 */
export class ProviderAccountDispatchFailureFeedback implements ProviderAccountDispatchFailureFeedbackPort {
  private readonly entries = new Map<string, FeedbackEntry>();
  private readonly now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  recordDispatchOutcome(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
    readonly outcome: ProviderAccountDispatchFeedbackOutcome;
  }): void {
    const scope = accountScope(input?.candidate);
    if (
      !scope ||
      (input.outcome !== 'success' &&
        input.outcome !== 'auth_or_permission_failure' &&
        input.outcome !== 'rate_limited')
    ) {
      return;
    }
    const now = this.now().getTime();
    const key = `${scope.ownerScopeKey} ${scope.accountId}`;
    if (input.outcome === 'success') {
      this.entries.delete(key);
      return;
    }
    const current = this.entries.get(key);
    const stale = current !== undefined && now - current.lastOutcomeAt > FEEDBACK_STALE_AFTER_MS;
    const consecutive = current === undefined || stale ? 1 : current.consecutiveFailures + 1;
    let cooledUntil = 0;
    if (input.outcome === 'auth_or_permission_failure') {
      cooledUntil =
        now +
        Math.min(FEEDBACK_AUTH_MAX_COOLDOWN_MS, FEEDBACK_AUTH_BASE_COOLDOWN_MS * 2 ** Math.min(consecutive - 1, 16));
    } else if (consecutive >= FEEDBACK_RATE_FAILURE_THRESHOLD) {
      cooledUntil =
        now +
        Math.min(
          FEEDBACK_RATE_MAX_COOLDOWN_MS,
          FEEDBACK_RATE_BASE_COOLDOWN_MS * 2 ** Math.min(consecutive - FEEDBACK_RATE_FAILURE_THRESHOLD, 16),
        );
    }
    this.entries.set(key, { consecutiveFailures: consecutive, lastOutcomeAt: now, cooledUntil });
    this.prune(now);
  }

  isExcluded(input: { readonly candidate: ProviderAccountRuntimeHealthCandidate; readonly now: Date }): boolean {
    const scope = accountScope(input?.candidate);
    if (!scope || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) return false;
    const entry = this.entries.get(`${scope.ownerScopeKey} ${scope.accountId}`);
    if (!entry) return false;
    // The cooldown is the only exclusion signal; once it expires the account
    // is schedulable again and the next recorded failure starts a fresh count.
    return input.now.getTime() < entry.cooledUntil;
  }

  /** Drops expired-and-forgotten entries and bounds the map size. */
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.cooledUntil && now - entry.lastOutcomeAt > FEEDBACK_STALE_AFTER_MS) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size <= FEEDBACK_MAX_TRACKED_ACCOUNTS) return;
    const byAge = [...this.entries.entries()].sort((left, right) => left[1].lastOutcomeAt - right[1].lastOutcomeAt);
    for (const [key] of byAge.slice(0, this.entries.size - FEEDBACK_MAX_TRACKED_ACCOUNTS)) {
      this.entries.delete(key);
    }
  }
}
