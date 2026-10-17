/**
 * Official reference pricing (roadmap batch 5 §5.5, task #22): the models.dev
 * registry (https://models.dev/api.json) with an in-process 6-hour TTL cache
 * and a small built-in bootstrap fallback.
 *
 * Cache placement decision: PROCESS-MEMORY, not PostgreSQL. The plaza is a
 * zero-storage showcase (no plaza-owned tables, no migrations) and the
 * reference prices are advisory display data, never billing input — a
 * per-process cache keeps that property. The cost: each gateway replica
 * refreshes independently (bounded: one fetch per 6h per process,
 * single-flight, 10s deadline, 32 MiB response bound).
 *
 * The registry is display-only and best-effort: a fetch failure falls back to
 * the last successful snapshot (stale-while-error) and then to the built-in
 * fallback card; a model with no entry simply carries `official_pricing: null`.
 */

export interface OfficialPricingEntry {
  /** USD per 1M input tokens, decimal string. */
  readonly input: string | null;
  readonly output: string | null;
  readonly cacheRead: string | null;
  readonly cacheWrite: string | null;
}

export interface OfficialModelEntry extends OfficialPricingEntry {
  readonly contextWindow: number | null;
}

export interface ModelsDevFetchResult {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type ModelsDevFetcher = (url: string, signal: AbortSignal) => Promise<ModelsDevFetchResult>;

export const MODELS_DEV_API_URL = 'https://models.dev/api.json' as const;
export const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_PROVIDERS = 1024;
const MAX_MODES_PER_PROVIDER = 4096;

/**
 * Our gateway provider ids → models.dev provider keys. Unmapped providers
 * still resolve through the cross-provider model-id index (canonical entries
 * preferred), so a new provider category works without touching this table.
 */
const PROVIDER_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  vertex: 'google-vertex',
  grok: 'xai',
  zhipu: 'zai',
  minimax: 'minimax',
  openrouter: 'openrouter',
});

/**
 * Built-in bootstrap fallback (sub2api 内置兜底价卡): a handful of flagship
 * entries, values captured from the models.dev registry on 2026-10-16. Only
 * used when the registry is unreachable and no cached snapshot exists.
 * Model pricing data is data, not capability (roadmap non-goal) — new entries
 * belong in the registry, not here.
 */
const BUILT_IN_FALLBACK: Readonly<Record<string, OfficialModelEntry>> = Object.freeze({
  'anthropic/claude-sonnet-4-5': entry('3', '15', '0.3', '3.75', 200000),
  'anthropic/claude-opus-4-6': entry('5', '25', '0.5', '6.25', 1000000),
  'anthropic/claude-haiku-4-5': entry('1', '5', '0.1', '1.25', 200000),
  'openai/gpt-5.2': entry('1.75', '14', '0.175', null, 400000),
  'google/gemini-flash-latest': entry('0.75', '3.75', '0.075', null, 1048576),
  'xai/grok-4.7': entry('2', '6', '0.5', null, 500000),
});

function entry(
  input: string | null,
  output: string | null,
  cacheRead: string | null,
  cacheWrite: string | null,
  contextWindow: number | null,
): OfficialModelEntry {
  return { input, output, cacheRead, cacheWrite, contextWindow };
}

interface ParsedRegistry {
  /** providerKey/modelId → entry (both direct and canonical-index hits). */
  readonly byProvider: ReadonlyMap<string, OfficialModelEntry>;
  /** modelId → canonical entry (first canonical provider wins, provider key order). */
  readonly byModelId: ReadonlyMap<string, OfficialModelEntry>;
}

const EMPTY_REGISTRY: ParsedRegistry = { byProvider: new Map(), byModelId: new Map() };

interface MutableRegistryIndex {
  readonly byProvider: Map<string, OfficialModelEntry>;
  readonly byModelId: Map<string, OfficialModelEntry>;
}

function decimalString(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (!Number.isSafeInteger(value * 1_000_000)) return null;
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function parseCostEntry(raw: unknown, providerKey: string, modelId: string, index: MutableRegistryIndex): void {
  if (index.byProvider.size + index.byModelId.size > MAX_PROVIDERS * MAX_MODES_PER_PROVIDER) return;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const model = raw as Record<string, unknown>;
  const cost = model.cost;
  const costRecord =
    cost !== null && typeof cost === 'object' && !Array.isArray(cost) ? (cost as Record<string, unknown>) : {};
  const limit = model.limit;
  const limitRecord =
    limit !== null && typeof limit === 'object' && !Array.isArray(limit) ? (limit as Record<string, unknown>) : {};
  const contextWindow =
    typeof limitRecord.context === 'number' && Number.isSafeInteger(limitRecord.context) && limitRecord.context > 0
      ? limitRecord.context
      : null;
  const parsed = entry(
    decimalString(costRecord.input),
    decimalString(costRecord.output),
    decimalString(costRecord.cache_read),
    decimalString(costRecord.cache_write),
    contextWindow,
  );
  if (
    parsed.input === null &&
    parsed.output === null &&
    parsed.cacheRead === null &&
    parsed.cacheWrite === null &&
    parsed.contextWindow === null
  ) {
    return;
  }
  index.byProvider.set(`${providerKey}/${modelId}`, parsed);
  // Canonical entries (the provider's own listing) win the cross-provider
  // model-id index; mirrors keep canonical_model_id pointing elsewhere.
  if (model.canonical_model_id === `${providerKey}/${modelId}` && !index.byModelId.has(modelId)) {
    index.byModelId.set(modelId, parsed);
  }
}

export function parseModelsDevRegistry(payload: unknown): ParsedRegistry {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return EMPTY_REGISTRY;
  const index: MutableRegistryIndex = { byProvider: new Map(), byModelId: new Map() };
  const providers = Object.keys(payload as Record<string, unknown>);
  if (providers.length > MAX_PROVIDERS) return EMPTY_REGISTRY;
  for (const providerKey of providers.sort()) {
    if (index.byProvider.size + index.byModelId.size > MAX_PROVIDERS * MAX_MODES_PER_PROVIDER) break;
    const provider = (payload as Record<string, unknown>)[providerKey];
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue;
    const models = (provider as Record<string, unknown>).models;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue;
    const modelIds = Object.keys(models as Record<string, unknown>);
    if (modelIds.length > MAX_MODES_PER_PROVIDER) continue;
    for (const modelId of modelIds) {
      parseCostEntry((models as Record<string, unknown>)[modelId], providerKey, modelId, index);
    }
  }
  return { byProvider: index.byProvider, byModelId: index.byModelId };
}

export interface ModelsDevPricingRegistryOptions {
  readonly url?: string;
  readonly fetcher?: ModelsDevFetcher;
  /** Millisecond clock; defaults to Date.now. */
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly fallback?: Readonly<Record<string, OfficialModelEntry>>;
}

export class ModelsDevOfficialPricingRegistry {
  private readonly url: string;
  private readonly fetcher: ModelsDevFetcher;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly fallback: Readonly<Record<string, OfficialModelEntry>>;
  private cached: { readonly registry: ParsedRegistry; readonly expiresAt: number } | null = null;
  private inflight: Promise<ParsedRegistry> | null = null;

  constructor(options: ModelsDevPricingRegistryOptions = {}) {
    this.url = options.url ?? MODELS_DEV_API_URL;
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? MODELS_DEV_TTL_MS;
    this.fallback = options.fallback ?? BUILT_IN_FALLBACK;
  }

  /**
   * Reference pricing + context window for one (our provider id, model id).
   * Lookup order: mapped models.dev provider key → cross-provider canonical
   * index → (on registry unavailability) the built-in fallback.
   */
  async lookup(providerId: string, modelId: string): Promise<OfficialModelEntry | null> {
    if (typeof providerId !== 'string' || typeof modelId !== 'string' || providerId === '' || modelId === '') {
      return null;
    }
    const registry = await this.current();
    const mapped = PROVIDER_KEY_MAP[providerId];
    if (mapped !== undefined) {
      const direct = registry.byProvider.get(`${mapped}/${modelId}`);
      if (direct !== undefined) return direct;
    }
    const canonical = registry.byModelId.get(modelId);
    if (canonical !== undefined) return canonical;
    if (mapped !== undefined) {
      const fallbackEntry = this.fallback[`${mapped}/${modelId}`];
      if (fallbackEntry !== undefined) return fallbackEntry;
    }
    return null;
  }

  private async current(): Promise<ParsedRegistry> {
    const now = this.now();
    if (this.cached !== null && this.cached.expiresAt > now) return this.cached.registry;
    this.inflight ??= this.fetch().then(
      (registry) => {
        this.cached = { registry, expiresAt: this.now() + this.ttlMs };
        return registry;
      },
      () => {
        // Unreachable: serve stale-while-error, else the built-in fallback.
        if (this.cached !== null) return this.cached.registry;
        return { byProvider: new Map(Object.entries(this.fallback)), byModelId: new Map() };
      },
    );
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async fetch(): Promise<ParsedRegistry> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS, undefined);
    try {
      const response = await this.fetcher(this.url, controller.signal);
      if (!response.ok) throw new Error(`models.dev fetch failed with status ${response.status}`);
      const payload = (await response.json()) as unknown;
      return parseModelsDevRegistry(payload);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Default fetcher: Node's global fetch (bundled undici 6.x) with size bounding. */
const defaultFetcher: ModelsDevFetcher = async (url, signal) => {
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
  return {
    ok: response.ok,
    status: response.status,
    json: async () => {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('models.dev response exceeds the size bound');
      return JSON.parse(text) as unknown;
    },
  };
};

export const MODELS_DEV_BUILT_IN_FALLBACK = BUILT_IN_FALLBACK;
export const MODELS_DEV_PROVIDER_KEY_MAP = PROVIDER_KEY_MAP;
