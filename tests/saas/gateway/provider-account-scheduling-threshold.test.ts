import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSchedulingThresholdPauseReason,
  evaluateSchedulingThresholdPause,
  SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS,
  type SchedulingThresholdAccountRow,
  schedulingThresholdCandidatesFromRow,
  schedulingThresholdPauseMatches,
  schedulingThresholdWindowStartMs,
} from '../../../src/saas/gateway/provider-account-scheduling-threshold.js';

const NOW_MS = 1_700_000_000_000;
const IN_1H = NOW_MS + 60 * 60 * 1000;
const IN_3H = NOW_MS + 3 * 60 * 60 * 1000;
const IN_2D = NOW_MS + 2 * 24 * 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function baseRow(overrides: Partial<SchedulingThresholdAccountRow> = {}): SchedulingThresholdAccountRow {
  return {
    account_id: 'account-a',
    codex_5h_used_percent: null,
    codex_5h_reset_at: null,
    codex_7d_used_percent: null,
    codex_7d_reset_at: null,
    codex_usage_updated_at: null,
    claude_5h_utilization: null,
    claude_5h_reset_at: null,
    claude_7d_utilization: null,
    claude_7d_reset_at: null,
    claude_7d_sonnet_utilization: null,
    claude_7d_sonnet_reset_at: null,
    claude_7d_oi_utilization: null,
    claude_7d_oi_reset_at: null,
    claude_usage_updated_at: null,
    claude_session_window_start: null,
    gemini_shared_daily_used: null,
    gemini_shared_daily_limit: null,
    gemini_pro_daily_used: null,
    gemini_pro_daily_limit: null,
    gemini_flash_daily_used: null,
    gemini_flash_daily_limit: null,
    gemini_daily_reset_at: null,
    gemini_usage_updated_at: null,
    opencode_go_rolling_5h_used_percent: null,
    opencode_go_rolling_5h_reset_at: null,
    opencode_go_weekly_used_percent: null,
    opencode_go_weekly_reset_at: null,
    opencode_go_monthly_used_percent: null,
    opencode_go_monthly_reset_at: null,
    opencode_go_usage_updated_at: null,
    zhipu_5h_used_percent: null,
    zhipu_5h_reset_at: null,
    zhipu_weekly_used_percent: null,
    zhipu_weekly_reset_at: null,
    zhipu_usage_updated_at: null,
    minimax_5h_used_percent: null,
    minimax_5h_reset_at: null,
    minimax_weekly_used_percent: null,
    minimax_weekly_reset_at: null,
    minimax_usage_updated_at: null,
    grok_5h_used_percent: null,
    grok_5h_reset_at: null,
    grok_usage_updated_at: null,
    auto_pause_5h_threshold: null,
    auto_pause_7d_threshold: null,
    ...overrides,
  };
}

test('Kimi exhaustion uses the existing pause gate without operator thresholds and expires with freshness/reset', () => {
  const row = baseRow({
    kimi_5h_used_percent: 100,
    kimi_5h_reset_at: iso(IN_1H),
    kimi_weekly_used_percent: 100,
    kimi_weekly_reset_at: iso(IN_2D),
    kimi_usage_updated_at: iso(NOW_MS),
  });
  const pause = evaluateSchedulingThresholdPause({
    nowMs: NOW_MS,
    candidates: schedulingThresholdCandidatesFromRow(row, NOW_MS),
  });
  assert.equal(pause?.platform, 'kimi');
  assert.equal(pause?.window, 'weekly');
  assert.equal(pause?.thresholdPercent, 100);
  assert.equal(pause?.untilMs, NOW_MS + SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS);
  assert.equal(
    evaluateSchedulingThresholdPause({
      nowMs: NOW_MS + SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS + 1,
      candidates: schedulingThresholdCandidatesFromRow(row, NOW_MS + SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS + 1),
    }),
    null,
  );
  const reset = baseRow({ ...row, kimi_weekly_used_percent: null, kimi_5h_reset_at: iso(NOW_MS) });
  assert.equal(
    evaluateSchedulingThresholdPause({
      nowMs: NOW_MS,
      candidates: schedulingThresholdCandidatesFromRow(reset, NOW_MS),
    }),
    null,
  );
  assert.deepEqual(schedulingThresholdCandidatesFromRow(baseRow({ ...row, kimi_usage_updated_at: null }), NOW_MS), []);
});

test('Kimi honors an operator early-pause threshold and missing reset never guesses a horizon', () => {
  const row = baseRow({ kimi_5h_used_percent: 85, kimi_5h_reset_at: iso(IN_1H), kimi_usage_updated_at: iso(NOW_MS) });
  assert.equal(
    evaluateSchedulingThresholdPause({ nowMs: NOW_MS, candidates: schedulingThresholdCandidatesFromRow(row, NOW_MS) }),
    null,
  );
  const pause = evaluateSchedulingThresholdPause({
    nowMs: NOW_MS,
    candidates: schedulingThresholdCandidatesFromRow({ ...row, auto_pause_5h_threshold: 80 }, NOW_MS),
  });
  assert.equal(pause?.thresholdPercent, 80);
  assert.equal(pause?.untilMs, IN_1H);
  assert.deepEqual(schedulingThresholdCandidatesFromRow({ ...row, kimi_5h_reset_at: null }, NOW_MS), []);
});

test('a window at or above its threshold with a future reset pauses until that reset', () => {
  const pause = evaluateSchedulingThresholdPause({
    nowMs: NOW_MS,
    candidates: [{ platform: 'codex', window: '5h', usedPercent: 95, untilMs: IN_3H, thresholdPercent: 90 }],
  });
  assert.ok(pause !== null);
  assert.equal(pause.platform, 'codex');
  assert.equal(pause.window, '5h');
  assert.equal(pause.thresholdPercent, 90);
  assert.equal(pause.usedPercent, 95);
  assert.equal(pause.untilMs, IN_3H);
});

test('the winner is the latest breaching reset, ties broken by the higher used percent', () => {
  const pause = evaluateSchedulingThresholdPause({
    nowMs: NOW_MS,
    candidates: [
      { platform: 'codex', window: '5h', usedPercent: 99, untilMs: IN_3H, thresholdPercent: 90 },
      { platform: 'codex', window: '7d', usedPercent: 92, untilMs: IN_2D, thresholdPercent: 90 },
    ],
  });
  assert.ok(pause !== null);
  assert.equal(pause.window, '7d');
  assert.equal(pause.untilMs, IN_2D);

  const tie = evaluateSchedulingThresholdPause({
    nowMs: NOW_MS,
    candidates: [
      { platform: 'claude', window: '5h', usedPercent: 91, untilMs: IN_3H, thresholdPercent: 90 },
      { platform: 'claude', window: '7d', usedPercent: 95, untilMs: IN_3H, thresholdPercent: 90 },
    ],
  });
  assert.ok(tie !== null);
  assert.equal(tie.window, '7d');
  assert.equal(tie.usedPercent, 95);
});

test('candidates below threshold, with elapsed resets, or without a threshold never pause', () => {
  assert.equal(
    evaluateSchedulingThresholdPause({
      nowMs: NOW_MS,
      candidates: [{ platform: 'codex', window: '5h', usedPercent: 89.9, untilMs: IN_3H, thresholdPercent: 90 }],
    }),
    null,
  );
  assert.equal(
    evaluateSchedulingThresholdPause({
      nowMs: NOW_MS,
      candidates: [{ platform: 'codex', window: '5h', usedPercent: 99, untilMs: NOW_MS - 1, thresholdPercent: 90 }],
    }),
    null,
  );
  // 100 disables the gate; <1 is invalid (the 099 CHECK allows 1..100).
  assert.equal(
    evaluateSchedulingThresholdPause({
      nowMs: NOW_MS,
      candidates: [{ platform: 'codex', window: '5h', usedPercent: 99.5, untilMs: IN_3H, thresholdPercent: 100 }],
    }),
    null,
  );
  assert.equal(
    evaluateSchedulingThresholdPause({
      nowMs: NOW_MS,
      candidates: [{ platform: 'codex', window: '5h', usedPercent: 99.5, untilMs: IN_3H, thresholdPercent: 0 }],
    }),
    null,
  );
  assert.equal(evaluateSchedulingThresholdPause({ nowMs: NOW_MS, candidates: [] }), null);
});

test('candidate rows map each column family with its unit and staleness rules', () => {
  // codex percent columns; fresh snapshot; both families configured.
  const codex = schedulingThresholdCandidatesFromRow(
    baseRow({
      codex_5h_used_percent: 95,
      codex_5h_reset_at: iso(IN_3H),
      codex_7d_used_percent: 42,
      codex_7d_reset_at: iso(IN_2D),
      codex_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_5h_threshold: 90,
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(codex.length, 2);
  assert.deepEqual(
    codex.map((candidate) => [candidate.platform, candidate.window, candidate.usedPercent]),
    [
      ['codex', '5h', 95],
      ['codex', '7d', 42],
    ],
  );

  // claude utilization fractions multiply into percent.
  const claude = schedulingThresholdCandidatesFromRow(
    baseRow({
      claude_5h_utilization: 0.93,
      claude_5h_reset_at: iso(IN_3H),
      claude_7d_utilization: 0.5,
      claude_7d_reset_at: iso(IN_2D),
      claude_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_5h_threshold: 90,
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(claude.length, 2);
  assert.ok(Math.abs((claude[0]?.usedPercent ?? 0) - 93) < 1e-9);
  assert.ok(Math.abs((claude[1]?.usedPercent ?? 0) - 50) < 1e-9);

  // gemini daily request counts fold into percent against the tier limit;
  // unlimited (-1) and absent limits produce no candidate.
  const gemini = schedulingThresholdCandidatesFromRow(
    baseRow({
      gemini_shared_daily_used: 190,
      gemini_shared_daily_limit: 200,
      gemini_pro_daily_used: 10,
      gemini_pro_daily_limit: -1,
      gemini_flash_daily_used: 5,
      gemini_flash_daily_limit: null,
      gemini_daily_reset_at: iso(IN_2D),
      gemini_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(gemini.length, 1);
  assert.equal(gemini[0]?.window, 'shared_daily');
  assert.ok(Math.abs((gemini[0]?.usedPercent ?? 0) - 95) < 1e-9);

  // opencode-go percent columns split across the two threshold families.
  const opencode = schedulingThresholdCandidatesFromRow(
    baseRow({
      opencode_go_rolling_5h_used_percent: 96,
      opencode_go_rolling_5h_reset_at: iso(IN_3H),
      opencode_go_weekly_used_percent: 30,
      opencode_go_weekly_reset_at: iso(IN_2D),
      opencode_go_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_5h_threshold: 90,
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(opencode.length, 2);
  assert.equal(opencode[0]?.window, 'rolling_5h');
  assert.equal(opencode[1]?.window, 'weekly');

  // Batch-3 CN providers (migration 120): the coding-plan quota worker's
  // percent families split across the same two threshold families.
  const zhipu = schedulingThresholdCandidatesFromRow(
    baseRow({
      zhipu_5h_used_percent: 91,
      zhipu_5h_reset_at: iso(IN_3H),
      zhipu_weekly_used_percent: 25,
      zhipu_weekly_reset_at: iso(IN_2D),
      zhipu_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_5h_threshold: 90,
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(zhipu.length, 2);
  assert.equal(zhipu[0]?.platform, 'zhipu');
  assert.equal(zhipu[0]?.window, '5h');
  assert.equal(zhipu[1]?.window, 'weekly');

  const minimax = schedulingThresholdCandidatesFromRow(
    baseRow({
      minimax_5h_used_percent: 50,
      minimax_5h_reset_at: iso(IN_3H),
      minimax_weekly_used_percent: 82,
      minimax_weekly_reset_at: iso(IN_2D),
      minimax_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_5h_threshold: 90,
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(minimax.length, 2);
  assert.equal(minimax[0]?.platform, 'minimax');
  assert.equal(minimax[0]?.window, '5h');
  assert.equal(minimax[1]?.window, 'weekly');
  // payg accounts never get snapshots: a NULL family contributes nothing.
  assert.equal(
    schedulingThresholdCandidatesFromRow(baseRow({ auto_pause_5h_threshold: 90, auto_pause_7d_threshold: 80 }), NOW_MS)
      .length,
    0,
  );

  // Migration 119 (batch 3 grok; core-plan 9.1): the 5h token window joins
  // the threshold families — auto_pause_5h_threshold gates it, a fresh
  // grok_usage_updated_at is required, and the 429 cooldown is NOT a window
  // here (it is consumed by the eligibility SQL).
  const grok = schedulingThresholdCandidatesFromRow(
    baseRow({
      grok_5h_used_percent: 96,
      grok_5h_reset_at: iso(IN_3H),
      grok_usage_updated_at: iso(NOW_MS - 60_000),
      auto_pause_5h_threshold: 90,
      auto_pause_7d_threshold: 80,
    }),
    NOW_MS,
  );
  assert.equal(grok.length, 1);
  assert.equal(grok[0]?.platform, 'grok');
  assert.equal(grok[0]?.window, '5h');
  const grokPause = evaluateSchedulingThresholdPause({ nowMs: NOW_MS, candidates: grok });
  assert.ok(grokPause !== null);
  assert.equal(grokPause.platform, 'grok');
});

test('a grok window without a configured threshold contributes nothing (dormant default)', () => {
  assert.equal(
    schedulingThresholdCandidatesFromRow(
      baseRow({
        grok_5h_used_percent: 96,
        grok_5h_reset_at: iso(IN_3H),
        grok_usage_updated_at: iso(NOW_MS - 60_000),
      }),
      NOW_MS,
    ).length,
    0,
  );
  // Stale grok snapshot contributes nothing either.
  assert.equal(
    schedulingThresholdCandidatesFromRow(
      baseRow({
        grok_5h_used_percent: 96,
        grok_5h_reset_at: iso(IN_3H),
        grok_usage_updated_at: iso(NOW_MS - SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS - 1),
        auto_pause_5h_threshold: 90,
      }),
      NOW_MS,
    ).length,
    0,
  );
});

test('stale snapshots contribute no candidates; absent thresholds contribute none either (dormant default)', () => {
  assert.equal(
    schedulingThresholdCandidatesFromRow(
      baseRow({
        codex_5h_used_percent: 95,
        codex_5h_reset_at: iso(IN_3H),
        codex_usage_updated_at: iso(NOW_MS - SCHEDULING_THRESHOLD_SNAPSHOT_MAX_AGE_MS - 1),
        auto_pause_5h_threshold: 90,
      }),
      NOW_MS,
    ).length,
    0,
  );
  // Fresh snapshot but no threshold configured: the pre-activation behavior.
  assert.equal(
    schedulingThresholdCandidatesFromRow(
      baseRow({
        codex_5h_used_percent: 99,
        codex_5h_reset_at: iso(IN_3H),
        codex_usage_updated_at: iso(NOW_MS),
      }),
      NOW_MS,
    ).length,
    0,
  );
  // A 5h threshold alone does not gate the 7d family.
  const only5h = schedulingThresholdCandidatesFromRow(
    baseRow({
      codex_5h_used_percent: 95,
      codex_5h_reset_at: iso(IN_3H),
      codex_7d_used_percent: 99,
      codex_7d_reset_at: iso(IN_2D),
      codex_usage_updated_at: iso(NOW_MS),
      auto_pause_5h_threshold: 90,
    }),
    NOW_MS,
  );
  assert.equal(only5h.length, 1);
  assert.equal(only5h[0]?.window, '5h');
});

test('the reason JSON carries the sub2api temp-unsched shape and matches idempotently', () => {
  const pause = {
    platform: 'codex' as const,
    window: '5h',
    thresholdPercent: 90,
    usedPercent: 95,
    untilMs: IN_3H,
  };
  const reason = buildSchedulingThresholdPauseReason({ pause, triggeredAtMs: NOW_MS });
  assert.equal(reason.source, 'account_scheduling_threshold');
  assert.equal(reason.until_unix, Math.floor(IN_3H / 1000));
  assert.equal(reason.triggered_at_unix, Math.floor(NOW_MS / 1000));
  assert.equal(reason.used_percent, 95);

  // Same decision re-triggered later: equal after zeroing triggered_at_unix.
  const later = buildSchedulingThresholdPauseReason({ pause, triggeredAtMs: NOW_MS + 5_000 });
  assert.ok(schedulingThresholdPauseMatches({ untilMs: IN_3H, reason: later }, pause, reason));
  // A different window or threshold breaks the match.
  assert.equal(
    schedulingThresholdPauseMatches(
      {
        untilMs: IN_3H,
        reason: buildSchedulingThresholdPauseReason({ pause: { ...pause, window: '7d' }, triggeredAtMs: NOW_MS }),
      },
      pause,
      reason,
    ),
    false,
  );
  assert.equal(
    schedulingThresholdPauseMatches(
      {
        untilMs: IN_3H,
        reason: buildSchedulingThresholdPauseReason({
          pause: { ...pause, thresholdPercent: 80 },
          triggeredAtMs: NOW_MS,
        }),
      },
      pause,
      reason,
    ),
    false,
  );
  // Second-granularity until equality: a sub-second drift still matches.
  assert.ok(schedulingThresholdPauseMatches({ untilMs: IN_3H + 500, reason: later }, pause, reason));
  // A different deadline never matches; a non-threshold reason never matches.
  assert.equal(schedulingThresholdPauseMatches({ untilMs: IN_2D, reason: later }, pause, reason), false);
  assert.equal(schedulingThresholdPauseMatches({ untilMs: IN_3H, reason: { source: 'other' } }, pause, reason), false);
  assert.equal(schedulingThresholdPauseMatches({ untilMs: null, reason: later }, pause, reason), false);

  // Window-cost enrichment participates in equality.
  const withCost = buildSchedulingThresholdPauseReason({
    pause,
    triggeredAtMs: NOW_MS,
    windowCost: { requests: 3, tokens: 12_000n },
  });
  assert.equal(withCost.window_cost_requests, 3);
  assert.equal(withCost.window_cost_tokens, '12000');
  assert.equal(schedulingThresholdPauseMatches({ untilMs: IN_3H, reason }, pause, withCost), false);
});

test('the window-cost start prefers an open claude session window and falls back to the hour', () => {
  const sessionStart = NOW_MS - 60 * 60 * 1000;
  assert.equal(
    schedulingThresholdWindowStartMs({ claude_session_window_start: iso(sessionStart) }, NOW_MS),
    sessionStart,
  );
  // A stored start whose 5h window already elapsed falls back.
  const staleStart = NOW_MS - 6 * 60 * 60 * 1000;
  assert.equal(
    schedulingThresholdWindowStartMs({ claude_session_window_start: iso(staleStart) }, NOW_MS),
    Math.floor(NOW_MS / 3_600_000) * 3_600_000,
  );
  assert.equal(
    schedulingThresholdWindowStartMs({ claude_session_window_start: null }, NOW_MS),
    Math.floor(NOW_MS / 3_600_000) * 3_600_000,
  );
});
