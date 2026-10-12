import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../../src/saas/db/types.js';
import {
  CUSTOMER_KEY_MUTATION_ISSUE_SQL,
  type CustomerKeyMutationSessionHandle,
} from '../../../src/saas/identity/customer-key-mutation-session.js';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';
import { assertCustomerKeyMutationSessionBound, SaasIdentityService } from '../../../src/saas/identity/service.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import { createSaasKeyHandler, type SaasKeyHttpOptions } from '../../../src/saas/keys/http.js';
import type { ApiKeyMetadata, CreateApiKeyInput, CreatedApiKey } from '../../../src/saas/keys/types.js';
import { SaasApiError, saasClient } from '../../../web/src/api/saas-client.js';

const ORIGIN = 'https://console.example.test';
const HOST = 'console.example.test';
const SESSION_TOKEN = 'session-token-private';
const CSRF_TOKEN = 'csrf-token-for-writes';

interface Project {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  role: 'owner' | 'viewer';
  createdAt: string;
  updatedAt: string;
}

interface ServiceCalls {
  getSession: string[];
  verifyCsrfToken: Array<[string, string]>;
  listProjects: Array<[string, string]>;
  createProject: Array<[string, string, { name: string; slug?: string }]>;
}

function makeService(options: { denyTenant?: string } = {}) {
  const calls: ServiceCalls = {
    getSession: [],
    verifyCsrfToken: [],
    listProjects: [],
    createProject: [],
  };
  const projects: Project[] = [
    {
      id: 'project-default',
      tenantId: 'tenant-a',
      name: 'Default',
      slug: 'default',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  const service = {
    calls,
    async getSession(token: string) {
      calls.getSession.push(token);
      return token === SESSION_TOKEN ? { userId: 'user-1' } : undefined;
    },
    async verifyCsrfToken(token: string, csrfToken: string) {
      calls.verifyCsrfToken.push([token, csrfToken]);
      return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
    },
    async listProjects(userId: string, tenantId: string) {
      calls.listProjects.push([userId, tenantId]);
      if (tenantId === options.denyTenant) throw Object.assign(new Error('tenant is not visible'), { status: 403 });
      return projects.filter((project) => project.tenantId === tenantId);
    },
    async createProject(userId: string, tenantId: string, input: { name: string; slug?: string }) {
      calls.createProject.push([userId, tenantId, input]);
      return {
        id: 'project-created',
        tenantId,
        name: input.name,
        slug: input.slug ?? 'created-project',
        role: 'owner' as const,
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        internalSecret: 'must-not-leak',
      };
    },
  };
  return { service, calls };
}

function makeRequest(method: string, url: string, headers: IncomingHttpHeaders = {}, body?: string): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress: '198.51.100.10' },
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
  return request as unknown as IncomingMessage;
}

interface ResponseRecorder {
  status: number;
  headers: OutgoingHttpHeaders;
  body: string;
  destroyed: boolean;
  writableEnded: boolean;
}

function makeResponse(): { response: ServerResponse; recorder: ResponseRecorder } {
  const recorder: ResponseRecorder = {
    status: 0,
    headers: {},
    body: '',
    destroyed: false,
    writableEnded: false,
  };
  const response = {
    get destroyed() {
      return recorder.destroyed;
    },
    get writableEnded() {
      return recorder.writableEnded;
    },
    writeHead(status: number, headers?: OutgoingHttpHeaders) {
      recorder.status = status;
      recorder.headers = headers ?? {};
      return response;
    },
    end(chunk?: string | Uint8Array) {
      recorder.body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8');
      recorder.writableEnded = true;
      return response;
    },
  };
  return { response: response as unknown as ServerResponse, recorder };
}

async function invoke(
  handler: ReturnType<typeof createSaasIdentityHandler>,
  request: IncomingMessage,
): Promise<{ handled: boolean; recorder: ResponseRecorder; data: Record<string, unknown> }> {
  const { response, recorder } = makeResponse();
  const handled = await handler(request, response);
  return { handled, recorder, data: JSON.parse(recorder.body) as Record<string, unknown> };
}

const sessionHeaders: IncomingHttpHeaders = {
  cookie: `mr_saas_session=${SESSION_TOKEN}`,
};

const writeHeaders: IncomingHttpHeaders = {
  cookie: `mr_saas_session=${SESSION_TOKEN}; mr_saas_csrf=${CSRF_TOKEN}`,
  origin: ORIGIN,
  host: HOST,
  'content-type': 'application/json',
  'x-csrf-token': CSRF_TOKEN,
};

test('direct handler mocks cover authenticated GET and CSRF-protected POST project routes', async () => {
  const { service, calls } = makeService();
  const handler = createSaasIdentityHandler({
    service: service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });

  const listed = await invoke(handler, makeRequest('GET', '/console/api/v1/tenants/tenant-a/projects', sessionHeaders));
  assert.equal(listed.handled, true);
  assert.equal(listed.recorder.status, 200);
  assert.deepEqual(listed.data.data, [
    {
      id: 'project-default',
      tenantId: 'tenant-a',
      name: 'Default',
      slug: 'default',
      role: 'owner',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  const created = await invoke(
    handler,
    makeRequest(
      'POST',
      '/console/api/v1/tenants/tenant-a/projects',
      writeHeaders,
      JSON.stringify({ name: 'New Project', slug: 'new-project' }),
    ),
  );
  assert.equal(created.handled, true);
  assert.equal(created.recorder.status, 201);
  assert.deepEqual(created.data.data, {
    id: 'project-created',
    tenantId: 'tenant-a',
    name: 'New Project',
    slug: 'new-project',
    role: 'owner',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(calls.listProjects, [['user-1', 'tenant-a']]);
  assert.deepEqual(calls.createProject, [['user-1', 'tenant-a', { name: 'New Project', slug: 'new-project' }]]);
  assert.deepEqual(calls.verifyCsrfToken, [[SESSION_TOKEN, CSRF_TOKEN]]);
});

test('direct handler mocks preserve unauthenticated and cross-tenant project isolation', async () => {
  const unauthenticated = makeService();
  const unauthenticatedHandler = createSaasIdentityHandler({
    service: unauthenticated.service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });
  const missingSession = await invoke(
    unauthenticatedHandler,
    makeRequest('GET', '/console/api/v1/tenants/tenant-a/projects'),
  );
  assert.equal(missingSession.recorder.status, 401);
  assert.deepEqual(unauthenticated.calls.getSession, []);
  assert.deepEqual(unauthenticated.calls.listProjects, []);

  const denied = makeService({ denyTenant: 'tenant-other' });
  const deniedHandler = createSaasIdentityHandler({
    service: denied.service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });
  const crossTenant = await invoke(
    deniedHandler,
    makeRequest('GET', '/console/api/v1/tenants/tenant-other/projects', sessionHeaders),
  );
  assert.equal(crossTenant.recorder.status, 403);
  assert.equal((crossTenant.data.error as Record<string, unknown>).code, 'FORBIDDEN');
  assert.deepEqual(denied.calls.listProjects, [['user-1', 'tenant-other']]);
});

test('direct handler mocks enforce CSRF before JSON DTO parsing and reject extra fields', async () => {
  const { service, calls } = makeService();
  const handler = createSaasIdentityHandler({
    service: service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });

  const csrfRejected = await invoke(
    handler,
    makeRequest(
      'POST',
      '/console/api/v1/tenants/tenant-a/projects',
      {
        cookie: `mr_saas_session=${SESSION_TOKEN}`,
        origin: ORIGIN,
        host: HOST,
        'content-type': 'application/json',
      },
      '{"name":',
    ),
  );
  assert.equal(csrfRejected.recorder.status, 403);
  assert.equal((csrfRejected.data.error as Record<string, unknown>).code, 'CSRF_REJECTED');
  assert.deepEqual(calls.createProject, []);

  const extraField = await invoke(
    handler,
    makeRequest(
      'POST',
      '/console/api/v1/tenants/tenant-a/projects',
      writeHeaders,
      JSON.stringify({ name: 'New Project', projectId: 'tenant-other' }),
    ),
  );
  assert.equal(extraField.recorder.status, 400);
  assert.equal((extraField.data.error as Record<string, unknown>).code, 'INVALID_BODY');
  assert.deepEqual(calls.createProject, []);
});

// DTO regression only: invoke the original handler using the existing fake
// request/response and service ports, without sockets or DB. These tests do not
// substitute for real password/session/authorization PostgreSQL acceptance.
test('session POST and GET preserve public null/boolean metadata without weakening redaction or scalar guards', async () => {
  const createdAt = '2026-01-01T00:00:00.000Z';
  const expiresAt = '2099-01-01T00:00:00.000Z';
  const privateValue = 'synthetic-dto-secret-must-not-leak';
  const cycle: { nullable: null; self?: unknown } = { nullable: null };
  cycle.self = cycle;
  let deep: unknown = {
    boundaryNull: null,
    boundaryTrue: true,
    boundaryFalse: false,
    boundaryText: 'depth-limit-fixture',
  };
  // Session=0, metadata=1, deep=2; ten wrappers put these scalar leaves
  // at depth 13, testing that null/boolean do not bypass the depth guard.
  for (let index = 0; index < 10; index++) deep = { nested: deep };
  const publicSession = {
    userId: 'dto-fixture-user',
    activeTenantId: null,
    createdAt,
    expiresAt,
    metadata: {
      enabled: true,
      disabled: false,
      nullable: null,
      finite: 12.5,
      missing: undefined,
      notANumber: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      values: [
        null,
        true,
        false,
        0,
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        SESSION_TOKEN,
      ],
      safeDate: new Date(createdAt),
      invalidDate: new Date(Number.NaN),
      cycle,
      deep,
      token: null,
      password: false,
      secret: true,
      credential: privateValue,
      hash: privateValue,
      tokenHash: privateValue,
      passwordHash: privateValue,
      nested: { nullable: null, enabled: true, disabled: false, secret: privateValue },
      hiddenValue: SESSION_TOKEN,
    },
    token: SESSION_TOKEN,
    csrfToken: CSRF_TOKEN,
    passwordHash: privateValue,
    secret: privateValue,
    hiddenValue: SESSION_TOKEN,
  };
  const lookups: string[] = [];
  const csrfLookups: Array<[string, string]> = [];
  const logins: Array<{ email: string; password: string; ttlSeconds: number }> = [];
  const service = {
    async login(input: { email: string; password: string; ttlSeconds: number }) {
      logins.push(input);
      return { token: SESSION_TOKEN, csrfToken: CSRF_TOKEN, session: publicSession };
    },
    async getSession(token: string) {
      lookups.push(token);
      return token === SESSION_TOKEN ? publicSession : undefined;
    },
    async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
      csrfLookups.push([token, csrfToken]);
      return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
    },
  };
  const handler = createSaasIdentityHandler({
    service: service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });
  const results = [
    await invoke(
      handler,
      makeRequest(
        'POST',
        '/console/api/v1/auth/session',
        {
          origin: ORIGIN,
          host: HOST,
          'content-type': 'application/json',
        },
        JSON.stringify({ email: 'dto-fixture@example.test', password: 'synthetic-dto-password-only' }),
      ),
    ),
    await invoke(handler, makeRequest('GET', '/console/api/v1/auth/session', sessionHeaders)),
  ];
  for (const result of results) {
    assert.equal(result.handled, true);
    assert.equal(result.recorder.status, 200);
    assert.equal(result.recorder.headers['cache-control'], 'no-store');
    assert.equal(result.recorder.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.recorder.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.recorder.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(Object.keys(result.data).sort(), ['data', 'meta']);
    assert.deepEqual(Object.keys(result.data.meta as Record<string, unknown>), ['requestId']);
    assert.equal(typeof (result.data.meta as Record<string, unknown>).requestId, 'string');
    const data = result.data.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data), ['session']);
    const session = data.session as Record<string, unknown>;
    assert.deepEqual(Object.keys(session).sort(), ['activeTenantId', 'createdAt', 'expiresAt', 'metadata', 'userId']);
    assert.equal(session.userId, 'dto-fixture-user');
    assert.equal(session.activeTenantId, null);
    assert.equal(session.createdAt, createdAt);
    assert.equal(session.expiresAt, expiresAt);
    const metadata = session.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), [
      'cycle',
      'deep',
      'disabled',
      'enabled',
      'finite',
      'nested',
      'nullable',
      'safeDate',
      'values',
    ]);
    assert.equal(metadata.enabled, true);
    assert.equal(metadata.disabled, false);
    assert.equal(metadata.nullable, null);
    assert.equal(metadata.finite, 12.5);
    assert.equal(metadata.safeDate, createdAt);
    assert.deepEqual(metadata.values, [null, true, false, 0]);
    assert.deepEqual(metadata.cycle, { nullable: null });
    assert.deepEqual(metadata.nested, { nullable: null, enabled: true, disabled: false });
    const safeDeep = metadata.deep as Record<string, unknown>;
    let cursor = safeDeep;
    let depth = 1;
    while (Object.hasOwn(cursor, 'nested')) {
      cursor = cursor.nested as Record<string, unknown>;
      depth++;
    }
    assert.equal(depth, 11);
    assert.deepEqual(cursor, {}, 'depth > 12 remains omitted even for null/boolean leaves');
    assert.ok(
      ![SESSION_TOKEN, CSRF_TOKEN, privateValue, 'depth-limit-fixture'].some((value) =>
        result.recorder.body.includes(value),
      ),
      'synthetic secret/hidden/deep values must never enter the public DTO',
    );
  }
  const cookies = results[0]!.recorder.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 4);
  assert.equal(cookies.filter((value) => !value.includes('Max-Age=0')).length, 2);
  const sessionCookie = cookies.find((value) => value.startsWith('mr_saas_session=') && !value.includes('Max-Age=0'));
  const csrfCookie = cookies.find((value) => value.startsWith('mr_saas_csrf=') && !value.includes('Max-Age=0'));
  assert.ok(sessionCookie && csrfCookie);
  for (const cookie of [sessionCookie, csrfCookie]) {
    assert.ok(cookie.includes('SameSite=Strict') && cookie.includes('Max-Age=900') && cookie.includes('Secure'));
  }
  assert.match(sessionCookie, /(?:^|; )Path=\/console\/api\/v1(?:;|$)/);
  assert.match(csrfCookie, /(?:^|; )Path=\/console(?:;|$)/);
  const expiredCsrf = cookies.filter((value) => value.startsWith('mr_saas_csrf=;') && value.includes('Max-Age=0'));
  assert.equal(expiredCsrf.length, 2);
  assert.deepEqual(expiredCsrf.map((value) => /(?:^|; )Path=([^;]+)/.exec(value)?.[1]).sort(), [
    '/console',
    '/console/api/v1',
  ]);
  assert.ok(
    expiredCsrf.every(
      (value) => value.includes('Secure') && value.includes('SameSite=Strict') && !value.includes('HttpOnly'),
    ),
  );
  assert.ok(sessionCookie.includes('HttpOnly'));
  assert.ok(!csrfCookie.includes('HttpOnly'));
  assert.equal(results[1]!.recorder.headers['set-cookie'], undefined, 'GET does not mint/reset a session');
  assert.deepEqual(lookups, [SESSION_TOKEN]);
  assert.deepEqual(logins, [
    { email: 'dto-fixture@example.test', password: 'synthetic-dto-password-only', ttlSeconds: 900 },
  ]);
  assert.deepEqual(csrfLookups, [], 'session DTO routes must not invoke the absent MFA authority');
});

test('member directory final and empty pages keep nullable cursor/name and the exact minimal projection', async () => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const tenant = '20000000-0000-4000-8000-000000000001';
  const member = {
    userId: actor,
    displayName: null,
    role: 'owner' as const,
    status: 'active' as const,
    email: 'synthetic-member-dto@example.test',
    passwordHash: 'synthetic-member-password-hash',
    token: SESSION_TOKEN,
    credential: null,
    secret: false,
    safeExtra: true,
  };
  for (const items of [[member], []]) {
    const calls: Array<[string, string, unknown]> = [];
    const lookups: string[] = [];
    const csrfLookups: Array<[string, string]> = [];
    const service = {
      async getSession(token: string) {
        lookups.push(token);
        return token === SESSION_TOKEN ? { userId: actor, activeTenantId: null } : undefined;
      },
      async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
        csrfLookups.push([token, csrfToken]);
        return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
      },
      async listTenantMembers(userId: string, tenantId: string, query: unknown) {
        calls.push([userId, tenantId, query]);
        return { items, nextCursor: null };
      },
    };
    const handler = createSaasIdentityHandler({
      service: service as never,
      publicOrigin: ORIGIN,
      sessionTtlSeconds: 900,
    });
    const result = await invoke(
      handler,
      makeRequest('GET', `/console/api/v1/tenants/${tenant}/members`, sessionHeaders),
    );
    assert.equal(result.handled, true);
    assert.equal(result.recorder.status, 200);
    assert.deepEqual(result.data.data, {
      items: items.map(() => ({ userId: actor, displayName: null, role: 'owner', status: 'active' })),
      nextCursor: null,
    });
    assert.equal(result.recorder.headers['cache-control'], 'no-store');
    assert.equal(result.recorder.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.recorder.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.recorder.headers['set-cookie'], undefined, 'readonly directory does not mint/reset a session');
    assert.deepEqual(lookups, [SESSION_TOKEN]);
    assert.deepEqual(calls, [[actor, tenant, {}]]);
    assert.deepEqual(csrfLookups, [], 'readonly directory must not invoke the absent MFA authority');
    assert.ok(
      ![member.email, member.passwordHash, SESSION_TOKEN].some((value) => result.recorder.body.includes(value)),
      'member projection must not expand to unknown or sensitive fields',
    );
  }
});

// Synthetic cookie-jar/client contracts, not execution evidence for a browser,
// PostgreSQL session or managed activation. Do not log jar contents or secrets.
test('real issuer scope separates HttpOnly session from portal-readable CSRF and removes both prior path identities', async () => {
  const lookups: string[] = [];
  const csrfLookups: Array<[string, string]> = [];
  const handler = createSaasIdentityHandler({
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
    service: {
      async login() {
        return {
          token: SESSION_TOKEN,
          csrfToken: CSRF_TOKEN,
          session: { userId: 'scope-fixture-user', activeTenantId: null },
        };
      },
      async getSession(token: string) {
        lookups.push(token);
        return token === SESSION_TOKEN ? { userId: 'scope-fixture-user', activeTenantId: null } : undefined;
      },
      async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
        csrfLookups.push([token, csrfToken]);
        return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
      },
    } as never,
  });
  const issued = await invoke(
    handler,
    makeRequest(
      'POST',
      '/console/api/v1/auth/session',
      {
        host: HOST,
        origin: ORIGIN,
        'content-type': 'application/json',
      },
      JSON.stringify({ email: 'scope-fixture@example.test', password: 'synthetic-password-only' }),
    ),
  );
  assert.equal(issued.recorder.status, 200);
  assert.equal(issued.recorder.headers['cache-control'], 'no-store');
  assert.deepEqual(issued.data.data, { session: { userId: 'scope-fixture-user', activeTenantId: null } });
  assert.equal(issued.recorder.body.includes(SESSION_TOKEN), false);
  assert.equal(issued.recorder.body.includes(CSRF_TOKEN), false);
  const cookies = issued.recorder.headers['set-cookie'];
  assert.ok(Array.isArray(cookies));
  const jar = new Map<string, { name: string; value: string; path: string; httpOnly: boolean }>([
    ['mr_saas_csrf|/console', { name: 'mr_saas_csrf', value: 'synthetic-stale-ui', path: '/console', httpOnly: false }],
    [
      'mr_saas_csrf|/console/api/v1',
      { name: 'mr_saas_csrf', value: 'synthetic-stale-api', path: '/console/api/v1', httpOnly: false },
    ],
  ]);
  for (const header of cookies) {
    const parts = header.split(';').map((value) => value.trim());
    const pair = parts[0];
    assert.ok(pair);
    const separator = pair.indexOf('=');
    assert.ok(separator > 0);
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const path = parts.find((part) => part.startsWith('Path='))?.slice(5);
    assert.ok(path);
    const key = `${name}|${path}`;
    if (parts.includes('Max-Age=0')) jar.delete(key);
    else jar.set(key, { name, value, path, httpOnly: parts.includes('HttpOnly') });
  }
  assert.equal(jar.size, 2);
  assert.equal(jar.has('mr_saas_csrf|/console/api/v1'), false);
  const pathMatches = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const visible = (pathname: string) =>
    [...jar.values()].filter((cookie) => !cookie.httpOnly && pathMatches(pathname, cookie.path));
  assert.deepEqual(
    visible('/console/security').map((cookie) => cookie.name),
    ['mr_saas_csrf'],
  );
  assert.deepEqual(
    visible('/console').map((cookie) => cookie.name),
    ['mr_saas_csrf'],
  );
  assert.deepEqual(visible('/console-other'), []);
  assert.deepEqual(visible('/platform'), []);
  const apiCookies = [...jar.values()].filter((cookie) => pathMatches('/console/api/v1/auth/mfa', cookie.path));
  assert.deepEqual(apiCookies.map((cookie) => cookie.name).sort(), ['mr_saas_csrf', 'mr_saas_session']);
  assert.equal(apiCookies.filter((cookie) => cookie.name === 'mr_saas_csrf').length, 1);
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let calls = 0;
  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        cookie: visible('/console/security')
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join('; '),
      },
    });
    globalThis.fetch = async (input, init) => {
      ++calls;
      assert.equal(String(input), '/console/api/v1/auth/mfa');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(init?.credentials, 'same-origin');
      assert.equal(init?.mode, 'same-origin');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.referrerPolicy, 'no-referrer');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('x-csrf-token'), CSRF_TOKEN);
      assert.equal(headers.has('Origin'), false);
      assert.equal(headers.has('Authorization'), false);
      return new Response(
        JSON.stringify({ data: { enabled: false }, meta: { requestId: 'synthetic-public-request-id' } }),
        { status: 200 },
      );
    };
    assert.deepEqual(await saasClient.getCustomerMfaStatus(), { enabled: false });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
  assert.deepEqual(lookups, [], 'cookie issuance must not consult an existing session');
  assert.deepEqual(csrfLookups, [], 'the client fetch fixture must not invoke the absent MFA authority');
});

test('client rejects identical/different duplicate CSRF and malformed encoding before MFA fetch; no envelope token fallback', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      ++calls;
      throw new Error('Must not dispatch ambiguous CSRF');
    };
    for (const cookie of [
      `mr_saas_csrf=${CSRF_TOKEN}; mr_saas_csrf=${CSRF_TOKEN}`,
      `mr_saas_csrf=${CSRF_TOKEN}; mr_saas_csrf=different-synthetic-token`,
      'mr_saas_csrf=%ZZ',
      'mr_saas_csrf=',
      `mr_saas_session=${SESSION_TOKEN}`,
    ]) {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie } });
      const reject = (error: unknown) => {
        assert.ok(error instanceof SaasApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, 'CSRF_REJECTED');
        assert.equal(error.details, undefined);
        assert.equal(error.data, undefined);
        assert.equal(error.message.includes(SESSION_TOKEN), false);
        assert.equal(error.message.includes(CSRF_TOKEN), false);
        return true;
      };
      await assert.rejects(saasClient.getCustomerMfaStatus(), reject);
      await assert.rejects(saasClient.startCustomerMfaEnrollment({ password: 'synthetic-password-only' }), reject);
      await assert.rejects(
        saasClient.confirmCustomerMfaEnrollment({
          password: 'synthetic-password-only',
          code: '123456',
          confirmationToken: 'synthetic-confirmation-token',
        }),
        reject,
      );
      await assert.rejects(
        saasClient.revokeCustomerMfa({ password: 'synthetic-password-only', code: '123456' }),
        reject,
      );
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

// Standalone key-delegation contracts: real IdentityService issuer on a strictly
// scripted database, not PG authority/race evidence. Only generic driver rows are
// adapted below; no shape-only handle is accepted by any positive writer.
const KEY_USER = '11111111-1111-4111-8111-111111111111';
const KEY_SESSION = '22222222-2222-4222-8222-222222222222';
const KEY_TENANT = '33333333-3333-4333-8333-333333333333';
const KEY_PROJECT = '44444444-4444-4444-8444-444444444444';
const KEY_PATH = `/console/api/v1/tenants/${KEY_TENANT}/projects/${KEY_PROJECT}/keys`;
const KEY_CREATE = JSON.stringify({ name: 'Owned key', modelScopes: ['model-a'], supplyMode: 'platform' });
const KEY_MUTATIONS = [
  { path: KEY_PATH, body: KEY_CREATE, status: 201 },
  { path: `${KEY_PATH}/owned-key/rotate`, body: '{}', status: 201 },
  { path: `${KEY_PATH}/owned-key/revoke`, body: '{}', status: 200 },
];

function standaloneKeys(options: { missing?: 'issuer' | 'writer'; issuer?: 'empty' | 'error' | 'forged' } = {}) {
  const calls = { native: [] as string[], writes: [] as string[], legacy: 0, list: 0 };
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const tokenHash = hash(SESSION_TOKEN),
    csrfHash = hash(CSRF_TOKEN);
  const sessionSql =
    'SELECT s.user_id, s.expires_at, s.created_at FROM saas_sessions s JOIN saas_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.disabled_at IS NULL LIMIT 1';
  const csrfSql =
    'SELECT s.csrf_token_hash FROM saas_sessions s JOIN saas_users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.disabled_at IS NULL LIMIT 1';
  const scopeSql =
    "SELECT t.id AS tenant_id, m.role AS tenant_role, pm.role AS project_role, p.id AS project_id FROM saas_tenants t JOIN saas_memberships m ON m.tenant_id = t.id JOIN saas_users u ON u.id = m.user_id JOIN saas_projects p ON p.tenant_id = t.id AND p.id = $3 JOIN saas_project_memberships pm ON pm.tenant_id = t.id AND pm.project_id = p.id AND pm.user_id = m.user_id AND pm.status = 'active' WHERE t.id = $1 AND m.user_id = $2 AND m.status = 'active' AND t.status = 'active' AND u.disabled_at IS NULL LIMIT 1";
  const database: SaasDatabase = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlResult<Row>> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      let rows: unknown[];
      if (sql === CUSTOMER_KEY_MUTATION_ISSUE_SQL) {
        calls.native.push('issue');
        assert.deepEqual(values, [tokenHash, csrfHash]);
        if (options.issuer === 'error') throw new Error('Owned issuer port failure');
        rows =
          options.issuer === 'empty'
            ? []
            : [
                {
                  id: KEY_SESSION,
                  user_id: KEY_USER,
                  token_hash: tokenHash,
                  csrf_token_hash: csrfHash,
                },
              ];
      } else if (normalized === sessionSql) {
        calls.native.push('session');
        assert.equal(values.length, 2);
        rows =
          values[0] === tokenHash
            ? [
                {
                  user_id: KEY_USER,
                  expires_at: '2030-01-01T00:00:00.000Z',
                  created_at: '2026-10-04T00:00:00.000Z',
                },
              ]
            : [];
      } else if (normalized === csrfSql) {
        calls.native.push('csrf');
        assert.equal(values.length, 2);
        rows = values[0] === tokenHash ? [{ csrf_token_hash: csrfHash }] : [];
      } else if (normalized === scopeSql) {
        calls.native.push('scope');
        rows =
          values.length === 3 && values[0] === KEY_TENANT && values[1] === KEY_USER && values[2] === KEY_PROJECT
            ? [{ tenant_id: KEY_TENANT, project_id: KEY_PROJECT, tenant_role: 'owner', project_role: 'owner' }]
            : [];
      } else throw new Error('Unexpected standalone key fixture SQL');
      // Scripted driver boundary only: real issuer validates row shape/identity.
      return { rows: rows as Row[], rowCount: rows.length };
    },
    async transaction<T>(_work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      throw new Error('HTTP delegation fixture must not claim a money/write TX');
    },
    async migrate() {
      throw new Error('No fixture migration');
    },
    async verifySchema() {
      throw new Error('No fixture readiness');
    },
    async ping() {
      throw new Error('No fixture ping');
    },
    async close() {},
  };
  const service = new SaasIdentityService(database, { now: () => new Date('2026-10-04T00:00:00.000Z') });
  // Deliberately absent/forged negative ports; all positive minting uses the
  // unmodified actual method. These overrides must never satisfy map origin.
  if (options.missing === 'issuer') Object.defineProperty(service, 'issueKeyMutationSession', { value: undefined });
  if (options.issuer === 'forged')
    Object.defineProperty(service, 'issueKeyMutationSession', {
      value: async () => Object.freeze({ purpose: 'customer-key-mutation-session-v1' }),
    });
  const metadata: ApiKeyMetadata = {
    id: 'owned-key',
    tenantId: KEY_TENANT,
    projectId: KEY_PROJECT,
    principalUserId: KEY_USER,
    executionPrincipalType: 'member',
    executionPrincipalId: KEY_USER,
    createdByUserId: KEY_USER,
    rotatedByUserId: null,
    revokedByUserId: null,
    entitlementId: 'owned-entitlement',
    supplyProfileId: 'owned-profile',
    supplyMode: 'platform',
    name: 'Owned key',
    prefix: 'mr_live_owned',
    modelScopes: ['model-a'],
    status: 'active',
    createdAt: '2026-10-04T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    authzVersion: 1,
    modelScopeVersion: 1,
    entitlementAuthzVersion: 1,
    supplyProfileAuthzVersion: 1,
  };
  const rejectLegacy = async (): Promise<never> => {
    ++calls.legacy;
    throw new Error('Legacy HTTP writer forbidden');
  };
  const keyService: NonNullable<SaasKeyHttpOptions['keyService']> = {
    create: rejectLegacy,
    rotate: rejectLegacy,
    revoke: rejectLegacy,
    async list(context) {
      assert.deepEqual(context, {
        userId: KEY_USER,
        tenantId: KEY_TENANT,
        projectId: KEY_PROJECT,
        tenantRole: 'owner',
        projectRole: 'owner',
      });
      ++calls.list;
      return [Object.assign({}, metadata, { unknownPrivateField: 'synthetic-unknown-field' })];
    },
    ...(options.missing === 'writer'
      ? {}
      : {
          async createAuthenticated(
            context: TenantContext,
            input: CreateApiKeyInput,
            handle: CustomerKeyMutationSessionHandle,
          ): Promise<CreatedApiKey> {
            assertCustomerKeyMutationSessionBound(handle, database, context.userId);
            assert.equal(context.tenantId, KEY_TENANT);
            assert.equal(context.projectId, KEY_PROJECT);
            assert.equal(input.principalKind, 'member');
            calls.writes.push('create');
            return { ...metadata, secret: 'synthetic-owned-create-secret' };
          },
          async rotateAuthenticated(
            context: TenantContext,
            keyId: string,
            handle: CustomerKeyMutationSessionHandle,
          ): Promise<CreatedApiKey> {
            assertCustomerKeyMutationSessionBound(handle, database, context.userId);
            assert.equal(keyId, metadata.id);
            calls.writes.push('rotate');
            return { ...metadata, secret: 'synthetic-owned-rotate-secret' };
          },
          async revokeAuthenticated(
            context: TenantContext,
            keyId: string,
            handle: CustomerKeyMutationSessionHandle,
          ): Promise<ApiKeyMetadata> {
            assertCustomerKeyMutationSessionBound(handle, database, context.userId);
            assert.equal(keyId, metadata.id);
            calls.writes.push('revoke');
            return { ...metadata, status: 'revoked', revokedAt: metadata.createdAt };
          },
        }),
  };
  const handlerOptions = { service, keyService, publicOrigin: ORIGIN, sessionTtlSeconds: 900 };
  return { handler: createSaasIdentityHandler(handlerOptions), dedicated: createSaasKeyHandler(handlerOptions), calls };
}

test('standalone identity key routes delegate all three writes to genuine issuer-bound authenticated ports', async () => {
  const fixture = standaloneKeys();
  for (const mutation of KEY_MUTATIONS) {
    const result = await invoke(fixture.handler, makeRequest('POST', mutation.path, writeHeaders, mutation.body));
    assert.equal(result.handled, true);
    assert.equal(result.recorder.status, mutation.status);
    assert.equal(result.recorder.headers['cache-control'], 'no-store');
    assert.equal(result.recorder.headers['set-cookie'], undefined);
    assert.ok(!result.recorder.body.includes(SESSION_TOKEN) && !result.recorder.body.includes(CSRF_TOKEN));
  }
  assert.deepEqual(fixture.calls.writes, ['create', 'rotate', 'revoke']);
  assert.equal(fixture.calls.legacy, 0);
  assert.deepEqual(
    fixture.calls.native,
    ['session', 'csrf', 'scope', 'issue', 'session', 'csrf', 'scope', 'issue', 'session', 'csrf', 'scope', 'issue'],
    'no duplicate standalone session/CSRF check',
  );
});

test('standalone key mutation missing issuer or authenticated writer is 503 while readonly GET remains allowed', async () => {
  for (const missing of ['issuer', 'writer'] as const) {
    const fixture = standaloneKeys({ missing });
    for (const mutation of KEY_MUTATIONS) {
      const result = await invoke(fixture.handler, makeRequest('POST', mutation.path, writeHeaders, mutation.body));
      assert.equal(result.handled, true);
      assert.equal(result.recorder.status, 503);
      assert.deepEqual(fixture.calls.writes, []);
      assert.equal(fixture.calls.legacy, 0);
    }
    const result = await invoke(fixture.handler, makeRequest('GET', KEY_PATH, sessionHeaders));
    assert.equal(result.recorder.status, 200);
    assert.equal(fixture.calls.list, 1);
    assert.equal(result.recorder.body.includes('unknownPrivateField'), false);
    assert.equal(result.recorder.headers['set-cookie'], undefined);
    assert.equal(fixture.calls.native.includes('issue'), false);
  }
});

test('standalone key writes reject a shape-only forged issuer instead of falling back to legacy methods', async () => {
  const fixture = standaloneKeys({ issuer: 'forged' });
  for (const mutation of KEY_MUTATIONS) {
    const result = await invoke(fixture.handler, makeRequest('POST', mutation.path, writeHeaders, mutation.body));
    assert.equal(result.recorder.status, 503);
  }
  assert.deepEqual(fixture.calls.writes, []);
  assert.equal(fixture.calls.legacy, 0);
  assert.equal(fixture.calls.native.includes('issue'), false);
});

test('standalone delegated key boundaries reject method origin host CSRF body and foreign scope before issuance', async () => {
  const variants = [
    { method: 'PUT', headers: writeHeaders, status: 405 },
    { method: 'POST', headers: { ...writeHeaders, origin: 'https://other.example.test' }, status: 403 },
    { method: 'POST', headers: { ...writeHeaders, host: 'other.example.test' }, status: 403 },
    { method: 'POST', headers: { ...writeHeaders, 'x-csrf-token': 'synthetic-wrong-csrf' }, status: 403 },
    { method: 'POST', headers: { ...writeHeaders, cookie: 'mr_saas_session=synthetic-unknown-session' }, status: 401 },
  ];
  for (const mutation of KEY_MUTATIONS)
    for (const variant of variants) {
      const fixture = standaloneKeys();
      const result = await invoke(
        fixture.handler,
        makeRequest(variant.method, mutation.path, variant.headers, mutation.body),
      );
      assert.equal(result.recorder.status, variant.status);
      assert.deepEqual(fixture.calls.writes, []);
      assert.equal(fixture.calls.legacy, 0);
      assert.equal(fixture.calls.native.includes('issue'), false);
    }
  for (const mutation of KEY_MUTATIONS) {
    for (const path of [mutation.path, mutation.path.replace(KEY_TENANT, 'foreign-tenant')]) {
      const fixture = standaloneKeys();
      const body =
        path === mutation.path ? JSON.stringify({ ...JSON.parse(mutation.body), approved: true }) : mutation.body;
      const result = await invoke(fixture.handler, makeRequest('POST', path, writeHeaders, body));
      assert.equal(result.recorder.status, path === mutation.path ? 400 : 404);
      assert.deepEqual(fixture.calls.writes, []);
      assert.equal(fixture.calls.legacy, 0);
      assert.equal(fixture.calls.native.includes('issue'), false);
    }
  }
});

test('standalone key issuer refusal or query error remains failclosed on every delegated write', async () => {
  for (const issuer of ['empty', 'error'] as const) {
    const fixture = standaloneKeys({ issuer });
    for (const mutation of KEY_MUTATIONS) {
      const result = await invoke(fixture.handler, makeRequest('POST', mutation.path, writeHeaders, mutation.body));
      assert.equal(result.recorder.status, issuer === 'empty' ? 401 : 503);
      assert.deepEqual(fixture.calls.writes, []);
      assert.equal(fixture.calls.legacy, 0);
    }
    assert.equal(fixture.calls.native.filter((value) => value === 'issue').length, 3);
  }
});

test('standalone and dedicated key handlers share exact valid body response and readonly projection contracts', async () => {
  const fixture = standaloneKeys();
  const optionalCreate = {
    path: KEY_PATH,
    body: JSON.stringify({
      name: 'Owned key',
      modelScopes: ['model-a'],
      supplyMode: 'platform',
      principalKind: 'member',
      expiresAt: null,
    }),
    status: 201,
  };
  for (const mutation of [...KEY_MUTATIONS, optionalCreate]) {
    const direct = await invoke(fixture.dedicated, makeRequest('POST', mutation.path, writeHeaders, mutation.body));
    const delegated = await invoke(fixture.handler, makeRequest('POST', mutation.path, writeHeaders, mutation.body));
    assert.equal(direct.recorder.status, mutation.status);
    assert.equal(delegated.recorder.status, mutation.status);
    assert.deepEqual(delegated.data.data, direct.data.data);
    assert.deepEqual(delegated.recorder.headers, direct.recorder.headers);
  }
  const direct = await invoke(fixture.dedicated, makeRequest('GET', KEY_PATH, sessionHeaders));
  const delegated = await invoke(fixture.handler, makeRequest('GET', KEY_PATH, sessionHeaders));
  assert.equal(direct.recorder.status, 200);
  assert.equal(delegated.recorder.status, 200);
  assert.deepEqual(delegated.data.data, direct.data.data);
  assert.equal(delegated.recorder.body.includes('synthetic-unknown-field'), false);
  assert.equal(delegated.recorder.body.includes('secret'), false);
  assert.equal(fixture.calls.legacy, 0);
});

test('member management routes CSRF-guard role change, removal and ownership transfer with strict bodies', async () => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const tenant = '20000000-0000-4000-8000-000000000001';
  const target = '30000000-0000-4000-8000-000000000001';
  const calls: Array<readonly unknown[]> = [];
  const service = {
    async getSession(token: string) {
      return token === SESSION_TOKEN ? { userId: actor, activeTenantId: null } : undefined;
    },
    async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
      return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
    },
    async updateTenantMemberRole(...args: readonly unknown[]) {
      calls.push(['role', ...args]);
      return { userId: target, displayName: 'Dev', role: args[3], status: 'active' };
    },
    async removeTenantMember(...args: readonly unknown[]) {
      calls.push(['remove', ...args]);
      return { userId: target, displayName: 'Dev', role: 'developer', status: 'revoked' };
    },
    async transferTenantOwnership(...args: readonly unknown[]) {
      calls.push(['transfer', ...args]);
      return { userId: target, displayName: 'Dev', role: 'owner', status: 'active' };
    },
  };
  const handler = createSaasIdentityHandler({
    service: service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });

  const rolePath = `/console/api/v1/tenants/${tenant}/members/${target}/role`;
  const removePath = `/console/api/v1/tenants/${tenant}/members/${target}/remove`;
  const transferPath = `/console/api/v1/tenants/${tenant}/ownership-transfer`;

  let result = await invoke(handler, makeRequest('POST', rolePath, writeHeaders, JSON.stringify({ role: 'billing' })));
  assert.equal(result.recorder.status, 200);
  assert.deepEqual(result.data.data, {
    member: { userId: target, displayName: 'Dev', role: 'billing', status: 'active' },
  });
  result = await invoke(handler, makeRequest('POST', removePath, writeHeaders, '{}'));
  assert.equal(result.recorder.status, 200);
  assert.deepEqual(result.data.data, {
    member: { userId: target, displayName: 'Dev', role: 'developer', status: 'revoked' },
  });
  result = await invoke(handler, makeRequest('POST', transferPath, writeHeaders, JSON.stringify({ userId: target })));
  assert.equal(result.recorder.status, 200);
  assert.deepEqual(result.data.data, {
    member: { userId: target, displayName: 'Dev', role: 'owner', status: 'active' },
  });
  assert.deepEqual(calls, [
    ['role', actor, tenant, target, 'billing'],
    ['remove', actor, tenant, target],
    ['transfer', actor, tenant, target],
  ]);
});

test('member management routes reject wrong method origin host CSRF session and malformed bodies', async () => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const tenant = '20000000-0000-4000-8000-000000000001';
  const target = '30000000-0000-4000-8000-000000000001';
  let serviceCalls = 0;
  const service = {
    async getSession(token: string) {
      return token === SESSION_TOKEN ? { userId: actor, activeTenantId: null } : undefined;
    },
    async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
      return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
    },
    async updateTenantMemberRole() {
      serviceCalls += 1;
      return { userId: target, displayName: null, role: 'viewer', status: 'active' };
    },
    async removeTenantMember() {
      serviceCalls += 1;
      return { userId: target, displayName: null, role: 'viewer', status: 'revoked' };
    },
    async transferTenantOwnership() {
      serviceCalls += 1;
      return { userId: target, displayName: null, role: 'owner', status: 'active' };
    },
  };
  const handler = createSaasIdentityHandler({
    service: service as never,
    publicOrigin: ORIGIN,
    sessionTtlSeconds: 900,
  });

  const rolePath = `/console/api/v1/tenants/${tenant}/members/${target}/role`;
  const removePath = `/console/api/v1/tenants/${tenant}/members/${target}/remove`;
  const transferPath = `/console/api/v1/tenants/${tenant}/ownership-transfer`;
  const mutations = [
    { path: rolePath, body: JSON.stringify({ role: 'viewer' }) },
    { path: removePath, body: '{}' },
    { path: transferPath, body: JSON.stringify({ userId: target }) },
  ];
  const variants = [
    { method: 'PUT', headers: writeHeaders, status: 405 },
    { method: 'GET', headers: writeHeaders, status: 405 },
    { method: 'POST', headers: { ...writeHeaders, origin: 'https://other.example.test' }, status: 403 },
    { method: 'POST', headers: { ...writeHeaders, host: 'other.example.test' }, status: 403 },
    { method: 'POST', headers: { ...writeHeaders, 'x-csrf-token': 'synthetic-wrong-csrf' }, status: 403 },
    { method: 'POST', headers: { ...writeHeaders, cookie: 'mr_saas_session=synthetic-unknown-session' }, status: 401 },
  ];
  for (const mutation of mutations) {
    for (const variant of variants) {
      const result = await invoke(handler, makeRequest(variant.method, mutation.path, variant.headers, mutation.body));
      assert.equal(result.recorder.status, variant.status, `${variant.method} ${mutation.path}`);
    }
  }
  // Strict bodies: bad role value, extra key, missing required key, non-empty remove body.
  const badBodies: Array<[string, string]> = [
    [rolePath, JSON.stringify({ role: 'root' })],
    [rolePath, JSON.stringify({ role: 'viewer', extra: true })],
    [rolePath, JSON.stringify({})],
    [removePath, JSON.stringify({ userId: target })],
    [transferPath, JSON.stringify({})],
    [transferPath, JSON.stringify({ userId: target, role: 'owner' })],
    [transferPath, JSON.stringify({ userId: 42 })],
  ];
  for (const [path, body] of badBodies) {
    const result = await invoke(handler, makeRequest('POST', path, writeHeaders, body));
    assert.equal(result.recorder.status, 400, `${path} ${body}`);
  }
  assert.equal(serviceCalls, 0, 'no rejected request may reach the service');
});

test('member management routes surface service error codes unchanged', async () => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const tenant = '20000000-0000-4000-8000-000000000001';
  const target = '30000000-0000-4000-8000-000000000001';
  const failures = [
    { thrown: new SaasIdentityError(409, 'LAST_OWNER_REQUIRED'), code: 'CONFLICT' },
    { thrown: new SaasIdentityError(404, 'MEMBER_NOT_FOUND'), code: 'NOT_FOUND' },
    { thrown: new SaasIdentityError(403, 'INSUFFICIENT_TENANT_ROLE'), code: 'FORBIDDEN' },
  ];
  for (const { thrown, code } of failures) {
    const service = {
      async getSession(token: string) {
        return token === SESSION_TOKEN ? { userId: actor, activeTenantId: null } : undefined;
      },
      async verifyCsrfToken(token: string, csrfToken: string): Promise<boolean> {
        return token === SESSION_TOKEN && csrfToken === CSRF_TOKEN;
      },
      async removeTenantMember(): Promise<never> {
        throw thrown;
      },
    };
    const handler = createSaasIdentityHandler({
      service: service as never,
      publicOrigin: ORIGIN,
      sessionTtlSeconds: 900,
    });
    const result = await invoke(
      handler,
      makeRequest('POST', `/console/api/v1/tenants/${tenant}/members/${target}/remove`, writeHeaders, '{}'),
    );
    assert.equal(result.recorder.status, thrown.status);
    const error = result.data.error as Record<string, unknown>;
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    // The specific service code never leaks past the generic status bucket.
    assert.equal(JSON.stringify(error).includes(thrown.code), false);
    assert.equal(result.recorder.body.includes('stack'), false);
  }
});
