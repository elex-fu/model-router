import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyGemini429,
  isGeminiDailyQuotaExhaustion,
  parseGeminiErrorBody,
  parseGoogleRetryDelayMs,
} from '../../../../src/saas/gateway/gemini/quota-headers.js';

const NOW_MS = 1_700_000_000_000;

function googleErrorBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.', ...overrides },
  });
}

test('the Google JSON error body shape parses code, status, message and details', () => {
  const parsed = parseGeminiErrorBody(
    googleErrorBody({ details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '26s' }] }),
  );
  assert.ok(parsed);
  assert.equal(parsed.code, 429);
  assert.equal(parsed.status, 'RESOURCE_EXHAUSTED');
  assert.equal(parsed.message, 'Quota exceeded.');
  assert.equal(parsed.details.length, 1);

  // Non-JSON, empty, oversized and wrong-shape bodies all fail closed.
  for (const bad of ['not json', '', ' '.repeat(70_000), '{"error":"flat"}', '[]', 'null']) {
    assert.equal(parseGeminiErrorBody(bad), null, bad.slice(0, 20));
  }
});

test('the RetryInfo detail duration parses into milliseconds', () => {
  const retryInfo = (delay: string): unknown[] => [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay },
  ];
  assert.equal(parseGoogleRetryDelayMs(retryInfo('30s')), 30_000);
  assert.equal(parseGoogleRetryDelayMs(retryInfo('5m')), 300_000);
  assert.equal(parseGoogleRetryDelayMs(retryInfo('1h')), 3_600_000);
  assert.equal(parseGoogleRetryDelayMs(retryInfo('0.5s')), 500);
  assert.equal(parseGoogleRetryDelayMs(retryInfo('1h30m')), null);
  assert.equal(parseGoogleRetryDelayMs(retryInfo('0s')), null);
  // No RetryInfo detail at all.
  assert.equal(parseGoogleRetryDelayMs([]), null);
  assert.equal(parseGoogleRetryDelayMs([{ '@type': 'type.googleapis.com/google.rpc.DebugInfo' }]), null);
  assert.equal(parseGoogleRetryDelayMs(['plain']), null);
});

test('429 classification: the retry-after header wins and reports its source', () => {
  const classification = classifyGemini429(
    {
      headers: { 'retry-after': '30' },
      bodyText: googleErrorBody({
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5m' }],
      }),
      tierId: 'gcp_standard',
    },
    NOW_MS,
  );
  assert.equal(classification.source, 'retry-after');
  assert.equal(classification.resetAtMs, NOW_MS + 30_000);
  assert.equal(classification.resourceExhausted, true);
  assert.equal(classification.googleStatus, 'RESOURCE_EXHAUSTED');
  // An implausible retry-after (beyond maxAheadMs) is not trusted.
  const rejected = classifyGemini429(
    { headers: { 'retry-after': String(3 * 24 * 60 * 60) }, bodyText: null, tierId: 'gcp_standard' },
    NOW_MS,
  );
  assert.equal(rejected.source, 'tier-cooldown');
});

test('429 classification: the RetryInfo body delay beats the tier cooldown', () => {
  const classification = classifyGemini429(
    {
      headers: {},
      bodyText: googleErrorBody({
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '30s' }],
      }),
      tierId: 'gcp_standard',
    },
    NOW_MS,
  );
  assert.equal(classification.source, 'retry-info');
  assert.equal(classification.resetAtMs, NOW_MS + 30_000);

  const minutes = classifyGemini429(
    {
      headers: {},
      bodyText: googleErrorBody({
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5m' }],
      }),
      tierId: 'aistudio_free',
    },
    NOW_MS,
  );
  assert.equal(minutes.source, 'retry-info');
  assert.equal(minutes.resetAtMs, NOW_MS + 300_000);
});

test('429 classification: no signal falls back to the tier cooldown', () => {
  const standard = classifyGemini429({ headers: {}, bodyText: googleErrorBody(), tierId: 'gcp_standard' }, NOW_MS);
  assert.equal(standard.source, 'tier-cooldown');
  assert.equal(standard.resetAtMs, NOW_MS + 5 * 60_000);
  assert.equal(standard.resourceExhausted, true);

  // Unknown tier → the 5-minute unknown-tier default, not a table guess.
  const unknownTier = classifyGemini429({ headers: {}, bodyText: null, tierId: null }, NOW_MS);
  assert.equal(unknownTier.source, 'tier-cooldown');
  assert.equal(unknownTier.resetAtMs, NOW_MS + 5 * 60_000);
  assert.equal(unknownTier.resourceExhausted, false);

  // A 429 with no body, no headers and no tier still produces a bounded
  // outcome whose daily reset is in the future and within 24h+1h.
  const bare = classifyGemini429({ headers: {}, bodyText: null }, NOW_MS);
  assert.equal(bare.source, 'tier-cooldown');
  assert.equal(bare.resetAtMs, NOW_MS + 5 * 60_000);
  assert.ok(bare.dailyResetAtMs > NOW_MS);
  assert.ok(bare.dailyResetAtMs <= NOW_MS + 25 * 60 * 60 * 1000);
});

test('daily-quota exhaustion keys on RESOURCE_EXHAUSTED plus per-day wording', () => {
  assert.equal(
    isGeminiDailyQuotaExhaustion(
      googleErrorBody({ message: 'Rate LIMit exceeded for generate_content_per_day, limit: 100' }),
    ),
    true,
  );
  assert.equal(
    isGeminiDailyQuotaExhaustion(googleErrorBody({ message: 'GenerateContentRequests per_day limit exceeded' })),
    true,
  );
  // RESOURCE_EXHAUSTED without per-day wording is a generic burst 429.
  assert.equal(isGeminiDailyQuotaExhaustion(googleErrorBody({ message: 'Quota exceeded.' })), false);
  // Other statuses never mark the daily quota exhausted.
  assert.equal(
    isGeminiDailyQuotaExhaustion(
      JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'RATE_LIMIT_EXCEEDED per day' } }),
    ),
    false,
  );
  assert.equal(isGeminiDailyQuotaExhaustion(null), false);
  assert.equal(isGeminiDailyQuotaExhaustion('not json'), false);
});
