import { createHash } from 'node:crypto';
import type { ProviderAccountSchedulerEligibilityPort } from './provider-account-scheduler.js';

export interface CachedProviderAccountEligibilityOptions {
  /** Milliseconds an allow decision stays reusable; defaults to 5000ms. */
  readonly ttlMs?: number;
  /** Bounded cache size (entries and in-flight revalidations); defaults to 4096. */
  readonly maxEntries?: number;
  /** Injectable monotonic clock (milliseconds) for tests. */
  readonly now?: () => number;
}

type RevalidateInput = Parameters<ProviderAccountSchedulerEligibilityPort['revalidate']>[0];
type EligibilityDecision = Awaited<ReturnType<ProviderAccountSchedulerEligibilityPort['revalidate']>>;

/** Depth bound for the canonical key form; deeper (never expected) inputs bypass. */
const MAX_CANONICAL_DEPTH = 32;

/**
 * §12.2 Phase A2a (D2) performance wide-snapshot extension: bounded,
 * allow-only process cache for the scheduler's STATIC authorization reads —
 * the eligibility authority revalidation (PostgresEligibilityAuthority:
 * the S4 route join plus the S5 ~15-table account/credential/rights/
 * capability/pool eligibility join, and the supplier-cost rate lookup keyed
 * by the candidate's supplierCostVersion). Mirrors the
 * CachedRequestPreparationAuthority precedent.
 *
 * The cache key is a canonical deep form of EVERY input field except the
 * scheduler clock (`now`): the caller's identity/version tuple, the
 * entitlement snapshot, the candidate's complete identity+epoch record
 * (account/credential/pool/member/grant/rights-adjacent versions), the
 * server-owned route authority facts, the resolved billing group id, and
 * the composite routing decision. The normalization is generic and
 * key-sorted rather than field-enumerated on purpose: a hand-written field
 * list that misses one epoch field would be a wrong-hit security bug, while
 * the generic form can only over- or under-approximate by producing a
 * spurious miss (bypass) — never a wrong hit. BigInt/number/string versions
 * of the same epoch share one canonical form (`4`, `'4'`, `4n` → `"4"`),
 * matching how the authority compares versions.
 *
 * What is NOT cached (the §12.2 dynamic-state rule): concurrency lease
 * counts, the selection audit INSERT, model-cooldown point reads, runtime
 * health views, and every lease/ledger/wallet write stay on their existing
 * per-call paths — this decorator only wraps the eligibility port, and
 * those reads live on other ports.
 *
 * Residual, explicitly accepted staleness (bounded ≤ TTL): the eligibility
 * allow VALUE carries scheduling-only signals revalidated by the same SQL
 * row (R7 health-score weight modulation, the D4 quota snapshot, the 099/
 * 100/108 quota-window reset snapshots, the migration-119 grok/kimi 429
 * deadlines and free-tier gate, and `authorityAt` itself). Those columns
 * carry no version epochs, so a cached allow can keep serving for up to
 * TTL after such a write. None of them ever grants or removes
 * AUTHORIZATION (the 093/119 scheduling-signal precedent: they modulate
 * weight or deny a candidate as a scheduling preference), and deny/block
 * results are never cached, so a fresh denial always lands on the next
 * cache miss. Authorization staleness is impossible in the fail-closed
 * direction: every version epoch the SQL validates is carried by the key.
 *
 * Safety premise (verified against postgres-request-admission-guard.ts):
 * the admission guard re-reads every route/account/credential/pool/rights/
 * capability authority fact from PostgreSQL inside the admission
 * transaction (loadAdmissionAuthority UNION ALL batch, after the shared
 * fences) and revalidates the frozen versions carried by the request/
 * attempt records against those fresh rows — a stale or racing epoch fails
 * closed at admission. A cache hit can never bypass the final defense
 * line, exactly like the CachedRequestPreparationAuthority and
 * CachedKeyAuthenticator precedents. Control-plane changes surface as
 * bounded (≤ TTL) guard denials until the affected entries expire, never
 * as silently stale authority.
 */
export class CachedProviderAccountEligibility implements ProviderAccountSchedulerEligibilityPort {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { until: number; value: EligibilityDecision }>();
  private readonly pending = new Map<string, Promise<EligibilityDecision>>();

  /** The wrapped eligibility authority; public read-only like the protocol decorators. */
  readonly underlyingEligibility: ProviderAccountSchedulerEligibilityPort;

  constructor(source: ProviderAccountSchedulerEligibilityPort, options: CachedProviderAccountEligibilityOptions = {}) {
    this.underlyingEligibility = source;
    this.ttlMs = options.ttlMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 4096;
    this.now = options.now ?? Date.now;
    for (const bound of [this.ttlMs, this.maxEntries]) {
      if (!Number.isSafeInteger(bound) || bound < 1) throw new Error('Invalid eligibility cache bounds');
    }
  }

  async revalidate(input: RevalidateInput): Promise<EligibilityDecision> {
    const key = cacheKey(input);
    if (key === null) {
      // Un-canonicalizable input (unexpected shape): bypass, never guess.
      return this.underlyingEligibility.revalidate(input);
    }
    const cached = this.entries.get(key);
    if (cached && cached.until > this.now()) {
      // Recency bump: Map iteration order approximates LRU.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return structuredClone(cached.value);
    }
    this.entries.delete(key);
    const inFlight = this.pending.get(key);
    if (inFlight) return structuredClone(await inFlight);
    if (this.pending.size >= this.maxEntries) {
      // Cache pressure must never fail a selection: bypass single-flight.
      return this.underlyingEligibility.revalidate(input);
    }
    const observedAt = this.now();
    const operation = this.underlyingEligibility
      .revalidate(input)
      .then((decision) => {
        if (decision.decision === 'allow') this.store(key, observedAt + this.ttlMs, decision);
        return decision;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return structuredClone(await operation);
  }

  private store(key: string, until: number, value: EligibilityDecision): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { until, value: structuredClone(value) });
  }
}

/**
 * Composition seam: returns the source unchanged when cache options are
 * absent. Every non-production construction (unit and integration tests
 * building PostgresProviderAccountScheduler directly) omits the option and
 * keeps the byte-identical uncached behavior; the production wiring in
 * managed-saas-gateway.ts passes it behind the
 * MODEL_ROUTER_SCHEDULER_STATIC_CACHE kill switch.
 */
export function wrapProviderAccountEligibilityCache(
  source: ProviderAccountSchedulerEligibilityPort,
  options?: CachedProviderAccountEligibilityOptions,
): ProviderAccountSchedulerEligibilityPort {
  return options === undefined ? source : new CachedProviderAccountEligibility(source, options);
}

/**
 * Sentinel propagated by `canonical` when a value (or depth) cannot be
 * represented in the canonical JSON form: the whole key becomes null and
 * the resolve bypasses the cache — at worst a lost cache opportunity,
 * never a wrong hit.
 */
const UNSUPPORTED = Symbol('cache-key-unsupported');

type Canonical = string | boolean | null | Canonical[] | { [key: string]: Canonical } | typeof UNSUPPORTED;

function canonical(value: unknown, depth: number): Canonical {
  if (value === null || value === undefined) return null;
  if (depth > MAX_CANONICAL_DEPTH) return UNSUPPORTED;
  switch (typeof value) {
    case 'string':
      return value;
    case 'boolean':
      return value;
    case 'number':
      // Version epochs arrive as number/string/bigint depending on the
      // adapter; one canonical string form per epoch value.
      return Number.isFinite(value) ? String(value) : UNSUPPORTED;
    case 'bigint':
      return value.toString(10);
    case 'object': {
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : UNSUPPORTED;
      if (Array.isArray(value)) {
        const items: Canonical[] = [];
        for (const item of value) {
          const canonicalItem = canonical(item, depth + 1);
          if (canonicalItem === UNSUPPORTED) return UNSUPPORTED;
          items.push(canonicalItem);
        }
        return items;
      }
      const record: { [key: string]: Canonical } = {};
      for (const property of Object.keys(value as Record<string, unknown>).sort()) {
        const canonicalValue = canonical((value as Record<string, unknown>)[property], depth + 1);
        if (canonicalValue === UNSUPPORTED) return UNSUPPORTED;
        record[property] = canonicalValue;
      }
      return record;
    }
    default:
      return UNSUPPORTED;
  }
}

function cacheKey(input: RevalidateInput): string | null {
  // `now` is the scheduler clock, not an authority fact (the SQL uses the
  // database authority_now; input.now only feeds a scheduling signal), so it
  // is deliberately excluded: including it would defeat every cache hit.
  const { now: _now, ...versioned } = input as RevalidateInput & { now?: Date };
  const normalized = canonical(versioned, 0);
  if (normalized === UNSUPPORTED) return null;
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
