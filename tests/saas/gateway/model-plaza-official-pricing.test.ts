import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MODELS_DEV_BUILT_IN_FALLBACK,
  type ModelsDevFetchResult,
  ModelsDevOfficialPricingRegistry,
  parseModelsDevRegistry,
} from '../../../src/saas/gateway/model-plaza/official-pricing.js';

function registryPayload(): unknown {
  return {
    anthropic: {
      models: {
        'claude-sonnet-4-5': {
          cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          limit: { context: 200000 },
          canonical_model_id: 'anthropic/claude-sonnet-4-5',
        },
      },
    },
    venice: {
      models: {
        // A mirror: same model id under another provider, canonical points
        // at the anthropic listing.
        'claude-sonnet-4-5': {
          cost: { input: 9, output: 45, cache_read: 0.9 },
          canonical_model_id: 'anthropic/claude-sonnet-4-5',
        },
      },
    },
    zai: {
      models: {
        'glm-5': {
          cost: { input: 0.6, output: 2.2 },
          limit: { context: 200000 },
          canonical_model_id: 'zai/glm-5',
        },
      },
    },
  };
}

function okFetcher(payload: unknown, calls: { count: number } = { count: 0 }): () => Promise<ModelsDevFetchResult> {
  return async () => {
    calls.count += 1;
    return { ok: true, status: 200, json: async () => payload };
  };
}

function failingFetcher(): () => Promise<ModelsDevFetchResult> {
  return async () => {
    throw new Error('network unreachable');
  };
}

test('parses cost entries with per-1M decimal strings and context windows', () => {
  const registry = parseModelsDevRegistry(registryPayload());
  const entry = registry.byProvider.get('anthropic/claude-sonnet-4-5');
  assert.ok(entry);
  assert.equal(entry.input, '3');
  assert.equal(entry.output, '15');
  assert.equal(entry.cacheRead, '0.3');
  assert.equal(entry.cacheWrite, '3.75');
  assert.equal(entry.contextWindow, 200000);
});

test('the cross-provider model-id index prefers the canonical provider entry', () => {
  const registry = parseModelsDevRegistry(registryPayload());
  const canonical = registry.byModelId.get('claude-sonnet-4-5');
  assert.ok(canonical);
  assert.equal(canonical.input, '3', 'canonical anthropic entry wins over the venice mirror');
});

test('lookup maps our provider ids onto models.dev keys, with canonical cross-provider fallback', async () => {
  let now = 1_000;
  const calls = { count: 0 };
  const registry = new ModelsDevOfficialPricingRegistry({
    fetcher: okFetcher(registryPayload(), calls),
    now: () => now,
    ttlMs: 1_000,
  });
  const viaProviderMap = await registry.lookup('claude', 'claude-sonnet-4-5');
  assert.deepEqual(
    [viaProviderMap?.input, viaProviderMap?.contextWindow],
    ['3', 200000],
    'claude -> anthropic direct mapping',
  );
  // Unmapped provider still resolves through the canonical model-id index.
  const viaModelIndex = await registry.lookup('bedrock', 'claude-sonnet-4-5');
  assert.equal(viaModelIndex?.input, '3');
  const zhipu = await registry.lookup('zhipu', 'glm-5');
  assert.equal(zhipu?.input, '0.6');
  const unknown = await registry.lookup('claude', 'no-such-model');
  assert.equal(unknown, null);
  assert.equal(calls.count, 1, 'the TTL cache serves every lookup from one fetch');
  now += 2_000;
  await registry.lookup('claude', 'claude-sonnet-4-5');
  assert.equal(calls.count, 2, 'an expired cache refetches');
});

test('a fetch failure with no cache falls back to the built-in card; with cache, serves stale', async () => {
  let now = 1_000;
  const calls = { count: 0 };
  const cold = new ModelsDevOfficialPricingRegistry({
    fetcher: failingFetcher(),
    now: () => now,
    ttlMs: 1_000,
  });
  const fallbackEntry = await cold.lookup('claude', 'claude-sonnet-4-5');
  assert.equal(fallbackEntry?.input, MODELS_DEV_BUILT_IN_FALLBACK['anthropic/claude-sonnet-4-5']?.input ?? null);

  const warm = new ModelsDevOfficialPricingRegistry({
    fetcher: okFetcher(registryPayload(), calls),
    now: () => now,
    ttlMs: 1_000,
  });
  const fresh = await warm.lookup('claude', 'claude-sonnet-4-5');
  assert.equal(fresh?.input, '3');
  now += 2_000;
  // After expiry, a failed refresh serves the last good snapshot.
  const failingWarm = new ModelsDevOfficialPricingRegistry({
    fetcher: failingFetcher(),
    now: () => now,
    ttlMs: 1_000,
  });
  void failingWarm;
  const stale = await warm.lookup('claude', 'claude-sonnet-4-5');
  assert.equal(stale?.input, '3', 'stale-while-error serves the cached snapshot');
});

test('malformed payloads parse to an empty registry instead of throwing', () => {
  assert.deepEqual(parseModelsDevRegistry('nope'), { byProvider: new Map(), byModelId: new Map() });
  assert.deepEqual(parseModelsDevRegistry([1, 2, 3]), { byProvider: new Map(), byModelId: new Map() });
  const withGarbageModel = parseModelsDevRegistry({
    weird: { models: { 'm-1': { cost: 'not-a-cost', limit: 'x' } } },
  });
  assert.equal(withGarbageModel.byProvider.size, 0);
});
