import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS,
  type CodexRateLimitSnapshot,
} from '../../src/saas/gateway/codex/quota-headers.js';
import {
  CODEX_ACCOUNT_CREDENTIAL_COOLDOWN_MS,
  CodexAccountPool,
  type CodexPoolAccount,
} from '../../src/server/codex-account-pool.js';
import { classifyCodexAccountFailure } from '../../src/server/codex-account-transport.js';

/*
 * CS4 (docs/standalone-relay-capability-plan-2026-10-30.md D1): unit suite
 * for the codex account pool — round-robin distribution, cooldown skip +
 * recovery with an injected clock, revoked exclusion, 3-strike cooldown,
 * quota retry-after honoring, markSuccess streak reset, engine refresh asks.
 */

interface EngineStub {
  resolveAccessToken(provider: string, accountId?: string): Promise<string>;
  calls: Array<{ provider: string; accountId?: string }>;
}

function engineStub(): EngineStub {
  const calls: EngineStub['calls'] = [];
  return {
    calls,
    async resolveAccessToken(provider: string, accountId?: string) {
      calls.push({ provider, accountId });
      return `tok-${accountId ?? 'default'}`;
    },
  };
}

function account(id: string, overrides: Partial<CodexPoolAccount> = {}): CodexPoolAccount {
  return { id, accessToken: `tok-${id}`, ...overrides };
}

test('pool: round-robin distribution over non-revoked accounts', () => {
  const accounts = [account('a'), account('b'), account('c')];
  const pool = new CodexAccountPool({ listing: () => accounts });
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    const selection = pool.select();
    assert.notEqual(selection, null);
    seen.push(selection!.accountId);
  }
  assert.deepEqual(seen.sort(), ['a', 'a', 'b', 'b', 'c', 'c']);
});

test('pool: empty listing selects null', () => {
  const pool = new CodexAccountPool({ listing: () => [] });
  assert.equal(pool.select(), null);
});

test('pool: revoked accounts are never selected', () => {
  const pool = new CodexAccountPool({
    listing: () => [account('a', { status: 'revoked' }), account('b', { status: 'active' })],
  });
  for (let i = 0; i < 4; i++) {
    const selection = pool.select();
    assert.notEqual(selection, null);
    assert.equal(selection!.accountId, 'b');
  }
  assert.equal(pool.availableCount(), 1);
});

test('pool: credential_expired cooldown skips the account and recovers after 5 minutes', () => {
  let now = 1_000_000;
  const pool = new CodexAccountPool({
    listing: () => [account('a'), account('b')],
    nowMs: () => now,
  });
  pool.markFailure('a', 'credential_expired');
  // a is cooling down: only b is schedulable.
  assert.equal(pool.select()!.accountId, 'b');
  assert.equal(pool.select()!.accountId, 'b');
  now += CODEX_ACCOUNT_CREDENTIAL_COOLDOWN_MS - 1;
  assert.equal(pool.select()!.accountId, 'b');
  now += 1;
  // Cooldown elapsed: a is schedulable again.
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: credential_expired asks the engine for a fresh token (fire-and-forget)', async () => {
  const engine = engineStub();
  const pool = new CodexAccountPool({ listing: () => [account('a')], engine });
  pool.markFailure('a', 'credential_expired');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(engine.calls, [{ provider: 'codex_oauth', accountId: 'a' }]);
});

test('pool: quota cooldown honors the retry-after hint', () => {
  let now = 5_000;
  const pool = new CodexAccountPool({
    listing: () => [account('a'), account('b')],
    nowMs: () => now,
  });
  pool.markFailure('a', 'quota', { retryAfterMs: 30_000 });
  assert.equal(pool.select()!.accountId, 'b');
  now += 29_999;
  assert.equal(pool.select()!.accountId, 'b');
  now += 1;
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: quota cooldown falls back to 60s without a hint', () => {
  let now = 0;
  const pool = new CodexAccountPool({
    listing: () => [account('a'), account('b')],
    nowMs: () => now,
  });
  pool.markFailure('a', 'quota');
  now += 59_999;
  assert.equal(pool.select()!.accountId, 'b');
  now += 1;
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: other failures cool the account after three strikes', () => {
  let now = 0;
  const pool = new CodexAccountPool({
    listing: () => [account('a'), account('b')],
    nowMs: () => now,
  });
  pool.markFailure('a', 'other');
  pool.markFailure('a', 'other');
  // Two strikes: still schedulable.
  assert.equal(pool.select()!.accountId, 'a');
  pool.markFailure('a', 'other');
  // Third strike: 5-minute cooldown.
  assert.equal(pool.select()!.accountId, 'b');
  now += 5 * 60_000;
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: markSuccess clears the failure streak', () => {
  const pool = new CodexAccountPool({ listing: () => [account('a')] });
  pool.markFailure('a', 'other');
  pool.markFailure('a', 'other');
  pool.markSuccess('a');
  pool.markFailure('a', 'other');
  pool.markFailure('a', 'other');
  // The streak restarted at markSuccess: two fresh strikes do not cool down.
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: all accounts cooling down selects null', () => {
  let now = 0;
  const pool = new CodexAccountPool({
    listing: () => [account('a'), account('b')],
    nowMs: () => now,
  });
  pool.markFailure('a', 'credential_expired');
  pool.markFailure('b', 'credential_expired');
  assert.equal(pool.select(), null);
  // Schedulable count follows the cooldowns without advancing round-robin.
  assert.equal(pool.availableCount(), 0);
  now += CODEX_ACCOUNT_CREDENTIAL_COOLDOWN_MS;
  assert.equal(pool.availableCount(), 2);
});

test('pool: selection carries the stored token and chatgpt-account-id (no login fallback)', () => {
  const pool = new CodexAccountPool({
    listing: () => [account('a', { accessToken: 'stored-token', chatgptAccountId: 'chatgpt-42' }), account('b')],
  });
  assert.deepEqual(pool.select(), { accountId: 'a', accessToken: 'stored-token', chatgptAccountId: 'chatgpt-42' });
  // Without an explicit chatgptAccountId the header value stays absent (the
  // id_token email login must never be sent as the account id).
  assert.deepEqual(pool.select(), { accountId: 'b', accessToken: 'tok-b' });
});

test('pool: missing accessToken is omitted so the transport resolves via the engine', () => {
  const pool = new CodexAccountPool({ listing: () => [account('a', { accessToken: undefined })] });
  assert.deepEqual(pool.select(), { accountId: 'a' });
});

test('pool: requires a listing function', () => {
  assert.throws(
    () => new CodexAccountPool({ listing: undefined as unknown as () => readonly CodexPoolAccount[] }),
    /requires an account listing/,
  );
});

test('classifyCodexAccountFailure: 401 credential expired, 429 quota, 403 quota-window body, else other', () => {
  assert.equal(classifyCodexAccountFailure(401), 'credential_expired');
  assert.equal(classifyCodexAccountFailure(401, '{"error":"token expired"}'), 'credential_expired');
  assert.equal(classifyCodexAccountFailure(429), 'quota');
  assert.equal(classifyCodexAccountFailure(429, 'slow down'), 'quota');
  assert.equal(classifyCodexAccountFailure(403, 'You have hit your usage limit'), 'quota');
  assert.equal(classifyCodexAccountFailure(403, 'Quota will reset at midnight'), 'quota');
  assert.equal(classifyCodexAccountFailure(403, 'forbidden'), 'other');
  assert.equal(classifyCodexAccountFailure(500), 'other');
  assert.equal(classifyCodexAccountFailure(502, 'connect timeout'), 'other');
  assert.equal(classifyCodexAccountFailure(400, 'bad request'), 'other');
});

// Keep the helper referenced (mirrors a live-listing pool whose backing store
// can change between selects).
test('pool: listing changes are picked up on the next select', () => {
  const accounts: CodexPoolAccount[] = [account('a')];
  const pool = new CodexAccountPool({ listing: () => accounts });
  assert.equal(pool.select()!.accountId, 'a');
  accounts.push(account('b'));
  assert.equal(pool.select()!.accountId, 'b');
  assert.equal(pool.select()!.accountId, 'a');
});

/*
 * CS3 fix 2 (已知未闭合项 2): passive x-codex-* quota snapshots gate selection
 * through the shared SaaS quota kernel (classifyQuotaPause): pause at the
 * threshold until the classified reset time, stale snapshots stop gating.
 */

function quotaSnapshot(overrides: Partial<CodexRateLimitSnapshot> = {}): CodexRateLimitSnapshot {
  return {
    used5hPercent: 10,
    reset5hSeconds: null,
    window5hMinutes: 300,
    used7dPercent: null,
    reset7dSeconds: null,
    window7dMinutes: null,
    ...overrides,
  };
}

test('pool: quota snapshot pauses the account until the reset deadline', () => {
  let now = 1_000_000;
  const pool = new CodexAccountPool({ listing: () => [account('a'), account('b')], nowMs: () => now });
  pool.markQuotaSnapshot('a', quotaSnapshot({ used5hPercent: 100, reset5hSeconds: 3600 }), now);
  // 5h window fully used with an hour to go: only b is schedulable.
  assert.equal(pool.select()!.accountId, 'b');
  assert.equal(pool.availableCount(), 1);
  now += 3_599_000;
  assert.equal(pool.select()!.accountId, 'b');
  now += 1_000;
  // Reset deadline reached: the window no longer trips the threshold gate.
  assert.equal(pool.select()!.accountId, 'a');
  assert.equal(pool.availableCount(), 2);
});

test('pool: quota snapshot with an already-passed reset deadline never pauses', () => {
  let now = 5_000;
  const pool = new CodexAccountPool({ listing: () => [account('a'), account('b')], nowMs: () => now });
  pool.markQuotaSnapshot('a', quotaSnapshot({ used5hPercent: 100, reset5hSeconds: 1 }), now);
  now += 2_000;
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: a snapshot older than two hours stops gating (probe-allowed)', () => {
  const now = 10_000_000;
  const pool = new CodexAccountPool({ listing: () => [account('a'), account('b')], nowMs: () => now });
  // The reset deadline is still 24h out — only the staleness rule can let a
  // through (exactly one self-healing probe; the pool admits it).
  pool.markQuotaSnapshot(
    'a',
    quotaSnapshot({ used5hPercent: 100, reset5hSeconds: 86_400 }),
    now - CODEX_QUOTA_SNAPSHOT_MAX_AGE_MS - 1,
  );
  assert.equal(pool.select()!.accountId, 'a');
  assert.equal(pool.availableCount(), 2);
});

test('pool: the 7d window pauses independently of the 5h window', () => {
  const now = 1_000_000;
  const pool = new CodexAccountPool({ listing: () => [account('a'), account('b')], nowMs: () => now });
  pool.markQuotaSnapshot('a', quotaSnapshot({ used7dPercent: 100, reset7dSeconds: 86_400 }), now);
  assert.equal(pool.select()!.accountId, 'b');
  assert.equal(pool.availableCount(), 1);
});

test('pool: quota-pause thresholds are pool options (default pauses at 100)', () => {
  const now = 1_000_000;
  const stricter = new CodexAccountPool({
    listing: () => [account('a'), account('b')],
    nowMs: () => now,
    quotaPauseThresholds: { pause5hUsedPercent: 90, pause7dUsedPercent: 90 },
  });
  stricter.markQuotaSnapshot('a', quotaSnapshot({ used5hPercent: 90, reset5hSeconds: 600 }), now);
  assert.equal(stricter.select()!.accountId, 'b');
  // Below the DEFAULT threshold (100): the default-configured pool keeps a.
  const pool = new CodexAccountPool({ listing: () => [account('a'), account('b')], nowMs: () => now });
  pool.markQuotaSnapshot('a', quotaSnapshot({ used5hPercent: 90, reset5hSeconds: 600 }), now);
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: markSuccess clears failures but not the quota pause', () => {
  const now = 1_000_000;
  const pool = new CodexAccountPool({ listing: () => [account('a'), account('b')], nowMs: () => now });
  pool.markQuotaSnapshot('a', quotaSnapshot({ used5hPercent: 100, reset5hSeconds: 3600 }), now);
  pool.markSuccess('a');
  // The snapshot describes upstream state; a served attempt does not un-pause
  // a window the upstream still reports as exhausted.
  assert.equal(pool.select()!.accountId, 'b');
});

test('pool: a malformed quota snapshot call records nothing', () => {
  const now = 1_000_000;
  const pool = new CodexAccountPool({ listing: () => [account('a')], nowMs: () => now });
  pool.markQuotaSnapshot('', quotaSnapshot({ used5hPercent: 100, reset5hSeconds: 3600 }), now);
  pool.markQuotaSnapshot('a', null as unknown as CodexRateLimitSnapshot, now);
  assert.equal(pool.select()!.accountId, 'a');
});

test('pool: selection carries the chatgpt user id for the identity namespace', () => {
  const pool = new CodexAccountPool({
    listing: () => [account('a', { chatgptAccountId: 'chatgpt-42', chatgptUserId: 'user-42' }), account('b')],
  });
  assert.deepEqual(pool.select(), {
    accountId: 'a',
    accessToken: 'tok-a',
    chatgptAccountId: 'chatgpt-42',
    chatgptUserId: 'user-42',
  });
  // Absent stays absent (the transport falls back to the account id).
  assert.deepEqual(pool.select(), { accountId: 'b', accessToken: 'tok-b' });
});
