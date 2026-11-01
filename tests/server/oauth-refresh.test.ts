import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { ControlStore } from '../../src/control/store.js';
import { OAuthTokenResolver } from '../../src/server/oauth.js';
import { type OAuthAccount, OAuthAccountStore, type OAuthTokenUpdate } from '../../src/server/oauth-accounts.js';
import {
  type OAuthRefreshAccountStore,
  OAuthRefreshEngine,
  type OAuthRefreshFetch,
  refreshOAuthAccount,
} from '../../src/server/oauth-refresh.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeAccountStore implements OAuthRefreshAccountStore {
  readonly accounts = new Map<string, OAuthAccount>();
  readonly updates: Array<{ provider: string; id: string; update: OAuthTokenUpdate }> = [];

  put(account: OAuthAccount): void {
    this.accounts.set(`${account.provider}:${account.id}`, { ...account });
  }

  get(provider: string, id: string): OAuthAccount | undefined {
    const account = this.accounts.get(`${provider}:${id}`);
    return account === undefined ? undefined : { ...account };
  }

  getDefault(provider: string): OAuthAccount | undefined {
    for (const account of this.accounts.values()) {
      if (account.provider === provider && account.isDefault) return { ...account };
    }
    return undefined;
  }

  list(provider?: string): OAuthAccount[] {
    return [...this.accounts.values()]
      .filter((account) => provider === undefined || account.provider === provider)
      .map((account) => ({ ...account }));
  }

  updateTokens(provider: string, id: string, update: OAuthTokenUpdate): OAuthAccount | undefined {
    const key = `${provider}:${id}`;
    const current = this.accounts.get(key);
    if (current === undefined) return undefined;
    const next: OAuthAccount = { ...current };
    if (update.accessToken !== undefined) next.accessToken = update.accessToken;
    if (update.refreshToken !== undefined) next.refreshToken = update.refreshToken;
    if (update.expiresAt !== undefined) next.expiresAt = update.expiresAt;
    if (update.status !== undefined) next.status = update.status;
    if (update.lastRefreshAt !== undefined) next.lastRefreshAt = update.lastRefreshAt;
    if (update.failureCount !== undefined) next.failureCount = update.failureCount;
    if (update.nextRetryAt === null) delete next.nextRetryAt;
    else if (update.nextRetryAt !== undefined) next.nextRetryAt = update.nextRetryAt;
    this.accounts.set(key, next);
    this.updates.push({ provider, id, update });
    return { ...next };
  }
}

describe('refreshOAuthAccount', () => {
  const account = (overrides: Partial<OAuthAccount> = {}): OAuthAccount => ({
    id: 'a1',
    provider: 'codex_oauth',
    accessToken: 'old-access',
    refreshToken: 'rt-secret',
    expiresAt: 1_000,
    isDefault: true,
    ...overrides,
  });

  it('classifies network failures, 429 and 5xx as retryable', async () => {
    const networkFailure = await refreshOAuthAccount({
      account: account(),
      provider: 'codex_oauth',
      fetchImpl: () => Promise.reject(new Error('boom')),
    });
    assert.equal(networkFailure.state, 'failure');
    assert.equal(networkFailure.retryable, true);
    assert.equal(networkFailure.terminal, false);
    if (networkFailure.state === 'failure') assert.equal(networkFailure.errorCode, 'network_error');

    const rateLimited = await refreshOAuthAccount({
      account: account(),
      provider: 'codex_oauth',
      fetchImpl: () => Promise.resolve(new Response('', { status: 429 })),
    });
    assert.equal(rateLimited.state, 'failure');
    if (rateLimited.state === 'failure') {
      assert.equal(rateLimited.retryable, true);
      assert.equal(rateLimited.errorCode, 'rate_limited');
      assert.equal(rateLimited.httpStatus, 429);
    }

    const unavailable = await refreshOAuthAccount({
      account: account(),
      provider: 'codex_oauth',
      fetchImpl: () => Promise.resolve(new Response('', { status: 503 })),
    });
    assert.equal(unavailable.state, 'failure');
    if (unavailable.state === 'failure') {
      assert.equal(unavailable.retryable, true);
      assert.equal(unavailable.errorCode, 'provider_unavailable');
      assert.equal(unavailable.httpStatus, 503);
    }
  });

  it('marks providers without a refresh binding as cleanly unsupported', async () => {
    const result = await refreshOAuthAccount({
      account: { id: 'g1', provider: 'github_copilot', accessToken: 'old', isDefault: true },
      provider: 'github_copilot',
      fetchImpl: () => Promise.resolve(jsonResponse({})),
    });
    assert.deepEqual(result, {
      state: 'failure',
      retryable: false,
      terminal: false,
      errorCode: 'provider_unsupported',
      oauthError: null,
      httpStatus: null,
    });
  });

  it('uses a generic passthrough binding when the account carries one', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: OAuthRefreshFetch = async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
        redirect: init.redirect,
      });
      return jsonResponse({ access_token: 'tok' });
    };
    const result = await refreshOAuthAccount({
      account: {
        id: 'g1',
        provider: 'github_copilot',
        accessToken: 'old',
        refreshToken: 'rt',
        isDefault: true,
        tokenEndpoint: 'https://github.example.test/token',
        clientId: 'cli-x',
      } as OAuthAccount,
      provider: 'github_copilot',
      fetchImpl,
    });
    assert.equal(result.state, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://github.example.test/token');
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('client_id'), 'cli-x');
    assert.equal(form.has('scope'), false);
  });
});

describe('OAuthRefreshEngine', () => {
  let store: FakeAccountStore;
  let fetchCalls: RecordedCall[];
  let respond: () => Response;
  let now: { value: number };
  let engine: OAuthRefreshEngine;

  const baseAccount = (overrides: Partial<OAuthAccount> = {}): OAuthAccount => ({
    id: 'a1',
    provider: 'codex_oauth',
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: 1_000,
    isDefault: true,
    ...overrides,
  });

  beforeEach(() => {
    store = new FakeAccountStore();
    fetchCalls = [];
    respond = () => jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
    now = { value: 500 };
    engine = new OAuthRefreshEngine(store, {
      fetchImpl: async (url, init) => {
        fetchCalls.push({
          url,
          method: init.method,
          headers: init.headers as Record<string, string>,
          body: String(init.body),
          redirect: init.redirect,
        });
        return respond();
      },
      nowMs: () => now.value,
    });
  });

  it('sends the codex refresh grant shape (endpoint, scope, client_id, user-agent)', async () => {
    store.put(baseAccount());
    await engine.resolveAccessToken('codex_oauth');
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.equal(call.url, 'https://auth.openai.com/oauth/token');
    assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(call.headers.accept, 'application/json');
    assert.equal(call.headers['user-agent'], 'codex_cli_rs/0.146.0 (Mac OS X 15.0; arm64) Terminal');
    const form = new URLSearchParams(call.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'old-refresh');
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(form.get('scope'), 'openid profile email');
  });

  it('does not fetch when the token is outside the expiry margin', async () => {
    store.put(baseAccount({ expiresAt: now.value + 20 * 60_000 }));
    const token = await engine.resolveAccessToken('codex_oauth');
    assert.equal(token, 'old-access');
    assert.equal(fetchCalls.length, 0);
  });

  it('does not fetch for accounts without a refresh binding (stale token returned)', async () => {
    store.put({
      id: 'g1',
      provider: 'github_copilot',
      accessToken: 'gh-old',
      refreshToken: 'gh-rt',
      expiresAt: now.value + 1,
      isDefault: true,
    });
    const token = await engine.resolveAccessToken('github_copilot');
    assert.equal(token, 'gh-old');
    assert.equal(fetchCalls.length, 0);
  });

  it('refreshes, updates the store, clears the failure count and singleflights concurrent resolves', async () => {
    store.put(baseAccount({ failureCount: 3, lastRefreshAt: 1 }));
    const [first, second] = await Promise.all([
      engine.resolveAccessToken('codex_oauth'),
      engine.resolveAccessToken('codex_oauth'),
    ]);
    assert.equal(first, 'new-access');
    assert.equal(second, 'new-access');
    assert.equal(fetchCalls.length, 1);
    const updated = store.get('codex_oauth', 'a1');
    assert.equal(updated?.accessToken, 'new-access');
    assert.equal(updated?.refreshToken, 'new-refresh');
    assert.equal(updated?.expiresAt, now.value + 3_600_000);
    assert.equal(updated?.status, 'active');
    assert.equal(updated?.failureCount, 0);
    assert.equal(updated?.lastRefreshAt, now.value);
    assert.equal(updated?.nextRetryAt, undefined);
  });

  it('keeps the old refresh token when the response does not return one', async () => {
    respond = () => jsonResponse({ access_token: 'new-access', expires_in: 3600 });
    store.put(baseAccount());
    await engine.resolveAccessToken('codex_oauth');
    const updated = store.get('codex_oauth', 'a1');
    assert.equal(updated?.accessToken, 'new-access');
    assert.equal(updated?.refreshToken, 'old-refresh');
  });

  it('revokes the account on terminal OAuth rejections and never fetches again', async () => {
    respond = () => jsonResponse({ error: 'invalid_grant' }, 400);
    store.put(baseAccount());
    await assert.rejects(() => engine.resolveAccessToken('codex_oauth'), /re-authentication required/);
    assert.equal(store.get('codex_oauth', 'a1')?.status, 'revoked');
    assert.equal(fetchCalls.length, 1);
    await assert.rejects(() => engine.resolveAccessToken('codex_oauth'), /re-authentication required/);
    assert.equal(fetchCalls.length, 1);
  });

  for (const code of ['refresh_token_reused', 'token_expired', 'app_session_terminated', 'refresh_token_invalidated']) {
    it(`revokes on terminal error ${code}`, async () => {
      respond = () => jsonResponse({ error: code }, 400);
      store.put(baseAccount());
      await assert.rejects(() => engine.resolveAccessToken('codex_oauth'), /re-authentication required/);
      assert.equal(store.get('codex_oauth', 'a1')?.status, 'revoked');
    });
  }

  it('backs off without revoking on a 400 carrying a non-terminal error code', async () => {
    respond = () => jsonResponse({ error: 'unsupported_grant_type' }, 400);
    store.put(baseAccount());
    const token = await engine.resolveAccessToken('codex_oauth');
    assert.equal(token, 'old-access');
    const updated = store.get('codex_oauth', 'a1');
    assert.equal(updated?.status, 'active');
    assert.equal(updated?.failureCount, 1);
    assert.ok(updated?.nextRetryAt !== undefined && updated.nextRetryAt > now.value);
  });

  it('applies exponential backoff on retryable failures and retries after it passes', async () => {
    respond = () => new Response('', { status: 503 });
    store.put(baseAccount());
    const token = await engine.resolveAccessToken('codex_oauth');
    assert.equal(token, 'old-access');
    assert.equal(fetchCalls.length, 1);
    const failing = store.get('codex_oauth', 'a1');
    assert.equal(failing?.status, 'active');
    assert.equal(failing?.failureCount, 1);
    assert.ok(failing?.nextRetryAt !== undefined && failing.nextRetryAt > now.value);

    // still inside the backoff window: no second fetch
    await engine.resolveAccessToken('codex_oauth');
    assert.equal(fetchCalls.length, 1);

    // advance the clock past the backoff stamp and succeed
    now.value = (failing?.nextRetryAt ?? 0) + 1;
    respond = () => jsonResponse({ access_token: 'new-access', expires_in: 3600 });
    const refreshed = await engine.resolveAccessToken('codex_oauth');
    assert.equal(refreshed, 'new-access');
    assert.equal(fetchCalls.length, 2);
    assert.equal(store.get('codex_oauth', 'a1')?.failureCount, 0);
  });

  it('force refreshes a null-expiry account on demand (the 401 recovery path)', async () => {
    // Imported auth.json accounts may carry no expiry; a live 401 from the
    // upstream is the definitive signal, so {force:true} bypasses the margin.
    store.put(baseAccount({ expiresAt: undefined }));
    // Without force: unknown expiry returns the stored token, never refreshes.
    assert.equal(await engine.resolveAccessToken('codex_oauth'), 'old-access');
    assert.equal(fetchCalls.length, 0);
    await engine.close();

    const forced = new OAuthRefreshEngine(store, {
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return respond();
      },
      nowMs: () => now.value,
    });
    const token = await forced.resolveAccessToken('codex_oauth', undefined, { force: true });
    assert.equal(token, 'new-access');
    assert.equal(fetchCalls.length, 1);
    // The refresh response recorded the expiry — subsequent resolves use the margin.
    assert.ok(store.get('codex_oauth', 'a1')?.expiresAt !== undefined);
    await forced.close();
  });

  it('sweeps expiring accounts proactively and stops on close()', async () => {
    store.put(baseAccount());
    engine.start(5);
    await delay(50);
    assert.equal(fetchCalls.length, 1);
    assert.equal(store.get('codex_oauth', 'a1')?.accessToken, 'new-access');
    // the token is fresh now: further sweeps stay idle
    await delay(20);
    assert.equal(fetchCalls.length, 1);
    await engine.close();
    // force expiry again: a stopped engine must not fetch
    const updated = store.get('codex_oauth', 'a1');
    now.value = (updated?.expiresAt ?? 0) + 60_000;
    await delay(50);
    assert.equal(fetchCalls.length, 1);
  });
});

describe('OAuthRefreshEngine with the real OAuthAccountStore', () => {
  let tmpDir: string;
  let control: ControlStore;
  let store: OAuthAccountStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-refresh-test-'));
    control = new ControlStore(tmpDir);
    store = new OAuthAccountStore(path.join(tmpDir, 'config.json'), control.secrets);
  });

  it('loads account files written before the new fields existed', () => {
    control.secrets.put('oauth_legacy_1', JSON.stringify({ accessToken: 'legacy-access', refreshToken: 'legacy-rt' }));
    fs.writeFileSync(
      path.join(tmpDir, 'oauth-accounts.json'),
      JSON.stringify([
        { id: 'legacy', provider: 'codex_oauth', secretRef: 'oauth_legacy_1', isDefault: true, expiresAt: 1_000 },
      ]),
    );
    const reopened = new OAuthAccountStore(path.join(tmpDir, 'config.json'), control.secrets);
    const account = reopened.get('codex_oauth', 'legacy');
    assert.equal(account?.accessToken, 'legacy-access');
    assert.equal(account?.refreshToken, 'legacy-rt');
    assert.equal(account?.status, undefined);
    assert.equal(account?.failureCount, undefined);
  });

  it('updateTokens rotates tokens through the secure save path and reopens', () => {
    store.add({
      id: '1',
      provider: 'codex_oauth',
      accessToken: 'first-access',
      refreshToken: 'first-rt',
      isDefault: true,
    });
    const updated = store.updateTokens('codex_oauth', '1', {
      accessToken: 'second-access',
      expiresAt: 9_999,
      status: 'active',
      failureCount: 2,
      nextRetryAt: 123,
    });
    assert.equal(updated?.accessToken, 'second-access');
    assert.equal(updated?.refreshToken, 'first-rt');
    assert.equal(updated?.failureCount, 2);
    const reopened = new OAuthAccountStore(path.join(tmpDir, 'config.json'), control.secrets);
    assert.equal(reopened.get('codex_oauth', '1')?.accessToken, 'second-access');
    assert.equal(reopened.get('codex_oauth', '1')?.failureCount, 2);
    const cleared = store.updateTokens('codex_oauth', '1', { refreshToken: 'second-rt', nextRetryAt: null });
    assert.equal(cleared?.refreshToken, 'second-rt');
    assert.equal(cleared?.nextRetryAt, undefined);
    const disk = fs.readFileSync(path.join(tmpDir, 'oauth-accounts.json'), 'utf-8');
    assert.equal(disk.includes('second-access'), false);
    assert.equal(disk.includes('second-rt'), false);
    assert.equal(store.updateTokens('codex_oauth', 'missing'), undefined);
  });

  it('drives a full refresh through the resolver wiring', async () => {
    store.add({
      id: '1',
      provider: 'codex_oauth',
      accessToken: 'old-access',
      refreshToken: 'old-rt',
      expiresAt: 1_000,
      isDefault: true,
    });
    const calls: RecordedCall[] = [];
    const now = { value: 500 };
    const engine = new OAuthRefreshEngine(store, {
      fetchImpl: async (url, init) => {
        calls.push({
          url,
          method: init.method,
          headers: init.headers as Record<string, string>,
          body: String(init.body),
          redirect: init.redirect,
        });
        return jsonResponse({ access_token: 'engine-access', refresh_token: 'engine-rt', expires_in: 1200 });
      },
      nowMs: () => now.value,
    });
    const resolver = new OAuthTokenResolver(store, engine);
    const token = await resolver.resolve(
      { tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' },
      'codex_oauth',
    );
    assert.equal(token, 'engine-access');
    assert.equal(calls.length, 1);
    assert.equal(store.get('codex_oauth', '1')?.refreshToken, 'engine-rt');
    // a fresh token resolves without another fetch
    const again = await resolver.resolve(
      { tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' },
      'codex_oauth',
    );
    assert.equal(again, 'engine-access');
    assert.equal(calls.length, 1);
    await engine.close();
  });

  it('keeps the legacy resolver behavior without an engine', async () => {
    store.add({
      id: '1',
      provider: 'codex_oauth',
      accessToken: 'old-access',
      refreshToken: 'old-rt',
      expiresAt: Date.now() - 1_000,
      isDefault: true,
    });
    const bare = new OAuthTokenResolver(store);
    await assert.rejects(
      () => bare.resolve({ tokenUrl: '', clientId: '', clientSecret: '', grantType: 'device_code' }, 'codex_oauth'),
      /re-authentication required/,
    );
  });
});
