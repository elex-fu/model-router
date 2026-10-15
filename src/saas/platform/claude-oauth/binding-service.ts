import { randomBytes } from 'node:crypto';
import {
  buildAuthorizeUrl,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_REDIRECT_URI,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_OAUTH_TOKEN_USER_AGENT,
  claudeOauthError,
  constantTimeEqualText,
  createPkcePair,
} from './oauth.js';

/**
 * R5 Claude OAuth binding service (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5). Pure logic plus
 * an injectable fetch, following the codex binding-service contract: the
 * platform console generates an authorize URL (the operator completes it in
 * a local browser against the platform.claude.com code callback), pastes the
 * resulting authorization code back, and this service exchanges it for the
 * OAuth material the caller then seals through the existing credential
 * envelope path. The Claude token endpoint speaks JSON (not form-urlencoded)
 * and answers `organization.uuid` + `account{uuid,email_address}` directly,
 * so no separate organization resolution is needed on this path. Token
 * material never leaves the process except to the fixed https token
 * endpoint, is never logged, and is never embedded in error messages.
 */

/** Binding sessions live for 30 minutes: enough for a human browser round trip. */
export const CLAUDE_BINDING_SESSION_TTL_MS = 30 * 60_000;
export const CLAUDE_BINDING_TOKEN_TIMEOUT_MS = 60_000;
export const CLAUDE_BINDING_MAX_RESPONSE_BYTES = 32_768;

export interface ClaudeCredentialEnvelope {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO timestamp derived from expires_in; null when the endpoint gave none. */
  readonly expiresAt: string | null;
  readonly clientId: string;
  readonly organizationUuid: string;
  readonly accountUuid: string | null;
  readonly email: string | null;
}

export interface ClaudeBindingSession {
  readonly state: string;
  readonly codeVerifier: string;
  readonly expiresAtMs: number;
}

/**
 * Storage for binding sessions. `take` must remove the session (single-use
 * state); production may swap the in-memory implementation for a shared
 * store without touching the service.
 */
export interface BindingSessionStore {
  put(session: ClaudeBindingSession): Promise<void>;
  take(state: string): Promise<ClaudeBindingSession | null>;
}

interface StoredEntry {
  readonly session: ClaudeBindingSession;
  expiresAtMs: number;
}

/** In-memory single-use binding session store with TTL sweep on every access. */
export class InMemoryBindingSessionStore implements BindingSessionStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(session: ClaudeBindingSession): Promise<void> {
    this.sweep(this.now());
    this.entries.set(session.state, { session, expiresAtMs: session.expiresAtMs });
    if (this.entries.size > 1_024) {
      // Bound the map even under a start-request flood; oldest state wins.
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
  }

  async take(state: string): Promise<ClaudeBindingSession | null> {
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

export type ClaudeOauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface ClaudeOAuthBindingServiceOptions {
  readonly sessionStore: BindingSessionStore;
  /** Test/custom seam; production uses the global fetch against the fixed endpoint. */
  readonly fetch?: ClaudeOauthFetch;
  readonly nowMs?: () => number;
}

export interface ClaudeBindingStart {
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

function printableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}

function parseTokenResponse(body: unknown): {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number | null;
  readonly organizationUuid: string | null;
  readonly accountUuid: string | null;
  readonly email: string | null;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw claudeOauthError('TOKEN_RESPONSE_INVALID');
  }
  const record = body as Record<string, unknown>;
  const accessToken = tokenText(record.access_token);
  if (accessToken === null) throw claudeOauthError('TOKEN_RESPONSE_INVALID');
  const refreshToken = tokenText(record.refresh_token);
  if (refreshToken === null) throw claudeOauthError('TOKEN_RESPONSE_INVALID');
  let expiresInSeconds: number | null = null;
  if (record.expires_in !== undefined) {
    const raw = record.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 31_536_000) {
      throw claudeOauthError('TOKEN_RESPONSE_INVALID');
    }
    expiresInSeconds = parsed;
  }
  const organization = record.organization;
  const organizationUuid =
    organization !== null && typeof organization === 'object' && !Array.isArray(organization)
      ? printableText((organization as Record<string, unknown>).uuid, 128)
      : null;
  const account = record.account;
  let accountUuid: string | null = null;
  let email: string | null = null;
  if (account !== null && typeof account === 'object' && !Array.isArray(account)) {
    const accountRecord = account as Record<string, unknown>;
    accountUuid = printableText(accountRecord.uuid, 128);
    email = printableText(accountRecord.email_address, 320);
  }
  return { accessToken, refreshToken, expiresInSeconds, organizationUuid, accountUuid, email };
}

export class ClaudeOAuthBindingService {
  private readonly fetcher: ClaudeOauthFetch;
  private readonly nowMs: () => number;

  constructor(private readonly options: ClaudeOAuthBindingServiceOptions) {
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

  async generateBindingSession(): Promise<ClaudeBindingStart> {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = randomBytes(32).toString('hex');
    await this.options.sessionStore.put({
      state,
      codeVerifier,
      expiresAtMs: this.nowMs() + CLAUDE_BINDING_SESSION_TTL_MS,
    });
    return { authorizeUrl: buildAuthorizeUrl({ state, codeChallenge }), state };
  }

  async completeBinding(input: { readonly state: string; readonly code: string }): Promise<ClaudeCredentialEnvelope> {
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
      throw claudeOauthError('STATE_INVALID');
    }
    if (typeof input.code !== 'string' || input.code.length < 16 || input.code.length > 2_048) {
      throw claudeOauthError('CODE_INVALID');
    }
    const session = await this.options.sessionStore.take(input.state);
    if (!session) throw claudeOauthError('SESSION_NOT_FOUND');
    // Defense in depth: the session is only usable when the caller's state
    // matches it exactly, compared in constant time.
    if (!constantTimeEqualText(session.state, input.state)) throw claudeOauthError('SESSION_NOT_FOUND');
    if (this.nowMs() > session.expiresAtMs) throw claudeOauthError('SESSION_EXPIRED');

    // The Claude token endpoint speaks JSON (sub2api's ExchangeCodeForToken).
    const requestBody = JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      code: input.code,
      redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
      code_verifier: session.codeVerifier,
    });
    let response: Response;
    try {
      response = await this.fetcher(new URL(CLAUDE_OAUTH_TOKEN_ENDPOINT), {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'user-agent': CLAUDE_OAUTH_TOKEN_USER_AGENT,
        },
        body: requestBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(CLAUDE_BINDING_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw claudeOauthError('TOKEN_EXCHANGE_FAILED');
    }
    if (response.status < 200 || response.status >= 300) {
      throw claudeOauthError('TOKEN_EXCHANGE_FAILED');
    }

    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > CLAUDE_BINDING_MAX_RESPONSE_BYTES) throw new Error('too large');
      body = JSON.parse(text);
    } catch {
      throw claudeOauthError('TOKEN_RESPONSE_INVALID');
    }
    const tokens = parseTokenResponse(body);
    if (tokens.organizationUuid === null) throw claudeOauthError('TOKEN_RESPONSE_INVALID');
    const nowMs = this.nowMs();
    return Object.freeze({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt:
        tokens.expiresInSeconds === null ? null : new Date(nowMs + tokens.expiresInSeconds * 1_000).toISOString(),
      clientId: CLAUDE_OAUTH_CLIENT_ID,
      organizationUuid: tokens.organizationUuid,
      accountUuid: tokens.accountUuid,
      email: tokens.email,
    });
  }
}
