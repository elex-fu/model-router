import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyLimiter } from '../../src/limit/limiter.js';
import type { ProxyKey } from '../../src/config/types.js';

function makeKey(overrides: Partial<ProxyKey> = {}): ProxyKey {
  return {
    name: 'alice',
    key: 'mrk_alice',
    enabled: true,
    createdAt: '2026-05-03T00:00:00Z',
    ...overrides,
  };
}

function clock(initial: number) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

test('reserveRequest: undefined rpm and dailyTokens = unrestricted', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey();
  for (let i = 0; i < 1000; i++) {
    const r = limiter.reserveRequest('alice', key);
    assert.equal(r.allowed, true, `iteration ${i} expected allowed`);
  }
});

test('reserveRequest: rpm=0 is fully blocked', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ rpm: 0 });
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'rpm_exceeded');
});

test('reserveRequest: dailyTokens=0 is fully blocked', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ dailyTokens: 0 });
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily_tokens_exceeded');
});

test('reserveRequest: rpm allows up to N requests, rejects (N+1) within 60s', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ rpm: 3 });
  for (let i = 0; i < 3; i++) {
    const r = limiter.reserveRequest('alice', key);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const r4 = limiter.reserveRequest('alice', key);
  assert.equal(r4.allowed, false);
  assert.equal(r4.reason, 'rpm_exceeded');
  assert.ok((r4.retryAfterMs ?? 0) > 0);
});

test('reserveRequest: rpm window slides — old timestamps drop out', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ rpm: 2 });

  assert.equal(limiter.reserveRequest('alice', key).allowed, true);
  c.advance(1000);
  assert.equal(limiter.reserveRequest('alice', key).allowed, true);
  // Now at full capacity
  assert.equal(limiter.reserveRequest('alice', key).allowed, false);

  // Advance 60s past the first timestamp; first slot expires
  c.advance(59_001);
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, true);
});

test('reserveRequest: rpm retryAfterMs reflects oldest timestamp expiry', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ rpm: 1 });
  limiter.reserveRequest('alice', key);
  c.advance(10_000);
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, false);
  // oldest stamp is at t=1_000_000, expires at t=1_060_000; current is 1_010_000 → 50_000 ms remaining
  assert.equal(r.retryAfterMs, 50_000);
});

test('recordUsage: accumulates input + output tokens for the day', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ dailyTokens: 1000 });

  limiter.reserveRequest('alice', key);
  limiter.recordUsage('alice', 100, 200);
  limiter.reserveRequest('alice', key);
  limiter.recordUsage('alice', 50, 150);

  const usage = limiter.getUsage('alice');
  assert.equal(usage?.dailyTokensUsed, 500);
});

test('reserveRequest: blocks once dailyTokensUsed >= dailyTokens', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const key = makeKey({ dailyTokens: 500 });

  assert.equal(limiter.reserveRequest('alice', key).allowed, true);
  limiter.recordUsage('alice', 300, 250); // 550 used, > 500

  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily_tokens_exceeded');
});

test('reserveRequest: dailyTokens resets after dailyResetAt', () => {
  const c = clock(1_000_000);
  // Custom reset every 1000ms for this test
  const limiter = new KeyLimiter({
    now: c.now,
    nextDailyReset: (n) => Math.floor(n / 1000) * 1000 + 1000,
  });
  const key = makeKey({ dailyTokens: 100 });

  limiter.reserveRequest('alice', key);
  limiter.recordUsage('alice', 80, 30); // 110 used > 100

  assert.equal(limiter.reserveRequest('alice', key).allowed, false);

  c.set(1_000_000 + 1500); // crossed the next-reset boundary
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, true);
  assert.equal(limiter.getUsage('alice')?.dailyTokensUsed, 0);
});

test('hydrate: seeds dailyTokensUsed from prior persisted totals', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  limiter.hydrate([
    { keyName: 'alice', tokensUsed: 1500 },
    { keyName: 'bob', tokensUsed: 9999 },
  ]);
  assert.equal(limiter.getUsage('alice')?.dailyTokensUsed, 1500);
  assert.equal(limiter.getUsage('bob')?.dailyTokensUsed, 9999);
});

test('hydrate: hydrated tokens count toward subsequent dailyTokens checks', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  limiter.hydrate([{ keyName: 'alice', tokensUsed: 1000 }]);
  const key = makeKey({ dailyTokens: 1000 });
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily_tokens_exceeded');
});

test('rpm and dailyTokens are independent — rpm pass + dailyTokens fail', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  limiter.hydrate([{ keyName: 'alice', tokensUsed: 100 }]);
  const key = makeKey({ rpm: 100, dailyTokens: 50 });
  const r = limiter.reserveRequest('alice', key);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'daily_tokens_exceeded');
});

test('separate keys have isolated usage state', () => {
  const c = clock(1_000_000);
  const limiter = new KeyLimiter({ now: c.now });
  const aliceKey = makeKey({ name: 'alice', rpm: 1 });
  const bobKey = makeKey({ name: 'bob', rpm: 1 });
  assert.equal(limiter.reserveRequest('alice', aliceKey).allowed, true);
  assert.equal(limiter.reserveRequest('alice', aliceKey).allowed, false);
  // bob is unaffected
  assert.equal(limiter.reserveRequest('bob', bobKey).allowed, true);
});
