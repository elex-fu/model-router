import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { type TestContext, test } from 'node:test';
import { createCustomerPasskeyHandler } from '../../../src/saas/identity/customer-passkey-http.js';
import { CustomerPasskeyService } from '../../../src/saas/identity/customer-passkey-service.js';
import type { CustomerPasskeySessionProof } from '../../../src/saas/identity/customer-passkey-types.js';
import { createSaasIdentityHandler } from '../../../src/saas/identity/http.js';
import { SaasIdentityService } from '../../../src/saas/identity/service.js';
import {
  assertionPayload,
  registrationPayload,
  SIM_ORIGIN,
  SIM_RP_ID,
  simulatePasskey,
} from './customer-passkey-simulator.js';
import {
  CustomerPasskeyUnitDatabase,
  CustomerPasskeyUnitKeys,
  PASSKEY_TEST_PASSWORD,
} from './customer-passkey-unit-database.js';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
interface UnitHttpReply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}
async function endpoint(t: TestContext, options: { composed?: boolean; deployment?: 'configured' | 'absent' } = {}) {
  const db = await CustomerPasskeyUnitDatabase.create();
  const keys = new CustomerPasskeyUnitKeys(db);
  const proof = await db.session();
  const svc = new CustomerPasskeyService(db, {
    keyProvider: keys,
    rpId: SIM_RP_ID,
    rpName: 'Passkey HTTP Unit',
    origins: [SIM_ORIGIN],
  });
  let handler: ((req: unknown, res: unknown) => Promise<boolean>) | undefined;
  let limited = false;
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
  server.listen(0, '127.0.0.1');
  await listening;
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const origin = `http://127.0.0.1:${addr.port}`;
  const rateLimiter = {
    async take() {
      return limited ? 1 : undefined;
    },
  };
  const passkeyOptions = { publicOrigin: origin, rateLimiter, cookieSecure: false };
  handler = options.composed
    ? (createSaasIdentityHandler({
        service: new SaasIdentityService(db, { now: () => new Date(db.state.now) }),
        ...(options.deployment === 'absent' ? {} : { customerPasskey: svc }),
        publicOrigin: origin,
        sessionTtlSeconds: 1800,
        rateLimiter,
      }) as never)
    : (createCustomerPasskeyHandler({
        ...(options.deployment === 'absent'
          ? { sessionAuthority: new SaasIdentityService(db, { now: () => new Date(db.state.now) }) }
          : { service: svc }),
        ...passkeyOptions,
      }) as never);
  const request = async (
    path: string,
    body?: unknown,
    p: CustomerPasskeySessionProof = proof,
    headers: Record<string, string> = {},
  ): Promise<UnitHttpReply> => {
    const response = await fetch(`${origin}/console/api/v1/auth/passkey${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        cookie: `mr_saas_session=${p.sessionToken}; mr_saas_csrf=${p.csrfToken}`,
        'x-csrf-token': p.csrfToken,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json: unknown = await response.json();
    assert.ok(record(json));
    return { status: response.status, headers: response.headers, json };
  };
  return {
    db,
    keys,
    proof,
    svc,
    request,
    origin,
    setLimited: (v: boolean) => {
      limited = v;
    },
  };
}
function errorCode(reply: UnitHttpReply): string {
  const error = reply.json.error;
  assert.ok(record(error));
  assert.equal(JSON.stringify(reply.json).includes('synthetic'), false, 'sensitive detail must never surface');
  return String(error.code);
}

test('full registration and assertion ceremonies run over the wire with strict envelope shapes', async (t) => {
  const { db, proof, request } = await endpoint(t);
  const key = simulatePasskey();
  const start = await request('/registration/start', { password: PASSKEY_TEST_PASSWORD });
  assert.equal(start.status, 201);
  const data = start.json.data;
  assert.ok(record(data));
  const challenge = String(data.challenge);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(data.rp, { id: SIM_RP_ID, name: 'Passkey HTTP Unit' });
  assert.equal(data.attestation, 'none');
  // The creation options echo the account email (user.name) by design; secrets never.
  assert.equal(JSON.stringify(data).includes(PASSKEY_TEST_PASSWORD), false);
  assert.equal(JSON.stringify(data).includes('passwordHash'), false);

  const finish = await request('/registration/finish', {
    password: PASSKEY_TEST_PASSWORD,
    challenge,
    credential: registrationPayload(key, challenge),
  });
  assert.equal(finish.status, 200);
  const changed = finish.json.data;
  assert.ok(record(changed));
  assert.equal(changed.credentialId, key.credentialId);
  assert.equal(changed.signInRequired, true);
  const cookies = finish.headers.getSetCookie();
  assert.equal(cookies.length, 3, 'factor change expires the session cookies on the wire');
  assert.equal(
    cookies.every((c) => c.includes('Max-Age=0')),
    true,
  );

  const session = await db.session();
  const list = await request('', undefined, session);
  assert.equal(list.status, 200);
  assert.deepEqual(
    (list.json.data as { passkeys: Array<{ credentialId: string }> }).passkeys.map((p) => p.credentialId),
    [key.credentialId],
  );

  const assertStart = await request(
    '/assertion/start',
    { password: PASSKEY_TEST_PASSWORD, credentialId: key.credentialId },
    session,
  );
  assert.equal(assertStart.status, 201);
  const assertData = assertStart.json.data;
  assert.ok(record(assertData));
  assert.deepEqual(assertData.allowCredentials, [{ type: 'public-key', id: key.credentialId }]);
  const assertChallenge = String(assertData.challenge);
  const verified = await request(
    '/assertion/finish',
    {
      password: PASSKEY_TEST_PASSWORD,
      challenge: assertChallenge,
      credential: assertionPayload(key, assertChallenge, 1),
    },
    session,
  );
  assert.equal(verified.status, 200);
  assert.deepEqual(verified.json.data, { verified: true, credentialId: key.credentialId });
  assert.equal(verified.headers.getSetCookie().length, 0, 'assertion keeps the session alive');
});

test('boundary negatives: method, origin, host, csrf, session, body shapes and rate limit', async (t) => {
  const { proof, request, origin, setLimited } = await endpoint(t);
  const key = simulatePasskey();
  const start = await request('/registration/start', { password: PASSKEY_TEST_PASSWORD });
  const challenge = String((start.json.data as Record<string, unknown>).challenge);

  const put = await fetch(
    `http://127.0.0.1:${new URL(String(start.headers.get('x-unit-origin') ?? 'http://127.0.0.1')).port}`,
    {},
  ).catch(() => undefined);
  assert.equal(put, undefined, 'fixture never issues cross-fixture requests');

  const badMethod = await request('', { password: PASSKEY_TEST_PASSWORD });
  assert.equal(badMethod.status, 405);
  assert.equal(errorCode(badMethod), 'METHOD_NOT_ALLOWED');
  const badOrigin = await request(
    '/registration/finish',
    { password: PASSKEY_TEST_PASSWORD, challenge, credential: registrationPayload(key, challenge) },
    proof,
    { origin: 'https://evil.example.test' },
  );
  assert.equal(badOrigin.status, 403);
  assert.equal(errorCode(badOrigin), 'ORIGIN_REJECTED');
  // fetch forbids overriding Host; go through the raw socket for the host check.
  const badHost = await new Promise<UnitHttpReply>((resolve, reject) => {
    const target = new URL(`${origin}/console/api/v1/auth/passkey/registration/finish`);
    const request = httpRequest(
      target,
      {
        method: 'POST',
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: {
          origin: origin,
          cookie: `mr_saas_session=${proof.sessionToken}; mr_saas_csrf=${proof.csrfToken}`,
          'x-csrf-token': proof.csrfToken,
          'content-type': 'application/json',
          host: 'evil.example.test',
          connection: 'close',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          try {
            const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            assert.ok(record(json));
            resolve({ status: response.statusCode ?? 0, headers: new Headers(), json });
          } catch {
            reject(new Error('Unit Host response shape'));
          }
        });
      },
    );
    request.once('error', () => reject(new Error('Unit Host request failed')));
    request.end(
      JSON.stringify({ password: PASSKEY_TEST_PASSWORD, challenge, credential: registrationPayload(key, challenge) }),
    );
  });
  assert.equal(badHost.status, 403);
  assert.equal(errorCode(badHost), 'ORIGIN_REJECTED');
  const badCsrf = await request(
    '/registration/finish',
    { password: PASSKEY_TEST_PASSWORD, challenge, credential: registrationPayload(key, challenge) },
    proof,
    { 'x-csrf-token': `${proof.csrfToken.slice(1)}x` },
  );
  assert.equal(badCsrf.status, 403);
  assert.equal(errorCode(badCsrf), 'CSRF_REJECTED');
  const badSession = await request(
    '/registration/finish',
    { password: PASSKEY_TEST_PASSWORD, challenge, credential: registrationPayload(key, challenge) },
    { ...proof, sessionToken: `${proof.sessionToken.slice(1)}x` },
  );
  assert.equal(badSession.status, 401);
  assert.equal(errorCode(badSession), 'UNAUTHENTICATED');
  for (const malformed of [
    { challenge, credential: registrationPayload(key, challenge) }, // password missing
    { password: PASSKEY_TEST_PASSWORD, challenge, credential: { id: 'x' } }, // credential keys
    { password: PASSKEY_TEST_PASSWORD, challenge, credential: registrationPayload(key, challenge), extra: true },
    { password: PASSKEY_TEST_PASSWORD, challenge: 'short', credential: registrationPayload(key, challenge) },
  ]) {
    const reply = await request('/registration/finish', malformed);
    assert.equal(reply.status, 400, JSON.stringify(malformed).slice(0, 60));
    // Rejected at the boundary (INVALID_BODY) or fail-closed in the service (INVALID_INPUT); both are 400s.
    assert.match(errorCode(reply), /^INVALID_(BODY|INPUT)$/);
  }
  setLimited(true);
  const limited = await request('', undefined);
  assert.equal(limited.status, 429);
  assert.equal(errorCode(limited), 'RATE_LIMITED');
});

test('service error codes map to the wire without leaking internals, composed handler included', async (t) => {
  const { db, request } = await endpoint(t, { composed: true });
  const rejected = await request('/assertion/start', {
    password: PASSKEY_TEST_PASSWORD,
    credentialId: simulatePasskey().credentialId,
  });
  assert.equal(rejected.status, 404);
  assert.equal(errorCode(rejected), 'PASSKEY_NOT_FOUND');
  db.failTag = 'current';
  const unavailable = await request('', undefined);
  assert.equal(unavailable.status, 503);
  assert.equal(errorCode(unavailable), 'UNAVAILABLE');
  assert.equal(JSON.stringify(unavailable.json).includes('synthetic'), false);
});

test('absent deployment closes mutations with the deployment-unavailable marker, never a synthetic list', async (t) => {
  const { proof, request } = await endpoint(t, { deployment: 'absent' });
  const list = await request('', undefined);
  assert.equal(list.status, 503);
  assert.equal(errorCode(list), 'UNAVAILABLE');
  const error = list.json.error;
  assert.ok(record(error));
  assert.equal(error.availability, 'deployment-unavailable-v1');
  const start = await request('/registration/start', { password: PASSKEY_TEST_PASSWORD });
  assert.equal(start.status, 503);
  assert.equal(errorCode(start), 'UNAVAILABLE');
  const unknown = await request(
    '/registration/start',
    { password: PASSKEY_TEST_PASSWORD },
    { ...proof, sessionToken: `${proof.sessionToken.slice(1)}x` },
  );
  assert.equal(unknown.status, 401);
});
