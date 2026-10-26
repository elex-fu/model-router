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
  /**
   * Trusted eligibility authority clock for rights windows. Only a truly absent
   * field preserves the legacy scheduler clock; malformed or inherited values block.
   */
  readonly authorityAt?: string | Date;
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
    /** §4.4 composite: revalidate against the resolved target platform. */
    readonly composite?: ProviderAccountSchedulerCompositeContext;
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
    /** Server-owned clock sampled after asynchronous health reads. */
    readonly clock?: () => Date;
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

/**
 * Roadmap batch 2 §2.1 (task #5) — the shouldClearStickySession semantics:
 * the authority held a binding for this request's affinity reference,
 * revalidated its target against the caller's eligible snapshot, found it
 * unschedulable (unhealthy, cooling down, or revoked), and CLEARED the
 * binding. The selection must degrade to load balancing instead of failing
 * closed — unlike 'allow' with an account that is no longer eligible, which
 * stays a hard block (an authority that recommends a target it did not
 * validate against the snapshot is an inconsistency, not a clean downgrade).
 */
export interface ProviderAccountSchedulerAffinityStale {
  readonly decision: 'stale';
}

export interface ProviderAccountSchedulerAffinityBlocked {
  readonly decision: 'block';
  readonly reason: string;
}

export type ProviderAccountSchedulerAffinityDecision =
  | ProviderAccountSchedulerAffinityAllowed
  | ProviderAccountSchedulerAffinityStale
  | ProviderAccountSchedulerAffinityBlocked;

export interface ProviderAccountSchedulerAffinityPort {
  /**
   * Resolves only a server-validated opaque affinity reference. The returned
   * account is merely a preference and is checked again against all filters.
   * A 'stale' decision means the authority found a binding, verified its
   * target against eligibleAccountIds, cleared it, and the caller must
   * degrade to load balancing (batch 2 §2.1 shouldClearStickySession).
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
  | {
      readonly decision: 'block';
      readonly reason: string;
      /** One locked active winner; a hint for combined selection, never authority to dispatch. */
      readonly contention?: { readonly kind: 'active_binding'; readonly accountId: string };
    };

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
  /**
   * Native-only, collection-scoped live read batching. Eligibility/hint gates
   * run first; only health-admitted candidates enter the concurrency scope.
   * Custom ports omit this and keep the original sequential check order.
   * Every retry/rescue/reconciliation collection opens independent scopes.
   */
  readonly candidateReadScope?: <T>(
    input: {
      readonly phase: 'health' | 'concurrency';
      readonly caller: RequestPreparationCaller;
      readonly candidates: readonly RequestPreparationCandidateAuthority[];
    },
    work: () => Promise<T>,
  ) => Promise<T>;
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
  /**
   * Core-plan 9.1 (B06 consumption half): the model-level cooldown read seam.
   * The SAME ProviderAccountModelRateLimit instance the dispatch side records
   * (a model-not-found 404 / plan-gated 400 cools the (account, model) pair
   * for 30 min) must also be read by the scheduler, otherwise the state is
   * written and never consumed. A cooled (account, model) pair is skipped
   * exactly like a failure-feedback exclude: a per-selection scheduling hint,
   * never an admission deny, with the same P17 fail-open when the viable set
   * would otherwise empty. Absent keeps the selection path unchanged.
   */
  readonly modelCooldown?: ProviderAccountSchedulerModelCooldownPort;
  /**
   * Gap-remediation G-B1 (window three-state): the window-cost gate read
   * seam. Resolves the account's three-state window schedulability from the
   * migration-130 frozen policy and the exact supplier-cost fact
   * (getAccountWindowCostFactsBatch + evaluateWindowCostSchedulability —
   * the composition wires the PG reader). 'sticky_only' skips the candidate
   * for non-sticky selections exactly like a hint exclude; a sticky binding
   * whose target is 'sticky_only' stays selectable (the reserve band admits
   * existing sessions). 'paused' skips both. A read failure must resolve
   * 'admit' (fail-open — a missing observation never removes capacity).
   * Absent keeps the selection path byte-identical (golden red line).
   */
  readonly windowCost?: ProviderAccountSchedulerWindowCostPort;
}

/**
 * Core-plan 9.2 — the sticky-wait budget (initial defaults are a composition
 * concern, to be frozen after load testing): a per-request wait budget
 * (recommended 2 s, strictly positive), a per-sticky-target waiter queue
 * length, and the re-check tick. All process-local; nothing here touches
 * durable scheduling state.
 */
export interface ProviderAccountSchedulerStickyWaitConfig {
  readonly maxWaitMs: number;
  readonly maxQueueLength: number;
  readonly tickMs: number;
}

/**
 * Core-plan 9.1: the model-cooldown read seam consumed by the candidate loop.
 * Non-throwing. Implementations may be synchronous (the process-local
 * `ProviderAccountModelRateLimit` L1) or promise-returning (the durable
 * PostgreSQL registry, migration 133); a failed durable read resolves false
 * (fail-open). The durable account-level authority is never substituted by it.
 */
export interface ProviderAccountSchedulerModelCooldownPort {
  /** True while the (account, model) pair is inside its dispatch-derived cooldown. */
  isModelExcluded(input: {
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly model: string;
    readonly now: Date;
  }): boolean | Promise<boolean>;
}

/**
 * G-B1: the window three-state read seam. Implementations must be
 * non-throwing; an unavailable read resolves 'admit' (fail-open).
 */
export interface ProviderAccountSchedulerWindowCostPort {
  resolveWindowCostSchedulability(input: {
    readonly candidate: RequestPreparationCandidateAuthority;
    readonly now: Date;
    /**
     * True when the selection is resolving an existing sticky binding (the
     * reserve band admits it); false for open-session selection.
     */
    readonly isSticky: boolean;
  }): Promise<'admit' | 'sticky_only' | 'paused'>;
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
  /**
   * §4.4 composite: the authority adapter's resolved composite decision.
   * Present only when the request's billing group is composite; absent keeps
   * the selection path byte-identical (the golden-fixture red line).
   */
  readonly composite?: ProviderAccountSchedulerCompositeContext;
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

/**
 * Batch 4 §4.4 composite model routing: the resolved composite decision for
 * a request whose billing group is marked composite. Set only by a trusted
 * server adapter (the PostgreSQL preparation authority resolved it from the
 * migration-121 registry plus the group's account catalog) — never client
 * input. When present, eligibility revalidation expects the candidate on the
 * resolved target platform/product/model/endpoint instead of the route
 * config's nominal pin (the platform-column predicates in the eligibility
 * SQL narrow through the candidate's own provider facts, the model_scopes
 * pattern). Structurally identical to RequestPreparationCompositeRoute.
 */
export interface ProviderAccountSchedulerCompositeContext {
  readonly billingGroupId: string;
  readonly source: 'route' | 'account_model' | 'detector';
  readonly routeId: string | null;
  readonly targetPlatform: string;
  readonly productId: string;
  readonly upstreamModel: string;
  readonly endpoint: string;
}

export interface ProviderAccountSchedulerPort {
  select(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>>;

  /** Selects and binds before returning, preserving temporary capacity observations until the final winner. */
  selectAndBind?(
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
  /**
   * Core-plan 9.2: the bounded sticky-wait seam. When set, a sticky binding
   * whose target is busy (every lease slot observed in flight, but the
   * account passed eligibility and health) enters a bounded wait instead of
   * immediately degrading the session: the selection re-checks the target on
   * an in-process tick WITHOUT holding any database transaction, lease, or
   * wallet hold. Defaults to OFF (unset) — the selection path stays
   * byte-identical (golden-fixture red line).
   */
  readonly stickyWait?: ProviderAccountSchedulerStickyWaitConfig;
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

export function sameCandidateIdentity(
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

function affinityDataValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
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

/**
 * G-B1: the empty-eligible fallback scope — the caller-validated input
 * route (the same identity facts affinityScopeFromSelection derives from a
 * revalidated candidate's route), used when the window gate skipped every
 * candidate and the sticky re-admission still needs to resolve a binding.
 */
function affinityScopeFromInputRoute(
  input: ProviderAccountSchedulerInput,
  candidate: RequestPreparationCandidateAuthority,
): ProviderAccountSchedulerAffinityScope | null {
  const route = input.route;
  if (!isRecord(route) || !validRevalidatedRoute(route, input, candidate)) return null;
  return {
    ...(route as ProviderAccountSchedulerRevalidatedRoute),
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
  if (!Object.hasOwn(value, 'authorityAt') && 'authorityAt' in value) return false;
  const authorityAt = Object.hasOwn(value, 'authorityAt') ? date(value.authorityAt) : now;
  if (authorityAt === null) return false;
  if (
    value.status !== 'active' ||
    !isRecord(value.capability) ||
    // The trusted route separates native capability from client route scope.
    value.capability.protocol !== (input.route?.providerProtocol ?? input.protocol) ||
    value.capability.supportLevel !== 'supported' ||
    value.capability.validationState !== 'verified' ||
    !validRights(value.rights, refreshed, input.protocol, authorityAt) ||
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

/**
 * Core-plan 9.2: sticky-wait budget validation. Absent is the default OFF;
 * present but malformed is a composition error (constructor TypeError),
 * matching how the strategy options fail.
 */
function resolveStickyWait(value: ProviderAccountSchedulerStickyWaitConfig | undefined) {
  if (value === undefined) return undefined;
  const positive = (field: string, v: number, minimum: number) => {
    if (!Number.isSafeInteger(v) || v < minimum) {
      throw new TypeError(`scheduler sticky wait ${field} must be a safe integer ≥ ${minimum}`);
    }
  };
  positive('maxWaitMs', value.maxWaitMs, 1);
  positive('maxQueueLength', value.maxQueueLength, 1);
  positive('tickMs', value.tickMs, 1);
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
   * Core-plan 9.2: per-(supplyMode, account) in-process waiter count. Only
   * consulted when `stickyWait` is configured; the map is keyed so a BYOK
   * tenant and a platform pool member with the same account id never share a
   * queue. It never touches durable state.
   */
  private readonly stickyWaitQueue = new Map<string, number>();
  /** Validated 9.2 sticky-wait budget; `undefined` keeps the path OFF. */
  private readonly stickyWait: ProviderAccountSchedulerStickyWaitConfig | undefined;
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
    this.stickyWait = resolveStickyWait(options.stickyWait);
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
      // §4.4 composite: the context is server-owned and complete or absent;
      // composite groups are platform pools (the F2 precedent), so a BYOK or
      // partial composite context is invalid input, never a fallback to the
      // nominal route pin.
      const composite = input.composite;
      if (composite !== undefined) {
        if (
          !isRecord(composite) ||
          !nonEmpty(composite.billingGroupId) ||
          (composite.source !== 'route' && composite.source !== 'account_model' && composite.source !== 'detector') ||
          (composite.routeId !== null && composite.routeId !== undefined && !nonEmpty(composite.routeId)) ||
          !nonEmpty(composite.targetPlatform) ||
          !nonEmpty(composite.productId) ||
          !nonEmpty(composite.upstreamModel) ||
          !nonEmpty(composite.endpoint) ||
          input.caller.supplyMode !== 'platform'
        ) {
          return schedulerBlock('scheduler composite route context is invalid');
        }
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
        ignoreModelCooldown: false,
        ignoreWindowCost: false,
      });
      if (firstPass.outcome === 'blocked') return schedulerBlock(firstPass.reason);
      let eligible = firstPass.eligible;
      let durableHealthDenies = firstPass.healthDenied;
      let capacityDenies = firstPass.busySkipped.length;
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
       *
       * Core-plan 9.1: the model-level cooldown hint shares this exact
       * fail-open contract — when only cooldown hints (account, model, or
       * both) emptied the viable set, the union of skipped candidates is
       * re-run with both hints cleared instead of starved.
       *
       * G-B1: the window gate deliberately does NOT join this union — the
       * P17 fail-open is for in-process TRANSIENT hints whose durable state
       * is healthy; a window over-limit is a real capacity state (the
       * sub2api posture: the DB-READ failure fails open, an over-limit
       * window never does). A window-emptied viable set rejects below.
       */
      if (
        eligible.length === 0 &&
        (firstPass.failureFeedbackSkipped.length > 0 || firstPass.modelCooldownSkipped.length > 0)
      ) {
        const fallbackCandidates = [
          ...firstPass.failureFeedbackSkipped,
          ...firstPass.modelCooldownSkipped.filter(
            (c) => !firstPass.failureFeedbackSkipped.some((f) => f.accountId === c.accountId),
          ),
        ];
        const fallbackPass = await this.collectEligibleCandidates(input, now, fallbackCandidates, {
          ignoreFailureFeedback: true,
          ignoreModelCooldown: true,
          ignoreWindowCost: false,
        });
        if (fallbackPass.outcome === 'blocked') return schedulerBlock(fallbackPass.reason);
        eligible = fallbackPass.eligible;
        durableHealthDenies += fallbackPass.healthDenied;
        capacityDenies += fallbackPass.busySkipped.length;
      }

      /*
       * G-B1 sticky rescue: when the ONLY viable candidates were skipped by
       * the window gate and this request carries an affinity reference, the
       * binding's target is re-checked with isSticky=true BEFORE the
       * empty-set rejection — a reserve-band session must not be starved by
       * the band that exists to protect it. Only 'sticky_only' re-enters
       * ('paused' is genuinely out of window); the re-admission runs the
       * FULL check chain on the target with the gate cleared, so an account
       * that also fails eligibility/health/concurrency still rejects.
       */
      if (eligible.length === 0 && firstPass.windowCostSkipped.length > 0 && this.dependencies.windowCost) {
        if (hasAffinityReference(input.scheduling) && this.dependencies.affinity) {
          const rescueScope =
            affinityScopeFromInputRoute(input, firstPass.windowCostSkipped[0]) ??
            affinityScopeFromSelection(input, eligible);
          const rescueAffinity = await this.dependencies.affinity
            .resolve({
              caller: input.caller,
              entitlement: input.entitlement,
              publicModel: input.publicModel,
              protocol: input.protocol,
              context: input.scheduling as RequestPreparationSchedulingContext,
              scope: rescueScope as never,
              eligibleAccountIds: firstPass.windowCostSkipped.map((c) => c.accountId),
            })
            .catch(() => null);
          if (
            isRecord(rescueAffinity) &&
            rescueAffinity.decision === 'allow' &&
            typeof rescueAffinity.accountId === 'string' &&
            rescueAffinity.accountId !== ''
          ) {
            const target = firstPass.windowCostSkipped.find((c) => c.accountId === rescueAffinity.accountId);
            if (target !== undefined) {
              let targetState: 'admit' | 'sticky_only' | 'paused' = 'admit';
              try {
                targetState = await this.dependencies.windowCost.resolveWindowCostSchedulability({
                  candidate: target,
                  now,
                  isSticky: true,
                });
              } catch {
                targetState = 'admit';
              }
              if (targetState === 'sticky_only') {
                const rescued = await this.collectEligibleCandidates(input, now, [target], {
                  ignoreFailureFeedback: false,
                  ignoreModelCooldown: false,
                  ignoreWindowCost: true,
                });
                const rescuedCandidate =
                  rescued.outcome === 'collected'
                    ? rescued.eligible.find(({ accountId }) => accountId === target.accountId)
                    : undefined;
                if (rescuedCandidate) {
                  return allowRequestPreparation(rescuedCandidate.candidate, {
                    strategy: 'affinity',
                    reasons: ['affinity', 'window-reserve-band'],
                  });
                }
              }
            }
          }
        }
      }

      if (eligible.length === 0) {
        /*
         * K2 (all-4-faulted fail-away): when the durable health authority
         * itself denied candidates — every structurally eligible account is
         * in a cooldown — the emptiness is an availability condition, not a
         * client fault, so the selection blocks as a clean 503 instead of
         * the generic account_denied 403 (a 403 tells well-behaved clients
         * their request is forbidden and suppresses retry; the run-2 P17
         * starvation was 4,698 of exactly those). This is a DIFFERENT
         * mechanism from P17's: P17's starvation came from the in-process
         * HINT emptying the set while the durable rows were healthy, which
         * the fallback pass above now prevents; here the durable evidence
         * itself — the authority P17 explicitly defers to — says no account
         * is schedulable, and the cooldowns are short (≤15 s for the
         * account-attributable kinds) so recovery is seconds away.
         */
        if (durableHealthDenies > 0) {
          return blockRequestPreparation('capability_unavailable', 'no schedulable provider account is available');
        }
        if (capacityDenies > 0) {
          return rejectRequestPreparation('rate_limited', 'provider account capacity is currently exhausted');
        }
        return rejectRequestPreparation('account_denied', 'no eligible provider account is available');
      }

      try {
        let affinityAccountId: string | null = null;
        /*
         * Core-plan 9.2: the busy population of the FIRST pass. With the
         * sticky-wait seam configured, the affinity resolution domain extends
         * to busy-but-otherwise-schedulable accounts so a binding whose target
         * is at its lease wall survives as 'allow' (the wait path can hold it)
         * instead of being invalidated as 'stale' — the sub2api bounded-wait
         * posture. Without the seam the domain is the eligible set only and
         * the semantics stay byte-identical (golden red line).
         */
        const busyByAccountId = new Map(firstPass.busySkipped.map((c) => [c.accountId, c]));
        if (hasAffinityReference(input.scheduling)) {
          /*
           * Roadmap batch 2 §2.1 (task #5) — the sticky three-state gate
           * (sub2api CheckWindowCostSchedulability semantics, MVP scope):
           *  1. a sticky hit whose account is healthy and not cooling down
           *     is already inside `eligible` (the check chain ran first) and
           *     is selected directly — model routing beats stickiness beats
           *     load balancing;
           *  2. a binding whose target is no longer schedulable is cleared
           *     by the authority ('stale') and the selection DEGRADES to the
           *     normal ranking chain — the session re-binds to whatever the
           *     load balancer picks instead of rejecting the request;
           *  3. no binding at all → the normal ranking chain.
           * The window-cost reserve band (limit+reserve) still needs the
           * per-window cost policy (migration + freeze) — NOT implemented
           * here. The bounded wait plan IS (9.2): when configured, a busy
           * sticky target enters the bounded re-check loop below instead of
           * degrading or blocking.
           */
          // G-B1: when the window gate emptied the eligible set, the scope
          // falls back to the caller-validated input route — the
          // window-skipped candidates passed eligibility before the gate
          // skipped them, so their binding remains resolvable for the
          // sticky re-admission below.
          const scope =
            affinityScopeFromSelection(input, eligible) ??
            (eligible.length === 0 && firstPass.windowCostSkipped.length > 0
              ? affinityScopeFromInputRoute(input, firstPass.windowCostSkipped[0])
              : null);
          if (!scope) return schedulerBlock('provider account affinity route scope is unavailable or stale');
          // G-B1: the affinity resolution domain extends to the
          // window-skipped population too — a sticky binding in the reserve
          // band must stay resolvable even when the gate emptied the
          // eligible set (the busy-domain extension precedent).
          const affinityDomainAccountIds = this.stickyWait
            ? [
                ...eligible.map(({ accountId }) => accountId),
                ...busyByAccountId.keys(),
                ...firstPass.windowCostSkipped.map((c) => c.accountId),
              ]
            : [...eligible.map(({ accountId }) => accountId), ...firstPass.windowCostSkipped.map((c) => c.accountId)];
          const affinity = await this.dependencies.affinity?.resolve({
            caller: input.caller,
            entitlement: input.entitlement,
            publicModel: input.publicModel,
            protocol: input.protocol,
            context: input.scheduling as RequestPreparationSchedulingContext,
            scope,
            eligibleAccountIds: affinityDomainAccountIds,
          });
          if (
            !isRecord(affinity) ||
            (affinity.decision !== 'allow' && affinity.decision !== 'block' && affinity.decision !== 'stale')
          ) {
            return schedulerBlock('provider account affinity authority returned an invalid decision');
          }
          if (affinity.decision === 'block') return schedulerBlock(affinity.reason);
          if (affinity.decision === 'allow') {
            if (affinity.accountId !== null && !nonEmpty(affinity.accountId)) {
              return schedulerBlock('provider account affinity returned an invalid account');
            }
            affinityAccountId = affinity.accountId;
          }
          // 'stale': the cleared binding degrades to load balancing below.
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
          const busyTarget = this.stickyWait ? busyByAccountId.get(affinityAccountId) : undefined;
          if (busyTarget) {
            const waited = await this.waitForBusyStickyTarget(input, affinityAccountId, busyTarget);
            if (waited !== null) return waited;
            /*
             * waited === null: the waiter queue is full — degrade to the
             * ranking chain below instead of blocking. The busy target is
             * excluded from `eligible`, so the ranking can never pick it;
             * the caller re-binds on the selected account exactly like the
             * stale-degrade path.
             */
          } else {
            return schedulerBlock('persisted provider account affinity target is no longer eligible');
          }
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
   * Standard preparation keeps selection and affinity binding in one operation.
   * Only a locked, typed winner may replace a proposal that lost its first bind;
   * the replacement passes the full check chain and one final fenced bind.
   */
  async selectAndBindCandidate(
    input: ProviderAccountSchedulerInput,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>> {
    try {
      const selected = await this.select(input);
      if (selected.decision !== 'allow') return selected;
      if (!this.selectionMatchesSource(input, selected.value)) {
        return schedulerBlock('scheduler selected an account outside the authorized candidate set');
      }
      if (!hasAffinityReference(input.scheduling)) return selected;
      const initial = await this.bindSelectedCandidate(input, selected.value);
      if (initial.decision === 'allow') return selected;
      const source = this.affinityWinnerFromBind(input, selected.value, initial);
      if (source.decision !== 'allow') return source;
      const winner = await this.revalidateAffinityWinner(input, source.value);
      if (winner.decision !== 'allow') return winner;
      if (!this.selectionMatchesSource(input, winner.value)) {
        return schedulerBlock('provider account affinity winner is outside the authorized candidate set');
      }
      const finalBinding = await this.bindSelectedCandidate(input, winner.value);
      if (finalBinding.decision !== 'allow') {
        // A second known winner ends this operation. It grants no authority to
        // dispatch and must not start another revalidation or bind attempt.
        const changedWinner = this.affinityWinnerFromBind(input, winner.value, finalBinding);
        if (changedWinner.decision === 'allow') {
          return rejectRequestPreparation('rate_limited', 'provider account affinity binding is contended');
        }
        return schedulerBlock(finalBinding.reason);
      }
      return winner;
    } catch {
      return schedulerBlock('provider account scheduler failed closed');
    }
  }

  private affinityWinnerFromBind(
    input: ProviderAccountSchedulerInput,
    selected: RequestPreparationCandidateAuthority,
    binding: Extract<ProviderAccountSchedulerAffinityBindDecision, { readonly decision: 'block' }>,
  ): RequestPreparationDecision<RequestPreparationCandidateAuthority> {
    const contention = binding.contention;
    if (
      !Object.hasOwn(binding, 'contention') ||
      !isRecord(contention) ||
      !Object.hasOwn(contention, 'kind') ||
      !Object.hasOwn(contention, 'accountId') ||
      contention.kind !== 'active_binding' ||
      !nonEmpty(contention.accountId) ||
      contention.accountId === selected.accountId
    ) {
      return schedulerBlock(binding.reason);
    }
    const sources = input.candidates.filter((candidate) => candidate.accountId === contention.accountId);
    const source = sources.length === 1 ? sources[0] : undefined;
    if (!source || !this.selectionMatchesSource(input, source) || !input.route) {
      return schedulerBlock('provider account affinity winner is outside the authorized candidate set');
    }
    const bindingInput = {
      caller: input.caller,
      entitlement: input.entitlement,
      publicModel: input.publicModel,
      protocol: input.protocol,
      context: input.scheduling as RequestPreparationSchedulingContext,
      route: input.route,
    };
    const selectedScope = affinityScopeFromBinding({ ...bindingInput, candidate: selected });
    const winnerScope = affinityScopeFromBinding({ ...bindingInput, candidate: source });
    if (
      !selectedScope ||
      !winnerScope ||
      (Object.keys(selectedScope) as (keyof ProviderAccountSchedulerAffinityScope)[]).some(
        (key) => selectedScope[key] !== winnerScope[key],
      )
    ) {
      return schedulerBlock('provider account affinity winner route scope changed');
    }
    return allowRequestPreparation(source);
  }

  private selectionMatchesSource(
    input: ProviderAccountSchedulerInput,
    selected: RequestPreparationCandidateAuthority,
  ): boolean {
    return (
      isRecord(selected) &&
      candidateMatchesScope(input.caller, selected) &&
      selected.accountOwnerKind === (input.caller.supplyMode === 'byok' ? 'tenant' : 'platform') &&
      !input.scheduling?.attemptedAccountIds?.includes(selected.accountId) &&
      input.candidates.some((candidate) => sameCandidateIdentity(candidate, selected))
    );
  }

  private async bindSelectedCandidate(
    input: ProviderAccountSchedulerInput,
    candidate: RequestPreparationCandidateAuthority,
  ): Promise<ProviderAccountSchedulerAffinityBindDecision> {
    if (!input.route) return { decision: 'block', reason: 'provider account affinity route scope is invalid' };
    const scope = affinityScopeFromBinding({
      caller: input.caller,
      entitlement: input.entitlement,
      publicModel: input.publicModel,
      protocol: input.protocol,
      context: input.scheduling as RequestPreparationSchedulingContext,
      route: input.route,
      candidate,
    });
    if (!scope) return { decision: 'block', reason: 'provider account affinity route scope is invalid' };
    const affinity = this.dependencies.affinity;
    if (!affinity?.bind) return { decision: 'block', reason: 'provider account affinity storage is unavailable' };
    const decision = await affinity.bind({
      context: input.scheduling as RequestPreparationSchedulingContext,
      scope,
      accountId: candidate.accountId,
    });
    const outcome = affinityDataValue(decision, 'decision');
    if (outcome === 'allow') return { decision: 'allow' };
    const reason = affinityDataValue(decision, 'reason');
    if (outcome !== 'block' || !nonEmpty(reason)) {
      return { decision: 'block', reason: 'provider account affinity authority returned an invalid decision' };
    }
    const contention = affinityDataValue(decision, 'contention');
    const kind = affinityDataValue(contention, 'kind');
    const accountId = affinityDataValue(contention, 'accountId');
    if (
      isRecord(decision) &&
      (Object.getPrototypeOf(decision) === Object.prototype || Object.getPrototypeOf(decision) === null) &&
      Reflect.ownKeys(decision).length === 3 &&
      isRecord(contention) &&
      (Object.getPrototypeOf(contention) === Object.prototype || Object.getPrototypeOf(contention) === null) &&
      Reflect.ownKeys(contention).length === 2 &&
      kind === 'active_binding' &&
      nonEmpty(accountId)
    ) {
      return { decision: 'block', reason, contention: { kind, accountId } };
    }
    return { decision: 'block', reason };
  }

  private async revalidateAffinityWinner(
    input: ProviderAccountSchedulerInput,
    source: RequestPreparationCandidateAuthority,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority>> {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return schedulerBlock('scheduler clock is unavailable');
    }
    let pass = await this.collectEligibleCandidates(input, now, [source], {
      ignoreFailureFeedback: false,
      ignoreModelCooldown: false,
      ignoreWindowCost: false,
    });
    if (pass.outcome === 'blocked') return schedulerBlock(pass.reason);
    if (pass.windowCostSkipped.length > 0 && this.dependencies.windowCost) {
      let state: 'admit' | 'sticky_only' | 'paused';
      try {
        state = await this.dependencies.windowCost.resolveWindowCostSchedulability({
          candidate: source,
          now,
          isSticky: true,
        });
      } catch {
        // Match the existing window observation contract; durable authority remains below.
        state = 'admit';
      }
      if (state === 'admit' || state === 'sticky_only') {
        const fresh = this.now();
        if (!(fresh instanceof Date) || !Number.isFinite(fresh.getTime())) {
          return schedulerBlock('scheduler clock is unavailable');
        }
        pass = await this.collectEligibleCandidates(input, fresh, [source], {
          ignoreFailureFeedback: false,
          ignoreModelCooldown: false,
          ignoreWindowCost: true,
        });
        if (pass.outcome === 'blocked') return schedulerBlock(pass.reason);
      }
    }
    const eligible = pass.eligible.find(({ accountId }) => accountId === source.accountId);
    if (eligible) {
      return allowRequestPreparation(eligible.candidate, {
        strategy: 'affinity',
        reasons: ['affinity', 'bind-contention'],
      });
    }
    const busy = pass.busySkipped.find((candidate) => candidate.accountId === source.accountId);
    if (busy && this.stickyWait) {
      const waited = await this.waitForBusyStickyTarget(input, source.accountId, busy);
      if (waited !== null) return waited;
    }
    if (pass.healthDenied > 0) {
      return blockRequestPreparation('capability_unavailable', 'no schedulable provider account is available');
    }
    if (busy) return rejectRequestPreparation('rate_limited', 'provider account capacity is currently exhausted');
    return rejectRequestPreparation('account_denied', 'no eligible provider account is available');
  }

  /**
   * Core-plan 9.2: the bounded wait for a busy sticky target. The re-check
   * loop re-runs the full candidate check chain on `tickMs` sleeps; between
   * ticks NOTHING is held — no database transaction (every port opens its
   * own), no inference lease, no wallet hold (those are acquired later, after
   * a successful selection). Waiting is capped by `maxWaitMs` and, per
   * (supplyMode, account) sticky target, by `maxQueueLength` concurrent
   * waiters tracked in-process — a full queue returns null (degrade to the
   * ranking chain). Outcomes:
   *   - the target became eligible → allow (selection trace notes the wait);
   *   - an authority block on any re-check pass → the same block decision;
   *   - budget exhausted → 429-mapped reject with a Retry-After hint, the
   *     binding intact for the next request (this request is NOT degraded,
   *     matching the sub2api wait plan).
   * Returns null only when the waiter queue is full.
   */
  private async waitForBusyStickyTarget(
    input: ProviderAccountSchedulerInput,
    targetAccountId: string,
    busyTarget: RequestPreparationCandidateAuthority,
  ): Promise<RequestPreparationDecision<RequestPreparationCandidateAuthority> | null> {
    const config = this.stickyWait as ProviderAccountSchedulerStickyWaitConfig;
    const queueKey = `${busyTarget.supplyMode}:${targetAccountId}`;
    const waiters = this.stickyWaitQueue.get(queueKey) ?? 0;
    if (waiters >= config.maxQueueLength) {
      return null; // queue full → degrade to the ranking chain immediately
    }
    this.stickyWaitQueue.set(queueKey, waiters + 1);
    try {
      const deadline = this.now().getTime() + config.maxWaitMs;
      const tickMs = Math.min(config.tickMs, Math.max(config.maxWaitMs, 1));
      for (;;) {
        await new Promise<void>((resolve) => setTimeout(resolve, tickMs));
        const now = this.now();
        if (now.getTime() >= deadline) {
          return {
            decision: 'reject',
            code: 'rate_limited',
            message:
              'the sticky provider account is still busy; the bounded wait budget expired — retry shortly (the session binding is kept)',
            retryAfterSeconds: Math.max(1, Math.ceil(config.maxWaitMs / 1000)),
          };
        }
        const pass = await this.collectEligibleCandidates(input, now, input.candidates, {
          ignoreFailureFeedback: false,
          ignoreModelCooldown: false,
          ignoreWindowCost: false,
        });
        if (pass.outcome === 'blocked') return schedulerBlock(pass.reason);
        const freed = pass.eligible.find(({ accountId }) => accountId === targetAccountId);
        if (freed) {
          return allowRequestPreparation(freed.candidate, {
            strategy: 'affinity',
            reasons: ['affinity', 'sticky-wait'],
          });
        }
        // Still busy (or transiently skipped): sleep and re-check.
      }
    } finally {
      const remaining = (this.stickyWaitQueue.get(queueKey) ?? 1) - 1;
      if (remaining <= 0) this.stickyWaitQueue.delete(queueKey);
      else this.stickyWaitQueue.set(queueKey, remaining);
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
   *
   * G-B1: `ignoreWindowCost` extends the same fail-open contract to the
   * window three-state gate — when only window hints emptied the viable
   * set, the union of skipped candidates is re-run with the gate cleared.
   * `windowCostSkipped` carries them (per-selection hint semantics).
   *
   * K2: `healthDenied` counts candidates the DURABLE health authority
   * denied (cooldown/unhealthy row, or a live-cooldown deny). select()
   * surfaces an all-durably-denied emptiness as a 503 availability block
   * instead of the generic account_denied 403.
   */
  private async collectEligibleCandidates(
    input: ProviderAccountSchedulerInput,
    now: Date,
    candidates: readonly RequestPreparationCandidateAuthority[],
    options: {
      readonly ignoreFailureFeedback: boolean;
      readonly ignoreModelCooldown: boolean;
      readonly ignoreWindowCost: boolean;
    },
  ): Promise<
    | { readonly outcome: 'blocked'; readonly reason: string }
    | {
        readonly outcome: 'collected';
        readonly eligible: EligibleCandidate[];
        readonly failureFeedbackSkipped: RequestPreparationCandidateAuthority[];
        readonly modelCooldownSkipped: RequestPreparationCandidateAuthority[];
        /** G-B1: candidates the window three-state gate skipped (hint semantics). */
        readonly windowCostSkipped: RequestPreparationCandidateAuthority[];
        /**
         * Core-plan 9.2: candidates that passed eligibility and health but
         * are at (or over) their concurrency limit — the in-process "busy"
         * population the bounded sticky wait consults. These candidates stay
         * out of ranking; an empty set caused by this capacity denial is
         * rate limited after durable health denial takes precedence.
         */
        readonly busySkipped: RequestPreparationCandidateAuthority[];
        readonly healthDenied: number;
      }
  > {
    const attempted = new Set(input.scheduling?.attemptedAccountIds ?? []);
    const seenAccounts = new Set<string>();
    const eligible: EligibleCandidate[] = [];
    const failureFeedbackSkipped: RequestPreparationCandidateAuthority[] = [];
    const modelCooldownSkipped: RequestPreparationCandidateAuthority[] = [];
    const windowCostSkipped: RequestPreparationCandidateAuthority[] = [];
    const busySkipped: RequestPreparationCandidateAuthority[] = [];
    let healthDenied = 0;
    // select() has already validated these; the local bindings keep the same
    // narrowing for the extracted loop body and fail closed defensively.
    const eligibilityPort = this.dependencies.eligibility;
    const healthPort = this.dependencies.health;
    const concurrencyPort = this.dependencies.concurrency;
    if (!eligibilityPort || !healthPort || !concurrencyPort) {
      return { outcome: 'blocked', reason: 'provider account scheduler storage ports are unavailable' };
    }

    const batchScope = this.dependencies.candidateReadScope;
    type AllowedEligibility = Extract<ProviderAccountSchedulerEligibilityDecision, { decision: 'allow' }>;
    type AllowedHealth = Exclude<ReturnType<typeof healthValue>, 'block' | 'deny'>;
    type Blocked = { readonly outcome: 'blocked'; readonly reason: string };
    const validated: { eligibility: AllowedEligibility; candidateValue: RequestPreparationCandidateAuthority }[] = [];
    const healthAdmitted: {
      eligibility: AllowedEligibility;
      candidateValue: RequestPreparationCandidateAuthority;
      healthResult: AllowedHealth;
    }[] = [];
    const checkConcurrency = async (
      eligibility: AllowedEligibility,
      candidateValue: RequestPreparationCandidateAuthority,
      healthResult: AllowedHealth,
    ): Promise<Blocked | null> => {
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
      if (concurrency.decision === 'deny') {
        busySkipped.push(candidateValue);
        return null;
      }
      if (
        !isRecord(concurrency.value) ||
        !nonNegativeInteger(concurrency.value.inFlight) ||
        !positiveInteger(concurrency.value.limit)
      ) {
        return { outcome: 'blocked', reason: 'provider account concurrency authority is invalid' };
      }
      if (concurrency.value.inFlight >= concurrency.value.limit) {
        busySkipped.push(candidateValue);
        return null;
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
      return null;
    };
    const checkHealth = async (
      eligibility: AllowedEligibility,
      candidateValue: RequestPreparationCandidateAuthority,
    ): Promise<Blocked | null> => {
      const health = await healthPort.get({
        caller: input.caller,
        candidate: eligibility.candidate,
        now,
        clock: this.now,
      });
      const healthNow = this.now();
      if (!(healthNow instanceof Date) || !Number.isFinite(healthNow.getTime())) {
        return { outcome: 'blocked', reason: 'provider account health clock is unavailable' };
      }
      const healthResult = healthValue(health, healthNow, this.maxHealthAgeMs);
      if (healthResult === 'block') {
        return { outcome: 'blocked', reason: 'provider account health authority is unavailable' };
      }
      if (healthResult === 'deny') {
        healthDenied += 1;
        return null;
      }

      if (batchScope) {
        healthAdmitted.push({ eligibility, candidateValue, healthResult });
        return null;
      }
      return checkConcurrency(eligibility, candidateValue, healthResult);
    };

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
      // Core-plan 9.1 (B06): model-level cooldown read. Same hint semantics as
      // failure feedback: skip only this (account, model) candidate, exactly
      // like a health deny, never the whole selection. The read may be
      // promise-returning (the durable PostgreSQL registry); a failed durable
      // read resolves false inside the registry (fail-open).
      if (
        !options.ignoreModelCooldown &&
        (await this.dependencies.modelCooldown?.isModelExcluded({
          candidate: candidateValue,
          model: candidateValue.resolvedModel,
          now,
        }))
      ) {
        modelCooldownSkipped.push(candidateValue);
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
        composite: input.composite,
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

      // G-B1 (window three-state): the migration-130 gate. Non-sticky
      // selection: 'sticky_only' and 'paused' both skip (the reserve band
      // admits existing sessions only). Sticky selection (the affinity
      // target — see the post-resolution re-admission in select()):
      // 'sticky_only' passes — the reserve band exists precisely for those
      // sessions — while 'paused' still skips. Per-candidate hint
      // semantics, exactly like the cooldowns above; never an admission
      // deny. The re-admission step re-queries the gate for the resolved
      // target, so this loop always treats 'sticky_only' as a skip.
      if (!options.ignoreWindowCost && this.dependencies.windowCost) {
        let windowState: 'admit' | 'sticky_only' | 'paused' = 'admit';
        try {
          windowState = await this.dependencies.windowCost.resolveWindowCostSchedulability({
            candidate: candidateValue,
            now,
            isSticky: false,
          });
        } catch {
          windowState = 'admit'; // fail-open: a failed read never removes capacity
        }
        if (windowState !== 'admit') {
          windowCostSkipped.push(candidateValue);
          continue;
        }
      }

      if (batchScope) {
        validated.push({ eligibility, candidateValue });
      } else {
        const blocked = await checkHealth(eligibility, candidateValue);
        if (blocked) return blocked;
      }
    }

    if (batchScope && validated.length > 0) {
      const healthBlocked = await batchScope(
        {
          phase: 'health',
          caller: input.caller,
          candidates: validated.map(({ eligibility }) => eligibility.candidate),
        },
        async () => {
          for (const { eligibility, candidateValue } of validated) {
            const blocked = await checkHealth(eligibility, candidateValue);
            if (blocked) return blocked;
          }
          return null;
        },
      );
      if (healthBlocked) return healthBlocked;
      if (healthAdmitted.length > 0) {
        const concurrencyBlocked = await batchScope(
          {
            phase: 'concurrency',
            caller: input.caller,
            candidates: healthAdmitted.map(({ eligibility }) => eligibility.candidate),
          },
          async () => {
            for (const { eligibility, candidateValue, healthResult } of healthAdmitted) {
              const blocked = await checkConcurrency(eligibility, candidateValue, healthResult);
              if (blocked) return blocked;
            }
            return null;
          },
        );
        if (concurrencyBlocked) return concurrencyBlocked;
      }
    }

    return {
      outcome: 'collected',
      eligible,
      failureFeedbackSkipped,
      modelCooldownSkipped,
      windowCostSkipped,
      busySkipped,
      healthDenied,
    };
  }

  /**
   * R7 strategy composition (plan §R7): soonest-reset promotion first (a
   * filter, not a comparator), then the ordered comparator registry
   * [cost-priority?, load, lru?], then the tail — the seeded in-group
   * shuffle when LRU is enabled, otherwise the deterministic
   * weighted draw (with the optional latency coefficient folded into the
   * effective weights). Cost priority first restricts the draw to the minimum
   * known-cost tier, independently of LRU. The returned trace names the tail algorithm and the
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
    // Sorting alone does not alter weighted selection probabilities. Preserve
    // the ranking/soonest-reset gates above, then only draw within the best
    // cost tier; unknown costs tie only when no known rate is available.
    const selectionPool = this.strategies.costPriorityEnabled
      ? ordered.filter((candidate) => compareSupplierCost(candidate, ordered[0]!) === 0)
      : ordered;
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
      candidate: drawWeighted(
        selectionPool,
        selectionSeed(input.requestId, input),
        this.strategies.latencyWeightCoefficient,
      ),
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
