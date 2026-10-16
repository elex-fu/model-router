/**
 * F4 Gemini usage snapshot (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b; port of sub2api's
 * service/gemini_quota.go semantics). Gemini has no per-account upstream
 * usage endpoint: sub2api aggregates its own request counts per model class
 * against the tier's RPD/RPM policy and resets the daily window at Pacific
 * midnight. This module holds the pure half of that computation:
 *
 * - `parseGeminiUsageMetadata` normalizes the usageMetadata object every
 *   Gemini response carries (promptTokenCount / candidatesTokenCount /
 *   thoughtsTokenCount / totalTokenCount);
 * - `geminiDailyWindowStart` / `geminiDailyResetAtMs` compute the
 *   America/Los_Angeles daily window (fixed -08:00 offset fallback when the
 *   IANA zone is unavailable in the runtime);
 * - `computeGeminiUsageProgress` folds per-model-class request counts into
 *   the scheduling snapshot the migration-111 columns persist. The snapshot
 *   is a scheduling signal only: it never enters the billing path and never
 *   authorizes a profit/cost failover decision (093/100 precedent).
 */

import { GEMINI_QUOTA_TIME_ZONE, type GeminiTierQuota } from './constants.js';
import { geminiModelClass } from './identity.js';

/** Normalized Gemini usageMetadata facts (all optional). */
export interface GeminiUsageMetadata {
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  /** Reasoning/thinking tokens (folded into the output side, sub2api parity). */
  readonly thoughtsTokens: number | null;
  /** Prompt tokens served from implicit context cache (inside promptTokenCount). */
  readonly cachedTokens: number | null;
  readonly totalTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Extracts the normalized usage facts from a Gemini `usageMetadata` object. */
export function parseGeminiUsageMetadata(value: unknown): GeminiUsageMetadata | null {
  if (!isRecord(value)) return null;
  const promptTokens = tokenCount(value.promptTokenCount);
  const outputTokens = tokenCount(value.candidatesTokenCount);
  const thoughtsTokens = tokenCount(value.thoughtsTokenCount);
  const cachedTokens = tokenCount(value.cachedContentTokenCount);
  const totalTokens = tokenCount(value.totalTokenCount);
  if (
    promptTokens === null &&
    outputTokens === null &&
    thoughtsTokens === null &&
    cachedTokens === null &&
    totalTokens === null
  ) {
    return null;
  }
  return { promptTokens, outputTokens, thoughtsTokens, cachedTokens, totalTokens };
}

/** Merges a later usageMetadata observation into an earlier one (last-wins per field). */
export function mergeGeminiUsageMetadata(
  previous: GeminiUsageMetadata | null,
  next: GeminiUsageMetadata,
): GeminiUsageMetadata {
  return {
    promptTokens: next.promptTokens ?? previous?.promptTokens ?? null,
    outputTokens: next.outputTokens ?? previous?.outputTokens ?? null,
    thoughtsTokens: next.thoughtsTokens ?? previous?.thoughtsTokens ?? null,
    cachedTokens: next.cachedTokens ?? previous?.cachedTokens ?? null,
    totalTokens: next.totalTokens ?? previous?.totalTokens ?? null,
  };
}

const PACIFIC_FIXED_OFFSET_MINUTES = -8 * 60;

function pacificTimeZoneMinutesOffset(nowMs: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: GEMINI_QUOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(nowMs));
  const get = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(nowMs / 1000) * 1000) / 60_000);
}

function pacificMidnight(nowMs: number): number {
  // Local Pacific wall-clock for `now`, decomposed via the Intl formatter,
  // then re-anchored at 00:00:00 local on the same calendar day.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: GEMINI_QUOTA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(nowMs));
  const get = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  const offsetMinutes = pacificTimeZoneMinutesOffset(nowMs);
  return Date.UTC(get('year'), get('month') - 1, get('day'), 0, 0, 0) - offsetMinutes * 60_000;
}

/**
 * Epoch milliseconds of the current daily window's Pacific-midnight start.
 * When the runtime lacks the IANA zone database this degrades to the fixed
 * PST offset (sub2api's own LoadLocation fallback), which can be off by an
 * hour on DST edges — acceptable for a scheduling signal.
 */
export function geminiDailyWindowStartMs(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return Number.NaN;
  try {
    return pacificMidnight(nowMs);
  } catch {
    const utcMidnight = Math.floor(nowMs / 86_400_000) * 86_400_000;
    return utcMidnight - PACIFIC_FIXED_OFFSET_MINUTES * 60_000;
  }
}

/** Epoch milliseconds of the next daily reset (the following Pacific midnight). */
export function geminiDailyResetAtMs(nowMs: number): number {
  const start = geminiDailyWindowStartMs(nowMs);
  let reset = start + 86_400_000;
  if (reset <= nowMs) reset += 86_400_000;
  return reset;
}

/** One usage window's progress as persisted in the scheduling snapshot. */
export interface GeminiUsageProgress {
  /** Requests consumed in the window; null when the window does not apply. */
  readonly used: number | null;
  /** The tier's window limit; -1 means unlimited; null when unknown. */
  readonly limit: number | null;
}

/** The scheduling snapshot computed from per-model-class request counts. */
export interface GeminiUsageSnapshot {
  readonly sharedDaily: GeminiUsageProgress | null;
  readonly proDaily: GeminiUsageProgress | null;
  readonly flashDaily: GeminiUsageProgress | null;
  readonly minute: GeminiUsageProgress | null;
  readonly dailyResetAtMs: number;
  readonly observedAtMs: number;
}

/**
 * Folds per-model request counts into the tier-shaped snapshot. `requests`
 * keys are model ids; `minuteRequests` is the rolling-minute total (the
 * caller's window). Shared-pool tiers (Google One / Code Assist) collapse
 * everything into `sharedDaily`; per-class tiers (AI Studio) split pro/flash
 * by model name. Unlimited (-1) limits pass through so the scheduler can
 * treat the window as never-exhausted.
 */
export function computeGeminiUsageSnapshot(input: {
  readonly requests: Readonly<Record<string, number>>;
  readonly minuteRequests: number;
  readonly tierQuota: GeminiTierQuota | null;
  readonly nowMs: number;
}): GeminiUsageSnapshot {
  let sharedUsed = 0;
  let proUsed = 0;
  let flashUsed = 0;
  for (const [model, count] of Object.entries(input.requests ?? {})) {
    const safeCount = typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
    sharedUsed += safeCount;
    if (geminiModelClass(model) === 'flash') flashUsed += safeCount;
    else proUsed += safeCount;
  }
  const quota = input.tierQuota;
  const sharedDaily: GeminiUsageProgress | null =
    quota !== null && quota.sharedRpd > 0 ? { used: sharedUsed, limit: quota.sharedRpd } : null;
  const perClass = quota !== null && quota.sharedRpd <= 0;
  const proDaily: GeminiUsageProgress | null = perClass ? { used: proUsed, limit: quota?.proRpd ?? null } : null;
  const flashDaily: GeminiUsageProgress | null = perClass ? { used: flashUsed, limit: quota?.flashRpd ?? null } : null;
  const minute: GeminiUsageProgress | null =
    quota === null
      ? { used: input.minuteRequests, limit: null }
      : quota.sharedRpm > 0
        ? { used: input.minuteRequests, limit: quota.sharedRpm }
        : {
            used: input.minuteRequests,
            limit: geminiMinuteLimitForClass(quota, input.requests),
          };
  return {
    sharedDaily,
    proDaily,
    flashDaily,
    minute,
    dailyResetAtMs: geminiDailyResetAtMs(input.nowMs),
    observedAtMs: input.nowMs,
  };
}

function geminiMinuteLimitForClass(quota: GeminiTierQuota, requests: Readonly<Record<string, number>>): number {
  // Per-class tiers apply the class limit of the class the current traffic
  // actually used; with mixed traffic the smaller limit wins (conservative).
  let sawFlash = false;
  let sawPro = false;
  for (const model of Object.keys(requests ?? {})) {
    if (geminiModelClass(model) === 'flash') sawFlash = true;
    else sawPro = true;
  }
  if (sawFlash && !sawPro) return quota.flashRpm;
  if (sawPro && !sawFlash) return quota.proRpm;
  return Math.min(quota.proRpm, quota.flashRpm);
}
