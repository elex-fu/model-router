import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CODEX_BINDING_SESSION_TTL_MS,
  CodexOAuthBindingService,
  type CodexOauthFetch,
  InMemoryBindingSessionStore,
} from '../../../../src/saas/platform/codex-oauth/binding-service.js';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  CODEX_OAUTH_USER_AGENT,
  CodexOAuthError,
} from '../../../../src/saas/platform/codex-oauth/oauth.js';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function makeIdToken(nowMs: number, ttlSeconds: number): string {
  const payload = {
    iss: 'https://auth.openai.com/',
    exp: Math.floor((nowMs + ttlSeconds * 1_000) / 1000),
    email: 'operator@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-4242',
      chatgpt_user_id: 'user-1717',
      plan_type: 'pro',
    },
  };
  return `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(payload)}.sig`;
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

interface Harness {
  readonly service: CodexOAuthBindingService;
  readonly store: InMemoryBindingSessionStore;
  readonly seen: Array<{ url: string; method: string; headers: Headers; body: string }>;
  setResponse(response: Response | Error): void;
  now(): number;
}

function harness(nowMs = 1_700_000_000_000): Harness {
  const current = nowMs;
  const store = new InMemoryBindingSessionStore(() => current);
  const seen: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  let response: Response | Error = jsonResponse({});
  const fetcher = (async (url: URL, init: RequestInit) => {
    seen.push({
      url: url.href,
      method: init.method ?? '',
      headers: new Headers(init.headers),
      body: String(init.body),
    });
    if (response instanceof Error) throw response;
    return response;
  }) as CodexOauthFetch;
  const service = new CodexOAuthBindingService({
    sessionStore: store,
    fetch: fetcher,
    nowMs: () => current,
  });
  return {
    service,
    store,
    seen,
    setResponse(next: Response | Error) {
      response = next;
    },
    now() {
      return current;
    },
  };
}

test('generateBindingSession returns the authorize URL and stores the single-use state', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  assert.equal(start.authorizeUrl.origin + start.authorizeUrl.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(start.authorizeUrl.searchParams.get('state'), start.state);
  assert.match(start.state, /^[0-9a-f]{64}$/);
  const stored = await h.store.take(start.state);
  assert.ok(stored);
  assert.equal(stored.state, start.state);
  assert.equal(stored.codeVerifier.length, 128);
  assert.equal(stored.expiresAtMs - h.now(), CODEX_BINDING_SESSION_TTL_MS);
  // Single-use: taking again yields nothing.
  assert.equal(await h.store.take(start.state), null);
});

test('completeBinding exchanges the code with PKCE and builds the envelope', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  h.setResponse(
    jsonResponse({
      access_token: 'accs-bound-token',
      refresh_token: 'rfrsh-bound-token',
      id_token: makeIdToken(h.now(), 3_600),
      token_type: 'Bearer',
      expires_in: 3_600,
    }),
  );
  const envelope = await h.service.completeBinding({ state: start.state, code: 'authz-code-0123456789abcdef' });
  assert.equal(h.seen.length, 1);
  const request = h.seen[0];
  assert.ok(request);
  assert.equal(request.url, CODEX_OAUTH_TOKEN_ENDPOINT);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.equal(request.headers.get('user-agent'), CODEX_OAUTH_USER_AGENT);
  const form = new URLSearchParams(request.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('client_id'), CODEX_OAUTH_CLIENT_ID);
  assert.equal(form.get('code'), 'authz-code-0123456789abcdef');
  assert.match(form.get('code_verifier') ?? '', /^[0-9a-f]{128}$/);
  assert.equal(form.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);

  assert.equal(envelope.accessToken, 'accs-bound-token');
  assert.equal(envelope.refreshToken, 'rfrsh-bound-token');
  assert.ok(envelope.idToken);
  assert.equal(envelope.expiresAt, new Date(h.now() + 3_600_000).toISOString());
  assert.equal(envelope.clientId, CODEX_OAUTH_CLIENT_ID);
  assert.equal(envelope.email, 'operator@example.test');
  assert.equal(envelope.chatgptAccountId, 'acct-4242');
  assert.equal(envelope.chatgptUserId, 'user-1717');
  assert.equal(envelope.planType, 'pro');
});

test('completeBinding consumes the session: replay and unknown states fail closed', async () => {
  const h = harness();
  h.setResponse(
    jsonResponse({
      access_token: 'accs-bound-token',
      refresh_token: 'rfrsh-bound-token',
      id_token: makeIdToken(h.now(), 3_600),
      expires_in: 3_600,
    }),
  );
  const start = await h.service.generateBindingSession();
  const input = { state: start.state, code: 'authz-code-0123456789abcdef' };
  await h.service.completeBinding(input);
  await assert.rejects(h.service.completeBinding(input), (error: unknown) => {
    assert.ok(error instanceof CodexOAuthError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
  await assert.rejects(
    h.service.completeBinding({ state: 'f'.repeat(64), code: 'authz-code-0123456789abcdef' }),
    (error: unknown) => {
      assert.ok(error instanceof CodexOAuthError);
      assert.equal(error.code, 'SESSION_NOT_FOUND');
      return true;
    },
  );
  // No token call was made for the replayed/unknown states.
  assert.equal(h.seen.length, 1);
});

test('an expired binding session is rejected before any token call', async () => {
  // A store that does not sweep on its own (the expiry check is the
  // service's job, so a non-sweeping store must still fail closed).
  const holder: { session: { state: string; codeVerifier: string; expiresAtMs: number } | null } = { session: null };
  let current = 1_700_000_000_000;
  const service = new CodexOAuthBindingService({
    sessionStore: {
      async put(session) {
        holder.session = session;
      },
      async take(state) {
        const session = holder.session;
        holder.session = null;
        return session !== null && session.state === state ? session : null;
      },
    },
    fetch: (async () => {
      throw new Error('must not fetch');
    }) as CodexOauthFetch,
    nowMs: () => current,
  });
  await service.generateBindingSession();
  assert.ok(holder.session !== null); // generate stored it
  // Seed an already-expired session under a known state.
  const expired = { state: 'e'.repeat(64), codeVerifier: 'v'.repeat(128), expiresAtMs: current - 1 };
  holder.session = expired;
  await assert.rejects(
    service.completeBinding({ state: expired.state, code: 'authz-code-0123456789abcdef' }),
    (error: unknown) => {
      assert.ok(error instanceof CodexOAuthError);
      assert.equal(error.code, 'SESSION_EXPIRED');
      return true;
    },
  );
  // The in-memory store's own sweep surfaces expired sessions as not-found.
  const sweeping = new InMemoryBindingSessionStore(() => current);
  await sweeping.put({ state: 'd'.repeat(64), codeVerifier: 'v'.repeat(128), expiresAtMs: current - 1 });
  assert.equal(await sweeping.take('d'.repeat(64)), null);
  current += 1;
});

test('malformed state or code input never reaches the token endpoint', async () => {
  const h = harness();
  await assert.rejects(
    h.service.completeBinding({ state: 'short', code: 'authz-code-0123456789abcdef' }),
    (error: unknown) => {
      assert.ok(error instanceof CodexOAuthError);
      assert.equal(error.code, 'STATE_INVALID');
      return true;
    },
  );
  await assert.rejects(h.service.completeBinding({ state: 'a'.repeat(32), code: 'too-short' }), (error: unknown) => {
    assert.ok(error instanceof CodexOAuthError);
    assert.equal(error.code, 'CODE_INVALID');
    return true;
  });
  assert.equal(h.seen.length, 0);
});

test('token endpoint rejections and malformed responses fail closed', async () => {
  const cases: Array<{ name: string; response: Response | Error; code: string }> = [
    {
      name: 'http 400',
      response: jsonResponse({ error: 'invalid_grant' }, { status: 400 }),
      code: 'TOKEN_EXCHANGE_FAILED',
    },
    { name: 'http 503', response: jsonResponse({}, { status: 503 }), code: 'TOKEN_EXCHANGE_FAILED' },
    { name: 'network error', response: new Error('socket hangup'), code: 'TOKEN_EXCHANGE_FAILED' },
    {
      name: 'missing refresh token',
      response: jsonResponse({ access_token: 'accs-bound-token', id_token: 'x'.repeat(40) }),
      code: 'TOKEN_RESPONSE_INVALID',
    },
    {
      name: 'missing id token',
      response: jsonResponse({ access_token: 'accs-bound-token', refresh_token: 'rfrsh-bound-token' }),
      code: 'TOKEN_RESPONSE_INVALID',
    },
    {
      name: 'non-string access token',
      response: jsonResponse({ access_token: 42, refresh_token: 'rfrsh-bound-token', id_token: 'x'.repeat(40) }),
      code: 'TOKEN_RESPONSE_INVALID',
    },
    {
      name: 'bad expires_in',
      response: jsonResponse({
        access_token: 'accs-bound-token',
        refresh_token: 'rfrsh-bound-token',
        id_token: 'x'.repeat(40),
        expires_in: 0,
      }),
      code: 'TOKEN_RESPONSE_INVALID',
    },
  ];
  for (const { name, response, code } of cases) {
    const h = harness();
    const start = await h.service.generateBindingSession();
    h.setResponse(response);
    await assert.rejects(
      h.service.completeBinding({ state: start.state, code: 'authz-code-0123456789abcdef' }),
      (error: unknown) => {
        assert.ok(error instanceof CodexOAuthError, `${name}: expected CodexOAuthError`);
        assert.equal(error.code, code, name);
        // Structured errors never leak token material.
        assert.equal(/accs-|rfrsh-/.test(error.message), false, name);
        return true;
      },
      name,
    );
  }
});

test('an expired id_token from the exchange is rejected', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  h.setResponse(
    jsonResponse({
      access_token: 'accs-bound-token',
      refresh_token: 'rfrsh-bound-token',
      id_token: makeIdToken(h.now() - 600_000, 1),
    }),
  );
  await assert.rejects(
    h.service.completeBinding({ state: start.state, code: 'authz-code-0123456789abcdef' }),
    (error: unknown) => {
      assert.ok(error instanceof CodexOAuthError);
      assert.equal(error.code, 'ID_TOKEN_EXPIRED');
      return true;
    },
  );
});

test('expires_at stays null when the endpoint omits expires_in', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  h.setResponse(
    jsonResponse({
      access_token: 'accs-bound-token',
      refresh_token: 'rfrsh-bound-token',
      id_token: makeIdToken(h.now(), 3_600),
    }),
  );
  const envelope = await h.service.completeBinding({ state: start.state, code: 'authz-code-0123456789abcdef' });
  assert.equal(envelope.expiresAt, null);
});
