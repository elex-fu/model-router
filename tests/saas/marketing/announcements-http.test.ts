import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { MarketingAnnouncementError } from '../../../src/saas/marketing/announcements.js';
import {
  createMarketingAnnouncementCustomerHttpHandler,
  createMarketingAnnouncementPlatformHttpHandler,
  type MarketingAnnouncementCustomerOperations,
  type MarketingAnnouncementOpsOperations,
} from '../../../src/saas/marketing/announcements-http.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

const OPS_ORIGIN = 'https://platform-admin.test';
const CONSOLE_ORIGIN = 'https://console.test';
const OPS_SESSION = 'platform-session-token';
const OPS_CSRF = 'platform-csrf-token';
const CUSTOMER_SESSION = 'customer-session-token';
const CUSTOMER_CSRF = 'customer-csrf-token';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ANNOUNCEMENT_ID = '33333333-3333-4333-8333-333333333333';

const ACTOR: PlatformAdminActor = {
  userId: 'operator-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

const ANNOUNCEMENT = {
  id: ANNOUNCEMENT_ID,
  kind: 'maintenance',
  severity: 'critical',
  title: 'Scheduler upgrade window',
  body: 'The control plane is read-only during the window.',
  publishAt: '2026-10-12T01:00:00.000Z',
  unpublishAt: null,
  status: 'draft',
  version: 1,
  createdByUserId: 'operator-from-session',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
} as const;

const VALID_CREATE_BODY = {
  kind: 'maintenance',
  severity: 'critical',
  title: 'Scheduler upgrade window',
  body: 'The control plane is read-only during the window.',
  publishAt: '2026-10-12T01:00:00.000Z',
};

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

interface OpsCalls {
  readonly create: unknown[];
  readonly publish: unknown[];
  readonly withdraw: unknown[];
  readonly list: unknown[];
}

function opsOperations(calls: OpsCalls): MarketingAnnouncementOpsOperations {
  return {
    async createDraft(actor, input) {
      calls.create.push([actor, structuredClone(input)]);
      return { ...ANNOUNCEMENT };
    },
    async publish(actor, id, version) {
      calls.publish.push([actor, id, version]);
      return { ...ANNOUNCEMENT, status: 'published' as const, version: 2 };
    },
    async withdraw(actor, id, version) {
      calls.withdraw.push([actor, id, version]);
      return { ...ANNOUNCEMENT, status: 'withdrawn' as const, version: 2 };
    },
    async list(actor, input) {
      calls.list.push([actor, structuredClone(input)]);
      return { announcements: [{ ...ANNOUNCEMENT }], nextCursor: null };
    },
  };
}

interface CustomerCalls {
  readonly list: unknown[];
  readonly read: unknown[];
}

function customerOperations(calls: CustomerCalls): MarketingAnnouncementCustomerOperations {
  return {
    async listPublished(context, input) {
      calls.list.push([structuredClone(context), structuredClone(input)]);
      // Mirror the customer-safe projection exactly: no operator identity,
      // lifecycle status, version or internal timestamps.
      return {
        announcements: [
          {
            id: ANNOUNCEMENT.id,
            kind: ANNOUNCEMENT.kind,
            severity: ANNOUNCEMENT.severity,
            title: ANNOUNCEMENT.title,
            body: ANNOUNCEMENT.body,
            publishAt: ANNOUNCEMENT.publishAt,
            unpublishAt: ANNOUNCEMENT.unpublishAt,
            readAt: null,
          },
        ],
        nextCursor: null,
      };
    },
    async markRead(context, id) {
      calls.read.push([structuredClone(context), id]);
      return { outcome: 'marked' as const, announcementId: id, readAt: '2026-10-11T00:00:00.000Z' };
    },
  };
}

async function performRequest(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<{ handled: boolean; response: ResponseSnapshot }> {
  const url = new URL(path, origin);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = init.body === undefined ? undefined : String(init.body);
  const req = {
    url: `${url.pathname}${url.search}`,
    method: init.method ?? 'GET',
    headers,
    destroyed: false,
    socket: { remoteAddress: '203.0.113.10' },
    resume() {
      return req;
    },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
  let status = 0;
  const responseHeaders = new Headers();
  const chunks: Buffer[] = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead(code: number, head: Record<string, string>) {
      status = code;
      for (const [key, value] of Object.entries(head)) responseHeaders.set(key, value);
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      res.writableEnded = true;
      return res;
    },
  } as unknown as ServerResponse;
  const handled = await handler(req, res);
  return {
    handled,
    response: {
      status,
      headers: responseHeaders,
      body: chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {},
    },
  };
}

function opsHarness(
  actor: PlatformAdminActor | undefined,
  overrides: Partial<MarketingAnnouncementOpsOperations> = {},
) {
  const calls: OpsCalls = { create: [], publish: [], withdraw: [], list: [] };
  const handler = createMarketingAnnouncementPlatformHttpHandler({
    access: { authenticate: async () => actor },
    operations: { ...opsOperations(calls), ...overrides },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === OPS_SESSION && csrfToken === OPS_CSRF,
    },
    publicOrigin: OPS_ORIGIN,
  });
  const request = (path: string, init: RequestInit = {}) => performRequest(handler, OPS_ORIGIN, path, init);
  return { calls, request };
}

function customerHarness(
  options: {
    session?: { userId: string } | undefined;
    tenantId?: string;
    overrides?: Partial<MarketingAnnouncementCustomerOperations>;
  } = {},
) {
  const calls: CustomerCalls = { list: [], read: [] };
  const session = options.session === undefined ? { userId: USER_ID } : options.session;
  const tenantId = options.tenantId ?? TENANT_ID;
  const handler = createMarketingAnnouncementCustomerHttpHandler({
    service: {
      getSession: async (token) =>
        token === CUSTOMER_SESSION && session
          ? { userId: session.userId, activeTenantId: null, expiresAt: '2026-10-12T00:00:00.000Z', createdAt: NOWISH }
          : undefined,
      verifyCsrfToken: async (token, csrfToken) => token === CUSTOMER_SESSION && csrfToken === CUSTOMER_CSRF,
      resolveTenantContext: async ({ userId, tenantId: requested }) => {
        if (requested !== tenantId) throw Object.assign(new Error('TENANT_ACCESS_DENIED'), { status: 404 });
        return {
          userId,
          tenantId: requested,
          projectId: 'project-1',
          tenantRole: 'viewer' as const,
          projectRole: 'viewer' as const,
        };
      },
    },
    operations: { ...customerOperations(calls), ...options.overrides },
    publicOrigin: CONSOLE_ORIGIN,
  });
  const request = (path: string, init: RequestInit = {}) => performRequest(handler, CONSOLE_ORIGIN, path, init);
  return { calls, request };
}

const NOWISH = '2026-10-11T00:00:00.000Z';

function opsMutationHeaders(): Record<string, string> {
  return {
    host: new URL(OPS_ORIGIN).host,
    origin: OPS_ORIGIN,
    cookie: `mr_platform_admin_session=${OPS_SESSION}; mr_platform_admin_csrf=${OPS_CSRF}`,
    'x-csrf-token': OPS_CSRF,
    'content-type': 'application/json',
  };
}

function customerMutationHeaders(): Record<string, string> {
  return {
    host: new URL(CONSOLE_ORIGIN).host,
    origin: CONSOLE_ORIGIN,
    cookie: `mr_saas_session=${CUSTOMER_SESSION}; mr_saas_csrf=${CUSTOMER_CSRF}`,
    'x-csrf-token': CUSTOMER_CSRF,
    'content-type': 'application/json',
  };
}

test('ops handler ignores foreign paths and rejects unknown methods', async () => {
  const { request } = opsHarness(ACTOR);
  assert.equal((await request('/admin/api/v1/marketing/redeem-codes')).handled, false);
  assert.equal((await request('/admin/api/v1/marketing/announcements-extra')).handled, false);
  const put = await request('/admin/api/v1/marketing/announcements', { method: 'PUT' });
  assert.equal(put.handled, true);
  assert.equal(put.response.status, 405);
  assert.equal(put.response.headers.get('allow'), 'GET, POST');
});

test('ops create requires authentication, the operations band, origin and CSRF', async () => {
  const unauthenticated = await opsHarness(undefined).request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify(VALID_CREATE_BODY),
  });
  assert.equal(unauthenticated.response.status, 401);

  const wrongBand = await opsHarness({ ...ACTOR, roles: ['support'] }).request(
    '/admin/api/v1/marketing/announcements',
    { method: 'POST', headers: opsMutationHeaders(), body: JSON.stringify(VALID_CREATE_BODY) },
  );
  assert.equal(wrongBand.response.status, 403);

  const noOrigin = await opsHarness(ACTOR).request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: { ...opsMutationHeaders(), origin: '' },
    body: JSON.stringify(VALID_CREATE_BODY),
  });
  assert.equal(noOrigin.response.status, 403);
  assert.equal((noOrigin.response.body as { error: { code: string } }).error.code, 'ORIGIN_REQUIRED');

  const badCsrf = await opsHarness(ACTOR).request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: { ...opsMutationHeaders(), 'x-csrf-token': 'wrong' },
    body: JSON.stringify(VALID_CREATE_BODY),
  });
  assert.equal(badCsrf.response.status, 403);
  assert.equal((badCsrf.response.body as { error: { code: string } }).error.code, 'CSRF_REJECTED');
});

test('ops create parses the strict body and forwards the session actor', async () => {
  const { calls, request } = opsHarness(ACTOR);
  const created = await request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify(VALID_CREATE_BODY),
  });
  assert.equal(created.response.status, 201);
  assert.equal(calls.create.length, 1);
  const [actor, input] = calls.create[0] as [{ userId: string }, Record<string, unknown>];
  assert.equal(actor.userId, 'operator-from-session');
  assert.deepEqual(input, VALID_CREATE_BODY);

  const extraField = await request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ ...VALID_CREATE_BODY, status: 'published' }),
  });
  assert.equal(extraField.response.status, 400);

  const missingField = await request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ kind: 'maintenance' }),
  });
  assert.equal(missingField.response.status, 400);

  const wrongType = await request('/admin/api/v1/marketing/announcements', {
    method: 'POST',
    headers: { ...opsMutationHeaders(), 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(wrongType.response.status, 415);
});

test('ops publish and withdraw require a strict version body and a uuid path identifier', async () => {
  const { calls, request } = opsHarness(ACTOR);
  const published = await request(`/admin/api/v1/marketing/announcements/${ANNOUNCEMENT_ID}/publish`, {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(published.response.status, 200);
  assert.deepEqual(calls.publish[0], [
    { userId: ACTOR.userId, sessionId: ACTOR.sessionId, roles: ['operations'] },
    ANNOUNCEMENT_ID,
    1,
  ]);

  const withdrawn = await request(`/admin/api/v1/marketing/announcements/${ANNOUNCEMENT_ID}/withdraw`, {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ expectedVersion: 2 }),
  });
  assert.equal(withdrawn.response.status, 200);
  assert.equal(calls.withdraw.length, 1);

  const badVersion = await request(`/admin/api/v1/marketing/announcements/${ANNOUNCEMENT_ID}/publish`, {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ expectedVersion: '1' }),
  });
  assert.equal(badVersion.response.status, 400);

  const badId = await request('/admin/api/v1/marketing/announcements/not-a-uuid/publish', {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(badId.response.status, 400);

  const getOnTransition = await request(`/admin/api/v1/marketing/announcements/${ANNOUNCEMENT_ID}/publish`);
  assert.equal(getOnTransition.response.status, 405);
});

test('ops list validates the query and maps service errors', async () => {
  const { calls, request } = opsHarness(ACTOR);
  const listed = await request('/admin/api/v1/marketing/announcements?status=published&limit=10');
  assert.equal(listed.response.status, 200);
  assert.deepEqual(calls.list[0]?.[1], { status: 'published', kind: undefined, limit: 10, cursor: undefined });

  assert.equal((await request('/admin/api/v1/marketing/announcements?bogus=1')).response.status, 400);
  assert.equal((await request('/admin/api/v1/marketing/announcements?limit=0')).response.status, 400);
  assert.equal((await request('/admin/api/v1/marketing/announcements?limit=101')).response.status, 400);

  const failing = opsHarness(ACTOR, {
    list: async () => {
      throw new MarketingAnnouncementError('ANNOUNCEMENT_STORAGE_ERROR');
    },
  });
  assert.equal((await failing.request('/admin/api/v1/marketing/announcements')).response.status, 503);

  const conflict = opsHarness(ACTOR, {
    publish: async () => {
      throw new MarketingAnnouncementError('ANNOUNCEMENT_VERSION_CONFLICT');
    },
  });
  const conflicted = await conflict.request(`/admin/api/v1/marketing/announcements/${ANNOUNCEMENT_ID}/publish`, {
    method: 'POST',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ expectedVersion: 1 }),
  });
  assert.equal(conflicted.response.status, 409);
  assert.equal((conflicted.response.body as { error: { code: string } }).error.code, 'ANNOUNCEMENT_VERSION_CONFLICT');
});

test('customer list requires a session and tenant membership; any active member role passes', async () => {
  const { calls, request } = customerHarness();
  const listed = await request(`/console/api/v1/tenants/${TENANT_ID}/announcements`, {
    headers: { cookie: `mr_saas_session=${CUSTOMER_SESSION}` },
  });
  assert.equal(listed.response.status, 200);
  assert.deepEqual(calls.list[0]?.[0], { tenantId: TENANT_ID, userId: USER_ID });
  // Customer-safe projection: operator identity and lifecycle internals never
  // cross the boundary.
  const listedBody = JSON.stringify(listed.response.body);
  for (const forbidden of ['createdByUserId', 'createdAt', 'updatedAt', '"version"', '"status"']) {
    assert.ok(!listedBody.includes(forbidden), `customer projection leaks ${forbidden}`);
  }

  const noSession = await request(`/console/api/v1/tenants/${TENANT_ID}/announcements`);
  assert.equal(noSession.response.status, 401);

  const foreignTenant = await customerHarness({ tenantId: '99999999-9999-4999-8999-999999999999' }).request(
    `/console/api/v1/tenants/${TENANT_ID}/announcements`,
    { headers: { cookie: `mr_saas_session=${CUSTOMER_SESSION}` } },
  );
  assert.equal(foreignTenant.response.status, 404, 'non-membership is indistinguishable from unknown');

  const badTenant = await request('/console/api/v1/tenants/not-a-uuid/announcements', {
    headers: { cookie: `mr_saas_session=${CUSTOMER_SESSION}` },
  });
  assert.equal(badTenant.response.status, 400);

  const postOnList = await request(`/console/api/v1/tenants/${TENANT_ID}/announcements`, {
    method: 'POST',
    headers: customerMutationHeaders(),
    body: '{}',
  });
  assert.equal(postOnList.response.status, 405);
});

test('customer read receipt enforces CSRF and a strict empty body', async () => {
  const { calls, request } = customerHarness();
  const marked = await request(`/console/api/v1/tenants/${TENANT_ID}/announcements/${ANNOUNCEMENT_ID}/read`, {
    method: 'POST',
    headers: customerMutationHeaders(),
    body: '{}',
  });
  assert.equal(marked.response.status, 200);
  assert.deepEqual(calls.read[0], [{ tenantId: TENANT_ID, userId: USER_ID }, ANNOUNCEMENT_ID]);

  const badCsrf = await request(`/console/api/v1/tenants/${TENANT_ID}/announcements/${ANNOUNCEMENT_ID}/read`, {
    method: 'POST',
    headers: { ...customerMutationHeaders(), 'x-csrf-token': 'wrong' },
    body: '{}',
  });
  assert.equal(badCsrf.response.status, 403);

  const nonEmpty = await request(`/console/api/v1/tenants/${TENANT_ID}/announcements/${ANNOUNCEMENT_ID}/read`, {
    method: 'POST',
    headers: customerMutationHeaders(),
    body: '{"readAt":"2026-10-11T00:00:00.000Z"}',
  });
  assert.equal(nonEmpty.response.status, 400);

  const notFound = customerHarness({
    overrides: {
      markRead: async () => {
        throw new MarketingAnnouncementError('ANNOUNCEMENT_NOT_FOUND');
      },
    },
  });
  const missing = await notFound.request(`/console/api/v1/tenants/${TENANT_ID}/announcements/${ANNOUNCEMENT_ID}/read`, {
    method: 'POST',
    headers: customerMutationHeaders(),
    body: '{}',
  });
  assert.equal(missing.response.status, 404);
});
