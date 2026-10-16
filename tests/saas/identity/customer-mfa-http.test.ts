import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { type TestContext, test } from 'node:test';
import { type CustomerMfaHttpOptions, createCustomerMfaHandler } from '../../../src/saas/identity/customer-mfa-http.js';
import { CustomerMfaService } from '../../../src/saas/identity/customer-mfa-service.js';
import type { CustomerMfaSessionProof } from '../../../src/saas/identity/customer-mfa-types.js';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import { totpCode } from '../../../src/saas/platform/auth/totp.js';
import { CustomerMfaUnitDatabase, CustomerMfaUnitKeys, TEST_PASSWORD } from './customer-mfa-unit-database.js';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Unit HTTP shape');
  return value;
}
/** Actual wire response projection, never a fabricated handler/business response. */
interface UnitHttpReply {
  response: { status: number; headers: Headers };
  json: Record<string, unknown>;
}
/** Wire Host is explicit; TCP connects only to this fixture's owned 127.0.0.1 listener. */
async function requestWithHost(
  origin: string,
  host: string,
  proof?: CustomerMfaSessionProof,
  extraHeaders: Record<string, string> = {},
  path = '',
  input?: unknown,
): Promise<UnitHttpReply> {
  const target = new URL('/console/api/v1/auth/mfa' + path, origin);
  assert.equal(target.protocol, 'http:');
  assert.ok(target.hostname === '127.0.0.1' || target.hostname === '127.0.0.2');
  assert.ok(Number(target.port) > 0);
  const payload = input === undefined ? undefined : JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      target,
      {
        hostname: '127.0.0.1',
        port: target.port,
        method: input === undefined ? 'GET' : 'POST',
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: {
          ...(proof
            ? {
                origin,
                cookie: 'mr_saas_session=' + proof.sessionToken + '; mr_saas_csrf=' + proof.csrfToken,
                'x-csrf-token': proof.csrfToken,
                'content-type': 'application/json',
              }
            : {}),
          ...extraHeaders,
          host,
          connection: 'close',
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: unknown) => {
          if (!(chunk instanceof Uint8Array)) {
            response.destroy(new Error('Unit Host response bytes'));
            return;
          }
          size += chunk.byteLength;
          if (size > 4096) {
            response.destroy(new Error('Unit Host response limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', () => reject(new Error('Unit Host response failed')));
        response.once('aborted', () => reject(new Error('Unit Host response aborted')));
        response.once('end', () => {
          try {
            const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.ok(record(json));
            const status = response.statusCode;
            assert.ok(typeof status === 'number');
            const headers = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              const name = response.rawHeaders[index],
                value = response.rawHeaders[index + 1];
              assert.ok(name !== undefined && value !== undefined);
              headers.append(name, value);
            }
            resolve({ response: { status, headers }, json });
          } catch {
            reject(new Error('Unit Host response shape'));
          }
        });
      },
    );
    request.once('error', () => reject(new Error('Unit Host request failed')));
    assert.equal(request.getHeader('host'), host);
    request.end(payload);
  });
}
function assertExpiredCustomerCookies(cookies: string[]): void {
  assert.equal(cookies.length, 3);
  assert.equal(cookies.filter((c) => c.startsWith('mr_saas_session=;')).length, 1);
  assert.equal(cookies.filter((c) => c.startsWith('mr_saas_csrf=;')).length, 2);
  assert.equal(
    cookies.every(
      (c) => c.includes('SameSite=Strict') && c.includes('Max-Age=0') && c.includes('Expires=Thu, 01 Jan 1970'),
    ),
    true,
  );
  assert.deepEqual(
    cookies
      .map((c) =>
        c
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p.startsWith('Path=') || p === 'HttpOnly')
          .join(';'),
      )
      .sort(),
    ['HttpOnly;Path=/console/api/v1', 'Path=/console', 'Path=/console/api/v1'].sort(),
  );
}
async function endpoint(
  t: TestContext,
  composed = false,
  cookieSecure = false,
  deployment: 'configured' | 'absent' = 'configured',
  bindHost: '127.0.0.1' | '127.0.0.2' = '127.0.0.1',
) {
  const db = await CustomerMfaUnitDatabase.create(),
    keys = new CustomerMfaUnitKeys(db),
    proof = await db.session();
  const svc = new CustomerMfaService(db, { issuer: 'Customer MFA HTTP Unit', keyProvider: keys });
  let handler: ReturnType<typeof createCustomerMfaHandler> | undefined;
  let limited = false,
    limiterFailed = false;
  const server = createServer((req, res) => {
    void (async () => {
      if (!handler || !(await handler(req, res))) {
        res.writeHead(404);
        res.end();
      }
    })().catch(() => {
      res.destroy();
    });
  });
  t.after(async () => {
    try {
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    } finally {
      keys.key.fill(0);
    }
  });
  const listening = once(server, 'listening');
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Socket ownership does not depend on a host-specific 127.0.0.2 alias.
  // The declared origin/Host below remains bindHost, not the connect address.
  server.listen(0, '127.0.0.1');
  try {
    await Promise.race([
      listening,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error('Unit listener timeout')), 5000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  assert.equal(addr.address, '127.0.0.1');
  const origin = 'http://' + bindHost + ':' + addr.port;
  const rateLimiter = {
    async take() {
      if (limiterFailed) throw new Error('synthetic private rate-limit detail');
      return limited ? 1 : undefined;
    },
  };
  handler = composed
    ? createSaasIdentityHandler({
        service: new SaasIdentityService(db, { now: () => new Date(db.state.now) }),
        ...(deployment === 'absent' ? {} : { customerMfa: svc }),
        publicOrigin: origin,
        sessionTtlSeconds: 1800,
        rateLimiter,
        cookieSecure,
      })
    : createCustomerMfaHandler({
        ...(deployment === 'absent'
          ? { sessionAuthority: new SaasIdentityService(db, { now: () => new Date(db.state.now) }) }
          : { service: svc }),
        publicOrigin: origin,
        rateLimiter,
        cookieSecure,
      });
  const request = async (
    path: string,
    body?: unknown,
    p: CustomerMfaSessionProof = proof,
    headers: Record<string, string> = {},
  ): Promise<UnitHttpReply> => {
    if (bindHost === '127.0.0.2')
      return requestWithHost(origin, headers.host ?? new URL(origin).host, p, headers, path, body);
    const response = await fetch(origin + '/console/api/v1/auth/mfa' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        cookie: 'mr_saas_session=' + p.sessionToken + '; mr_saas_csrf=' + p.csrfToken,
        'x-csrf-token': p.csrfToken,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    const json: unknown = await response.json();
    assert.ok(record(json));
    return { response, json };
  };
  return {
    db,
    keys,
    svc,
    proof,
    request,
    origin,
    listenHost: addr.address,
    setLimited: (v: boolean) => {
      limited = v;
    },
    setLimiterFailure: () => {
      limiterFailed = true;
    },
  };
}
test('actual public HTTP -> real password/crypto/service enrollment and confirm clear customer cookies', async (t) => {
  const f = await endpoint(t);
  const start = await f.request('/enrollment/start', { password: TEST_PASSWORD });
  assert.equal(start.response.status, 201);
  assert.equal(start.response.headers.get('cache-control'), 'no-store');
  assert.ok(record(start.json.data));
  const secret = string(start.json.data.secret),
    token = string(start.json.data.confirmationToken);
  assert.equal(JSON.stringify(f.db.state.events).includes(secret), false);
  const done = await f.request(
    '/enrollment/confirm',
    { password: TEST_PASSWORD, confirmationToken: token, code: totpCode(secret, f.db.state.now) },
    f.db.next(f.proof),
  );
  assert.equal(done.response.status, 200);
  assert.ok(record(done.json.data));
  assert.equal(done.json.data.signInRequired, true);
  assert.equal(done.response.headers.getSetCookie().length, 3);
  assert.equal(
    done.response.headers.getSetCookie().every((c) => c.includes('Max-Age=0') && c.includes('SameSite=Strict')),
    true,
  );
  assertExpiredCustomerCookies(done.response.headers.getSetCookie());
  assert.equal(f.db.state.credentials[0]?.verified, true);
  assert.equal(f.db.state.sessions[0]?.revoked, true);
  const status = await f.request('', undefined, await f.db.session());
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.json.data, { enabled: true });
  assert.equal('secret' in status.json.data, false);
});
test('public duplicate concurrent start preserves one credential, no second secret issuance', async (t) => {
  const f = await endpoint(t),
    responses = await Promise.all([
      f.request('/enrollment/start', { password: TEST_PASSWORD }),
      f.request('/enrollment/start', { password: TEST_PASSWORD }, f.db.next(f.proof)),
    ]);
  assert.deepEqual(responses.map((x) => x.response.status).sort(), [201, 409]);
  assert.equal(f.db.state.credentials.length, 1);
  assert.equal(f.db.state.enrollments.length, 1);
  assert.equal(responses.filter((x) => record(x.json.data) && Object.hasOwn(x.json.data, 'secret')).length, 1);
});
test('HTTP origin/CSRF/duplicate cookies/query secret/client recent boolean cannot reach producer', async (t) => {
  const f = await endpoint(t);
  const deniedHeaders: Record<string, string>[] = [
    { origin: 'http://untrusted.invalid' },
    { 'x-csrf-token': 'incorrect' },
    {
      cookie:
        'mr_saas_session=' +
        f.proof.sessionToken +
        '; mr_saas_session=' +
        f.proof.sessionToken +
        '; mr_saas_csrf=' +
        f.proof.csrfToken,
    },
    {
      cookie:
        'mr_saas_session=' +
        f.proof.sessionToken +
        '; mr_saas_csrf=' +
        f.proof.csrfToken +
        '; mr_saas_csrf=' +
        f.proof.csrfToken,
    },
    {
      cookie:
        'mr_saas_session=' +
        f.proof.sessionToken +
        '; mr_saas_csrf=' +
        f.proof.csrfToken +
        '; mr_saas_csrf=different-synthetic-csrf',
    },
  ];
  for (const headers of deniedHeaders) {
    const r = await f.request('/enrollment/start', { password: TEST_PASSWORD }, f.db.next(f.proof), headers);
    assert.equal(r.response.status === 401 || r.response.status === 403, true);
  }
  const query = await f.request('/enrollment/start?secret=synthetic-hidden', { password: TEST_PASSWORD });
  assert.equal(query.response.status, 400);
  assert.equal(JSON.stringify(query.json).includes('synthetic-hidden'), false);
  const clientProof = await f.request('/enrollment/start', { password: TEST_PASSWORD, recent: true });
  assert.equal(clientProof.response.status, 400);
  assert.equal(f.keys.calls, 0);
  assert.equal(f.db.state.commands.length, 0);
});
test('expired enrollment and raw sensitive key/service errors never surface public detail', async (t) => {
  const f = await endpoint(t),
    start = await f.request('/enrollment/start', { password: TEST_PASSWORD });
  assert.ok(record(start.json.data));
  const token = string(start.json.data.confirmationToken);
  f.db.state.now += 300001;
  const expired = await f.request(
    '/enrollment/confirm',
    { password: TEST_PASSWORD, confirmationToken: token, code: '000000' },
    f.db.next(f.proof),
  );
  assert.equal(expired.response.status, 409);
  assert.equal(JSON.stringify(expired.json).includes(token), false);
  f.keys.fail = true;
  const failure = await f.request('/enrollment/start', { password: TEST_PASSWORD }, f.db.next(f.proof));
  assert.equal(failure.response.status, 503);
  assert.equal(JSON.stringify(failure.json).includes('synthetic sensitive'), false);
});
test('HTTP actual revoke requires password plus fresh TOTP, revokes current-session facts', async (t) => {
  const f = await endpoint(t),
    start = await f.request('/enrollment/start', { password: TEST_PASSWORD });
  assert.ok(record(start.json.data));
  const secret = string(start.json.data.secret),
    token = string(start.json.data.confirmationToken);
  const confirmed = await f.request('/enrollment/confirm', {
    password: TEST_PASSWORD,
    confirmationToken: token,
    code: totpCode(secret, f.db.state.now),
  });
  assert.equal(confirmed.response.status, 200);
  const proof = await f.db.session();
  f.db.state.now += 60000;
  const wrong = await f.request('/revoke', { password: 'wrong', code: totpCode(secret, f.db.state.now) }, proof);
  assert.equal(wrong.response.status, 403);
  assert.equal(f.db.state.credentials[0]?.revoked, false);
  const revoked = await f.request(
    '/revoke',
    { password: TEST_PASSWORD, code: totpCode(secret, f.db.state.now) },
    f.db.next(proof),
  );
  assert.equal(revoked.response.status, 200);
  assert.equal(f.db.state.credentials[0]?.revoked, true);
  assertExpiredCustomerCookies(revoked.response.headers.getSetCookie());
  const old = await f.request('', undefined, proof);
  assert.equal(old.response.status, 401);
});
test('shared limiter failure/rate limit is fail-closed without password/KMS/business effects', async (t) => {
  const f = await endpoint(t);
  f.setLimited(true);
  assert.equal((await f.request('/enrollment/start', { password: TEST_PASSWORD })).response.status, 429);
  f.setLimited(false);
  f.setLimiterFailure();
  const failed = await f.request('/enrollment/start', { password: TEST_PASSWORD });
  assert.equal(failed.response.status, 503);
  assert.equal(JSON.stringify(failed.json).includes('synthetic private'), false);
  assert.equal(f.keys.calls, 0);
  assert.equal(f.db.state.credentials.length, 0);
});
test('existing identity HTTP composition delegates the public MFA path to the genuine producer', async (t) => {
  const f = await endpoint(t, true);
  const denied = await f.request('/enrollment/start', { password: 'incorrect' });
  assert.equal(denied.response.status, 403);
  assert.equal(f.keys.calls, 0);
  const started = await f.request('/enrollment/start', { password: TEST_PASSWORD });
  assert.equal(started.response.status, 201);
  assert.ok(record(started.json.data));
  const secret = string(started.json.data.secret),
    token = string(started.json.data.confirmationToken);
  const confirmed = await f.request('/enrollment/confirm', {
    password: TEST_PASSWORD,
    confirmationToken: token,
    code: totpCode(secret, f.db.state.now),
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(f.db.state.credentials[0]?.verified, true);
  assert.equal(
    f.db.state.sessions.every((s) => s.revoked),
    true,
  );
  assert.equal(f.db.state.events.length, f.db.state.audits.length);
  assert.equal(f.db.state.events.length, f.db.state.outbox.length);
  assertExpiredCustomerCookies(confirmed.response.headers.getSetCookie());
});

test('absent deployment uses real identity session and CSRF before no-store 503, accepts GET without Origin and never queries MFA tables', async (t) => {
  const f = await endpoint(t, true, false, 'absent');
  const before = f.db.trace.length;
  const response = await fetch(f.origin + '/console/api/v1/auth/mfa', {
    headers: {
      cookie: 'mr_saas_session=' + f.proof.sessionToken + '; mr_saas_csrf=' + f.proof.csrfToken,
      'x-csrf-token': f.proof.csrfToken,
    },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value: unknown = await response.json();
  assert.ok(record(value));
  assert.ok(record(value.error));
  assert.equal(value.error.code, 'UNAVAILABLE');
  assert.equal(value.error.availability, 'deployment-unavailable-v1');
  assert.equal(Object.hasOwn(value, 'data'), false);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.deepEqual(
    f.db.trace.slice(before).map((x) => x.tag),
    ['identity-session-read', 'identity-csrf-read'],
  );
  assert.equal(f.keys.calls, 0);
  assert.equal(f.db.state.commands.length, 0);
  for (const path of ['/enrollment/start', '/enrollment/confirm', '/revoke']) {
    const denied = await f.request(path, { password: TEST_PASSWORD, code: '000000' });
    assert.equal(denied.response.status, 503);
    assert.ok(record(denied.json.error));
    assert.equal(denied.json.error.availability, 'deployment-unavailable-v1');
    assert.equal(JSON.stringify(denied.json).includes(TEST_PASSWORD), false);
    assert.equal(denied.response.headers.has('set-cookie'), false);
  }
  assert.equal(f.keys.calls, 0);
  assert.equal(f.db.state.credentials.length, 0);
});

test('absent capability never bypasses Host Origin duplicate-cookie durable-CSRF revocation expiry or shared-limit failures', async (t) => {
  const f = await endpoint(t, false, false, 'absent');
  for (const headers of [
    { origin: 'http://untrusted.invalid' },
    { 'x-csrf-token': 'incorrect' },
    {
      cookie:
        'mr_saas_session=' +
        f.proof.sessionToken +
        '; mr_saas_csrf=' +
        f.proof.csrfToken +
        '; mr_saas_csrf=' +
        f.proof.csrfToken,
    },
  ]) {
    const denied = await f.request('/enrollment/start', { password: TEST_PASSWORD }, f.proof, headers);
    assert.equal(denied.response.status === 401 || denied.response.status === 403, true);
    assert.ok(record(denied.json.error));
    assert.equal(denied.json.error.availability, undefined);
  }
  f.setLimited(true);
  assert.equal((await f.request('')).response.status, 429);
  f.setLimited(false);
  f.setLimiterFailure();
  const failed = await f.request('');
  assert.equal(failed.response.status, 503);
  assert.ok(record(failed.json.error));
  assert.equal(failed.json.error.availability, undefined);
  const revoked = await endpoint(t, false, false, 'absent');
  const session = revoked.db.state.sessions[0];
  assert.ok(session);
  session.revoked = true;
  assert.equal((await revoked.request('')).response.status, 401);
  session.revoked = false;
  revoked.db.state.now = Date.parse(session.expires_at) + 1;
  assert.equal((await revoked.request('')).response.status, 401);
  const mismatch = await endpoint(t, false, false, 'absent');
  const otherSession = await mismatch.db.session();
  assert.equal(
    (await mismatch.request('', undefined, { ...mismatch.proof, csrfToken: otherSession.csrfToken })).response.status,
    403,
  );
  const host = await requestWithHost(mismatch.origin, 'wrong.invalid');
  assert.equal(host.response.status, 403);
  assert.equal(mismatch.keys.calls, 0);
  assert.ok(record(host.json.error));
  assert.equal(host.json.error.code, 'ORIGIN_REJECTED');
  assert.equal(host.json.error.availability, undefined);
  assert.equal(host.response.headers.get('cache-control'), 'no-store');
});
test('configured Secure attribute matches identity cleanup for direct and composed MFA confirmation/revoke', async (t) => {
  for (const composed of [false, true]) {
    // Explicit Cookie headers exercise the real handlers, not browser cookie
    // acceptance over this synthetic loopback listener.
    const f = await endpoint(t, composed, true);
    const start = await f.request('/enrollment/start', { password: TEST_PASSWORD });
    assert.equal(start.response.status, 201);
    assert.equal(start.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(start.response.headers.getSetCookie(), []);
    assert.ok(record(start.json.data));
    const secret = string(start.json.data.secret),
      token = string(start.json.data.confirmationToken);
    const confirmed = await f.request('/enrollment/confirm', {
      password: TEST_PASSWORD,
      confirmationToken: token,
      code: totpCode(secret, f.db.state.now),
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.response.headers.get('cache-control'), 'no-store');
    assertExpiredCustomerCookies(confirmed.response.headers.getSetCookie());
    assert.equal(
      confirmed.response.headers.getSetCookie().every((c) => c.includes('; Secure')),
      true,
    );
    const proof = await f.db.session();
    f.db.state.now += 60000;
    const revoked = await f.request(
      '/revoke',
      { password: TEST_PASSWORD, code: totpCode(secret, f.db.state.now) },
      proof,
    );
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.response.headers.get('cache-control'), 'no-store');
    assertExpiredCustomerCookies(revoked.response.headers.getSetCookie());
    assert.equal(
      revoked.response.headers.getSetCookie().every((c) => c.includes('; Secure')),
      true,
    );
  }
});

test('legal 127.0.0.2 owned port0 preserves real configured status and authenticated absent deployment without MFA SQL', async (t) => {
  for (const deployment of ['absent', 'configured'] as const) {
    const f = await endpoint(t, true, false, deployment, '127.0.0.2');
    assert.equal(new URL(f.origin).hostname, '127.0.0.2');
    assert.equal(f.listenHost, '127.0.0.1');
    assert.notEqual(
      f.listenHost,
      new URL(f.origin).hostname,
      'socket address must not rewrite the declared public authority',
    );
    assert.ok(Number(new URL(f.origin).port) > 0);
    const before = f.db.trace.length;
    const status = await f.request('');
    assert.equal(status.response.headers.get('cache-control'), 'no-store');
    assert.equal(status.response.headers.has('set-cookie'), false);
    if (deployment === 'absent') {
      assert.equal(status.response.status, 503);
      assert.ok(record(status.json.error));
      assert.equal(status.json.error.availability, 'deployment-unavailable-v1');
      assert.equal(Object.hasOwn(status.json, 'data'), false);
      assert.deepEqual(
        f.db.trace.slice(before).map((x) => x.tag),
        ['identity-session-read', 'identity-csrf-read'],
      );
    } else {
      assert.equal(status.response.status, 200);
      assert.deepEqual(status.json.data, { enabled: false });
      assert.equal(
        f.db.trace.slice(before).some((x) => x.tag === 'current'),
        true,
      );
      assert.equal(
        f.db.trace.slice(before).some((x) => x.tag === 'active'),
        true,
      );
    }
    assert.equal(f.keys.calls, 0);
    assert.equal(f.db.state.commands.length, 0);
    const otherOrigin = f.origin.replace('127.0.0.2', '127.0.0.1');
    const wrongOrigin = await f.request('', undefined, f.proof, { origin: otherOrigin });
    assert.equal(wrongOrigin.response.status, 403);
    assert.ok(record(wrongOrigin.json.error));
    assert.equal(wrongOrigin.json.error.availability, undefined);
    const wrongHost = await requestWithHost(f.origin, new URL(otherOrigin).host, f.proof);
    assert.equal(wrongHost.response.status, 403);
    assert.ok(record(wrongHost.json.error));
    assert.equal(wrongHost.json.error.availability, undefined);
    assert.equal(wrongHost.json.error.code, 'ORIGIN_REJECTED');
    assert.equal(wrongHost.response.headers.get('cache-control'), 'no-store');
  }
});

test('MFA origin validation matches deployment loopback and HTTPS rules without accepting external HTTP or ambiguous origins', async (t) => {
  const db = await CustomerMfaUnitDatabase.create(),
    keys = new CustomerMfaUnitKeys(db);
  t.after(() => {
    keys.key.fill(0);
  });
  const service = new CustomerMfaService(db, { issuer: 'Customer MFA Origin Unit', keyProvider: keys });
  const sessionAuthority = new SaasIdentityService(db, { now: () => new Date(db.state.now) });
  const boundary = {
    publicOrigin: 'http://localhost',
    rateLimiter: {
      async take() {
        return undefined;
      },
    },
  };
  const variants: readonly CustomerMfaHttpOptions[] = [
    { ...boundary, service },
    { ...boundary, sessionAuthority },
  ];
  const before = db.trace.length;
  for (const options of variants) {
    for (const publicOrigin of [
      'http://127.0.0.2',
      'http://127.255.255.254',
      'http://[::1]',
      'http://localhost',
      'https://customer.example.test',
    ])
      assert.doesNotThrow(() => createCustomerMfaHandler({ ...options, publicOrigin }));
    for (const publicOrigin of [
      'http://customer.example.test',
      'http://127.0.0.2.example.test',
      'http://localhost.example.test',
      'http://[::2]',
      'http://127.0.0.999',
      'not-an-origin',
      'http://user@127.0.0.2',
      'https://user:password@customer.example.test',
      'http://127.0.0.2/path',
      'http://127.0.0.2?query=1',
      'http://127.0.0.2#fragment',
      'http://127.0.0.2/',
      'http://127.2',
      'http://2130706434',
      'http://0x7f000002',
      'http://LOCALHOST',
      'http://127.0.0.2:80',
    ])
      assert.throws(() => createCustomerMfaHandler({ ...options, publicOrigin }));
  }
  assert.equal(db.trace.length, before);
  assert.equal(keys.calls, 0);
});
