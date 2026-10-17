import { randomBytes } from 'node:crypto';
import {
  buildGrokAuthorizeUrl,
  constantTimeEqualText,
  createGrokPkcePair,
  GROK_OAUTH_CLIENT_ID,
  GROK_OAUTH_REDIRECT_URI,
  GROK_OAUTH_TOKEN_ENDPOINT,
  GROK_OAUTH_USER_AGENT,
  grokOauthError,
  grokSubscriptionTierFromAccessToken,
  parseGrokIdTokenClaims,
} from './oauth.js';

/**
 * Batch-3 Grok OAuth binding service (the platform/codex-oauth
 * binding-service.ts contract applied to the xAI public-client PKCE flow).
 * Pure logic plus an injectable fetch: the platform console generates an
 * authorize URL (the operator completes it in a local browser against the
 * loopback redirect), pastes the resulting authorization code back, and this
 * service exchanges it for the OAuth material the caller then seals through
 * the existing credential envelope path. Token material never leaves the
 * process except to the fixed https token endpoint, is never logged, and is
 * never embedded in error messages.
 */

/** Binding sessions live for 30 minutes: enough for a human browser round trip. */
export const GROK_BINDING_SESSION_TTL_MS = 30 * 60_000;
export const GROK_BINDING_TOKEN_TIMEOUT_MS = 10_000;
export const GROK_BINDING_MAX_RESPONSE_BYTES = 65_536;

export interface GrokCredentialEnvelope {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly idToken: string | null;
  /** ISO timestamp derived from expires_in; null when the endpoint gave none. */
  readonly expiresAt: string | null;
  readonly clientId: string;
  readonly email: string | null;
  /** id_token `sub` claim — the xAI user id. */
  readonly userId: string;
  /** id_token `team_id` claim when present. */
  readonly teamId: string | null;
  /**
   * Subscription tier derived from the ACCESS TOKEN payload only
   * (grokSubscriptionTierFromAccessToken); null when the token carries no
   * parsable tier claim.
   */
  readonly subscriptionTier: string | null;
}

export interface GrokBindingSession {
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAtMs: number;
}

/**
 * Storage for binding sessions. `take` must remove the session (single-use
 * state); production may swap the in-memory implementation for a shared store
 * without touching the service.
 */
export interface GrokBindingSessionStore {
  put(session: GrokBindingSession): Promise<void>;
  take(state: string): Promise<GrokBindingSession | null>;
}

interface StoredEntry {
  readonly session: GrokBindingSession;
  expiresAtMs: number;
}

/** In-memory single-use binding session store with TTL sweep on every access. */
export class InMemoryGrokBindingSessionStore implements GrokBindingSessionStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(session: GrokBindingSession): Promise<void> {
    this.sweep(this.now());
    this.entries.set(session.state, { session, expiresAtMs: session.expiresAtMs });
    if (this.entries.size > 1_024) {
      // Bound the map even under a start-request flood; oldest state wins.
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
  }

  async take(state: string): Promise<GrokBindingSession | null> {
    this.sweep(this.now());
    const entry = this.entries.get(state);
    if (!entry) return null;
    this.entries.delete(state);
    return entry.session;
  }

  private sweep(nowMs: number): void {
    for (const [state, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(state);
    }
  }
}

export type GrokOauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface GrokOAuthBindingServiceOptions {
  readonly sessionStore: GrokBindingSessionStore;
  /** Test/custom seam; production uses the global fetch against the fixed endpoint. */
  readonly fetch?: GrokOauthFetch;
  readonly nowMs?: () => number;
}

export interface GrokBindingStart {
  readonly authorizeUrl: URL;
  readonly state: string;
}

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
    throw grokOauthError('TOKEN_RESPONSE_INVALID');
  }
  const record = body as Record<string, unknown>;
  const accessToken = tokenText(record.access_token);
  if (accessToken === null) throw grokOauthError('TOKEN_RESPONSE_INVALID');
  const refreshToken = tokenText(record.refresh_token);
  if (refreshToken === null) throw grokOauthError('TOKEN_RESPONSE_INVALID');
  const idToken = tokenText(record.id_token);
  let expiresInSeconds: number | null = null;
  if (record.expires_in !== undefined) {
    const raw = record.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 31_536_000) {
      throw grokOauthError('TOKEN_RESPONSE_INVALID');
    }
    expiresInSeconds = parsed;
  }
  return { accessToken, refreshToken, idToken, expiresInSeconds };
}

export class GrokOAuthBindingService {
  private readonly fetcher: GrokOauthFetch;
  private readonly nowMs: () => number;

  constructor(private readonly options: GrokOAuthBindingServiceOptions) {
    if (
      !options?.sessionStore ||
      typeof options.sessionStore.put !== 'function' ||
      typeof options.sessionStore.take !== 'function'
    ) {
      throw new TypeError('sessionStore is required');
    }
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async generateBindingSession(): Promise<GrokBindingStart> {
    const { codeVerifier, codeChallenge } = createGrokPkcePair();
    const state = randomBytes(32).toString('hex');
    await this.options.sessionStore.put({
      state,
      codeVerifier,
      expiresAtMs: this.nowMs() + GROK_BINDING_SESSION_TTL_MS,
    });
    return { authorizeUrl: buildGrokAuthorizeUrl({ state, codeChallenge }), state };
  }

  async completeBinding(input: { readonly state: string; readonly code: string }): Promise<GrokCredentialEnvelope> {
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
      throw grokOauthError('STATE_INVALID');
    }
    if (typeof input.code !== 'string' || input.code.length < 16 || input.code.length > 2_048) {
      throw grokOauthError('CODE_INVALID');
    }
    const session = await this.options.sessionStore.take(input.state);
    if (!session) throw grokOauthError('SESSION_NOT_FOUND');
    // Defense in depth: the session is only usable when the caller's state
    // matches it exactly, compared in constant time.
    if (!constantTimeEqualText(session.state, input.state)) throw grokOauthError('SESSION_NOT_FOUND');
    if (this.nowMs() > session.expiresAtMs) throw grokOauthError('SESSION_EXPIRED');

    const form =
      `grant_type=authorization_code&client_id=${encodeURIComponent(GROK_OAUTH_CLIENT_ID)}` +
      `&code=${encodeURIComponent(input.code)}&code_verifier=${encodeURIComponent(session.codeVerifier)}` +
      `&redirect_uri=${encodeURIComponent(GROK_OAUTH_REDIRECT_URI)}`;
    let response: Response;
    try {
      response = await this.fetcher(new URL(GROK_OAUTH_TOKEN_ENDPOINT), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': GROK_OAUTH_USER_AGENT,
        },
        body: form,
        redirect: 'manual',
        signal: AbortSignal.timeout(GROK_BINDING_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw grokOauthError('TOKEN_EXCHANGE_FAILED');
    }
    if (response.status < 200 || response.status >= 300) {
      throw grokOauthError('TOKEN_EXCHANGE_FAILED');
    }

    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > GROK_BINDING_MAX_RESPONSE_BYTES) throw new Error('too large');
      body = JSON.parse(text);
    } catch {
      throw grokOauthError('TOKEN_RESPONSE_INVALID');
    }
    const tokens = parseTokenResponse(body);
    if (tokens.idToken === null) throw grokOauthError('TOKEN_RESPONSE_INVALID');
    const claims = parseGrokIdTokenClaims(tokens.idToken, this.nowMs());
    const subscriptionTier = grokSubscriptionTierFromAccessToken(tokens.accessToken);
    const nowMs = this.nowMs();
    return Object.freeze({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt:
        tokens.expiresInSeconds === null ? null : new Date(nowMs + tokens.expiresInSeconds * 1_000).toISOString(),
      clientId: GROK_OAUTH_CLIENT_ID,
      email: claims.email,
      userId: claims.userId,
      teamId: claims.teamId,
      subscriptionTier,
    });
  }
}
