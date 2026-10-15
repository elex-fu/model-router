import type { SafeSession } from '../types.js';

/** Social login providers supported by the sub2api parity Phase 2 surface. */
export type OAuthLoginProvider = 'oidc' | 'wechat';

/**
 * A provider-resolved external identity. `providerSubject` is the provider's
 * stable account id (OIDC `sub`, WeChat `openid`) — never a display name or
 * an access token — and is the durable half of the binding key.
 */
export interface OAuthIdentity {
  readonly providerType: OAuthLoginProvider;
  readonly providerSubject: string;
  readonly email?: string;
  readonly displayName?: string;
}

/**
 * Secret reference for provider credentials. The identity module has no
 * secret store, so (mirroring the platform config's `type: 'env'` source)
 * secrets are referenced by environment variable name and resolved at call
 * time. Values are never embedded in configuration or source.
 */
export interface OAuthSecretSource {
  readonly type: 'env';
  readonly name: string;
}

export interface OidcLoginProviderConfig {
  /** Base issuer URL without a trailing slash; `/.well-known/openid-configuration` is appended. */
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecretSource: OAuthSecretSource;
}

export interface WechatLoginProviderConfig {
  /** WeChat Open Platform (open.weixin.qq.com) app id. */
  readonly appId: string;
  readonly appSecretSource: OAuthSecretSource;
}

export interface OAuthLoginConfig {
  readonly oidc?: OidcLoginProviderConfig;
  readonly wechat?: WechatLoginProviderConfig;
}

/** Minimal fetch seam so tests inject canned provider responses. */
export type OAuthFetch = (url: string, init?: OAuthFetchRequestInit) => Promise<OAuthFetchResponse>;

export interface OAuthFetchRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface OAuthFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/** Provider seam consumed by the login service; one client per provider. */
export interface OAuthProviderClient {
  readonly providerType: OAuthLoginProvider;
  authorizeUrl(input: { readonly redirectUri: string; readonly state: string }): Promise<string>;
  exchangeCode(input: { readonly code: string; readonly redirectUri: string }): Promise<OAuthIdentity>;
}

export interface OAuthLoginStart {
  readonly authorizeUrl: string;
  readonly state: string;
}

/** Result of exchanging an authorization code: either a session or a pending decision. */
export type OAuthLoginCompletion =
  | {
      readonly kind: 'authenticated';
      readonly token: string;
      readonly csrfToken: string;
      readonly session: SafeSession;
    }
  | { readonly kind: 'adoption-required'; readonly pendingToken: string; readonly email: string }
  | { readonly kind: 'registration-required'; readonly pendingToken: string; readonly email?: string };

export interface OAuthRegistrationInput {
  readonly password: string;
  readonly displayName?: string;
}

export interface OAuthAdoptionInput {
  readonly password: string;
}

/** Session material issued on successful login, registration, or adoption. */
export interface OAuthLoginSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly session: SafeSession;
}

/**
 * Identity capabilities injected into the OAuth login service. Implemented
 * additively by SaasIdentityService; injection keeps the OAuth service
 * independent of the identity service internals and fakeable in tests.
 * No password hashes leave this boundary.
 */
export interface OAuthIdentityDirectory {
  /** Active-account email probe used for the adoption decision. */
  findUserAccountByEmail(email: string): Promise<{ readonly userId: string } | undefined>;
  /** Password proof for adoption; undefined for unknown/disabled/wrong password. */
  verifyAccountPasswordByEmail(email: string, password: string): Promise<{ readonly userId: string } | undefined>;
  /** Session issuance for an already-authenticated active user. */
  issueSessionForUser(userId: string, ttlSeconds: number): Promise<OAuthLoginSession | undefined>;
}

export type OAuthLoginErrorCode =
  | 'INVALID_INPUT'
  | 'PROVIDER_UNKNOWN'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'STATE_INVALID'
  | 'PENDING_INVALID'
  | 'CREDENTIALS_REJECTED'
  | 'EMAIL_ALREADY_EXISTS'
  | 'IDENTITY_CONFLICT'
  | 'UNAVAILABLE';

const safeMessages: Record<OAuthLoginErrorCode, string> = {
  INVALID_INPUT: 'The OAuth login request contains invalid data.',
  PROVIDER_UNKNOWN: 'The requested OAuth provider is not configured.',
  PROVIDER_UNAVAILABLE: 'The OAuth provider is temporarily unavailable.',
  PROVIDER_REJECTED: 'The OAuth provider rejected the authorization code.',
  STATE_INVALID: 'The OAuth login state is invalid or expired.',
  PENDING_INVALID: 'The pending OAuth login is invalid or expired.',
  CREDENTIALS_REJECTED: 'Email or password is incorrect.',
  EMAIL_ALREADY_EXISTS: 'An account already exists for this email address.',
  IDENTITY_CONFLICT: 'This provider identity is already bound to an account.',
  UNAVAILABLE: 'The login service could not complete the request.',
};

export class OAuthLoginError extends Error {
  readonly status: number;
  readonly code: OAuthLoginErrorCode;

  constructor(status: number, code: OAuthLoginErrorCode) {
    super(safeMessages[code]);
    this.name = 'OAuthLoginError';
    this.status = status;
    this.code = code;
  }
}

export function oauthLoginFail(status: number, code: OAuthLoginErrorCode): never {
  throw new OAuthLoginError(status, code);
}
