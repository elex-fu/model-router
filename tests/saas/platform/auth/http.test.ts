import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { test } from 'node:test';
import {
  createPlatformAdminAuthHandler,
  PLATFORM_ADMIN_AUTH_COOKIE_PATH,
  PLATFORM_ADMIN_AUTH_PREFIX,
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_SESSION_COOKIE,
  type PlatformAdminAuthHttpService,
} from '../../../../src/saas/platform/auth/http.js';

const SESSION_TOKEN = 'session-token-never-in-body';
const CSRF_TOKEN = 'csrf-token-readable-and-double-submitted';
const ENROLLMENT_TOKEN = 'cli-enrollment-token-once';
const CONFIRMATION_TOKEN = 'confirmation-token-once';
const OTPAUTH_URI = 'otpauth://totp/Model%20Router:owner%40example.test?secret=ONE-TIME-URI-SECRET';

type Calls = Record<string, unknown[][]>;

function makeService(overrides: Partial<PlatformAdminAuthHttpService> = {}) {
  const calls: Calls = {
    login: [],
    getSession: [],
    verifyCsrfToken: [],
    logout: [],
    beginMfaEnrollment: [],
    confirmMfaEnrollment: [],
  };
  let loggedOut = false;
  let enrollmentUsed = false;
  let confirmationUsed = false;
  const session = {
    id: 'session-id',
    userId: 'admin-user-id',
    createdAt: '2026-01-02T03:04:05.000Z',
    expiresAt: '2026-01-02T11:04:05.000Z',
  };
  const record =
    <Name extends keyof Calls, Arguments extends unknown[], Result>(
      name: Name,
      implementation: (...args: Arguments) => Result,
    ) =>
    async (...args: Arguments): Promise<Result> => {
      calls[name].push(args);
      return implementation(...args);
    };
  const service: PlatformAdminAuthHttpService = {
    login: record('login', async () => ({ token: SESSION_TOKEN, csrfToken: CSRF_TOKEN, session })),
    getSession: record('getSession', async (token: string) =>
      token === SESSION_TOKEN && !loggedOut ? session : undefined,
    ),
    verifyCsrfToken: record(
      'verifyCsrfToken',
      async (token: string, csrfToken: string) => token === SESSION_TOKEN && csrfToken === CSRF_TOKEN && !loggedOut,
    ),
    logout: record('logout', async (token: string) => {
      assert.equal(token, SESSION_TOKEN);
      loggedOut = true;
    }),
    beginMfaEnrollment: record('beginMfaEnrollment', async (token: string) => {
      if (token !== ENROLLMENT_TOKEN || enrollmentUsed) {
        throw Object.assign(new Error('raw enrollment token must not escape'), {
          code: 'MFA_ENROLLMENT_TOKEN_INVALID',
        });
      }
      enrollmentUsed = true;
      return {
        otpauthUri: OTPAUTH_URI,
        confirmationToken: CONFIRMATION_TOKEN,
        expiresAt: '2026-01-02T03:14:05.000Z',
      };
    }),
    confirmMfaEnrollment: record('confirmMfaEnrollment', async (token: string, code: string) => {
      if (token !== CONFIRMATION_TOKEN || confirmationUsed || code !== '123456') {
        throw Object.assign(new Error('raw confirmation token must not escape'), {
          code: 'MFA_CONFIRMATION_INVALID',
        });
      }
      confirmationUsed = true;
    }),
  };
  return { service: { ...service, ...overrides }, calls };
}

class TestLimiter {
  readonly keys: string[] = [];

  constructor(private readonly limitNext = false) {}

  async take(key: string): Promise<number | undefined> {
    this.keys.push(key);
    if (this.limitNext && this.keys.length === 1) {
      return 17;
    }
    return undefined;
  }
}

async function startApp(
  service: PlatformAdminAuthHttpService,
  limiter = new TestLimiter(),
  publicOrigin?: string,
  listenHost = '127.0.0.1',
) {
  let handler: ReturnType<typeof createPlatformAdminAuthHandler>;
  let unhandled = 0;
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (handled) return;
      unhandled += 1;
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unhandled');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, listenHost, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localHostname = listenHost.includes(':') ? `[${listenHost}]` : listenHost;
  const localOrigin = `http://${localHostname}:${address.port}`;
  handler = createPlatformAdminAuthHandler({
    service,
    rateLimiter: limiter,
    publicOrigin: publicOrigin ?? localOrigin,
    sessionTtlSeconds: 3600,
  });
  return {
    server,
    base: `${localOrigin}${PLATFORM_ADMIN_AUTH_PREFIX}`,
    origin: publicOrigin ?? localOrigin,
    host: new URL(publicOrigin ?? localOrigin).host,
    limiter,
    unhandled: () => unhandled,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get('set-cookie') ?? '';
  return combined ? combined.split(/, (?=[^;,]+=)/) : [];
}

function cookieAttribute(cookie: string, attribute: string): string | undefined {
  const prefix = `${attribute.toLowerCase()}=`;
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.toLowerCase().startsWith(prefix))
    ?.slice(prefix.length);
}

function cookiePair(response: Response, name: string): string {
  const matches = setCookies(response).filter(
    (value) =>
      value.startsWith(`${name}=`) &&
      cookieAttribute(value, 'Path') === PLATFORM_ADMIN_AUTH_COOKIE_PATH &&
      cookieAttribute(value, 'Max-Age') !== '0',
  );
  assert.equal(matches.length, 1, `expected one live ${name} cookie at ${PLATFORM_ADMIN_AUTH_COOKIE_PATH}`);
  const cookie = matches[0];
  assert.ok(cookie);
  return cookie.split(';', 1)[0] as string;
}

function cookieValue(pair: string, name: string): string {
  assert.ok(pair.startsWith(`${name}=`));
  return decodeURIComponent(pair.slice(name.length + 1));
}

interface StoredCookie {
  name: string;
  value: string;
  path: string;
}

type CookieJar = Map<string, StoredCookie>;

function cookieKey(name: string, path: string): string {
  return `${name}\0${path}`;
}

function applySetCookies(jar: CookieJar, values: string[]): void {
  for (const serialized of values) {
    const [pair, ...attributes] = serialized.split(';').map((part) => part.trim());
    assert.ok(pair);
    const separator = pair.indexOf('=');
    assert.ok(separator > 0, `invalid Set-Cookie pair: ${pair}`);
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const path = attributes.find((attribute) => attribute.toLowerCase().startsWith('path='))?.slice(5) ?? '/';
    const key = cookieKey(name, path);
    if (attributes.some((attribute) => /^max-age=0$/i.test(attribute))) {
      jar.delete(key);
    } else {
      jar.set(key, { name, value, path });
    }
  }
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function cookieHeaderForPath(jar: CookieJar, requestPath: string): string {
  return [...jar.values()]
    .filter((cookie) => pathMatches(requestPath, cookie.path))
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}

function cookieNames(header: string): string[] {
  return header
    .split(';')
    .map((part) => part.trim().split('=', 1)[0])
    .filter((name) => name.length > 0);
}

interface TestResponseBody {
  data?: Record<string, unknown>;
  error?: { code: string; message?: string; requestId?: string };
}

async function body(response: Response): Promise<TestResponseBody> {
  return (await response.json()) as TestResponseBody;
}

async function rawRequest(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: options.method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(options.body)) }),
        ...options.headers,
      },
    });
    request.on('error', reject);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

async function login(app: Awaited<ReturnType<typeof startApp>>, cookieHeader?: string) {
  const response = await fetch(`${app.base}/session`, {
    method: 'POST',
    headers: {
      origin: app.origin,
      host: app.host,
      'content-type': 'application/json',
      ...(cookieHeader === undefined ? {} : { cookie: cookieHeader }),
    },
    body: JSON.stringify({ email: 'owner@example.test', password: 'correct password', code: '123456' }),
  });
  const sessionCookie = cookiePair(response, PLATFORM_ADMIN_SESSION_COOKIE);
  const csrfCookie = cookiePair(response, PLATFORM_ADMIN_CSRF_COOKIE);
  return {
    response,
    sessionCookie,
    csrfCookie,
    cookie: `${sessionCookie}; ${csrfCookie}`,
    csrfToken: cookieValue(csrfCookie, PLATFORM_ADMIN_CSRF_COOKIE),
  };
}

test('factory requires an injected asynchronous limiter and rejects non-loopback HTTP origins', () => {
  const { service } = makeService();
  assert.throws(
    () =>
      createPlatformAdminAuthHandler({
        service,
        publicOrigin: 'http://127.0.0.1:3000',
        rateLimiter: undefined as never,
      }),
    /rateLimiter\.take/,
  );
  assert.throws(
    () =>
      createPlatformAdminAuthHandler({
        service,
        publicOrigin: 'http://admin.example.test',
        rateLimiter: { take: async () => undefined },
      }),
    /loopback/,
  );
  assert.doesNotThrow(() =>
    createPlatformAdminAuthHandler({
      service,
      publicOrigin: 'http://[::ffff:127.0.0.1]:3000',
      rateLimiter: { take: async () => undefined },
    }),
  );
});

test('login enforces exact Origin and Host, sets isolated cookie flags, and exposes only the allowed CSRF value', async () => {
  const { service, calls } = makeService();
  const app = await startApp(service);
  try {
    const noOrigin = await fetch(`${app.base}/session`, {
      method: 'POST',
      headers: { host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'pw', code: '123456' }),
    });
    assert.equal(noOrigin.status, 403);

    const wrongOrigin = await fetch(`${app.base}/session`, {
      method: 'POST',
      headers: { origin: 'http://attacker.test', host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'pw', code: '123456' }),
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongHost = await rawRequest(`${app.base}/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: 'attacker.test', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'pw', code: '123456' }),
    });
    assert.equal(wrongHost.status, 403);
    assert.equal(calls.login.length, 0);

    const loggedIn = await login(app);
    assert.equal(loggedIn.response.status, 200);
    const cookies = setCookies(loggedIn.response);
    assert.equal(cookies.length, 4);
    const sessionCookie = cookies.find(
      (value) =>
        value.startsWith(`${PLATFORM_ADMIN_SESSION_COOKIE}=`) &&
        cookieAttribute(value, 'Path') === PLATFORM_ADMIN_AUTH_COOKIE_PATH &&
        cookieAttribute(value, 'Max-Age') !== '0',
    );
    const csrfCookie = cookies.find(
      (value) =>
        value.startsWith(`${PLATFORM_ADMIN_CSRF_COOKIE}=`) &&
        cookieAttribute(value, 'Path') === PLATFORM_ADMIN_AUTH_COOKIE_PATH &&
        cookieAttribute(value, 'Max-Age') !== '0',
    );
    assert.ok(sessionCookie);
    assert.ok(csrfCookie);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Strict/);
    assert.doesNotMatch(sessionCookie, /Secure/);
    assert.equal(cookieAttribute(sessionCookie, 'Path'), '/admin/api/v1');
    assert.match(sessionCookie, /Max-Age=3600/);
    assert.doesNotMatch(sessionCookie, /Domain=/i);
    assert.match(csrfCookie, /SameSite=Strict/);
    assert.equal(cookieAttribute(csrfCookie, 'Path'), '/admin/api/v1');
    assert.doesNotMatch(csrfCookie, /HttpOnly/);
    assert.doesNotMatch(csrfCookie, /Domain=/i);
    const legacyExpirations = cookies.filter((value) => cookieAttribute(value, 'Max-Age') === '0');
    assert.equal(legacyExpirations.length, 2);
    assert.ok(legacyExpirations.every((value) => cookieAttribute(value, 'Path') === '/admin/api/v1/auth'));
    const responseText = await loggedIn.response.clone().text();
    assert.equal(responseText.includes(SESSION_TOKEN), false);
    assert.equal(responseText.includes(CSRF_TOKEN), true);
    assert.equal((await body(loggedIn.response)).data.csrfToken, CSRF_TOKEN);
  } finally {
    await app.close();
  }
});

test('login removes legacy-path cookies and its session and CSRF cookies cover admin read APIs', async () => {
  const { service } = makeService();
  const app = await startApp(service);
  try {
    const jar: CookieJar = new Map();
    applySetCookies(jar, [
      `${PLATFORM_ADMIN_SESSION_COOKIE}=stale-session; Path=/admin/api/v1/auth; HttpOnly; SameSite=Strict`,
      `${PLATFORM_ADMIN_CSRF_COOKIE}=stale-csrf; Path=/admin/api/v1/auth; SameSite=Strict`,
    ]);
    const staleCookieHeader = cookieHeaderForPath(jar, `${PLATFORM_ADMIN_AUTH_PREFIX}/session`);
    assert.deepEqual(cookieNames(staleCookieHeader), [PLATFORM_ADMIN_SESSION_COOKIE, PLATFORM_ADMIN_CSRF_COOKIE]);

    const loggedIn = await login(app, staleCookieHeader);
    assert.equal(loggedIn.response.status, 200);
    const responseCookies = setCookies(loggedIn.response);
    assert.equal(responseCookies.length, 4);
    applySetCookies(jar, responseCookies);

    assert.equal(jar.has(cookieKey(PLATFORM_ADMIN_SESSION_COOKIE, '/admin/api/v1/auth')), false);
    assert.equal(jar.has(cookieKey(PLATFORM_ADMIN_CSRF_COOKIE, '/admin/api/v1/auth')), false);
    assert.equal(
      jar.get(cookieKey(PLATFORM_ADMIN_SESSION_COOKIE, PLATFORM_ADMIN_AUTH_COOKIE_PATH))?.value,
      cookieValue(loggedIn.sessionCookie, PLATFORM_ADMIN_SESSION_COOKIE),
    );
    assert.equal(
      jar.get(cookieKey(PLATFORM_ADMIN_CSRF_COOKIE, PLATFORM_ADMIN_AUTH_COOKIE_PATH))?.value,
      cookieValue(loggedIn.csrfCookie, PLATFORM_ADMIN_CSRF_COOKIE),
    );

    const readApiHeader = cookieHeaderForPath(jar, '/admin/api/v1/me');
    assert.deepEqual(cookieNames(readApiHeader), [PLATFORM_ADMIN_SESSION_COOKIE, PLATFORM_ADMIN_CSRF_COOKIE]);
    assert.match(
      readApiHeader,
      new RegExp(
        `${PLATFORM_ADMIN_SESSION_COOKIE}=${cookieValue(loggedIn.sessionCookie, PLATFORM_ADMIN_SESSION_COOKIE)}`,
      ),
    );
    assert.match(
      readApiHeader,
      new RegExp(`${PLATFORM_ADMIN_CSRF_COOKIE}=${cookieValue(loggedIn.csrfCookie, PLATFORM_ADMIN_CSRF_COOKIE)}`),
    );

    const authApiHeader = cookieHeaderForPath(jar, `${PLATFORM_ADMIN_AUTH_PREFIX}/session`);
    assert.deepEqual(cookieNames(authApiHeader), [PLATFORM_ADMIN_SESSION_COOKIE, PLATFORM_ADMIN_CSRF_COOKIE]);
  } finally {
    await app.close();
  }
});

test('invalid login is generic, limiter keys are opaque, and rate limits fail closed', async () => {
  let loginCalls = 0;
  const { service } = makeService({
    login: async () => {
      loginCalls += 1;
      return undefined;
    },
  });
  const limiter = new TestLimiter(true);
  const app = await startApp(service, limiter);
  try {
    const limited = await fetch(`${app.base}/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'wrong', code: '000000' }),
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '17');
    assert.equal(loginCalls, 0);
    const limitedText = await limited.text();
    assert.equal(limitedText.includes('owner@example.test'), false);
    assert.ok(limiter.keys[0]);
    assert.match(limiter.keys[0] as string, /^[0-9a-f]{64}$/);
    assert.equal((limiter.keys[0] as string).includes('owner'), false);

    const normalLimiter = new TestLimiter();
    const normalApp = await startApp(service, normalLimiter);
    try {
      const invalid = await fetch(`${normalApp.base}/session`, {
        method: 'POST',
        headers: { origin: normalApp.origin, host: normalApp.host, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.test', password: 'wrong', code: '000000' }),
      });
      assert.equal(invalid.status, 401);
      const invalidText = await invalid.text();
      const invalidBody = JSON.parse(invalidText);
      assert.equal(invalidBody.error.code, 'INVALID_CREDENTIALS');
      assert.equal(invalidText.includes('wrong'), false);
    } finally {
      await normalApp.close();
    }
  } finally {
    await app.close();
  }
});

test('login applies source and normalized account limits with opaque keys', async () => {
  const { service, calls } = makeService();
  const limiter = new TestLimiter();
  const ipv4App = await startApp(service, limiter);
  const ipv6App = await startApp(service, limiter, undefined, '::1');
  try {
    const sendLogin = async (app: Awaited<ReturnType<typeof startApp>>, email: string) => {
      const response = await rawRequest(`${app.base}/session`, {
        method: 'POST',
        headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong', code: '000000' }),
      });
      return response;
    };

    assert.equal((await sendLogin(ipv4App, 'Owner@Example.test')).status, 200);
    assert.equal((await sendLogin(ipv6App, ' owner@example.test ')).status, 200);
    assert.equal((await sendLogin(ipv6App, 'other@example.test')).status, 200);

    assert.equal(calls.login[0]?.[0], 'owner@example.test');
    assert.equal(calls.login[1]?.[0], 'owner@example.test');
    assert.equal(calls.login[2]?.[0], 'other@example.test');

    assert.equal(limiter.keys.length, 6);
    const [sourceOne, accountOne, sourceTwo, accountTwo, sourceThree, accountThree] = limiter.keys;
    assert.notEqual(sourceOne, sourceTwo);
    assert.equal(sourceTwo, sourceThree);
    assert.equal(accountOne, accountTwo);
    assert.notEqual(accountOne, accountThree);
    assert.notEqual(sourceOne, accountOne);
    for (const key of limiter.keys) {
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(key, /owner@example\.test|other@example\.test|127\.0\.0\.1|::1/i);
    }
  } finally {
    await ipv6App.close();
    await ipv4App.close();
  }
});

test('malformed account input still consumes the opaque source bucket before normalization', async () => {
  const { service } = makeService();
  const limiter = new TestLimiter();
  const app = await startApp(service, limiter);
  try {
    const response = await fetch(`${app.base}/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: '   ', password: 'pw', code: '123456' }),
    });
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(limiter.keys.length, 1);
    assert.match(limiter.keys[0] as string, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(limiter.keys[0] as string, /127\.0\.0\.1/i);
  } finally {
    await app.close();
  }
});

test('strict JSON limits, unknown API routes, and outside ownership are handled without SPA fallback', async () => {
  const { service } = makeService();
  const app = await startApp(service);
  try {
    const oversized = await fetch(`${app.base}/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'x'.repeat(70 * 1024), code: '123456' }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await body(oversized)).error.code, 'BODY_TOO_LARGE');

    const extra = await fetch(`${app.base}/session`, {
      method: 'POST',
      headers: { origin: app.origin, host: app.host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: 'pw', code: '123456', extra: true }),
    });
    assert.equal(extra.status, 400);
    assert.equal((await body(extra)).error.code, 'INVALID_BODY');

    const unknown = await fetch(`${app.base}/not-a-route`);
    assert.equal(unknown.status, 404);
    assert.equal(app.unhandled(), 0);

    const outside = await fetch(`http://127.0.0.1:${new URL(app.base).port}/admin/api/v1/unknown`);
    assert.equal(outside.status, 404);
    assert.equal(app.unhandled(), 1);
  } finally {
    await app.close();
  }
});

test('GET session revalidates, and DELETE requires exact Origin, double-submit CSRF, service validation, and clears cookies', async () => {
  const { service, calls } = makeService();
  const app = await startApp(service);
  try {
    const loggedIn = await login(app);
    const jar: CookieJar = new Map();
    applySetCookies(jar, setCookies(loggedIn.response));
    assert.equal(cookieHeaderForPath(jar, `${PLATFORM_ADMIN_AUTH_PREFIX}/session`), loggedIn.cookie);
    const getOne = await fetch(`${app.base}/session`, { headers: { cookie: loggedIn.cookie } });
    assert.equal(getOne.status, 200);
    const getTwo = await fetch(`${app.base}/session`, { headers: { cookie: loggedIn.cookie } });
    assert.equal(getTwo.status, 200);
    assert.equal(calls.getSession.length, 2);
    assert.equal(JSON.stringify(await body(getOne)).includes(SESSION_TOKEN), false);

    const missingCsrf = await fetch(`${app.base}/session`, {
      method: 'DELETE',
      headers: { origin: app.origin, host: app.host, cookie: loggedIn.cookie },
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(calls.logout.length, 0);

    const badOrigin = await fetch(`${app.base}/session`, {
      method: 'DELETE',
      headers: {
        origin: 'http://attacker.test',
        host: app.host,
        cookie: loggedIn.cookie,
        'x-csrf-token': loggedIn.csrfToken,
      },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(calls.logout.length, 0);

    const mismatch = await fetch(`${app.base}/session`, {
      method: 'DELETE',
      headers: {
        origin: app.origin,
        host: app.host,
        cookie: loggedIn.cookie,
        'x-csrf-token': 'wrong-csrf',
      },
    });
    assert.equal(mismatch.status, 403);
    assert.equal(calls.verifyCsrfToken.length, 0);

    const logout = await fetch(`${app.base}/session`, {
      method: 'DELETE',
      headers: {
        origin: app.origin,
        host: app.host,
        cookie: loggedIn.cookie,
        'x-csrf-token': loggedIn.csrfToken,
      },
    });
    assert.equal(logout.status, 200);
    assert.equal(calls.verifyCsrfToken.length, 1);
    assert.equal(calls.logout.length, 1);
    const expiredCookies = setCookies(logout);
    assert.equal(expiredCookies.length, 4);
    assert.ok(expiredCookies.every((value) => cookieAttribute(value, 'Max-Age') === '0'));
    assert.ok(expiredCookies.every((value) => /SameSite=Strict/.test(value)));
    assert.ok(expiredCookies.every((value) => !/Domain=/i.test(value)));
    const clearedKeys = expiredCookies.map((value) => {
      const pair = value.split(';', 1)[0] as string;
      const name = pair.slice(0, pair.indexOf('='));
      const path = cookieAttribute(value, 'Path');
      assert.ok(path);
      if (name === PLATFORM_ADMIN_SESSION_COOKIE) assert.match(value, /HttpOnly/);
      if (name === PLATFORM_ADMIN_CSRF_COOKIE) assert.doesNotMatch(value, /HttpOnly/);
      return cookieKey(name, path);
    });
    assert.equal(new Set(clearedKeys).size, 4);
    assert.deepEqual(
      clearedKeys.sort(),
      [
        cookieKey(PLATFORM_ADMIN_CSRF_COOKIE, '/admin/api/v1'),
        cookieKey(PLATFORM_ADMIN_CSRF_COOKIE, '/admin/api/v1/auth'),
        cookieKey(PLATFORM_ADMIN_SESSION_COOKIE, '/admin/api/v1'),
        cookieKey(PLATFORM_ADMIN_SESSION_COOKIE, '/admin/api/v1/auth'),
      ].sort(),
    );
    applySetCookies(jar, expiredCookies);
    assert.equal(jar.size, 0);
    assert.equal((await fetch(`${app.base}/session`, { headers: { cookie: loggedIn.cookie } })).status, 401);
  } finally {
    await app.close();
  }
});

test('MFA start and confirm consume bearer tokens once, never create a session, and expose only allowed setup values', async () => {
  const { service, calls } = makeService();
  const app = await startApp(service);
  try {
    const start = await fetch(`${app.base}/mfa/enrollment/start`, {
      method: 'POST',
      headers: {
        origin: app.origin,
        host: app.host,
        authorization: `Bearer ${ENROLLMENT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ issuer: 'Model Router' }),
    });
    assert.equal(start.status, 200);
    const startBody = await body(start);
    assert.equal(startBody.data.otpauthUri, OTPAUTH_URI);
    assert.equal(startBody.data.confirmationToken, CONFIRMATION_TOKEN);
    assert.equal(calls.login.length, 0);
    assert.equal(calls.getSession.length, 0);
    assert.equal(setCookies(start).length, 0);

    const replayStart = await fetch(`${app.base}/mfa/enrollment/start`, {
      method: 'POST',
      headers: {
        origin: app.origin,
        host: app.host,
        authorization: `Bearer ${ENROLLMENT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ issuer: 'Model Router' }),
    });
    assert.equal(replayStart.status, 401);
    assert.equal((await body(replayStart)).error.code, 'MFA_ENROLLMENT_TOKEN_INVALID');

    const confirm = await fetch(`${app.base}/mfa/enrollment/confirm`, {
      method: 'POST',
      headers: {
        origin: app.origin,
        host: app.host,
        authorization: `Bearer ${CONFIRMATION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: '123456' }),
    });
    assert.equal(confirm.status, 200);
    assert.deepEqual((await body(confirm)).data, { confirmed: true });
    assert.equal(calls.login.length, 0);
    assert.equal(calls.getSession.length, 0);
    assert.equal(setCookies(confirm).length, 0);

    const replayConfirm = await fetch(`${app.base}/mfa/enrollment/confirm`, {
      method: 'POST',
      headers: {
        origin: app.origin,
        host: app.host,
        authorization: `Bearer ${CONFIRMATION_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: '123456' }),
    });
    assert.equal(replayConfirm.status, 401);
    assert.equal((await body(replayConfirm)).error.code, 'MFA_CONFIRMATION_INVALID');
  } finally {
    await app.close();
  }
});

test('HTTPS origins receive Secure cookies while loopback HTTP remains usable for dev/test', async () => {
  const { service } = makeService();
  const app = await startApp(service, new TestLimiter(), 'https://admin.example.test');
  try {
    const response = await rawRequest(`${app.base}/session`, {
      method: 'POST',
      headers: {
        origin: 'https://admin.example.test',
        host: 'admin.example.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'owner@example.test', password: 'pw', code: '123456' }),
    });
    assert.equal(response.status, 200);
    const cookies = response.headers['set-cookie'] ?? [];
    assert.equal(cookies.length, 4);
    assert.ok(cookies.every((value) => /Secure/.test(value)));
    assert.ok(cookies.every((value) => !/Domain=/i.test(value)));
    assert.ok(cookies.some((value) => cookieAttribute(value, 'Path') === '/admin/api/v1'));
    assert.ok(cookies.some((value) => cookieAttribute(value, 'Path') === '/admin/api/v1/auth'));
  } finally {
    await app.close();
  }
});
