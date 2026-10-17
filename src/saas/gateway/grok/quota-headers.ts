/**
 * Batch-3 Grok quota header parsing (sub2api backend/internal/pkg/xai
 * quota.go port). Pure helpers over plain header maps: the gateway transport
 * feeds these the `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
 * headers from every upstream response (including 429s), accepting both the
 * double-dash (`x-ratelimit-…`) and single-dash (`x-rate-limit-…`) variants,
 * plus the subscription-tier and entitlement header family. The parsed
 * snapshot lands on the migration-119 grok scheduling columns; it is a
 * point-in-time scheduling signal and never enters the billing path (the 093
 * quota-snapshot precedent).
 *
 * Reset disambiguation (the sub2api/xai parseResetHeader rule, mirrored after
 * the Kiro reset parser): xAI may express the reset as a millisecond epoch, a
 * second epoch, or a *relative* number of seconds until reset. Disambiguated
 * purely by magnitude so a relative "60" is never misread as 1970-01-01:
 * - value >= 1e12 → millisecond epoch (÷1000);
 * - value >= 1e9  → plausible unix-seconds epoch (>= 2001-09), kept as-is;
 * - otherwise     → relative seconds from now.
 */

/** ≥ 1e12: the value is a millisecond epoch. */
export const GROK_RESET_MILLISECONDS_EPOCH_FLOOR = 1_000_000_000_000;
/** ≥ 1e9: the value is a unix-seconds epoch (2001-09-09 or later). */
export const GROK_RESET_SECONDS_EPOCH_FLOOR = 1_000_000_000;

/** The two header-spelling families, in lookup priority order. */
const RATE_LIMIT_HEADER_PREFIXES = ['x-ratelimit', 'x-rate-limit'] as const;

const SUBSCRIPTION_TIER_HEADERS = [
  'xai-subscription-tier',
  'x-subscription-tier',
  'x-xai-subscription-tier',
  'x-xai-user-tier',
  'xai-user-tier',
  'xai-tier',
  'x-user-tier',
  'x-plan-tier',
  'x-subscription-plan',
] as const;

const ENTITLEMENT_STATUS_HEADERS = [
  'xai-entitlement-status',
  'x-entitlement-status',
  'x-xai-entitlement-status',
  'x-xai-user-entitlement-status',
  'x-user-entitlement-status',
] as const;

/** One parsed quota window (requests or tokens dimension). */
export interface GrokQuotaWindow {
  readonly limit: number | null;
  readonly remaining: number | null;
  /** Epoch milliseconds when the window resets; null when unparsable/absent. */
  readonly resetAtMs: number | null;
  /** (limit − remaining) / limit × 100 when both sides are known; else null. */
  readonly usedPercent: number | null;
}

/** The full parsed grok quota-header snapshot. */
export interface GrokQuotaHeaderSnapshot {
  readonly requests: GrokQuotaWindow | null;
  readonly tokens: GrokQuotaWindow | null;
  readonly retryAfterSeconds: number | null;
  readonly subscriptionTier: string | null;
  readonly entitlementStatus: string | null;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const direct = headers?.[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

/** First non-empty value among the names, in order. */
function firstHeader(headers: Readonly<Record<string, string>>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headerValue(headers, name);
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return null;
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || !/^-?\d{1,19}$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The reset disambiguation kernel (table-driven tested): numeric values are
 * classified by magnitude; RFC 3339 timestamps are also accepted because some
 * xAI surfaces emit them. Anything else is unparsable (null).
 */
export function parseGrokResetMs(raw: string | undefined, nowMs: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^-?\d{1,16}$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value)) return null;
    if (value >= GROK_RESET_MILLISECONDS_EPOCH_FLOOR) return Math.floor(value / 1000) * 1000;
    if (value >= GROK_RESET_SECONDS_EPOCH_FLOOR) return value * 1000;
    // Relative seconds from now; a negative value is clamped to "already reset".
    return nowMs + Math.max(0, value) * 1000;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** retry-after: integer seconds or an HTTP-date; clamped at zero. */
export function parseGrokRetryAfterSeconds(raw: string | undefined, nowMs: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((parsed - nowMs) / 1000)) : null;
}

function parseWindow(
  headers: Readonly<Record<string, string>>,
  dimension: 'requests' | 'tokens',
  nowMs: number,
): GrokQuotaWindow | null {
  let limit: number | null = null;
  let remaining: number | null = null;
  let resetAtMs: number | null = null;
  for (const prefix of RATE_LIMIT_HEADER_PREFIXES) {
    if (limit === null) limit = parseCount(headerValue(headers, `${prefix}-limit-${dimension}`));
    if (remaining === null) remaining = parseCount(headerValue(headers, `${prefix}-remaining-${dimension}`));
    if (resetAtMs === null) resetAtMs = parseGrokResetMs(headerValue(headers, `${prefix}-reset-${dimension}`), nowMs);
  }
  if (limit === null && remaining === null && resetAtMs === null) return null;
  const usedPercent =
    limit !== null && limit > 0 && remaining !== null && remaining >= 0
      ? Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100))
      : null;
  return { limit, remaining, resetAtMs, usedPercent };
}

/**
 * Parses the grok quota headers into the scheduling snapshot. Returns null
 * when no window and no tier/entitlement/retry signal is present.
 */
export function parseGrokQuotaHeaders(
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): GrokQuotaHeaderSnapshot | null {
  const requests = parseWindow(headers, 'requests', nowMs);
  const tokens = parseWindow(headers, 'tokens', nowMs);
  const retryAfterSeconds = parseGrokRetryAfterSeconds(headerValue(headers, 'retry-after'), nowMs);
  const subscriptionTier = firstHeader(headers, SUBSCRIPTION_TIER_HEADERS);
  const entitlementStatus = firstHeader(headers, ENTITLEMENT_STATUS_HEADERS);
  if (
    requests === null &&
    tokens === null &&
    retryAfterSeconds === null &&
    subscriptionTier === null &&
    entitlementStatus === null
  ) {
    return null;
  }
  return Object.freeze({
    requests,
    tokens,
    retryAfterSeconds,
    subscriptionTier,
    entitlementStatus,
  });
}

/**
 * The 5h-scheduling-signal projection of a parsed snapshot: the token window
 * is the primary grok scheduling window (rolling request/token allowance);
 * the requests window rides alongside for operators whose tier gates on
 * request count. Nulls mean "never observed" and keep scheduling on its
 * pre-grok behavior.
 */
export interface GrokSchedulingSnapshot {
  readonly used5hPercent: number | null;
  readonly reset5hAtMs: number | null;
  readonly requestsUsedPercent: number | null;
  readonly requestsResetAtMs: number | null;
  readonly retryAfterSeconds: number | null;
}

export function grokSchedulingSnapshotFromHeaders(snapshot: GrokQuotaHeaderSnapshot): GrokSchedulingSnapshot {
  return Object.freeze({
    used5hPercent: snapshot.tokens?.usedPercent ?? null,
    reset5hAtMs: snapshot.tokens?.resetAtMs ?? null,
    requestsUsedPercent: snapshot.requests?.usedPercent ?? null,
    requestsResetAtMs: snapshot.requests?.resetAtMs ?? null,
    retryAfterSeconds: snapshot.retryAfterSeconds,
  });
}
