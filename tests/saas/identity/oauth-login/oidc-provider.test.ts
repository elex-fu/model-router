import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createOidcProvider } from '../../../../src/saas/identity/oauth-login/oidc-provider.js';
import {
  type OAuthFetch,
  type OAuthFetchRequestInit,
  type OAuthFetchResponse,
  OAuthLoginError,
} from '../../../../src/saas/identity/oauth-login/types.js';

const OIDC_ENV_SECRET_NAME = 'MODEL_ROUTER_UNIT_TEST_OIDC_SECRET';
const ISSUER = 'https://idp.example.test';

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: 'https://idp.example.test/authorize',
  token_endpoint: 'https://idp.example.test/token',
  userinfo_endpoint: 'https://idp.example.test/userinfo',
};

function jsonResponse(payload: unknown, status = 200): OAuthFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

interface FetchCall {
  url: string;
  init?: OAuthFetchRequestInit;
}

function fixture() {
  const calls: FetchCall[] = [];
  let tokenPayload: unknown = { access_token: 'unit-access-token' };
  let userinfoPayload: unknown = {
    sub: 'unit-sub-1',
    email: 'Unit@Example.test',
    email_verified: true,
    name: 'Unit User',
  };
  const fetch: OAuthFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === `${ISSUER}/.well-known/openid-configuration`) return jsonResponse(discovery);
    if (url === discovery.token_endpoint) return jsonResponse(tokenPayload);
    if (url === discovery.userinfo_endpoint) return jsonResponse(userinfoPayload);
    return jsonResponse({ error: 'not found' }, 404);
  };
  const provider = createOidcProvider(
    { issuerUrl: ISSUER, clientId: 'unit-client-id', clientSecretSource: { type: 'env', name: OIDC_ENV_SECRET_NAME } },
    { fetch, now: () => 1_000 },
  );
  return {
    calls,
    provider,
    setTokenPayload: (value: unknown) => {
      tokenPayload = value;
    },
    setUserinfoPayload: (value: unknown) => {
      userinfoPayload = value;
    },
  };
}

const rejected = (code: string) => (error: unknown) => error instanceof OAuthLoginError && error.code === code;

before(() => {
  // Synthetic unit fixture value assembled at runtime, never a real secret.
  process.env[OIDC_ENV_SECRET_NAME] = ['unit', 'oidc', 'secret'].join('-');
});

after(() => {
  delete process.env[OIDC_ENV_SECRET_NAME];
});

test('authorize URL is the discovered endpoint with the standard code-flow parameters', async () => {
  const { provider } = fixture();
  const url = new URL(
    await provider.authorizeUrl({ redirectUri: 'https://app.example.test/callback', state: 'unit-state-0123456789' }),
  );
  assert.equal(url.origin + url.pathname, discovery.authorization_endpoint);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'unit-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.example.test/callback');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('state'), 'unit-state-0123456789');
});

test('code exchange posts the form credentials and resolves sub/email/name from userinfo', async () => {
  const { calls, provider } = fixture();
  const identity = await provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/callback' });
  assert.deepEqual(identity, {
    providerType: 'oidc',
    providerSubject: 'unit-sub-1',
    email: 'unit@example.test',
    displayName: 'Unit User',
  });
  const tokenCall = calls.find((call) => call.url === discovery.token_endpoint);
  assert.ok(tokenCall?.init);
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(tokenCall.init.headers?.['content-type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(tokenCall.init.body ?? '');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'unit-code');
  assert.equal(body.get('redirect_uri'), 'https://app.example.test/callback');
  assert.equal(body.get('client_id'), 'unit-client-id');
  assert.equal(body.get('client_secret'), process.env[OIDC_ENV_SECRET_NAME]);
  const userinfoCall = calls.find((call) => call.url === discovery.userinfo_endpoint);
  assert.equal(userinfoCall?.init?.headers?.authorization, 'Bearer unit-access-token');
});

test('discovery is cached across exchanges within the TTL window', async () => {
  const { calls, provider } = fixture();
  await provider.exchangeCode({ code: 'unit-code-1', redirectUri: 'https://app.example.test/callback' });
  await provider.exchangeCode({ code: 'unit-code-2', redirectUri: 'https://app.example.test/callback' });
  assert.equal(calls.filter((call) => call.url === `${ISSUER}/.well-known/openid-configuration`).length, 1);
  assert.equal(calls.filter((call) => call.url === discovery.token_endpoint).length, 2);
});

test('an issuer mismatch in the discovery document is rejected before any redirect', async () => {
  const mismatchedFetch: OAuthFetch = async (url) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({ ...discovery, issuer: 'https://other-idp.example.test' });
    }
    return jsonResponse({}, 404);
  };
  const provider = createOidcProvider(
    { issuerUrl: ISSUER, clientId: 'unit-client-id', clientSecretSource: { type: 'env', name: OIDC_ENV_SECRET_NAME } },
    { fetch: mismatchedFetch, now: () => 1_000 },
  );
  await assert.rejects(
    provider.authorizeUrl({ redirectUri: 'https://app.example.test/callback', state: 's' }),
    rejected('PROVIDER_UNAVAILABLE'),
  );
});

test('unverified provider email is dropped so it can never drive adoption', async () => {
  const { provider, setUserinfoPayload } = fixture();
  setUserinfoPayload({ sub: 'unit-sub-1', email: 'unit@example.test', email_verified: false });
  const identity = await provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/callback' });
  assert.equal('email' in identity, false);
});

test('a missing sub, a rejected code, and a missing secret are distinct failures', async () => {
  const noSubject = fixture();
  noSubject.setUserinfoPayload({ email: 'unit@example.test' });
  await assert.rejects(
    noSubject.provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/callback' }),
    rejected('PROVIDER_UNAVAILABLE'),
  );

  const rejectedCode = fixture();
  rejectedCode.setTokenPayload({ error: 'invalid_grant' });
  await assert.rejects(
    rejectedCode.provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/callback' }),
    rejected('PROVIDER_REJECTED'),
  );

  const missingSecret = createOidcProvider(
    {
      issuerUrl: ISSUER,
      clientId: 'unit-client-id',
      clientSecretSource: { type: 'env', name: 'MODEL_ROUTER_UNIT_TEST_OIDC_MISSING' },
    },
    { fetch: async () => jsonResponse(discovery), now: () => 1_000 },
  );
  await assert.rejects(
    missingSecret.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/callback' }),
    rejected('PROVIDER_UNAVAILABLE'),
  );
});

test('a network failure reaching the provider is unavailable, not a rejection', async () => {
  const provider = createOidcProvider(
    { issuerUrl: ISSUER, clientId: 'unit-client-id', clientSecretSource: { type: 'env', name: OIDC_ENV_SECRET_NAME } },
    {
      fetch: async () => {
        throw new Error('synthetic provider outage detail');
      },
      now: () => 1_000,
    },
  );
  await assert.rejects(
    provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/callback' }),
    rejected('PROVIDER_UNAVAILABLE'),
  );
});
