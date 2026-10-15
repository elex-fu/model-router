import type { RoundingMode } from '../../pricing/types.js';
import { MAX_MINOR_UNITS } from '../money.js';
import { SaasBillingGroupsError } from './errors.js';
import type {
  AppliedTopupConversion,
  BillingGroupRecord,
  ComposedGroupMultiplier,
  RationalMultiplier,
  TopupAmountTier,
} from './types.js';

/** Settings key that will hold the amount-tier topup discount table. */
export const TOPUP_AMOUNT_TIER_DISCOUNTS_SETTINGS_KEY = 'saas.payments.topup.amount_tier_discounts' as const;

export const NEUTRAL_MULTIPLIER: RationalMultiplier = { numerator: 1n, denominator: 1n };

export function gcdBigInt(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}

/** Parses a positive bigint (numerator may be zero only when allowZero). */
export function parseMultiplierPart(value: unknown, allowZero = false): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim()) && value.trim().length <= 30) {
    parsed = BigInt(value.trim());
  } else {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  if (parsed < 0n || parsed > MAX_MINOR_UNITS || (!allowZero && parsed === 0n)) {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  return parsed;
}

/** A strictly positive rational multiplier (the only valid multiplier shape). */
export function normalizeRationalMultiplier(value: unknown): RationalMultiplier {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  return {
    numerator: parseMultiplierPart(candidate.numerator),
    denominator: parseMultiplierPart(candidate.denominator),
  };
}

/** A non-negative fraction (profit margins may be zero, denominators may not). */
export function normalizeFractionMultiplier(value: unknown): RationalMultiplier {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  return {
    numerator: parseMultiplierPart(candidate.numerator, true),
    denominator: parseMultiplierPart(candidate.denominator),
  };
}

/** Exact rational multiplication with reduction; inputs must be positive. */
export function multiplyRational(left: RationalMultiplier, right: RationalMultiplier): RationalMultiplier {
  if (left.numerator <= 0n || left.denominator <= 0n || right.numerator <= 0n || right.denominator <= 0n) {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  const numerator = left.numerator * right.numerator;
  const denominator = left.denominator * right.denominator;
  const reduction = gcdBigInt(numerator, denominator);
  return { numerator: numerator / reduction, denominator: denominator / reduction };
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

/**
 * Outer rational multiply of a minor-units amount. Holds round with 'ceil'
 * (never under-hold); settlements use the price version's rounding mode.
 */
export function multiplyMinorUnits(
  amountMinorUnits: bigint,
  multiplier: RationalMultiplier,
  mode: RoundingMode,
): bigint {
  if (amountMinorUnits < 0n || multiplier.numerator <= 0n || multiplier.denominator <= 0n) {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  const numerator = amountMinorUnits * multiplier.numerator;
  const denominator = multiplier.denominator;
  const amount = roundRational(numerator, denominator, mode);
  if (amount < 0n || amount > MAX_MINOR_UNITS) throw new SaasBillingGroupsError('AMOUNT_OVERFLOW');
  return amount;
}

function parseClockSeconds(value: unknown): number {
  if (typeof value !== 'string') throw new SaasBillingGroupsError('INVALID_INPUT');
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
  if (!match) throw new SaasBillingGroupsError('INVALID_INPUT');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 24 || minutes > 59 || seconds > 59) throw new SaasBillingGroupsError('INVALID_INPUT');
  return hours * 3600 + minutes * 60 + seconds;
}

export function parsePeakWindowTime(value: unknown): number {
  return parseClockSeconds(value);
}

function utcSecondsOfDay(at: Date): number {
  return at.getUTCHours() * 3600 + at.getUTCMinutes() * 60 + at.getUTCSeconds();
}

/**
 * Half-open [start, end) peak window in UTC. When start > end the window
 * wraps midnight (peak from start to end the next day); start === end is an
 * empty window and never applies (conservative: no surcharge).
 */
export function isWithinPeakWindow(at: Date, startSecondsUtc: number, endSecondsUtc: number): boolean {
  const seconds = utcSecondsOfDay(at);
  if (startSecondsUtc === endSecondsUtc) return false;
  if (startSecondsUtc < endSecondsUtc) {
    return seconds >= startSecondsUtc && seconds < endSecondsUtc;
  }
  return seconds >= startSecondsUtc || seconds < endSecondsUtc;
}

/**
 * Group resolution fallback chain: the key's explicit group, then the tenant
 * default, then the seeded 'default' group.
 */
export function resolveBillingGroupId(
  keyBillingGroupId: string | null | undefined,
  tenantDefaultBillingGroupId: string | null | undefined,
): string {
  if (typeof keyBillingGroupId === 'string' && keyBillingGroupId.trim().length > 0) return keyBillingGroupId;
  if (typeof tenantDefaultBillingGroupId === 'string' && tenantDefaultBillingGroupId.trim().length > 0) {
    return tenantDefaultBillingGroupId;
  }
  return 'default';
}

/**
 * Effective billing multiplier = group.rate_multiplier × peak_multiplier when
 * the request time falls inside the peak window. Computed once at admission
 * and frozen on the price snapshot; never recomputed at settlement.
 */
export function composeGroupMultiplier(group: BillingGroupRecord, at: Date): ComposedGroupMultiplier {
  if (group.peakEnabled && group.peak !== null) {
    if (isWithinPeakWindow(at, group.peak.startSecondsUtc, group.peak.endSecondsUtc)) {
      return { multiplier: multiplyRational(group.rateMultiplier, group.peak.multiplier), peakApplied: true };
    }
  }
  return { multiplier: group.rateMultiplier, peakApplied: false };
}

/**
 * sub2api profit_control rule (plan §R1): refuse when the customer charge is
 * at or below supplierCost × (1 − minMargin − safetyBuffer). Both margins are
 * rational fractions of the supplier cost. All arithmetic is exact.
 */
export function evaluateProfitControl(input: {
  readonly customerChargeMinorUnits: bigint;
  readonly supplierCostMinorUnits: bigint;
  readonly minMargin: RationalMultiplier;
  readonly safetyBuffer: RationalMultiplier;
}): { readonly allowed: boolean } {
  if (input.customerChargeMinorUnits < 0n || input.supplierCostMinorUnits < 0n) {
    throw new SaasBillingGroupsError('INVALID_INPUT');
  }
  if (input.minMargin.numerator < 0n || input.minMargin.denominator <= 0n) {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  if (input.safetyBuffer.numerator < 0n || input.safetyBuffer.denominator <= 0n) {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  // threshold = cost × (1 − margin − buffer), computed over one common denominator.
  const commonDen = input.minMargin.denominator * input.safetyBuffer.denominator;
  const oneScaled = commonDen;
  const marginScaled = input.minMargin.numerator * input.safetyBuffer.denominator;
  const bufferScaled = input.safetyBuffer.numerator * input.minMargin.denominator;
  const factorNumerator = oneScaled - marginScaled - bufferScaled;
  if (factorNumerator <= 0n) return { allowed: true };
  // customerCharge > cost × factorNumerator / commonDen
  const leftScaled = input.customerChargeMinorUnits * commonDen;
  const rightScaled = input.supplierCostMinorUnits * factorNumerator;
  return { allowed: leftScaled > rightScaled };
}

/**
 * Parses the amount-tier discount settings value. Expected JSON shape:
 * `[{ "thresholdMinorUnits": "100000", "discountNumerator": 95, "discountDenominator": 100 }]`.
 * Tiers must have positive thresholds and multipliers no greater than one;
 * the result is sorted by ascending threshold.
 */
export function parseTopupAmountTierDiscounts(value: unknown): readonly TopupAmountTier[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    try {
      return parseTopupAmountTierDiscounts(JSON.parse(value));
    } catch {
      throw new SaasBillingGroupsError('INVALID_INPUT');
    }
  }
  if (!Array.isArray(value)) throw new SaasBillingGroupsError('INVALID_INPUT');
  const tiers: TopupAmountTier[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') throw new SaasBillingGroupsError('INVALID_INPUT');
    const candidate = entry as Record<string, unknown>;
    const threshold = parseTierThreshold(candidate.thresholdMinorUnits);
    const discount = normalizeRationalMultiplier({
      numerator: candidate.discountNumerator,
      denominator: candidate.discountDenominator,
    });
    if (discount.numerator > discount.denominator || discount.numerator === 0n) {
      throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
    }
    if (tiers.some((tier) => tier.thresholdMinorUnits === threshold)) {
      throw new SaasBillingGroupsError('INVALID_INPUT');
    }
    tiers.push({ thresholdMinorUnits: threshold, discountMultiplier: discount });
  }
  tiers.sort((left, right) => (left.thresholdMinorUnits < right.thresholdMinorUnits ? -1 : 1));
  return tiers;
}

function parseTierThreshold(value: unknown): bigint {
  let parsed: bigint;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    parsed = BigInt(value);
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim()) && value.trim().length <= 30) {
    parsed = BigInt(value.trim());
  } else {
    throw new SaasBillingGroupsError('INVALID_INPUT');
  }
  if (parsed <= 0n) throw new SaasBillingGroupsError('INVALID_INPUT');
  return parsed;
}

function selectTopupTier(paidMinorUnits: bigint, tiers: readonly TopupAmountTier[]): TopupAmountTier | null {
  let selected: TopupAmountTier | null = null;
  for (const tier of tiers) {
    if (paidMinorUnits >= tier.thresholdMinorUnits) selected = tier;
  }
  return selected;
}

/**
 * Wallet credit conversion (new-api second lever): credit = paid ×
 * topup_multiplier × amount-tier discount, rounded down (the platform never
 * over-credits). With no tiers and a neutral multiplier this is the identity.
 */
export function computeTopupCredit(input: {
  readonly paidMinorUnits: bigint;
  readonly topupMultiplier: RationalMultiplier;
  readonly tiers?: readonly TopupAmountTier[];
}): AppliedTopupConversion {
  if (input.paidMinorUnits < 0n) throw new SaasBillingGroupsError('INVALID_INPUT');
  if (input.topupMultiplier.numerator <= 0n || input.topupMultiplier.denominator <= 0n) {
    throw new SaasBillingGroupsError('INVALID_MULTIPLIER');
  }
  const tier = selectTopupTier(input.paidMinorUnits, input.tiers ?? []);
  let credit = multiplyMinorUnits(input.paidMinorUnits, input.topupMultiplier, 'floor');
  if (tier) {
    credit = multiplyMinorUnits(credit, tier.discountMultiplier, 'floor');
  }
  return {
    paidMinorUnits: input.paidMinorUnits,
    creditMinorUnits: credit,
    topupMultiplier: input.topupMultiplier,
    tierDiscount: tier?.discountMultiplier ?? null,
  };
}
