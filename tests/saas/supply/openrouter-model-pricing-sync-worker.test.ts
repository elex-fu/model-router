import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPENROUTER_ENDPOINT, OPENROUTER_MODELS_URL } from '../../../src/saas/gateway/openrouter/catalog-identity.js';
import type { AppendSupplierCostVersionInput } from '../../../src/saas/pricing/types.js';
import {
  clampOpenRouterPricingSyncIntervalMs,
  fetchOpenRouterModelPricing,
  OPENROUTER_PRICING_MAX_ENTRIES,
  OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS,
  OPENROUTER_PRICING_SYNC_MAX_INTERVAL_MS,
  OPENROUTER_PRICING_SYNC_MIN_INTERVAL_MS,
  OPENROUTER_SUPPLIER_COST_EFFECTIVE_AT,
  type OpenRouterModelPricing,
  type OpenRouterModelPricingFetch,
  type OpenRouterModelPricingSyncStore,
  OpenRouterModelPricingSyncWorker,
  type OpenRouterModelPricingTarget,
  openRouterModelPricingDigest,
  openRouterSupplierCostIdempotencyKey,
  openRouterSupplierCostVersionInput,
  parseOpenRouterModelPricingResponseBody,
  parseUsdPerTokenMinorUnits,
  startOpenRouterModelPricingSyncWorker,
} from '../../../src/saas/supply/openrouter-model-pricing-sync-worker.js';

/*
 * All fixtures are synthetic: the OpenRouter catalog is public so no key
 * material is needed anywhere, and the fetch seam is always a fake — no live
 * network is ever contacted.
 */

const HOUR_MS = 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

interface CatalogModelFixture {
  readonly id: string;
  readonly prompt?: string;
  readonly completion?: string;
  /** Injects a JSON-number completion to prove the no-float rejection. */
  readonly numericCompletion?: number;
  readonly inputCacheRead?: string;
  readonly inputCacheWrite?: string;
  readonly omitPricing?: boolean;
}

function catalogBody(models: readonly CatalogModelFixture[]): string {
  return JSON.stringify({
    data: models.map((model) => ({
      id: model.id,
      name: `Synthetic ${model.id}`,
      pricing: model.omitPricing
        ? undefined
        : {
            request: '0',
            image: '0',
            web_search: '0',
            internal_reasoning: '0',
            prompt: model.prompt ?? '0.0000015',
            ...(model.numericCompletion === undefined
              ? { completion: model.completion ?? '0.000003' }
              : { completion: model.numericCompletion }),
            ...(model.inputCacheRead === undefined ? {} : { input_cache_read: model.inputCacheRead }),
            ...(model.inputCacheWrite === undefined ? {} : { input_cache_write: model.inputCacheWrite }),
          },
    })),
  });
}

const TWO_MODELS: readonly CatalogModelFixture[] = [
  { id: 'openai/gpt-4o', prompt: '0.0000015', completion: '0.000003' },
  { id: 'anthropic/claude-sonnet-4', prompt: '0.000002', completion: '0.000006' },
];

// ---------------------------------------------------------------------------
// Rational conversion (exact, never floats).
// ---------------------------------------------------------------------------

test('decimal USD-per-token strings convert to exact reduced minor-unit rationals', () => {
  assert.deepEqual(parseUsdPerTokenMinorUnits('0.0000015'), { numeratorMinorUnits: 3n, denominatorUnits: 20_000n });
  assert.deepEqual(parseUsdPerTokenMinorUnits('0.15'), { numeratorMinorUnits: 15n, denominatorUnits: 1n });
  assert.deepEqual(parseUsdPerTokenMinorUnits('1'), { numeratorMinorUnits: 100n, denominatorUnits: 1n });
  assert.deepEqual(parseUsdPerTokenMinorUnits('0'), { numeratorMinorUnits: 0n, denominatorUnits: 1n });
  assert.deepEqual(parseUsdPerTokenMinorUnits('0.00000003'), { numeratorMinorUnits: 3n, denominatorUnits: 1_000_000n });
  assert.deepEqual(parseUsdPerTokenMinorUnits(' 0.0000015 '), { numeratorMinorUnits: 3n, denominatorUnits: 20_000n });
  // The exactness invariant: rate * 10^7 reproduces the upstream decimal.
  const rate = parseUsdPerTokenMinorUnits('0.0000015');
  assert.ok(rate);
  assert.equal((rate.numeratorMinorUnits * 10_000_000n) / rate.denominatorUnits, 1_500n);
});

test('malformed, negative, numeric and over-precise prices are rejected', () => {
  // "-1" is OpenRouter's negotiable marker; never a cost row.
  assert.equal(parseUsdPerTokenMinorUnits('-1'), null);
  assert.equal(parseUsdPerTokenMinorUnits('-0.0000015'), null);
  assert.equal(parseUsdPerTokenMinorUnits('1e-7'), null);
  assert.equal(parseUsdPerTokenMinorUnits(''), null);
  assert.equal(parseUsdPerTokenMinorUnits('   '), null);
  assert.equal(parseUsdPerTokenMinorUnits('.5'), null);
  assert.equal(parseUsdPerTokenMinorUnits('1.'), null);
  assert.equal(parseUsdPerTokenMinorUnits('01.5'), null);
  // Trailing whitespace is trimmed like leading whitespace (upstream strings
  // sometimes carry it); interior structure is still strictly validated.
  assert.deepEqual(parseUsdPerTokenMinorUnits('0.0000015\n'), { numeratorMinorUnits: 3n, denominatorUnits: 20_000n });
  // JSON numbers are float-parsed before this code runs; the money path
  // refuses them outright.
  assert.equal(parseUsdPerTokenMinorUnits(0.0000015), null);
  assert.equal(parseUsdPerTokenMinorUnits(0), null);
  assert.equal(parseUsdPerTokenMinorUnits(null), null);
  assert.equal(parseUsdPerTokenMinorUnits(undefined), null);
  // More than 18 significant digits: refused instead of silently truncating.
  assert.equal(parseUsdPerTokenMinorUnits('0.1234567890123456789'), null);
});

// ---------------------------------------------------------------------------
// Catalog body parsing.
// ---------------------------------------------------------------------------

test('a valid catalog parses into normalized, deduplicated, sorted priced models', () => {
  const parsed = parseOpenRouterModelPricingResponseBody(
    encode(
      catalogBody([
        { id: 'anthropic/claude-sonnet-4', prompt: '0.000002', completion: '0.000006' },
        { id: 'openrouter/openai/gpt-4o', prompt: '0.0000015', completion: '0.000003', inputCacheRead: '0.0000001' },
        { id: 'openai/gpt-4o', prompt: '0.0000015', completion: '0.000003', inputCacheRead: '0.0000001' },
      ]),
    ),
  );
  assert.ok(parsed);
  assert.equal(parsed.skippedEntryCount, 1, 'duplicate after normalization is skipped');
  assert.deepEqual(
    parsed.models.map((model) => model.model),
    ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
  );
  const gpt = parsed.models[1];
  assert.ok(gpt);
  assert.deepEqual(gpt.input, { numeratorMinorUnits: 3n, denominatorUnits: 20_000n });
  assert.deepEqual(gpt.output, { numeratorMinorUnits: 3n, denominatorUnits: 10_000n });
  assert.deepEqual(gpt.cacheRead, { numeratorMinorUnits: 1n, denominatorUnits: 100_000n });
  assert.equal(gpt.cacheWrite, null);
});

test('entries with missing or malformed pricing are skipped, never guessed', () => {
  const parsed = parseOpenRouterModelPricingResponseBody(
    encode(
      catalogBody([
        { id: 'good/model', prompt: '0.0000015', completion: '0.000003' },
        { id: 'no-pricing/model', omitPricing: true },
        { id: 'negotiable/model', prompt: '-1', completion: '0.000003' },
        { id: 'numeric/model', prompt: '0.0000015', numericCompletion: 0.000003 },
        { id: 'bad-id/é', prompt: '0.0000015', completion: '0.000003' },
      ]),
    ),
  );
  assert.ok(parsed);
  assert.deepEqual(
    parsed.models.map((model) => model.model),
    ['good/model'],
  );
  assert.equal(parsed.skippedEntryCount, 4);
});

test('a structurally invalid envelope fails the whole parse', () => {
  assert.equal(parseOpenRouterModelPricingResponseBody(encode('{"error":"nope"}')), null);
  assert.equal(parseOpenRouterModelPricingResponseBody(encode('{"data":null}')), null);
  assert.equal(parseOpenRouterModelPricingResponseBody(encode('{"data":{}}')), null);
  assert.equal(parseOpenRouterModelPricingResponseBody(encode('not json')), null);
  assert.equal(parseOpenRouterModelPricingResponseBody(encode('[]')), null);
  const oversized = JSON.stringify({
    data: Array.from({ length: OPENROUTER_PRICING_MAX_ENTRIES + 1 }, () => ({ id: 'a/b' })),
  });
  assert.equal(parseOpenRouterModelPricingResponseBody(encode(oversized)), null);
});

// ---------------------------------------------------------------------------
// Fetch (fake transport; typed failures; ETag revalidation).
// ---------------------------------------------------------------------------

test('the pinned public catalog URL is fetched with attribution-free headers', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: OpenRouterModelPricingFetch = (url, init) => {
    seen.push({ url: url.toString(), init });
    return Promise.resolve(jsonResponse(catalogBody(TWO_MODELS), { etag: '"v1"' }));
  };
  const result = await fetchOpenRouterModelPricing(fetcher);
  assert.equal(result.state, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, OPENROUTER_MODELS_URL);
  assert.equal((seen[0]?.init.method as string) ?? '', 'GET');
  const headers = (seen[0]?.init.headers ?? {}) as Record<string, string>;
  assert.equal(headers.accept, 'application/json');
  assert.equal(headers['user-agent'], 'model-router');
  assert.equal('authorization' in headers, false, 'the public catalog needs no credential');
  if (result.state === 'ok') {
    assert.equal(result.etag, '"v1"');
    assert.equal(result.models.length, 2);
  }
});

test('an ETag revalidation yields not_modified without a body', async () => {
  const fetcher: OpenRouterModelPricingFetch = (_url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    assert.equal(headers['if-none-match'], '"v1"');
    return Promise.resolve(new Response(null, { status: 304 }));
  };
  const result = await fetchOpenRouterModelPricing(fetcher, undefined, { ifNoneMatch: '"v1"' });
  assert.equal(result.state, 'not_modified');
  if (result.state === 'not_modified') {
    assert.equal(typeof result.fetchedAtMs, 'number');
  }
});

test('typed failure modes never throw', async () => {
  const cases: readonly [Response, string][] = [
    [new Response(null, { status: 429 }), 'provider_rate_limited'],
    [new Response(null, { status: 503 }), 'provider_unavailable'],
    [new Response(null, { status: 404 }), 'provider_response_invalid'],
    [
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
      'provider_redirect_rejected',
    ],
    [
      new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'text/html' } }),
      'provider_response_invalid',
    ],
    [
      new Response('nope', { status: 200, headers: { 'content-type': 'application/json' } }),
      'provider_response_invalid',
    ],
  ];
  for (const [response, errorCode] of cases) {
    const result = await fetchOpenRouterModelPricing(() => Promise.resolve(response));
    assert.equal(result.state, 'failed', `expected failure for status ${response.status}`);
    if (result.state === 'failed') assert.equal(result.errorCode, errorCode);
  }
  const networkFailure: OpenRouterModelPricingFetch = () => Promise.reject(new TypeError('fetch failed'));
  const failed = await fetchOpenRouterModelPricing(networkFailure);
  assert.equal(failed.state, 'failed');
  if (failed.state === 'failed') assert.equal(failed.errorCode, 'provider_network_error');
});

// ---------------------------------------------------------------------------
// Interval clamps and idempotency keys.
// ---------------------------------------------------------------------------

test('sync interval clamps to [5min, 24h] with a 1h default', () => {
  assert.equal(OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS, HOUR_MS);
  assert.equal(clampOpenRouterPricingSyncIntervalMs(undefined), OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS);
  assert.equal(clampOpenRouterPricingSyncIntervalMs(1), OPENROUTER_PRICING_SYNC_MIN_INTERVAL_MS);
  assert.equal(clampOpenRouterPricingSyncIntervalMs(FIVE_MINUTES_MS), FIVE_MINUTES_MS);
  assert.equal(clampOpenRouterPricingSyncIntervalMs(Infinity), OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS);
  assert.equal(clampOpenRouterPricingSyncIntervalMs(Number.NaN), OPENROUTER_PRICING_SYNC_DEFAULT_INTERVAL_MS);
  assert.equal(clampOpenRouterPricingSyncIntervalMs(10 * 24 * HOUR_MS), OPENROUTER_PRICING_SYNC_MAX_INTERVAL_MS);
});

function pricedModel(overrides: Partial<OpenRouterModelPricing> = {}): OpenRouterModelPricing {
  return {
    model: 'openai/gpt-4o',
    input: { numeratorMinorUnits: 3n, denominatorUnits: 20_000n },
    output: { numeratorMinorUnits: 6n, denominatorUnits: 20_000n },
    cacheRead: null,
    cacheWrite: null,
    ...overrides,
  };
}

test('idempotency keys are content-addressed: stable for identical prices, fresh on any change', () => {
  const base = pricedModel();
  assert.equal(openRouterSupplierCostIdempotencyKey(base), openRouterSupplierCostIdempotencyKey(pricedModel()));
  assert.notEqual(
    openRouterSupplierCostIdempotencyKey(base),
    openRouterSupplierCostIdempotencyKey(
      pricedModel({ output: { numeratorMinorUnits: 7n, denominatorUnits: 20_000n } }),
    ),
  );
  assert.notEqual(
    openRouterSupplierCostIdempotencyKey(base),
    openRouterSupplierCostIdempotencyKey(
      pricedModel({ cacheRead: { numeratorMinorUnits: 1n, denominatorUnits: 1_000_000n } }),
    ),
  );
  assert.notEqual(
    openRouterSupplierCostIdempotencyKey(base),
    openRouterSupplierCostIdempotencyKey(pricedModel({ model: 'anthropic/claude-sonnet-4' })),
  );
});

test('the supplier-cost append input carries the exact identity, policy constants and rates', () => {
  const pricing = pricedModel({ cacheRead: { numeratorMinorUnits: 1n, denominatorUnits: 1_000_000n } });
  const input = openRouterSupplierCostVersionInput(pricing, { publicModelId: 'pm-1', publicModelVersion: 1 });
  assert.equal(input.publicModelId, 'pm-1');
  assert.equal(input.publicModelVersion, 1);
  assert.equal(input.providerId, 'openrouter');
  assert.equal(input.productId, 'openrouter-api');
  assert.equal(input.resolvedModel, 'openai/gpt-4o');
  assert.equal(input.protocol, 'openai');
  assert.equal(input.endpoint, OPENROUTER_ENDPOINT);
  assert.equal(input.currency, 'USD');
  assert.equal(input.effectiveAt, OPENROUTER_SUPPLIER_COST_EFFECTIVE_AT);
  assert.equal(new Date(OPENROUTER_SUPPLIER_COST_EFFECTIVE_AT).getTime(), 0);
  assert.equal(input.roundingMode, 'half_up');
  assert.equal(input.roundingBoundary, 'total');
  assert.deepEqual(input.rates.input, { numeratorMinorUnits: 3n, denominatorUnits: 20_000n });
  assert.deepEqual(input.rates.output, { numeratorMinorUnits: 6n, denominatorUnits: 20_000n });
  assert.deepEqual(input.rates.cache_read, { numeratorMinorUnits: 1n, denominatorUnits: 1_000_000n });
  assert.equal(input.rates.cache_write, undefined);
  assert.equal(input.idempotencyKey, openRouterSupplierCostIdempotencyKey(pricing));
});

// ---------------------------------------------------------------------------
// In-memory fake store (mirrors the service semantics the worker relies on).
// ---------------------------------------------------------------------------

class MemorySyncStore implements OpenRouterModelPricingSyncStore {
  productRegistrations = 0;
  readonly capabilities: string[] = [];
  readonly rightsChunks: Array<{ readonly index: number; readonly models: readonly string[] }> = [];
  readonly aliases: string[] = [];
  readonly appended: AppendSupplierCostVersionInput[] = [];
  readonly appendedKeys = new Map<string, number>();
  listCalls = 0;
  /** Extra targets tests pre-seed (e.g. wrong endpoint/protocol cases). */
  readonly extraTargets: OpenRouterModelPricingTarget[] = [];

  async ensureProduct(): Promise<void> {
    this.productRegistrations += 1;
  }

  async registerCapability(model: string): Promise<void> {
    this.capabilities.push(model);
  }

  async registerRightsChunk(chunkIndex: number, models: readonly string[]): Promise<void> {
    this.rightsChunks.push({ index: chunkIndex, models: [...models] });
  }

  async registerPublicAlias(
    model: string,
  ): Promise<{ readonly publicModelId: string; readonly publicModelVersion: number } | null> {
    if (this.aliases.includes(model)) return null;
    this.aliases.push(model);
    return { publicModelId: `pm-${model}`, publicModelVersion: 1 };
  }

  /** Mirrors the pricing-target join: a target resolves iff alias + capability + rights all cover the model. */
  async listProviderTargets(): Promise<readonly OpenRouterModelPricingTarget[]> {
    this.listCalls += 1;
    const targets: OpenRouterModelPricingTarget[] = [...this.extraTargets];
    for (const model of this.aliases) {
      if (!this.capabilities.includes(model)) continue;
      if (!this.rightsChunks.some((chunk) => chunk.models.includes(model))) continue;
      targets.push({
        publicModelId: `pm-${model}`,
        publicModelVersion: 1,
        resolvedModel: model,
        protocol: 'openai',
        endpoint: OPENROUTER_ENDPOINT,
      });
    }
    return targets;
  }

  async appendSupplierCost(input: AppendSupplierCostVersionInput): Promise<{ readonly version: number }> {
    const existing = this.appendedKeys.get(input.idempotencyKey);
    if (existing !== undefined) return { version: existing };
    const version =
      this.appended.filter(
        (row) => row.publicModelId === input.publicModelId && row.resolvedModel === input.resolvedModel,
      ).length + 1;
    this.appendedKeys.set(input.idempotencyKey, version);
    this.appended.push(input);
    return { version };
  }
}

function sequenceFetch(responses: readonly Response[]): OpenRouterModelPricingFetch {
  let index = 0;
  return () => {
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error('fixture fetch exhausted');
    return Promise.resolve(response);
  };
}

// ---------------------------------------------------------------------------
// Worker rounds.
// ---------------------------------------------------------------------------

test('a first round registers structure for uncovered models and appends priced versions', async () => {
  const store = new MemorySyncStore();
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: () => Promise.resolve(jsonResponse(catalogBody(TWO_MODELS), { etag: '"v1"' })),
  });
  const round = await worker.runOnce();
  assert.equal(round.state, 'synced');
  if (round.state !== 'synced') return;
  assert.equal(round.modelCount, 2);
  assert.equal(round.appendedCount, 2);
  assert.equal(round.registeredStructureCount, 2);
  assert.equal(round.untargetedCount, 0);
  assert.deepEqual([...store.capabilities].sort(), ['anthropic/claude-sonnet-4', 'openai/gpt-4o']);
  assert.deepEqual(store.aliases.map((alias) => alias).sort(), ['anthropic/claude-sonnet-4', 'openai/gpt-4o']);
  assert.equal(store.rightsChunks.length, 1);
  assert.equal(store.rightsChunks[0]?.index, 0);
  assert.equal(store.appended.length, 2);
  for (const input of store.appended) {
    assert.equal(input.protocol, 'openai');
    assert.equal(input.endpoint, OPENROUTER_ENDPOINT);
    assert.equal(input.publicModelId, `pm-${input.resolvedModel}`);
  }
  const watermark = worker.currentWatermark();
  assert.ok(watermark);
  assert.equal(watermark.etag, '"v1"');
  const parsedFixture = parseOpenRouterModelPricingResponseBody(encode(catalogBody(TWO_MODELS)));
  assert.ok(parsedFixture);
  assert.equal(watermark.digest, openRouterModelPricingDigest(parsedFixture.models));
});

test('identical content replays as a pure no-op: no new versions, no structure writes', async () => {
  const store = new MemorySyncStore();
  const body = catalogBody(TWO_MODELS);
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: () => Promise.resolve(jsonResponse(body, { etag: '"v1"' })),
  });
  await worker.runOnce();
  assert.equal(store.appended.length, 2);
  const appendedBefore = [...store.appended];
  const structureCalls =
    store.productRegistrations + store.capabilities.length + store.rightsChunks.length + store.aliases.length;

  // A restarted worker (fresh watermark, same store) replays idempotent
  // appends: the content-addressed keys resolve onto the existing rows.
  const restarted = new OpenRouterModelPricingSyncWorker(store, {
    fetch: () => Promise.resolve(jsonResponse(body, { etag: '"v2"' })),
  });
  const replay = await restarted.runOnce();
  assert.equal(replay.state, 'synced');
  if (replay.state !== 'synced') return;
  assert.equal(replay.appendedCount, 2);
  assert.deepEqual(store.appended, appendedBefore, 'identical prices must not append new versions');
  const structureAfter =
    store.productRegistrations + store.capabilities.length + store.rightsChunks.length + store.aliases.length;
  assert.equal(structureAfter, structureCalls, 'covered models must not re-register structure');

  // A same-worker round with a changed ETag but identical content is a
  // watermark hit: nothing is even attempted.
  const unchanged = await worker.runOnce();
  assert.equal(unchanged.state, 'unchanged');
  assert.deepEqual(store.appended, appendedBefore);
});

test('a 304 revalidation short-circuits the round before any store access', async () => {
  const store = new MemorySyncStore();
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: sequenceFetch([
      jsonResponse(catalogBody(TWO_MODELS), { etag: '"v1"' }),
      new Response(null, { status: 304 }),
    ]),
  });
  await worker.runOnce();
  const listCallsAfterFirst = store.listCalls;
  const second = await worker.runOnce();
  assert.equal(second.state, 'not_modified');
  assert.equal(store.listCalls, listCallsAfterFirst);
});

test('a price change appends the next version under a fresh idempotency key', async () => {
  const store = new MemorySyncStore();
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: sequenceFetch([
      jsonResponse(catalogBody(TWO_MODELS), { etag: '"v1"' }),
      jsonResponse(
        catalogBody([
          { id: 'openai/gpt-4o', prompt: '0.000002', completion: '0.000003' },
          { id: 'anthropic/claude-sonnet-4', prompt: '0.000002', completion: '0.000006' },
        ]),
        { etag: '"v2"' },
      ),
    ]),
  });
  const first = await worker.runOnce();
  assert.equal(first.state, 'synced');
  const gptFirst = store.appended.find((input) => input.resolvedModel === 'openai/gpt-4o');
  assert.ok(gptFirst);
  assert.deepEqual(gptFirst.rates.input, { numeratorMinorUnits: 3n, denominatorUnits: 20_000n });

  const second = await worker.runOnce();
  assert.equal(second.state, 'synced');
  if (second.state !== 'synced') return;
  assert.equal(second.appendedCount, 2);
  // Only the changed model gained a version row.
  const gptRows = store.appended.filter((input) => input.resolvedModel === 'openai/gpt-4o');
  const claudeRows = store.appended.filter((input) => input.resolvedModel === 'anthropic/claude-sonnet-4');
  assert.equal(gptRows.length, 2);
  assert.equal(claudeRows.length, 1);
  assert.deepEqual(gptRows[1]?.rates.input, { numeratorMinorUnits: 1n, denominatorUnits: 5_000n });
  assert.notEqual(gptRows[0]?.idempotencyKey, gptRows[1]?.idempotencyKey);
});

test('targets under a foreign endpoint or protocol are never priced (fail-closed)', async () => {
  const store = new MemorySyncStore();
  store.extraTargets.push({
    publicModelId: 'pm-foreign-endpoint',
    publicModelVersion: 1,
    resolvedModel: 'openai/gpt-4o',
    protocol: 'openai',
    endpoint: 'some-other-endpoint',
  });
  store.extraTargets.push({
    publicModelId: 'pm-foreign-protocol',
    publicModelVersion: 1,
    resolvedModel: 'anthropic/claude-sonnet-4',
    protocol: 'anthropic',
    endpoint: OPENROUTER_ENDPOINT,
  });
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: () => Promise.resolve(jsonResponse(catalogBody(TWO_MODELS))),
  });
  const round = await worker.runOnce();
  assert.equal(round.state, 'synced');
  if (round.state !== 'synced') return;
  assert.equal(round.untargetedCount, 2);
  assert.equal(round.appendedCount, 0);
  assert.equal(store.appended.length, 0);
});

test('concurrent rounds share one in-flight sync (singleflight)', async () => {
  const store = new MemorySyncStore();
  let fetchCount = 0;
  let release: ((response: Response) => void) | undefined;
  const fetcher: OpenRouterModelPricingFetch = () => {
    fetchCount += 1;
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  };
  const worker = new OpenRouterModelPricingSyncWorker(store, { fetch: fetcher });
  const first = worker.runOnce();
  const second = worker.runOnce();
  await Promise.resolve();
  await Promise.resolve();
  release?.(jsonResponse(catalogBody(TWO_MODELS)));
  const [firstRound, secondRound] = await Promise.all([first, second]);
  assert.equal(fetchCount, 1, 'the second concurrent round must reuse the in-flight fetch');
  assert.equal(firstRound.state, 'synced');
  assert.equal(secondRound.state, 'synced');
});

test('a failed fetch fails the round without advancing the watermark', async () => {
  const store = new MemorySyncStore();
  const failures: string[] = [];
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: () => Promise.resolve(new Response(null, { status: 503 })),
    onError: (code) => failures.push(code),
  });
  const round = await worker.runOnce();
  assert.equal(round.state, 'failed');
  if (round.state === 'failed') assert.equal(round.errorCode, 'provider_unavailable');
  assert.deepEqual(failures, ['fetch_failed']);
  assert.equal(worker.currentWatermark(), null);
  assert.equal(store.listCalls, 0);
});

test('store failures fail the round and are reported as round_failed by the loop wrapper', async () => {
  const store = new MemorySyncStore();
  // A store whose target listing always fails (class methods stay bound).
  const failingStore: OpenRouterModelPricingSyncStore = Object.assign(
    Object.create(Object.getPrototypeOf(store)),
    store,
    { listProviderTargets: () => Promise.reject(new Error('injected store failure')) },
  );
  const failures: string[] = [];
  const worker = new OpenRouterModelPricingSyncWorker(failingStore, {
    fetch: () => Promise.resolve(jsonResponse(catalogBody(TWO_MODELS))),
    onError: (code) => failures.push(code),
  });
  await assert.rejects(worker.runOnce(), /injected store failure/);
  assert.equal(worker.currentWatermark(), null);
  // The start-loop wrapper swallows the rejection into onError.
  const handle = startOpenRouterModelPricingSyncWorker(failingStore, {
    fetch: () => Promise.resolve(jsonResponse(catalogBody(TWO_MODELS))),
    intervalMs: FIVE_MINUTES_MS,
    onError: (code) => failures.push(code),
  });
  const deadline = Date.now() + 5_000;
  while (!failures.includes('round_failed') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await handle.close();
  assert.ok(failures.includes('round_failed'));
});

test('a 150-model catalog shards rights into two chunks with deterministic membership', async () => {
  const store = new MemorySyncStore();
  const models: CatalogModelFixture[] = Array.from({ length: 150 }, (_, index) => ({
    id: `vendor/model-${String(index).padStart(3, '0')}`,
  }));
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: () => Promise.resolve(jsonResponse(catalogBody(models))),
  });
  const round = await worker.runOnce();
  assert.equal(round.state, 'synced');
  if (round.state !== 'synced') return;
  assert.equal(round.modelCount, 150);
  assert.equal(round.appendedCount, 150);
  const chunkIndexes = store.rightsChunks.map((chunk) => chunk.index).sort((left, right) => left - right);
  assert.deepEqual(chunkIndexes, [0, 1]);
  const first = store.rightsChunks.find((chunk) => chunk.index === 0);
  const second = store.rightsChunks.find((chunk) => chunk.index === 1);
  assert.equal(first?.models.length, 100);
  assert.equal(second?.models.length, 50);
  assert.equal(first?.models[0], 'vendor/model-000');
  assert.equal(second?.models[49], 'vendor/model-149');
});

test('a covered catalog performs no structure writes on later rounds', async () => {
  const store = new MemorySyncStore();
  const worker = new OpenRouterModelPricingSyncWorker(store, {
    fetch: sequenceFetch([
      jsonResponse(catalogBody(TWO_MODELS), { etag: '"v1"' }),
      jsonResponse(
        catalogBody([
          { id: 'openai/gpt-4o', prompt: '0.000002', completion: '0.000003' },
          { id: 'anthropic/claude-sonnet-4', prompt: '0.000002', completion: '0.000006' },
        ]),
        { etag: '"v2"' },
      ),
    ]),
  });
  await worker.runOnce();
  const structureSnapshot = {
    products: store.productRegistrations,
    capabilities: store.capabilities.length,
    rights: store.rightsChunks.length,
    aliases: store.aliases.length,
  };
  // Different content (a price change) but the same models: structure is
  // already covered, so only the changed model's cost version appends.
  const changed = await worker.runOnce();
  assert.equal(changed.state, 'synced');
  assert.deepEqual(
    {
      products: store.productRegistrations,
      capabilities: store.capabilities.length,
      rights: store.rightsChunks.length,
      aliases: store.aliases.length,
    },
    structureSnapshot,
  );
});

test('the worker constructor rejects a missing store and clamps its interval', () => {
  assert.throws(() => new OpenRouterModelPricingSyncWorker(undefined as never), TypeError);
  const store = new MemorySyncStore();
  assert.equal(new OpenRouterModelPricingSyncWorker(store, { intervalMs: 1 }).intervalMs, FIVE_MINUTES_MS);
  assert.equal(
    new OpenRouterModelPricingSyncWorker(store, { intervalMs: 100 * HOUR_MS }).intervalMs,
    OPENROUTER_PRICING_SYNC_MAX_INTERVAL_MS,
  );
  assert.equal(new OpenRouterModelPricingSyncWorker(store).intervalMs, HOUR_MS);
});

test('close aborts an in-flight round', async () => {
  const store = new MemorySyncStore();
  let release: ((response: Response) => void) | undefined;
  const fetcher: OpenRouterModelPricingFetch = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  const worker = new OpenRouterModelPricingSyncWorker(store, { fetch: fetcher });
  const round = worker.runOnce();
  await Promise.resolve();
  // close() drains the in-flight round, so release its fetch first.
  const closed = worker.close();
  release?.(jsonResponse(catalogBody(TWO_MODELS)));
  await closed;
  assert.deepEqual(await round, { state: 'aborted' });
  assert.deepEqual(await worker.runOnce(), { state: 'aborted' });
});

test('a failing alias write defers that model without failing the round', async () => {
  const store = new MemorySyncStore();
  const base = store.registerPublicAlias.bind(store);
  const flaky: OpenRouterModelPricingSyncStore = Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
    registerPublicAlias: (model: string) =>
      model === 'openai/gpt-4o' ? Promise.reject(new Error('duplicate alias surfaces as storage error')) : base(model),
  });
  const worker = new OpenRouterModelPricingSyncWorker(flaky, {
    fetch: () => Promise.resolve(jsonResponse(catalogBody(TWO_MODELS))),
  });
  const round = await worker.runOnce();
  assert.equal(round.state, 'synced');
  if (round.state !== 'synced') return;
  assert.equal(round.aliasDeferredCount, 1);
  // The deferred model got capability + rights but no target, so it stays
  // unpriced this round (fail-closed); the healthy model priced normally.
  assert.equal(round.appendedCount, 1);
  assert.equal(round.untargetedCount, 1);
  assert.deepEqual(
    store.appended.map((input) => input.resolvedModel),
    ['anthropic/claude-sonnet-4'],
  );
});
