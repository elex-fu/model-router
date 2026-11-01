import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type OAuthRefreshAdapter, resolveAdapter } from '../../src/oauth-refresh/adapters.js';
import {
  NON_RETRYABLE_OAUTH_ERRORS,
  OAUTH_REFRESH_MAX_RESPONSE_BYTES,
  type OAuthRefreshFetch,
  performOAuthRefresh,
  type RefreshableCredential,
  refreshBackoffMs,
  shouldRefresh,
} from '../../src/oauth-refresh/core.js';

const credential = (overrides: Partial<RefreshableCredential> = {}): RefreshableCredential => ({
  key: 'openai-codex/codex-chatgpt/oauth:acct-1',
  providerId: 'openai-codex/codex-chatgpt/oauth',
  refreshToken: 'rt-secret',
  expiresAtMs: 1_000,
  ...overrides,
});

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: RequestRedirect | undefined;
}

function recordFetch(calls: RecordedCall[], respond: () => Response): OAuthRefreshFetch {
  return async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
      redirect: init.redirect,
    });
    return respond();
  };
}

const adapter = (overrides: Partial<OAuthRefreshAdapter> = {}): OAuthRefreshAdapter => ({
  id: 'test-adapter',
  tokenEndpoint: 'https://token.example.test/oauth/token',
  clientId: 'client-x',
  refreshScope: null,
  userAgent: 'agent-x',
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('performOAuthRefresh grant form', () => {
  it('sends the codex grant shape: scope present, client_secret absent, pinned CLI UA', async () => {
    const calls: RecordedCall[] = [];
    const codex = resolveAdapter('codex_oauth');
    assert.ok(codex !== null);
    const attempt = await performOAuthRefresh(
      credential(),
      codex,
      recordFetch(calls, () => jsonResponse({ access_token: 'tok' })),
      { nowMs: 5_000 },
    );
    assert.equal(attempt.outcome.kind, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://auth.openai.com/oauth/token');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].redirect, 'manual');
    assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(calls[0].headers.accept, 'application/json');
    assert.equal(calls[0].headers['user-agent'], 'codex_cli_rs/0.146.0 (Mac OS X 15.0; arm64) Terminal');
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'rt-secret');
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(form.get('scope'), 'openid profile email');
    assert.equal(form.has('client_secret'), false);
  });

  it('omits the scope parameter when the adapter carries none', async () => {
    const calls: RecordedCall[] = [];
    const claude = resolveAdapter('anthropic-claude/claude-subscription/oauth');
    assert.ok(claude !== null);
    const attempt = await performOAuthRefresh(
      credential({ providerId: 'anthropic-claude/claude-subscription/oauth' }),
      claude,
      recordFetch(calls, () => jsonResponse({ access_token: 'tok' })),
    );
    assert.equal(attempt.outcome.kind, 'success');
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.has('scope'), false);
    assert.equal(form.has('client_secret'), false);
  });

  it('sends client_secret only when the adapter carries one', async () => {
    const withSecret: RecordedCall[] = [];
    const attempt = await performOAuthRefresh(
      credential(),
      adapter({ clientSecret: 'installed-app-secret' }),
      recordFetch(withSecret, () => jsonResponse({ access_token: 'tok' })),
    );
    assert.equal(attempt.outcome.kind, 'success');
    assert.equal(new URLSearchParams(withSecret[0].body).get('client_secret'), 'installed-app-secret');

    const withoutSecret: RecordedCall[] = [];
    await performOAuthRefresh(
      credential(),
      adapter(),
      recordFetch(withoutSecret, () => jsonResponse({ access_token: 'tok' })),
    );
    assert.equal(new URLSearchParams(withoutSecret[0].body).has('client_secret'), false);

    const emptySecret: RecordedCall[] = [];
    await performOAuthRefresh(
      credential(),
      adapter({ clientSecret: '' }),
      recordFetch(emptySecret, () => jsonResponse({ access_token: 'tok' })),
    );
    assert.equal(new URLSearchParams(emptySecret[0].body).has('client_secret'), false);
  });

  it('parses the token response and computes the writeback expiry', async () => {
    const attempt = await performOAuthRefresh(
      credential(),
      adapter(),
      () =>
        Promise.resolve(
          jsonResponse({ access_token: 'acc', refresh_token: 'new-rt', id_token: 'id', expires_in: 1200 }),
        ),
      { nowMs: 10_000 },
    );
    assert.equal(attempt.outcome.kind, 'success');
    const { writeback } = attempt;
    assert.ok(writeback !== null);
    assert.equal(writeback.key, credential().key);
    assert.equal(writeback.accessToken, 'acc');
    assert.equal(writeback.refreshToken, 'new-rt');
    assert.equal(writeback.idToken, 'id');
    assert.equal(writeback.expiresInSeconds, 1200);
    assert.equal(writeback.expiresAtMs, 10_000 + 1_200_000);
  });

  it('keeps a null refresh token and expiry when the endpoint returns neither', async () => {
    const attempt = await performOAuthRefresh(credential(), adapter(), () =>
      Promise.resolve(jsonResponse({ access_token: 'acc' })),
    );
    assert.equal(attempt.outcome.kind, 'success');
    assert.ok(attempt.writeback !== null);
    assert.equal(attempt.writeback.refreshToken, null);
    assert.equal(attempt.writeback.expiresAtMs, null);
    assert.equal(attempt.writeback.expiresInSeconds, null);
  });

  it('extracts passthrough fields the binding preserves', async () => {
    const attempt = await performOAuthRefresh(
      credential(),
      adapter({ passthroughFields: ['plan_type', 'chatgpt_account_id'] }),
      () => Promise.resolve(jsonResponse({ access_token: 'acc', plan_type: 'plus', chatgpt_account_id: 42 })),
    );
    assert.equal(attempt.outcome.kind, 'success');
    assert.ok(attempt.writeback !== null);
    assert.deepEqual(attempt.writeback.passthrough, { plan_type: 'plus' });
  });
});

describe('performOAuthRefresh failure taxonomy', () => {
  const refresh = (respond: () => Response, ad: OAuthRefreshAdapter = adapter()) =>
    performOAuthRefresh(credential(), ad, () => Promise.resolve(respond()));

  for (const code of NON_RETRYABLE_OAUTH_ERRORS) {
    it(`classifies the terminal rejection ${code}`, async () => {
      const attempt = await refresh(() => jsonResponse({ error: code }, 400));
      assert.equal(attempt.outcome.kind, 'terminal');
      assert.equal(attempt.outcome.errorCode, 'endpoint_rejected');
      assert.equal(attempt.outcome.oauthError, code);
      assert.equal(attempt.outcome.httpStatus, 400);
      assert.equal(attempt.writeback, null);
    });
  }

  it('classifies a 400 without a known terminal code as non-retryable failure', async () => {
    const attempt = await refresh(() => jsonResponse({ error: 'unsupported_grant_type' }, 400));
    assert.equal(attempt.outcome.kind, 'failure');
    assert.equal(attempt.outcome.errorCode, 'endpoint_rejected');
    assert.equal(attempt.outcome.oauthError, 'unsupported_grant_type');
  });

  it('classifies 429 and 5xx as retryable', async () => {
    const rateLimited = await refresh(() => new Response('', { status: 429 }));
    assert.equal(rateLimited.outcome.kind, 'retryable');
    assert.equal(rateLimited.outcome.errorCode, 'rate_limited');
    assert.equal(rateLimited.outcome.httpStatus, 429);

    const unavailable = await refresh(() => new Response('', { status: 503 }));
    assert.equal(unavailable.outcome.kind, 'retryable');
    assert.equal(unavailable.outcome.errorCode, 'provider_unavailable');
    assert.equal(unavailable.outcome.httpStatus, 503);
  });

  it('classifies a network failure as retryable network_error without status', async () => {
    const attempt = await performOAuthRefresh(credential(), adapter(), () => Promise.reject(new Error('boom')));
    assert.equal(attempt.outcome.kind, 'retryable');
    assert.equal(attempt.outcome.errorCode, 'network_error');
    assert.equal(attempt.outcome.httpStatus, null);
    assert.equal(attempt.outcome.oauthError, null);
  });

  it('classifies a 3xx redirect as a non-followed failure', async () => {
    const attempt = await refresh(() => new Response('', { status: 302, headers: { location: 'https://x.test/' } }));
    assert.equal(attempt.outcome.kind, 'failure');
    assert.equal(attempt.outcome.errorCode, 'redirect_rejected');
    assert.equal(attempt.outcome.httpStatus, 302);
  });

  it('classifies an unexpected non-2xx status as endpoint_unsupported', async () => {
    const attempt = await refresh(() => new Response('', { status: 405 }));
    assert.equal(attempt.outcome.kind, 'failure');
    assert.equal(attempt.outcome.errorCode, 'endpoint_unsupported');
  });

  it('classifies unsupported adapters and malformed credentials as cleanly unsupported', async () => {
    const noFetch: OAuthRefreshFetch = () => Promise.resolve(jsonResponse({ access_token: 'tok' }));
    const noEndpoint = await performOAuthRefresh(
      credential(),
      adapter({ tokenEndpoint: 'https://host:8443/token' }),
      noFetch,
    );
    assert.equal(noEndpoint.outcome.kind, 'unsupported');
    assert.equal(noEndpoint.outcome.errorCode, 'adapter_unsupported');

    const badToken = await performOAuthRefresh(credential({ refreshToken: 'has space' }), adapter(), noFetch);
    assert.equal(badToken.outcome.kind, 'unsupported');
    assert.equal(badToken.outcome.errorCode, 'credential_invalid');
    assert.equal(badToken.writeback, null);
  });

  it('rejects non-JSON and unparseable token responses', async () => {
    const wrongType = await refresh(() => new Response('tok', { headers: { 'content-type': 'text/plain' } }));
    assert.equal(wrongType.outcome.kind, 'failure');
    assert.equal(wrongType.outcome.errorCode, 'response_invalid');

    const missingType = await refresh(() => new Response('{}'));
    assert.equal(missingType.outcome.kind, 'failure');
    assert.equal(missingType.outcome.errorCode, 'response_invalid');

    const badJson = await refresh(() => jsonResponse({ nope: true }));
    assert.equal(badJson.outcome.kind, 'failure');
    assert.equal(badJson.outcome.errorCode, 'response_invalid');

    const badExpiry = await refresh(() => jsonResponse({ access_token: 'acc', expires_in: 0 }));
    assert.equal(badExpiry.outcome.kind, 'failure');
    assert.equal(badExpiry.outcome.errorCode, 'response_invalid');
  });
});

describe('performOAuthRefresh response caps', () => {
  it('rejects a declared content-length over the cap before reading the body', async () => {
    const attempt = await performOAuthRefresh(credential(), adapter(), () =>
      Promise.resolve(
        new Response('x', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(OAUTH_REFRESH_MAX_RESPONSE_BYTES + 1),
          },
        }),
      ),
    );
    assert.equal(attempt.outcome.kind, 'failure');
    assert.equal(attempt.outcome.errorCode, 'response_too_large');
    assert.equal(attempt.outcome.httpStatus, 200);
  });

  it('rejects a streamed body over the cap even without a declared length', async () => {
    const attempt = await performOAuthRefresh(credential(), adapter(), () =>
      Promise.resolve(
        new Response(`${'x'.repeat(OAUTH_REFRESH_MAX_RESPONSE_BYTES + 1)}`, {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    assert.equal(attempt.outcome.kind, 'failure');
    assert.equal(attempt.outcome.errorCode, 'response_too_large');
  });
});

describe('refreshBackoffMs', () => {
  it('doubles from the min and caps at the max', () => {
    assert.equal(refreshBackoffMs(1, { min: 1_000, max: 100_000 }), 1_000);
    assert.equal(refreshBackoffMs(2, { min: 1_000, max: 100_000 }), 2_000);
    assert.equal(refreshBackoffMs(3, { min: 1_000, max: 100_000 }), 4_000);
    assert.equal(refreshBackoffMs(9, { min: 1_000, max: 100_000 }), 100_000);
    assert.equal(refreshBackoffMs(99, { min: 1_000, max: 100_000 }), 100_000);
    assert.equal(refreshBackoffMs(0, { min: 1_000, max: 100_000 }), 1_000);
  });

  it('applies deterministic ±10% jitter keyed by the account and stays clamped', () => {
    const first = refreshBackoffMs(1, { min: 10_000, max: 100_000, jitterKey: 'codex_oauth:a1' });
    const second = refreshBackoffMs(1, { min: 10_000, max: 100_000, jitterKey: 'codex_oauth:a1' });
    assert.equal(first, second);
    assert.ok(first >= 9_500 && first <= 11_000);
    // Jitter is clamped into [min, max] at the ladder extremes.
    const jitteredMax = refreshBackoffMs(9, { min: 10_000, max: 12_000, jitterKey: 'k' });
    assert.ok(jitteredMax >= 10_000 && jitteredMax <= 12_000);
    // Different keys may jitter differently but remain within the band.
    const other = refreshBackoffMs(1, { min: 10_000, max: 100_000, jitterKey: 'other' });
    assert.ok(other >= 9_500 && other <= 11_000);
  });

  it('defaults to the shared constants without options', () => {
    assert.equal(refreshBackoffMs(1), 60_000);
    assert.ok(refreshBackoffMs(50) >= 60_000);
  });
});

describe('shouldRefresh', () => {
  const margin = 60_000;
  const now = 1_000_000;

  it('refreshes inside the margin and at the boundary, not outside it', () => {
    assert.equal(shouldRefresh(now + margin, margin, now, false), true);
    assert.equal(shouldRefresh(now + margin - 1, margin, now, false), true);
    assert.equal(shouldRefresh(now + margin + 1, margin, now, false), false);
    assert.equal(shouldRefresh(now - 1, margin, now, false), true);
  });

  it('never proactively refreshes an unknown expiry', () => {
    assert.equal(shouldRefresh(null, margin, now, false), false);
  });

  it('force bypasses the margin for known and unknown expiries', () => {
    assert.equal(shouldRefresh(null, margin, now, true), true);
    assert.equal(shouldRefresh(now + 10 * margin, margin, now, true), true);
  });
});
