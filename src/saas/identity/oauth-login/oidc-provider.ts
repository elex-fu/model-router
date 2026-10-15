import {
  type OAuthFetch,
  type OAuthIdentity,
  type OAuthLoginProvider,
  type OAuthProviderClient,
  type OAuthSecretSource,
  type OidcLoginProviderConfig,
  oauthLoginFail,
} from './types.js';

const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
const MAX_SUBJECT_LENGTH = 512;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userinfoEndpoint: string;
}

export interface OidcProviderDeps {
  readonly fetch: OAuthFetch;
  readonly now?: () => number;
}

function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 2048) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  }
  void field;
  return parsed.toString();
}

function normalizeIssuerUrl(issuerUrl: string): string {
  if (typeof issuerUrl !== 'string' || issuerUrl.length > 2048) oauthLoginFail(400, 'INVALID_INPUT');
  let parsed: URL;
  try {
    parsed = new URL(issuerUrl);
  } catch {
    return oauthLoginFail(400, 'INVALID_INPUT');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }
  // OIDC discovery appends the well-known path to the issuer as published.
  return parsed.toString().replace(/\/+$/, '');
}

/** Resolve the provider secret by environment name at call time (rotation-safe). */
export function resolveOauthSecret(source: OAuthSecretSource): string {
  if (
    !source ||
    source.type !== 'env' ||
    typeof source.name !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source.name)
  ) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }
  const value = process.env[source.name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  }
  return value;
}

async function readJsonObject(response: {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  if (!response.ok) oauthLoginFail(401, 'PROVIDER_REJECTED');
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
  return value as Record<string, unknown>;
}

/** Standard OIDC code flow: discovery document, authorize URL, code exchange, userinfo. */
export function createOidcProvider(config: OidcLoginProviderConfig, deps: OidcProviderDeps): OAuthProviderClient {
  if (!config || typeof config.clientId !== 'string' || !config.clientId || config.clientId.length > 256) {
    oauthLoginFail(400, 'INVALID_INPUT');
  }
  const issuer = normalizeIssuerUrl(config.issuerUrl);
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const cache = new Map<string, { document: OidcDiscoveryDocument; expiresAt: number }>();
  const now = deps.now ?? Date.now;

  async function discover(): Promise<OidcDiscoveryDocument> {
    const cached = cache.get(discoveryUrl);
    if (cached && cached.expiresAt > now()) return cached.document;
    let response: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      response = await deps.fetch(discoveryUrl, { method: 'GET', headers: { accept: 'application/json' } });
    } catch {
      return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    }
    const document = await readJsonObject(response);
    // OIDC core: the discovery issuer must equal the configured issuer.
    if (document.issuer !== issuer) oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    const parsed: OidcDiscoveryDocument = {
      issuer,
      authorizationEndpoint: httpsUrl(document.authorization_endpoint, 'authorization_endpoint'),
      tokenEndpoint: httpsUrl(document.token_endpoint, 'token_endpoint'),
      userinfoEndpoint: httpsUrl(document.userinfo_endpoint, 'userinfo_endpoint'),
    };
    cache.set(discoveryUrl, { document: parsed, expiresAt: now() + DISCOVERY_CACHE_TTL_MS });
    return parsed;
  }

  async function exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthIdentity> {
    const document = await discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: config.clientId,
      client_secret: resolveOauthSecret(config.clientSecretSource),
    });
    let tokenResponse: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      tokenResponse = await deps.fetch(document.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      });
    } catch {
      return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    }
    const tokens = await readJsonObject(tokenResponse);
    const accessToken = tokens.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 4096) {
      oauthLoginFail(401, 'PROVIDER_REJECTED');
    }

    let userinfoResponse: { ok: boolean; status: number; json(): Promise<unknown> };
    try {
      userinfoResponse = await deps.fetch(document.userinfoEndpoint, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
    } catch {
      return oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    }
    const userinfo = await readJsonObject(userinfoResponse);
    const subject = userinfo.sub;
    if (typeof subject !== 'string' || subject.length === 0 || subject.length > MAX_SUBJECT_LENGTH) {
      oauthLoginFail(503, 'PROVIDER_UNAVAILABLE');
    }
    // An unverified provider email must never drive the adoption decision.
    const email =
      typeof userinfo.email === 'string' &&
      userinfo.email_verified !== false &&
      userinfo.email.length <= 254 &&
      EMAIL_PATTERN.test(userinfo.email)
        ? userinfo.email.trim().toLowerCase()
        : undefined;
    const name =
      typeof userinfo.name === 'string' && userinfo.name.trim().length > 0 && userinfo.name.trim().length <= 120
        ? userinfo.name.trim()
        : undefined;
    return {
      providerType: 'oidc',
      providerSubject: subject,
      ...(email === undefined ? {} : { email }),
      ...(name === undefined ? {} : { displayName: name }),
    };
  }

  return {
    providerType: 'oidc' satisfies OAuthLoginProvider,
    async authorizeUrl(input): Promise<string> {
      const document = await discover();
      const url = new URL(document.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', input.state);
      return url.toString();
    },
    exchangeCode,
  };
}
