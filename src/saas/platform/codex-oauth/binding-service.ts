import { randomBytes } from 'node:crypto';
import {
  buildAuthorizeUrl,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_TOKEN_ENDPOINT,
  CODEX_OAUTH_USER_AGENT,
  codexOauthError,
  constantTimeEqualText,
  createPkcePair,
  parseIdTokenClaims,
} from './oauth.js';

/**
 * Phase 1b Codex OAuth binding service (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.2). Pure logic plus
 * an injectable fetch: the platform console generates an authorize URL (the
 * operator completes it in a local browser against the loopback redirect),
 * pastes the resulting authorization code back, and this service exchanges
 * it for the OAuth material that the caller then seals through the existing
 * credential envelope path. Token material never leaves the process except
 * to the fixed https token endpoint, is never logged, and is never embedded
 * in error messages.
 */

/** Binding sessions live for 30 minutes: enough for a human browser round trip. */
export const CODEX_BINDING_SESSION_TTL_MS = 30 * 60_000;
export const CODEX_BINDING_TOKEN_TIMEOUT_MS = 10_000;
export const CODEX_BINDING_MAX_RESPONSE_BYTES = 8_192;

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

export interface CodexBindingSession {
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAtMs: number;
}

/**
 * Storage for binding sessions. `take` must remove the session (single-use
 * state); production may swap the in-memory implementation for a shared store
 * without touching the service.
 */
export interface BindingSessionStore {
  put(session: CodexBindingSession): Promise<void>;
  take(state: string): Promise<CodexBindingSession | null>;
}

interface StoredEntry {
  readonly session: CodexBindingSession;
  expiresAtMs: number;
}

/** In-memory single-use binding session store with TTL sweep on every access. */
export class InMemoryBindingSessionStore implements BindingSessionStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(session: CodexBindingSession): Promise<void> {
    this.sweep(this.now());
    this.entries.set(session.state, { session, expiresAtMs: session.expiresAtMs });
    if (this.entries.size > 1_024) {
      // Bound the map even under a start-request flood; oldest state wins.
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
  }

  async take(state: string): Promise<CodexBindingSession | null> {
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

export type CodexOauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface CodexOAuthBindingServiceOptions {
  readonly sessionStore: BindingSessionStore;
  /** Test/custom seam; production uses the global fetch against the fixed endpoint. */
  readonly fetch?: CodexOauthFetch;
  readonly nowMs?: () => number;
}

export interface CodexBindingStart {
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

export class CodexOAuthBindingService {
  private readonly fetcher: CodexOauthFetch;
  private readonly nowMs: () => number;

  constructor(private readonly options: CodexOAuthBindingServiceOptions) {
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

  async generateBindingSession(): Promise<CodexBindingStart> {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = randomBytes(32).toString('hex');
    await this.options.sessionStore.put({
      state,
      codeVerifier,
      expiresAtMs: this.nowMs() + CODEX_BINDING_SESSION_TTL_MS,
    });
    return { authorizeUrl: buildAuthorizeUrl({ state, codeChallenge }), state };
  }

  async completeBinding(input: { readonly state: string; readonly code: string }): Promise<CodexCredentialEnvelope> {
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
      throw codexOauthError('STATE_INVALID');
    }
    if (typeof input.code !== 'string' || input.code.length < 16 || input.code.length > 2_048) {
      throw codexOauthError('CODE_INVALID');
    }
    const session = await this.options.sessionStore.take(input.state);
    if (!session) throw codexOauthError('SESSION_NOT_FOUND');
    // Defense in depth: the session is only usable when the caller's state
    // matches it exactly, compared in constant time.
    if (!constantTimeEqualText(session.state, input.state)) throw codexOauthError('SESSION_NOT_FOUND');
    if (this.nowMs() > session.expiresAtMs) throw codexOauthError('SESSION_EXPIRED');

    const form = `grant_type=authorization_code&client_id=${encodeURIComponent(CODEX_OAUTH_CLIENT_ID)}&code=${encodeURIComponent(input.code)}&code_verifier=${encodeURIComponent(session.codeVerifier)}&redirect_uri=${encodeURIComponent(CODEX_OAUTH_REDIRECT_URI)}`;
    let response: Response;
    try {
      response = await this.fetcher(new URL(CODEX_OAUTH_TOKEN_ENDPOINT), {
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
    const tokens = parseTokenResponse(body);
    if (tokens.idToken === null) throw codexOauthError('TOKEN_RESPONSE_INVALID');
    const claims = parseIdTokenClaims(tokens.idToken, this.nowMs());
    const nowMs = this.nowMs();
    return Object.freeze({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt:
        tokens.expiresInSeconds === null ? null : new Date(nowMs + tokens.expiresInSeconds * 1_000).toISOString(),
      clientId: CODEX_OAUTH_CLIENT_ID,
      email: claims.email,
      chatgptAccountId: claims.chatgptAccountId,
      chatgptUserId: claims.chatgptUserId,
      planType: claims.planType,
    });
  }
}
