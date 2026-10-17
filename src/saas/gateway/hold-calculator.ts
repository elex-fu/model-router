import { multiplyMinorUnits } from '../billing/groups/multiplier.js';
import type { RationalMultiplier } from '../billing/groups/types.js';
import { calculatePriceVersion, normalizeRates, normalizeUsage } from '../pricing/calculator.js';
import { SaasPricingError } from '../pricing/errors.js';
import type {
  CustomerPriceVersionRecord,
  ExactIntegerInput,
  PerUnitTier,
  PriceCalculation,
  PriceHoldInput,
  PriceMetric,
  RateSet,
  RateSetInput,
  RationalRate,
} from '../pricing/types.js';
import { PER_UNIT_TIERS } from '../pricing/types.js';

export const INPUT_BILLING_BUCKETS = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
] as const satisfies readonly PriceMetric[];

export type InputBillingBucket = (typeof INPUT_BILLING_BUCKETS)[number];

/**
 * Upper bounds and possible input billing categories supplied by a trusted
 * final-payload/provider-policy verifier. This calculator does not inspect
 * payloads or establish that the bounds or feasible categories are true; it
 * only calculates a conservative price from that verifier's envelope.
 */
export interface BillableUsageEnvelope {
  readonly inputUpperBound: ExactIntegerInput;
  readonly outputUpperBound: ExactIntegerInput;
  /** A unique, non-empty list describing the input billing categories that are feasible. */
  readonly feasibleInputBuckets: readonly InputBillingBucket[];
}

/**
 * §4.1 (roadmap batch 4) per-unit (media) hold envelope — a NEW branch, not
 * an extension of {@link BillableUsageEnvelope}: the token envelope's shape
 * (input/output upper bounds + one-of-five input bucket) has no room for a
 * unit count or a size tier, and media work (an image generation, a TTS
 * synthesis) has no token bounds to bound at all.
 *
 * `perUnitUnitsUpperBound` is the unit-count upper bound (images × n,
 * seconds, characters); `sizeTier` is the canonical tier selected by the
 * request, or null when the tier is not fixed at admission — the conservative
 * hold then prices against the MOST EXPENSIVE tier the version carries (the
 * token envelope's max-feasible-bucket principle, applied to tiers).
 * Token bounds are optional and allow mixed per-unit + token pricing.
 */
export interface PerUnitUsageEnvelope {
  readonly perUnitUnitsUpperBound: ExactIntegerInput;
  readonly sizeTier: PerUnitTier | string | null;
  readonly inputUpperBound?: ExactIntegerInput;
  readonly outputUpperBound?: ExactIntegerInput;
}

export type ConservativeHoldEnvelope = BillableUsageEnvelope | PerUnitUsageEnvelope;

export interface ConservativePriceHold {
  /** A valid PriceHoldInput witness with the full output bound and one input allocation. */
  readonly witness: PriceHoldInput;
  /** The input metric assigned the entire input upper bound in the witness. */
  readonly selectedInputMetric: InputBillingBucket | null;
  /** §4.1: the per-unit rate family selected for the media witness, when the envelope is media. */
  readonly selectedPerUnitRate: { readonly flat: boolean; readonly tier: PerUnitTier | null } | null;
  readonly inputUpperBound: bigint;
  readonly outputUpperBound: bigint;
  readonly perUnitUnitsUpperBound: bigint;
  readonly calculation: PriceCalculation;
}

function fail(code: 'INVALID_INPUT' | 'PRICE_RATE_MISSING'): never {
  throw new SaasPricingError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedBounds(envelope: BillableUsageEnvelope): { input: bigint; output: bigint } {
  if (!isRecord(envelope)) fail('INVALID_INPUT');

  const inputBound = envelope.inputUpperBound;
  const outputBound = envelope.outputUpperBound;
  if (inputBound === null || inputBound === undefined || outputBound === null || outputBound === undefined) {
    fail('INVALID_INPUT');
  }

  const usage = normalizeUsage({
    inputTotal: inputBound as ExactIntegerInput,
    inputUncached: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: outputBound as ExactIntegerInput,
    reasoningOutput: null,
  });

  return {
    input: usage.inputTotal ?? fail('INVALID_INPUT'),
    output: usage.outputTotal ?? fail('INVALID_INPUT'),
  };
}

function normalizedBuckets(value: unknown): readonly InputBillingBucket[] {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_INPUT');

  const supplied = new Set<string>();
  for (const bucket of value as unknown[]) {
    if (typeof bucket !== 'string' || !(INPUT_BILLING_BUCKETS as readonly string[]).includes(bucket)) {
      fail('INVALID_INPUT');
    }
    if (supplied.has(bucket)) fail('INVALID_INPUT');
    supplied.add(bucket);
  }

  // Use declaration order for deterministic ties, regardless of envelope order.
  return INPUT_BILLING_BUCKETS.filter((bucket) => supplied.has(bucket));
}

function normalizedCustomerRates(version: CustomerPriceVersionRecord): RateSet {
  if (!isRecord(version) || version.kind !== 'customer' || !isRecord(version.rates)) fail('INVALID_INPUT');
  if (!['floor', 'ceil', 'half_up', 'half_even'].includes(String(version.roundingMode))) fail('INVALID_INPUT');
  if (version.roundingBoundary !== 'total') fail('INVALID_INPUT');
  return normalizeRates(version.rates as RateSetInput);
}

function isPerUnitEnvelope(envelope: ConservativeHoldEnvelope): envelope is PerUnitUsageEnvelope {
  return 'perUnitUnitsUpperBound' in envelope;
}

function compareRates(
  left: NonNullable<RateSet[InputBillingBucket]>,
  right: NonNullable<RateSet[InputBillingBucket]>,
): number {
  const leftScaled = left.numeratorMinorUnits * right.denominatorUnits;
  const rightScaled = right.numeratorMinorUnits * left.denominatorUnits;
  return leftScaled > rightScaled ? 1 : leftScaled < rightScaled ? -1 : 0;
}

function compareRationalRates(left: RationalRate, right: RationalRate): number {
  const leftScaled = left.numeratorMinorUnits * right.denominatorUnits;
  const rightScaled = right.numeratorMinorUnits * left.denominatorUnits;
  return leftScaled > rightScaled ? 1 : leftScaled < rightScaled ? -1 : 0;
}

function witnessFor(
  inputUpperBound: bigint,
  outputUpperBound: bigint,
  selectedInputMetric: InputBillingBucket,
): PriceHoldInput {
  return {
    inputTotal: inputUpperBound,
    inputUncached: selectedInputMetric === 'input' ? inputUpperBound : 0n,
    cacheRead: selectedInputMetric === 'cache_read' ? inputUpperBound : 0n,
    cacheWrite: selectedInputMetric === 'cache_write' ? inputUpperBound : 0n,
    cacheWrite5m: selectedInputMetric === 'cache_write_5m' ? inputUpperBound : 0n,
    cacheWrite1h: selectedInputMetric === 'cache_write_1h' ? inputUpperBound : 0n,
    outputTotal: outputUpperBound,
    // Reasoning is a subset of outputTotal. It is not added as another priced term.
    reasoningOutput: 0n,
  };
}

/**
 * Prices the maximum charge over every feasible allocation of the input
 * upper bound. Rates are non-negative, so assigning all input to the exact
 * highest-rate feasible bucket is maximal; total-boundary rounding is
 * monotone and the output term is constant across allocations.
 */
export function calculateConservativePriceHold(
  version: CustomerPriceVersionRecord,
  envelope: BillableUsageEnvelope,
): ConservativePriceHold;

/**
 * §4.1 media branch: prices the unit-count upper bound against the per-unit
 * rate family. When the tier is fixed, that tier's rate (or the flat rate
 * when the version carries no ladder) is the witness rate. When the tier is
 * NOT fixed, the conservative witness prices against the MOST EXPENSIVE of
 * the flat rate and every tier rate — rates are non-negative, so the max
 * rate times the unit bound dominates every tier the request could settle
 * on. Optional token bounds ride the witness unchanged.
 */
export function calculateConservativePriceHold(
  version: CustomerPriceVersionRecord,
  envelope: PerUnitUsageEnvelope,
): ConservativePriceHold;

export function calculateConservativePriceHold(
  version: CustomerPriceVersionRecord,
  envelope: ConservativeHoldEnvelope,
): ConservativePriceHold {
  const rates = normalizedCustomerRates(version);
  if (isPerUnitEnvelope(envelope)) {
    return conservativePerUnitHold(version, rates, envelope);
  }
  const bounds = normalizedBounds(envelope);
  const inputUpperBound = bounds.input;
  const outputUpperBound = bounds.output;
  const envelopeRecord = envelope as unknown as Record<string, unknown>;
  const feasibleInputBuckets = normalizedBuckets(envelopeRecord.feasibleInputBuckets);

  let selectedInputMetric = feasibleInputBuckets[0];
  if (selectedInputMetric === undefined) fail('INVALID_INPUT');

  if (inputUpperBound > 0n) {
    for (const bucket of feasibleInputBuckets) {
      if (rates[bucket] === null) fail('PRICE_RATE_MISSING');
      const rate = rates[bucket];
      const selectedRate = rates[selectedInputMetric];
      if (rate === null || selectedRate === null) fail('PRICE_RATE_MISSING');
      if (compareRates(rate, selectedRate) > 0) selectedInputMetric = bucket;
    }
  }

  const witness = witnessFor(inputUpperBound, outputUpperBound, selectedInputMetric);
  const calculation = calculatePriceVersion(version, witness);
  return {
    witness,
    selectedInputMetric,
    selectedPerUnitRate: null,
    inputUpperBound,
    outputUpperBound,
    perUnitUnitsUpperBound: 0n,
    calculation,
  };
}

function conservativePerUnitHold(
  version: CustomerPriceVersionRecord,
  rates: RateSet,
  envelope: PerUnitUsageEnvelope,
): ConservativePriceHold {
  const perUnitUsage = normalizeUsage({
    inputTotal: null,
    inputUncached: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: null,
    reasoningOutput: null,
    perUnitUnits: envelope.perUnitUnitsUpperBound,
    sizeTier: envelope.sizeTier ?? null,
  });
  const perUnitUnits = perUnitUsage.perUnitUnits ?? fail('INVALID_INPUT');
  const sizeTier = perUnitUsage.sizeTier;

  let selectedTier: PerUnitTier | null = null;
  let selectedRate: RationalRate | null;
  if (sizeTier !== null) {
    selectedTier = sizeTier;
    selectedRate = rates.per_unit_tiers?.[sizeTier] ?? rates.per_unit;
    if (selectedRate === null) fail('PRICE_RATE_MISSING');
  } else {
    // Tier unknown at admission: price against the most expensive family
    // member (flat per_unit vs every tier rate) — the conservative maximum.
    let best: RationalRate | null = rates.per_unit;
    for (const tier of PER_UNIT_TIERS) {
      const rate = rates.per_unit_tiers?.[tier];
      if (rate === undefined) continue;
      if (best === null || compareRationalRates(rate, best) > 0) {
        best = rate;
        selectedTier = tier;
      }
    }
    if (best === null) fail('PRICE_RATE_MISSING');
    selectedRate = best;
  }

  const tokenBounds = normalizeUsage({
    inputTotal: envelope.inputUpperBound ?? 0,
    inputUncached: null,
    cacheRead: null,
    cacheWrite: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    outputTotal: envelope.outputUpperBound ?? 0,
    reasoningOutput: null,
  });
  const witness: PriceHoldInput = {
    inputTotal: tokenBounds.inputTotal ?? fail('INVALID_INPUT'),
    inputUncached: tokenBounds.inputTotal ?? 0n,
    cacheRead: 0n,
    cacheWrite: 0n,
    cacheWrite5m: 0n,
    cacheWrite1h: 0n,
    outputTotal: tokenBounds.outputTotal ?? fail('INVALID_INPUT'),
    reasoningOutput: 0n,
    perUnitUnits,
    sizeTier: selectedTier,
  };
  const calculation = calculatePriceVersion(version, witness);
  return {
    witness,
    selectedInputMetric: null,
    selectedPerUnitRate: { flat: selectedTier === null, tier: selectedTier },
    inputUpperBound: tokenBounds.inputTotal ?? 0n,
    outputUpperBound: tokenBounds.outputTotal ?? 0n,
    perUnitUnitsUpperBound: perUnitUnits,
    calculation,
  };
}

/**
 * R1 billing-group outer multiplier: a pure wrapper over the conservative
 * hold. The internal selection logic is untouched; only the final amount is
 * multiplied by the exact rational group multiplier, rounding up so the hold
 * is never short of the worst-case group-adjusted charge.
 */
export function applyGroupMultiplierToHold(
  hold: ConservativePriceHold,
  groupMultiplier: RationalMultiplier,
): ConservativePriceHold {
  const amountMinorUnits = multiplyMinorUnits(hold.calculation.amountMinorUnits, groupMultiplier, 'ceil');
  return {
    ...hold,
    calculation: {
      ...hold.calculation,
      amountMinorUnits,
      unroundedNumerator: hold.calculation.unroundedNumerator * groupMultiplier.numerator,
      unroundedDenominator: hold.calculation.unroundedDenominator * groupMultiplier.denominator,
    },
  };
}
