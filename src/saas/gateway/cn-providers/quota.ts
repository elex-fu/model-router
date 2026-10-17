/**
 * Batch 3 CN-provider Coding Plan quota parsers (sub2api reference:
 * backend/internal/service/cn_provider_quota_service.go — parseZhipuTokenTiers,
 * parseMiniMaxUsageTiers, classifyZhipuWindowUnit, cnNormalizeResetTime).
 * Pure functions; the polling worker (supply/cn-providers-quota-worker.ts)
 * owns fetching and persistence.
 *
 * Zhipu GET /api/monitor/usage/quota/limit (Authorization WITHOUT the Bearer
 * prefix; team plans add ?type=2 + bigmodel-organization/bigmodel-project
 * headers — the URL/header builder below carries both):
 * - `data.limits[]` entries carry `type` (TOKENS_LIMIT | CREDIT_LIMIT),
 *   `percentage` (already a used-percent), `nextResetTime` (ms or ISO) and
 *   an optional `unit` window classifier: 3 = 5h rolling, 6 = weekly;
 * - classification priority: the explicit unit field FIRST (a reset-time
 *   sort cannot substitute — at period edges the weekly window resets
 *   EARLIER than the 5h window, so time ordering would label them
 *   backwards); unit-missing entries fall into a heuristic: no-reset
 *   entries first (a 0%-used 5h bucket may carry no reset), then ascending
 *   reset, filling still-empty slots;
 * - CREDIT_LIMIT (credit balance) measures a different quantity than
 *   TOKENS_LIMIT (token windows): when both are present only TOKENS_LIMIT
 *   entries compete for the 5h/weekly slots; CREDIT_LIMIT participates
 *   only when no TOKENS_LIMIT entry exists. Old plans return a single
 *   TOKENS_LIMIT entry (weekly stays null); new plans return two.
 * - HTTP 2xx with success=false is a business error (no snapshot write).
 *
 * MiniMax GET /v1/api/openplatform/coding_plan/remains (Bearer):
 * - `model_remains[]` — only the `model_name == "general"` entry applies
 *   (the coding plan); video entries are skipped;
 * - the fields are REMAINING percentages: used = 100 − remaining (floored
 *   at 0);
 * - 5h window: current_interval_remaining_percent + end_time; weekly only
 *   when current_weekly_status == 1 (current_weekly_remaining_percent +
 *   weekly_end_time);
 * - `base_resp.status_code != 0` is a business error.
 */

import { MINIMAX_QUOTA_URL, MINIMAX_QUOTA_URL_INTL, ZHIPU_QUOTA_URL, ZHIPU_QUOTA_URL_INTL } from './constants.js';

export type CnQuotaWindow = '5h' | 'weekly';

/** One upstream-observed rolling-window tier; NULL fields were absent upstream, never guessed. */
export interface CnQuotaTierSnapshot {
  readonly window: CnQuotaWindow;
  readonly usedPercent: number;
  /** RFC 3339 UTC string; '' means the upstream reported no reset time. */
  readonly resetAt: string;
}

export interface CnQuotaParseResult {
  /** Empty tiers = nothing observed (no snapshot write). */
  readonly tiers: readonly CnQuotaTierSnapshot[];
  /** Zhipu plan level / MiniMax subscription title passthrough (display signal). */
  readonly planLevel: string;
}

export type CnQuotaParseErrorCode = 'business_error' | 'response_invalid' | 'general_not_found' | 'base_resp_error';

export type CnQuotaParse =
  | { readonly state: 'ok'; readonly result: CnQuotaParseResult }
  | { readonly state: 'error'; readonly errorCode: CnQuotaParseErrorCode; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses a JSON number or numeric string (sub2api cnParseF64). */
function parseF64(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Normalizes an upstream reset time (ISO 8601 string / seconds / ms epoch)
 * to an RFC 3339 UTC string; '' when absent or unrecognizable (sub2api
 * cnNormalizeResetTime / cnMillisToRFC3339).
 */
export function cnNormalizeResetTime(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'number' && Number.isFinite(raw)) return msToRfc3339(raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    if (/^[0-9]{1,15}$/.test(trimmed)) return msToRfc3339(Number(trimmed));
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }
  return '';
}

function msToRfc3339(epoch: number): string {
  if (epoch <= 0) return '';
  // Seconds (< 1e12) vs milliseconds, the sub2api heuristic.
  const ms = epoch < 1_000_000_000_000 ? epoch * 1000 : epoch;
  return new Date(ms).toISOString();
}

/** Zhipu unit classifier: 3 = 5h rolling window, 6 = weekly (sub2api issue #3036). */
export type ZhipuWindowUnit = '5h' | 'weekly' | 'unknown';

export function classifyZhipuWindowUnit(unit: unknown): ZhipuWindowUnit {
  const value = parseF64(unit);
  if (value === null) return 'unknown';
  if (value === 3) return '5h';
  if (value === 6) return 'weekly';
  return 'unknown';
}

interface ZhipuLimitEntry {
  readonly percentage: number;
  readonly resetMs: number;
  readonly hasReset: boolean;
  readonly resetIso: string;
}

function readZhipuEntry(item: Record<string, unknown>): ZhipuLimitEntry | null {
  const percentage = parseF64(item.percentage) ?? 0;
  let resetMs = Number.NaN;
  let hasReset = false;
  let resetIso = '';
  const nextReset = item.nextResetTime;
  if (typeof nextReset === 'number' && Number.isFinite(nextReset)) {
    resetMs = nextReset;
    hasReset = nextReset > 0;
    resetIso = msToRfc3339(nextReset);
  } else if (typeof nextReset === 'string' && nextReset.trim() !== '') {
    resetIso = cnNormalizeResetTime(nextReset);
    const parsed = Date.parse(resetIso);
    hasReset = resetIso !== '' && Number.isFinite(parsed);
    resetMs = hasReset ? parsed : Number.NaN;
  }
  return { percentage, resetMs, hasReset, resetIso };
}

/**
 * Parses the zhipu quota payload's `data` object into 5h + weekly tiers.
 * See the module header for the classification priority contract.
 */
export function parseZhipuQuotaData(data: unknown): CnQuotaParse {
  if (!isRecord(data)) return { state: 'error', errorCode: 'response_invalid', message: 'data object missing' };
  const limits = data.limits;
  if (!Array.isArray(limits)) return { state: 'ok', result: { tiers: [], planLevel: '' } };

  let fiveHour: ZhipuLimitEntry | null = null;
  let weekly: ZhipuLimitEntry | null = null;
  const unclassified: ZhipuLimitEntry[] = [];
  const creditFallback: ZhipuLimitEntry[] = [];
  let hasTokensLimit = false;

  for (const raw of limits) {
    if (!isRecord(raw)) continue;
    const limitType = typeof raw.type === 'string' ? raw.type.trim().toUpperCase() : '';
    if (limitType !== 'TOKENS_LIMIT' && limitType !== 'CREDIT_LIMIT') continue;
    const entry = readZhipuEntry(raw);
    if (entry === null) continue;
    if (limitType === 'CREDIT_LIMIT') {
      creditFallback.push(entry);
      continue;
    }
    hasTokensLimit = true;
    const unit = classifyZhipuWindowUnit(raw.unit);
    if (unit === '5h' && fiveHour === null) {
      fiveHour = entry;
    } else if (unit === 'weekly' && weekly === null) {
      weekly = entry;
    } else {
      unclassified.push(entry);
    }
  }

  // No TOKENS_LIMIT at all (credit-only plans): degrade to CREDIT_LIMIT display.
  if (!hasTokensLimit) unclassified.push(...creditFallback);

  // Unit-missing heuristic: no-reset entries first, then ascending reset,
  // filling still-empty slots.
  unclassified.sort((left, right) => {
    if (left.hasReset !== right.hasReset) return left.hasReset ? 1 : -1;
    return left.resetMs - right.resetMs;
  });
  for (const entry of unclassified) {
    if (fiveHour === null) fiveHour = entry;
    else if (weekly === null) weekly = entry;
  }

  const tiers: CnQuotaTierSnapshot[] = [];
  if (fiveHour !== null) {
    tiers.push({ window: '5h', usedPercent: fiveHour.percentage, resetAt: fiveHour.resetIso });
  }
  if (weekly !== null) {
    tiers.push({ window: 'weekly', usedPercent: weekly.percentage, resetAt: weekly.resetIso });
  }
  const planLevel = typeof data.level === 'string' ? data.level.trim() : '';
  return { state: 'ok', result: { tiers, planLevel } };
}

/** Parses a full zhipu quota response body (the 2xx success envelope). */
export function parseZhipuQuotaResponseBody(bytes: Uint8Array): CnQuotaParse {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { state: 'error', errorCode: 'response_invalid', message: 'body is not valid JSON' };
  }
  if (!isRecord(body)) return { state: 'error', errorCode: 'response_invalid', message: 'body is not an object' };
  if (body.success === false) {
    const message =
      typeof body.msg === 'string' && body.msg.trim() !== '' ? body.msg.trim() : 'unknown zhipu quota error';
    return { state: 'error', errorCode: 'business_error', message };
  }
  return parseZhipuQuotaData(body.data);
}

/**
 * Parses the MiniMax coding-plan remains payload. See the module header for
 * the general-entry / percentage-inversion / weekly-gate contract.
 */
export function parseMinimaxQuotaResponseBody(bytes: Uint8Array): CnQuotaParse {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { state: 'error', errorCode: 'response_invalid', message: 'body is not valid JSON' };
  }
  if (!isRecord(body)) return { state: 'error', errorCode: 'response_invalid', message: 'body is not an object' };
  const baseResp = isRecord(body.base_resp) ? body.base_resp : null;
  const statusCode = baseResp !== null ? parseF64(baseResp.status_code) : null;
  if (statusCode !== null && statusCode !== 0) {
    const message =
      baseResp !== null && typeof baseResp.status_msg === 'string' && baseResp.status_msg.trim() !== ''
        ? baseResp.status_msg.trim()
        : 'unknown minimax quota error';
    return { state: 'error', errorCode: 'base_resp_error', message };
  }
  const remains = body.model_remains;
  if (!Array.isArray(remains)) return { state: 'ok', result: { tiers: [], planLevel: '' } };

  let general: Record<string, unknown> | null = null;
  for (const raw of remains) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.model_name === 'string' ? raw.model_name.trim().toLowerCase() : '';
    if (name === 'general') {
      general = raw;
      break;
    }
  }
  if (general === null) {
    return { state: 'error', errorCode: 'general_not_found', message: 'no general coding-plan remain entry' };
  }

  const usedFromRemaining = (value: unknown): number | null => {
    const remaining = parseF64(value);
    if (remaining === null) return null;
    const used = 100 - remaining;
    return used < 0 ? 0 : used;
  };

  const tiers: CnQuotaTierSnapshot[] = [];
  const intervalRemaining = usedFromRemaining(general.current_interval_remaining_percent);
  if (intervalRemaining !== null) {
    tiers.push({
      window: '5h',
      usedPercent: intervalRemaining,
      resetAt: minimaxResetTime(general.end_time),
    });
  }
  if (parseF64(general.current_weekly_status) === 1) {
    const weeklyRemaining = usedFromRemaining(general.current_weekly_remaining_percent);
    if (weeklyRemaining !== null) {
      tiers.push({
        window: 'weekly',
        usedPercent: weeklyRemaining,
        resetAt: minimaxResetTime(general.weekly_end_time),
      });
    }
  }
  const planLevel =
    typeof body.current_subscribe_title === 'string' ? (body.current_subscribe_title as string).trim() : '';
  return { state: 'ok', result: { tiers, planLevel } };
}

/** MiniMax reset times are epoch milliseconds (seconds tolerated, sub2api minimaxResetTime). */
function minimaxResetTime(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const value = parseF64(raw);
  if (value === null || value <= 0) return cnNormalizeResetTime(raw);
  return msToRfc3339(value);
}

/**
 * Zhipu quota probe URL builder (sub2api zhipuQuotaURL + the team-plan
 * variant): the monitor host follows the inference domain — open.bigmodel.cn
 * domestic default, api.z.ai international. Team plans (an organization id
 * present) append ?type=2; personal plans keep the bare path.
 */
export function zhipuQuotaUrl(options: { readonly international?: boolean; readonly team?: boolean } = {}): string {
  const base = options.international === true ? ZHIPU_QUOTA_URL_INTL : ZHIPU_QUOTA_URL;
  return options.team === true ? `${base}?type=2` : base;
}

/** MiniMax quota probe URL builder (domestic api.minimaxi.com / international api.minimax.io). */
export function minimaxQuotaUrl(options: { readonly international?: boolean } = {}): string {
  return options.international === true ? MINIMAX_QUOTA_URL_INTL : MINIMAX_QUOTA_URL;
}
