/**
 * Shared OAuth-subscription quota-pause decision (R5 step 1, design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Extracted from the
 * codex package (gateway/codex/quota-headers.ts) and parameterized: providers
 * expose different usage-window families (codex 5h/7d; Claude
 * 5h/7d/7d_sonnet/7d_oi), different snapshot staleness bounds and different
 * auto-pause thresholds. The decision semantics are identical for every
 * family:
 *
 * - a snapshot older than the provider's staleness bound no longer gates — it
 *   returns `probe-allowed` so the scheduler may admit exactly one
 *   self-healing probe (the caller enforces the "one" part);
 * - a window at or above its threshold pauses the account, unless its reset
 *   deadline has already passed (a window whose reset deadline is in the past
 *   is stale by definition; trusting it would wedge the account for a whole
 *   window it never entered);
 * - otherwise the account is `active`.
 */

/** One provider usage window as persisted in a scheduling snapshot. */
export interface QuotaWindowPauseSnapshot {
  /** Percent (codex) or fraction (Claude) of the window consumed; null when unknown. */
  readonly usedPercent: number | null;
  /** Epoch milliseconds when the window resets; `null` when unknown. */
  readonly resetAtMs: number | null;
}

/** Scheduler-side view of one account's persisted quota snapshot. */
export interface QuotaPauseSnapshotInput {
  /** Epoch milliseconds when the snapshot was last refreshed from upstream. */
  readonly observedAtMs: number;
  readonly windows: readonly QuotaWindowPauseSnapshot[];
}

export type QuotaPauseDecision = 'paused' | 'active' | 'probe-allowed';

function windowTripsThreshold(
  usedPercent: number | null,
  resetAtMs: number | null,
  threshold: number,
  nowMs: number,
): boolean {
  if (usedPercent === null) return false;
  if (usedPercent < threshold) return false;
  if (resetAtMs !== null && resetAtMs <= nowMs) return false;
  return true;
}

/**
 * Scheduling gate over a persisted quota snapshot. `windowThresholds` holds
 * one auto-pause threshold per entry of `snapshot.windows` (percent or
 * fraction, matching the provider's `usedPercent` unit); a mismatched length
 * fails open to `active` only for the extra/missing windows and never throws.
 */
export function classifyQuotaPauseWindows(
  snapshot: QuotaPauseSnapshotInput,
  windowThresholds: readonly number[],
  nowMs: number,
  snapshotMaxAgeMs: number,
): QuotaPauseDecision {
  if (!Number.isFinite(snapshot?.observedAtMs)) return 'probe-allowed';
  if (nowMs - snapshot.observedAtMs > snapshotMaxAgeMs) return 'probe-allowed';
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  for (let index = 0; index < windows.length; index += 1) {
    const threshold = windowThresholds[index];
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) continue;
    const window = windows[index];
    if (windowTripsThreshold(window?.usedPercent ?? null, window?.resetAtMs ?? null, threshold, nowMs)) {
      return 'paused';
    }
  }
  return 'active';
}
