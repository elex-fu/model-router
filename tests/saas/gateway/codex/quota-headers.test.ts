import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyQuotaPause, parseCodexRateLimitHeaders } from '../../../../src/saas/gateway/codex/quota-headers.js';

const HOUR_MS = 60 * 60 * 1000;

test('parseCodexRateLimitHeaders reads a primary=5h upstream layout', () => {
  const snapshot = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': '42',
    'x-codex-primary-reset-after-seconds': '3600',
    'x-codex-primary-window-minutes': '300',
    'x-codex-secondary-used-percent': '71',
    'x-codex-secondary-reset-after-seconds': '86400',
    'x-codex-secondary-window-minutes': '10080',
  });
  assert.deepEqual(snapshot, {
    used5hPercent: 42,
    reset5hSeconds: 3600,
    window5hMinutes: 300,
    used7dPercent: 71,
    reset7dSeconds: 86400,
    window7dMinutes: 10080,
  });
});

test('parseCodexRateLimitHeaders swaps a primary=7d upstream layout back into shape', () => {
  const snapshot = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': '95',
    'x-codex-primary-reset-after-seconds': '200000',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '10',
    'x-codex-secondary-reset-after-seconds': '1200',
    'x-codex-secondary-window-minutes': '270',
  });
  assert.deepEqual(snapshot, {
    used5hPercent: 10,
    reset5hSeconds: 1200,
    window5hMinutes: 270,
    used7dPercent: 95,
    reset7dSeconds: 200000,
    window7dMinutes: 10080,
  });
});

test('parseCodexRateLimitHeaders treats the 360-minute boundary as the 5h window', () => {
  const atBoundary = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': '1',
    'x-codex-primary-window-minutes': '360',
    'x-codex-secondary-used-percent': '2',
    'x-codex-secondary-window-minutes': '10080',
  });
  assert.equal(atBoundary?.window5hMinutes, 360);
  assert.equal(atBoundary?.window7dMinutes, 10080);

  const justOver = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': '1',
    'x-codex-primary-window-minutes': '361',
    'x-codex-secondary-used-percent': '2',
    'x-codex-secondary-window-minutes': '300',
  });
  assert.equal(justOver?.window5hMinutes, 300);
  assert.equal(justOver?.window7dMinutes, 361);
});

test('parseCodexRateLimitHeaders handles a single advertised window', () => {
  const onlyPrimary5h = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-reset-after-seconds': '60',
    'x-codex-primary-window-minutes': '300',
  });
  assert.deepEqual(onlyPrimary5h, {
    used5hPercent: 100,
    reset5hSeconds: 60,
    window5hMinutes: 300,
    used7dPercent: null,
    reset7dSeconds: null,
    window7dMinutes: null,
  });

  const onlyPrimary7d = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': '50',
    'x-codex-primary-reset-after-seconds': '5000',
    'x-codex-primary-window-minutes': '10080',
  });
  assert.deepEqual(onlyPrimary7d, {
    used5hPercent: null,
    reset5hSeconds: null,
    window5hMinutes: null,
    used7dPercent: 50,
    reset7dSeconds: 5000,
    window7dMinutes: 10080,
  });

  const onlySecondary5h = parseCodexRateLimitHeaders({
    'x-codex-secondary-used-percent': '30',
    'x-codex-secondary-reset-after-seconds': '600',
    'x-codex-secondary-window-minutes': '240',
  });
  assert.deepEqual(onlySecondary5h, {
    used5hPercent: 30,
    reset5hSeconds: 600,
    window5hMinutes: 240,
    used7dPercent: null,
    reset7dSeconds: null,
    window7dMinutes: null,
  });
});

test('parseCodexRateLimitHeaders returns null without any parsable window', () => {
  assert.equal(parseCodexRateLimitHeaders({}), null);
  assert.equal(
    parseCodexRateLimitHeaders({
      'x-codex-primary-used-percent': 'not-a-number',
      'x-codex-primary-window-minutes': '  ',
    }),
    null,
  );
  assert.equal(parseCodexRateLimitHeaders({ 'content-type': 'application/json' }), null);
});

test('parseCodexRateLimitHeaders matches header names case-insensitively', () => {
  const snapshot = parseCodexRateLimitHeaders({
    'X-Codex-Primary-Used-Percent': '12',
    'X-Codex-Primary-Window-Minutes': '300',
  });
  assert.equal(snapshot?.used5hPercent, 12);
  assert.equal(snapshot?.window5hMinutes, 300);
});

function snapshot(
  overrides: Partial<Parameters<typeof classifyQuotaPause>[0]>,
): Parameters<typeof classifyQuotaPause>[0] {
  return {
    used5hPercent: 10,
    reset5hAtMs: null,
    used7dPercent: 10,
    reset7dAtMs: null,
    observedAtMs: Date.now(),
    ...overrides,
  };
}

const THRESHOLDS = { pause5hUsedPercent: 90, pause7dUsedPercent: 80 };

test('classifyQuotaPause pauses when a window is at or above its threshold', () => {
  const now = Date.now();
  assert.equal(
    classifyQuotaPause(snapshot({ used5hPercent: 90, reset5hAtMs: now + HOUR_MS }), THRESHOLDS, now),
    'paused',
  );
  assert.equal(
    classifyQuotaPause(
      snapshot({ used5hPercent: 95, reset5hAtMs: now + HOUR_MS, used7dPercent: 95, reset7dAtMs: now + 3 * HOUR_MS }),
      THRESHOLDS,
      now,
    ),
    'paused',
  );
  assert.equal(
    classifyQuotaPause(snapshot({ used7dPercent: 80, reset7dAtMs: now + 3 * HOUR_MS }), THRESHOLDS, now),
    'paused',
  );
  // Below both thresholds stays active.
  assert.equal(
    classifyQuotaPause(
      snapshot({ used5hPercent: 89, reset5hAtMs: now + HOUR_MS, used7dPercent: 79, reset7dAtMs: now + 3 * HOUR_MS }),
      THRESHOLDS,
      now,
    ),
    'active',
  );
  // Unknown usage cannot pause (fail open to the normal scheduler).
  assert.equal(classifyQuotaPause(snapshot({ used5hPercent: null, used7dPercent: null }), THRESHOLDS, now), 'active');
});

test('classifyQuotaPause ignores a window whose reset deadline already passed', () => {
  const now = Date.now();
  assert.equal(classifyQuotaPause(snapshot({ used5hPercent: 100, reset5hAtMs: now - 1 }), THRESHOLDS, now), 'active');
  // Only the expired window is ignored; the live one still gates.
  assert.equal(
    classifyQuotaPause(
      snapshot({ used5hPercent: 100, reset5hAtMs: now - 1, used7dPercent: 100, reset7dAtMs: now + HOUR_MS }),
      THRESHOLDS,
      now,
    ),
    'paused',
  );
  // A missing reset time keeps the threshold decision.
  assert.equal(classifyQuotaPause(snapshot({ used5hPercent: 100, reset5hAtMs: null }), THRESHOLDS, now), 'paused');
});

test('classifyQuotaPause allows one probe when the snapshot is more than two hours stale', () => {
  const now = Date.now();
  const stale = snapshot({ used5hPercent: 100, reset5hAtMs: now + HOUR_MS, observedAtMs: now - 2 * HOUR_MS - 1 });
  assert.equal(classifyQuotaPause(stale, THRESHOLDS, now), 'probe-allowed');
  const fresh = snapshot({ used5hPercent: 100, reset5hAtMs: now + HOUR_MS, observedAtMs: now - 2 * HOUR_MS });
  assert.equal(classifyQuotaPause(fresh, THRESHOLDS, now), 'paused');
  assert.equal(classifyQuotaPause(snapshot({ observedAtMs: Number.NaN }), THRESHOLDS, now), 'probe-allowed');
});

test('classifyQuotaPause treats a reset deadline exactly at now as passed', () => {
  const now = 1_000_000;
  assert.equal(
    classifyQuotaPause(snapshot({ used5hPercent: 100, reset5hAtMs: now, observedAtMs: now - 1000 }), THRESHOLDS, now),
    'active',
  );
});
