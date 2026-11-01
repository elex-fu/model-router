import { createHash } from 'node:crypto';
import type { OAuthAccount, OAuthTokenUpdate } from './oauth-accounts.js';

/**
 * Classic-mode OAuth refresh engine (capability plan task CS1,
 * docs/standalone-relay-capability-plan-2026-10-30.md D1).
 *
 * The request building, response parsing and failure classification are
 * ported from the SaaS refresh worker (src/saas/supply/oauth-token-refresh-
 * worker.ts) so both planes keep identical provider semantics, but this
 * module is deliberately saas-free: no PG, no Redis, no src/saas imports.
 * Scheduling state lives on the JSON-backed OAuthAccountStore.
 *
 * Provider constants are COPIES of the public OAuth client constants in
 * src/saas/platform/codex-oauth/oauth.ts (lines 19-36) — classic must not
 * import from the saas tree, so the values are duplicated here with this
 * comment as the drift anchor. Nothing here is confidential (RFC 6749 §2.1
 * public clients).
 */

export const OAUTH_REFRESH_TIMEOUT_MS = 5_000;
export const OAUTH_REFRESH_MAX_RESPONSE_BYTES = 65_536;
export const OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS = 31_536_000;
/** Refresh when less than this remains (SaaS schedules at expires_in × 0.8). */
export const OAUTH_REFRESH_DEFAULT_MARGIN_MS = 10 * 60_000;
export const OAUTH_REFRESH_MIN_BACKOFF_MS = 60_000;
export const OAUTH_REFRESH_MAX_BACKOFF_MS = 24 * 60 * 60_000;

/**
 * Terminal RFC 6749 §5.2 / provider-specific rejections: the grant is gone
 * (revoked, expired or rotated elsewhere). An account that fails with one of
 * these is marked 'revoked' and never auto-refreshed again.
 */
export const NON_RETRYABLE_OAUTH_ERRORS: readonly string[] = Object.freeze([
  'invalid_grant',
  'refresh_token_reused',
  'token_expired',
  'app_session_terminated',
  'refresh_token_invalidated',
]);

// --- Provider registry (copied from src/saas/platform/codex-oauth/oauth.ts lines 19-36) ---

const CODEX_OAUTH_TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Refresh scope drops offline_access — the refresh token already exists. */
const CODEX_OAUTH_REFRESH_SCOPE = 'openid profile email';
const CODEX_OAUTH_USER_AGENT = 'codex_cli_rs/0.146.0 (Mac OS X 15.0; arm64) Terminal';

const GITHUB_COPILOT_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const DEFAULT_USER_AGENT = 'model-router';

export interface OAuthRefreshProviderSpec {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** null sends no scope parameter (the endpoint keeps the original grant's scopes). */
  readonly refreshScope: string | null;
  readonly userAgent: string;
}

const CODEX_OAUTH_REFRESH_PROVIDER: OAuthRefreshProviderSpec = Object.freeze({
  tokenEndpoint: CODEX_OAUTH_TOKEN_ENDPOINT,
  clientId: CODEX_OAUTH_CLIENT_ID,
  refreshScope: CODEX_OAUTH_REFRESH_SCOPE,
  userAgent: CODEX_OAUTH_USER_AGENT,
});

/** Optional per-account provider binding fields the generic passthrough understands. */
interface ProviderBindingFields {
  tokenEndpoint?: unknown;
  clientId?: unknown;
  refreshScope?: unknown;
  userAgent?: unknown;
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the refresh binding for one provider/account pair. Only
 * compile-time-fixed public bindings are refreshed (fail-closed, never
 * guessed): 'codex_oauth' always; every other provider goes through the
 * generic passthrough and refreshes only when the account itself carries the
 * binding (clientId plus, for github_copilot, GitHub's token endpoint as the
 * default). Otherwise null — the account is cleanly unsupported.
 */
export function resolveOAuthRefreshProviderSpec(
  provider: string,
  account: OAuthAccount,
): OAuthRefreshProviderSpec | null {
  if (provider === 'codex_oauth') return CODEX_OAUTH_REFRESH_PROVIDER;
  const binding = account as OAuthAccount & ProviderBindingFields;
  const clientId = typeof binding.clientId === 'string' && binding.clientId.length > 0 ? binding.clientId : null;
  if (clientId === null) return null;
  const endpointCandidate =
    typeof binding.tokenEndpoint === 'string' && binding.tokenEndpoint.length > 0 ? binding.tokenEndpoint : null;
  const endpoint = endpointCandidate ?? (provider === 'github_copilot' ? GITHUB_COPILOT_TOKEN_ENDPOINT : null);
  if (endpoint === null || !httpsUrl(endpoint)) return null;
  return {
    tokenEndpoint: endpoint,
    clientId,
    refreshScope:
      typeof binding.refreshScope === 'string' && binding.refreshScope.length > 0 ? binding.refreshScope : null,
    userAgent:
      typeof binding.userAgent === 'string' && binding.userAgent.length > 0 ? binding.userAgent : DEFAULT_USER_AGENT,
  };
}

// --- Refresh result taxonomy ---

export type RefreshFailureErrorCode =
  /** No fixed refresh binding for this provider/account (not an account fault). */
  | 'provider_unsupported'
  /** The account carries no usable refresh token (not an account fault). */
  | 'account_unrefreshable'
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'provider_unavailable'
  /** 400/401/403 from the token endpoint; see oauthError for the RFC 6749 code. */
  | 'endpoint_rejected'
  /** 3xx redirect or unexpected status the engine will not follow. */
  | 'endpoint_unsupported'
  /** 2xx whose body is not a valid token response. */
  | 'response_invalid';

export interface RefreshSuccess {
  readonly state: 'success';
  readonly accessToken: string;
  /** null means the endpoint did not rotate the refresh token; retain the old one. */
  readonly refreshToken: string | null;
  /** id_token when the endpoint returns one (parsed, not persisted by the engine). */
  readonly idToken: string | null;
  /** null means the endpoint gave no expiry. */
  readonly expiresInSeconds: number | null;
}

export interface RefreshFailure {
  readonly state: 'failure';
  readonly retryable: boolean;
  /** true only for the revoked-class (NON_RETRYABLE_OAUTH_ERRORS) rejections. */
  readonly terminal: boolean;
  readonly errorCode: RefreshFailureErrorCode;
  /** RFC 6749 §5.2 error code from the rejection body, or null. */
  readonly oauthError: string | null;
  readonly httpStatus: number | null;
}

export type RefreshResult = RefreshSuccess | RefreshFailure;

export type OAuthRefreshFetch = (url: string, init: RequestInit) => Promise<Response>;

function failure(
  errorCode: RefreshFailureErrorCode,
  retryable: boolean,
  terminal: boolean,
  oauthError: string | null,
  httpStatus: number | null,
): RefreshFailure {
  return { state: 'failure', retryable, terminal, errorCode, oauthError, httpStatus };
}

/** Printable ASCII token text (RFC 6749 §1.4 vsvar); never logged. */
function tokenText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Single refresh_token grant call against the provider token endpoint.
 * Ported from the SaaS worker's requestOauthTokenRefresh: form-urlencoded
 * grant, client_id, scope narrowing when the binding carries one, pinned
 * User-Agent, manual redirects and the bounded response contract. Never
 * throws; every failure mode is a classified RefreshFailure.
 */
export async function refreshOAuthAccount(input: {
  account: OAuthAccount;
  provider: string;
  fetchImpl?: OAuthRefreshFetch;
  nowMs?: number;
}): Promise<RefreshResult> {
  const { account, provider } = input;
  const fetcher = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const spec = resolveOAuthRefreshProviderSpec(provider, account);
  if (spec === null) return failure('provider_unsupported', false, false, null, null);
  const refreshToken = account.refreshToken;
  if (typeof refreshToken !== 'string' || tokenText(refreshToken, 4096) === null) {
    return failure('account_unrefreshable', false, false, null, null);
  }

  const form =
    `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}` +
    `&client_id=${encodeURIComponent(spec.clientId)}` +
    (spec.refreshScope === null ? '' : `&scope=${encodeURIComponent(spec.refreshScope)}`);
  const deadline = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
  let response: Response;
  try {
    deadline.throwIfAborted();
    response = await fetcher(spec.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': spec.userAgent,
      },
      body: form,
      redirect: 'manual',
      signal: deadline,
    });
  } catch {
    return failure(deadline.aborted ? 'timeout' : 'network_error', true, false, null, null);
  }

  if (response.status < 200 || response.status >= 300) {
    if (response.status >= 300 && response.status < 400) {
      return failure('endpoint_unsupported', false, false, null, response.status);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      const oauthError = await rejectionCode(response);
      const terminal = oauthError !== null && NON_RETRYABLE_OAUTH_ERRORS.includes(oauthError);
      return failure('endpoint_rejected', false, terminal, oauthError, response.status);
    }
    if (response.status === 429) return failure('rate_limited', true, false, null, response.status);
    if (response.status >= 500) return failure('provider_unavailable', true, false, null, response.status);
    return failure('endpoint_unsupported', false, false, null, response.status);
  }

  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== undefined && contentType !== 'application/json') {
    return failure('response_invalid', false, false, null, response.status);
  }
  let bytes: Uint8Array;
  try {
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d{1,12}$/.test(declared) && Number(declared) > OAUTH_REFRESH_MAX_RESPONSE_BYTES) {
      return failure('response_invalid', false, false, null, response.status);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > OAUTH_REFRESH_MAX_RESPONSE_BYTES) {
      return failure('response_invalid', false, false, null, response.status);
    }
    bytes = new Uint8Array(buffer);
  } catch {
    return failure(deadline.aborted ? 'timeout' : 'response_invalid', deadline.aborted, false, null, response.status);
  }
  return parseTokenResponse(bytes, response.status);
}

/** Best-effort RFC 6749 §5.2 error-code extraction from a rejection body; never throws. */
async function rejectionCode(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text.length > OAUTH_REFRESH_MAX_RESPONSE_BYTES) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    return tokenText(parsed.error, 64);
  } catch {
    return null;
  }
}

function parseTokenResponse(bytes: Uint8Array, httpStatus: number): RefreshResult {
  let body: Record<string, unknown>;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return failure('response_invalid', false, false, null, httpStatus);
    body = parsed;
  } catch {
    return failure('response_invalid', false, false, null, httpStatus);
  }
  const accessToken = tokenText(body.access_token, 4096);
  if (accessToken === null) return failure('response_invalid', false, false, null, httpStatus);
  let refreshToken: string | null = null;
  if (body.refresh_token !== undefined) {
    refreshToken = tokenText(body.refresh_token, 4096);
    if (refreshToken === null) return failure('response_invalid', false, false, null, httpStatus);
  }
  let idToken: string | null = null;
  if (body.id_token !== undefined) {
    idToken = tokenText(body.id_token, 32_768);
    if (idToken === null) return failure('response_invalid', false, false, null, httpStatus);
  }
  let expiresInSeconds: number | null = null;
  if (body.expires_in !== undefined) {
    const raw = body.expires_in;
    const parsed =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS) {
      return failure('response_invalid', false, false, null, httpStatus);
    }
    expiresInSeconds = parsed;
  }
  return { state: 'success', accessToken, refreshToken, idToken, expiresInSeconds };
}

// --- Backoff ---

function jitterFraction(key: string): number {
  const digest = createHash('sha256').update('oauth-refresh-jitter').update(key).digest();
  const unit = digest.readUInt32BE(0) / 0xffffffff;
  return (unit * 2 - 1) * 0.1;
}

/** Exponential backoff 60s → 24h with deterministic ±10% jitter keyed by account. */
export function oauthRefreshBackoffMs(
  key: string,
  failureCount: number,
  options: { minBackoffMs?: number; maxBackoffMs?: number } = {},
): number {
  const min = options.minBackoffMs ?? OAUTH_REFRESH_MIN_BACKOFF_MS;
  const max = options.maxBackoffMs ?? OAUTH_REFRESH_MAX_BACKOFF_MS;
  const attempts = Math.max(1, failureCount);
  let base = min;
  for (let index = 1; index < attempts; index += 1) {
    base = Math.min(max, base * 2);
    if (base >= max) break;
  }
  const jittered = Math.round(Math.min(max, base) * (1 + jitterFraction(key)));
  return Math.min(max, Math.max(min, jittered));
}

// --- Engine ---

/** The part of OAuthAccountStore the engine needs (satisfied by the real store and test fakes). */
export interface OAuthRefreshAccountStore {
  get(provider: string, id: string): OAuthAccount | undefined;
  getDefault(provider: string): OAuthAccount | undefined;
  list(provider?: string): OAuthAccount[];
  updateTokens(provider: string, id: string, update: OAuthTokenUpdate): OAuthAccount | undefined;
}

export interface OAuthRefreshEngineOptions {
  /** Refresh when less than this remains; default 10 minutes. */
  readonly refreshMarginMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly fetchImpl?: OAuthRefreshFetch;
  readonly nowMs?: () => number;
  readonly onError?: (error: unknown, context: { provider: string; accountId: string }) => void;
}

function reauthenticationRequired(provider: string): Error {
  return new Error(`Account token for ${provider} expired; re-authentication required`);
}

function isRevoked(account: OAuthAccount): boolean {
  return account.status === 'revoked';
}

/**
 * Refresh-before-expiry engine over the JSON-backed OAuth account store.
 * Singleflight per account: concurrent resolve/sweep calls never issue two
 * refresh grants for the same account. Revoked accounts are never refreshed
 * again; retryable failures back off exponentially; the stored refresh token
 * is only overwritten when the endpoint actually returns a new one.
 */
export class OAuthRefreshEngine {
  private readonly inFlight = new Map<string, Promise<void>>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly refreshMarginMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly store: OAuthRefreshAccountStore,
    private readonly options: OAuthRefreshEngineOptions = {},
  ) {
    this.refreshMarginMs = options.refreshMarginMs ?? OAUTH_REFRESH_DEFAULT_MARGIN_MS;
    this.minBackoffMs = options.minBackoffMs ?? OAUTH_REFRESH_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? OAUTH_REFRESH_MAX_BACKOFF_MS;
  }

  /**
   * Returns a live access token for the account, refreshing first when the
   * stored token is inside the expiry margin. Throws the re-authentication
   * error for revoked accounts and the no-account error when none is stored.
   */
  async resolveAccessToken(provider: string, accountId?: string): Promise<string> {
    const account = this.getAccount(provider, accountId);
    if (account === undefined) throw new Error(`No authenticated account for ${provider}`);
    if (isRevoked(account)) throw reauthenticationRequired(provider);
    if (!this.shouldRefresh(account) || this.withinBackoff(account)) return account.accessToken;
    await this.runExclusive(provider, account.id);
    const updated = this.getAccount(provider, accountId);
    if (updated === undefined) throw new Error(`No authenticated account for ${provider}`);
    if (isRevoked(updated)) throw reauthenticationRequired(provider);
    return updated.accessToken;
  }

  /** Starts the proactive sweep loop (an immediate first sweep refreshes expiring accounts at boot). */
  start(intervalMs: number = 60_000): void {
    if (this.sweepTimer !== undefined || this.closed) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.sweepTimer.unref?.();
    void this.sweep();
  }

  /** One proactive pass over every stored account (singleflight applies). */
  async sweep(): Promise<void> {
    if (this.closed) return;
    const accounts = this.store.list();
    for (const account of accounts) {
      if (this.closed) return;
      if (isRevoked(account)) continue;
      if (!this.shouldRefresh(account) || this.withinBackoff(account)) continue;
      try {
        await this.runExclusive(account.provider, account.id);
      } catch {
        // refreshAccount reports unexpected errors through onError; a sweep
        // must never abort the remaining accounts.
      }
    }
  }

  /** Stops the scheduled loop and drains in-flight refreshes. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private getAccount(provider: string, accountId?: string): OAuthAccount | undefined {
    return accountId === undefined ? this.store.getDefault(provider) : this.store.get(provider, accountId);
  }

  private now(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  /**
   * A persisted 'refreshing' stamp from a crashed process is reclaimed as
   * active after OAUTH_REFRESH_STALE_REFRESHING_MS (mirrors the SaaS
   * stale-'refreshing' reclamation predicate).
   */
  private shouldRefresh(account: OAuthAccount): boolean {
    if (account.expiresAt === undefined) return false;
    if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) return false;
    if (resolveOAuthRefreshProviderSpec(account.provider, account) === null) return false;
    return account.expiresAt <= this.now() + this.refreshMarginMs;
  }

  private withinBackoff(account: OAuthAccount): boolean {
    return account.nextRetryAt !== undefined && account.nextRetryAt > this.now();
  }

  private runExclusive(provider: string, accountId: string): Promise<void> {
    const key = `${provider}:${accountId}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const run = this.refreshAccount(provider, accountId).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async refreshAccount(provider: string, accountId: string): Promise<void> {
    const account = this.store.get(provider, accountId);
    if (account === undefined || isRevoked(account)) return;
    if (!this.shouldRefresh(account) || this.withinBackoff(account)) return;

    // Crash-observability stamp before the network call: a crash in this
    // window leaves 'refreshing' on disk, which loads as active (a crashed
    // process's in-flight grant is gone, so the next sweep simply retries;
    // singleflight prevents concurrent in-process retries).
    this.updateQuiet(provider, accountId, { status: 'refreshing' });

    let result: RefreshResult;
    try {
      result = await refreshOAuthAccount({
        account,
        provider,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (error) {
      this.options.onError?.(error, { provider, accountId });
      this.recordFailure(provider, accountId, account, this.maxBackoffMs);
      return;
    }

    if (result.state === 'success') {
      const now = this.now();
      this.updateQuiet(provider, accountId, {
        accessToken: result.accessToken,
        ...(result.refreshToken !== null ? { refreshToken: result.refreshToken } : {}),
        ...(result.expiresInSeconds !== null ? { expiresAt: now + result.expiresInSeconds * 1000 } : {}),
        status: 'active',
        lastRefreshAt: now,
        failureCount: 0,
        nextRetryAt: null,
      });
      return;
    }
    if (result.terminal) {
      this.updateQuiet(provider, accountId, {
        status: 'revoked',
        lastRefreshAt: this.now(),
        failureCount: (account.failureCount ?? 0) + 1,
        nextRetryAt: null,
      });
      return;
    }
    if (result.errorCode === 'provider_unsupported' || result.errorCode === 'account_unrefreshable') {
      // Not an account fault and nothing to schedule: the account cannot be
      // refreshed in its current shape; restore active so the stamp is clean.
      this.updateQuiet(provider, accountId, { status: 'active' });
      return;
    }
    const backoffMs = result.retryable
      ? oauthRefreshBackoffMs(`${provider}:${accountId}`, (account.failureCount ?? 0) + 1, {
          minBackoffMs: this.minBackoffMs,
          maxBackoffMs: this.maxBackoffMs,
        })
      : this.maxBackoffMs;
    this.recordFailure(provider, accountId, account, backoffMs);
  }

  private recordFailure(provider: string, accountId: string, account: OAuthAccount, backoffMs: number): void {
    const now = this.now();
    this.updateQuiet(provider, accountId, {
      status: 'active',
      lastRefreshAt: now,
      failureCount: (account.failureCount ?? 0) + 1,
      nextRetryAt: now + backoffMs,
    });
  }

  /** Store writes must never take down request-path token resolution. */
  private updateQuiet(provider: string, accountId: string, update: OAuthTokenUpdate): void {
    try {
      this.store.updateTokens(provider, accountId, update);
    } catch (error) {
      this.options.onError?.(error, { provider, accountId });
    }
  }
}
