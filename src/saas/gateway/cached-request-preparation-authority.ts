import { createHash } from 'node:crypto';
import type {
  RequestPreparationAuthority,
  RequestPreparationAuthorityPort,
  RequestPreparationCaller,
} from './request-preparation-service.js';

export interface CachedRequestPreparationAuthorityOptions {
  /** Milliseconds an allow decision stays reusable; defaults to 5000ms. */
  readonly ttlMs?: number;
  /** Bounded cache size (entries and in-flight resolutions); defaults to 4096. */
  readonly maxEntries?: number;
  /** Injectable monotonic clock (milliseconds) for tests. */
  readonly now?: () => number;
}

type ResolveInput = Parameters<RequestPreparationAuthorityPort['resolve']>[0];
type AuthorityDecision = Awaited<ReturnType<RequestPreparationAuthorityPort['resolve']>>;

/**
 * C0 §29.65 performance narrow-fix: bounded, allow-only process cache for
 * admission authority resolution.
 *
 * The cache key is the complete caller/entitlement version tuple plus the
 * request's model/protocol/operation identity (the version contract: when
 * every version in the key is unchanged, the authorization facts the
 * adapter reads are unchanged; a concurrent version change produces a new
 * key, misses, and re-resolves). The key contains only id-shaped caller
 * fields — never key material, credentials, or request bodies.
 *
 * Only allow decisions are cached. Rejects and storage failures are never
 * amplified by a cache window, so fail-closed denials stay fresh.
 *
 * Safety premise (verified against postgres-request-admission-guard.ts):
 * the admission guard re-reads every authority fact from PostgreSQL inside
 * the admission transaction (loadAdmissionAuthority UNION ALL batch, after
 * the shared fences) and revalidates the frozen versions carried by the
 * request/attempt records against those fresh rows. A stale or racing
 * version therefore fails closed at admission with AUTHORITY_MISMATCH — a
 * cache hit can never bypass the final defense line, exactly like the
 * CachedKeyAuthenticator precedent ("admission still revalidates
 * authorization versions").
 *
 * Version facts the resolve INPUT does not carry (route config version,
 * commercial policy/price/cost versions, composite route registry,
 * account/credential/pool/rights/capability epochs) are all re-derived and
 * revalidated fresh by the guard, so they need not enter the cache key;
 * their control-plane changes surface as bounded (≤ TTL) guard denials
 * until the affected entries expire, never as silently stale authority.
 */
export class CachedRequestPreparationAuthority implements RequestPreparationAuthorityPort {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { until: number; value: RequestPreparationAuthority }>();
  private readonly pending = new Map<string, Promise<AuthorityDecision>>();

  /** The wrapped PostgreSQL adapter; public read-only like the protocol decorators. */
  readonly underlyingAuthority: RequestPreparationAuthorityPort;

  constructor(
    source: RequestPreparationAuthorityPort,
    options: CachedRequestPreparationAuthorityOptions = {},
  ) {
    this.underlyingAuthority = source;
    this.ttlMs = options.ttlMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 4096;
    this.now = options.now ?? Date.now;
    for (const bound of [this.ttlMs, this.maxEntries]) {
      if (!Number.isSafeInteger(bound) || bound < 1) throw new Error('Invalid preparation authority cache bounds');
    }
  }

  async resolve(input: ResolveInput): Promise<AuthorityDecision> {
    const key = cacheKey(input);
    const cached = this.entries.get(key);
    if (cached && cached.until > this.now()) {
      // Recency bump: Map iteration order approximates LRU.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { decision: 'allow', value: structuredClone(cached.value) };
    }
    this.entries.delete(key);
    const inFlight = this.pending.get(key);
    if (inFlight) return structuredClone(await inFlight);
    if (this.pending.size >= this.maxEntries) {
      // Cache pressure must never fail a request: bypass single-flight.
      return this.underlyingAuthority.resolve(input);
    }
    const observedAt = this.now();
    const operation = this.underlyingAuthority
      .resolve(input)
      .then((decision) => {
        if (decision.decision === 'allow') this.store(key, observedAt + this.ttlMs, decision.value);
        return decision;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return structuredClone(await operation);
  }

  private store(key: string, until: number, value: RequestPreparationAuthority): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { until, value: structuredClone(value) });
  }
}

/**
 * Normalizes a version the way the adapter compares versions (bigint
 * equality), so `4`, `'4'`, and `4n` share one cache key. Unparseable
 * values fall back to their raw string form — at worst a spurious miss,
 * never a wrong hit.
 */
function exactVersion(value: RequestPreparationCaller['authzVersion']): string {
  try {
    return BigInt(value).toString(10);
  } catch {
    return String(value);
  }
}

function cacheKey(input: ResolveInput): string {
  const normalized = {
    caller: {
      tenantId: input.caller.tenantId,
      projectId: input.caller.projectId,
      proxyKeyId: input.caller.proxyKeyId,
      principalKind: input.caller.principalKind,
      principalId: input.caller.principalId,
      entitlementId: input.caller.entitlementId,
      supplyProfileId: input.caller.supplyProfileId,
      supplyMode: input.caller.supplyMode,
      // Membership-only downstream: canonical set identity.
      modelScopes: [...input.caller.modelScopes].sort(),
      authzVersion: exactVersion(input.caller.authzVersion),
      entitlementVersion: exactVersion(input.caller.entitlementVersion),
      supplyProfileVersion: exactVersion(input.caller.supplyProfileVersion),
      modelScopeVersion: exactVersion(input.caller.modelScopeVersion),
    },
    entitlement: {
      tenantId: input.entitlement.tenantId,
      projectId: input.entitlement.projectId,
      proxyKeyId: input.entitlement.proxyKeyId,
      entitlementId: input.entitlement.entitlementId,
      entitlementVersion: exactVersion(input.entitlement.entitlementVersion),
      supplyProfileId: input.entitlement.supplyProfileId,
      supplyProfileVersion: exactVersion(input.entitlement.supplyProfileVersion),
      supplyMode: input.entitlement.supplyMode,
      modelScopeVersion: exactVersion(input.entitlement.modelScopeVersion),
      // Membership-only downstream: canonical set identity.
      allowedModels: [...input.entitlement.allowedModels].sort(),
      // Order-sensitive downstream (sameProviderScope): order preserved.
      allowedProviderIds: [...input.entitlement.allowedProviderIds],
      projectPolicyVersion: exactVersion(input.entitlement.projectPolicyVersion),
    },
    publicModel: input.publicModel,
    protocol: input.protocol,
    clientOperation: input.clientOperation ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
