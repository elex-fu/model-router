import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAdminServer } from '../../src/admin/server.js';
import { createSaasIdentityHandler } from '../../src/saas/identity/http.js';

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (headers.getSetCookie) return headers.getSetCookie();
  const combined = response.headers.get('set-cookie') ?? '';
  return combined ? combined.split(/, (?=[^;,]+=)/) : [];
}

interface CookieRecord {
  name: string;
  pair: string;
  path: string;
  httpOnly: boolean;
  expiresAt: number | undefined;
}

// Same-origin, host-only fixture jar, not a replacement for a browser or the
// production parser. This issuer has no Domain cookies; do not silently merge them.
function cookieRecord(header: string, receivedAt: number, responsePath: string): CookieRecord {
  const [pair, ...attributes] = header.split(';').map((value) => value.trim());
  const separator = pair.indexOf('=');
  const name = pair.slice(0, separator);
  if (separator < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new TypeError('Invalid fixture Set-Cookie identity');
  }
  const lastSlash = responsePath.lastIndexOf('/');
  let cookiePath = responsePath.startsWith('/') && lastSlash > 0 ? responsePath.slice(0, lastSlash) : '/';
  let maxAge: bigint | undefined;
  let expiresAt: number | undefined;
  let httpOnly = false;
  for (const attribute of attributes) {
    const equals = attribute.indexOf('=');
    const attributeName = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const value = equals < 0 ? '' : attribute.slice(equals + 1).trim();
    if (attributeName === 'domain') throw new TypeError('Fixture jar requires host-only cookies');
    if (attributeName === 'httponly') httpOnly = true;
    if (attributeName === 'path' && value.startsWith('/')) cookiePath = value;
    if (attributeName === 'max-age' && /^-?[0-9]+$/.test(value)) maxAge = BigInt(value);
    if (attributeName === 'expires') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }
  if (maxAge !== undefined) {
    // Valid Max-Age wins irrespective of attribute order or conflicting Expires.
    const deadline = BigInt(receivedAt) + maxAge * 1000n;
    expiresAt = maxAge <= 0n ? receivedAt : deadline > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(deadline);
  }
  return { name, pair, path: cookiePath, expiresAt, httpOnly };
}

type CookieJar = Map<string, CookieRecord>;

function applySetCookies(jar: CookieJar, headers: string[], receivedAt: number, responsePath = '/'): void {
  if (!Number.isSafeInteger(receivedAt)) throw new TypeError('Invalid fixture cookie receipt time');
  for (const header of headers) {
    const record = cookieRecord(header, receivedAt, responsePath);
    const identity = JSON.stringify([record.name, record.path]);
    if (record.expiresAt !== undefined && record.expiresAt <= receivedAt) jar.delete(identity);
    else jar.set(identity, record);
  }
}

function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  return requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

function browserCookies(jar: CookieJar, requestPath: string, readableOnly = false, now = Date.now()): string {
  return [...jar.values()]
    .filter(
      ({ path, httpOnly, expiresAt }) =>
        (expiresAt === undefined || expiresAt > now) &&
        cookiePathMatches(requestPath, path) &&
        (!readableOnly || !httpOnly),
    )
    .sort((left, right) => right.path.length - left.path.length)
    .map(({ pair }) => pair)
    .join('; ');
}

test('management listener serves SPA under /admin without swallowing API paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-static-'));
  const web = path.join(dir, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Console</title>');
  fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'window.__console=true');
  const admin = createAdminServer({
    configPath: path.join(dir, 'config.json'),
    webDistPath: web,
    saasIdentityHandler: async (req, res) => {
      if (req.url !== '/console/api/v1/ping') return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { ok: true } }));
      return true;
    },
  });
  try {
    await new Promise<void>((resolve) => admin.server.listen(0, '127.0.0.1', resolve));
    const addr = admin.server.address();
    assert.ok(addr && typeof addr !== 'string');
    const base = `http://127.0.0.1:${addr.port}`;
    const page = await fetch(`${base}/admin/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Console/);
    const route = await fetch(`${base}/admin/upstreams`, { headers: { accept: 'text/html' } });
    assert.equal(route.status, 200);
    const asset = await fetch(`${base}/admin/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /__console/);
    const consolePage = await fetch(`${base}/console/`);
    assert.equal(consolePage.status, 200);
    assert.match(await consolePage.text(), /Console/);
    const consoleRoute = await fetch(`${base}/console/login`, { headers: { accept: 'text/html' } });
    assert.equal(consoleRoute.status, 200);
    assert.match(await consoleRoute.text(), /Console/);
    const consoleApi = await fetch(`${base}/console/api/v1/ping`);
    assert.equal(consoleApi.status, 200);
    assert.equal((await consoleApi.json()).data.ok, true);
    const unknownConsoleApi = await fetch(`${base}/console/api/v1/unknown`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(unknownConsoleApi.status, 404);
    assert.match(unknownConsoleApi.headers.get('content-type') ?? '', /application\/json/);
    assert.doesNotMatch(await unknownConsoleApi.text(), /Console/);
    const api = await fetch(`${base}/admin/api/v1/bootstrap`);
    assert.equal(api.status, 200);
    assert.equal(((await api.json()) as { data: { initialized: boolean } }).data.initialized, false);
    const unknownApi = await fetch(`${base}/admin/api/v1/unknown`);
    assert.notEqual(unknownApi.headers.get('content-type'), 'text/html');
  } finally {
    await admin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('console cookies support a browser mutation from /console', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-console-cookie-'));
  const web = path.join(dir, 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Console</title>');
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const sessionToken = 'session-token-for-console-test';
  const csrfToken = 'csrf-token-for-console-test';
  const session = {
    userId: 'user-1',
    activeTenantId: null,
    expiresAt: '2030-01-01T00:00:00.000Z',
    createdAt: '2029-01-01T00:00:00.000Z',
  };
  let createdBy: string | undefined;
  const service = {
    login: async () => ({ token: sessionToken, csrfToken, session }),
    getSession: async (token: string) => (token === sessionToken ? session : undefined),
    verifyCsrfToken: async (token: string, supplied: string) => token === sessionToken && supplied === csrfToken,
    createTenant: async (userId: string, input: { name: string; slug?: string }) => {
      createdBy = userId;
      return {
        id: 'tenant-1',
        name: input.name,
        slug: input.slug ?? 'tenant-1',
        status: 'active' as const,
        role: 'owner' as const,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
      };
    },
  };
  const admin = createAdminServer({
    configPath: path.join(dir, 'config.json'),
    webDistPath: web,
    publicOrigin: origin,
    saasIdentityHandler: createSaasIdentityHandler({
      service: service as never,
      publicOrigin: origin,
      sessionTtlSeconds: 900,
      rateLimiter: { take: async () => undefined },
    }),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      admin.server.once('error', reject);
      admin.server.listen(port, '127.0.0.1', () => resolve());
    });
    const page = await fetch(`${origin}/console/`);
    assert.equal(page.status, 200);

    for (const method of ['GET', 'POST'] as const) {
      const headers = new Headers({ accept: 'application/json' });
      const options: RequestInit = { method, headers };
      if (method === 'POST') {
        headers.set('content-type', 'application/json');
        headers.set('origin', origin);
        headers.set('host', new URL(origin).host);
        options.body = JSON.stringify({
          token: 'unused',
          email: 'person@example.test',
          password: 'unused',
          displayName: 'Person',
        });
      }
      const removedBootstrap = await fetch(`${origin}/console/api/v1/bootstrap`, options);
      assert.equal(removedBootstrap.status, 404, `${method} console bootstrap route should not exist`);
      assert.match(removedBootstrap.headers.get('content-type') ?? '', /application\/json/);
    }

    const login = await fetch(`${origin}/console/api/v1/auth/session`, {
      method: 'POST',
      headers: { origin, host: new URL(origin).host, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.test', password: 'correct horse battery staple' }),
    });
    assert.equal(login.status, 200);
    const cookies = setCookieHeaders(login);
    const jar: CookieJar = new Map();
    applySetCookies(jar, cookies, Date.now(), '/console/api/v1/auth/session');
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('mr_saas_session='));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith(`mr_saas_csrf=${encodeURIComponent(csrfToken)};`));
    assert.ok(sessionCookie);
    assert.ok(csrfCookie);
    assert.match(sessionCookie, /Path=\/console\/api\/v1/);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(csrfCookie, /Path=\/console(?:;|$)/);
    assert.doesNotMatch(csrfCookie, /HttpOnly/);

    const readableFromConsole = browserCookies(jar, '/console/', true);
    assert.match(readableFromConsole, /mr_saas_csrf=csrf-token-for-console-test/);
    assert.doesNotMatch(readableFromConsole, /mr_saas_session=/);
    const csrfFromPage = /(?:^|; )mr_saas_csrf=([^;]+)/.exec(readableFromConsole)?.[1];
    assert.equal(csrfFromPage, csrfToken);
    assert.ok(csrfFromPage);
    const mutation = await fetch(`${origin}/console/api/v1/tenants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        host: new URL(origin).host,
        referer: `${origin}/console/`,
        cookie: browserCookies(jar, '/console/api/v1/tenants'),
        'x-csrf-token': csrfFromPage,
      },
      body: JSON.stringify({ name: 'Browser tenant' }),
    });
    await mutation.arrayBuffer();
    assert.equal(mutation.status, 201, 'Authenticated console mutation must return 201');
    assert.equal(createdBy, 'user-1');
  } finally {
    await admin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local mode does not mount the SaaS console without a database handler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-router-local-console-'));
  const web = path.join(dir, 'web');
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Console</title>');
  const admin = createAdminServer({ configPath: path.join(dir, 'config.json'), webDistPath: web });
  try {
    await new Promise<void>((resolve) => admin.server.listen(0, '127.0.0.1', resolve));
    const address = admin.server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(`${base}/console/`, { headers: { accept: 'text/html' } });
    assert.notEqual(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const api = await fetch(`${base}/console/api/v1/bootstrap`, { headers: { accept: 'text/html' } });
    assert.notEqual(api.headers.get('content-type'), 'text/html; charset=utf-8');
  } finally {
    await admin.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cookie jar applies legacy API-only CSRF deletion before one live console cookie', () => {
  const now = Date.UTC(2030, 0, 1);
  const jar: CookieJar = new Map();
  applySetCookies(jar, ['mr_saas_csrf=old-api-value; Path=/console/api/v1; Max-Age=900'], now);
  applySetCookies(
    jar,
    [
      'mr_saas_csrf=; Path=/console; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'mr_saas_csrf=; Path=/console/api/v1; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'mr_saas_session=unit-session; HttpOnly; Path=/console/api/v1; Max-Age=900',
      'mr_saas_csrf=new-console-value; Path=/console; Max-Age=900',
    ],
    now,
  );
  assert.equal(browserCookies(jar, '/console/', true, now), 'mr_saas_csrf=new-console-value');
  assert.equal(
    browserCookies(jar, '/console/api/v1/tenants', false, now),
    'mr_saas_session=unit-session; mr_saas_csrf=new-console-value',
  );
  assert.equal(jar.size, 2);
});

test('live same-name cookies on distinct paths remain duplicated in the request header', () => {
  const now = Date.UTC(2030, 0, 1);
  const jar: CookieJar = new Map();
  applySetCookies(
    jar,
    [
      'mr_saas_csrf=live-console; Path=/console; Max-Age=900',
      'mr_saas_csrf=live-api; Path=/console/api/v1; Max-Age=900',
    ],
    now,
  );
  const header = browserCookies(jar, '/console/api/v1/tenants', false, now);
  assert.equal(header, 'mr_saas_csrf=live-api; mr_saas_csrf=live-console');
  assert.equal(header.split('; ').filter((pair) => pair.startsWith('mr_saas_csrf=')).length, 2);
  assert.equal(browserCookies(jar, '/console/', true, now), 'mr_saas_csrf=live-console');
});

test('cookie deletion and replacement apply only to the same name and path identity', () => {
  const now = Date.UTC(2030, 0, 1);
  const jar: CookieJar = new Map();
  applySetCookies(
    jar,
    [
      'mr_saas_csrf=live-console; Path=/console',
      'mr_saas_csrf=live-api; Path=/console/api/v1',
      'other=retained; Path=/console',
    ],
    now,
  );
  applySetCookies(jar, ['mr_saas_csrf=; Path=/console/api/v1; Max-Age=0'], now);
  assert.equal(browserCookies(jar, '/console/api/v1/tenants', false, now), 'mr_saas_csrf=live-console; other=retained');
  applySetCookies(jar, ['mr_saas_csrf=replaced-console; Path=/console'], now);
  assert.equal(browserCookies(jar, '/console/', false, now), 'mr_saas_csrf=replaced-console; other=retained');
  assert.equal(jar.size, 2);
  assert.equal(browserCookies(jar, '/console-elsewhere', false, now), '');
});

test('valid Max-Age wins over conflicting Expires in either attribute order', () => {
  const now = Date.UTC(2030, 0, 1);
  for (const attributes of [
    'Max-Age=90; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=90',
  ]) {
    const jar: CookieJar = new Map();
    applySetCookies(jar, ['mr_saas_csrf=live; Path=/console; ' + attributes], now);
    assert.equal(browserCookies(jar, '/console/', true, now + 89_999), 'mr_saas_csrf=live');
    assert.equal(browserCookies(jar, '/console/', true, now + 90_000), '');
  }
  for (const maxAge of ['0', '-1']) {
    const jar: CookieJar = new Map();
    applySetCookies(jar, ['mr_saas_csrf=live; Path=/console'], now);
    applySetCookies(
      jar,
      ['mr_saas_csrf=deleted; Path=/console; Max-Age=' + maxAge + '; Expires=Wed, 01 Jan 2031 00:00:00 GMT'],
      now,
    );
    assert.equal(jar.size, 0);
    assert.equal(browserCookies(jar, '/console/', true, now), '');
  }
});

test('invalid Max-Age falls back to Expires and expiry is checked without resetting receipt time', () => {
  const now = Date.UTC(2030, 0, 1);
  const jar: CookieJar = new Map();
  applySetCookies(
    jar,
    [
      'past=expired; Path=/console; Max-Age=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      'future=live; Path=/console; Max-Age=invalid; Expires=Wed, 01 Jan 2031 00:00:00 GMT',
    ],
    now,
  );
  assert.equal(browserCookies(jar, '/console/', false, now), 'future=live');
  assert.equal(browserCookies(jar, '/console/', false, Date.UTC(2031, 0, 1)), '');
});

test('empty session-cookie value without expiry is not silently treated as deletion', () => {
  const now = Date.UTC(2030, 0, 1);
  const jar: CookieJar = new Map();
  applySetCookies(
    jar,
    ['mr_saas_csrf=; Path=/console', 'mr_saas_session=private; Path=/console/api/v1; HttpOnly'],
    now,
  );
  assert.equal(browserCookies(jar, '/console/', true, now), 'mr_saas_csrf=');
  assert.equal(browserCookies(jar, '/console/api/v1/tenants', true, now), 'mr_saas_csrf=');
  assert.equal(browserCookies(jar, '/console/api/v1/tenants', false, now), 'mr_saas_session=private; mr_saas_csrf=');
});

test('default cookie path is response-relative and unsupported domain scope is not silently collapsed', () => {
  const now = Date.UTC(2030, 0, 1);
  const jar: CookieJar = new Map();
  applySetCookies(jar, ['unit=live'], now, '/console/api/v1/auth/session');
  assert.equal(browserCookies(jar, '/console/api/v1/auth/session', false, now), 'unit=live');
  assert.equal(browserCookies(jar, '/console/api/v1/tenants', false, now), '');
  assert.throws(() => applySetCookies(jar, ['unit=other-host; Domain=example.test; Path=/console'], now), TypeError);
  assert.equal(jar.size, 1);
});
