import { type OAuthRefreshAdapter, resolveAdapter, resolvePassthroughAdapter } from '../oauth-refresh/adapters.js';
import {
  type CoreRefreshErrorCode,
  OAUTH_REFRESH_MAX_BACKOFF_MS,
  OAUTH_REFRESH_MIN_BACKOFF_MS,
  type OAuthRefreshAttempt,
  type OAuthRefreshCommitResult,
  type OAuthRefreshFetch,
  performOAuthRefresh,
  type RefreshableCredential,
  refreshBackoffMs,
  shouldRefresh,
} from '../oauth-refresh/core.js';
import type { OAuthAccount, OAuthTokenUpdate } from './oauth-accounts.js';
import { type OAuthRefreshAccountStore, OAuthRefreshStoreAdapter } from './oauth-refresh-store.js';

export type { OAuthRefreshFetch } from '../oauth-refresh/core.js';
export {
  NON_RETRYABLE_OAUTH_ERRORS,
  OAUTH_REFRESH_MAX_BACKOFF_MS,
  OAUTH_REFRESH_MAX_EXPIRES_IN_SECONDS,
  OAUTH_REFRESH_MAX_RESPONSE_BYTES,
  OAUTH_REFRESH_MIN_BACKOFF_MS,
  OAUTH_REFRESH_TIMEOUT_MS,
} from '../oauth-refresh/core.js';
export type { OAuthRefreshAccountStore } from './oauth-refresh-store.js';

/**
 * Classic-mode OAuth refresh engine (capability plan task CS1,
 * docs/standalone-relay-capability-plan-2026-10-30.md D1).
 *
 * Re-cored (docs/oauth-refresh-engine-unification-plan-20261101.md R1+R2):
 * every internal path — provider resolution, the refresh round-trip, the
 * failure taxonomy and the backoff ladder — now delegates to the neutral
 * core/adapter modules shared with the SaaS refresh worker. This shell keeps
 * only the classic scheduling design: the JSON-backed OAuthAccountStore (via
 * the shape-mapping OAuthRefreshStoreAdapter), the 60s sweep loop and the
 * process-internal singleflight.
 *
 * Semantics union note (the stricter implementation won each divergence):
 * the response byte cap is 4_096 (SaaS), a missing content-type header is
 * rejected (SaaS), token text must be printable 0x21-0x7e (SaaS), a failed
 * body read is a retryable network error (SaaS), token endpoints must be
 * canonical https URLs with no explicit port (SaaS). The failure backoff cap
 * stays 24h (classic) and the revoked-account terminal classification stays
 * classic-only. See the DIVERGENCE comments in src/oauth-refresh/core.ts.
 */

/** Refresh when less than this remains (SaaS schedules at expires_in × 0.8). */
export const OAUTH_REFRESH_DEFAULT_MARGIN_MS = 10 * 60_000;

/**
 * The fixed public OAuth client binding for one provider/account pair.
 * Structurally the neutral core's adapter (fail-closed, never guessed).
 */
export type OAuthRefreshProviderSpec = OAuthRefreshAdapter;

/**
 * Resolves the refresh binding for one provider/account pair. The fixed
 * registry bindings resolve by provider key ('codex_oauth' and the SaaS
 * triple spellings); every other provider goes through the generic
 * passthrough and refreshes only when the account itself carries the binding
 * (clientId plus, for github_copilot, GitHub's token endpoint as the
 * default). Otherwise null — the account is cleanly unsupported.
 */
export function resolveOAuthRefreshProviderSpec(
  provider: string,
  account: OAuthAccount,
): OAuthRefreshProviderSpec | null {
  return resolveAdapter(provider) ?? resolvePassthroughAdapter({ ...account, provider });
}

// --- Refresh result taxonomy (classic public API) ---

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

function failure(
  errorCode: RefreshFailureErrorCode,
  retryable: boolean,
  terminal: boolean,
  oauthError: string | null,
  httpStatus: number | null,
): RefreshFailure {
  return { state: 'failure', retryable, terminal, errorCode, oauthError, httpStatus };
}

/** Maps a core error code onto the classic public failure code. */
function classicErrorCode(code: CoreRefreshErrorCode): RefreshFailureErrorCode {
  switch (code) {
    case 'network_error':
      return 'network_error';
    case 'timeout':
      return 'timeout';
    case 'rate_limited':
      return 'rate_limited';
    case 'provider_unavailable':
      return 'provider_unavailable';
    case 'endpoint_rejected':
      return 'endpoint_rejected';
    case 'adapter_unsupported':
      return 'provider_unsupported';
    case 'credential_invalid':
      return 'account_unrefreshable';
    case 'redirect_rejected':
    case 'endpoint_unsupported':
      return 'endpoint_unsupported';
    case 'response_invalid':
    case 'response_too_large':
      return 'response_invalid';
  }
}

/** Maps a neutral core attempt onto the classic public RefreshResult. */
function classicResult(attempt: OAuthRefreshAttempt): RefreshResult {
  const { outcome, writeback } = attempt;
  if (outcome.kind === 'success' && writeback !== null) {
    return {
      state: 'success',
      accessToken: writeback.accessToken,
      refreshToken: writeback.refreshToken,
      idToken: writeback.idToken,
      expiresInSeconds: writeback.expiresInSeconds,
    };
  }
  const code = outcome.errorCode;
  const errorCode = code === null ? 'response_invalid' : classicErrorCode(code);
  const retryable = outcome.kind === 'retryable';
  const terminal = outcome.kind === 'terminal';
  // The classic taxonomy never attached a transport status or provider code
  // to transport-level failures.
  const isTransport = code === 'network_error' || code === 'timeout';
  return failure(
    errorCode,
    retryable,
    terminal,
    isTransport ? null : outcome.oauthError,
    isTransport ? null : outcome.httpStatus,
  );
}

/**
 * Single refresh_token grant call against the provider token endpoint
 * (thin wrapper over the neutral core's performOAuthRefresh): same contract,
 * same failure taxonomy, same constants — the core is the single
 * implementation shared with the SaaS refresh worker. Never throws; every
 * failure mode is a classified RefreshFailure.
 */
export async function refreshOAuthAccount(input: {
  account: OAuthAccount;
  provider: string;
  fetchImpl?: OAuthRefreshFetch;
  nowMs?: number;
}): Promise<RefreshResult> {
  const { account, provider } = input;
  const adapter = resolveOAuthRefreshProviderSpec(provider, account);
  if (adapter === null) return failure('provider_unsupported', false, false, null, null);
  const refreshToken = account.refreshToken;
  if (typeof refreshToken !== 'string') {
    return failure('account_unrefreshable', false, false, null, null);
  }
  const credential: RefreshableCredential = {
    key: `${provider}:${account.id}`,
    providerId: provider,
    refreshToken,
    expiresAtMs: account.expiresAt ?? null,
  };
  const attempt = await performOAuthRefresh(credential, adapter, input.fetchImpl, {
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  return classicResult(attempt);
}

// --- Backoff ---

/** Exponential backoff 60s → 24h with deterministic ±10% jitter keyed by account. */
export function oauthRefreshBackoffMs(
  key: string,
  failureCount: number,
  options: { minBackoffMs?: number; maxBackoffMs?: number } = {},
): number {
  return refreshBackoffMs(failureCount, {
    ...(options.minBackoffMs === undefined ? {} : { min: options.minBackoffMs }),
    ...(options.maxBackoffMs === undefined ? {} : { max: options.maxBackoffMs }),
    jitterKey: key,
  });
}

// --- Engine ---

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
  private readonly accounts: OAuthRefreshStoreAdapter;
  private readonly refreshMarginMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    store: OAuthRefreshAccountStore,
    private readonly options: OAuthRefreshEngineOptions = {},
  ) {
    this.accounts = new OAuthRefreshStoreAdapter(store);
    this.refreshMarginMs = options.refreshMarginMs ?? OAUTH_REFRESH_DEFAULT_MARGIN_MS;
    this.minBackoffMs = options.minBackoffMs ?? OAUTH_REFRESH_MIN_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? OAUTH_REFRESH_MAX_BACKOFF_MS;
  }

  /**
   * Returns a live access token for the account, refreshing first when the
   * stored token is inside the expiry margin. Throws the re-authentication
   * error for revoked accounts and the no-account error when none is stored.
   */
  async resolveAccessToken(provider: string, accountId?: string, options?: { force?: boolean }): Promise<string> {
    const account = this.accounts.getAccount(provider, accountId);
    if (account === undefined) throw new Error(`No authenticated account for ${provider}`);
    if (isRevoked(account)) throw reauthenticationRequired(provider);
    // `force` bypasses the expiry-margin check: a live 401 from the upstream
    // is definitive evidence the token is dead even when the stored expiry is
    // unknown (imported auth.json accounts) — the expiry margin is a
    // proactive optimization, never the only refresh trigger. Backoff still
    // applies: a forced refresh inside a failure backoff returns the stored
    // token (a retry storm must not become a refresh storm).
    if ((!options?.force && !this.shouldRefresh(account)) || this.withinBackoff(account)) {
      return account.accessToken;
    }
    await this.runExclusive(provider, account.id, options?.force === true);
    const updated = this.accounts.getAccount(provider, accountId);
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

  /** One proactive pass over every due stored account (singleflight applies). */
  async sweep(): Promise<void> {
    if (this.closed) return;
    const due = this.accounts.listDue(this.now(), this.refreshMarginMs, Number.POSITIVE_INFINITY);
    for (const credential of due) {
      if (this.closed) return;
      try {
        await this.runExclusive(credential.providerId, credential.key.slice(credential.providerId.length + 1));
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

  private now(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  /**
   * A persisted 'refreshing' stamp from a crashed process is reclaimed as
   * active after OAUTH_REFRESH_STALE_REFRESHING_MS (mirrors the SaaS
   * stale-'refreshing' reclamation predicate).
   */
  private shouldRefresh(account: OAuthAccount): boolean {
    if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) return false;
    if (resolveOAuthRefreshProviderSpec(account.provider, account) === null) return false;
    return shouldRefresh(account.expiresAt ?? null, this.refreshMarginMs, this.now(), false);
  }

  private withinBackoff(account: OAuthAccount): boolean {
    return account.nextRetryAt !== undefined && account.nextRetryAt > this.now();
  }

  private runExclusive(provider: string, accountId: string, force = false): Promise<void> {
    const key = `${provider}:${accountId}`;
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing;
    const run = this.refreshAccount(provider, accountId, force).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, run);
    return run;
  }

  private async refreshAccount(provider: string, accountId: string, force = false): Promise<void> {
    const account = this.accounts.getAccount(provider, accountId);
    if (account === undefined || isRevoked(account)) return;
    const refreshToken = account.refreshToken;
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) return;
    // `force` bypasses the expiry margin (a live 401 is definitive expiry
    // evidence) but never the backoff or the provider binding: a forced
    // refresh still needs a refresh token and a provider that supports it.
    if ((!force && !this.shouldRefresh(account)) || this.withinBackoff(account)) return;
    const adapter = resolveOAuthRefreshProviderSpec(provider, account);
    if (adapter === null) return;

    // Crash-observability stamp before the network call: a crash in this
    // window leaves 'refreshing' on disk, which loads as active (a crashed
    // process's in-flight grant is gone, so the next sweep simply retries;
    // singleflight prevents concurrent in-process retries).
    this.updateQuiet(provider, accountId, { status: 'refreshing' });

    const credential: RefreshableCredential = {
      key: `${provider}:${accountId}`,
      providerId: provider,
      refreshToken,
      expiresAtMs: account.expiresAt ?? null,
    };
    let attempt: OAuthRefreshAttempt;
    try {
      attempt = await performOAuthRefresh(credential, adapter, this.options.fetchImpl, {
        nowMs: this.now(),
      });
    } catch (error) {
      this.options.onError?.(error, { provider, accountId });
      this.commitQuiet(credential, {
        outcome: { kind: 'failure', errorCode: null, oauthError: null, httpStatus: null },
        writeback: null,
        nowMs: this.now(),
        backoffMs: this.maxBackoffMs,
      });
      return;
    }
    this.commitQuiet(credential, this.commitInput(attempt, provider, accountId, account));
  }

  /** Scheduling policy the classic shell owns: backoff ladder bounds per engine options. */
  private commitInput(
    attempt: OAuthRefreshAttempt,
    provider: string,
    accountId: string,
    account: OAuthAccount,
  ): OAuthRefreshCommitResult {
    const { outcome, writeback } = attempt;
    const nowMs = this.now();
    if (outcome.kind === 'success' || outcome.kind === 'unsupported') {
      return { outcome, writeback, nowMs };
    }
    const backoffMs =
      outcome.kind === 'retryable'
        ? oauthRefreshBackoffMs(`${provider}:${accountId}`, (account.failureCount ?? 0) + 1, {
            minBackoffMs: this.minBackoffMs,
            maxBackoffMs: this.maxBackoffMs,
          })
        : this.maxBackoffMs;
    return { outcome, writeback: null, nowMs, backoffMs };
  }

  /** Store writes must never take down request-path token resolution. */
  private updateQuiet(provider: string, accountId: string, update: OAuthTokenUpdate): void {
    try {
      this.accounts.applyUpdate(provider, accountId, update);
    } catch (error) {
      this.options.onError?.(error, { provider, accountId });
    }
  }

  private commitQuiet(credential: RefreshableCredential, result: OAuthRefreshCommitResult): void {
    try {
      this.accounts.commit(credential, result);
    } catch (error) {
      const { providerId, key } = credential;
      this.options.onError?.(error, { provider: providerId, accountId: key.slice(providerId.length + 1) });
    }
  }
}
