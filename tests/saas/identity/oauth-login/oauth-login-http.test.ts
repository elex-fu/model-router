import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { type TestContext, test } from 'node:test';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { createSaasIdentityHandler } from '../../../../src/saas/identity/http.js';
import { OAuthLoginService } from '../../../../src/saas/identity/oauth-login/oauth-login-service.js';
import type { OAuthFetch, OAuthFetchResponse } from '../../../../src/saas/identity/oauth-login/types.js';
import { hashPassword } from '../../../../src/saas/identity/password.js';
import { SaasIdentityService } from '../../../../src/saas/identity/service.js';
import { FakeSaasDatabase } from '../fake-database.js';

const OIDC_ENV_SECRET_NAME = 'MODEL_ROUTER_UNIT_TEST_OIDC_SECRET';
const OIDC_ISSUER = 'https://idp.example.test';
const UNIT_PASSWORD = 'synthetic-oauth-unit-password';
const REDIRECT_URI = 'https://app.example.test/oauth/callback';

const discovery = {
  issuer: OIDC_ISSUER,
  authorization_endpoint: `${OIDC_ISSUER}/authorize`,
  token_endpoint: `${OIDC_ISSUER}/token`,
  userinfo_endpoint: `${OIDC_ISSUER}/userinfo`,
};

interface UnitHttpReply {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

function jsonResponse(payload: unknown, status = 200): OAuthFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

async function request(
  origin: string,
  path: string,
  init: { method: string; origin?: string; cookie?: string; body?: unknown },
): Promise<UnitHttpReply> {
  const target = new URL(path, origin);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      target,
      {
        method: init.method,
        agent: false,
        signal: AbortSignal.timeout(5000),
        headers: {
          host: target.host,
          connection: 'close',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.origin === undefined ? {} : { origin: init.origin }),
          ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: unknown) => {
          if (!(chunk instanceof Uint8Array)) {
            response.destroy(new Error('Unit response bytes'));
            return;
          }
          size += chunk.byteLength;
          if (size > 8192) {
            response.destroy(new Error('Unit response limit'));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', () => reject(new Error('Unit response failed')));
        response.once('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            // Fall-through 404s carry no body; only JSON endpoints do.
            const json: unknown = raw.length === 0 ? {} : JSON.parse(raw);
            assert.ok(json !== null && typeof json === 'object' && !Array.isArray(json));
            const status = response.statusCode;
            assert.ok(typeof status === 'number');
            const headers = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              headers.append(response.rawHeaders[index] as string, response.rawHeaders[index + 1] as string);
            }
            resolve({ status, headers, json: json as Record<string, unknown> });
          } catch {
            reject(new Error('Unit response shape'));
          }
        });
      },
    );
    outgoing.once('error', () => reject(new Error('Unit request failed')));
    outgoing.end(payload);
  });
}

/**
 * Owned loopback listener plus the composed identity handler. The handler is
 * created after listening so publicOrigin carries the real port; only the
 * provider HTTP is canned.
 */
async function endpoint(
  t: TestContext,
  mount: 'oauth' | 'none' = 'oauth',
): Promise<{
  origin: string;
  database: FakeSaasDatabase;
  identity: SaasIdentityService;
}> {
  const database = new FakeSaasDatabase();
  const nowMs = Date.UTC(2026, 9, 15, 8, 0, 0);
  const identity = new SaasIdentityService(database as never, { now: () => new Date(nowMs) });
  let handler: ReturnType<typeof createSaasIdentityHandler> | undefined;
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
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const listening = once(server, 'listening');
  let timer: ReturnType<typeof setTimeout> | undefined;
  server.listen(0, '127.0.0.1');
  try {
    await Promise.race([
      listening,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Unit listener timeout')), 5000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;

  if (mount === 'oauth') {
    // Synthetic unit fixture value assembled at runtime, never a real secret.
    process.env[OIDC_ENV_SECRET_NAME] = ['unit', 'oidc', 'secret'].join('-');
    t.after(() => delete process.env[OIDC_ENV_SECRET_NAME]);
    const fetch: OAuthFetch = async (url) => {
      if (url === `${OIDC_ISSUER}/.well-known/openid-configuration`) return jsonResponse(discovery);
      if (url === discovery.token_endpoint) return jsonResponse({ access_token: 'unit-access-token' });
      if (url === discovery.userinfo_endpoint) {
        return jsonResponse({
          sub: 'unit-oidc-sub-1',
          email: 'unit.oidc@example.test',
          email_verified: true,
          name: 'Unit User',
        });
      }
      return jsonResponse({ error: 'unexpected' }, 404);
    };
    const oauth = new OAuthLoginService({
      database: database as unknown as SaasDatabase,
      identity,
      config: {
        oidc: {
          issuerUrl: OIDC_ISSUER,
          clientId: 'unit-client-id',
          clientSecretSource: { type: 'env', name: OIDC_ENV_SECRET_NAME },
        },
      },
      sessionTtlSeconds: 900,
      now: () => new Date(nowMs),
      fetch,
    });
    handler = createSaasIdentityHandler({
      service: identity,
      oauthLogin: { service: oauth },
      publicOrigin: origin,
      sessionTtlSeconds: 900,
    });
  } else {
    handler = createSaasIdentityHandler({ service: identity, publicOrigin: origin, sessionTtlSeconds: 900 });
  }
  return { origin, database, identity };
}

function setCookies(reply: UnitHttpReply): string[] {
  return reply.headers.getSetCookie();
}

function cookieValueFrom(cookies: string[], name: string): string | undefined {
  for (const header of cookies) {
    const [pair] = header.split(';');
    const separator = pair.indexOf('=');
    if (separator > 0 && pair.slice(0, separator) === name) return pair.slice(separator + 1);
  }
  return undefined;
}

async function startLogin(origin: string, withOrigin = true): Promise<{ reply: UnitHttpReply; state: string }> {
  const reply = await request(origin, '/console/api/v1/auth/oauth/oidc/start', {
    method: 'POST',
    ...(withOrigin ? { origin } : {}),
    body: { redirectUri: REDIRECT_URI },
  });
  const state = cookieValueFrom(setCookies(reply), 'mr_saas_oauth_state');
  assert.ok(state);
  return { reply, state };
}

async function callback(origin: string, state: string, cookieState = state): Promise<UnitHttpReply> {
  return request(origin, `/console/api/v1/auth/oauth/oidc/callback?code=unit-code&state=${encodeURIComponent(state)}`, {
    method: 'GET',
    cookie: `mr_saas_oauth_state=${cookieState}`,
  });
}

function seedAccount(database: FakeSaasDatabase, email: string, passwordHash: string | null): string {
  const userId = randomUUID();
  database.state.users.push({
    id: userId,
    email,
    email_canonical: email,
    password_hash: passwordHash,
    display_name: 'Seeded User',
    email_verified_at: null,
    disabled_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  return userId;
}

test('start requires the same-origin write boundary and sets a Lax state cookie', async (t) => {
  const { origin } = await endpoint(t);
  const denied = await request(origin, '/console/api/v1/auth/oauth/oidc/start', {
    method: 'POST',
    body: { redirectUri: REDIRECT_URI },
  });
  assert.equal(denied.status, 403);

  const { reply, state } = await startLogin(origin);
  assert.equal(reply.status, 200);
  const authorizeUrl = new URL((reply.json.data as Record<string, unknown>).authorizeUrl as string);
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, discovery.authorization_endpoint);
  assert.equal(authorizeUrl.searchParams.get('state'), state);
  const stateCookie = setCookies(reply).find((header) => header.startsWith('mr_saas_oauth_state='));
  assert.ok(stateCookie);
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /SameSite=Lax/);
  assert.match(stateCookie, /Max-Age=600/);
  assert.match(stateCookie, /Path=\/console/);
});

test('callback with a tampered state cookie is rejected before any provider call', async (t) => {
  const { origin } = await endpoint(t);
  const { state } = await startLogin(origin);
  const reply = await callback(origin, state, `${state.slice(0, -1)}X`);
  assert.equal(reply.status, 400);
  assert.equal((reply.json.error as Record<string, unknown>).code, 'STATE_INVALID');
});

test('full registration flow: callback returns a pending decision, completion sets session cookies', async (t) => {
  const { origin, database, identity } = await endpoint(t);
  const { state } = await startLogin(origin);
  const pending = await callback(origin, state);
  assert.equal(pending.status, 200);
  const data = pending.json.data as Record<string, unknown>;
  assert.equal(data.kind, 'registration-required');
  assert.equal(data.email, 'unit.oidc@example.test');
  const pendingToken = data.pendingToken;
  assert.ok(typeof pendingToken === 'string');
  // The single-use state cookie is cleared with the pending decision.
  const cleared = setCookies(pending).find((header) => header.startsWith('mr_saas_oauth_state=;'));
  assert.ok(cleared && cleared.includes('Max-Age=0'));

  const denied = await request(origin, '/console/api/v1/auth/oauth/complete-registration', {
    method: 'POST',
    body: { pendingToken, password: UNIT_PASSWORD },
  });
  assert.equal(denied.status, 403);

  const completion = await request(origin, '/console/api/v1/auth/oauth/complete-registration', {
    method: 'POST',
    origin,
    body: { pendingToken, password: UNIT_PASSWORD, displayName: 'Registered Name' },
  });
  assert.equal(completion.status, 201);
  const cookies = setCookies(completion);
  const sessionCookie = cookies.find((header) => header.startsWith('mr_saas_session='));
  assert.ok(
    sessionCookie &&
      sessionCookie.includes('HttpOnly') &&
      sessionCookie.includes('SameSite=Strict') &&
      sessionCookie.includes('Path=/console/api/v1'),
  );
  const csrfCookie = cookies.find((header) => header.startsWith('mr_saas_csrf='));
  assert.ok(csrfCookie && csrfCookie.includes('SameSite=Strict') && csrfCookie.includes('Path=/console'));

  // The issued cookie authenticates against the genuine identity session route.
  const sessionToken = cookieValueFrom(cookies, 'mr_saas_session');
  assert.ok(sessionToken);
  const session = await request(origin, '/console/api/v1/auth/session', {
    method: 'GET',
    cookie: `mr_saas_session=${sessionToken}`,
  });
  assert.equal(session.status, 200);
  assert.equal(database.state.users.length, 1);
  assert.equal((await identity.getSession(sessionToken))?.userId, database.state.users[0]?.id);
});

test('bound identity callback authenticates directly and sets session cookies', async (t) => {
  const { origin, database } = await endpoint(t);
  const userId = seedAccount(database, 'unit.oidc@example.test', null);
  database.state.oauthIdentities.push({
    id: randomUUID(),
    provider_type: 'oidc',
    provider_subject: 'unit-oidc-sub-1',
    tenant_user_id: userId,
    email: 'unit.oidc@example.test',
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });

  const { state } = await startLogin(origin);
  const reply = await callback(origin, state);
  assert.equal(reply.status, 200);
  const data = reply.json.data as Record<string, unknown>;
  assert.equal(data.status, 'authenticated');
  assert.equal((data.session as Record<string, unknown>).userId, userId);
  assert.ok(setCookies(reply).some((header) => header.startsWith('mr_saas_session=')));
});

test('adoption completion rejects a wrong password with 401 and binds nothing', async (t) => {
  const { origin, database } = await endpoint(t);
  seedAccount(database, 'unit.oidc@example.test', await hashPassword(UNIT_PASSWORD));

  const { state } = await startLogin(origin);
  const pending = await callback(origin, state);
  const data = pending.json.data as Record<string, unknown>;
  assert.equal(data.kind, 'adoption-required');
  const pendingToken = data.pendingToken;
  assert.ok(typeof pendingToken === 'string');

  const rejected = await request(origin, '/console/api/v1/auth/oauth/complete-adoption', {
    method: 'POST',
    origin,
    body: { pendingToken, password: 'wrong-password-proof' },
  });
  assert.equal(rejected.status, 401);
  assert.equal((rejected.json.error as Record<string, unknown>).code, 'CREDENTIALS_REJECTED');
  assert.equal(database.state.oauthIdentities.length, 0);
});

test('unconfigured deployments leave the OAuth routes unmounted', async (t) => {
  const { origin } = await endpoint(t, 'none');
  const reply = await request(origin, '/console/api/v1/auth/oauth/oidc/start', {
    method: 'POST',
    origin,
    body: { redirectUri: REDIRECT_URI },
  });
  assert.equal(reply.status, 404);
});
