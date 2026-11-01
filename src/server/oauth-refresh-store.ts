import { type OAuthRefreshAdapter, resolveAdapter, resolvePassthroughAdapter } from '../oauth-refresh/adapters.js';
import {
  OAUTH_REFRESH_MAX_BACKOFF_MS,
  type OAuthRefreshCommitResult,
  type OAuthRefreshStore,
  type RefreshableCredential,
  shouldRefresh,
} from '../oauth-refresh/core.js';
import type { OAuthAccount, OAuthTokenUpdate } from './oauth-accounts.js';

/**
 * Classic-plane store adapter for the neutral OAuth refresh core (design:
 * docs/oauth-refresh-engine-unification-plan-20261101.md §2.3). A thin
 * shape-mapper over the JSON-backed OAuthAccountStore: `listDue` reads the
 * account list and filters it by expiry margin + binding + backoff state,
 * `commit` maps a core attempt onto the existing updateTokens path. JSON
 * storage, atomic temp-file writes and master.key sealing stay exactly as
 * they are in OAuthAccountStore; the process-internal singleflight lives in
 * the engine, not here.
 */

/** The part of OAuthAccountStore the engine needs (satisfied by the real store and test fakes). */
export interface OAuthRefreshAccountStore {
  get(provider: string, id: string): OAuthAccount | undefined;
  getDefault(provider: string): OAuthAccount | undefined;
  list(provider?: string): OAuthAccount[];
  updateTokens(provider: string, id: string, update: OAuthTokenUpdate): OAuthAccount | undefined;
}

/** Fixed registry adapter or the account-carried passthrough binding. */
export function resolveAccountAdapter(provider: string, account: OAuthAccount): OAuthRefreshAdapter | null {
  return resolveAdapter(provider) ?? resolvePassthroughAdapter({ ...account, provider });
}

/** Splits a classic credential key (`${providerId}:${accountId}`) back into its account coordinates. */
function accountCoordinates(credential: RefreshableCredential): { provider: string; accountId: string } {
  return {
    provider: credential.providerId,
    accountId: credential.key.slice(credential.providerId.length + 1),
  };
}

export class OAuthRefreshStoreAdapter implements OAuthRefreshStore {
  constructor(private readonly accounts: OAuthRefreshAccountStore) {}

  /**
   * Accounts a sweep should refresh now: not revoked, inside the expiry
   * margin, carrying a usable refresh token, resolvable to a refresh
   * binding, and not inside a failure backoff window.
   */
  listDue(nowMs: number, marginMs: number, limit: number): readonly RefreshableCredential[] {
    const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : Number.POSITIVE_INFINITY;
    const due: RefreshableCredential[] = [];
    for (const account of this.accounts.list()) {
      if (due.length >= cap) break;
      if (account.status === 'revoked') continue;
      if (typeof account.refreshToken !== 'string' || account.refreshToken.length === 0) continue;
      if (!shouldRefresh(account.expiresAt ?? null, marginMs, nowMs, false)) continue;
      if (resolveAccountAdapter(account.provider, account) === null) continue;
      if (account.nextRetryAt !== undefined && account.nextRetryAt > nowMs) continue;
      due.push({
        key: `${account.provider}:${account.id}`,
        providerId: account.provider,
        refreshToken: account.refreshToken,
        expiresAtMs: account.expiresAt ?? null,
      });
    }
    return due;
  }

  /**
   * Maps one core attempt onto the updateTokens patch (identical to the
   * classic engine's own write discipline):
   * - success: rotate tokens (refresh token only when the endpoint returned
   *   one), reset the failure ladder, clear the backoff stamp;
   * - terminal: mark revoked, never auto-refreshed again;
   * - unsupported: not an account fault — restore the active stamp only;
   * - failure/retryable: stamp the failure ladder and the backoff window.
   */
  commit(credential: RefreshableCredential, result: OAuthRefreshCommitResult): void {
    const { provider, accountId } = accountCoordinates(credential);
    const { outcome, writeback } = result;
    const nowMs = result.nowMs ?? Date.now();
    if (outcome.kind === 'success' && writeback !== null) {
      this.accounts.updateTokens(provider, accountId, {
        accessToken: writeback.accessToken,
        ...(writeback.refreshToken !== null ? { refreshToken: writeback.refreshToken } : {}),
        ...(writeback.expiresInSeconds !== null ? { expiresAt: nowMs + writeback.expiresInSeconds * 1000 } : {}),
        status: 'active',
        lastRefreshAt: nowMs,
        failureCount: 0,
        nextRetryAt: null,
      });
      return;
    }
    if (outcome.kind === 'terminal') {
      this.accounts.updateTokens(provider, accountId, {
        status: 'revoked',
        lastRefreshAt: nowMs,
        failureCount: this.nextFailureCount(provider, accountId),
        nextRetryAt: null,
      });
      return;
    }
    if (outcome.kind === 'unsupported') {
      this.accounts.updateTokens(provider, accountId, { status: 'active' });
      return;
    }
    const backoffMs = result.backoffMs ?? OAUTH_REFRESH_MAX_BACKOFF_MS;
    this.accounts.updateTokens(provider, accountId, {
      status: 'active',
      lastRefreshAt: nowMs,
      failureCount: this.nextFailureCount(provider, accountId),
      nextRetryAt: nowMs + backoffMs,
    });
  }

  /** Resolves the default or explicit account (the request-path read). */
  getAccount(provider: string, accountId?: string): OAuthAccount | undefined {
    return accountId === undefined ? this.accounts.getDefault(provider) : this.accounts.get(provider, accountId);
  }

  /** Raw token/lifecycle patch (the crash-observability 'refreshing' stamp). */
  applyUpdate(provider: string, accountId: string, update: OAuthTokenUpdate): void {
    this.accounts.updateTokens(provider, accountId, update);
  }

  private nextFailureCount(provider: string, accountId: string): number {
    const account = this.accounts.get(provider, accountId);
    return (account?.failureCount ?? 0) + 1;
  }
}
