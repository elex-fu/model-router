import type { BillingGroupRecord } from '../../billing/groups/types.js';
import type { CustomerPriceVersionRecord } from '../../pricing/types.js';

/**
 * Model plaza (roadmap batch 5 §5.5, task #22): a zero-storage, read-only
 * showcase over the live billing-group × catalog × pricing state. The
 * aggregation semantics are the sub2api model-plaza port (backend/internal/
 * service/model_plaza_service.go):
 *
 * - model enumeration comes from the catalog capability rows (supported +
 *   verified + platform rights active) intersected with each group's account
 *   pool (a group with no pool rows is UNRESTRICTED — the F2 scheduling
 *   contract), never from a plaza-owned table;
 * - the display price for every (group, model) pair is the exact amount the
 *   customer would be charged: the customer price version resolved through
 *   `SaasPricingService.resolveCustomerPriceVersion` (the same chain the
 *   admission guard uses, run inside one snapshot transaction), with the
 *   group's per-model override replacing the rate set and the group rate
 *   multiplier scaling every rate (peak windows are exposed separately —
 *   base-rate display, never a silently time-varying price);
 * - whitelist semantics: model scopes (what a key may CALL) never filter the
 *   plaza (what a visitor may SEE); exclusivity is a showcase-level flag from
 *   the plaza settings, and exclusive groups are invisible to anonymous
 *   callers.
 */

/** The three plaza access tiers, resolved at the HTTP boundary. */
export type ModelPlazaAccessTier = 'proxy_key' | 'session' | 'anonymous';

/** Caller identity material for one plaza request, by tier. */
export interface ModelPlazaAccess {
  readonly tier: ModelPlazaAccessTier;
  /** Present only for the proxy_key tier. */
  readonly proxyKeyCaller: { readonly tenantId: string; readonly projectId: string; readonly keyId: string } | null;
  /** Present only for the session tier. */
  readonly sessionUserId: string | null;
}

/** One nominal catalog pricing target (the platformPricingTargetSql shape). */
export interface ModelPlazaTarget {
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly alias: string;
  readonly displayName: string;
  readonly providerId: string;
  readonly productId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly protocol: string;
}

/** One effective customer price identity (currency included). */
export interface ModelPlazaPriceIdentity {
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly providerId: string;
  readonly productId: string;
  readonly protocol: string;
  readonly endpoint: string;
  readonly currency: string;
}

/**
 * The point-in-time facts one plaza render needs, read inside a single
 * transaction. `capabilityKey` strings are
 * `provider \0 product \0 model \0 endpoint` composites.
 */
export interface ModelPlazaFacts {
  /** Active billing groups (already status-filtered), id-ordered. */
  readonly groups: readonly BillingGroupRecord[];
  /** Per group: capability keys servable by its account pool. */
  readonly groupCapabilities: ReadonlyMap<string, ReadonlySet<string>>;
  /** Groups with no pool rows (unrestricted — every platform account serves). */
  readonly unrestrictedGroupIds: ReadonlySet<string>;
  /** Per group: provider ids with active+verified accounts in its pool. */
  readonly groupPlatforms: ReadonlyMap<string, ReadonlySet<string>>;
  /** All capability keys of active+verified platform accounts. */
  readonly globalCapabilities: ReadonlySet<string>;
  /** All provider ids with active+verified platform accounts. */
  readonly globalPlatforms: ReadonlySet<string>;
  /** Nominal catalog targets (deterministically ordered). */
  readonly targets: readonly ModelPlazaTarget[];
  /** Effective customer price identities with at least one live version. */
  readonly priceIdentities: readonly ModelPlazaPriceIdentity[];
}

/**
 * A snapshot transaction: the facts plus the same-chain price resolution and
 * the per-tier authorized-group lookups, all running on one executor so a
 * render is coherent.
 */
export interface ModelPlazaSnapshot {
  readonly facts: ModelPlazaFacts;
  /**
   * Resolves the authoritative customer price version for one identity —
   * `SaasPricingService.resolveCustomerPriceVersion` on the snapshot's
   * executor. Null when no version is effective (unpriced showcase entry).
   */
  readonly resolvePrice: (identity: ModelPlazaPriceIdentity) => Promise<CustomerPriceVersionRecord | null>;
  /** The key's effective billing group id (key binding → tenant default → 'default'); null when unresolvable. */
  readonly resolveKeyBillingGroup: (caller: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly keyId: string;
  }) => Promise<string | null>;
  /** The session user's authorized billing group ids; empty when none. */
  readonly resolveSessionUserGroups: (userId: string) => Promise<readonly string[]>;
}

/** The store seam the plaza service aggregates over. */
export interface ModelPlazaFactsPort {
  withSnapshot<T>(at: Date, work: (snapshot: ModelPlazaSnapshot) => Promise<T>): Promise<T>;
}

/** A rational rate as surfaced for display (exact rational + decimal helpers). */
export interface ModelPlazaRate {
  readonly numeratorMinorUnits: string;
  readonly denominatorUnits: string;
  /** Currency units per 1,000,000 usage units (tokens); null when the currency's minor-unit exponent is unknown. */
  readonly perMillionUnits: string | null;
  /** Currency units per single usage unit (per_unit metrics); null when the exponent is unknown. */
  readonly perUnitPrice: string | null;
}

export interface ModelPlazaLongContextPolicy {
  readonly inputThreshold: string;
  readonly thresholdInclusive: boolean;
  readonly inputMultiplier: { readonly numerator: string; readonly denominator: string };
  readonly outputMultiplier: { readonly numerator: string; readonly denominator: string };
}

/** The effective (实收口径) display pricing for one (group, model) pair. */
export interface ModelPlazaPricing {
  readonly currency: string;
  readonly rates: {
    readonly input: ModelPlazaRate | null;
    readonly cacheRead: ModelPlazaRate | null;
    readonly cacheWrite: ModelPlazaRate | null;
    readonly cacheWrite5m: ModelPlazaRate | null;
    readonly cacheWrite1h: ModelPlazaRate | null;
    readonly output: ModelPlazaRate | null;
  };
  readonly perUnit: ModelPlazaRate | null;
  readonly perUnitTiers: Readonly<Record<string, ModelPlazaRate>> | null;
  readonly longContext: ModelPlazaLongContextPolicy | null;
  readonly serviceTiers: Readonly<Record<string, { readonly numerator: string; readonly denominator: string }>> | null;
}

/** Official reference pricing (models.dev registry; USD per 1M tokens). */
export interface ModelPlazaOfficialPricing {
  readonly input: string | null;
  readonly output: string | null;
  readonly cacheRead: string | null;
  readonly cacheWrite: string | null;
}

export interface ModelPlazaModel {
  readonly model: string;
  readonly displayName: string;
  readonly platform: string;
  readonly contextWindow: number | null;
  readonly pricing: ModelPlazaPricing | null;
  readonly officialPricing: ModelPlazaOfficialPricing | null;
}

export interface ModelPlazaGroup {
  readonly id: string;
  readonly name: string;
  readonly composite: boolean;
  readonly rateMultiplier: { readonly numerator: string; readonly denominator: string };
  readonly peak: {
    readonly start: string;
    readonly end: string;
    readonly multiplier: { readonly numerator: string; readonly denominator: string };
  } | null;
  readonly models: readonly ModelPlazaModel[];
}

export interface ModelPlazaResponse {
  readonly description: string;
  readonly groups: readonly ModelPlazaGroup[];
}
