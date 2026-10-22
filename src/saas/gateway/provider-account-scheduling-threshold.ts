/**
 * R-dormant activation (sub2api account_scheduling_threshold_eval.go port):
 * the lazy scheduling-threshold pause kernel. The scheduler evaluates it at
 * candidate-collection time (never in a background pass): a candidate whose
 * persisted quota snapshot reports a window at or above its auto-pause
 * threshold is paused until that window's reset — the pause winner is the
 * LATEST breaching reset (the account stays out of rotation for its whole
 * exhausted horizon), ties broken by the higher used percent.
 *
 * Thresholds reuse the dormant migration-099 `auto_pause_*_threshold`
 * columns — the per-account operator override, one per window family:
 * `auto_pause_5h_threshold` gates short windows (codex 5h, claude 5h,
 * opencode-go rolling 5h, zhipu/minimax coding-plan 5h, grok 5h),
 * `auto_pause_7d_threshold` gates long windows (codex 7d, claude
 * 7d/7d_sonnet/7d_oi, opencode-go weekly/monthly, gemini daily,
 * zhipu/minimax coding-plan weekly). No threshold configured (NULL) produces
 * no candidate at all — the pre-activation behavior, byte-identical (the
 * golden-fixture red line).
 *
 * The persisted reason JSON is the sub2api temp-unsched shape
 * (`source: "account_scheduling_threshold"`); idempotency compares reasons
 * with `triggered_at_unix` zeroed and `until` at second granularity.
 */

/** A snapshot older than this no longer pauses (the codex 2h precedent). */
export const SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type SchedulingThresholdPlatform =
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'opencode-go'
  | 'zhipu'
  | 'minimax'
  | 'kimi'
  | 'grok';

/** One window candidate as persisted in the quota-snapshot column family. */
export interface SchedulingThresholdWindowCandidate {
  readonly platform: SchedulingThresholdPlatform;
  readonly window: string;
  readonly usedPercent: number;
  /** Epoch milliseconds when the window resets; a candidate requires until > now. */
  readonly untilMs: number;
  readonly thresholdPercent: number;
}

/** The pause decision the scheduler persists. */
export interface SchedulingThresholdPause {
  readonly platform: SchedulingThresholdPlatform;
  readonly window: string;
  readonly thresholdPercent: number;
  readonly usedPercent: number;
  readonly untilMs: number;
}

/** The persisted reason JSON shape (sub2api temp-unsched payload port). */
export interface SchedulingThresholdPauseReason {
  readonly source: 'account_scheduling_threshold';
  readonly platform: string;
  readonly window: string;
  readonly threshold_percent: number;
  readonly used_percent: number;
  readonly until_unix: number;
  readonly triggered_at_unix: number;
  /** Optional window-cost observation (requests/tokens since window start). */
  readonly window_cost_requests?: number;
  readonly window_cost_tokens?: string;
}

/**
 * Winner selection (pickLatestResetSchedulingCandidate port): a candidate
 * matches iff its reset is still in the future and its used percent is at
 * or above its threshold; the winner is the latest reset, ties broken by
 * the higher used percent.
 */
export function evaluateSchedulingThresholdPause(input: {
  readonly nowMs: number;
  readonly candidates: readonly SchedulingThresholdWindowCandidate[];
}): SchedulingThresholdPause | null {
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  let winner: SchedulingThresholdWindowCandidate | null = null;
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (!Number.isFinite(candidate.usedPercent) || !Number.isFinite(candidate.untilMs)) continue;
    if (!Number.isFinite(candidate.thresholdPercent) || candidate.thresholdPercent < 1) continue;
    // Kimi's default 100% cutoff represents observed exhaustion, independent
    // of the optional operator early-pause thresholds used by other families.
    if (candidate.thresholdPercent >= 100 && !(candidate.platform === 'kimi' && candidate.thresholdPercent === 100))
      continue;
    if (candidate.untilMs <= input.nowMs) continue;
    if (candidate.usedPercent < candidate.thresholdPercent) continue;
    if (winner === null) {
      winner = candidate;
      continue;
    }
    if (
      candidate.untilMs > winner.untilMs ||
      (candidate.untilMs === winner.untilMs && candidate.usedPercent > winner.usedPercent)
    ) {
      winner = candidate;
    }
  }
  if (winner === null) return null;
  return {
    platform: winner.platform,
    window: winner.window,
    thresholdPercent: Math.round(winner.thresholdPercent),
    usedPercent: winner.usedPercent,
    untilMs: winner.untilMs,
  };
}

/** Builds the persisted reason JSON for one pause decision. */
export function buildSchedulingThresholdPauseReason(input: {
  readonly pause: SchedulingThresholdPause;
  readonly triggeredAtMs: number;
  readonly windowCost?: { readonly requests: number; readonly tokens: bigint } | null;
}): SchedulingThresholdPauseReason {
  const reason: {
    source: 'account_scheduling_threshold';
    platform: string;
    window: string;
    threshold_percent: number;
    used_percent: number;
    until_unix: number;
    triggered_at_unix: number;
    window_cost_requests?: number;
    window_cost_tokens?: string;
  } = {
    source: 'account_scheduling_threshold',
    platform: input.pause.platform,
    window: input.pause.window,
    threshold_percent: input.pause.thresholdPercent,
    used_percent: Math.round(input.pause.usedPercent * 10) / 10,
    until_unix: Math.floor(input.pause.untilMs / 1000),
    triggered_at_unix: Math.floor(input.triggeredAtMs / 1000),
  };
  if (input.windowCost !== null && input.windowCost !== undefined) {
    reason.window_cost_requests = input.windowCost.requests;
    reason.window_cost_tokens = input.windowCost.tokens.toString();
  }
  return Object.freeze(reason);
}

function zeroedTriggeredAt(reason: SchedulingThresholdPauseReason): SchedulingThresholdPauseReason {
  return { ...reason, triggered_at_unix: 0 };
}

function parseReason(value: unknown): SchedulingThresholdPauseReason | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.source !== 'account_scheduling_threshold') return null;
  if (typeof record.platform !== 'string' || typeof record.window !== 'string') return null;
  const threshold = Number(record.threshold_percent);
  const used = Number(record.used_percent);
  const until = Number(record.until_unix);
  const triggered = Number(record.triggered_at_unix);
  if (![threshold, used, until, triggered].every((part) => Number.isFinite(part))) return null;
  const reason: {
    source: 'account_scheduling_threshold';
    platform: string;
    window: string;
    threshold_percent: number;
    used_percent: number;
    until_unix: number;
    triggered_at_unix: number;
    window_cost_requests?: number;
    window_cost_tokens?: string;
  } = {
    source: 'account_scheduling_threshold',
    platform: record.platform,
    window: record.window,
    threshold_percent: threshold,
    used_percent: used,
    until_unix: until,
    triggered_at_unix: triggered,
  };
  if (typeof record.window_cost_requests === 'number' && Number.isFinite(record.window_cost_requests)) {
    reason.window_cost_requests = record.window_cost_requests;
  }
  if (typeof record.window_cost_tokens === 'string' && /^([0-9]+)$/.test(record.window_cost_tokens)) {
    reason.window_cost_tokens = record.window_cost_tokens;
  }
  return Object.freeze(reason);
}

/**
 * Idempotency check (accountHasSameSchedulingThresholdPause port): the
 * stored pause matches the new decision when both `until` values agree at
 * second granularity and both reasons parse as threshold reasons that are
 * equal after zeroing `triggered_at_unix`. A match skips the rewrite.
 */
export function schedulingThresholdPauseMatches(
  stored: { readonly untilMs: number | null; readonly reason: unknown },
  pause: SchedulingThresholdPause,
  reason: SchedulingThresholdPauseReason,
): boolean {
  if (stored.untilMs === null || !Number.isFinite(stored.untilMs)) return false;
  if (Math.floor(stored.untilMs / 1000) !== Math.floor(pause.untilMs / 1000)) return false;
  const storedReason = parseReason(stored.reason);
  if (storedReason === null) return false;
  return JSON.stringify(zeroedTriggeredAt(storedReason)) === JSON.stringify(zeroedTriggeredAt(reason));
}

/** One account's persisted quota/threshold columns (the batch read row). */
export interface SchedulingThresholdAccountRow {
  readonly account_id: string;
  readonly codex_5h_used_percent: number | null;
  readonly codex_5h_reset_at: Date | string | null;
  readonly codex_7d_used_percent: number | null;
  readonly codex_7d_reset_at: Date | string | null;
  readonly codex_usage_updated_at: Date | string | null;
  readonly claude_5h_utilization: number | null;
  readonly claude_5h_reset_at: Date | string | null;
  readonly claude_7d_utilization: number | null;
  readonly claude_7d_reset_at: Date | string | null;
  readonly claude_7d_sonnet_utilization: number | null;
  readonly claude_7d_sonnet_reset_at: Date | string | null;
  readonly claude_7d_oi_utilization: number | null;
  readonly claude_7d_oi_reset_at: Date | string | null;
  readonly claude_usage_updated_at: Date | string | null;
  readonly claude_session_window_start: Date | string | null;
  readonly gemini_shared_daily_used: number | null;
  readonly gemini_shared_daily_limit: number | null;
  readonly gemini_pro_daily_used: number | null;
  readonly gemini_pro_daily_limit: number | null;
  readonly gemini_flash_daily_used: number | null;
  readonly gemini_flash_daily_limit: number | null;
  readonly gemini_daily_reset_at: Date | string | null;
  readonly gemini_usage_updated_at: Date | string | null;
  readonly opencode_go_rolling_5h_used_percent: number | null;
  readonly opencode_go_rolling_5h_reset_at: Date | string | null;
  readonly opencode_go_weekly_used_percent: number | null;
  readonly opencode_go_weekly_reset_at: Date | string | null;
  readonly opencode_go_monthly_used_percent: number | null;
  readonly opencode_go_monthly_reset_at: Date | string | null;
  readonly opencode_go_usage_updated_at: Date | string | null;
  readonly zhipu_5h_used_percent: number | null;
  readonly zhipu_5h_reset_at: Date | string | null;
  readonly zhipu_weekly_used_percent: number | null;
  readonly zhipu_weekly_reset_at: Date | string | null;
  readonly zhipu_usage_updated_at: Date | string | null;
  readonly minimax_5h_used_percent: number | null;
  readonly minimax_5h_reset_at: Date | string | null;
  readonly minimax_weekly_used_percent: number | null;
  readonly minimax_weekly_reset_at: Date | string | null;
  readonly minimax_usage_updated_at: Date | string | null;
  readonly kimi_5h_used_percent?: number | null;
  readonly kimi_5h_reset_at?: Date | string | null;
  readonly kimi_weekly_used_percent?: number | null;
  readonly kimi_weekly_reset_at?: Date | string | null;
  readonly kimi_usage_updated_at?: Date | string | null;
  /* Migration 119 (batch 3 grok): the quota-header-observed 5h token window. */
  readonly grok_5h_used_percent: number | null;
  readonly grok_5h_reset_at: Date | string | null;
  readonly grok_usage_updated_at: Date | string | null;
  readonly auto_pause_5h_threshold: number | null;
  readonly auto_pause_7d_threshold: number | null;
}

function timestampMs(value: Date | string | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumber(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function familyFresh(updatedAt: Date | string | null, nowMs: number): boolean {
  const updatedMs = timestampMs(updatedAt);
  return updatedMs !== null && nowMs - updatedMs <= SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS;
}

function validThreshold(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value < 100 ? value : null;
}

/**
 * Builds the window candidates from one account's persisted columns. Only
 * families with a fresh snapshot (their `usage_updated_at` within the
 * staleness bound) contribute; an absent threshold disables that family's
 * windows entirely — the dormant default produces zero candidates.
 */
export function schedulingThresholdCandidatesFromRow(
  row: SchedulingThresholdAccountRow,
  nowMs: number,
): SchedulingThresholdWindowCandidate[] {
  const candidates: SchedulingThresholdWindowCandidate[] = [];
  const threshold5h = validThreshold(row.auto_pause_5h_threshold);
  const threshold7d = validThreshold(row.auto_pause_7d_threshold);

  const push = (
    platform: SchedulingThresholdPlatform,
    window: string,
    usedPercent: number | null,
    untilMs: number | null,
    threshold: number | null,
  ): void => {
    if (threshold === null || usedPercent === null || untilMs === null) return;
    candidates.push({ platform, window, usedPercent, untilMs, thresholdPercent: threshold });
  };

  if (threshold5h !== null && familyFresh(row.codex_usage_updated_at, nowMs)) {
    push('codex', '5h', finiteNumber(row.codex_5h_used_percent), timestampMs(row.codex_5h_reset_at), threshold5h);
    push('codex', '7d', finiteNumber(row.codex_7d_used_percent), timestampMs(row.codex_7d_reset_at), threshold7d);
  }
  if (threshold5h !== null || threshold7d !== null) {
    if (familyFresh(row.claude_usage_updated_at, nowMs)) {
      // The claude columns carry utilization fractions (0..1+); percent = fraction × 100.
      const utilizationPercent = (value: number | null): number | null => {
        const fraction = finiteNumber(value);
        return fraction === null ? null : fraction * 100;
      };
      push(
        'claude',
        '5h',
        utilizationPercent(row.claude_5h_utilization),
        timestampMs(row.claude_5h_reset_at),
        threshold5h,
      );
      push(
        'claude',
        '7d',
        utilizationPercent(row.claude_7d_utilization),
        timestampMs(row.claude_7d_reset_at),
        threshold7d,
      );
      push(
        'claude',
        '7d_sonnet',
        utilizationPercent(row.claude_7d_sonnet_utilization),
        timestampMs(row.claude_7d_sonnet_reset_at),
        threshold7d,
      );
      push(
        'claude',
        '7d_oi',
        utilizationPercent(row.claude_7d_oi_utilization),
        timestampMs(row.claude_7d_oi_reset_at),
        threshold7d,
      );
    }
    if (familyFresh(row.gemini_usage_updated_at, nowMs) && threshold7d !== null) {
      // Gemini daily windows are request counts against a tier limit;
      // limit <= 0 (or NULL) means the window does not apply.
      const countPercent = (used: number | null, limit: number | null): number | null => {
        const usedCount = finiteNumber(used);
        const limitCount = finiteNumber(limit);
        if (usedCount === null || limitCount === null || limitCount <= 0) return null;
        return (usedCount / limitCount) * 100;
      };
      push(
        'gemini',
        'shared_daily',
        countPercent(row.gemini_shared_daily_used, row.gemini_shared_daily_limit),
        timestampMs(row.gemini_daily_reset_at),
        threshold7d,
      );
      push(
        'gemini',
        'pro_daily',
        countPercent(row.gemini_pro_daily_used, row.gemini_pro_daily_limit),
        timestampMs(row.gemini_daily_reset_at),
        threshold7d,
      );
      push(
        'gemini',
        'flash_daily',
        countPercent(row.gemini_flash_daily_used, row.gemini_flash_daily_limit),
        timestampMs(row.gemini_daily_reset_at),
        threshold7d,
      );
    }
    if (familyFresh(row.opencode_go_usage_updated_at, nowMs)) {
      push(
        'opencode-go',
        'rolling_5h',
        finiteNumber(row.opencode_go_rolling_5h_used_percent),
        timestampMs(row.opencode_go_rolling_5h_reset_at),
        threshold5h,
      );
      push(
        'opencode-go',
        'weekly',
        finiteNumber(row.opencode_go_weekly_used_percent),
        timestampMs(row.opencode_go_weekly_reset_at),
        threshold7d,
      );
      push(
        'opencode-go',
        'monthly',
        finiteNumber(row.opencode_go_monthly_used_percent),
        timestampMs(row.opencode_go_monthly_reset_at),
        threshold7d,
      );
    }
    // Batch-3 CN providers (migration 120): the coding-plan quota worker
    // writes the 5h/rolling + weekly windows as used percents. payg accounts
    // never get snapshots, so they contribute nothing by construction.
    if (familyFresh(row.zhipu_usage_updated_at, nowMs)) {
      push('zhipu', '5h', finiteNumber(row.zhipu_5h_used_percent), timestampMs(row.zhipu_5h_reset_at), threshold5h);
      push(
        'zhipu',
        'weekly',
        finiteNumber(row.zhipu_weekly_used_percent),
        timestampMs(row.zhipu_weekly_reset_at),
        threshold7d,
      );
    }
    if (familyFresh(row.minimax_usage_updated_at, nowMs)) {
      push(
        'minimax',
        '5h',
        finiteNumber(row.minimax_5h_used_percent),
        timestampMs(row.minimax_5h_reset_at),
        threshold5h,
      );
      push(
        'minimax',
        'weekly',
        finiteNumber(row.minimax_weekly_used_percent),
        timestampMs(row.minimax_weekly_reset_at),
        threshold7d,
      );
    }
    // Batch-3 Grok (migration 119): the quota-header observer writes the 5h
    // token window (upstream-observed used percent, never extrapolated). An
    // account whose 429 cooldown is live is already excluded by the
    // eligibility SQL; this family contributes only the auto-pause threshold
    // port of the sub2api grok scheduling semantics.
    if (familyFresh(row.grok_usage_updated_at, nowMs)) {
      push('grok', '5h', finiteNumber(row.grok_5h_used_percent), timestampMs(row.grok_5h_reset_at), threshold5h);
    }
  }
  const kimiObservedAt = timestampMs(row.kimi_usage_updated_at ?? null);
  if (kimiObservedAt !== null && kimiObservedAt <= nowMs && familyFresh(row.kimi_usage_updated_at ?? null, nowMs)) {
    // Persisted pauses must expire when the observation goes stale even if
    // a weekly reset is days away. A later successful poll can extend them.
    const until = (reset: Date | string | null | undefined): number | null => {
      const resetMs = timestampMs(reset ?? null);
      return resetMs === null ? null : Math.min(resetMs, kimiObservedAt + SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS);
    };
    push('kimi', '5h', finiteNumber(row.kimi_5h_used_percent ?? null), until(row.kimi_5h_reset_at), threshold5h ?? 100);
    push(
      'kimi',
      'weekly',
      finiteNumber(row.kimi_weekly_used_percent ?? null),
      until(row.kimi_weekly_reset_at),
      threshold7d ?? 100,
    );
  }
  return candidates;
}

/**
 * The window-cost aggregation start for one account (the sub2api
 * GetCurrentWindowStartTime port): the claude session-window start when it
 * is still open, else the current hour truncated (the same prediction the
 * session-window writer uses when no reset header has been observed).
 */
export function schedulingThresholdWindowStartMs(
  row: Pick<SchedulingThresholdAccountRow, 'claude_session_window_start'>,
  nowMs: number,
): number {
  const startMs = timestampMs(row.claude_session_window_start);
  if (startMs !== null) {
    // A session window spans 5h; a stored start is only trustworthy while
    // its implied end is still in the future.
    if (startMs + 5 * 60 * 60 * 1000 > nowMs) return startMs;
  }
  return Math.floor(nowMs / (60 * 60 * 1000)) * 60 * 60 * 1000;
}
