import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
  WHAM_RATE_LIMIT_RESET_CREDITS_URL,
} from '../../../src/saas/gateway/codex/reset-credits.js';
import { WHAM_USAGE_URL } from '../../../src/saas/gateway/codex/wham-usage.js';
import {
  type CodexWhamAccountRef,
  type CodexWhamCredentialResolution,
  type CodexWhamCredentialSecret,
  type CodexWhamUsageStore,
  CodexWhamUsageStoreError,
  PostgresCodexWhamUsageStore,
} from '../../../src/saas/supply/codex-wham-usage-store-postgres.js';
import {
  CODEX_WHAM_USAGE_MAX_BACKOFF_MS,
  CODEX_WHAM_USAGE_MAX_PER_ROUND,
  CODEX_WHAM_USAGE_MIN_BACKOFF_MS,
  CODEX_WHAM_USAGE_MIN_REFRESH_MS,
  CODEX_WHAM_USAGE_REFRESH_MS,
  CodexWhamUsageWorker,
  clampCodexWhamUsageRefreshMs,
  codexWhamUsageFailureBackoffMs,
  startCodexWhamUsageWorker,
} from '../../../src/saas/supply/codex-wham-usage-worker.js';

const NOW_MS = 1_700_000_000_000;
const CREDIT_EXPIRES_AT = new Date(NOW_MS + 60 * 60_000).toISOString();
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const PLATFORM_ACCOUNT: CodexWhamAccountRef = Object.freeze({
  ownerKind: 'platform',
  tenantId: null,
  accountId: 'account-a',
});

/** 5h primary window (300s) + 7d secondary window (10080s), not exhausted. */
function usageBody(fiveHourUsed: number): Record<string, unknown> {
  return {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: fiveHourUsed,
        limit_window_seconds: 300,
        reset_after_seconds: 600,
        reset_at: Math.floor(NOW_MS / 1000) + 600,
      },
      secondary_window: {
        used_percent: 12.25,
        limit_window_seconds: 10080,
        reset_after_seconds: 999,
        reset_at: Math.floor(NOW_MS / 1000) + 999,
      },
    },
    rate_limit_reset_credits: {
      available_count: fiveHourUsed >= 100 ? 1 : 0,
      credits:
        fiveHourUsed >= 100
          ? [{ id: 'credit-1', reset_type: 'codex_rate_limits', status: 'available', expires_at: CREDIT_EXPIRES_AT }]
          : [],
    },
  };
}

const DETAILS_BODY = [
  { id: 'credit-1', reset_type: 'codex_rate_limits', status: 'available', expires_at: CREDIT_EXPIRES_AT },
];

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

type Route =
  | { readonly status: number; readonly body: string }
  | (() => { readonly status: number; readonly body: string });

function fakeFetch(routes: Record<string, Route>) {
  const calls: RecordedRequest[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init.method as string,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const route = routes[`${init.method as string} ${url}`];
    if (route === undefined) throw new Error(`unexpected fetch: ${init.method as string} ${url}`);
    const resolved = typeof route === 'function' ? route() : route;
    return new Response(resolved.body, { status: resolved.status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch };
}

function jsonResponse(status: number, body: unknown): { readonly status: number; readonly body: string } {
  return { status, body: JSON.stringify(body) };
}

interface WrittenSnapshot {
  readonly account: CodexWhamAccountRef;
  readonly snapshot: Record<string, unknown>;
  readonly observedAtMs: number;
}

function fakeStore(
  overrides: {
    claimed?: readonly CodexWhamAccountRef[];
    credential?: CodexWhamCredentialSecret | null;
    claimError?: boolean;
  } = {},
): CodexWhamUsageStore & { written: WrittenSnapshot[]; claims: Array<{ refreshMs: number; limit: number }> } {
  const claims: Array<{ refreshMs: number; limit: number }> = [];
  const written: WrittenSnapshot[] = [];
  const credential: CodexWhamCredentialSecret | null =
    overrides.credential === undefined ? { accessToken: 'token-a', chatgptAccountId: 'acct-a' } : overrides.credential;
  const store: CodexWhamUsageStore = {
    async claimDueCodexAccounts(input) {
      if (overrides.claimError) throw new Error('claim unavailable');
      claims.push({ refreshMs: input.refreshMs, limit: input.limit });
      return overrides.claimed ?? [];
    },
    async withUnsealedCodexCredential<T>(
      _account: CodexWhamAccountRef,
      callback: (secret: CodexWhamCredentialSecret) => Promise<T>,
    ): Promise<CodexWhamCredentialResolution<T>> {
      if (credential === null) return { state: 'failed', reason: 'credential_unavailable' };
      return { state: 'ok', value: await callback(credential) };
    },
    async writeSnapshot(account, snapshot, observedAtMs) {
      written.push({ account, snapshot: snapshot as unknown as Record<string, unknown>, observedAtMs });
    },
  };
  return Object.assign(store, { written, claims });
}

test('a round claims due accounts, queries /wham/usage and writes the normalized 5h/7d snapshot', async () => {
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT] });
  const routes = fakeFetch({ [`GET ${WHAM_USAGE_URL}`]: jsonResponse(200, usageBody(42.5)) });
  const worker = new CodexWhamUsageWorker(store, { now: () => NOW_MS, fetch: routes.fetch });
  assert.equal(await worker.runOnce(), 1);

  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0]?.limit, CODEX_WHAM_USAGE_MAX_PER_ROUND);
  assert.equal(store.claims[0]?.refreshMs, CODEX_WHAM_USAGE_REFRESH_MS);

  assert.equal(routes.calls.length, 1);
  const request = routes.calls[0];
  assert.equal(request.method, 'GET');
  assert.equal(request.url, WHAM_USAGE_URL);
  assert.equal(request.headers.authorization, 'Bearer token-a');
  assert.equal(request.headers['chatgpt-account-id'], 'acct-a');
  assert.equal(request.headers.originator, 'Codex Desktop');
  assert.equal(request.headers['openai-beta'], 'codex-1');

  assert.equal(store.written.length, 1);
  const written = store.written[0];
  assert.equal(written.account.accountId, 'account-a');
  assert.equal(written.observedAtMs, NOW_MS);
  assert.deepEqual(
    { ...written.snapshot },
    {
      used5hPercent: 42.5,
      reset5hSeconds: 600,
      window5hMinutes: 5,
      used7dPercent: 12.25,
      reset7dSeconds: 999,
      window7dMinutes: 168,
    },
  );
});

test('auto reset stays off by default even when a window is exhausted with a credit available', async () => {
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT] });
  const routes = fakeFetch({ [`GET ${WHAM_USAGE_URL}`]: jsonResponse(200, usageBody(100)) });
  const worker = new CodexWhamUsageWorker(store, { now: () => NOW_MS, fetch: routes.fetch });
  assert.equal(await worker.runOnce(), 1);

  assert.equal(routes.calls.length, 1);
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0]?.snapshot.used5hPercent, 100);
});

test('auto reset consumes an available credit with a UUID idempotency key and re-fetches usage', async () => {
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT] });
  let usageFetches = 0;
  const routes = fakeFetch({
    [`GET ${WHAM_USAGE_URL}`]: () => jsonResponse(200, usageBody(usageFetches++ === 0 ? 100 : 10)),
    [`GET ${WHAM_RATE_LIMIT_RESET_CREDITS_URL}`]: jsonResponse(200, DETAILS_BODY),
    [`POST ${WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL}`]: jsonResponse(200, { redeemed: true }),
  });
  const worker = new CodexWhamUsageWorker(store, {
    autoResetEnabled: true,
    now: () => NOW_MS,
    fetch: routes.fetch,
  });
  assert.equal(await worker.runOnce(), 1);

  assert.deepEqual(
    routes.calls.map((call) => `${call.method} ${call.url}`),
    [
      `GET ${WHAM_USAGE_URL}`,
      `GET ${WHAM_RATE_LIMIT_RESET_CREDITS_URL}`,
      `POST ${WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL}`,
      `GET ${WHAM_USAGE_URL}`,
    ],
  );

  const consume = routes.calls[2];
  assert.match(consume?.headers.authorization ?? '', /^Bearer token-a$/);
  const consumeBody = JSON.parse(consume?.body ?? '{}') as { redeem_request_id?: string; credit_id?: string };
  assert.match(consumeBody.redeem_request_id ?? '', UUID_V4);
  assert.equal(consumeBody.credit_id, 'credit-1');

  assert.equal(store.written.length, 2);
  assert.equal(store.written[0]?.snapshot.used5hPercent, 100);
  assert.equal(store.written[1]?.snapshot.used5hPercent, 10);
});

test('a consume 4xx skips the re-fetch and never fails the round', async () => {
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT] });
  const routes = fakeFetch({
    [`GET ${WHAM_USAGE_URL}`]: jsonResponse(200, usageBody(100)),
    [`GET ${WHAM_RATE_LIMIT_RESET_CREDITS_URL}`]: jsonResponse(200, DETAILS_BODY),
    [`POST ${WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL}`]: jsonResponse(404, '{"error":"not_found"}'),
  });
  const worker = new CodexWhamUsageWorker(store, {
    autoResetEnabled: true,
    now: () => NOW_MS,
    fetch: routes.fetch,
  });
  assert.equal(await worker.runOnce(), 1);

  assert.equal(routes.calls.length, 3);
  assert.equal(routes.calls.at(-1)?.url, WHAM_RATE_LIMIT_RESET_CREDITS_CONSUME_URL);
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0]?.snapshot.used5hPercent, 100);
});

test('auto reset stops before the details fetch when the summary reports zero available credits', async () => {
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT] });
  const exhaustedNoCredits = usageBody(100);
  const body = {
    ...exhaustedNoCredits,
    rate_limit_reset_credits: { available_count: 0, credits: [] },
  };
  const routes = fakeFetch({ [`GET ${WHAM_USAGE_URL}`]: jsonResponse(200, body) });
  const worker = new CodexWhamUsageWorker(store, {
    autoResetEnabled: true,
    now: () => NOW_MS,
    fetch: routes.fetch,
  });
  assert.equal(await worker.runOnce(), 1);
  assert.equal(routes.calls.length, 1);
  assert.equal(store.written.length, 1);
});

test('an unparsable body writes nothing and backs the account off', async () => {
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT] });
  let usageFetches = 0;
  const routes = fakeFetch({
    [`GET ${WHAM_USAGE_URL}`]: () =>
      usageFetches++ === 0 ? { status: 200, body: 'definitely not json' } : jsonResponse(200, usageBody(42.5)),
  });
  let clock = NOW_MS;
  const worker = new CodexWhamUsageWorker(store, { now: () => clock, fetch: routes.fetch, random: () => 0.5 });

  assert.equal(await worker.runOnce(), 1);
  assert.equal(routes.calls.length, 1);
  assert.equal(store.written.length, 0);

  // An immediate second round re-claims the account but the backoff window
  // (15min default, no jitter here) keeps it out of the fetch path.
  assert.equal(await worker.runOnce(), 1);
  assert.equal(routes.calls.length, 1);
  assert.equal(store.written.length, 0);

  // Past the backoff window the same worker queries again and now succeeds.
  clock = NOW_MS + 20 * 60_000;
  assert.equal(await worker.runOnce(), 1);
  assert.equal(routes.calls.length, 2);
  assert.equal(store.written.length, 1);
  assert.equal(store.written[0]?.snapshot.used5hPercent, 42.5);
});

test('an unavailable credential skips the account without any fetch or write', async () => {
  const observed: string[] = [];
  const store = fakeStore({ claimed: [PLATFORM_ACCOUNT], credential: null });
  const routes = fakeFetch({});
  const worker = new CodexWhamUsageWorker(store, {
    now: () => NOW_MS,
    fetch: routes.fetch,
    onError: (kind) => observed.push(kind),
  });
  assert.equal(await worker.runOnce(), 1);
  assert.equal(routes.calls.length, 0);
  assert.equal(store.written.length, 0);
  assert.deepEqual(observed, ['credential_unavailable']);
});

test('a claim failure is reported and fails open (zero processed, no throw)', async () => {
  const observed: string[] = [];
  const store = fakeStore({ claimError: true });
  const routes = fakeFetch({});
  const worker = new CodexWhamUsageWorker(store, {
    now: () => NOW_MS,
    fetch: routes.fetch,
    onError: (kind) => observed.push(kind),
  });
  assert.equal(await worker.runOnce(), 0);
  assert.equal(routes.calls.length, 0);
  assert.deepEqual(observed, ['claim_failed']);
});

test('an empty claim runs no fetches', async () => {
  const store = fakeStore({ claimed: [] });
  const routes = fakeFetch({});
  const worker = new CodexWhamUsageWorker(store, { now: () => NOW_MS, fetch: routes.fetch });
  assert.equal(await worker.runOnce(), 0);
  assert.equal(routes.calls.length, 0);
});

test('refresh intervals and failure backoff clamp to the documented bounds', () => {
  assert.equal(clampCodexWhamUsageRefreshMs(undefined), CODEX_WHAM_USAGE_REFRESH_MS);
  assert.equal(clampCodexWhamUsageRefreshMs(1_000), CODEX_WHAM_USAGE_MIN_REFRESH_MS);
  assert.equal(clampCodexWhamUsageRefreshMs(100 * 60 * 60_000), 24 * 60 * 60_000);
  assert.equal(clampCodexWhamUsageRefreshMs(Number.NaN), CODEX_WHAM_USAGE_REFRESH_MS);

  // ±10% jitter around the 15min default.
  assert.equal(
    codexWhamUsageFailureBackoffMs(CODEX_WHAM_USAGE_REFRESH_MS, 1, () => 0),
    13.5 * 60_000,
  );
  assert.equal(
    codexWhamUsageFailureBackoffMs(CODEX_WHAM_USAGE_REFRESH_MS, 1, () => 1),
    16.5 * 60_000,
  );
  // Floor and cap.
  assert.equal(
    codexWhamUsageFailureBackoffMs(1_000, 1, () => 0.5),
    CODEX_WHAM_USAGE_MIN_BACKOFF_MS,
  );
  // 15min × 2^6 = 16h; ±10% jitter keeps it inside [14.4h, 17.6h].
  for (const random of [0, 0.5, 1]) {
    const backoff = codexWhamUsageFailureBackoffMs(CODEX_WHAM_USAGE_REFRESH_MS, 20, () => random);
    assert.ok(backoff >= 14.4 * 60 * 60_000, `backoff too small: ${backoff}`);
    assert.ok(backoff <= 17.6 * 60 * 60_000, `backoff too large: ${backoff}`);
  }
  // A 24h refresh caps the streak backoff at 24h even after jitter.
  for (const random of [0, 0.5, 1]) {
    const backoff = codexWhamUsageFailureBackoffMs(24 * 60 * 60_000, 20, () => random);
    assert.ok(backoff >= 21.6 * 60 * 60_000, `backoff too small: ${backoff}`);
    assert.ok(backoff <= CODEX_WHAM_USAGE_MAX_BACKOFF_MS, `backoff too large: ${backoff}`);
  }
});

test('close halts the worker, is idempotent, and runOnce becomes a no-op', async () => {
  const store = fakeStore({ claimed: [] });
  const worker = new CodexWhamUsageWorker(store, { now: () => NOW_MS });
  assert.equal(await worker.runOnce(), 0);
  const first = worker.close();
  await first;
  assert.strictEqual(worker.close(), first);
  assert.equal(await worker.runOnce(), 0);
});

test('startCodexWhamUsageWorker resolves close idempotently and leaves no pending round', async () => {
  const store = fakeStore({ claimed: [] });
  const handle = startCodexWhamUsageWorker(store, { now: () => NOW_MS, pollIntervalMs: 60_000 });
  await handle.close();
  await handle.close();
  assert.equal(store.claims.length, 1);
});

// ---------------------------------------------------------------------------
// Postgres store (fake database implementing the SaasDatabase query surface).
// ---------------------------------------------------------------------------

const DEPLOYMENT = 'codex-wham-store-test-deployment';
const ENVIRONMENT = 'codex-wham-store-test-env';
const TENANT_ID = '00000000-0000-0000-0000-0000000000bb';
const PG_ACCOUNT_ID = '00000000-0000-0000-0000-0000000000cc';

const TENANT_REF: CodexWhamAccountRef = Object.freeze({
  ownerKind: 'tenant',
  tenantId: TENANT_ID,
  accountId: PG_ACCOUNT_ID,
});
const PLATFORM_REF: CodexWhamAccountRef = Object.freeze({
  ownerKind: 'platform',
  tenantId: null,
  accountId: PG_ACCOUNT_ID,
});

const plaintextKey = Buffer.alloc(32, 0x5b);
const sealingKms = {
  generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('wham-fixture-wrapped-dek') }),
};
const unsealingKms: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => plaintextKey,
};

function accountRow(ownerKind: 'tenant' | 'platform'): Row {
  const row: Row = {
    owner: ownerKind,
    id: PG_ACCOUNT_ID,
    provider_id: 'openai-codex',
    product_id: 'codex-chatgpt',
    credential_type: 'oauth',
    purpose: 'inference',
  };
  if (ownerKind === 'tenant') row.tenant_id = TENANT_ID;
  return row;
}

async function sealFixtureCredential(ownerKind: 'tenant' | 'platform', secretJson: string): Promise<Row> {
  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: TENANT_ID,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'openai-codex',
          productId: 'codex-chatgpt',
          credentialType: 'oauth',
          accountId: PG_ACCOUNT_ID,
          credentialId: 'credential-1',
          credentialVersion: 1,
        }
      : {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          providerId: 'openai-codex',
          productId: 'codex-chatgpt',
          credentialType: 'oauth',
          accountId: PG_ACCOUNT_ID,
          credentialId: 'credential-1',
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(Buffer.from(secretJson), context, sealingKms, 'wham-fixture-kms');
  return {
    version: 1,
    schema_version: 1,
    context_version: 1,
    algorithm: 'aes-256-gcm',
    kms_purpose: 'inference',
    kms_key_id: envelope.kmsKeyId,
    wrapped_dek: envelope.wrappedDek,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    auth_tag: envelope.authTag,
  };
}

type Row = Record<string, unknown>;

interface FakeState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  readonly updates: Array<{ sql: string; values: readonly unknown[] }>;
  claimRows: Row[];
  accountRows: Row[];
  credentialRows: Row[];
  versionRows: Row[];
}

class FakeDatabase implements SaasDatabase {
  constructor(readonly state: FakeState) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    let rows: Row[];
    if (sql.startsWith('UPDATE')) {
      this.state.updates.push({ sql, values });
      // Each owner scope claims only from its own table.
      rows = sql.includes('FOR UPDATE SKIP LOCKED')
        ? this.state.claimRows.filter(
            (row) =>
              !(
                (sql.includes('saas_tenant_provider_accounts') && row.owner === 'platform') ||
                (sql.includes('saas_platform_provider_accounts') && row.owner === 'tenant')
              ),
          )
        : [];
    } else if (sql.includes('_provider_accounts')) {
      rows = this.state.accountRows;
    } else if (sql.includes('_provider_credential_versions')) {
      rows = this.state.versionRows;
    } else if (sql.includes('_provider_credentials')) {
      rows = this.state.credentialRows;
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 120)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    statements: [],
    updates: [],
    claimRows: [],
    accountRows: [],
    credentialRows: [],
    versionRows: [],
    ...overrides,
  };
}

function snapshotSink() {
  const writes: Array<{ account: CodexWhamAccountRef; snapshot: unknown; observedAtMs: number }> = [];
  return {
    writes,
    sink: {
      async writeCodexSnapshot(account: CodexWhamAccountRef, snapshot: unknown, observedAtMs: number): Promise<void> {
        writes.push({ account, snapshot, observedAtMs });
      },
    },
  };
}

function pgStore(state: FakeState, sink = snapshotSink().sink): PostgresCodexWhamUsageStore {
  return new PostgresCodexWhamUsageStore(new FakeDatabase(state), unsealingKms, sink, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
    nowMs: () => 1_000_000,
  });
}

test('claimDueCodexAccounts stamps codex_usage_updated_at with a SKIP LOCKED lease per owner scope', async () => {
  const state = fakeState({ claimRows: [accountRow('tenant'), accountRow('platform')] });
  const refs = await pgStore(state).claimDueCodexAccounts({ refreshMs: 900_000, limit: 5 });
  assert.deepEqual(refs, [TENANT_REF, PLATFORM_REF]);
  assert.equal(state.updates.length, 2);
  for (const claim of state.updates) {
    assert.match(claim.sql, /^UPDATE saas_(tenant|platform)_provider_accounts AS account/);
    assert.match(claim.sql, /SET codex_usage_updated_at = \$1::timestamptz, updated_at = clock_timestamp\(\)/);
    assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(claim.sql, /LIMIT \$6/);
    assert.match(claim.sql, /claim\.codex_usage_updated_at IS NULL/);
    assert.match(
      claim.sql,
      /claim\.codex_usage_updated_at\s+<= clock_timestamp\(\) - \(\$5::text \|\| ' seconds'\)::interval/,
    );
    assert.match(claim.sql, /claim\.status = 'active' AND claim\.validation_state = 'verified'/);
    assert.deepEqual(claim.values, [
      new Date(1_000_000).toISOString(),
      'openai-codex',
      'codex-chatgpt',
      'oauth',
      '900',
      5,
    ]);
  }
});

test('withUnsealedCodexCredential unseals the current OAuth credential into the quota-plane identity', async () => {
  const secretJson = JSON.stringify({ access_token: 'wham-token-1', chatgpt_account_id: 'wham-account-1' });
  for (const ownerKind of ['tenant', 'platform'] as const) {
    const state = fakeState({
      accountRows: [accountRow(ownerKind)],
      credentialRows: [{ id: 'credential-1', current_version: 1 }],
      versionRows: [await sealFixtureCredential(ownerKind, secretJson)],
    });
    const seen: CodexWhamCredentialSecret[] = [];
    const result = await pgStore(state).withUnsealedCodexCredential(
      ownerKind === 'tenant' ? TENANT_REF : PLATFORM_REF,
      async (secret) => {
        seen.push(secret);
        return secret.accessToken;
      },
    );
    assert.deepEqual(result, { state: 'ok', value: 'wham-token-1' });
    assert.deepEqual(seen, [{ accessToken: 'wham-token-1', chatgptAccountId: 'wham-account-1' }]);
    // The account binding is re-resolved server-side, never trusted.
    const binding = state.statements[0];
    assert.match(binding?.sql ?? '', /account\.provider_id = \$\d+/);
    assert.ok(binding?.values.includes('openai-codex'));
    assert.ok(binding?.values.includes('codex-chatgpt'));
    assert.ok(binding?.values.includes('oauth'));
  }
});

test('withUnsealedCodexCredential resolves a typed failure without invoking the callback when no credential exists', async () => {
  const state = fakeState({ accountRows: [accountRow('platform')], credentialRows: [] });
  let invoked = 0;
  const result = await pgStore(state).withUnsealedCodexCredential(PLATFORM_REF, async () => {
    invoked += 1;
    return 'never';
  });
  assert.deepEqual(result, { state: 'failed', reason: 'credential_unavailable' });
  assert.equal(invoked, 0);
});

test('withUnsealedCodexCredential reports a format failure for a non-OAuth plaintext shape', async () => {
  const state = fakeState({
    accountRows: [accountRow('platform')],
    credentialRows: [{ id: 'credential-1', current_version: 1 }],
    versionRows: [await sealFixtureCredential('platform', JSON.stringify({ access_token: 'wham-token-1' }))],
  });
  let invoked = 0;
  const result = await pgStore(state).withUnsealedCodexCredential(PLATFORM_REF, async () => {
    invoked += 1;
    return 'never';
  });
  assert.deepEqual(result, { state: 'failed', reason: 'credential_format_invalid' });
  assert.equal(invoked, 0);
});

test('writeSnapshot delegates to the injected quota-snapshot sink with the observed timestamp', async () => {
  const state = fakeState();
  const sink = snapshotSink();
  await pgStore(state, sink.sink).writeSnapshot(
    PLATFORM_REF,
    {
      used5hPercent: 41.5,
      reset5hSeconds: 600,
      window5hMinutes: 300,
      used7dPercent: null,
      reset7dSeconds: null,
      window7dMinutes: null,
    },
    1_500_000,
  );
  assert.equal(state.updates.length, 0);
  assert.equal(sink.writes.length, 1);
  assert.equal(sink.writes[0]?.account.accountId, PG_ACCOUNT_ID);
  assert.equal(sink.writes[0]?.observedAtMs, 1_500_000);
  assert.deepEqual(sink.writes[0]?.snapshot, {
    used5hPercent: 41.5,
    reset5hSeconds: 600,
    window5hMinutes: 300,
    used7dPercent: null,
    reset7dSeconds: null,
    window7dMinutes: null,
  });
});

test('the Postgres store wraps database failures as a stable store-unavailable error', async () => {
  const failing: SaasDatabase = {
    query: async () => {
      throw new Error('connection reset');
    },
    transaction: async () => {
      throw new Error('connection reset');
    },
    migrate: async () => {},
    verifySchema: async () => {},
    ping: async () => {},
    close: async () => {},
  };
  const store = new PostgresCodexWhamUsageStore(failing, unsealingKms, snapshotSink().sink, {
    deployment: DEPLOYMENT,
    environment: ENVIRONMENT,
  });
  await assert.rejects(store.claimDueCodexAccounts({ refreshMs: 60_000, limit: 1 }), CodexWhamUsageStoreError);
});
