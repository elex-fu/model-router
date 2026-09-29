import { calculatePriceVersion, normalizeRates, normalizeUsage } from '../pricing/calculator.js';
import { SaasPricingError } from '../pricing/errors.js';
import type {
  CustomerPriceVersionRecord,
  ExactIntegerInput,
  PriceCalculation,
  PriceHoldInput,
  PriceMetric,
  RateSet,
  RateSetInput,
} from '../pricing/types.js';

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

export interface ConservativePriceHold {
  /** A valid PriceHoldInput witness with the full output bound and one input allocation. */
  readonly witness: PriceHoldInput;
  /** The input metric assigned the entire input upper bound in the witness. */
  readonly selectedInputMetric: InputBillingBucket;
  readonly inputUpperBound: bigint;
  readonly outputUpperBound: bigint;
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

function compareRates(
  left: NonNullable<RateSet[InputBillingBucket]>,
  right: NonNullable<RateSet[InputBillingBucket]>,
): number {
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
): ConservativePriceHold {
  const bounds = normalizedBounds(envelope);
  const inputUpperBound = bounds.input;
  const outputUpperBound = bounds.output;
  const envelopeRecord = envelope as unknown as Record<string, unknown>;
  const feasibleInputBuckets = normalizedBuckets(envelopeRecord.feasibleInputBuckets);
  const rates = normalizedCustomerRates(version);

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
    inputUpperBound,
    outputUpperBound,
    calculation,
  };
}
