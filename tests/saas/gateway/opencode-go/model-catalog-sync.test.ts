import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPENCODE_GO_MODELS_URL } from '../../../../src/saas/gateway/opencode-go/catalog-identity.js';
import { OPENCODE_GO_FALLBACK_MODEL_IDS } from '../../../../src/saas/gateway/opencode-go/model-catalog.js';
import {
  createOpenCodeGoModelCatalogCache,
  fetchOpencodeGoModels,
  mergeOpenCodeGoModelCatalog,
  normalizeOpenCodeGoModelIds,
  OPENCODE_GO_MODELS_STALE_MS,
  OPENCODE_GO_MODELS_TTL_MS,
  type OpencodeGoModelsFetch,
  parseOpenCodeGoModelsResponseBody,
} from '../../../../src/saas/gateway/opencode-go/model-catalog-sync.js';

const SECRET = Buffer.from('unit-test-api-key');

function modelsResponse(models: readonly string[], etag?: string): Response {
  return new Response(
    JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0 })) }),
    { status: 200, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) } },
  );
}

test('the models endpoint is pinned to the OpenCode Go OpenAI-format base', () => {
  assert.equal(OPENCODE_GO_MODELS_URL, 'https://opencode.ai/zen/go/v1/models');
  assert.equal(OPENCODE_GO_MODELS_TTL_MS, 60_000);
  assert.equal(OPENCODE_GO_MODELS_STALE_MS, 300_000);
});

test('parseOpenCodeGoModelsResponseBody accepts the OpenAI list envelope only', () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  assert.deepEqual(parseOpenCodeGoModelsResponseBody(bytes({ data: [{ id: 'grok-4.7' }, { id: 'glm-5.3' }] })), [
    'grok-4.7',
    'glm-5.3',
  ]);
  // An empty array is authoritative (sub2api modelCatalogEntries semantics).
  assert.deepEqual(parseOpenCodeGoModelsResponseBody(bytes({ data: [] })), []);
  // Missing/null/non-array data, error envelopes and malformed JSON are not lists.
  assert.equal(parseOpenCodeGoModelsResponseBody(bytes({})), null);
  assert.equal(parseOpenCodeGoModelsResponseBody(bytes({ data: null })), null);
  assert.equal(parseOpenCodeGoModelsResponseBody(bytes({ error: { message: 'x' } })), null);
  assert.equal(parseOpenCodeGoModelsResponseBody(bytes([1, 2])), null);
  assert.equal(parseOpenCodeGoModelsResponseBody(new TextEncoder().encode('not-json')), null);
  assert.equal(parseOpenCodeGoModelsResponseBody(bytes({ data: [{ object: 'model' }] })), null);
});

test('normalizeOpenCodeGoModelIds normalizes, dedupes and sorts', () => {
  assert.deepEqual(
    normalizeOpenCodeGoModelIds(['OPENCODE-GO/GLM-5.3', 'glm-5.3', ' opencode/kimi-k3 ', 'grok-4.7', 'opencode/']),
    ['glm-5.3', 'grok-4.7', 'kimi-k3'],
  );
});

test('mergeOpenCodeGoModelCatalog unions upstream over the built-in fallback', () => {
  const merged = mergeOpenCodeGoModelCatalog(['new-model', 'OPENCODE-GO/GLM-5.3']);
  assert.ok(merged.includes('new-model'));
  assert.ok(merged.includes('glm-5.3'));
  for (const model of OPENCODE_GO_FALLBACK_MODEL_IDS) {
    assert.ok(merged.includes(model), `built-in ${model} must survive the merge`);
  }
  // The fallback alone is the null-upstream catalog.
  assert.deepEqual(
    mergeOpenCodeGoModelCatalog(null),
    [...new Set([...OPENCODE_GO_FALLBACK_MODEL_IDS])].sort((left, right) => left.localeCompare(right)),
  );
});

test('fetchOpencodeGoModels sends Bearer auth, pins the URL and normalizes the ids', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: OpencodeGoModelsFetch = async (url, init) => {
    seen.push({ url: url.href, init });
    return modelsResponse(['OPENCODE-GO/GROK-4.7', 'glm-5.3'], '"etag-1"');
  };
  const result = await fetchOpencodeGoModels(SECRET, fetcher);
  assert.equal(result.state, 'ok');
  if (result.state !== 'ok') throw new Error('expected ok');
  assert.deepEqual(result.models, ['glm-5.3', 'grok-4.7']);
  assert.equal(result.etag, '"etag-1"');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, OPENCODE_GO_MODELS_URL);
  assert.equal(seen[0]?.init.method, 'GET');
  assert.equal(seen[0]?.init.redirect, 'manual');
  const headers = new Headers(seen[0]?.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer unit-test-api-key');
  assert.equal(headers.get('accept'), 'application/json');
  assert.ok(!JSON.stringify(result).includes('unit-test-api-key'));
});

test('fetchOpencodeGoModels revalidates with If-None-Match and honors 304', async () => {
  const seen: string[] = [];
  const fetcher: OpencodeGoModelsFetch = async (_url, init) => {
    seen.push(new Headers(init.headers).get('if-none-match') ?? '');
    return new Response(null, { status: 304 });
  };
  const first = await fetchOpencodeGoModels(SECRET, fetcher, undefined, { ifNoneMatch: '"etag-1"' });
  assert.equal(first.state, 'not_modified');
  assert.deepEqual(seen, ['"etag-1"']);
  const absent = await fetchOpencodeGoModels(SECRET, fetcher);
  assert.equal(absent.state, 'not_modified');
  assert.deepEqual(seen, ['"etag-1"', '']);
});

test('fetchOpencodeGoModels maps failure modes to typed error codes', async () => {
  const cases: Array<{ response: () => Response; errorCode: string }> = [
    {
      response: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
      errorCode: 'provider_redirect_rejected',
    },
    { response: () => new Response(null, { status: 401 }), errorCode: 'credential_rejected' },
    { response: () => new Response(null, { status: 403 }), errorCode: 'credential_rejected' },
    { response: () => new Response(null, { status: 429 }), errorCode: 'provider_rate_limited' },
    { response: () => new Response(null, { status: 503 }), errorCode: 'provider_unavailable' },
    { response: () => new Response(null, { status: 404 }), errorCode: 'provider_response_invalid' },
    {
      response: () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'text/plain' } }),
      errorCode: 'provider_response_invalid',
    },
    {
      response: () =>
        new Response('{"data":"not-an-array"}', { status: 200, headers: { 'content-type': 'application/json' } }),
      errorCode: 'provider_response_invalid',
    },
    {
      response: () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 + 1) },
        }),
      errorCode: 'provider_response_too_large',
    },
  ];
  for (const testCase of cases) {
    const result = await fetchOpencodeGoModels(SECRET, async () => testCase.response());
    assert.equal(result.state, 'failed', JSON.stringify(testCase));
    if (result.state === 'failed') assert.equal(result.errorCode, testCase.errorCode);
  }
  // A non-printable secret never reaches the wire.
  const invalid = await fetchOpencodeGoModels(Buffer.from('bad\nkey'), async () => {
    throw new Error('must not be called');
  });
  assert.deepEqual(invalid, { state: 'failed', errorCode: 'credential_format_invalid' });
});

/* ------------------------------------------------------------------ */
/* Cache: TTL / stale / fallback / singleflight                        */
/* ------------------------------------------------------------------ */

function fakeClock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms) => (current += ms) };
}

test('the cache falls back to the built-in catalog before the first successful sync', async () => {
  let calls = 0;
  const cache = createOpenCodeGoModelCatalogCache({
    resolveSecret: () => SECRET,
    now: () => 1_000_000,
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503 });
    },
  });
  const models = await cache.list();
  assert.equal(calls, 1);
  assert.deepEqual(models, mergeOpenCodeGoModelCatalog(null));
});

test('the cache serves fresh entries without refetching within the TTL', async () => {
  const clock = fakeClock();
  let calls = 0;
  const cache = createOpenCodeGoModelCatalogCache({
    resolveSecret: () => SECRET,
    now: clock.now,
    fetch: async () => {
      calls += 1;
      return modelsResponse(['upstream-model']);
    },
  });
  const first = await cache.list();
  assert.equal(calls, 1);
  assert.ok(first.includes('upstream-model'));
  clock.advance(OPENCODE_GO_MODELS_TTL_MS - 1);
  const second = await cache.list();
  assert.equal(calls, 1, 'fresh entry must not refetch');
  assert.deepEqual(second, first);
});

test('the cache serves stale entries while a singleflight background refresh runs', async () => {
  const clock = fakeClock();
  let calls = 0;
  let releaseRefresh: (() => void) | undefined;
  const cache = createOpenCodeGoModelCatalogCache({
    resolveSecret: () => SECRET,
    now: clock.now,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return modelsResponse(['upstream-model-v1']);
      // Second refresh (the background one) hangs until the test releases it.
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return modelsResponse(['upstream-model-v2']);
    },
  });
  await cache.list();
  assert.equal(calls, 1);
  clock.advance(OPENCODE_GO_MODELS_TTL_MS + 1_000);
  // Stale-while-revalidate: the stale catalog is served without waiting.
  const stale = await cache.list();
  assert.ok(stale.includes('upstream-model-v1'));
  assert.ok(!stale.includes('upstream-model-v2'));
  assert.equal(calls, 2, 'the background refresh was kicked off');
  releaseRefresh?.();
  // Let the background refresh settle, then confirm the new catalog is live.
  await new Promise((resolve) => setTimeout(resolve, 10));
  clock.advance(1);
  const refreshed = await cache.list();
  assert.ok(refreshed.includes('upstream-model-v2'), JSON.stringify(refreshed));
  assert.equal(calls, 2, 'no additional fetch within the new TTL');
});

test('past the stale window a failed refresh falls back to the built-in catalog', async () => {
  const clock = fakeClock();
  let calls = 0;
  const cache = createOpenCodeGoModelCatalogCache({
    resolveSecret: () => SECRET,
    now: clock.now,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return modelsResponse(['upstream-model']);
      return new Response(null, { status: 500 });
    },
  });
  await cache.list();
  clock.advance(OPENCODE_GO_MODELS_STALE_MS + 1);
  const models = await cache.list();
  assert.equal(calls, 2);
  // The stale entry is not resurrected: the built-in fallback is the floor.
  assert.deepEqual(models, mergeOpenCodeGoModelCatalog(null));
  assert.ok(!models.includes('upstream-model'));
});

test('concurrent list() calls beyond the stale window share one refresh (singleflight)', async () => {
  const clock = fakeClock();
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const cache = createOpenCodeGoModelCatalogCache({
    resolveSecret: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return SECRET;
    },
    now: clock.now,
    fetch: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return modelsResponse(['upstream-model']);
    },
  });
  const results = await Promise.all([cache.list(), cache.list(), cache.list()]);
  assert.equal(calls, 1, 'concurrent readers share the in-flight refresh');
  assert.equal(maxInFlight, 1);
  for (const models of results) assert.ok(models.includes('upstream-model'));
});

test('a 304 revalidation keeps the cached list and refreshes the timestamps', async () => {
  const clock = fakeClock();
  let calls = 0;
  const etags: Array<string | null> = [];
  const cache = createOpenCodeGoModelCatalogCache({
    resolveSecret: () => SECRET,
    now: clock.now,
    fetch: async (_url, init) => {
      calls += 1;
      etags.push(new Headers(init.headers).get('if-none-match'));
      if (calls === 1) return modelsResponse(['upstream-model'], '"etag-1"');
      return new Response(null, { status: 304 });
    },
  });
  await cache.list();
  clock.advance(OPENCODE_GO_MODELS_TTL_MS + 1);
  const models = await cache.list();
  assert.equal(calls, 2);
  assert.deepEqual(etags, [null, '"etag-1"']);
  assert.ok(models.includes('upstream-model'));
  // The revalidation refreshed the entry: the next read is fresh again.
  clock.advance(OPENCODE_GO_MODELS_TTL_MS - 1);
  await cache.list();
  assert.equal(calls, 2);
});
