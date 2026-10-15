import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Phase 1b Codex OAuth account binding (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.2). These are the
 * empirically verified public Codex CLI OAuth constants (sub2api's
 * backend/internal/pkg/openai/oauth.go port): a public RFC 6749 §2.1 client
 * (the client id is not a secret), a loopback redirect URI the operator's
 * browser completes locally, and the simplified-flow flag the CLI uses.
 * Nothing in this module is confidential.
 */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_AUTHORIZE_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
export const CODEX_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
/** Authorization scopes; offline_access is what yields a refresh token. */
export const CODEX_OAUTH_AUTH_SCOPES = 'openid profile email offline_access';
/**
 * Refresh-grant scope: offline_access is dropped because the refresh token
 * already exists (the R4 refresh worker sends exactly this narrowing).
 */
export const CODEX_OAUTH_REFRESH_SCOPE = 'openid profile email';
/** The Codex CLI simplified-flow marker appended to the authorize URL. */
export const CODEX_OAUTH_SIMPLIFIED_FLOW = 'codex_cli_simplified_flow';
/**
 * Canonical outbound UA for the token exchange. The originator/version shape
 * must track the Codex CLI (>= 0.144.0; Phase 1.4 owns version syncing).
 */
export const CODEX_OAUTH_USER_AGENT = 'codex_cli_rs/0.146.0 (Mac OS X 15.0; arm64) Terminal';
/** The id_token payload is validated against the local clock with this skew. */
export const CODEX_ID_TOKEN_CLOCK_SKEW_MS = 120_000;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const CODEX_AUTH_CLAIMS_KEY = 'https://api.openai.com/auth';

export type CodexOauthErrorCode =
  | 'ID_TOKEN_MALFORMED'
  | 'ID_TOKEN_EXPIRED'
  | 'ID_TOKEN_CLAIMS_MISSING'
  | 'PKCE_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'STATE_INVALID'
  | 'CODE_INVALID'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'TOKEN_RESPONSE_INVALID'
  | 'AUTH_JSON_INVALID';

const ERROR_MESSAGES: Record<CodexOauthErrorCode, string> = {
  ID_TOKEN_MALFORMED: 'The Codex id_token is malformed',
  ID_TOKEN_EXPIRED: 'The Codex id_token is expired',
  ID_TOKEN_CLAIMS_MISSING: 'The Codex id_token carries no ChatGPT account claims',
  PKCE_INVALID: 'The PKCE challenge is invalid',
  SESSION_NOT_FOUND: 'The Codex OAuth binding session is unknown or already consumed',
  SESSION_EXPIRED: 'The Codex OAuth binding session has expired',
  STATE_INVALID: 'The binding state is invalid',
  CODE_INVALID: 'The authorization code is invalid',
  TOKEN_EXCHANGE_FAILED: 'The Codex OAuth token endpoint rejected the exchange',
  TOKEN_RESPONSE_INVALID: 'The Codex OAuth token response is invalid',
  AUTH_JSON_INVALID: 'The Codex CLI auth.json payload is invalid',
};

export class CodexOAuthError extends Error {
  constructor(readonly code: CodexOauthErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'CodexOAuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function codexOauthError(code: CodexOauthErrorCode): CodexOAuthError {
  return new CodexOAuthError(code);
}

/** Constant-time equality for non-secret session state values (hash-then-compare). */
export function constantTimeEqualText(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** S256 code challenge for an ASCII verifier (RFC 7636). */
export function computePkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'utf8').digest('base64url');
}

export interface CodexPkcePair {
  /** 64 random bytes as 128 lowercase hex characters (the Codex CLI shape). */
  readonly codeVerifier: string;
  /** base64url(SHA-256(verifier)). */
  readonly codeChallenge: string;
}

export function createPkcePair(): CodexPkcePair {
  const codeVerifier = randomBytes(64).toString('hex');
  return { codeVerifier, codeChallenge: computePkceChallenge(codeVerifier) };
}

export interface CodexAuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

/** The authorize URL the platform operator opens in a local browser. */
export function buildAuthorizeUrl(input: CodexAuthorizeUrlInput): URL {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
    throw codexOauthError('STATE_INVALID');
  }
  if (typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw codexOauthError('PKCE_INVALID');
  }
  const url = new URL(CODEX_OAUTH_AUTHORIZE_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', CODEX_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_AUTH_SCOPES);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set(CODEX_OAUTH_SIMPLIFIED_FLOW, 'true');
  return url;
}

/** Claims this router needs from the id_token's `https://api.openai.com/auth` object. */
export interface CodexIdTokenClaims {
  readonly chatgptAccountId: string;
  readonly chatgptUserId: string | null;
  readonly planType: string | null;
  readonly email: string | null;
  readonly organizations: readonly string[];
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

function organizationIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0 && entry.length <= 128) ids.push(entry);
    else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === 'string' && id.length > 0 && id.length <= 128) ids.push(id);
    }
  }
  return Object.freeze(ids);
}

function decodeIdTokenPayload(idToken: string): Record<string, unknown> {
  const segments = idToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => !BASE64URL_SEGMENT.test(segment))) {
    throw codexOauthError('ID_TOKEN_MALFORMED');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw codexOauthError('ID_TOKEN_MALFORMED');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codexOauthError('ID_TOKEN_MALFORMED');
  }
  return payload as Record<string, unknown>;
}

/**
 * Decode the id_token payload and extract the ChatGPT account claims WITHOUT
 * the expiry gate. The binding flow uses parseIdTokenClaims (fresh token
 * required); auth.json imports use this lenient form because a CLI snapshot
 * legitimately carries a stale id_token while its refresh token is still
 * valid. Signature is never verified: the token arrived over the direct
 * TLS token-endpoint response, not from an untrusted audience.
 */
export function decodeIdTokenClaims(idToken: string): CodexIdTokenClaims {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 32_768) {
    throw codexOauthError('ID_TOKEN_MALFORMED');
  }
  const payload = decodeIdTokenPayload(idToken);
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) {
    throw codexOauthError('ID_TOKEN_MALFORMED');
  }
  const authClaims = payload[CODEX_AUTH_CLAIMS_KEY];
  if (authClaims === null || typeof authClaims !== 'object' || Array.isArray(authClaims)) {
    throw codexOauthError('ID_TOKEN_CLAIMS_MISSING');
  }
  const claims = authClaims as Record<string, unknown>;
  const chatgptAccountId = printableText(claims.chatgpt_account_id, 128);
  if (chatgptAccountId === null) throw codexOauthError('ID_TOKEN_CLAIMS_MISSING');
  return Object.freeze({
    chatgptAccountId,
    chatgptUserId: printableText(claims.chatgpt_user_id, 128),
    planType: printableText(claims.plan_type, 64),
    email: printableText(payload.email, 320),
    organizations: organizationIds(claims.organizations),
    expiresAtMs: Math.round(exp * 1_000),
  });
}

/**
 * Parse and freshness-check the id_token issued by the binding token
 * exchange. The exp claim must be within the ±120s local-clock skew window:
 * a token expired more than 120s ago is rejected, mirroring the CLI.
 */
export function parseIdTokenClaims(idToken: string, nowMs: number = Date.now()): CodexIdTokenClaims {
  const claims = decodeIdTokenClaims(idToken);
  if (nowMs > claims.expiresAtMs + CODEX_ID_TOKEN_CLOCK_SKEW_MS) {
    throw codexOauthError('ID_TOKEN_EXPIRED');
  }
  return claims;
}
