import { createHash } from 'node:crypto';
import { candidateMatchesScope, type GatewayProtocol, type SupplyMode } from './contracts.js';
import {
  allowRequestPreparation,
  blockRequestPreparation,
  type RequestPreparationCaller,
  type RequestPreparationCandidateAuthority,
  type RequestPreparationDecision,
  type RequestPreparationEntitlement,
  type RequestPreparationRouteAuthority,
  type RequestPreparationSchedulingContext,
  rejectRequestPreparation,
} from './request-preparation-service.js';

/**
 * This scheduler is deliberately a pre-lease selector. It never treats a
 * health or concurrency snapshot as permission to send traffic: the durable
 * request/attempt authority and the fenced provider-account lease remain the
 * final dispatch guards.
 *
 * R7 scheduling strategies (plan §R7, docs/token-resale-implementation-plan-
 * 2026-10-15.md; sub2api's four-level filter as the reference model): every
 * strategy is behind an option with default-off/default-neutral, so the
 * default selection order — priority tier, health rank, load-ratio order,
 * deterministic weighted draw — is byte-identical to the pre-R7 behavior
 * (proven by the golden-fixture regression test). When enabled they compose
 * as: soonest-reset promotion (a filter) → the ordered comparator registry
 * [cost-priority?, load-ratio, lru?] → the tail (seeded in-group shuffle
 * when LRU is on, otherwise the unchanged weighted draw with the optional
 * latency coefficient folded into the effective weights).
 *
 * Signal sources: quota-window resets come from the 099 codex / 100 claude /
 * 108 opencode-go account columns surfaced by the PostgreSQL eligibility
 * queries; supplier rates from saas_supplier_cost_versions via the
 * candidate's supplierCostVersion; the LRU last-used signal is the runtime
 * health authority's observedAt; latency comes from the optional health
 * `latencyMs` field, which the runtime health authority is expected to
 * populate once the R6 probe/latency signals land — until then the latency
 * coefficient stays neutral by construction.
 *
 * F2 (task #35, plan §R1/R5 follow-ups): the input carries a server-resolved
 * `billingGroupId` (forwarded to the eligibility port; the PostgreSQL
 * authority narrows the platform candidate domain to the group's account
 * pool) and optional `claudeCodeClient` evidence consumed by the PostgreSQL
 * wrapper's claude_code_only enforcement. The eligibility `scheduling`
 * signals gain `groupPoolPriority`: when any candidate carries one, a group
 * tier runs BEFORE the priority/health tiers; with no signal (the default
 * unrestricted group, BYOK, or a pool-less group) the selection is
 * byte-identical to pre-F2 — the R7 golden fixture is the red line.
 */

export interface ProviderAccountSchedulerRights {
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly supplyMode: SupplyMode;
  readonly status: 'active';
  readonly version: string | number;
  readonly effectiveAt?: string | Date | null;
  readonly expiresAt?: string | Date | null;
}

export interface ProviderAccountSchedulerEligibilityAllowed {
  readonly decision: 'allow';
  /** The same account identity, with freshly revalidated non-secret epochs. */
  readonly candidate: RequestPreparationCandidateAuthority;
  readonly status: 'active';
  readonly capability: {
    readonly protocol: GatewayProtocol;
    readonly supportLevel: 'supported' | 'limited';
    readonly validationState: 'verified' | 'unverified';
  };
  readonly rights: ProviderAccountSchedulerRights;
  /** Current route identity read by the same authority that revalidated this candidate. */
  readonly route?: ProviderAccountSchedulerRevalidatedRoute;
  /** Higher values are preferred before load balancing is applied. */
  readonly priority: number;
  /** Positive integer used by deterministic weighted choice. */
  readonly weight: number;
  /**
   * R7 scheduling signals (plan §R7, tasks #33): point-in-time, non-secret
   * scheduling-only facts revalidated by the same authority. Every field is
   * optional so pre-R7 eligibility ports keep working unchanged; absent or
   * null means "no signal" and every strategy skips the candidate. These
   * never enter the billing path (093/099/100/108 precedent).
   */
  readonly scheduling?: {
    /**
     * Earliest upcoming quota-window reset across the observed codex (099),
     * claude (100), and opencode-go (108) snapshot families, paired with the
     * refresh stamp of the family that produced it. Null when no family has
     * both an upcoming reset and a refresh stamp.
     */
    readonly soonestResetAt?: Date | string | null;
    readonly soonestResetObservedAt?: Date | string | null;
    /**
     * Blended input+output supplier rate (minor units per token) as an exact
     * rational, read from saas_supplier_cost_versions via the candidate's
     * supplierCostVersion. Null when the candidate carries no cost version.
     */
    readonly supplierCostRate?: {
      readonly numeratorMinorUnits: bigint | number | string;
      readonly denominatorUnits: bigint | number | string;
    } | null;
    /**
     * F2 (task #35) billing-group pool priority: the candidate's priority in
     * the resolved billing group's account pool (saas_billing_group_account_
     * pools, 0–1000, higher preferred). Null means "not in a narrowed pool"
     * — the unrestricted default — and the group tier is skipped entirely,
     * so the pre-F2 selection order is byte-identical. Only platform
     * candidates of a group with explicit pool rows ever carry a value.
     */
    readonly groupPoolPriority?: number | null;
  };
}

export interface ProviderAccountSchedulerRevalidatedRoute {
  readonly tenantId: string;
  readonly projectId: string;
  readonly routeConfigId: string;
  readonly routeConfigVersion: string;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly supplyMode: SupplyMode;
  readonly targetMode: 'tenant_account' | 'platform_pool';
  readonly upstreamId: string;
  readonly providerId: string;
  readonly productId: string;
}

/** Secret-free scope facts used by durable affinity storage. */
export interface ProviderAccountSchedulerAffinityScope extends ProviderAccountSchedulerRevalidatedRoute {
  readonly supplyProfileId: string;
  readonly accountOwnerKind: 'tenant' | 'platform';
}

export interface ProviderAccountSchedulerEligibilityDenied {
  readonly decision: 'deny';
  readonly reason?: string;
}

export interface ProviderAccountSchedulerEligibilityBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerEligibilityDecision =
  | ProviderAccountSchedulerEligibilityAllowed
  | ProviderAccountSchedulerEligibilityDenied
  | ProviderAccountSchedulerEligibilityBlocked;

export interface ProviderAccountSchedulerEligibilityPort {
  /**
   * Re-checks the candidate's account, credential, capability, and Provider
   * rights immediately before selection. A deny removes only this candidate;
   * an unavailable authority blocks the whole selection.
   *
   * F2 (task #35): the server-resolved billing group id narrows the platform
   * candidate domain to that group's account pool; absent means the caller is
   * BYOK (group pools never apply) or the composition did not resolve one.
   */
  revalidate(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
    readonly route?: RequestPreparationRouteAuthority;
    readonly billingGroupId?: string;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerEligibilityDecision>;
}

export interface ProviderAccountSchedulerHealthAllowed {
  readonly decision: 'allow';
  readonly value: {
    readonly status: 'healthy' | 'degraded' | 'cooldown' | 'unhealthy';
    readonly observedAt: string | Date;
    readonly cooldownUntil?: string | Date | null;
    /**
     * R7 latency awareness (plan §R7 item 4): optional upstream latency
     * observation in milliseconds. Absent/null keeps the weight modulation
     * exactly neutral; the runtime health authority is expected to populate
     * it from its latency signals when available (probe/observability
     * integration). Malformed values fail closed like every other health fact.
     */
    readonly latencyMs?: number | null;
  };
}

export interface ProviderAccountSchedulerHealthDenied {
  readonly decision: 'deny';
  readonly reason?: string;
}

export interface ProviderAccountSchedulerHealthBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerHealthDecision =
  | ProviderAccountSchedulerHealthAllowed
  | ProviderAccountSchedulerHealthDenied
  | ProviderAccountSchedulerHealthBlocked;

export interface ProviderAccountSchedulerHealthPort {
  /** Missing, stale, or unavailable distributed health state must block. */
  get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerHealthDecision>;
}

export interface ProviderAccountSchedulerConcurrencyAllowed {
  readonly decision: 'allow';
  readonly value: {
    /** This is a preflight observation, never the final lease decision. */
    readonly inFlight: number;
    readonly limit: number;
  };
}

export interface ProviderAccountSchedulerConcurrencyDenied {
  readonly decision: 'deny';
  readonly reason?: string;
}

export interface ProviderAccountSchedulerConcurrencyBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerConcurrencyDecision =
  | ProviderAccountSchedulerConcurrencyAllowed
  | ProviderAccountSchedulerConcurrencyDenied
  | ProviderAccountSchedulerConcurrencyBlocked;

export interface ProviderAccountSchedulerConcurrencyPort {
  /**
   * Reads a bounded, fail-closed capacity snapshot. The caller must still
   * acquire the fenced database lease after preparation and before I/O.
   *
   * F2 (task #35): the request identity is part of the observation input so
   * an optional Redis concurrency-slot pre-check (R6) can key its ZSET member
   * by it; ports that do not use it ignore the field.
   */
  get(input: {
    readonly caller: RequestPreparationCaller;
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly requestId: string;
    readonly now: Date;
  }): Promise<ProviderAccountSchedulerConcurrencyDecision>;
}

export interface ProviderAccountSchedulerAffinityAllowed {
  readonly decision: 'allow';
  /** Null means no valid affinity was found and is not an error. */
  readonly accountId: string | null;
}

export interface ProviderAccountSchedulerAffinityBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerAffinityDecision =
  | ProviderAccountSchedulerAffinityAllowed
  | ProviderAccountSchedulerAffinityBlocked;

export interface ProviderAccountSchedulerAffinityPort {
  /**
   * Resolves only a server-validated opaque affinity reference. The returned
   * account is merely a preference and is checked again against all filters.
   */
  resolve(input: {
    readonly caller: RequestPreparationCaller;
    readonly entitlement: RequestPreparationEntitlement;
    readonly publicModel: string;
    readonly protocol: GatewayProtocol;
    readonly context: RequestPreparationSchedulingContext;
    readonly scope: ProviderAccountSchedulerAffinityScope;
    /** Candidate ids have already passed route, rights, capability, health, and concurrency checks. */
    readonly eligibleAccountIds: readonly string[];
  }): Promise<ProviderAccountSchedulerAffinityDecision>;

  /** Called by request preparation only after it accepts the eligible selection. */
  bind?(input: {
    readonly context: RequestPreparationSchedulingContext;
    readonly scope: ProviderAccountSchedulerAffinityScope;
    readonly accountId: string;
  }): Promise<ProviderAccountSchedulerAffinityBindDecision>;
}

export type ProviderAccountSchedulerAffinityBindDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly reason: string };

export interface ProviderAccountSchedulerAffinityBindingInput {
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  readonly context: RequestPreparationSchedulingContext;
  readonly route: RequestPreparationRouteAuthority;
  readonly candidate: RequestPreparationCandidateAuthority;
}

export interface ProviderAccountSchedulerDependencies {
  /** Optional in the type only so an uncomposed runtime fails closed. */
  readonly eligibility?: ProviderAccountSchedulerEligibilityPort;
  /** Distributed/database-backed health state; no process-local fallback. */
  readonly health?: ProviderAccountSchedulerHealthPort;
  /** Capacity observation; the fenced lease remains the final authority. */
  readonly concurrency?: ProviderAccountSchedulerConcurrencyPort;
  /** Required whenever the request carries an affinity reference. */
  readonly affinity?: ProviderAccountSchedulerAffinityPort;
  /**
   * H5c (R9 bench finding P8): optional in-process, short-term failure
   * feedback. The durable runtime-health classification deliberately
   * excludes non-retryable provider 4xx outcomes (401/403/429 — caller
   * validation is not runtime evidence), so a faulted account otherwise keeps
   * receiving dispatches for as long as its health row stays fresh. This port
   * lets the composition temporarily exclude an account from selection after
   * recent dispatch failures. It is a scheduling hint only — exactly like the
   * priority/weight signals: it can never grant access, it never touches the
   * persisted health rows, and the billing/lease authorities stay exactly as
   * authoritative as before. Absent (the default) keeps the selection path
   * byte-identical (golden-fixture red line).
   *
   * P17 (R9 re-run finding): the hint is also never an admission deny. When
   * exclusion would empty the ENTIRE otherwise-eligible candidate set (the
   * all-accounts-faulted chaos scenario), the selection degrades to
   * dispatching anyway — fail-open passthrough for that one request — so the
   * client observes the provider's real status instead of a gateway 403. The
   * durable PG health classification and its cooldowns remain the only
   * authoritative admission gate; see collectEligibleCandidates.
   */
  readonly failureFeedback?: ProviderAccountSchedulerFailureFeedbackPort;
}

/**
 * H5c: the in-process failure-feedback seam consumed by the candidate loop.
 * Implementations must be synchronous, non-throwing, and process-local (the
 * PostgreSQL health rows remain the durable authority).
 */
export interface ProviderAccountSchedulerFailureFeedbackPort {
  /** True while recent dispatch failures put the account in a short-term cooldown. */
  isExcluded(input: { readonly candidate: RequestPreparationCandidateAuthority; readonly now: Date }): boolean;
}

export interface ProviderAccountSchedulerInput {
  readonly requestId: string;
  /**
   * R7 observability: the attempt this selection prepares, when the caller
   * (request preparation) has already allocated it. Optional and purely
   * informational — it never influences selection.
   */
  readonly attemptId?: string;
  readonly caller: RequestPreparationCaller;
  readonly entitlement: RequestPreparationEntitlement;
  readonly candidates: readonly RequestPreparationCandidateAuthority[];
  readonly publicModel: string;
  readonly protocol: GatewayProtocol;
  /** Server-resolved route identity; required when an affinity key is present. */
  readonly route?: RequestPreparationRouteAuthority;
  readonly scheduling?: RequestPreparationSchedulingContext;
  /**
   * F2 (task #35): the server-resolved billing group that narrows the
   * platform candidate domain (key binding, then tenant default). Set only
   * by a trusted server adapter — the PostgreSQL scheduler wrapper — never
   * by client input. Absent means BYOK or an unresolved group.
   */
  readonly billingGroupId?: string;
  /**
   * F2 (task #35) claude_code_only enforcement evidence: the request's
   * client-identity signals (user agent, path, headers, parsed body),
   * forwarded from the trusted HTTP boundary only (the clientAddress
   * precedent). Absent means no evidence: a claude_code_only group then
   * fails closed to its fallback/reject path. The scheduler never derives
   * it from anything client-controlled beyond these forwarded signals.
   */
  readonly claudeCodeClient?: ProviderAccountSchedulerClientEvidence;
}

/**
 * Structurally identical to the R5 Claude Code validator's input
 * (claude/claude-code-validator.ts); declared here so the core input type
 * carries no Claude-specific import.
 */
export interface ProviderAccountSchedulerClientEvidence {
  readonly userAgent: string | null;
  readonly path: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface ProviderAccountSchedulerPort {
  select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>>;

  /** Persists affinity after preparation accepts the selected candidate. */
  bindAffinity?(
    input: ProviderAccountSchedulerAffinityBindingInput,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision>;
}

/**
 * R7 scheduling-strategy toggles (plan §R7, docs/token-resale-implementation-
 * plan-2026-10-15.md). Every strategy is default-off/default-neutral so the
 * default selection order — priority tier, health rank, load-ratio order,
 * deterministic weighted draw — is byte-identical to the pre-R7 behavior.
 */
export interface ProviderAccountSchedulerSoonestResetStrategyOptions {
  /** Default false: no promotion, pre-R7 behavior. */
  readonly enabled?: boolean;
  /**
   * Use-it-or-lose-it horizon: a quota window counts as imminent when it
   * resets strictly less than this many milliseconds from now.
   * Default 30 minutes.
   */
  readonly windowMs?: number;
  /**
   * Stale-snapshot guard: a window's reset only counts while the snapshot
   * family that observed it was refreshed within this many milliseconds.
   * Default 30 minutes.
   */
  readonly snapshotMaxAgeMs?: number;
}

export interface ProviderAccountSchedulerStrategiesOptions {
  /**
   * Soonest-reset promotion: after candidate filtering, accounts whose
   * quota-window snapshot (099 codex / 100 claude / 108 opencode-go columns)
   * resets within the horizon are promoted ahead of the rest of their
   * priority tier.
   */
  readonly soonestReset?: ProviderAccountSchedulerSoonestResetStrategyOptions;
  /**
   * Cost priority: within the promoted tier, order candidates by their
   * saas_supplier_cost_versions rate ascending (exact rational compare;
   * subscription pools at ~0 cost sort ahead of pay-as-you-go keys).
   */
  readonly costPriority?: { readonly enabled?: boolean };
  /**
   * LRU tie-break + in-group shuffle: orders by least-recently-used first
   * (runtime-health observedAt as the last-used signal; never-used first)
   * and replaces the deterministic-draw tail with a seeded shuffle inside
   * groups that tie on the whole comparator chain (anti-thundering-herd).
   * The shuffle seed derives from the request identity, so runs stay
   * reproducible; the deterministic draw remains the default tail.
   */
  readonly lru?: { readonly enabled?: boolean };
  /**
   * Latency awareness: folds the health authority's latency signal into the
   * effective draw weight — weight × (1 − coefficient × min(1, latency /
   * 30s)), floored at the 0.05 multiplier. Default 0 keeps every weight
   * exactly unchanged.
   */
  readonly latencyWeightCoefficient?: number;
}

/**
 * Observability record attached to an allowed selection when any R7 strategy
 * is enabled: which tail algorithm chose the account and which strategy
 * dimensions actually discriminated the outcome.
 */
export interface ProviderAccountSchedulerSelectionTrace {
  readonly strategy: string;
  readonly reasons: readonly string[];
}

export interface ProviderAccountSchedulerOptions {
  readonly now?: () => Date;
  readonly maxHealthAgeMs?: number;
  readonly strategies?: ProviderAccountSchedulerStrategiesOptions;
}

/** Exact non-negative integer as persisted by PostgreSQL (bigint/text/safe number). */
function exactNonNegativeInteger(value: unknown): bigint | null {
  try {
    const parsed =
      typeof value === 'bigint'
        ? value
        : typeof value === 'number' && Number.isSafeInteger(value)
          ? BigInt(value)
          : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
            ? BigInt(value)
            : null;
    return parsed !== null && parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

interface EligibleCandidate {
  readonly candidate: RequestPreparationCandidateAuthority;
  readonly priority: number;
  readonly weight: number;
  readonly inFlight: number;
  readonly concurrencyLimit: number;
  readonly healthRank: number;
  readonly accountId: string;
  readonly route?: ProviderAccountSchedulerRevalidatedRoute;
  /** R7 scheduling signals; null means "no signal" and every strategy skips the candidate. */
  readonly soonestResetAt: Date | null;
  readonly soonestResetObservedAt: Date | null;
  readonly supplierCost: { readonly numeratorMinorUnits: bigint; readonly denominatorUnits: bigint } | null;
  /** LRU signal: the health authority's last observation time (never-used = null). */
  readonly lastUsedAt: Date | null;
  /** R7 latency signal in milliseconds; null keeps the weight modulation neutral. */
  readonly latencyMs: number | null;
  /**
   * F2 billing-group pool priority; null means the candidate is not in a
   * narrowed group pool and the group tier is skipped (pre-F2 behavior).
   */
  readonly groupPriority: number | null;
}

const DEFAULT_MAX_HEALTH_AGE_MS = 30_000;
const MAX_HEALTH_AGE_MS = 86_400_000;

/**
 * H1 (R9 bench finding P5b): the persisted runtime-health `observed_at` is
 * written by the PostgreSQL clock (`clock_timestamp()`), while this gate
 * compares against the gateway process clock (`input.now`). Cross-process
 * clock dispersion (measured at 15–30 ms between the gateway and Postgres
 * containers during the R9 bench; NTP-synced fleets typically stay within a
 * few tens of milliseconds) therefore yields rows a few milliseconds "in the
 * future", which used to be treated as malformed and blocked ~5–15% of
 * admissions under load. An `observedAt` up to this many milliseconds AHEAD
 * of `now` is now clamped to age 0; anything further ahead is still a
 * genuinely future timestamp (clock misconfiguration, not dispersion) and
 * fails closed exactly as before.
 */
export const MAX_HEALTH_OBSERVED_AT_SKEW_MS = 250;

/** Resolves the health freshness bound shared by the scheduler and its ports. */
export function resolveMaxHealthAgeMs(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_HEALTH_AGE_MS)
    : DEFAULT_MAX_HEALTH_AGE_MS;
}
const MAX_IDENTIFIER_LENGTH = 512;
const POSITIVE_INTEGER_MAX = 1_000_000_000;

/* R7 (plan §R7) strategy defaults and bounds. */
/** Use-it-or-lose-it horizon: quota windows resetting sooner than this are imminent. */
const SOONEST_RESET_DEFAULT_WINDOW_MS = 30 * 60_000;
/** Stale-snapshot guard: resets only count while their family snapshot is this fresh. */
const SOONEST_RESET_DEFAULT_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
/** Latency at which the R7 latency penalty saturates (p99-scale upstream latency). */
const LATENCY_REFERENCE_MS = 30_000;
/** Multiplier floor (0.05) mirroring HEALTH_SCORE_WEIGHT_FLOOR in health-score.ts. */
const LATENCY_MULTIPLIER_FLOOR_MILLI = 50;
/** Upper bound on a plausible health-authority latency observation. */
const LATENCY_MS_MAX = 3_600_000;
/** Migration-105 CHECK bound on saas_billing_group_account_pools.priority. */
const BILLING_GROUP_POOL_PRIORITY_MAX = 1000;

/** F2: parses the eligibility group-pool priority signal; null = unrestricted. */
function groupPoolPrioritySignal(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > BILLING_GROUP_POOL_PRIORITY_MAX
  ) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value === value.trim() && !value.includes('\u0000');
}

function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? new Date(value.getTime()) : typeof value === 'string' ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= POSITIVE_INTEGER_MAX;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= POSITIVE_INTEGER_MAX;
}

function revision(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1;
  if (typeof value === 'string') return /^[1-9][0-9]*$/.test(value);
  return typeof value === 'bigint' && value >= 1n;
}

function revisionText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return String(value);
  if (typeof value === 'bigint' && value >= 1n) return value.toString();
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  return null;
}

function withinWindow(value: unknown, now: Date): boolean {
  const effectiveAt = date(value);
  return effectiveAt === null || effectiveAt.getTime() <= now.getTime();
}

function notExpired(value: unknown, now: Date): boolean {
  const expiresAt = date(value);
  return expiresAt === null || expiresAt.getTime() > now.getTime();
}

function sameCandidateIdentity(
  original: RequestPreparationCandidateAuthority,
  refreshed: RequestPreparationCandidateAuthority,
): boolean {
  return (
    refreshed.tenantId === original.tenantId &&
    refreshed.projectId === original.projectId &&
    refreshed.proxyKeyId === original.proxyKeyId &&
    refreshed.supplyProfileId === original.supplyProfileId &&
    refreshed.supplyMode === original.supplyMode &&
    refreshed.accountId === original.accountId &&
    refreshed.upstreamId === original.upstreamId &&
    refreshed.credentialId === original.credentialId &&
    refreshed.providerId === original.providerId &&
    refreshed.productId === original.productId &&
    refreshed.resolvedModel === original.resolvedModel &&
    refreshed.protocol === original.protocol &&
    refreshed.endpoint === original.endpoint &&
    refreshed.supplierCostVersion === original.supplierCostVersion
  );
}

function validAffinityContext(context: RequestPreparationSchedulingContext | undefined): boolean {
  if (!context) return true;
  const fields = [context.previousResponseId, context.sessionId].filter((value) => value !== undefined);
  return (
    fields.every((value) => nonEmpty(value) && value.length <= MAX_IDENTIFIER_LENGTH) &&
    (context.attemptedAccountIds === undefined ||
      (Array.isArray(context.attemptedAccountIds) &&
        new Set(context.attemptedAccountIds).size === context.attemptedAccountIds.length &&
        context.attemptedAccountIds.every((value) => nonEmpty(value) && value.length <= MAX_IDENTIFIER_LENGTH))) &&
    (fields.length > 0 || (context.attemptedAccountIds?.length ?? 0) > 0)
  );
}

function hasAffinityReference(context: RequestPreparationSchedulingContext | undefined): boolean {
  return Boolean(context?.previousResponseId !== undefined || context?.sessionId !== undefined);
}

function validRevalidatedRoute(
  route: unknown,
  input: ProviderAccountSchedulerInput,
  candidate: RequestPreparationCandidateAuthority,
): route is ProviderAccountSchedulerRevalidatedRoute {
  if (!isRecord(route)) return false;
  const source = input.route;
  return (
    nonEmpty(route.tenantId) &&
    route.tenantId === input.caller.tenantId &&
    nonEmpty(route.projectId) &&
    route.projectId === input.caller.projectId &&
    nonEmpty(route.routeConfigId) &&
    nonEmpty(route.routeConfigVersion) &&
    revisionText(route.routeConfigVersion) !== null &&
    nonEmpty(route.publicModelId) &&
    nonEmpty(route.publicModelVersion) &&
    revisionText(route.publicModelVersion) !== null &&
    route.publicModel === input.publicModel &&
    route.protocol === input.protocol &&
    route.supplyMode === input.caller.supplyMode &&
    route.targetMode === (input.caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool') &&
    nonEmpty(route.upstreamId) &&
    route.upstreamId === candidate.upstreamId &&
    nonEmpty(route.providerId) &&
    route.providerId === candidate.providerId &&
    nonEmpty(route.productId) &&
    route.productId === candidate.productId &&
    (source === undefined ||
      (route.routeConfigId === source.routeConfigId &&
        revisionText(route.routeConfigVersion) === revisionText(source.routeConfigVersion) &&
        route.publicModelId === source.publicModelId &&
        revisionText(route.publicModelVersion) === revisionText(source.publicModelVersion) &&
        route.tenantId === source.tenantId &&
        route.projectId === source.projectId &&
        route.publicModel === source.publicModel &&
        route.protocol === source.protocol &&
        route.supplyMode === input.caller.supplyMode &&
        route.targetMode === source.targetMode &&
        route.upstreamId === source.upstreamId &&
        candidate.endpoint === source.endpoint))
  );
}

function affinityScopeFromSelection(
  input: ProviderAccountSchedulerInput,
  eligible: readonly EligibleCandidate[],
): ProviderAccountSchedulerAffinityScope | null {
  const first = eligible[0];
  if (!first?.route || !validRevalidatedRoute(first.route, input, first.candidate)) return null;
  for (const current of eligible) {
    if (
      !current.route ||
      !validRevalidatedRoute(current.route, input, current.candidate) ||
      current.route.routeConfigId !== first.route.routeConfigId ||
      current.route.routeConfigVersion !== first.route.routeConfigVersion ||
      current.route.publicModelId !== first.route.publicModelId ||
      current.route.publicModelVersion !== first.route.publicModelVersion ||
      current.route.upstreamId !== first.route.upstreamId ||
      current.route.providerId !== first.route.providerId ||
      current.route.productId !== first.route.productId
    ) {
      return null;
    }
  }
  return {
    ...first.route,
    supplyProfileId: input.caller.supplyProfileId,
    accountOwnerKind: input.caller.supplyMode === 'byok' ? 'tenant' : 'platform',
  };
}

function affinityScopeFromBinding(
  input: ProviderAccountSchedulerAffinityBindingInput,
): ProviderAccountSchedulerAffinityScope | null {
  const { caller, entitlement, publicModel, protocol, route, candidate } = input;
  if (
    !nonEmpty(route.routeConfigId) ||
    !revisionText(route.routeConfigVersion) ||
    !nonEmpty(route.publicModelId) ||
    !revisionText(route.publicModelVersion) ||
    !nonEmpty(route.upstreamId) ||
    route.tenantId !== caller.tenantId ||
    route.projectId !== caller.projectId ||
    route.publicModel !== publicModel ||
    route.protocol !== protocol ||
    candidate.tenantId !== caller.tenantId ||
    candidate.projectId !== caller.projectId ||
    candidate.supplyProfileId !== caller.supplyProfileId ||
    candidate.supplyMode !== caller.supplyMode ||
    candidate.supplyMode !== entitlement.supplyMode ||
    candidate.upstreamId !== route.upstreamId ||
    candidate.protocol !== protocol ||
    candidate.providerId === '' ||
    candidate.productId === '' ||
    candidate.endpoint !== route.endpoint ||
    route.targetMode !== (caller.supplyMode === 'byok' ? 'tenant_account' : 'platform_pool')
  ) {
    return null;
  }
  return {
    tenantId: caller.tenantId,
    projectId: caller.projectId,
    supplyProfileId: caller.supplyProfileId,
    supplyMode: caller.supplyMode,
    routeConfigId: route.routeConfigId,
    routeConfigVersion: revisionText(route.routeConfigVersion) as string,
    publicModelId: route.publicModelId,
    publicModelVersion: revisionText(route.publicModelVersion) as string,
    publicModel,
    protocol,
    targetMode: route.targetMode,
    upstreamId: route.upstreamId,
    providerId: candidate.providerId,
    productId: candidate.productId,
    accountOwnerKind: candidate.accountOwnerKind,
  };
}

function healthStatusRank(status: ProviderAccountSchedulerHealthAllowed['value']['status']): number {
  return status === 'healthy' ? 0 : 1;
}

function healthValue(
  decision: ProviderAccountSchedulerHealthDecision,
  now: Date,
  maxHealthAgeMs: number,
): { readonly rank: number; readonly observedAt: Date; readonly latencyMs: number | null } | 'deny' | 'block' {
  if (
    !isRecord(decision) ||
    (decision.decision !== 'allow' && decision.decision !== 'deny' && decision.decision !== 'block')
  ) {
    return 'block';
  }
  if (decision.decision === 'deny') return 'deny';
  if (decision.decision === 'block') return 'block';
  const value = decision.value;
  if (!isRecord(value)) return 'block';
  if (
    value.status !== 'healthy' &&
    value.status !== 'degraded' &&
    value.status !== 'cooldown' &&
    value.status !== 'unhealthy'
  ) {
    return 'block';
  }
  const observedAt = date(value.observedAt);
  if (!observedAt) return 'block';
  // H1 (P5b): small negative age — the PostgreSQL writer clock running ahead
  // of the gateway clock — is clamped to age 0; only a genuinely future
  // timestamp beyond MAX_HEALTH_OBSERVED_AT_SKEW_MS stays malformed.
  if (observedAt.getTime() - now.getTime() > MAX_HEALTH_OBSERVED_AT_SKEW_MS) return 'block';
  if (now.getTime() - observedAt.getTime() > maxHealthAgeMs) return 'block';
  // R7: the optional latency signal must be a plausible non-negative duration;
  // anything else is authority drift and fails closed like the other facts.
  const latencyMs = value.latencyMs;
  if (latencyMs !== undefined && latencyMs !== null) {
    if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > LATENCY_MS_MAX) {
      return 'block';
    }
  }
  const cooldownUntil =
    value.cooldownUntil === undefined || value.cooldownUntil === null ? null : date(value.cooldownUntil);
  if (value.cooldownUntil !== undefined && value.cooldownUntil !== null && cooldownUntil === null) return 'block';
  if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) return 'deny';
  if (value.status === 'cooldown' || value.status === 'unhealthy') return 'deny';
  return { rank: healthStatusRank(value.status), observedAt, latencyMs: latencyMs ?? null };
}

function validRights(
  rights: unknown,
  candidate: RequestPreparationCandidateAuthority,
  protocol: GatewayProtocol,
  now: Date,
): boolean {
  if (!isRecord(rights)) return false;
  return (
    rights.status === 'active' &&
    rights.providerId === candidate.providerId &&
    rights.productId === candidate.productId &&
    rights.model === candidate.resolvedModel &&
    rights.endpoint === candidate.endpoint &&
    rights.supplyMode === candidate.supplyMode &&
    candidate.protocol === protocol &&
    revision(rights.version) &&
    withinWindow(rights.effectiveAt, now) &&
    notExpired(rights.expiresAt, now)
  );
}

function validSchedulingSignals(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const resetAt = value.soonestResetAt;
  if (resetAt !== undefined && resetAt !== null && date(resetAt) === null) return false;
  const observedAt = value.soonestResetObservedAt;
  if (observedAt !== undefined && observedAt !== null && date(observedAt) === null) return false;
  const rate = value.supplierCostRate;
  if (rate !== undefined && rate !== null) {
    if (!isRecord(rate)) return false;
    const numerator = exactNonNegativeInteger(rate.numeratorMinorUnits);
    const denominator = exactNonNegativeInteger(rate.denominatorUnits);
    if (numerator === null || denominator === null || denominator === 0n) return false;
  }
  // F2: the billing-group pool priority must be a safe integer in the
  // migration-105 CHECK range when present; null/absent means unrestricted.
  const groupPoolPriority = value.groupPoolPriority;
  if (groupPoolPriority !== undefined && groupPoolPriority !== null) {
    if (
      typeof groupPoolPriority !== 'number' ||
      !Number.isSafeInteger(groupPoolPriority) ||
      groupPoolPriority < 0 ||
      groupPoolPriority > BILLING_GROUP_POOL_PRIORITY_MAX
    ) {
      return false;
    }
  }
  return true;
}

function validEligibility(
  value: unknown,
  original: RequestPreparationCandidateAuthority,
  input: ProviderAccountSchedulerInput,
  now: Date,
): value is ProviderAccountSchedulerEligibilityAllowed {
  if (!isRecord(value) || value.decision !== 'allow') return false;
  if (!isRecord(value.candidate)) return false;
  const refreshed = value.candidate as unknown as RequestPreparationCandidateAuthority;
  if (!sameCandidateIdentity(original, refreshed)) {
    return false;
  }
  if (value.route !== undefined && !validRevalidatedRoute(value.route, input, refreshed)) return false;
  if (!candidateMatchesScope(input.caller, refreshed)) return false;
  if (
    value.status !== 'active' ||
    !isRecord(value.capability) ||
    value.capability.protocol !== input.protocol ||
    value.capability.supportLevel !== 'supported' ||
    value.capability.validationState !== 'verified' ||
    !validRights(value.rights, refreshed, input.protocol, now) ||
    !positiveInteger(value.weight) ||
    typeof value.priority !== 'number' ||
    !Number.isSafeInteger(value.priority) ||
    value.priority < 0 ||
    value.priority > POSITIVE_INTEGER_MAX ||
    !validSchedulingSignals(value.scheduling)
  ) {
    return false;
  }
  return true;
}

function compareLoadRatio(left: EligibleCandidate, right: EligibleCandidate): number {
  const leftNumerator = BigInt(left.inFlight) * BigInt(right.concurrencyLimit);
  const rightNumerator = BigInt(right.inFlight) * BigInt(left.concurrencyLimit);
  return leftNumerator < rightNumerator ? -1 : leftNumerator > rightNumerator ? 1 : 0;
}

function compareLoad(left: EligibleCandidate, right: EligibleCandidate): number {
  const ratio = compareLoadRatio(left, right);
  if (ratio !== 0) return ratio;
  return left.accountId.localeCompare(right.accountId);
}

/**
 * R7 cost-priority comparator: exact rational cross-multiplication of the
 * blended input+output supplier rate (minor units per token). Unknown cost —
 * no supplier cost version (BYOK candidates) or a missing snapshot row —
 * sorts after every known rate, so unpriced supply is never rewarded.
 */
function compareSupplierCost(left: EligibleCandidate, right: EligibleCandidate): number {
  if (left.supplierCost === null) return right.supplierCost === null ? 0 : 1;
  if (right.supplierCost === null) return -1;
  const leftNumerator = left.supplierCost.numeratorMinorUnits * right.supplierCost.denominatorUnits;
  const rightNumerator = right.supplierCost.numeratorMinorUnits * left.supplierCost.denominatorUnits;
  return leftNumerator < rightNumerator ? -1 : leftNumerator > rightNumerator ? 1 : 0;
}

/**
 * R7 LRU comparator: least recently used first. A null last-used signal
 * (never observed by the health authority) counts as the least recently
 * used, mirroring the sub2api "LastUsedAt empty is smallest" rule.
 */
function compareLastUsed(left: EligibleCandidate, right: EligibleCandidate): number {
  if (left.lastUsedAt === null) return right.lastUsedAt === null ? 0 : -1;
  if (right.lastUsedAt === null) return 1;
  const leftTime = left.lastUsedAt.getTime();
  const rightTime = right.lastUsedAt.getTime();
  return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0;
}

/** One entry in the ordered R7 strategy registry applied before the account-id tie-break. */
interface OrderingStrategy {
  readonly name: 'cost-priority' | 'load' | 'lru';
  readonly compare: (left: EligibleCandidate, right: EligibleCandidate) => number;
}

function compareByStrategies(
  left: EligibleCandidate,
  right: EligibleCandidate,
  strategies: readonly OrderingStrategy[],
): number {
  for (const strategy of strategies) {
    const order = strategy.compare(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * R7 latency multiplier in per-mille: 1000 = exactly today's weight. The
 * penalty saturates at LATENCY_REFERENCE_MS and the multiplier never drops
 * below the 0.05 floor, mirroring the health-score weight floor.
 */
function latencyMultiplierMilli(latencyMs: number | null, coefficient: number): number {
  if (coefficient <= 0 || latencyMs === null) return 1000;
  const penalty = Math.min(1, latencyMs / LATENCY_REFERENCE_MS);
  const milli = Math.round(1000 * (1 - coefficient * penalty));
  return Math.max(LATENCY_MULTIPLIER_FLOOR_MILLI, Math.min(1000, milli));
}

function effectiveWeight(candidate: EligibleCandidate, latencyWeightCoefficient: number): bigint {
  const numerator = BigInt(candidate.weight) * BigInt(candidate.concurrencyLimit);
  const denominator = BigInt(candidate.concurrencyLimit + candidate.inFlight);
  const base = numerator / denominator > 0n ? numerator / denominator : 1n;
  const multiplierMilli = latencyMultiplierMilli(candidate.latencyMs, latencyWeightCoefficient);
  // multiplierMilli === 1000 returns the exact pre-R7 value (and the exact draw).
  if (multiplierMilli === 1000) return base;
  const adjusted = (base * BigInt(multiplierMilli)) / 1000n;
  return adjusted > 0n ? adjusted : 1n;
}

function deterministicDraw(seed: string, totalWeight: bigint): bigint {
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex');
  return BigInt(`0x${digest.slice(0, 16)}`) % totalWeight;
}

function selectionSeed(requestId: string, input: ProviderAccountSchedulerInput): string {
  return [
    requestId,
    input.caller.tenantId,
    input.caller.projectId,
    input.caller.proxyKeyId,
    input.caller.supplyProfileId,
    input.caller.supplyMode,
    input.publicModel,
    input.protocol,
  ].join('\u001f');
}

function drawWeighted(
  ordered: readonly EligibleCandidate[],
  seed: string,
  latencyWeightCoefficient: number,
): EligibleCandidate {
  const totalWeight = ordered.reduce(
    (total, candidate) => total + effectiveWeight(candidate, latencyWeightCoefficient),
    0n,
  );
  let draw = deterministicDraw(seed, totalWeight);
  for (const candidate of ordered) {
    const weight = effectiveWeight(candidate, latencyWeightCoefficient);
    if (draw < weight) return candidate;
    draw -= weight;
  }
  return ordered[ordered.length - 1] as EligibleCandidate;
}

function chooseWeighted(
  candidates: readonly EligibleCandidate[],
  requestId: string,
  input: ProviderAccountSchedulerInput,
): EligibleCandidate {
  const ordered = [...candidates].sort(compareLoad);
  return drawWeighted(ordered, selectionSeed(requestId, input), 0);
}

/** Deterministic sha256-counter PRNG; reproducible for a fixed seed. */
function seededRandom(seed: string): () => number {
  let counter = 0;
  return () => {
    const digest = createHash('sha256').update(`${seed}\u001f${counter++}`, 'utf8').digest('hex');
    return Number(BigInt(`0x${digest.slice(0, 13)}`)) / 2 ** 52;
  };
}

function fisherYatesShuffle<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = items[index];
    items[index] = items[swap] as T;
    items[swap] = held as T;
  }
}

/**
 * R7 LRU tail: candidates are already in a total order extending the
 * strategy chain; groups that tie on the whole chain are shuffled with the
 * request-derived seed (anti-thundering-herd) and the first candidate wins.
 * Groups of one are untouched, so any strict chain order is preserved.
 */
function chooseByChainOrder(
  ordered: readonly EligibleCandidate[],
  strategies: readonly OrderingStrategy[],
  seed: string,
): EligibleCandidate {
  const groups: EligibleCandidate[][] = [];
  for (const candidate of ordered) {
    const current = groups[groups.length - 1];
    if (current && compareByStrategies(current[0] as EligibleCandidate, candidate, strategies) === 0) {
      current.push(candidate);
    } else {
      groups.push([candidate]);
    }
  }
  const flattened: EligibleCandidate[] = [];
  for (const group of groups) {
    if (group.length > 1) fisherYatesShuffle(group, seededRandom(seed));
    flattened.push(...group);
  }
  return flattened[0] as EligibleCandidate;
}

function schedulerBlock(message: string): RequestPreparationDecision<never> {
  return blockRequestPreparation('capability_unavailable', message);
}

/** Resolved R7 strategy configuration; every default preserves pre-R7 behavior. */
interface ResolvedStrategies {
  readonly anyEnabled: boolean;
  readonly soonestResetEnabled: boolean;
  readonly soonestResetWindowMs: number;
  readonly soonestResetSnapshotMaxAgeMs: number;
  readonly costPriorityEnabled: boolean;
  readonly lruEnabled: boolean;
  readonly latencyWeightCoefficient: number;
}

/** A provided strategy window must be a positive safe integer; absent falls back. */
function positiveMsOption(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('scheduler strategy windows must be positive safe integers');
  }
  return value;
}

function resolveStrategies(options: ProviderAccountSchedulerStrategiesOptions | undefined): ResolvedStrategies {
  const soonestReset = options?.soonestReset;
  const windowMs = positiveMsOption(soonestReset?.windowMs, SOONEST_RESET_DEFAULT_WINDOW_MS);
  const snapshotMaxAgeMs = positiveMsOption(soonestReset?.snapshotMaxAgeMs, SOONEST_RESET_DEFAULT_SNAPSHOT_MAX_AGE_MS);
  const coefficient = options?.latencyWeightCoefficient ?? 0;
  if (typeof coefficient !== 'number' || !Number.isFinite(coefficient) || coefficient < 0 || coefficient > 1) {
    throw new TypeError('scheduler latency weight coefficient must be a finite number in [0, 1]');
  }
  const soonestResetEnabled = soonestReset?.enabled === true;
  const costPriorityEnabled = options?.costPriority?.enabled === true;
  const lruEnabled = options?.lru?.enabled === true;
  return {
    anyEnabled: soonestResetEnabled || costPriorityEnabled || lruEnabled || coefficient > 0,
    soonestResetEnabled,
    soonestResetWindowMs: windowMs,
    soonestResetSnapshotMaxAgeMs: snapshotMaxAgeMs,
    costPriorityEnabled,
    lruEnabled,
    latencyWeightCoefficient: coefficient,
  };
}

/**
 * Selects one authorized account from a server-provided candidate set.
 * Candidate authority is refreshed before ranking; sticky state can only move
 * an already eligible candidate to the front and can never grant access.
 */
export class ProviderAccountScheduler implements ProviderAccountSchedulerPort {
  private readonly now: () => Date;
  private readonly maxHealthAgeMs: number;
  private readonly strategies: ResolvedStrategies;
  /**
   * R7 strategy registry: the ordered comparators applied before the
   * account-id tie-break when strategies are enabled. Cost priority leads
   * (commercial tiering inside the priority tier), the existing load-ratio
   * order balances within a cost tier, and LRU breaks load ties — the exact
   * sub2api filter order the plan prescribes. With no strategies enabled the
   * registry is the single load-ratio entry and the selection path is
   * byte-identical to pre-R7.
   */
  private readonly orderingStrategies: readonly OrderingStrategy[];

  constructor(
    private readonly dependencies: ProviderAccountSchedulerDependencies,
    options: ProviderAccountSchedulerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxHealthAgeMs = resolveMaxHealthAgeMs(options.maxHealthAgeMs);
    this.strategies = resolveStrategies(options.strategies);
    const chain: OrderingStrategy[] = [];
    if (this.strategies.costPriorityEnabled) {
      chain.push({ name: 'cost-priority', compare: compareSupplierCost });
    }
    chain.push({ name: 'load', compare: compareLoadRatio });
    if (this.strategies.lruEnabled) {
      chain.push({ name: 'lru', compare: compareLastUsed });
    }
    this.orderingStrategies = chain;
  }

  async select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>> {
    try {
      const now = this.now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
        return schedulerBlock('scheduler clock is unavailable');
      if (
        !isRecord(input) ||
        !isRecord(input.caller) ||
        !isRecord(input.entitlement) ||
        !nonEmpty(input.requestId) ||
        (input.attemptId !== undefined && !nonEmpty(input.attemptId)) ||
        !nonEmpty(input.publicModel) ||
        (input.billingGroupId !== undefined && !nonEmpty(input.billingGroupId)) ||
        !nonEmpty(input.caller.tenantId) ||
        !nonEmpty(input.caller.projectId) ||
        !nonEmpty(input.caller.proxyKeyId) ||
        !nonEmpty(input.caller.supplyProfileId) ||
        (input.caller.supplyMode !== 'byok' && input.caller.supplyMode !== 'platform')
      ) {
        return schedulerBlock('scheduler input is invalid');
      }
      if (!validAffinityContext(input.scheduling)) return schedulerBlock('scheduler affinity context is invalid');
      if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
        return rejectRequestPreparation('account_denied', 'no eligible provider account is available');
      }
      if (!this.dependencies.eligibility || !this.dependencies.health || !this.dependencies.concurrency) {
        return schedulerBlock('provider account scheduler storage ports are unavailable');
      }
      if (hasAffinityReference(input.scheduling) && !this.dependencies.affinity) {
        return schedulerBlock('provider account affinity storage is unavailable');
      }

      const firstPass = await this.collectEligibleCandidates(input, now, input.candidates, {
        ignoreFailureFeedback: false,
      });
      if (firstPass.outcome === 'blocked') return schedulerBlock(firstPass.reason);
      let eligible = firstPass.eligible;
      /*
       * P17 (R9 re-run finding): fail-open passthrough when the in-process
       * failure-feedback cooldown would empty the entire viable candidate
       * set. Exclusions are computed per selection: pass one skips cooled
       * candidates exactly like a health deny (preserving the H5c 3–6×
       * fault-window dispatch reduction whenever any non-excluded candidate
       * survives), and only when NO candidate survived does the selection
       * re-run the excluded candidates with the hint cleared — the request
       * then dispatches and the provider's real status reaches the client.
       * The durable PG health classification (checked inside the fallback
       * pass like any other) stays the authoritative admission gate: if the
       * excluded candidates also fail eligibility/health/concurrency there,
       * the selection still rejects exactly as before.
       */
      if (eligible.length === 0 && firstPass.failureFeedbackSkipped.length > 0) {
        const fallbackPass = await this.collectEligibleCandidates(input, now, firstPass.failureFeedbackSkipped, {
          ignoreFailureFeedback: true,
        });
        if (fallbackPass.outcome === 'blocked') return schedulerBlock(fallbackPass.reason);
        eligible = fallbackPass.eligible;
      }

      if (eligible.length === 0)
        return rejectRequestPreparation('account_denied', 'no eligible provider account is available');

      try {
        let affinityAccountId: string | null = null;
        if (hasAffinityReference(input.scheduling)) {
          const scope = affinityScopeFromSelection(input, eligible);
          if (!scope) return schedulerBlock('provider account affinity route scope is unavailable or stale');
          const affinity = await this.dependencies.affinity?.resolve({
            caller: input.caller,
            entitlement: input.entitlement,
            publicModel: input.publicModel,
            protocol: input.protocol,
            context: input.scheduling as RequestPreparationSchedulingContext,
            scope,
            eligibleAccountIds: eligible.map(({ accountId }) => accountId),
          });
          if (!isRecord(affinity) || (affinity.decision !== 'allow' && affinity.decision !== 'block')) {
            return schedulerBlock('provider account affinity authority returned an invalid decision');
          }
          if (affinity.decision === 'block') return schedulerBlock(affinity.reason);
          if (affinity.accountId !== null && !nonEmpty(affinity.accountId)) {
            return schedulerBlock('provider account affinity returned an invalid account');
          }
          affinityAccountId = affinity.accountId;
        }

        /*
         * F2 (task #35) billing-group pool tier: candidates carrying a group
         * pool priority (a group with explicit pool rows narrows the domain,
         * so every eligible candidate carries one) are tiered by it BEFORE
         * the existing priority/health tiers. When no candidate carries a
         * signal — the unrestricted default, BYOK, or a pool-less group —
         * `tiered` is exactly `eligible` and the ranking chain is
         * byte-identical to pre-F2. A defensive mix (impossible under the
         * narrowing SQL, which excludes non-members) keeps only the highest
         * group tier rather than guessing.
         */
        const groupPriorities = eligible
          .map((candidate) => candidate.groupPriority)
          .filter((value): value is number => value !== null);
        const tiered =
          groupPriorities.length === 0
            ? eligible
            : eligible.filter((candidate) => candidate.groupPriority === Math.max(...groupPriorities));
        const highestTierPriority = Math.max(...tiered.map((candidate) => candidate.priority));
        const bestPriority = tiered.filter((candidate) => candidate.priority === highestTierPriority);
        const bestHealthRank = Math.min(...bestPriority.map((candidate) => candidate.healthRank));
        const ranked = bestPriority.filter((candidate) => candidate.healthRank === bestHealthRank);
        const preferred =
          affinityAccountId === null ? undefined : eligible.find(({ accountId }) => accountId === affinityAccountId);
        if (affinityAccountId !== null && !preferred) {
          return schedulerBlock('persisted provider account affinity target is no longer eligible');
        }
        if (preferred) {
          return allowRequestPreparation(
            preferred.candidate,
            this.strategies.anyEnabled ? { strategy: 'affinity', reasons: ['affinity'] } : undefined,
          );
        }
        if (!this.strategies.anyEnabled) {
          return allowRequestPreparation(chooseWeighted(ranked, input.requestId, input).candidate);
        }
        const selected = this.chooseByStrategyRegistry(ranked, input, now);
        return allowRequestPreparation(selected.candidate.candidate, selected.trace);
      } catch {
        return schedulerBlock('provider account scheduler failed closed');
      }
    } catch {
      return schedulerBlock('provider account scheduler failed closed');
    }
  }

  /**
   * One pass of the per-candidate check chain: duplicate/scope validation →
   * H5c failure-feedback exclusion → eligibility revalidation → health →
   * concurrency. Every authority decision keeps its exact pre-P17 meaning:
   * a candidate-level deny removes only that candidate, an authority block
   * aborts the whole selection (surfaced as the 'blocked' outcome), and an
   * in-process feedback exclusion skips the candidate before the eligibility
   * round trip (the cheap normal path).
   *
   * `ignoreFailureFeedback` is the P17 fail-open fallback: when the feedback
   * cooldown excluded every candidate in the first pass, the selection
   * re-runs exactly those candidates with the hint cleared, so the in-process
   * cooldown can never turn "all accounts faulted" into a gateway admission
   * rejection — the durable PG health classification checked in this same
   * chain remains the only authoritative gate. `failureFeedbackSkipped`
   * carries the excluded candidates (in encounter order) for that fallback.
   */
  private async collectEligibleCandidates(
    input: ProviderAccountSchedulerInput,
    now: Date,
    candidates: readonly RequestPreparationCandidateAuthority[],
    options: { readonly ignoreFailureFeedback: boolean },
  ): Promise<
    | { readonly outcome: 'blocked'; readonly reason: string }
    | {
        readonly outcome: 'collected';
        readonly eligible: EligibleCandidate[];
        readonly failureFeedbackSkipped: RequestPreparationCandidateAuthority[];
      }
  > {
    const attempted = new Set(input.scheduling?.attemptedAccountIds ?? []);
    const seenAccounts = new Set<string>();
    const eligible: EligibleCandidate[] = [];
    const failureFeedbackSkipped: RequestPreparationCandidateAuthority[] = [];
    // select() has already validated these; the local bindings keep the same
    // narrowing for the extracted loop body and fail closed defensively.
    const eligibilityPort = this.dependencies.eligibility;
    const healthPort = this.dependencies.health;
    const concurrencyPort = this.dependencies.concurrency;
    if (!eligibilityPort || !healthPort || !concurrencyPort) {
      return { outcome: 'blocked', reason: 'provider account scheduler storage ports are unavailable' };
    }

    for (const candidate of candidates) {
      const rawCandidate: unknown = candidate;
      if (!isRecord(rawCandidate) || !nonEmpty(rawCandidate.accountId)) {
        return { outcome: 'blocked', reason: 'candidate authority is invalid' };
      }
      const candidateValue = rawCandidate as unknown as RequestPreparationCandidateAuthority;
      if (seenAccounts.has(candidateValue.accountId)) {
        return { outcome: 'blocked', reason: 'candidate authority contains duplicate accounts' };
      }
      seenAccounts.add(candidateValue.accountId);
      if (attempted.has(candidateValue.accountId)) continue;
      if (!candidateMatchesScope(input.caller, candidateValue)) continue;
      // H5c (P8): an in-process post-failure cooldown removes only this
      // candidate, exactly like a health deny — never the whole selection.
      // P17: skipped candidates are remembered so the caller can fail open
      // when this hint emptied the entire viable candidate set.
      if (
        !options.ignoreFailureFeedback &&
        this.dependencies.failureFeedback?.isExcluded({ candidate: candidateValue, now })
      ) {
        failureFeedbackSkipped.push(candidateValue);
        continue;
      }

      const eligibility = await eligibilityPort.revalidate({
        caller: input.caller,
        entitlement: input.entitlement,
        candidate: candidateValue,
        publicModel: input.publicModel,
        protocol: input.protocol,
        route: input.route,
        billingGroupId: input.billingGroupId,
        now,
      });
      if (
        !isRecord(eligibility) ||
        (eligibility.decision !== 'allow' && eligibility.decision !== 'deny' && eligibility.decision !== 'block')
      ) {
        return { outcome: 'blocked', reason: 'provider eligibility authority returned an invalid decision' };
      }
      if (eligibility.decision === 'block') return { outcome: 'blocked', reason: eligibility.reason };
      if (eligibility.decision === 'deny') continue;
      if (!validEligibility(eligibility, candidateValue, input, now)) {
        return { outcome: 'blocked', reason: 'provider eligibility authority returned an invalid candidate' };
      }

      const health = await healthPort.get({
        caller: input.caller,
        candidate: eligibility.candidate,
        now,
      });
      const healthResult = healthValue(health, now, this.maxHealthAgeMs);
      if (healthResult === 'block') {
        return { outcome: 'blocked', reason: 'provider account health authority is unavailable' };
      }
      if (healthResult === 'deny') continue;

      const concurrency = await concurrencyPort.get({
        caller: input.caller,
        candidate: eligibility.candidate,
        requestId: input.requestId,
        now,
      });
      if (
        !isRecord(concurrency) ||
        (concurrency.decision !== 'allow' && concurrency.decision !== 'deny' && concurrency.decision !== 'block')
      ) {
        return { outcome: 'blocked', reason: 'provider account concurrency authority returned an invalid decision' };
      }
      if (concurrency.decision === 'block') return { outcome: 'blocked', reason: concurrency.reason };
      if (concurrency.decision === 'deny') continue;
      if (
        !isRecord(concurrency.value) ||
        !nonNegativeInteger(concurrency.value.inFlight) ||
        !positiveInteger(concurrency.value.limit) ||
        concurrency.value.inFlight >= concurrency.value.limit
      ) {
        if (isRecord(concurrency.value) && concurrency.value.inFlight >= concurrency.value.limit) continue;
        return { outcome: 'blocked', reason: 'provider account concurrency authority is invalid' };
      }

      eligible.push({
        candidate: eligibility.candidate,
        priority: eligibility.priority,
        weight: eligibility.weight,
        inFlight: concurrency.value.inFlight,
        concurrencyLimit: concurrency.value.limit,
        healthRank: healthResult.rank,
        accountId: eligibility.candidate.accountId,
        route: eligibility.route,
        // R7 scheduling signals: absent columns/ports stay null and every
        // strategy skips the candidate, preserving pre-R7 behavior.
        soonestResetAt: date(eligibility.scheduling?.soonestResetAt),
        soonestResetObservedAt: date(eligibility.scheduling?.soonestResetObservedAt),
        supplierCost:
          eligibility.scheduling?.supplierCostRate === undefined || eligibility.scheduling?.supplierCostRate === null
            ? null
            : {
                numeratorMinorUnits: exactNonNegativeInteger(
                  eligibility.scheduling.supplierCostRate.numeratorMinorUnits,
                ) as bigint,
                denominatorUnits: exactNonNegativeInteger(
                  eligibility.scheduling.supplierCostRate.denominatorUnits,
                ) as bigint,
              },
        lastUsedAt: healthResult.observedAt,
        latencyMs: healthResult.latencyMs,
        // F2: the billing-group pool tier; null keeps the ranking exactly
        // the pre-F2 priority/health chain (golden-fixture red line).
        groupPriority: groupPoolPrioritySignal(eligibility.scheduling?.groupPoolPriority),
      });
    }

    return { outcome: 'collected', eligible, failureFeedbackSkipped };
  }

  /**
   * R7 strategy composition (plan §R7): soonest-reset promotion first (a
   * filter, not a comparator), then the ordered comparator registry
   * [cost-priority?, load, lru?], then the tail — the seeded in-group
   * shuffle when LRU is enabled, otherwise the unchanged deterministic
   * weighted draw (with the optional latency coefficient folded into the
   * effective weights). The returned trace names the tail algorithm and the
   * strategy dimensions that actually discriminated the outcome.
   */
  private chooseByStrategyRegistry(
    ranked: readonly EligibleCandidate[],
    input: ProviderAccountSchedulerInput,
    now: Date,
  ): { readonly candidate: EligibleCandidate; readonly trace: ProviderAccountSchedulerSelectionTrace } {
    const reasons: string[] = [];
    let pool = ranked;
    if (this.strategies.soonestResetEnabled) {
      const imminent = pool.filter((candidate) => this.isImminentReset(candidate, now));
      if (imminent.length > 0 && imminent.length < pool.length) {
        pool = imminent;
        reasons.push('soonest-reset');
      }
    }
    const chain = this.orderingStrategies;
    const ordered = [...pool].sort(
      (left, right) => compareByStrategies(left, right, chain) || left.accountId.localeCompare(right.accountId),
    );
    for (const strategy of chain) {
      if (strategy.name === 'load') continue;
      const discriminates = ordered.some((left) =>
        ordered.some((right) => left !== right && strategy.compare(left, right) !== 0),
      );
      if (discriminates) reasons.push(strategy.name);
    }
    if (
      this.strategies.latencyWeightCoefficient > 0 &&
      ordered.some((candidate) => candidate.latencyMs !== null && candidate.latencyMs > 0)
    ) {
      reasons.push('latency-weight');
    }
    if (this.strategies.lruEnabled) {
      const seed = selectionSeed(input.requestId, input);
      const chosen = chooseByChainOrder(ordered, chain, `${seed}strategy-shuffle`);
      return { candidate: chosen, trace: { strategy: 'lru-order+seeded-shuffle', reasons } };
    }
    return {
      candidate: drawWeighted(ordered, selectionSeed(input.requestId, input), this.strategies.latencyWeightCoefficient),
      trace: { strategy: 'weighted-draw', reasons },
    };
  }

  /**
   * Use-it-or-lose-it predicate: the account's soonest observed quota-window
   * reset is upcoming, strictly inside the horizon, and backed by a snapshot
   * refreshed within the staleness bound. Any missing signal skips the
   * account (pre-R7 behavior for that candidate).
   */
  private isImminentReset(candidate: EligibleCandidate, now: Date): boolean {
    const resetAt = candidate.soonestResetAt;
    const observedAt = candidate.soonestResetObservedAt;
    if (resetAt === null || observedAt === null) return false;
    const resetTime = resetAt.getTime();
    const observedTime = observedAt.getTime();
    if (observedTime > now.getTime()) return false;
    if (now.getTime() - observedTime > this.strategies.soonestResetSnapshotMaxAgeMs) return false;
    return resetTime > now.getTime() && resetTime - now.getTime() < this.strategies.soonestResetWindowMs;
  }

  async bindAffinity(
    input: ProviderAccountSchedulerAffinityBindingInput,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision> {
    if (!hasAffinityReference(input?.context)) return { decision: 'allow' };
    try {
      if (!validAffinityContext(input.context)) {
        return { decision: 'block', reason: 'scheduler affinity context is invalid' };
      }
      const scope = affinityScopeFromBinding(input);
      if (!scope) return { decision: 'block', reason: 'provider account affinity route scope is invalid' };
      if (!this.dependencies.affinity?.bind) {
        return { decision: 'block', reason: 'provider account affinity storage is unavailable' };
      }
      const decision = await this.dependencies.affinity.bind({
        context: input.context,
        scope,
        accountId: input.candidate.accountId,
      });
      if (!isRecord(decision) || (decision.decision !== 'allow' && decision.decision !== 'block')) {
        return { decision: 'block', reason: 'provider account affinity authority returned an invalid decision' };
      }
      return decision.decision === 'allow' ? { decision: 'allow' } : { decision: 'block', reason: decision.reason };
    } catch {
      return { decision: 'block', reason: 'provider account affinity binding failed closed' };
    }
  }
}
