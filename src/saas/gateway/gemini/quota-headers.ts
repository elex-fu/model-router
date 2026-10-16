/**
 * F4 Gemini 429 / quota-exhaustion classification (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b; port of sub2api's
 * service/gemini_response_signal.go and gemini_quota.go cooldown semantics).
 * Pure helpers over plain header maps and error bodies: the gateway transport
 * feeds these the JSON error body (and `retry-after` header) of every 429
 * and the scheduler consumes the resulting rate-limit deadline.
 *
 * Gemini surfaces its rate-limit signal in the JSON body, not headers:
 * `{"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": ...}}`
 * optionally carrying a `RetryInfo` retry delay. The cooldown is otherwise
 * the tier policy's fixed cooldown (5-30 minutes per tier), and the daily
 * window resets at Pacific midnight.
 */

import { GEMINI_RESOURCE_EXHAUSTED_STATUS, GEMINI_UNKNOWN_TIER_COOLDOWN_MS } from './constants.js';
import { type GeminiQuotaTierId, geminiTierCooldownMs } from './identity.js';
import { geminiDailyResetAtMs } from './quota-usage.js';

/** 429 retry deadlines further than this from now are rejected as implausible. */
export const GEMINI_RATE_LIMIT_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
/** The 429 classification outcome the scheduler persists. */
export interface GeminiRateLimitClassification {
  /** Whether the error body carried RESOURCE_EXHAUSTED. */
  readonly resourceExhausted: boolean;
  /** The Google status name from the error body, when parsable. */
  readonly googleStatus: string | null;
  /** The rate_limited_until deadline (epoch ms). */
  readonly resetAtMs: number;
  /** The next daily-window reset (epoch ms) the account waits for. */
  readonly dailyResetAtMs: number;
  /** Which signal produced the deadline. */
  readonly source: 'retry-after' | 'retry-info' | 'tier-cooldown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parses the Google JSON error body shape ({"error": {code, status, message}}). */
export function parseGeminiErrorBody(bodyText: string): {
  readonly code: number | null;
  readonly status: string | null;
  readonly message: string | null;
  readonly details: readonly unknown[];
} | null {
  if (typeof bodyText !== 'string' || bodyText.length === 0 || bodyText.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.error)) return null;
  const error = parsed.error;
  const code = typeof error.code === 'number' && Number.isFinite(error.code) ? Math.round(error.code) : null;
  const status = typeof error.status === 'string' && error.status.length > 0 ? error.status : null;
  const message = typeof error.message === 'string' ? error.message : null;
  const details = Array.isArray(error.details) ? error.details : [];
  if (code === null && status === null && message === null) return null;
  return { code, status, message, details };
}

/** RFC 3339 duration subset → milliseconds ("30s", "5m", "1h30m", "0.5s"). */
export function parseGoogleRetryDelayMs(details: readonly unknown[]): number | null {
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    if (detail['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo' && !('retryDelay' in detail)) continue;
    const raw = detail.retryDelay;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 32) continue;
    const match = /^(\d+(?:\.\d+)?)(s|m|h)$/.exec(raw.trim());
    if (match === null) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const multiplier = match[2] === 's' ? 1_000 : match[2] === 'm' ? 60_000 : 3_600_000;
    const ms = Math.round(value * multiplier);
    if (!Number.isSafeInteger(ms) || ms <= 0) continue;
    return ms;
  }
  return null;
}

function parseRetryAfterHeaderMs(raw: string | null, nowMs: number): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{1,10}$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
    return nowMs + seconds * 1_000;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= nowMs) return null;
  return parsed;
}

/**
 * Classifies a 429 into the scheduling outcome. Selection order mirrors the
 * reference semantics: an explicit `retry-after` header first, then the
 * RetryInfo delay from the error details, then the tier's fixed cooldown
 * (the unknown-tier default when the tier is not resolvable). A deadline
 * further than `maxAheadMs` in the future is rejected as implausible and the
 * next signal is tried.
 */
export function classifyGemini429(
  input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string | null;
    readonly tierId?: GeminiQuotaTierId | null;
    readonly maxAheadMs?: number;
  },
  nowMs: number,
): GeminiRateLimitClassification {
  const headers = input.headers ?? {};
  const maxAheadMs = input.maxAheadMs ?? GEMINI_RATE_LIMIT_MAX_AHEAD_MS;
  const parsed = input.bodyText === null ? null : parseGeminiErrorBody(input.bodyText);
  const resourceExhausted = parsed?.status?.trim().toUpperCase() === GEMINI_RESOURCE_EXHAUSTED_STATUS;
  const dailyResetAtMs = geminiDailyResetAtMs(nowMs);

  const retryAfterMs = parseRetryAfterHeaderMs(headers['retry-after'] ?? null, nowMs);
  if (retryAfterMs !== null && retryAfterMs <= nowMs + maxAheadMs) {
    return {
      resourceExhausted,
      googleStatus: parsed?.status ?? null,
      resetAtMs: retryAfterMs,
      dailyResetAtMs,
      source: 'retry-after',
    };
  }
  const retryInfoMs = parsed === null ? null : parseGoogleRetryDelayMs(parsed.details);
  if (retryInfoMs !== null && nowMs + retryInfoMs <= nowMs + maxAheadMs) {
    return {
      resourceExhausted,
      googleStatus: parsed?.status ?? null,
      resetAtMs: nowMs + retryInfoMs,
      dailyResetAtMs,
      source: 'retry-info',
    };
  }
  const tierCooldownMs =
    input.tierId === undefined
      ? GEMINI_UNKNOWN_TIER_COOLDOWN_MS
      : geminiTierCooldownMs(input.tierId ?? null, GEMINI_UNKNOWN_TIER_COOLDOWN_MS);
  return {
    resourceExhausted,
    googleStatus: parsed?.status ?? null,
    resetAtMs: nowMs + tierCooldownMs,
    dailyResetAtMs,
    source: 'tier-cooldown',
  };
}

/**
 * Whether a 429's error body marks the account's daily quota as exhausted
 * (RESOURCE_EXHAUSTED with a RATE_LIMIT_EXCEEDED reason or a GenerateContent
 * request-per-day violation). A generic burst 429 must not pause the account
 * for a whole day.
 */
export function isGeminiDailyQuotaExhaustion(bodyText: string | null): boolean {
  const parsed = bodyText === null ? null : parseGeminiErrorBody(bodyText);
  if (parsed === null) return false;
  if (parsed.status?.trim().toUpperCase() !== GEMINI_RESOURCE_EXHAUSTED_STATUS) return false;
  const message = parsed.message ?? '';
  return /RATE_LIMIT_EXCEEDED/i.test(message) || /per[_ ]day/i.test(message);
}
