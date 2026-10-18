import { normalizeBillingServiceTier, SERVICE_TIER_COST_RANK } from './multipliers.js';

/**
 * R3 §8.3 service-tier trust rules, declared per supply category.
 *
 * `service_tier_billing.go` in sub2api has two facts that must be ported
 * together, never just the generic "a trusted response can only lower the
 * bill" pure function:
 *
 * 1. Verified public APIs report the served tier authoritatively — an
 *    outbound `priority` answered with `service_tier: default` really was
 *    downgraded and bills at the cheaper tier.
 * 2. Codex OAuth is the recorded exception: the ChatGPT-subscription
 *    backend frequently answers `service_tier: default` for requests that
 *    were NOT actually downgraded, so the observed tier there is
 *    NON-AUTHORITATIVE. The outbound tier is kept and the observed value is
 *    recorded next to a trust reason instead of being applied.
 *
 * All rules here are pure and deterministic. They are evaluated once, at the
 * observation/dispatch point, with the account category known; the resolved
 * billing tier plus the trust reason are frozen onto the usage evidence, so
 * settlement never re-interprets history against newer adapter or price
 * policy versions.
 */

/** Whether an upstream's declared tier may lower this request's bill. */
export type ServiceTierObservedAuthority = 'authoritative' | 'non-authoritative';

/** Why the billing tier was chosen; every case is explainable in usage details. */
export type ServiceTierTrustReason =
  | 'no-tier-input'
  | 'observed-missing'
  | 'observed-lower'
  | 'observed-equal'
  | 'observed-higher-ignored'
  | 'observed-unknown-ignored'
  | 'observed-conflict'
  | 'observed-non-authoritative';

/** The category a supply identity belongs to, for tier-trust purposes. */
export type ServiceTierTrustCategory = 'public-api' | 'codex-oauth';

export interface ServiceTierAccountFacts {
  readonly providerId: string;
  readonly productId?: string | null;
  /** Codex accounts are OAuth by construction; carried for future categories. */
  readonly credentialType?: string | null;
}

/**
 * Category classification. The Codex product is the single non-authoritative
 * category today (provider `openai-codex`, product `codex-chatgpt`, the
 * ChatGPT-subscription OAuth surface); every other verified provider is a
 * public API whose response tier is authoritative.
 */
export function serviceTierTrustCategory(facts: ServiceTierAccountFacts): ServiceTierTrustCategory {
  if (facts.providerId === 'openai-codex') return 'codex-oauth';
  return 'public-api';
}

/** Observed-tier authority per category (§8.3 table). */
export function serviceTierObservedAuthority(category: ServiceTierTrustCategory): ServiceTierObservedAuthority {
  return category === 'codex-oauth' ? 'non-authoritative' : 'authoritative';
}

export interface ServiceTierTrustResolution {
  /** Tier carried by the request actually sent upstream ('' when none). */
  readonly requested: string;
  /** Tier declared by the upstream response ('' when none). */
  readonly observed: string;
  /** Tier used for billing. */
  readonly billing: string;
  /** Billing is cheaper than requested (audit signal). */
  readonly downgraded: boolean;
  /** The observed tier was withheld from billing (never applied). */
  readonly retained: boolean;
  readonly reason: ServiceTierTrustReason;
}

export interface ServiceTierTrustInput {
  readonly requested: string | null | undefined;
  readonly observed: string | null | undefined;
  readonly observedAuthority: ServiceTierObservedAuthority;
  /** Multiple response reports disagreed; the conflict is never billed on. */
  readonly observedConflict?: boolean;
}

/**
 * Resolves the billing tier under the §8.3 rules:
 *
 * - authoritative + observed lower  → bill at the trusted lower tier;
 * - non-authoritative (Codex OAuth) → keep the outbound tier, record observed;
 * - observed higher, unknown, missing, or conflicting → never raises the bill
 *   alone; the frozen outbound tier applies.
 */
export function resolveServiceTierBillingTerms(input: ServiceTierTrustInput): ServiceTierTrustResolution {
  const requested = normalizeBillingServiceTier(input.requested);
  const observed = normalizeBillingServiceTier(input.observed);
  const base: ServiceTierTrustResolution = {
    requested,
    observed,
    billing: requested,
    downgraded: false,
    retained: false,
    reason: 'no-tier-input',
  };
  if (requested === '' && observed === '') return base;
  if (input.observedConflict === true) {
    // Conflicting reports go to the exception path: the outbound tier is
    // kept and the conflict is recorded; nothing is accumulated or applied.
    return { ...base, retained: observed !== '', reason: 'observed-conflict' };
  }
  if (input.observedAuthority === 'non-authoritative') {
    if (observed === '') return { ...base, reason: 'observed-missing' };
    return { ...base, retained: true, reason: 'observed-non-authoritative' };
  }
  if (observed === '') return { ...base, reason: requested === '' ? 'no-tier-input' : 'observed-missing' };
  if (observed === requested) return { ...base, reason: 'observed-equal' };
  const observedRank = SERVICE_TIER_COST_RANK[observed];
  if (observedRank === undefined) return { ...base, retained: true, reason: 'observed-unknown-ignored' };
  const requestedRank = SERVICE_TIER_COST_RANK[requested] ?? 1;
  if (observedRank >= requestedRank) return { ...base, retained: true, reason: 'observed-higher-ignored' };
  return { ...base, billing: observed, downgraded: true, reason: 'observed-lower' };
}

/**
 * The settlement-facing tier terms after trust resolution: the observed side
 * is suppressed entirely for non-authoritative/conflicting reports so the
 * calculator's only-lower rule cannot apply a tier this category does not
 * trust. Authoritative inputs pass through unchanged.
 */
export function settlementServiceTierTerms(
  resolution: ServiceTierTrustResolution | null,
): { readonly requested: string | null; readonly observed: string | null } | null {
  if (resolution === null) return null;
  if (resolution.requested === '' && resolution.observed === '') return null;
  return {
    requested: resolution.requested === '' ? null : resolution.requested,
    observed:
      resolution.downgraded || resolution.reason === 'observed-equal'
        ? resolution.observed === ''
          ? null
          : resolution.observed
        : null,
  };
}
