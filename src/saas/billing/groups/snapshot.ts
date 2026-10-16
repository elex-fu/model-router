import type { CustomerPriceSnapshotRecord } from '../../pricing/types.js';
import { SaasBillingGroupsError } from './errors.js';
import { NEUTRAL_MULTIPLIER, normalizeRationalMultiplier } from './multiplier.js';
import { assertAppliedOverrideDigest, parseAppliedModelPricingOverride } from './override.js';
import type { SnapshotBillingGroupTerms } from './types.js';

/**
 * Billing-group terms frozen on an immutable customer price snapshot. Old
 * snapshots (created before billing groups existed) carry no group fields and
 * resolve to the neutral multiplier with no override, so their settlements
 * are byte-for-byte unchanged. The R1 enforcement terms (migration 112) are
 * absent on pre-112 snapshots and resolve to null (no limit in force).
 */
export function snapshotBillingGroupTerms(snapshot: CustomerPriceSnapshotRecord): SnapshotBillingGroupTerms {
  const billingGroupId = snapshot.billingGroupId ?? null;
  const rateMultiplier = snapshot.rateMultiplier
    ? normalizeRationalMultiplier(snapshot.rateMultiplier)
    : NEUTRAL_MULTIPLIER;
  const peakApplied = snapshot.peakApplied ?? false;
  const storedOverride = snapshot.modelPricingOverride;
  let modelPricingOverride: SnapshotBillingGroupTerms['modelPricingOverride'];
  if (storedOverride === null || storedOverride === undefined) {
    if (snapshot.modelPricingOverrideDigest != null) {
      // A digest without its stored rate set cannot be reconstructed; the
      // snapshot row is internally inconsistent and settlement fails closed.
      throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    }
    modelPricingOverride = null;
  } else {
    const override = parseAppliedModelPricingOverride(storedOverride);
    if (override === null) throw new SaasBillingGroupsError('INVALID_OVERRIDE');
    assertAppliedOverrideDigest(override, snapshot.modelPricingOverrideDigest ?? null);
    modelPricingOverride = override;
  }
  return {
    billingGroupId,
    rateMultiplier,
    peakApplied,
    modelPricingOverride,
    rpmLimit: snapshot.groupRpmLimit ?? null,
    dailyLimitMinorUnits: snapshot.groupDailyLimitMinorUnits ?? null,
    weeklyLimitMinorUnits: snapshot.groupWeeklyLimitMinorUnits ?? null,
    monthlyLimitMinorUnits: snapshot.groupMonthlyLimitMinorUnits ?? null,
    supportedModelScopes: snapshot.groupSupportedModelScopes ?? null,
    fallbackGroupId: snapshot.groupFallbackGroupId ?? null,
  };
}
