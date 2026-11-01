import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { ControlStore } from '../../src/control/store.js';
import {
  CODEX_OAUTH_AUTH_SCOPES,
  CODEX_OAUTH_AUTHORIZE_ENDPOINT,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_REFRESH_SCOPE,
  CODEX_OAUTH_SIMPLIFIED_FLOW,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  CODEX_OAUTH_USER_AGENT,
  CodexOAuthError,
  type CodexOauthFetch,
  codexOauthError,
  computePkceChallenge,
  constantTimeEqualText,
  createCodexBindingSession,
  createPkcePair,
  decodeIdTokenClaims,
  exchangeCodeForTokens,
  parseCodexAuthJson,
  parseIdTokenClaims,
} from '../../src/server/codex-account-binding.js';
import { OAuthAccountStore } from '../../src/server/oauth-accounts.js';

const AUTHORIZATION_CODE = 'authorization-code_value-0123456789abcdef';
const ACCESS_TOKEN = 'codex-access-token-1';
const REFRESH_TOKEN = 'codex-refresh-token-1';

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeIdToken(payload: Record<string, unknown>, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(
    JSON.stringify({ iss: 'https://auth.openai.com/', iat: Math.floor(nowMs / 1000), ...payload }),
  );
  return `${header}.${body}.signature`;
}

function chatgptClaims(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'user@example.com',
    exp: Math.floor((nowMs + 600_000) / 1000),
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-123',
      chatgpt_user_id: 'user-456',
      plan_type: 'chatgptplus',
      organizations: ['org-1', { id: 'org-2' }],
    },
    ...overrides,
  };
}

function tokenBody(idToken: string | null, expires: number | string = 3600): string {
  return JSON.stringify({
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    ...(idToken === null ? {} : { id_token: idToken }),
    expires_in: expires,
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestRedirect | undefined;
}

function stubFetch(body: string, status = 200): { fetch: CodexOauthFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: CodexOauthFetch = (url, init) => {
    requests.push({
      url: url.toString(),
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
      redirect: init.redirect,
    });
    return Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
  };
  return { fetch, requests };
}

const failingFetch: CodexOauthFetch = () => Promise.reject(new Error('network down'));

function expectError(error: unknown, code: string): void {
  assert.ok(error instanceof CodexOAuthError, `expected CodexOAuthError, got ${String(error)}`);
  assert.equal((error as CodexOAuthError).code, code);
}

describe('createPkcePair', () => {
  it('pins the Codex CLI verifier shape and the S256 challenge', () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.match(codeVerifier, /^[0-9a-f]{128}$/);
    assert.match(codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(codeChallenge, computePkceChallenge(codeVerifier));
  });
});

describe('buildAuthorizeUrl (via session.start)', () => {
  it('carries the exact public client constants and query parameter set', () => {
    const start = createCodexBindingSession().start();
    const url = start.authorizeUrl;
    assert.equal(`${url.origin}${url.pathname}`, CODEX_OAUTH_AUTHORIZE_ENDPOINT);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), CODEX_OAUTH_CLIENT_ID);
    assert.equal(url.searchParams.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);
    assert.equal(url.searchParams.get('scope'), CODEX_OAUTH_AUTH_SCOPES);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get(CODEX_OAUTH_SIMPLIFIED_FLOW), 'true');
    assert.equal(url.searchParams.get('state'), start.state);
    assert.equal(url.searchParams.get('code_challenge'), computePkceChallenge(start.codeVerifier));
    assert.deepEqual([...url.searchParams.keys()].sort(), [
      'client_id',
      'code_challenge',
      'code_challenge_method',
      CODEX_OAUTH_SIMPLIFIED_FLOW,
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ]);
    // The constants themselves: the empirically verified public Codex CLI values.
    assert.equal(CODEX_OAUTH_CLIENT_ID, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(CODEX_OAUTH_REDIRECT_URI, 'http://localhost:1455/auth/callback');
    assert.equal(CODEX_OAUTH_AUTH_SCOPES, 'openid profile email offline_access');
    assert.equal(CODEX_OAUTH_REFRESH_SCOPE, 'openid profile email');
    assert.equal(CODEX_OAUTH_TOKEN_ENDPOINT, 'https://auth.openai.com/oauth/token');
    assert.equal(CODEX_OAUTH_USER_AGENT.startsWith('codex_cli_rs/'), true);
  });

  it('state is 32 random bytes of hex and the verifier matches the challenge', () => {
    for (let index = 0; index < 8; index += 1) {
      const start = createCodexBindingSession().start();
      assert.match(start.state, /^[0-9a-f]{64}$/);
      assert.equal(start.codeVerifier.length, 128);
      assert.equal(computePkceChallenge(start.codeVerifier), start.authorizeUrl.searchParams.get('code_challenge'));
    }
  });
});

describe('exchangeCodeForTokens', () => {
  it('posts the authorization_code grant to the fixed endpoint with the CLI UA', async () => {
    const idToken = makeIdToken(chatgptClaims(Date.now()), Date.now());
    const { fetch, requests } = stubFetch(tokenBody(idToken));
    const result = await exchangeCodeForTokens({
      code: AUTHORIZATION_CODE,
      codeVerifier: 'v'.repeat(128),
      fetch,
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, CODEX_OAUTH_TOKEN_ENDPOINT);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].redirect, 'manual');
    assert.equal(requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(requests[0].headers['user-agent'], CODEX_OAUTH_USER_AGENT);
    const params = new URLSearchParams(requests[0].body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('client_id'), CODEX_OAUTH_CLIENT_ID);
    assert.equal(params.get('code'), AUTHORIZATION_CODE);
    assert.equal(params.get('code_verifier'), 'v'.repeat(128));
    assert.equal(params.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);
    assert.deepEqual(result, {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      idToken,
      expiresInSeconds: 3600,
    });
  });

  it('accepts a numeric-string expires_in and keeps id_token optional', async () => {
    const { fetch } = stubFetch(tokenBody(null, '1800'));
    const result = await exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch });
    assert.equal(result.idToken, null);
    assert.equal(result.expiresInSeconds, 1800);
  });

  it('rejects a missing refresh_token (strict parse)', async () => {
    const { fetch } = stubFetch(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }));
    await assert.rejects(
      exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch }),
      (error: unknown) => {
        expectError(error, 'TOKEN_RESPONSE_INVALID');
        return true;
      },
    );
  });

  it('rejects a missing access_token', async () => {
    const { fetch } = stubFetch(JSON.stringify({ refresh_token: REFRESH_TOKEN }));
    await assert.rejects(
      exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch }),
      (error: unknown) => {
        expectError(error, 'TOKEN_RESPONSE_INVALID');
        return true;
      },
    );
  });

  for (const expires of [0, -1, 31_536_001, 'abc', 1.5]) {
    it(`rejects out-of-bounds expires_in ${JSON.stringify(expires)}`, async () => {
      const { fetch } = stubFetch(tokenBody(null, expires));
      await assert.rejects(
        exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch }),
        (error: unknown) => {
          expectError(error, 'TOKEN_RESPONSE_INVALID');
          return true;
        },
      );
    });
  }

  it('rejects malformed JSON and oversized bodies', async () => {
    const malformed = stubFetch('not-json{');
    await assert.rejects(
      exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch: malformed.fetch }),
      (error: unknown) => {
        expectError(error, 'TOKEN_RESPONSE_INVALID');
        return true;
      },
    );
    const oversized = stubFetch(`${tokenBody(null)}${' '.repeat(9000)}`);
    await assert.rejects(
      exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch: oversized.fetch }),
      (error: unknown) => {
        expectError(error, 'TOKEN_RESPONSE_INVALID');
        return true;
      },
    );
  });

  it('rejects non-2xx and network failures as TOKEN_EXCHANGE_FAILED', async () => {
    const rejected = stubFetch(tokenBody(null), 400);
    await assert.rejects(
      exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch: rejected.fetch }),
      (error: unknown) => {
        expectError(error, 'TOKEN_EXCHANGE_FAILED');
        return true;
      },
    );
    await assert.rejects(
      exchangeCodeForTokens({ code: AUTHORIZATION_CODE, codeVerifier: 'v', fetch: failingFetch }),
      (error: unknown) => {
        expectError(error, 'TOKEN_EXCHANGE_FAILED');
        return true;
      },
    );
  });

  it('rejects a malformed code before any request', async () => {
    const { fetch, requests } = stubFetch(tokenBody(null));
    await assert.rejects(exchangeCodeForTokens({ code: 'too-short', codeVerifier: 'v', fetch }), (error: unknown) => {
      expectError(error, 'CODE_INVALID');
      return true;
    });
    assert.equal(requests.length, 0);
  });
});

describe('parseIdTokenClaims / decodeIdTokenClaims', () => {
  it('extracts the ChatGPT account claims from a fresh id_token', () => {
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const claims = parseIdTokenClaims(idToken, now);
    assert.equal(claims.chatgptAccountId, 'acct-123');
    assert.equal(claims.chatgptUserId, 'user-456');
    assert.equal(claims.planType, 'chatgptplus');
    assert.equal(claims.email, 'user@example.com');
    assert.deepEqual(claims.organizations, ['org-1', 'org-2']);
    assert.equal(claims.expiresAtMs, Math.floor((now + 600_000) / 1000) * 1000);
  });

  it('rejects garbage tokens as ID_TOKEN_MALFORMED', () => {
    for (const garbage of ['garbage', 'a.b', 'a.b.c.d', '..']) {
      assert.throws(
        () => parseIdTokenClaims(garbage),
        (error: unknown) => {
          expectError(error, 'ID_TOKEN_MALFORMED');
          return true;
        },
      );
    }
  });

  it('rejects a token without the auth claims object', () => {
    const now = Date.now();
    const idToken = makeIdToken({ exp: Math.floor((now + 600_000) / 1000) }, now);
    assert.throws(
      () => parseIdTokenClaims(idToken),
      (error: unknown) => {
        expectError(error, 'ID_TOKEN_CLAIMS_MISSING');
        return true;
      },
    );
  });

  it('rejects a token expired beyond the ±120s skew window but decodes it leniently', () => {
    const now = Date.now();
    const stale = makeIdToken(chatgptClaims(now, { exp: Math.floor((now - 600_000) / 1000) }), now);
    assert.throws(
      () => parseIdTokenClaims(stale, now),
      (error: unknown) => {
        expectError(error, 'ID_TOKEN_EXPIRED');
        return true;
      },
    );
    // The import path uses the same claims without the freshness gate.
    assert.equal(decodeIdTokenClaims(stale).chatgptAccountId, 'acct-123');
  });
});

describe('parseCodexAuthJson', () => {
  it('parses the full Codex CLI auth.json shape', () => {
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const envelope = parseCodexAuthJson(
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken,
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          account_id: 'acct-123',
        },
        last_refresh: '2026-10-31T00:00:00.000Z',
      }),
    );
    assert.equal(envelope.accessToken, ACCESS_TOKEN);
    assert.equal(envelope.refreshToken, REFRESH_TOKEN);
    assert.equal(envelope.idToken, idToken);
    assert.equal(envelope.chatgptAccountId, 'acct-123');
    assert.equal(envelope.email, 'user@example.com');
    assert.equal(envelope.chatgptUserId, 'user-456');
    assert.equal(envelope.planType, 'chatgptplus');
    assert.equal(envelope.expiresAt, null);
    assert.equal(envelope.clientId, CODEX_OAUTH_CLIENT_ID);
  });

  it('rejects a missing account id, refresh token, or tokens object', () => {
    const cases = [
      JSON.stringify({ tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN } }),
      JSON.stringify({ tokens: { access_token: ACCESS_TOKEN, account_id: 'acct-123' } }),
      JSON.stringify({ tokens: 'nope' }),
      'not-json',
      JSON.stringify([1, 2]),
      '',
    ];
    for (const text of cases) {
      assert.throws(
        () => parseCodexAuthJson(text),
        (error: unknown) => {
          expectError(error, 'AUTH_JSON_INVALID');
          return true;
        },
      );
    }
  });

  it('hard-rejects an id_token whose account id contradicts tokens.account_id', () => {
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const text = JSON.stringify({
      tokens: { id_token: idToken, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, account_id: 'acct-other' },
    });
    assert.throws(
      () => parseCodexAuthJson(text),
      (error: unknown) => {
        expectError(error, 'AUTH_JSON_INVALID');
        return true;
      },
    );
  });

  it('tolerates a stale or opaque id_token (refresh token is the credential)', () => {
    const now = Date.now();
    // Structurally valid but expired: still decodes (import path has no freshness gate).
    const stale = makeIdToken(chatgptClaims(now, { exp: Math.floor((now - 3_600_000) / 1000) }), now);
    const staleEnvelope = parseCodexAuthJson(
      JSON.stringify({
        tokens: { id_token: stale, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, account_id: 'acct-123' },
      }),
    );
    assert.equal(staleEnvelope.chatgptAccountId, 'acct-123');
    assert.equal(staleEnvelope.email, 'user@example.com');
    // Opaque garbage never blocks the import either.
    const envelope = parseCodexAuthJson(
      JSON.stringify({
        tokens: {
          id_token: 'opaque',
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          account_id: 'acct-123',
        },
      }),
    );
    assert.equal(envelope.chatgptAccountId, 'acct-123');
    assert.equal(envelope.email, null);
  });
});

describe('createCodexBindingSession', () => {
  let tmpDir: string;
  let control: ControlStore;
  let store: OAuthAccountStore;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binding-'));
    configPath = path.join(tmpDir, 'config.json');
    control = new ControlStore(tmpDir);
    store = new OAuthAccountStore(configPath, control.secrets);
  });

  it('completes the code path into a store-ready account (secret stays out of metadata)', async () => {
    const session = createCodexBindingSession();
    const start = session.start();
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const { fetch, requests } = stubFetch(tokenBody(idToken, 1800));
    const bound = await session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, fetch });
    assert.equal(requests.length, 1);
    const verifier = new URLSearchParams(requests[0].body).get('code_verifier');
    assert.equal(verifier, start.codeVerifier);
    assert.equal(bound.id, 'acct-123');
    assert.equal(bound.provider, 'codex_oauth');
    assert.equal(bound.login, 'user@example.com');
    assert.equal(bound.accessToken, ACCESS_TOKEN);
    assert.equal(bound.refreshToken, REFRESH_TOKEN);
    assert.equal(bound.status, 'active');
    assert.equal(bound.source, 'oauth-binding');
    assert.ok(bound.expiresAt !== undefined && Math.abs(bound.expiresAt - (now + 1_800_000)) < 5_000);
    // Store-ready: add() seals the tokens and the metadata stays secret-free.
    store.add({ ...bound, isDefault: true });
    const stored = store.get('codex_oauth', 'acct-123');
    assert.deepEqual(stored, { ...bound, isDefault: true });
    const disk = fs.readFileSync(path.join(tmpDir, 'oauth-accounts.json'), 'utf8');
    assert.equal(disk.includes(ACCESS_TOKEN), false);
    assert.equal(disk.includes(REFRESH_TOKEN), false);
  });

  it('rejects a state mismatch in constant time and accepts the exact state', async () => {
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const session = createCodexBindingSession();
    const start = session.start();
    const mismatched = `${start.state.slice(0, 63)}${start.state.endsWith('0') ? '1' : '0'}`;
    await assert.rejects(
      session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, state: mismatched }),
      (error: unknown) => {
        expectError(error, 'SESSION_NOT_FOUND');
        return true;
      },
    );
    const { fetch } = stubFetch(tokenBody(idToken));
    const bound = await session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, state: start.state, fetch });
    assert.equal(bound.id, 'acct-123');
    // The comparison helper itself is a hash-then-compare, not ===.
    assert.equal(constantTimeEqualText(start.state, start.state), true);
    assert.equal(constantTimeEqualText(start.state, `${start.state}x`), false);
  });

  it('rejects a malformed state', async () => {
    const session = createCodexBindingSession();
    session.start();
    await assert.rejects(session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, state: 'short' }), (error: unknown) => {
      expectError(error, 'STATE_INVALID');
      return true;
    });
  });

  it('the session is single-use and cannot complete before start', async () => {
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const session = createCodexBindingSession();
    await assert.rejects(session.complete({ codeOrAuthJson: AUTHORIZATION_CODE }), (error: unknown) => {
      expectError(error, 'SESSION_NOT_FOUND');
      return true;
    });
    session.start();
    const { fetch } = stubFetch(tokenBody(idToken));
    await session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, fetch });
    const second = stubFetch(tokenBody(idToken));
    await assert.rejects(session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, fetch: second.fetch }), (error) => {
      expectError(error, 'SESSION_NOT_FOUND');
      return true;
    });
    assert.equal(second.requests.length, 0);
  });

  it('rejects an expired session', async () => {
    let now = Date.now();
    const session = createCodexBindingSession({ nowMs: () => now });
    session.start();
    now += 30 * 60_000 + 1;
    await assert.rejects(session.complete({ codeOrAuthJson: AUTHORIZATION_CODE }), (error: unknown) => {
      expectError(error, 'SESSION_EXPIRED');
      return true;
    });
  });

  it('rejects a missing id_token in the binding exchange', async () => {
    const session = createCodexBindingSession();
    session.start();
    const { fetch } = stubFetch(tokenBody(null));
    await assert.rejects(session.complete({ codeOrAuthJson: AUTHORIZATION_CODE, fetch }), (error: unknown) => {
      expectError(error, 'TOKEN_RESPONSE_INVALID');
      return true;
    });
  });

  it('accepts a pasted auth.json blob on the import path without any fetch', async () => {
    const now = Date.now();
    const idToken = makeIdToken(chatgptClaims(now), now);
    const session = createCodexBindingSession();
    session.start();
    const blob = JSON.stringify({
      tokens: { id_token: idToken, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, account_id: 'acct-123' },
    });
    const bound = await session.complete({ codeOrAuthJson: `${blob}\n`, fetch: failingFetch });
    assert.equal(bound.source, 'auth-json-import');
    assert.equal(bound.id, 'acct-123');
    assert.equal(bound.accessToken, ACCESS_TOKEN);
    assert.equal(bound.refreshToken, REFRESH_TOKEN);
    assert.equal(bound.expiresAt, undefined);
    assert.equal(bound.login, 'user@example.com');
    store.add({ ...bound, isDefault: false });
    assert.equal(store.get('codex_oauth', 'acct-123')?.refreshToken, REFRESH_TOKEN);
  });

  it('validates the code shape before the session lookup', async () => {
    assert.ok(codexOauthError('STATE_INVALID') instanceof CodexOAuthError);
    assert.equal(codexOauthError('CODE_INVALID').code, 'CODE_INVALID');
    await assert.rejects(createCodexBindingSession().complete({ codeOrAuthJson: 'short-code' }), (error: unknown) => {
      expectError(error, 'CODE_INVALID');
      return true;
    });
  });
});
