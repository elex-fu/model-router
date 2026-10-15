import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAuthorizeUrl,
  CODEX_ID_TOKEN_CLOCK_SKEW_MS,
  CODEX_OAUTH_AUTH_SCOPES,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_REFRESH_SCOPE,
  CODEX_OAUTH_USER_AGENT,
  CodexOAuthError,
  computePkceChallenge,
  constantTimeEqualText,
  createPkcePair,
  parseIdTokenClaims,
} from '../../../../src/saas/platform/codex-oauth/oauth.js';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Runtime-assembled fake JWT (no real token material anywhere). */
function makeIdToken(payload: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(payload)}.sig-nomatter-not-verified`;
}

function claimsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://auth.openai.com/',
    sub: 'user-1',
    aud: CODEX_OAUTH_CLIENT_ID,
    exp: Math.floor((Date.now() + 3_600_000) / 1000),
    iat: Math.floor(Date.now() / 1000),
    email: 'operator@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-1234',
      chatgpt_user_id: 'user-5678',
      plan_type: 'plus',
      organizations: ['org-1', { id: 'org-2' }, 42],
    },
    ...overrides,
  };
}

test('PKCE follows S256 with the RFC 7636 appendix vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(computePkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('createPkcePair derives the challenge from its verifier deterministically', () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.match(codeVerifier, /^[0-9a-f]{128}$/);
    assert.equal(codeChallenge, computePkceChallenge(codeVerifier));
    assert.match(codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  }
  assert.notEqual(createPkcePair().codeVerifier, createPkcePair().codeVerifier);
});

test('buildAuthorizeUrl pins every empirically verified Codex parameter', () => {
  const { codeChallenge } = createPkcePair();
  const state = 'a'.repeat(32);
  const url = buildAuthorizeUrl({ state, codeChallenge });
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  const params = [...url.searchParams.entries()];
  assert.deepEqual(params, [
    ['response_type', 'code'],
    ['client_id', CODEX_OAUTH_CLIENT_ID],
    ['redirect_uri', CODEX_OAUTH_REDIRECT_URI],
    ['scope', CODEX_OAUTH_AUTH_SCOPES],
    ['state', state],
    ['code_challenge', codeChallenge],
    ['code_challenge_method', 'S256'],
    ['codex_cli_simplified_flow', 'true'],
  ]);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.notEqual(url.searchParams.get('scope'), CODEX_OAUTH_REFRESH_SCOPE);
});

test('buildAuthorizeUrl rejects malformed state and challenge inputs', () => {
  const { codeChallenge } = createPkcePair();
  assert.throws(() => buildAuthorizeUrl({ state: 'short', codeChallenge }), CodexOAuthError);
  assert.throws(() => buildAuthorizeUrl({ state: `x${'a'.repeat(300)}`, codeChallenge }), CodexOAuthError);
  assert.throws(() => buildAuthorizeUrl({ state: 'a'.repeat(32), codeChallenge: 'not-a-challenge' }), CodexOAuthError);
});

test('parseIdTokenClaims extracts the api.openai.com/auth claims', () => {
  const nowMs = Date.now();
  const idToken = makeIdToken(claimsPayload({ exp: Math.floor((nowMs + 60_000) / 1000) }));
  const claims = parseIdTokenClaims(idToken, nowMs);
  assert.equal(claims.chatgptAccountId, 'acct-1234');
  assert.equal(claims.chatgptUserId, 'user-5678');
  assert.equal(claims.planType, 'plus');
  assert.equal(claims.email, 'operator@example.test');
  assert.deepEqual(claims.organizations, ['org-1', 'org-2']);
});

test('parseIdTokenClaims accepts expiry inside the 120s skew window and rejects beyond it', () => {
  const nowMs = Date.now();
  const withinSkew = makeIdToken(
    claimsPayload({ exp: Math.floor((nowMs - CODEX_ID_TOKEN_CLOCK_SKEW_MS + 1_000) / 1000) }),
  );
  assert.equal(parseIdTokenClaims(withinSkew, nowMs).chatgptAccountId, 'acct-1234');

  const beyondSkew = makeIdToken(
    claimsPayload({ exp: Math.floor((nowMs - CODEX_ID_TOKEN_CLOCK_SKEW_MS - 1_000) / 1000) }),
  );
  assert.throws(
    () => parseIdTokenClaims(beyondSkew, nowMs),
    (error: unknown) => {
      assert.ok(error instanceof CodexOAuthError);
      assert.equal(error.code, 'ID_TOKEN_EXPIRED');
      return true;
    },
  );
});

test('parseIdTokenClaims fails closed on malformed tokens and missing claims', () => {
  const nowMs = Date.now();
  const cases: Array<{ name: string; token: string }> = [
    { name: 'not a jwt', token: 'hello' },
    { name: 'two segments', token: `${encodeSegment({})}.${encodeSegment({})}` },
    { name: 'non-base64url segment', token: `x!x.${encodeSegment(claimsPayload())}.y` },
    { name: 'payload not json', token: `${encodeSegment({})}.${Buffer.from('nope').toString('base64url')}.z` },
    { name: 'payload not an object', token: `${encodeSegment({})}.${encodeSegment([1, 2])}.z` },
    { name: 'no exp claim', token: makeIdToken(claimsPayload({ exp: undefined })) },
    { name: 'no auth claims object', token: makeIdToken({ exp: Math.floor(nowMs / 1000) + 600 }) },
    {
      name: 'auth claims without account id',
      token: makeIdToken({ exp: Math.floor(nowMs / 1000) + 600, 'https://api.openai.com/auth': {} }),
    },
    {
      name: 'auth claims is an array',
      token: makeIdToken({ exp: Math.floor(nowMs / 1000) + 600, 'https://api.openai.com/auth': [] }),
    },
  ];
  for (const { name, token } of cases) {
    assert.throws(
      () => parseIdTokenClaims(token, nowMs),
      (error: unknown) => {
        assert.ok(error instanceof CodexOAuthError, `${name}: expected CodexOAuthError`);
        assert.equal(error.code === 'ID_TOKEN_MALFORMED' || error.code === 'ID_TOKEN_CLAIMS_MISSING', true);
        return true;
      },
      name,
    );
  }
});

test('the canonical outbound user agent tracks the Codex CLI shape', () => {
  assert.match(CODEX_OAUTH_USER_AGENT, /^codex_cli_rs\/0\.1(4[4-9]|[5-9][0-9])\.\d+ /);
});

test('constantTimeEqualText compares without early-exit length leaks', () => {
  assert.equal(constantTimeEqualText('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(constantTimeEqualText('a'.repeat(64), 'b'.repeat(64)), false);
  assert.equal(constantTimeEqualText('short', 'a-much-longer-value'), false);
  assert.equal(constantTimeEqualText('', ''), true);
});
