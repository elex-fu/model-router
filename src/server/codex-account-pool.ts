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
 * CS3 fix 2 (已知未闭合项 2): passive `x-codex-*` quota headers feed the pool
 * through `markQuotaSnapshot` — the shared SaaS quota gate
 * (src/saas/gateway/codex/quota-headers.ts classifyQuotaPause) pauses an
 * account whose 5h/7d window is at or above its threshold until the
 * classified reset time, and a snapshot older than two hours stops gating
 * (probe-allowed: one self-healing probe may be admitted) — identical to the
 * SaaS scheduler rule, with the thresholds exported as pool options.
 *
 * Sticky selection is intentionally NOT implemented here: the classic
 * SessionAffinityStore already pins a proxy key to an upstream, and
 * account-level stickiness can be layered on later by passing a preferred
 * account id to `select` — the signature stays the extension point.
 */

import {
  type CodexRateLimitSnapshot,
  classifyQuotaPause,
  type QuotaPauseSnapshot,
  type QuotaPauseThresholds,
} from '../saas/gateway/codex/quota-headers.js';
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
  /**
   * ChatGPT user id for the per-account identity namespace (CS3 fix 1).
   * Optional: the store does not persist CS2's extracted claim yet, and the
   * namespace falls back to the account id for the user coordinate — still
   * unique per account.
   */
  readonly chatgptUserId?: string;
}

/** One schedulable account as returned by `select`. */
export interface CodexAccountSelection {
  readonly accountId: string;
  readonly accessToken?: string;
  readonly chatgptAccountId?: string;
  /** Identity-namespace user coordinate (falls back to the account id upstream). */
  readonly chatgptUserId?: string;
}

/** Default credential-expired cooldown (5 minutes). */
export const CODEX_ACCOUNT_CREDENTIAL_COOLDOWN_MS = 5 * 60_000;
/** Default quota cooldown when the upstream gives no retry-after hint. */
export const CODEX_ACCOUNT_QUOTA_COOLDOWN_MS = 60_000;
/** Strike-path cooldown (KeyPool default parity). */
export const CODEX_ACCOUNT_COOLDOWN_MS = 5 * 60_000;
/** Strikes before the cooldown fires (KeyPool default parity). */
export const CODEX_ACCOUNT_MAX_FAILURES = 3;

/**
 * Default quota-pause thresholds (percent used) — the SaaS scheduler's "pause
 * at 100% used" rule: a window the upstream reports as fully consumed pauses
 * the account until its reset deadline.
 */
export const CODEX_ACCOUNT_DEFAULT_QUOTA_PAUSE_THRESHOLDS: QuotaPauseThresholds = {
  pause5hUsedPercent: 100,
  pause7dUsedPercent: 100,
};

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
  /** Quota-pause thresholds for the passive x-codex-* snapshot gate. */
  readonly quotaPauseThresholds?: QuotaPauseThresholds;
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
  /**
   * CS3 fix 2: stores one account's parsed `x-codex-*` quota snapshot (observed
   * on ANY upstream response, including 429s). `select`/`availableCount` skip
   * accounts the shared quota gate classifies as paused until the classified
   * reset time.
   */
  markQuotaSnapshot(accountId: string, snapshot: CodexRateLimitSnapshot, observedAtMs: number): void;
}

export class CodexAccountPool implements CodexAccountPoolContract {
  private readonly states = new Map<string, AccountState>();
  private readonly quotaSnapshots = new Map<string, QuotaPauseSnapshot>();
  private lastSelectedIndex = -1;
  private readonly listing: () => readonly CodexPoolAccount[];
  private readonly engine?: CodexAccountEngine;
  private readonly provider: string;
  private readonly nowMs: () => number;
  private readonly credentialCooldownMs: number;
  private readonly quotaCooldownMs: number;
  private readonly cooldownMs: number;
  private readonly maxFailures: number;
  private readonly quotaPauseThresholds: QuotaPauseThresholds;

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
    this.quotaPauseThresholds = options.quotaPauseThresholds ?? CODEX_ACCOUNT_DEFAULT_QUOTA_PAUSE_THRESHOLDS;
  }

  /**
   * Round-robin over non-revoked, non-cooled accounts. Returns null when
   * nothing is schedulable (empty listing or every account cooling down or
   * quota-paused).
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
      if (this.quotaPaused(account.id, now)) continue;
      this.lastSelectedIndex = index;
      return {
        accountId: account.id,
        ...(typeof account.accessToken === 'string' && account.accessToken !== ''
          ? { accessToken: account.accessToken }
          : {}),
        ...(typeof account.chatgptAccountId === 'string' && account.chatgptAccountId !== ''
          ? { chatgptAccountId: account.chatgptAccountId }
          : {}),
        ...(typeof account.chatgptUserId === 'string' && account.chatgptUserId !== ''
          ? { chatgptUserId: account.chatgptUserId }
          : {}),
      };
    }
    return null;
  }

  /**
   * Schedulable account count (non-revoked, not cooling down, not
   * quota-paused) without advancing the round-robin position — KeyPool
   * getAvailableCount parity.
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
      if (state !== undefined && state.cooledUntil > now) return false;
      return !this.quotaPaused(account.id, now);
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
        void this.engine.resolveAccessToken(this.provider, accountId, { force: true }).catch(() => {});
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
    // The quota snapshot describes upstream state, not this attempt's
    // outcome — a served request does not un-pause a window the upstream
    // still reports as exhausted.
  }

  /**
   * CS3 fix 2: stores one parsed `x-codex-*` snapshot. Relative reset-after
   * seconds convert to epoch deadlines against `observedAtMs` (the shared
   * gate wants epoch reset times). Independent of the failure cooldowns: a
   * quota cooldown and a quota pause simply overlap.
   */
  markQuotaSnapshot(accountId: string, snapshot: CodexRateLimitSnapshot, observedAtMs: number): void {
    if (typeof accountId !== 'string' || accountId.length === 0 || snapshot === null || typeof snapshot !== 'object') {
      return;
    }
    this.quotaSnapshots.set(accountId, {
      used5hPercent: snapshot.used5hPercent ?? null,
      reset5hAtMs: resetAtMs(observedAtMs, snapshot.reset5hSeconds),
      used7dPercent: snapshot.used7dPercent ?? null,
      reset7dAtMs: resetAtMs(observedAtMs, snapshot.reset7dSeconds),
      observedAtMs,
    });
  }

  /** True only while the shared quota gate classifies the account as paused. */
  private quotaPaused(accountId: string, nowMs: number): boolean {
    const snapshot = this.quotaSnapshots.get(accountId);
    if (snapshot === undefined) return false;
    // Stale snapshots return probe-allowed and stop gating; a reset deadline
    // in the past also un-pauses — the shared kernel owns every rule.
    return classifyQuotaPause(snapshot, this.quotaPauseThresholds, nowMs) === 'paused';
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

/** Relative reset-after seconds → epoch deadline; null when unknown. */
function resetAtMs(observedAtMs: number, resetAfterSeconds: number | null): number | null {
  if (resetAfterSeconds === null || !Number.isFinite(resetAfterSeconds)) return null;
  return observedAtMs + resetAfterSeconds * 1000;
}
