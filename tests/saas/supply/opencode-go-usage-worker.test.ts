import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPENCODE_GO_BASE_URL } from '../../../src/saas/gateway/opencode-go/catalog-identity.js';
import {
  clampOpencodeGoUsageDebounceMs,
  clampOpencodeGoUsageIntervalMs,
  deriveOpencodeGoRateLimitUntilMs,
  fetchOpencodeGoUsage,
  OPENCODE_GO_USAGE_MAX_PER_ROUND,
  OPENCODE_GO_USAGE_URL,
  type OpencodeGoUsageAccountRef,
  type OpencodeGoUsageFailure,
  type OpencodeGoUsageFetch,
  type OpencodeGoUsageSnapshot,
  type OpencodeGoUsageStore,
  OpencodeGoUsageWorker,
  type OpencodeGoUsageWorkerOptions,
  opencodeGoUsageFailureBackoffMs,
  parseOpencodeGoUsageResponse,
  parseRetryAfterMs,
  startOpencodeGoUsageWorker,
} from '../../../src/saas/supply/opencode-go-usage-worker.js';

/*
 * All fixtures are synthetic: fake API keys are assembled at runtime and no
 * live network is ever contacted (the fetch seam is always a fake).
 */

const ROLLING_RESET_ISO = '2026-08-13T18:26:39.281Z';
const WEEKLY_RESET_ISO = '2026-08-17T00:00:00.281Z';
const MONTHLY_RESET_ISO = '2026-09-13T13:24:47.281Z';
const ROLLING_RESET_MS = Date.parse(ROLLING_RESET_ISO);
const WEEKLY_RESET_MS = Date.parse(WEEKLY_RESET_ISO);
const MONTHLY_RESET_MS = Date.parse(MONTHLY_RESET_ISO);
/** Injected worker clock: before every fixture reset, so cooldowns are future. */
const NOW_MS = Date.parse('2026-08-13T17:00:00.000Z');
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

type UsageWindowOverride = Record<string, unknown> | null;

function usageBody(
  overrides: { rolling?: UsageWindowOverride; weekly?: UsageWindowOverride; monthly?: UsageWindowOverride } = {},
): string {
  const window = (status: string, percent: number, resetsAt: string) => ({ status, percent, resetsAt });
  return JSON.stringify({
    usage: {
      rolling: overrides.rolling === undefined ? window('ok', 6, ROLLING_RESET_ISO) : overrides.rolling,
      weekly: overrides.weekly === undefined ? window('ok', 2, WEEKLY_RESET_ISO) : overrides.weekly,
      monthly: overrides.monthly === undefined ? window('ok', 1, MONTHLY_RESET_ISO) : overrides.monthly,
    },
  });
}

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

// ---------------------------------------------------------------------------
// In-memory fake store (the Postgres implementation lands with migration 108).
// ---------------------------------------------------------------------------

interface MemoryAccount {
  readonly ref: OpencodeGoUsageAccountRef;
  secret: string | null;
  nextDueAtMs: number | null;
  lastAttemptAtMs: number | null;
  rateLimitedUntilMs: number | null;
  readonly snapshots: OpencodeGoUsageSnapshot[];
  readonly failures: OpencodeGoUsageFailure[];
  readonly rateLimitWrites: number[];
  fetches: number;
}

type DueInput = Parameters<OpencodeGoUsageStore['readDueAccounts']>[0];

class MemoryOpencodeGoUsageStore implements OpencodeGoUsageStore {
  readonly accounts = new Map<string, MemoryAccount>();
  readonly readInputs: DueInput[] = [];

  addAccount(accountId: string, secret: string | null = `test-key-${accountId}`): MemoryAccount {
    const account: MemoryAccount = {
      ref: { ownerKind: 'platform', tenantId: null, accountId },
      secret,
      nextDueAtMs: null,
      lastAttemptAtMs: null,
      rateLimitedUntilMs: null,
      snapshots: [],
      failures: [],
      rateLimitWrites: [],
      fetches: 0,
    };
    this.accounts.set(accountId, account);
    return account;
  }

  expect(accountId: string): MemoryAccount {
    const account = this.accounts.get(accountId);
    assert.ok(account, `unknown fixture account ${accountId}`);
    return account;
  }

  async readDueAccounts(input: DueInput): Promise<readonly OpencodeGoUsageAccountRef[]> {
    this.readInputs.push(input);
    const due = [...this.accounts.values()].filter(
      (account) =>
        (account.nextDueAtMs === null || account.nextDueAtMs <= input.nowMs) &&
        (account.lastAttemptAtMs === null || account.lastAttemptAtMs + input.debounceMs <= input.nowMs) &&
        (account.rateLimitedUntilMs === null || account.rateLimitedUntilMs <= input.nowMs),
    );
    return due.slice(0, input.limit).map((account) => account.ref);
  }

  async withUnsealedApiKey<T>(
    account: OpencodeGoUsageAccountRef,
    callback: (secret: Buffer) => Promise<T>,
  ): Promise<T | null> {
    const fixture = this.accounts.get(account.accountId);
    if (!fixture || fixture.secret === null) return null;
    fixture.fetches += 1;
    return callback(Buffer.from(fixture.secret, 'ascii'));
  }

  async writeUsageSnapshot(account: OpencodeGoUsageAccountRef, snapshot: OpencodeGoUsageSnapshot): Promise<void> {
    const fixture = this.expect(account.accountId);
    fixture.snapshots.push(snapshot);
    fixture.lastAttemptAtMs = snapshot.fetchedAtMs;
    fixture.nextDueAtMs = snapshot.nextDueAtMs;
  }

  async writeUsageFailure(account: OpencodeGoUsageAccountRef, failure: OpencodeGoUsageFailure): Promise<void> {
    const fixture = this.expect(account.accountId);
    fixture.failures.push(failure);
    fixture.lastAttemptAtMs = failure.attemptedAtMs;
    fixture.nextDueAtMs = failure.nextDueAtMs;
  }

  async markRateLimited(account: OpencodeGoUsageAccountRef, untilMs: number): Promise<void> {
    const fixture = this.expect(account.accountId);
    fixture.rateLimitedUntilMs = untilMs;
    fixture.rateLimitWrites.push(untilMs);
  }
}

interface FetchTracker {
  readonly fetch: OpencodeGoUsageFetch;
  count(): number;
  maxConcurrent(): number;
}

/** Fake fetch that records concurrency; the handler defaults to a healthy body. */
function trackingFetch(handler?: (url: URL, init: RequestInit) => Response | Promise<Response>): FetchTracker {
  let calls = 0;
  let inFlight = 0;
  let maxConcurrent = 0;
  const fetch: OpencodeGoUsageFetch = async (url, init) => {
    calls += 1;
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    try {
      if (handler) return await handler(url, init);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return jsonResponse(usageBody());
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, count: () => calls, maxConcurrent: () => maxConcurrent };
}

function workerOptions(overrides: Partial<OpencodeGoUsageWorkerOptions> = {}): OpencodeGoUsageWorkerOptions {
  return { now: () => NOW_MS, random: () => 0.5, ...overrides };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'waitFor timed out');
    await sleep(10);
  }
}

/** Forces a fixture account back to due, past debounce and backoff horizons. */
function forceDue(account: MemoryAccount): void {
  account.nextDueAtMs = NOW_MS - 1;
  account.lastAttemptAtMs = NOW_MS - 10 * 60_000;
}

// ---------------------------------------------------------------------------
// Response parsing (sub2api payload shape).
// ---------------------------------------------------------------------------

test('usage URL is pinned to the catalog base URL, never duplicated', () => {
  assert.equal(OPENCODE_GO_USAGE_URL, `${OPENCODE_GO_BASE_URL}/v1/usage`);
  assert.equal(OPENCODE_GO_BASE_URL, 'https://opencode.ai/zen/go');
});

test('parses the wrapped usage payload with exact window fields', () => {
  const usage = parseOpencodeGoUsageResponse(Buffer.from(usageBody()));
  assert.ok(usage);
  assert.deepEqual(usage.rolling5h, { usedPercent: 6, status: 'ok', resetsAtMs: ROLLING_RESET_MS });
  assert.deepEqual(usage.weekly, { usedPercent: 2, status: 'ok', resetsAtMs: WEEKLY_RESET_MS });
  assert.deepEqual(usage.monthly, { usedPercent: 1, status: 'ok', resetsAtMs: MONTHLY_RESET_MS });
});

test('parses top-level windows without a usage wrapper', () => {
  const usage = parseOpencodeGoUsageResponse(
    Buffer.from(`{"rolling":{"status":"ok","percent":6,"resetsAt":"${ROLLING_RESET_ISO}"}}`),
  );
  assert.ok(usage);
  assert.deepEqual(usage.rolling5h, { usedPercent: 6, status: 'ok', resetsAtMs: ROLLING_RESET_MS });
  assert.equal(usage.weekly, null);
  assert.equal(usage.monthly, null);
});

test('missing window fields degrade to null, never to guesses', () => {
  const usage = parseOpencodeGoUsageResponse(
    Buffer.from(`{"usage":{"rolling":{"status":"ok"},"weekly":{"percent":3}}}`),
  );
  assert.ok(usage);
  assert.deepEqual(usage.rolling5h, { usedPercent: null, status: 'ok', resetsAtMs: null });
  assert.deepEqual(usage.weekly, { usedPercent: 3, status: null, resetsAtMs: null });
  assert.equal(usage.monthly, null);
});

test('unparseable resetsAt and invalid JSON fail closed', () => {
  const usage = parseOpencodeGoUsageResponse(
    Buffer.from(`{"usage":{"rolling":{"status":"ok","percent":6,"resetsAt":"not-a-date"}}}`),
  );
  assert.deepEqual(usage?.rolling5h, { usedPercent: 6, status: 'ok', resetsAtMs: null });
  assert.equal(parseOpencodeGoUsageResponse(Buffer.from('{"usage": {broken')), null);
  assert.equal(parseOpencodeGoUsageResponse(Buffer.from('[]')), null);
  assert.equal(parseOpencodeGoUsageResponse(Buffer.from('{}')), null);
  assert.equal(parseOpencodeGoUsageResponse(Buffer.from('{"usage":{}}')), null);
});

// ---------------------------------------------------------------------------
// Rate-limit cooldown mapping.
// ---------------------------------------------------------------------------

test('rate-limit cooldown maps to the exhausted window reset', () => {
  const usage = parseOpencodeGoUsageResponse(
    Buffer.from(usageBody({ rolling: { status: 'ok', percent: 100, resetsAt: ROLLING_RESET_ISO } })),
  );
  assert.ok(usage);
  assert.equal(deriveOpencodeGoRateLimitUntilMs(usage, NOW_MS), ROLLING_RESET_MS);
});

test('exhausted status without 100 percent still triggers the cooldown', () => {
  const usage = parseOpencodeGoUsageResponse(
    Buffer.from(usageBody({ weekly: { status: 'exhausted', percent: 99, resetsAt: WEEKLY_RESET_ISO } })),
  );
  assert.ok(usage);
  assert.equal(deriveOpencodeGoRateLimitUntilMs(usage, NOW_MS), WEEKLY_RESET_MS);
});

test('multiple exhausted windows cool down until the latest reset', () => {
  const usage = parseOpencodeGoUsageResponse(
    Buffer.from(
      usageBody({
        rolling: { status: 'exhausted', percent: 100, resetsAt: ROLLING_RESET_ISO },
        monthly: { status: 'ok', percent: 100, resetsAt: MONTHLY_RESET_ISO },
      }),
    ),
  );
  assert.ok(usage);
  assert.equal(deriveOpencodeGoRateLimitUntilMs(usage, NOW_MS), MONTHLY_RESET_MS);
});

test('no exhausted window, past resets, or missing resets never guess a cooldown', () => {
  const healthy = parseOpencodeGoUsageResponse(Buffer.from(usageBody()));
  assert.ok(healthy);
  assert.equal(deriveOpencodeGoRateLimitUntilMs(healthy, NOW_MS), null);

  const alreadyReset = parseOpencodeGoUsageResponse(
    Buffer.from(usageBody({ rolling: { status: 'exhausted', percent: 100, resetsAt: ROLLING_RESET_ISO } })),
  );
  assert.ok(alreadyReset);
  assert.equal(deriveOpencodeGoRateLimitUntilMs(alreadyReset, ROLLING_RESET_MS + 1), null);

  const noReset = parseOpencodeGoUsageResponse(
    Buffer.from(usageBody({ rolling: { status: 'exhausted', percent: 100 } })),
  );
  assert.ok(noReset);
  assert.equal(deriveOpencodeGoRateLimitUntilMs(noReset, NOW_MS), null);
});

test('Retry-After parses delta-seconds and HTTP-dates, rejects junk', () => {
  assert.equal(parseRetryAfterMs('120', NOW_MS), 120_000);
  assert.equal(parseRetryAfterMs(' 42 ', NOW_MS), 42_000);
  assert.equal(parseRetryAfterMs('Wed, 13 Aug 2026 18:00:00 GMT', NOW_MS), 3_600_000);
  assert.equal(parseRetryAfterMs('0', NOW_MS), null);
  assert.equal(parseRetryAfterMs('-5', NOW_MS), null);
  assert.equal(parseRetryAfterMs('Wed, 13 Aug 2026 16:00:00 GMT', NOW_MS), null);
  assert.equal(parseRetryAfterMs('soon', NOW_MS), null);
  assert.equal(parseRetryAfterMs(null, NOW_MS), null);
});

// ---------------------------------------------------------------------------
// Interval / debounce / backoff semantics.
// ---------------------------------------------------------------------------

test('interval clamps to the sub2api bounds (default 15min, min 5min, max 24h)', () => {
  assert.equal(clampOpencodeGoUsageIntervalMs(undefined), FIFTEEN_MINUTES_MS);
  assert.equal(clampOpencodeGoUsageIntervalMs(60_000), FIVE_MINUTES_MS);
  assert.equal(clampOpencodeGoUsageIntervalMs(FIVE_MINUTES_MS), FIVE_MINUTES_MS);
  assert.equal(clampOpencodeGoUsageIntervalMs(FIFTEEN_MINUTES_MS), FIFTEEN_MINUTES_MS);
  assert.equal(clampOpencodeGoUsageIntervalMs(48 * 60 * 60_000), 24 * 60 * 60_000);
  assert.equal(clampOpencodeGoUsageIntervalMs(Number.NaN), FIFTEEN_MINUTES_MS);
});

test('debounce clamps to the sub2api bounds (default/min 1min, max 60min)', () => {
  assert.equal(clampOpencodeGoUsageDebounceMs(undefined), 60_000);
  assert.equal(clampOpencodeGoUsageDebounceMs(1), 60_000);
  assert.equal(clampOpencodeGoUsageDebounceMs(60_000), 60_000);
  assert.equal(clampOpencodeGoUsageDebounceMs(120 * 60_000), 60 * 60_000);
  assert.equal(clampOpencodeGoUsageDebounceMs(Number.POSITIVE_INFINITY), 60_000);
});

test('failure backoff grows exponentially, honors Retry-After, caps at 24h', () => {
  const noJitter = () => 0.5;
  assert.equal(opencodeGoUsageFailureBackoffMs(FIFTEEN_MINUTES_MS, 1, null, noJitter), FIFTEEN_MINUTES_MS);
  assert.equal(opencodeGoUsageFailureBackoffMs(FIFTEEN_MINUTES_MS, 2, null, noJitter), 30 * 60_000);
  assert.equal(opencodeGoUsageFailureBackoffMs(FIFTEEN_MINUTES_MS, 7, null, noJitter), FIFTEEN_MINUTES_MS * 64);
  assert.equal(opencodeGoUsageFailureBackoffMs(30 * 60_000, 20, null, noJitter), 24 * 60 * 60_000);
  assert.equal(opencodeGoUsageFailureBackoffMs(FIFTEEN_MINUTES_MS, 1, 2 * 60 * 60_000, noJitter), 2 * 60 * 60_000);
  // The jitter range is ±10% of the base, capped at 5 minutes.
  assert.equal(
    opencodeGoUsageFailureBackoffMs(50 * 60_000, 1, null, () => 0),
    45 * 60_000,
  );
  assert.equal(
    opencodeGoUsageFailureBackoffMs(50 * 60_000, 1, null, () => 0.999_999),
    55 * 60_000,
  );
});

// ---------------------------------------------------------------------------
// Fetch classification.
// ---------------------------------------------------------------------------

test('fetch classifies redirect, auth, 429, 5xx, and non-JSON without throwing', async () => {
  const secret = Buffer.from('test-key-classification', 'ascii');

  const redirect = await fetchOpencodeGoUsage(
    secret,
    async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } }),
  );
  assert.deepEqual(redirect, {
    state: 'failed',
    errorCode: 'provider_redirect_rejected',
    httpStatus: 302,
    retryAfterMs: null,
  });

  const rejected = await fetchOpencodeGoUsage(secret, async () => new Response('', { status: 401 }));
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.state === 'failed' && rejected.errorCode, 'credential_rejected');

  const limited = await fetchOpencodeGoUsage(
    secret,
    async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
  );
  assert.deepEqual(limited, { state: 'rate_limited', httpStatus: 429, retryAfterMs: 120_000 });

  const unavailable = await fetchOpencodeGoUsage(secret, async () => new Response('', { status: 503 }));
  assert.equal(unavailable.state, 'failed');
  assert.equal(unavailable.state === 'failed' && unavailable.errorCode, 'provider_unavailable');

  const notJson = await fetchOpencodeGoUsage(
    secret,
    async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  );
  assert.equal(notJson.state, 'failed');
  assert.equal(notJson.state === 'failed' && notJson.errorCode, 'provider_response_invalid');

  const network = await fetchOpencodeGoUsage(secret, async () => {
    throw new Error('connection reset');
  });
  assert.equal(network.state, 'failed');
  assert.equal(network.state === 'failed' && network.errorCode, 'provider_network_error');
});

test('fetch rejects oversized bodies and non-ASCII keys', async () => {
  const secret = Buffer.from('test-key-bounds', 'ascii');
  const tooLarge = await fetchOpencodeGoUsage(secret, async () => jsonResponse('x'.repeat(512 * 1024 + 1)));
  assert.equal(tooLarge.state, 'failed');
  assert.equal(tooLarge.state === 'failed' && tooLarge.errorCode, 'provider_response_too_large');

  const nonAscii = await fetchOpencodeGoUsage(Buffer.from('not ascii', 'utf8'), async () => jsonResponse(usageBody()));
  assert.equal(nonAscii.state, 'failed');
  assert.equal(nonAscii.state === 'failed' && nonAscii.errorCode, 'credential_format_invalid');
});

// ---------------------------------------------------------------------------
// Worker rounds against the in-memory store.
// ---------------------------------------------------------------------------

test('a healthy round writes the snapshot and schedules the next fetch one interval out', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch();
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  const processed = await worker.runOnce();
  assert.equal(processed, 1);
  assert.equal(tracker.count(), 1);
  assert.equal(store.readInputs[0]?.limit, OPENCODE_GO_USAGE_MAX_PER_ROUND);

  const account = store.expect('account-1');
  assert.equal(account.snapshots.length, 1);
  const snapshot = account.snapshots[0] as OpencodeGoUsageSnapshot;
  assert.deepEqual(snapshot.rolling5h, { usedPercent: 6, status: 'ok', resetsAtMs: ROLLING_RESET_MS });
  assert.deepEqual(snapshot.weekly, { usedPercent: 2, status: 'ok', resetsAtMs: WEEKLY_RESET_MS });
  assert.deepEqual(snapshot.monthly, { usedPercent: 1, status: 'ok', resetsAtMs: MONTHLY_RESET_MS });
  assert.equal(snapshot.nextDueAtMs - snapshot.fetchedAtMs, FIFTEEN_MINUTES_MS);
  assert.equal(account.rateLimitWrites.length, 0);
  assert.equal(account.failures.length, 0);
});

test('an exhausted window in a healthy response parks scheduling at its reset', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch(() =>
    jsonResponse(usageBody({ rolling: { status: 'ok', percent: 100, resetsAt: ROLLING_RESET_ISO } })),
  );
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  await worker.runOnce();
  const account = store.expect('account-1');
  assert.equal(account.snapshots.length, 1);
  assert.deepEqual(account.rateLimitWrites, [ROLLING_RESET_MS]);
});

test('a 429 with Retry-After marks the precise cooldown and backs off the fetch', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  await worker.runOnce();
  const account = store.expect('account-1');
  assert.equal(account.snapshots.length, 0);
  assert.deepEqual(account.rateLimitWrites, [NOW_MS + 120_000]);
  assert.equal(account.failures.length, 1);
  const failure = account.failures[0];
  assert.ok(failure);
  assert.equal(failure.errorCode, 'provider_rate_limited');
  assert.equal(failure.httpStatus, 429);
  assert.equal(failure.retryAfterMs, 120_000);
  assert.equal(failure.attemptedAtMs, NOW_MS);
  // Retry-After (2min) is below the interval backoff (15min), so the usage
  // fetch itself is throttled by the full interval while account scheduling
  // parks at the precise 2-minute hint.
  assert.equal(failure.nextDueAtMs - failure.attemptedAtMs, FIFTEEN_MINUTES_MS);
});

test('a 429 without Retry-After never invents a cooldown', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch(async () => new Response('', { status: 429 }));
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  await worker.runOnce();
  const account = store.expect('account-1');
  assert.equal(account.rateLimitWrites.length, 0);
  assert.equal(account.failures.length, 1);
  assert.equal(account.failures[0]?.retryAfterMs, null);
});

test('failures back off exponentially across rounds and reset on success', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  let respondWithError = true;
  const tracker = trackingFetch(async () =>
    respondWithError ? new Response('', { status: 503 }) : jsonResponse(usageBody()),
  );
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  assert.equal(await worker.runOnce(), 1);
  const account = store.expect('account-1');
  const first = account.failures[0];
  assert.ok(first);
  assert.equal(first.failureCount, 1);
  assert.equal(first.nextDueAtMs - first.attemptedAtMs, FIFTEEN_MINUTES_MS);

  // Still inside the backoff and debounce horizons: not due, no fetch.
  assert.equal(await worker.runOnce(), 0);
  assert.equal(tracker.count(), 1);

  // Past the first backoff: the second failure doubles the horizon.
  forceDue(account);
  assert.equal(await worker.runOnce(), 1);
  const second = account.failures[1];
  assert.ok(second);
  assert.equal(second.failureCount, 2);
  assert.equal(second.nextDueAtMs - second.attemptedAtMs, 2 * FIFTEEN_MINUTES_MS);

  // A success clears the streak; the next failure starts over at count 1.
  respondWithError = false;
  forceDue(account);
  assert.equal(await worker.runOnce(), 1);
  assert.equal(account.snapshots.length, 1);
  respondWithError = true;
  forceDue(account);
  assert.equal(await worker.runOnce(), 1);
  assert.equal(account.failures[2]?.failureCount, 1);
});

test('a missing credential fails closed without fetching', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1', null);
  const tracker = trackingFetch();
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  assert.equal(await worker.runOnce(), 1);
  assert.equal(tracker.count(), 0);
  const failure = store.expect('account-1').failures[0];
  assert.ok(failure);
  assert.equal(failure.errorCode, 'credential_unavailable');
  assert.equal(failure.httpStatus, null);
  assert.equal(failure.nextDueAtMs - failure.attemptedAtMs, FIFTEEN_MINUTES_MS);
});

test('debounce holds off a retried account inside the floor', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  const account = store.addAccount('account-1');
  account.lastAttemptAtMs = NOW_MS - 30_000; // inside the 1-minute debounce
  const tracker = trackingFetch();
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  assert.equal(await worker.runOnce(), 0);
  assert.equal(tracker.count(), 0);
  assert.equal(store.readInputs[0]?.debounceMs, 60_000);

  account.lastAttemptAtMs = NOW_MS - 120_000; // past the floor
  assert.equal(await worker.runOnce(), 1);
  assert.equal(tracker.count(), 1);
});

test('interval and debounce options are clamped before reaching the store', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch();
  const worker = new OpencodeGoUsageWorker(
    store,
    workerOptions({ fetch: tracker.fetch, intervalMs: 60_000, debounceMs: 5_000 }),
  );

  assert.equal(worker.intervalMs, FIVE_MINUTES_MS);
  assert.equal(worker.debounceMs, 60_000);
  await worker.runOnce();
  assert.equal(store.readInputs[0]?.intervalMs, FIVE_MINUTES_MS);
  const snapshot = store.expect('account-1').snapshots[0];
  assert.ok(snapshot);
  assert.equal(snapshot.nextDueAtMs - snapshot.fetchedAtMs, FIVE_MINUTES_MS);
});

test('each round is capped at 20 accounts and drains the remainder next round', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  for (let index = 0; index < 25; index += 1) store.addAccount(`account-${index}`);
  const tracker = trackingFetch();
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  assert.equal(await worker.runOnce(), 20);
  assert.equal(tracker.count(), 20);
  assert.equal(await worker.runOnce(), 5);
  assert.equal(tracker.count(), 25);
  for (let index = 0; index < 25; index += 1) {
    assert.equal(store.expect(`account-${index}`).snapshots.length, 1, `account-${index}`);
  }
});

test('round concurrency never exceeds 4 parallel fetches', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  for (let index = 0; index < 12; index += 1) store.addAccount(`account-${index}`);
  const tracker = trackingFetch(); // 5ms artificial latency per fetch
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  assert.equal(await worker.runOnce(), 12);
  assert.equal(tracker.maxConcurrent(), 4);
});

test('singleflight: concurrent rounds fetch an in-flight account exactly once', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch(async () => {
    await sleep(60);
    return jsonResponse(usageBody());
  });
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  const [first, second] = await Promise.all([worker.runOnce(), worker.runOnce()]);
  assert.equal(first + second, 1);
  assert.equal(tracker.count(), 1);
  assert.equal(store.expect('account-1').snapshots.length, 1);
});

test('close aborts in-flight rounds, discards their writes, and drains', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch(async () => {
    await sleep(80);
    return jsonResponse(usageBody());
  });
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  const round = worker.runOnce();
  await worker.close();
  assert.equal(await round, 0);
  assert.equal(store.expect('account-1').snapshots.length, 0);
  assert.equal(await worker.runOnce(), 0);
});

test('the started worker loop processes accounts and closes cleanly', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  store.addAccount('account-1');
  const tracker = trackingFetch();
  const handle = startOpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch, pollIntervalMs: 100 }));

  await waitFor(() => store.expect('account-1').snapshots.length === 1);
  assert.equal(tracker.count(), 1);
  await handle.close();
  await sleep(150);
  assert.equal(tracker.count(), 1);
});

test('rate-limited accounts are not polled until the cooldown clears', async () => {
  const store = new MemoryOpencodeGoUsageStore();
  const account = store.addAccount('account-1');
  account.rateLimitedUntilMs = NOW_MS + 60_000;
  const tracker = trackingFetch();
  const worker = new OpencodeGoUsageWorker(store, workerOptions({ fetch: tracker.fetch }));

  assert.equal(await worker.runOnce(), 0);
  account.rateLimitedUntilMs = NOW_MS - 1;
  assert.equal(await worker.runOnce(), 1);
});
