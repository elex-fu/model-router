import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import {
  createPlatformRefundHttpHandler,
  type PlatformRefundService,
} from '../../../src/saas/payments/platform-refunds-http.js';
import type { PaymentRefundRecord } from '../../../src/saas/payments/types.js';
import type { PlatformAdminActor } from '../../../src/saas/platform/access/types.js';

const FINANCE: PlatformAdminActor = {
  userId: '00000000-0000-4000-8000-000000000002',
  sessionId: 'platform-session-1',
  roles: ['finance'],
};
const SESSION = 'platform-session-token';
const CSRF = 'platform-csrf-token';
const TENANT = '00000000-0000-4000-8000-000000000001';
const ORDER = '00000000-0000-4000-8000-000000000003';
const REFUND = '00000000-0000-4000-8000-000000000004';
const BASE = 'https://platform-admin.test';

const RECORD: PaymentRefundRecord = {
  id: REFUND,
  tenantId: TENANT,
  refundType: 'wallet_topup',
  originalOrderId: ORDER,
  amountMinorUnits: '1250',
  currency: 'USD',
  status: 'unknown',
  providerRefundId: null,
  failureCode: null,
  blockedCode: null,
  walletRefundTransactionId: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  updatedAt: '2026-09-29T00:00:00.000Z',
  completedAt: null,
};

interface Calls {
  readonly requests: Array<Record<string, unknown>>;
  readonly reads: Array<[string, string]>;
}

function createService(calls: Calls): PlatformRefundService {
  return {
    async requestPlatformWalletTopUpRefund(input) {
      calls.requests.push(structuredClone(input));
      return structuredClone(RECORD);
    },
    async getRefund(tenantId, refundId) {
      calls.reads.push([tenantId, refundId]);
      return tenantId === TENANT && refundId === REFUND ? structuredClone(RECORD) : null;
    },
  };
}

async function harness(actor: PlatformAdminActor | undefined) {
  const calls: Calls = { requests: [], reads: [] };
  const handler = createPlatformRefundHttpHandler({
    access: { authenticate: async () => actor },
    service: createService(calls),
    publicOrigin: BASE,
    authService: {
      verifyCsrfToken: async (token, csrf) => token === SESSION && csrf === CSRF,
    },
  });
  return {
    calls,
    async request(path: string, init: RequestInit = {}) {
      const url = new URL(path, BASE);
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
      let responseBody = '';
      let ended = false;
      const res = {
        destroyed: false,
        get writableEnded() {
          return ended;
        },
        writeHead(code: number, values: Record<string, unknown> = {}) {
          status = code;
          responseHeaders = new Headers(Object.entries(values).map(([key, value]) => [key, String(value)]));
          return res;
        },
        end(value?: unknown) {
          responseBody = value === undefined ? '' : String(value);
          ended = true;
          return res;
        },
      } as unknown as ServerResponse;
      assert.equal(await handler(req, res), true);
      return {
        status,
        headers: responseHeaders,
        body: JSON.parse(responseBody) as Record<string, unknown>,
      };
    },
  };
}

function postInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      origin: BASE,
      host: 'platform-admin.test',
      cookie: `${'mr_platform_admin_session'}=${SESSION}; mr_platform_admin_csrf=${CSRF}`,
      'x-csrf-token': CSRF,
      'content-type': 'application/json',
      'idempotency-key': 'platform-refund-request-1',
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

test('platform refund write rejects non-finance roles before invoking the refund service', async () => {
  const app = await harness({ ...FINANCE, roles: ['support-readonly'] });
  const response = await app.request(
    `${BASE}/admin/api/v1/payments/refunds`,
    postInit({ tenantId: TENANT, orderId: ORDER, reasonCode: 'OPERATOR_APPROVED' }),
  );
  assert.equal(response.status, 403);
  assert.equal(errorCode(response.body), 'FORBIDDEN');
  assert.equal(app.calls.requests.length, 0);

  const read = await app.request(`${BASE}/admin/api/v1/payments/refunds/${TENANT}/${REFUND}`);
  assert.equal(read.status, 403);
  assert.equal(errorCode(read.body), 'FORBIDDEN');
  assert.equal(app.calls.reads.length, 0);
});

test('platform refund write derives actor and idempotency from the authenticated request and rejects snapshots', async () => {
  const app = await harness(FINANCE);
  const path = `${BASE}/admin/api/v1/payments/refunds`;
  const rejected = await app.request(
    path,
    postInit({
      tenantId: TENANT,
      orderId: ORDER,
      reasonCode: 'OPERATOR_APPROVED',
      actorId: 'client-controlled-actor',
      merchantId: 'client-controlled-merchant',
      amountMinorUnits: '1',
    }),
  );
  assert.equal(rejected.status, 400);
  assert.equal(errorCode(rejected.body), 'INVALID_BODY');

  const response = await app.request(
    path,
    postInit({
      tenantId: TENANT,
      orderId: ORDER,
      reasonCode: 'OPERATOR_APPROVED',
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(app.calls.requests.length, 1);
  assert.deepEqual(app.calls.requests[0], {
    actorId: FINANCE.userId,
    sessionId: FINANCE.sessionId,
    actorRoles: FINANCE.roles,
    tenantId: TENANT,
    orderId: ORDER,
    clientRequestId: 'platform-refund-request-1',
    reasonCode: 'OPERATOR_APPROVED',
  });
  assert.equal('amountMinorUnits' in (app.calls.requests[0] ?? {}), false);
});

test('platform refund read scopes lookup by the tenant in the route', async () => {
  const app = await harness(FINANCE);
  const response = await app.request(`${BASE}/admin/api/v1/payments/refunds/${TENANT}/${REFUND}`);
  assert.equal(response.status, 200);
  assert.deepEqual(app.calls.reads, [[TENANT, REFUND]]);
  const crossTenant = await app.request(
    `${BASE}/admin/api/v1/payments/refunds/00000000-0000-4000-8000-000000000009/${REFUND}`,
  );
  assert.equal(crossTenant.status, 404);
  assert.deepEqual(app.calls.reads[1], ['00000000-0000-4000-8000-000000000009', REFUND]);
});
