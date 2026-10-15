/**
 * R5 Claude usage snapshot (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5; port of sub2api's
 * ClaudeUsageResponse semantics). Fetches
 * `GET https://api.anthropic.com/api/oauth/usage` (Bearer + the oauth beta +
 * a claude-code UA) and normalizes the four windows: five_hour, seven_day,
 * seven_day_sonnet and seven_day_overage_included (the Fable-only 7d window
 * the response headers label 7d_oi). Pure parsing plus an injectable fetch.
 */

export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
/** UA the usage endpoint expects (matches the observed real request shape). */
export const CLAUDE_USAGE_USER_AGENT = 'claude-code/2.1.7';
export const CLAUDE_USAGE_TIMEOUT_MS = 30_000;
export const CLAUDE_USAGE_MAX_RESPONSE_BYTES = 65_536;

/** One usage window: utilization fraction (0..1+) and an ISO reset timestamp. */
export interface ClaudeUsageWindow {
  readonly utilization: number;
  readonly resetsAt: string;
}

/** Normalized /api/oauth/usage snapshot. */
export interface ClaudeUsageSnapshot {
  readonly fiveHour: ClaudeUsageWindow | null;
  readonly sevenDay: ClaudeUsageWindow | null;
  readonly sevenDaySonnet: ClaudeUsageWindow | null;
  readonly sevenDayOverageIncluded: ClaudeUsageWindow | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWindow(value: unknown): ClaudeUsageWindow | null {
  if (!isRecord(value)) return null;
  const utilization =
    typeof value.utilization === 'number' && Number.isFinite(value.utilization) ? value.utilization : null;
  const resetsAt = typeof value.resets_at === 'string' && value.resets_at.length > 0 ? value.resets_at : null;
  if (utilization === null || resetsAt === null) return null;
  return { utilization, resetsAt };
}

/**
 * Parses the usage response body. Absent windows stay null (the upstream
 * legitimately omits seven_day_sonnet/7d_oi for accounts without those
 * entitlements); a body without even the 5h window returns null so callers
 * treat the observation as unavailable rather than empty.
 */
export function parseClaudeUsageSnapshot(body: unknown): ClaudeUsageSnapshot | null {
  if (!isRecord(body)) return null;
  const fiveHour = parseWindow(body.five_hour);
  const sevenDay = parseWindow(body.seven_day);
  const sevenDaySonnet = parseWindow(body.seven_day_sonnet);
  const sevenDayOverageIncluded = parseWindow(body.seven_day_overage_included);
  if (fiveHour === null && sevenDay === null && sevenDaySonnet === null && sevenDayOverageIncluded === null) {
    return null;
  }
  return { fiveHour, sevenDay, sevenDaySonnet, sevenDayOverageIncluded };
}

export type ClaudeUsageFetchErrorCode = 'USAGE_HTTP_ERROR' | 'USAGE_RESPONSE_INVALID';

export class ClaudeUsageFetchError extends Error {
  constructor(
    readonly code: ClaudeUsageFetchErrorCode,
    readonly httpStatus: number | null,
  ) {
    super(
      code === 'USAGE_HTTP_ERROR'
        ? 'the Claude usage endpoint rejected the request'
        : 'the Claude usage response is invalid',
    );
    this.name = 'ClaudeUsageFetchError';
  }
}

export type ClaudeUsageFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** Fetches and parses the OAuth usage snapshot for one access token. */
export async function fetchClaudeUsageSnapshot(
  accessToken: string,
  fetcher: ClaudeUsageFetch = (url, init) => fetch(url, init),
  options: { readonly signal?: AbortSignal } = {},
): Promise<ClaudeUsageSnapshot> {
  let response: Response;
  try {
    response = await fetcher(new URL(CLAUDE_USAGE_ENDPOINT), {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': CLAUDE_USAGE_USER_AGENT,
      },
      redirect: 'manual',
      signal: options.signal ?? AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
    });
  } catch {
    throw new ClaudeUsageFetchError('USAGE_HTTP_ERROR', null);
  }
  if (response.status < 200 || response.status >= 300) {
    try {
      void response.body?.cancel();
    } catch {
      // The body is neither consumed nor surfaced.
    }
    throw new ClaudeUsageFetchError('USAGE_HTTP_ERROR', response.status);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ClaudeUsageFetchError('USAGE_RESPONSE_INVALID', response.status);
  }
  if (text.length > CLAUDE_USAGE_MAX_RESPONSE_BYTES) {
    throw new ClaudeUsageFetchError('USAGE_RESPONSE_INVALID', response.status);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ClaudeUsageFetchError('USAGE_RESPONSE_INVALID', response.status);
  }
  const snapshot = parseClaudeUsageSnapshot(body);
  if (snapshot === null) throw new ClaudeUsageFetchError('USAGE_RESPONSE_INVALID', response.status);
  return snapshot;
}
