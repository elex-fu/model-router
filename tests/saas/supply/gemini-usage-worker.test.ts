import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEMINI_USAGE_MAX_PER_ROUND, GeminiUsageWorker } from '../../../src/saas/supply/gemini-usage-worker.js';

const NOW_MS = 1_700_000_000_000;

interface StoreCall {
  readonly kind: string;
  readonly accountId?: string;
  readonly windowStartMs?: number;
}

function fakeStore(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: StoreCall[] = [];
  const store = {
    calls,
    async claimDueGeminiAccounts(input: { refreshMs: number; limit: number }) {
      calls.push({ kind: 'claim' });
      assert.ok(input.limit >= 1 && input.limit <= GEMINI_USAGE_MAX_PER_ROUND);
      return (overrides.claimed ?? []) as never;
    },
    async readGeminiWindowRequestCounts(_account: unknown, windowStartMs: number) {
      calls.push({ kind: 'counts', windowStartMs });
      return (overrides.requests ?? {}) as never;
    },
    async readGeminiMinuteRequestCount() {
      calls.push({ kind: 'minute' });
      return (overrides.minuteRequests ?? 0) as never;
    },
    async writeGeminiSnapshot(account: { accountId: string }, snapshot: unknown) {
      calls.push({ kind: 'write', accountId: account.accountId });
      (store as { snapshots?: unknown[] }).snapshots.push(snapshot);
    },
    snapshots: [] as unknown[],
  };
  return store;
}

test('a round claims due accounts, folds request counts and writes the tier snapshot', async () => {
  const store = fakeStore({
    claimed: [
      { ownerKind: 'tenant', tenantId: 'tenant-1', accountId: 'account-a', tierId: 'tier-free' },
      { ownerKind: 'platform', tenantId: null, accountId: 'account-b', tierId: null },
    ],
    requests: { 'gemini-2.5-pro': 4, 'gemini-2.5-flash': 1 },
    minuteRequests: 2,
  });
  const worker = new GeminiUsageWorker(store, { now: () => NOW_MS });
  const processed = await worker.runOnce();
  assert.equal(processed, 2);
  assert.equal(store.snapshots.length, 2);
  for (const snapshot of store.snapshots as Array<Record<string, unknown>>) {
    assert.ok(typeof snapshot.dailyResetAtMs === 'number');
    assert.ok(typeof snapshot.observedAtMs === 'number');
  }
  assert.deepEqual(
    store.calls.map((call) => call.kind),
    ['claim', 'counts', 'minute', 'write', 'counts', 'minute', 'write'],
  );
});

test('a claim failure is reported and fails open (zero processed, no throw)', async () => {
  const observed: string[] = [];
  const store = {
    async claimDueGeminiAccounts() {
      throw new Error('unavailable');
    },
    async readGeminiWindowRequestCounts() {
      throw new Error('unreachable');
    },
    async readGeminiMinuteRequestCount() {
      throw new Error('unreachable');
    },
    async writeGeminiSnapshot() {
      throw new Error('unreachable');
    },
  };
  const worker = new GeminiUsageWorker(store, {
    now: () => NOW_MS,
    onError: (kind) => observed.push(kind),
  });
  assert.equal(await worker.runOnce(), 0);
  assert.deepEqual(observed, ['claim_failed']);
});

test('an account failure is isolated and reported per account', async () => {
  const observed: string[] = [];
  const store = fakeStore({
    claimed: [
      { ownerKind: 'tenant', tenantId: 'tenant-1', accountId: 'account-a', tierId: null },
      { ownerKind: 'tenant', tenantId: 'tenant-1', accountId: 'account-b', tierId: null },
    ],
  });
  const original = store.readGeminiWindowRequestCounts.bind(store);
  store.readGeminiWindowRequestCounts = (async (account: { accountId: string }, start: number) => {
    if (account.accountId === 'account-a') throw new Error('account failed');
    return original(account, start);
  }) as typeof original;
  const worker = new GeminiUsageWorker(store, {
    now: () => NOW_MS,
    onError: (kind) => observed.push(kind),
  });
  assert.equal(await worker.runOnce(), 1);
  assert.deepEqual(observed, ['account_failed']);
  assert.equal(store.snapshots.length, 1);
});

test('close halts the loop and runOnce becomes a no-op', async () => {
  const store = fakeStore({ claimed: [] });
  const worker = new GeminiUsageWorker(store, { now: () => NOW_MS });
  assert.equal(await worker.runOnce(), 0);
  await worker.close();
  assert.equal(await worker.runOnce(), 0);
});
