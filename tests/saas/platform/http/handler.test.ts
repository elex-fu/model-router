import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { ProviderRightsRecord } from '../../../../src/saas/catalog/index.js';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import {
  CapacityPolicyError,
  type CapacityPolicyLimits,
  type CapacityPolicyRecord,
} from '../../../../src/saas/platform/capacity-policy-service.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminCapacityPolicyService,
  type PlatformAdminCapacityPolicyTargetSelectors,
  type PlatformAdminReadHandlerOptions,
} from '../../../../src/saas/platform/http/index.js';

const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-1',
  sessionId: 'session-1',
  roles: ['operations'],
};

const WRITE_ACTOR: PlatformAdminActor = {
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  sessionId: 'session-1',
  roles: ['operations'],
};

const WRITE_SESSION_TOKEN = 'platform-session-token';
const WRITE_CSRF_TOKEN = 'platform-csrf-token';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const API_KEY_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CAPACITY_LIMITS: CapacityPolicyLimits = {
  requestsPerMinute: 120,
  tokensPerMinute: 90000,
  maxConcurrentRequests: 8,
};
const TENANT_CAPACITY_POLICY: CapacityPolicyRecord = {
  scope: 'tenant',
  tenantId: TENANT_ID,
  revision: '7',
  revisionKind: 'tenant_capacity_policy',
  limits: CAPACITY_LIMITS,
  configured: true,
};
const PROJECT_CAPACITY_POLICY: CapacityPolicyRecord = {
  scope: 'project',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  revision: '13',
  revisionKind: 'project_inference_policy',
  limits: CAPACITY_LIMITS,
  configured: true,
};
const API_KEY_CAPACITY_POLICY: CapacityPolicyRecord = {
  scope: 'api_key',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  apiKeyId: API_KEY_ID,
  revision: '23',
  revisionKind: 'api_key_authz',
  limits: CAPACITY_LIMITS,
  configured: true,
};

const RIGHTS_RECORD: ProviderRightsRecord = {
  rightsId: 'rights-a',
  version: 1,
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  supplyMode: 'platform',
  region: 'cn-mainland',
  purpose: 'commercial-api',
  modelScope: ['model-a'],
  endpointScope: ['chat-completions'],
  effectiveAt: '2026-09-01T00:00:00.000Z',
  expiresAt: null,
  approvalReference: 'approval-1',
  status: 'active',
  evidenceReference: 'evidence-reference',
  evidenceSha256: 'a'.repeat(64),
  createdAt: '2026-09-28T00:00:00.000Z',
};

const RIGHTS_VERSION_BODY = {
  rightsId: 'rights-a',
  providerId: 'provider-a',
  productId: 'product-a',
  credentialType: 'api-key',
  supplyMode: 'platform',
  region: 'cn-mainland',
  purpose: 'commercial-api',
  modelScope: ['model-a'],
  endpointScope: ['chat-completions'],
  effectiveAt: '2026-09-01T00:00:00Z',
  approvalReference: 'approval-1',
  evidenceReference: 'evidence-reference',
  evidenceSha256: 'a'.repeat(64),
  status: 'active',
} as const;

const RIGHTS_REVOKE_BODY = {
  approvalReference: 'approval-revoke',
  evidenceReference: 'revocation-evidence',
  evidenceSha256: 'b'.repeat(64),
  effectiveAt: '2026-09-29T00:00:00Z',
} as const;

const AUDIT_EVENT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  action: 'api_key.created',
  entityType: 'saas_api_key',
  entityId: 'key-reference-1',
  occurredAt: '2026-09-04T00:00:00.000Z',
  entryPoint: 'platform_admin',
  requestId: 'audit-request-1',
} as const;

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

interface Harness {
  readonly base: string;
  readonly unhandled: () => number;
  request(url: string, init?: RequestInit): Promise<TestResponse>;
  close(): Promise<void>;
}

function makeOptions(
  actor: PlatformAdminActor | undefined = ACTOR,
  overrides: Partial<PlatformAdminReadHandlerOptions> = {},
): PlatformAdminReadHandlerOptions & {
  readonly calls: {
    readonly auth: unknown[];
    readonly summaries: unknown[];
    readonly products: unknown[];
    readonly capabilities: unknown[];
    readonly rights: unknown[];
    readonly audits: unknown[];
    readonly registrations: unknown[];
    readonly revocations: unknown[];
    readonly csrf: unknown[];
    readonly capacityReads: unknown[];
    readonly capacityWrites: unknown[];
    readonly capacityTargetReads: unknown[];
  };
} {
  const calls = {
    auth: [] as unknown[],
    summaries: [] as unknown[],
    products: [] as unknown[],
    capabilities: [] as unknown[],
    rights: [] as unknown[],
    audits: [] as unknown[],
    registrations: [] as unknown[],
    revocations: [] as unknown[],
    csrf: [] as unknown[],
    capacityReads: [] as unknown[],
    capacityWrites: [] as unknown[],
    capacityTargetReads: [] as unknown[],
  };
  const options: PlatformAdminReadHandlerOptions = {
    access: {
      authenticate: async (request) => {
        calls.auth.push(request);
        return actor;
      },
    },
    operations: {
      getSummary: async (query) => {
        calls.summaries.push(query);
        return { summary: 'ok' };
      },
    },
    catalog: {
      listProducts: async (query) => {
        calls.products.push(query);
        return { items: ['product'] };
      },
      listCapabilities: async (query) => {
        calls.capabilities.push(query);
        return { items: ['capability'] };
      },
      listRights: async (query) => {
        calls.rights.push(query);
        return { items: ['right'] };
      },
    },
    audit: {
      listEvents: async (query) => {
        calls.audits.push(query);
        return { items: [AUDIT_EVENT], hasMore: false, nextCursor: null };
      },
    },
  };
  return { ...options, ...overrides, calls };
}

function makeWriteOptions(actor: PlatformAdminActor | undefined = WRITE_ACTOR): ReturnType<typeof makeOptions> {
  const base = makeOptions(actor);
  const options: PlatformAdminReadHandlerOptions = {
    ...base,
    writeSecurity: {
      publicOrigin: 'https://platform-admin.test',
      authService: {
        verifyCsrfToken: async (sessionToken, csrfToken) => {
          base.calls.csrf.push([sessionToken, csrfToken]);
          return sessionToken === WRITE_SESSION_TOKEN && csrfToken === WRITE_CSRF_TOKEN;
        },
      },
    },
    catalog: {
      ...base.catalog,
      registerProviderRightsVersion: async (input) => {
        base.calls.registrations.push(input);
        return RIGHTS_RECORD;
      },
      revokeProviderRights: async (input) => {
        base.calls.revocations.push(input);
        return { ...RIGHTS_RECORD, version: 2, status: 'revoked' };
      },
    },
  };
  return { ...options, calls: base.calls };
}

function updatedCapacityPolicy(
  record: CapacityPolicyRecord,
  expectedRevision: string,
  limits: CapacityPolicyLimits,
): CapacityPolicyRecord {
  return {
    ...record,
    revision: (BigInt(expectedRevision) + 1n).toString(),
    limits,
    configured: true,
  } as CapacityPolicyRecord;
}

function makeCapacityOptions(
  actor: PlatformAdminActor | undefined = WRITE_ACTOR,
  overrides: Partial<PlatformAdminCapacityPolicyService> = {},
  selectorOverrides: Partial<PlatformAdminCapacityPolicyTargetSelectors> = {},
): ReturnType<typeof makeOptions> {
  const base = makeWriteOptions(actor);
  const service: PlatformAdminCapacityPolicyService = {
    getTenantPolicy: async (input) => {
      base.calls.capacityReads.push({ scope: 'tenant', input });
      return TENANT_CAPACITY_POLICY;
    },
    getProjectPolicy: async (input) => {
      base.calls.capacityReads.push({ scope: 'project', input });
      return PROJECT_CAPACITY_POLICY;
    },
    getApiKeyPolicy: async (input) => {
      base.calls.capacityReads.push({ scope: 'api_key', input });
      return API_KEY_CAPACITY_POLICY;
    },
    setTenantPolicy: async (input) => {
      base.calls.capacityWrites.push({ scope: 'tenant', input });
      return updatedCapacityPolicy(TENANT_CAPACITY_POLICY, String(input.expectedRevision), input.limits);
    },
    setProjectPolicy: async (input) => {
      base.calls.capacityWrites.push({ scope: 'project', input });
      return updatedCapacityPolicy(PROJECT_CAPACITY_POLICY, String(input.expectedRevision), input.limits);
    },
    setApiKeyPolicy: async (input) => {
      base.calls.capacityWrites.push({ scope: 'api_key', input });
      return updatedCapacityPolicy(API_KEY_CAPACITY_POLICY, String(input.expectedRevision), input.limits);
    },
  };
  const selectors: PlatformAdminCapacityPolicyTargetSelectors = {
    listTenantIds: async (afterId, limit) => {
      base.calls.capacityTargetReads.push({ scope: 'tenant', afterId, limit });
      return [TENANT_ID];
    },
    listProjectIds: async (tenantId, afterId, limit) => {
      base.calls.capacityTargetReads.push({ scope: 'project', tenantId, afterId, limit });
      return [PROJECT_ID];
    },
    listApiKeyIds: async (tenantId, projectId, afterId, limit) => {
      base.calls.capacityTargetReads.push({ scope: 'api_key', tenantId, projectId, afterId, limit });
      return [API_KEY_ID];
    },
  };
  return {
    ...base,
    capacityPolicies: { ...service, ...overrides },
    capacityPolicyTargets: { ...selectors, ...selectorOverrides },
    calls: base.calls,
  };
}

function capacityWriteInit(body: unknown, overrides: Record<string, string> = {}): RequestInit {
  return { ...writeInit(body, overrides), method: 'PUT' };
}

async function startHarness(options: PlatformAdminReadHandlerOptions): Promise<Harness> {
  const handler = createPlatformAdminReadHandler(options);
  let unhandled = 0;
  return {
    base: 'http://platform-admin.test',
    unhandled: () => unhandled,
    async request(target, init) {
      const url = new URL(target, 'http://platform-admin.test');
      const requestHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      const requestBody = init?.body === undefined ? undefined : String(init.body);
      const req = {
        url: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: requestHeaders,
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          if (requestBody !== undefined) yield Buffer.from(requestBody);
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseHeaders = new Headers();
      let responseBody = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number, headers: Record<string, unknown> = {}) {
          status = code;
          responseHeaders = new Headers(
            Object.entries(headers).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : String(value)]],
            ),
          );
          return res;
        },
        end(body?: unknown) {
          responseBody = body === undefined ? '' : String(body);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      if (!handled) {
        unhandled += 1;
        status = 404;
        responseHeaders = new Headers({ 'content-type': 'text/plain' });
        responseBody = 'unhandled';
        writableEnded = true;
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        // Unhandled routes intentionally use the caller's plain-text fallback.
      }
      return { status, headers: responseHeaders, body };
    },
    close: async () => {},
  };
}

function assertJsonHeaders(response: TestResponse): void {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

function requestId(body: Record<string, unknown>): string {
  const meta = body.meta;
  assert.ok(meta && typeof meta === 'object' && !Array.isArray(meta));
  const value = (meta as Record<string, unknown>).requestId;
  assert.equal(typeof value, 'string');
  return value as string;
}

function errorBody(body: Record<string, unknown>): { code: string; message: string; requestId: string } {
  const error = body.error;
  assert.ok(error && typeof error === 'object' && !Array.isArray(error));
  const value = error as Record<string, unknown>;
  assert.equal(typeof value.code, 'string');
  assert.equal(typeof value.message, 'string');
  assert.equal(typeof value.requestId, 'string');
  return {
    code: value.code as string,
    message: value.message as string,
    requestId: value.requestId as string,
  };
}

function writeInit(body: unknown, overrides: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      origin: 'https://platform-admin.test',
      host: 'platform-admin.test',
      cookie: `mr_platform_admin_session=${WRITE_SESSION_TOKEN}; mr_platform_admin_csrf=${WRITE_CSRF_TOKEN}`,
      'x-csrf-token': WRITE_CSRF_TOKEN,
      'content-type': 'application/json',
      'user-agent': 'platform-admin-test-agent',
      ...overrides,
    },
    body: JSON.stringify(body),
  };
}

test('GET /me returns only the authenticated userId and roles', async () => {
  const options = makeOptions({ ...ACTOR, roles: ['support-readonly'] });
  const app = await startHarness(options);
  try {
    const response = await app.request(`${app.base}/admin/api/v1/me`);
    assert.equal(response.status, 200);
    assertJsonHeaders(response);
    assert.deepEqual(response.body.data, { userId: 'platform-user-1', roles: ['support-readonly'] });
    assert.equal(JSON.stringify(response.body).includes('session-1'), false);
    assert.match(requestId(response.body), /^platform_admin_read_/);
    assert.equal(options.calls.auth.length, 1);
  } finally {
    await app.close();
  }
});

test('operations summary requires operations access and passes the exact date query', async () => {
  const options = makeOptions();
  const app = await startHarness(options);
  try {
    const response = await app.request(
      `${app.base}/admin/api/v1/ops/summary?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, { summary: 'ok' });
    assert.deepEqual(options.calls.summaries, [{ from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }]);
  } finally {
    await app.close();
  }
});

test('catalog endpoints pass only their allow-listed pagination and provider filters', async () => {
  const options = makeOptions({ ...ACTOR, roles: ['security'] });
  const app = await startHarness(options);
  try {
    assert.equal(
      (await app.request(`${app.base}/admin/api/v1/catalog/products?limit=10&cursor=pc1.cursor`)).status,
      200,
    );
    assert.equal(
      (await app.request(`${app.base}/admin/api/v1/catalog/capabilities?limit=2&cursor=pc1.cap&providerId=provider-a`))
        .status,
      200,
    );
    assert.equal(
      (await app.request(`${app.base}/admin/api/v1/catalog/rights?limit=3&providerId=provider-a`)).status,
      200,
    );
    assert.deepEqual(options.calls.products, [{ limit: 10, cursor: 'pc1.cursor' }]);
    assert.deepEqual(options.calls.capabilities, [{ limit: 2, cursor: 'pc1.cap', providerId: 'provider-a' }]);
    assert.deepEqual(options.calls.rights, [{ limit: 3, providerId: 'provider-a' }]);
  } finally {
    await app.close();
  }
});

test('audit events are security-gated and pass only allow-listed filters to the safe read service', async () => {
  const options = makeOptions({ ...ACTOR, roles: ['security'] });
  const app = await startHarness(options);
  try {
    const response = await app.request(
      `${app.base}/admin/api/v1/audit/events?actorId=${AUDIT_EVENT.actorId}&action=api_key.created&entityType=saas_api_key&from=2026-09-01T00:00:00Z&to=2026-09-05T00:00:00Z&limit=10&cursor=pah1.cursor`,
    );
    assert.equal(response.status, 200);
    assertJsonHeaders(response);
    assert.deepEqual(response.body.data, { items: [AUDIT_EVENT], hasMore: false, nextCursor: null });
    assert.deepEqual(options.calls.audits, [
      {
        actorId: AUDIT_EVENT.actorId,
        action: 'api_key.created',
        entityType: 'saas_api_key',
        from: '2026-09-01T00:00:00Z',
        to: '2026-09-05T00:00:00Z',
        limit: 10,
        cursor: 'pah1.cursor',
      },
    ]);
    assert.equal(JSON.stringify(response.body).includes('session-1'), false);
  } finally {
    await app.close();
  }
});

test('missing audit configuration returns a safe 503 without disabling other read routes', async () => {
  const options = makeOptions({ ...ACTOR, roles: ['security'] }, { audit: undefined });
  const app = await startHarness(options);
  try {
    const audit = await app.request(`${app.base}/admin/api/v1/audit/events`);
    assert.equal(audit.status, 503);
    assert.equal(errorBody(audit.body).code, 'AUDIT_UNAVAILABLE');
    assertJsonHeaders(audit);
    assert.equal(options.calls.audits.length, 0);

    const me = await app.request(`${app.base}/admin/api/v1/me`);
    assert.equal(me.status, 200);
  } finally {
    await app.close();
  }
});

test('missing authentication is 401 and role denial is 403 without calling read services', async () => {
  const unauthenticatedOptions = makeOptions(ACTOR, {
    access: { authenticate: async () => undefined },
  });
  const unauthenticatedApp = await startHarness(unauthenticatedOptions);
  try {
    const response = await unauthenticatedApp.request(`${unauthenticatedApp.base}/admin/api/v1/me`);
    assert.equal(response.status, 401);
    assert.equal(errorBody(response.body).code, 'UNAUTHENTICATED');
    assertJsonHeaders(response);
  } finally {
    await unauthenticatedApp.close();
  }

  const deniedOptions = makeOptions({ ...ACTOR, roles: ['finance'] });
  const deniedApp = await startHarness(deniedOptions);
  try {
    const response = await deniedApp.request(`${deniedApp.base}/admin/api/v1/catalog/products`);
    assert.equal(response.status, 403);
    assert.equal(errorBody(response.body).code, 'FORBIDDEN');
    assert.equal(deniedOptions.calls.products.length, 0);

    const audit = await deniedApp.request(`${deniedApp.base}/admin/api/v1/audit/events`);
    assert.equal(audit.status, 403);
    assert.equal(errorBody(audit.body).code, 'FORBIDDEN');
    assert.equal(deniedOptions.calls.audits.length, 0);
  } finally {
    await deniedApp.close();
  }
});

test('superadmin is allowed for operations and catalog reads', async () => {
  const options = makeOptions({ ...ACTOR, roles: ['superadmin'] });
  const app = await startHarness(options);
  try {
    assert.equal((await app.request(`${app.base}/admin/api/v1/ops/summary?from=2026-09-01&to=2026-09-02`)).status, 200);
    assert.equal((await app.request(`${app.base}/admin/api/v1/catalog/products`)).status, 200);
    assert.equal(options.calls.summaries.length, 1);
    assert.equal(options.calls.products.length, 1);
  } finally {
    await app.close();
  }
});

test('rights version registration is operations/superadmin-only, same-origin, CSRF-protected, and audited', async () => {
  const options = makeWriteOptions();
  const app = await startHarness(options);
  try {
    const noOrigin = await app.request(`${app.base}/admin/api/v1/catalog/rights/versions`, {
      ...writeInit(RIGHTS_VERSION_BODY),
      headers: { ...writeInit(RIGHTS_VERSION_BODY).headers, origin: '' },
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(errorBody(noOrigin.body).code, 'ORIGIN_REJECTED');
    assert.equal(options.calls.registrations.length, 0);

    const missingCsrf = await app.request(`${app.base}/admin/api/v1/catalog/rights/versions`, {
      ...writeInit(RIGHTS_VERSION_BODY),
      headers: { ...writeInit(RIGHTS_VERSION_BODY).headers, 'x-csrf-token': '' },
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(errorBody(missingCsrf.body).code, 'CSRF_REJECTED');
    assert.equal(options.calls.registrations.length, 0);

    const denied = await startHarness(makeWriteOptions({ ...WRITE_ACTOR, roles: ['security'] }));
    try {
      const response = await denied.request(
        `${denied.base}/admin/api/v1/catalog/rights/versions`,
        writeInit(RIGHTS_VERSION_BODY),
      );
      assert.equal(response.status, 403);
      assert.equal(errorBody(response.body).code, 'FORBIDDEN');
    } finally {
      await denied.close();
    }

    const response = await app.request(
      `${app.base}/admin/api/v1/catalog/rights/versions`,
      writeInit(RIGHTS_VERSION_BODY),
    );
    assert.equal(response.status, 201);
    assertJsonHeaders(response);
    assert.deepEqual(response.body.data, {
      rightsId: 'rights-a',
      version: 1,
      providerId: 'provider-a',
      productId: 'product-a',
      credentialType: 'api-key',
      supplyMode: 'platform',
      region: 'cn-mainland',
      purpose: 'commercial-api',
      modelScope: ['model-a'],
      endpointScope: ['chat-completions'],
      effectiveAt: '2026-09-01T00:00:00.000Z',
      expiresAt: null,
      status: 'active',
      createdAt: '2026-09-28T00:00:00.000Z',
    });
    assert.equal(JSON.stringify(response.body).includes('evidenceSha256'), false);
    assert.equal(options.calls.registrations.length, 1);
    const input = options.calls.registrations[0] as Record<string, unknown>;
    assert.equal(input.actorUserId, undefined);
    const audit = input.audit as Record<string, unknown>;
    assert.equal(audit.actorUserId, WRITE_ACTOR.userId);
    assert.match(String(audit.requestId), /^platform_admin_write_/);
    assert.equal(audit.sourceIp, '203.0.113.10');
    assert.equal(audit.userAgent, 'platform-admin-test-agent');
    assert.deepEqual(options.calls.csrf, [[WRITE_SESSION_TOKEN, WRITE_CSRF_TOKEN]]);
  } finally {
    await app.close();
  }
});

test('rights writes reject unknown fields, invalid dates/scopes, oversized JSON, and version edits', async () => {
  const options = makeWriteOptions();
  const app = await startHarness(options);
  try {
    const cases: Array<{ body: unknown; code: string }> = [
      { body: { ...RIGHTS_VERSION_BODY, version: 2 }, code: 'INVALID_BODY' },
      { body: { ...RIGHTS_VERSION_BODY, actorUserId: 'body-must-not-be-trusted' }, code: 'INVALID_BODY' },
      { body: { ...RIGHTS_VERSION_BODY, unsupportedPayload: { providerSecret: 'nope' } }, code: 'INVALID_BODY' },
      { body: { ...RIGHTS_VERSION_BODY, effectiveAt: '2026-02-30T00:00:00Z' }, code: 'INVALID_BODY' },
      { body: { ...RIGHTS_VERSION_BODY, modelScope: ['*'] }, code: 'INVALID_BODY' },
      {
        body: { ...RIGHTS_VERSION_BODY, endpointScope: ['chat-completions', 'chat-completions'] },
        code: 'INVALID_BODY',
      },
    ];
    for (const item of cases) {
      const response = await app.request(`${app.base}/admin/api/v1/catalog/rights/versions`, writeInit(item.body));
      assert.equal(response.status, 400);
      assert.equal(errorBody(response.body).code, item.code);
    }

    const oversized = await app.request(`${app.base}/admin/api/v1/catalog/rights/versions`, {
      ...writeInit({ ...RIGHTS_VERSION_BODY, evidenceReference: 'x'.repeat(70 * 1024) }),
      headers: {
        ...writeInit(RIGHTS_VERSION_BODY).headers,
        'content-length': String(70 * 1024),
      },
    });
    assert.equal(oversized.status, 413);
    assert.equal(errorBody(oversized.body).code, 'BODY_TOO_LARGE');
    assert.equal(options.calls.registrations.length, 0);
  } finally {
    await app.close();
  }
});

test('rights revocation appends a new version through the explicit route and never edits a version in place', async () => {
  const options = makeWriteOptions();
  const app = await startHarness(options);
  try {
    const response = await app.request(
      `${app.base}/admin/api/v1/catalog/rights/rights-a/revoke`,
      writeInit(RIGHTS_REVOKE_BODY),
    );
    assert.equal(response.status, 200);
    assertJsonHeaders(response);
    assert.equal((response.body.data as Record<string, unknown>).status, 'revoked');
    assert.equal(options.calls.revocations.length, 1);
    const input = options.calls.revocations[0] as Record<string, unknown>;
    assert.equal(input.rightsId, 'rights-a');
    assert.equal(input.effectiveAt, RIGHTS_REVOKE_BODY.effectiveAt);
    const audit = input.audit as Record<string, unknown>;
    assert.equal(audit.actorUserId, WRITE_ACTOR.userId);
    assert.match(String(audit.requestId), /^platform_admin_write_/);

    const bodyRightsId = await app.request(
      `${app.base}/admin/api/v1/catalog/rights/rights-a/revoke`,
      writeInit({ ...RIGHTS_REVOKE_BODY, rightsId: 'body-rights-id' }),
    );
    assert.equal(bodyRightsId.status, 400);
    assert.equal(errorBody(bodyRightsId.body).code, 'INVALID_BODY');
    assert.equal(options.calls.revocations.length, 1);
  } finally {
    await app.close();
  }
});

test('write paths are discoverably handled and fail closed until transactional writers are injected', async () => {
  const options = makeOptions(WRITE_ACTOR);
  const app = await startHarness(options);
  try {
    const response = await app.request(
      `${app.base}/admin/api/v1/catalog/rights/versions`,
      writeInit(RIGHTS_VERSION_BODY),
    );
    assert.equal(response.status, 503);
    assert.equal(errorBody(response.body).code, 'CATALOG_WRITE_UNAVAILABLE');
    assert.equal(app.unhandled(), 0);
  } finally {
    await app.close();
  }
});

test('known routes reject non-GET methods before authentication', async () => {
  const options = makeOptions(undefined);
  const app = await startHarness(options);
  try {
    const response = await app.request(`${app.base}/admin/api/v1/audit/events`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(errorBody(response.body).code, 'METHOD_NOT_ALLOWED');
    assertJsonHeaders(response);
    assert.equal(options.calls.auth.length, 0);
  } finally {
    await app.close();
  }
});

test('duplicate, unsupported, empty, and invalid integer query values are rejected', async () => {
  const options = makeOptions({ ...ACTOR, roles: ['superadmin'] });
  const app = await startHarness(options);
  const cases = [
    '/admin/api/v1/me?extra=value',
    '/admin/api/v1/ops/summary?from=2026-09-01&from=2026-09-01&to=2026-09-02',
    '/admin/api/v1/ops/summary?from=&to=2026-09-02',
    '/admin/api/v1/catalog/products?limit=not-an-integer',
    '/admin/api/v1/catalog/products?limit=0',
    '/admin/api/v1/catalog/products?limit=1&limit=2',
    '/admin/api/v1/catalog/products?sort=name',
    '/admin/api/v1/catalog/capabilities?providerId=   ',
    '/admin/api/v1/catalog/rights?providerId=',
    '/admin/api/v1/audit/events?pageSize=10',
    '/admin/api/v1/audit/events?limit=101',
    '/admin/api/v1/audit/events?action=',
    '/admin/api/v1/audit/events?from=2026-09-01&from=2026-09-02',
    '/admin/api/v1/audit/events?createdFrom=2026-09-01&from=2026-09-02',
  ];
  try {
    for (const path of cases) {
      const response = await app.request(`${app.base}${path}`);
      assert.equal(response.status, 400, path);
      assert.equal(errorBody(response.body).code, 'INVALID_QUERY', path);
    }
    assert.equal(options.calls.summaries.length, 0);
    assert.equal(options.calls.products.length, 0);
    assert.equal(options.calls.capabilities.length, 0);
    assert.equal(options.calls.rights.length, 0);
    assert.equal(options.calls.audits.length, 0);
  } finally {
    await app.close();
  }
});

test('access and read-service failures are generic and do not leak exception details', async () => {
  const accessFailureOptions = makeOptions();
  accessFailureOptions.access.authenticate = async () => {
    throw new Error('database password=do-not-leak');
  };
  const accessFailureApp = await startHarness(accessFailureOptions);
  try {
    const response = await accessFailureApp.request(`${accessFailureApp.base}/admin/api/v1/me`);
    assert.equal(response.status, 500);
    const error = errorBody(response.body);
    assert.equal(error.code, 'INTERNAL_ERROR');
    assert.equal(error.message, 'The request could not be completed');
    assert.doesNotMatch(JSON.stringify(response.body), /password|do-not-leak/);
  } finally {
    await accessFailureApp.close();
  }

  const serviceFailureOptions = makeOptions();
  serviceFailureOptions.operations.getSummary = async () => {
    throw new Error('secret storage failure');
  };
  const serviceFailureApp = await startHarness(serviceFailureOptions);
  try {
    const response = await serviceFailureApp.request(
      `${serviceFailureApp.base}/admin/api/v1/ops/summary?from=2026-09-01&to=2026-09-02`,
    );
    assert.equal(response.status, 500);
    assert.equal(errorBody(response.body).code, 'INTERNAL_ERROR');
    assert.doesNotMatch(JSON.stringify(response.body), /secret storage failure/);
  } finally {
    await serviceFailureApp.close();
  }
});

test('unknown API paths and auth paths return false to the caller', async () => {
  const options = makeOptions();
  const app = await startHarness(options);
  try {
    const unknown = await app.request(`${app.base}/admin/api/v1/not-a-route`);
    const unknownAudit = await app.request(`${app.base}/admin/api/v1/audit/events/not-a-route`);
    const auth = await app.request(`${app.base}/admin/api/v1/auth/session`);
    assert.equal(unknown.status, 404);
    assert.equal(unknownAudit.status, 404);
    assert.equal(auth.status, 404);
    assert.equal(app.unhandled(), 3);
    assert.equal(options.calls.auth.length, 0);
  } finally {
    await app.close();
  }
});

test('capacity policy routes read and update all scopes with service CAS context and write protections', async () => {
  const options = makeCapacityOptions();
  const app = await startHarness(options);
  const targets = [
    { scope: 'tenant', path: `/admin/api/v1/capacity/tenants/${TENANT_ID}`, revision: '7' },
    {
      scope: 'project',
      path: `/admin/api/v1/capacity/tenants/${TENANT_ID}/projects/${PROJECT_ID}`,
      revision: '13',
    },
    {
      scope: 'api_key',
      path: `/admin/api/v1/capacity/tenants/${TENANT_ID}/projects/${PROJECT_ID}/api-keys/${API_KEY_ID}`,
      revision: '23',
    },
  ] as const;
  try {
    for (const target of targets) {
      const response = await app.request(`${app.base}${target.path}`);
      assert.equal(response.status, 200, target.scope);
      assertJsonHeaders(response);
      const data = response.body.data as Record<string, unknown>;
      assert.equal(data.scope, target.scope);
      assert.equal('secret' in data, false);
    }
    assert.deepEqual(
      options.calls.capacityReads.map((entry) => (entry as { scope: string }).scope),
      ['tenant', 'project', 'api_key'],
    );

    const invalidBody = await app.request(
      `${app.base}${targets[0].path}`,
      capacityWriteInit({ expectedRevision: '7', limits: CAPACITY_LIMITS, reason: 'free_form_reason' }),
    );
    assert.equal(invalidBody.status, 400);
    assert.equal(errorBody(invalidBody.body).code, 'INVALID_BODY');
    assert.equal(options.calls.capacityWrites.length, 0);

    for (const target of targets) {
      const response = await app.request(
        `${app.base}${target.path}`,
        capacityWriteInit({ expectedRevision: target.revision, limits: CAPACITY_LIMITS, reason: 'incident_response' }),
      );
      assert.equal(response.status, 200, target.scope);
      assertJsonHeaders(response);
      const data = response.body.data as Record<string, unknown>;
      assert.equal(data.scope, target.scope);
      assert.equal('actor' in data, false);
      assert.equal('secret' in data, false);
      const write = options.calls.capacityWrites.at(-1) as {
        scope: string;
        input: Record<string, unknown>;
      };
      assert.equal(write.scope, target.scope);
      assert.equal(write.input.expectedRevision, target.revision);
      assert.deepEqual(write.input.limits, CAPACITY_LIMITS);
      assert.equal(write.input.reason, 'incident_response');
      assert.equal(write.input.actor, WRITE_ACTOR);
      assert.match(String(write.input.requestId), /^[0-9a-f-]{36}$/iu);
      assert.equal(write.input.requestId, requestId(response.body));
    }
    assert.equal(options.calls.capacityWrites.length, 3);
    assert.equal(options.calls.csrf.length, 4);
  } finally {
    await app.close();
  }
});

test('capacity policy selectors are operations-only, scoped, paged, and identifier-only', async () => {
  const tenantIds = Array.from(
    { length: 26 },
    (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  );
  const selectorCalls: unknown[] = [];
  const options = makeCapacityOptions(
    WRITE_ACTOR,
    {},
    {
      listTenantIds: async (afterId, limit) => {
        selectorCalls.push({ scope: 'tenant', afterId, limit });
        return tenantIds.slice(0, limit);
      },
      listProjectIds: async (tenantId, afterId, limit) => {
        selectorCalls.push({ scope: 'project', tenantId, afterId, limit });
        return [PROJECT_ID];
      },
      listApiKeyIds: async (tenantId, projectId, afterId, limit) => {
        selectorCalls.push({ scope: 'api_key', tenantId, projectId, afterId, limit });
        return [API_KEY_ID];
      },
    },
  );
  const app = await startHarness(options);
  try {
    const tenants = await app.request(`${app.base}/admin/api/v1/capacity/targets/tenants`);
    assert.equal(tenants.status, 200);
    const tenantPage = tenants.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null };
    assert.equal(tenantPage.items.length, 25);
    assert.equal(tenantPage.nextCursor, tenantPage.items.at(-1)?.id);
    assert.deepEqual(tenantPage.items[0], { id: tenantIds[0] });
    assert.equal(JSON.stringify(tenantPage).includes('secret'), false);
    assert.deepEqual(selectorCalls[0], { scope: 'tenant', afterId: undefined, limit: 26 });

    const projects = await app.request(
      `${app.base}/admin/api/v1/capacity/targets/tenants/${TENANT_ID}/projects?cursor=${PROJECT_ID}`,
    );
    assert.equal(projects.status, 200);
    assert.deepEqual((projects.body.data as { items: unknown[] }).items, [{ id: PROJECT_ID }]);
    assert.deepEqual(selectorCalls[1], {
      scope: 'project',
      tenantId: TENANT_ID,
      afterId: PROJECT_ID,
      limit: 26,
    });

    const keys = await app.request(
      `${app.base}/admin/api/v1/capacity/targets/tenants/${TENANT_ID}/projects/${PROJECT_ID}/api-keys`,
    );
    assert.equal(keys.status, 200);
    assert.deepEqual((keys.body.data as { items: unknown[] }).items, [{ id: API_KEY_ID }]);
    assert.deepEqual(selectorCalls[2], {
      scope: 'api_key',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      afterId: undefined,
      limit: 26,
    });
    assert.equal(options.calls.capacityReads.length, 0);

    const deniedOptions = makeCapacityOptions({ ...WRITE_ACTOR, roles: ['support-readonly'] });
    const denied = await startHarness(deniedOptions);
    try {
      const deniedResponse = await denied.request(`${denied.base}/admin/api/v1/capacity/targets/tenants`);
      assert.equal(deniedResponse.status, 403);
      assert.equal(errorBody(deniedResponse.body).code, 'FORBIDDEN');
      const deniedPolicy = await denied.request(`${denied.base}/admin/api/v1/capacity/tenants/${TENANT_ID}`);
      assert.equal(deniedPolicy.status, 403);
      assert.equal(errorBody(deniedPolicy.body).code, 'FORBIDDEN');
      assert.equal(deniedOptions.calls.capacityTargetReads.length, 0);
      assert.equal(deniedOptions.calls.capacityReads.length, 0);
    } finally {
      await denied.close();
    }

    const superadminOptions = makeCapacityOptions({ ...WRITE_ACTOR, roles: ['superadmin'] });
    const superadmin = await startHarness(superadminOptions);
    try {
      assert.equal((await superadmin.request(`${superadmin.base}/admin/api/v1/capacity/targets/tenants`)).status, 200);
      assert.equal(
        (await superadmin.request(`${superadmin.base}/admin/api/v1/capacity/tenants/${TENANT_ID}`)).status,
        200,
      );
    } finally {
      await superadmin.close();
    }
  } finally {
    await app.close();
  }
});

test('capacity policy writes reject missing Origin/CSRF and return structured CAS conflicts', async () => {
  const conflictCalls: unknown[] = [];
  const options = makeCapacityOptions(WRITE_ACTOR, {
    setProjectPolicy: async (input) => {
      conflictCalls.push(input);
      throw new CapacityPolicyError('CAS_CONFLICT', 'The policy revision changed');
    },
  });
  const app = await startHarness(options);
  const path = `/admin/api/v1/capacity/tenants/${TENANT_ID}/projects/${PROJECT_ID}`;
  const body = { expectedRevision: '13', limits: CAPACITY_LIMITS, reason: 'capacity_adjustment' };
  try {
    const missingOrigin = await app.request(`${app.base}${path}`, {
      method: 'PUT',
      headers: {
        host: 'platform-admin.test',
        cookie: `mr_platform_admin_session=${WRITE_SESSION_TOKEN}; mr_platform_admin_csrf=${WRITE_CSRF_TOKEN}`,
        'x-csrf-token': WRITE_CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal(errorBody(missingOrigin.body).code, 'ORIGIN_REQUIRED');
    assert.equal(options.calls.auth.length, 0);

    const missingCsrf = await app.request(`${app.base}${path}`, capacityWriteInit(body, { 'x-csrf-token': '' }));
    assert.equal(missingCsrf.status, 403);
    assert.equal(errorBody(missingCsrf.body).code, 'CSRF_REJECTED');
    assert.equal(options.calls.capacityWrites.length, 0);

    const conflict = await app.request(`${app.base}${path}`, capacityWriteInit(body));
    assert.equal(conflict.status, 409);
    const error = errorBody(conflict.body);
    assert.equal(error.code, 'CAS_CONFLICT');
    assert.match(error.message, /revision changed/u);
    assert.match(error.requestId, /^[0-9a-f-]{36}$/iu);
    assert.equal(conflictCalls.length, 1);
  } finally {
    await app.close();
  }
});
