/**
 * Batch-3 Bedrock 429 / ThrottlingException classification (the
 * quota-headers analog of gemini's classifier; port of the retry-hint
 * halves of sub2api's bedrock retry handling). Pure helpers over plain
 * header maps and error bodies: the transport feeds these every
 * ThrottlingException (429 or the 400 spelling) and the scheduler
 * consumes the resulting cooldown deadline (the migration-117
 * bedrock_rate_limited_until column).
 *
 * Bedrock surfaces no quota windows in its responses — there are no
 * x-ratelimit headers and the only observable scheduling signal is the
 * ThrottlingException itself. The cooldown selection order mirrors the
 * gemini classifier: an explicit `retry-after` header first (seconds or
 * HTTP-date), then the AWS `Retry-After` modeled hint inside the error
 * body's details, then the fixed default cooldown.
 */

import { BEDROCK_DEFAULT_RATE_LIMIT_COOLDOWN_MS, BEDROCK_RATE_LIMIT_MAX_AHEAD_MS } from './constants.js';
import { parseAwsErrorBody } from './health.js';

/** The classification outcome the scheduler persists. */
export interface BedrockRateLimitClassification {
  /** Whether the body was AWS-shaped and named a throttling exception. */
  readonly throttlingException: boolean;
  /** The bare AWS exception type name, when parsable. */
  readonly exceptionType: string | null;
  /** The bedrock_rate_limited_until deadline (epoch ms). */
  readonly resetAtMs: number;
  /** Which signal produced the deadline. */
  readonly source: 'retry-after' | 'modeled-hint' | 'default-cooldown';
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
 * The modeled retry hint inside an AWS error body (the `details` array of
 * a ThrottlingException carries `{"RetryAfterSeconds": n}`).
 */
function parseModeledRetryAfterMs(bodyText: string | null): number | null {
  const parsed = parseAwsErrorBody(bodyText);
  if (parsed === null) return null;
  let details: unknown = null;
  try {
    const full = JSON.parse(bodyText ?? '');
    if (typeof full === 'object' && full !== null && !Array.isArray(full)) {
      details = (full as Record<string, unknown>).details;
    }
  } catch {
    return null;
  }
  if (!Array.isArray(details)) return null;
  for (const detail of details) {
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) continue;
    const seconds = (detail as Record<string, unknown>).RetryAfterSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
    const ms = Math.round(seconds * 1_000);
    if (!Number.isSafeInteger(ms) || ms <= 0) continue;
    return ms;
  }
  return null;
}

/**
 * Classifies one throttling observation into the scheduling outcome. A
 * deadline further than `maxAheadMs` in the future is rejected as
 * implausible and the next signal is tried (the gemini precedent).
 */
export function classifyBedrockRateLimit(
  input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly bodyText: string | null;
    readonly maxAheadMs?: number;
  },
  nowMs: number,
): BedrockRateLimitClassification {
  const headers = input.headers ?? {};
  const maxAheadMs = input.maxAheadMs ?? BEDROCK_RATE_LIMIT_MAX_AHEAD_MS;
  const parsed = parseAwsErrorBody(input.bodyText);
  const throttlingException =
    parsed !== null && (parsed.type === 'ThrottlingException' || parsed.type === 'TooManyRequestsException');

  const retryAfterMs = parseRetryAfterHeaderMs(headers['retry-after'] ?? null, nowMs);
  if (retryAfterMs !== null && retryAfterMs <= nowMs + maxAheadMs) {
    return { throttlingException, exceptionType: parsed?.type ?? null, resetAtMs: retryAfterMs, source: 'retry-after' };
  }
  const modeledMs = parseModeledRetryAfterMs(input.bodyText);
  if (modeledMs !== null && nowMs + modeledMs <= nowMs + maxAheadMs) {
    return {
      throttlingException,
      exceptionType: parsed?.type ?? null,
      resetAtMs: nowMs + modeledMs,
      source: 'modeled-hint',
    };
  }
  return {
    throttlingException,
    exceptionType: parsed?.type ?? null,
    resetAtMs: nowMs + BEDROCK_DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    source: 'default-cooldown',
  };
}
