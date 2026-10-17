import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProviderCredentialContext,
  type ProviderCredentialUnsealingKms,
  sealProviderCredential,
} from '../../../src/saas/credentials/provider-crypto.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/index.js';
import {
  createProviderHttpEgressAllowlist,
  type ProviderHttpEgressAllowlist,
} from '../../../src/saas/gateway/provider-http-address.js';
import { GEMINI_OAUTH_CLIENT_SECRET_ENV } from '../../../src/saas/platform/gemini-oauth/oauth.js';
import { sealEgressProxyCredentials } from '../../../src/saas/supply/egress-proxy-seal.js';
import {
  buildOauthCredentialMaterial,
  GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  geminiOauthTokenAdapters,
  OAUTH_REFRESH_MAX_BACKOFF_MS,
  OAUTH_REFRESH_MIN_BACKOFF_MS,
  OAUTH_REFRESH_STALE_REFRESHING_MS,
  type OauthCredentialRotationInput,
  type OauthTokenRefreshFetch,
  OauthTokenRefreshWorker,
  OauthTokenRefreshWorkerError,
  oauthRefreshFailureBackoffMs,
  oauthRefreshSuccessDelayMs,
  PostgresOauthTokenRefreshWorkerStore,
  parseOauthCredentialMaterial,
  requestOauthTokenRefresh,
  resolveOauthTokenAdapter,
  startOauthTokenRefreshWorker,
} from '../../../src/saas/supply/oauth-token-refresh-worker.js';

type Row = Record<string, unknown>;

const DEPLOYMENT = 'r4-test-deployment';
const ENVIRONMENT = 'r4-test-env';
const TENANT_ID = '00000000-0000-0000-0000-0000000000bb';
const OLD_MATERIAL = JSON.stringify({
  access_token: 'accs-old-token',
  refresh_token: 'rfrsh-old-token',
  token_type: 'Bearer',
  expires_in: 3600,
});

const plaintextKey = Buffer.alloc(32, 0x57);
const sealingKms = {
  generateDataKey: async () => ({ plaintextKey, ciphertextBlob: Buffer.from('r4-fixture-wrapped-dek') }),
};
const unsealingKms: ProviderCredentialUnsealingKms = {
  decryptDataKey: async () => plaintextKey,
};

const anthropicBinding = { providerId: 'anthropic', productId: 'claude-code', credentialType: 'oauth' } as const;

async function sealFixtureCredential(
  ownerKind: 'tenant' | 'platform',
  credentialId: string,
  plaintext: string = OLD_MATERIAL,
): Promise<Row> {
  const context = createProviderCredentialContext(
    ownerKind === 'tenant'
      ? {
          ownerKind: 'tenant',
          tenantId: TENANT_ID,
          supplyMode: 'byok',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          ...anthropicBinding,
          accountId: 'account-a',
          credentialId,
          credentialVersion: 1,
        }
      : {
          ownerKind: 'platform',
          supplyMode: 'platform',
          deployment: DEPLOYMENT,
          environment: ENVIRONMENT,
          purpose: 'inference',
          ...anthropicBinding,
          accountId: 'account-a',
          credentialId,
          credentialVersion: 1,
        },
  );
  const envelope = await sealProviderCredential(Buffer.from(plaintext), context, sealingKms, 'r4-fixture-kms');
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

function credentialRow(ownerKind: 'tenant' | 'platform', overrides: Row = {}): Row {
  const row: Row = {
    id: 'credential-a',
    account_id: 'account-a',
    provider_id: 'anthropic',
    product_id: 'claude-code',
    credential_type: 'oauth',
    current_version: 1,
    oauth_refresh_state: 'idle',
    oauth_next_refresh_at: new Date('2026-01-01T00:00:00Z'),
    oauth_last_refresh_at: new Date('2025-12-31T23:00:00Z'),
    purpose: 'inference',
    ...overrides,
  };
  if (ownerKind === 'tenant') row.tenant_id = TENANT_ID;
  return row;
}

interface FakeState {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }>;
  candidateQueue: Row[][];
  lockedRows?: Row[];
  versionRows: Row[];
  /** Per-claim envelope rows; when present, each versions query shifts one set. */
  versionQueue?: Row[][];
  updates: Array<{ sql: string; values: readonly unknown[] }>;
  rowCountQueue: number[];
  transactionError?: Error;
}

class FakeDatabase implements SaasDatabase {
  private lastCandidateRows: Row[] = [];

  constructor(
    readonly state: FakeState,
    private readonly ownerKind: 'tenant' | 'platform' = 'tenant',
  ) {}

  async query<RowType>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<RowType>> {
    this.state.statements.push({ sql, values });
    // The other owner dimension's tables hold no rows in this fixture, so a
    // poll ordered across both scopes skips straight past them.
    const otherPrefix = this.ownerKind === 'tenant' ? 'saas_platform_provider' : 'saas_tenant_provider';
    if (sql.includes(otherPrefix)) return { rows: [] as RowType[], rowCount: 0 };
    if (sql.startsWith('UPDATE')) {
      this.state.updates.push({ sql, values });
      const rowCount = this.state.rowCountQueue.length > 0 ? this.state.rowCountQueue.shift() : 1;
      return { rows: [] as RowType[], rowCount };
    }
    let rows: Row[];
    if (sql.includes('FOR UPDATE OF credential SKIP LOCKED')) {
      // The lock select re-reads exactly what the candidate select just returned.
      rows = this.state.lockedRows ?? this.lastCandidateRows;
    } else if (sql.includes('JOIN saas_egress_proxies AS proxy')) {
      // R3: the per-account egress lookup. Accounts in this fixture carry no
      // proxy binding, so the refresh runs on the direct path.
      rows = [];
    } else if (sql.includes('_provider_credential_versions')) {
      rows = this.state.versionQueue ? (this.state.versionQueue.shift() ?? []) : this.state.versionRows;
    } else if (sql.includes('_provider_credentials')) {
      this.lastCandidateRows = this.state.candidateQueue.length > 0 ? (this.state.candidateQueue.shift() ?? []) : [];
      rows = this.lastCandidateRows;
    } else {
      throw new Error(`unexpected SQL statement: ${sql.slice(0, 120)}`);
    }
    return { rows: rows as RowType[], rowCount: rows.length };
  }

  async transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.state.transactionError) throw this.state.transactionError;
    return work(this);
  }

  async migrate(): Promise<void> {}
  async verifySchema(): Promise<void> {}
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

function fakeState(ownerKind: 'tenant' | 'platform', versionRow: Row, candidateOverrides: Row = {}): FakeState {
  return {
    statements: [],
    candidateQueue: [[credentialRow(ownerKind, candidateOverrides)]],
    versionRows: [versionRow],
    updates: [],
    rowCountQueue: [],
  };
}

function storeOptions(overrides: Record<string, unknown> = {}) {
  return { deployment: DEPLOYMENT, environment: ENVIRONMENT, ...overrides };
}

function jsonResponse(body: unknown, init: { status?: number; contentType?: string; contentLength?: string } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': init.contentType ?? 'application/json' });
  if (init.contentLength !== undefined) headers.set('content-length', init.contentLength);
  return new Response(text, { status: init.status ?? 200, headers });
}

function fetchReturning(...responses: Array<Response | Error>): OauthTokenRefreshFetch {
  const queue = [...responses];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  };
}

const tokenSuccess = {
  access_token: 'accs-new-token',
  refresh_token: 'rfrsh-new-token',
  expires_in: 3600,
  scope: 'discarded-scope',
  id_token: 'discarded-id-token',
};

function recordingRotator(recorded: Array<{ input: OauthCredentialRotationInput; secretJson: unknown }>) {
  const buffers: Uint8Array[] = [];
  const rotator = async (input: OauthCredentialRotationInput) => {
    buffers.push(input.secret);
    recorded.push({ input, secretJson: JSON.parse(Buffer.from(input.secret).toString('utf8')) });
    return { version: input.expectedVersion + 1 };
  };
  return { rotator, buffers, recorded };
}

test('OAuth credential material parses only the refresh token and rejects non-material', () => {
  assert.deepEqual(parseOauthCredentialMaterial(Buffer.from(OLD_MATERIAL)), {
    refreshToken: 'rfrsh-old-token',
    passthrough: {},
  });
  for (const rejected of [
    '{not json',
    '[1,2]',
    '"text"',
    '{}',
    '{"access_token":"accs"}',
    '{"refresh_token":42}',
    'null',
    '',
  ]) {
    assert.equal(parseOauthCredentialMaterial(Buffer.from(rejected)), null, rejected);
  }
  const built = buildOauthCredentialMaterial({ accessToken: 'a', refreshToken: 'r', expiresInSeconds: 60 });
  assert.deepEqual(JSON.parse(built.toString('utf8')), {
    access_token: 'a',
    refresh_token: 'r',
    token_type: 'Bearer',
    expires_in: 60,
  });
  const withoutExpiry = buildOauthCredentialMaterial({ accessToken: 'a', refreshToken: 'r', expiresInSeconds: null });
  assert.deepEqual(Object.keys(JSON.parse(withoutExpiry.toString('utf8'))).sort(), [
    'access_token',
    'refresh_token',
    'token_type',
  ]);
  // P1c codex envelope passthrough: known ChatGPT metadata fields survive the
  // parse and are re-emitted by the builder; unknown keys never leak through.
  const codexEnvelope = JSON.stringify({
    access_token: 'accs-old',
    refresh_token: 'rfrsh-old',
    token_type: 'Bearer',
    expires_in: 3600,
    chatgpt_account_id: 'acct-1',
    chatgpt_user_id: 'user-1',
    plan_type: 'pro',
    client_id: 'app_client',
    email: 'oper@example.test',
    unknown_extra: 'dropped',
  });
  assert.deepEqual(parseOauthCredentialMaterial(Buffer.from(codexEnvelope)), {
    refreshToken: 'rfrsh-old',
    passthrough: {
      chatgpt_account_id: 'acct-1',
      chatgpt_user_id: 'user-1',
      plan_type: 'pro',
      client_id: 'app_client',
    },
  });
  const rebuilt = buildOauthCredentialMaterial({
    accessToken: 'accs-new',
    refreshToken: 'rfrsh-new',
    expiresInSeconds: 3600,
    passthrough: { chatgpt_account_id: 'acct-1', chatgpt_user_id: 'user-1', plan_type: 'pro', client_id: 'app_client' },
  });
  assert.deepEqual(JSON.parse(rebuilt.toString('utf8')), {
    access_token: 'accs-new',
    refresh_token: 'rfrsh-new',
    token_type: 'Bearer',
    expires_in: 3600,
    chatgpt_account_id: 'acct-1',
    chatgpt_user_id: 'user-1',
    plan_type: 'pro',
    client_id: 'app_client',
  });
});

test('failure backoff doubles from one minute up to the six-hour cap, statelessly', () => {
  assert.equal(oauthRefreshFailureBackoffMs(null), OAUTH_REFRESH_MIN_BACKOFF_MS);
  assert.equal(oauthRefreshFailureBackoffMs(Number.NaN), OAUTH_REFRESH_MIN_BACKOFF_MS);
  assert.equal(oauthRefreshFailureBackoffMs(0), OAUTH_REFRESH_MIN_BACKOFF_MS);
  assert.equal(oauthRefreshFailureBackoffMs(30_000), OAUTH_REFRESH_MIN_BACKOFF_MS);
  assert.equal(oauthRefreshFailureBackoffMs(60_000), 120_000);
  assert.equal(oauthRefreshFailureBackoffMs(120_000), 240_000);
  assert.equal(oauthRefreshFailureBackoffMs(10_800_000), OAUTH_REFRESH_MAX_BACKOFF_MS);
  assert.equal(oauthRefreshFailureBackoffMs(21_600_000), OAUTH_REFRESH_MAX_BACKOFF_MS);
  // 1m → 2m → 4m → 8m → 16m → 32m → 64m → 128m → 256m → 360m(cap)
  let interval = oauthRefreshFailureBackoffMs(null);
  const seen = [interval];
  for (let index = 0; index < 9; index += 1) {
    interval = oauthRefreshFailureBackoffMs(interval);
    seen.push(interval);
  }
  assert.deepEqual(
    seen,
    [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_840_000, 7_680_000, 15_360_000, 21_600_000],
  );
});

test('success delay is expires_in x 0.8 with a deterministic jitter inside +/-10%', () => {
  const first = oauthRefreshSuccessDelayMs('credential-a', 3600);
  assert.equal(first, oauthRefreshSuccessDelayMs('credential-a', 3600), 'hash-keyed jitter is deterministic');
  assert.ok(first >= 2_592_000 && first <= 3_168_000, `delay ${first} must stay within 0.72..0.88 of ttl`);
  assert.notEqual(oauthRefreshSuccessDelayMs('credential-a', 3600), oauthRefreshSuccessDelayMs('credential-b', 3600));
  for (const id of ['credential-a', 'credential-b', 'credential-c', 'credential-d']) {
    const delay = oauthRefreshSuccessDelayMs(id, 3600);
    assert.ok(delay >= 2_592_000 && delay <= 3_168_000, id);
  }
  // A missing expiry falls back to the default TTL; a tiny expiry clamps to the minimum.
  const fallback = oauthRefreshSuccessDelayMs('credential-a', null);
  assert.ok(fallback >= 2_592_000 && fallback <= 3_168_000, `default-ttl delay ${fallback}`);
  assert.equal(oauthRefreshSuccessDelayMs('credential-a', 1), 60_000);
});

test('adapter registry is closed and binds exactly the verified OAuth triples', () => {
  assert.equal(
    resolveOauthTokenAdapter({ providerId: 'kimi', productId: 'kimi-platform', credentialType: 'oauth' }),
    null,
  );
  assert.equal(
    resolveOauthTokenAdapter({ providerId: 'anthropic', productId: 'claude-code', credentialType: 'api-key' }),
    null,
  );
  const adapter = resolveOauthTokenAdapter(anthropicBinding);
  assert.equal(adapter?.tokenEndpoint, 'https://console.anthropic.com/v1/oauth/token');
  assert.equal(
    resolveOauthTokenAdapter({ providerId: 'openai', productId: 'codex-cli', credentialType: 'oauth' })?.adapterId,
    'openai-codex-oauth-v1',
  );
});

test('a well-formed token response contributes exactly access/refresh/expiry', async () => {
  const seen: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const result = await requestOauthTokenRefresh(anthropicBinding, 'rfrsh-old-token', (async (
    url: URL,
    init: RequestInit,
  ) => {
    seen.push({
      url: url.href,
      method: init.method ?? '',
      headers: new Headers(init.headers),
      body: String(init.body),
    });
    return jsonResponse(tokenSuccess);
  }) as OauthTokenRefreshFetch);
  assert.equal(seen.length, 1);
  const request = seen[0] as (typeof seen)[number];
  assert.equal(request.url, 'https://console.anthropic.com/v1/oauth/token');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('content-type'), 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(request.body);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'rfrsh-old-token');
  assert.equal(form.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.deepEqual(result, {
    state: 'refreshed',
    accessToken: 'accs-new-token',
    refreshToken: 'rfrsh-new-token',
    expiresInSeconds: 3600,
    passthrough: {},
    adapterId: 'anthropic-claude-code-oauth-v1',
    httpStatus: 200,
    durationMs: result.durationMs,
  });
  // Extra response fields never surface in the parsed result.
  assert.equal('scope' in result || 'id_token' in result, false);
});

test('token endpoint status and transport failures map to stable error codes', async (t) => {
  const cases: Array<{
    name: string;
    response: Response | Error;
    errorCode: string;
    retryable: boolean;
    httpStatus: number | null;
  }> = [
    {
      name: '400 invalid_grant rejects the credential',
      response: jsonResponse({ error: 'invalid_grant' }, { status: 400 }),
      errorCode: 'credential_rejected',
      retryable: false,
      httpStatus: 400,
    },
    {
      name: '401 rejects the credential',
      response: jsonResponse({}, { status: 401 }),
      errorCode: 'credential_rejected',
      retryable: false,
      httpStatus: 401,
    },
    {
      name: '403 rejects the credential',
      response: jsonResponse({}, { status: 403 }),
      errorCode: 'credential_rejected',
      retryable: false,
      httpStatus: 403,
    },
    {
      name: '429 is retryable rate limiting',
      response: jsonResponse({}, { status: 429 }),
      errorCode: 'provider_rate_limited',
      retryable: true,
      httpStatus: 429,
    },
    {
      name: '503 is a retryable provider outage',
      response: jsonResponse({}, { status: 503 }),
      errorCode: 'provider_unavailable',
      retryable: true,
      httpStatus: 503,
    },
    {
      name: '404 means the endpoint is unsupported',
      response: jsonResponse({}, { status: 404 }),
      errorCode: 'provider_endpoint_unsupported',
      retryable: false,
      httpStatus: 404,
    },
    {
      name: 'redirects are rejected',
      response: jsonResponse({}, { status: 302 }),
      errorCode: 'provider_redirect_rejected',
      retryable: false,
      httpStatus: 302,
    },
    {
      name: 'declared oversized bodies are rejected',
      response: jsonResponse({}, { contentLength: '8192' }),
      errorCode: 'provider_response_too_large',
      retryable: false,
      httpStatus: 200,
    },
    {
      name: 'non-JSON content types are rejected',
      response: jsonResponse({}, { contentType: 'text/html' }),
      errorCode: 'provider_response_invalid',
      retryable: false,
      httpStatus: 200,
    },
    {
      name: 'network errors are retryable',
      response: new Error('socket hangup'),
      errorCode: 'provider_network_error',
      retryable: true,
      httpStatus: null,
    },
  ];
  for (const { name, response, errorCode, retryable, httpStatus } of cases) {
    await t.test(name, async () => {
      const result = await requestOauthTokenRefresh(anthropicBinding, 'rfrsh-old-token', fetchReturning(response));
      assert.equal(result.state, 'failed');
      if (result.state === 'failed') {
        assert.equal(result.errorCode, errorCode);
        assert.equal(result.retryable, retryable);
        assert.equal(result.httpStatus, httpStatus);
      }
    });
  }

  await t.test('an aborted signal is a retryable timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await requestOauthTokenRefresh(
      anthropicBinding,
      'rfrsh-old-token',
      fetchReturning(jsonResponse(tokenSuccess)),
      controller.signal,
    );
    assert.equal(result.state, 'failed');
    if (result.state === 'failed') assert.equal(result.errorCode, 'provider_timeout');
  });

  await t.test('a non-ascii refresh token is rejected before any request', async () => {
    let fetched = 0;
    const result = await requestOauthTokenRefresh(anthropicBinding, 'rfrsh-☃', (async () => {
      fetched += 1;
      throw new Error('must not fetch');
    }) as OauthTokenRefreshFetch);
    assert.equal(fetched, 0);
    assert.equal(result.state, 'failed');
    if (result.state === 'failed') assert.equal(result.errorCode, 'credential_format_invalid');
  });

  await t.test('an unbound triple fails closed without a request', async () => {
    let fetched = 0;
    const result = await requestOauthTokenRefresh(
      { providerId: 'kimi', productId: 'kimi-platform', credentialType: 'oauth' },
      'rfrsh-old-token',
      (async () => {
        fetched += 1;
        throw new Error('must not fetch');
      }) as OauthTokenRefreshFetch,
    );
    assert.equal(fetched, 0);
    assert.deepEqual(result, {
      state: 'failed',
      errorCode: 'adapter_unsupported',
      retryable: false,
      adapterId: null,
      httpStatus: null,
      durationMs: 0,
      providerError: null,
    });
  });
});

test('malformed token responses fail closed, never guessing token material', async (t) => {
  const cases: Array<{ name: string; body: unknown }> = [
    { name: 'missing access_token', body: { refresh_token: 'rfrsh-new-token' } },
    { name: 'non-string access_token', body: { ...tokenSuccess, access_token: 42 } },
    { name: 'blank access_token', body: { ...tokenSuccess, access_token: 'has space' } },
    { name: 'non-string refresh_token', body: { ...tokenSuccess, refresh_token: 42 } },
    { name: 'zero expires_in', body: { ...tokenSuccess, expires_in: 0 } },
    { name: 'negative expires_in', body: { ...tokenSuccess, expires_in: -5 } },
    { name: 'exponent expires_in', body: { ...tokenSuccess, expires_in: '1e3' } },
    { name: 'oversized expires_in', body: { ...tokenSuccess, expires_in: 31_536_001 } },
    { name: 'non-object body', body: [1, 2, 3] },
    { name: 'invalid json', body: '{not json' },
  ];
  for (const { name, body } of cases) {
    await t.test(name, async () => {
      const result = await requestOauthTokenRefresh(
        anthropicBinding,
        'rfrsh-old-token',
        fetchReturning(jsonResponse(body)),
      );
      assert.equal(result.state, 'failed');
      if (result.state === 'failed') {
        assert.equal(result.errorCode, 'provider_response_invalid');
        assert.equal(result.retryable, false);
      }
    });
  }

  await t.test('a missing refresh_token retains the old one and a numeric-string expires_in parses', async () => {
    const result = await requestOauthTokenRefresh(
      anthropicBinding,
      'rfrsh-old-token',
      fetchReturning(jsonResponse({ access_token: 'accs-new-token', expires_in: '1800' })),
    );
    assert.equal(result.state, 'refreshed');
    if (result.state === 'refreshed') {
      assert.equal(result.refreshToken, null);
      assert.equal(result.expiresInSeconds, 1800);
    }
  });
});

test('store claims one due credential, refreshes, rotates and schedules the next refresh', async (t) => {
  for (const ownerKind of ['tenant', 'platform'] as const) {
    await t.test(ownerKind, async () => {
      const versionRow = await sealFixtureCredential(ownerKind, 'credential-a');
      const state = fakeState(ownerKind, versionRow);
      const store = new PostgresOauthTokenRefreshWorkerStore(
        new FakeDatabase(state, ownerKind),
        unsealingKms,
        storeOptions({ fetch: fetchReturning(jsonResponse(tokenSuccess)) }),
      );
      const recorder = recordingRotator([]);
      const outcome = await store.refreshNext(recorder.rotator);
      assert.deepEqual(outcome, { outcome: 'refreshed', ownerKind, credentialId: 'credential-a', version: 2 });

      // The rotation seam received the claimed version fence and exactly the
      // canonical new material — every other token response field discarded.
      assert.equal(recorder.recorded.length, 1);
      const rotation = recorder.recorded[0] as (typeof recorder.recorded)[number];
      assert.equal(rotation.input.expectedVersion, 1);
      assert.equal(rotation.input.ownerKind, ownerKind);
      assert.equal(rotation.input.tenantId, ownerKind === 'tenant' ? TENANT_ID : null);
      assert.equal(rotation.input.accountId, 'account-a');
      assert.equal(rotation.input.credentialId, 'credential-a');
      assert.deepEqual(rotation.secretJson, {
        access_token: 'accs-new-token',
        refresh_token: 'rfrsh-new-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
      // The new-secret buffer is zeroed after the rotation attempt.
      assert.ok(
        recorder.buffers[0]?.every((byte) => byte === 0),
        'new secret must be wiped',
      );

      // Two writes: refreshing marker inside the claim transaction, then the
      // finalize write guarded by the rotated current_version.
      assert.equal(state.updates.length, 2);
      const [marker, finalize] = state.updates as Array<{ sql: string; values: readonly unknown[] }>;
      assert.match(marker.sql, /oauth_refresh_state = 'refreshing'/);
      assert.match(marker.sql, /oauth_refresh_error_code = NULL/);
      assert.match(finalize.sql, /oauth_refresh_state = 'idle'/);
      assert.match(finalize.sql, /oauth_force_refresh_requested = false/);
      assert.match(
        finalize.sql,
        /oauth_next_refresh_at = clock_timestamp\(\) \(\+ \(\$\d \* interval '1 millisecond'\)\)|oauth_next_refresh_at = clock_timestamp\(\) \+ \(\$\d \* interval '1 millisecond'\)/,
      );
      assert.match(finalize.sql, /oauth_refresh_state = 'refreshing' AND current_version = \$\d/);
      const finalizeDelay = Number(finalize.values[ownerKind === 'tenant' ? 2 : 1]);
      assert.ok(finalizeDelay >= 2_592_000 && finalizeDelay <= 3_168_000, `delay ${finalizeDelay}`);
      const finalizeVersion = Number(finalize.values[ownerKind === 'tenant' ? 3 : 2]);
      assert.equal(finalizeVersion, 2);

      // The due scan binds the fixed adapter triples and prioritizes force-flagged rows.
      const candidate = state.statements[0] as { sql: string; values: readonly unknown[] };
      assert.match(candidate.sql, /unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\]\)/);
      assert.match(candidate.sql, /credential\.status = 'active' AND account\.status = 'active'/);
      assert.match(candidate.sql, /credential\.oauth_force_refresh_requested = true/);
      assert.match(candidate.sql, /ORDER BY credential\.oauth_force_refresh_requested DESC/);
      assert.deepEqual(candidate.values[0], ['anthropic', 'anthropic-claude', 'openai', 'openai-codex']);
      assert.deepEqual(candidate.values[1], ['claude-code', 'claude-subscription', 'codex-cli', 'codex-chatgpt']);
      assert.deepEqual(candidate.values[2], ['oauth', 'oauth', 'oauth', 'oauth']);
      assert.equal(candidate.values[3], OAUTH_REFRESH_STALE_REFRESHING_MS);
      const lock = state.statements.find(({ sql }) => sql.includes('FOR UPDATE OF credential SKIP LOCKED'));
      assert.ok(lock, 'the claim must take the row lock without waiting');
    });
  }
});

test('a response without refresh_token retains the sealed one inside the new material', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const state = fakeState('tenant', versionRow);
  const store = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(state),
    unsealingKms,
    storeOptions({ fetch: fetchReturning(jsonResponse({ access_token: 'accs-new-token', expires_in: 60 })) }),
  );
  const recorder = recordingRotator([]);
  const outcome = await store.refreshNext(recorder.rotator);
  assert.equal(outcome.outcome, 'refreshed');
  assert.deepEqual(recorder.recorded[0]?.secretJson, {
    access_token: 'accs-new-token',
    refresh_token: 'rfrsh-old-token',
    token_type: 'Bearer',
    expires_in: 60,
  });
});

test('token endpoint failures write failed state with exponential backoff and consume the force flag', async (t) => {
  await t.test('first failure backs off one minute', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a');
    const state = fakeState('tenant', versionRow, { oauth_force_refresh_requested: true });
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({ fetch: fetchReturning(jsonResponse({}, { status: 503 })) }),
    );
    let rotations = 0;
    const outcome = await store.refreshNext(async () => {
      rotations += 1;
      throw new Error('must not rotate on a failed refresh');
    });
    assert.deepEqual(outcome, {
      outcome: 'failed',
      ownerKind: 'tenant',
      credentialId: 'credential-a',
      errorCode: 'provider_unavailable',
    });
    assert.equal(rotations, 0);
    assert.equal(state.updates.length, 1, 'the failure write lands inside the claim transaction');
    const write = state.updates[0] as { sql: string; values: readonly unknown[] };
    assert.match(write.sql, /oauth_refresh_state = 'failed'/);
    assert.match(write.sql, /oauth_force_refresh_requested = false/);
    assert.match(write.sql, /oauth_last_refresh_at = clock_timestamp\(\)/);
    assert.deepEqual(write.values, [TENANT_ID, 'credential-a', 'provider_unavailable', 60_000]);
  });

  await t.test('a consecutive failure doubles the previous interval', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a');
    const state = fakeState('tenant', versionRow, {
      oauth_refresh_state: 'failed',
      oauth_last_refresh_at: new Date('2026-01-01T00:00:00Z'),
      oauth_next_refresh_at: new Date('2026-01-01T00:01:00Z'),
    });
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({ fetch: fetchReturning(jsonResponse({}, { status: 429 })) }),
    );
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.deepEqual(outcome, {
      outcome: 'failed',
      ownerKind: 'tenant',
      credentialId: 'credential-a',
      errorCode: 'provider_rate_limited',
    });
    const write = state.updates[0] as { values: readonly unknown[] };
    assert.deepEqual(write.values, [TENANT_ID, 'credential-a', 'provider_rate_limited', 120_000]);
  });
});

test('missing or non-OAuth credential material fails without crashing or rotating', async (t) => {
  await t.test('no active version row', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a');
    const state = fakeState('tenant', versionRow);
    state.versionRows = [];
    const store = new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.deepEqual(outcome, {
      outcome: 'failed',
      ownerKind: 'tenant',
      credentialId: 'credential-a',
      errorCode: 'credential_unavailable',
    });
    const write = state.updates[0] as { values: readonly unknown[] };
    assert.deepEqual(write.values.slice(0, 3), [TENANT_ID, 'credential-a', 'credential_unavailable']);
  });

  await t.test('kms purpose mismatch', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a');
    const state = fakeState('tenant', { ...versionRow, kms_purpose: 'backup' });
    const store = new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.equal(outcome.outcome, 'failed');
    if (outcome.outcome === 'failed') assert.equal(outcome.errorCode, 'credential_unavailable');
  });

  await t.test('plaintext without OAuth material', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a', 'sk-plain-api-key');
    const state = fakeState('tenant', versionRow);
    const store = new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.equal(outcome.outcome, 'failed');
    if (outcome.outcome === 'failed') assert.equal(outcome.errorCode, 'credential_unavailable');
  });

  await t.test('a non-ascii refresh token inside the envelope', async () => {
    const versionRow = await sealFixtureCredential(
      'tenant',
      'credential-a',
      JSON.stringify({ refresh_token: 'rfrsh-☃' }),
    );
    const state = fakeState('tenant', versionRow);
    let fetched = 0;
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({
        fetch: (async () => {
          fetched += 1;
          throw new Error('must not fetch');
        }) as OauthTokenRefreshFetch,
      }),
    );
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.equal(fetched, 0);
    assert.equal(outcome.outcome, 'failed');
    if (outcome.outcome === 'failed') assert.equal(outcome.errorCode, 'credential_format_invalid');
  });
});

test('rotation failures consume the claim as failed with the stable rotation codes', async (t) => {
  await t.test('version conflict', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a');
    const state = fakeState('tenant', versionRow);
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({ fetch: fetchReturning(jsonResponse(tokenSuccess)) }),
    );
    const outcome = await store.refreshNext(async () => {
      const error = new Error('cas lost') as Error & { code?: string };
      error.code = 'CREDENTIAL_VERSION_CONFLICT';
      throw error;
    });
    assert.deepEqual(outcome, {
      outcome: 'failed',
      ownerKind: 'tenant',
      credentialId: 'credential-a',
      errorCode: 'rotation_conflict',
    });
    // refreshing marker from the claim transaction, then the failure finalize.
    assert.equal(state.updates.length, 2);
    const finalize = state.updates[1] as { sql: string; values: readonly unknown[] };
    assert.match(finalize.sql, /oauth_refresh_state = 'failed'/);
    assert.deepEqual(finalize.values.slice(0, 3), [TENANT_ID, 'credential-a', 'rotation_conflict']);
  });

  await t.test('generic rotation failure', async () => {
    const versionRow = await sealFixtureCredential('tenant', 'credential-a');
    const state = fakeState('tenant', versionRow);
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({ fetch: fetchReturning(jsonResponse(tokenSuccess)) }),
    );
    const outcome = await store.refreshNext(async () => {
      throw new Error('kms offline');
    });
    assert.equal(outcome.outcome, 'failed');
    if (outcome.outcome === 'failed') assert.equal(outcome.errorCode, 'rotation_failed');
  });
});

test('a contended or absent claim yields idle without unsealing or writing', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const contended = fakeState('tenant', versionRow);
  contended.lockedRows = [];
  const contendedStore = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(contended),
    unsealingKms,
    storeOptions(),
  );
  let rotations = 0;
  const contendedOutcome = await contendedStore.refreshNext(async () => {
    rotations += 1;
    return { version: 2 };
  });
  assert.deepEqual(contendedOutcome, { outcome: 'idle' });
  assert.equal(rotations, 0);
  assert.equal(contended.updates.length, 0);
  assert.equal(
    contended.statements.some(({ sql }) => sql.includes('_provider_credential_versions')),
    false,
    'a lost claim never reads the envelope',
  );

  const empty = fakeState('tenant', versionRow);
  empty.candidateQueue = [[]];
  const emptyStore = new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(empty), unsealingKms, storeOptions());
  const emptyOutcome = await emptyStore.refreshNext(async () => ({ version: 2 }));
  assert.deepEqual(emptyOutcome, { outcome: 'idle' });
  assert.equal(empty.updates.length, 0);
});

test('plaintext token material never appears in outcomes, writes or statements', async () => {
  const markers = ['rfrsh-old-token', 'rfrsh-new-token', 'accs-old-token', 'accs-new-token'];
  const assertNoPlaintext = (state: FakeState, outcome: unknown) => {
    const haystack = JSON.stringify({ outcome, updates: state.updates, statements: state.statements });
    for (const marker of markers) {
      assert.equal(haystack.includes(marker), false, `plaintext marker leaked: ${marker}`);
    }
  };

  const successRow = await sealFixtureCredential('tenant', 'credential-a');
  const success = fakeState('tenant', successRow);
  const successStore = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(success),
    unsealingKms,
    storeOptions({ fetch: fetchReturning(jsonResponse(tokenSuccess)) }),
  );
  const recorder = recordingRotator([]);
  assertNoPlaintext(success, await successStore.refreshNext(recorder.rotator));

  const failureRow = await sealFixtureCredential('tenant', 'credential-a');
  const failure = fakeState('tenant', failureRow);
  const failureStore = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(failure),
    unsealingKms,
    storeOptions({ fetch: fetchReturning(jsonResponse({ error: 'invalid_grant' }, { status: 400 })) }),
  );
  assertNoPlaintext(failure, await failureStore.refreshNext(async () => ({ version: 2 })));
});

test('an abort during the token call rolls the claim back with no writes', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const state = fakeState('tenant', versionRow);
  const controller = new AbortController();
  const store = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(state),
    unsealingKms,
    storeOptions({
      signal: controller.signal,
      fetch: (async () => {
        controller.abort();
        return jsonResponse(tokenSuccess);
      }) as OauthTokenRefreshFetch,
    }),
  );
  await assert.rejects(
    store.refreshNext(async () => ({ version: 2 })),
    (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'LEASE_LOST',
  );
  assert.equal(state.updates.length, 0, 'the aborted claim must roll back before any write');
});

test('owner scoping and option validation fail closed', async () => {
  const versionRow = await sealFixtureCredential('platform', 'credential-a');
  const state = fakeState('platform', versionRow);
  const store = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(state, 'platform'),
    unsealingKms,
    storeOptions({ owners: ['platform'], fetch: fetchReturning(jsonResponse(tokenSuccess)) }),
  );
  const outcome = await store.refreshNext(async () => ({ version: 2 }));
  assert.deepEqual(outcome, { outcome: 'refreshed', ownerKind: 'platform', credentialId: 'credential-a', version: 2 });
  assert.equal(
    state.statements.some(({ sql }) => sql.includes('tenant_provider_credentials')),
    false,
  );

  assert.throws(
    () => new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions({ owners: [] })),
    (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'STORE_UNAVAILABLE',
  );
  assert.throws(
    () =>
      new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions({ deployment: '' })),
    (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'STORE_UNAVAILABLE',
  );
});

test('store failures surface as STORE_UNAVAILABLE and the worker reports cycles', async () => {
  const state: FakeState = {
    statements: [],
    candidateQueue: [],
    versionRows: [],
    updates: [],
    rowCountQueue: [],
    transactionError: new Error('connection reset'),
  };
  const store = new PostgresOauthTokenRefreshWorkerStore(new FakeDatabase(state), unsealingKms, storeOptions());
  await assert.rejects(
    store.refreshNext(async () => ({ version: 2 })),
    (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'STORE_UNAVAILABLE',
  );

  const worker = new OauthTokenRefreshWorker(
    new FakeDatabase(state),
    unsealingKms,
    async () => ({ version: 2 }),
    storeOptions(),
  );
  await assert.rejects(
    worker.runOnce(),
    (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'STORE_UNAVAILABLE',
  );
  await worker.close();
});

test('the worker drains a bounded batch per cycle and validates the batch option', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const versionRowB = await sealFixtureCredential('tenant', 'credential-b');
  const state = fakeState('tenant', versionRow);
  state.candidateQueue = [[credentialRow('tenant')], [credentialRow('tenant', { id: 'credential-b' })], []];
  // Each claim unseals the envelope sealed for that exact credential id.
  state.versionQueue = [[versionRow], [versionRowB]];
  const rotations: string[] = [];
  const worker = new OauthTokenRefreshWorker(
    new FakeDatabase(state),
    unsealingKms,
    async (input) => {
      rotations.push(input.credentialId);
      return { version: input.expectedVersion + 1 };
    },
    storeOptions({ batchSize: 5, fetch: fetchReturning(jsonResponse(tokenSuccess), jsonResponse(tokenSuccess)) }),
  );
  assert.equal(await worker.runOnce(), 'processed');
  assert.deepEqual(rotations, ['credential-a', 'credential-b']);
  await worker.close();
  assert.equal(await worker.runOnce(), 'stale');

  const idleState = fakeState('tenant', versionRow);
  idleState.candidateQueue = [[]];
  const idleWorker = new OauthTokenRefreshWorker(
    new FakeDatabase(idleState),
    unsealingKms,
    async () => ({ version: 2 }),
    storeOptions(),
  );
  assert.equal(await idleWorker.runOnce(), 'idle');
  await idleWorker.close();

  for (const batchSize of [0, 101, Number.NaN, 1.5]) {
    assert.throws(
      () =>
        new OauthTokenRefreshWorker(
          new FakeDatabase(state),
          unsealingKms,
          async () => ({ version: 2 }),
          storeOptions({ batchSize }),
        ),
      (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'STORE_UNAVAILABLE',
      `batchSize ${batchSize} must fail closed`,
    );
  }

  const running = startOauthTokenRefreshWorker(
    new FakeDatabase(idleState),
    unsealingKms,
    async () => ({ version: 2 }),
    storeOptions({ pollIntervalMs: 100 }),
  );
  await running.close();
});

test('a stale finalize guard loses the lease instead of marking a foreign version idle', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const state = fakeState('tenant', versionRow);
  // writeRefreshing commits (1), then the finalize guard observes a row that
  // no longer matches state='refreshing' + current_version (0 rows).
  state.rowCountQueue = [1, 0];
  const store = new PostgresOauthTokenRefreshWorkerStore(
    new FakeDatabase(state),
    unsealingKms,
    storeOptions({ fetch: fetchReturning(jsonResponse(tokenSuccess)) }),
  );
  await assert.rejects(
    store.refreshNext(async () => ({ version: 2 })),
    (error: unknown) => error instanceof OauthTokenRefreshWorkerError && error.code === 'LEASE_LOST',
  );
});

test('a bound egress proxy tunnels the refresh fetch and preserves the sealed refresh token', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const state = fakeState('tenant', versionRow);
  // The account lookup finds a bound proxy with sealed credentials.
  const sealedProxy = await sealEgressProxyCredentials(
    { username: 'proxyuser', password: 'proxypass' },
    { proxyId: 'proxy-a', deployment: DEPLOYMENT, environment: ENVIRONMENT },
    sealingKms,
    'r4-fixture-kms',
  );
  const originalQuery = FakeDatabase.prototype.query;
  FakeDatabase.prototype.query = async function queryPatch<RowType>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<RowType>> {
    if (sql.includes('JOIN saas_egress_proxies AS proxy')) {
      return {
        rows: [
          {
            id: 'proxy-a',
            name: 'primary',
            protocol: 'socks5',
            host: 'egress.example',
            port: 1080,
            auth_sealed_envelope: sealedProxy,
            status: 'active',
            expires_at: null,
            fallback_mode: 'none',
            backup_proxy_id: null,
            last_probe_at: null,
            last_probe_latency_ms: null,
            last_probe_ip: null,
            last_probe_quality: null,
          },
        ] as RowType[],
        rowCount: 1,
      };
    }
    return originalQuery.call(this, sql, values) as Promise<SqlResult<RowType>>;
  };
  try {
    const seenDispatchers: unknown[] = [];
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({
        fetch: async (url, init) => {
          seenDispatchers.push(init.dispatcher);
          assert.equal(url.protocol, 'https:');
          return jsonResponse(tokenSuccess);
        },
        createEgressConnection: async (proxy) => {
          // socks5 upgrades to socks5h before the dispatcher is built.
          assert.equal(proxy.url, 'socks5h://proxyuser:proxypass@egress.example:1080');
          return { dispatcher: { tunneled: true } as never, close: async () => {}, destroy: async () => {} };
        },
      }),
    );
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.deepEqual(outcome, {
      outcome: 'refreshed',
      ownerKind: 'tenant',
      credentialId: 'credential-a',
      version: 2,
    });
    assert.equal(seenDispatchers.length, 1);
    assert.deepEqual(seenDispatchers[0], { tunneled: true });
  } finally {
    FakeDatabase.prototype.query = originalQuery;
  }
});

test('refresh egress connections consult the operator egress allowlist (R9 §4 P1)', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const state = fakeState('tenant', versionRow);
  const originalQuery = FakeDatabase.prototype.query;
  FakeDatabase.prototype.query = async function queryPatch<RowType>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<RowType>> {
    if (sql.includes('JOIN saas_egress_proxies AS proxy')) {
      return {
        rows: [
          {
            id: 'proxy-a',
            name: 'primary',
            protocol: 'http',
            host: 'egress.example',
            port: 3128,
            auth_sealed_envelope: null,
            status: 'active',
            expires_at: null,
            fallback_mode: 'none',
            backup_proxy_id: null,
            last_probe_at: null,
            last_probe_latency_ms: null,
            last_probe_ip: null,
            last_probe_quality: null,
          },
        ] as RowType[],
        rowCount: 1,
      };
    }
    return originalQuery.call(this, sql, values) as Promise<SqlResult<RowType>>;
  };
  try {
    const allowlist = createProviderHttpEgressAllowlist(['172.20.0.0/16']);
    const connectionOptions: Array<{ readonly signal?: AbortSignal; readonly egressAllowlist?: unknown }> = [];
    const capture = (init?: { readonly signal?: AbortSignal; readonly egressAllowlist?: unknown }) => {
      connectionOptions.push(init ?? {});
      return { dispatcher: { tunneled: true } as never, close: async () => {}, destroy: async () => {} };
    };
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({
        fetch: async () => jsonResponse(tokenSuccess),
        createEgressConnection: async (_proxy, init) => capture(init),
        egressAllowlist: allowlist,
      }),
    );
    assert.equal((await store.refreshNext(async () => ({ version: 2 }))).outcome, 'refreshed');
    assert.equal(connectionOptions.length, 1);
    // The configured allowlist reaches the connection factory verbatim.
    assert.equal(connectionOptions[0]?.egressAllowlist, allowlist);

    // Without the option the default factory call carries no allowlist — the
    // exact pre-R9 strict posture. A fresh claim queue keeps the run eligible.
    const strictState = fakeState('tenant', await sealFixtureCredential('tenant', 'credential-a'));
    const strict = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(strictState),
      unsealingKms,
      storeOptions({
        fetch: async () => jsonResponse(tokenSuccess),
        createEgressConnection: async (_proxy, init) => capture(init),
      }),
    );
    assert.equal((await strict.refreshNext(async () => ({ version: 2 }))).outcome, 'refreshed');
    assert.equal(connectionOptions[1]?.egressAllowlist, undefined);

    // A malformed allowlist fails store construction closed.
    assert.throws(
      () =>
        new PostgresOauthTokenRefreshWorkerStore(
          new FakeDatabase(state),
          unsealingKms,
          storeOptions({
            egressAllowlist: {} as unknown as ProviderHttpEgressAllowlist,
          }),
        ),
      (error: unknown) => error instanceof OauthTokenRefreshWorkerError,
    );
  } finally {
    FakeDatabase.prototype.query = originalQuery;
  }
});

test('a bound egress proxy that cannot be established fails the refresh instead of direct-egressing', async () => {
  const versionRow = await sealFixtureCredential('tenant', 'credential-a');
  const state = fakeState('tenant', versionRow);
  const originalQuery = FakeDatabase.prototype.query;
  FakeDatabase.prototype.query = async function queryPatch<RowType>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<SqlResult<RowType>> {
    if (sql.includes('JOIN saas_egress_proxies AS proxy')) {
      return {
        rows: [
          {
            id: 'proxy-a',
            name: 'primary',
            protocol: 'http',
            host: 'egress.example',
            port: 3128,
            auth_sealed_envelope: null,
            status: 'active',
            expires_at: null,
            fallback_mode: 'none',
            backup_proxy_id: null,
            last_probe_at: null,
            last_probe_latency_ms: null,
            last_probe_ip: null,
            last_probe_quality: null,
          },
        ] as RowType[],
        rowCount: 1,
      };
    }
    return originalQuery.call(this, sql, values) as Promise<SqlResult<RowType>>;
  };
  try {
    let fetchCalls = 0;
    const store = new PostgresOauthTokenRefreshWorkerStore(
      new FakeDatabase(state),
      unsealingKms,
      storeOptions({
        fetch: async () => {
          fetchCalls += 1;
          return jsonResponse(tokenSuccess);
        },
        createEgressConnection: async () => {
          throw new Error('proxy unreachable');
        },
      }),
    );
    const outcome = await store.refreshNext(async () => ({ version: 2 }));
    assert.deepEqual(outcome, {
      outcome: 'failed',
      ownerKind: 'tenant',
      credentialId: 'credential-a',
      errorCode: 'egress_proxy_unavailable',
    });
    // The token endpoint was never contacted on the direct path.
    assert.equal(fetchCalls, 0);
  } finally {
    FakeDatabase.prototype.query = originalQuery;
  }
});

test('the F4 gemini adapter is absent without a client secret and complete with one', () => {
  // Fail-closed: no secret in the environment means no adapter, so gemini
  // credentials are excluded by the due scan rather than refreshed against a
  // grant missing its secret.
  assert.deepEqual(geminiOauthTokenAdapters(null), []);
  const adapters = geminiOauthTokenAdapters('test-installed-app-secret');
  assert.equal(adapters.length, 1);
  const adapter = adapters[0];
  assert.ok(adapter);
  assert.equal(adapter.providerId, 'google-gemini');
  assert.equal(adapter.productId, 'gemini-subscription');
  assert.equal(adapter.credentialType, 'oauth');
  assert.equal(adapter.adapterId, 'google-gemini-oauth-v1');
  assert.equal(adapter.tokenEndpoint, 'https://oauth2.googleapis.com/token');
  assert.equal(adapter.clientId, '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
  // Google's installed-app clients require client_secret in the refresh grant.
  assert.equal(adapter.clientSecret, 'test-installed-app-secret');
  // Refresh grants send no scope: the original grant's scopes persist.
  assert.equal(adapter.refreshScope, null);
  assert.deepEqual(adapter.passthroughFields, ['project_id', 'tier_id', 'client_id', 'email']);
  assert.equal(adapter.userAgent, 'model-router');

  // With the environment unconfigured (this suite's import-time assumption,
  // shared with the adapter-registry test above), the gemini triple is not
  // resolvable through the module-level adapter list.
  if (process.env[GEMINI_OAUTH_CLIENT_SECRET_ENV] === undefined) {
    assert.equal(
      resolveOauthTokenAdapter({
        providerId: 'google-gemini',
        productId: 'gemini-subscription',
        credentialType: 'oauth',
      }),
      null,
    );
  }
});

test('GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS preserves the dispatch-wrap metadata across rotations', () => {
  assert.deepEqual(GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS, ['project_id', 'tier_id', 'client_id', 'email']);
  // The pure parse/build pair round-trips a gemini envelope: the gateway needs
  // project_id (the v1internal dispatch wrap), tier_id (the 429 cooldown
  // policy) and client_id (refresh grant continuity) even though the
  // refresh-token response never returns them.
  const geminiEnvelope = JSON.stringify({
    access_token: 'accs-gemini-old',
    refresh_token: 'rfrsh-gemini-old',
    token_type: 'Bearer',
    expires_in: 3600,
    project_id: 'project-1',
    tier_id: 'gcp_standard',
    client_id: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    email: 'operator@example.test',
    unknown_extra: 'dropped',
  });
  assert.deepEqual(
    parseOauthCredentialMaterial(Buffer.from(geminiEnvelope), GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS),
    {
      refreshToken: 'rfrsh-gemini-old',
      passthrough: {
        project_id: 'project-1',
        tier_id: 'gcp_standard',
        client_id: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
        email: 'operator@example.test',
      },
    },
  );
  const rebuilt = buildOauthCredentialMaterial(
    {
      accessToken: 'accs-gemini-new',
      refreshToken: 'rfrsh-gemini-new',
      expiresInSeconds: 3600,
      passthrough: {
        project_id: 'project-1',
        tier_id: 'gcp_standard',
        client_id: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
        email: 'operator@example.test',
      },
    },
    GEMINI_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  );
  assert.deepEqual(JSON.parse(rebuilt.toString('utf8')), {
    access_token: 'accs-gemini-new',
    refresh_token: 'rfrsh-gemini-new',
    token_type: 'Bearer',
    expires_in: 3600,
    project_id: 'project-1',
    tier_id: 'gcp_standard',
    client_id: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    email: 'operator@example.test',
  });
});
