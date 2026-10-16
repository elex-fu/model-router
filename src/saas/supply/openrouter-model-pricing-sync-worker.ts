/**
 * F6 OpenRouter model-catalog + per-token pricing sync worker (plan §R8a,
 * task #39).
 *
 * OpenRouter is a pay-as-you-go aggregation API — NOT a subscription
 * category. Its role in the supply chain is (a) an OpenAI-protocol
 * BYOK/platform supply provider (zero bridge for openai-protocol clients),
 * (b) the failover-chain-end overflow, and (c) the killer feature this
 * worker delivers: the official per-token dollar pricing for 200+ models
 * synced into saas_supplier_cost_versions so the R7 cost-priority
 * scheduler gets full data.
 *
 * Sync source and shape:
 * - `GET https://openrouter.ai/api/v1/models` — the public catalog; no
 *   credential is required, so this worker never touches the KMS or any
 *   sealed secret;
 * - each entry carries `id` (a `<vendor>/<model>` slug) and a `pricing`
 *   object whose `prompt` / `completion` (and optional
 *   `input_cache_read` / `input_cache_write`) fields are USD-per-token
 *   decimal strings such as "0.0000015". OpenRouter marks unsupported or
 *   negotiable prices with "-1";
 * - rational conversion is exact: a decimal string becomes a bigint
 *   numerator/denominator minor-units-per-token rate
 *   ("0.0000015" -> 3/20000 cents per token), reduced by GCD. No float
 *   ever enters the money path; JSON-number pricing values are rejected.
 *
 * Write path (reuse, never raw SQL): supplier cost rows are appended
 * through the existing pricing service method
 * `SaasPricingService.appendSupplierCostVersion` (the same append-only,
 * advisory-lock-serialized lineage the platform console uses), and catalog
 * structure (product / capability / rights / public-model alias) through
 * the existing `SaasCatalogService` registration methods, composed by the
 * service-backed store in openrouter-model-pricing-sync-store.ts.
 *
 * Idempotency / no-op semantics (no new migration, no persisted watermark):
 * - each supplier-cost append carries a content-addressed idempotency key
 *   derived from the model id, the exact rational rates and the policy
 *   version constants, with a fixed epoch effectiveAt (the established
 *   seeded-price convention; resolution orders by version DESC, so the
 *   newest synced price always wins). Identical prices therefore resolve
 *   to the existing row — a pure no-op — while a real price change derives
 *   a new key and appends the next version;
 * - an in-memory watermark (upstream ETag + catalog content digest)
 *   short-circuits rounds whose content did not change, so the steady
 *   state performs zero writes. A crashed or restarted worker simply
 *   refetches and replays idempotent no-ops — this is why no sync-state
 *   table or migration is needed;
 * - provider-rights model_scope rows accept at most 100 models, so the
 *   synced list is sharded into deterministic 100-model chunks under
 *   chunk-stable rights ids (openrouter-registration.ts).
 *
 * Usage observer: OpenRouter's normalized usage object is OpenAI-standard
 * {prompt_tokens, completion_tokens, total_tokens} on the Chat Completions
 * native, and the generic observers key on providerProtocol+providerOperation
 * (never provider id), so usage passes through unchanged — no variant was
 * added and none is needed.
 *
 * Scheduling note (R7): OpenRouter accounts are metered, so their supplier
 * cost rows are real prices and the cost-priority strategy naturally ranks
 * subscription pools (zero-cost supplier rates) ahead of them. No scheduler
 * wiring belongs to this module; the parallel R7 task owns the strategy.
 *
 * Fail-closed rules:
 * - a catalog entry with missing, malformed, numeric or negative
 *   ("-1"-style) prompt/completion pricing is skipped — that model gets no
 *   capability, alias or cost row, never a guessed price;
 * - a structurally invalid envelope (no `data` array, oversized list) fails
 *   the whole round; nothing partial is written because the watermark only
 *   advances after a fully completed round;
 * - store failures propagate: the round fails, the watermark stays put and
 *   the next round retries.
 */

import { createHash } from 'node:crypto';
import { chunkOpenRouterRightsScope, OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE } from '../catalog/openrouter-registration.js';
import {
  OPENROUTER_CAPABILITY_PROTOCOL,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MODELS_URL,
  OPENROUTER_PRODUCT_ID,
  OPENROUTER_PROVIDER_ID,
} from '../gateway/openrouter/catalog-identity.js';
import { isOpenRouterModelIdValid, normalizeOpenRouterModelId } from '../gateway/openrouter/model-catalog.js';
import type { AppendSupplierCostVersionInput, RationalRateInput } from '../pricing/types.js';

export const OPENROUTER_PRICING_REQUEST_TIMEOUT_MS = 15_000;
/** The 200+-model catalog with pricing is a multi-hundred-KiB document. */
export const OPENROUTER_PRICING_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Upstream catalog cap; a larger list is refused, not truncated. */
export const OPENROUTER_PRICING_MAX_ENTRIES = 1024;

export const OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS = 60 * 60_000;
export const OPENROUTER_PRICING_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
export const OPENROUTER_PRICING_SYNC_MAX_INTERVAL_MS = 24 * 60 * 60_000;

/** Policy version constants the supplier-cost append carries (digest inputs). */
export const OPENROUTER_SUPPLIER_COST_COMMERCIAL_POLICY_VERSION = 'openrouter-sync-commercial-v1';
export const OPENROUTER_SUPPLIER_COST_CALCULATOR_VERSION = 'openrouter-sync-calculator-v1';
export const OPENROUTER_SUPPLIER_COST_ROUNDING_VERSION = 'openrouter-sync-rounding-v1';
export const OPENROUTER_SUPPLIER_COST_CURRENCY = 'USD' as const;
/**
 * Fixed epoch effectiveAt: with a content-addressed idempotency key the
 * definition digest must stay stable across replays, and resolution orders
 * by version DESC among effective rows, so the newest synced price always
 * resolves (the established seeded-price convention).
 */
export const OPENROUTER_SUPPLIER_COST_EFFECTIVE_AT = new Date(0).toISOString();

export type OpenRouterModelPricingFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type OpenRouterModelPricingFetchErrorCode =
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_invalid'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected';

/** Exact minor-units (cents) per token; never a float. */
export type OpenRouterUsdPerTokenRate = RationalRateInput & {
  readonly numeratorMinorUnits: bigint;
  readonly denominatorUnits: bigint;
};

/** One synced model with its exact per-token supplier rates. */
export interface OpenRouterModelPricing {
  readonly model: string;
  readonly input: OpenRouterUsdPerTokenRate;
  readonly output: OpenRouterUsdPerTokenRate;
  readonly cacheRead: OpenRouterUsdPerTokenRate | null;
  readonly cacheWrite: OpenRouterUsdPerTokenRate | null;
}

const USD_PER_TOKEN_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
/** Keeps 100·digits far below the pricing bigint bounds (2^63-1). */
const USD_PER_TOKEN_MAX_SIGNIFICANT_DIGITS = 18;

function bigintGcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

/**
 * Exact decimal-string → rational conversion for a USD-per-token price:
 * "0.0000015" dollars/token becomes 3/20000 minor units (cents) per token.
 * Rejects everything the money path must never accept: non-strings (JSON
 * numbers are float-parsed before this code runs), signs ("-1" is
 * OpenRouter's negotiable marker), exponents, leading zeros, empty values
 * and over-precise inputs. "0" resolves to the explicit 0/1 free rate.
 */
export function parseUsdPerTokenMinorUnits(value: unknown): OpenRouterUsdPerTokenRate | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  const match = USD_PER_TOKEN_DECIMAL_PATTERN.exec(trimmed);
  if (match === null) return null;
  const integer = match[1] as string;
  const fraction = match[2] ?? '';
  if (integer.length + fraction.length > USD_PER_TOKEN_MAX_SIGNIFICANT_DIGITS) return null;
  const dollars = BigInt(`${integer}${fraction}`);
  if (dollars === 0n) return { numeratorMinorUnits: 0n, denominatorUnits: 1n };
  // dollars/token -> minor units (cents) per token: multiply by 100.
  let numerator = dollars * 100n;
  let denominator = 10n ** BigInt(fraction.length);
  const divisor = bigintGcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numeratorMinorUnits: numerator, denominatorUnits: denominator };
}

function optionalUsdPerTokenMinorUnits(
  pricing: Record<string, unknown>,
  keys: readonly string[],
): OpenRouterUsdPerTokenRate | null {
  for (const key of keys) {
    const value = pricing[key];
    if (value === undefined || value === null) continue;
    return parseUsdPerTokenMinorUnits(value);
  }
  return null;
}

function isModelEntry(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strict envelope parse with fail-closed per-entry semantics: the `data`
 * field must be a real array (an empty array is authoritative; a missing,
 * null or non-array field is not), and every entry must be an object.
 * Entries whose id is invalid/duplicated or whose prompt/completion pricing
 * is missing/malformed are skipped and counted — they never receive a
 * guessed cost row — while the rest of the catalog syncs normally.
 */
export function parseOpenRouterModelPricingResponseBody(bytes: Uint8Array): {
  readonly models: readonly OpenRouterModelPricing[];
  readonly skippedEntryCount: number;
} | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  if (data.length > OPENROUTER_PRICING_MAX_ENTRIES) return null;
  const seen = new Set<string>();
  const models: OpenRouterModelPricing[] = [];
  let skippedEntryCount = 0;
  for (const entry of data) {
    if (!isModelEntry(entry)) {
      skippedEntryCount += 1;
      continue;
    }
    const rawId = entry.id;
    if (typeof rawId !== 'string') {
      skippedEntryCount += 1;
      continue;
    }
    const model = normalizeOpenRouterModelId(rawId);
    if (model === '' || !isOpenRouterModelIdValid(model) || seen.has(model)) {
      skippedEntryCount += 1;
      continue;
    }
    const pricing = isModelEntry(entry.pricing) ? (entry.pricing as Record<string, unknown>) : null;
    const input = pricing === null ? null : parseUsdPerTokenMinorUnits(pricing.prompt);
    const output = pricing === null ? null : parseUsdPerTokenMinorUnits(pricing.completion);
    if (input === null || output === null) {
      skippedEntryCount += 1;
      continue;
    }
    seen.add(model);
    models.push({
      model,
      input,
      output,
      cacheRead: pricing === null ? null : optionalUsdPerTokenMinorUnits(pricing, ['input_cache_read', 'cache_read']),
      cacheWrite:
        pricing === null ? null : optionalUsdPerTokenMinorUnits(pricing, ['input_cache_write', 'cache_write']),
    });
  }
  return {
    models: normalizeOpenRouterModelPricing(models),
    skippedEntryCount,
  };
}

/** Deterministic order + dedup over the parsed, priced model list. */
export function normalizeOpenRouterModelPricing(
  models: readonly OpenRouterModelPricing[],
): readonly OpenRouterModelPricing[] {
  const byModel = new Map<string, OpenRouterModelPricing>();
  for (const model of models) {
    if (!byModel.has(model.model)) byModel.set(model.model, model);
  }
  return Object.freeze([...byModel.values()].sort((left, right) => left.model.localeCompare(right.model)));
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
  const buffer = new Uint8Array(OPENROUTER_PRICING_MAX_RESPONSE_BYTES);
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
      if (value.byteLength > OPENROUTER_PRICING_MAX_RESPONSE_BYTES - bytesRead) {
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

export type OpenRouterModelPricingFetchResult =
  | {
      readonly state: 'ok';
      readonly models: readonly OpenRouterModelPricing[];
      readonly skippedEntryCount: number;
      readonly etag: string | null;
      readonly fetchedAtMs: number;
    }
  | { readonly state: 'not_modified'; readonly fetchedAtMs: number }
  | { readonly state: 'failed'; readonly errorCode: OpenRouterModelPricingFetchErrorCode };

/**
 * Fetches the pinned public models catalog. Never throws: every failure
 * mode (network, timeout, redirect, rate limit, parse, size) is a typed
 * failed result. `ifNoneMatch` revalidates a cached ETag.
 */
export async function fetchOpenRouterModelPricing(
  fetcher: OpenRouterModelPricingFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
  options: { readonly ifNoneMatch?: string | null } = {},
): Promise<OpenRouterModelPricingFetchResult> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'model-router' };
  const ifNoneMatch = options.ifNoneMatch?.trim();
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;

  const deadline = AbortSignal.timeout(OPENROUTER_PRICING_REQUEST_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(new URL(OPENROUTER_MODELS_URL), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: timeoutSignal,
    });
  } catch (error) {
    const halted = signal?.aborted === true;
    const isTimeout = !halted && (deadline.aborted || (error instanceof Error && error.name === 'TimeoutError'));
    return { state: 'failed', errorCode: isTimeout ? 'provider_timeout' : 'provider_network_error' };
  }

  if (response.status === 304) {
    cancelResponseBody(response);
    return { state: 'not_modified', fetchedAtMs: Date.now() };
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_redirect_rejected' };
  }
  if (response.status === 429) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_rate_limited' };
  }
  if (response.status < 200 || response.status >= 300) {
    cancelResponseBody(response);
    return {
      state: 'failed',
      errorCode: response.status >= 500 ? 'provider_unavailable' : 'provider_response_invalid',
    };
  }
  const contentLength = response.headers.get('content-length');
  const declaredBytes = contentLength !== null && /^\d{1,12}$/.test(contentLength) ? Number(contentLength) : null;
  if (declaredBytes !== null && declaredBytes > OPENROUTER_PRICING_MAX_RESPONSE_BYTES) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_response_too_large' };
  }
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'provider_response_invalid' };
  }
  const bodyResult = await boundedResponseBody(response, timeoutSignal);
  if (bodyResult.state === 'too_large') return { state: 'failed', errorCode: 'provider_response_too_large' };
  if (bodyResult.state === 'read_error' || bodyResult.state === 'timeout') {
    return {
      state: 'failed',
      errorCode: bodyResult.state === 'timeout' ? 'provider_timeout' : 'provider_network_error',
    };
  }
  const parsed = parseOpenRouterModelPricingResponseBody(bodyResult.bytes);
  if (parsed === null) return { state: 'failed', errorCode: 'provider_response_invalid' };
  const etag = response.headers.get('etag');
  return {
    state: 'ok',
    models: parsed.models,
    skippedEntryCount: parsed.skippedEntryCount,
    etag: etag !== null && etag.trim() !== '' ? etag : null,
    fetchedAtMs: Date.now(),
  };
}

/** One resolvable openrouter pricing target (alias + capability + rights). */
export interface OpenRouterModelPricingTarget {
  readonly publicModelId: string;
  readonly publicModelVersion: number;
  readonly resolvedModel: string;
  readonly protocol: string;
  readonly endpoint: string;
}

/**
 * The store contract the sync worker depends on. The service-backed default
 * implementation (openrouter-model-pricing-sync-store.ts) reuses
 * SaasCatalogService registration methods and
 * SaasPricingService.appendSupplierCostVersion / listPlatformPricingTargets
 * — the existing supplier-cost write path — so no raw SQL and no new
 * migration exist anywhere in this feature. A duplicate product or alias is
 * not an error (idempotent structure seeding); appendSupplierCost is
 * idempotent per the caller's content-addressed idempotency key.
 */
export interface OpenRouterModelPricingSyncStore {
  /** Registers the provider product; a duplicate is a no-op. */
  ensureProduct(): Promise<void>;
  /** Appends one verified capability version for the model. */
  registerCapability(model: string): Promise<void>;
  /** Appends one platform-rights version covering the chunk's models. */
  registerRightsChunk(chunkIndex: number, models: readonly string[]): Promise<void>;
  /**
   * Registers the `openrouter/<model>` public alias; resolves null when the
   * alias already exists (its identity then arrives via listProviderTargets
   * once capability + rights make it a resolvable target).
   */
  registerPublicAlias(
    model: string,
  ): Promise<{ readonly publicModelId: string; readonly publicModelVersion: number } | null>;
  /** Lists the provider's active pricing targets (all pages, filtered). */
  listProviderTargets(): Promise<readonly OpenRouterModelPricingTarget[]>;
  /** Appends one supplier cost version; resolves the stored version number. */
  appendSupplierCost(input: AppendSupplierCostVersionInput): Promise<{ readonly version: number }>;
}

export function clampOpenRouterPricingSyncIntervalMs(raw: number | undefined): number {
  if (raw === undefined) return OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(raw)) return OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS;
  return Math.min(
    Math.max(Math.round(raw), OPENROUTER_PRICING_SYNC_MIN_INTERVAL_MS),
    OPENROUTER_PRICING_SYNC_MAX_INTERVAL_MS,
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rateKeyPart(rate: OpenRouterUsdPerTokenRate | null): string {
  return rate === null ? '-' : `${rate.numeratorMinorUnits.toString(10)}/${rate.denominatorUnits.toString(10)}`;
}

function modelPricingCanonical(pricing: OpenRouterModelPricing): string {
  return [
    pricing.model,
    'in',
    rateKeyPart(pricing.input),
    'out',
    rateKeyPart(pricing.output),
    'cr',
    rateKeyPart(pricing.cacheRead),
    'cw',
    rateKeyPart(pricing.cacheWrite),
  ].join('|');
}

/**
 * Content digest over the whole priced catalog: the watermark's
 * change detector.
 */
export function openRouterModelPricingDigest(models: readonly OpenRouterModelPricing[]): string {
  return sha256Hex(models.map(modelPricingCanonical).join('\n'));
}

/**
 * Content-addressed idempotency key for one supplier-cost append: derived
 * from the model id, the exact rational rates and the policy version
 * constants, so identical prices always replay onto the existing row while
 * any change (rates or policy constants) derives a fresh key and appends
 * the next version.
 */
export function openRouterSupplierCostIdempotencyKey(pricing: OpenRouterModelPricing): string {
  const policyCanonical = [
    OPENROUTER_SUPPLIER_COST_COMMERCIAL_POLICY_VERSION,
    OPENROUTER_SUPPLIER_COST_CALCULATOR_VERSION,
    OPENROUTER_SUPPLIER_COST_ROUNDING_VERSION,
    OPENROUTER_SUPPLIER_COST_CURRENCY,
    OPENROUTER_SUPPLIER_COST_EFFECTIVE_AT,
  ].join('|');
  return `openrouter-sc-v1-${sha256Hex(pricing.model).slice(0, 16)}-${sha256Hex(`${modelPricingCanonical(pricing)}#${policyCanonical}`).slice(0, 16)}`;
}

/** Builds the exact AppendSupplierCostVersionInput for one synced model. */
export function openRouterSupplierCostVersionInput(
  pricing: OpenRouterModelPricing,
  target: Pick<OpenRouterModelPricingTarget, 'publicModelId' | 'publicModelVersion'>,
): AppendSupplierCostVersionInput {
  return {
    publicModelId: target.publicModelId,
    publicModelVersion: target.publicModelVersion,
    providerId: OPENROUTER_PROVIDER_ID,
    productId: OPENROUTER_PRODUCT_ID,
    resolvedModel: pricing.model,
    protocol: OPENROUTER_CAPABILITY_PROTOCOL,
    endpoint: OPENROUTER_ENDPOINT,
    currency: OPENROUTER_SUPPLIER_COST_CURRENCY,
    idempotencyKey: openRouterSupplierCostIdempotencyKey(pricing),
    effectiveAt: OPENROUTER_SUPPLIER_COST_EFFECTIVE_AT,
    commercialPolicyVersion: OPENROUTER_SUPPLIER_COST_COMMERCIAL_POLICY_VERSION,
    calculatorVersion: OPENROUTER_SUPPLIER_COST_CALCULATOR_VERSION,
    roundingVersion: OPENROUTER_SUPPLIER_COST_ROUNDING_VERSION,
    roundingMode: 'half_up' as const,
    roundingBoundary: 'total' as const,
    rates: {
      input: pricing.input,
      output: pricing.output,
      ...(pricing.cacheRead === null ? {} : { cache_read: pricing.cacheRead }),
      ...(pricing.cacheWrite === null ? {} : { cache_write: pricing.cacheWrite }),
    },
  };
}

export type OpenRouterModelPricingSyncRound =
  | {
      readonly state: 'synced';
      readonly fetchedAtMs: number;
      readonly modelCount: number;
      readonly appendedCount: number;
      readonly skippedEntryCount: number;
      readonly registeredStructureCount: number;
      /** Alias writes deferred this round (pre-existing or failed); retried while uncovered. */
      readonly aliasDeferredCount: number;
      readonly untargetedCount: number;
    }
  | { readonly state: 'not_modified'; readonly fetchedAtMs: number }
  | { readonly state: 'unchanged'; readonly fetchedAtMs: number; readonly modelCount: number }
  | { readonly state: 'failed'; readonly errorCode: OpenRouterModelPricingFetchErrorCode }
  | { readonly state: 'aborted' };

export interface OpenRouterModelPricingSyncWorkerOptions {
  /** Delay between completed sync rounds; clamped [5min, 24h], default 1h. */
  readonly intervalMs?: number;
  /** Test/custom seam; production uses the global fetch with a pinned URL. */
  readonly fetch?: OpenRouterModelPricingFetch;
  /** Test seam for deterministic clocks. */
  readonly now?: () => number;
  /** Receives only stable cycle codes; never provider or credential data. */
  readonly onError?: (code: 'fetch_failed' | 'round_failed') => void;
}

interface SyncWatermark {
  readonly etag: string | null;
  readonly digest: string;
  readonly syncedAtMs: number;
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

/**
 * Round-based pricing sync: fetch (ETag-conditional) → parse → ensure
 * catalog structure for uncovered models → append content-addressed
 * supplier cost versions. A singleflight guards concurrent rounds; close()
 * aborts the in-flight fetch and drains the round before returning.
 */
export class OpenRouterModelPricingSyncWorker {
  readonly intervalMs: number;
  private readonly halt = new AbortController();
  private readonly activeRuns = new Set<Promise<OpenRouterModelPricingSyncRound>>();
  private sync: Promise<OpenRouterModelPricingSyncRound> | null = null;
  private watermark: SyncWatermark | null = null;
  private closePromise?: Promise<void>;

  constructor(
    private readonly store: OpenRouterModelPricingSyncStore,
    private readonly options: OpenRouterModelPricingSyncWorkerOptions = {},
  ) {
    if (!store || typeof store.listProviderTargets !== 'function') {
      throw new TypeError('openrouter pricing sync worker requires a store');
    }
    this.options = Object.freeze({ ...options });
    this.intervalMs = clampOpenRouterPricingSyncIntervalMs(options.intervalMs);
  }

  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The last completed round's watermark (test/observability seam). */
  currentWatermark(): SyncWatermark | null {
    return this.watermark;
  }

  /** Performs one sync round; concurrent calls share the in-flight round. */
  async runOnce(): Promise<OpenRouterModelPricingSyncRound> {
    if (this.halt.signal.aborted) return { state: 'aborted' };
    const run = this.syncRoundShared();
    this.activeRuns.add(run);
    try {
      return await run;
    } catch (error) {
      if (this.halt.signal.aborted) return { state: 'aborted' };
      throw error;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private syncRoundShared(): Promise<OpenRouterModelPricingSyncRound> {
    this.sync ??= (async () => {
      try {
        return await this.syncRound();
      } finally {
        this.sync = null;
      }
    })();
    return this.sync;
  }

  private async syncRound(): Promise<OpenRouterModelPricingSyncRound> {
    const watermark = this.watermark;
    const result = await fetchOpenRouterModelPricing(this.options.fetch, this.halt.signal, {
      ifNoneMatch: watermark?.etag ?? null,
    });
    if (this.halt.signal.aborted) return { state: 'aborted' };
    if (result.state === 'failed') {
      try {
        this.options.onError?.('fetch_failed');
      } catch {
        // An observer cannot terminate the sync round.
      }
      return { state: 'failed', errorCode: result.errorCode };
    }
    if (result.state === 'not_modified') {
      // Upstream says the cached catalog is still current: nothing to do.
      return { state: 'not_modified', fetchedAtMs: result.fetchedAtMs };
    }

    const models = result.models;
    const digest = openRouterModelPricingDigest(models);
    if (watermark !== null && watermark.digest === digest) {
      // Same content, new ETag (or none): refresh the watermark only.
      this.watermark = { etag: result.etag, digest, syncedAtMs: this.nowMs() };
      return { state: 'unchanged', fetchedAtMs: result.fetchedAtMs, modelCount: models.length };
    }

    // Structure pass: register capability/rights/alias for models that are
    // not yet resolvable pricing targets, then re-read the target list so
    // freshly registered models are priced in this same round.
    const modelIds = models.map((model) => model.model);
    const chunkIndexOf = new Map(
      modelIds.map((model, index) => [model, Math.floor(index / OPENROUTER_RIGHTS_SCOPE_CHUNK_SIZE)] as const),
    );
    let targets = await this.store.listProviderTargets();
    const covered = new Map(targets.map((target) => [target.resolvedModel, target] as const));
    const uncovered = modelIds.filter((model) => !covered.has(model));
    let aliasDeferredCount = 0;
    if (uncovered.length > 0) {
      await this.store.ensureProduct();
      for (const model of uncovered) {
        await this.store.registerCapability(model);
      }
      // Re-register every rights chunk that contains an uncovered model,
      // with its current deterministic membership (≤ 100 models per chunk).
      const dirtyChunks = new Set(uncovered.map((model) => chunkIndexOf.get(model) ?? 0));
      const chunks = chunkOpenRouterRightsScope(modelIds);
      for (const chunkIndex of [...dirtyChunks].sort((left, right) => left - right)) {
        const chunk = chunks[chunkIndex];
        if (chunk !== undefined) await this.store.registerRightsChunk(chunkIndex, chunk);
      }
      let deferredThisRound = 0;
      for (const model of uncovered) {
        // A pre-existing alias (operator-seeded, or a prior partial round)
        // makes the insert conflict — and the catalog service currently
        // surfaces that duplicate as CATALOG_STORAGE_ERROR (the
        // PUBLIC_MODEL_ALIAS_EXISTS mapping sits above a query wrapper that
        // already remapped the unique violation), so the store's own
        // duplicate tolerance cannot catch every spelling. Tolerate the
        // alias write per model instead of failing the round: the model
        // whose alias pre-existed still becomes a pricing target once
        // capability + rights cover it (the re-list below proves it), and a
        // genuinely failed alias leaves the model untargeted — unpriced and
        // retried next round, never guessed (fail-closed).
        try {
          await this.store.registerPublicAlias(model);
        } catch {
          deferredThisRound += 1;
        }
      }
      aliasDeferredCount = deferredThisRound;
      targets = await this.store.listProviderTargets();
      for (const target of targets) covered.set(target.resolvedModel, target);
    }

    // Pricing pass: append the content-addressed supplier cost version for
    // every model whose target resolves under this provider's endpoint and
    // native protocol. Anything else stays unpriced (fail-closed).
    let appendedCount = 0;
    let untargetedCount = 0;
    for (const pricing of models) {
      const target = covered.get(pricing.model);
      if (
        target === undefined ||
        target.endpoint !== OPENROUTER_ENDPOINT ||
        target.protocol !== OPENROUTER_CAPABILITY_PROTOCOL
      ) {
        untargetedCount += 1;
        continue;
      }
      await this.store.appendSupplierCost(openRouterSupplierCostVersionInput(pricing, target));
      appendedCount += 1;
    }

    this.watermark = { etag: result.etag, digest, syncedAtMs: this.nowMs() };
    return {
      state: 'synced',
      fetchedAtMs: result.fetchedAtMs,
      modelCount: models.length,
      appendedCount,
      skippedEntryCount: result.skippedEntryCount,
      registeredStructureCount: uncovered.length,
      aliasDeferredCount,
      untargetedCount,
    };
  }

  async run(): Promise<void> {
    while (!this.halt.signal.aborted) {
      try {
        await this.runOnce();
      } catch {
        try {
          this.options.onError?.('round_failed');
        } catch {
          // An observer cannot terminate the sync loop.
        }
      }
      await delay(this.intervalMs, this.halt.signal);
    }
  }

  /** Aborts the in-flight fetch and drains the round before store close. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.halt.abort();
    this.closePromise = Promise.allSettled([...this.activeRuns, ...(this.sync === null ? [] : [this.sync])]).then(
      () => undefined,
    );
    return this.closePromise;
  }
}

export interface OpenRouterModelPricingSyncWorkerHandle {
  close(): Promise<void>;
}

export function startOpenRouterModelPricingSyncWorker(
  store: OpenRouterModelPricingSyncStore,
  options: OpenRouterModelPricingSyncWorkerOptions = {},
): OpenRouterModelPricingSyncWorkerHandle {
  const worker = new OpenRouterModelPricingSyncWorker(store, options);
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
          options.onError?.('round_failed');
        } catch {
          // An observer cannot terminate the sync loop.
        }
      }
      if (closed) break;
      await delayWithClose(worker.intervalMs);
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
