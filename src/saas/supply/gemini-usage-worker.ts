import { geminiTierQuota, normalizeGeminiTierId } from '../gateway/gemini/identity.js';
import { computeGeminiUsageSnapshot, geminiDailyWindowStartMs } from '../gateway/gemini/quota-usage.js';
import type {
  ClaimedGeminiAccount,
  PostgresProviderQuotaSnapshotStore,
} from './provider-account-quota-snapshot-store-postgres.js';

/**
 * R-dormant activation (sub2api gemini_quota.go port): the gemini usage
 * worker folds per-model-class request counts from `saas_attempts` into the
 * tier-shaped snapshot the migration-111 columns persist. Gemini exposes no
 * per-account upstream usage endpoint, so — unlike the codex/claude
 * transport-header writers — this family is worker-driven: the claim lease
 * and refresh cadence follow the opencode-go usage worker exactly (attempt
 * stamp as lease, SKIP LOCKED claim, bounded rounds, singleflight).
 *
 * The snapshot is a scheduling signal only; it never enters the billing
 * path (093/111 quota-snapshot precedent).
 */

/** Default refresh cadence: a snapshot is recomputed at most this often. */
export const GEMINI_USAGE_REFRESH_MS = 5 * 60 * 1000;
/** Cycle cadence between claim rounds. */
export const GEMINI_USAGE_POLL_INTERVAL_MS = 60_000;
/** At most this many accounts per claim round. */
export const GEMINI_USAGE_MAX_PER_ROUND = 20;

export interface GeminiUsageWorkerOptions {
  /** Snapshot refresh cadence; clamped to [30s, 24h]. */
  readonly refreshMs?: number;
  /** Round poll cadence; clamped to [100ms, 1h]. */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  /** Best-effort failure observer (never terminates a round). */
  readonly onError?: (kind: 'claim_failed' | 'account_failed' | 'cycle_failed') => void;
}

function clampRefreshMs(value: number | undefined): number {
  const parsed = value ?? GEMINI_USAGE_REFRESH_MS;
  if (!Number.isSafeInteger(parsed) || parsed < 30_000) return 30_000;
  return Math.min(parsed, 24 * 60 * 60 * 1000);
}

/**
 * Round-based gemini usage worker: every cycle claims at most 20 due gemini
 * accounts and recomputes their tier snapshot from the attempt table.
 */
export class GeminiUsageWorker {
  readonly refreshMs: number;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<number>>();
  private readonly inFlight = new Set<string>();
  private closePromise?: Promise<void>;

  constructor(
    private readonly store: Pick<
      PostgresProviderQuotaSnapshotStore,
      | 'claimDueGeminiAccounts'
      | 'readGeminiWindowRequestCounts'
      | 'readGeminiMinuteRequestCount'
      | 'writeGeminiSnapshot'
    >,
    private readonly options: GeminiUsageWorkerOptions = {},
  ) {
    if (!store || typeof store.claimDueGeminiAccounts !== 'function') {
      throw new TypeError('gemini usage worker requires a quota snapshot store');
    }
    this.options = Object.freeze({ ...options });
    this.refreshMs = clampRefreshMs(options.refreshMs);
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Claims and processes one round; resolves the number of accounts refreshed. */
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
    let accounts: ClaimedGeminiAccount[];
    try {
      accounts = await this.store.claimDueGeminiAccounts({
        refreshMs: this.refreshMs,
        limit: GEMINI_USAGE_MAX_PER_ROUND,
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
    for (const account of accounts) {
      if (this.halt.signal.aborted) break;
      // Singleflight per account: a concurrent round skips in-flight accounts.
      if (this.inFlight.has(account.accountId)) continue;
      const refresh = this.refreshAccount(account);
      this.inFlight.add(account.accountId);
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
        this.inFlight.delete(account.accountId);
      }
    }
    return processed;
  }

  private async refreshAccount(account: ClaimedGeminiAccount): Promise<void> {
    const nowMs = this.nowMs();
    const ref = {
      ownerKind: account.ownerKind,
      tenantId: account.tenantId,
      accountId: account.accountId,
    };
    const dailyStartMs = geminiDailyWindowStartMs(nowMs);
    const [requests, minuteRequests] = await Promise.all([
      this.store.readGeminiWindowRequestCounts(ref, dailyStartMs),
      this.store.readGeminiMinuteRequestCount(ref, nowMs),
    ]);
    if (this.halt.signal.aborted) return;
    const snapshot = computeGeminiUsageSnapshot({
      requests,
      minuteRequests,
      tierQuota: geminiTierQuota(normalizeGeminiTierId(account.tierId)),
      nowMs,
    });
    await this.store.writeGeminiSnapshot(ref, snapshot, nowMs);
  }

  /** Stops the worker; resolves once the active round has settled. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns]).then(() => undefined);
    return this.closePromise;
  }
}

export interface GeminiUsageWorkerHandle {
  close(): Promise<void>;
}

export function startGeminiUsageWorker(
  store: ConstructorParameters<typeof GeminiUsageWorker>[0],
  options: GeminiUsageWorkerOptions = {},
): GeminiUsageWorkerHandle {
  const worker = new GeminiUsageWorker(store, options);
  const pollIntervalMs = options.pollIntervalMs ?? GEMINI_USAGE_POLL_INTERVAL_MS;
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
