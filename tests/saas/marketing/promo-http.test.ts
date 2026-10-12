import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { MarketingPromoError, type PromoCodeView } from '../../../src/saas/marketing/promo-codes.js';
import {
  createMarketingOpsPromoCodesHandler,
  type MarketingPromoHttpHandler,
} from '../../../src/saas/marketing/promo-http.js';
import type { PlatformAdminActor, PlatformAdminRole } from '../../../src/saas/platform/access/types.js';

// R1/G2 promo-code operations HTTP suite. The handler is driven through a
// synthetic request/response pair; the domain service is a recording stub.

const OPS_ORIGIN = 'https://platform-admin.test';
const OPS_HOST = 'platform-admin.test';
const OPS_SESSION = 'platform-session-token';
const OPS_CSRF = 'platform-csrf-token';
const OPERATOR_ID = '44444444-4444-4444-8444-444444444444';
const CODE_ID = '33333333-3333-4333-8333-333333333333';
const OPS_PATH = '/admin/api/v1/marketing/promo-codes';

const CODE_VIEW: PromoCodeView = {
  id: CODE_ID,
  code: 'SAVE-25',
  kind: 'percent_off',
  percentBp: 2500,
  amountMinorUnits: null,
  currency: null,
  scope: 'wallet_topup',
  startsAt: null,
  endsAt: null,
  maxUses: null,
  perTenantOnce: true,
  status: 'active',
  createdByUserId: OPERATOR_ID,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  disabledAt: null,
};

interface Snapshot {
  readonly matched: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

async function invoke(
  handler: MarketingPromoHttpHandler,
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
  let parsed: Record<string, unknown> = {};
  if (responseText !== '') parsed = JSON.parse(responseText) as Record<string, unknown>;
  return { matched, status, headers: responseHeaders, body: parsed };
}

function errorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error as Record<string, unknown> | undefined;
  return typeof error?.code === 'string' ? error.code : undefined;
}

interface OpsOverrides {
  readonly roles?: readonly PlatformAdminRole[];
  readonly unauthenticated?: boolean;
  readonly withService?: boolean;
  readonly createError?: unknown;
  readonly listError?: unknown;
  readonly disableError?: unknown;
}

function opsHarness(overrides: OpsOverrides = {}) {
  const calls: {
    readonly create: Array<{ actor: unknown; input: unknown }>;
    readonly list: Array<{ actor: unknown; input: unknown }>;
    readonly disable: Array<{ actor: unknown; codeId: unknown }>;
  } = { create: [], list: [], disable: [] };
  const actor: PlatformAdminActor | undefined = overrides.unauthenticated
    ? undefined
    : { userId: OPERATOR_ID, sessionId: 'platform-session-id', roles: overrides.roles ?? ['operations'] };
  const promoCodes = {
    createPromoCode: async (actorArg: { userId: string }, input: unknown) => {
      calls.create.push({ actor: structuredClone(actorArg), input: structuredClone(input) });
      if (overrides.createError !== undefined) throw overrides.createError;
      return structuredClone(CODE_VIEW);
    },
    listPromoCodes: async (actorArg: { userId: string }, input: Record<string, unknown>) => {
      calls.list.push({ actor: structuredClone(actorArg), input: structuredClone(input) });
      if (overrides.listError !== undefined) throw overrides.listError;
      return { codes: [structuredClone(CODE_VIEW)], nextCursor: 'cursor-1' };
    },
    disablePromoCode: async (actorArg: { userId: string }, codeId: string) => {
      calls.disable.push({ actor: structuredClone(actorArg), codeId });
      if (overrides.disableError !== undefined) throw overrides.disableError;
      return { ...structuredClone(CODE_VIEW), status: 'disabled' as const, disabledAt: '2026-10-11T00:00:00.000Z' };
    },
  };
  const handler = createMarketingOpsPromoCodesHandler({
    access: { authenticate: async () => actor },
    authService: {
      verifyCsrfToken: async (token: string, csrf: string) => token === OPS_SESSION && csrf === OPS_CSRF,
    },
    ...(overrides.withService === false ? {} : { promoCodes }),
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

const PERCENT_BODY = { kind: 'percent_off', code: 'save-25', percentBp: 2500 };
const AMOUNT_BODY = { kind: 'amount_off', code: 'TAKE500', amountMinorUnits: '500', currency: 'USD' };

test('ops promo routes match only their own paths', async () => {
  const { handler, post } = opsHarness();
  for (const path of [
    '/admin/api/v1/marketing/redeem-codes',
    '/admin/api/v1/marketing/promo-codes/extra/deep/path',
    '/admin/api/v1/marketing/promo-codesx',
    '/console/api/v1/tenants/x/orders',
  ]) {
    const missed = await invoke(handler, OPS_ORIGIN, { path, method: 'POST' });
    assert.equal(missed.matched, false, path);
  }
  const hit = await post(OPS_PATH, PERCENT_BODY);
  assert.equal(hit.matched, true);
  const disableHit = await post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(disableHit.matched, true);
});

test('ops promo routes reject wrong methods with 405 and an allow header', async () => {
  const { calls, handler } = opsHarness();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const collection = await invoke(handler, OPS_ORIGIN, { path: OPS_PATH, method });
    assert.equal(collection.status, 405, method);
    assert.equal(collection.headers.get('allow'), 'GET, POST', method);
    const disable = await invoke(handler, OPS_ORIGIN, { path: `${OPS_PATH}/${CODE_ID}/disable`, method });
    assert.equal(disable.status, 405, method);
    assert.equal(disable.headers.get('allow'), 'POST', method);
  }
  assert.equal(calls.create.length + calls.list.length + calls.disable.length, 0);
});

test('ops promo routes enforce the operations/finance role band', async () => {
  for (const roles of [['operations'], ['finance'], ['superadmin']] as const) {
    const { get, post } = opsHarness({ roles });
    assert.equal((await get(OPS_PATH)).status, 200, roles.join(','));
    assert.equal((await post(OPS_PATH, PERCENT_BODY)).status, 201, roles.join(','));
  }
  for (const roles of [['support-readonly'], ['security'], []] as const) {
    const app = opsHarness({ roles });
    assert.equal((await app.get(OPS_PATH)).status, 403, roles.join(','));
    assert.equal((await app.post(OPS_PATH, PERCENT_BODY)).status, 403, roles.join(','));
    assert.equal((await app.post(`${OPS_PATH}/${CODE_ID}/disable`)).status, 403, roles.join(','));
    assert.equal(app.calls.create.length + app.calls.list.length + app.calls.disable.length, 0);
  }
  const anonymous = opsHarness({ unauthenticated: true });
  assert.equal((await anonymous.get(OPS_PATH)).status, 401);
  assert.equal((await anonymous.post(OPS_PATH, PERCENT_BODY)).status, 401);
});

test('ops promo create derives the actor from the session and passes the strict body through', async () => {
  const { calls, post } = opsHarness();
  const response = await post(OPS_PATH, {
    ...PERCENT_BODY,
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-12-01T00:00:00Z',
    maxUses: 100,
    perTenantOnce: false,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(calls.create[0]?.actor, { userId: OPERATOR_ID });
  assert.deepEqual(calls.create[0]?.input, {
    kind: 'percent_off',
    code: 'save-25',
    percentBp: 2500,
    startsAt: '2026-10-01T00:00:00Z',
    endsAt: '2026-12-01T00:00:00Z',
    maxUses: 100,
    perTenantOnce: false,
  });

  const amount = await post(OPS_PATH, AMOUNT_BODY);
  assert.equal(amount.status, 201);
  assert.deepEqual(calls.create[1]?.input, AMOUNT_BODY);
});

test('ops promo create enforces the kind-disjoint strict body', async () => {
  const { calls, post } = opsHarness();
  const bad = async (body: unknown, name: string) => {
    const response = await post(OPS_PATH, body);
    assert.equal(response.status, 400, name);
    assert.equal(errorCode(response.body), 'INVALID_BODY', name);
  };

  await bad({ ...PERCENT_BODY, actorId: 'spoof' }, 'unknown field rejected');
  await bad({ ...PERCENT_BODY, amountMinorUnits: '500' }, 'cross-kind field rejected');
  await bad({ ...AMOUNT_BODY, percentBp: 100 }, 'cross-kind percent rejected');
  await bad({ code: 'SAVE-25', percentBp: 2500 }, 'kind required');
  await bad({ kind: 'balance', code: 'SAVE-25' }, 'unknown kind rejected');
  await bad({ kind: 'percent_off', code: 'SAVE-25' }, 'percentBp required');
  await bad({ kind: 'percent_off', code: 'SAVE-25', percentBp: 0 }, 'percentBp lower bound');
  await bad({ kind: 'percent_off', code: 'SAVE-25', percentBp: 10000 }, 'percentBp upper bound');
  await bad({ kind: 'percent_off', code: 'SAVE-25', percentBp: 12.5 }, 'percentBp integer');
  await bad({ kind: 'percent_off', code: 'SAVE-25', percentBp: '2500' }, 'percentBp type');
  await bad({ kind: 'amount_off', code: 'TAKE500', amountMinorUnits: '500' }, 'currency required');
  await bad({ kind: 'amount_off', code: 'TAKE500', amountMinorUnits: 500, currency: 'USD' }, 'amount type');
  await bad({ ...PERCENT_BODY, maxUses: 0 }, 'maxUses bound');
  await bad({ ...PERCENT_BODY, maxUses: '10' }, 'maxUses type');
  await bad({ ...PERCENT_BODY, perTenantOnce: 'yes' }, 'perTenantOnce type');
  await bad({ ...PERCENT_BODY, startsAt: 42 }, 'startsAt type');
  await bad('null', 'object required');
  assert.equal(calls.create.length, 0);

  const notJson = await post(OPS_PATH, '{broken');
  assert.equal(notJson.status, 400);
  assert.equal(errorCode(notJson.body), 'INVALID_JSON');
  const wrongType = await post(OPS_PATH, PERCENT_BODY, { 'content-type': 'text/plain' });
  assert.equal(wrongType.status, 415);
  const oversized = await post(OPS_PATH, { ...PERCENT_BODY, code: `A${'1'.repeat(9000)}` });
  assert.equal(oversized.status, 413);
});

test('ops promo mutations require same-origin and a valid CSRF token', async () => {
  const { calls, post } = opsHarness();
  const noOrigin = await post(OPS_PATH, PERCENT_BODY, { origin: undefined });
  assert.equal(noOrigin.status, 403);
  assert.equal(errorCode(noOrigin.body), 'ORIGIN_REQUIRED');
  const wrongOrigin = await post(OPS_PATH, PERCENT_BODY, { origin: 'https://evil.test' });
  assert.equal(wrongOrigin.status, 403);
  const wrongHost = await post(OPS_PATH, PERCENT_BODY, { host: 'evil.test' });
  assert.equal(wrongHost.status, 403);
  const noCsrf = await post(OPS_PATH, PERCENT_BODY, { 'x-csrf-token': undefined });
  assert.equal(noCsrf.status, 403);
  assert.equal(errorCode(noCsrf.body), 'CSRF_REJECTED');
  const wrongCsrf = await post(OPS_PATH, PERCENT_BODY, { 'x-csrf-token': 'wrong' });
  assert.equal(wrongCsrf.status, 403);
  assert.equal(calls.create.length, 0);
});

test('ops promo list parses the query strictly and needs no CSRF', async () => {
  const { calls, get } = opsHarness();
  const listed = await get(`${OPS_PATH}?status=active&limit=10&cursor=abc`);
  assert.equal(listed.status, 200);
  assert.deepEqual(calls.list[0]?.input, { status: 'active', limit: 10, cursor: 'abc' });
  const body = listed.body as { data: { items: unknown[]; nextCursor: string | null } };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.nextCursor, 'cursor-1');

  const defaults = await get(OPS_PATH);
  assert.equal(defaults.status, 200);
  assert.deepEqual(calls.list[1]?.input, {});

  for (const query of ['?status=paused', '?limit=0', '?limit=101', '?limit=x', '?bogus=1', '?limit=1&limit=2']) {
    const response = await get(`${OPS_PATH}${query}`);
    assert.equal(response.status, 400, query);
    assert.equal(errorCode(response.body), 'INVALID_QUERY', query);
  }
  assert.equal(calls.list.length, 2);
});

test('ops promo disable rejects a body and rebuilds domain errors', async () => {
  const { calls, post } = opsHarness();
  const disabled = await post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(disabled.status, 200);
  assert.deepEqual(calls.disable[0], { actor: { userId: OPERATOR_ID }, codeId: CODE_ID });

  const withBody = await post(`${OPS_PATH}/${CODE_ID}/disable`, { bogus: true });
  assert.equal(withBody.status, 400);
  assert.equal(errorCode(withBody.body), 'BODY_NOT_ALLOWED');
  assert.equal(calls.disable.length, 1);

  const notFound = opsHarness({ disableError: new MarketingPromoError('PROMO_CODE_NOT_FOUND') });
  assert.equal((await notFound.post(`${OPS_PATH}/${CODE_ID}/disable`)).status, 404);
  const conflict = opsHarness({ disableError: new MarketingPromoError('PROMO_CODE_STATE_CONFLICT') });
  const conflictResponse = await conflict.post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(conflictResponse.status, 409);
  assert.equal(errorCode(conflictResponse.body), 'PROMO_CODE_STATE_CONFLICT');
  const invalid = opsHarness({ disableError: new MarketingPromoError('PROMO_INVALID_INPUT') });
  assert.equal((await invalid.post(`${OPS_PATH}/${CODE_ID}/disable`)).status, 400);
  const unexpected = opsHarness({ disableError: new Error('boom') });
  const unexpectedResponse = await unexpected.post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(unexpectedResponse.status, 500);
  assert.equal(errorCode(unexpectedResponse.body), 'INTERNAL_ERROR');
});

test('ops promo create rebuilds the duplicate-code conflict and storage failures generically', async () => {
  const conflict = opsHarness({ createError: new MarketingPromoError('PROMO_CODE_CONFLICT') });
  const conflictResponse = await conflict.post(OPS_PATH, PERCENT_BODY);
  assert.equal(conflictResponse.status, 409);
  assert.equal(errorCode(conflictResponse.body), 'PROMO_CODE_CONFLICT');

  const storage = opsHarness({ createError: new MarketingPromoError('PROMO_STORAGE_ERROR') });
  const storageResponse = await storage.post(OPS_PATH, PERCENT_BODY);
  assert.equal(storageResponse.status, 500);
  assert.equal(errorCode(storageResponse.body), 'INTERNAL_ERROR');

  const forbidden = opsHarness({ createError: new MarketingPromoError('PROMO_FORBIDDEN') });
  assert.equal((await forbidden.post(OPS_PATH, PERCENT_BODY)).status, 403);
});

test('ops promo routes fail closed with 503 when the service is not configured', async () => {
  const { get, post } = opsHarness({ withService: false });
  const listed = await get(OPS_PATH);
  assert.equal(listed.status, 503);
  assert.equal(errorCode(listed.body), 'MARKETING_PROMO_CODES_UNAVAILABLE');
  const created = await post(OPS_PATH, PERCENT_BODY);
  assert.equal(created.status, 503);
  const disabled = await post(`${OPS_PATH}/${CODE_ID}/disable`);
  assert.equal(disabled.status, 503);
});

test('ops promo routes rebuild list errors and never disclose internals', async () => {
  const invalid = opsHarness({ listError: new MarketingPromoError('PROMO_INVALID_INPUT') });
  assert.equal((await invalid.get(`${OPS_PATH}?cursor=abc`)).status, 400);
  const boom = opsHarness({ listError: new Error('sensitive detail') });
  const response = await boom.get(OPS_PATH);
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response.body).includes('sensitive detail'), false);
});
