import { resolveOauthSecret } from './oidc-provider.js';
import {
  type OAuthFetch,
  type OAuthIdentity,
  type OAuthLoginProvider,
  type OAuthProviderClient,
  oauthLoginFail,
  type WechatLoginProviderConfig,
} from './types.js';

const WECHAT_AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/qrconnect';
const WECHAT_ACCESS_TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token';
const WECHAT_USERINFO_URL = 'https://api.weixin.qq.com/sns/userinfo';
const MAX_OPENID_LENGTH = 128;
const MAX_NICKNAME_LENGTH = 120;

export interface WechatProviderDeps {
  readonly fetch: OAuthFetch;
}

function wechatError(payload: Record<string, unknown>): boolean {
  // WeChat signals failures with HTTP 200 + errcode; only errcode 0 is success.
  const errcode = payload.errcode;
  return typeof errcode === 'number' && errcode !== 0;
}

async function readWechatJson(response: {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  if (!response.ok) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  return value as Record<string, unknown>;
}

/**
 * WeChat Open Platform website-login code flow (qrconnect). The identity key
 * is the per-application `openid` returned by the access-token endpoint and
 * confirmed by the userinfo call; WeChat provides no email address.
 */
export function createWechatProvider(config: WechatLoginProviderConfig, deps: WechatProviderDeps): OAuthProviderClient {
  if (!config || typeof config.appId !== 'string' || !config.appId || config.appId.length > 64) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }

  async function exchangeCode(input: { code: string }): Promise<OAuthIdentity> {
    const tokenUrl = new URL(WECHAT_ACCESS_TOKEN_URL);
    tokenUrl.searchParams.set('appid', config.appId);
    tokenUrl.searchParams.set('secret', resolveOauthSecret(config.appSecretSource));
    tokenUrl.searchParams.set('code', input.code);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    let tokenResponse: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      tokenResponse = await deps.fetch(tokenUrl.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    }
    const tokens = await readWechatJson(tokenResponse);
    if (wechatError(tokens)) oauthLoginFail(401, 'PROVIDER_REJECTED');
    const accessToken = tokens.access_token;
    const openid = tokens.openid;
    if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 4096) {
      oauthLoginFail(401, 'PROVIDER_REJECTED');
    }
    if (typeof openid !== 'string' || openid.length === 0 || openid.length > MAX_OPENID_LENGTH) {
      oauthLoginFail(401, 'PROVIDER_REJECTED');
    }

    const userinfoUrl = new URL(WECHAT_USERINFO_URL);
    userinfoUrl.searchParams.set('access_token', accessToken);
    userinfoUrl.searchParams.set('openid', openid);
    let userinfoResponse: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      userinfoResponse = await deps.fetch(userinfoUrl.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
    } catch {
      return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    }
    const userinfo = await readWechatJson(userinfoResponse);
    if (wechatError(userinfo)) oauthLoginFail(401, 'PROVIDER_REJECTED');
    // The userinfo response must confirm the token endpoint's identity key.
    if (userinfo.openid !== openid) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    const nickname =
      typeof userinfo.nickname === 'string' &&
      userinfo.nickname.trim().length > 0 &&
      userinfo.nickname.trim().length <= MAX_NICKNAME_LENGTH
        ? userinfo.nickname.trim()
        : undefined;
    return {
      providerType: 'wechat',
      providerSubject: openid,
      ...(nickname === undefined ? {} : { displayName: nickname }),
    };
  }

  return {
    providerType: 'wechat' satisfies OAuthLoginProvider,
    async authorizeUrl(input): Promise<string> {
      const url = new URL(WECHAT_AUTHORIZE_URL);
      url.searchParams.set('appid', config.appId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'snsapi_login');
      url.searchParams.set('state', input.state);
      // WeChat's documented website-login endpoint requires the fragment suffix.
      return `${url.toString()}#wechat_redirect`;
    },
    exchangeCode,
  };
}
