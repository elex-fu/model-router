import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { SaasDatabase } from '../../../../src/saas/db/types.js';
import { OAuthLoginService } from '../../../../src/saas/identity/oauth-login/oauth-login-service.js';
import {
  type OAuthFetch,
  type OAuthFetchResponse,
  OAuthLoginError,
} from '../../../../src/saas/identity/oauth-login/types.js';
import { hashPassword } from '../../../../src/saas/identity/password.js';
import { SaasIdentityService } from '../../../../src/saas/identity/service.js';
import { FakeSaasDatabase } from '../fake-database.js';

const OIDC_ENV_SECRET_NAME = 'MODEL_ROUTER_UNIT_TEST_OIDC_SECRET';
const WECHAT_ENV_SECRET_NAME = 'MODEL_ROUTER_UNIT_TEST_WECHAT_SECRET';
const OIDC_ISSUER = 'https://idp.example.test';
const UNIT_PASSWORD = 'synthetic-oauth-unit-password';

const discovery = {
  issuer: OIDC_ISSUER,
  authorization_endpoint: `${OIDC_ISSUER}/authorize`,
  token_endpoint: `${OIDC_ISSUER}/token`,
  userinfo_endpoint: `${OIDC_ISSUER}/userinfo`,
};

function jsonResponse(payload: unknown, status = 200): OAuthFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function wechatOpenid(index: number): string {
  return `unit-openid-${index}-abcdef0123456789`;
}

/**
 * Unit fixtures wire the OAuth service to the shared fake database and a real
 * SaasIdentityService; only provider HTTP is canned. Password hashing and
 * session issuance run the genuine implementations.
 */
function fixture() {
  const database = new FakeSaasDatabase();
  let nowMs = Date.UTC(2026, 9, 15, 8, 0, 0);
  const now = () => new Date(nowMs);
  const identity = new SaasIdentityService(database as never, { now });

  let oidcSubject = 'unit-oidc-sub-1';
  let oidcEmail = 'unit.oidc@example.test';
  const fetch: OAuthFetch = async (url) => {
    if (url === `${OIDC_ISSUER}/.well-known/openid-configuration`) return jsonResponse(discovery);
    if (url === discovery.token_endpoint) return jsonResponse({ access_token: 'unit-access-token' });
    if (url === discovery.userinfo_endpoint) {
      return jsonResponse({ sub: oidcSubject, email: oidcEmail, email_verified: true, name: 'Unit OIDC User' });
    }
    if (url.startsWith('https://api.weixin.qq.com/sns/oauth2/access_token')) {
      return jsonResponse({ access_token: 'unit-wx-token', openid: wechatOpenid(0) });
    }
    if (url.startsWith('https://api.weixin.qq.com/sns/userinfo')) {
      return jsonResponse({ openid: wechatOpenid(0), nickname: 'Unit WeChat User' });
    }
    return jsonResponse({ error: 'unexpected unit fetch' }, 404);
  };

  const service = new OAuthLoginService({
    database: database as unknown as SaasDatabase,
    identity,
    config: {
      oidc: {
        issuerUrl: OIDC_ISSUER,
        clientId: 'unit-client-id',
        clientSecretSource: { type: 'env', name: OIDC_ENV_SECRET_NAME },
      },
      wechat: { appId: 'unit-wx-appid', appSecretSource: { type: 'env', name: WECHAT_ENV_SECRET_NAME } },
    },
    sessionTtlSeconds: 900,
    now,
    fetch,
  });

  return {
    database,
    identity,
    service,
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
    setOidcIdentity: (subject: string, email: string) => {
      oidcSubject = subject;
      oidcEmail = email;
    },
  };
}

/** Seed an account row directly, the way the fake database already stores users. */
async function seedUser(database: FakeSaasDatabase, email: string, password = UNIT_PASSWORD): Promise<string> {
  const userId = randomUUID();
  database.state.users.push({
    id: userId,
    email,
    email_canonical: email.trim().toLowerCase(),
    password_hash: await hashPassword(password),
    display_name: 'Seeded User',
    email_verified_at: null,
    disabled_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
  return userId;
}

function seedBinding(
  database: FakeSaasDatabase,
  providerType: string,
  subject: string,
  userId: string,
  email: string | null,
): void {
  database.state.oauthIdentities.push({
    id: randomUUID(),
    provider_type: providerType,
    provider_subject: subject,
    tenant_user_id: userId,
    email,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  });
}

async function startAndComplete(fxt: ReturnType<typeof fixture>, provider: 'oidc' | 'wechat', code = 'unit-code') {
  const started = await fxt.service.startLogin(provider, 'https://app.example.test/oauth/callback');
  return { started, completion: await fxt.service.completeLogin(provider, { state: started.state, code }) };
}

const rejected = (code: string) => (error: unknown) => error instanceof OAuthLoginError && error.code === code;

before(() => {
  process.env[OIDC_ENV_SECRET_NAME] = ['unit', 'oidc', 'secret'].join('-');
  process.env[WECHAT_ENV_SECRET_NAME] = ['unit', 'wechat', 'secret'].join('-');
});

after(() => {
  delete process.env[OIDC_ENV_SECRET_NAME];
  delete process.env[WECHAT_ENV_SECRET_NAME];
});

test('OIDC full chain: start redirects to the discovered authorize endpoint, unknown identity routes to registration', async () => {
  const fxt = fixture();
  const started = await fxt.service.startLogin('oidc', 'https://app.example.test/oauth/callback');
  const url = new URL(started.authorizeUrl);
  assert.equal(url.origin + url.pathname, discovery.authorization_endpoint);
  assert.equal(url.searchParams.get('state'), started.state);
  assert.match(started.state, /^[A-Za-z0-9_-]{43}$/);

  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'registration-required');
  if (completion.kind !== 'registration-required') return;
  assert.equal(completion.email, 'unit.oidc@example.test');
  assert.match(completion.pendingToken, /^[A-Za-z0-9_-]{43}$/);
});

test('completeRegistration creates the user, binds the identity, and issues a working session', async () => {
  const fxt = fixture();
  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'registration-required');
  if (completion.kind !== 'registration-required') return;

  const session = await fxt.service.completeRegistration(completion.pendingToken, {
    password: UNIT_PASSWORD,
    displayName: 'Registered Name',
  });
  assert.equal(fxt.database.state.users.length, 1);
  const user = fxt.database.state.users[0];
  assert.ok(user);
  assert.equal(user.email_canonical, 'unit.oidc@example.test');
  assert.equal(user.display_name, 'Registered Name');
  assert.equal(session.session.userId, user.id);
  assert.equal(fxt.database.state.oauthIdentities.length, 1);
  assert.equal(fxt.database.state.oauthIdentities[0]?.provider_type, 'oidc');
  assert.equal(fxt.database.state.oauthIdentities[0]?.provider_subject, 'unit-oidc-sub-1');
  assert.equal(fxt.database.state.oauthIdentities[0]?.tenant_user_id, user.id);
  // The issued session is a genuine identity session.
  const resolved = await fxt.identity.getSession(session.token);
  assert.equal(resolved?.userId, user.id);
  assert.equal(await fxt.identity.verifyCsrfToken(session.token, session.csrfToken), true);
});

test('a bound identity on an active account logs straight in', async () => {
  const fxt = fixture();
  const userId = await seedUser(fxt.database, 'bound@example.test');
  seedBinding(fxt.database, 'oidc', 'unit-oidc-sub-1', userId, 'unit.oidc@example.test');

  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'authenticated');
  if (completion.kind !== 'authenticated') return;
  assert.equal(completion.session.userId, userId);
  assert.equal((await fxt.identity.getSession(completion.token))?.userId, userId);
  assert.equal(fxt.database.state.users.length, 1, 'no account is created for a bound login');
});

test('a provider email owned by an existing account requires adoption with a password proof', async () => {
  const fxt = fixture();
  await seedUser(fxt.database, 'unit.oidc@example.test');

  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'adoption-required');
  if (completion.kind !== 'adoption-required') return;
  assert.equal(completion.email, 'unit.oidc@example.test');

  await assert.rejects(
    fxt.service.completeAdoption(completion.pendingToken, { password: 'wrong-password-proof' }),
    rejected('CREDENTIALS_REJECTED'),
  );
  assert.equal(fxt.database.state.oauthIdentities.length, 0, 'a rejected proof binds nothing');

  // Pending tokens are single-use: the failed proof consumed this one, so the
  // user restarts the provider redirect for a fresh adoption decision.
  const { completion: second } = await startAndComplete(fxt, 'oidc');
  assert.equal(second.kind, 'adoption-required');
  if (second.kind !== 'adoption-required') return;
  const session = await fxt.service.completeAdoption(second.pendingToken, { password: UNIT_PASSWORD });
  const user = fxt.database.state.users[0];
  assert.ok(user);
  assert.equal(session.session.userId, user.id);
  assert.equal(fxt.database.state.oauthIdentities.length, 1);
  assert.equal(fxt.database.state.oauthIdentities[0]?.tenant_user_id, user.id);
});

test('WeChat full chain: no provider email, registration synthesizes a unique .invalid address', async () => {
  const fxt = fixture();
  const started = await fxt.service.startLogin('wechat', 'https://app.example.test/oauth/callback');
  assert.ok(started.authorizeUrl.startsWith('https://open.weixin.qq.com/connect/qrconnect?'));
  assert.ok(started.authorizeUrl.endsWith('#wechat_redirect'));

  const { completion } = await startAndComplete(fxt, 'wechat');
  assert.equal(completion.kind, 'registration-required');
  if (completion.kind !== 'registration-required') return;
  assert.equal('email' in completion, false);

  const session = await fxt.service.completeRegistration(completion.pendingToken, { password: UNIT_PASSWORD });
  const user = fxt.database.state.users[0];
  assert.ok(user);
  assert.equal(String(user.email).endsWith('@oauth.wechat.invalid'), true);
  assert.equal(user.email_verified_at, null, 'a synthesized address is never marked verified');
  assert.equal(session.session.userId, user.id);
  assert.equal(fxt.database.state.oauthIdentities[0]?.provider_subject, wechatOpenid(0));
});

test('pending tokens expire after five minutes and never replay', async () => {
  const fxt = fixture();
  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'registration-required');
  if (completion.kind !== 'registration-required') return;

  fxt.advance(5 * 60_000 + 1);
  await assert.rejects(
    fxt.service.completeRegistration(completion.pendingToken, { password: UNIT_PASSWORD }),
    rejected('PENDING_INVALID'),
  );
  assert.equal(fxt.database.state.users.length, 0);
});

test('a completed registration consumes its pending token', async () => {
  const fxt = fixture();
  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'registration-required');
  if (completion.kind !== 'registration-required') return;
  await fxt.service.completeRegistration(completion.pendingToken, { password: UNIT_PASSWORD });
  await assert.rejects(
    fxt.service.completeRegistration(completion.pendingToken, { password: UNIT_PASSWORD }),
    rejected('PENDING_INVALID'),
  );
  assert.equal(fxt.database.state.users.length, 1);
});

test('state is single-use: tampered and replayed states are rejected', async () => {
  const fxt = fixture();
  const started = await fxt.service.startLogin('oidc', 'https://app.example.test/oauth/callback');
  await assert.rejects(
    fxt.service.completeLogin('oidc', { state: `${started.state.slice(0, -1)}X`, code: 'unit-code' }),
    rejected('STATE_INVALID'),
  );
  // The tampered attempt consumed nothing; the genuine state still works once.
  const completion = await fxt.service.completeLogin('oidc', { state: started.state, code: 'unit-code' });
  assert.equal(completion.kind, 'registration-required');
  await assert.rejects(
    fxt.service.completeLogin('oidc', { state: started.state, code: 'unit-code' }),
    rejected('STATE_INVALID'),
  );
});

test('state expires after ten minutes', async () => {
  const fxt = fixture();
  const started = await fxt.service.startLogin('oidc', 'https://app.example.test/oauth/callback');
  fxt.advance(10 * 60_000 + 1);
  await assert.rejects(
    fxt.service.completeLogin('oidc', { state: started.state, code: 'unit-code' }),
    rejected('STATE_INVALID'),
  );
});

test('registration against an existing email is a conflict, never a second account', async () => {
  const clash = fixture();
  await seedUser(clash.database, 'unit.oidc@example.test');
  const { completion } = await startAndComplete(clash, 'oidc');
  assert.equal(completion.kind, 'adoption-required');
  if (completion.kind !== 'adoption-required') return;
  // The user may prefer to register a fresh account instead of adopting, but
  // the provider email is already owned: the saas_users unique constraint is
  // the backstop and no second account is created.
  await assert.rejects(
    clash.service.completeRegistration(completion.pendingToken, { password: UNIT_PASSWORD }),
    rejected('EMAIL_ALREADY_EXISTS'),
  );
  assert.equal(clash.database.state.users.length, 1);
});

test('an already-bound provider subject cannot be re-bound through registration', async () => {
  const fxt = fixture();
  const owner = await seedUser(fxt.database, 'owner@example.test');
  fxt.setOidcIdentity('unit-oidc-sub-1', 'fresh-email@example.test');

  // The subject is unbound at decision time, so the flow routes to
  // registration; a concurrent completion binds it before this user finishes.
  const { completion } = await startAndComplete(fxt, 'oidc');
  assert.equal(completion.kind, 'registration-required');
  if (completion.kind !== 'registration-required') return;
  seedBinding(fxt.database, 'oidc', 'unit-oidc-sub-1', owner, 'owner@example.test');

  await assert.rejects(
    fxt.service.completeRegistration(completion.pendingToken, { password: UNIT_PASSWORD }),
    rejected('IDENTITY_CONFLICT'),
  );
  assert.equal(fxt.database.state.users.length, 1, 'the conflicting user insert rolled back with the transaction');
  assert.equal(fxt.database.state.oauthIdentities.length, 1, 'the original binding is untouched');
  assert.equal(fxt.database.state.oauthIdentities[0]?.tenant_user_id, owner);
});

test('unconfigured providers and malformed input are rejected before any provider call', async () => {
  const fxt = fixture();
  await assert.rejects(
    fxt.service.startLogin('github' as 'oidc', 'https://app.example.test/cb'),
    rejected('PROVIDER_UNKNOWN'),
  );
  await assert.rejects(fxt.service.startLogin('oidc', 'javascript:alert(1)'), rejected('INVALID_INPUT'));
  await assert.rejects(
    fxt.service.completeLogin('oidc', { state: 'short', code: 'unit-code' }),
    rejected('INVALID_INPUT'),
  );
  const weakPassword = 'short';
  await assert.rejects(
    fxt.service.completeRegistration('x'.repeat(43), { password: weakPassword }),
    rejected('PENDING_INVALID'),
  );
});
