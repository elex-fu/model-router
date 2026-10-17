import { createHash, timingSafeEqual } from 'node:crypto';
import {
  buildPkceAuthorizeUrl,
  type PkceAuthorizeUrlInput,
  type PkceError,
  createPkcePair as sharedCreatePkcePair,
  decodeIdTokenPayload as sharedDecodeIdTokenPayload,
} from '../../gateway/oauth-subscription/pkce.js';

/**
 * Batch-3 Grok OAuth constants and pure claim helpers (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三 Grok; port of sub2api's
 * backend/internal/pkg/xai/oauth.go + subscription_tier.go public-client
 * surface). Everything here is the empirically verified public Grok CLI OAuth
 * client (RFC 6749 §2.1: the client id is not a secret): a PKCE S256 flow
 * against auth.x.ai with the `plan=generic` authorize marker, a loopback
 * redirect the operator's browser completes locally, and JWT claims extracted
 * from the direct TLS token-endpoint response. Nothing in this module is
 * confidential.
 */

/** xAI OAuth issuer (sub2api xai.OAuthIssuer). */
export const GROK_OAUTH_ISSUER = 'https://auth.x.ai';
export const GROK_OAUTH_AUTHORIZE_ENDPOINT = `${GROK_OAUTH_ISSUER}/oauth2/authorize`;
export const GROK_OAUTH_TOKEN_ENDPOINT = `${GROK_OAUTH_ISSUER}/oauth2/token`;
/**
 * The Grok CLI public OAuth client id (sub2api xai.DefaultClientID) —
 * deliberately copied verbatim, not invented: the refresh grant is bound to
 * this exact client.
 */
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/** Authorization scopes; offline_access is what yields a refresh token. */
export const GROK_OAUTH_AUTH_SCOPES = 'openid profile email offline_access grok-cli:access api:access';
/**
 * Refresh-grant scope: null sends no scope parameter, so the endpoint keeps
 * the original grant's scopes (the R4 refresh worker's narrowing contract).
 */
export const GROK_OAUTH_REFRESH_SCOPE: string | null = null;
/** Loopback redirect URI the operator's browser completes locally (sub2api xai.DefaultRedirectURI). */
export const GROK_OAUTH_REDIRECT_URI = 'http://127.0.0.1:56121/callback';
/** Canonical outbound UA for authorize/token exchanges (the pinned CLI workspace shape). */
export const GROK_OAUTH_USER_AGENT = 'xai-grok-workspace/0.2.120';
/** Alias the R4 refresh worker binding imports (the CLAUDE_/GEMINI_ naming precedent). */
export const GROK_OAUTH_TOKEN_USER_AGENT = GROK_OAUTH_USER_AGENT;

/**
 * Token scheduling pins: xAI access tokens live ~6h; the refresh worker must
 * retry at least GROK_REFRESH_LEAD_MS before expiry so a failed refresh still
 * leaves recovery time inside the same token lifetime.
 */
export const GROK_OAUTH_DEFAULT_TOKEN_TTL_MS = 6 * 60 * 60 * 1_000;
export const GROK_OAUTH_REFRESH_LEAD_MS = 5 * 60 * 1_000;

/** The id_token/access_token payload is validated against the local clock with this skew. */
export const GROK_ID_TOKEN_CLOCK_SKEW_MS = 120_000;

/**
 * Refresh scheduling for the grok binding: the next refresh fires
 * `lead` before the token's expiry (default TTL when the endpoint gave no
 * expires_in). Always at least GROK_OAUTH_REFRESH_LEAD_MS of lead for any
 * plausible token TTL the worker admits (>= 60s), satisfying the 5-minute
 * refresh-margin pin.
 */
export function grokRefreshDelayMs(
  expiresInSeconds: number | null,
  options: { readonly tokenTtlMs?: number; readonly leadMs?: number } = {},
): number {
  const ttlMs =
    expiresInSeconds === null ? (options.tokenTtlMs ?? GROK_OAUTH_DEFAULT_TOKEN_TTL_MS) : expiresInSeconds * 1_000;
  const leadMs = options.leadMs ?? GROK_OAUTH_REFRESH_LEAD_MS;
  return Math.max(1_000, Math.min(Math.max(ttlMs - leadMs, Math.min(ttlMs, leadMs)), ttlMs));
}

export type GrokOauthErrorCode =
  | 'ID_TOKEN_MALFORMED'
  | 'ID_TOKEN_EXPIRED'
  | 'ID_TOKEN_CLAIMS_MISSING'
  | 'PKCE_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'STATE_INVALID'
  | 'CODE_INVALID'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_RESPONSE_INVALID';

const ERROR_MESSAGES: Record<GrokOauthErrorCode, string> = {
  ID_TOKEN_MALFORMED: 'The Grok id_token is malformed',
  ID_TOKEN_EXPIRED: 'The Grok id_token is expired',
  ID_TOKEN_CLAIMS_MISSING: 'The Grok id_token carries no account claims',
  PKCE_INVALID: 'The PKCE challenge is invalid',
  SESSION_NOT_FOUND: 'The Grok OAuth binding session is unknown or already consumed',
  SESSION_EXPIRED: 'The Grok OAuth binding session has expired',
  STATE_INVALID: 'The binding state is invalid',
  CODE_INVALID: 'The authorization code is invalid',
  TOKEN_EXCHANGE_FAILED: 'The xAI token endpoint rejected the exchange',
  TOKEN_RESPONSE_INVALID: 'The xAI token response is invalid',
};

export class GrokOAuthError extends Error {
  constructor(readonly code: GrokOauthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GrokOAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function grokOauthError(code: GrokOauthErrorCode): GrokOAuthError {
  return new GrokOAuthError(code);
}

/** Constant-time equality for non-secret session state values (hash-then-compare). */
export function constantTimeEqualText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// The S256 computation lives in the shared gateway/oauth-subscription/pkce.ts
// kernel; the Grok CLI verifier shape is 32 random bytes as unpadded base64url
// (43 characters — RFC 7636 §4.1 minimum entropy shape, sub2api
// GenerateCodeVerifier).
export { computePkceChallenge } from '../../gateway/oauth-subscription/pkce.js';

export interface GrokPkcePair {
  /** 32 random bytes as unpadded base64url (43 characters). */
  readonly codeVerifier: string;
  /** base64url(SHA-256(verifier)) without padding. */
  readonly codeChallenge: string;
}

export function createGrokPkcePair(): GrokPkcePair {
  return sharedCreatePkcePair({ verifierBytes: 32, verifierEncoding: 'base64url' });
}

export interface GrokAuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

/** The authorize URL the platform operator opens in a local browser. */
export function buildGrokAuthorizeUrl(input: GrokAuthorizeUrlInput): URL {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
    throw grokOauthError('STATE_INVALID');
  }
  if (typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw grokOauthError('PKCE_INVALID');
  }
  const shared: PkceAuthorizeUrlInput = {
    endpoint: GROK_OAUTH_AUTHORIZE_ENDPOINT,
    clientId: GROK_OAUTH_CLIENT_ID,
    redirectUri: GROK_OAUTH_REDIRECT_URI,
    scope: GROK_OAUTH_AUTH_SCOPES,
    state: input.state,
    codeChallenge: input.codeChallenge,
    // sub2api BuildAuthorizationURL: plan=generic keeps the CLI grant shape
    // off consumer plan selection.
    extraParams: { plan: 'generic' },
  };
  return buildPkceAuthorizeUrl(shared);
}

/** Claims this router needs from the id_token payload. */
export interface GrokIdTokenClaims {
  /** `sub` — the xAI user id. */
  readonly userId: string;
  readonly teamId: string | null;
  readonly email: string | null;
  readonly expiresAtMs: number;
}

function printableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    return sharedDecodeIdTokenPayload(token);
  } catch (error) {
    if (isPkceError(error)) throw grokOauthError('ID_TOKEN_MALFORMED');
    throw error;
  }
}

function isPkceError(error: unknown): error is PkceError {
  return error instanceof Error && error.name === 'PkceError';
}

/**
 * Decode the id_token payload and extract the account claims WITHOUT the
 * expiry gate (the binding flow freshness-checks via parseGrokIdTokenClaims).
 * Signature is never verified: the token arrived over the direct TLS
 * token-endpoint response, not from an untrusted audience.
 */
export function decodeGrokIdTokenClaims(idToken: string): GrokIdTokenClaims {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 32_768) {
    throw grokOauthError('ID_TOKEN_MALFORMED');
  }
  const payload = decodeJwtPayload(idToken);
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    throw grokOauthError('ID_TOKEN_MALFORMED');
  }
  const userId = printableText(payload.sub, 128);
  if (userId === null) throw grokOauthError('ID_TOKEN_CLAIMS_MISSING');
  return Object.freeze({
    userId,
    teamId: printableText(payload.team_id, 128),
    email: printableText(payload.email, 320),
    expiresAtMs: Math.round(exp * 1_000),
  });
}

/**
 * Parse and freshness-check the id_token issued by the binding token
 * exchange. The exp claim must be within the ±120s local-clock skew window.
 */
export function parseGrokIdTokenClaims(idToken: string, nowMs: number = Date.now()): GrokIdTokenClaims {
  const claims = decodeGrokIdTokenClaims(idToken);
  if (nowMs > claims.expiresAtMs + GROK_ID_TOKEN_CLOCK_SKEW_MS) {
    throw grokOauthError('ID_TOKEN_EXPIRED');
  }
  return claims;
}

/*
 * Subscription tier (sub2api xai/subscription_tier.go port). The numeric JWT
 * `tier` claim maps onto the stable snake_case keys Grok Build uses; display
 * names and `/user` strings normalize onto the same identifiers.
 */

/** Numeric prod_auth subscription-tier claim → snake_case key. */
export function mapGrokJwtSubscriptionTier(tier: number): string {
  switch (tier) {
    case 0:
      return 'free';
    case 1:
      return 'supergrok';
    case 2:
      return 'x_basic';
    case 3:
      return 'x_premium';
    case 4:
      return 'x_premium_plus';
    case 5:
      return 'supergrok_heavy';
    case 6:
      return 'supergrok_lite';
    case 7:
      return 'supergrok_plus';
    default:
      return String(tier);
  }
}

/** Canonicalizes display names / `/user` strings onto the snake_case keys. */
export function normalizeGrokSubscriptionTier(raw: string): string {
  let tier = raw.trim().toLowerCase();
  tier = tier.replaceAll('-', '_');
  tier = tier.split(/\s+/).join('_');
  switch (tier) {
    case 'free':
    case 'grok_free':
    case 'grokfree':
    case 'free_tier':
    case 'freetier':
    case 'grok_basic':
    case 'grokbasic':
      return 'free';
    case 'supergrok':
    case 'grokpro':
      return 'supergrok';
    case 'supergrok_lite':
    case 'supergroklite':
      return 'supergrok_lite';
    case 'supergrok_heavy':
    case 'supergrokheavy':
      return 'supergrok_heavy';
    case 'supergrok_pro':
    case 'supergrokpro':
      return 'supergrok_pro';
    case 'supergrok_plus':
    case 'supergrokplus':
      return 'supergrok_plus';
    case 'x_basic':
    case 'xbasic':
    case 'basic':
      return 'x_basic';
    case 'x_premium':
    case 'xpremium':
      return 'x_premium';
    case 'x_premium_plus':
    case 'xpremiumplus':
    case 'x_premium+':
      return 'x_premium_plus';
    default:
      return tier;
  }
}

/**
 * Subscription tier from the ACCESS TOKEN payload only (no signature check —
 * the same direct-TLS trust basis as the id_token claims). Response headers
 * and other untrusted surfaces must never feed this; the binding flow and the
 * refresh pipeline both call it on token material the endpoint itself handed
 * back. Returns null when the token carries no parsable `tier` claim.
 */
export function grokSubscriptionTierFromAccessToken(accessToken: string): string | null {
  if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 32_768) return null;
  let payload: Record<string, unknown>;
  try {
    payload = decodeJwtPayload(accessToken);
  } catch {
    return null;
  }
  const raw = payload.tier;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isSafeInteger(raw)) return null;
    return mapGrokJwtSubscriptionTier(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (/^\d{1,3}$/.test(trimmed)) return mapGrokJwtSubscriptionTier(Number(trimmed));
    return normalizeGrokSubscriptionTier(trimmed);
  }
  return null;
}
