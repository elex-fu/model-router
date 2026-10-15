import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REFRESH_SCOPE,
  CODEX_OAUTH_TOKEN_ENDPOINT,
} from '../../../src/saas/platform/codex-oauth/oauth.js';
import {
  type OauthTokenRefreshFetch,
  requestOauthTokenRefresh,
  resolveOauthTokenAdapter,
} from '../../../src/saas/supply/oauth-token-refresh-worker.js';

const codexBinding = { providerId: 'openai', productId: 'codex-cli', credentialType: 'oauth' } as const;
const anthropicBinding = { providerId: 'anthropic', productId: 'claude-code', credentialType: 'oauth' } as const;

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': init.contentType ?? 'application/json' }),
  });
}

function fetchCapturing(
  seen: Array<{ url: string; headers: Headers; body: string }>,
  response: Response,
): OauthTokenRefreshFetch {
  return (async (url: URL, init: RequestInit) => {
    seen.push({ url: url.href, headers: new Headers(init.headers), body: String(init.body) });
    return response;
  }) as OauthTokenRefreshFetch;
}

test('the codex refresh binding resolves with the P1b constants and narrowed refresh scope', () => {
  const adapter = resolveOauthTokenAdapter(codexBinding);
  assert.ok(adapter);
  assert.equal(adapter.adapterId, 'openai-codex-oauth-v1');
  assert.equal(adapter.tokenEndpoint, CODEX_OAUTH_TOKEN_ENDPOINT);
  assert.equal(adapter.tokenEndpoint, 'https://auth.openai.com/oauth/token');
  assert.equal(adapter.clientId, CODEX_OAUTH_CLIENT_ID);
  assert.equal(adapter.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(adapter.refreshScope, CODEX_OAUTH_REFRESH_SCOPE);
  assert.equal(adapter.refreshScope, 'openid profile email');
});

test('the codex refresh grant sends the narrowed scope; the anthropic grant stays scope-less', async () => {
  const seenCodex: Array<{ url: string; headers: Headers; body: string }> = [];
  const codex = await requestOauthTokenRefresh(
    codexBinding,
    'rfrsh-old-token',
    fetchCapturing(
      seenCodex,
      jsonResponse({ access_token: 'accs-new-token', refresh_token: 'rfrsh-new-token', expires_in: 3600 }),
    ),
  );
  assert.equal(codex.state, 'refreshed');
  assert.equal(seenCodex.length, 1);
  assert.equal(seenCodex[0]?.url, 'https://auth.openai.com/oauth/token');
  const codexForm = new URLSearchParams(seenCodex[0]?.body ?? '');
  assert.equal(codexForm.get('grant_type'), 'refresh_token');
  assert.equal(codexForm.get('refresh_token'), 'rfrsh-old-token');
  assert.equal(codexForm.get('client_id'), CODEX_OAUTH_CLIENT_ID);
  assert.equal(codexForm.get('scope'), 'openid profile email');

  const seenAnthropic: Array<{ url: string; headers: Headers; body: string }> = [];
  const anthropic = await requestOauthTokenRefresh(
    anthropicBinding,
    'rfrsh-old-token',
    fetchCapturing(seenAnthropic, jsonResponse({ access_token: 'accs-new-token', expires_in: 3600 })),
  );
  assert.equal(anthropic.state, 'refreshed');
  const anthropicForm = new URLSearchParams(seenAnthropic[0]?.body ?? '');
  assert.equal(anthropicForm.get('scope'), null);
});

test('a codex refresh response without a new refresh token keeps the old one (rotation semantics)', async () => {
  const result = await requestOauthTokenRefresh(
    codexBinding,
    'rfrsh-old-token',
    fetchCapturing([], jsonResponse({ access_token: 'accs-new-token', expires_in: 3600 })),
  );
  assert.equal(result.state, 'refreshed');
  if (result.state === 'refreshed') {
    // null means "endpoint did not rotate": the store's rotation input keeps
    // the previous refresh token (attemptRefresh passes refreshToken ?? old).
    assert.equal(result.refreshToken, null);
  }
});

test('an invalid_grant rejection surfaces the structured provider error code', async () => {
  const result = await requestOauthTokenRefresh(
    codexBinding,
    'rfrsh-rotated-elsewhere',
    fetchCapturing([], jsonResponse({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 })),
  );
  assert.equal(result.state, 'failed');
  if (result.state === 'failed') {
    assert.equal(result.errorCode, 'credential_rejected');
    assert.equal(result.httpStatus, 400);
    assert.equal(result.providerError, 'invalid_grant');
    assert.equal(result.retryable, false);
  }
});

test('rejections without a parseable RFC 6749 error body keep providerError null', async () => {
  for (const body of [
    JSON.stringify({ error_description: 'no code field' }),
    JSON.stringify({ error: 'x'.repeat(65) }),
    'not json at all',
  ]) {
    const result = await requestOauthTokenRefresh(
      codexBinding,
      'rfrsh-old-token',
      (async () =>
        new Response(body, {
          status: 403,
          headers: new Headers({ 'content-type': 'application/json' }),
        })) as unknown as OauthTokenRefreshFetch,
    );
    assert.equal(result.state, 'failed');
    if (result.state === 'failed') {
      assert.equal(result.errorCode, 'credential_rejected');
      assert.equal(result.httpStatus, 403);
      assert.equal(result.providerError, null);
    }
  }
});

test('transient upstream failures carry no provider error', async () => {
  const result = await requestOauthTokenRefresh(
    codexBinding,
    'rfrsh-old-token',
    fetchCapturing([], jsonResponse({ error: 'server_overloaded' }, { status: 503 })),
  );
  assert.equal(result.state, 'failed');
  if (result.state === 'failed') {
    assert.equal(result.errorCode, 'provider_unavailable');
    assert.equal(result.retryable, true);
    assert.equal(result.providerError, null);
  }
});
