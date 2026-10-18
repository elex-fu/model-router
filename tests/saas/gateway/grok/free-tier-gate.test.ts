import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROK_FREE_ROLLING_24H_TOKEN_LIMIT,
  GROK_FREE_SOFT_GATE_FRACTION,
} from '../../../../src/saas/gateway/grok/constants.js';
import {
  evaluateGrokFreeTierGate,
  evaluateGrokFreeTierGateSnapshot,
  GROK_FREE_SOFT_GATE_PERCENT_FLOOR,
  GROK_FREE_SOFT_GATE_TOKEN_FLOOR,
} from '../../../../src/saas/gateway/grok/free-tier-gate.js';

test('the nominal free allowance and the 95% floor are the pinned sub2api values', () => {
  assert.equal(GROK_FREE_ROLLING_24H_TOKEN_LIMIT, 500_000);
  assert.equal(GROK_FREE_SOFT_GATE_FRACTION, 0.95);
  assert.equal(GROK_FREE_SOFT_GATE_TOKEN_FLOOR, 475_000);
});

test('free-tier soft gate decision table', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tier: string | null;
    readonly rolling24hTokens: number | null;
    readonly expected: 'admit' | 'excluded';
  }> = [
    { name: 'free at 95% of nominal is excluded', tier: 'free', rolling24hTokens: 475_000, expected: 'excluded' },
    { name: 'free above the floor is excluded', tier: 'free', rolling24hTokens: 499_999, expected: 'excluded' },
    { name: 'free just under the floor is admitted', tier: 'free', rolling24hTokens: 474_999, expected: 'admit' },
    {
      name: 'free with no usage stats is admitted (fail-open)',
      tier: 'free',
      rolling24hTokens: null,
      expected: 'admit',
    },
    { name: 'free tier alias shapes normalize', tier: 'Free-Tier', rolling24hTokens: 500_000, expected: 'excluded' },
    { name: 'supergrok is never gated', tier: 'supergrok', rolling24hTokens: 10_000_000, expected: 'admit' },
    {
      name: 'supergrok_heavy is never gated',
      tier: 'supergrok_heavy',
      rolling24hTokens: 10_000_000,
      expected: 'admit',
    },
    {
      name: 'unknown tier is never gated (conservative admit)',
      tier: 'mystery',
      rolling24hTokens: 10_000_000,
      expected: 'admit',
    },
    { name: 'missing tier is admitted', tier: null, rolling24hTokens: 10_000_000, expected: 'admit' },
    { name: 'malformed input admits (fail-open)', tier: 'free', rolling24hTokens: Number.NaN, expected: 'admit' },
  ];
  for (const { name, tier, rolling24hTokens, expected } of cases) {
    assert.equal(evaluateGrokFreeTierGate({ subscriptionTier: tier, rolling24hTokens }), expected, name);
  }
});

/* ------------------------------------------------------------------ */
/* Core-plan 9.1 (B06): the scheduler-side snapshot adapter             */
/* ------------------------------------------------------------------ */

const NOW = 1_800_000_000_000;

test('free-tier snapshot adapter: percent floor derives from the same 95% fraction', () => {
  assert.equal(GROK_FREE_SOFT_GATE_PERCENT_FLOOR, 95);
});

test('free-tier snapshot adapter decision table', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly tier: string | null;
    readonly usedPercent: number | null;
    readonly observedAtMs: number | null;
    readonly expected: 'admit' | 'excluded';
  }> = [
    {
      name: 'free at 95% observed is excluded',
      tier: 'free',
      usedPercent: 95,
      observedAtMs: NOW - 1_000,
      expected: 'excluded',
    },
    {
      name: 'free above the floor is excluded',
      tier: 'free',
      usedPercent: 100,
      observedAtMs: NOW - 1_000,
      expected: 'excluded',
    },
    {
      name: 'free just under the floor is admitted',
      tier: 'free',
      usedPercent: 94.9,
      observedAtMs: NOW - 1_000,
      expected: 'admit',
    },
    {
      name: 'free with never-observed percent is admitted (fail-open)',
      tier: 'free',
      usedPercent: null,
      observedAtMs: NOW - 1_000,
      expected: 'admit',
    },
    {
      name: 'free with stale snapshot is admitted (fail-open)',
      tier: 'free',
      usedPercent: 100,
      observedAtMs: NOW - 2 * 60 * 60 * 1000 - 1,
      expected: 'admit',
    },
    {
      name: 'free with snapshot exactly at the freshness bound is evaluated',
      tier: 'free',
      usedPercent: 100,
      observedAtMs: NOW - 2 * 60 * 60 * 1000,
      expected: 'excluded',
    },
    {
      name: 'free with never-observed snapshot is admitted (fail-open)',
      tier: 'free',
      usedPercent: 100,
      observedAtMs: null,
      expected: 'admit',
    },
    {
      name: 'free tier alias normalizes',
      tier: 'Free-Tier',
      usedPercent: 96,
      observedAtMs: NOW - 1_000,
      expected: 'excluded',
    },
    {
      name: 'supergrok is never gated',
      tier: 'supergrok',
      usedPercent: 100,
      observedAtMs: NOW - 1_000,
      expected: 'admit',
    },
    { name: 'missing tier is admitted', tier: null, usedPercent: 100, observedAtMs: NOW - 1_000, expected: 'admit' },
    {
      name: 'malformed percent admits (fail-open)',
      tier: 'free',
      usedPercent: Number.NaN,
      observedAtMs: NOW - 1_000,
      expected: 'admit',
    },
  ];
  for (const { name, tier, usedPercent, observedAtMs, expected } of cases) {
    assert.equal(
      evaluateGrokFreeTierGateSnapshot({
        subscriptionTier: tier,
        observedUsedPercent: usedPercent,
        observedAtMs,
        nowMs: NOW,
      }),
      expected,
      name,
    );
  }
});
