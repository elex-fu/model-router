import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { MarketingAffiliateError } from '../../../src/saas/marketing/affiliate.js';
import {
  createMarketingAffiliateCustomerHttpHandler,
  createMarketingAffiliateOpsHttpHandler,
  type MarketingAffiliateCustomerOperations,
  type MarketingAffiliateOpsOperations,
} from '../../../src/saas/marketing/affiliate-http.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

// R2/G3 HTTP suite: role bands, strict bodies, CSRF/same-origin enforcement,
// query validation and the error rebuild for both affiliate surfaces.

const OPS_ORIGIN = 'https://platform-admin.test';
const CONSOLE_ORIGIN = 'https://console.test';
const OPS_SESSION = 'platform-session-token';
const OPS_CSRF = 'platform-csrf-token';
const CUSTOMER_SESSION = 'customer-session-token';
const CUSTOMER_CSRF = 'customer-csrf-token';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const INVITER_ID = '33333333-3333-4333-8333-333333333333';
const NOWISH = '2026-10-11T00:00:00.000Z';

const ACTOR: PlatformAdminActor = {
  userId: 'operator-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

const POLICY = {
  rewardBp: 250,
  enabled: true,
  version: 3,
  updatedByUserId: 'operator-from-session',
  createdAt: NOWISH,
  updatedAt: NOWISH,
} as const;

const REWARD = {
  id: '44444444-4444-4444-8444-444444444444',
  inviterTenantId: INVITER_ID,
  inviteeTenantId: TENANT_ID,
  sourceFundingRef: '55555555-5555-4555-8555-555555555555',
  sourceAmountMinorUnits: '10000',
  rewardAmountMinorUnits: '250',
  currency: 'CNY',
  rewardBpSnapshot: 250,
  ledgerTransactionId: '66666666-6666-4666-8666-666666666666',
  createdAt: NOWISH,
} as const;

const MY_VIEW = {
  inviteCode: 'ABCDEFGHJKMNPQRSTU',
  invitedCount: 2,
  rewards: [{ ...REWARD }],
  nextCursor: null,
} as const;

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
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

interface OpsCalls {
  readonly getPolicy: unknown[];
  readonly replacePolicy: unknown[];
  readonly listRewards: unknown[];
}

function opsHarness(
  actor: PlatformAdminActor | undefined,
  options: { overrides?: Partial<MarketingAffiliateOpsOperations>; omitOperations?: boolean } = {},
) {
  const calls: OpsCalls = { getPolicy: [], replacePolicy: [], listRewards: [] };
  const operations: MarketingAffiliateOpsOperations = {
    async getAffiliatePolicy(actor) {
      calls.getPolicy.push([structuredClone(actor)]);
      return { ...POLICY };
    },
    async replaceAffiliatePolicy(actor, input) {
      calls.replacePolicy.push([structuredClone(actor), structuredClone(input)]);
      return { ...POLICY, version: 4 };
    },
    async listRewards(actor, input) {
      calls.listRewards.push([structuredClone(actor), structuredClone(input)]);
      return { rewards: [{ ...REWARD }], nextCursor: null };
    },
    ...options.overrides,
  };
  const handler = createMarketingAffiliateOpsHttpHandler({
    access: { authenticate: async () => actor },
    authService: {
      verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === OPS_SESSION && csrfToken === OPS_CSRF,
    },
    ...(options.omitOperations ? {} : { operations }),
    publicOrigin: OPS_ORIGIN,
  });
  const request = (path: string, init: RequestInit = {}) => performRequest(handler, OPS_ORIGIN, path, init);
  return { calls, request };
}

interface CustomerCalls {
  readonly view: unknown[];
  readonly bind: unknown[];
}

function customerHarness(
  options: {
    session?: { userId: string } | undefined;
    tenantId?: string;
    overrides?: Partial<MarketingAffiliateCustomerOperations>;
    omitOperations?: boolean;
  } = {},
) {
  const calls: CustomerCalls = { view: [], bind: [] };
  const session = options.session === undefined ? { userId: USER_ID } : options.session;
  const tenantId = options.tenantId ?? TENANT_ID;
  const operations: MarketingAffiliateCustomerOperations = {
    async getMyAffiliate(context, input) {
      calls.view.push([structuredClone(context), structuredClone(input)]);
      return { ...MY_VIEW, rewards: [{ ...REWARD }] };
    },
    async bindInviter(context, input) {
      calls.bind.push([structuredClone(context), structuredClone(input)]);
      return { outcome: 'bound' as const, inviterTenantId: INVITER_ID };
    },
    ...options.overrides,
  };
  const handler = createMarketingAffiliateCustomerHttpHandler({
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
    ...(options.omitOperations ? {} : { operations }),
    publicOrigin: CONSOLE_ORIGIN,
  });
  const request = (path: string, init: RequestInit = {}) => performRequest(handler, CONSOLE_ORIGIN, path, init);
  return { calls, request };
}

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

function customerSessionHeaders(): Record<string, string> {
  return {
    host: new URL(CONSOLE_ORIGIN).host,
    cookie: `mr_saas_session=${CUSTOMER_SESSION}`,
  };
}

const errorCode = (body: Record<string, unknown>) => (body as { error: { code: string } }).error.code;

test('ops handler ignores foreign paths and rejects wrong methods', async () => {
  const { request } = opsHarness(ACTOR);
  assert.equal((await request('/admin/api/v1/marketing/redeem-codes')).handled, false);
  assert.equal((await request('/admin/api/v1/marketing/affiliate-policy/extra')).handled, false);
  assert.equal((await request('/admin/api/v1/marketing/affiliate-rewards-extra')).handled, false);
  const del = await request('/admin/api/v1/marketing/affiliate-policy', { method: 'DELETE' });
  assert.equal(del.handled, true);
  assert.equal(del.response.status, 405);
  assert.equal(del.response.headers.get('allow'), 'GET, PUT');
  const post = await request('/admin/api/v1/marketing/affiliate-rewards', { method: 'POST' });
  assert.equal(post.response.status, 405);
  assert.equal(post.response.headers.get('allow'), 'GET');
});

test('ops policy read requires the role band and never requires CSRF', async () => {
  const unauthenticated = await opsHarness(undefined).request('/admin/api/v1/marketing/affiliate-policy');
  assert.equal(unauthenticated.response.status, 401);

  const wrongBand = await opsHarness({ ...ACTOR, roles: ['support'] }).request(
    '/admin/api/v1/marketing/affiliate-policy',
  );
  assert.equal(wrongBand.response.status, 403);

  for (const roles of [['operations'], ['finance'], ['operations', 'finance']]) {
    const { calls, request } = opsHarness({ ...ACTOR, roles });
    const ok = await request('/admin/api/v1/marketing/affiliate-policy');
    assert.equal(ok.response.status, 200);
    assert.equal(calls.getPolicy.length, 1);
    const data = (ok.response.body as { data: { policy: { version: number } } }).data;
    assert.equal(data.policy.version, 3);
  }
});

test('ops policy replace enforces origin, CSRF, the strict body and forwards the session actor', async () => {
  const body = JSON.stringify({ rewardBp: 500, enabled: true, expectedVersion: 3 });
  const noOrigin = await opsHarness(ACTOR).request('/admin/api/v1/marketing/affiliate-policy', {
    method: 'PUT',
    headers: { ...opsMutationHeaders(), origin: '' },
    body,
  });
  assert.equal(noOrigin.response.status, 403);
  assert.equal(errorCode(noOrigin.response.body), 'ORIGIN_REQUIRED');

  const badCsrf = await opsHarness(ACTOR).request('/admin/api/v1/marketing/affiliate-policy', {
    method: 'PUT',
    headers: { ...opsMutationHeaders(), 'x-csrf-token': 'wrong' },
    body,
  });
  assert.equal(badCsrf.response.status, 403);
  assert.equal(errorCode(badCsrf.response.body), 'CSRF_REJECTED');

  for (const invalid of [
    { rewardBp: -1, enabled: true, expectedVersion: 3 },
    { rewardBp: 5001, enabled: true, expectedVersion: 3 },
    { rewardBp: 500, enabled: 'yes', expectedVersion: 3 },
    { rewardBp: 500, enabled: true, expectedVersion: -1 },
    { rewardBp: 500, enabled: true },
    { rewardBp: 500, enabled: true, expectedVersion: 3, extra: true },
  ]) {
    const rejected = await opsHarness(ACTOR).request('/admin/api/v1/marketing/affiliate-policy', {
      method: 'PUT',
      headers: opsMutationHeaders(),
      body: JSON.stringify(invalid),
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(invalid));
    assert.equal(errorCode(rejected.response.body), 'INVALID_BODY');
  }

  const { calls, request } = opsHarness(ACTOR);
  const replaced = await request('/admin/api/v1/marketing/affiliate-policy', {
    method: 'PUT',
    headers: opsMutationHeaders(),
    body,
  });
  assert.equal(replaced.response.status, 200);
  assert.deepEqual(calls.replacePolicy, [
    [{ userId: 'operator-from-session' }, { rewardBp: 500, enabled: true, expectedVersion: 3 }],
  ]);
  const data = (replaced.response.body as { data: { policy: { version: number } } }).data;
  assert.equal(data.policy.version, 4);
});

test('ops rewards list validates the query and forwards filters', async () => {
  const { calls, request } = opsHarness(ACTOR);
  const listed = await request(
    `/admin/api/v1/marketing/affiliate-rewards?inviterTenantId=${INVITER_ID}&limit=25&cursor=abc`,
  );
  assert.equal(listed.response.status, 200);
  assert.deepEqual(calls.listRewards, [
    [{ userId: 'operator-from-session' }, { inviterTenantId: INVITER_ID, limit: 25, cursor: 'abc' }],
  ]);
  const data = (listed.response.body as { data: { items: unknown[] } }).data;
  assert.equal(data.items.length, 1);

  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'unknown=1', 'inviterTenantId=']) {
    const rejected = await request(`/admin/api/v1/marketing/affiliate-rewards?${query}`);
    assert.equal(rejected.response.status, 400, query);
    assert.equal(errorCode(rejected.response.body), 'INVALID_QUERY');
  }
});

test('ops surfaces rebuild service errors and report 503 when unconfigured', async () => {
  const conflict = await opsHarness(ACTOR, {
    overrides: {
      async replaceAffiliatePolicy() {
        throw new MarketingAffiliateError('AFFILIATE_POLICY_VERSION_CONFLICT');
      },
    },
  }).request('/admin/api/v1/marketing/affiliate-policy', {
    method: 'PUT',
    headers: opsMutationHeaders(),
    body: JSON.stringify({ rewardBp: 500, enabled: true, expectedVersion: 3 }),
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(errorCode(conflict.response.body), 'AFFILIATE_POLICY_VERSION_CONFLICT');

  const storage = await opsHarness(ACTOR, {
    overrides: {
      async getAffiliatePolicy() {
        throw new MarketingAffiliateError('AFFILIATE_STORAGE_ERROR');
      },
    },
  }).request('/admin/api/v1/marketing/affiliate-policy');
  assert.equal(storage.response.status, 500);
  assert.equal(errorCode(storage.response.body), 'INTERNAL_ERROR');

  const unavailable = await opsHarness(ACTOR, { omitOperations: true }).request(
    '/admin/api/v1/marketing/affiliate-policy',
  );
  assert.equal(unavailable.response.status, 503);
  assert.equal(errorCode(unavailable.response.body), 'AFFILIATE_UNAVAILABLE');
});

test('customer handler ignores foreign paths and rejects wrong methods', async () => {
  const { request } = customerHarness();
  assert.equal((await request(`/console/api/v1/tenants/${TENANT_ID}/redeem`)).handled, false);
  assert.equal((await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate-extra`)).handled, false);
  const put = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate`, { method: 'PUT' });
  assert.equal(put.handled, true);
  assert.equal(put.response.status, 405);
  const get = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`);
  assert.equal(get.response.status, 405);
  assert.equal(get.response.headers.get('allow'), 'POST');
});

test('customer view requires an authenticated member and forwards the query', async () => {
  const noSession = await customerHarness().request(`/console/api/v1/tenants/${TENANT_ID}/affiliate`);
  assert.equal(noSession.response.status, 401);

  const foreign = await customerHarness({ tenantId: INVITER_ID }).request(
    `/console/api/v1/tenants/${TENANT_ID}/affiliate`,
    { headers: customerSessionHeaders() },
  );
  assert.equal(foreign.response.status, 404);

  const { calls, request } = customerHarness();
  const viewed = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate?limit=5&cursor=abc`, {
    headers: customerSessionHeaders(),
  });
  assert.equal(viewed.response.status, 200);
  assert.deepEqual(calls.view, [
    [
      { tenantId: TENANT_ID, userId: USER_ID },
      { limit: 5, cursor: 'abc' },
    ],
  ]);
  const data = (viewed.response.body as { data: { inviteCode: string; invitedCount: number } }).data;
  assert.equal(data.inviteCode, MY_VIEW.inviteCode);
  assert.equal(data.invitedCount, 2);

  const badLimit = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate?limit=0`, {
    headers: customerSessionHeaders(),
  });
  assert.equal(badLimit.response.status, 400);
  assert.equal(errorCode(badLimit.response.body), 'INVALID_QUERY');
});

test('customer bind enforces origin, CSRF and the strict body', async () => {
  const body = JSON.stringify({ inviteCode: 'ABCDEFGHJKMNPQRSTU' });
  const noOrigin = await customerHarness().request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
    method: 'POST',
    headers: { ...customerMutationHeaders(), origin: '' },
    body,
  });
  assert.equal(noOrigin.response.status, 403);
  assert.equal(errorCode(noOrigin.response.body), 'ORIGIN_REQUIRED');

  const badCsrf = await customerHarness().request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
    method: 'POST',
    headers: { ...customerMutationHeaders(), 'x-csrf-token': 'wrong' },
    body,
  });
  assert.equal(badCsrf.response.status, 403);
  assert.equal(errorCode(badCsrf.response.body), 'CSRF_REJECTED');

  for (const invalid of [
    {},
    { inviteCode: '' },
    { inviteCode: 42 },
    { inviteCode: 'X'.repeat(65) },
    { inviteCode: 'ABCDEFGHJKMNPQRSTU', extra: 1 },
  ]) {
    const rejected = await customerHarness().request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
      method: 'POST',
      headers: customerMutationHeaders(),
      body: JSON.stringify(invalid),
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(invalid));
    assert.equal(errorCode(rejected.response.body), 'INVALID_BODY');
  }

  const wrongType = await customerHarness().request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
    method: 'POST',
    headers: { ...customerMutationHeaders(), 'content-type': 'text/plain' },
    body,
  });
  assert.equal(wrongType.response.status, 415);

  const { calls, request } = customerHarness();
  const bound = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
    method: 'POST',
    headers: customerMutationHeaders(),
    body,
  });
  assert.equal(bound.response.status, 200);
  assert.deepEqual(calls.bind, [[{ tenantId: TENANT_ID, userId: USER_ID }, { inviteCode: 'ABCDEFGHJKMNPQRSTU' }]]);
});

test('customer bind rebuilds domain refusals without leaking internals', async () => {
  const cases: Array<[string, number, string]> = [
    ['AFFILIATE_INVALID_INPUT', 400, 'AFFILIATE_INVALID_INPUT'],
    ['AFFILIATE_INVITE_CODE_INVALID', 400, 'AFFILIATE_INVITE_CODE_INVALID'],
    ['AFFILIATE_SELF_INVITE', 409, 'AFFILIATE_SELF_INVITE'],
    ['AFFILIATE_CYCLE', 409, 'AFFILIATE_CYCLE'],
    ['AFFILIATE_ALREADY_BOUND', 409, 'AFFILIATE_ALREADY_BOUND'],
    ['AFFILIATE_STORAGE_ERROR', 500, 'INTERNAL_ERROR'],
  ];
  for (const [code, status, rebuilt] of cases) {
    const { request } = customerHarness({
      overrides: {
        async bindInviter() {
          throw new MarketingAffiliateError(code as never, 'internal detail must not cross');
        },
      },
    });
    const response = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
      method: 'POST',
      headers: customerMutationHeaders(),
      body: JSON.stringify({ inviteCode: 'ABCDEFGHJKMNPQRSTU' }),
    });
    assert.equal(response.response.status, status, code);
    assert.equal(errorCode(response.response.body), rebuilt, code);
    assert.doesNotMatch(JSON.stringify(response.response.body), /internal detail/);
  }

  const unavailable = await customerHarness({ omitOperations: true }).request(
    `/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`,
    { method: 'POST', headers: customerMutationHeaders(), body: JSON.stringify({ inviteCode: 'ABCDEFGHJKMNPQRSTU' }) },
  );
  assert.equal(unavailable.response.status, 503);
  assert.equal(errorCode(unavailable.response.body), 'AFFILIATE_UNAVAILABLE');
});

test('customer bind is rate limited per user after ten attempts in a window', async () => {
  const { calls, request } = customerHarness();
  const body = JSON.stringify({ inviteCode: 'AAAAAAAAAAAAAAAA' });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ok = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
      method: 'POST',
      headers: customerMutationHeaders(),
      body,
    });
    assert.equal(ok.response.status, 200, `attempt ${attempt + 1}`);
  }
  const limited = await request(`/console/api/v1/tenants/${TENANT_ID}/affiliate/bind`, {
    method: 'POST',
    headers: customerMutationHeaders(),
    body,
  });
  assert.equal(limited.response.status, 429);
  assert.equal(errorCode(limited.response.body), 'RATE_LIMITED');
  assert.ok(limited.response.headers.get('retry-after'));
  assert.equal(calls.bind.length, 10, 'the limited attempt never reaches the service');
});
