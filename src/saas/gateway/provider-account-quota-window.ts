import {
  classifyQuotaPauseWindows,
  type QuotaPauseDecision,
  type QuotaWindowPauseSnapshot,
} from './oauth-subscription/quota-pause.js';

/** The normalized scheduling signal derived from one account's persisted quota windows. */
export interface ProviderAccountQuotaWindowSignal {
  /** Minimum remaining ratio across the account's usable windows; null means unknown/stale. */
  readonly remainingRatio: number | null;
  /** The shared 100%-pause/reset/stale decision, before the core scheduler's affinity pass. */
  readonly decision: QuotaPauseDecision;
}

type Row = Readonly<Record<string, unknown>>;

function timestampMs(value: unknown): number | null {
  const parsed = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function percentWindow(usedPercent: unknown, resetAt: unknown): QuotaWindowPauseSnapshot {
  return { usedPercent: finiteNonNegative(usedPercent), resetAtMs: timestampMs(resetAt) };
}

function claudeWindow(utilization: unknown, resetAt: unknown): QuotaWindowPauseSnapshot {
  const fraction = finiteNonNegative(utilization);
  return { usedPercent: fraction === null ? null : fraction * 100, resetAtMs: timestampMs(resetAt) };
}

function geminiWindow(row: Row, usedKey: string, limitKey: string): QuotaWindowPauseSnapshot {
  const used = finiteNonNegative(row[usedKey]);
  const limit = finiteNonNegative(row[limitKey]);
  return {
    usedPercent: used === null || limit === null || limit <= 0 ? null : (used / limit) * 100,
    resetAtMs: timestampMs(row.account_gemini_daily_reset_at),
  };
}

/**
 * Normalizes codex percent, Claude utilization-fraction, and Gemini count
 * windows into one least-remaining signal. The shared classifier is the only
 * pause authority: a live 100% window pauses, an elapsed reset does not, and
 * a stale family returns probe-allowed instead of contributing a ratio.
 */
export function resolveProviderAccountQuotaWindow(
  row: Row,
  nowMs: number,
  snapshotMaxAgeMs: number,
): ProviderAccountQuotaWindowSignal {
  const families: readonly { readonly observedAtMs: number; readonly windows: readonly QuotaWindowPauseSnapshot[] }[] =
    [
      {
        observedAtMs: timestampMs(row.account_codex_usage_updated_at) ?? Number.NaN,
        windows: [
          percentWindow(row.account_codex_5h_used_percent, row.account_codex_5h_reset_at),
          percentWindow(row.account_codex_7d_used_percent, row.account_codex_7d_reset_at),
        ],
      },
      {
        observedAtMs: timestampMs(row.account_claude_usage_updated_at) ?? Number.NaN,
        windows: [
          claudeWindow(row.account_claude_5h_utilization, row.account_claude_5h_reset_at),
          claudeWindow(row.account_claude_7d_utilization, row.account_claude_7d_reset_at),
          claudeWindow(row.account_claude_7d_sonnet_utilization, row.account_claude_7d_sonnet_reset_at),
          claudeWindow(row.account_claude_7d_oi_utilization, row.account_claude_7d_oi_reset_at),
        ],
      },
      {
        observedAtMs: timestampMs(row.account_gemini_usage_updated_at) ?? Number.NaN,
        windows: [
          geminiWindow(row, 'account_gemini_shared_daily_used', 'account_gemini_shared_daily_limit'),
          geminiWindow(row, 'account_gemini_pro_daily_used', 'account_gemini_pro_daily_limit'),
          geminiWindow(row, 'account_gemini_flash_daily_used', 'account_gemini_flash_daily_limit'),
        ],
      },
    ];

  let remainingRatio: number | null = null;
  let sawFreshFamily = false;
  for (const family of families) {
    const decision = classifyQuotaPauseWindows(
      family,
      family.windows.map(() => 100),
      nowMs,
      snapshotMaxAgeMs,
    );
    if (decision === 'paused') return { remainingRatio: 0, decision };
    if (decision === 'probe-allowed') continue;
    sawFreshFamily = true;
    for (const window of family.windows) {
      if (window.usedPercent === null) continue;
      // classifyQuotaPauseWindows treats an elapsed reset as replenished. Its
      // remaining ratio is therefore full, never the persisted 0% remainder.
      const windowRatio =
        window.resetAtMs !== null && window.resetAtMs <= nowMs ? 1 : Math.max(0, 1 - window.usedPercent / 100);
      remainingRatio = remainingRatio === null ? windowRatio : Math.min(remainingRatio, windowRatio);
    }
  }
  return { remainingRatio, decision: sawFreshFamily ? 'active' : 'probe-allowed' };
}
