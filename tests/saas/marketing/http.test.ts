import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { TenantRole } from '../../../src/saas/identity/types.js';
import {
  createMarketingCustomerRedeemHandler,
  createMarketingOpsRedeemCodesHandler,
  type MarketingRedeemHttpHandler,
} from '../../../src/saas/marketing/http.js';
import {
  MarketingRedeemError,
  type RedeemCodeView,
  type RedeemResult,
} from '../../../src/saas/marketing/redeem-codes.js';
import type { PlatformAdminActor, PlatformAdminRole } from '../../../src/saas/platform/access/types.js';

const ORIGIN = 'https://console.test';
const HOST = 'console.test';
const SESSION = 'session-marketing';
const CSRF = 'csrf-marketing';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const CODE_ID = '33333333-3333-4333-8333-333333333333';
const CODE = 'ABCD-EFGH-JKMN-PQRS-TUVW';
const REDEEM_PATH = `/console/api/v1/tenants/${TENANT_ID}/redeem`;

const OPS_ORIGIN = 'https://platform-admin.test';
const OPS_HOST = 'platform-admin.test';
const OPS_SESSION = 'platform-session-token';
const OPS_CSRF = 'platform-csrf-token';
const OPERATOR_ID = '44444444-4444-4444-8444-444444444444';
const OPS_PATH = '/admin/api/v1/marketing/redeem-codes';

const REDEEMED: RedeemResult = {
  outcome: 'redeemed',
  kind: 'balance',
  codeId: CODE_ID,
  amountMinorUnits: '5000',
  currency: 'USD',
  ledgerTransactionId: 'ledger-transaction-1',
};

const CODE_VIEW: RedeemCodeView = {
  id: CODE_ID,
  codePrefix: 'ABCD',
  kind: 'balance',
  amountMinorUnits: '5000',
  currency: 'USD',
  servicePlanVersionId: null,
  status: 'active',
  batchRef: 'batch-1',
  createdAt: '2026-10-10T00:00:00.000Z',
  redeemedByTenantId: null,
  redeemedAt: null,
  disabledAt: null,
};

interface Snapshot {
  readonly matched: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function invoke(
  handler: MarketingRedeemHttpHandler,
  baseOrigin: string,
  init: {
    path: string;
    method?: string;
    headers?: Record<string, string | undefined>;
    body?: string;
    remoteAddress?: string;
  },
): Promise<Snapshot> {
  const url = new URL(init.path, baseOrigin);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (value !== undefined) headers[key.toLowerCase()] = value;
  }
  const body = init.body;
  if (body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }
  const req = {
    url: `${url.pathname}${url.search}`,
    method: init.method ?? 'GET',
    headers,
    destroyed: false,
    socket: { remoteAddress: init.remoteAddress ?? '203.0.113.10' },
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
        Object.entries(values).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]),
      );
      return res;
    },
    end(value?: unknown) {
      responseText = value === undefined ? '' : String(value);
      writableEnded = true;
      return res;
    },
  } as unknown as ServerResponse;

  const matched = await handler(req, res);
  return { matched, status, headers: responseHeaders, body: responseText === '' ? {} : JSON.parse(responseText) };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error;
  assert.ok(error && typeof error === 'object' && !Array.isArray(error));
  return (error as Record<string, unknown>).code as string;
}

function errorMessage(body: Record<string, unknown>): string {
  const error = body.error;
  assert.ok(error && typeof error === 'object' && !Array.isArray(error));
  return (error as Record<string, unknown>).message as string;
}

interface CustomerOverrides {
  readonly role?: TenantRole;
  readonly mismatch?: boolean;
  readonly tenantError?: unknown;
  readonly withService?: boolean;
  readonly redeemResult?: RedeemResult;
  readonly redeemError?: unknown;
}

function customerHarness(overrides: CustomerOverrides = {}) {
  const calls: { readonly redeem: Array<{ context: unknown; input: unknown }> } = { redeem: [] };
  const role = overrides.role ?? 'viewer';
  const identity = {
    getSession: async (token: string) =>
      token.startsWith('session')
        ? {
            userId: token === SESSION ? USER_ID : `user-${token}`,
            activeTenantId: null,
            expiresAt: '2099-01-01T00:00:00.000Z',
            createdAt: '2026-10-10T00:00:00.000Z',
          }
        : undefined,
    verifyCsrfToken: async (_token: string, csrf: string) => csrf === CSRF,
    resolveTenantContext: async ({ userId, tenantId }: { userId: string; tenantId: string }) => {
      if (overrides.tenantError !== undefined) throw overrides.tenantError;
      return {
        userId: overrides.mismatch ? '99999999-9999-4999-8999-999999999999' : userId,
        tenantId,
        projectId: 'project-1',
        tenantRole: role,
        projectRole: role,
      };
    },
  };
  const redeemService = {
    redeem: async (context: { tenantId: string; userId: string }, input: { code: string }) => {
      calls.redeem.push({ context: structuredClone(context), input: structuredClone(input) });
      if (overrides.redeemError !== undefined) throw overrides.redeemError;
      return overrides.redeemResult ?? REDEEMED;
    },
  };
  const handler = createMarketingCustomerRedeemHandler({
    service: identity,
    ...(overrides.withService === false ? {} : { redeemService }),
    publicOrigin: ORIGIN,
  });
  const post = (path: string, body: unknown, headers: Record<string, string | undefined> = {}) =>
    invoke(handler, ORIGIN, {
      path,
      method: 'POST',
      headers: {
        cookie: `mr_saas_session=${SESSION}; mr_saas_csrf=${CSRF}`,
        origin: ORIGIN,
        host: HOST,
        'x-csrf-token': CSRF,
        'content-type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { calls, handler, post };
}

interface OpsOverrides {
  readonly roles?: readonly PlatformAdminRole[];
  readonly unauthenticated?: boolean;
  readonly withService?: boolean;
  readonly generateError?: unknown;
  readonly listError?: unknown;
  readonly disableError?: unknown;
}

function opsHarness(overrides: OpsOverrides = {}) {
  const calls: {
    readonly generate: Array<{ actor: unknown; input: unknown }>;
    readonly list: Array<{ actor: unknown; input: unknown }>;
    readonly disable: Array<{ actor: unknown; codeId: unknown }>;
  } = { generate: [], list: [], disable: [] };
  const actor: PlatformAdminActor | undefined = overrides.unauthenticated
    ? undefined
    : { userId: OPERATOR_ID, sessionId: 'platform-session-id', roles: overrides.roles ?? ['operations'] };
  const redeemCodes = {
    generateBalanceCodes: async (
      actorArg: { userId: string },
      input: { count: number; amountMinorUnits: string; currency: string; batchRef?: string },
    ) => {
      calls.generate.push({ actor: structuredClone(actorArg), input: structuredClone(input) });
      if (overrides.generateError !== undefined) throw overrides.generateError;
      return { batchRef: 'batch-1', codes: ['AAAA-BBBB-CCCC-DDDD-EEEE', 'FFFF-GGGG-HHHH-JJJJ-KKKK'] };
    },
    generateSubscriptionCodes: async (
      actorArg: { userId: string },
      input: { count: number; servicePlanVersionId: string; batchRef?: string },
    ) => {
      calls.generate.push({ actor: structuredClone(actorArg), input: structuredClone(input) });
      if (overrides.generateError !== undefined) throw overrides.generateError;
      return { batchRef: 'batch-sub-1', codes: ['AAAA-BBBB-CCCC-DDDD-EEEE'] };
    },
    listCodes: async (actorArg: { userId: string }, input: Record<string, unknown>) => {
      calls.list.push({ actor: structuredClone(actorArg), input: structuredClone(input) });
      if (overrides.listError !== undefined) throw overrides.listError;
      return { codes: [structuredClone(CODE_VIEW)], nextCursor: 'cursor-1' };
    },
    disableCode: async (actorArg: { userId: string }, codeId: string) => {
      calls.disable.push({ actor: structuredClone(actorArg), codeId });
      if (overrides.disableError !== undefined) throw overrides.disableError;
      return { ...structuredClone(CODE_VIEW), status: 'disabled' as const, disabledAt: '2026-10-11T00:00:00.000Z' };
    },
  };
  const handler = createMarketingOpsRedeemCodesHandler({
    access: { authenticate: async () => actor },
    authService: {
      verifyCsrfToken: async (token: string, csrf: string) => token === OPS_SESSION && csrf === OPS_CSRF,
    },
    ...(overrides.withService === false ? {} : { redeemCodes }),
    publicOrigin: OPS_ORIGIN,
  });
  const post = (path: string, body?: unknown, headers: Record<string, string | undefined> = {}) =>
    invoke(handler, OPS_ORIGIN, {
      path,
      method: 'POST',
      headers: {
        cookie: `mr_platform_admin_session=${OPS_SESSION}; mr_platform_admin_csrf=${OPS_CSRF}`,
        origin: OPS_ORIGIN,
        host: OPS_HOST,
        'x-csrf-token': OPS_CSRF,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  const get = (path: string, headers: Record<string, string | undefined> = {}) =>
    invoke(handler, OPS_ORIGIN, {
      path,
      method: 'GET',
      headers: { cookie: `mr_platform_admin_session=${OPS_SESSION}`, ...headers },
    });
  return { calls, handler, post, get };
}

test('customer redeem matches only its own route', async () => {
  const { handler, post } = customerHarness();
  for (const path of [
    '/console/api/v1/tenants/x/orders',
    '/console/api/v1/tenants/x/redeem/codes',
    '/admin/api/v1/marketing/redeem-codes',
  ]) {
    const missed = await invoke(handler, ORIGIN, { path, method: 'POST' });
    assert.equal(missed.matched, false, path);
  }
  const hit = await post(REDEEM_PATH, { code: CODE });
  assert.equal(hit.matched, true);
});

test('customer redeem rejects non-POST methods with 405 and an allow header', async () => {
  const { calls, handler } = customerHarness();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await invoke(handler, ORIGIN, { path: REDEEM_PATH, method });
    assert.equal(response.matched, true, method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'POST', method);
    assert.equal(errorCode(response.body), 'METHOD_NOT_ALLOWED', method);
  }
  assert.equal(calls.redeem.length, 0);
});

test('customer redeem enforces a strict JSON body within 1KiB', async () => {
  const { calls, post } = customerHarness();
  const extra = await post(REDEEM_PATH, { code: CODE, tenantId: TENANT_ID });
  assert.equal(extra.status, 400);
  assert.equal(errorCode(extra.body), 'INVALID_BODY');

  const numericCode = await post(REDEEM_PATH, { code: 42 });
  assert.equal(numericCode.status, 400);

  const missing = await post(REDEEM_PATH, {});
  assert.equal(missing.status, 400);

  const notJson = await post(REDEEM_PATH, '{broken json');
  assert.equal(notJson.status, 400);
  assert.equal(errorCode(notJson.body), 'INVALID_JSON');

  const wrongType = await post(REDEEM_PATH, { code: CODE }, { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);

  const oversized = await post(REDEEM_PATH, { code: `A${'1'.repeat(2000)}` });
  assert.equal(oversized.status, 413);
  assert.equal(errorCode(oversized.body), 'BODY_TOO_LARGE');

  const empty = await post(REDEEM_PATH, '');
  assert.equal(empty.status, 400);
  assert.equal(calls.redeem.length, 0);
});

test('customer redeem rejects missing and unknown sessions with 401', async () => {
  const { calls, post } = customerHarness();
  const anonymous = await post(REDEEM_PATH, { code: CODE }, { cookie: undefined });
  assert.equal(anonymous.status, 401);
  assert.equal(errorCode(anonymous.body), 'UNAUTHENTICATED');

  const unknown = await post(REDEEM_PATH, { code: CODE }, { cookie: 'mr_saas_session=forged; mr_saas_csrf=x' });
  assert.equal(unknown.status, 401);
  assert.equal(calls.redeem.length, 0);
});

test('customer redeem enforces same-origin and double-submit CSRF', async () => {
  const { calls, post } = customerHarness();
  const noOrigin = await post(REDEEM_PATH, { code: CODE }, { origin: undefined });
  assert.equal(noOrigin.status, 403);
  assert.equal(errorCode(noOrigin.body), 'ORIGIN_REQUIRED');

  const evilOrigin = await post(REDEEM_PATH, { code: CODE }, { origin: 'https://evil.test' });
  assert.equal(evilOrigin.status, 403);
  assert.equal(errorCode(evilOrigin.body), 'ORIGIN_REJECTED');

  const evilHost = await post(REDEEM_PATH, { code: CODE }, { host: 'evil.test' });
  assert.equal(evilHost.status, 403);
  assert.equal(errorCode(evilHost.body), 'HOST_REJECTED');

  const badHeader = await post(REDEEM_PATH, { code: CODE }, { 'x-csrf-token': 'forged' });
  assert.equal(badHeader.status, 403);
  assert.equal(errorCode(badHeader.body), 'CSRF_REJECTED');

  const noCsrfCookie = await post(REDEEM_PATH, { code: CODE }, { cookie: `mr_saas_session=${SESSION}` });
  assert.equal(noCsrfCookie.status, 403);
  assert.equal(errorCode(noCsrfCookie.body), 'CSRF_REJECTED');
  assert.equal(calls.redeem.length, 0);
});

test('every active tenant role may redeem; a mismatched server context fails closed', async () => {
  for (const role of ['owner', 'admin', 'developer', 'billing', 'viewer'] as const) {
    const { calls, post } = customerHarness({ role });
    const response = await post(REDEEM_PATH, { code: CODE });
    assert.equal(response.status, 200, role);
    assert.equal(calls.redeem.length, 1, role);
  }

  const mismatched = customerHarness({ mismatch: true });
  const denied = await mismatched.post(REDEEM_PATH, { code: CODE });
  assert.equal(denied.status, 403);
  assert.equal(mismatched.calls.redeem.length, 0);

  const nonMember = customerHarness({ tenantError: Object.assign(new Error('denied'), { status: 404 }) });
  const missing = await nonMember.post(REDEEM_PATH, { code: CODE });
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing.body), 'NOT_FOUND');
  assert.equal(nonMember.calls.redeem.length, 0);
});

test('customer redeem rate limits per user after ten attempts per minute', async () => {
  const { calls, post } = customerHarness();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const ok = await post(REDEEM_PATH, { code: CODE });
    assert.equal(ok.status, 200, `attempt ${attempt}`);
  }
  const limited = await post(REDEEM_PATH, { code: CODE });
  assert.equal(limited.status, 429);
  assert.equal(errorCode(limited.body), 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal(calls.redeem.length, 10);
});

test('customer redeem rate limits per source IP across users', async () => {
  const { calls, post } = customerHarness();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ok = await post(
      REDEEM_PATH,
      { code: CODE },
      { cookie: `mr_saas_session=session-ip-${attempt}; mr_saas_csrf=${CSRF}` },
    );
    assert.equal(ok.status, 200, `attempt ${attempt}`);
  }
  const limited = await post(
    REDEEM_PATH,
    { code: CODE },
    { cookie: `mr_saas_session=session-ip-30; mr_saas_csrf=${CSRF}` },
  );
  assert.equal(limited.status, 429);
  assert.equal(errorCode(limited.body), 'RATE_LIMITED');
  assert.equal(calls.redeem.length, 30);
});

test('customer redeem reports 503 when the redeem service is absent', async () => {
  const { calls, post } = customerHarness({ withService: false });
  const response = await post(REDEEM_PATH, { code: CODE });
  assert.equal(response.status, 503);
  assert.equal(errorCode(response.body), 'REDEEM_UNAVAILABLE');
  assert.equal(calls.redeem.length, 0);
});

test('customer redeem maps service error codes without leaking internals', async () => {
  const cases: Array<[unknown, number, string]> = [
    [new MarketingRedeemError('REDEEM_INVALID_INPUT'), 400, 'REDEEM_INVALID_INPUT'],
    [new MarketingRedeemError('REDEEM_CODE_INVALID'), 400, 'REDEEM_CODE_INVALID'],
    [new MarketingRedeemError('REDEEM_KIND_UNSUPPORTED'), 400, 'REDEEM_KIND_UNSUPPORTED'],
    [new MarketingRedeemError('REDEEM_CODE_STATE_CONFLICT'), 409, 'REDEEM_CODE_STATE_CONFLICT'],
    [new MarketingRedeemError('REDEEM_FORBIDDEN'), 403, 'FORBIDDEN'],
    [new MarketingRedeemError('REDEEM_STORAGE_ERROR'), 500, 'INTERNAL_ERROR'],
    [new Error('pg connection failed password=hunter2'), 500, 'INTERNAL_ERROR'],
  ];
  for (const [thrown, status, code] of cases) {
    const { post } = customerHarness({ redeemError: thrown });
    const response = await post(REDEEM_PATH, { code: CODE });
    assert.equal(response.status, status, code);
    assert.equal(errorCode(response.body), code);
    assert.ok(!errorMessage(response.body).includes('hunter2'), 'internal details must not leak');
  }
});

test('unknown, disabled and foreign codes share one customer-side refusal', async () => {
  const { post } = customerHarness({
    redeemError: new MarketingRedeemError('REDEEM_CODE_INVALID', 'disabled code internal detail'),
  });
  const response = await post(REDEEM_PATH, { code: CODE });
  assert.equal(response.status, 400);
  assert.equal(errorCode(response.body), 'REDEEM_CODE_INVALID');
  assert.equal(errorMessage(response.body), 'The redeem code is invalid');
});

test('customer redeem returns the locked envelope and passes amounts through as strings', async () => {
  const { calls, post } = customerHarness();
  const response = await post(REDEEM_PATH, { code: CODE });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(response.body).sort(), ['data', 'meta']);
  assert.deepEqual(response.body.data, {
    outcome: 'redeemed',
    kind: 'balance',
    codeId: CODE_ID,
    amountMinorUnits: '5000',
    currency: 'USD',
    ledgerTransactionId: 'ledger-transaction-1',
  });
  assert.equal(typeof (response.body.meta as { requestId: unknown }).requestId, 'string');
  assert.deepEqual(calls.redeem, [{ context: { tenantId: TENANT_ID, userId: USER_ID }, input: { code: CODE } }]);
});

test('customer redeem returns the subscription grant shape for a subscription code', async () => {
  const subscriptionResult: RedeemResult = {
    outcome: 'redeemed',
    kind: 'subscription',
    codeId: CODE_ID,
    servicePlanVersionId: '55555555-5555-4555-8555-555555555555',
    subscriptionId: 'subscription-1',
    entitlementId: 'entitlement-1',
    expiresAt: '2026-11-10T00:00:00.000Z',
  };
  const { post } = customerHarness({ redeemResult: subscriptionResult });
  const response = await post(REDEEM_PATH, { code: CODE });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, subscriptionResult);
  assert.ok(!('amountMinorUnits' in (response.body.data as Record<string, unknown>)));
  assert.ok(!('ledgerTransactionId' in (response.body.data as Record<string, unknown>)));
});

test('customer redeem replay keeps the 200 response shape', async () => {
  const { post } = customerHarness({ redeemResult: { ...REDEEMED, outcome: 'replayed' } });
  const response = await post(REDEEM_PATH, { code: CODE });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { ...REDEEMED, outcome: 'replayed' });
});

test('operations routes dispatch generate, list and disable with the session-derived actor', async () => {
  const { calls, get, post } = opsHarness();
  const generated = await post(OPS_PATH, { count: 2, amountMinorUnits: '5000', currency: 'USD' });
  assert.equal(generated.status, 201);
  assert.deepEqual(calls.generate, [
    { actor: { userId: OPERATOR_ID }, input: { count: 2, amountMinorUnits: '5000', currency: 'USD' } },
  ]);

  const listed = await get(`${OPS_PATH}?batchRef=batch-1&status=active&limit=10&cursor=cursor-0`);
  assert.equal(listed.status, 200);
  assert.deepEqual(calls.list, [
    { actor: { userId: OPERATOR_ID }, input: { batchRef: 'batch-1', status: 'active', limit: 10, cursor: 'cursor-0' } },
  ]);

  const disabled = await post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(disabled.status, 200);
  assert.deepEqual(calls.disable, [{ actor: { userId: OPERATOR_ID }, codeId: CODE_ID }]);

  const spoofed = await post(OPS_PATH, { count: 1, amountMinorUnits: '5000', currency: 'USD', actorUserId: 'spoofed' });
  assert.equal(spoofed.status, 400);
  assert.equal(calls.generate.length, 1, 'the actor is never accepted from the body');
});

test('generation returns plaintext codes once and listings never leak the code hash', async () => {
  const { get, post } = opsHarness();
  const generated = await post(OPS_PATH, { count: 2, amountMinorUnits: '5000', currency: 'USD', batchRef: 'batch-1' });
  assert.equal(generated.status, 201);
  assert.deepEqual(Object.keys(generated.body).sort(), ['data', 'meta']);
  assert.deepEqual(generated.body.data, {
    batchRef: 'batch-1',
    codes: ['AAAA-BBBB-CCCC-DDDD-EEEE', 'FFFF-GGGG-HHHH-JJJJ-KKKK'],
  });

  const listed = await get(OPS_PATH);
  assert.equal(listed.status, 200);
  const data = listed.body.data as { items: Array<Record<string, unknown>>; nextCursor: string | null };
  assert.equal(data.nextCursor, 'cursor-1');
  assert.equal(data.items.length, 1);
  assert.deepEqual(data.items[0], CODE_VIEW as unknown as Record<string, unknown>);
  const serialized = JSON.stringify(listed.body);
  assert.ok(!/hash/i.test(serialized), 'the code hash must never leave the store');
});

test('subscription generation dispatches on the kind discriminator with a strict body', async () => {
  const { calls, post } = opsHarness();
  const generated = await post(OPS_PATH, {
    kind: 'subscription',
    count: 1,
    servicePlanVersionId: '00000000-0000-4000-8000-0000000000e1',
    batchRef: 'batch-sub-1',
  });
  assert.equal(generated.status, 201);
  assert.deepEqual(calls.generate, [
    {
      actor: { userId: OPERATOR_ID },
      input: { count: 1, servicePlanVersionId: '00000000-0000-4000-8000-0000000000e1', batchRef: 'batch-sub-1' },
    },
  ]);
  assert.deepEqual(generated.body.data, { batchRef: 'batch-sub-1', codes: ['AAAA-BBBB-CCCC-DDDD-EEEE'] });

  const cases: unknown[] = [
    // subscription carrying balance fields (and vice versa) is a strict rejection
    {
      kind: 'subscription',
      count: 1,
      servicePlanVersionId: '00000000-0000-4000-8000-0000000000e1',
      amountMinorUnits: '100',
    },
    {
      kind: 'balance',
      count: 1,
      amountMinorUnits: '100',
      currency: 'CNY',
      servicePlanVersionId: '00000000-0000-4000-8000-0000000000e1',
    },
    { kind: 'voucher', count: 1, amountMinorUnits: '100', currency: 'CNY' },
    { kind: 'subscription', count: 1 },
    { kind: 'subscription', count: 1, servicePlanVersionId: 42 },
    { kind: 7, count: 1, amountMinorUnits: '100', currency: 'CNY' },
  ];
  const before = calls.generate.length;
  for (const body of cases) {
    const rejected = await post(OPS_PATH, body);
    assert.equal(rejected.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.generate.length, before, 'strict rejections never reach the service');
});

test('operations routes enforce the operations/finance role band', async () => {
  for (const roles of [['operations'], ['finance'], ['superadmin']] as const) {
    const { get } = opsHarness({ roles });
    const response = await get(OPS_PATH);
    assert.equal(response.status, 200, roles.join(','));
  }

  for (const roles of [['support-readonly'], ['security'], []] as const) {
    const app = opsHarness({ roles });
    const listed = await app.get(OPS_PATH);
    assert.equal(listed.status, 403, roles.join(','));
    const generated = await app.post(OPS_PATH, { count: 1, amountMinorUnits: '5000', currency: 'USD' });
    assert.equal(generated.status, 403, roles.join(','));
    assert.equal(app.calls.list.length, 0);
    assert.equal(app.calls.generate.length, 0);
  }

  const anonymous = opsHarness({ unauthenticated: true });
  const response = await anonymous.get(OPS_PATH);
  assert.equal(response.status, 401);
  assert.equal(errorCode(response.body), 'UNAUTHENTICATED');
});

test('operations writes enforce same-origin and platform CSRF', async () => {
  const { calls, post } = opsHarness();
  const noOrigin = await post(OPS_PATH, { count: 1, amountMinorUnits: '5000', currency: 'USD' }, { origin: undefined });
  assert.equal(noOrigin.status, 403);
  assert.equal(errorCode(noOrigin.body), 'ORIGIN_REQUIRED');

  const evilOrigin = await post(`${OPS_PATH}/${CODE_ID}/disable`, undefined, { origin: 'https://evil.test' });
  assert.equal(evilOrigin.status, 403);
  assert.equal(errorCode(evilOrigin.body), 'ORIGIN_REJECTED');

  const badCsrf = await post(
    OPS_PATH,
    { count: 1, amountMinorUnits: '5000', currency: 'USD' },
    { 'x-csrf-token': 'forged' },
  );
  assert.equal(badCsrf.status, 403);
  assert.equal(errorCode(badCsrf.body), 'CSRF_REJECTED');

  const noCsrfCookie = await post(`${OPS_PATH}/${CODE_ID}/disable`, undefined, {
    cookie: `mr_platform_admin_session=${OPS_SESSION}`,
  });
  assert.equal(noCsrfCookie.status, 403);
  assert.equal(errorCode(noCsrfCookie.body), 'CSRF_REJECTED');
  assert.equal(calls.generate.length, 0);
  assert.equal(calls.disable.length, 0);
});

test('operations generation enforces a strict body and string amount passthrough', async () => {
  const { calls, post } = opsHarness();
  const rejected: unknown[] = [
    { count: 1, amountMinorUnits: '5000', currency: 'USD', codes: 1 },
    { count: '1', amountMinorUnits: '5000', currency: 'USD' },
    { count: 0, amountMinorUnits: '5000', currency: 'USD' },
    { count: 101, amountMinorUnits: '5000', currency: 'USD' },
    { count: 1.5, amountMinorUnits: '5000', currency: 'USD' },
    { count: 1, amountMinorUnits: 5000, currency: 'USD' },
    { count: 1, amountMinorUnits: '5000', currency: 840 },
    { count: 1, amountMinorUnits: '5000', currency: 'USD', batchRef: 42 },
  ];
  for (const body of rejected) {
    const response = await post(OPS_PATH, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(errorCode(response.body), 'INVALID_BODY');
  }
  assert.equal(calls.generate.length, 0);

  const accepted = await post(OPS_PATH, { count: 1, amountMinorUnits: '0005000', currency: 'USD' });
  assert.equal(accepted.status, 201);
  assert.deepEqual(calls.generate[0]?.input, { count: 1, amountMinorUnits: '0005000', currency: 'USD' });
});

test('operations list validates the query and passes filters through', async () => {
  const { calls, get } = opsHarness();
  for (const query of ['?status=bogus', '?limit=0', '?limit=101', '?limit=1&limit=2', '?cursor=', '?unexpected=x']) {
    const response = await get(`${OPS_PATH}${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(errorCode(response.body), 'INVALID_QUERY', query);
  }
  assert.equal(calls.list.length, 0);

  const bare = await get(OPS_PATH);
  assert.equal(bare.status, 200);
  assert.deepEqual(calls.list[0]?.input, {});
});

test('operations disable returns the view and rejects bodies', async () => {
  const { calls, post } = opsHarness();
  const response = await post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, { ...CODE_VIEW, status: 'disabled', disabledAt: '2026-10-11T00:00:00.000Z' });
  assert.deepEqual(calls.disable, [{ actor: { userId: OPERATOR_ID }, codeId: CODE_ID }]);

  const withBody = await post(`${OPS_PATH}/${CODE_ID}/disable`, { reason: 'no body allowed' });
  assert.equal(withBody.status, 400);
  assert.equal(errorCode(withBody.body), 'BODY_NOT_ALLOWED');
  assert.equal(calls.disable.length, 1);
});

test('operations routes map domain errors and rebuild unexpected errors generically', async () => {
  const unknownCode = opsHarness({ disableError: new MarketingRedeemError('REDEEM_CODE_INVALID') });
  const missing = await unknownCode.post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(missing.status, 400);
  assert.equal(errorCode(missing.body), 'REDEEM_CODE_INVALID');
  assert.equal(errorMessage(missing.body), 'The redeem code is invalid');

  const conflict = opsHarness({ disableError: new MarketingRedeemError('REDEEM_CODE_STATE_CONFLICT') });
  const raced = await conflict.post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(raced.status, 409);

  const badInput = opsHarness({ generateError: new MarketingRedeemError('REDEEM_INVALID_INPUT') });
  const invalid = await badInput.post(OPS_PATH, { count: 1, amountMinorUnits: '5000', currency: 'USD' });
  assert.equal(invalid.status, 400);

  const internal = opsHarness({ listError: new Error('FATAL: password authentication failed for user root') });
  const failed = await internal.get(OPS_PATH);
  assert.equal(failed.status, 500);
  assert.equal(errorCode(failed.body), 'INTERNAL_ERROR');
  assert.ok(!errorMessage(failed.body).includes('password'), 'internal details must not leak');
});

test('operations routes report 503 when the redeem-code service is absent', async () => {
  const { get, post } = opsHarness({ withService: false });
  const listed = await get(OPS_PATH);
  assert.equal(listed.status, 503);
  assert.equal(errorCode(listed.body), 'MARKETING_REDEEM_CODES_UNAVAILABLE');
  const generated = await post(OPS_PATH, { count: 1, amountMinorUnits: '5000', currency: 'USD' });
  assert.equal(generated.status, 503);
  const disabled = await post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(disabled.status, 503);
});

test('operations routes reject wrong methods and leave foreign paths unmatched', async () => {
  const { calls, handler } = opsHarness();
  const patched = await invoke(handler, OPS_ORIGIN, { path: OPS_PATH, method: 'PATCH' });
  assert.equal(patched.matched, true);
  assert.equal(patched.status, 405);
  assert.equal(patched.headers.get('allow'), 'GET, POST');

  const getDisable = await invoke(handler, OPS_ORIGIN, { path: `${OPS_PATH}/${CODE_ID}/disable`, method: 'GET' });
  assert.equal(getDisable.status, 405);
  assert.equal(getDisable.headers.get('allow'), 'POST');

  for (const path of [
    '/admin/api/v1/marketing/promo-codes',
    `${OPS_PATH}/${CODE_ID}`,
    `${OPS_PATH}/`,
    '/console/api/v1/tenants/x/redeem',
  ]) {
    const missed = await invoke(handler, OPS_ORIGIN, { path, method: 'POST' });
    assert.equal(missed.matched, false, path);
  }
  assert.equal(calls.generate.length + calls.list.length + calls.disable.length, 0);
});
