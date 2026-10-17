import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_WINDOW_5H_MAX_AGE_MS,
  classifyClaude429,
  claudeSessionWindowFromResetMs,
  parseClaudeQuotaSnapshot,
  parseClaudeRateLimitWindow,
} from '../../../../src/saas/gateway/claude/quota-headers.js';

const NOW_MS = 1_700_000_000_000;
const IN_5H = NOW_MS + 3 * 60 * 60 * 1000;
const IN_7D = NOW_MS + 6 * 24 * 60 * 60 * 1000;

test('window parsing reads status, utilization and plausibility-bounded resets', () => {
  const window = parseClaudeRateLimitWindow(
    {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '0.87',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(IN_5H / 1000)),
    },
    '5h',
    NOW_MS,
  );
  assert.equal(window.window, '5h');
  assert.equal(window.status, 'rejected');
  assert.equal(window.utilization, 0.87);
  assert.equal(window.rejected, true);
  assert.equal(window.exhausted, false);
  assert.equal(window.resetAtMs, IN_5H - (IN_5H % 1000));

  // utilization >= 1.0 (with epsilon) counts as exhausted.
  const exhausted = parseClaudeRateLimitWindow({ 'anthropic-ratelimit-unified-7d-utilization': '1.0' }, '7d', NOW_MS);
  assert.equal(exhausted.exhausted, true);
  const surpassed = parseClaudeRateLimitWindow(
    { 'anthropic-ratelimit-unified-7d_oi-surpassed-threshold': 'true' },
    '7d_oi',
    NOW_MS,
  );
  assert.equal(surpassed.surpassedThreshold, true);
  assert.equal(surpassed.exhausted, true);

  // Resets in the past or beyond the window's plausibility bound are null.
  assert.equal(
    parseClaudeRateLimitWindow(
      { 'anthropic-ratelimit-unified-5h-reset': String(Math.floor((NOW_MS - 1000) / 1000)) },
      '5h',
      NOW_MS,
    ).resetAtMs,
    null,
  );
  assert.equal(
    parseClaudeRateLimitWindow(
      {
        'anthropic-ratelimit-unified-5h-reset': String(
          Math.floor((NOW_MS + CLAUDE_WINDOW_5H_MAX_AGE_MS + 60_000) / 1000),
        ),
      },
      '5h',
      NOW_MS,
    ).resetAtMs,
    null,
  );
  // Millisecond timestamps are auto-detected.
  assert.equal(
    parseClaudeRateLimitWindow({ 'anthropic-ratelimit-unified-5h-reset': String(IN_5H) }, '5h', NOW_MS).resetAtMs,
    IN_5H,
  );
  // Malformed values never throw.
  const malformed = parseClaudeRateLimitWindow(
    { 'anthropic-ratelimit-unified-5h-utilization': 'not-a-number', 'anthropic-ratelimit-unified-5h-reset': 'soon' },
    '5h',
    NOW_MS,
  );
  assert.equal(malformed.utilization, null);
  assert.equal(malformed.resetAtMs, null);
});

test('429 classification prefers the exhausted window with a valid reset (7d over 5h)', () => {
  const classification = classifyClaude429(
    {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(IN_5H / 1000)),
      'anthropic-ratelimit-unified-7d-surpassed-threshold': 'true',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(IN_7D / 1000)),
    },
    NOW_MS,
  );
  assert.ok(classification);
  assert.equal(classification.window, '7d');
  assert.equal(classification.resetAtMs, IN_7D - (IN_7D % 1000));
  assert.equal(classification.fiveHourResetAtMs, IN_5H - (IN_5H % 1000));
  // The session window anchors on the 5h reset: [reset − 5h, reset].
  assert.equal(classification.sessionWindowEndMs, IN_5H - (IN_5H % 1000));
  assert.equal(classification.sessionWindowStartMs, classification.sessionWindowEndMs - 5 * 60 * 60 * 1000);
});

test('429 classification falls back to the 5h window and then the aggregated reset', () => {
  const fiveHour = classifyClaude429(
    {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(IN_5H / 1000)),
    },
    NOW_MS,
  );
  assert.ok(fiveHour);
  assert.equal(fiveHour.window, '5h');
  assert.equal(fiveHour.resetAtMs, IN_5H - (IN_5H % 1000));

  // No per-window signal: the aggregated unified-reset header (up to 366d).
  const aggregated = classifyClaude429(
    { 'anthropic-ratelimit-unified-reset': String(Math.floor(IN_7D / 1000)) },
    NOW_MS,
  );
  assert.ok(aggregated);
  assert.equal(aggregated.window, '5h');
  assert.equal(aggregated.resetAtMs, IN_7D - (IN_7D % 1000));
  // No 5h reset header: the session window anchors on the aggregated deadline.
  assert.equal(aggregated.sessionWindowEndMs, IN_7D - (IN_7D % 1000));
});

test('a 429 without any parsable reset yields null (caller applies the short fallback cooldown)', () => {
  assert.equal(classifyClaude429({}, NOW_MS), null);
  assert.equal(classifyClaude429({ 'anthropic-ratelimit-unified-5h-status': 'rejected' }, NOW_MS), null);
  assert.equal(classifyClaude429({ 'anthropic-ratelimit-unified-5h-reset': 'yesterday' }, NOW_MS), null);
  // An exhausted window whose reset is implausibly far away is not trusted.
  assert.equal(
    classifyClaude429(
      {
        'anthropic-ratelimit-unified-7d-surpassed-threshold': 'true',
        'anthropic-ratelimit-unified-7d-reset': String(Math.floor((NOW_MS + 400 * 24 * 60 * 60 * 1000) / 1000)),
      },
      NOW_MS,
    ),
    null,
  );
});

test('success-path quota snapshot parses every signaling window off any response', () => {
  const snapshot = parseClaudeQuotaSnapshot(
    {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(IN_5H / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': '0.91',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(IN_7D / 1000)),
    },
    NOW_MS,
  );
  assert.ok(snapshot !== null);
  assert.equal(snapshot.observedAtMs, NOW_MS);
  assert.equal(snapshot.windows.length, 2);
  const fiveHour = snapshot.windows.find((window) => window.window === '5h');
  const sevenDay = snapshot.windows.find((window) => window.window === '7d');
  assert.ok(fiveHour !== undefined && sevenDay !== undefined);
  assert.equal(fiveHour.status, 'allowed');
  assert.equal(fiveHour.utilization, 0.42);
  assert.equal(fiveHour.resetAtMs, IN_5H - (IN_5H % 1000));
  assert.equal(sevenDay.utilization, 0.91);
  assert.equal(sevenDay.resetAtMs, IN_7D - (IN_7D % 1000));
  assert.equal(fiveHour.exhausted, false);
  assert.equal(sevenDay.exhausted, false);

  // A response with no window signal at all writes nothing.
  assert.equal(parseClaudeQuotaSnapshot({}, NOW_MS), null);
  // Surpassed-threshold alone is a signal (status/utilization absent).
  const surpassedOnly = parseClaudeQuotaSnapshot(
    { 'anthropic-ratelimit-unified-5h-surpassed-threshold': 'true' },
    NOW_MS,
  );
  assert.ok(surpassedOnly !== null);
  assert.equal(surpassedOnly.windows.length, 1);
  assert.equal(surpassedOnly.windows[0]?.surpassedThreshold, true);

  // The 7d_sonnet label participates when the upstream advertises it.
  const sonnet = parseClaudeQuotaSnapshot({ 'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.55' }, NOW_MS);
  assert.ok(sonnet !== null);
  assert.equal(sonnet.windows[0]?.window, '7d_sonnet');
});

test('the session window anchors to [reset − 5h, reset]', () => {
  const window = claudeSessionWindowFromResetMs(IN_5H);
  assert.equal(window.endMs, IN_5H);
  assert.equal(window.startMs, IN_5H - 5 * 60 * 60 * 1000);
});
