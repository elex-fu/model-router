import assert from 'node:assert/strict';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';

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
  let deep: unknown = { boundaryNull: null, boundaryTrue: true, boundaryFalse: false, boundaryText: 'depth-limit-fixture' };
  // Session=0, metadata=1, deep=2; ten wrappers put these scalar leaves
  // at depth 13, testing that null/boolean do not bypass the depth guard.
  for (let index = 0; index < 10; index++) deep = { nested: deep };
  const publicSession = {
    userId: 'dto-fixture-user', activeTenantId: null, createdAt, expiresAt,
    metadata: {
      enabled: true, disabled: false, nullable: null, finite: 12.5,
      missing: undefined, notANumber: Number.NaN, positiveInfinity: Number.POSITIVE_INFINITY, negativeInfinity: Number.NEGATIVE_INFINITY,
      values: [null, true, false, 0, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, SESSION_TOKEN],
      safeDate: new Date(createdAt), invalidDate: new Date(Number.NaN), cycle, deep,
      token: null, password: false, secret: true, credential: privateValue, hash: privateValue,
      tokenHash: privateValue, passwordHash: privateValue, nested: { nullable: null, enabled: true, disabled: false, secret: privateValue },
      hiddenValue: SESSION_TOKEN,
    },
    token: SESSION_TOKEN, csrfToken: CSRF_TOKEN, passwordHash: privateValue, secret: privateValue,
    hiddenValue: SESSION_TOKEN,
  };
  const lookups: string[] = [];
  const logins: Array<{ email: string; password: string; ttlSeconds: number }> = [];
  const service = {
    async login(input: { email: string; password: string; ttlSeconds: number }) {
      logins.push(input);
      return { token: SESSION_TOKEN, csrfToken: CSRF_TOKEN, session: publicSession };
    },
    async getSession(token: string) {
      lookups.push(token); return token === SESSION_TOKEN ? publicSession : undefined;
    },
  };
  const handler = createSaasIdentityHandler({ service: service as never, publicOrigin: ORIGIN, sessionTtlSeconds: 900 });
  const results = [
    await invoke(handler, makeRequest('POST', '/console/api/v1/auth/session', {
      origin: ORIGIN, host: HOST, 'content-type': 'application/json',
    }, JSON.stringify({ email: 'dto-fixture@example.test', password: 'synthetic-dto-password-only' }))),
    await invoke(handler, makeRequest('GET', '/console/api/v1/auth/session', sessionHeaders)),
  ];
  for (const result of results) {
    assert.equal(result.handled, true); assert.equal(result.recorder.status, 200);
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
    assert.equal(session.userId, 'dto-fixture-user'); assert.equal(session.activeTenantId, null);
    assert.equal(session.createdAt, createdAt); assert.equal(session.expiresAt, expiresAt);
    const metadata = session.metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ['cycle', 'deep', 'disabled', 'enabled', 'finite', 'nested', 'nullable', 'safeDate', 'values']);
    assert.equal(metadata.enabled, true); assert.equal(metadata.disabled, false); assert.equal(metadata.nullable, null);
    assert.equal(metadata.finite, 12.5); assert.equal(metadata.safeDate, createdAt);
    assert.deepEqual(metadata.values, [null, true, false, 0]);
    assert.deepEqual(metadata.cycle, { nullable: null });
    assert.deepEqual(metadata.nested, { nullable: null, enabled: true, disabled: false });
    const safeDeep = metadata.deep as Record<string, unknown>;
    let cursor = safeDeep; let depth = 1;
    while (Object.hasOwn(cursor, 'nested')) { cursor = cursor.nested as Record<string, unknown>; depth++; }
    assert.equal(depth, 11); assert.deepEqual(cursor, {}, 'depth > 12 remains omitted even for null/boolean leaves');
    assert.ok(![SESSION_TOKEN, CSRF_TOKEN, privateValue, 'depth-limit-fixture'].some(value => result.recorder.body.includes(value)),
      'synthetic secret/hidden/deep values must never enter the public DTO');
  }
  const cookies = results[0]!.recorder.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 2);
  const sessionCookie = cookies.find(value => value.startsWith('mr_saas_session='));
  const csrfCookie = cookies.find(value => value.startsWith('mr_saas_csrf='));
  assert.ok(sessionCookie && csrfCookie);
  for (const cookie of [sessionCookie, csrfCookie]) {
    assert.ok(cookie.includes('SameSite=Strict') && cookie.includes('Path=/console/api/v1') && cookie.includes('Max-Age=900') && cookie.includes('Secure'));
  }
  assert.ok(sessionCookie.includes('HttpOnly')); assert.ok(!csrfCookie.includes('HttpOnly'));
  assert.equal(results[1]!.recorder.headers['set-cookie'], undefined, 'GET does not mint/reset a session');
  assert.deepEqual(lookups, [SESSION_TOKEN]);
  assert.deepEqual(logins, [{ email: 'dto-fixture@example.test', password: 'synthetic-dto-password-only', ttlSeconds: 900 }]);
});

test('member directory final and empty pages keep nullable cursor/name and the exact minimal projection', async () => {
  const actor = '10000000-0000-4000-8000-000000000001';
  const tenant = '20000000-0000-4000-8000-000000000001';
  const member = { userId: actor, displayName: null, role: 'owner' as const, status: 'active' as const,
    email: 'synthetic-member-dto@example.test', passwordHash: 'synthetic-member-password-hash',
    token: SESSION_TOKEN, credential: null, secret: false, safeExtra: true };
  for (const items of [[member], []]) {
    const calls: Array<[string, string, unknown]> = [];
    const lookups: string[] = [];
    const service = {
      async getSession(token: string) {
        lookups.push(token); return token === SESSION_TOKEN ? { userId: actor, activeTenantId: null } : undefined;
      },
      async listTenantMembers(userId: string, tenantId: string, query: unknown) {
        calls.push([userId, tenantId, query]); return { items, nextCursor: null };
      },
    };
    const handler = createSaasIdentityHandler({ service: service as never, publicOrigin: ORIGIN, sessionTtlSeconds: 900 });
    const result = await invoke(handler, makeRequest('GET', `/console/api/v1/tenants/${tenant}/members`, sessionHeaders));
    assert.equal(result.handled, true); assert.equal(result.recorder.status, 200);
    assert.deepEqual(result.data.data, { items: items.map(() => ({ userId: actor, displayName: null, role: 'owner', status: 'active' })), nextCursor: null });
    assert.equal(result.recorder.headers['cache-control'], 'no-store');
    assert.equal(result.recorder.headers['x-content-type-options'], 'nosniff');
    assert.equal(result.recorder.headers['referrer-policy'], 'no-referrer');
    assert.equal(result.recorder.headers['set-cookie'], undefined, 'readonly directory does not mint/reset a session');
    assert.deepEqual(lookups, [SESSION_TOKEN]); assert.deepEqual(calls, [[actor, tenant, {}]]);
    assert.ok(![member.email, member.passwordHash, SESSION_TOKEN].some(value => result.recorder.body.includes(value)),
      'member projection must not expand to unknown or sensitive fields');
  }
});
