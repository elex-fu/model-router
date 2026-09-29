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
