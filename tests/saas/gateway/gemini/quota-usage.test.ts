import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEMINI_TIER_QUOTAS } from '../../../../src/saas/gateway/gemini/constants.js';
import {
  computeGeminiUsageSnapshot,
  geminiDailyResetAtMs,
  geminiDailyWindowStartMs,
  mergeGeminiUsageMetadata,
  parseGeminiUsageMetadata,
} from '../../../../src/saas/gateway/gemini/quota-usage.js';

test('usageMetadata parsing: all fields, partial fields and non-records', () => {
  const full = parseGeminiUsageMetadata({
    promptTokenCount: 120,
    candidatesTokenCount: 42,
    thoughtsTokenCount: 7,
    cachedContentTokenCount: 30,
    totalTokenCount: 169,
  });
  assert.deepEqual(full, {
    promptTokens: 120,
    outputTokens: 42,
    thoughtsTokens: 7,
    cachedTokens: 30,
    totalTokens: 169,
  });

  // Missing fields stay null rather than being guessed as zero.
  const partial = parseGeminiUsageMetadata({ promptTokenCount: 10, candidatesTokenCount: 2 });
  assert.deepEqual(partial, {
    promptTokens: 10,
    outputTokens: 2,
    thoughtsTokens: null,
    cachedTokens: null,
    totalTokens: null,
  });

  // Non-record / all-unparsable input is null (no signal at all).
  for (const bad of ['nope', null, undefined, 42, [], {}]) {
    assert.equal(parseGeminiUsageMetadata(bad), null);
  }
  // Negative / non-integer counts are dropped to null fields; when at least
  // one valid field survives the rest stay null.
  assert.deepEqual(parseGeminiUsageMetadata({ promptTokenCount: -1, candidatesTokenCount: 5 }), {
    promptTokens: null,
    outputTokens: 5,
    thoughtsTokens: null,
    cachedTokens: null,
    totalTokens: null,
  });
  // Every count unparsable → no signal at all.
  assert.equal(parseGeminiUsageMetadata({ promptTokenCount: -1, totalTokenCount: 1.5 }), null);
});

test('usageMetadata merge is last-wins per field with null fallback to the earlier observation', () => {
  const earlier = parseGeminiUsageMetadata({
    promptTokenCount: 100,
    candidatesTokenCount: 1,
    thoughtsTokenCount: 4,
    cachedContentTokenCount: 20,
    totalTokenCount: 105,
  });
  assert.ok(earlier);
  const later = parseGeminiUsageMetadata({ promptTokenCount: 210, candidatesTokenCount: 30 });
  assert.ok(later);
  assert.deepEqual(mergeGeminiUsageMetadata(earlier, later), {
    promptTokens: 210,
    outputTokens: 30,
    thoughtsTokens: 4,
    cachedTokens: 20,
    // A null field in the later observation falls back to the earlier one.
    totalTokens: 105,
  });
  // Merging onto null keeps only the later observation's fields.
  assert.deepEqual(mergeGeminiUsageMetadata(null, later), {
    promptTokens: 210,
    outputTokens: 30,
    thoughtsTokens: null,
    cachedTokens: null,
    totalTokens: null,
  });
});

test('the daily window anchors on Pacific midnight (computed independently via Intl)', () => {
  // Noon on a Pacific daylight-time day.
  const pdtNoon = Date.parse('2026-07-15T12:00:00-07:00');
  const pdtMidnight = Date.parse('2026-07-15T00:00:00-07:00');
  assert.equal(geminiDailyWindowStartMs(pdtNoon), pdtMidnight);
  // A UTC timestamp whose UTC calendar day differs from the Pacific day.
  const utcEarly = Date.parse('2026-07-15T07:30:00Z'); // 00:30 PDT on July 15
  assert.equal(geminiDailyWindowStartMs(utcEarly), pdtMidnight);
  // Exactly at Pacific midnight maps onto itself.
  assert.equal(geminiDailyWindowStartMs(pdtMidnight), pdtMidnight);
  // Late-night Pacific time still belongs to the same calendar day.
  const pdtLateNight = Date.parse('2026-07-15T23:59:00-07:00');
  assert.equal(geminiDailyWindowStartMs(pdtLateNight), pdtMidnight);
  // A standard-time (winter) day uses the -08:00 anchor.
  const pstNoon = Date.parse('2026-01-15T12:00:00-08:00');
  assert.equal(geminiDailyWindowStartMs(pstNoon), Date.parse('2026-01-15T00:00:00-08:00'));
});

test('the daily reset is the following Pacific midnight, always in the future and bounded', () => {
  for (const nowMs of [Date.parse('2026-07-15T12:00:00-07:00'), Date.parse('2026-01-15T03:00:00-08:00'), Date.now()]) {
    const reset = geminiDailyResetAtMs(nowMs);
    assert.ok(reset > nowMs, `reset must be in the future for ${nowMs}`);
    assert.ok(reset - nowMs <= 24 * 60 * 60 * 1000 + 60 * 60 * 1000, `reset within 24h+1h for ${nowMs}`);
    // Monotonicity: the window start never exceeds now and now is inside the window.
    const start = geminiDailyWindowStartMs(nowMs);
    assert.ok(start <= nowMs);
    assert.ok(nowMs - start < 24 * 60 * 60 * 1000);
  }
  const noon = Date.parse('2026-07-15T12:00:00-07:00');
  assert.equal(geminiDailyResetAtMs(noon), Date.parse('2026-07-16T00:00:00-07:00'));
});

test('shared-pool tiers collapse pro+flash traffic into one sharedDaily window', () => {
  const snapshot = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-pro': 100, 'gemini-2.5-flash': 200 },
    minuteRequests: 7,
    tierQuota: GEMINI_TIER_QUOTAS.gcp_standard,
    nowMs: 1_700_000_000_000,
  });
  assert.deepEqual(snapshot.sharedDaily, { used: 300, limit: 1_500 });
  assert.equal(snapshot.proDaily, null);
  assert.equal(snapshot.flashDaily, null);
  assert.deepEqual(snapshot.minute, { used: 7, limit: GEMINI_TIER_QUOTAS.gcp_standard.sharedRpm });
  assert.equal(snapshot.observedAtMs, 1_700_000_000_000);
  assert.equal(snapshot.dailyResetAtMs, geminiDailyResetAtMs(1_700_000_000_000));
});

test('per-class tiers split pro/flash by model name and pick the matching minute limit', () => {
  const quota = GEMINI_TIER_QUOTAS.aistudio_free;
  const proOnly = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-pro': 10 },
    minuteRequests: 2,
    tierQuota: quota,
    nowMs: 1,
  });
  assert.equal(proOnly.sharedDaily, null);
  assert.deepEqual(proOnly.proDaily, { used: 10, limit: quota.proRpd });
  assert.deepEqual(proOnly.flashDaily, { used: 0, limit: quota.flashRpd });
  assert.deepEqual(proOnly.minute, { used: 2, limit: quota.proRpm });

  const flashOnly = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-flash': 40, 'gemini-2.0-flash-lite': 5 },
    minuteRequests: 9,
    tierQuota: quota,
    nowMs: 1,
  });
  assert.deepEqual(flashOnly.proDaily, { used: 0, limit: quota.proRpd });
  assert.deepEqual(flashOnly.flashDaily, { used: 45, limit: quota.flashRpd });
  // Only flash traffic: the flash RPM limit applies.
  assert.deepEqual(flashOnly.minute, { used: 9, limit: quota.flashRpm });

  // Mixed traffic: the smaller class limit wins (conservative).
  const mixed = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-pro': 1, 'gemini-2.5-flash': 2 },
    minuteRequests: 3,
    tierQuota: quota,
    nowMs: 1,
  });
  assert.deepEqual(mixed.minute, { used: 3, limit: Math.min(quota.proRpm, quota.flashRpm) });
});

test('a null tier quota still reports the used counts with null limits', () => {
  const snapshot = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-pro': 3, 'gemini-2.5-flash': 4 },
    minuteRequests: 5,
    tierQuota: null,
    nowMs: 1_700_000_000_000,
  });
  // No quota class is known: no daily window applies, but the minute count is
  // still surfaced with a null limit.
  assert.equal(snapshot.sharedDaily, null);
  assert.equal(snapshot.proDaily, null);
  assert.equal(snapshot.flashDaily, null);
  assert.deepEqual(snapshot.minute, { used: 5, limit: null });
});

test('unlimited (-1) daily limits pass through so the scheduler treats the window as never exhausted', () => {
  const snapshot = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-pro': 500 },
    minuteRequests: 3,
    tierQuota: GEMINI_TIER_QUOTAS.aistudio_paid,
    nowMs: 1,
  });
  assert.equal(snapshot.sharedDaily, null);
  assert.deepEqual(snapshot.proDaily, { used: 500, limit: -1 });
  assert.deepEqual(snapshot.flashDaily, { used: 0, limit: -1 });
  assert.deepEqual(snapshot.minute, { used: 3, limit: GEMINI_TIER_QUOTAS.aistudio_paid.proRpm });
});

test('non-positive and non-numeric request counts are ignored by the fold', () => {
  const snapshot = computeGeminiUsageSnapshot({
    requests: { 'gemini-2.5-pro': 4, 'gemini-2.5-flash': -3, other: Number.NaN, another: 0 },
    minuteRequests: 0,
    tierQuota: GEMINI_TIER_QUOTAS.gcp_standard,
    nowMs: 1,
  });
  assert.deepEqual(snapshot.sharedDaily, { used: 4, limit: 1_500 });
});
