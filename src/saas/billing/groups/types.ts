import type { RateSet, RateSetInput } from '../../pricing/types.js';

/**
 * Exact rational multiplier (bigint numerator/denominator). Multiplier math in
 * this module is rational-only; floats never participate (red line: the
 * commercial billing kernel must be exactly reproducible).
 */
export interface RationalMultiplier {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** A configured peak surcharge window; times are seconds since UTC midnight. */
export interface BillingGroupPeakWindow {
  readonly startSecondsUtc: number;
  readonly endSecondsUtc: number;
  readonly multiplier: RationalMultiplier;
}

/** Parsed group-level per-model price override (sub2api `model_pricing`). */
export type BillingGroupModelPricingEntry = RateSetInput;

/** A billing group row mapped from PostgreSQL. */
export interface BillingGroupRecord {
  readonly id: string;
  readonly displayName: string;
  /** Outer billing multiplier applied on top of the resolved price version. */
  readonly rateMultiplier: RationalMultiplier;
  /** Independent topup (wallet funding) multiplier — the "second lever". */
  readonly topupMultiplier: RationalMultiplier;
  readonly peakEnabled: boolean;
  readonly peak: BillingGroupPeakWindow | null;
  /** Public model id -> override rate set. Highest pricing priority when present. */
  readonly modelPricing: ReadonlyMap<string, BillingGroupModelPricingEntry>;
  readonly rpmLimit: number | null;
  readonly dailyLimitMinorUnits: bigint | null;
  readonly weeklyLimitMinorUnits: bigint | null;
  readonly monthlyLimitMinorUnits: bigint | null;
  readonly profitMinMargin: RationalMultiplier | null;
  readonly profitSafetyBuffer: RationalMultiplier | null;
  readonly claudeCodeOnly: boolean;
  readonly fallbackGroupId: string | null;
  readonly supportedModelScopes: readonly string[] | null;
  readonly status: string;
}

/** Admission-time composition of the group billing multiplier. */
export interface ComposedGroupMultiplier {
  readonly multiplier: RationalMultiplier;
  readonly peakApplied: boolean;
}

/** The per-model override actually applied at admission, with its digest. */
export interface AppliedModelPricingOverride {
  readonly model: string;
  readonly rates: RateSet;
  readonly digest: string;
}

/** Billing-group terms frozen on an immutable customer price snapshot. */
export interface SnapshotBillingGroupTerms {
  readonly billingGroupId: string | null;
  readonly rateMultiplier: RationalMultiplier;
  readonly peakApplied: boolean;
  readonly modelPricingOverride: AppliedModelPricingOverride | null;
  /**
   * R1 enforcement terms (roadmap 1.3, migration 112). Null means no limit
   * was in force at admission (also the pre-112 snapshot shape); zero is
   * finite (blocks everything, the KEY-BUD semantics).
   */
  readonly rpmLimit: number | null;
  readonly dailyLimitMinorUnits: bigint | null;
  readonly weeklyLimitMinorUnits: bigint | null;
  readonly monthlyLimitMinorUnits: bigint | null;
  readonly supportedModelScopes: readonly string[] | null;
  readonly fallbackGroupId: string | null;
}

/** A control-plane writable billing group shape. */
export interface BillingGroupUpsertInput {
  readonly id: string;
  readonly displayName: string;
  readonly rateMultiplier: RationalMultiplier;
  readonly topupMultiplier: RationalMultiplier;
  readonly peakEnabled: boolean;
  readonly peakStart: string | null;
  readonly peakEnd: string | null;
  readonly peakMultiplier: RationalMultiplier | null;
  readonly modelPricing: Readonly<Record<string, BillingGroupModelPricingEntry>> | null;
  readonly rpmLimit: number | null;
  readonly dailyLimitMinorUnits: bigint | null;
  readonly weeklyLimitMinorUnits: bigint | null;
  readonly monthlyLimitMinorUnits: bigint | null;
  readonly profitMinMargin: RationalMultiplier | null;
  readonly profitSafetyBuffer: RationalMultiplier | null;
  readonly claudeCodeOnly: boolean;
  readonly fallbackGroupId: string | null;
  readonly supportedModelScopes: readonly string[] | null;
  readonly status: string;
}

/** Amount-tier topup discount: at or above the threshold, apply the multiplier. */
export interface TopupAmountTier {
  readonly thresholdMinorUnits: bigint;
  /** A discount multiplier no greater than one (e.g. 95/100 for 5% off). */
  readonly discountMultiplier: RationalMultiplier;
}

/** The applied topup conversion, recorded for auditability. */
export interface AppliedTopupConversion {
  readonly paidMinorUnits: bigint;
  readonly creditMinorUnits: bigint;
  readonly topupMultiplier: RationalMultiplier;
  readonly tierDiscount: RationalMultiplier | null;
}
