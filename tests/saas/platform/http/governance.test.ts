import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { PlatformAdminActor } from '../../../../src/saas/platform/access/index.js';
import { PlatformGovernanceError } from '../../../../src/saas/platform/governance/errors.js';
import {
  createPlatformAdminReadHandler,
  type PlatformAdminGovernanceServices,
  type PlatformAdminReadHandlerOptions,
} from '../../../../src/saas/platform/http/index.js';

const SESSION_TOKEN = 'platform-session-token';
const CSRF_TOKEN = 'platform-csrf-token';
const TARGET_USER = '10000000-0000-4000-8000-0000000000b1';
const TARGET_TENANT = '20000000-0000-4000-8000-0000000000a1';

function actor(roles: PlatformAdminActor['roles']): PlatformAdminActor {
  return { userId: '10000000-0000-4000-8000-0000000000aa', sessionId: 'session-1', roles };
}

interface GovernanceCalls {
  listUsers: unknown[];
  setUserDisabled: unknown[];
  resetUserPassword: unknown[];
  resetUserMfa: unknown[];
  listTenants: unknown[];
  setTenantStatus: unknown[];
  takeoverTenant: unknown[];
  listOperators: unknown[];
  grantOperatorRole: unknown[];
  revokeOperatorRole: unknown[];
  createOperator: unknown[];
}

function makeGovernance(calls: GovernanceCalls): PlatformAdminGovernanceServices {
  return {
    users: {
      listUsers: async (actorArg, query) => {
        calls.listUsers.push({ actor: actorArg, query });
        return {
          items: [
            {
              id: TARGET_USER,
              email: 'target@example.test',
              displayName: 'Target',
              emailVerifiedAt: null,
              disabledAt: null,
              createdAt: '2026-02-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        };
      },
      setUserDisabled: async (...args) => {
        calls.setUserDisabled.push(args);
      },
      resetUserPassword: async (...args) => {
        calls.resetUserPassword.push(args);
      },
      resetUserMfa: async (...args) => {
        calls.resetUserMfa.push(args);
      },
    },
    tenants: {
      listTenants: async (actorArg, query) => {
        calls.listTenants.push({ actor: actorArg, query });
        return {
          items: [
            {
              id: TARGET_TENANT,
              name: 'Alpha',
              slug: 'alpha',
              status: 'active',
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        };
      },
      setTenantStatus: async (...args) => {
        calls.setTenantStatus.push(args);
        return {
          id: TARGET_TENANT,
          name: 'Alpha',
          slug: 'alpha',
          status: 'suspended',
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
        };
      },
      takeoverTenant: async (...args) => {
        calls.takeoverTenant.push(args);
      },
    },
    operators: {
      listOperators: async (actorArg) => {
        calls.listOperators.push(actorArg);
        return [
          {
            userId: TARGET_USER,
            email: 'operator@example.test',
            displayName: null,
            disabledAt: null,
            roles: ['superadmin'],
          },
        ];
      },
      grantOperatorRole: async (...args) => {
        calls.grantOperatorRole.push(args);
      },
      revokeOperatorRole: async (...args) => {
        calls.revokeOperatorRole.push(args);
      },
      createOperator: async (...args) => {
        calls.createOperator.push(args);
        return {
          userId: TARGET_USER,
          email: 'new@example.test',
          displayName: null,
          disabledAt: null,
          roles: ['operations'],
        };
      },
    },
  };
}

function makeOptions(
  currentActor: PlatformAdminActor | undefined,
  governance?: PlatformAdminGovernanceServices,
  calls?: GovernanceCalls,
) {
  const options: PlatformAdminReadHandlerOptions = {
    access: { authenticate: async () => currentActor },
    operations: { getSummary: async () => ({ summary: 'ok' }) },
    catalog: {
      listProducts: async () => ({ items: [] }),
      listCapabilities: async () => ({ items: [] }),
      listRights: async () => ({ items: [] }),
    },
    writeSecurity: {
      publicOrigin: 'https://platform-admin.test',
      authService: {
        verifyCsrfToken: async (sessionToken, csrfToken) => sessionToken === SESSION_TOKEN && csrfToken === CSRF_TOKEN,
      },
    },
    ...(governance === undefined ? {} : { governance }),
  };
  return { options, calls };
}

function writeInit(body: unknown, overrides: Record<string, string> = {}, method = 'POST'): RequestInit {
  return {
    method,
    headers: {
      origin: 'https://platform-admin.test',
      host: 'platform-admin.test',
      cookie: `mr_platform_admin_session=${SESSION_TOKEN}; mr_platform_admin_csrf=${CSRF_TOKEN}`,
      'x-csrf-token': CSRF_TOKEN,
      'content-type': 'application/json',
      ...overrides,
    },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  };
}

async function startHarness(options: PlatformAdminReadHandlerOptions) {
  const handler = createPlatformAdminReadHandler(options);
  return {
    async request(target: string, init?: RequestInit) {
      const url = new URL(target, 'http://platform-admin.test');
      const req = {
        url: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        destroyed: false,
        socket: { remoteAddress: '203.0.113.10' },
        resume() {
          return req;
        },
        async *[Symbol.asyncIterator]() {
          if (init?.body !== undefined) yield Buffer.from(String(init.body));
        },
      } as unknown as IncomingMessage;
      let status = 200;
      let responseBody = '';
      const responseHeaders: Record<string, unknown> = {};
      const res = {
        destroyed: false,
        writableEnded: false,
        writeHead(code: number, headers: Record<string, unknown> = {}) {
          status = code;
          Object.assign(responseHeaders, headers);
          return res;
        },
        end(body?: unknown) {
          responseBody = body === undefined ? '' : String(body);
          return res;
        },
      } as unknown as ServerResponse;
      const handled = await handler(req, res);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        // unhandled routes return no JSON
      }
      return { status, handled, body, headers: responseHeaders };
    },
  };
}

function errorCode(body: Record<string, unknown>): string {
  const error = body.error as Record<string, unknown> | undefined;
  assert.ok(error);
  return String(error.code);
}

test('GET /governance/users enforces the read role band and passes the normalized query through', async () => {
  const calls: GovernanceCalls = {
    listUsers: [],
    setUserDisabled: [],
    resetUserPassword: [],
    resetUserMfa: [],
    listTenants: [],
    setTenantStatus: [],
    takeoverTenant: [],
    listOperators: [],
    grantOperatorRole: [],
    revokeOperatorRole: [],
    createOperator: [],
  };
  const governance = makeGovernance(calls);
  for (const roles of [['superadmin'], ['security'], ['operations'], ['support-readonly']] as const) {
    const { options } = makeOptions(actor([...roles]), governance, calls);
    const app = await startHarness(options);
    const response = await app.request(
      '/admin/api/v1/governance/users?limit=25&status=active&emailContains=target%40&cursor=cursor%2F1',
    );
    assert.equal(response.status, 200);
    assert.equal(response.handled, true);
    assert.deepEqual(calls.listUsers.at(-1), {
      actor: actor([...roles]),
      query: { limit: 25, cursor: 'cursor/1', emailContains: 'target@', status: 'active' },
    });
    const data = response.body.data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ['items', 'nextCursor']);
    assert.doesNotMatch(JSON.stringify(response.body), /password|hash/i);
  }

  const denied = await startHarness(makeOptions(actor(['finance']), governance).options);
  const forbiddenResponse = await denied.request('/admin/api/v1/governance/users');
  assert.equal(forbiddenResponse.status, 403);

  const unauthenticated = await startHarness(makeOptions(undefined, governance).options);
  assert.equal((await unauthenticated.request('/admin/api/v1/governance/users')).status, 401);

  const badStatus = await startHarness(makeOptions(actor(['operations']), governance).options);
  const invalid = await badStatus.request('/admin/api/v1/governance/users?status=deleted');
  assert.equal(invalid.status, 400);
  assert.equal(errorCode(invalid.body), 'INVALID_QUERY');

  const absent = await startHarness(makeOptions(actor(['operations'])).options);
  const unavailable = await absent.request('/admin/api/v1/governance/users');
  assert.equal(unavailable.status, 503);
  assert.equal(errorCode(unavailable.body), 'GOVERNANCE_UNAVAILABLE');
});

test('user mutations enforce the write role band, CSRF, strict bodies, and map domain errors safely', async () => {
  const calls: GovernanceCalls = {
    listUsers: [],
    setUserDisabled: [],
    resetUserPassword: [],
    resetUserMfa: [],
    listTenants: [],
    setTenantStatus: [],
    takeoverTenant: [],
    listOperators: [],
    grantOperatorRole: [],
    revokeOperatorRole: [],
    createOperator: [],
  };
  const governance = makeGovernance(calls);
  const { options } = makeOptions(actor(['security']), governance);
  const app = await startHarness(options);

  const disable = await app.request(`/admin/api/v1/governance/users/${TARGET_USER}/disable`, writeInit({}));
  assert.equal(disable.status, 200);
  assert.deepEqual(disable.body.data, { ok: true });
  assert.deepEqual(calls.setUserDisabled.at(-1), [actor(['security']), TARGET_USER, true]);

  const enable = await app.request(`/admin/api/v1/governance/users/${TARGET_USER}/enable`, writeInit({}));
  assert.equal(enable.status, 200);
  assert.deepEqual(calls.setUserDisabled.at(-1), [actor(['security']), TARGET_USER, false]);

  const mfaReset = await app.request(`/admin/api/v1/governance/users/${TARGET_USER}/mfa-reset`, writeInit({}));
  assert.equal(mfaReset.status, 200);
  assert.equal(calls.resetUserMfa.length, 1);

  const passwordReset = await app.request(
    `/admin/api/v1/governance/users/${TARGET_USER}/password-reset`,
    writeInit({ password: 'operator-set-passphrase' }),
  );
  assert.equal(passwordReset.status, 200);
  assert.deepEqual(calls.resetUserPassword.at(-1), [actor(['security']), TARGET_USER, 'operator-set-passphrase']);
  assert.doesNotMatch(JSON.stringify(passwordReset.body), /operator-set-passphrase/);

  // operations is excluded from user mutations even though it can write elsewhere.
  const operationsActor = await startHarness(makeOptions(actor(['operations']), governance).options);
  const denied = await operationsActor.request(`/admin/api/v1/governance/users/${TARGET_USER}/disable`, writeInit({}));
  assert.equal(denied.status, 403);

  // CSRF failure rejects before any service call.
  const csrfCallsBefore = calls.setUserDisabled.length;
  const badCsrf = await app.request(
    `/admin/api/v1/governance/users/${TARGET_USER}/disable`,
    writeInit({}, { 'x-csrf-token': 'wrong-token' }),
  );
  assert.equal(badCsrf.status, 403);
  assert.equal(calls.setUserDisabled.length, csrfCallsBefore);

  // Strict body allowlist and method gate.
  const extraKey = await app.request(
    `/admin/api/v1/governance/users/${TARGET_USER}/disable`,
    writeInit({ reason: 'not allowed' }),
  );
  assert.equal(extraKey.status, 400);
  const wrongMethod = await app.request(`/admin/api/v1/governance/users/${TARGET_USER}/disable`);
  assert.equal(wrongMethod.status, 405);

  // Domain errors map to their public status with the safe message only.
  const failingGovernance = makeGovernance({
    ...calls,
    resetUserMfa: [],
  });
  failingGovernance.users.resetUserMfa = async () => {
    throw new PlatformGovernanceError('GOVERNANCE_NOT_FOUND');
  };
  const failing = await startHarness(makeOptions(actor(['security']), failingGovernance).options);
  const notFound = await failing.request(`/admin/api/v1/governance/users/${TARGET_USER}/mfa-reset`, writeInit({}));
  assert.equal(notFound.status, 404);
  assert.equal(errorCode(notFound.body), 'GOVERNANCE_NOT_FOUND');
  assert.doesNotMatch(JSON.stringify(notFound.body), /target@example|secret/i);
});

test('tenant lifecycle and takeover enforce their role bands', async () => {
  const calls: GovernanceCalls = {
    listUsers: [],
    setUserDisabled: [],
    resetUserPassword: [],
    resetUserMfa: [],
    listTenants: [],
    setTenantStatus: [],
    takeoverTenant: [],
    listOperators: [],
    grantOperatorRole: [],
    revokeOperatorRole: [],
    createOperator: [],
  };
  const governance = makeGovernance(calls);
  const operationsApp = await startHarness(makeOptions(actor(['operations']), governance).options);

  const list = await operationsApp.request('/admin/api/v1/governance/tenants?status=active&slugContains=alpha');
  assert.equal(list.status, 200);
  assert.deepEqual(calls.listTenants.at(-1), {
    actor: actor(['operations']),
    query: { cursor: null, slugContains: 'alpha', status: 'active' },
  });

  const suspend = await operationsApp.request(
    `/admin/api/v1/governance/tenants/${TARGET_TENANT}/suspend`,
    writeInit({}),
  );
  assert.equal(suspend.status, 200);
  assert.deepEqual(calls.setTenantStatus.at(-1), [actor(['operations']), TARGET_TENANT, 'suspend']);
  const data = suspend.body.data as Record<string, unknown>;
  assert.equal(data.status, 'suspended');

  // security cannot write tenant lifecycle.
  const securityApp = await startHarness(makeOptions(actor(['security']), governance).options);
  assert.equal(
    (await securityApp.request(`/admin/api/v1/governance/tenants/${TARGET_TENANT}/suspend`, writeInit({}))).status,
    403,
  );

  // takeover is superadmin-only.
  const takeoverDenied = await operationsApp.request(
    `/admin/api/v1/governance/tenants/${TARGET_TENANT}/takeover`,
    writeInit({ targetUserId: TARGET_USER }),
  );
  assert.equal(takeoverDenied.status, 403);

  const superadminApp = await startHarness(makeOptions(actor(['superadmin']), governance).options);
  const takeover = await superadminApp.request(
    `/admin/api/v1/governance/tenants/${TARGET_TENANT}/takeover`,
    writeInit({ targetUserId: TARGET_USER }),
  );
  assert.equal(takeover.status, 200);
  assert.deepEqual(calls.takeoverTenant.at(-1), [actor(['superadmin']), TARGET_TENANT, TARGET_USER]);
});

test('operator management is superadmin-only with grant, revoke, and create flows', async () => {
  const calls: GovernanceCalls = {
    listUsers: [],
    setUserDisabled: [],
    resetUserPassword: [],
    resetUserMfa: [],
    listTenants: [],
    setTenantStatus: [],
    takeoverTenant: [],
    listOperators: [],
    grantOperatorRole: [],
    revokeOperatorRole: [],
    createOperator: [],
  };
  const governance = makeGovernance(calls);
  const superadminApp = await startHarness(makeOptions(actor(['superadmin']), governance).options);

  const list = await superadminApp.request('/admin/api/v1/governance/operators');
  assert.equal(list.status, 200);
  const items = (list.body.data as Record<string, unknown>).items;
  assert.ok(Array.isArray(items));
  assert.doesNotMatch(JSON.stringify(list.body), /password/i);

  const grant = await superadminApp.request(
    `/admin/api/v1/governance/operators/${TARGET_USER}/roles`,
    writeInit({ role: 'finance' }),
  );
  assert.equal(grant.status, 200);
  assert.deepEqual(calls.grantOperatorRole.at(-1), [actor(['superadmin']), TARGET_USER, 'finance']);

  const revoke = await superadminApp.request(
    `/admin/api/v1/governance/operators/${TARGET_USER}/roles/finance`,
    writeInit(undefined, {}, 'DELETE'),
  );
  assert.equal(revoke.status, 200);
  assert.deepEqual(calls.revokeOperatorRole.at(-1), [actor(['superadmin']), TARGET_USER, 'finance']);

  const created = await superadminApp.request(
    '/admin/api/v1/governance/operators',
    writeInit({ email: 'new@example.test', password: 'initial-passphrase-01', role: 'operations' }),
  );
  assert.equal(created.status, 201);
  assert.deepEqual(calls.createOperator.at(-1), [
    actor(['superadmin']),
    { email: 'new@example.test', displayName: undefined, password: 'initial-passphrase-01', role: 'operations' },
  ]);
  assert.doesNotMatch(JSON.stringify(created.body), /initial-passphrase/);

  // operations/security/support-readonly are all excluded.
  for (const roles of [['operations'], ['security'], ['support-readonly']] as const) {
    const denied = await startHarness(makeOptions(actor([...roles]), governance).options);
    assert.equal((await denied.request('/admin/api/v1/governance/operators')).status, 403);
    assert.equal(
      (await denied.request(`/admin/api/v1/governance/operators/${TARGET_USER}/roles`, writeInit({ role: 'finance' })))
        .status,
      403,
    );
  }

  const wrongMethod = await superadminApp.request(`/admin/api/v1/governance/operators/${TARGET_USER}/roles/finance`, {
    method: 'PUT',
  });
  assert.equal(wrongMethod.status, 405);
});
