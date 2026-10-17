/**
 * R5 Claude 429 quota-header classification (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5; port of sub2api's
 * ratelimit_service.go Anthropic window selection). Pure helpers over plain
 * header maps: the gateway transport feeds these the
 * `anthropic-ratelimit-unified-*` headers from every 429 (and any response
 * carrying window signal) and the scheduler consumes the resulting
 * rate-limit deadline and session window.
 *
 * Header vocabulary (window ∈ {5h, 7d, 7d_oi}):
 * - `anthropic-ratelimit-unified-{window}-status` — "rejected" marks the
 *   window as the one that tripped;
 * - `anthropic-ratelimit-unified-{window}-surpassed-threshold` — explicit
 *   exhaustion signal;
 * - `anthropic-ratelimit-unified-{window}-utilization` — fraction ≥ 1.0
 *   counts as exhausted;
 * - `anthropic-ratelimit-unified-{window}-reset` — unix seconds (milliseconds
 *   auto-detected) that must land inside (now, now + maxAge];
 * - `anthropic-ratelimit-unified-reset` — aggregated fallback deadline.
 *
 * Session window: [reset − 5h, reset], preferring the 5h reset header over
 * the aggregated deadline when both exist.
 */

/** 5h reset deadlines further than this from now are rejected as implausible. */
export const CLAUDE_WINDOW_5H_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 7d-family reset deadlines further than this from now are rejected. */
export const CLAUDE_WINDOW_7D_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
/** Configurable fallback cooldown for a 429 with no usable reset header. */
export const CLAUDE_429_FALLBACK_COOLDOWN_MS = 60_000;

export type ClaudeRateLimitWindow = '5h' | '7d' | '7d_sonnet' | '7d_oi';

/** Parsed per-window signal off the unified rate-limit headers. */
export interface ClaudeRateLimitWindowSnapshot {
  readonly window: ClaudeRateLimitWindow;
  readonly status: string | null;
  readonly utilization: number | null;
  readonly surpassedThreshold: boolean;
  /** Epoch milliseconds; null when absent or outside the plausibility window. */
  readonly resetAtMs: number | null;
  readonly exhausted: boolean;
  readonly rejected: boolean;
}

function headerValue(headers: Record<string, string>, name: string): string | null {
  const direct = headers?.[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function parseResetTimestampMs(raw: string | null, nowMs: number, maxAgeMs: number): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d{1,15}$/.test(trimmed)) return null;
  let seconds = Number(trimmed);
  if (seconds > 1e11) seconds = Math.floor(seconds / 1000);
  const resetAtMs = seconds * 1000;
  if (!Number.isSafeInteger(resetAtMs)) return null;
  if (resetAtMs <= nowMs || resetAtMs > nowMs + maxAgeMs) return null;
  return resetAtMs;
}

function windowMaxAgeMs(window: ClaudeRateLimitWindow): number {
  return window === '5h' ? CLAUDE_WINDOW_5H_MAX_AGE_MS : CLAUDE_WINDOW_7D_MAX_AGE_MS;
}

function isWindowRejected(headers: Record<string, string>, window: ClaudeRateLimitWindow): boolean {
  const status = headerValue(headers, `anthropic-ratelimit-unified-${window}-status`);
  return status !== null && status.trim().toLowerCase() === 'rejected';
}

function isWindowExceeded(headers: Record<string, string>, window: ClaudeRateLimitWindow): boolean {
  // surpassed-threshold first (most explicit), then utilization >= 1.0 with
  // an epsilon so 0.9999999... still counts.
  const surpassed = headerValue(headers, `anthropic-ratelimit-unified-${window}-surpassed-threshold`);
  if (surpassed !== null && surpassed.trim().toLowerCase() === 'true') return true;
  const utilization = headerValue(headers, `anthropic-ratelimit-unified-${window}-utilization`);
  if (utilization !== null) {
    const parsed = Number(utilization.trim());
    if (Number.isFinite(parsed) && parsed >= 1.0 - 1e-9) return true;
  }
  return false;
}

/** Parses one window's signal; utilization is echoed when parsable. */
export function parseClaudeRateLimitWindow(
  headers: Record<string, string>,
  window: ClaudeRateLimitWindow,
  nowMs: number,
): ClaudeRateLimitWindowSnapshot {
  const utilizationRaw = headerValue(headers, `anthropic-ratelimit-unified-${window}-utilization`);
  const utilization = utilizationRaw !== null && utilizationRaw.trim().length > 0 ? Number(utilizationRaw) : null;
  return {
    window,
    status: headerValue(headers, `anthropic-ratelimit-unified-${window}-status`),
    utilization: utilization !== null && Number.isFinite(utilization) ? utilization : null,
    surpassedThreshold: isWindowExceeded(headers, window),
    resetAtMs: parseResetTimestampMs(
      headerValue(headers, `anthropic-ratelimit-unified-${window}-reset`),
      nowMs,
      windowMaxAgeMs(window),
    ),
    exhausted: isWindowExceeded(headers, window),
    rejected: isWindowRejected(headers, window),
  };
}

/** All window labels the unified header family can carry. */
export const CLAUDE_QUOTA_WINDOW_LABELS: readonly ClaudeRateLimitWindow[] = ['5h', '7d', '7d_sonnet', '7d_oi'];

/** One window's observed quota facts, regardless of exhaustion. */
export interface ClaudeQuotaWindowSnapshot {
  readonly window: ClaudeRateLimitWindow;
  readonly status: string | null;
  /** Upstream-observed utilization fraction (0..1+); null when absent. */
  readonly utilization: number | null;
  readonly surpassedThreshold: boolean;
  /** Epoch milliseconds; null when absent or outside the plausibility window. */
  readonly resetAtMs: number | null;
}

/** The success-path quota snapshot the PG writer persists (per-window). */
export interface ClaudeQuotaSnapshot {
  readonly observedAtMs: number;
  /** Windows that carried at least one parsable signal, header order. */
  readonly windows: readonly ClaudeQuotaWindowSnapshot[];
}

/**
 * Parses the unified quota headers off ANY response (success included). Each
 * window label contributes when it carries a status, utilization or reset
 * signal; windows with no signal stay absent. The 5h session-window anchor
 * follows the reset: [reset − 5h, reset] (the sub2api UpdateSessionWindow
 * semantics; the writer persists it into the session-window columns).
 */
export function parseClaudeQuotaSnapshot(headers: Record<string, string>, nowMs: number): ClaudeQuotaSnapshot | null {
  const windows: ClaudeQuotaWindowSnapshot[] = [];
  for (const label of CLAUDE_QUOTA_WINDOW_LABELS) {
    const raw = parseClaudeRateLimitWindow(headers, label, nowMs);
    const hasSignal =
      raw.status !== null || raw.utilization !== null || raw.resetAtMs !== null || raw.surpassedThreshold;
    if (!hasSignal) continue;
    windows.push(raw);
  }
  if (windows.length === 0) return null;
  return { observedAtMs: nowMs, windows };
}

/** Session window [start, end] = [reset − 5h, reset] for a 5h reset anchor. */
export function claudeSessionWindowFromResetMs(resetAtMs: number): {
  readonly startMs: number;
  readonly endMs: number;
} {
  return { startMs: resetAtMs - 5 * 60 * 60 * 1000, endMs: resetAtMs };
}

/** The 429 classification outcome the scheduler persists. */
export interface ClaudeRateLimitClassification {
  /** Which window tripped ('7d' preferred over '5h' when both signal). */
  readonly window: ClaudeRateLimitWindow;
  /** The rate_limited_until deadline (epoch ms). */
  readonly resetAtMs: number;
  /** The 5h window reset when known; used for the session window anchor. */
  readonly fiveHourResetAtMs: number | null;
  /** Session window [start, end] = [reset − 5h, reset]. */
  readonly sessionWindowStartMs: number;
  readonly sessionWindowEndMs: number;
}

function selectExhaustedWindow(
  headers: Record<string, string>,
  nowMs: number,
): { readonly window: ClaudeRateLimitWindow; readonly resetAtMs: number } | null {
  const reset5h = parseResetTimestampMs(
    headerValue(headers, 'anthropic-ratelimit-unified-5h-reset'),
    nowMs,
    CLAUDE_WINDOW_5H_MAX_AGE_MS,
  );
  const reset7d = parseResetTimestampMs(
    headerValue(headers, 'anthropic-ratelimit-unified-7d-reset'),
    nowMs,
    CLAUDE_WINDOW_7D_MAX_AGE_MS,
  );
  const exceeded5h = isWindowRejected(headers, '5h') || isWindowExceeded(headers, '5h');
  const exceeded7d = isWindowExceeded(headers, '7d');
  if (exceeded7d && reset7d !== null) return { window: '7d', resetAtMs: reset7d };
  if (exceeded5h && reset5h !== null) return { window: '5h', resetAtMs: reset5h };
  return null;
}

/**
 * Classifies a 429 into the scheduling outcome. Selection order mirrors the
 * reference: the per-window headers first (7d over 5h), then the aggregated
 * `anthropic-ratelimit-unified-reset` fallback (up to a 366-day bound).
 * Returns null when nothing parsable exists — the caller then applies the
 * configurable short fallback cooldown instead of a window-long ban.
 */
export function classifyClaude429(
  headers: Record<string, string>,
  nowMs: number,
): ClaudeRateLimitClassification | null {
  const selected = selectExhaustedWindow(headers, nowMs);
  let resetAtMs: number | null = selected?.resetAtMs ?? null;
  if (resetAtMs === null) {
    resetAtMs = parseResetTimestampMs(
      headerValue(headers, 'anthropic-ratelimit-unified-reset'),
      nowMs,
      366 * 24 * 60 * 60 * 1000,
    );
  }
  if (resetAtMs === null) return null;
  const fiveHourResetAtMs = parseResetTimestampMs(
    headerValue(headers, 'anthropic-ratelimit-unified-5h-reset'),
    nowMs,
    CLAUDE_WINDOW_5H_MAX_AGE_MS,
  );
  const windowEndMs = fiveHourResetAtMs ?? resetAtMs;
  return {
    window: selected?.window ?? '5h',
    resetAtMs,
    fiveHourResetAtMs,
    sessionWindowStartMs: windowEndMs - 5 * 60 * 60 * 1000,
    sessionWindowEndMs: windowEndMs,
  };
}
