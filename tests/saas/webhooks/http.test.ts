import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { afterEach, test } from 'node:test';
import { SaasIdentityError } from '../../../src/saas/identity/errors.js';
import type { TenantContext } from '../../../src/saas/identity/types.js';
import type {
  CreatedCustomerWebhookEndpoint,
  CustomerWebhookEndpointMetadata,
  CustomerWebhookSigningSecretMetadata,
} from '../../../src/saas/webhooks/endpoint-service.js';
import {
  type CustomerWebhookHttpHandler,
  type CustomerWebhookHttpOptions,
  createCustomerWebhookHandler,
} from '../../../src/saas/webhooks/http.js';

const SESSION_TOKEN = 'valid-customer-session-token';
const CSRF_TOKEN = 'valid-customer-csrf-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT_A = '22222222-2222-4222-8222-222222222222';
const ENDPOINT_B = '33333333-3333-4333-8333-333333333333';

const testServers = new Set<Server>();

function closeTestServer(server: Server): Promise<void> {
  if (!server.listening) {
    testServers.delete(server);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      testServers.delete(server);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function listenTestServer(server: Server): Promise<string> {
  testServers.add(server);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  } catch (error) {
    await closeTestServer(server);
    throw error;
  }
}

afterEach(async () => {
  const results = await Promise.allSettled([...testServers].map(closeTestServer));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});

function endpoint(endpointId: string, state: CustomerWebhookEndpointMetadata['state'] = 'active') {
  return {
    tenantId: TENANT_A,
    endpointId,
    currentVersion: 3,
    state,
    targetUrl: 'https://hooks.example.test/customer-events',
    eventTypes: ['request.completed'] as const,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  } satisfies CustomerWebhookEndpointMetadata;
}

function secret(version: number, state: CustomerWebhookSigningSecretMetadata['state']) {
  return {
    endpointId: ENDPOINT_A,
    version,
    state,
    overlapExpiresAt: state === 'overlap' ? '2026-09-22T12:00:00.000Z' : null,
    createdAt: '2026-09-20T12:00:00.000Z',
  } satisfies CustomerWebhookSigningSecretMetadata;
}

async function createServer(
  settings: {
    readonly role?: TenantContext['tenantRole'];
    readonly memberTenant?: string;
    readonly failCreate?: boolean;
    readonly deliveryRows?: readonly Record<string, unknown>[];
    readonly missingEndpointId?: string;
  } = {},
) {
  const calls: {
    readonly contexts: Array<{ readonly userId: string; readonly tenantId: string }>;
    readonly actors: Array<{ readonly operation: string; readonly actor: unknown; readonly endpointId?: string }>;
    readonly listQueries: unknown[][];
    readonly deliveryQueries: Array<{ readonly sql: string; readonly values: unknown[] }>;
  } = { contexts: [], actors: [], listQueries: [], deliveryQueries: [] };
  const endpointService: CustomerWebhookHttpOptions['endpointService'] = {
    createEndpoint: async (actor, input) => {
      calls.actors.push({ operation: 'create', actor, endpointId: undefined });
      if (settings.failCreate) throw new Error('kms response contained forbidden-secret-material');
      assert.equal(input.targetUrl, 'https://hooks.example.test/customer-events');
      return {
        endpoint: endpoint(ENDPOINT_A),
        signingSecret: 'only-shown-once-secret-value',
        signingSecretVersion: 1,
      } satisfies CreatedCustomerWebhookEndpoint;
    },
    updateEndpoint: async (actor, endpointId, input) => {
      calls.actors.push({ operation: 'update', actor, endpointId });
      assert.equal(input.targetUrl, 'https://hooks.example.test/customer-events');
      assert.deepEqual(input.eventTypes, ['request.completed']);
      return endpoint(endpointId);
    },
    setEndpointState: async (actor, endpointId, state) => {
      calls.actors.push({ operation: state, actor, endpointId });
      return endpoint(endpointId, state);
    },
    rotateSigningSecret: async (actor, endpointId, overlapMs) => {
      calls.actors.push({ operation: `rotate:${overlapMs}`, actor, endpointId });
      return { signingSecret: 'rotated-only-once-secret', signingSecretVersion: 4 };
    },
    revokeSigningSecret: async (actor, endpointId, version) => {
      calls.actors.push({ operation: `revoke-secret:${version}`, actor, endpointId });
    },
    readEndpoint: async (actor, endpointId) => {
      calls.actors.push({ operation: 'read', actor, endpointId });
      if (endpointId === settings.missingEndpointId) throw new Error('WEBHOOK_ENDPOINT_NOT_FOUND');
      return endpoint(endpointId);
    },
    listSigningSecretMetadata: async (_actor, endpointId) => [
      secret(4, 'current'),
      { ...secret(3, 'revoked'), endpointId },
    ],
  };
  const options: CustomerWebhookHttpOptions = {
    service: {
      getSession: async (token) =>
        token === SESSION_TOKEN
          ? {
              userId: USER_ID,
              activeTenantId: null,
              expiresAt: '2099-01-01T00:00:00.000Z',
              createdAt: '2026-09-20T12:00:00.000Z',
            }
          : undefined,
      verifyCsrfToken: async (token, csrf) => token === SESSION_TOKEN && csrf === CSRF_TOKEN,
      resolveTenantContext: async ({ userId, tenantId }) => {
        calls.contexts.push({ userId, tenantId });
        if (tenantId !== (settings.memberTenant ?? TENANT_A)) {
          throw new SaasIdentityError(404, 'TENANT_ACCESS_DENIED');
        }
        return {
          userId,
          tenantId,
          projectId: '44444444-4444-4444-8444-444444444444',
          tenantRole: settings.role ?? 'owner',
          projectRole: 'viewer',
        };
      },
    },
    database: {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('FROM saas_customer_webhook_deliveries AS delivery')) {
          const parameters = [...values];
          calls.deliveryQueries.push({ sql, values: parameters });
          const cursorCreatedAt = parameters[2] === null ? undefined : new Date(String(parameters[2])).toISOString();
          const cursorEventId = parameters[3] === null ? undefined : String(parameters[3]);
          const rows = [...(settings.deliveryRows ?? [])]
            .filter((row) => {
              if (!cursorCreatedAt || !cursorEventId) return true;
              const createdAt = new Date(String(row.cursor_created_at)).toISOString();
              return (
                createdAt < cursorCreatedAt ||
                (createdAt === cursorCreatedAt && String(row.cursor_event_id) < cursorEventId)
              );
            })
            .sort((left, right) => {
              const byTime =
                new Date(String(right.cursor_created_at)).getTime() -
                new Date(String(left.cursor_created_at)).getTime();
              return byTime || String(right.cursor_event_id).localeCompare(String(left.cursor_event_id));
            })
            .slice(0, Number(parameters[4]));
          return { rows: rows as Row[], rowCount: rows.length };
        }
        calls.listQueries.push([...values]);
        const limit = Number(values[2] ?? 51);
        const endpointIds = [ENDPOINT_A, ENDPOINT_B].slice(0, limit);
        return {
          rows: endpointIds.map((endpoint_id) => ({ endpoint_id })) as Row[],
          rowCount: endpointIds.length,
        };
      },
    },
    endpointService,
    publicOrigin: 'http://127.0.0.1:1',
  };
  let handler: CustomerWebhookHttpHandler;
  const server = http.createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      }
    });
  });
  const origin = await listenTestServer(server);
  handler = createCustomerWebhookHandler({ ...options, publicOrigin: origin });
  return { origin, calls };
}

function sessionHeaders(origin: string): Record<string, string> {
  return {
    cookie: `mr_saas_session=${SESSION_TOKEN}`,
    origin,
  };
}

function writeHeaders(origin: string): Record<string, string> {
  return {
    ...sessionHeaders(origin),
    cookie: `mr_saas_session=${SESSION_TOKEN}; mr_saas_csrf=${CSRF_TOKEN}`,
    'x-csrf-token': CSRF_TOKEN,
    'content-type': 'application/json',
  };
}

test('lists only the authenticated tenant and returns endpoint allowlists without internal metadata', async () => {
  const app = await createServer();
  const response = await fetch(`${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks?limit=1`, {
    headers: sessionHeaders(app.origin),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null };
  };
  assert.deepEqual(body.data?.items?.[0], {
    endpointId: ENDPOINT_A,
    currentVersion: 3,
    state: 'active',
    targetUrl: 'https://hooks.example.test/customer-events',
    eventTypes: ['request.completed'],
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
  });
  assert.equal(body.data?.nextCursor, ENDPOINT_A);
  assert.deepEqual(app.calls.listQueries[0], [TENANT_A, null, 2]);
  assert.equal(app.calls.actors[0]?.actor && (app.calls.actors[0].actor as { tenantId: string }).tenantId, TENANT_A);

  const crossTenant = await fetch(`${app.origin}/console/api/v1/tenants/${TENANT_B}/webhooks`, {
    headers: sessionHeaders(app.origin),
  });
  assert.equal(crossTenant.status, 404);
  assert.equal(app.calls.listQueries.length, 1);
});

test('endpoint and signing-secret reads return only public metadata', async () => {
  const app = await createServer();
  const base = `${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks/${ENDPOINT_A}`;
  const endpointResponse = await fetch(base, { headers: sessionHeaders(app.origin) });
  assert.equal(endpointResponse.status, 200);
  const endpointBody = (await endpointResponse.json()) as { data?: Record<string, unknown> };
  assert.deepEqual(Object.keys(endpointBody.data ?? {}).sort(), [
    'createdAt',
    'currentVersion',
    'endpointId',
    'eventTypes',
    'state',
    'targetUrl',
    'updatedAt',
  ]);
  assert.equal('tenantId' in (endpointBody.data ?? {}), false);
  assert.equal('signingSecret' in (endpointBody.data ?? {}), false);

  const secretsResponse = await fetch(`${base}/secrets`, { headers: sessionHeaders(app.origin) });
  assert.equal(secretsResponse.status, 200);
  const secretsBody = (await secretsResponse.json()) as { data?: { items?: Array<Record<string, unknown>> } };
  assert.deepEqual(Object.keys(secretsBody.data?.items?.[0] ?? {}).sort(), [
    'createdAt',
    'overlapExpiresAt',
    'state',
    'version',
  ]);
  assert.equal(JSON.stringify(secretsBody.data).includes('endpointId'), false);
  assert.equal(JSON.stringify(secretsBody.data).includes('signingSecret'), false);
});

test('delivery history is session and tenant scoped, paginated, and returns only the safe summary DTO', async () => {
  const eventOne = '44444444-4444-4444-8444-444444444444';
  const eventTwo = '55555555-5555-4555-8555-555555555555';
  const app = await createServer({
    role: 'viewer',
    deliveryRows: [
      {
        event_type: 'request.completed',
        occurred_at: new Date('2026-09-29T11:58:00.000Z'),
        cursor_created_at: new Date('2026-09-29T11:59:00.000Z'),
        cursor_event_id: eventOne,
        status: 'delivered',
        attempts: 2,
        last_http_status: 204,
        last_latency_ms: 85,
        last_error_code: null,
        payload: { private: 'payload-must-not-leak' },
        target_url: 'https://hooks.example.test/private-target-must-not-leak',
      },
      {
        event_type: 'usage.completed',
        occurred_at: new Date('2026-09-29T11:57:00.000Z'),
        cursor_created_at: new Date('2026-09-29T11:58:00.000Z'),
        cursor_event_id: eventTwo,
        status: 'dead_lettered',
        attempts: 12,
        last_http_status: 503,
        last_latency_ms: 300000,
        last_error_code: 'HTTP_STATUS_REJECTED',
        payload: { private: 'another-payload-must-not-leak' },
        target_url: 'https://hooks.example.test/another-private-target-must-not-leak',
      },
    ],
  });
  const base = `${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks/${ENDPOINT_A}/deliveries`;

  const unauthenticated = await fetch(
    `${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks/${ENDPOINT_A}/deliveries`,
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(app.calls.deliveryQueries.length, 0);

  const first = await fetch(`${base}?limit=1`, { headers: sessionHeaders(app.origin) });
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null; hasMore?: boolean };
  };
  assert.deepEqual(firstBody.data?.items, [
    {
      eventType: 'request.completed',
      occurredAt: '2026-09-29T11:58:00.000Z',
      status: 'delivered',
      attempts: 2,
      lastHttpStatus: 204,
      lastLatencyMs: 85,
      lastErrorCode: null,
    },
  ]);
  assert.equal(firstBody.data?.hasMore, true);
  assert.equal(typeof firstBody.data?.nextCursor, 'string');
  const firstText = JSON.stringify(firstBody.data);
  assert.doesNotMatch(firstText, /payload|target_url|hooks\.example\.test|44444444-4444-4444-8444-444444444444/);
  assert.deepEqual(app.calls.deliveryQueries[0]?.values, [TENANT_A, ENDPOINT_A, null, null, 2]);
  assert.doesNotMatch(app.calls.deliveryQueries[0]?.sql ?? '', /payload|target_url/i);
  assert.match(app.calls.deliveryQueries[0]?.sql ?? '', /delivery\.tenant_id = \$1 AND delivery\.endpoint_id = \$2/);

  const nextCursor = firstBody.data?.nextCursor;
  assert.ok(nextCursor);
  const second = await fetch(`${base}?limit=1&cursor=${encodeURIComponent(nextCursor)}`, {
    headers: sessionHeaders(app.origin),
  });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as {
    data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null; hasMore?: boolean };
  };
  assert.deepEqual(secondBody.data?.items, [
    {
      eventType: 'usage.completed',
      occurredAt: '2026-09-29T11:57:00.000Z',
      status: 'dead_lettered',
      attempts: 12,
      lastHttpStatus: 503,
      lastLatencyMs: 300000,
      lastErrorCode: 'HTTP_STATUS_REJECTED',
    },
  ]);
  assert.equal(secondBody.data?.nextCursor, null);
  assert.equal(secondBody.data?.hasMore, false);
  assert.equal(app.calls.deliveryQueries[1]?.values[0], TENANT_A);
  assert.equal(app.calls.deliveryQueries[1]?.values[1], ENDPOINT_A);
  assert.equal(typeof app.calls.deliveryQueries[1]?.values[2], 'string');
  assert.equal(app.calls.actors.filter((call) => call.operation === 'read').length, 2);

  const crossTenant = await fetch(
    `${app.origin}/console/api/v1/tenants/${TENANT_B}/webhooks/${ENDPOINT_A}/deliveries`,
    { headers: sessionHeaders(app.origin) },
  );
  assert.equal(crossTenant.status, 404);
  assert.equal(app.calls.deliveryQueries.length, 2);
});

test('delivery history rejects invalid pagination and endpoints outside the active tenant', async () => {
  const missingEndpoint = '66666666-6666-4666-8666-666666666666';
  const app = await createServer({ missingEndpointId: missingEndpoint });
  const base = `${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks/${ENDPOINT_A}/deliveries`;
  for (const suffix of ['?limit=0', '?limit=101', '?cursor=not-a-cursor', '?limit=2&limit=3']) {
    const response = await fetch(`${base}${suffix}`, { headers: sessionHeaders(app.origin) });
    assert.equal(response.status, 400);
  }
  assert.equal(app.calls.deliveryQueries.length, 0);

  const missing = await fetch(
    `${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks/${missingEndpoint}/deliveries`,
    { headers: sessionHeaders(app.origin) },
  );
  assert.equal(missing.status, 404);
  assert.equal(app.calls.deliveryQueries.length, 0);
});

test('requires session-backed CSRF and exact Origin for writes and rejects tenant authority in JSON', async () => {
  const app = await createServer();
  const path = `/console/api/v1/tenants/${TENANT_A}/webhooks`;
  const body = JSON.stringify({
    targetUrl: 'https://hooks.example.test/customer-events',
    eventTypes: ['request.completed'],
  });

  const missingCsrf = await fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: { ...sessionHeaders(app.origin), 'content-type': 'application/json' },
    body,
  });
  assert.equal(missingCsrf.status, 403);

  const wrongOrigin = await fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: { ...writeHeaders('http://evil.example'), origin: 'http://evil.example' },
    body,
  });
  assert.equal(wrongOrigin.status, 403);

  const forgedTenant = await fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: writeHeaders(app.origin),
    body: JSON.stringify({
      targetUrl: 'https://hooks.example.test/customer-events',
      eventTypes: ['request.completed'],
      tenantId: TENANT_B,
    }),
  });
  assert.equal(forgedTenant.status, 400);

  const created = await fetch(`${app.origin}${path}`, {
    method: 'POST',
    headers: writeHeaders(app.origin),
    body,
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { data?: Record<string, unknown> };
  assert.equal(createdBody.data?.signingSecret, 'only-shown-once-secret-value');
  assert.equal(createdBody.data?.signingSecretVersion, 1);
  assert.equal('tenantId' in ((createdBody.data?.endpoint ?? {}) as Record<string, unknown>), false);
  assert.deepEqual(
    app.calls.actors.map((call) => call.operation),
    ['create'],
  );
  const createCall = app.calls.actors[0];
  assert.ok(createCall);
  assert.equal((createCall.actor as { actorUserId: string }).actorUserId, USER_ID);
});

test('requires owner or admin for configuration actions and composes lifecycle service methods', async () => {
  const viewer = await createServer({ role: 'viewer' });
  const denied = await fetch(`${viewer.origin}/console/api/v1/tenants/${TENANT_A}/webhooks`, {
    method: 'POST',
    headers: writeHeaders(viewer.origin),
    body: JSON.stringify({
      targetUrl: 'https://hooks.example.test/customer-events',
      eventTypes: ['request.completed'],
    }),
  });
  assert.equal(denied.status, 403);
  assert.equal(viewer.calls.actors.length, 0);

  const app = await createServer();
  const base = `${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks/${ENDPOINT_A}`;
  const patchBody = JSON.stringify({
    targetUrl: 'https://hooks.example.test/customer-events',
    eventTypes: ['request.completed'],
  });
  const patchWithoutCsrf = await fetch(base, {
    method: 'PATCH',
    headers: { ...sessionHeaders(app.origin), 'content-type': 'application/json' },
    body: patchBody,
  });
  assert.equal(patchWithoutCsrf.status, 403);
  assert.equal(
    app.calls.actors.some((call) => call.operation === 'update'),
    false,
  );
  const patch = await fetch(base, { method: 'PATCH', headers: writeHeaders(app.origin), body: patchBody });
  assert.equal(patch.status, 200);
  const requests = [
    fetch(`${base}/disable`, { method: 'POST', headers: writeHeaders(app.origin), body: '{}' }),
    fetch(`${base}/enable`, { method: 'POST', headers: writeHeaders(app.origin), body: '{}' }),
    fetch(`${base}/revoke`, { method: 'POST', headers: writeHeaders(app.origin), body: '{}' }),
    fetch(`${base}/rotate`, {
      method: 'POST',
      headers: writeHeaders(app.origin),
      body: JSON.stringify({ overlapMs: 1000 }),
    }),
    fetch(`${base}/secrets/3/revoke`, { method: 'POST', headers: writeHeaders(app.origin), body: '{}' }),
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200, 200],
  );
  const rotation = (await responses[3]?.json()) as { data?: Record<string, unknown> };
  assert.equal(rotation.data?.signingSecret, 'rotated-only-once-secret');
  assert.deepEqual(
    app.calls.actors.map((call) => call.operation).sort(),
    ['active', 'revoke-secret:3', 'revoked', 'rotate:1000', 'suspended', 'update'].sort(),
  );
});

test('maps service failures to safe responses without leaking protector or request details', async () => {
  const app = await createServer({ failCreate: true });
  const response = await fetch(`${app.origin}/console/api/v1/tenants/${TENANT_A}/webhooks`, {
    method: 'POST',
    headers: writeHeaders(app.origin),
    body: JSON.stringify({
      targetUrl: 'https://hooks.example.test/customer-events',
      eventTypes: ['request.completed'],
    }),
  });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(text, /forbidden-secret-material|kms response/i);
  assert.match(text, /INTERNAL_ERROR/);
});
