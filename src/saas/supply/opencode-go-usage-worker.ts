import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_CREDENTIAL_TYPE,
  OPENCODE_GO_PRODUCT_ID,
  OPENCODE_GO_PROVIDER_ID,
} from '../gateway/opencode-go/catalog-identity.js';

/**
 * R5b OpenCode Go quota-snapshot usage worker (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #23;
 * semantics extracted from sub2api
 * backend/internal/service/opencode_go_usage.go).
 *
 * The worker periodically fetches the official OpenCode Zen/Go usage endpoint
 * (`GET {OPENCODE_GO_BASE_URL}/v1/usage`, Bearer api_key) for `opencode-go`
 * platform-pool accounts and overwrites the account row's quota-window
 * snapshot columns. The snapshot is a scheduling signal only: it never enters
 * the billing path and never authorizes a profit/cost failover decision
 * (093/099 quota-snapshot precedent).
 *
 * sub2api worker semantics ported here:
 * - default refresh interval 15min, hard minimum 5min between successful
 *   fetches of the same account, 24h maximum;
 * - 1min debounce floor between any two attempts of the same account;
 * - at most 20 accounts per round, at most 4 concurrent fetches;
 * - singleflight per account (a second concurrent round never re-fetches an
 *   in-flight account);
 * - 15s request timeout, 512KiB bounded response body, redirects rejected;
 * - failure backoff: interval * 2^min(failureCount-1, 6), capped at 24h,
 *   never below a Retry-After hint or one minute, ±10% jitter capped at 5min.
 *
 * Leader/lease semantics: this repo has no Redis/jobs-table leader lock — the
 * established pattern (quota-sync-worker, oauth-token-refresh-worker) is a
 * per-account SKIP LOCKED row claim whose attempt stamp is the lease. The
 * production Postgres store (migration 108, task #25) must claim due rows
 * atomically (e.g. `UPDATE ... SET opencode_go_usage_updated_at = now() WHERE
 * id IN (SELECT ... WHERE due LIMIT n FOR UPDATE SKIP LOCKED) RETURNING ...`),
 * which replaces sub2api's 2-minute leader-lock TTL with a crash-safe,
 * self-healing claim: a crashed worker leaves the attempt stamp behind, so no
 * replica re-fetches the account until the debounce floor passes.
 *
 * This module defines the worker, the snapshot type, and the store interface
 * the worker depends on; the Postgres implementation lands with migration 108
 * (task #25). Fail-closed rules mirror the quota-sync worker:
 * - a window the upstream did not report is stored as NULL, never guessed;
 * - `percent` is upstream-observed only, never extrapolated;
 * - every failure mode advances the account's next-due horizon (no hot loops).
 */

export const OPENCODE_GO_USAGE_PATH = '/v1/usage';
/** Pinned usage endpoint; the base URL literal lives only in catalog-identity. */
export const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_BASE_URL}${OPENCODE_GO_USAGE_PATH}`;
/** Compile-time fixed account binding the store's due scan must filter on. */
export const OPENCODE_GO_USAGE_ACCOUNT_BINDING = Object.freeze({
  providerId: OPENCODE_GO_PROVIDER_ID,
  productId: OPENCODE_GO_PRODUCT_ID,
  credentialType: OPENCODE_GO_CREDENTIAL_TYPE,
});

export const OPENCODE_GO_USAGE_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const OPENCODE_GO_USAGE_MIN_INTERVAL_MS = 5 * 60_000;
export const OPENCODE_GO_USAGE_MAX_INTERVAL_MS = 24 * 60 * 60_000;
export const OPENCODE_GO_USAGE_DEFAULT_DEBOUNCE_MS = 60_000;
export const OPENCODE_GO_USAGE_MIN_DEBOUNCE_MS = 60_000;
export const OPENCODE_GO_USAGE_MAX_DEBOUNCE_MS = 60 * 60_000;
/** Cycle cadence between rounds (sub2api opencodeGoUsageCycleInterval). */
export const OPENCODE_GO_USAGE_POLL_INTERVAL_MS = 60_000;
export const OPENCODE_GO_USAGE_REQUEST_TIMEOUT_MS = 15_000;
export const OPENCODE_GO_USAGE_MAX_RESPONSE_BYTES = 512 * 1024;
export const OPENCODE_GO_USAGE_MAX_PER_ROUND = 20;
export const OPENCODE_GO_USAGE_CONCURRENCY = 4;
export const OPENCODE_GO_USAGE_MIN_BACKOFF_MS = 60_000;
export const OPENCODE_GO_USAGE_MAX_DELAY_MS = 24 * 60 * 60_000;

/** Upstream-observed quota window; NULL fields were absent upstream, never guessed. */
export interface OpencodeGoUsageWindowSnapshot {
  /** Upstream `percent` (0..100 observed, not validated as a bound). */
  readonly usedPercent: number | null;
  /** Upstream window `status` (e.g. 'ok'); passthrough scheduling signal. */
  readonly status: string | null;
  /** Upstream `resetsAt` (RFC 3339) as epoch milliseconds. */
  readonly resetsAtMs: number | null;
}

/**
 * The only usage observation persisted on the account row. Window keys mirror
 * the upstream rolling/weekly/monthly triple; a NULL window was not reported.
 */
export interface OpencodeGoUsageSnapshot {
  readonly rolling5h: OpencodeGoUsageWindowSnapshot | null;
  readonly weekly: OpencodeGoUsageWindowSnapshot | null;
  readonly monthly: OpencodeGoUsageWindowSnapshot | null;
  readonly fetchedAtMs: number;
  /** Worker-computed due horizon; the store persists it as next_due_at. */
  readonly nextDueAtMs: number;
}

export interface OpencodeGoUsageAccountRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
}

export type OpencodeGoUsageErrorCode =
  | 'credential_unavailable'
  | 'credential_format_invalid'
  | 'credential_rejected'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_invalid'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected';

/** Failure bookkeeping the store persists to advance the next-due horizon. */
export interface OpencodeGoUsageFailure {
  readonly attemptedAtMs: number;
  readonly errorCode: OpencodeGoUsageErrorCode;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  /** Worker-computed backoff horizon (interval or exponential, never shorter). */
  readonly nextDueAtMs: number;
  /** 1-based attempt streak within the observed failure run. */
  readonly failureCount: number;
}

/**
 * The store contract the usage worker depends on. The Postgres implementation
 * (migration 108, task #25) must:
 * - filter due accounts on the OPENCODE_GO_USAGE_ACCOUNT_BINDING triple with
 *   active/verified account and credential state (quota-sync due-scan shape);
 * - claim rows FOR UPDATE SKIP LOCKED so replicas never double-fetch;
 * - apply the due predicate
 *     next_due_at IS NULL OR next_due_at <= now
 *     AND (last attempt + debounce <= now)
 *     AND (rate_limited_until IS NULL OR rate_limited_until <= now);
 * - unseal the api_key credential only inside the callback (KMS decrypt-only
 *   seam, quota-sync precedent) and zero the buffer afterwards.
 */
export interface OpencodeGoUsageStore {
  /** Returns at most `limit` claimed due accounts for this round. */
  readDueAccounts(input: {
    readonly nowMs: number;
    readonly debounceMs: number;
    readonly intervalMs: number;
    readonly limit: number;
  }): Promise<readonly OpencodeGoUsageAccountRef[]>;
  /**
   * Unseals the account's current api_key and invokes the callback. Resolves
   * null when no verified credential is available; the callback's result (and
   * errors) pass through unchanged.
   */
  withUnsealedApiKey<T>(
    account: OpencodeGoUsageAccountRef,
    callback: (secret: Buffer) => Promise<T>,
  ): Promise<T | null>;
  /** Persists a successful usage snapshot (windows + due horizon). */
  writeUsageSnapshot(account: OpencodeGoUsageAccountRef, snapshot: OpencodeGoUsageSnapshot): Promise<void>;
  /** Persists a failed attempt (no windows; backoff horizon only). */
  writeUsageFailure(account: OpencodeGoUsageAccountRef, failure: OpencodeGoUsageFailure): Promise<void>;
  /** Sets the account scheduling cooldown (exhausted-window reset / 429 hint). */
  markRateLimited(account: OpencodeGoUsageAccountRef, untilMs: number): Promise<void>;
}

export type OpencodeGoUsageFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type OpencodeGoUsageFetchResult =
  | {
      readonly state: 'ok';
      readonly usage: Omit<OpencodeGoUsageSnapshot, 'fetchedAtMs' | 'nextDueAtMs'>;
      readonly fetchedAtMs: number;
      readonly httpStatus: number;
    }
  | {
      readonly state: 'rate_limited';
      readonly httpStatus: 429;
      readonly retryAfterMs: number | null;
    }
  | {
      readonly state: 'failed';
      readonly errorCode: OpencodeGoUsageErrorCode;
      readonly httpStatus: number | null;
      readonly retryAfterMs: number | null;
    };

export function clampOpencodeGoUsageIntervalMs(raw: number | undefined): number {
  if (raw === undefined) return OPENCODE_GO_USAGE_DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(raw)) return OPENCODE_GO_USAGE_DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(Math.round(raw), OPENCODE_GO_USAGE_MIN_INTERVAL_MS), OPENCODE_GO_USAGE_MAX_INTERVAL_MS);
}

export function clampOpencodeGoUsageDebounceMs(raw: number | undefined): number {
  if (raw === undefined) return OPENCODE_GO_USAGE_DEFAULT_DEBOUNCE_MS;
  if (!Number.isFinite(raw)) return OPENCODE_GO_USAGE_DEFAULT_DEBOUNCE_MS;
  return Math.min(Math.max(Math.round(raw), OPENCODE_GO_USAGE_MIN_DEBOUNCE_MS), OPENCODE_GO_USAGE_MAX_DEBOUNCE_MS);
}

function asciiApiKey(secret: Buffer): string | null {
  if (secret.length < 1 || secret.length > 4_096) return null;
  for (const byte of secret) {
    if (byte < 0x21 || byte > 0x7e) return null;
  }
  return secret.toString('ascii');
}

function canonicalUsageUrl(): URL | null {
  try {
    const url = new URL(OPENCODE_GO_USAGE_URL);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.href !== OPENCODE_GO_USAGE_URL
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * RFC 7231 Retry-After: delta-seconds or HTTP-date, as milliseconds from now.
 * Zero, negative, expired, or malformed hints resolve null (no precise hint).
 */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null || header.length === 0 || header.length > 64) return null;
  const trimmed = header.trim();
  if (/^[0-9]{1,10}$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds >= 1 ? seconds * 1_000 : null;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const delta = parsed - nowMs;
  return delta >= 1_000 ? delta : null;
}

type Fields = Record<string, unknown>;

function record(value: unknown): Fields | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : null;
}

function parseWindow(value: unknown): OpencodeGoUsageWindowSnapshot | null {
  const window = record(value);
  if (!window) return null;
  const status = typeof window.status === 'string' && window.status.length > 0 ? window.status : null;
  const usedPercent =
    typeof window.percent === 'number' && Number.isFinite(window.percent) && window.percent >= 0
      ? window.percent
      : null;
  let resetsAtMs: number | null = null;
  if (typeof window.resetsAt === 'string' && window.resetsAt.length > 0 && window.resetsAt.length <= 64) {
    const parsed = Date.parse(window.resetsAt);
    if (Number.isFinite(parsed)) resetsAtMs = parsed;
  }
  return { usedPercent, status, resetsAtMs };
}

/**
 * Parses the upstream usage payload leniently (sub2api
 * parseOpenCodeGoUsageJSON): the top level may wrap the windows in a "usage"
 * object or expose them directly; missing windows resolve null instead of
 * failing the whole parse. Structurally invalid JSON — or a payload reporting
 * no window at all — resolves null: a snapshot with zero observed windows
 * would clear real scheduling state, so it is never accepted.
 */
export function parseOpencodeGoUsageResponse(
  bytes: Uint8Array,
): Omit<OpencodeGoUsageSnapshot, 'fetchedAtMs' | 'nextDueAtMs'> | null {
  let body: Fields | null;
  try {
    body = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
  if (!body) return null;
  const usage = record(body.usage) ?? body;
  const rolling5h = parseWindow(usage.rolling);
  const weekly = parseWindow(usage.weekly);
  const monthly = parseWindow(usage.monthly);
  if (!rolling5h && !weekly && !monthly) return null;
  return { rolling5h, weekly, monthly };
}

function isExhaustedWindow(window: OpencodeGoUsageWindowSnapshot): boolean {
  if (window.status !== null && window.status.toLowerCase() === 'exhausted') return true;
  return window.usedPercent !== null && window.usedPercent >= 100;
}

/**
 * Maps the observed windows onto a precise scheduling cooldown (sub2api
 * classify semantics: only a window at 100%/exhausted status is a quota
 * signal). The cooldown is the latest reset among exhausted windows whose
 * reset is still in the future — every exhausted window must clear before the
 * account is schedulable again. No exhausted window (or only resets already
 * in the past) resolves null; the worker never guesses a cooldown.
 */
export function deriveOpencodeGoRateLimitUntilMs(
  usage: Omit<OpencodeGoUsageSnapshot, 'fetchedAtMs' | 'nextDueAtMs'>,
  nowMs: number,
): number | null {
  let until: number | null = null;
  for (const window of [usage.rolling5h, usage.weekly, usage.monthly]) {
    if (!window || !isExhaustedWindow(window)) continue;
    if (window.resetsAtMs === null || window.resetsAtMs <= nowMs) continue;
    if (until === null || window.resetsAtMs > until) until = window.resetsAtMs;
  }
  return until;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Body content is neither consumed nor surfaced.
  }
}

type BoundedBodyResult =
  | { readonly state: 'ok'; readonly bytes: Uint8Array }
  | { readonly state: 'too_large' }
  | { readonly state: 'read_error' }
  | { readonly state: 'timeout' };

async function boundedResponseBody(response: Response, signal: AbortSignal): Promise<BoundedBodyResult> {
  if (signal.aborted) {
    cancelResponseBody(response);
    return { state: 'timeout' };
  }
  if (!response.body) return { state: 'ok', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const buffer = new Uint8Array(OPENCODE_GO_USAGE_MAX_RESPONSE_BYTES);
  let bytesRead = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { state: 'timeout' };
      if (done) return { state: 'ok', bytes: buffer.subarray(0, bytesRead) };
      if (!(value instanceof Uint8Array)) {
        cancel();
        return { state: 'read_error' };
      }
      if (value.byteLength > OPENCODE_GO_USAGE_MAX_RESPONSE_BYTES - bytesRead) {
        cancel();
        return { state: 'too_large' };
      }
      buffer.set(value, bytesRead);
      bytesRead += value.byteLength;
    }
  } catch {
    cancel();
    return { state: signal.aborted ? 'timeout' : 'read_error' };
  } finally {
    signal.removeEventListener('abort', cancel);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or errored stream may already have released its reader.
    }
  }
}

/**
 * Fetches the pinned usage endpoint with Bearer auth. Never throws: every
 * failure mode (network, timeout, redirect, auth, parse, size) is a typed
 * failed/rate-limited result so the caller can advance the due horizon.
 */
export async function fetchOpencodeGoUsage(
  secret: Buffer,
  fetcher: OpencodeGoUsageFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
): Promise<OpencodeGoUsageFetchResult> {
  const url = canonicalUsageUrl();
  const token = asciiApiKey(secret);
  if (url === null) {
    return { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: null, retryAfterMs: null };
  }
  if (token === null) {
    return { state: 'failed', errorCode: 'credential_format_invalid', httpStatus: null, retryAfterMs: null };
  }

  const deadline = AbortSignal.timeout(OPENCODE_GO_USAGE_REQUEST_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'model-router' },
      redirect: 'manual',
      signal: timeoutSignal,
    });
  } catch (error) {
    const halted = signal?.aborted === true;
    const isTimeout = !halted && (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError'));
    return {
      state: 'failed',
      errorCode: isTimeout ? 'provider_timeout' : 'provider_network_error',
      httpStatus: null,
      retryAfterMs: null,
    };
  }

  if (timeoutSignal.aborted && !deadline.aborted) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_network_error', httpStatus: response.status, retryAfterMs: null };
  }
  const nowMs = Date.now();
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), nowMs);
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_redirect_rejected', httpStatus: response.status, retryAfterMs };
  }
  if (response.status === 401 || response.status === 403) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'credential_rejected', httpStatus: response.status, retryAfterMs };
  }
  if (response.status === 429) {
    cancelResponseBody(response);
    return { state: 'rate_limited', httpStatus: 429, retryAfterMs };
  }
  if (response.status < 200 || response.status >= 300) {
    cancelResponseBody(response);
    return {
      state: 'failed',
      errorCode: response.status >= 500 ? 'provider_unavailable' : 'provider_response_invalid',
      httpStatus: response.status,
      retryAfterMs,
    };
  }
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > OPENCODE_GO_USAGE_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_response_too_large', httpStatus: response.status, retryAfterMs };
  }
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: response.status, retryAfterMs };
  }
  const bodyResult = await boundedResponseBody(response, timeoutSignal);
  if (bodyResult.state === 'too_large') {
    return { state: 'failed', errorCode: 'provider_response_too_large', httpStatus: response.status, retryAfterMs };
  }
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    return {
      state: 'failed',
      errorCode: bodyResult.state === 'timeout' ? 'provider_timeout' : 'provider_network_error',
      httpStatus: response.status,
      retryAfterMs,
    };
  }
  const usage = parseOpencodeGoUsageResponse(bodyResult.bytes);
  if (!usage) {
    return { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: response.status, retryAfterMs };
  }
  return { state: 'ok', usage, fetchedAtMs: Date.now(), httpStatus: response.status };
}

/**
 * Failure not-before delay (sub2api nextOpenCodeGoUsageDelay): interval *
 * 2^min(failureCount-1, 6), capped at 24h, never below a Retry-After hint or
 * one minute, with ±10% jitter capped at 5 minutes.
 */
export function opencodeGoUsageFailureBackoffMs(
  intervalMs: number,
  failureCount: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const minimumDelay = retryAfterMs ?? 0;
  let base = clampOpencodeGoUsageIntervalMs(intervalMs);
  if (failureCount > 0) {
    base *= 2 ** Math.min(failureCount - 1, 6);
  }
  if (base > OPENCODE_GO_USAGE_MAX_DELAY_MS) base = OPENCODE_GO_USAGE_MAX_DELAY_MS;
  if (retryAfterMs !== null && retryAfterMs > base) base = retryAfterMs;
  const jitterRange = Math.min(base / 10, 5 * 60_000);
  if (jitterRange > 0) {
    base += Math.floor(random() * (jitterRange * 2 + 1)) - jitterRange;
  }
  if (base < minimumDelay) return minimumDelay;
  if (base < OPENCODE_GO_USAGE_MIN_BACKOFF_MS) return OPENCODE_GO_USAGE_MIN_BACKOFF_MS;
  return Math.round(base);
}

export interface OpencodeGoUsageWorkerOptions {
  /** Max wait between successful fetches of one account; clamped [5min, 24h]. */
  readonly intervalMs?: number;
  /** Floor between any two attempts of one account; clamped [1min, 60min]. */
  readonly debounceMs?: number;
  /** Round cadence; clamped [100ms, 1h]. */
  readonly pollIntervalMs?: number;
  /** Test/custom seam; production uses the global fetch with a pinned URL. */
  readonly fetch?: OpencodeGoUsageFetch;
  /** Test seam for deterministic clocks. */
  readonly now?: () => number;
  /** Test seam for deterministic backoff jitter. */
  readonly random?: () => number;
  /** Receives only stable cycle codes; never provider or credential data. */
  readonly onError?: (code: 'cycle_failed' | 'account_failed') => void;
}

function accountKey(account: OpencodeGoUsageAccountRef): string | null {
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

function positiveBound(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min) return min;
  return Math.min(value, max);
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runner = async (): Promise<void> => {
    while (true) {
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

/**
 * Round-based usage worker: every cycle claims at most 20 due accounts, fetches
 * them with at most 4 concurrent calls under a per-account singleflight, and
 * writes snapshot / failure / rate-limit state through the store. The halt
 * signal aborts in-flight fetches; close() drains them before returning.
 */
export class OpencodeGoUsageWorker {
  readonly intervalMs: number;
  readonly debounceMs: number;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<number>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failureStreaks = new Map<string, number>();
  private closePromise?: Promise<void>;

  constructor(
    private readonly store: OpencodeGoUsageStore,
    private readonly options: OpencodeGoUsageWorkerOptions = {},
  ) {
    if (!store || typeof store.readDueAccounts !== 'function') throw new TypeError('usage worker requires a store');
    this.options = Object.freeze({ ...options });
    this.intervalMs = clampOpencodeGoUsageIntervalMs(options.intervalMs);
    this.debounceMs = clampOpencodeGoUsageDebounceMs(options.debounceMs);
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Claims and processes one round; resolves the number of accounts fetched. */
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
    const nowMs = this.nowMs();
    const accounts = await this.store.readDueAccounts({
      nowMs,
      debounceMs: this.debounceMs,
      intervalMs: this.intervalMs,
      limit: OPENCODE_GO_USAGE_MAX_PER_ROUND,
    });
    let processed = 0;
    await runWithConcurrency(accounts, OPENCODE_GO_USAGE_CONCURRENCY, async (account) => {
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

  private async refreshAccount(account: OpencodeGoUsageAccountRef, key: string): Promise<void> {
    const attemptedAtMs = this.nowMs();
    let result: OpencodeGoUsageFetchResult | null;
    try {
      result = await this.store.withUnsealedApiKey(account, (secret) =>
        fetchOpencodeGoUsage(secret, this.options.fetch, this.halt.signal),
      );
    } catch {
      result = { state: 'failed', errorCode: 'credential_unavailable', httpStatus: null, retryAfterMs: null };
    }
    if (this.halt.signal.aborted) return;

    if (result === null) {
      await this.writeFailure(account, key, attemptedAtMs, 'credential_unavailable', null, null);
      return;
    }
    if (result.state === 'ok') {
      const nextDueAtMs = Math.max(result.fetchedAtMs + this.intervalMs, attemptedAtMs + this.debounceMs);
      await this.store.writeUsageSnapshot(account, {
        rolling5h: result.usage.rolling5h,
        weekly: result.usage.weekly,
        monthly: result.usage.monthly,
        fetchedAtMs: result.fetchedAtMs,
        nextDueAtMs,
      });
      this.failureStreaks.delete(key);
      const rateLimitedUntilMs = deriveOpencodeGoRateLimitUntilMs(result.usage, this.nowMs());
      if (rateLimitedUntilMs !== null) await this.store.markRateLimited(account, rateLimitedUntilMs);
      return;
    }
    const errorCode = result.state === 'rate_limited' ? 'provider_rate_limited' : result.errorCode;
    const retryAfterMs = result.retryAfterMs;
    await this.writeFailure(account, key, attemptedAtMs, errorCode, result.httpStatus, retryAfterMs);
    // A 429 with a precise Retry-After hint parks account scheduling for
    // exactly that window (sub2api semantics); without a hint the failure
    // backoff alone throttles the usage fetch, never the scheduler.
    if (result.state === 'rate_limited' && retryAfterMs !== null && retryAfterMs > 0) {
      await this.store.markRateLimited(account, attemptedAtMs + retryAfterMs);
    }
  }

  private async writeFailure(
    account: OpencodeGoUsageAccountRef,
    key: string,
    attemptedAtMs: number,
    errorCode: OpencodeGoUsageErrorCode,
    httpStatus: number | null,
    retryAfterMs: number | null,
  ): Promise<void> {
    const failureCount = (this.failureStreaks.get(key) ?? 0) + 1;
    this.failureStreaks.set(key, failureCount);
    const nextDueAtMs =
      attemptedAtMs + opencodeGoUsageFailureBackoffMs(this.intervalMs, failureCount, retryAfterMs, this.options.random);
    await this.store.writeUsageFailure(account, {
      attemptedAtMs,
      errorCode,
      httpStatus,
      retryAfterMs,
      nextDueAtMs,
      failureCount,
    });
  }

  async run(): Promise<void> {
    const pollIntervalMs = positiveBound(
      this.options.pollIntervalMs ?? OPENCODE_GO_USAGE_POLL_INTERVAL_MS,
      100,
      3_600_000,
    );
    while (!this.halt.signal.aborted) {
      try {
        await this.runOnce();
      } catch {
        try {
          this.options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate usage processing.
        }
      }
      await delay(pollIntervalMs, this.halt.signal);
    }
  }

  /** Aborts in-flight fetches and drains actual runs before store/KMS close. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns, ...this.inFlight.values()]).then(() => undefined);
    return this.closePromise;
  }
}

export interface OpencodeGoUsageWorkerHandle {
  close(): Promise<void>;
}

export function startOpencodeGoUsageWorker(
  store: OpencodeGoUsageStore,
  options: OpencodeGoUsageWorkerOptions = {},
): OpencodeGoUsageWorkerHandle {
  const worker = new OpencodeGoUsageWorker(store, options);
  const pollIntervalMs = positiveBound(options.pollIntervalMs ?? OPENCODE_GO_USAGE_POLL_INTERVAL_MS, 100, 3_600_000);
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
      await delayWithClose(pollIntervalMs);
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
