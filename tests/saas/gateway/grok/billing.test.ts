import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGrokBillingUrl,
  fetchGrokBillingWindow,
  type GrokBillingSummary,
  grokPlanFromMonthlyLimitCents,
  mergeGrokBillingProbeResult,
  parseGrokBillingPayload,
} from '../../../../src/saas/gateway/grok/billing.js';
import { GROK_OAUTH_DEFAULT_BASE_URL } from '../../../../src/saas/gateway/grok/constants.js';

test('billing URLs pin the weekly credits and monthly paths on the CLI proxy base', () => {
  assert.equal(GROK_OAUTH_DEFAULT_BASE_URL, 'https://cli-chat-proxy.grok.com/v1');
  assert.equal(
    buildGrokBillingUrl(GROK_OAUTH_DEFAULT_BASE_URL, true),
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  );
  assert.equal(buildGrokBillingUrl(GROK_OAUTH_DEFAULT_BASE_URL, false), 'https://cli-chat-proxy.grok.com/v1/billing');
  assert.equal(
    buildGrokBillingUrl('https://custom.example.com/prefix/', false),
    'https://custom.example.com/prefix/billing',
  );
});

test('monthly limit cents identify SuperGrok ($150) and SuperGrok Heavy ($1500)', () => {
  assert.equal(grokPlanFromMonthlyLimitCents(15_000), 'supergrok');
  assert.equal(grokPlanFromMonthlyLimitCents(150_000), 'supergrok_heavy');
  // Float noise is tolerated; other limits identify nothing.
  assert.equal(grokPlanFromMonthlyLimitCents(15_000.4), 'supergrok');
  assert.equal(grokPlanFromMonthlyLimitCents(5_000), null);
  assert.equal(grokPlanFromMonthlyLimitCents(null), null);
});

test('weekly credits config parses into the normalized summary', () => {
  const summary = parseGrokBillingPayload({
    config: {
      currentPeriod: { type: 'WEEKLY', start: '2026-10-13', end: '2026-10-20' },
      creditUsagePercent: 42.5,
      productUsage: [
        { product: 'grok-cli', usagePercent: 10 },
        { product: '', usagePercent: 1 },
      ],
      prepaidBalance: { val: 12 },
    },
  });
  assert.ok(summary);
  assert.equal(summary.periodType, 'weekly');
  assert.equal(summary.usagePercent, 42.5);
  assert.equal(summary.periodStart, '2026-10-13');
  assert.equal(summary.periodEnd, '2026-10-20');
  assert.equal(summary.monthlyLimitCents, null);
});

test('monthly config parses limit/used and identifies the plan', () => {
  const summary = parseGrokBillingPayload({
    config: {
      monthlyLimit: '15000',
      used: { val: 3000 },
      billingPeriodStart: '2026-10-01',
      billingPeriodEnd: '2026-10-31',
    },
  });
  assert.ok(summary);
  assert.equal(summary.periodType, 'monthly');
  assert.equal(summary.monthlyLimitCents, 15_000);
  assert.equal(summary.usedCents, 3_000);
  assert.equal(summary.usedPercent, 20);
  assert.equal(summary.plan, 'supergrok');
});

test('config with neither weekly nor monthly signal is null', () => {
  assert.equal(parseGrokBillingPayload({ config: {} }), null);
  assert.equal(parseGrokBillingPayload({}), null);
  assert.equal(parseGrokBillingPayload(null), null);
});

test('merge keeps the previous window on failure and reports partial', () => {
  const weekly = parseGrokBillingPayload({
    config: { currentPeriod: { type: 'weekly', start: 'w-s', end: 'w-e' }, creditUsagePercent: 55 },
  });
  const monthly = parseGrokBillingPayload({ config: { monthlyLimit: 150000, used: 75000 } });
  const merged = mergeGrokBillingProbeResult(null, weekly, monthly, { weeklyOk: true, monthlyOk: true });
  assert.ok(merged);
  assert.equal(merged.usagePercent, 55);
  assert.equal(merged.monthlyLimitCents, 150_000);
  assert.equal(merged.usedPercent, 50);
  assert.equal(merged.plan, 'supergrok_heavy');
  assert.equal(merged.partial, false);
  assert.deepEqual(merged.failedWindows, []);

  // A failed monthly window keeps the previous values and flags partial.
  const partial = mergeGrokBillingProbeResult(merged, weekly, null, { weeklyOk: true, monthlyOk: false });
  assert.ok(partial);
  assert.equal(partial.monthlyLimitCents, 150_000);
  assert.equal(partial.plan, 'supergrok_heavy');
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.failedWindows, ['monthly']);

  // Both windows failed with no previous → null.
  assert.equal(mergeGrokBillingProbeResult(null, null, null, { weeklyOk: false, monthlyOk: false }), null);

  // Both failed but previous exists → previous survives.
  const retained: GrokBillingSummary | null = mergeGrokBillingProbeResult(merged, null, null, {
    weeklyOk: false,
    monthlyOk: false,
  });
  assert.ok(retained);
  assert.deepEqual(retained.failedWindows, ['weekly', 'monthly']);
});

test('fetchGrokBillingWindow stamps the CLI identity on the proxy host and parses the body', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const result = await fetchGrokBillingWindow({
    baseUrl: GROK_OAUTH_DEFAULT_BASE_URL,
    formatCredits: true,
    accessToken: 'tok',
    fetcher: async (url, init) => {
      seen.push({
        url,
        headers: Object.fromEntries(new Headers(init.headers as HeadersInit).entries()),
      });
      return new Response(JSON.stringify({ config: { currentPeriod: { type: 'weekly' }, creditUsagePercent: 12 } }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.summary?.usagePercent, 12);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  assert.equal(seen[0]?.headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(seen[0]?.headers['x-grok-client-identifier'], 'grok-shell');
  assert.equal(seen[0]?.headers.authorization, 'Bearer tok');
});
