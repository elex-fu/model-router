/**
 * R1 billing-group spend windows (roadmap 1.3, phase 3): pure calendar
 * arithmetic for the group daily/weekly/monthly spend buckets and the API
 * key 5h/7d rolling windows. No SQL and no clock reads live here — callers
 * inject the timestamp — so every boundary is unit-testable.
 */

/** The group spend window kinds (migration 114). */
export type BillingGroupSpendWindowKind = 'daily' | 'weekly' | 'monthly';

/**
 * The UTC calendar bucket a timestamp falls into, as an ISO date string:
 * daily = UTC midnight, weekly = ISO week (Monday), monthly = UTC month
 * start. Dates (not timestamps) keep the counter primary key stable and
 * node-pg-safe (dates are read back as text, never parsed as local
 * midnights — the KEY-BUD day lesson).
 */
export function billingGroupSpendWindowStart(kind: BillingGroupSpendWindowKind, at: Date): string {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new TypeError('billing group spend window requires a valid timestamp');
  }
  const utcYear = at.getUTCFullYear();
  const utcMonth = at.getUTCMonth();
  const utcDate = at.getUTCDate();
  const iso = (year: number, month: number, day: number): string =>
    `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (kind === 'daily') return iso(utcYear, utcMonth, utcDate);
  if (kind === 'monthly') return iso(utcYear, utcMonth, 1);
  // weekly: ISO 8601 week — Monday-based, computed from the UTC day of week
  // (getUTCDay is Sunday=0; Monday=1..Saturday=6).
  const dayOfWeek = (at.getUTCDay() + 6) % 7;
  const monday = Date.UTC(utcYear, utcMonth, utcDate - dayOfWeek);
  const mondayDate = new Date(monday);
  return iso(mondayDate.getUTCFullYear(), mondayDate.getUTCMonth(), mondayDate.getUTCDate());
}

/**
 * The API key rolling-window cutoffs (sub2api RateLimitWindow5h/7d): the
 * earliest ISO timestamp whose reservations still count inside the trailing
 * window. A reservation created exactly at the cutoff is INSIDE the window
 * (strictly-greater comparisons in SQL must use `created_at >= cutoff`).
 */
export function keyBudgetRollingCutoffs(at: Date): { readonly fiveHour: string; readonly sevenDay: string } {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new TypeError('rolling window cutoffs require a valid timestamp');
  }
  const cutoff = (milliseconds: number): string => new Date(at.getTime() - milliseconds).toISOString();
  return { fiveHour: cutoff(5 * 60 * 60 * 1000), sevenDay: cutoff(7 * 24 * 60 * 60 * 1000) };
}
