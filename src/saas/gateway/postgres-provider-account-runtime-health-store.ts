import type { SaasDatabase, SqlExecutor } from '../db/types.js';
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
     observed_at, cooldown_until, last_outcome, source_fencing_token, revision)
  SELECT $8::text, $2, $3, $4, $9::text,
         CASE WHEN $9::text = 'cooldown' THEN 1 ELSE 0 END,
         observation.observed_at,
         CASE WHEN $9::text = 'cooldown'
           THEN observation.observed_at + interval '1 second' ELSE NULL END,
         $10::text, $7::bigint, 1
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
        revision = current_health.revision + 1
  WHERE current_health.source_fencing_token < EXCLUDED.source_fencing_token
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

export class PostgresProviderAccountRuntimeHealthStore
  implements ProviderAccountSchedulerHealthPort, ProviderAccountRuntimeHealthWriter
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
}
