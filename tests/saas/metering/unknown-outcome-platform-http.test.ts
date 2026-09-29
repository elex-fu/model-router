import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  createUnknownOutcomePlatformHttpHandler,
  UNKNOWN_OUTCOME_PLATFORM_PATHS,
  type UnknownOutcomePlatformHttpOptions,
  type UnknownOutcomePlatformOperations,
} from '../../../src/saas/metering/unknown-outcome-platform-http.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const TENANT_ID = 'tenant-a';
const CASE_ID = 'case-a';
const ACTOR: PlatformAdminActor = {
  userId: 'operator-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

const CASE = {
  caseId: CASE_ID,
  tenantId: TENANT_ID,
  projectId: 'project-a',
  requestId: 'request-a',
  supplyMode: 'platform' as const,
  scanAttempts: 2,
  lastErrorCode: null,
  createdAt: '2026-09-29T00:00:00.000Z',
};

const DETAIL = {
  summary: CASE,
  possibleAttemptIds: ['attempt-a', 'attempt-b'],
  observations: [],
};

const COVERAGE = [
  { attemptId: 'attempt-a', outcome: 'not_executed' as const, evidenceReference: 'provider-ledger:a' },
  { attemptId: 'attempt-b', outcome: 'not_executed' as const, evidenceReference: 'provider-ledger:b' },
];

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

interface Calls {
  readonly list: unknown[];
  readonly detail: unknown[];
  readonly resolve: unknown[];
  readonly csrf: unknown[];
  readonly auth: unknown[];
}

function operations(calls: Calls): UnknownOutcomePlatformOperations {
  return {
    async listCases(input) {
      calls.list.push(structuredClone(input));
      return [CASE];
    },
    async getCase(input) {
      calls.detail.push(structuredClone(input));
      return input.tenantId === TENANT_ID && input.caseId === CASE_ID ? DETAIL : null;
    },
    async resolveCase(input) {
      calls.resolve.push(structuredClone(input));
      return { status: 'resolved', caseId: input.caseId, requestId: 'request-a' };
    },
  };
}

async function harness(
  actor: PlatformAdminActor | undefined,
  operationOverrides: Partial<UnknownOutcomePlatformOperations> = {},
): Promise<{
  readonly calls: Calls;
  request(path: string, init?: RequestInit): Promise<ResponseSnapshot>;
}> {
  const calls: Calls = { list: [], detail: [], resolve: [], csrf: [], auth: [] };
  const baseOperations = operations(calls);
  const options: UnknownOutcomePlatformHttpOptions = {
    access: {
      authenticate: async (request) => {
        calls.auth.push(request);
        return actor;
      },
    },
    operations: { ...baseOperations, ...operationOverrides },
    publicOrigin: ORIGIN,
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => {
        calls.csrf.push([sessionToken, csrfToken]);
        return sessionToken === SESSION && csrfToken === CSRF;
      },
    },
  };
  const handler = createUnknownOutcomePlatformHttpHandler(options);

  return {
    calls,
    async request(path, init = {}) {
      const url = new URL(path, ORIGIN);
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
      let status = 200;
      let responseHeaders = new Headers();
      let responseText = '';
      let writableEnded = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return writableEnded;
        },
        writeHead(code: number, values: Record<string, unknown> = {}) {
          status = code;
          responseHeaders = new Headers(
            Object.entries(values).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(', ') : String(value),
            ]),
          );
          return res;
        },
        end(value?: unknown) {
          responseText = value === undefined ? '' : String(value);
          writableEnded = true;
          return res;
        },
      } as unknown as ServerResponse;

      assert.equal(await handler(req, res), true);
      return { status, headers: responseHeaders, body: JSON.parse(responseText) as Record<string, unknown> };
    },
  };
}

function postInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      host: 'platform-admin.test',
      cookie: `mr_platform_admin_session=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'idempotency-key': 'operator-resolution-1',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  assert.ok(error && typeof error === 'object' && !Array.isArray(error));
  return (error as Record<string, unknown>).code as string;
}

test('list and detail require an explicit tenant and use tenant-scoped operations', async () => {
  const app = await harness(ACTOR);

  const list = await app.request(`${ORIGIN}/admin/api/v1/ops/unknown-outcomes?tenantId=${TENANT_ID}&limit=10`);
  assert.equal(list.status, 200);
  assert.deepEqual(app.calls.list, [{ tenantId: TENANT_ID, limit: 10 }]);
  assert.deepEqual(list.body.data, { items: [CASE] });

  const detail = await app.request(`${ORIGIN}/admin/api/v1/ops/unknown-outcomes/${CASE_ID}?tenantId=${TENANT_ID}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(app.calls.detail, [{ tenantId: TENANT_ID, caseId: CASE_ID }]);
  assert.deepEqual(detail.body.data, DETAIL);

  const missingTenantList = await app.request(`${ORIGIN}/admin/api/v1/ops/unknown-outcomes`);
  assert.equal(missingTenantList.status, 400);
  assert.equal(errorCode(missingTenantList.body), 'INVALID_QUERY');
  const missingTenantDetail = await app.request(`${ORIGIN}/admin/api/v1/ops/unknown-outcomes/${CASE_ID}`);
  assert.equal(missingTenantDetail.status, 400);
  assert.equal(errorCode(missingTenantDetail.body), 'INVALID_QUERY');
  assert.equal(app.calls.detail.length, 1);
});

test('resolve preserves support-ticket locator and derives the actor from the platform session', async () => {
  const app = await harness(ACTOR);
  const response = await app.request(
    `${ORIGIN}/admin/api/v1/ops/unknown-outcomes/${CASE_ID}/resolve-not-executed?tenantId=${TENANT_ID}`,
    postInit({
      supportTicketRef: 'SUP-1842',
      reason: 'The provider-side ledger was reviewed for every possible dispatch attempt.',
      coverage: COVERAGE,
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(app.calls.resolve, [
    {
      tenantId: TENANT_ID,
      caseId: CASE_ID,
      actorUserId: ACTOR.userId,
      actorSessionId: ACTOR.sessionId,
      idempotencyKey: 'operator-resolution-1',
      supportTicketRef: 'SUP-1842',
      reason: 'The provider-side ledger was reviewed for every possible dispatch attempt.',
      coverage: COVERAGE,
    },
  ]);
  assert.equal(JSON.stringify(app.calls.resolve).includes('client-controlled-actor'), false);
});

test('only operations and superadmin roles can access the handler', async () => {
  const denied = await harness({ ...ACTOR, roles: ['support-readonly'] });
  const response = await denied.request(`${ORIGIN}/admin/api/v1/ops/unknown-outcomes?tenantId=${TENANT_ID}`);
  assert.equal(response.status, 403);
  assert.equal(errorCode(response.body), 'FORBIDDEN');
  assert.equal(denied.calls.list.length, 0);

  const superadmin = await harness({ ...ACTOR, roles: ['superadmin'] });
  assert.equal(
    (await superadmin.request(`${ORIGIN}/admin/api/v1/ops/unknown-outcomes?tenantId=${TENANT_ID}`)).status,
    200,
  );
});

test('POST requires same-origin, CSRF, and Idempotency-Key protections', async () => {
  const app = await harness(ACTOR);
  const path = `${ORIGIN}/admin/api/v1/ops/unknown-outcomes/${CASE_ID}/resolve-not-executed?tenantId=${TENANT_ID}`;
  const body = { supportTicketRef: 'SUP-1842', reason: 'Reviewed evidence.', coverage: [COVERAGE[0]] };

  const wrongOrigin = await app.request(path, postInit(body, { origin: 'https://attacker.test' }));
  assert.equal(wrongOrigin.status, 403);
  assert.equal(errorCode(wrongOrigin.body), 'ORIGIN_REJECTED');

  const wrongCsrf = await app.request(path, postInit(body, { 'x-csrf-token': 'attacker-token' }));
  assert.equal(wrongCsrf.status, 403);
  assert.equal(errorCode(wrongCsrf.body), 'CSRF_REJECTED');

  const missingKey = await app.request(path, postInit(body, { 'idempotency-key': '' }));
  assert.equal(missingKey.status, 400);
  assert.equal(errorCode(missingKey.body), 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(app.calls.resolve.length, 0);
});

test('POST uses a strict payload and validates complete not-executed coverage entries', async () => {
  const app = await harness(ACTOR);
  const path = `${ORIGIN}/admin/api/v1/ops/unknown-outcomes/${CASE_ID}/resolve-not-executed?tenantId=${TENANT_ID}`;
  const valid = { supportTicketRef: 'SUP-1842', reason: 'Reviewed evidence.', coverage: COVERAGE };

  for (const body of [
    { ...valid, actorUserId: 'client-controlled-actor', actorSessionId: 'client-controlled-session' },
    { ...valid, coverage: [{ ...COVERAGE[0], outcome: 'executed' }] },
    {
      ...valid,
      coverage: [COVERAGE[0], { ...COVERAGE[0], evidenceReference: 'other-reference' }],
    },
    {
      ...valid,
      coverage: [{ ...COVERAGE[0], providerConfirmed: true }],
    },
  ]) {
    const response = await app.request(path, postInit(body));
    assert.equal(response.status, 400);
    assert.ok(['INVALID_BODY', 'INVALID_COVERAGE'].includes(errorCode(response.body)));
  }
  assert.equal(app.calls.resolve.length, 0);
});

test('POST enforces the platform body limit and maps safe resolution outcomes', async () => {
  const app = await harness(ACTOR);
  const path = `${ORIGIN}/admin/api/v1/ops/unknown-outcomes/${CASE_ID}/resolve-not-executed?tenantId=${TENANT_ID}`;
  const oversized = await app.request(
    path,
    postInit({
      supportTicketRef: 'SUP-1842',
      reason: 'x'.repeat(70_000),
      coverage: COVERAGE,
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(errorCode(oversized.body), 'BODY_TOO_LARGE');

  const insufficient = await harness(undefined, {
    async resolveCase() {
      return { status: 'insufficient_evidence', missingAttemptIds: ['attempt-b'] };
    },
  });
  const unauthenticated = await insufficient.request(
    path,
    postInit({
      supportTicketRef: 'SUP-1842',
      reason: 'Reviewed evidence.',
      coverage: [COVERAGE[0]],
    }),
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(errorCode(unauthenticated.body), 'UNAUTHENTICATED');

  const resultApp = await harness(ACTOR, {
    async resolveCase() {
      return { status: 'insufficient_evidence', missingAttemptIds: ['attempt-b'] };
    },
  });
  const result = await resultApp.request(
    path,
    postInit({
      supportTicketRef: 'SUP-1842',
      reason: 'Reviewed evidence.',
      coverage: COVERAGE,
    }),
  );
  assert.equal(result.status, 422);
  assert.equal(errorCode(result.body), 'INSUFFICIENT_EVIDENCE');
});

test('unrelated paths remain unhandled and query keys are deny-listed', async () => {
  const app = await harness(ACTOR);
  assert.equal(
    UNKNOWN_OUTCOME_PLATFORM_PATHS.resolve,
    '/admin/api/v1/ops/unknown-outcomes/:caseId/resolve-not-executed',
  );
  const handler = createUnknownOutcomePlatformHttpHandler({
    access: { authenticate: async () => ACTOR },
    operations: operations(app.calls),
    publicOrigin: ORIGIN,
    authService: { verifyCsrfToken: async () => true },
  });
  const req = {
    url: '/admin/api/v1/other',
    method: 'GET',
    headers: {},
  } as unknown as IncomingMessage;
  const res = {} as ServerResponse;
  assert.equal(await handler(req, res), false);
  assert.equal(
    await handler(
      {
        ...req,
        method: 'POST',
        url: `/admin/api/v1/ops/unknown-outcomes/${CASE_ID}/resolve?tenantId=${TENANT_ID}`,
      } as unknown as IncomingMessage,
      res,
    ),
    false,
  );

  const invalid = await app.request(
    `${ORIGIN}/admin/api/v1/ops/unknown-outcomes?tenantId=${TENANT_ID}&caseId=client-selected`,
  );
  assert.equal(invalid.status, 400);
  assert.equal(errorCode(invalid.body), 'INVALID_QUERY');
  assert.equal(app.calls.list.length, 0);
});
