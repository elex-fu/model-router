import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { SaasMeteringError } from '../../../src/saas/metering/errors.js';
import {
  createUsageCorrectionPlatformHttpHandler,
  USAGE_CORRECTION_PLATFORM_PATHS,
  type UsageCorrectionPlatformHttpOptions,
  type UsageCorrectionPlatformOperations,
} from '../../../src/saas/metering/usage-correction-platform-http.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

const ORIGIN = 'https://platform-admin.test';
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USAGE_EVENT_ID = '33333333-3333-4333-8333-333333333333';
const SETTLEMENT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR: PlatformAdminActor = {
  userId: 'operator-from-session',
  sessionId: 'platform-session-id',
  roles: ['operations'],
};

const CORRECTION = {
  id: 'correction-1',
  tenantId: TENANT_ID,
  correctedUsageEventId: USAGE_EVENT_ID,
  correctedSettlementId: SETTLEMENT_ID,
  reasonCode: 'provider_reported_correction',
  correctionUsage: {
    inputTotal: '900',
    inputUncached: '900',
    cacheRead: '0',
    cacheWrite: '0',
    cacheWrite5m: '0',
    cacheWrite1h: '0',
    outputTotal: '80',
    reasoningOutput: '0',
    status: 'reported',
    source: 'upstream',
    semanticsVersion: 'v1',
    measurementKind: 'snapshot',
    billableBasis: 'exact',
  },
  amountDeltaMinorUnits: '25',
  currency: 'USD',
  operatorIdentity: ACTOR.userId,
  evidenceRef: null,
  correctionDigest: 'a'.repeat(64),
  createdAt: '2026-10-10T00:00:00.000Z',
} as const;

const VALID_BODY = {
  tenantId: TENANT_ID,
  usageEventId: USAGE_EVENT_ID,
  settlementId: SETTLEMENT_ID,
  reasonCode: 'provider_reported_correction',
  correctionUsage: CORRECTION.correctionUsage,
  amountDeltaMinorUnits: '25',
  currency: 'USD',
};

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

interface Calls {
  readonly list: unknown[];
  readonly record: unknown[];
  readonly csrf: unknown[];
  readonly auth: unknown[];
}

function operations(calls: Calls): UsageCorrectionPlatformOperations {
  return {
    async listCorrections(input) {
      calls.list.push(structuredClone(input));
      return [CORRECTION];
    },
    async recordCorrection(input) {
      calls.record.push(structuredClone(input));
      return { correction: CORRECTION, replayed: false, ledgerTransactionId: 'ledger-1' };
    },
  };
}

async function harness(
  actor: PlatformAdminActor | undefined,
  operationOverrides: Partial<UsageCorrectionPlatformOperations> = {},
): Promise<{
  readonly calls: Calls;
  request(path: string, init?: RequestInit): Promise<ResponseSnapshot>;
}> {
  const calls: Calls = { list: [], record: [], csrf: [], auth: [] };
  const baseOperations = operations(calls);
  const options: UsageCorrectionPlatformHttpOptions = {
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
  const handler = createUsageCorrectionPlatformHttpHandler(options);

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

test('POST records a correction with the operator identity from the session', async () => {
  const { calls, request } = await harness(ACTOR);
  const response = await request(USAGE_CORRECTION_PLATFORM_PATHS.corrections, postInit(VALID_BODY));

  assert.equal(response.status, 201);
  assert.equal(calls.record.length, 1);
  const input = calls.record[0] as Record<string, unknown>;
  assert.equal(input.actorUserId, 'operator-from-session');
  assert.equal(input.tenantId, TENANT_ID);
  assert.equal(input.usageEventId, USAGE_EVENT_ID);
  assert.equal(input.settlementId, SETTLEMENT_ID);
  assert.equal(input.amountDeltaMinorUnits, '25');
  assert.equal(input.currency, 'USD');
  const data = response.body.data as Record<string, unknown>;
  assert.equal(data.replayed, false);
});

test('POST replays report 200 with the original record', async () => {
  const { request } = await harness(ACTOR, {
    async recordCorrection() {
      return { correction: CORRECTION, replayed: true, ledgerTransactionId: null };
    },
  });
  const response = await request(USAGE_CORRECTION_PLATFORM_PATHS.corrections, postInit(VALID_BODY));
  assert.equal(response.status, 200);
  assert.equal((response.body.data as Record<string, unknown>).replayed, true);
});

test('GET lists corrections with tenant boundary validation', async () => {
  const { calls, request } = await harness(ACTOR);
  const response = await request(
    `${USAGE_CORRECTION_PLATFORM_PATHS.corrections}?tenantId=${TENANT_ID}&usageEventId=${USAGE_EVENT_ID}&limit=10`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls.list[0], { tenantId: TENANT_ID, usageEventId: USAGE_EVENT_ID, limit: 10 });
  const data = response.body.data as { items: unknown[] };
  assert.equal(data.items.length, 1);
});

test('unauthenticated and non-operations callers are rejected', async () => {
  const unauthenticated = await harness(undefined);
  const first = await unauthenticated.request(`${USAGE_CORRECTION_PLATFORM_PATHS.corrections}?tenantId=${TENANT_ID}`);
  assert.equal(first.status, 401);

  const viewer = await harness({ userId: 'viewer', sessionId: 's', roles: ['support-readonly'] });
  const second = await viewer.request(`${USAGE_CORRECTION_PLATFORM_PATHS.corrections}?tenantId=${TENANT_ID}`);
  assert.equal(second.status, 403);
  assert.equal(viewer.calls.list.length, 0);
});

test('POST without CSRF or origin is rejected before touching operations', async () => {
  const { calls, request } = await harness(ACTOR);
  const noCsrf = await request(
    USAGE_CORRECTION_PLATFORM_PATHS.corrections,
    postInit(VALID_BODY, { 'x-csrf-token': 'wrong' }),
  );
  assert.equal(noCsrf.status, 403);
  assert.equal(errorCode(noCsrf.body), 'CSRF_REJECTED');

  const foreignOrigin = await request(
    USAGE_CORRECTION_PLATFORM_PATHS.corrections,
    postInit(VALID_BODY, { origin: 'https://evil.example' }),
  );
  assert.equal(foreignOrigin.status, 403);
  assert.equal(calls.record.length, 0);
});

test('invalid bodies are rejected with bounded errors', async () => {
  const { calls, request } = await harness(ACTOR);
  for (const body of [
    { ...VALID_BODY, reasonCode: 'make_it_free' },
    { ...VALID_BODY, amountDeltaMinorUnits: '12.5' },
    { ...VALID_BODY, operatorIdentity: 'spoofed' },
    { ...VALID_BODY, correctionUsage: { ...VALID_BODY.correctionUsage, outputTotal: 'many' } },
    { tenantId: TENANT_ID },
  ]) {
    const response = await request(USAGE_CORRECTION_PLATFORM_PATHS.corrections, postInit(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.record.length, 0);
});

test('service conflicts map to their HTTP statuses', async () => {
  const conflicts: Array<[string, number]> = [
    ['USAGE_EVENT_NOT_FOUND', 404],
    ['USAGE_CORRECTION_STATE_CONFLICT', 409],
    ['USAGE_SETTLEMENT_CONFLICT', 409],
    ['METERING_INVALID_INPUT', 400],
  ];
  for (const [code, expected] of conflicts) {
    const { request } = await harness(ACTOR, {
      async recordCorrection() {
        throw new SaasMeteringError(code as never);
      },
    });
    const response = await request(USAGE_CORRECTION_PLATFORM_PATHS.corrections, postInit(VALID_BODY));
    assert.equal(response.status, expected, code);
  }
});

test('unsupported methods are rejected', async () => {
  const { request } = await harness(ACTOR);
  const response = await request(USAGE_CORRECTION_PLATFORM_PATHS.corrections, { method: 'DELETE' });
  assert.equal(response.status, 405);
});
