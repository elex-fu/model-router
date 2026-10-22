/**
 * Batch 3 CN-provider Coding Plan quota probe worker (design:
 * docs/capability-parity-roadmap-2026-10-16.md 批次三; sub2api reference:
 * backend/internal/service/cn_provider_quota_service.go). Periodically
 * probes the rolling-window quota endpoints for `zhipu` / `minimax`
 * coding-mode accounts and the Kimi Coding catalog products (both owners),
 * overwriting the existing account quota-window snapshot column families. The snapshot is
 * a scheduling signal only: it never enters the billing path and never
 * authorizes a profit/cost failover decision (093/099/108 quota-snapshot
 * precedent). payg accounts have no rolling-window quota endpoint and are
 * never claimed.
 *
 * Probe contracts (the quota.ts parser module owns the response semantics):
 * - zhipu: GET /api/monitor/usage/quota/limit with the Authorization header
 *   carrying the raw API key WITHOUT the Bearer prefix; team plans add
 *   ?type=2 plus the bigmodel-organization / bigmodel-project headers;
 * - kimi: GET /coding/v1/usages with a Bearer key; limits[].detail is
 *   rolling 5h and top-level usage is weekly;
 * - minimax: GET /v1/api/openplatform/coding_plan/remains with a Bearer key;
 *   only the model_remains "general" entry applies (video skipped).
 *
 * Worker semantics ported from the opencode-go usage worker (R5b-3) and the
 * sub2api CN quota service: 15min default refresh interval (5min hard
 * minimum, 24h maximum), 1min debounce floor, ≤20 accounts per round with ≤4
 * concurrent fetches, singleflight per account, 15s request timeout, 256KiB
 * bounded response body (sub2api cnQuotaMaxBodyBytes), redirects rejected,
 * failure backoff interval × 2^min(failures−1, 6) capped at 24h with
 * ±10%/5min jitter, and a SKIP LOCKED claim whose attempt stamp is the lease
 * (the store's job).
 *
 * Fail-closed rules:
 * - a window the upstream did not report is stored as NULL, never guessed;
 * - a parse reporting ZERO windows never overwrites the snapshot (it would
 *   erase real scheduling state);
 * - every failure mode advances the account's next-due horizon (no hot
 *   loops).
 */

import { MINIMAX_PROVIDER_ID, ZHIPU_PROVIDER_ID } from '../gateway/cn-providers/catalog-identity.js';
import {
  type CnQuotaTierSnapshot,
  KIMI_CODING_PROVIDER_ID,
  KIMI_CODING_QUOTA_URL,
  KIMI_CODING_QUOTA_URL_GLOBAL,
  minimaxQuotaUrl,
  parseKimiQuotaResponseBody,
  parseMinimaxQuotaResponseBody,
  parseZhipuQuotaResponseBody,
  zhipuQuotaUrl,
} from '../gateway/cn-providers/quota.js';

/** Compile-time fixed provider ids the due scan filters on. */
export const CN_QUOTA_PROVIDER_IDS: readonly string[] = Object.freeze([
  ZHIPU_PROVIDER_ID,
  MINIMAX_PROVIDER_ID,
  KIMI_CODING_PROVIDER_ID,
]);

export const CN_QUOTA_DEFAULT_INTERVAL_MS = 15 * 60_000;
export const CN_QUOTA_MIN_INTERVAL_MS = 5 * 60_000;
export const CN_QUOTA_MAX_INTERVAL_MS = 24 * 60 * 60_000;
export const CN_QUOTA_DEFAULT_DEBOUNCE_MS = 60_000;
export const CN_QUOTA_MIN_DEBOUNCE_MS = 60_000;
export const CN_QUOTA_MAX_DEBOUNCE_MS = 60 * 60_000;
export const CN_QUOTA_POLL_INTERVAL_MS = 60_000;
export const CN_QUOTA_REQUEST_TIMEOUT_MS = 15_000;
export const CN_QUOTA_MAX_RESPONSE_BYTES = 256 * 1024;
export const CN_QUOTA_MAX_PER_ROUND = 20;
export const CN_QUOTA_CONCURRENCY = 4;
export const CN_QUOTA_MIN_BACKOFF_MS = 60_000;
export const CN_QUOTA_MAX_DELAY_MS = 24 * 60 * 60_000;

/** One claimed account; the provider dimension selects the column family. */
export interface CnQuotaAccountRef {
  readonly ownerKind: 'tenant' | 'platform';
  readonly tenantId: string | null;
  readonly accountId: string;
  readonly providerId: string;
  readonly productId?: string;
  readonly failureCount?: number;
}

/** Upstream-observed quota snapshot (windows absent upstream stay null). */
export interface CnQuotaSnapshot {
  readonly fiveHour: CnQuotaTierSnapshot | null;
  readonly weekly: CnQuotaTierSnapshot | null;
  readonly fetchedAtMs: number;
  /** Worker-computed due horizon; the store persists it as next_due_at. */
  readonly nextDueAtMs: number;
}

export type CnQuotaErrorCode =
  | 'credential_unavailable'
  | 'credential_format_invalid'
  | 'credential_rejected'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_invalid'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected'
  | 'provider_business_error';

export interface CnQuotaFailure {
  readonly attemptedAtMs: number;
  readonly errorCode: CnQuotaErrorCode;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  readonly nextDueAtMs: number;
  readonly failureCount: number;
}

/**
 * The store contract the worker depends on (the Postgres implementation:
 * supply/cn-providers-quota-store-postgres.ts, migration 120 columns).
 */
export interface CnQuotaStore {
  readDueAccounts(input: {
    readonly nowMs: number;
    readonly debounceMs: number;
    readonly intervalMs: number;
    readonly limit: number;
  }): Promise<readonly CnQuotaAccountRef[]>;
  withUnsealedApiKey<T>(
    account: CnQuotaAccountRef,
    callback: (secret: Buffer, fetcher?: CnQuotaFetch) => Promise<T>,
    fetcher?: CnQuotaFetch,
  ): Promise<T | null>;
  writeQuotaSnapshot(account: CnQuotaAccountRef, snapshot: CnQuotaSnapshot): Promise<void>;
  writeQuotaFailure(account: CnQuotaAccountRef, failure: CnQuotaFailure): Promise<void>;
  markRateLimited(account: CnQuotaAccountRef, untilMs: number): Promise<void>;
}

/**
 * Per-account probe options (the deployment seam for the zhipu team plan
 * and international hosts): the default is the domestic personal-plan path.
 */
export interface CnQuotaProbeOptions {
  readonly international?: boolean;
  readonly team?: boolean;
  readonly organization?: string | null;
  readonly project?: string | null;
}

export type CnQuotaFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type CnQuotaFetchResult =
  | {
      readonly state: 'ok';
      readonly fiveHour: CnQuotaTierSnapshot | null;
      readonly weekly: CnQuotaTierSnapshot | null;
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
      readonly errorCode: CnQuotaErrorCode;
      readonly httpStatus: number | null;
      readonly retryAfterMs: number | null;
    };

export function clampCnQuotaIntervalMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return CN_QUOTA_DEFAULT_INTERVAL_MS;
  return Math.min(Math.max(Math.round(raw), CN_QUOTA_MIN_INTERVAL_MS), CN_QUOTA_MAX_INTERVAL_MS);
}

export function clampCnQuotaDebounceMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return CN_QUOTA_DEFAULT_DEBOUNCE_MS;
  return Math.min(Math.max(Math.round(raw), CN_QUOTA_MIN_DEBOUNCE_MS), CN_QUOTA_MAX_DEBOUNCE_MS);
}

function asciiApiKey(secret: Buffer): string | null {
  if (secret.length < 1 || secret.length > 4_096) return null;
  for (const byte of secret) {
    if (byte < 0x21 || byte > 0x7e) return null;
  }
  return secret.toString('ascii');
}

/** RFC 7231 Retry-After (delta-seconds or HTTP-date) as milliseconds from now. */
export function parseCnQuotaRetryAfterMs(header: string | null, nowMs: number): number | null {
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

function buildProbeRequest(
  providerId: string,
  token: string,
  options: CnQuotaProbeOptions,
): { readonly url: URL; readonly headers: Record<string, string> } | null {
  if (providerId === ZHIPU_PROVIDER_ID) {
    // The team-plan path keys on the organization id's presence (the sub2api
    // rule): ?type=2 plus the bigmodel-organization/-project headers exist
    // only for team credentials; personal plans keep the bare path.
    const organization =
      typeof options.organization === 'string' && options.organization.trim() !== ''
        ? options.organization.trim()
        : null;
    const url = zhipuQuotaUrl({ international: options.international, team: organization !== null });
    const headers: Record<string, string> = {
      // Zhipu's monitor endpoint authenticates with the RAW key — no Bearer
      // prefix (sub2api queryUsageForAccount).
      authorization: token,
      accept: 'application/json',
      'content-type': 'application/json',
      'accept-language': 'en-US,en',
      'user-agent': 'model-router',
    };
    if (organization !== null) {
      headers['bigmodel-organization'] = organization;
      if (typeof options.project === 'string' && options.project.trim() !== '') {
        headers['bigmodel-project'] = options.project.trim();
      }
    }
    return { url: new URL(url), headers };
  }
  if (providerId === KIMI_CODING_PROVIDER_ID) {
    return {
      url: new URL(options.international === true ? KIMI_CODING_QUOTA_URL_GLOBAL : KIMI_CODING_QUOTA_URL),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'model-router' },
    };
  }
  if (providerId === MINIMAX_PROVIDER_ID) {
    const url = minimaxQuotaUrl({ international: options.international });
    return {
      url: new URL(url),
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'model-router' },
    };
  }
  return null;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    // Body content is neither consumed nor surfaced.
  }
}

async function boundedResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<
  | { readonly state: 'ok'; readonly bytes: Uint8Array }
  | { readonly state: 'too_large' }
  | { readonly state: 'read_error' }
  | { readonly state: 'timeout' }
> {
  if (signal.aborted) {
    cancelResponseBody(response);
    return { state: 'timeout' };
  }
  if (!response.body) return { state: 'ok', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const buffer = new Uint8Array(CN_QUOTA_MAX_RESPONSE_BYTES);
  let bytesRead = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { state: 'timeout' };
      if (done) return { state: 'ok', bytes: buffer.subarray(0, bytesRead) };
      if (!(value instanceof Uint8Array)) {
        cancel();
        return { state: 'read_error' };
      }
      if (value.byteLength > CN_QUOTA_MAX_RESPONSE_BYTES - bytesRead) {
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
 * Fetches one account's quota snapshot. Never throws: every failure mode is
 * a typed result so the caller can advance the due horizon.
 */
export async function fetchCnProviderQuota(
  providerId: string,
  secret: Buffer,
  fetcher: CnQuotaFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
  options: CnQuotaProbeOptions = {},
): Promise<CnQuotaFetchResult> {
  const token = asciiApiKey(secret);
  if (token === null) {
    return { state: 'failed', errorCode: 'credential_format_invalid', httpStatus: null, retryAfterMs: null };
  }
  const probe = buildProbeRequest(providerId, token, options);
  if (probe === null) {
    return { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: null, retryAfterMs: null };
  }

  const deadline = AbortSignal.timeout(CN_QUOTA_REQUEST_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(probe.url, {
      method: 'GET',
      headers: probe.headers,
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
  const retryAfterMs = parseCnQuotaRetryAfterMs(response.headers.get('retry-after'), nowMs);
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
  if (declaredBytes !== null && declaredBytes > CN_QUOTA_MAX_RESPONSE_BYTES) {
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
  const parsed =
    providerId === KIMI_CODING_PROVIDER_ID
      ? parseKimiQuotaResponseBody(bodyResult.bytes)
      : providerId === ZHIPU_PROVIDER_ID
        ? parseZhipuQuotaResponseBody(bodyResult.bytes)
        : parseMinimaxQuotaResponseBody(bodyResult.bytes);
  if (parsed.state === 'error') {
    return {
      state: 'failed',
      errorCode: 'provider_business_error',
      httpStatus: response.status,
      retryAfterMs,
    };
  }
  const fiveHour = parsed.result.tiers.find((tier) => tier.window === '5h') ?? null;
  const weekly = parsed.result.tiers.find((tier) => tier.window === 'weekly') ?? null;
  if (fiveHour === null && weekly === null) {
    // Zero observed windows never overwrite the snapshot (it would erase
    // real scheduling state) — the opencode-go worker's fail-closed rule.
    return { state: 'failed', errorCode: 'provider_response_invalid', httpStatus: response.status, retryAfterMs };
  }
  return { state: 'ok', fiveHour, weekly, fetchedAtMs: Date.now(), httpStatus: response.status };
}

/** Failure not-before delay (the opencode-go backoff shape, sub2api parity). */
export function cnQuotaFailureBackoffMs(
  intervalMs: number,
  failureCount: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const minimumDelay = retryAfterMs ?? 0;
  let base = clampCnQuotaIntervalMs(intervalMs);
  if (failureCount > 0) {
    base *= 2 ** Math.min(failureCount - 1, 6);
  }
  if (base > CN_QUOTA_MAX_DELAY_MS) base = CN_QUOTA_MAX_DELAY_MS;
  if (retryAfterMs !== null && retryAfterMs > base) base = retryAfterMs;
  const jitterRange = Math.min(base / 10, 5 * 60_000);
  if (jitterRange > 0) {
    base += Math.floor(random() * (jitterRange * 2 + 1)) - jitterRange;
  }
  if (base < minimumDelay) return minimumDelay;
  if (base < CN_QUOTA_MIN_BACKOFF_MS) return CN_QUOTA_MIN_BACKOFF_MS;
  return Math.round(base);
}

export interface CnProvidersQuotaWorkerOptions {
  readonly intervalMs?: number;
  readonly debounceMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetch?: CnQuotaFetch;
  /**
   * Per-account probe options (zhipu team plan / international hosts). The
   * default is the domestic personal-plan path for every account.
   */
  readonly resolveProbeOptions?: (account: CnQuotaAccountRef) => CnQuotaProbeOptions;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly onError?: (code: 'cycle_failed' | 'account_failed') => void;
}

function accountKey(account: CnQuotaAccountRef): string | null {
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
  if (typeof account.providerId !== 'string') return null;
  return `${account.ownerKind}:${account.tenantId ?? ''}:${account.accountId}:${account.providerId}`;
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

/** Epoch-ms reset helpers for the snapshot write (RFC 3339 → epoch). */
export function cnQuotaResetAtMs(tier: CnQuotaTierSnapshot | null): number | null {
  if (tier === null || tier.resetAt === '') return null;
  const parsed = Date.parse(tier.resetAt);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Round-based quota worker: every cycle claims at most 20 due coding-plan
 * accounts, probes them with at most 4 concurrent calls under a per-account
 * singleflight, and writes snapshot / failure / rate-limit state through the
 * store. The halt signal aborts in-flight fetches; close() drains them.
 */
export class CnProvidersQuotaWorker {
  readonly intervalMs: number;
  readonly debounceMs: number;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<number>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failureStreaks = new Map<string, number>();
  private closePromise?: Promise<void>;

  constructor(
    private readonly store: CnQuotaStore,
    private readonly options: CnProvidersQuotaWorkerOptions = {},
  ) {
    if (!store || typeof store.readDueAccounts !== 'function') throw new TypeError('cn quota worker requires a store');
    this.options = Object.freeze({ ...options });
    this.intervalMs = clampCnQuotaIntervalMs(options.intervalMs);
    this.debounceMs = clampCnQuotaDebounceMs(options.debounceMs);
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

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
      limit: CN_QUOTA_MAX_PER_ROUND,
    });
    let processed = 0;
    await runWithConcurrency(accounts, CN_QUOTA_CONCURRENCY, async (account) => {
      const key = accountKey(account);
      if (key === null) {
        try {
          this.options.onError?.('account_failed');
        } catch {
          // An observer cannot terminate quota processing.
        }
        return;
      }
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
          // An observer cannot terminate quota processing.
        }
      } finally {
        this.inFlight.delete(key);
      }
    });
    return processed;
  }

  private async refreshAccount(account: CnQuotaAccountRef, key: string): Promise<void> {
    const attemptedAtMs = this.nowMs();
    let result: CnQuotaFetchResult | null;
    try {
      result = await this.store.withUnsealedApiKey(
        account,
        (secret, scopedFetch) =>
          fetchCnProviderQuota(
            account.providerId,
            secret,
            scopedFetch ?? this.options.fetch,
            this.halt.signal,
            this.options.resolveProbeOptions?.(account) ?? {
              international: account.providerId === KIMI_CODING_PROVIDER_ID && account.productId === 'kimi-code-global',
            },
          ),
        this.options.fetch,
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
      await this.store.writeQuotaSnapshot(account, {
        fiveHour: result.fiveHour,
        weekly: result.weekly,
        fetchedAtMs: result.fetchedAtMs,
        nextDueAtMs,
      });
      this.failureStreaks.delete(key);
      return;
    }
    const errorCode = result.state === 'rate_limited' ? 'provider_rate_limited' : result.errorCode;
    await this.writeFailure(account, key, attemptedAtMs, errorCode, result.httpStatus, result.retryAfterMs);
    if (result.state === 'rate_limited' && result.retryAfterMs !== null && result.retryAfterMs > 0) {
      await this.store.markRateLimited(account, attemptedAtMs + result.retryAfterMs);
    }
  }

  private async writeFailure(
    account: CnQuotaAccountRef,
    key: string,
    attemptedAtMs: number,
    errorCode: CnQuotaErrorCode,
    httpStatus: number | null,
    retryAfterMs: number | null,
  ): Promise<void> {
    const persistedFailures =
      Number.isSafeInteger(account.failureCount) && (account.failureCount ?? -1) >= 0 ? (account.failureCount ?? 0) : 0;
    const failureCount = Math.max(this.failureStreaks.get(key) ?? 0, persistedFailures) + 1;
    this.failureStreaks.set(key, failureCount);
    const nextDueAtMs =
      attemptedAtMs + cnQuotaFailureBackoffMs(this.intervalMs, failureCount, retryAfterMs, this.options.random);
    await this.store.writeQuotaFailure(account, {
      attemptedAtMs,
      errorCode,
      httpStatus,
      retryAfterMs,
      nextDueAtMs,
      failureCount,
    });
  }

  async run(): Promise<void> {
    const pollIntervalMs = positiveBound(this.options.pollIntervalMs ?? CN_QUOTA_POLL_INTERVAL_MS, 100, 3_600_000);
    while (!this.halt.signal.aborted) {
      try {
        await this.runOnce();
      } catch {
        try {
          this.options.onError?.('cycle_failed');
        } catch {
          // An observer cannot terminate quota processing.
        }
      }
      await delay(pollIntervalMs, this.halt.signal);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns, ...this.inFlight.values()]).then(() => undefined);
    return this.closePromise;
  }
}

export interface CnProvidersQuotaWorkerHandle {
  close(): Promise<void>;
}

export function startCnProvidersQuotaWorker(
  store: CnQuotaStore,
  options: CnProvidersQuotaWorkerOptions = {},
): CnProvidersQuotaWorkerHandle {
  const worker = new CnProvidersQuotaWorker(store, options);
  const pollIntervalMs = positiveBound(options.pollIntervalMs ?? CN_QUOTA_POLL_INTERVAL_MS, 100, 3_600_000);
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
          // An observer cannot terminate quota processing.
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
