import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROK_RESET_MILLISECONDS_EPOCH_FLOOR,
  GROK_RESET_SECONDS_EPOCH_FLOOR,
  grokSchedulingSnapshotFromHeaders,
  parseGrokQuotaHeaders,
  parseGrokResetMs,
  parseGrokRetryAfterSeconds,
} from '../../../../src/saas/gateway/grok/quota-headers.js';

const NOW_MS = 1_761_000_000_000; // 2025-10-21T00:00:00Z-ish fixed clock

test('reset disambiguation by magnitude (table-driven, the sub2api/xai rule)', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly raw: string;
    readonly expectedMs: number;
  }> = [
    { name: 'millisecond epoch (>= 1e12) divides to seconds', raw: '1761000000000', expectedMs: 1_761_000_000_000 },
    { name: 'large ms epoch still floors to seconds precision', raw: '1761000000123', expectedMs: 1_761_000_000_000 },
    {
      name: 'second epoch (>= 1e9) stays as-is',
      raw: String(GROK_RESET_SECONDS_EPOCH_FLOOR),
      expectedMs: GROK_RESET_SECONDS_EPOCH_FLOOR * 1000,
    },
    { name: 'relative seconds (small magnitude) anchor to now', raw: '60', expectedMs: NOW_MS + 60_000 },
    { name: 'relative zero is now', raw: '0', expectedMs: NOW_MS },
    { name: 'negative relative clamps to already-reset', raw: '-30', expectedMs: NOW_MS },
    {
      name: 'RFC3339 timestamp parses directly',
      raw: new Date(NOW_MS + 90 * 60_000).toISOString().replace('.000Z', 'Z'),
      expectedMs: NOW_MS + 90 * 60_000,
    },
  ];
  for (const { name, raw, expectedMs } of cases) {
    const parsed = parseGrokResetMs(raw, NOW_MS);
    assert.ok(parsed !== null, name);
    assert.equal(Math.abs((parsed as number) - expectedMs) < 1_500, true, `${name}: ${parsed} vs ${expectedMs}`);
  }
  // Magnitude floors are the documented pins.
  assert.equal(GROK_RESET_MILLISECONDS_EPOCH_FLOOR, 1_000_000_000_000);
  assert.equal(GROK_RESET_SECONDS_EPOCH_FLOOR, 1_000_000_000);
  // Unparsable values are null, never guessed.
  assert.equal(parseGrokResetMs(undefined, NOW_MS), null);
  assert.equal(parseGrokResetMs('', NOW_MS), null);
  assert.equal(parseGrokResetMs('soon', NOW_MS), null);
});

test('retry-after accepts seconds and HTTP-dates', () => {
  assert.equal(parseGrokRetryAfterSeconds('30', NOW_MS), 30);
  assert.equal(parseGrokRetryAfterSeconds(new Date(NOW_MS + 45_000).toUTCString(), NOW_MS), 45);
  assert.equal(parseGrokRetryAfterSeconds(undefined, NOW_MS), null);
  assert.equal(parseGrokRetryAfterSeconds('junk', NOW_MS), null);
});

test('both header spellings parse into the two quota windows', () => {
  // Double-dash family (primary spelling).
  const doubleDash = parseGrokQuotaHeaders(
    {
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '42',
      'x-ratelimit-reset-requests': '120',
      'x-ratelimit-limit-tokens': '1000000',
      'x-ratelimit-remaining-tokens': '250000',
      'x-ratelimit-reset-tokens': String(NOW_MS + 3_600_000),
      'x-subscription-tier': 'supergrok',
    },
    NOW_MS,
  );
  assert.ok(doubleDash);
  assert.equal(doubleDash.requests?.limit, 60);
  assert.equal(doubleDash.requests?.remaining, 42);
  assert.equal(doubleDash.requests?.usedPercent, 30);
  assert.equal(doubleDash.tokens?.limit, 1_000_000);
  assert.equal(doubleDash.tokens?.remaining, 250_000);
  assert.equal(doubleDash.tokens?.usedPercent, 75);
  assert.equal(doubleDash.tokens?.resetAtMs, NOW_MS + 3_600_000);
  assert.equal(doubleDash.subscriptionTier, 'supergrok');

  // Single-dash family (the x-rate-limit variant) parses identically.
  const singleDash = parseGrokQuotaHeaders(
    {
      'x-rate-limit-limit-requests': '10',
      'x-rate-limit-remaining-requests': '5',
      'x-rate-limit-reset-requests': '90',
    },
    NOW_MS,
  );
  assert.ok(singleDash);
  assert.equal(singleDash.requests?.limit, 10);
  assert.equal(singleDash.requests?.usedPercent, 50);
  assert.equal(singleDash.requests?.resetAtMs, NOW_MS + 90_000);
  assert.equal(singleDash.tokens, null);

  // The scheduling projection carries the token window as the 5h signal.
  const snapshot = grokSchedulingSnapshotFromHeaders(doubleDash);
  assert.equal(snapshot.used5hPercent, 75);
  assert.equal(snapshot.reset5hAtMs, NOW_MS + 3_600_000);
  assert.equal(snapshot.requestsUsedPercent, 30);
  assert.equal(snapshot.requestsResetAtMs, NOW_MS + 120_000);
});

test('case-insensitive header lookup and emptiness semantics', () => {
  const snapshot = parseGrokQuotaHeaders(
    { 'X-RateLimit-Limit-Tokens': '100', 'X-RateLimit-Remaining-Tokens': '0' },
    NOW_MS,
  );
  assert.ok(snapshot);
  assert.equal(snapshot.tokens?.usedPercent, 100);
  // No signal at all → null.
  assert.equal(parseGrokQuotaHeaders({}, NOW_MS), null);
  assert.equal(parseGrokQuotaHeaders({ 'x-ratelimit-limit-requests': 'junk' }, NOW_MS), null);
  // A tier header alone is a valid (if minimal) observation.
  const tierOnly = parseGrokQuotaHeaders({ 'xai-subscription-tier': 'free' }, NOW_MS);
  assert.ok(tierOnly);
  assert.equal(tierOnly.subscriptionTier, 'free');
  assert.equal(tierOnly.requests, null);
  assert.equal(tierOnly.tokens, null);
});
