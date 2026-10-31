import {
  buildWhamConsumeResetCreditsRequest,
  generateResetCreditsIdempotencyKey,
  isResetCreditAvailable,
  parseWhamResetCreditsResponse,
  WHAM_RATE_LIMIT_RESET_CREDITS_URL,
} from '../gateway/codex/reset-credits.js';
import {
  buildWhamQuotaPlaneHeaders,
  parseWhamUsageResponse,
  WHAM_USAGE_URL,
  type WhamUsageSnapshot,
  whamUsageSnapshotIsUsable,
} from '../gateway/codex/wham-usage.js';
import type {
  CodexWhamAccountRef,
  CodexWhamCredentialSecret,
  CodexWhamUsageStore,
} from './codex-wham-usage-store-postgres.js';

/**
 * P1-3b Codex /wham active usage worker (design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md §1.4 follow-up). Round loop
 * shaped after the gemini usage worker (claim lease, bounded rounds,
 * singleflight, close semantics) with the opencode-go usage worker's fetch
 * discipline:
 *
 * - every cycle claims at most 20 due codex accounts (SKIP LOCKED attempt
 *   stamp = lease) and queries them with at most 4 concurrent calls;
 * - each call GETs `https://chatgpt.com/backend-api/wham/usage` on the quota
 *   plane with the account's unsealed OAuth identity (15s timeout, 512KiB
 *   bounded body, redirects rejected), parses it with
 *   `parseWhamUsageResponse` and — when the normalized 5h/7d snapshot is
 *   present — writes exactly the passive transport sink's snapshot shape
 *   through the store (fromStatus-200 semantics: an active observation);
 * - auto reset (opt-in, `autoResetEnabled`, default OFF): when a window is
 *   exhausted (usedPercent ≥ 100 or the body's limit_reached/allowed flags)
 *   and a reset credit is available, the worker consumes one credit with a
 *   fresh idempotency key and re-fetches usage once to persist the refreshed
 *   windows. The branch never throws a round: failures keep the pre-reset
 *   snapshot in place;
 * - failure backoff: the 15min default refresh doubles per consecutive
 *   failure (capped 24h, floored 5min, ±10% jitter) and is tracked in memory
 *   on top of the claim lease, which already bounds re-attempts server-side.
 *
 * The snapshot is a scheduling signal only; it never enters the billing path
 * (093/099 quota-snapshot precedent).
 */

/** Default refresh cadence: an account is re-queried at most this often. */
export const CODEX_WHAM_USAGE_REFRESH_MS = 15 * 60_000;
/** Hard minimum between active queries of one account (opencode precedent). */
export const CODEX_WHAM_USAGE_MIN_REFRESH_MS = 5 * 60_000;
export const CODEX_WHAM_USAGE_MAX_REFRESH_MS = 24 * 60 * 60_000;
/** Cycle cadence between claim rounds. */
export const CODEX_WHAM_USAGE_POLL_INTERVAL_MS = 60_000;
/** At most this many accounts per claim round. */
export const CODEX_WHAM_USAGE_MAX_PER_ROUND = 20;
/** At most this many concurrent quota-plane queries per round. */
export const CODEX_WHAM_USAGE_CONCURRENCY = 4;
export const CODEX_WHAM_USAGE_REQUEST_TIMEOUT_MS = 15_000;
export const CODEX_WHAM_USAGE_MAX_RESPONSE_BYTES = 512 * 1024;
/** Failure-backoff floor: a failing account never hot-loops faster than this. */
export const CODEX_WHAM_USAGE_MIN_BACKOFF_MS = 5 * 60_000;
export const CODEX_WHAM_USAGE_MAX_BACKOFF_MS = 24 * 60 * 60_000;

export type CodexWhamUsageFetch = (url: string, init: RequestInit) => Promise<Response>;

export type CodexWhamUsageErrorKind =
  | 'claim_failed'
  | 'account_failed'
  | 'credential_unavailable'
  | 'auto_reset_failed'
  | 'cycle_failed';

export interface CodexWhamUsageWorkerOptions {
  /** Opt-in auto reset-credit redemption; OFF by default (conservative rollout). */
  readonly autoResetEnabled?: boolean;
  /** Refresh cadence; clamped to [5min, 24h]. */
  readonly refreshMs?: number;
  /** Round poll cadence; clamped to [100ms, 1h]. */
  readonly pollIntervalMs?: number;
  /** Test/custom seam; production uses the global fetch with pinned URLs. */
  readonly fetch?: CodexWhamUsageFetch;
  /** Test seam for deterministic clocks. */
  readonly now?: () => number;
  /** Test seam for deterministic backoff jitter. */
  readonly random?: () => number;
  /** Best-effort failure observer (never terminates a round). */
  readonly onError?: (kind: CodexWhamUsageErrorKind) => void;
}

export function clampCodexWhamUsageRefreshMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return CODEX_WHAM_USAGE_REFRESH_MS;
  return Math.min(Math.max(Math.round(raw), CODEX_WHAM_USAGE_MIN_REFRESH_MS), CODEX_WHAM_USAGE_MAX_REFRESH_MS);
}

/**
 * Failure backoff (opencode semantics, simplified for the lease-bounded claim):
 * refresh × 2^min(failureCount-1, 6), capped at 24h, jittered ±10%, floored at
 * 5min. The claim lease already bounds server-side re-attempts; this only
 * keeps a failing account out of the fetch path between leases.
 */
export function codexWhamUsageFailureBackoffMs(
  refreshMs: number,
  failureCount: number,
  random: () => number = Math.random,
): number {
  let base = clampCodexWhamUsageRefreshMs(refreshMs);
  if (failureCount > 0) base *= 2 ** Math.min(failureCount - 1, 6);
  if (base > CODEX_WHAM_USAGE_MAX_BACKOFF_MS) base = CODEX_WHAM_USAGE_MAX_BACKOFF_MS;
  const jitter = base / 10;
  if (jitter > 0) base += (random() * 2 - 1) * jitter;
  if (base < CODEX_WHAM_USAGE_MIN_BACKOFF_MS) base = CODEX_WHAM_USAGE_MIN_BACKOFF_MS;
  return Math.round(Math.min(base, CODEX_WHAM_USAGE_MAX_BACKOFF_MS));
}

/**
 * Whether a parsed usage snapshot indicates an exhausted window: either
 * normalized window at 100% or more, or the body's explicit
 * `rate_limit.limit_reached` / `rate_limit.allowed === false` flags.
 */
export function whamUsageIndicatesExhaustion(usage: WhamUsageSnapshot): boolean {
  if (usage.allowed === false) return true;
  if (usage.limitReached === true) return true;
  const rateLimit = usage.rateLimit;
  if (rateLimit === null) return false;
  if (rateLimit.used5hPercent !== null && rateLimit.used5hPercent >= 100) return true;
  if (rateLimit.used7dPercent !== null && rateLimit.used7dPercent >= 100) return true;
  return false;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const next = index;
      index += 1;
      if (next >= items.length) return;
      await work(items[next] as T);
    }
  };
  const runners: Promise<void>[] = [];
  for (let slot = 0; slot < Math.min(limit, items.length); slot += 1) runners.push(runner());
  await Promise.all(runners);
}

function accountKey(account: CodexWhamAccountRef): string | null {
  if (
    typeof account.accountId !== 'string' ||
    account.accountId.length === 0 ||
    account.accountId.trim() !== account.accountId ||
    account.accountId.includes('\u0000')
  ) {
    return null;
  }
  if (account.ownerKind !== 'tenant' && account.ownerKind !== 'platform') return null;
  if (account.ownerKind === 'tenant' && (typeof account.tenantId !== 'string' || account.tenantId.length === 0)) {
    return null;
  }
  return `${account.ownerKind}:${account.tenantId ?? ''}:${account.accountId}`;
}

type BodyRead = { readonly ok: true; readonly text: string } | { readonly ok: false };

async function readBodyBounded(response: Response, maxBytes: number): Promise<BodyRead> {
  try {
    if (response.body === null) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) return { ok: false };
      return { ok: true, text };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
    let length = 0;
    for (const chunk of chunks) length += chunk.byteLength;
    const merged = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder('utf8', { fatal: true }).decode(merged) };
  } catch {
    return { ok: false };
  }
}

interface QuotaPlaneResponse {
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: unknown;
}

/**
 * Round-based codex wham usage worker: every cycle claims at most 20 due
 * codex accounts, queries the quota plane with at most 4 concurrent calls and
 * writes snapshot state through the store. The halt signal aborts rounds;
 * close() drains them before returning.
 */
export class CodexWhamUsageWorker {
  readonly refreshMs: number;
  readonly autoResetEnabled: boolean;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<number>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly backoff = new Map<string, { nextAttemptAtMs: number; failureCount: number }>();
  private closePromise?: Promise<void>;

  constructor(
    private readonly store: CodexWhamUsageStore,
    private readonly options: CodexWhamUsageWorkerOptions = {},
  ) {
    if (!store || typeof store.claimDueCodexAccounts !== 'function') {
      throw new TypeError('codex wham usage worker requires a usage store');
    }
    this.options = Object.freeze({ ...options });
    this.refreshMs = clampCodexWhamUsageRefreshMs(options.refreshMs);
    this.autoResetEnabled = options.autoResetEnabled === true;
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  private fetchCall(): CodexWhamUsageFetch {
    return this.options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Claims and processes one round; resolves the number of accounts processed. */
  async runOnce(): Promise<number> {
    if (this.halt.signal.aborted) return 0;
    const run = this.processRound();
    this.activeRuns.add(run);
    try {
      return await run;
    } catch (error) {
      if (this.halt.signal.aborted) return 0;
      throw error;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async processRound(): Promise<number> {
    let accounts: readonly CodexWhamAccountRef[];
    try {
      accounts = await this.store.claimDueCodexAccounts({
        refreshMs: this.refreshMs,
        limit: CODEX_WHAM_USAGE_MAX_PER_ROUND,
      });
    } catch {
      try {
        this.options.onError?.('claim_failed');
      } catch {
        // An observer cannot terminate usage processing.
      }
      return 0;
    }
    let processed = 0;
    await runWithConcurrency(accounts, CODEX_WHAM_USAGE_CONCURRENCY, async (account) => {
      if (this.halt.signal.aborted) return;
      const key = accountKey(account);
      if (key === null) {
        try {
          this.options.onError?.('account_failed');
        } catch {
          // An observer cannot terminate usage processing.
        }
        return;
      }
      // Singleflight per account: a concurrent round skips in-flight accounts.
      if (this.inFlight.has(key)) return;
      const refresh = this.refreshAccount(account, key);
      this.inFlight.set(key, refresh);
      try {
        await refresh;
        if (!this.halt.signal.aborted) processed += 1;
      } catch {
        try {
          this.options.onError?.('account_failed');
        } catch {
          // An observer cannot terminate usage processing.
        }
      } finally {
        this.inFlight.delete(key);
      }
    });
    return processed;
  }

  private async refreshAccount(account: CodexWhamAccountRef, key: string): Promise<void> {
    const nowMs = this.nowMs();
    // In-memory failure backoff on top of the claim lease: a failing account
    // is skipped (not re-queried, not unsealed) until the backoff expires.
    const parked = this.backoff.get(key);
    if (parked !== undefined && parked.nextAttemptAtMs > nowMs) return;
    const attemptedAtMs = this.nowMs();
    let outcome: 'ok' | 'failed';
    try {
      const resolution = await this.store.withUnsealedCodexCredential(account, (secret) =>
        this.queryAndApply(account, secret),
      );
      if (resolution.state === 'failed') {
        // No usable credential: skip the account entirely — nothing failed
        // upstream, so the claim debounce alone bounds the next attempt.
        try {
          this.options.onError?.('credential_unavailable');
        } catch {
          // An observer cannot terminate usage processing.
        }
        return;
      }
      outcome = resolution.value;
    } catch {
      this.recordFailure(key, attemptedAtMs);
      return;
    }
    if (this.halt.signal.aborted) return;
    if (outcome === 'failed') {
      this.recordFailure(key, attemptedAtMs);
      return;
    }
    this.backoff.delete(key);
  }

  /** One account's quota-plane query + snapshot write + optional auto reset. */
  private async queryAndApply(
    account: CodexWhamAccountRef,
    secret: CodexWhamCredentialSecret,
  ): Promise<'ok' | 'failed'> {
    const usage = await this.fetchWhamUsage(secret);
    if (usage === null) return 'failed';
    if (this.halt.signal.aborted) return 'ok';
    if (usage.rateLimit !== null) {
      await this.store.writeSnapshot(account, usage.rateLimit, usage.observedAtMs);
    }
    if (this.autoResetEnabled && whamUsageIndicatesExhaustion(usage)) {
      // The auto-reset branch is best-effort and never fails the round: a
      // failed redemption keeps the already-written pre-reset snapshot.
      try {
        await this.attemptAutoReset(account, secret, usage);
      } catch {
        try {
          this.options.onError?.('auto_reset_failed');
        } catch {
          // An observer cannot terminate usage processing.
        }
      }
    }
    return 'ok';
  }

  private recordFailure(key: string, attemptedAtMs: number): void {
    const failureCount = (this.backoff.get(key)?.failureCount ?? 0) + 1;
    const delayMs = codexWhamUsageFailureBackoffMs(this.refreshMs, failureCount, this.options.random);
    this.backoff.set(key, { failureCount, nextAttemptAtMs: attemptedAtMs + delayMs });
  }

  private async fetchWhamUsage(secret: CodexWhamCredentialSecret): Promise<WhamUsageSnapshot | null> {
    const response = await this.requestJson(secret, { url: WHAM_USAGE_URL, method: 'GET' });
    if (!response.ok) return null;
    return parseWhamUsageResponse(response.body, this.nowMs());
  }

  /**
   * Auto reset (opt-in): when a window is exhausted and a reset credit is
   * available, consume one (fresh UUID idempotency key) and re-fetch usage
   * once, persisting the refreshed snapshot. A definitive zero
   * `available_count` skips the branch; an unknown/null count probes the
   * details endpoint (the "summary > 0 OR details returns one" gate).
   */
  private async attemptAutoReset(
    account: CodexWhamAccountRef,
    secret: CodexWhamCredentialSecret,
    usage: WhamUsageSnapshot,
  ): Promise<void> {
    const summaryCount = usage.resetCredits?.availableCount ?? null;
    if (summaryCount === 0) return;
    const details = await this.requestJson(secret, { url: WHAM_RATE_LIMIT_RESET_CREDITS_URL, method: 'GET' });
    if (!details.ok) return;
    const credits = parseWhamResetCreditsResponse(details.body);
    const available = credits.find((credit) => isResetCreditAvailable(credit, this.nowMs())) ?? null;
    if (available === null) return;
    const consume = buildWhamConsumeResetCreditsRequest({
      idempotencyKey: generateResetCreditsIdempotencyKey(),
      ...(available.id !== null ? { creditId: available.id } : {}),
    });
    const consumed = await this.requestJson(secret, {
      url: consume.url,
      method: 'POST',
      body: JSON.stringify(consume.body),
    });
    if (!consumed.ok) return;
    // One refresh re-fetch; a failure keeps the pre-reset snapshot in place.
    const refreshed = await this.fetchWhamUsage(secret);
    if (refreshed === null) return;
    if (!whamUsageSnapshotIsUsable(refreshed, this.nowMs())) return;
    if (refreshed.rateLimit === null) return;
    await this.store.writeSnapshot(account, refreshed.rateLimit, refreshed.observedAtMs);
  }

  /**
   * One quota-plane request with the account identity headers: 15s timeout,
   * bounded body, redirects rejected, JSON-parsed. Non-2xx responses,
   * redirects, oversized or unparsable bodies resolve `{ok: false}` (the
   * caller decides whether that is a failure or a soft skip).
   */
  private async requestJson(
    secret: CodexWhamCredentialSecret,
    request: { readonly url: string; readonly method: 'GET' | 'POST'; readonly body?: string },
  ): Promise<QuotaPlaneResponse> {
    let response: Response;
    try {
      response = await this.fetchCall()(request.url, {
        method: request.method,
        headers: buildWhamQuotaPlaneHeaders({
          accessToken: secret.accessToken,
          chatgptAccountId: secret.chatgptAccountId,
        }),
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(CODEX_WHAM_USAGE_REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      return { ok: false, status: null, body: null };
    }
    if (response.redirected) {
      await drainResponse(response);
      return { ok: false, status: response.status, body: null };
    }
    if (response.status < 200 || response.status >= 300) {
      await drainResponse(response);
      return { ok: false, status: response.status, body: null };
    }
    const read = await readBodyBounded(response, CODEX_WHAM_USAGE_MAX_RESPONSE_BYTES);
    if (!read.ok) return { ok: false, status: response.status, body: null };
    try {
      return { ok: true, status: response.status, body: JSON.parse(read.text) };
    } catch {
      return { ok: false, status: response.status, body: null };
    }
  }

  /** Stops the worker; resolves once the active round has settled. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns, ...this.inFlight.values()]).then(() => undefined);
    return this.closePromise;
  }
}

async function drainResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Releasing the socket is best-effort.
  }
}

export interface CodexWhamUsageWorkerHandle {
  close(): Promise<void>;
}

export function startCodexWhamUsageWorker(
  store: ConstructorParameters<typeof CodexWhamUsageWorker>[0],
  options: CodexWhamUsageWorkerOptions = {},
): CodexWhamUsageWorkerHandle {
  const worker = new CodexWhamUsageWorker(store, options);
  const pollIntervalMs = options.pollIntervalMs ?? CODEX_WHAM_USAGE_POLL_INTERVAL_MS;
  const boundedPoll =
    Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 100 ? Math.min(pollIntervalMs, 3_600_000) : 60_000;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveWait: (() => void) | undefined;
  const delayWithClose = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      resolveWait = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resolveWait = undefined;
        resolve();
      }, durationMs);
    });
  const loop = async (): Promise<void> => {
    while (!closed) {
      try {
        await worker.runOnce();
      } catch {
        if (closed) break;
        try {
          options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate usage processing.
        }
      }
      if (closed) break;
      await delayWithClose(boundedPoll);
    }
  };
  const done = loop();
  return {
    async close() {
      if (closed) return done;
      closed = true;
      const closeWorker = worker.close();
      if (timer !== undefined) clearTimeout(timer);
      resolveWait?.();
      await Promise.all([closeWorker, done]);
    },
  };
}
