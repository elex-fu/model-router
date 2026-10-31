/**
 * P1-3a Codex /wham active usage query (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4 follow-up). Pure helpers
 * with zero IO, ported from sub2api's quota-plane semantics
 * (`backend/internal/service/openai_quota_service.go`):
 *
 * - endpoints and quota-plane identity constants: lines 26-39 (usage URL,
 *   `openai-beta: codex-1`, originator "Codex Desktop", `oai-language`,
 *   sec-fetch-*, `priority`);
 * - quota-plane header set: `buildCodexCommonHeaders`, lines 601-620 (plus
 *   `content-type` on the consume POST, line 399);
 * - typed /wham/usage projection: lines 41-108 (rate_limit primary/secondary
 *   windows, additional_rate_limits with metered features, credits balance,
 *   embedded rate_limit_reset_credits summary);
 * - 5h/7d window normalization: reuses the rules pinned in
 *   `./quota-headers.ts` (`window_minutes ≤ 360 ⇒ 5h window`, primary wider
 *   than that is the 7d window and secondary the 5h one; s2a's equivalent is
 *   `OpenAICodexUsageSnapshot.Normalize`, openai_gateway_service.go:149-219);
 * - staleness gate: `CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS` (two hours).
 *
 * The gateway transport performs the actual fetch and feeds the response body
 * to `parseWhamUsageResponse`; nothing here touches the network or storage.
 */

import {
  CODEX_5H_WINDOW_MAX_MINUTES,
  CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS,
  type CodexRateLimitSnapshot,
} from './quota-headers.js';
import { type CodexResetCredit, mapWhamResetCreditEntry } from './reset-credits.js';

/** Active usage endpoint on the ChatGPT quota plane. */
export const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/**
 * Quota-plane identity: the active /wham queries present as "Codex Desktop",
 * deliberately distinct from the inference plane's `codex_cli_rs` originator
 * (see `./identity.ts`, `CODEX_DEFAULT_ORIGINATOR`). s2a:
 * openai_quota_service.go:31-36, 601-620.
 */
export const WHAM_QUOTA_PLANE_ORIGINATOR = 'Codex Desktop';
export const WHAM_QUOTA_PLANE_OPENAI_BETA = 'codex-1';
export const WHAM_QUOTA_PLANE_LANGUAGE_TAG = 'zh-CN';
export const WHAM_QUOTA_PLANE_SEC_FETCH_SITE = 'none';
export const WHAM_QUOTA_PLANE_SEC_FETCH_MODE = 'no-cors';
export const WHAM_QUOTA_PLANE_SEC_FETCH_DEST = 'empty';
export const WHAM_QUOTA_PLANE_PRIORITY = 'u=4, i';

/** Inputs for the shared quota-plane header set. */
export interface WhamQuotaPlaneHeadersInput {
  /** OAuth access token for the ChatGPT account (Bearer). */
  readonly accessToken: string;
  /** `chatgpt-account-id` header value (falls back to organization_id upstream). */
  readonly chatgptAccountId: string;
  /** Optional user-agent override; omitted header when not supplied. */
  readonly userAgent?: string;
  /** Adds `x-openai-fedramp: true` (s2a openai_quota_service.go:616-618). */
  readonly fedRamp?: boolean;
}

/**
 * Quota-plane header set for the active /wham queries (usage, reset-credit
 * details, consume), ported from s2a's `buildCodexCommonHeaders`
 * (openai_quota_service.go:601-620): Bearer auth, account id, `codex-1` beta,
 * language tag, "Codex Desktop" originator, accept, the sec-fetch-* trio and
 * `priority`. `content-type: application/json` is included unconditionally:
 * s2a adds it only on the consume POST (line 399), but the shared set here is
 * also used for that POST and the extra header is inert on the GETs.
 */
export function buildWhamQuotaPlaneHeaders(input: WhamQuotaPlaneHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    'chatgpt-account-id': input.chatgptAccountId,
    'openai-beta': WHAM_QUOTA_PLANE_OPENAI_BETA,
    'oai-language': WHAM_QUOTA_PLANE_LANGUAGE_TAG,
    originator: WHAM_QUOTA_PLANE_ORIGINATOR,
    accept: 'application/json',
    'content-type': 'application/json',
    'sec-fetch-site': WHAM_QUOTA_PLANE_SEC_FETCH_SITE,
    'sec-fetch-mode': WHAM_QUOTA_PLANE_SEC_FETCH_MODE,
    'sec-fetch-dest': WHAM_QUOTA_PLANE_SEC_FETCH_DEST,
    priority: WHAM_QUOTA_PLANE_PRIORITY,
  };
  if (typeof input.userAgent === 'string' && input.userAgent.length > 0) {
    headers['user-agent'] = input.userAgent;
  }
  if (input.fedRamp === true) {
    headers['x-openai-fedramp'] = 'true';
  }
  return headers;
}

/** One /wham/usage rate-limit window (s2a OpenAIRateLimitWindow, lines 43-49). */
export interface WhamRateLimitWindow {
  readonly usedPercent: number | null;
  /** Window length in seconds; `windowMinutes` is derived as floor(seconds/60). */
  readonly limitWindowSeconds: number | null;
  readonly resetAfterSeconds: number | null;
  /** Upstream reset timestamp (epoch seconds); kept raw, unused by normalization. */
  readonly resetAt: number | null;
}

/** Rate-limit envelope (s2a OpenAIRateLimit, lines 51-57). */
export interface WhamRateLimit {
  readonly allowed: boolean | null;
  readonly limitReached: boolean | null;
  readonly primaryWindow: WhamRateLimitWindow | null;
  readonly secondaryWindow: WhamRateLimitWindow | null;
}

/** Named extra window (e.g. Codex Spark, `metered_feature` "codex_bengalfox"). */
export interface WhamAdditionalRateLimit {
  readonly limitName: string | null;
  readonly meteredFeature: string | null;
  /** Normalized 5h/7d projection of the entry's primary/secondary windows. */
  readonly rateLimit: CodexRateLimitSnapshot | null;
}

/**
 * Spendable Codex credit balance (s2a OpenAICredits, lines 79-87). `balance`
 * stays a nullable decimal string upstream-side to preserve precision.
 */
export interface WhamCredits {
  readonly hasCredits: boolean | null;
  readonly unlimited: boolean | null;
  readonly balance: string | null;
}

/** Embedded reset-credit summary carried by the /wham/usage body (s2a lines 72-77). */
export interface WhamResetCreditsSummary {
  readonly availableCount: number | null;
  readonly credits: readonly CodexResetCredit[];
}

/** Typed projection of a /wham/usage response. */
export interface WhamUsageSnapshot {
  /** Normalized 5h/7d windows from `rate_limit` (quota-headers rules); `null` when absent/unparsable. */
  readonly rateLimit: CodexRateLimitSnapshot | null;
  /** Raw envelope flags from `rate_limit`; `null` when the body omits them. */
  readonly allowed: boolean | null;
  readonly limitReached: boolean | null;
  /** Named extra windows (s2a AdditionalRateLimits, lines 59-64); empty when absent. */
  readonly additionalRateLimits: readonly WhamAdditionalRateLimit[];
  readonly credits: WhamCredits | null;
  readonly resetCredits: WhamResetCreditsSummary | null;
  /** Epoch milliseconds the transport observed the response (s2a FetchedAt, line 215). */
  readonly observedAtMs: number;
}

interface NormalizableWindow {
  readonly usedPercent: number | null;
  readonly resetAfterSeconds: number | null;
  readonly windowMinutes: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown): WhamRateLimitWindow | null {
  if (!isRecord(value)) return null;
  return {
    usedPercent: toFiniteNumber(value.used_percent),
    limitWindowSeconds: toFiniteNumber(value.limit_window_seconds),
    resetAfterSeconds: toFiniteNumber(value.reset_after_seconds),
    resetAt: toFiniteNumber(value.reset_at),
  };
}

function toNormalizable(window: WhamRateLimitWindow | null): NormalizableWindow {
  return {
    usedPercent: window?.usedPercent ?? null,
    resetAfterSeconds: window?.resetAfterSeconds ?? null,
    windowMinutes:
      window?.limitWindowSeconds !== null && window?.limitWindowSeconds !== undefined
        ? Math.floor(window.limitWindowSeconds / 60)
        : null,
  };
}

function hasWindowSignal(window: NormalizableWindow): boolean {
  return window.usedPercent !== null || window.resetAfterSeconds !== null || window.windowMinutes !== null;
}

function isFiveHourWindow(window: NormalizableWindow): boolean {
  return window.windowMinutes !== null && window.windowMinutes <= CODEX_5H_WINDOW_MAX_MINUTES;
}

function snapshotFrom(fiveHour: NormalizableWindow, sevenDay: NormalizableWindow): CodexRateLimitSnapshot {
  return {
    used5hPercent: fiveHour.usedPercent,
    reset5hSeconds: fiveHour.resetAfterSeconds,
    window5hMinutes: fiveHour.windowMinutes,
    used7dPercent: sevenDay.usedPercent,
    reset7dSeconds: sevenDay.resetAfterSeconds,
    window7dMinutes: sevenDay.windowMinutes,
  };
}

/**
 * Normalizes /wham/usage primary/secondary windows into the canonical 5h/7d
 * snapshot, applying the exact rules pinned in `./quota-headers.ts`
 * (`parseCodexRateLimitHeaders`): `window_minutes ≤ 360 ⇒ 5h window`; a
 * primary wider than that is the 7d window and the secondary the 5h one; a
 * lone window classifies by the same threshold; with no window lengths at all
 * the legacy assumption is primary=7d / secondary=5h. `limit_window_seconds`
 * is converted with the same integer division s2a uses
 * (openai_quota_service.go:668, 675). Returns `null` when neither window
 * carries any signal. Note one deliberate edge divergence from s2a's
 * `Normalize`: when BOTH windows are ≤ 360 minutes this rule keeps
 * primary=5h, while s2a's strict `primary < secondary` comparison would swap
 * — the quota-headers rule wins because this repo's scheduler is pinned to it.
 */
export function normalizeWhamRateLimitWindows(
  primary: WhamRateLimitWindow | null,
  secondary: WhamRateLimitWindow | null,
): CodexRateLimitSnapshot | null {
  const primaryWindow = toNormalizable(primary);
  const secondaryWindow = toNormalizable(secondary);
  const primaryHasSignal = hasWindowSignal(primaryWindow);
  const secondaryHasSignal = hasWindowSignal(secondaryWindow);
  if (!primaryHasSignal && !secondaryHasSignal) return null;

  if (!secondaryHasSignal) {
    return isFiveHourWindow(primaryWindow)
      ? snapshotFrom(primaryWindow, secondaryWindow)
      : snapshotFrom(secondaryWindow, primaryWindow);
  }
  if (!primaryHasSignal) {
    return isFiveHourWindow(secondaryWindow)
      ? snapshotFrom(secondaryWindow, primaryWindow)
      : snapshotFrom(primaryWindow, secondaryWindow);
  }
  return isFiveHourWindow(primaryWindow)
    ? snapshotFrom(primaryWindow, secondaryWindow)
    : snapshotFrom(secondaryWindow, primaryWindow);
}

function parseAdditionalRateLimits(value: unknown): readonly WhamAdditionalRateLimit[] {
  if (!Array.isArray(value)) return [];
  const entries: WhamAdditionalRateLimit[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rateLimit = isRecord(item.rate_limit) ? item.rate_limit : null;
    entries.push({
      limitName: typeof item.limit_name === 'string' && item.limit_name.trim().length > 0 ? item.limit_name : null,
      meteredFeature:
        typeof item.metered_feature === 'string' && item.metered_feature.trim().length > 0
          ? item.metered_feature
          : null,
      rateLimit: normalizeWhamRateLimitWindows(
        parseWindow(rateLimit?.primary_window),
        parseWindow(rateLimit?.secondary_window),
      ),
    });
  }
  return entries;
}

function parseCredits(value: unknown): WhamCredits | null {
  if (!isRecord(value)) return null;
  return {
    hasCredits: toBoolean(value.has_credits),
    unlimited: toBoolean(value.unlimited),
    balance: typeof value.balance === 'string' ? value.balance : null,
  };
}

function parseResetCreditsSummary(value: unknown): WhamResetCreditsSummary | null {
  if (!isRecord(value)) return null;
  // s2a decodes available_count as a plain int on this body (strict), but its
  // details-endpoint parse also accepts numeric strings
  // (openai_quota_reset_credits.go:124-150); accept both defensively.
  let availableCount: number | null = null;
  if (typeof value.available_count === 'number' && Number.isFinite(value.available_count)) {
    availableCount = value.available_count;
  } else if (typeof value.available_count === 'string') {
    const parsed = Number(value.available_count.trim());
    availableCount = value.available_count.trim().length > 0 && Number.isFinite(parsed) ? parsed : null;
  }
  const credits: CodexResetCredit[] = [];
  if (Array.isArray(value.credits)) {
    for (const entry of value.credits) {
      const credit = mapWhamResetCreditEntry(entry);
      if (credit !== null) credits.push(credit);
    }
  }
  return { availableCount, credits };
}

/**
 * Parses a /wham/usage response body into the typed snapshot. Returns `null`
 * when the body is not an object or carries no parsable quota signal at all
 * (mirroring `parseCodexRateLimitHeaders`' no-signal rule); individual
 * sections stay `null`/empty when the body omits or malforms them.
 * `observedAtMs` stamps the observation time (s2a sets `FetchedAt` from the
 * response clock, openai_quota_service.go:215) and defaults to `Date.now()`;
 * tests and replayed captures pass it explicitly.
 */
export function parseWhamUsageResponse(body: unknown, observedAtMs: number = Date.now()): WhamUsageSnapshot | null {
  if (!isRecord(body)) return null;
  const rawRateLimit = isRecord(body.rate_limit) ? body.rate_limit : null;
  const rateLimit = normalizeWhamRateLimitWindows(
    parseWindow(rawRateLimit?.primary_window),
    parseWindow(rawRateLimit?.secondary_window),
  );
  const additionalRateLimits = parseAdditionalRateLimits(body.additional_rate_limits);
  const credits = parseCredits(body.credits);
  const resetCredits = parseResetCreditsSummary(body.rate_limit_reset_credits);
  const allowed = rawRateLimit !== null ? toBoolean(rawRateLimit.allowed) : null;
  const limitReached = rawRateLimit !== null ? toBoolean(rawRateLimit.limit_reached) : null;

  const hasSignal =
    rateLimit !== null ||
    additionalRateLimits.length > 0 ||
    credits !== null ||
    resetCredits !== null ||
    allowed !== null ||
    limitReached !== null;
  if (!hasSignal) return null;

  return {
    rateLimit,
    allowed,
    limitReached,
    additionalRateLimits,
    credits,
    resetCredits,
    observedAtMs,
  };
}

/**
 * Staleness gate for a parsed usage snapshot, consistent with
 * `CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS` (two hours, the same bound
 * `classifyQuotaPause` uses): a snapshot is usable while its age is at most
 * `maxAgeMs` and it still carries at least one quota section. `null`
 * snapshots, non-finite observation times and signal-free snapshots are
 * unusable (fail closed — the caller must re-query, not guess).
 */
export function whamUsageSnapshotIsUsable(
  snapshot: WhamUsageSnapshot | null,
  nowMs: number,
  maxAgeMs: number = CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS,
): boolean {
  if (snapshot === null || snapshot === undefined) return false;
  if (!Number.isFinite(snapshot.observedAtMs)) return false;
  if (nowMs - snapshot.observedAtMs > maxAgeMs) return false;
  return (
    snapshot.rateLimit !== null ||
    snapshot.additionalRateLimits.length > 0 ||
    snapshot.credits !== null ||
    snapshot.resetCredits !== null
  );
}
