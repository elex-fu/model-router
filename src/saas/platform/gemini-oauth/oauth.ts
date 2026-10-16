import { createHash, timingSafeEqual } from 'node:crypto';
import {
  buildPkceAuthorizeUrl,
  type PkceAuthorizeUrlInput,
  createPkcePair as sharedCreatePkcePair,
} from '../../gateway/oauth-subscription/pkce.js';

/**
 * F4 Gemini OAuth account binding constants (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b; sub2api's
 * backend/internal/pkg/geminicli/constants.go). These are the empirically
 * verified public Gemini CLI (Cloud Code Assist) OAuth constants: Google's
 * public installed-app client (RFC 6749 §2.1 — the client id is not a
 * secret), the accounts.google.com authorize endpoint, the
 * oauth2.googleapis.com token endpoint and the codeassist.google.com code
 * callback redirect. The token exchange is a form-urlencoded POST.
 *
 * The installed-app client_secret Google requires in the token exchange is
 * NOT embedded here (provider-shaped literals trip secret-scanning push
 * protection); operators supply it through the
 * MODEL_ROUTER_GEMINI_OAUTH_CLIENT_SECRET environment variable — the same
 * escape hatch sub2api documents (GEMINI_CLI_OAUTH_CLIENT_SECRET).
 */
export const GEMINI_OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GEMINI_OAUTH_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GEMINI_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GEMINI_OAUTH_REDIRECT_URI = 'https://codeassist.google.com/authcode';
/** The code_assist scopes the Gemini CLI requests (sub2api DefaultCodeAssistScopes). */
export const GEMINI_OAUTH_AUTH_SCOPES =
  'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
/** Refresh grants send no scope: the original grant's scopes persist. */
export const GEMINI_OAUTH_REFRESH_SCOPE = null;
/** Environment variable carrying the installed-app client secret (never a source literal). */
export const GEMINI_OAUTH_CLIENT_SECRET_ENV = 'MODEL_ROUTER_GEMINI_OAUTH_CLIENT_SECRET';
/** Canonical outbound UA for the token exchange. */
export const GEMINI_OAUTH_TOKEN_USER_AGENT = 'model-router';

export type GeminiOauthErrorCode =
  | 'STATE_INVALID'
  | 'PKCE_INVALID'
  | 'CLIENT_SECRET_MISSING'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'CODE_INVALID'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'PROJECT_RESOLUTION_FAILED'
  | 'CREDENTIALS_JSON_INVALID';

const ERROR_MESSAGES: Record<GeminiOauthErrorCode, string> = {
  STATE_INVALID: 'The binding state is invalid',
  PKCE_INVALID: 'The PKCE challenge is invalid',
  CLIENT_SECRET_MISSING: 'The Gemini CLI OAuth client secret is not configured',
  SESSION_NOT_FOUND: 'The Gemini OAuth binding session is unknown or already consumed',
  SESSION_EXPIRED: 'The Gemini OAuth binding session has expired',
  CODE_INVALID: 'The authorization code is invalid',
  TOKEN_EXCHANGE_FAILED: 'The Gemini token endpoint rejected the exchange',
  TOKEN_RESPONSE_INVALID: 'The Gemini token response is invalid',
  PROJECT_RESOLUTION_FAILED: 'The Gemini Code Assist project could not be resolved',
  CREDENTIALS_JSON_INVALID: 'The Gemini credentials.json payload is invalid',
};

export class GeminiOAuthError extends Error {
  constructor(readonly code: GeminiOauthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'GeminiOAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function geminiOauthError(code: GeminiOauthErrorCode): GeminiOAuthError {
  return new GeminiOAuthError(code);
}

/** Constant-time equality for non-secret session state values (hash-then-compare). */
export function constantTimeEqualText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export interface GeminiPkcePair {
  /** 32 random bytes as 43 base64url characters (the Gemini CLI shape). */
  readonly codeVerifier: string;
  /** base64url(SHA-256(verifier)). */
  readonly codeChallenge: string;
}

/** PKCE pair in the Gemini CLI's 43-char base64url verifier shape. */
export function createPkcePair(): GeminiPkcePair {
  return sharedCreatePkcePair({ verifierBytes: 32, verifierEncoding: 'base64url' });
}

/**
 * Reads the installed-app client secret from the environment. The value is
 * Google's public Gemini CLI client secret (published in the open-source
 * CLI), but it is provider-shaped, so it lives only in the deployment
 * environment. Returns null when unset or blank.
 */
export function resolveGeminiOauthClientSecret(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[GEMINI_OAUTH_CLIENT_SECRET_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface GeminiAuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

/** The authorize URL the platform operator opens in a local browser. */
export function buildAuthorizeUrl(input: GeminiAuthorizeUrlInput): URL {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
    throw geminiOauthError('STATE_INVALID');
  }
  if (typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw geminiOauthError('PKCE_INVALID');
  }
  const shared: PkceAuthorizeUrlInput = {
    endpoint: GEMINI_OAUTH_AUTHORIZE_ENDPOINT,
    clientId: GEMINI_OAUTH_CLIENT_ID,
    redirectUri: GEMINI_OAUTH_REDIRECT_URI,
    scope: GEMINI_OAUTH_AUTH_SCOPES,
    state: input.state,
    codeChallenge: input.codeChallenge,
    // The offline-access consent pair the Gemini CLI sends (sub2api
    // BuildAuthorizationURL): without prompt=consent Google may skip issuing
    // a refresh token for an already-authorized user.
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  };
  return buildPkceAuthorizeUrl(shared);
}
