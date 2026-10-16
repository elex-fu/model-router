import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  type GeminiCredentialSink,
  GeminiOAuthBindingService,
  type GeminiOauthFetch,
  InMemoryBindingSessionStore,
} from '../../../../src/saas/platform/gemini-oauth/binding-service.js';
import {
  createGeminiOauthHttpHandler,
  type GeminiOauthHttpOptions,
} from '../../../../src/saas/platform/gemini-oauth/http.js';

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
  });
}

function loadCodeAssistBody(): string {
  return JSON.stringify({
    cloudaicompanionProject: 'project-http',
    allowedTiers: [{ id: 'standard-tier', isDefault: true }],
  });
}

interface SinkCall {
  readonly source: 'oauth-binding' | 'credentials-json-import';
  readonly actorUserId: string;
  readonly hasTokenMaterial: boolean;
  readonly projectId: string | null;
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
  readonly service: GeminiOAuthBindingService;
}

function harness(
  fetchResponses: Array<Response | Error> = [
    new Response(tokenResponseBody(), { headers: { 'content-type': 'application/json' } }),
    new Response(loadCodeAssistBody(), { headers: { 'content-type': 'application/json' } }),
  ],
): Harness {
  const sinkCalls: SinkCall[] = [];
  const sink: GeminiCredentialSink = {
    async accept(input) {
      sinkCalls.push({
        source: input.source,
        actorUserId: input.actorUserId,
        hasTokenMaterial: input.envelope.accessToken.length > 0 && input.envelope.refreshToken.length > 0,
        projectId: input.envelope.projectId,
      });
      return { accountRef: 'platform-account-1' };
    },
  };
  const queue = [...fetchResponses];
  const fetcher = (async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected extra fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as GeminiOauthFetch;
  const service = new GeminiOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(),
    fetch: fetcher,
    clientSecret: 'test-installed-app-secret',
  });
  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: GeminiOauthHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    sink,
    publicOrigin: ORIGIN,
  };
  const handler = createGeminiOauthHttpHandler(options);

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
  const response = await h.request('/admin/api/v1/gemini-oauth/start', {});
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.ok(typeof data.state === 'string' && data.state.length === 64);
  const authorizeUrl = new URL(String(data.authorizeUrl));
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(authorizeUrl.searchParams.get('state'), data.state);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizeUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizeUrl.searchParams.get('prompt'), 'consent');
  assert.equal(h.sinkCalls.length, 0);
});

test('unrelated paths fall through to the next handler', async () => {
  const h = harness();
  for (const path of [
    '/admin/api/v1/claude-oauth/start',
    '/healthz',
    '/admin/api/v1/gemini-oauth/unknown',
    '/admin/api/v1/gemini-oauth/',
  ]) {
    const response = await h.request(path, {});
    assert.equal(response.handled, false, path);
  }
});

test('complete seals the envelope through the sink and returns only the summary', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const response = await h.request('/admin/api/v1/gemini-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.accountRef, 'platform-account-1');
  assert.equal(data.projectId, 'project-http');
  assert.equal(data.tierId, 'standard-tier');
  assert.equal('accessToken' in data, false);
  assert.equal('refreshToken' in data, false);
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(h.sinkCalls[0]?.source, 'oauth-binding');
  assert.equal(h.sinkCalls[0]?.actorUserId, 'platform-user-from-session');
  assert.equal(h.sinkCalls[0]?.hasTokenMaterial, true);
  assert.equal(h.sinkCalls[0]?.projectId, 'project-http');
});

test('import accepts a pasted oauth_creds.json and reports only the summary', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/gemini-oauth/import', {
    credentialsJson: JSON.stringify({
      access_token: 'accs-import',
      refresh_token: 'rfrsh-import',
      project_id: 'project-import',
      tier_id: 'LEGACY',
    }),
  });
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.projectId, 'project-import');
  // The legacy tier spelling is normalized onto the canonical quota id.
  assert.equal(data.tierId, 'gcp_standard');
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(h.sinkCalls[0]?.source, 'credentials-json-import');
});

test('auth, origin, CSRF and body-shape failures fail closed', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();

  // Wrong method.
  const method = await h.request('/admin/api/v1/gemini-oauth/start', {}, { method: 'GET' });
  assert.equal(method.status, 405);
  // Cross-origin.
  const origin = await h.request('/admin/api/v1/gemini-oauth/start', {}, { headers: { origin: 'https://evil.test' } });
  assert.equal(origin.status, 403);
  assert.equal((origin.body.error as Record<string, unknown>).code, 'ORIGIN_REJECTED');
  // Missing CSRF.
  const csrf = await h.request('/admin/api/v1/gemini-oauth/start', {}, { headers: { 'x-csrf-token': 'wrong' } });
  assert.equal(csrf.status, 403);
  assert.equal((csrf.body.error as Record<string, unknown>).code, 'CSRF_REJECTED');
  // Unauthenticated.
  const unauthenticated = await h.request('/admin/api/v1/gemini-oauth/start', {}, { actor: undefined });
  assert.equal(unauthenticated.status, 401);
  // Wrong role.
  const viewer: PlatformAdminActor = { ...ACTOR, roles: ['support-readonly'] };
  const forbidden = await h.request('/admin/api/v1/gemini-oauth/start', {}, { actor: viewer });
  assert.equal(forbidden.status, 403);
  // Unsupported fields / bad content type.
  const extraField = await h.request('/admin/api/v1/gemini-oauth/start', { unexpected: 1 });
  assert.equal(extraField.status, 400);
  const contentType = await h.request(
    '/admin/api/v1/gemini-oauth/start',
    {},
    { headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(contentType.status, 415);
  // Unknown state maps to 404, expired to 410, bad shapes to 400.
  const unknown = await h.request('/admin/api/v1/gemini-oauth/complete', {
    state: 'f'.repeat(64),
    code: 'c'.repeat(40),
  });
  assert.equal(unknown.status, 404);
  assert.equal((unknown.body.error as Record<string, unknown>).code, 'BINDING_SESSION_NOT_FOUND');
  const badShape = await h.request('/admin/api/v1/gemini-oauth/complete', { state: 'short', code: 'c'.repeat(40) });
  assert.equal(badShape.status, 400);
  assert.equal((badShape.body.error as Record<string, unknown>).code, 'INVALID_BINDING_INPUT');
  const expiredService = new GeminiOAuthBindingService({
    sessionStore: {
      put: async () => undefined,
      take: async () => ({ state: start.state, codeVerifier: 'v', expiresAtMs: Date.now() - 1 }),
    },
    clientSecret: 'test-installed-app-secret',
    fetch: async () => new Response(tokenResponseBody(), { headers: { 'content-type': 'application/json' } }),
  });
  const options: GeminiOauthHttpOptions = {
    access: { authenticate: async () => ACTOR },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service: expiredService,
    sink: { accept: async () => ({ accountRef: 'x' }) },
    publicOrigin: ORIGIN,
  };
  const expiredHandler = createGeminiOauthHttpHandler(options);
  let expiredStatus = 0;
  let expiredBody = '';
  const expiredRes = {
    destroyed: false,
    get writableEnded() {
      return false;
    },
    writeHead(code: number) {
      expiredStatus = code;
      return expiredRes;
    },
    end(value?: unknown) {
      expiredBody = String(value ?? '');
      return expiredRes;
    },
  } as unknown as ServerResponse;
  const expiredReq = {
    url: '/admin/api/v1/gemini-oauth/complete',
    method: 'POST',
    headers: {
      host: 'platform-admin.test',
      origin: ORIGIN,
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
    },
    destroyed: false,
    socket: { remoteAddress: '203.0.113.10' },
    resume() {
      return expiredReq;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ state: start.state, code: 'c'.repeat(40) }));
    },
  } as unknown as IncomingMessage;
  await expiredHandler(expiredReq, expiredRes);
  assert.equal(expiredStatus, 410);
  assert.equal((JSON.parse(expiredBody) as { error: { code: string } }).error.code, 'BINDING_SESSION_EXPIRED');
  // The live session still completes after the noise above.
  const complete = await h.request('/admin/api/v1/gemini-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(complete.status, 200);
});

test('upstream token failures surface a generic 502 without token material', async () => {
  const h = harness([new Response('{"error":"invalid_grant"}', { status: 400 })]);
  const start = await h.service.generateBindingSession();
  const response = await h.request('/admin/api/v1/gemini-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(response.status, 502);
  assert.equal((response.body.error as Record<string, unknown>).code, 'GEMINI_OAUTH_UPSTREAM_FAILED');
  assert.equal(h.sinkCalls.length, 0);
});

test('a loadCodeAssist failure surfaces the same generic 502', async () => {
  const h = harness([
    new Response(tokenResponseBody(), { headers: { 'content-type': 'application/json' } }),
    new Response('forbidden', { status: 403 }),
  ]);
  const start = await h.service.generateBindingSession();
  const response = await h.request('/admin/api/v1/gemini-oauth/complete', {
    state: start.state,
    code: 'c'.repeat(40),
  });
  assert.equal(response.status, 502);
  assert.equal((response.body.error as Record<string, unknown>).code, 'GEMINI_OAUTH_UPSTREAM_FAILED');
  assert.equal(h.sinkCalls.length, 0);
});

test('a missing installed-app client secret is a 503 unavailable, never a leak', async () => {
  const service = new GeminiOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(),
    clientSecret: null,
    fetch: async () => new Response(tokenResponseBody(), { headers: { 'content-type': 'application/json' } }),
  });
  const sinkCalls: SinkCall[] = [];
  const options: GeminiOauthHttpOptions = {
    access: { authenticate: async () => ACTOR },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    sink: {
      async accept(input) {
        sinkCalls.push({
          source: input.source,
          actorUserId: input.actorUserId,
          hasTokenMaterial: false,
          projectId: input.envelope.projectId,
        });
        return { accountRef: 'x' };
      },
    },
    publicOrigin: ORIGIN,
  };
  const handler = createGeminiOauthHttpHandler(options);
  const start = await service.generateBindingSession();
  let status = 0;
  let bodyText = '';
  const res = {
    destroyed: false,
    get writableEnded() {
      return false;
    },
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(value?: unknown) {
      bodyText = String(value ?? '');
      return res;
    },
  } as unknown as ServerResponse;
  const req = {
    url: '/admin/api/v1/gemini-oauth/complete',
    method: 'POST',
    headers: {
      host: 'platform-admin.test',
      origin: ORIGIN,
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
    },
    destroyed: false,
    socket: { remoteAddress: '203.0.113.10' },
    resume() {
      return req;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ state: start.state, code: 'c'.repeat(40) }));
    },
  } as unknown as IncomingMessage;
  await handler(req, res);
  assert.equal(status, 503);
  assert.equal((JSON.parse(bodyText) as { error: { code: string } }).error.code, 'GEMINI_OAUTH_UNAVAILABLE');
  assert.equal(sinkCalls.length, 0);
});

test('a malformed import body is a 400-class failure, never a leak', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/gemini-oauth/import', {
    credentialsJson: JSON.stringify({ access_token: 'a', project_id: 'p' }),
  });
  assert.equal(response.status, 400);
  assert.equal((response.body.error as Record<string, unknown>).code, 'INVALID_BINDING_INPUT');
  assert.equal(h.sinkCalls.length, 0);
});
