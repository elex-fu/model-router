import { MAX_MINOR_UNITS } from '../billing/money.js';
import { SaasPricingError } from './errors.js';
import {
  computeEffectiveTokenMultipliers,
  type EffectiveTokenMultipliers,
  normalizeTokenMultiplierPolicy,
} from './multipliers.js';
import type {
  CommercialPriceVersionRecord,
  ExactIntegerInput,
  NormalizedPriceHoldInput,
  NormalizedTokenUsage,
  PerUnitTier,
  PriceCalculation,
  PriceHoldInput,
  PriceMetric,
  RateSet,
  RateSetInput,
  RationalMultiplier,
  RationalRate,
  RoundingBoundary,
  RoundingMode,
  TokenUsageInput,
  UsageSettlementCalculation,
} from './types.js';
import { PER_UNIT_TIERS } from './types.js';

export const COMMERCIAL_CALCULATOR_VERSION = 'commercial-token-v1' as const;
export const TOTAL_ROUNDING_BOUNDARY: RoundingBoundary = 'total';

/*
 * Metric order is digest-stable: it defines the insertion order of every
 * normalized RateSet, which the price-version digest material serializes.
 * `per_unit` (4.0 ⑤) must stay LAST so the six legacy metrics keep their
 * exact pre-per_unit ordering; a null per_unit is omitted from that digest
 * material (see rateDigest in service.ts), keeping old digests identical.
 */
const PRICE_METRICS: readonly PriceMetric[] = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
  'per_unit',
];

const PER_UNIT_TIER_SET: ReadonlySet<string> = new Set(PER_UNIT_TIERS);

/** Parses a canonical per-unit size tier; anything outside the registry fails closed. */
export function parsePerUnitTier(value: unknown): PerUnitTier | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !PER_UNIT_TIER_SET.has(value)) fail('INVALID_INPUT');
  return value as PerUnitTier;
}

function fail(
  code: 'INVALID_INPUT' | 'INVALID_RATE' | 'USAGE_INCOMPLETE' | 'PRICE_RATE_MISSING' | 'PRICE_AMOUNT_OVERFLOW',
): never {
  throw new SaasPricingError(code);
}

function parseNonNegativeInteger(value: unknown, code: 'INVALID_INPUT' | 'INVALID_RATE', allowZero = true): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(code);
    parsed = BigInt(value);
  } else if (typeof value === 'string' && value.trim().length <= 19 && /^(0|[1-9][0-9]*)$/.test(value.trim())) {
    try {
      parsed = BigInt(value.trim());
    } catch {
      fail(code);
    }
  } else {
    fail(code);
  }
  if (parsed < 0n || parsed > MAX_MINOR_UNITS || (!allowZero && parsed === 0n)) fail(code);
  return parsed;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

function addRational(
  left: { numerator: bigint; denominator: bigint },
  right: { numerator: bigint; denominator: bigint },
): { numerator: bigint; denominator: bigint } {
  const commonDivisor = gcd(left.denominator, right.denominator);
  const leftMultiplier = right.denominator / commonDivisor;
  const rightMultiplier = left.denominator / commonDivisor;
  const numerator = left.numerator * leftMultiplier + right.numerator * rightMultiplier;
  const denominator = left.denominator * leftMultiplier;
  const reduction = gcd(numerator, denominator);
  return { numerator: numerator / reduction, denominator: denominator / reduction };
}

function multiplyRate(count: bigint, rate: RationalRate): { numerator: bigint; denominator: bigint } {
  return {
    numerator: count * rate.numeratorMinorUnits,
    denominator: rate.denominatorUnits,
  };
}

function normalizeRate(value: RationalRateInputLike): RationalRate {
  const numeratorMinorUnits = parseNonNegativeInteger(value.numeratorMinorUnits, 'INVALID_RATE');
  const denominatorUnits = parseNonNegativeInteger(value.denominatorUnits, 'INVALID_RATE', false);
  return { numeratorMinorUnits, denominatorUnits };
}

interface RationalRateInputLike {
  readonly numeratorMinorUnits: ExactIntegerInput;
  readonly denominatorUnits: ExactIntegerInput;
}

export function normalizeRates(input: RateSetInput): RateSet {
  const normalized = {} as Record<PriceMetric, RationalRate | null>;
  for (const metric of PRICE_METRICS) {
    const value = input[metric];
    normalized[metric] = value === undefined || value === null ? null : normalizeRate(value);
  }
  for (const key of Object.keys(input)) {
    if (key === 'per_unit_tiers') continue;
    if (!(PRICE_METRICS as readonly string[]).includes(key)) fail('INVALID_RATE');
  }
  let perUnitTiers: RateSet['per_unit_tiers'] = null;
  const tierInput = (input as RateSetInput).per_unit_tiers;
  if (tierInput !== undefined && tierInput !== null) {
    if (typeof tierInput !== 'object' || Array.isArray(tierInput)) fail('INVALID_RATE');
    const tiers = {} as Record<PerUnitTier, RationalRate>;
    for (const [tier, rate] of Object.entries(tierInput)) {
      if (!PER_UNIT_TIER_SET.has(tier)) fail('INVALID_RATE');
      if (rate === undefined || rate === null) continue;
      tiers[tier as PerUnitTier] = normalizeRate(rate as RationalRateInputLike);
    }
    // Registry order keeps the map (and its digest material) canonical.
    const canonical = {} as Record<PerUnitTier, RationalRate>;
    for (const tier of PER_UNIT_TIERS) if (tiers[tier] !== undefined) canonical[tier] = tiers[tier];
    if (Object.keys(canonical).length === 0) fail('INVALID_RATE');
    perUnitTiers = canonical;
  }
  if (normalized.input === null || normalized.output === null) fail('INVALID_RATE');
  return { ...normalized, per_unit_tiers: perUnitTiers };
}

/**
 * Canonical digest material for the tier ladder: null (omitted) when the
 * version carries no tiers — the §4.1 anti-drift policy — and a
 * registry-ordered {tier → {num, den}} map when it does.
 */
export function perUnitTiersDigestMaterial(
  rates: RateSet,
): Record<string, { numeratorMinorUnits: string; denominatorUnits: string }> | null {
  if (rates.per_unit_tiers === null) return null;
  const material: Record<string, { numeratorMinorUnits: string; denominatorUnits: string }> = {};
  for (const tier of PER_UNIT_TIERS) {
    const rate = rates.per_unit_tiers[tier];
    if (rate === undefined) continue;
    material[tier] = {
      numeratorMinorUnits: rate.numeratorMinorUnits.toString(10),
      denominatorUnits: rate.denominatorUnits.toString(10),
    };
  }
  return material;
}

function normalizeNullableUsage(value: ExactIntegerInput | null): bigint | null {
  return value === null ? null : parseNonNegativeInteger(value, 'INVALID_INPUT');
}

export function normalizeUsage(input: TokenUsageInput): NormalizedTokenUsage {
  return {
    inputTotal: normalizeNullableUsage(input.inputTotal),
    inputUncached: normalizeNullableUsage(input.inputUncached),
    cacheRead: normalizeNullableUsage(input.cacheRead),
    cacheWrite: normalizeNullableUsage(input.cacheWrite),
    cacheWrite5m: normalizeNullableUsage(input.cacheWrite5m),
    cacheWrite1h: normalizeNullableUsage(input.cacheWrite1h),
    outputTotal: normalizeNullableUsage(input.outputTotal),
    reasoningOutput: normalizeNullableUsage(input.reasoningOutput),
    perUnitUnits:
      input.perUnitUnits === undefined || input.perUnitUnits === null
        ? null
        : parseNonNegativeInteger(input.perUnitUnits, 'INVALID_INPUT'),
    sizeTier: parsePerUnitTier(input.sizeTier),
  };
}

export function normalizeHoldInput(input: PriceHoldInput): NormalizedPriceHoldInput {
  const usage = normalizeUsage({
    inputTotal: input.inputTotal,
    inputUncached: input.inputUncached,
    cacheRead: input.cacheRead,
    cacheWrite: input.cacheWrite,
    cacheWrite5m: input.cacheWrite5m,
    cacheWrite1h: input.cacheWrite1h,
    outputTotal: input.outputTotal,
    reasoningOutput: input.reasoningOutput,
  });
  return {
    inputTotal: usage.inputTotal ?? fail('USAGE_INCOMPLETE'),
    inputUncached: usage.inputUncached ?? fail('USAGE_INCOMPLETE'),
    cacheRead: usage.cacheRead ?? fail('USAGE_INCOMPLETE'),
    cacheWrite: usage.cacheWrite ?? fail('USAGE_INCOMPLETE'),
    cacheWrite5m: usage.cacheWrite5m ?? fail('USAGE_INCOMPLETE'),
    cacheWrite1h: usage.cacheWrite1h ?? fail('USAGE_INCOMPLETE'),
    outputTotal: usage.outputTotal ?? fail('USAGE_INCOMPLETE'),
    reasoningOutput: usage.reasoningOutput ?? fail('USAGE_INCOMPLETE'),
    perUnitUnits:
      input.perUnitUnits === undefined || input.perUnitUnits === null
        ? 0n
        : parseNonNegativeInteger(input.perUnitUnits, 'INVALID_INPUT'),
    sizeTier: parsePerUnitTier(input.sizeTier),
  };
}

function roundRational(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === 'floor') return quotient;
  if (mode === 'ceil') return quotient + 1n;
  const doubled = remainder * 2n;
  if (mode === 'half_up') return quotient + (doubled >= denominator ? 1n : 0n);
  if (doubled > denominator) return quotient + 1n;
  if (doubled < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function pushTerm(
  accumulator: { numerator: bigint; denominator: bigint },
  chargedMetrics: PriceMetric[],
  metric: PriceMetric,
  count: bigint,
  rate: RationalRate | null,
): { numerator: bigint; denominator: bigint } {
  if (count === 0n) return accumulator;
  if (rate === null) fail('PRICE_RATE_MISSING');
  chargedMetrics.push(metric);
  return addRational(accumulator, multiplyRate(count, rate));
}

function scaleRate(rate: RationalRate, multiplier: RationalMultiplier): RationalRate {
  return {
    numeratorMinorUnits: rate.numeratorMinorUnits * multiplier.numerator,
    denominatorUnits: rate.denominatorUnits * multiplier.denominator,
  };
}

/**
 * Applies the effective multipliers to the rate set: the input family
 * (input + every cache bucket) takes the input multiplier, output takes the
 * output multiplier. Neutral 1/1 multipliers return the rates untouched, so a
 * multiplier-less calculation is byte-identical to the pre-4.1 arithmetic.
 */
function scaledRates(rates: RateSet, multipliers: EffectiveTokenMultipliers): RateSet {
  if (
    multipliers.input.numerator === multipliers.input.denominator &&
    multipliers.output.numerator === multipliers.output.denominator
  ) {
    return rates;
  }
  return {
    ...rates,
    input: rates.input === null ? null : scaleRate(rates.input, multipliers.input),
    cache_read: rates.cache_read === null ? null : scaleRate(rates.cache_read, multipliers.input),
    cache_write: rates.cache_write === null ? null : scaleRate(rates.cache_write, multipliers.input),
    cache_write_5m: rates.cache_write_5m === null ? null : scaleRate(rates.cache_write_5m, multipliers.input),
    cache_write_1h: rates.cache_write_1h === null ? null : scaleRate(rates.cache_write_1h, multipliers.input),
    output: rates.output === null ? null : scaleRate(rates.output, multipliers.output),
  };
}

export interface CalculatePriceOptions {
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary?: RoundingBoundary;
  readonly requireComplete?: boolean;
  /**
   * §4.1 optional token-path multipliers (service tier + long context).
   * Usually the price version's own policy; absent/null keeps multipliers off.
   */
  readonly tokenMultipliers?: Parameters<typeof normalizeTokenMultiplierPolicy>[0];
  /** Requested/observed service tiers; the only-lower rule applies. */
  readonly serviceTier?: { readonly requested: string | null; readonly observed: string | null } | null;
}

export function calculatePrice(
  ratesInput: RateSet | RateSetInput,
  usageInput: TokenUsageInput | NormalizedTokenUsage,
  options: CalculatePriceOptions,
): PriceCalculation {
  const rates = normalizeRates(ratesInput as RateSetInput);
  const usage = normalizeUsage(usageInput as TokenUsageInput);
  const roundingBoundary = options.roundingBoundary ?? TOTAL_ROUNDING_BOUNDARY;
  if (roundingBoundary !== TOTAL_ROUNDING_BOUNDARY) fail('INVALID_INPUT');

  const chargedMetrics: PriceMetric[] = [];
  const ignoredMetrics: Array<'inputTotal' | 'reasoningOutput'> = [];
  const unknownMetrics: string[] = [];
  let accumulator = { numerator: 0n, denominator: 1n };

  /*
   * §4.1 per-unit (media) mode: a non-null perUnitUnits makes the per-unit
   * term the primary billable dimension. Media transports report no token
   * counters at all, so a fully absent token-counter family is "not
   * applicable" (charged zero, complete) instead of "unknown". Mixed
   * per-unit + token work (e.g. video billed per second AND per token)
   * still bills both when the counters are present.
   */
  const perUnitMode = usage.perUnitUnits !== null;
  const tokenCountersAbsent =
    usage.inputTotal === null &&
    usage.inputUncached === null &&
    usage.cacheRead === null &&
    usage.cacheWrite === null &&
    usage.cacheWrite5m === null &&
    usage.cacheWrite1h === null &&
    usage.outputTotal === null &&
    usage.reasoningOutput === null;

  // Long context is keyed on the billed input tokens; 0 when no input is known.
  const billedInputTokens =
    usage.inputTotal ??
    (usage.inputUncached === null &&
    usage.cacheRead === null &&
    usage.cacheWrite === null &&
    usage.cacheWrite5m === null &&
    usage.cacheWrite1h === null
      ? null
      : (usage.inputUncached ?? 0n) +
        (usage.cacheRead ?? 0n) +
        (usage.cacheWrite ?? 0n) +
        (usage.cacheWrite5m ?? 0n) +
        (usage.cacheWrite1h ?? 0n));
  const multipliers = computeEffectiveTokenMultipliers({
    policy: normalizeTokenMultiplierPolicy(options.tokenMultipliers ?? null),
    billedInputTokens,
    requestedServiceTier: options.serviceTier?.requested ?? null,
    observedServiceTier: options.serviceTier?.observed ?? null,
  });
  const effectiveRates = scaledRates(rates, multipliers);

  if (perUnitMode && usage.perUnitUnits !== null && usage.perUnitUnits > 0n) {
    const tier = usage.sizeTier;
    const rate = tier === null ? effectiveRates.per_unit : (effectiveRates.per_unit_tiers?.[tier] ?? null);
    // Fail closed: units priced against a tier/rate the version does not
    // carry is a billing error, never a zero charge.
    if (rate === null) fail('PRICE_RATE_MISSING');
    accumulator = pushTerm(accumulator, chargedMetrics, 'per_unit', usage.perUnitUnits, rate);
  }

  if (!(perUnitMode && tokenCountersAbsent)) {
    const hasInputBreakdown =
      usage.inputUncached !== null ||
      usage.cacheRead !== null ||
      usage.cacheWrite !== null ||
      usage.cacheWrite5m !== null ||
      usage.cacheWrite1h !== null;
    if (hasInputBreakdown) {
      if (usage.inputTotal !== null) ignoredMetrics.push('inputTotal');
      if (usage.inputUncached === null) unknownMetrics.push('inputUncached');
      else accumulator = pushTerm(accumulator, chargedMetrics, 'input', usage.inputUncached, effectiveRates.input);
      if (usage.cacheRead === null) unknownMetrics.push('cacheRead');
      else
        accumulator = pushTerm(accumulator, chargedMetrics, 'cache_read', usage.cacheRead, effectiveRates.cache_read);

      const hasGenericWrite = usage.cacheWrite !== null && usage.cacheWrite > 0n;
      const hasTtlWrite =
        (usage.cacheWrite5m !== null && usage.cacheWrite5m > 0n) ||
        (usage.cacheWrite1h !== null && usage.cacheWrite1h > 0n);
      if (hasGenericWrite && hasTtlWrite) fail('INVALID_INPUT');
      if (hasGenericWrite) {
        accumulator = pushTerm(
          accumulator,
          chargedMetrics,
          'cache_write',
          usage.cacheWrite as bigint,
          effectiveRates.cache_write,
        );
      } else if (hasTtlWrite) {
        if (usage.cacheWrite5m === null) unknownMetrics.push('cacheWrite5m');
        else
          accumulator = pushTerm(
            accumulator,
            chargedMetrics,
            'cache_write_5m',
            usage.cacheWrite5m,
            effectiveRates.cache_write_5m,
          );
        if (usage.cacheWrite1h === null) unknownMetrics.push('cacheWrite1h');
        else
          accumulator = pushTerm(
            accumulator,
            chargedMetrics,
            'cache_write_1h',
            usage.cacheWrite1h,
            effectiveRates.cache_write_1h,
          );
      }
    } else if (usage.inputTotal === null) {
      unknownMetrics.push('inputTotal');
    } else {
      accumulator = pushTerm(accumulator, chargedMetrics, 'input', usage.inputTotal, effectiveRates.input);
    }

    if (usage.outputTotal === null) {
      unknownMetrics.push('outputTotal');
    } else {
      accumulator = pushTerm(accumulator, chargedMetrics, 'output', usage.outputTotal, effectiveRates.output);
    }

    if (usage.reasoningOutput !== null) {
      if (usage.outputTotal !== null && usage.reasoningOutput > usage.outputTotal) fail('INVALID_INPUT');
      ignoredMetrics.push('reasoningOutput');
    }
  }

  const complete = unknownMetrics.length === 0;
  if (!complete && options.requireComplete !== false) fail('USAGE_INCOMPLETE');
  const amountMinorUnits = roundRational(accumulator.numerator, accumulator.denominator, options.roundingMode);
  if (amountMinorUnits < 0n || amountMinorUnits > MAX_MINOR_UNITS) fail('PRICE_AMOUNT_OVERFLOW');
  return {
    amountMinorUnits,
    unroundedNumerator: accumulator.numerator,
    unroundedDenominator: accumulator.denominator,
    roundingMode: options.roundingMode,
    roundingBoundary,
    chargedMetrics,
    ignoredMetrics,
    unknownMetrics,
    complete,
  };
}

export function calculatePriceVersion(
  version: CommercialPriceVersionRecord,
  usage: TokenUsageInput | NormalizedTokenUsage,
  options: { readonly requireComplete?: boolean; readonly serviceTier?: CalculatePriceOptions['serviceTier'] } = {},
): PriceCalculation {
  return calculatePrice(version.rates, usage, {
    roundingMode: version.roundingMode,
    roundingBoundary: version.roundingBoundary,
    requireComplete: options.requireComplete,
    tokenMultipliers: version.tokenMultipliers ?? null,
    serviceTier: options.serviceTier ?? null,
  });
}

export function calculateUsageSettlement(input: {
  readonly customerPrice: CommercialPriceVersionRecord;
  readonly supplierCost: CommercialPriceVersionRecord;
  readonly usage: TokenUsageInput | NormalizedTokenUsage;
  readonly requireComplete?: boolean;
  readonly serviceTier?: CalculatePriceOptions['serviceTier'];
}): UsageSettlementCalculation {
  const customer = calculatePriceVersion(input.customerPrice, input.usage, {
    requireComplete: input.requireComplete,
    serviceTier: input.serviceTier,
  });
  const supplier = calculatePriceVersion(input.supplierCost, input.usage, {
    requireComplete: input.requireComplete,
    serviceTier: input.serviceTier,
  });
  return {
    customerPriceVersion: input.customerPrice.id,
    supplierCostVersion: input.supplierCost.id,
    customerCurrency: input.customerPrice.currency,
    supplierCurrency: input.supplierCost.currency,
    customer,
    supplier,
  };
}

export function priceHoldInputToUsage(input: NormalizedPriceHoldInput): NormalizedTokenUsage {
  return { ...input };
}
