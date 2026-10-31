import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCanonicalIdentity, CODEX_DEFAULT_ORIGINATOR } from '../../../../src/saas/gateway/codex/identity.js';
import {
  CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS,
  parseCodexRateLimitHeaders,
} from '../../../../src/saas/gateway/codex/quota-headers.js';
import {
  buildWhamQuotaPlaneHeaders,
  normalizeWhamRateLimitWindows,
  parseWhamUsageResponse,
  WHAM_QUOTA_PLANE_LANGUAGE_TAG,
  WHAM_QUOTA_PLANE_OPENAI_BETA,
  WHAM_QUOTA_PLANE_ORIGINATOR,
  WHAM_QUOTA_PLANE_PRIORITY,
  WHAM_USAGE_URL,
  type WhamUsageSnapshot,
  whamUsageSnapshotIsUsable,
} from '../../../../src/saas/gateway/codex/wham-usage.js';

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function window(usedPercent: number, limitWindowSeconds: number, resetAfterSeconds: number): object {
  return {
    used_percent: usedPercent,
    limit_window_seconds: limitWindowSeconds,
    reset_after_seconds: resetAfterSeconds,
  };
}

test('WHAM_USAGE_URL points at the chatgpt.com quota plane', () => {
  assert.equal(WHAM_USAGE_URL, 'https://chatgpt.com/backend-api/wham/usage');
});

test('buildWhamQuotaPlaneHeaders ports the s2a quota-plane identity', () => {
  const headers = buildWhamQuotaPlaneHeaders({ accessToken: 'token-1', chatgptAccountId: 'acct-1' });
  assert.equal(headers.authorization, 'Bearer token-1');
  assert.equal(headers['chatgpt-account-id'], 'acct-1');
  assert.equal(headers['openai-beta'], WHAM_QUOTA_PLANE_OPENAI_BETA);
  assert.equal(headers['openai-beta'], 'codex-1');
  assert.equal(headers['oai-language'], WHAM_QUOTA_PLANE_LANGUAGE_TAG);
  assert.equal(headers.originator, WHAM_QUOTA_PLANE_ORIGINATOR);
  assert.equal(headers.originator, 'Codex Desktop');
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['sec-fetch-site'], 'none');
  assert.equal(headers['sec-fetch-mode'], 'no-cors');
  assert.equal(headers['sec-fetch-dest'], 'empty');
  assert.equal(headers.priority, WHAM_QUOTA_PLANE_PRIORITY);
  assert.equal(headers.priority, 'u=4, i');
  // No user-agent override means no header, not a fabricated default.
  assert.equal('user-agent' in headers, false);
  assert.equal('x-openai-fedramp' in headers, false);
});

test('the quota-plane identity is distinct from the inference-plane identity', () => {
  const headers = buildWhamQuotaPlaneHeaders({ accessToken: 'token-1', chatgptAccountId: 'acct-1' });
  const inference = buildCanonicalIdentity();
  // The inference plane speaks as the Codex CLI; the quota plane is the desktop app.
  assert.equal(headers.originator, 'Codex Desktop');
  assert.equal(inference.originator, CODEX_DEFAULT_ORIGINATOR);
  assert.notEqual(headers.originator, inference.originator);
  assert.notEqual(headers['openai-beta'], 'codex_cli_rs');
  assert.equal(inference.userAgent.startsWith(inference.originator), true);
  // The quota-plane header set never leaks inference-plane identity fields.
  assert.equal('user-agent' in headers, false);
});

test('buildWhamQuotaPlaneHeaders forwards optional user-agent and fedramp flags', () => {
  const withAll = buildWhamQuotaPlaneHeaders({
    accessToken: 'token-2',
    chatgptAccountId: 'acct-2',
    userAgent: 'Codex Desktop/1.0',
    fedRamp: true,
  });
  assert.equal(withAll['user-agent'], 'Codex Desktop/1.0');
  assert.equal(withAll['x-openai-fedramp'], 'true');

  const fedRampOff = buildWhamQuotaPlaneHeaders({ accessToken: 't', chatgptAccountId: 'a', fedRamp: false });
  assert.equal('x-openai-fedramp' in fedRampOff, false);
});

test('parseWhamUsageResponse projects a s2a-shaped usage body', () => {
  const body = {
    user_id: 'user-1',
    account_id: 'acct-1',
    email: 'user@example.com',
    plan_type: 'pro',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { ...window(12.5, 18000, 5400), reset_at: 1_760_000_540 },
      secondary_window: { ...window(71, 604800, 200000), reset_at: 1_760_200_000 },
    },
    additional_rate_limits: [
      {
        limit_name: 'codex_spark',
        metered_feature: 'codex_bengalfox',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: window(30, 18000, 900),
          secondary_window: null,
        },
      },
    ],
    rate_limit_reset_credits: {
      available_count: 2,
      credits: [
        { expires_at: '2026-07-04T04:05:06Z', id: 'credit-1', status: 'available', reset_type: 'codex_rate_limits' },
      ],
    },
    credits: { has_credits: true, unlimited: false, balance: '12.34' },
  };

  const snapshot = parseWhamUsageResponse(body, NOW);
  assert.notEqual(snapshot, null);
  assert.deepEqual(snapshot?.rateLimit, {
    used5hPercent: 12.5,
    reset5hSeconds: 5400,
    window5hMinutes: 300,
    used7dPercent: 71,
    reset7dSeconds: 200000,
    window7dMinutes: 10080,
  });
  assert.equal(snapshot?.allowed, true);
  assert.equal(snapshot?.limitReached, false);
  assert.equal(snapshot?.observedAtMs, NOW);

  assert.equal(snapshot?.additionalRateLimits.length, 1);
  const spark = snapshot?.additionalRateLimits[0];
  assert.equal(spark?.limitName, 'codex_spark');
  assert.equal(spark?.meteredFeature, 'codex_bengalfox');
  assert.equal(spark?.rateLimit?.used5hPercent, 30);
  assert.equal(spark?.rateLimit?.reset5hSeconds, 900);
  assert.equal(spark?.rateLimit?.window5hMinutes, 300);
  assert.equal(spark?.rateLimit?.used7dPercent, null);

  assert.deepEqual(snapshot?.credits, { hasCredits: true, unlimited: false, balance: '12.34' });

  assert.equal(snapshot?.resetCredits?.availableCount, 2);
  assert.equal(snapshot?.resetCredits?.credits.length, 1);
  assert.equal(snapshot?.resetCredits?.credits[0]?.id, 'credit-1');
  assert.equal(snapshot?.resetCredits?.credits[0]?.expiresAt, '2026-07-04T04:05:06Z');
  assert.equal(snapshot?.resetCredits?.credits[0]?.expiryAtMs, Date.parse('2026-07-04T04:05:06Z'));
});

test('parseWhamUsageResponse swaps a primary=7d layout into canonical 5h/7d fields', () => {
  const snapshot = parseWhamUsageResponse(
    {
      rate_limit: {
        primary_window: window(95, 604800, 200000),
        secondary_window: window(10, 16200, 1200),
      },
    },
    NOW,
  );
  assert.deepEqual(snapshot?.rateLimit, {
    used5hPercent: 10,
    reset5hSeconds: 1200,
    window5hMinutes: 270,
    used7dPercent: 95,
    reset7dSeconds: 200000,
    window7dMinutes: 10080,
  });
  // 16200 seconds = 270 minutes: at the 360-minute threshold boundary the
  // smaller window is still the 5h one.
  const atBoundary = parseWhamUsageResponse(
    { rate_limit: { primary_window: window(1, 21600, 60), secondary_window: window(2, 604800, 600) } },
    NOW,
  );
  assert.equal(atBoundary?.rateLimit?.window5hMinutes, 360);
  assert.equal(atBoundary?.rateLimit?.window7dMinutes, 10080);
  const justOver = parseWhamUsageResponse(
    { rate_limit: { primary_window: window(1, 21660, 60), secondary_window: window(2, 18000, 600) } },
    NOW,
  );
  assert.equal(justOver?.rateLimit?.window5hMinutes, 300);
  assert.equal(justOver?.rateLimit?.window7dMinutes, 361);
});

test('parseWhamUsageResponse keeps a lone window in its own bucket', () => {
  const onlyPrimary5h = parseWhamUsageResponse({ rate_limit: { primary_window: window(100, 18000, 60) } }, NOW);
  assert.deepEqual(onlyPrimary5h?.rateLimit, {
    used5hPercent: 100,
    reset5hSeconds: 60,
    window5hMinutes: 300,
    used7dPercent: null,
    reset7dSeconds: null,
    window7dMinutes: null,
  });
  const onlySecondary7d = parseWhamUsageResponse({ rate_limit: { secondary_window: window(50, 604800, 5000) } }, NOW);
  assert.deepEqual(onlySecondary7d?.rateLimit, {
    used5hPercent: null,
    reset5hSeconds: null,
    window5hMinutes: null,
    used7dPercent: 50,
    reset7dSeconds: 5000,
    window7dMinutes: 10080,
  });
  // No window lengths at all: legacy assumption primary=7d / secondary=5h.
  const legacy = parseWhamUsageResponse(
    { rate_limit: { primary_window: { used_percent: 80 }, secondary_window: { used_percent: 20 } } },
    NOW,
  );
  assert.equal(legacy?.rateLimit?.used7dPercent, 80);
  assert.equal(legacy?.rateLimit?.used5hPercent, 20);
});

test('parseWhamUsageResponse returns null for unparsable bodies', () => {
  assert.equal(parseWhamUsageResponse(null, NOW), null);
  assert.equal(parseWhamUsageResponse(undefined, NOW), null);
  assert.equal(parseWhamUsageResponse('not-json', NOW), null);
  assert.equal(parseWhamUsageResponse(42, NOW), null);
  assert.equal(parseWhamUsageResponse([], NOW), null);
  // A well-formed object with no quota signal at all is unusable.
  assert.equal(parseWhamUsageResponse({ user_id: 'user-1', plan_type: 'pro' }, NOW), null);
  assert.equal(parseWhamUsageResponse({}, NOW), null);
  assert.equal(parseWhamUsageResponse({ rate_limit: { primary_window: { used_percent: 'high' } } }, NOW), null);
});

test('parseWhamUsageResponse tolerates partially malformed sections', () => {
  const snapshot = parseWhamUsageResponse(
    {
      rate_limit: 'not-an-object',
      additional_rate_limits: 'nope',
      credits: { has_credits: 'yes', unlimited: false, balance: 9 },
      rate_limit_reset_credits: { available_count: '3', credits: [null, { expires_at: 'soon-ish' }] },
    },
    NOW,
  );
  assert.notEqual(snapshot, null);
  assert.equal(snapshot?.rateLimit, null);
  assert.deepEqual(snapshot?.additionalRateLimits, []);
  // Non-boolean flags and non-string balance degrade to null.
  assert.deepEqual(snapshot?.credits, { hasCredits: null, unlimited: false, balance: null });
  // Numeric-string available_count is accepted; unparsable expiry stays null.
  assert.equal(snapshot?.resetCredits?.availableCount, 3);
  assert.equal(snapshot?.resetCredits?.credits.length, 1);
  assert.equal(snapshot?.resetCredits?.credits[0]?.expiryAtMs, null);
  assert.equal(snapshot?.allowed, null);
  assert.equal(snapshot?.limitReached, null);
});

test('parseWhamUsageResponse defaults the observation time to now', () => {
  const before = Date.now();
  const snapshot = parseWhamUsageResponse({ credits: { has_credits: true } });
  const after = Date.now();
  assert.equal(snapshot !== null && snapshot.observedAtMs >= before && snapshot.observedAtMs <= after, true);
});

test('normalizeWhamRateLimitWindows agrees with the quota-headers normalization rules', () => {
  // Cross-check: the same values fed through synthesized x-codex-* headers
  // must normalize identically.
  const primary = { usedPercent: 42, limitWindowSeconds: 18000, resetAfterSeconds: 3600, resetAt: 0 };
  const secondary = { usedPercent: 71, limitWindowSeconds: 604800, resetAfterSeconds: 86400, resetAt: 0 };
  const fromWham = normalizeWhamRateLimitWindows(primary, secondary);
  const fromHeaders = parseCodexRateLimitHeaders({
    'x-codex-primary-used-percent': String(primary.usedPercent),
    'x-codex-primary-reset-after-seconds': String(primary.resetAfterSeconds),
    'x-codex-primary-window-minutes': '300',
    'x-codex-secondary-used-percent': String(secondary.usedPercent),
    'x-codex-secondary-reset-after-seconds': String(secondary.resetAfterSeconds),
    'x-codex-secondary-window-minutes': '10080',
  });
  assert.deepEqual(fromWham, fromHeaders);
  assert.equal(normalizeWhamRateLimitWindows(null, null), null);
  assert.equal(
    normalizeWhamRateLimitWindows(
      { usedPercent: null, limitWindowSeconds: null, resetAfterSeconds: null, resetAt: null },
      null,
    ),
    null,
  );
});

function snapshot(overrides: Partial<WhamUsageSnapshot>): WhamUsageSnapshot {
  return {
    rateLimit: {
      used5hPercent: 10,
      reset5hSeconds: 600,
      window5hMinutes: 300,
      used7dPercent: 20,
      reset7dSeconds: 6000,
      window7dMinutes: 10080,
    },
    allowed: true,
    limitReached: false,
    additionalRateLimits: [],
    credits: null,
    resetCredits: null,
    observedAtMs: NOW,
    ...overrides,
  };
}

test('whamUsageSnapshotIsUsable gates on the two-hour staleness bound', () => {
  const maxAge = CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS;
  assert.equal(maxAge, 2 * HOUR_MS);
  // Exactly at the bound is still usable; one millisecond past is not.
  assert.equal(whamUsageSnapshotIsUsable(snapshot({ observedAtMs: NOW - maxAge }), NOW), true);
  assert.equal(whamUsageSnapshotIsUsable(snapshot({ observedAtMs: NOW - maxAge - 1 }), NOW), false);
  // Fresh snapshot with a future observation time (clock skew) stays usable.
  assert.equal(whamUsageSnapshotIsUsable(snapshot({ observedAtMs: NOW + 1000 }), NOW), true);
  // Custom max age is honored.
  assert.equal(whamUsageSnapshotIsUsable(snapshot({ observedAtMs: NOW - 3 * HOUR_MS }), NOW, 4 * HOUR_MS), true);
  assert.equal(whamUsageSnapshotIsUsable(snapshot({ observedAtMs: NOW - 3 * HOUR_MS }), NOW, HOUR_MS), false);
});

test('whamUsageSnapshotIsUsable fails closed on missing or signal-free snapshots', () => {
  assert.equal(whamUsageSnapshotIsUsable(null, NOW), false);
  assert.equal(whamUsageSnapshotIsUsable(snapshot({ observedAtMs: Number.NaN }), NOW), false);
  const signalFree = snapshot({
    rateLimit: null,
    additionalRateLimits: [],
    credits: null,
    resetCredits: null,
    allowed: true,
    limitReached: false,
  });
  assert.equal(whamUsageSnapshotIsUsable(signalFree, NOW), false);
  // Any single quota section is enough.
  assert.equal(
    whamUsageSnapshotIsUsable(
      snapshot({ rateLimit: null, credits: { hasCredits: true, unlimited: null, balance: null } }),
      NOW,
    ),
    true,
  );
});
