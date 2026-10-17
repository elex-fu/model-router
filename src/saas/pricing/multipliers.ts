import type {
  ExactIntegerInput,
  LongContextPolicyInput,
  NormalizedLongContextPolicy,
  NormalizedTokenMultiplierPolicy,
  RationalMultiplier,
  RationalMultiplierInput,
  TokenMultiplierPolicyInput,
} from './types.js';

/**
 * §4.1 (roadmap batch 4) token-path billing multipliers: service-tier
 * settlement and long-context repricing. Pure functions over exact rationals;
 * ported from sub2api's `service_tier_billing.go` and the LongContext* fields
 * of `billing_service.go` with the float multipliers replaced by exact
 * rational pairs.
 *
 * Both dimensions are configuration-driven (the price version's
 * `tokenMultipliers`) and default OFF: no policy, no tier input, or a neutral
 * 1/1 multiplier leaves every existing token calculation byte-identical.
 */

/**
 * Known service tiers, ordered by cost rank (lower rank = cheaper). Mirrors
 * sub2api `serviceTierCostRank`: flex is cheaper than the base tier family;
 * priority/fast are more expensive; unknown tiers rank at base but are
 * reported unknown so the resolver never bills on them.
 */
const SERVICE_TIER_COST_RANK: Readonly<Record<string, number>> = {
  flex: 0,
  '': 1,
  default: 1,
  standard: 1,
  auto: 1,
  scale: 1,
  priority: 2,
  fast: 2,
};

export function normalizeBillingServiceTier(tier: string | null | undefined): string {
  return (tier ?? '').trim().toLowerCase();
}

export interface ServiceTierBillingResolution {
  /** Tier carried by the request sent upstream ('' when none). */
  readonly requested: string;
  /** Tier declared by the upstream response ('' when none). */
  readonly observed: string;
  /** Tier used for billing. */
  readonly billing: string;
  /** Billing is cheaper than requested (audit signal). */
  readonly downgraded: boolean;
}

/**
 * Picks the tier to bill. The upstream declaration is trusted ONLY to lower
 * the bill: a request served below the tier it asked for (OpenAI `priority`
 * answered with `service_tier: default`, Anthropic fast answered with
 * `usage.speed: standard`) is billed at the cheaper tier. A response that
 * claims a more expensive tier, an unknown one, or none at all leaves the
 * requested tier in place — which is also the behavior for upstreams that
 * never declare a tier.
 */
export function resolveBillingServiceTier(
  requested: string | null | undefined,
  observed: string | null | undefined,
): ServiceTierBillingResolution {
  const normalizedRequested = normalizeBillingServiceTier(requested);
  const normalizedObserved = normalizeBillingServiceTier(observed);
  const resolution: ServiceTierBillingResolution = {
    requested: normalizedRequested,
    observed: normalizedObserved,
    billing: normalizedRequested,
    downgraded: false,
  };
  if (normalizedObserved === '' || normalizedObserved === normalizedRequested) return resolution;
  const observedRank = SERVICE_TIER_COST_RANK[normalizedObserved];
  if (observedRank === undefined) return resolution;
  const requestedRank = SERVICE_TIER_COST_RANK[normalizedRequested] ?? 1;
  if (observedRank >= requestedRank) return resolution;
  return { ...resolution, billing: normalizedObserved, downgraded: true };
}

const NEUTRAL_MULTIPLIER: RationalMultiplier = { numerator: 1n, denominator: 1n };

function parseMultiplierPart(value: ExactIntegerInput, label: string): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && value.trim().length <= 19 && /^(0|[1-9][0-9]*)$/.test(value.trim())) {
    parsed = BigInt(value.trim());
  } else {
    throw new TypeError(`${label} must be a non-negative exact integer`);
  }
  if (parsed <= 0n) throw new TypeError(`${label} must be positive`);
  return parsed;
}

/** Exact rational multiplier; a zero numerator would make billing free, so it is rejected. */
export function normalizeRationalMultiplier(value: RationalMultiplierInput, label: string): RationalMultiplier {
  return {
    numerator: parseMultiplierPart(value.numerator, `${label}.numerator`),
    denominator: parseMultiplierPart(value.denominator, `${label}.denominator`),
  };
}

export function isNeutralMultiplier(value: RationalMultiplier): boolean {
  return value.numerator === value.denominator;
}

function multiplyMultipliers(left: RationalMultiplier, right: RationalMultiplier): RationalMultiplier {
  return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
}

/**
 * Normalizes the whole optional multiplier policy. Null/undefined input is
 * null (multipliers off). A non-null policy with no service tiers and no
 * long-context terms is also null — an empty policy must not change any
 * digest material that a null policy would omit.
 */
export function normalizeTokenMultiplierPolicy(
  input: TokenMultiplierPolicyInput | null | undefined,
): NormalizedTokenMultiplierPolicy | null {
  if (input === null || input === undefined) return null;
  const serviceTiers: Record<string, RationalMultiplier> = {};
  let hasServiceTiers = false;
  if (input.serviceTiers !== null && input.serviceTiers !== undefined) {
    if (typeof input.serviceTiers !== 'object' || Array.isArray(input.serviceTiers)) {
      throw new TypeError('tokenMultipliers.serviceTiers must be a tier map');
    }
    for (const [tier, multiplier] of Object.entries(input.serviceTiers)) {
      const normalizedTier = normalizeBillingServiceTier(tier);
      if (normalizedTier === '') throw new TypeError('tokenMultipliers.serviceTiers tier must be non-empty');
      if (SERVICE_TIER_COST_RANK[normalizedTier] === undefined) {
        throw new TypeError(`tokenMultipliers.serviceTiers tier ${normalizedTier} is not a known service tier`);
      }
      serviceTiers[normalizedTier] = normalizeRationalMultiplier(multiplier, `serviceTiers.${normalizedTier}`);
      hasServiceTiers = true;
    }
  }
  let longContext: NormalizedLongContextPolicy | null = null;
  if (input.longContext !== null && input.longContext !== undefined) {
    const raw = input.longContext as LongContextPolicyInput;
    let threshold: bigint;
    if (typeof raw.inputThreshold === 'bigint') threshold = raw.inputThreshold;
    else if (typeof raw.inputThreshold === 'number' && Number.isSafeInteger(raw.inputThreshold)) {
      threshold = BigInt(raw.inputThreshold);
    } else if (
      typeof raw.inputThreshold === 'string' &&
      raw.inputThreshold.trim().length <= 19 &&
      /^(0|[1-9][0-9]*)$/.test(raw.inputThreshold.trim())
    ) {
      threshold = BigInt(raw.inputThreshold.trim());
    } else {
      throw new TypeError('longContext.inputThreshold must be a non-negative exact integer');
    }
    if (threshold <= 0n) throw new TypeError('longContext.inputThreshold must be positive');
    longContext = {
      inputThreshold: threshold,
      thresholdInclusive: raw.thresholdInclusive === true,
      inputMultiplier: normalizeRationalMultiplier(raw.inputMultiplier, 'longContext.inputMultiplier'),
      outputMultiplier: normalizeRationalMultiplier(raw.outputMultiplier, 'longContext.outputMultiplier'),
    };
  }
  if (!hasServiceTiers && longContext === null) return null;
  return { serviceTiers, longContext };
}

/** Service-tier multiplier for a resolved tier; unlisted/unknown tiers are neutral. */
export function serviceTierMultiplier(
  tier: string,
  policy: NormalizedTokenMultiplierPolicy | null,
): RationalMultiplier {
  if (policy === null) return NEUTRAL_MULTIPLIER;
  const normalizedTier = normalizeBillingServiceTier(tier);
  return policy.serviceTiers[normalizedTier] ?? NEUTRAL_MULTIPLIER;
}

export interface LongContextApplication {
  readonly inputMultiplier: RationalMultiplier;
  readonly outputMultiplier: RationalMultiplier;
}

/**
 * Long-context repricing: once billed input tokens cross the threshold, the
 * ENTIRE session's input and output are multiplied (never just the excess).
 * `thresholdInclusive` selects `>=` (xAI) over the default strict `>`
 * (Claude/GPT-5.4). Returns null when the policy is absent or the threshold
 * is not crossed.
 */
export function longContextMultiplier(
  billedInputTokens: bigint,
  policy: NormalizedTokenMultiplierPolicy | null,
): LongContextApplication | null {
  if (policy === null || policy.longContext === null) return null;
  const { longContext } = policy;
  const crossed = longContext.thresholdInclusive
    ? billedInputTokens >= longContext.inputThreshold
    : billedInputTokens > longContext.inputThreshold;
  if (!crossed) return null;
  return { inputMultiplier: longContext.inputMultiplier, outputMultiplier: longContext.outputMultiplier };
}

export interface EffectiveTokenMultipliers {
  readonly input: RationalMultiplier;
  readonly output: RationalMultiplier;
  readonly serviceTier: ServiceTierBillingResolution | null;
  readonly longContextApplied: boolean;
}

function combine(base: RationalMultiplier, extra: RationalMultiplier | null): RationalMultiplier {
  return extra === null || isNeutralMultiplier(extra) ? base : multiplyMultipliers(base, extra);
}

/**
 * Resolves the effective input/output term multipliers for one calculation:
 * service tier (whole-bill) × long context (input/output-specific). Neutral
 * 1/1 multipliers are returned as exact identity so a no-op policy leaves
 * rate arithmetic untouched (zero drift for existing token paths).
 */
export function computeEffectiveTokenMultipliers(input: {
  readonly policy: NormalizedTokenMultiplierPolicy | null;
  readonly billedInputTokens: bigint | null;
  readonly requestedServiceTier?: string | null;
  readonly observedServiceTier?: string | null;
}): EffectiveTokenMultipliers {
  const hasTierInput =
    (input.requestedServiceTier !== null && input.requestedServiceTier !== undefined) ||
    (input.observedServiceTier !== null && input.observedServiceTier !== undefined);
  if (input.policy === null && !hasTierInput) {
    return { input: NEUTRAL_MULTIPLIER, output: NEUTRAL_MULTIPLIER, serviceTier: null, longContextApplied: false };
  }
  let serviceTier: ServiceTierBillingResolution | null = null;
  let tierMultiplier = NEUTRAL_MULTIPLIER;
  if (hasTierInput) {
    serviceTier = resolveBillingServiceTier(input.requestedServiceTier, input.observedServiceTier);
    tierMultiplier = serviceTierMultiplier(serviceTier.billing, input.policy);
  }
  const longContext = longContextMultiplier(input.billedInputTokens ?? 0n, input.policy);
  return {
    input: combine(tierMultiplier, longContext?.inputMultiplier ?? null),
    output: combine(tierMultiplier, longContext?.outputMultiplier ?? null),
    serviceTier,
    longContextApplied: longContext !== null,
  };
}

/** Canonical digest material for a multiplier policy; null policy → null (omitted). */
export function tokenMultiplierPolicyDigestMaterial(
  policy: NormalizedTokenMultiplierPolicy | null,
): Record<string, unknown> | null {
  if (policy === null) return null;
  const material: Record<string, unknown> = {};
  const tierKeys = Object.keys(policy.serviceTiers).sort();
  if (tierKeys.length > 0) {
    material.serviceTiers = Object.fromEntries(
      tierKeys.map((tier) => [
        tier,
        {
          numerator: policy.serviceTiers[tier].numerator.toString(10),
          denominator: policy.serviceTiers[tier].denominator.toString(10),
        },
      ]),
    );
  }
  if (policy.longContext !== null) {
    material.longContext = {
      inputThreshold: policy.longContext.inputThreshold.toString(10),
      thresholdInclusive: policy.longContext.thresholdInclusive,
      inputMultiplier: {
        numerator: policy.longContext.inputMultiplier.numerator.toString(10),
        denominator: policy.longContext.inputMultiplier.denominator.toString(10),
      },
      outputMultiplier: {
        numerator: policy.longContext.outputMultiplier.numerator.toString(10),
        denominator: policy.longContext.outputMultiplier.denominator.toString(10),
      },
    };
  }
  return material;
}
