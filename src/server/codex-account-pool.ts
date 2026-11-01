/**
 * CS4 (docs/standalone-relay-capability-plan-2026-10-30.md D1): account
 * selection pool for classic codex subscription-account upstreams. One pool
 * instance serves the 'codex_oauth' provider family: round-robin over the
 * non-revoked accounts from a read-only listing (OAuthAccountStore.list),
 * skipping cooled-down accounts, with KeyPool-style cooldown semantics at
 * account granularity:
 *
 * - `credential_expired` (401): immediate 5-minute cooldown + a best-effort
 *   ask of the CS1 refresh engine for a live token (the engine refreshes when
 *   the stored token is inside its expiry margin; terminal grants are the
 *   engine's business, not the pool's).
 * - `quota` (429 / quota-window 403): cooldown from the upstream
 *   retry-after hint (60s fallback) — a cooldown, never unhealthiness.
 * - `other`: three strikes then cooldown (KeyPool maxFailures parity).
 * - `markSuccess` clears the failure streak.
 *
 * Sticky selection is intentionally NOT implemented here: the classic
 * SessionAffinityStore already pins a proxy key to an upstream, and
 * account-level stickiness can be layered on later by passing a preferred
 * account id to `select` — the signature stays the extension point.
 */

import type { CodexAccountEngine, CodexAccountFailureClassification } from './codex-account-transport.js';

/** Structural account shape the pool selects over — OAuthAccount satisfies it. */
export interface CodexPoolAccount {
  readonly id: string;
  /** Stored access token; when absent the transport resolves via the engine. */
  readonly accessToken?: string;
  /** 'revoked' accounts are never selected; any other status is schedulable. */
  readonly status?: string;
  /**
   * ChatGPT account id for the chatgpt-account-id header. Only an explicit
   * value is used — `login` (the id_token email) is deliberately NOT a
   * fallback because the header must carry the account id, not an email.
   * CS2's binding extracts this claim; persisting it on the account is the
   * documented follow-up.
   */
  readonly chatgptAccountId?: string;
}

/** One schedulable account as returned by `select`. */
export interface CodexAccountSelection {
  readonly accountId: string;
  readonly accessToken?: string;
  readonly chatgptAccountId?: string;
}

/** Default credential-expired cooldown (5 minutes). */
export const CODEX_ACCOUNT_CREDENTIAL_COOLDOWN_MS = 5 * 60_000;
/** Default quota cooldown when the upstream gives no retry-after hint. */
export const CODEX_ACCOUNT_QUOTA_COOLDOWN_MS = 60_000;
/** Strike-path cooldown (KeyPool default parity). */
export const CODEX_ACCOUNT_COOLDOWN_MS = 5 * 60_000;
/** Strikes before the cooldown fires (KeyPool default parity). */
export const CODEX_ACCOUNT_MAX_FAILURES = 3;

export interface CodexAccountPoolOptions {
  /** Read-only live view of the schedulable accounts. */
  readonly listing: () => readonly CodexPoolAccount[];
  /** Refresh-engine handle for credential-expired retry refreshes. */
  readonly engine?: CodexAccountEngine;
  /** Account provider id passed to the engine; defaults to 'codex_oauth'. */
  readonly provider?: string;
  /** Injectable clock (tests); default Date.now. */
  readonly nowMs?: () => number;
  readonly credentialCooldownMs?: number;
  readonly quotaCooldownMs?: number;
  readonly cooldownMs?: number;
  readonly maxFailures?: number;
}

interface AccountState {
  failures: number;
  cooledUntil: number;
}

/**
 * The structural pool contract the classic dispatch consumes
 * (ProxyHandlerOptions.codexAccountPool) — satisfied by CodexAccountPool
 * and by test stubs. `availableCount` bounds the per-upstream retry loop:
 * codex accounts ARE the credentials, so the dispatch attempts one select()
 * per schedulable account (mirroring the static key pool's entry count).
 */
export interface CodexAccountPoolContract {
  select(): CodexAccountSelection | null;
  /** Schedulable accounts right now; never advances round-robin state. */
  availableCount(): number;
  markFailure(
    accountId: string,
    classification: CodexAccountFailureClassification,
    hint?: { retryAfterMs?: number },
  ): void;
  markSuccess(accountId: string): void;
}

export class CodexAccountPool implements CodexAccountPoolContract {
  private readonly states = new Map<string, AccountState>();
  private lastSelectedIndex = -1;
  private readonly listing: () => readonly CodexPoolAccount[];
  private readonly engine?: CodexAccountEngine;
  private readonly provider: string;
  private readonly nowMs: () => number;
  private readonly credentialCooldownMs: number;
  private readonly quotaCooldownMs: number;
  private readonly cooldownMs: number;
  private readonly maxFailures: number;

  constructor(options: CodexAccountPoolOptions) {
    if (typeof options.listing !== 'function') throw new Error('CodexAccountPool requires an account listing');
    this.listing = options.listing;
    this.engine = options.engine;
    this.provider = options.provider ?? 'codex_oauth';
    this.nowMs = options.nowMs ?? Date.now;
    this.credentialCooldownMs = options.credentialCooldownMs ?? CODEX_ACCOUNT_CREDENTIAL_COOLDOWN_MS;
    this.quotaCooldownMs = options.quotaCooldownMs ?? CODEX_ACCOUNT_QUOTA_COOLDOWN_MS;
    this.cooldownMs = options.cooldownMs ?? CODEX_ACCOUNT_COOLDOWN_MS;
    this.maxFailures = options.maxFailures ?? CODEX_ACCOUNT_MAX_FAILURES;
  }

  /**
   * Round-robin over non-revoked, non-cooled accounts. Returns null when
   * nothing is schedulable (empty listing or every account cooling down).
   */
  select(): CodexAccountSelection | null {
    const accounts = this.listing().filter(
      (account) =>
        account !== null &&
        account !== undefined &&
        typeof account.id === 'string' &&
        account.id !== '' &&
        account.status !== 'revoked',
    );
    if (accounts.length === 0) return null;
    const now = this.nowMs();
    for (let offset = 1; offset <= accounts.length; offset++) {
      const index = (this.lastSelectedIndex + offset) % accounts.length;
      const account = accounts[index];
      if (account === undefined) continue;
      const state = this.states.get(account.id);
      if (state !== undefined && state.cooledUntil > now) continue;
      this.lastSelectedIndex = index;
      return {
        accountId: account.id,
        ...(typeof account.accessToken === 'string' && account.accessToken !== ''
          ? { accessToken: account.accessToken }
          : {}),
        ...(typeof account.chatgptAccountId === 'string' && account.chatgptAccountId !== ''
          ? { chatgptAccountId: account.chatgptAccountId }
          : {}),
      };
    }
    return null;
  }

  /**
   * Schedulable account count (non-revoked, not cooling down) without
   * advancing the round-robin position — KeyPool.getAvailableCount parity.
   */
  availableCount(): number {
    const now = this.nowMs();
    return this.listing().filter((account) => {
      if (
        account === null ||
        account === undefined ||
        typeof account.id !== 'string' ||
        account.id === '' ||
        account.status === 'revoked'
      ) {
        return false;
      }
      const state = this.states.get(account.id);
      return state === undefined || state.cooledUntil <= now;
    }).length;
  }

  markFailure(
    accountId: string,
    classification: CodexAccountFailureClassification,
    hint?: { retryAfterMs?: number },
  ): void {
    const state = this.stateFor(accountId);
    state.failures += 1;
    if (classification === 'credential_expired') {
      state.cooledUntil = this.now() + this.credentialCooldownMs;
      // Best-effort refresh ask (fire-and-forget): the engine decides
      // whether a grant is actually due; a rejected grant never reaches the
      // request path from here.
      if (this.engine !== undefined) {
        void this.engine.resolveAccessToken(this.provider, accountId).catch(() => {});
      }
      return;
    }
    if (classification === 'quota') {
      const cooldownMs = Math.max(0, hint?.retryAfterMs ?? this.quotaCooldownMs);
      state.cooledUntil = Math.max(state.cooledUntil, this.now() + cooldownMs);
      return;
    }
    if (state.failures >= this.maxFailures) state.cooledUntil = this.now() + this.cooldownMs;
  }

  markSuccess(accountId: string): void {
    const state = this.states.get(accountId);
    if (state !== undefined) {
      state.failures = 0;
      state.cooledUntil = 0;
    }
  }

  private stateFor(accountId: string): AccountState {
    let state = this.states.get(accountId);
    if (state === undefined) {
      state = { failures: 0, cooledUntil: 0 };
      this.states.set(accountId, state);
    }
    return state;
  }

  private now(): number {
    return this.nowMs();
  }
}
