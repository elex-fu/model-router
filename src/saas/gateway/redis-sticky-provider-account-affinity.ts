import {
  computeStickySessionHash,
  REDIS_STICKY_TTL_MS,
  type RedisRuntimeCache,
  stickyKeyForRequest,
} from '../runtime/redis-concurrency-slots.js';
import type {
  ProviderAccountSchedulerAffinityBindDecision,
  ProviderAccountSchedulerAffinityDecision,
  ProviderAccountSchedulerAffinityPort,
} from './provider-account-scheduler.js';

/**
 * R6b sticky-session fast path (docs/token-resale-implementation-plan-2026-10-15.md
 * §R6b-2): a Redis-backed decorator around any
 * ProviderAccountSchedulerAffinityPort (production: the 041 Postgres
 * affinity source).
 *
 * Semantics:
 * - resolve(): the Redis sticky key is checked FIRST with a sliding-TTL read
 *   (GET+PEXPIRE in one atomic EVAL): a hit whose account is still in
 *   eligibleAccountIds returns immediately (the fast path) and its 1h window
 *   is refreshed, so the TTL bounds session IDLENESS, not absolute mapping
 *   age. A miss falls back to the inner PG affinity source, and a successful
 *   allow with a non-null account is backfilled into Redis with the 1h TTL.
 *   An ineligible hit also falls back to PG; whatever PG then decides, the
 *   stale Redis row is cleared (shouldClearStickySession, batch 2 §2.1): a
 *   PG 'stale' (binding cleared, degrade to load balancing) or a PG miss
 *   both delete the key, and a PG allow overwrites it via the backfill.
 *   (The atomic refresh cannot be conditional on the caller's eligible set —
 *   an ineligible hit may extend a stale row's lifetime, which is harmless:
 *   eligibility is re-checked on every read and PG re-decides.)
 * - bind(): always forwards to the inner port (PG stays authoritative) and
 *   backfills the Redis mapping only after a successful bind. A block,
 *   including an active-binding contention hint, is forwarded unchanged.
 * - The sessionHash priority is sub2api's — session-id → conversation_id →
 *   prompt_cache_key → content-hash fallback. The http-handler scheduling
 *   seam (sticky-session-reference.ts) derives that reference at the trusted
 *   boundary and fills input.scheduling.sessionId;
 *   computeStickySessionHash is the single shared implementation of the
 *   priority chain.
 * - Invalidation: the RESP client deliberately has no SUBSCRIBE, so PubSub
 *   invalidation is NOT wired (documented deviation). The sliding 1h TTL
 *   bounds Redis↔PG drift for idle sessions and the PG source remains
 *   authoritative on every miss; the PG affinity resolver additionally
 *   CAS-invalidates a stale target itself when it is no longer eligible.
 *
 * STRICT ROLE: this is a cache/coordination layer only. PG (the 041 table)
 * stays the durable affinity source of record; every Redis decision is
 * re-validated against the caller-provided eligible set before use, and any
 * Redis failure degrades to the pure-PG path (fail-open).
 *
 * Integration point (R7 / combined deployments): the decorator wraps the
 * PostgresProviderAccountAffinity instance handed to the gateway
 * composition as schedulerAffinity. The dedicated gateway workload may hold
 * ONE core-owned Redis connection when the gateway-scoped deployment
 * setting (MODEL_ROUTER_SAAS_GATEWAY_REDIS_URL) is present — core loads it
 * and passes the cache client here; absent the setting, the pure-PG path
 * runs unchanged (combined/control-plane topologies wire the shared Redis
 * provider's cache client instead).
 */

export interface RedisStickyAffinityOptions {
  readonly cache: RedisRuntimeCache;
  /** Redis key prefix shared with the hot-state clients (e.g. model-router:saas). */
  readonly keyPrefix: string;
  /** Sticky TTL; defaults to the plan's 1 hour. */
  readonly ttlMs?: number;
}

export class RedisStickyAffinityError extends Error {
  constructor() {
    super('invalid Redis sticky affinity configuration');
    this.name = 'RedisStickyAffinityError';
  }
}

interface AffinityResolveInput {
  readonly context: {
    readonly sessionId?: string | undefined;
    readonly previousResponseId?: string | undefined;
  };
  readonly scope: {
    readonly supplyProfileId: string;
    readonly accountOwnerKind: 'tenant' | 'platform';
  };
  readonly eligibleAccountIds: readonly string[];
}

/** The sticky pool scope: the supply profile + owner kind identify the pool. */
function stickyPoolScopeKey(scope: { readonly supplyProfileId: string; readonly accountOwnerKind: string }): string {
  return `${scope.accountOwnerKind}:${scope.supplyProfileId}`;
}

export function createRedisStickyProviderAccountAffinity(
  inner: ProviderAccountSchedulerAffinityPort,
  options: RedisStickyAffinityOptions,
): ProviderAccountSchedulerAffinityPort {
  if (!inner || typeof inner.resolve !== 'function') throw new RedisStickyAffinityError();
  if (!options || typeof options !== 'object' || !options.cache) throw new RedisStickyAffinityError();
  if (typeof options.keyPrefix !== 'string' || options.keyPrefix === '' || options.keyPrefix.length > 128) {
    throw new RedisStickyAffinityError();
  }
  const cache = options.cache;
  const ttlMs =
    typeof options.ttlMs === 'number' &&
    Number.isSafeInteger(options.ttlMs) &&
    options.ttlMs >= 1 &&
    options.ttlMs <= 86_400_000
      ? options.ttlMs
      : REDIS_STICKY_TTL_MS;

  const stickyKey = (input: {
    readonly context: { readonly sessionId?: string | undefined; readonly previousResponseId?: string | undefined };
    readonly scope: { readonly supplyProfileId: string; readonly accountOwnerKind: string };
  }): string | null => {
    const sessionHash = computeStickySessionHash({
      sessionId: input.context.sessionId ?? null,
      conversationId: input.context.previousResponseId ?? null,
    });
    if (sessionHash === null) return null;
    return stickyKeyForRequest(options.keyPrefix, stickyPoolScopeKey(input.scope), { sessionId: sessionHash });
  };

  const backfill = (key: string | null, accountId: string | null): void => {
    if (key === null || accountId === null) return;
    void cache.set(key, Buffer.from(accountId, 'utf8'), ttlMs).catch(() => undefined);
  };

  const clear = (key: string | null): void => {
    if (key === null) return;
    void cache.delete(key).catch(() => undefined);
  };

  return {
    async resolve(input): Promise<ProviderAccountSchedulerAffinityDecision> {
      const key = stickyKey(input as AffinityResolveInput);
      let staleHit = false;
      if (key !== null) {
        // Sliding-TTL read: a hit atomically refreshes the 1h idle window
        // (REDIS_CACHE_GET_SLIDING_SCRIPT) before eligibility is checked.
        const entry = await cache.getAndRefreshTtl(key, ttlMs);
        if (entry.state === 'hit' && entry.value !== null) {
          const accountId = entry.value.toString('utf8');
          if ((input.eligibleAccountIds as readonly string[]).includes(accountId)) {
            return { decision: 'allow', accountId };
          }
          // Ineligible hit: fall through to the authoritative PG source,
          // which performs its own CAS invalidation of the stale row. The
          // Redis copy is drift whatever PG decides, so remember to clear.
          staleHit = true;
        }
      }
      const decision = await inner.resolve(input);
      if (decision.decision === 'allow') {
        if (decision.accountId !== null) {
          // Overwrites any stale drift with PG's authoritative mapping.
          backfill(key, decision.accountId);
        } else if (staleHit) {
          // PG holds no active binding: the ineligible Redis row is pure
          // drift (e.g. PG's row expired first) — drop it.
          clear(key);
        }
        return decision;
      }
      if (decision.decision === 'stale') {
        // PG cleared the binding (target no longer schedulable): drop the
        // stale Redis copy too and let the caller degrade to load balancing.
        clear(key);
        return decision;
      }
      return decision;
    },
    async bind(input): Promise<ProviderAccountSchedulerAffinityBindDecision> {
      const decision: ProviderAccountSchedulerAffinityBindDecision =
        inner.bind === undefined ? { decision: 'allow' } : await inner.bind(input);
      if (decision.decision !== 'allow') return decision;
      if (typeof input.accountId === 'string') {
        backfill(
          stickyKey({
            context: input.context as {
              readonly sessionId?: string | undefined;
              readonly previousResponseId?: string | undefined;
            },
            scope: input.scope as { readonly supplyProfileId: string; readonly accountOwnerKind: string },
          }),
          input.accountId,
        );
      }
      return decision;
    },
  };
}
