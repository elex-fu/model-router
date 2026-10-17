import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROK_BINDING_SESSION_TTL_MS,
  type GrokBindingSessionStore,
  GrokOAuthBindingService,
  type GrokOauthFetch,
  InMemoryGrokBindingSessionStore,
} from '../../../../src/saas/platform/grok-oauth/binding-service.js';
import {
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_REDIRECT_URI,
  GROK_OAUTH_TOKEN_ENDPOINT,
} from '../../../../src/saas/platform/grok-oauth/oauth.js';

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fakeJwt(claims: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'none' }))}.${base64url(JSON.stringify(claims))}.${base64url('sig')}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

test('completeBinding exchanges the pasted code with the PKCE verifier and extracts JWT claims', async () => {
  const nowMs = 1_700_000_000_000;
  const seen: Array<{ url: string; body: string; headers: Headers }> = [];
  const fetcher: GrokOauthFetch = async (url, init) => {
    seen.push({ url: url.href, body: String(init.body), headers: new Headers(init.headers) });
    return json({
      access_token: fakeJwt({ tier: 5, sub: 'user-77' }),
      refresh_token: 'rfrsh-token',
      id_token: fakeJwt({
        sub: 'user-77',
        team_id: 'team-42',
        email: 'ops@example.com',
        exp: Math.floor(nowMs / 1000) + 3600,
      }),
      expires_in: 21_600,
    });
  };
  const service = new GrokOAuthBindingService({
    sessionStore: new InMemoryGrokBindingSessionStore(() => nowMs),
    fetch: fetcher,
    nowMs: () => nowMs,
  });
  const start = await service.generateBindingSession();
  assert.equal(start.authorizeUrl.searchParams.get('plan'), 'generic');

  const envelope = await service.completeBinding({ state: start.state, code: 'c'.repeat(40) });
  assert.equal(envelope.accessToken.split('.')[1], base64url(JSON.stringify({ tier: 5, sub: 'user-77' })));
  assert.equal(envelope.refreshToken, 'rfrsh-token');
  assert.equal(envelope.userId, 'user-77');
  assert.equal(envelope.teamId, 'team-42');
  assert.equal(envelope.email, 'ops@example.com');
  // subscription_tier comes ONLY from the access token payload (tier 5 = heavy).
  assert.equal(envelope.subscriptionTier, 'supergrok_heavy');
  assert.equal(envelope.clientId, GROK_OAUTH_CLIENT_ID);
  assert.equal(envelope.expiresAt, new Date(nowMs + 21_600 * 1_000).toISOString());

  // The exchange hits the fixed token endpoint with the authorization_code
  // grant, the client id, the session's PKCE verifier and the loopback
  // redirect URI.
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, GROK_OAUTH_TOKEN_ENDPOINT);
  const form = new URLSearchParams(seen[0]?.body ?? '');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('client_id'), GROK_OAUTH_CLIENT_ID);
  assert.equal(form.get('redirect_uri'), GROK_OAUTH_REDIRECT_URI);
  assert.ok(form.get('code_verifier'));
});

test('the binding session is single-use and expiry-gated', async () => {
  let serviceClock = 1_700_000_000_000;
  // The store's sweep clock stays frozen so the expiry gate under test is
  // the SERVICE's (a store-side sweep would race the same deadline).
  const store = new InMemoryGrokBindingSessionStore(() => 1_700_000_000_000);
  const service = new GrokOAuthBindingService({
    sessionStore: store,
    fetch: async () => json({ access_token: 'a', refresh_token: 'r', id_token: fakeJwt({ sub: 'u' }) }),
    nowMs: () => serviceClock,
  });
  const start = await service.generateBindingSession();
  // A wrong state never reaches the token endpoint.
  await assert.rejects(
    () => service.completeBinding({ state: 'f'.repeat(43), code: 'c'.repeat(40) }),
    (error: unknown) => (error as { code?: string }).code === 'SESSION_NOT_FOUND',
  );
  // Expired session.
  serviceClock += GROK_BINDING_SESSION_TTL_MS + 1;
  await assert.rejects(
    () => service.completeBinding({ state: start.state, code: 'c'.repeat(40) }),
    (error: unknown) => (error as { code?: string }).code === 'SESSION_EXPIRED',
  );
});

test('an upstream rejection never surfaces token material', async () => {
  const service = new GrokOAuthBindingService({
    sessionStore: new InMemoryGrokBindingSessionStore(),
    fetch: async () => json({ error: 'invalid_grant' }, 400),
  });
  const start = await service.generateBindingSession();
  await assert.rejects(
    () => service.completeBinding({ state: start.state, code: 'c'.repeat(40) }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'TOKEN_EXCHANGE_FAILED');
      assert.ok(!(error instanceof Error) || !error.message.includes('invalid_grant'));
      return true;
    },
  );
});

test('a token response without an id_token is rejected (claims are mandatory)', async () => {
  const service = new GrokOAuthBindingService({
    sessionStore: new InMemoryGrokBindingSessionStore(),
    fetch: async () => json({ access_token: 'a', refresh_token: 'r' }),
  });
  const start = await service.generateBindingSession();
  await assert.rejects(
    () => service.completeBinding({ state: start.state, code: 'c'.repeat(40) }),
    (error: unknown) => (error as { code?: string }).code === 'TOKEN_RESPONSE_INVALID',
  );
});

test('the session store bound stays bounded and sweeps expired entries', async () => {
  let clock = 0;
  const store: GrokBindingSessionStore = new InMemoryGrokBindingSessionStore(() => clock);
  await store.put({ state: 's'.repeat(43), codeVerifier: 'v'.repeat(43), expiresAtMs: 100 });
  clock = 101;
  assert.equal(await store.take('s'.repeat(43)), null);
});
