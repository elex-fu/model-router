import { createHash } from 'node:crypto';
import type {
  RequestPreparationCaller,
  RequestPreparationEntitlement,
  RequestPreparationEntitlementPort,
  RequestPreparationSqlOptions,
} from './request-preparation-service.js';

export interface CachedRequestPreparationEntitlementOptions {
  /** Milliseconds an allow decision stays reusable; defaults to 5000ms. */
  readonly ttlMs?: number;
  /** Bounded cache size (entries and in-flight resolutions); defaults to 4096. */
  readonly maxEntries?: number;
  /** Injectable monotonic clock (milliseconds) for tests. */
  readonly now?: () => number;
}

type ResolveInput = Parameters<RequestPreparationEntitlementPort['resolve']>[0];
type EntitlementDecision = Awaited<ReturnType<RequestPreparationEntitlementPort['resolve']>>;

/**
 * §12.2 Phase A2a (D2) performance wide-snapshot extension: bounded,
 * allow-only process cache for the pre-dispatch entitlement resolution
 * (RequestPreparationEntitlementPort), mirroring the
 * CachedRequestPreparationAuthority precedent.
 *
 * The cache key is the caller's complete identity/version tuple (tenant,
 * project, proxy key, principal, entitlement id, supply profile id, supply
 * mode, model scopes, and the authz/entitlement/supplyProfile/modelScope
 * epochs) plus the request's publicModel and protocol — the version
 * contract: when every version in the key is unchanged, the entitlement
 * facts the resolver reads are unchanged. The resolver reads
 * saas_project_entitlements ⋈ saas_supply_profiles keyed by entitlement id
 * and validates authz_version/supply_profile authz_version against the
 * caller-carried epochs, and the BYOK plan snapshot resolved by entitlement
 * id carries its own entitlementAuthzVersion — so a concurrent version
 * change produces a new key, misses, and re-resolves. The key contains only
 * id-shaped caller fields — never key material, credentials, or request
 * bodies.
 *
 * Only allow decisions are cached. Rejects (entitlement_denied) and blocks
 * (storage_failure / capability_unavailable) are never amplified by a cache
 * window, so fail-closed denials stay fresh.
 *
 * Version facts the resolve INPUT does not carry — projectPolicyVersion
 * (saas_projects.inference_policy_version) and the project
 * inference_policy_status — are NOT in the key. Safety premise (verified
 * against postgres-request-admission-guard.ts): the admission guard
 * re-reads the project, project-policy version row, entitlement, and
 * supply profile from PostgreSQL inside the admission transaction
 * (loadAdmissionAuthority UNION ALL batch, after the shared fences) and
 * revalidates the frozen versions carried by the request/attempt records
 * against those fresh rows. A stale or racing policy/entitlement version
 * therefore fails closed at admission — a cache hit can never bypass the
 * final defense line, exactly like the CachedRequestPreparationAuthority
 * precedent. Control-plane changes surface as bounded (≤ TTL) guard
 * denials until the affected entries expire, never as silently stale
 * authority.
 *
 * Executor-carrying resolutions (RequestPreparationSqlOptions) bypass the
 * cache entirely, both read and write: an in-transaction resolve runs under
 * the shared authorization fences and must observe the transaction's fresh
 * READ COMMITTED snapshot. The production pre-dispatch path never passes
 * sqlOptions (the preparation service and the model-list resolver call
 * resolve with the caller/publicModel/protocol input only), so the bypass
 * is a defensive invariant, not a hot path.
 */
export class CachedRequestPreparationEntitlement implements RequestPreparationEntitlementPort {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, { until: number; value: RequestPreparationEntitlement }>();
  private readonly pending = new Map<string, Promise<EntitlementDecision>>();

  /** The wrapped entitlement port; public read-only like the protocol decorators. */
  readonly underlyingEntitlement: RequestPreparationEntitlementPort;

  constructor(source: RequestPreparationEntitlementPort, options: CachedRequestPreparationEntitlementOptions = {}) {
    this.underlyingEntitlement = source;
    this.ttlMs = options.ttlMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 4096;
    this.now = options.now ?? Date.now;
    for (const bound of [this.ttlMs, this.maxEntries]) {
      if (!Number.isSafeInteger(bound) || bound < 1) throw new Error('Invalid preparation entitlement cache bounds');
    }
  }

  async resolve(input: ResolveInput, sqlOptions?: RequestPreparationSqlOptions): Promise<EntitlementDecision> {
    // A transaction executor means a fenced, in-transaction resolution: never
    // serve a cache hit, never store one (see the class comment).
    if (sqlOptions !== undefined) return this.underlyingEntitlement.resolve(input, sqlOptions);
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
      return this.underlyingEntitlement.resolve(input);
    }
    const observedAt = this.now();
    const operation = this.underlyingEntitlement
      .resolve(input)
      .then((decision) => {
        if (decision.decision === 'allow') this.store(key, observedAt + this.ttlMs, decision.value);
        return decision;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return structuredClone(await operation);
  }

  private store(key: string, until: number, value: RequestPreparationEntitlement): void {
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { until, value: structuredClone(value) });
  }
}

/**
 * Normalizes a version the way the resolver compares versions (bigint
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
      // Membership-only downstream (allowedModels includes publicModel):
      // canonical set identity.
      modelScopes: [...input.caller.modelScopes].sort(),
      authzVersion: exactVersion(input.caller.authzVersion),
      entitlementVersion: exactVersion(input.caller.entitlementVersion),
      supplyProfileVersion: exactVersion(input.caller.supplyProfileVersion),
      modelScopeVersion: exactVersion(input.caller.modelScopeVersion),
    },
    publicModel: input.publicModel,
    protocol: input.protocol,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
