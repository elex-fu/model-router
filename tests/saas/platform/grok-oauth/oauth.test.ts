import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildGrokAuthorizeUrl,
  computePkceChallenge,
  createGrokPkcePair,
  GROK_OAUTH_AUTH_SCOPES,
  GROK_OAUTH_AUTHORIZE_ENDPOINT,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_DEFAULT_TOKEN_TTL_MS,
  GROK_OAUTH_ISSUER,
  GROK_OAUTH_REDIRECT_URI,
  GROK_OAUTH_REFRESH_LEAD_MS,
  GROK_OAUTH_REFRESH_SCOPE,
  GROK_OAUTH_TOKEN_ENDPOINT,
  grokOauthError,
  grokRefreshDelayMs,
  grokSubscriptionTierFromAccessToken,
  mapGrokJwtSubscriptionTier,
  normalizeGrokSubscriptionTier,
  parseGrokIdTokenClaims,
} from '../../../../src/saas/platform/grok-oauth/oauth.js';

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** Minimal unsigned JWT shape (claims-only) for direct-TLS trust-basis tests. */
function fakeJwt(claims: Record<string, unknown>): string {
  return `${base64url(Buffer.from(JSON.stringify({ alg: 'none' })))}.${base64url(
    Buffer.from(JSON.stringify(claims)),
  )}.${base64url(Buffer.from('sig'))}`;
}

test('grok PKCE pair: 32 random bytes as unpadded base64url verifier, S256 challenge', () => {
  const { codeVerifier, codeChallenge } = createGrokPkcePair();
  // 32 bytes → 43 base64url characters, unpadded, RFC 7636 §4.1/4.2 charset.
  assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!codeVerifier.includes('='));
  assert.equal(codeChallenge, computePkceChallenge(codeVerifier));
  assert.equal(codeChallenge, base64url(createHash('sha256').update(codeVerifier, 'utf8').digest()));
  // Two draws never collide (random entropy behind the verifier).
  assert.notEqual(createGrokPkcePair().codeVerifier, createGrokPkcePair().codeVerifier);
});

test('the authorize URL pins the public client, full scope, S256 and plan=generic', () => {
  const url = buildGrokAuthorizeUrl({ state: 'a'.repeat(43), codeChallenge: createGrokPkcePair().codeChallenge });
  assert.equal(`${url.origin}${url.pathname}`, GROK_OAUTH_AUTHORIZE_ENDPOINT);
  assert.equal(GROK_OAUTH_ISSUER, 'https://auth.x.ai');
  assert.equal(GROK_OAUTH_AUTHORIZE_ENDPOINT, 'https://auth.x.ai/oauth2/authorize');
  assert.equal(GROK_OAUTH_TOKEN_ENDPOINT, 'https://auth.x.ai/oauth2/token');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), GROK_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get('client_id'), 'b1a00492-073a-47ea-816f-4c329264a828');
  assert.equal(url.searchParams.get('redirect_uri'), GROK_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), GROK_OAUTH_AUTH_SCOPES);
  assert.equal(GROK_OAUTH_AUTH_SCOPES, 'openid profile email offline_access grok-cli:access api:access');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('plan'), 'generic');
  assert.ok(url.searchParams.get('state'));
});

test('authorize URL input validation fails closed', () => {
  assert.throws(
    () => buildGrokAuthorizeUrl({ state: 'short', codeChallenge: 'x'.repeat(43) }),
    (error: unknown) => {
      assert.ok(error instanceof Error && error.name === 'GrokOAuthError');
      assert.equal((error as { code?: string }).code, 'STATE_INVALID');
      return true;
    },
  );
  assert.throws(
    () => buildGrokAuthorizeUrl({ state: 'a'.repeat(43), codeChallenge: 'too-short' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PKCE_INVALID');
      return true;
    },
  );
  assert.ok(grokOauthError('STATE_INVALID') instanceof Error);
});

test('id_token claims: email/sub/team_id extraction with the clock-skew freshness gate', () => {
  const nowMs = Date.now();
  const claims = parseGrokIdTokenClaims(
    fakeJwt({ sub: 'user-1', team_id: 'team-9', email: 'a@example.com', exp: Math.floor(nowMs / 1000) + 60 }),
    nowMs,
  );
  assert.equal(claims.userId, 'user-1');
  assert.equal(claims.teamId, 'team-9');
  assert.equal(claims.email, 'a@example.com');
  // Expired more than the skew window ago is rejected.
  assert.throws(
    () => parseGrokIdTokenClaims(fakeJwt({ sub: 'user-1', exp: Math.floor(nowMs / 1000) - 400 }), nowMs),
    (error: unknown) => (error as { code?: string }).code === 'ID_TOKEN_EXPIRED',
  );
  // No sub claim is a claims failure.
  assert.throws(
    () => parseGrokIdTokenClaims(fakeJwt({ exp: Math.floor(nowMs / 1000) + 60 }), nowMs),
    (error: unknown) => (error as { code?: string }).code === 'ID_TOKEN_CLAIMS_MISSING',
  );
});

test('subscription tier comes from the ACCESS TOKEN numeric claim (sub2api tier map)', () => {
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 0 })), 'free');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 1 })), 'supergrok');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 5 })), 'supergrok_heavy');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 6 })), 'supergrok_lite');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 7 })), 'supergrok_plus');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: '3' })), 'x_premium');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 'SuperGrok Heavy' })), 'supergrok_heavy');
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 'free-tier' })), 'free');
  // No tier claim / malformed token / non-integer tier → null, never guessed.
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({})), null);
  assert.equal(grokSubscriptionTierFromAccessToken('not-a-jwt'), null);
  assert.equal(grokSubscriptionTierFromAccessToken(fakeJwt({ tier: 1.5 })), null);
  assert.equal(mapGrokJwtSubscriptionTier(4), 'x_premium_plus');
  assert.equal(normalizeGrokSubscriptionTier('SuperGrok'), 'supergrok');
});

test('refresh scheduling honors the 6h TTL pin with a >= 5min lead', () => {
  assert.equal(GROK_OAUTH_DEFAULT_TOKEN_TTL_MS, 6 * 60 * 60 * 1_000);
  assert.equal(GROK_OAUTH_REFRESH_LEAD_MS, 5 * 60 * 1_000);
  // The 6h TTL with a 5min lead refreshes 5 minutes before expiry.
  assert.equal(grokRefreshDelayMs(null), GROK_OAUTH_DEFAULT_TOKEN_TTL_MS - GROK_OAUTH_REFRESH_LEAD_MS);
  assert.equal(grokRefreshDelayMs(21_600), 21_600 * 1_000 - GROK_OAUTH_REFRESH_LEAD_MS);
  // A TTL above the lead refreshes exactly lead-before-expiry; a shorter TTL
  // refreshes as early as it can (at expiry — no later than the TTL itself).
  for (const ttlSeconds of [600, 3_600, 21_600]) {
    assert.equal(grokRefreshDelayMs(ttlSeconds), ttlSeconds * 1_000 - GROK_OAUTH_REFRESH_LEAD_MS);
  }
  assert.equal(grokRefreshDelayMs(60), 60_000);
  assert.equal(GROK_OAUTH_REFRESH_SCOPE, null);
});
