import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  type ClaudeCredentialSink,
  ClaudeOAuthBindingService,
  type ClaudeOauthFetch,
  InMemoryBindingSessionStore,
} from '../../../../src/saas/platform/claude-oauth/binding-service.js';
import {
  type ClaudeOauthHttpOptions,
  createClaudeOauthHttpHandler,
} from '../../../../src/saas/platform/claude-oauth/http.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

function tokenResponseBody(): string {
  return JSON.stringify({
    access_token: 'accs-http-token',
    refresh_token: 'rfrsh-http-token',
    expires_in: 3_600,
    organization: { uuid: 'org-http' },
    account: { uuid: 'acct-http', email_address: 'operator@example.test' },
  });
}

interface SinkCall {
  readonly source: 'oauth-binding' | 'credentials-json-import';
  readonly actorUserId: string;
  readonly hasTokenMaterial: boolean;
  readonly organizationUuid: string | null;
}

interface TestResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly handled: boolean;
}

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ) => Promise<TestResponse>;
  readonly sinkCalls: SinkCall[];
  readonly service: ClaudeOAuthBindingService;
}

function harness(
  fetchResponse: Response | Error = new Response(tokenResponseBody(), {
    headers: { 'content-type': 'application/json' },
  }),
): Harness {
  const sinkCalls: SinkCall[] = [];
  const sink: ClaudeCredentialSink = {
    async accept(input) {
      sinkCalls.push({
        source: input.source,
        actorUserId: input.actorUserId,
        hasTokenMaterial: input.envelope.accessToken.length > 0 && input.envelope.refreshToken.length > 0,
        organizationUuid: input.envelope.organizationUuid,
      });
      return { accountRef: 'platform-account-1' };
    },
  };
  const fetcher = (async () => {
    if (fetchResponse instanceof Error) throw fetchResponse;
    return fetchResponse;
  }) as ClaudeOauthFetch;
  const service = new ClaudeOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(),
    fetch: fetcher,
  });
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: ClaudeOauthHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    sink,
    publicOrigin: ORIGIN,
  };
  const handler = createClaudeOauthHttpHandler(options);

  return {
    sinkCalls,
    service,
    async request(
      path: string,
      body: unknown,
      overrides: {
        method?: string;
        actor?: PlatformAdminActor | undefined;
        headers?: Record<string, string>;
      } = {},
    ): Promise<TestResponse> {
      const headers: Record<string, string> = {
        host: 'platform-admin.test',
        origin: ORIGIN,
        cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...overrides.headers,
      };
      currentActor = 'actor' in overrides ? overrides.actor : ACTOR;
      const bodyText = JSON.stringify(body ?? {});
      const req = {
        url: path,
        method: overrides.method ?? 'POST',
        headers,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(bodyText);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseText = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number) {
          status = code;
          return res;
        },
        end(value?: unknown) {
          responseText = value === undefined ? '' : String(value);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      return {
        status,
        handled,
        body: responseText === '' ? {} : (JSON.parse(responseText) as Record<string, unknown>),
      };
    },
  };
}

test('start returns the authorize URL and state for an authenticated operator', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/claude-oauth/start', {});
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.ok(typeof data.state === 'string' && data.state.length === 64);
  const authorizeUrl = new URL(String(data.authorizeUrl));
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://claude.com/cai/oauth/authorize');
  assert.equal(authorizeUrl.searchParams.get('state'), data.state);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(h.sinkCalls.length, 0);
});

test('unrelated paths fall through to the next handler', async () => {
  const h = harness();
  for (const path of [
    '/admin/api/v1/codex-oauth/start',
    '/healthz',
    '/admin/api/v1/claude-oauth/unknown',
    '/admin/api/v1/claude-oauth/',
  ]) {
    const response = await h.request(path, {});
    assert.equal(response.handled, false, path);
  }
});

test('complete seals the envelope through the sink and returns only the summary', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const response = await h.request('/admin/api/v1/claude-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.accountRef, 'platform-account-1');
  assert.equal(data.organizationUuid, 'org-http');
  assert.equal('accessToken' in data, false);
  assert.equal('refreshToken' in data, false);
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(h.sinkCalls[0].source, 'oauth-binding');
  assert.equal(h.sinkCalls[0].actorUserId, 'platform-user-from-session');
  assert.equal(h.sinkCalls[0].hasTokenMaterial, true);
});

test('import accepts a pasted credentials.json and reports only the summary', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/claude-oauth/import', {
    credentialsJson: JSON.stringify({
      claudeAiOauth: {
        accessToken: 'accs-import',
        refreshToken: 'rfrsh-import',
        organizationUuid: 'org-import',
      },
    }),
  });
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.organizationUuid, 'org-import');
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(h.sinkCalls[0].source, 'credentials-json-import');
});

test('auth, origin, CSRF and body-shape failures fail closed', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();

  // Wrong method.
  const method = await h.request('/admin/api/v1/claude-oauth/start', {}, { method: 'GET' });
  assert.equal(method.status, 405);
  // Cross-origin.
  const origin = await h.request('/admin/api/v1/claude-oauth/start', {}, { headers: { origin: 'https://evil.test' } });
  assert.equal(origin.status, 403);
  assert.equal((origin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');
  // Missing CSRF.
  const csrf = await h.request('/admin/api/v1/claude-oauth/start', {}, { headers: { 'x-csrf-token': 'wrong' } });
  assert.equal(csrf.status, 403);
  assert.equal((csrf.body.error as Record<string, unknown>).code, 'CSRF_REJECTED');
  // Unauthenticated.
  const unauthenticated = await h.request('/admin/api/v1/claude-oauth/start', {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);
  // Wrong role.
  const viewer: PlatformAdminActor = { ...ACTOR, roles: ['support-readonly'] };
  const forbidden = await h.request('/admin/api/v1/claude-oauth/start', {}, { actor: viewer });
  assert.equal(forbidden.status, 403);
  // Unsupported fields / bad content type.
  const extraField = await h.request('/admin/api/v1/claude-oauth/start', { unexpected: 1 });
  assert.equal(extraField.status, 400);
  const contentType = await h.request(
    '/admin/api/v1/claude-oauth/start',
    {},
    { headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(contentType.status, 415);
  // Unknown state.
  const unknown = await h.request('/admin/api/v1/claude-oauth/complete', {
    state: 'f'.repeat(64),
    code: 'c'.repeat(40),
  });
  assert.equal(unknown.status, 404);
  assert.equal((unknown.body.error as Record<string, unknown>).code, 'BINDING_SESSION_NOT_FOUND');
  // The live session still completes after the noise above.
  const complete = await h.request('/admin/api/v1/claude-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(complete.status, 200);
});

test('upstream token failures surface a generic 502 without token material', async () => {
  const h = harness(new Response('{"error":"invalid_grant"}', { status: 400 }));
  const start = await h.service.generateBindingSession();
  const response = await h.request('/admin/api/v1/claude-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(response.status, 502);
  assert.equal((response.body.error as Record<string, unknown>).code, 'CLAUDE_OAUTH_UPSTREAM_FAILED');
  assert.equal(h.sinkCalls.length, 0);
});

test('a malformed import body is a 502-class failure, never a leak', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/claude-oauth/import', {
    credentialsJson: JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }),
  });
  assert.equal(response.status, 502);
  assert.equal((response.body.error as Record<string, unknown>).code, 'CLAUDE_OAUTH_UPSTREAM_FAILED');
  assert.equal(h.sinkCalls.length, 0);
});
