import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_REFRESH_SCOPE,
  GROK_OAUTH_TOKEN_ENDPOINT,
  GROK_OAUTH_TOKEN_USER_AGENT,
} from '../../../src/saas/platform/grok-oauth/oauth.js';
import {
  buildOauthCredentialMaterial,
  GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  type OauthTokenRefreshFetch,
  parseOauthCredentialMaterial,
  requestOauthTokenRefresh,
  resolveOauthTokenAdapter,
} from '../../../src/saas/supply/oauth-token-refresh-worker.js';

const grokBinding = { providerId: 'xai-grok', productId: 'grok-subscription', credentialType: 'oauth' } as const;
const grokApiKeyBinding = { providerId: 'xai-grok', productId: 'grok-api', credentialType: 'api-key' } as const;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

function fetchCapturing(seen: Array<{ url: string; body: string; headers: Headers }>, response: Response) {
  return (async (url: URL, init: RequestInit) => {
    seen.push({ url: url.href, body: String(init.body), headers: new Headers(init.headers) });
    return response;
  }) as OauthTokenRefreshFetch;
}

test('the grok refresh binding resolves with the xAI public-client constants', () => {
  const adapter = resolveOauthTokenAdapter(grokBinding);
  assert.ok(adapter);
  assert.equal(adapter.adapterId, 'xai-grok-oauth-v1');
  assert.equal(adapter.tokenEndpoint, GROK_OAUTH_TOKEN_ENDPOINT);
  assert.equal(adapter.tokenEndpoint, 'https://auth.x.ai/oauth2/token');
  assert.equal(adapter.clientId, GROK_OAUTH_CLIENT_ID);
  assert.equal(adapter.clientId, 'b1a00492-073a-47ea-816f-4c329264a828');
  // No scope parameter: the endpoint keeps the original grant's scopes
  // (grok-cli:access / api:access survive every rotation).
  assert.equal(adapter.refreshScope, GROK_OAUTH_REFRESH_SCOPE);
  assert.equal(adapter.refreshScope, null);
  assert.equal(adapter.userAgent, GROK_OAUTH_TOKEN_USER_AGENT);
  assert.deepEqual(adapter.passthroughFields, GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS);
  // The passthrough list keeps the tier + account coordinates alive.
  assert.deepEqual(
    [...GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS],
    ['user_id', 'team_id', 'subscription_tier', 'client_id', 'email'],
  );
});

test('the grok api-key product is NOT refreshable (fail-closed scan)', () => {
  assert.equal(resolveOauthTokenAdapter(grokApiKeyBinding), null);
  // An unknown product under the provider is excluded too.
  assert.equal(resolveOauthTokenAdapter({ ...grokBinding, productId: 'grok-mystery' }), null);
});

test('the grok refresh grant sends no scope and the pinned CLI user agent', async () => {
  const seen: Array<{ url: string; body: string; headers: Headers }> = [];
  const result = await requestOauthTokenRefresh(
    grokBinding,
    'rfrsh-old-token',
    fetchCapturing(
      seen,
      jsonResponse({ access_token: 'accs-new-token', refresh_token: 'rfrsh-new-token', expires_in: 21_600 }),
    ),
  );
  assert.equal(result.state, 'refreshed');
  assert.equal(result.expiresInSeconds, 21_600);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://auth.x.ai/oauth2/token');
  const form = new URLSearchParams(seen[0]?.body ?? '');
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'rfrsh-old-token');
  assert.equal(form.get('client_id'), GROK_OAUTH_CLIENT_ID);
  assert.equal(form.get('scope'), null);
  assert.equal(seen[0]?.headers.get('user-agent'), GROK_OAUTH_TOKEN_USER_AGENT);
});

test('a rotation preserves the grok envelope metadata (tier + account coordinates)', () => {
  const oldSecret = buildOauthCredentialMaterial(
    {
      accessToken: 'accs-old',
      refreshToken: 'rfrsh-old',
      expiresInSeconds: 100,
      passthrough: {
        user_id: 'user-77',
        team_id: 'team-42',
        subscription_tier: 'free',
        email: 'ops@example.com',
        client_id: GROK_OAUTH_CLIENT_ID,
      },
    },
    GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  );
  const material = parseOauthCredentialMaterial(oldSecret, GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS);
  assert.ok(material);
  assert.equal(material.refreshToken, 'rfrsh-old');
  assert.equal(material.passthrough.subscription_tier, 'free');
  assert.equal(material.passthrough.user_id, 'user-77');
  assert.equal(material.passthrough.team_id, 'team-42');
  // The rotated envelope keeps the passthrough even when the endpoint only
  // answered tokens (the worker merges old + response passthrough).
  const rotated = buildOauthCredentialMaterial(
    {
      accessToken: 'accs-new',
      refreshToken: 'rfrsh-new',
      expiresInSeconds: 21_600,
      passthrough: { ...material.passthrough },
    },
    GROK_OAUTH_ENVELOPE_PASSTHROUGH_FIELDS,
  );
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(rotated)) as Record<string, unknown>;
  assert.equal(parsed.access_token, 'accs-new');
  assert.equal(parsed.subscription_tier, 'free');
  assert.equal(parsed.user_id, 'user-77');
  assert.equal(parsed.client_id, GROK_OAUTH_CLIENT_ID);
});
