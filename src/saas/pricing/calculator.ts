import { MAX_MINOR_UNITS } from '../billing/money.js';
import { SaasPricingError } from './errors.js';
import type {
  CommercialPriceVersionRecord,
  ExactIntegerInput,
  NormalizedPriceHoldInput,
  NormalizedTokenUsage,
  PriceCalculation,
  PriceHoldInput,
  PriceMetric,
  RateSet,
  RateSetInput,
  RationalRate,
  RoundingBoundary,
  RoundingMode,
  TokenUsageInput,
  UsageSettlementCalculation,
} from './types.js';

export const COMMERCIAL_CALCULATOR_VERSION = 'commercial-token-v1' as const;
export const TOTAL_ROUNDING_BOUNDARY: RoundingBoundary = 'total';

const PRICE_METRICS: readonly PriceMetric[] = [
  'input',
  'cache_read',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
];

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
    if (!(PRICE_METRICS as readonly string[]).includes(key)) fail('INVALID_RATE');
  }
  if (normalized.input === null || normalized.output === null) fail('INVALID_RATE');
  return normalized;
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
  };
}

export function normalizeHoldInput(input: PriceHoldInput): NormalizedPriceHoldInput {
  const usage = normalizeUsage({ ...input });
  return {
    inputTotal: usage.inputTotal ?? fail('USAGE_INCOMPLETE'),
    inputUncached: usage.inputUncached ?? fail('USAGE_INCOMPLETE'),
    cacheRead: usage.cacheRead ?? fail('USAGE_INCOMPLETE'),
    cacheWrite: usage.cacheWrite ?? fail('USAGE_INCOMPLETE'),
    cacheWrite5m: usage.cacheWrite5m ?? fail('USAGE_INCOMPLETE'),
    cacheWrite1h: usage.cacheWrite1h ?? fail('USAGE_INCOMPLETE'),
    outputTotal: usage.outputTotal ?? fail('USAGE_INCOMPLETE'),
    reasoningOutput: usage.reasoningOutput ?? fail('USAGE_INCOMPLETE'),
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

export interface CalculatePriceOptions {
  readonly roundingMode: RoundingMode;
  readonly roundingBoundary?: RoundingBoundary;
  readonly requireComplete?: boolean;
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

  const hasInputBreakdown =
    usage.inputUncached !== null ||
    usage.cacheRead !== null ||
    usage.cacheWrite !== null ||
    usage.cacheWrite5m !== null ||
    usage.cacheWrite1h !== null;
  if (hasInputBreakdown) {
    if (usage.inputTotal !== null) ignoredMetrics.push('inputTotal');
    if (usage.inputUncached === null) unknownMetrics.push('inputUncached');
    else accumulator = pushTerm(accumulator, chargedMetrics, 'input', usage.inputUncached, rates.input);
    if (usage.cacheRead === null) unknownMetrics.push('cacheRead');
    else accumulator = pushTerm(accumulator, chargedMetrics, 'cache_read', usage.cacheRead, rates.cache_read);

    const hasGenericWrite = usage.cacheWrite !== null && usage.cacheWrite > 0n;
    const hasTtlWrite =
      (usage.cacheWrite5m !== null && usage.cacheWrite5m > 0n) ||
      (usage.cacheWrite1h !== null && usage.cacheWrite1h > 0n);
    if (hasGenericWrite && hasTtlWrite) fail('INVALID_INPUT');
    if (hasGenericWrite) {
      accumulator = pushTerm(accumulator, chargedMetrics, 'cache_write', usage.cacheWrite as bigint, rates.cache_write);
    } else if (hasTtlWrite) {
      if (usage.cacheWrite5m === null) unknownMetrics.push('cacheWrite5m');
      else
        accumulator = pushTerm(accumulator, chargedMetrics, 'cache_write_5m', usage.cacheWrite5m, rates.cache_write_5m);
      if (usage.cacheWrite1h === null) unknownMetrics.push('cacheWrite1h');
      else
        accumulator = pushTerm(accumulator, chargedMetrics, 'cache_write_1h', usage.cacheWrite1h, rates.cache_write_1h);
    }
  } else if (usage.inputTotal === null) {
    unknownMetrics.push('inputTotal');
  } else {
    accumulator = pushTerm(accumulator, chargedMetrics, 'input', usage.inputTotal, rates.input);
  }

  if (usage.outputTotal === null) {
    unknownMetrics.push('outputTotal');
  } else {
    accumulator = pushTerm(accumulator, chargedMetrics, 'output', usage.outputTotal, rates.output);
  }

  if (usage.reasoningOutput !== null) {
    if (usage.outputTotal !== null && usage.reasoningOutput > usage.outputTotal) fail('INVALID_INPUT');
    ignoredMetrics.push('reasoningOutput');
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
  options: { readonly requireComplete?: boolean } = {},
): PriceCalculation {
  return calculatePrice(version.rates, usage, {
    roundingMode: version.roundingMode,
    roundingBoundary: version.roundingBoundary,
    requireComplete: options.requireComplete,
  });
}

export function calculateUsageSettlement(input: {
  readonly customerPrice: CommercialPriceVersionRecord;
  readonly supplierCost: CommercialPriceVersionRecord;
  readonly usage: TokenUsageInput | NormalizedTokenUsage;
  readonly requireComplete?: boolean;
}): UsageSettlementCalculation {
  const customer = calculatePriceVersion(input.customerPrice, input.usage, {
    requireComplete: input.requireComplete,
  });
  const supplier = calculatePriceVersion(input.supplierCost, input.usage, {
    requireComplete: input.requireComplete,
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
