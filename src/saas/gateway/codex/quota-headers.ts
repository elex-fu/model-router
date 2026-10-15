/**
 * P1a Codex quota header parsing and scheduling gate (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4). Pure helpers over
 * plain header maps and snapshots; the gateway transport feeds these the
 * `x-codex-*` rate-limit headers from every upstream response (including
 * 429s) and the scheduler consults `classifyQuotaPause` before admitting an
 * account from the platform pool.
 *
 * Window semantics: the upstream labels one window `primary` and the other
 * `secondary`, but which is which varies. The normalization rule is
 * `window_minutes ≤ 360 ⇒ 5h window`; a primary wider than that is the 7d
 * window and the secondary is the 5h one.
 *
 * R5 step 1: the pause gate (`classifyQuotaPause`) now delegates to the
 * shared oauth-subscription/quota-pause.ts kernel; the codex flat snapshot
 * shape, the two-window thresholds and the two-hour staleness bound stay
 * pinned here so behavior is unchanged.
 */

import { classifyQuotaPauseWindows } from '../oauth-subscription/quota-pause.js';

/** Maximum window length (minutes) still considered the 5-hour bucket. */
export const CODEX_5H_WINDOW_MAX_MINUTES = 360;
/** A snapshot older than this stops gating scheduling; one probe is allowed instead. */
export const CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Parsed `x-codex-*` rate-limit headers after 5h/7d normalization. */
export interface CodexRateLimitSnapshot {
  readonly used5hPercent: number | null;
  readonly reset5hSeconds: number | null;
  readonly window5hMinutes: number | null;
  readonly used7dPercent: number | null;
  readonly reset7dSeconds: number | null;
  readonly window7dMinutes: number | null;
}

interface RawWindow {
  readonly usedPercent: number | null;
  readonly resetAfterSeconds: number | null;
  readonly windowMinutes: number | null;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers?.[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawWindow(headers: Record<string, string>, label: 'primary' | 'secondary'): RawWindow {
  return {
    usedPercent: parseNumber(headerValue(headers, `x-codex-${label}-used-percent`)),
    resetAfterSeconds: parseNumber(headerValue(headers, `x-codex-${label}-reset-after-seconds`)),
    windowMinutes: parseNumber(headerValue(headers, `x-codex-${label}-window-minutes`)),
  };
}

function isFiveHourWindow(window: RawWindow): boolean {
  return window.windowMinutes !== null && window.windowMinutes <= CODEX_5H_WINDOW_MAX_MINUTES;
}

/**
 * Parses and normalizes the Codex rate-limit headers. Returns `null` when
 * neither window carries any parsable signal. Fields for an absent window
 * stay `null` (a 429 may only advertise the exhausted window). When both
 * windows are present, `window_minutes ≤ 360` identifies the 5h bucket;
 * otherwise the labels are swapped so `*5h*`/`*7d*` always mean what they
 * say.
 */
export function parseCodexRateLimitHeaders(headers: Record<string, string>): CodexRateLimitSnapshot | null {
  const primary = parseRawWindow(headers, 'primary');
  const secondary = parseRawWindow(headers, 'secondary');
  const primaryHasSignal =
    primary.usedPercent !== null || primary.resetAfterSeconds !== null || primary.windowMinutes !== null;
  const secondaryHasSignal =
    secondary.usedPercent !== null || secondary.resetAfterSeconds !== null || secondary.windowMinutes !== null;
  if (!primaryHasSignal && !secondaryHasSignal) return null;

  if (!secondaryHasSignal) {
    return isFiveHourWindow(primary)
      ? {
          used5hPercent: primary.usedPercent,
          reset5hSeconds: primary.resetAfterSeconds,
          window5hMinutes: primary.windowMinutes,
          used7dPercent: null,
          reset7dSeconds: null,
          window7dMinutes: null,
        }
      : {
          used5hPercent: null,
          reset5hSeconds: null,
          window5hMinutes: null,
          used7dPercent: primary.usedPercent,
          reset7dSeconds: primary.resetAfterSeconds,
          window7dMinutes: primary.windowMinutes,
        };
  }
  if (!primaryHasSignal) {
    return isFiveHourWindow(secondary)
      ? {
          used5hPercent: secondary.usedPercent,
          reset5hSeconds: secondary.resetAfterSeconds,
          window5hMinutes: secondary.windowMinutes,
          used7dPercent: null,
          reset7dSeconds: null,
          window7dMinutes: null,
        }
      : {
          used5hPercent: null,
          reset5hSeconds: null,
          window5hMinutes: null,
          used7dPercent: secondary.usedPercent,
          reset7dSeconds: secondary.resetAfterSeconds,
          window7dMinutes: secondary.windowMinutes,
        };
  }

  const [fiveHour, sevenDay] = isFiveHourWindow(primary) ? [primary, secondary] : [secondary, primary];
  return {
    used5hPercent: fiveHour.usedPercent,
    reset5hSeconds: fiveHour.resetAfterSeconds,
    window5hMinutes: fiveHour.windowMinutes,
    used7dPercent: sevenDay.usedPercent,
    reset7dSeconds: sevenDay.resetAfterSeconds,
    window7dMinutes: sevenDay.windowMinutes,
  };
}

/** Scheduler-side view of one account's persisted quota snapshot. */
export interface QuotaPauseSnapshot {
  readonly used5hPercent: number | null;
  /** Epoch milliseconds when the 5h window resets; `null` when unknown. */
  readonly reset5hAtMs: number | null;
  readonly used7dPercent: number | null;
  /** Epoch milliseconds when the 7d window resets; `null` when unknown. */
  readonly reset7dAtMs: number | null;
  /** Epoch milliseconds when the snapshot was last refreshed from upstream headers. */
  readonly observedAtMs: number;
}

/** Per-account auto-pause thresholds (percent used). */
export interface QuotaPauseThresholds {
  readonly pause5hUsedPercent: number;
  readonly pause7dUsedPercent: number;
}

export type QuotaPauseDecision = 'paused' | 'active' | 'probe-allowed';

/**
 * Scheduling gate over a persisted quota snapshot (shared
 * oauth-subscription/quota-pause.ts semantics, codex window family):
 *
 * - a snapshot older than two hours no longer gates — it returns
 *   `probe-allowed` so the scheduler may admit exactly one self-healing
 *   probe (the caller enforces the "one" part);
 * - a window at or above its threshold pauses the account, unless its reset
 *   deadline has already passed;
 * - otherwise the account is `active`.
 */
export function classifyQuotaPause(
  snapshot: QuotaPauseSnapshot,
  thresholds: QuotaPauseThresholds,
  nowMs: number,
): QuotaPauseDecision {
  return classifyQuotaPauseWindows(
    {
      observedAtMs: snapshot.observedAtMs,
      windows: [
        { usedPercent: snapshot.used5hPercent, resetAtMs: snapshot.reset5hAtMs },
        { usedPercent: snapshot.used7dPercent, resetAtMs: snapshot.reset7dAtMs },
      ],
    },
    [thresholds.pause5hUsedPercent, thresholds.pause7dUsedPercent],
    nowMs,
    CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS,
  );
}
