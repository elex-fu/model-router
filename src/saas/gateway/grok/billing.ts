/**
 * Batch-3 Grok billing probe (sub2api backend/internal/pkg/xai billing.go
 * port, pure parts + an injectable fetch). Two windows are probed on the CLI
 * proxy base:
 *
 * - weekly (`/billing?format=credits`): the rolling weekly credits window —
 *   creditUsagePercent, per-product usage, prepaid/on-demand money;
 * - monthly (`/billing`): the calendar billing view — monthlyLimit/used in
 *   cents. The $150.00 / $1,500.00 monthly limits identify SuperGrok and
 *   SuperGrok Heavy respectively.
 *
 * The merged snapshot is a scheduling/observability signal (migration 119's
 * grok_billing jsonb); it never enters the billing path.
 */

import {
  applyGrokCliProxyHeaders,
  GROK_BILLING_MONTHLY_PATH,
  GROK_BILLING_WEEKLY_PATH,
  GROK_CLI_PROXY_HOST,
  GROK_OAUTH_DEFAULT_BASE_URL,
  GROK_SUPERGROK_HEAVY_MONTHLY_LIMIT_CENTS,
  GROK_SUPERGROK_MONTHLY_LIMIT_CENTS,
} from './constants.js';

export interface GrokBillingPeriod {
  readonly type: string | null;
  readonly start: string | null;
  readonly end: string | null;
}

/** Normalized billing summary (the persisted grok_billing jsonb shape). */
export interface GrokBillingSummary {
  /** 'weekly' | 'monthly' | 'unknown' */
  readonly periodType: string | null;
  readonly usagePercent: number | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly monthlyLimitCents: number | null;
  readonly usedCents: number | null;
  readonly usedPercent: number | null;
  /** 'supergrok' | 'supergrok_heavy' | null (monthly-limit derived). */
  readonly plan: string | null;
  readonly weeklyStatusCode: number | null;
  readonly monthlyStatusCode: number | null;
  readonly partial: boolean;
  readonly failedWindows: readonly string[];
  readonly fetchedAt: string | null;
}

export type GrokBillingFetch = (url: string, init: RequestInit) => Promise<Response>;

export const GROK_BILLING_TIMEOUT_MS = 10_000;
export const GROK_BILLING_MAX_RESPONSE_BYTES = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Cent-valued fields appear either as bare numbers/strings or the object form
 * `{"val": 123}` (sub2api parseCentValue).
 */
function parseCentValue(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (isRecord(value)) return finiteNumber(value.val);
  return finiteNumber(value);
}

function parsePeriod(value: unknown): GrokBillingPeriod {
  if (!isRecord(value)) return { type: null, start: null, end: null };
  return {
    type: text(value.type),
    start: text(value.start),
    end: text(value.end),
  };
}

function resolvePeriodType(period: GrokBillingPeriod): string | null {
  const raw = period.type?.toLowerCase() ?? '';
  if (raw.includes('weekly')) return 'weekly';
  if (raw.includes('monthly')) return 'monthly';
  return raw === '' ? null : 'unknown';
}

/** Monthly-limit → plan (sub2api resolvePlan; $150 = SuperGrok, $1,500 = Heavy). */
export function grokPlanFromMonthlyLimitCents(monthlyLimitCents: number | null): string | null {
  if (monthlyLimitCents === null) return null;
  const limit = Math.round(monthlyLimitCents);
  if (limit === GROK_SUPERGROK_MONTHLY_LIMIT_CENTS) return 'supergrok';
  if (limit === GROK_SUPERGROK_HEAVY_MONTHLY_LIMIT_CENTS) return 'supergrok_heavy';
  return null;
}

/**
 * Normalizes one `/billing` response config into the summary fields this
 * router persists. Returns null when the config carries neither a weekly
 * (credits/period/products) nor a monthly (limit/used/period-bounds) signal.
 */
export function parseGrokBillingConfig(
  config: unknown,
): Omit<
  GrokBillingSummary,
  'partial' | 'failedWindows' | 'fetchedAt' | 'weeklyStatusCode' | 'monthlyStatusCode'
> | null {
  if (!isRecord(config)) return null;
  const period = parsePeriod(config.currentPeriod);
  const periodType = resolvePeriodType(period);
  const usagePercent = finiteNumber(config.creditUsagePercent);
  const monthlyLimitCents = parseCentValue(config.monthlyLimit);
  const usedCents = parseCentValue(config.used);
  const hasWeekly =
    usagePercent !== null ||
    periodType === 'weekly' ||
    (period.start !== null && period.end !== null) ||
    parseCentValue(config.prepaidBalance) !== null ||
    parseCentValue(config.onDemandCap) !== null ||
    parseCentValue(config.onDemandUsed) !== null;
  const billingPeriodStart = text(config.billingPeriodStart);
  const billingPeriodEnd = text(config.billingPeriodEnd);
  const hasMonthly = monthlyLimitCents !== null || usedCents !== null || (!hasWeekly && billingPeriodEnd !== null);
  if (!hasWeekly && !hasMonthly) return null;
  let usedPercent: number | null = null;
  if (monthlyLimitCents !== null && monthlyLimitCents > 0 && usedCents !== null) {
    usedPercent = (Math.min(usedCents, monthlyLimitCents) / monthlyLimitCents) * 100;
  }
  if (hasWeekly) {
    return {
      periodType: periodType ?? 'weekly',
      usagePercent,
      periodStart: period.start,
      periodEnd: period.end,
      monthlyLimitCents,
      usedCents,
      usedPercent,
      plan: grokPlanFromMonthlyLimitCents(monthlyLimitCents),
    };
  }
  return {
    periodType: 'monthly',
    usagePercent: null,
    periodStart: billingPeriodStart,
    periodEnd: billingPeriodEnd,
    monthlyLimitCents,
    usedCents,
    usedPercent,
    plan: grokPlanFromMonthlyLimitCents(monthlyLimitCents),
  };
}

/** Parses a full `/billing` response body (`{config: {...}}`). */
export function parseGrokBillingPayload(body: unknown): ReturnType<typeof parseGrokBillingConfig> {
  if (!isRecord(body)) return null;
  return parseGrokBillingConfig(body.config);
}

/**
 * Merge rule (sub2api MergeBillingProbeResult, simplified to the fields this
 * router keeps): a successful window overwrites its domain; a failed window
 * retains the previous value; `partial` and `failedWindows` report which
 * windows could not be refreshed.
 */
export function mergeGrokBillingProbeResult(
  previous: GrokBillingSummary | null,
  weekly: ReturnType<typeof parseGrokBillingConfig>,
  monthly: ReturnType<typeof parseGrokBillingConfig>,
  options: { readonly weeklyOk: boolean; readonly monthlyOk: boolean; readonly fetchedAt?: string },
): GrokBillingSummary | null {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const base: GrokBillingSummary = previous ?? {
    periodType: null,
    usagePercent: null,
    periodStart: null,
    periodEnd: null,
    monthlyLimitCents: null,
    usedCents: null,
    usedPercent: null,
    plan: null,
    weeklyStatusCode: null,
    monthlyStatusCode: null,
    partial: true,
    failedWindows: [],
    fetchedAt: null,
  };
  const failedWindows: string[] = [];
  if (!options.weeklyOk) failedWindows.push('weekly');
  if (!options.monthlyOk) failedWindows.push('monthly');
  if (!options.weeklyOk && !options.monthlyOk && previous === null) return null;
  const next: {
    periodType: string | null;
    usagePercent: number | null;
    periodStart: string | null;
    periodEnd: string | null;
    monthlyLimitCents: number | null;
    usedCents: number | null;
    usedPercent: number | null;
    plan: string | null;
  } = {
    periodType: base.periodType,
    usagePercent: base.usagePercent,
    periodStart: base.periodStart,
    periodEnd: base.periodEnd,
    monthlyLimitCents: base.monthlyLimitCents,
    usedCents: base.usedCents,
    usedPercent: base.usedPercent,
    plan: base.plan,
  };
  if (options.weeklyOk && weekly !== null) {
    next.periodType = weekly.periodType;
    next.usagePercent = weekly.usagePercent;
    next.periodStart = weekly.periodStart;
    next.periodEnd = weekly.periodEnd;
  }
  if (options.monthlyOk && monthly !== null) {
    if (next.periodType === null) next.periodType = 'monthly';
    next.monthlyLimitCents = monthly.monthlyLimitCents;
    next.usedCents = monthly.usedCents;
    next.usedPercent = monthly.usedPercent;
    next.plan = monthly.plan;
  }
  return {
    ...base,
    ...next,
    fetchedAt,
    partial: failedWindows.length > 0,
    failedWindows,
  };
}

/** Builds the weekly or monthly billing URL against a resolved base URL. */
export function buildGrokBillingUrl(baseUrl: string, formatCredits: boolean): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}${formatCredits ? GROK_BILLING_WEEKLY_PATH : GROK_BILLING_MONTHLY_PATH}`;
}

/**
 * Fetches one billing window. The CLI identity headers are stamped exactly
 * like forwarding traffic (the billing endpoints sit on the CLI proxy host
 * and reject non-CLI callers); the bearer token arrives from the caller's
 * unsealed-envelope callback and never leaves this call except to the
 * resolved upstream.
 */
export async function fetchGrokBillingWindow(input: {
  readonly baseUrl: string;
  readonly formatCredits: boolean;
  readonly accessToken: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: GrokBillingFetch;
}): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly summary: ReturnType<typeof parseGrokBillingConfig>;
}> {
  const url = buildGrokBillingUrl(input.baseUrl, input.formatCredits);
  const headers = applyGrokCliProxyHeaders(
    {
      authorization: `Bearer ${input.accessToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    new URL(url).hostname,
  );
  try {
    const response = await (input.fetcher ?? ((u, init) => fetch(u, init)))(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: input.signal ?? AbortSignal.timeout(GROK_BILLING_TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, summary: null };
    }
    const text = await response.text();
    if (text.length > GROK_BILLING_MAX_RESPONSE_BYTES) return { ok: false, status: response.status, summary: null };
    return { ok: true, status: response.status, summary: parseGrokBillingPayload(JSON.parse(text)) };
  } catch {
    return { ok: false, status: 0, summary: null };
  }
}

/**
 * The default probe base: the CLI proxy. Accounts forwarding through a custom
 * upstream keep their billing probes on that upstream (the caller passes its
 * resolved base URL into fetchGrokBillingWindow).
 */
export const GROK_BILLING_DEFAULT_BASE_URL = GROK_OAUTH_DEFAULT_BASE_URL;
export const GROK_BILLING_HOST = GROK_CLI_PROXY_HOST;
