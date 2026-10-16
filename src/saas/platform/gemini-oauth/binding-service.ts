import { randomBytes } from 'node:crypto';
import {
  GEMINI_CLI_USER_AGENT,
  GEMINI_CODE_ASSIST_DEFAULT_TIER_ID,
  GEMINI_CODE_ASSIST_METADATA,
} from '../../gateway/gemini/constants.js';
import {
  buildAuthorizeUrl,
  constantTimeEqualText,
  createPkcePair,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_TOKEN_ENDPOINT,
  GEMINI_OAUTH_TOKEN_USER_AGENT,
  geminiOauthError,
  resolveGeminiOauthClientSecret,
} from './oauth.js';

/**
 * F4 Gemini OAuth binding service (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R8b; port of sub2api's
 * service/gemini_oauth_service.go + repository/geminicli_codeassist_client.go).
 * Pure logic plus an injectable fetch, following the claude binding-service
 * contract: the platform console generates an authorize URL (the operator
 * completes it in a local browser against the codeassist.google.com code
 * callback), pastes the resulting authorization code back, and this service
 *
 * 1. exchanges it at oauth2.googleapis.com/token (form-urlencoded; the
 *    installed-app client_secret arrives from the environment, never a
 *    source literal);
 * 2. resolves the Cloud Code Assist project through the CLI's
 *    `v1internal:loadCodeAssist` call (the cloudaicompanionProject the
 *    v1internal dispatch wrap needs) and the tier from its allowed tiers;
 * 3. onboards the user (`v1internal:onboardUser`, tier LEGACY) when
 *    loadCodeAssist reports no current tier — sub2api's flow for accounts
 *    that have never used the CLI.
 *
 * Token material never leaves the process except to the fixed https
 * endpoints, is never logged, and is never embedded in error messages.
 */

/** Binding sessions live for 30 minutes: enough for a human browser round trip. */
export const GEMINI_BINDING_SESSION_TTL_MS = 30 * 60_000;
export const GEMINI_BINDING_TOKEN_TIMEOUT_MS = 60_000;
export const GEMINI_BINDING_MAX_RESPONSE_BYTES = 32_768;

export interface GeminiCredentialEnvelope {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO timestamp derived from expires_in; null when the endpoint gave none. */
  readonly expiresAt: string | null;
  readonly clientId: string;
  /** The Cloud Code Assist project (cloudaicompanionProject from loadCodeAssist). */
  readonly projectId: string;
  /** Canonical tier id (normalized from the loadCodeAssist allowed tiers). */
  readonly tierId: string | null;
  readonly email: string | null;
}

export interface GeminiBindingSession {
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
  put(session: GeminiBindingSession): Promise<void>;
  take(state: string): Promise<GeminiBindingSession | null>;
}

interface StoredEntry {
  readonly session: GeminiBindingSession;
  expiresAtMs: number;
}

/** In-memory single-use binding session store with TTL sweep on every access. */
export class InMemoryBindingSessionStore implements BindingSessionStore {
  private readonly entries = new Map<string, StoredEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(session: GeminiBindingSession): Promise<void> {
    this.sweep(this.now());
    this.entries.set(session.state, { session, expiresAtMs: session.expiresAtMs });
    if (this.entries.size > 1_024) {
      // Bound the map even under a start-request flood; oldest state wins.
      const first = this.entries.keys().next();
      if (!first.done) this.entries.delete(first.value);
    }
  }

  async take(state: string): Promise<GeminiBindingSession | null> {
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

export type GeminiOauthFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface GeminiOAuthBindingServiceOptions {
  readonly sessionStore: BindingSessionStore;
  /** Test/custom seam; production uses the global fetch against the fixed endpoints. */
  readonly fetch?: GeminiOauthFetch;
  readonly nowMs?: () => number;
  /** Injectable client secret; defaults to the environment variable. */
  readonly clientSecret?: string | null;
  /** Injectable code assist base URL; defaults to the pinned cloudcode-pa endpoint. */
  readonly codeAssistBaseUrl?: string;
}

export interface GeminiBindingStart {
  readonly authorizeUrl: URL;
  readonly state: string;
}

/** Facts resolved from the loadCodeAssist call. */
export interface GeminiCodeAssistResolution {
  readonly projectId: string;
  readonly tierId: string | null;
}

function tokenText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tierIdText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9_/-]+$/.test(trimmed) ? trimmed : null;
}

function parseTokenResponse(body: unknown): {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number | null;
} {
  if (!isRecord(body)) throw geminiOauthError('TOKEN_RESPONSE_INVALID');
  const accessToken = tokenText(body.access_token);
  if (accessToken === null) throw geminiOauthError('TOKEN_RESPONSE_INVALID');
  const refreshToken = tokenText(body.refresh_token);
  let expiresInSeconds: number | null = null;
  if (body.expires_in !== undefined) {
    const raw = body.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 31_536_000) {
      throw geminiOauthError('TOKEN_RESPONSE_INVALID');
    }
    expiresInSeconds = parsed;
  }
  return { accessToken, refreshToken, expiresInSeconds };
}

/**
 * The loadCodeAssist resolution (sub2api fetchProjectID + extractTierIDFrom
 * AllowedTiers): the cloudaicompanionProject is the dispatch project; the
 * tier prefers paidTier over currentTier, then the default allowed tier,
 * then the first non-empty one. `null` tier means the account still needs
 * onboarding.
 */
export function parseLoadCodeAssistResponse(body: unknown): GeminiCodeAssistResolution | null {
  if (!isRecord(body)) return null;
  const projectId = typeof body.cloudaicompanionProject === 'string' ? body.cloudaicompanionProject.trim() : '';
  if (projectId.length === 0 || projectId.length > 128) return null;
  const paidTier = isRecord(body.paidTier) ? tierIdText(body.paidTier.id) : null;
  const currentTier = isRecord(body.currentTier) ? tierIdText(body.currentTier.id) : null;
  let allowedTier: string | null = null;
  if (Array.isArray(body.allowedTiers)) {
    let fallback: string | null = null;
    for (const entry of body.allowedTiers) {
      if (!isRecord(entry)) continue;
      const id = tierIdText(entry.id);
      if (id === null) continue;
      if (entry.isDefault === true && allowedTier === null) allowedTier = id;
      if (fallback === null) fallback = id;
    }
    allowedTier = allowedTier ?? fallback;
  }
  const tierId = paidTier ?? currentTier ?? allowedTier;
  return { projectId, tierId };
}

export class GeminiOAuthBindingService {
  private readonly fetcher: GeminiOauthFetch;
  private readonly nowMs: () => number;
  private readonly clientSecret: string | null;
  private readonly codeAssistBaseUrl: string;

  constructor(private readonly options: GeminiOAuthBindingServiceOptions) {
    if (
      !options?.sessionStore ||
      typeof options.sessionStore.put !== 'function' ||
      typeof options.sessionStore.take !== 'function'
    ) {
      throw new TypeError('sessionStore is required');
    }
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.clientSecret = options.clientSecret === undefined ? resolveGeminiOauthClientSecret() : options.clientSecret;
    this.codeAssistBaseUrl = options.codeAssistBaseUrl ?? 'https://cloudcode-pa.googleapis.com';
  }

  async generateBindingSession(): Promise<GeminiBindingStart> {
    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = randomBytes(32).toString('hex');
    await this.options.sessionStore.put({
      state,
      codeVerifier,
      expiresAtMs: this.nowMs() + GEMINI_BINDING_SESSION_TTL_MS,
    });
    return { authorizeUrl: buildAuthorizeUrl({ state, codeChallenge }), state };
  }

  async completeBinding(input: { readonly state: string; readonly code: string }): Promise<GeminiCredentialEnvelope> {
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9._-]{16,256}$/.test(input.state)) {
      throw geminiOauthError('STATE_INVALID');
    }
    if (typeof input.code !== 'string' || input.code.length < 16 || input.code.length > 2_048) {
      throw geminiOauthError('CODE_INVALID');
    }
    const session = await this.options.sessionStore.take(input.state);
    if (!session) throw geminiOauthError('SESSION_NOT_FOUND');
    // Defense in depth: the session is only usable when the caller's state
    // matches it exactly, compared in constant time.
    if (!constantTimeEqualText(session.state, input.state)) throw geminiOauthError('SESSION_NOT_FOUND');
    if (this.nowMs() > session.expiresAtMs) throw geminiOauthError('SESSION_EXPIRED');
    if (this.clientSecret === null) throw geminiOauthError('CLIENT_SECRET_MISSING');

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: this.clientSecret,
      code: input.code,
      code_verifier: session.codeVerifier,
      redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    });
    let response: Response;
    try {
      response = await this.fetcher(new URL(GEMINI_OAUTH_TOKEN_ENDPOINT), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': GEMINI_OAUTH_TOKEN_USER_AGENT,
        },
        body: form.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(GEMINI_BINDING_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw geminiOauthError('TOKEN_EXCHANGE_FAILED');
    }
    if (response.status < 200 || response.status >= 300) {
      try {
        void response.body?.cancel();
      } catch {
        // The body is neither consumed nor surfaced.
      }
      throw geminiOauthError('TOKEN_EXCHANGE_FAILED');
    }
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > GEMINI_BINDING_MAX_RESPONSE_BYTES) throw new Error('too large');
      body = JSON.parse(text);
    } catch {
      throw geminiOauthError('TOKEN_RESPONSE_INVALID');
    }
    const tokens = parseTokenResponse(body);
    if (tokens.refreshToken === null) throw geminiOauthError('TOKEN_RESPONSE_INVALID');

    let resolution: GeminiCodeAssistResolution | null = null;
    try {
      resolution = await this.loadCodeAssist(tokens.accessToken);
    } catch {
      resolution = null;
    }
    if (resolution === null) throw geminiOauthError('PROJECT_RESOLUTION_FAILED');

    let tierId = resolution.tierId;
    if (tierId === null) {
      // The account has never used the CLI: onboard it with the default tier
      // (sub2api's OnboardUser fallback), then re-resolve.
      try {
        await this.onboardUser(tokens.accessToken);
        const reResolved = await this.loadCodeAssist(tokens.accessToken);
        tierId = reResolved?.tierId ?? null;
      } catch {
        tierId = null;
      }
    }

    const nowMs = this.nowMs();
    return Object.freeze({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt:
        tokens.expiresInSeconds === null ? null : new Date(nowMs + tokens.expiresInSeconds * 1_000).toISOString(),
      clientId: GEMINI_OAUTH_CLIENT_ID,
      projectId: resolution.projectId,
      tierId,
      email: null,
    });
  }

  /** POST {base}/v1internal:loadCodeAssist with the CLI metadata block and UA. */
  async loadCodeAssist(accessToken: string): Promise<GeminiCodeAssistResolution | null> {
    return this.codeAssistCall(
      'loadCodeAssist',
      accessToken,
      {
        metadata: { ...GEMINI_CODE_ASSIST_METADATA },
      },
      parseLoadCodeAssistResponse,
    );
  }

  /** POST {base}/v1internal:onboardUser with the default tier id. */
  async onboardUser(accessToken: string): Promise<boolean> {
    const result = await this.codeAssistCall(
      'onboardUser',
      accessToken,
      {
        tierId: GEMINI_CODE_ASSIST_DEFAULT_TIER_ID,
        metadata: { ...GEMINI_CODE_ASSIST_METADATA },
      },
      (body) => (isRecord(body) && body.done === true ? true : null),
    );
    return result === null ? false : result;
  }

  private async codeAssistCall<T>(
    action: 'loadCodeAssist' | 'onboardUser',
    accessToken: string,
    requestBody: Record<string, unknown>,
    parse: (body: unknown) => T | null,
  ): Promise<T | null> {
    const url = new URL(`${this.codeAssistBaseUrl.replace(/\/+$/, '')}/v1internal:${action}`);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': GEMINI_CLI_USER_AGENT,
        },
        body: JSON.stringify(requestBody),
        redirect: 'manual',
        signal: AbortSignal.timeout(GEMINI_BINDING_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw geminiOauthError('PROJECT_RESOLUTION_FAILED');
    }
    if (response.status < 200 || response.status >= 300) {
      try {
        void response.body?.cancel();
      } catch {
        // The body is neither consumed nor surfaced.
      }
      throw geminiOauthError('PROJECT_RESOLUTION_FAILED');
    }
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > GEMINI_BINDING_MAX_RESPONSE_BYTES) throw new Error('too large');
      body = JSON.parse(text);
    } catch {
      throw geminiOauthError('PROJECT_RESOLUTION_FAILED');
    }
    return parse(body);
  }
}
