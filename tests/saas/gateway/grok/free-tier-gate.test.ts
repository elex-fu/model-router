import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROK_FREE_ROLLING_24H_TOKEN_LIMIT,
  GROK_FREE_SOFT_GATE_FRACTION,
} from '../../../../src/saas/gateway/grok/constants.js';
import {
  evaluateGrokFreeTierGate,
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
