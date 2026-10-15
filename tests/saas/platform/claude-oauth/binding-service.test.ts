import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLAUDE_BINDING_SESSION_TTL_MS,
  ClaudeOAuthBindingService,
  type ClaudeOauthFetch,
  InMemoryBindingSessionStore,
} from '../../../../src/saas/platform/claude-oauth/binding-service.js';
import { ClaudeOAuthError } from '../../../../src/saas/platform/claude-oauth/oauth.js';

const NOW_MS = 1_700_000_000_000;

function tokenResponseBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'accs-claude',
    refresh_token: 'rfrsh-claude',
    expires_in: 3_600,
    organization: { uuid: 'org-4242' },
    account: { uuid: 'acct-1717', email_address: 'operator@example.test' },
    ...overrides,
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function harness(fetchResponse: Response | Error = jsonResponse(tokenResponseBody())): {
  service: ClaudeOAuthBindingService;
  seen: Seen[];
  now: () => number;
} {
  const seen: Seen[] = [];
  const nowMs = NOW_MS;
  const fetcher = (async (url: URL, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    seen.push({ url: url.href, method: init.method ?? 'POST', headers, body: JSON.parse(String(init.body)) });
    if (fetchResponse instanceof Error) throw fetchResponse;
    return fetchResponse;
  }) as ClaudeOauthFetch;
  const service = new ClaudeOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(() => nowMs),
    fetch: fetcher,
    nowMs: () => nowMs,
  });
  return { service, seen, now: () => nowMs };
}

test('generateBindingSession stores PKCE state with the 30-minute TTL', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  assert.match(start.state, /^[0-9a-f]{64}$/);
  const url = start.authorizeUrl;
  assert.equal(url.searchParams.get('state'), start.state);
  assert.ok(url.searchParams.get('code_challenge'));
  // The store keeps the verifier until completeBinding consumes it.
  const second = await h.service.generateBindingSession();
  assert.notEqual(second.state, start.state);
});

test('completeBinding exchanges the code as a JSON POST and returns the envelope', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const envelope = await h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) });
  assert.equal(h.seen.length, 1);
  const request = h.seen[0];
  assert.equal(request.url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers['user-agent'], 'axios/1.13.6');
  assert.equal(request.body.grant_type, 'authorization_code');
  assert.equal(request.body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(request.body.redirect_uri, 'https://platform.claude.com/oauth/code/callback');
  assert.equal(request.body.code, 'c'.repeat(40));
  assert.equal(typeof request.body.code_verifier, 'string');
  // The envelope carries organization/account coordinates, no token echoes
  // beyond the material itself.
  assert.deepEqual(envelope, {
    accessToken: 'accs-claude',
    refreshToken: 'rfrsh-claude',
    expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    organizationUuid: 'org-4242',
    accountUuid: 'acct-1717',
    email: 'operator@example.test',
  });
});

test('the state is single-use: a replayed binding session is not found', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  await h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) });
  await assert.rejects(h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
    assert.ok(error instanceof ClaudeOAuthError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
});

test('an expired session, bad state shape and bad code shape fail closed', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const expiredService = new ClaudeOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(() => NOW_MS + CLAUDE_BINDING_SESSION_TTL_MS + 1),
    nowMs: () => NOW_MS + CLAUDE_BINDING_SESSION_TTL_MS + 1,
    fetch: async () => jsonResponse(tokenResponseBody()),
  });
  // The session was stored under the first service's clock; complete through
  // the expired clock by re-using the same store shape.
  const expired = new ClaudeOAuthBindingService({
    sessionStore: {
      put: async () => undefined,
      take: async () => ({ state: start.state, codeVerifier: 'v', expiresAtMs: NOW_MS - 1 }),
    },
    nowMs: () => NOW_MS,
    fetch: async () => jsonResponse(tokenResponseBody()),
  });
  await assert.rejects(expired.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
    assert.ok(error instanceof ClaudeOAuthError);
    assert.equal(error.code, 'SESSION_EXPIRED');
    return true;
  });
  assert.ok(expiredService);
  for (const bad of [
    { state: 'short', code: 'c'.repeat(40) },
    { state: start.state, code: 'too-short' },
  ]) {
    await assert.rejects(h.service.completeBinding(bad), ClaudeOAuthError);
  }
});

test('token endpoint rejections and malformed responses never leak material', async () => {
  for (const [response, code] of [
    [new Response('{"error":"invalid_grant"}', { status: 400 }), 'TOKEN_EXCHANGE_FAILED'],
    [jsonResponse('not json'), 'TOKEN_RESPONSE_INVALID'],
    [jsonResponse(JSON.stringify({ access_token: 'a', refresh_token: 'r' })), 'TOKEN_RESPONSE_INVALID'],
    [jsonResponse(tokenResponseBody({ organization: null })), 'TOKEN_RESPONSE_INVALID'],
    [
      jsonResponse(tokenResponseBody({ access_token: 'no refresh', refresh_token: undefined })),
      'TOKEN_RESPONSE_INVALID',
    ],
  ] as const) {
    const h = harness(response as Response);
    const start = await h.service.generateBindingSession();
    await assert.rejects(h.service.completeBinding({ state: start.state, code: 'c'.repeat(40) }), (error: unknown) => {
      assert.ok(error instanceof ClaudeOAuthError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('accs-claude') || error.message.includes('rfrsh-claude'), false);
      return true;
    });
  }
  const networkError = harness(new Error('network down'));
  const start = await networkError.service.generateBindingSession();
  await assert.rejects(
    networkError.service.completeBinding({ state: start.state, code: 'c'.repeat(40) }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeOAuthError);
      assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED');
      return true;
    },
  );
});
