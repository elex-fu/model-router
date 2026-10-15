import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  type OAuthFetch,
  type OAuthFetchResponse,
  OAuthLoginError,
} from '../../../../src/saas/identity/oauth-login/types.js';
import { createWechatProvider } from '../../../../src/saas/identity/oauth-login/wechat-provider.js';

const WECHAT_ENV_SECRET_NAME = 'MODEL_ROUTER_UNIT_TEST_WECHAT_SECRET';
const OPENID = 'unit-openid-abcdef0123456789';

function jsonResponse(payload: unknown, status = 200): OAuthFetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function fixture() {
  const urls: string[] = [];
  let tokenPayload: unknown = { access_token: 'unit-access-token', openid: OPENID, expires_in: 7200 };
  let userinfoPayload: unknown = { openid: OPENID, nickname: 'Unit Nickname' };
  const fetch: OAuthFetch = async (url) => {
    urls.push(url);
    if (url.startsWith('https://api.weixin.qq.com/sns/oauth2/access_token')) return jsonResponse(tokenPayload);
    if (url.startsWith('https://api.weixin.qq.com/sns/userinfo')) return jsonResponse(userinfoPayload);
    return jsonResponse({ errcode: -1 }, 404);
  };
  const provider = createWechatProvider(
    { appId: 'unit-wx-appid', appSecretSource: { type: 'env', name: WECHAT_ENV_SECRET_NAME } },
    { fetch },
  );
  return {
    urls,
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
  process.env[WECHAT_ENV_SECRET_NAME] = ['unit', 'wechat', 'secret'].join('-');
});

after(() => {
  delete process.env[WECHAT_ENV_SECRET_NAME];
});

test('authorize URL is the qrconnect endpoint with scope snsapi_login and the redirect fragment', async () => {
  const { provider } = fixture();
  const url = await provider.authorizeUrl({
    redirectUri: 'https://app.example.test/wechat/callback',
    state: 'unit-state-1234',
  });
  assert.equal(url.endsWith('#wechat_redirect'), true);
  const parsed = new URL(url.slice(0, -'#wechat_redirect'.length));
  assert.equal(parsed.origin + parsed.pathname, 'https://open.weixin.qq.com/connect/qrconnect');
  assert.equal(parsed.searchParams.get('appid'), 'unit-wx-appid');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'https://app.example.test/wechat/callback');
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('scope'), 'snsapi_login');
  assert.equal(parsed.searchParams.get('state'), 'unit-state-1234');
});

test('code exchange resolves the openid identity key with the nickname', async () => {
  const { urls, provider } = fixture();
  const identity = await provider.exchangeCode({
    code: 'unit-code',
    redirectUri: 'https://app.example.test/wechat/callback',
  });
  assert.deepEqual(identity, { providerType: 'wechat', providerSubject: OPENID, displayName: 'Unit Nickname' });
  const tokenUrl = urls.find((url) => url.includes('/sns/oauth2/access_token'));
  assert.ok(tokenUrl);
  const parsed = new URL(tokenUrl);
  assert.equal(parsed.searchParams.get('appid'), 'unit-wx-appid');
  assert.equal(parsed.searchParams.get('secret'), process.env[WECHAT_ENV_SECRET_NAME]);
  assert.equal(parsed.searchParams.get('code'), 'unit-code');
  assert.equal(parsed.searchParams.get('grant_type'), 'authorization_code');
  const userinfoUrl = urls.find((url) => url.includes('/sns/userinfo'));
  assert.ok(userinfoUrl);
  const userinfo = new URL(userinfoUrl);
  assert.equal(userinfo.searchParams.get('access_token'), 'unit-access-token');
  assert.equal(userinfo.searchParams.get('openid'), OPENID);
});

test('a WeChat errcode rejects the code instead of surfacing provider detail', async () => {
  const { provider, setTokenPayload } = fixture();
  setTokenPayload({ errcode: 40029, errmsg: 'invalid code' });
  await assert.rejects(
    provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/cb' }),
    rejected('PROVIDER_REJECTED'),
  );
});

test('a userinfo openid that contradicts the token endpoint is unavailable', async () => {
  const { provider, setUserinfoPayload } = fixture();
  setUserinfoPayload({ openid: 'different-openid-value', nickname: 'Mismatch' });
  await assert.rejects(
    provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/cb' }),
    rejected('PROVIDER_UNAVAILABLE'),
  );
});

test('a missing env secret is unavailable before any provider call', async () => {
  const urls: string[] = [];
  const provider = createWechatProvider(
    { appId: 'unit-wx-appid', appSecretSource: { type: 'env', name: 'MODEL_ROUTER_UNIT_TEST_WECHAT_MISSING' } },
    {
      fetch: async (url) => {
        urls.push(url);
        return jsonResponse({});
      },
    },
  );
  await assert.rejects(
    provider.exchangeCode({ code: 'unit-code', redirectUri: 'https://app.example.test/cb' }),
    rejected('PROVIDER_UNAVAILABLE'),
  );
  assert.equal(urls.length, 0);
});
