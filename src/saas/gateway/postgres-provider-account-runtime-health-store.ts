import type { SaasDatabase, SqlExecutor } from '../db/types.js';
import { parseHealthScoreColumn } from './health-score.js';
import type {
  ProviderAccountSchedulerHealthDecision,
  ProviderAccountSchedulerHealthPort,
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
  | { readonly decision: 'block'; readonly reason: string };

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
 */
export interface ProviderAccountHalfOpenProbeAdmissionPort {
  tryAdmitHalfOpenProbe(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
  }): Promise<'admitted' | 'closed'>;
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
     AND current_health.state = 'cooldown'
     AND current_health.cooldown_until IS NOT NULL
     AND current_health.cooldown_until <= observation.observed_at
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
  private writeFailed = false;

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

  async get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerHealthDecision> {
    if (this.writeFailed) {
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
      if (result.rows.length !== 1) {
        return { decision: 'block', reason: 'provider account runtime health is unknown' };
      }
      const row = result.rows[0];
      const observedAt = asDate(row.observed_at);
      const cooldownUntil = row.cooldown_until === null ? null : asDate(row.cooldown_until);
      if (
        !validState(row.state) ||
        !observedAt ||
        observedAt.getTime() > input.now.getTime() ||
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
    if (this.writeFailed) {
      return { decision: 'block', reason: 'provider account runtime health authority is unavailable' };
    }
    const scope = accountScope(input?.candidate, input?.caller);
    if (!scope || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
      return { decision: 'block', reason: 'provider account runtime health input is invalid' };
    }
    try {
      const result = await this.database.query<SchedulingHealthRow>(READ_SCHEDULING_SQL, [
        scope.ownerScopeKey,
        scope.accountId,
        scope.ownerKind,
        scope.ownerTenantId,
      ]);
      if (result.rows.length !== 1) {
        return { decision: 'block', reason: 'provider account runtime health is unknown' };
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
        return { decision: 'block', reason: 'provider account runtime health score is malformed' };
      }
      if (
        !validState(row.state) ||
        !observedAt ||
        observedAt.getTime() > input.now.getTime() ||
        input.now.getTime() - observedAt.getTime() > this.maxHealthAgeMs ||
        (row.cooldown_until !== null && !cooldownUntil) ||
        (row.half_open_probe_at !== null && !halfOpenProbeAt) ||
        consecutiveFailures === null
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
      return { decision: 'block', reason: 'provider account runtime health authority is unavailable' };
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
      if (result.rows.length === 0) return 'stale';
      if (result.rows.length !== 1 || !validRevision(result.rows[0].revision)) throw storageError();
      return 'applied';
    } catch {
      this.writeFailed = true;
      throw storageError();
    }
  }

  /**
   * R7/D6 half-open probe admission: at most one concurrent probe per
   * account. Losing cases (still cooling, live probe, healthy or missing
   * row) all return 'closed'. A storage failure closes this runtime to
   * future selections, mirroring recordRuntimeOutcome.
   */
  async tryAdmitHalfOpenProbe(input: {
    readonly candidate: ProviderAccountRuntimeHealthCandidate;
  }): Promise<'admitted' | 'closed'> {
    const scope = accountScope(input?.candidate);
    if (!scope) invalidInput();
    try {
      const result = await this.database.transaction((tx: SqlExecutor) =>
        tx.query<RevisionRow>(ADMIT_HALF_OPEN_PROBE_SQL, [
          scope.ownerScopeKey,
          scope.ownerKind,
          scope.ownerTenantId,
          scope.accountId,
        ]),
      );
      if (result.rows.length === 0) return 'closed';
      if (result.rows.length !== 1 || !validRevision(result.rows[0].revision)) throw storageError();
      return 'admitted';
    } catch {
      this.writeFailed = true;
      throw storageError();
    }
  }
}
