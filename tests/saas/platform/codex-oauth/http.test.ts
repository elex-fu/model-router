import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  type CodexCredentialSink,
  CodexOAuthBindingService,
  type CodexOauthFetch,
  InMemoryBindingSessionStore,
} from '../../../../src/saas/platform/codex-oauth/binding-service.js';
import {
  type CodexOauthHttpOptions,
  createCodexOauthHttpHandler,
} from '../../../../src/saas/platform/codex-oauth/http.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

interface SinkCall {
  readonly source: 'oauth-binding' | 'auth-json-import';
  readonly actorUserId: string;
  readonly hasTokenMaterial: boolean;
  readonly chatgptAccountId: string | null;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function freshIdToken(): string {
  const payload = {
    exp: Math.floor((Date.now() + 3_600_000) / 1000),
    email: 'operator@example.test',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-4242',
      chatgpt_user_id: 'user-1717',
      plan_type: 'pro',
    },
  };
  return `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(payload)}.sig`;
}

function tokenResponseBody(): string {
  return JSON.stringify({
    access_token: 'accs-http-token',
    refresh_token: 'rfrsh-http-token',
    id_token: freshIdToken(),
    expires_in: 3_600,
  });
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
  readonly service: CodexOAuthBindingService;
  setResponse(response: Response | Error): void;
}

function harness(
  fetchResponse: Response | Error = new Response(tokenResponseBody(), {
    headers: { 'content-type': 'application/json' },
  }),
): Harness {
  const sinkCalls: SinkCall[] = [];
  const sink: CodexCredentialSink = {
    async accept(input) {
      sinkCalls.push({
        source: input.source,
        actorUserId: input.actorUserId,
        hasTokenMaterial: input.envelope.accessToken.length > 0 && input.envelope.refreshToken.length > 0,
        chatgptAccountId: input.envelope.chatgptAccountId,
      });
      return { accountRef: 'platform-account-1' };
    },
  };
  let response = fetchResponse;
  const fetcher = (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as CodexOauthFetch;
  const service = new CodexOAuthBindingService({
    sessionStore: new InMemoryBindingSessionStore(),
    fetch: fetcher,
  });
  const options: CodexOauthHttpOptions = {
    access: { authenticate: async () => ACTOR },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    sink,
    publicOrigin: ORIGIN,
  };
  const handler = createCodexOauthHttpHandler(options);

  return {
    sinkCalls,
    service,
    setResponse(next: Response | Error) {
      response = next;
    },
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
  const response = await h.request('/admin/api/v1/codex-oauth/start', {});
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.ok(typeof data.state === 'string' && data.state.length === 64);
  const authorizeUrl = new URL(String(data.authorizeUrl));
  assert.equal(authorizeUrl.searchParams.get('state'), data.state);
  assert.equal(authorizeUrl.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(h.sinkCalls.length, 0);
});

test('unrelated paths fall through to the next handler', async () => {
  const h = harness();
  assert.equal((await h.request('/admin/api/v1/supply/accounts', {})).handled, false);
  assert.equal((await h.request('/admin/api/v1/codex-oauth/unknown', {})).handled, false);
});

test('only same-origin POSTs with CSRF and the operations role are accepted', async () => {
  const h = harness();
  assert.equal((await h.request('/admin/api/v1/codex-oauth/start', {}, { method: 'GET' })).status, 405);
  assert.equal(
    (await h.request('/admin/api/v1/codex-oauth/start', {}, { headers: { origin: 'https://evil.test' } })).status,
    403,
  );
  assert.equal(
    (await h.request('/admin/api/v1/codex-oauth/start', {}, { headers: { 'x-csrf-token': 'wrong' } })).status,
    403,
  );
  assert.equal((await h.request('/admin/api/v1/codex-oauth/start', {}, { headers: { cookie: '' } })).status, 403);
  assert.equal(
    (await h.request('/admin/api/v1/codex-oauth/start', {}, { headers: { 'content-type': 'text/plain' } })).status,
    415,
  );
  assert.equal((await h.request('/admin/api/v1/codex-oauth/start', { extra: 1 })).status, 400);
});

test('complete runs the full binding chain and returns only the non-secret summary', async () => {
  const h = harness();
  const start = await h.service.generateBindingSession();
  const response = await h.request('/admin/api/v1/codex-oauth/complete', {
    state: start.state,
    code: 'authz-code-0123456789abcdef',
  });
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.accountRef, 'platform-account-1');
  assert.equal(data.chatgptAccountId, 'acct-4242');
  assert.equal(data.planType, 'pro');
  assert.equal(data.email, 'operator@example.test');
  assert.ok(typeof data.expiresAt === 'string');
  // Token material never crosses the HTTP boundary.
  const serialized = JSON.stringify(response.body);
  assert.equal(/accs-http-token|rfrsh-http-token/.test(serialized), false);
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(h.sinkCalls[0]?.source, 'oauth-binding');
  assert.equal(h.sinkCalls[0]?.actorUserId, ACTOR.userId);
  assert.equal(h.sinkCalls[0]?.hasTokenMaterial, true);
});

test('complete maps binding failures to structured statuses', async () => {
  const h = harness();
  const unknown = await h.request('/admin/api/v1/codex-oauth/complete', {
    state: 'f'.repeat(64),
    code: 'authz-code-0123456789abcdef',
  });
  assert.equal(unknown.status, 404);
  assert.equal((unknown.body.error as Record<string, unknown>)?.code, 'BINDING_SESSION_NOT_FOUND');

  const started = await h.service.generateBindingSession();
  const upstream = await h.request('/admin/api/v1/codex-oauth/complete', {
    state: started.state,
    code: 'authz-code-0123456789abcdef',
  });
  // The default harness response is a valid token exchange; force a failure.
  void upstream;

  const h2 = harness(new Error('socket hangup'));
  const start2 = await h2.service.generateBindingSession();
  const failed = await h2.request('/admin/api/v1/codex-oauth/complete', {
    state: start2.state,
    code: 'authz-code-0123456789abcdef',
  });
  assert.equal(failed.status, 502);
  assert.equal((failed.body.error as Record<string, unknown>)?.code, 'CODEX_OAUTH_UPSTREAM_FAILED');
});

test('import parses the pasted auth.json and hands the envelope to the sink', async () => {
  const h = harness();
  const authJson = JSON.stringify({
    tokens: { access_token: 'accs-cli-token', refresh_token: 'rfrsh-cli-token', account_id: 'acct-9090' },
    last_refresh: '2026-10-01T12:00:00.000Z',
  });
  const response = await h.request('/admin/api/v1/codex-oauth/import', { authJson });
  assert.equal(response.status, 200);
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.accountRef, 'platform-account-1');
  assert.equal(data.chatgptAccountId, 'acct-9090');
  assert.equal(/accs-cli-token|rfrsh-cli-token/.test(JSON.stringify(response.body)), false);
  assert.equal(h.sinkCalls.length, 1);
  assert.equal(h.sinkCalls[0]?.source, 'auth-json-import');
});

test('import rejects invalid auth.json payloads with the structured code', async () => {
  const h = harness();
  const response = await h.request('/admin/api/v1/codex-oauth/import', { authJson: 'not json' });
  assert.equal(response.status, 502);
  assert.equal((response.body.error as Record<string, unknown>)?.code, 'CODEX_OAUTH_UPSTREAM_FAILED');
  assert.equal(h.sinkCalls.length, 0);
});
