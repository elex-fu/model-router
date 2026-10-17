import { SaasBillingGroupsError } from './errors.js';
import { normalizeFractionMultiplier, normalizeRationalMultiplier, parsePeakWindowTime } from './multiplier.js';
import { parseModelPricingJson } from './override.js';
import type { BillingGroupModelPricingEntry, BillingGroupRecord, RationalMultiplier } from './types.js';

type Row = Record<string, unknown>;

function requiredText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
    throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  }
  return value;
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
    throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  }
  return value;
}

function requiredBoolean(row: Row, key: string): boolean {
  if (typeof row[key] !== 'boolean') throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  return row[key] as boolean;
}

function optionalBigint(row: Row, key: string): bigint | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value.trim())) return BigInt(value.trim());
  throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
}

function optionalMultiplier(row: Row, numKey: string, denKey: string): RationalMultiplier | null {
  const numerator = optionalBigint(row, numKey);
  const denominator = optionalBigint(row, denKey);
  if (numerator === null && denominator === null) return null;
  if (numerator === null || denominator === null) throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  return normalizeRationalMultiplier({ numerator, denominator });
}

/** Profit margins are non-negative fractions; multipliers proper are positive. */
function optionalMargin(row: Row, numKey: string, denKey: string): RationalMultiplier | null {
  const numerator = optionalBigint(row, numKey);
  const denominator = optionalBigint(row, denKey);
  if (numerator === null && denominator === null) return null;
  if (numerator === null || denominator === null) throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  return normalizeFractionMultiplier({ numerator, denominator });
}

function optionalLimit(row: Row, key: string): bigint | null {
  return optionalBigint(row, key);
}

function optionalStringArray(row: Row, key: string): readonly string[] | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  }
  return value as string[];
}

/**
 * Maps a `SELECT * FROM saas_billing_groups` row to the domain record. Every
 * shape violation fails closed with GROUP_STORAGE_ERROR; callers decide
 * whether that surfaces as a storage failure or an admission denial.
 */
export function mapBillingGroupRow(row: unknown): BillingGroupRecord {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  }
  const record = row as Row;
  const rateMultiplier = normalizeRationalMultiplier({
    numerator: optionalBigint(record, 'rate_multiplier_num'),
    denominator: optionalBigint(record, 'rate_multiplier_den'),
  });
  const topupMultiplier = normalizeRationalMultiplier({
    numerator: optionalBigint(record, 'topup_multiplier_num'),
    denominator: optionalBigint(record, 'topup_multiplier_den'),
  });
  const peakEnabled = requiredBoolean(record, 'peak_enabled');
  let peak = null;
  if (peakEnabled) {
    const peakStart = optionalText(record, 'peak_start');
    const peakEnd = optionalText(record, 'peak_end');
    const peakMultiplier = optionalMultiplier(record, 'peak_multiplier_num', 'peak_multiplier_den');
    if (peakStart === null || peakEnd === null || peakMultiplier === null) {
      throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
    }
    peak = {
      startSecondsUtc: parsePeakWindowTime(peakStart),
      endSecondsUtc: parsePeakWindowTime(peakEnd),
      multiplier: peakMultiplier,
    };
  }
  const profitMinMargin = optionalMargin(record, 'profit_min_margin_num', 'profit_min_margin_den');
  const profitSafetyBuffer = optionalMargin(record, 'profit_safety_buffer_num', 'profit_safety_buffer_den');
  if ((profitMinMargin === null) !== (profitSafetyBuffer === null)) {
    throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  }
  let modelPricing: ReadonlyMap<string, BillingGroupModelPricingEntry>;
  try {
    modelPricing = parseModelPricingJson(record.model_pricing);
  } catch {
    throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
  }
  return {
    id: requiredText(record, 'id'),
    displayName: requiredText(record, 'display_name'),
    rateMultiplier,
    topupMultiplier,
    peakEnabled,
    peak,
    modelPricing,
    rpmLimit: optionalLimitNumber(record),
    dailyLimitMinorUnits: optionalLimit(record, 'daily_limit_minor_units'),
    weeklyLimitMinorUnits: optionalLimit(record, 'weekly_limit_minor_units'),
    monthlyLimitMinorUnits: optionalLimit(record, 'monthly_limit_minor_units'),
    profitMinMargin,
    profitSafetyBuffer,
    claudeCodeOnly: requiredBoolean(record, 'claude_code_only'),
    fallbackGroupId: optionalText(record, 'fallback_group_id'),
    supportedModelScopes: optionalStringArray(record, 'supported_model_scopes'),
    composite: requiredBoolean(record, 'composite'),
    status: requiredText(record, 'status'),
  };
}

function optionalLimitNumber(row: Row): number | null {
  const value = row.rpm_limit;
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new SaasBillingGroupsError('GROUP_STORAGE_ERROR');
}
