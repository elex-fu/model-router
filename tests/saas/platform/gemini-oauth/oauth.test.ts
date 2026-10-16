import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  buildAuthorizeUrl,
  createPkcePair,
  GEMINI_OAUTH_AUTH_SCOPES,
  GEMINI_OAUTH_AUTHORIZE_ENDPOINT,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET_ENV,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_REFRESH_SCOPE,
  GEMINI_OAUTH_TOKEN_ENDPOINT,
  GEMINI_OAUTH_TOKEN_USER_AGENT,
  GeminiOAuthError,
  resolveGeminiOauthClientSecret,
} from '../../../../src/saas/platform/gemini-oauth/oauth.js';

const STATE = 'a'.repeat(64);

test('the OAuth constants match the Gemini CLI black-box capture', () => {
  assert.equal(GEMINI_OAUTH_CLIENT_ID, '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
  assert.equal(GEMINI_OAUTH_AUTHORIZE_ENDPOINT, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(GEMINI_OAUTH_TOKEN_ENDPOINT, 'https://oauth2.googleapis.com/token');
  assert.equal(GEMINI_OAUTH_REDIRECT_URI, 'https://codeassist.google.com/authcode');
  assert.equal(GEMINI_OAUTH_TOKEN_USER_AGENT, 'model-router');
  assert.ok(GEMINI_OAUTH_AUTH_SCOPES.includes('https://www.googleapis.com/auth/cloud-platform'));
  assert.ok(GEMINI_OAUTH_AUTH_SCOPES.includes('userinfo.email'));
  // Refresh grants send no scope: the original grant's scopes persist.
  assert.equal(GEMINI_OAUTH_REFRESH_SCOPE, null);
});

test('the PKCE pair uses the Gemini CLI 43-char base64url verifier shape', () => {
  const pair = createPkcePair();
  assert.match(pair.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  // S256: base64url(SHA-256(verifier)), pinned against node:crypto directly.
  const expected = createHash('sha256').update(pair.codeVerifier, 'utf8').digest('base64url');
  assert.equal(pair.codeChallenge, expected);
});

test('the authorize URL carries offline access, consent and PKCE S256', () => {
  const url = buildAuthorizeUrl({ state: STATE, codeChallenge: 'b'.repeat(43) });
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), GEMINI_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), GEMINI_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), GEMINI_OAUTH_AUTH_SCOPES);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'b'.repeat(43));
  // The offline-access consent pair the CLI sends: without prompt=consent
  // Google may skip issuing a refresh token for an already-authorized user.
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
});

test('invalid state and PKCE challenge shapes fail closed', () => {
  for (const badState of ['short', '', `spaces ${' '.repeat(20)}`, `bad+chars${'x'.repeat(20)}`]) {
    assert.throws(
      () => buildAuthorizeUrl({ state: badState, codeChallenge: 'b'.repeat(43) }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiOAuthError);
        assert.equal(error.code, 'STATE_INVALID');
        return true;
      },
      JSON.stringify(badState),
    );
  }
  for (const badChallenge of ['too-short', '', 'x'.repeat(44), 'not+base64url+challenge+value+padding==']) {
    assert.throws(
      () => buildAuthorizeUrl({ state: STATE, codeChallenge: badChallenge }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiOAuthError);
        assert.equal(error.code, 'PKCE_INVALID');
        return true;
      },
      JSON.stringify(badChallenge),
    );
  }
});

test('the installed-app client secret arrives only through the environment', () => {
  assert.equal(GEMINI_OAUTH_CLIENT_SECRET_ENV, 'MODEL_ROUTER_GEMINI_OAUTH_CLIENT_SECRET');
  assert.equal(resolveGeminiOauthClientSecret({ [GEMINI_OAUTH_CLIENT_SECRET_ENV]: 'test-secret' }), 'test-secret');
  assert.equal(resolveGeminiOauthClientSecret({}), null);
  assert.equal(resolveGeminiOauthClientSecret({ [GEMINI_OAUTH_CLIENT_SECRET_ENV]: undefined }), null);
  assert.equal(resolveGeminiOauthClientSecret({ [GEMINI_OAUTH_CLIENT_SECRET_ENV]: '' }), null);
  assert.equal(resolveGeminiOauthClientSecret({ [GEMINI_OAUTH_CLIENT_SECRET_ENV]: '   ' }), null);
  // Whitespace-only padding is trimmed away; a real value survives trimming.
  assert.equal(
    resolveGeminiOauthClientSecret({ [GEMINI_OAUTH_CLIENT_SECRET_ENV]: ' padded-secret ' }),
    'padded-secret',
  );
});
