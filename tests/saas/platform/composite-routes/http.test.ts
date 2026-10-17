import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  SaasCompositeModelRoutesError,
  type SaasCompositeModelRoutesService,
} from '../../../../src/saas/billing/composite-routes/service.js';
import type { CompositeModelRoute } from '../../../../src/saas/gateway/composite-route-resolver.js';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/types.js';
import {
  type CompositeModelRoutesHttpOptions,
  createCompositeModelRoutesHttpHandler,
} from '../../../../src/saas/platform/composite-routes-http.js';

/*
 * §4.4 composite model routing (task #18) — the operator surface: registry
 * CRUD plus the three-level resolution preview. The contract mirrors the
 * billing-groups http.ts shape exactly (the 105 admin surface precedent).
 */

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const ACTOR: PlatformAdminActor = {
  userId: 'platform-user-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

function routeRow(overrides: Partial<CompositeModelRoute> = {}): CompositeModelRoute {
  return {
    id: '1',
    groupId: 'composite-a',
    publicModel: 'all/gpt-5',
    matchType: 'exact',
    targetPlatform: 'openai-codex',
    upstreamModel: 'gpt-5.1',
    endpoint: 'responses',
    priority: 100,
    enabled: true,
    notes: 'bundled plan alias',
    ...overrides,
  };
}

interface ServiceCall {
  readonly action: string;
  readonly input: unknown;
}

interface Harness {
  readonly request: (
    path: string,
    body: unknown,
    overrides?: { method?: string; actor?: PlatformAdminActor | undefined; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: Record<string, unknown>; handled: boolean }>;
  readonly calls: ServiceCall[];
  readonly auditCalls: Array<{ action: string; targetId: string; actorUserId: string }>;
}

function harness(): Harness {
  const calls: ServiceCall[] = [];
  const auditCalls: Array<{ action: string; targetId: string; actorUserId: string }> = [];
  const routes = new Map<string, CompositeModelRoute>();
  const service = {
    async listRoutes(groupId: string, options: { readonly includeDisabled?: boolean } = {}) {
      calls.push({ action: 'list', input: { groupId, options } });
      return [...routes.values()].filter((route) => options.includeDisabled || route.enabled);
    },
    async createRoute(input: Parameters<SaasCompositeModelRoutesService['createRoute']>[0]) {
      calls.push({ action: 'create', input });
      const shape = `${input.groupId}|${input.publicModel}|${input.matchType}|${input.endpoint}`;
      if (routes.has(shape)) throw new SaasCompositeModelRoutesError('ROUTE_CONFLICT');
      const record = routeRow({ ...input, id: '5' });
      routes.set(shape, record);
      return record;
    },
    async updateRoute(routeId: string, input: Parameters<SaasCompositeModelRoutesService['updateRoute']>[1]) {
      calls.push({ action: 'update', input: { routeId, ...input } });
      const existing = routes.get(`${input.groupId}|${input.publicModel}|${input.matchType}|${input.endpoint}`);
      if (!existing) throw new SaasCompositeModelRoutesError('ROUTE_NOT_FOUND');
      return routeRow({ ...input, id: routeId });
    },
    async deleteRoute(routeId: string) {
      calls.push({ action: 'delete', input: routeId });
      if (routeId !== '5') throw new SaasCompositeModelRoutesError('ROUTE_NOT_FOUND');
    },
    async previewRoute(input: Parameters<SaasCompositeModelRoutesService['previewRoute']>[0]) {
      calls.push({ action: 'preview', input });
      if (input.groupId === 'missing') throw new SaasCompositeModelRoutesError('GROUP_NOT_FOUND');
      if (input.groupId === 'plain') throw new SaasCompositeModelRoutesError('GROUP_NOT_COMPOSITE');
      return {
        decision: {
          matched: true,
          source: 'route',
          groupId: input.groupId,
          publicModel: input.model,
          targetPlatform: 'openai-codex',
          upstreamModel: 'gpt-5.1',
          endpoint: 'responses',
          routeId: '5',
          reason: '',
        },
        routeCount: routes.size,
      };
    },
  } as unknown as Pick<
    SaasCompositeModelRoutesService,
    'listRoutes' | 'createRoute' | 'updateRoute' | 'deleteRoute' | 'previewRoute'
  >;

  let currentActor: PlatformAdminActor | undefined = ACTOR;
  const options: CompositeModelRoutesHttpOptions = {
    access: { authenticate: async () => currentActor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION && csrfToken === CSRF,
    },
    service,
    async audit(input) {
      auditCalls.push({ action: input.action, targetId: input.targetId, actorUserId: input.actorUserId });
    },
    publicOrigin: ORIGIN,
  };
  const handler = createCompositeModelRoutesHttpHandler(options);

  return {
    calls,
    auditCalls,
    async request(path, body, overrides = {}) {
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

function validRouteBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupId: 'composite-a',
    publicModel: 'all/gpt-5',
    matchType: 'exact',
    targetPlatform: 'openai-codex',
    upstreamModel: 'gpt-5.1',
    endpoint: 'responses',
    priority: 100,
    enabled: true,
    notes: 'bundled plan alias',
    ...overrides,
  };
}

test('list returns the group registry with includeDisabled surfaced separately', async () => {
  const { request, calls } = harness();
  const enabled = await request('/admin/api/v1/composite-routes/list', { groupId: 'composite-a' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.handled, true);
  assert.ok(Array.isArray((enabled.body.data as { routes: unknown[] }).routes));
  assert.deepEqual(calls[0]?.input, { groupId: 'composite-a', options: { includeDisabled: false } });

  const all = await request('/admin/api/v1/composite-routes/list', {
    groupId: 'composite-a',
    includeDisabled: true,
  });
  assert.equal(all.status, 200);
  assert.deepEqual(calls[1]?.input, { groupId: 'composite-a', options: { includeDisabled: true } });
});

test('create and update persist route rows and write best-effort audit', async () => {
  const { request, calls, auditCalls } = harness();
  const created = await request('/admin/api/v1/composite-routes/create', validRouteBody());
  assert.equal(created.status, 200);
  assert.equal((created.body.data as { route: { id: string } }).route.id, '5');
  assert.equal(calls[0]?.action, 'create');

  const updated = await request('/admin/api/v1/composite-routes/update', {
    routeId: '5',
    ...validRouteBody({ priority: 10 }),
  });
  assert.equal(updated.status, 200);
  assert.equal((updated.body.data as { route: { priority: number } }).route.priority, 10);
  assert.equal(calls[1]?.action, 'update');
  assert.deepEqual(
    auditCalls.map(({ action }) => action),
    ['saas_composite_model_route.created', 'saas_composite_model_route.updated'],
  );
});

test('create rejects unknown target platforms and malformed shapes', async () => {
  const { request } = harness();
  for (const [body, code] of [
    [validRouteBody({ targetPlatform: 'openai' }), 'INVALID_BODY'],
    [validRouteBody({ matchType: 'regex' }), 'INVALID_BODY'],
    [validRouteBody({ endpoint: 'embeddings' }), 'INVALID_BODY'],
    [validRouteBody({ priority: -1 }), 'INVALID_BODY'],
    [validRouteBody({ extra: 1 }), 'INVALID_BODY'],
  ] as const) {
    const result = await request('/admin/api/v1/composite-routes/create', body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal((result.body.error as { code: string }).code, code);
  }
});

test('delete removes a row and maps service errors onto stable envelopes', async () => {
  const { request } = harness();
  const deleted = await request('/admin/api/v1/composite-routes/delete', { groupId: 'composite-a', routeId: '5' });
  assert.equal(deleted.status, 200);
  const missing = await request('/admin/api/v1/composite-routes/delete', { groupId: 'composite-a', routeId: '9' });
  assert.equal(missing.status, 404);
  assert.equal((missing.body.error as { code: string }).code, 'COMPOSITE_ROUTE_ROUTE_NOT_FOUND');
});

test('preview runs the three-level resolution and returns the matched level', async () => {
  const { request, calls } = harness();
  const preview = await request('/admin/api/v1/composite-routes/preview', {
    groupId: 'composite-a',
    model: 'all/gpt-5',
    endpoint: 'responses',
  });
  assert.equal(preview.status, 200);
  assert.deepEqual((preview.body.data as { decision: unknown }).decision, {
    matched: true,
    source: 'route',
    groupId: 'composite-a',
    publicModel: 'all/gpt-5',
    targetPlatform: 'openai-codex',
    upstreamModel: 'gpt-5.1',
    endpoint: 'responses',
    routeId: '5',
    reason: '',
  });
  assert.equal(calls[0]?.action, 'preview');

  const notComposite = await request('/admin/api/v1/composite-routes/preview', {
    groupId: 'plain',
    model: 'all/gpt-5',
    endpoint: 'responses',
  });
  assert.equal(notComposite.status, 409);
  assert.equal((notComposite.body.error as { code: string }).code, 'COMPOSITE_ROUTE_GROUP_NOT_COMPOSITE');
});

test('auth, origin, CSRF and method stay fail-closed', async () => {
  const { request } = harness();
  const unauthenticated = await request(
    '/admin/api/v1/composite-routes/list',
    { groupId: 'composite-a' },
    {
      actor: undefined,
    },
  );
  assert.equal(unauthenticated.status, 401);

  const crossOrigin = await request(
    '/admin/api/v1/composite-routes/list',
    { groupId: 'composite-a' },
    {
      headers: { origin: 'https://evil.test' },
    },
  );
  assert.equal(crossOrigin.status, 403);

  const noCsrf = await request('/admin/api/v1/composite-routes/create', validRouteBody(), {
    headers: { 'x-csrf-token': 'wrong' },
  });
  assert.equal(noCsrf.status, 403);

  const wrongMethod = await request('/admin/api/v1/composite-routes/list', undefined, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);

  // Unrelated paths fall through (handled false).
  const other = await request('/admin/api/v1/billing-groups/list', {});
  assert.equal(other.handled, false);
});
