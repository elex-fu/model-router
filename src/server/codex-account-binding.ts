import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  buildPkceAuthorizeUrl,
  createPkcePair as sharedCreatePkcePair,
  decodeIdTokenPayload as sharedDecodeIdTokenPayload,
} from '../saas/gateway/oauth-subscription/pkce.js';
import type { OAuthAccount } from './oauth-accounts.js';

/**
 * Classic-mode Codex OAuth account binding (capability plan task CS2,
 * docs/standalone-relay-capability-plan-2026-10-30.md D1 task table).
 *
 * Ported 1:1 from the SaaS Codex OAuth package — the PKCE pair, authorize URL
 * constants, strict token-response parsing and id_token claim extraction come
 * from src/saas/platform/codex-oauth/oauth.ts, the binding/exchange flow from
 * binding-service.ts, and the auth.json import from import.ts — so both planes
 * keep identical provider semantics, validation strictness and error taxonomy.
 *
 * The shared crypto/URL/JWT primitives are IMPORTED from the pure kernel
 * src/saas/gateway/oauth-subscription/pkce.ts (its import chain is node:crypto
 * only; it was extracted precisely so both planes share one implementation).
 * The Codex-specific constants below are COPIES of the public OAuth client
 * constants in src/saas/platform/codex-oauth/oauth.ts lines 19-38 — the
 * classic tree otherwise avoids src/saas imports (same drift-anchor discipline
 * as src/server/oauth-refresh.ts). Nothing here is confidential (RFC 6749
 * §2.1 public clients). Token material is never logged and never embedded in
 * error messages.
 */

// --- Codex OAuth public client constants (drift anchor: saas codex-oauth/oauth.ts) ---

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_AUTHORIZE_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
export const CODEX_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
/** Authorization scopes; offline_access is what yields a refresh token. */
export const CODEX_OAUTH_AUTH_SCOPES = 'openid profile email offline_access';
/** Refresh-grant scope: offline_access is dropped (the refresh token exists). */
export const CODEX_OAUTH_REFRESH_SCOPE = 'openid profile email';
/** The Codex CLI simplified-flow marker appended to the authorize URL. */
export const CODEX_OAUTH_SIMPLIFIED_FLOW = 'codex_cli_simplified_flow';
/** Canonical outbound UA for the token exchange (must track the Codex CLI). */
export const CODEX_OAUTH_USER_AGENT = 'codex_cli_rs/0.146.0 (Mac OS X 15.0; arm64) Terminal';
/** The id_token payload is validated against the local clock with this skew. */
export const CODEX_ID_TOKEN_CLOCK_SKEW_MS = 120_000;

// --- Binding session/exchange limits (drift anchor: saas codex-oauth/binding-service.ts) ---

/** Binding sessions live for 30 minutes: enough for a human browser round trip. */
export const CODEX_BINDING_SESSION_TTL_MS = 30 * 60_000;
export const CODEX_BINDING_TOKEN_TIMEOUT_MS = 10_000;
export const CODEX_BINDING_MAX_RESPONSE_BYTES = 8_192;

const CODEX_AUTH_CLAIMS_KEY = 'https://api.openai.com/auth';

// --- Error taxonomy (identical codes and messages to saas codex-oauth/oauth.ts) ---

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

// The S256 computation lives in the shared gateway/oauth-subscription/pkce.ts
// kernel; the codex CLI verifier shape (64 random bytes as 128 lowercase hex
// characters) is pinned here.
export { computePkceChallenge } from '../saas/gateway/oauth-subscription/pkce.js';

export interface CodexPkcePair {
  /** 64 random bytes as 128 lowercase hex characters (the Codex CLI shape). */
  readonly codeVerifier: string;
  /** base64url(SHA-256(verifier)). */
  readonly codeChallenge: string;
}

export function createPkcePair(): CodexPkcePair {
  return sharedCreatePkcePair({ verifierBytes: 64, verifierEncoding: 'hex' });
}

export interface CodexAuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

/** The authorize URL the operator opens in a local browser. */
export function buildAuthorizeUrl(input: CodexAuthorizeUrlInput): URL {
  if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
    throw codexOauthError('STATE_INVALID');
  }
  if (typeof input.codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)) {
    throw codexOauthError('PKCE_INVALID');
  }
  return buildPkceAuthorizeUrl({
    endpoint: CODEX_OAUTH_AUTHORIZE_ENDPOINT,
    clientId: CODEX_OAUTH_CLIENT_ID,
    redirectUri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_AUTH_SCOPES,
    state: input.state,
    codeChallenge: input.codeChallenge,
    extraParams: { [CODEX_OAUTH_SIMPLIFIED_FLOW]: 'true' },
  });
}

// --- id_token claims (saas codex-oauth/oauth.ts, unverified JWT decode) ---

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
  try {
    return sharedDecodeIdTokenPayload(idToken);
  } catch (error) {
    if (isPkceError(error)) throw codexOauthError('ID_TOKEN_MALFORMED');
    throw error;
  }
}

function isPkceError(error: unknown): error is { name: string } {
  return error instanceof Error && error.name === 'PkceError';
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

// --- Token exchange (saas codex-oauth/binding-service.ts completeBinding) ---

export type CodexOauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

function tokenText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function parseTokenResponse(body: unknown): {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string | null;
  readonly expiresInSeconds: number | null;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw codexOauthError('TOKEN_RESPONSE_INVALID');
  }
  const record = body as Record<string, unknown>;
  const accessToken = tokenText(record.access_token);
  if (accessToken === null) throw codexOauthError('TOKEN_RESPONSE_INVALID');
  const refreshToken = tokenText(record.refresh_token);
  if (refreshToken === null) throw codexOauthError('TOKEN_RESPONSE_INVALID');
  const idToken = tokenText(record.id_token);
  let expiresInSeconds: number | null = null;
  if (record.expires_in !== undefined) {
    const raw = record.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 31_536_000) {
      throw codexOauthError('TOKEN_RESPONSE_INVALID');
    }
    expiresInSeconds = parsed;
  }
  return { accessToken, refreshToken, idToken, expiresInSeconds };
}

export interface CodexTokenExchangeInput {
  readonly code: string;
  readonly codeVerifier: string;
  /** Defaults to the fixed loopback redirect URI the authorize URL used. */
  readonly redirectUri?: string;
  /** Test/custom seam; production uses the global fetch against the fixed endpoint. */
  readonly fetch?: CodexOauthFetch;
}

export interface CodexTokenExchangeResult {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Optional in the raw response; the binding flow itself requires it. */
  readonly idToken: string | null;
  readonly expiresInSeconds: number | null;
}

/**
 * Exchange an authorization code at the fixed Codex token endpoint with the
 * strict response parse of the SaaS binding service: access_token and
 * refresh_token are required printable tokens, id_token is optional here (the
 * binding flow rejects its absence separately), and expires_in must be a
 * positive integer within the 1s..365d bounds.
 */
export async function exchangeCodeForTokens(input: CodexTokenExchangeInput): Promise<CodexTokenExchangeResult> {
  if (typeof input.code !== 'string' || input.code.length < 16 || input.code.length > 2_048) {
    throw codexOauthError('CODE_INVALID');
  }
  const fetcher = input.fetch ?? ((url, init) => fetch(url, init));
  const redirectUri = input.redirectUri ?? CODEX_OAUTH_REDIRECT_URI;
  const form = `grant_type=authorization_code&client_id=${encodeURIComponent(CODEX_OAUTH_CLIENT_ID)}&code=${encodeURIComponent(input.code)}&code_verifier=${encodeURIComponent(input.codeVerifier)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  let response: Response;
  try {
    response = await fetcher(new URL(CODEX_OAUTH_TOKEN_ENDPOINT), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': CODEX_OAUTH_USER_AGENT,
      },
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(CODEX_BINDING_TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw codexOauthError('TOKEN_EXCHANGE_FAILED');
  }
  if (response.status < 200 || response.status >= 300) {
    throw codexOauthError('TOKEN_EXCHANGE_FAILED');
  }
  let body: unknown;
  try {
    const text = await response.text();
    if (text.length > CODEX_BINDING_MAX_RESPONSE_BYTES) throw new Error('too large');
    body = JSON.parse(text);
  } catch {
    throw codexOauthError('TOKEN_RESPONSE_INVALID');
  }
  return parseTokenResponse(body);
}

// --- Codex CLI auth.json import (saas codex-oauth/import.ts) ---

/** The credential envelope both the binding flow and the auth.json import produce. */
export interface CodexCredentialEnvelope {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string | null;
  /** ISO timestamp derived from expires_in; null when the endpoint gave none. */
  readonly expiresAt: string | null;
  readonly clientId: string;
  readonly email: string | null;
  readonly chatgptAccountId: string;
  readonly chatgptUserId: string | null;
  readonly planType: string | null;
}

/**
 * Parse the Codex CLI's ~/.codex/auth.json content. Lenient on optional
 * fields, strict on the required ones: an import without a usable refresh
 * token or account id is rejected rather than guessed. The id_token (when
 * present) is decoded without the freshness gate — a CLI snapshot
 * legitimately carries a stale id_token while its refresh token is still
 * valid — but a contradictory account id is a hard rejection.
 */
export function parseCodexAuthJson(text: string): CodexCredentialEnvelope {
  if (typeof text !== 'string' || text.length === 0 || text.length > 65_536) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  const tokens = (body as Record<string, unknown>).tokens;
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  const record = tokens as Record<string, unknown>;
  const accessToken = tokenText(record.access_token);
  const refreshToken = tokenText(record.refresh_token);
  const accountId = tokenText(record.account_id);
  if (accessToken === null || refreshToken === null || accountId === null) {
    throw codexOauthError('AUTH_JSON_INVALID');
  }
  const idToken = tokenText(record.id_token);
  let email: string | null = null;
  let chatgptUserId: string | null = null;
  let planType: string | null = null;
  if (idToken !== null) {
    try {
      const claims = decodeIdTokenClaims(idToken);
      if (claims.chatgptAccountId !== accountId) throw codexOauthError('AUTH_JSON_INVALID');
      email = claims.email;
      chatgptUserId = claims.chatgptUserId;
      planType = claims.planType;
    } catch (error) {
      if (error instanceof CodexOAuthError && error.code === 'AUTH_JSON_INVALID') throw error;
      // A stale or opaque id_token never blocks the import: the refresh
      // token is the credential and the account id is already known.
    }
  }
  return Object.freeze({
    accessToken,
    refreshToken,
    idToken,
    expiresAt: null,
    // The CLI does not record its client id in auth.json, but the refresh
    // grant must use the same public client the tokens were issued to.
    clientId: CODEX_OAUTH_CLIENT_ID,
    email,
    chatgptAccountId: accountId,
    chatgptUserId,
    planType,
  });
}

// --- Binding session manager (classic single-process form of the SaaS service) ---

export interface CodexBindingStart {
  readonly authorizeUrl: URL;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface CodexBindingCompleteInput {
  /** Either an authorization code from the loopback redirect or a pasted auth.json blob. */
  readonly codeOrAuthJson: string;
  /**
   * State echoed by the loopback redirect (`?code=...&state=...`). Optional;
   * when present it is compared against the session state in constant time.
   */
  readonly state?: string;
  /** Test/custom seam; defaults to the global fetch against the fixed endpoint. */
  readonly fetch?: CodexOauthFetch;
}

export type CodexAccountSource = 'oauth-binding' | 'auth-json-import';

/**
 * OAuthAccount-shaped result ready for OAuthAccountStore.add(): id is the
 * ChatGPT account id, login is the id_token email when present, expiresAt is
 * epoch ms, and status starts active so the CS1 refresh engine picks the
 * account up immediately. `source` and the claim extras are non-secret
 * operator metadata.
 */
export interface CodexBoundAccount extends OAuthAccount {
  readonly source: CodexAccountSource;
  readonly chatgptUserId: string | null;
  readonly planType: string | null;
}

interface ActiveSession {
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAtMs: number;
}

export interface CodexBindingSessionOptions {
  readonly nowMs?: () => number;
}

export interface CodexBindingSession {
  /** Generates the PKCE pair + state and returns the authorize URL to open. */
  start(): CodexBindingStart;
  /**
   * Completes the binding with either the pasted authorization code (PKCE
   * exchange against the fixed token endpoint; the session is single-use) or
   * a pasted auth.json blob (import parse path, session not consumed). The
   * module never touches the account store; the caller stores the result.
   */
  complete(input: CodexBindingCompleteInput): Promise<CodexBoundAccount>;
}

function accountFromEnvelope(envelope: CodexCredentialEnvelope, source: CodexAccountSource): CodexBoundAccount {
  return Object.freeze({
    id: envelope.chatgptAccountId,
    provider: 'codex_oauth',
    ...(envelope.email === null ? {} : { login: envelope.email }),
    accessToken: envelope.accessToken,
    refreshToken: envelope.refreshToken,
    ...(envelope.expiresAt === null ? {} : { expiresAt: Date.parse(envelope.expiresAt) }),
    isDefault: false,
    status: 'active',
    source,
    chatgptUserId: envelope.chatgptUserId,
    planType: envelope.planType,
  });
}

/** A pasted input that looks like JSON takes the auth.json import path. */
function isAuthJsonBlob(text: string): boolean {
  return text.startsWith('{');
}

export function createCodexBindingSession(options: CodexBindingSessionOptions = {}): CodexBindingSession {
  const nowMs = options.nowMs ?? (() => Date.now());
  let active: ActiveSession | null = null;
  let consumed = false;

  return {
    start(): CodexBindingStart {
      const { codeVerifier, codeChallenge } = createPkcePair();
      const state = randomBytes(32).toString('hex');
      active = { state, codeVerifier, expiresAtMs: nowMs() + CODEX_BINDING_SESSION_TTL_MS };
      consumed = false;
      return { authorizeUrl: buildAuthorizeUrl({ state, codeChallenge }), state, codeVerifier };
    },

    async complete(input: CodexBindingCompleteInput): Promise<CodexBoundAccount> {
      const text = typeof input.codeOrAuthJson === 'string' ? input.codeOrAuthJson.trim() : '';
      if (isAuthJsonBlob(text)) {
        // Import path: no binding session required, none consumed.
        return accountFromEnvelope(parseCodexAuthJson(text), 'auth-json-import');
      }
      if (
        input.state !== undefined &&
        (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state))
      ) {
        throw codexOauthError('STATE_INVALID');
      }
      if (text.length < 16 || text.length > 2_048) throw codexOauthError('CODE_INVALID');
      const session = active;
      if (session === null) throw codexOauthError('SESSION_NOT_FOUND');
      // Defense in depth: the session is only usable when the caller's state
      // matches it exactly, compared in constant time.
      if (input.state !== undefined && !constantTimeEqualText(session.state, input.state)) {
        throw codexOauthError('SESSION_NOT_FOUND');
      }
      if (consumed) throw codexOauthError('SESSION_NOT_FOUND');
      if (nowMs() > session.expiresAtMs) throw codexOauthError('SESSION_EXPIRED');
      // Single-use: the session dies with this attempt even when the exchange fails.
      consumed = true;
      const tokens = await exchangeCodeForTokens({
        code: text,
        codeVerifier: session.codeVerifier,
        fetch: input.fetch,
      });
      if (tokens.idToken === null) throw codexOauthError('TOKEN_RESPONSE_INVALID');
      const claims = parseIdTokenClaims(tokens.idToken, nowMs());
      const now = nowMs();
      return accountFromEnvelope(
        Object.freeze({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          expiresAt:
            tokens.expiresInSeconds === null ? null : new Date(now + tokens.expiresInSeconds * 1_000).toISOString(),
          clientId: CODEX_OAUTH_CLIENT_ID,
          email: claims.email,
          chatgptAccountId: claims.chatgptAccountId,
          chatgptUserId: claims.chatgptUserId,
          planType: claims.planType,
        }),
        'oauth-binding',
      );
    },
  };
}
