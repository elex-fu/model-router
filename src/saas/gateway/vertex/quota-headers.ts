/**
 * Batch-3 Vertex 429 classification (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Vertex SA; port of
 * sub2api's Vertex branch in gemini_messages_compat_service.go
 * ParseGeminiRateLimitResetTime — google.rpc.RetryInfo retryDelay honored
 * with a 15-minute cap, no-reset fallback of one minute, and NO daily
 * Pacific-midnight reset because Vertex service accounts are pay-as-you-go
 * with short-window RPM/TPM throttles only). Pure helpers over plain header
 * maps and error bodies; the gateway transport feeds these the JSON error
 * body (and `retry-after` header) of every 429 and the scheduler consumes
 * the resulting rate-limit deadline.
 *
 * The Google JSON error-body parser and the RetryInfo duration parser are
 * shared with the F4 gemini package (the shapes are identical Google
 * errorDetails across the aiplatform and code-assist surfaces).
 */

import { parseGeminiErrorBody, parseGoogleRetryDelayMs } from '../gemini/quota-headers.js';
import {
  VERTEX_RATE_LIMIT_FALLBACK_MS,
  VERTEX_RATE_LIMIT_MAX_AHEAD_MS,
  VERTEX_RATE_LIMIT_RETRY_INFO_MAX_MS,
} from './constants.js';

/** The rate-limit status name the quota classifier keys on. */
export const VERTEX_RESOURCE_EXHAUSTED_STATUS = 'RESOURCE_EXHAUSTED';

/** The 429 classification outcome the scheduler persists. */
export interface VertexRateLimitClassification {
  /** Whether the error body carried RESOURCE_EXHAUSTED. */
  readonly resourceExhausted: boolean;
  /** The Google status name from the error body, when parsable. */
  readonly googleStatus: string | null;
  /** The rate_limited_until deadline (epoch ms). */
  readonly resetAtMs: number;
  /** Which signal produced the deadline. */
  readonly source: 'retry-after' | 'retry-info' | 'fallback';
}

function parseRetryAfterHeaderMs(raw: string | null | undefined, nowMs: number): number | null {
  if (raw === null || raw === undefined) return null;
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
 * Classifies a Vertex 429 into the scheduling outcome. Selection order:
 * an explicit `retry-after` header, then the google.rpc.RetryInfo
 * retryDelay from the error details (capped at 15 minutes so a hostile
 * value cannot park the account for hours), then the fixed one-minute
 * fallback (Vertex pay-as-you-go throttles are short windows; a longer
 * default would over-pause a per-token billing account). A deadline further
 * than `maxAheadMs` in the future is rejected as implausible and the next
 * signal is tried.
 */
export function classifyVertex429(
  input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string | null;
    readonly maxAheadMs?: number;
  },
  nowMs: number,
): VertexRateLimitClassification {
  const headers = input.headers ?? {};
  const maxAheadMs = input.maxAheadMs ?? VERTEX_RATE_LIMIT_MAX_AHEAD_MS;
  const parsed = input.bodyText === null ? null : parseGeminiErrorBody(input.bodyText);
  const resourceExhausted = parsed?.status?.trim().toUpperCase() === VERTEX_RESOURCE_EXHAUSTED_STATUS;

  const retryAfterMs = parseRetryAfterHeaderMs(headers['retry-after'] ?? null, nowMs);
  if (retryAfterMs !== null && retryAfterMs <= nowMs + maxAheadMs) {
    return {
      resourceExhausted,
      googleStatus: parsed?.status ?? null,
      resetAtMs: retryAfterMs,
      source: 'retry-after',
    };
  }
  const retryInfoMs = parsed === null ? null : parseGoogleRetryDelayMs(parsed.details);
  if (retryInfoMs !== null) {
    const cappedMs = Math.min(retryInfoMs, VERTEX_RATE_LIMIT_RETRY_INFO_MAX_MS);
    if (nowMs + cappedMs <= nowMs + maxAheadMs) {
      return {
        resourceExhausted,
        googleStatus: parsed?.status ?? null,
        resetAtMs: nowMs + cappedMs,
        source: 'retry-info',
      };
    }
  }
  return {
    resourceExhausted,
    googleStatus: parsed?.status ?? null,
    resetAtMs: nowMs + VERTEX_RATE_LIMIT_FALLBACK_MS,
    source: 'fallback',
  };
}

/**
 * Whether a 429's error body marks the account's quota as daily-exhausted.
 * Vertex has no daily quota (pay-as-you-go), so this is false unless the
 * message explicitly carries a per-day violation — a generic burst 429 must
 * never pause the account for a day.
 */
export function isVertexDailyQuotaExhaustion(bodyText: string | null): boolean {
  const parsed = bodyText === null ? null : parseGeminiErrorBody(bodyText);
  if (parsed === null) return false;
  if (parsed.status?.trim().toUpperCase() !== VERTEX_RESOURCE_EXHAUSTED_STATUS) return false;
  const message = parsed.message ?? '';
  return /per[_ ]day/i.test(message);
}
