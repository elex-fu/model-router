import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { createSaasIdentityHandler, type SaasIdentityRateLimiter } from '../../../src/saas/identity/http.js';

const SESSION_TOKEN = 'session-token-private';
const CSRF_TOKEN = 'csrf-token-for-writes';
const INVITATION_TOKEN = 'invitation-token-once';

type ServiceOverrides = Record<string, (...args: any[]) => any>;

function makeService(overrides: ServiceOverrides = {}) {
  const calls: Record<string, unknown[][]> = {
    login: [],
    getSession: [],
    logout: [],
    listSessions: [],
    revokeSession: [],
    revokeOtherSessions: [],
    createTenant: [],
    listTenants: [],
    listProjects: [],
    createProject: [],
    createInvitation: [],
    acceptInvitation: [],
    verifyCsrfToken: [],
  };
  let loggedOut = false;
  const session = { userId: 'user-1', email: 'person@example.test', activeTenantId: 'tenant-member' };
  const record =
    (name: string, implementation: (...args: any[]) => any) =>
    async (...args: any[]) => {
      calls[name].push(args);
      return implementation(...args);
    };

  const service = {
    login: record('login', async (input) => ({
      token: SESSION_TOKEN,
      csrfToken: CSRF_TOKEN,
      session: { ...session, activeTenantId: input.activeTenantId ?? session.activeTenantId },
    })),
    getSession: record('getSession', async (token) => (token === SESSION_TOKEN && !loggedOut ? session : undefined)),
    verifyCsrfToken: record(
      'verifyCsrfToken',
      async (token, csrfToken) => token === SESSION_TOKEN && csrfToken === CSRF_TOKEN && !loggedOut,
    ),
    logout: record('logout', async (token) => {
      assert.equal(token, SESSION_TOKEN);
      loggedOut = true;
    }),
    listSessions: record('listSessions', async (token) =>
      token === SESSION_TOKEN
        ? [
            {
              id: 'session-current',
              createdAt: '2026-01-01T00:00:00.000Z',
              expiresAt: '2026-02-01T00:00:00.000Z',
              revokedAt: null,
              status: 'active',
              current: true,
            },
            {
              id: 'session-other',
              createdAt: '2025-12-01T00:00:00.000Z',
              expiresAt: '2026-01-01T00:00:00.000Z',
              revokedAt: '2025-12-02T00:00:00.000Z',
              status: 'revoked',
              current: false,
            },
          ]
        : undefined,
    ),
    revokeSession: record('revokeSession', async (token, sessionId) => {
      assert.equal(token, SESSION_TOKEN);
      if (sessionId === 'missing-session') return undefined;
      const currentSessionRevoked = sessionId === 'session-current';
      if (currentSessionRevoked) loggedOut = true;
      return { sessionId, revokedAt: '2026-01-02T03:04:05.000Z', currentSessionRevoked };
    }),
    revokeOtherSessions: record('revokeOtherSessions', async (token) => {
      assert.equal(token, SESSION_TOKEN);
      return { revokedCount: 1, currentSessionPreserved: true };
    }),
    createTenant: record('createTenant', async (userId, input) => ({ id: 'tenant-new', ownerId: userId, ...input })),
    listTenants: record('listTenants', async (userId) =>
      userId === 'user-1' ? [{ id: 'tenant-member', name: 'Member tenant' }] : [],
    ),
    listProjects: record('listProjects', async (userId, tenantId) => {
      if (userId !== 'user-1' || tenantId !== 'tenant-member') {
        throw Object.assign(new Error('project membership denied'), { status: 403 });
      }
      return [
        {
          id: 'project-1',
          tenantId,
          name: 'Member project',
          slug: 'member-project',
          role: 'owner',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          internalSecret: 'must-not-leak',
        },
      ];
    }),
    createProject: record('createProject', async (actorUserId, tenantId, input) => ({
      id: 'project-new',
      tenantId,
      name: input.name,
      slug: input.slug ?? 'derived-slug',
      role: actorUserId === 'user-1' ? 'owner' : 'viewer',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      internalSecret: 'must-not-leak',
    })),
    createInvitation: record('createInvitation', async (actorUserId, tenantId, input) => {
      if (actorUserId !== 'user-1' || tenantId !== 'tenant-member') {
        throw Object.assign(new Error('membership denied'), { status: 403 });
      }
      return { token: INVITATION_TOKEN, email: input.email, role: input.role, expiresAt: '2030-01-01T00:00:00.000Z' };
    }),
    acceptInvitation: record('acceptInvitation', async ({ token, email, displayName }) => {
      if (token !== INVITATION_TOKEN) throw Object.assign(new Error('invalid invitation'), { status: 403 });
      return { userId: 'user-2', email, displayName };
    }),
  } as Record<string, (...args: any[]) => any>;

  for (const [name, implementation] of Object.entries(overrides)) {
    service[name] = record(name, implementation);
    calls[name] ??= [];
  }
  return { service, calls };
}

class TestRateLimiter implements SaasIdentityRateLimiter {
  readonly keys: string[] = [];

  constructor(private readonly outcome: number | Error | undefined = undefined) {}

  async take(key: string): Promise<number | undefined> {
    this.keys.push(key);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

async function startServer(
  service: Record<string, (...args: any[]) => any>,
  publicOrigin?: string,
  rateLimiter?: SaasIdentityRateLimiter,
  cookieSecure = false,
  peerAddresses: readonly string[] = [],
) {
  let handler: ReturnType<typeof createSaasIdentityHandler>;
  let unhandled = 0;
  let requestCount = 0;
  const server: Server = createServer((req, res) => {
    const peerAddress = peerAddresses[requestCount++];
    if (peerAddress !== undefined) {
      Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: peerAddress });
    }
    void handler(req, res).then((handled) => {
      if (handled) return;
      unhandled += 1;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unhandled');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localOrigin = `http://127.0.0.1:${address.port}`;
  handler = createSaasIdentityHandler({
    service: service as never,
    publicOrigin: publicOrigin ?? localOrigin,
    sessionTtlSeconds: 900,
    cookieSecure,
    rateLimiter,
  });
  return {
    server,
    base: `${localOrigin}/console/api/v1`,
    origin: publicOrigin ?? localOrigin,
    host: new URL(publicOrigin ?? localOrigin).host,
    rateLimiter,
    unhandled: () => unhandled,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get('set-cookie') ?? '';
  return combined ? combined.split(/, (?=[^;,]+=)/) : [];
}

function cookiePair(response: Response, name: string): string {
  const cookie = setCookies(response).find((value) => value.startsWith(`${name}=`));
  assert.ok(cookie, `missing ${name} cookie`);
  const pair = cookie.split(';', 1)[0];
  if (!pair) throw new Error(`invalid ${name} cookie`);
  return pair;
}

async function login(app: Awaited<ReturnType<typeof startServer>>) {
  const response = await fetch(`${app.base}/auth/session`, {
    method: 'POST',
    headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'person@example.test', password: 'correct horse battery staple' }),
  });
  const sessionCookie = cookiePair(response, 'mr_saas_session');
  const csrfCookie = cookiePair(response, 'mr_saas_csrf');
  const body = await json(response);
  return {
    response,
    sessionCookie,
    csrfCookie,
    cookie: `${sessionCookie}; ${csrfCookie}`,
    csrfToken: decodeURIComponent(csrfCookie.slice('mr_saas_csrf='.length)),
    body,
  };
}

test('handler returns false for paths outside the explicit route allowlist', async () => {
  const { service } = makeService();
  const app = await startServer(service);
  try {
    assert.equal((await fetch(`${app.base}/not-a-route`)).status, 404);
    assert.equal((await fetch(`${app.base.replace('/console/api/v1', '')}/elsewhere`)).status, 404);
    assert.equal(app.unhandled(), 2);
    const unsupportedMethod = await fetch(`${app.base}/tenants`, { method: 'DELETE' });
    assert.equal(unsupportedMethod.status, 405);
    assert.equal(unsupportedMethod.headers.get('allow'), 'GET, POST');
    const unsupportedProjectMethod = await fetch(`${app.base}/tenants/tenant-member/projects`, { method: 'DELETE' });
    assert.equal(unsupportedProjectMethod.status, 405);
    assert.equal(unsupportedProjectMethod.headers.get('allow'), 'GET, POST');
    assert.equal(app.unhandled(), 2);
  } finally {
    await app.close();
  }
});

test('bootstrap status and admin creation are not exposed by the identity HTTP handler', async () => {
  const { service, calls } = makeService({
    bootstrapStatus: async () => {
      throw new Error('bootstrap status must not be called');
    },
    bootstrapPlatformAdmin: async () => {
      throw new Error('bootstrap admin creation must not be called');
    },
  });
  const app = await startServer(service);
  try {
    const status = await fetch(`${app.base}/bootstrap`);
    assert.equal(status.status, 404);
    assert.equal(await status.text(), 'unhandled');

    const creation = await fetch(`${app.base}/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'bootstrap-token',
        email: 'admin@example.test',
        password: 'bootstrap-password',
        displayName: 'Platform Admin',
      }),
    });
    assert.equal(creation.status, 404);
    assert.equal(await creation.text(), 'unhandled');
    assert.equal(app.unhandled(), 2);
    assert.equal(calls.bootstrapStatus.length, 0);
    assert.equal(calls.bootstrapPlatformAdmin.length, 0);
  } finally {
    await app.close();
  }
});

test('every POST enforces the configured Host and Origin before reading its body', async () => {
  const { service, calls } = makeService();
  const limiter = new TestRateLimiter();
  const app = await startServer(service, 'https://console.example.test', limiter);
  try {
    const wrongOrigin = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', host: app.host, 'content-type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await json(wrongOrigin)).error.code, 'ORIGIN_REJECTED');

    const wrongHost = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: 'other.example.test', 'content-type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(wrongHost.status, 403);
    assert.equal((await json(wrongHost)).error.code, 'HOST_REJECTED');

    assert.equal(limiter.keys.length, 0);
    assert.equal(calls.login.length, 0);
  } finally {
    await app.close();
  }
});

test('injected limiter failures fail closed before reading the login body', async () => {
  const { service, calls } = makeService();
  const limiter = new TestRateLimiter(new Error('distributed limiter unavailable'));
  const app = await startServer(service, undefined, limiter);
  try {
    const response = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(response.status, 503);
    assert.equal((await json(response)).error.code, 'RATE_LIMITER_UNAVAILABLE');
    assert.equal(limiter.keys.length, 1);
    assert.equal(calls.login.length, 0);
  } finally {
    await app.close();
  }
});

test('login limiter keys are opaque, account-stable across peers, and distinct across accounts', async () => {
  const { service, calls } = makeService();
  const limiter = new TestRateLimiter();
  const app = await startServer(service, undefined, limiter, false, [
    '198.51.100.10',
    '198.51.100.11',
    '198.51.100.12',
  ]);
  try {
    const sendLogin = async (email: string) => {
      const response = await fetch(`${app.base}/auth/session`, {
        method: 'POST',
        headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'password' }),
      });
      await response.text();
      return response;
    };

    assert.equal((await sendLogin('Owner@Example.test')).status, 200);
    assert.equal((await sendLogin(' owner@example.test ')).status, 200);
    assert.equal((await sendLogin('other@example.test')).status, 200);
    assert.deepEqual(
      calls.login.slice(0, 3).map((args) => (args[0] as { email: string }).email),
      ['owner@example.test', 'owner@example.test', 'other@example.test'],
    );

    assert.equal(limiter.keys.length, 6);
    const [sourceOne, accountOne, sourceTwo, accountTwo, sourceThree, accountThree] = limiter.keys;
    assert.notEqual(sourceOne, sourceTwo);
    assert.notEqual(sourceTwo, sourceThree);
    assert.notEqual(sourceOne, sourceThree);
    assert.equal(accountOne, accountTwo);
    assert.notEqual(accountOne, accountThree);
    assert.notEqual(sourceOne, accountOne);
    for (const key of limiter.keys) {
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(key, /owner@example\.test|other@example\.test|127\.0\.0\.1/i);
    }
  } finally {
    await app.close();
  }
});

test('malformed email input still consumes the source bucket before account normalization', async () => {
  const { service, calls } = makeService();
  const limiter = new TestRateLimiter();
  const app = await startServer(service, undefined, limiter);
  try {
    const response = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: '   ', password: 'password' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await json(response)).error.code, 'INVALID_BODY');
    assert.equal(limiter.keys.length, 1);
    assert.match(limiter.keys[0] as string, /^[0-9a-f]{64}$/);
    assert.equal(calls.login.length, 0);
  } finally {
    await app.close();
  }
});

test('login sets an HttpOnly strict session cookie and returns a session without the raw session token', async () => {
  const { service, calls } = makeService();
  const app = await startServer(service, undefined, undefined, true);
  try {
    const result = await login(app);
    assert.equal(result.response.status, 200);
    const sessionCookie = setCookies(result.response).find((cookie) => cookie.startsWith('mr_saas_session=')) ?? '';
    const csrfCookie = setCookies(result.response).find((cookie) => cookie.startsWith('mr_saas_csrf=')) ?? '';
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Strict/);
    assert.match(sessionCookie, /Path=\/console\/api\/v1/);
    assert.match(sessionCookie, /Max-Age=900/);
    assert.match(sessionCookie, /Secure/);
    assert.match(csrfCookie, /SameSite=Strict/);
    assert.match(csrfCookie, /Path=\/console\/api\/v1/);
    assert.match(csrfCookie, /Max-Age=900/);
    assert.match(csrfCookie, /Secure/);
    assert.doesNotMatch(csrfCookie, /HttpOnly/);
    assert.equal(JSON.stringify(result.body).includes(SESSION_TOKEN), false);
    assert.equal(JSON.stringify(result.body).includes(CSRF_TOKEN), false);
    const loginArguments = calls.login[0]?.[0] as { ttlSeconds: number } | undefined;
    assert.equal(loginArguments?.ttlSeconds, 900);

    const sessionResponse = await fetch(`${app.base}/auth/session`, { headers: { cookie: result.cookie } });
    assert.equal(sessionResponse.status, 200);
    const sessionBody = await json(sessionResponse);
    assert.equal(sessionBody.data.session.userId, 'user-1');
    assert.equal(sessionBody.data.csrfToken, undefined);
    assert.equal(JSON.stringify(sessionBody).includes(SESSION_TOKEN), false);
  } finally {
    await app.close();
  }
});

test('cookie-authenticated writes require matching Origin and CSRF, and logout revokes the session', async () => {
  const { service, calls } = makeService();
  const app = await startServer(service);
  try {
    const loggedIn = await login(app);
    const endpoint = `${app.base}/tenants`;
    const payload = JSON.stringify({ name: 'New tenant' });
    const noOrigin = await fetch(endpoint, {
      method: 'POST',
      headers: {
        cookie: loggedIn.cookie,
        host: app.host,
        'content-type': 'application/json',
        'x-csrf-token': CSRF_TOKEN,
      },
      body: payload,
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await json(noOrigin)).error.code, 'ORIGIN_REQUIRED');

    const wrongOrigin = await fetch(endpoint, {
      method: 'POST',
      headers: {
        cookie: loggedIn.cookie,
        origin: 'https://attacker.example',
        host: app.host,
        'content-type': 'application/json',
        'x-csrf-token': CSRF_TOKEN,
      },
      body: payload,
    });
    assert.equal(wrongOrigin.status, 403);

    const noCsrf = await fetch(endpoint, {
      method: 'POST',
      headers: {
        cookie: loggedIn.sessionCookie,
        origin: app.origin,
        host: app.host,
        'content-type': 'application/json',
      },
      body: payload,
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await json(noCsrf)).error.code, 'CSRF_REJECTED');

    const mismatchedCsrf = await fetch(endpoint, {
      method: 'POST',
      headers: {
        cookie: loggedIn.cookie,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': 'not-the-cookie-token',
        'content-type': 'application/json',
      },
      body: payload,
    });
    assert.equal(mismatchedCsrf.status, 403);
    assert.equal(calls.createTenant.length, 0);

    const allowed = await fetch(endpoint, {
      method: 'POST',
      headers: {
        cookie: loggedIn.cookie,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': CSRF_TOKEN,
        'content-type': 'application/json',
      },
      body: payload,
    });
    assert.equal(allowed.status, 201);
    assert.equal(calls.createTenant[0]?.[0], 'user-1');

    const badLogout = await fetch(`${app.base}/auth/session`, {
      method: 'DELETE',
      headers: { cookie: loggedIn.cookie, origin: app.origin },
    });
    assert.equal(badLogout.status, 403);
    assert.equal(calls.logout.length, 0);

    const logout = await fetch(`${app.base}/auth/session`, {
      method: 'DELETE',
      headers: { cookie: loggedIn.cookie, origin: app.origin, 'x-csrf-token': CSRF_TOKEN },
    });
    assert.equal(logout.status, 200);
    assert.equal(setCookies(logout).filter((cookie) => /Max-Age=0/.test(cookie)).length, 2);
    assert.equal(calls.logout[0]?.[0], SESSION_TOKEN);
    const afterLogout = await fetch(`${app.base}/auth/session`, { headers: { cookie: loggedIn.cookie } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await app.close();
  }
});

test('customer session routes expose only safe metadata and keep platform cookies outside the customer audience', async () => {
  const { service, calls } = makeService({
    listSessions: async () => [
      {
        id: 'session-current',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-02-01T00:00:00.000Z',
        revokedAt: null,
        status: 'active',
        current: true,
        token: 'raw-session-token-must-not-leak',
        tokenHash: 'raw-token-hash-must-not-leak',
        csrfTokenHash: 'raw-csrf-hash-must-not-leak',
        cookie: 'session-cookie-must-not-leak',
        secret: 'session-secret-must-not-leak',
      },
      {
        id: 'session-revoked',
        createdAt: '2025-12-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
        revokedAt: '2025-12-02T00:00:00.000Z',
        status: 'revoked',
        current: false,
      },
    ],
  });
  const app = await startServer(service);
  try {
    const loggedIn = await login(app);
    const response = await fetch(`${app.base}/auth/sessions`, { headers: { cookie: loggedIn.cookie } });
    assert.equal(response.status, 200);
    const responseText = await response.text();
    const body = JSON.parse(responseText);
    assert.deepEqual(body.data.sessions, [
      {
        id: 'session-current',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-02-01T00:00:00.000Z',
        revokedAt: null,
        status: 'active',
        current: true,
      },
      {
        id: 'session-revoked',
        createdAt: '2025-12-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
        revokedAt: '2025-12-02T00:00:00.000Z',
        status: 'revoked',
        current: false,
      },
    ]);
    for (const sensitiveValue of [
      SESSION_TOKEN,
      CSRF_TOKEN,
      'raw-session-token-must-not-leak',
      'raw-token-hash-must-not-leak',
      'raw-csrf-hash-must-not-leak',
      'session-cookie-must-not-leak',
      'session-secret-must-not-leak',
    ]) {
      assert.equal(responseText.includes(sensitiveValue), false);
    }
    assert.equal(calls.listSessions[0]?.[0], SESSION_TOKEN);

    const platformCookie = await fetch(`${app.base}/auth/sessions`, {
      headers: { cookie: `mr_platform_session=${SESSION_TOKEN}` },
    });
    assert.equal(platformCookie.status, 401);
    assert.equal(calls.listSessions.length, 1);
  } finally {
    await app.close();
  }
});

test('session revocation preserves the caller for revoke-others and expires cookies when revoking the current session', async () => {
  const { service, calls } = makeService();
  const app = await startServer(service);
  try {
    const loggedIn = await login(app);
    const post = (path: string) =>
      fetch(`${app.base}${path}`, {
        method: 'POST',
        headers: {
          cookie: loggedIn.cookie,
          origin: app.origin,
          host: app.host,
          'x-csrf-token': loggedIn.csrfToken,
          'content-type': 'application/json',
        },
        body: '{}',
      });

    const otherSessions = await post('/auth/sessions/revoke-others');
    assert.equal(otherSessions.status, 200);
    assert.deepEqual((await json(otherSessions)).data, {
      revokedCount: 1,
      currentSessionPreserved: true,
    });
    assert.equal(
      setCookies(otherSessions).some((cookie) => /Max-Age=0/.test(cookie)),
      false,
    );
    assert.equal(calls.revokeOtherSessions[0]?.[0], SESSION_TOKEN);

    const selected = await post('/auth/sessions/session-other/revoke');
    assert.equal(selected.status, 200);
    assert.deepEqual((await json(selected)).data, {
      sessionId: 'session-other',
      revokedAt: '2026-01-02T03:04:05.000Z',
      currentSessionRevoked: false,
    });
    assert.equal(
      setCookies(selected).some((cookie) => /Max-Age=0/.test(cookie)),
      false,
    );
    assert.deepEqual(calls.revokeSession[0]?.slice(0, 2), [SESSION_TOKEN, 'session-other']);
    assert.match(String(calls.revokeSession[0]?.[2]), /^saas_[0-9a-f-]{36}$/);

    const current = await post('/auth/sessions/session-current/revoke');
    assert.equal(current.status, 200);
    assert.deepEqual((await json(current)).data, {
      sessionId: 'session-current',
      revokedAt: '2026-01-02T03:04:05.000Z',
      currentSessionRevoked: true,
    });
    assert.equal(setCookies(current).filter((cookie) => /Max-Age=0/.test(cookie)).length, 2);
  } finally {
    await app.close();
  }
});

test('session revocation rejects missing, mismatched, or invalid CSRF/origin boundaries before changing sessions', async () => {
  const { service, calls } = makeService();
  const app = await startServer(service);
  try {
    const loggedIn = await login(app);
    const path = `${app.base}/auth/sessions/revoke-others`;
    const request = (headers: Record<string, string>) =>
      fetch(path, {
        method: 'POST',
        headers: { host: app.host, 'content-type': 'application/json', ...headers },
        body: '{}',
      });

    const missingOrigin = await request({
      cookie: loggedIn.cookie,
      'x-csrf-token': loggedIn.csrfToken,
    });
    assert.equal(missingOrigin.status, 403);
    assert.equal((await json(missingOrigin)).error.code, 'ORIGIN_REQUIRED');

    const wrongOrigin = await request({
      cookie: loggedIn.cookie,
      origin: 'https://attacker.example',
      'x-csrf-token': loggedIn.csrfToken,
    });
    assert.equal(wrongOrigin.status, 403);
    assert.equal((await json(wrongOrigin)).error.code, 'ORIGIN_REJECTED');

    const missingCsrf = await request({ cookie: loggedIn.sessionCookie, origin: app.origin });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await json(missingCsrf)).error.code, 'CSRF_REJECTED');

    const mismatchedCsrf = await request({
      cookie: loggedIn.cookie,
      origin: app.origin,
      'x-csrf-token': 'not-the-bound-csrf-token',
    });
    assert.equal(mismatchedCsrf.status, 403);
    assert.equal((await json(mismatchedCsrf)).error.code, 'CSRF_REJECTED');
    assert.equal(calls.revokeOtherSessions.length, 0);
  } finally {
    await app.close();
  }
});

test('double-submit CSRF cookie remains valid after the HTTP handler is recreated', async () => {
  const { service, calls } = makeService();
  const first = await startServer(service);
  let sessionCookie = '';
  let csrfCookie = '';
  try {
    const loggedIn = await login(first);
    sessionCookie = loggedIn.sessionCookie;
    csrfCookie = loggedIn.csrfCookie;
  } finally {
    await first.close();
  }

  const second = await startServer(service);
  try {
    const response = await fetch(`${second.base}/tenants`, {
      method: 'POST',
      headers: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        origin: second.origin,
        host: second.host,
        'x-csrf-token': decodeURIComponent(csrfCookie.slice('mr_saas_csrf='.length)),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Created after restart' }),
    });
    assert.equal(response.status, 201);
    assert.equal(calls.verifyCsrfToken.length, 1);
  } finally {
    await second.close();
  }
});

test('tenant APIs use the authenticated user and leave tenant membership checks to the service', async () => {
  const { service, calls } = makeService();
  const app = await startServer(service);
  try {
    const loggedIn = await login(app);
    const authHeaders = { cookie: loggedIn.cookie };

    const listed = await fetch(`${app.base}/tenants`, { headers: authHeaders });
    assert.equal(listed.status, 200);
    assert.equal(calls.listTenants[0]?.[0], 'user-1');
    assert.deepEqual((await json(listed)).data, [{ id: 'tenant-member', name: 'Member tenant' }]);

    const projects = await fetch(`${app.base}/tenants/tenant-member/projects`, { headers: authHeaders });
    assert.equal(projects.status, 200);
    assert.deepEqual((await json(projects)).data, [
      {
        id: 'project-1',
        tenantId: 'tenant-member',
        name: 'Member project',
        slug: 'member-project',
        role: 'owner',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    assert.deepEqual(calls.listProjects[0], ['user-1', 'tenant-member']);

    const noProjectCsrf = await fetch(`${app.base}/tenants/tenant-member/projects`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'No CSRF' }),
    });
    assert.equal(noProjectCsrf.status, 403);
    assert.equal(calls.createProject.length, 0);

    const createdProject = await fetch(`${app.base}/tenants/tenant-member/projects`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': loggedIn.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Created project', slug: 'created-project' }),
    });
    assert.equal(createdProject.status, 201);
    assert.deepEqual((await json(createdProject)).data, {
      id: 'project-new',
      tenantId: 'tenant-member',
      name: 'Created project',
      slug: 'created-project',
      role: 'owner',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    assert.deepEqual(calls.createProject[0], [
      'user-1',
      'tenant-member',
      { name: 'Created project', slug: 'created-project' },
    ]);

    const crossTenantProjects = await fetch(`${app.base}/tenants/tenant-outsider/projects`, { headers: authHeaders });
    assert.equal(crossTenantProjects.status, 403);
    assert.deepEqual(calls.listProjects[1], ['user-1', 'tenant-outsider']);

    const spoofedTenant = await fetch(`${app.base}/tenants`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': loggedIn.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Tenant', tenantId: 'tenant-outsider' }),
    });
    assert.equal(spoofedTenant.status, 400);
    assert.equal(calls.createTenant.length, 0);

    const created = await fetch(`${app.base}/tenants`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': loggedIn.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Tenant', slug: 'tenant' }),
    });
    assert.equal(created.status, 201);
    assert.equal(calls.createTenant[0]?.[0], 'user-1');

    const ownerInvitation = await fetch(`${app.base}/tenants/tenant-member/invitations`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': loggedIn.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'owner' }),
    });
    assert.equal(ownerInvitation.status, 400);
    assert.equal(calls.createInvitation.length, 0);

    const denied = await fetch(`${app.base}/tenants/tenant-outsider/invitations`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': loggedIn.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'viewer' }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(calls.createInvitation[0]?.slice(0, 2), ['user-1', 'tenant-outsider']);

    const invitation = await fetch(`${app.base}/tenants/tenant-member/invitations`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        origin: app.origin,
        host: app.host,
        'x-csrf-token': loggedIn.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'invitee@example.test', role: 'viewer', ttlSeconds: 3600 }),
    });
    assert.equal(invitation.status, 201);
    const invitationText = await invitation.text();
    assert.equal(invitationText.split(INVITATION_TOKEN).length - 1, 1);
    assert.equal(JSON.parse(invitationText).data.token, INVITATION_TOKEN);
    assert.equal(calls.createInvitation[1]?.[0], 'user-1');

    const accepted = await fetch(`${app.base}/invitations/accept`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({
        token: INVITATION_TOKEN,
        email: 'invitee@example.test',
        displayName: 'Invited User',
        password: 'invitee-password',
      }),
    });
    assert.equal(accepted.status, 201);
    const acceptedText = await accepted.text();
    assert.equal(acceptedText.includes(INVITATION_TOKEN), false);
    assert.equal(JSON.parse(acceptedText).data.userId, 'user-2');
    const acceptedCall = calls.acceptInvitation[0]?.[0] as { token?: unknown } | undefined;
    assert.equal(acceptedCall?.token, INVITATION_TOKEN);
  } finally {
    await app.close();
  }
});

test('project listing rejects an unauthenticated request before calling the service', async () => {
  const { service, calls } = makeService();
  const app = await startServer(service);
  try {
    const response = await fetch(`${app.base}/tenants/tenant-member/projects`);
    assert.equal(response.status, 401);
    assert.equal(calls.getSession.length, 0);
    assert.equal(calls.listProjects.length, 0);
  } finally {
    await app.close();
  }
});

test('JSON limits, strict shapes, and safe error envelopes are enforced', async () => {
  const { service } = makeService({ login: async () => undefined });
  const app = await startServer(service);
  try {
    const invalidJson = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: '{"email":',
    });
    assert.equal(invalidJson.status, 400);
    const invalidBody = await json(invalidJson);
    assert.deepEqual(Object.keys(invalidBody.error).sort(), ['code', 'message', 'requestId']);
    assert.equal(invalidBody.error.code, 'INVALID_JSON');
    assert.match(invalidBody.error.requestId, /^saas_[0-9a-f-]{36}$/);
    assert.equal(invalidJson.headers.get('cache-control'), 'no-store');
    assert.equal(invalidJson.headers.get('x-content-type-options'), 'nosniff');

    const extraField = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'pw', tenantId: 'tenant-2' }),
    });
    assert.equal(extraField.status, 400);
    assert.equal((await json(extraField)).error.code, 'INVALID_BODY');

    const oversized = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await json(oversized)).error.code, 'BODY_TOO_LARGE');

    const unsupportedContentType = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'text/plain' },
      body: 'email=person@example.test',
    });
    assert.equal(unsupportedContentType.status, 415);
  } finally {
    await app.close();
  }
});

test('login throttling responds with a bounded retry interval', async () => {
  const { service } = makeService({ login: async () => undefined });
  const app = await startServer(service);
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${app.base}/auth/session`, {
        method: 'POST',
        headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.test', password: 'wrong' }),
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`${app.base}/auth/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'wrong' }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await json(limited)).error.code, 'LOGIN_RATE_LIMITED');
  } finally {
    await app.close();
  }
});
