import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CnProvidersQuotaWorker,
  type CnQuotaAccountRef,
  type CnQuotaFailure,
  type CnQuotaFetch,
  type CnQuotaSnapshot,
  type CnQuotaStore,
  clampCnQuotaDebounceMs,
  clampCnQuotaIntervalMs,
  cnQuotaFailureBackoffMs,
  fetchCnProviderQuota,
  parseCnQuotaRetryAfterMs,
} from '../../../src/saas/supply/cn-providers-quota-worker.js';

/*
 * All fixtures are synthetic: fake API keys are assembled at runtime and no
 * live network is ever contacted (the fetch seam is always a fake).
 */

const RESET_ISO = '2026-10-17T12:00:00.000Z';
const RESET_MS = Date.parse(RESET_ISO);
const NOW = 1_760_000_000_000;

function apiKey(): Buffer {
  return Buffer.from('cn-test-key-0123456789');
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ZHIPU_OK_BODY = {
  success: true,
  data: {
    level: 'MAX',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 42, nextResetTime: RESET_MS },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 71, nextResetTime: RESET_MS + 3_600_000 },
    ],
  },
};

const MINIMAX_OK_BODY = {
  base_resp: { status_code: 0, status_msg: '' },
  current_subscribe_title: 'MiniMax Coding Plan',
  model_remains: [
    {
      model_name: 'general',
      current_interval_remaining_percent: 62.5,
      end_time: RESET_MS,
      current_weekly_status: 1,
      current_weekly_remaining_percent: 15,
      weekly_end_time: RESET_MS + 86_400_000,
    },
  ],
};

test('fetchCnProviderQuota authenticates zhipu with the RAW key (no Bearer) and minimax with Bearer', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: CnQuotaFetch = async (url, init) => {
    seen.push({ url: url.toString(), headers: init.headers as Record<string, string> });
    return jsonResponse(url.hostname.includes('minimax') ? MINIMAX_OK_BODY : ZHIPU_OK_BODY);
  };
  const zhipu = await fetchCnProviderQuota('zhipu', apiKey(), fetcher);
  assert.equal(zhipu.state, 'ok');
  assert.equal(seen[0]?.url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(seen[0]?.headers.authorization, 'cn-test-key-0123456789', 'zhipu: raw key, no Bearer prefix');
  assert.equal(seen[0]?.headers['accept-language'], 'en-US,en');

  const minimax = await fetchCnProviderQuota('minimax', apiKey(), fetcher, undefined, {});
  assert.equal(minimax.state, 'ok');
  assert.equal(seen[1]?.url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains');
  assert.equal(seen[1]?.headers.authorization, 'Bearer cn-test-key-0123456789');
});

test('fetchCnProviderQuota applies the team-plan URL and organization headers', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: CnQuotaFetch = async (url, init) => {
    seen.push({ url: url.toString(), headers: init.headers as Record<string, string> });
    return jsonResponse(ZHIPU_OK_BODY);
  };
  const result = await fetchCnProviderQuota('zhipu', apiKey(), fetcher, undefined, {
    team: true,
    organization: 'org-123',
    project: 'proj-9',
  });
  assert.equal(result.state, 'ok');
  assert.equal(seen[0]?.url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2');
  assert.equal(seen[0]?.headers['bigmodel-organization'], 'org-123');
  assert.equal(seen[0]?.headers['bigmodel-project'], 'proj-9');
  // Team without an organization id keeps the personal-plan path.
  const personal = await fetchCnProviderQuota('zhipu', apiKey(), fetcher, undefined, { team: true });
  assert.equal(personal.state, 'ok');
  assert.equal(seen[1]?.url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.equal(seen[1]?.headers['bigmodel-organization'], undefined);
});

test('fetchCnProviderQuota selects the international hosts and parses both providers', async () => {
  const seen: string[] = [];
  const fetcher: CnQuotaFetch = async (url) => {
    seen.push(url.toString());
    return jsonResponse(url.hostname.includes('minimax') ? MINIMAX_OK_BODY : ZHIPU_OK_BODY);
  };
  const zhipu = await fetchCnProviderQuota('zhipu', apiKey(), fetcher, undefined, { international: true });
  assert.equal(zhipu.state, 'ok');
  if (zhipu.state === 'ok') {
    assert.equal(zhipu.fiveHour?.usedPercent, 42);
    assert.equal(zhipu.weekly?.usedPercent, 71);
  }
  assert.equal(seen[0], 'https://api.z.ai/api/monitor/usage/quota/limit');

  const minimax = await fetchCnProviderQuota('minimax', apiKey(), fetcher, undefined, { international: true });
  assert.equal(minimax.state, 'ok');
  if (minimax.state === 'ok') {
    // minimax fields are REMAINING percentages: used = 100 − remaining.
    assert.equal(minimax.fiveHour?.usedPercent, 37.5);
    assert.equal(minimax.weekly?.usedPercent, 85);
  }
  assert.equal(seen[1], 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains');
});

test('fetchCnProviderQuota maps every failure mode to typed results', async () => {
  const cases: readonly {
    name: string;
    response: () => Response;
    expected: { state: string; errorCode?: string; httpStatus?: number | null };
    provider?: string;
  }[] = [
    {
      name: 'credential rejected (401)',
      response: () => new Response('denied', { status: 401 }),
      expected: { state: 'failed', errorCode: 'credential_rejected', httpStatus: 401 },
    },
    {
      name: 'credential rejected (403)',
      response: () => new Response('forbidden', { status: 403 }),
      expected: { state: 'failed', errorCode: 'credential_rejected', httpStatus: 403 },
    },
    {
      name: 'rate limited with hint',
      response: () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
      expected: { state: 'rate_limited', httpStatus: 429 },
    },
    {
      name: 'provider unavailable (503)',
      response: () => new Response('oops', { status: 503 }),
      expected: { state: 'failed', errorCode: 'provider_unavailable', httpStatus: 503 },
    },
    {
      name: 'redirect rejected',
      response: () => new Response('', { status: 302, headers: { location: 'https://elsewhere.test' } }),
      expected: { state: 'failed', errorCode: 'provider_redirect_rejected', httpStatus: 302 },
    },
    {
      name: 'non-json content type',
      response: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      expected: { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: 200 },
    },
    {
      name: 'business error (zhipu success=false)',
      response: () => jsonResponse({ success: false, msg: '当前用户不存在coding plan' }),
      expected: { state: 'failed', errorCode: 'provider_business_error', httpStatus: 200 },
    },
    {
      name: 'business error (minimax base_resp)',
      response: () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'bad key' }, model_remains: [] }),
      expected: { state: 'failed', errorCode: 'provider_business_error', httpStatus: 200 },
      provider: 'minimax',
    },
    {
      name: 'zero observed windows never overwrite the snapshot',
      response: () => jsonResponse({ success: true, data: { limits: [] } }),
      expected: { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: 200 },
    },
  ];
  for (const { name, response, expected, provider = 'zhipu' } of cases) {
    const fetcher: CnQuotaFetch = async () => response();
    const result = await fetchCnProviderQuota(provider, apiKey(), fetcher);
    assert.equal(result.state, expected.state, name);
    if (result.state === 'failed' && expected.errorCode !== undefined) {
      assert.equal(result.errorCode, expected.errorCode, name);
      assert.equal(result.httpStatus, expected.httpStatus ?? null, name);
    }
  }
  // A malformed secret (non-printable bytes) never reaches the wire.
  const badKey = await fetchCnProviderQuota('zhipu', Buffer.from([0xff, 0xfe]), async () => {
    throw new Error('unreachable');
  });
  assert.equal(badKey.state, 'failed');
  if (badKey.state === 'failed') assert.equal(badKey.errorCode, 'credential_format_invalid');
});

test('the worker round claims due accounts and writes snapshots per provider family', async () => {
  const store = new MemoryCnQuotaStore();
  const zhipuAccount = store.add('zhipu');
  const minimaxAccount = store.add('minimax');
  store.due.push(zhipuAccount, minimaxAccount);
  const fetcher: CnQuotaFetch = async (url) =>
    jsonResponse(url.hostname.includes('minimax') ? MINIMAX_OK_BODY : ZHIPU_OK_BODY);

  const worker = new CnProvidersQuotaWorker(store, { fetch: fetcher, now: () => NOW });
  const processed = await worker.runOnce();
  assert.equal(processed, 2);
  assert.equal(store.snapshots.length, 2);

  const zhipuSnapshot = store.snapshots.find((entry) => entry.account.providerId === 'zhipu')?.snapshot;
  assert.ok(zhipuSnapshot);
  assert.equal(zhipuSnapshot.fiveHour?.usedPercent, 42);
  assert.equal(zhipuSnapshot.fiveHour?.resetAt, RESET_ISO);
  assert.equal(zhipuSnapshot.weekly?.usedPercent, 71);

  const minimaxSnapshot = store.snapshots.find((entry) => entry.account.providerId === 'minimax')?.snapshot;
  assert.ok(minimaxSnapshot);
  assert.equal(minimaxSnapshot.fiveHour?.usedPercent, 37.5);
  assert.equal(minimaxSnapshot.weekly?.usedPercent, 85);
  // Failure streaks reset after success.
  assert.equal(store.failures.length, 0);
});

test('the worker writes failures with backoff and honors 429 Retry-After cooldowns', async () => {
  const store = new MemoryCnQuotaStore();
  const account = store.add('minimax');
  store.due.push(account);

  const worker = new CnProvidersQuotaWorker(store, {
    fetch: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
    now: () => NOW,
    random: () => 0,
  });
  const processed = await worker.runOnce();
  assert.equal(processed, 1);
  assert.equal(store.snapshots.length, 0);
  assert.equal(store.failures.length, 1);
  const failure = store.failures[0];
  assert.ok(failure);
  assert.equal(failure.errorCode, 'provider_rate_limited');
  assert.equal(failure.failureCount, 1);
  assert.equal(failure.retryAfterMs, 30_000);
  // The Retry-After hint parks scheduling for exactly that window.
  assert.deepEqual(store.rateLimited, [{ account, untilMs: NOW + 30_000 }]);

  // The second failure doubles the backoff horizon (interval × 2^1).
  store.due.push(account);
  await worker.runOnce();
  const second = store.failures[1];
  assert.ok(second);
  assert.equal(second.failureCount, 2);
  assert.ok(second.nextDueAtMs > failure.nextDueAtMs);
});

test('the worker skips accounts whose credential cannot be unsealed', async () => {
  const store = new MemoryCnQuotaStore();
  const account = store.add('zhipu');
  store.due.push(account);
  store.unsealed = false;
  const worker = new CnProvidersQuotaWorker(store, {
    fetch: async () => {
      throw new Error('unreachable');
    },
    now: () => NOW,
  });
  const processed = await worker.runOnce();
  assert.equal(processed, 1);
  assert.equal(store.snapshots.length, 0);
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0]?.errorCode, 'credential_unavailable');
});

test('clamp + backoff helpers mirror the opencode-go worker bounds', () => {
  assert.equal(clampCnQuotaIntervalMs(undefined), 15 * 60_000);
  assert.equal(clampCnQuotaIntervalMs(1_000), 5 * 60_000);
  assert.equal(clampCnQuotaIntervalMs(Infinity), 15 * 60_000, 'non-finite falls to the default');
  assert.equal(clampCnQuotaDebounceMs(undefined), 60_000);
  assert.equal(clampCnQuotaDebounceMs(5_000), 60_000);

  // No failures: the interval itself (no jitter with random() = 0.5).
  assert.equal(
    cnQuotaFailureBackoffMs(15 * 60_000, 0, null, () => 0.5),
    15 * 60_000,
  );
  // Failure streak 3: interval × 2^2.
  assert.equal(
    cnQuotaFailureBackoffMs(15 * 60_000, 3, null, () => 0.5),
    60 * 60_000,
  );
  // Retry-After never shortens the horizon below the hint.
  assert.equal(
    cnQuotaFailureBackoffMs(15 * 60_000, 0, 2 * 60 * 60_000, () => 0.5),
    2 * 60 * 60_000,
  );
  // Floor: never below one minute.
  assert.equal(cnQuotaFailureBackoffMs(15 * 60_000, 0, null, () => 0.5) < 60_000, false);

  assert.equal(parseCnQuotaRetryAfterMs('30', NOW), 30_000);
  assert.equal(parseCnQuotaRetryAfterMs(new Date(NOW + 60_000).toUTCString(), NOW), 60_000);
  assert.equal(parseCnQuotaRetryAfterMs('0', NOW), null);
  assert.equal(parseCnQuotaRetryAfterMs(null, NOW), null);
});

interface MemorySnapshotEntry {
  account: CnQuotaAccountRef;
  snapshot: CnQuotaSnapshot;
}

class MemoryCnQuotaStore implements CnQuotaStore {
  readonly due: CnQuotaAccountRef[] = [];
  readonly snapshots: MemorySnapshotEntry[] = [];
  readonly failures: CnQuotaFailure[] = [];
  readonly rateLimited: { account: CnQuotaAccountRef; untilMs: number }[] = [];
  private nextId = 1;
  unsealed = true;

  add(providerId: string): CnQuotaAccountRef {
    return {
      ownerKind: 'platform',
      tenantId: null,
      accountId: `acct-${this.nextId++}`,
      providerId,
    };
  }

  async readDueAccounts(): Promise<readonly CnQuotaAccountRef[]> {
    return this.due.splice(0, this.due.length);
  }

  async withUnsealedApiKey<T>(
    _account: CnQuotaAccountRef,
    callback: (secret: Buffer) => Promise<T>,
  ): Promise<T | null> {
    if (!this.unsealed) return null;
    return callback(apiKey());
  }

  async writeQuotaSnapshot(account: CnQuotaAccountRef, snapshot: CnQuotaSnapshot): Promise<void> {
    this.snapshots.push({ account, snapshot });
  }

  async writeQuotaFailure(_account: CnQuotaAccountRef, failure: CnQuotaFailure): Promise<void> {
    this.failures.push(failure);
  }

  async markRateLimited(account: CnQuotaAccountRef, untilMs: number): Promise<void> {
    this.rateLimited.push({ account, untilMs });
  }
}
