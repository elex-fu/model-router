/**
 * R5b-4 OpenCode Go upstream model-catalog sync (design:
 * docs/token-resale-implementation-plan-2026-10-15.md §R5b, task #24).
 *
 * Sub2api semantics (backend/internal/service/openai_codex_models_service.go
 * `fetchCachedOpenAIModels` + `openaiModelsCache`, applied to the OpenCode Go
 * OpenAI-format models endpoint):
 * - fetch `GET {OPENCODE_GO_BASE_URL}/v1/models` with Bearer api_key;
 * - cache the normalized model list with a 1 minute fresh TTL and a 5 minute
 *   stale allowance: fresh entries are served directly, stale entries are
 *   served while a singleflight background refresh runs, and a reader with
 *   no usable entry awaits the in-flight refresh exactly once;
 * - revalidation is conditional: the cached upstream ETag is sent as
 *   If-None-Match and a 304 keeps the cached list while refreshing the
 *   timestamps;
 * - the built-in fallback catalog (model-catalog.ts) is the merge base and
 *   the never-fail floor: the served list is always
 *   union(normalized upstream ids, OPENCODE_GO_FALLBACK_MODEL_IDS), so a
 *   model that has not synced (or a flapping upstream) can never remove a
 *   built-in id, and `list()` never rejects.
 *
 * Pure module: no DB access, no workers. The credential is supplied by the
 * caller (a platform-pool account's sealed key) through the same
 * secret-injection seam the usage worker uses; no secret is ever stored,
 * logged, or embedded here.
 */

import { OPENCODE_GO_MODELS_URL } from './catalog-identity.js';
import { normalizeOpenCodeGoModelId, OPENCODE_GO_FALLBACK_MODEL_IDS } from './model-catalog.js';

export const OPENCODE_GO_MODELS_TTL_MS = 60_000;
export const OPENCODE_GO_MODELS_STALE_MS = 5 * 60_000;
export const OPENCODE_GO_MODELS_REQUEST_TIMEOUT_MS = 15_000;
export const OPENCODE_GO_MODELS_MAX_RESPONSE_BYTES = 512 * 1024;
/** sub2api catalog caps; a larger upstream list is refused, not truncated. */
export const OPENCODE_GO_MODELS_MAX_ENTRIES = 512;
export const OPENCODE_GO_MODELS_MAX_ID_LENGTH = 200;

export type OpencodeGoModelsFetch = (url: URL, init: RequestInit) => Promise<Response>;

export type OpenCodeGoModelsFetchErrorCode =
  | 'credential_format_invalid'
  | 'credential_rejected'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_network_error'
  | 'provider_response_invalid'
  | 'provider_response_too_large'
  | 'provider_redirect_rejected';

export type OpenCodeGoModelsFetchResult =
  | {
      readonly state: 'ok';
      readonly models: readonly string[];
      readonly etag: string | null;
      readonly fetchedAtMs: number;
    }
  | { readonly state: 'not_modified'; readonly fetchedAtMs: number }
  | { readonly state: 'failed'; readonly errorCode: OpenCodeGoModelsFetchErrorCode };

function asciiApiKey(secret: Buffer): string | null {
  if (secret.length < 1 || secret.length > 4_096) return null;
  for (const byte of secret) {
    if (byte < 0x21 || byte > 0x7e) return null;
  }
  return secret.toString('ascii');
}

function cancelResponseBody(response: Response): void {
  if (!response.body || typeof response.body.cancel !== 'function') return;
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
  const buffer = new Uint8Array(OPENCODE_GO_MODELS_MAX_RESPONSE_BYTES);
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
      if (value.byteLength > OPENCODE_GO_MODELS_MAX_RESPONSE_BYTES - bytesRead) {
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

function modelIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= OPENCODE_GO_MODELS_MAX_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

/**
 * Strict OpenAI `/v1/models` envelope parse (sub2api `modelCatalogEntries`
 * semantics): the `data` field must be a real array — an empty array is
 * authoritative, but a missing field, null, an error envelope, or a
 * non-array must not become a successful empty list.
 */
export function parseOpenCodeGoModelsResponseBody(bytes: Uint8Array): readonly string[] | null {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;
  if (data.length > OPENCODE_GO_MODELS_MAX_ENTRIES) return null;
  const models: string[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const id = (entry as Record<string, unknown>).id;
    if (!modelIdentifier(id)) return null;
    models.push(id);
  }
  return models;
}

/**
 * Normalizes upstream model ids (namespace prefixes, case, whitespace) into
 * the canonical rule-table vocabulary, dropping empties and duplicates, and
 * returns a deterministic sorted order.
 */
export function normalizeOpenCodeGoModelIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    const normalized = normalizeOpenCodeGoModelId(id);
    if (normalized !== '') seen.add(normalized);
  }
  return Object.freeze([...seen].sort((left, right) => left.localeCompare(right)));
}

/**
 * The served catalog: the normalized upstream list merged over the built-in
 * fallback (union, sorted, deduplicated). `null` upstream (never synced or
 * fetch failed) is exactly the fallback list.
 */
export function mergeOpenCodeGoModelCatalog(upstreamModels: readonly string[] | null): readonly string[] {
  return normalizeOpenCodeGoModelIds([...(upstreamModels ?? []), ...OPENCODE_GO_FALLBACK_MODEL_IDS]);
}

/**
 * Fetches the pinned models endpoint with Bearer auth. Never throws: every
 * failure mode (network, timeout, redirect, auth, parse, size) is a typed
 * failed result. `ifNoneMatch` revalidates a cached ETag.
 */
export async function fetchOpencodeGoModels(
  secret: Buffer,
  fetcher: OpencodeGoModelsFetch = (url, init) => fetch(url, init),
  signal?: AbortSignal,
  options: { readonly ifNoneMatch?: string | null } = {},
): Promise<OpenCodeGoModelsFetchResult> {
  const token = asciiApiKey(secret);
  if (token === null) return { state: 'failed', errorCode: 'credential_format_invalid' };

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'user-agent': 'model-router',
  };
  const ifNoneMatch = options.ifNoneMatch?.trim();
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;

  const deadline = AbortSignal.timeout(OPENCODE_GO_MODELS_REQUEST_TIMEOUT_MS);
  const timeoutSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  let response: Response;
  try {
    timeoutSignal.throwIfAborted();
    response = await fetcher(new URL(OPENCODE_GO_MODELS_URL), {
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
  if (response.status === 401 || response.status === 403) {
    cancelResponseBody(response);
    return { state: 'failed', errorCode: 'credential_rejected' };
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
  if (declaredBytes !== null && declaredBytes > OPENCODE_GO_MODELS_MAX_RESPONSE_BYTES) {
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
  const models = parseOpenCodeGoModelsResponseBody(bodyResult.bytes);
  if (models === null) return { state: 'failed', errorCode: 'provider_response_invalid' };
  const etag = response.headers.get('etag');
  return {
    state: 'ok',
    models: normalizeOpenCodeGoModelIds(models),
    etag: etag !== null && etag.trim() !== '' ? etag : null,
    fetchedAtMs: Date.now(),
  };
}

interface CacheEntry {
  readonly models: readonly string[];
  readonly etag: string | null;
  readonly fetchedAtMs: number;
}

export interface OpenCodeGoModelCatalogCacheOptions {
  /** Supplies the platform-pool account key; called only inside a refresh. */
  readonly resolveSecret: () => Buffer | Promise<Buffer>;
  /** Test/custom seam; production uses the global fetch with a pinned URL. */
  readonly fetch?: OpencodeGoModelsFetch;
  /** Test seam for deterministic clocks. */
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly staleMs?: number;
}

/**
 * The /v1/models sync cache. `list()` never rejects: it returns the merged
 * catalog (upstream ∪ built-in fallback) from the fresh or stale cache, or
 * awaits a singleflight refresh, or falls back to the built-in list when the
 * upstream has never synced or the refresh failed.
 */
export class OpenCodeGoModelCatalogCache {
  private readonly options: OpenCodeGoModelCatalogCacheOptions;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private entry: CacheEntry | null = null;
  private refresh: Promise<CacheEntry | null> | null = null;

  constructor(options: OpenCodeGoModelCatalogCacheOptions) {
    if (!options || typeof options.resolveSecret !== 'function') {
      throw new TypeError('OpenCodeGoModelCatalogCache requires a resolveSecret seam');
    }
    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
      throw new TypeError('OpenCodeGoModelCatalogCache fetch seam must be callable');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('OpenCodeGoModelCatalogCache now seam must be callable');
    }
    this.options = options;
    this.ttlMs = options.ttlMs ?? OPENCODE_GO_MODELS_TTL_MS;
    this.staleMs = options.staleMs ?? OPENCODE_GO_MODELS_STALE_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new TypeError('OpenCodeGoModelCatalogCache ttlMs must be a positive integer');
    }
    if (!Number.isSafeInteger(this.staleMs) || this.staleMs < this.ttlMs) {
      throw new TypeError('OpenCodeGoModelCatalogCache staleMs must be an integer >= ttlMs');
    }
  }

  /** The upstream-sourced entry, when one exists (test/observability seam). */
  currentEntry(): CacheEntry | null {
    return this.entry;
  }

  async list(): Promise<readonly string[]> {
    const now = this.options.now?.() ?? Date.now();
    const entry = this.entry;
    if (entry && now < entry.fetchedAtMs + this.ttlMs) {
      return mergeOpenCodeGoModelCatalog(entry.models);
    }
    if (entry && now < entry.fetchedAtMs + this.staleMs) {
      // Stale-while-revalidate: serve the cached catalog and kick off the
      // shared background refresh; its failures are swallowed here.
      void this.refreshShared().catch(() => undefined);
      return mergeOpenCodeGoModelCatalog(entry.models);
    }
    const refreshed = await this.refreshShared().catch(() => null);
    if (refreshed) return mergeOpenCodeGoModelCatalog(refreshed.models);
    // No usable upstream observation: the built-in fallback catalog is the
    // never-fail floor.
    return mergeOpenCodeGoModelCatalog(null);
  }

  private refreshShared(): Promise<CacheEntry | null> {
    this.refresh ??= (async () => {
      try {
        const secret = await this.options.resolveSecret();
        const result = await fetchOpencodeGoModels(secret, this.options.fetch, undefined, {
          ifNoneMatch: this.entry?.etag ?? null,
        });
        // The cache stamps entries with its own (injectable) clock so TTL
        // decisions never mix time domains with the fetch result.
        const fetchedAtMs = this.options.now?.() ?? Date.now();
        if (result.state === 'ok') {
          const next: CacheEntry = { models: result.models, etag: result.etag, fetchedAtMs };
          this.entry = next;
          return next;
        }
        if (result.state === 'not_modified' && this.entry) {
          const next: CacheEntry = { ...this.entry, fetchedAtMs };
          this.entry = next;
          return next;
        }
        // A failed refresh never resurrects an entry past its stale window:
        // the caller falls back to the built-in catalog.
        return null;
      } finally {
        this.refresh = null;
      }
    })();
    return this.refresh;
  }
}

export function createOpenCodeGoModelCatalogCache(
  options: OpenCodeGoModelCatalogCacheOptions,
): OpenCodeGoModelCatalogCache {
  return new OpenCodeGoModelCatalogCache(options);
}
