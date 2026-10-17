import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSearchResponsesBody,
  parseSearchClientRequest,
} from '../../../../src/saas/gateway/websearch/emulation.js';
import {
  observeSearchProviderResponse,
  SEARCH_RESPONSE_MAX_BODY_BYTES,
  SearchResponseObservationError,
  searchDescriptorForDispatch,
} from '../../../../src/saas/gateway/websearch/response-observer.js';

/**
 * §4.3 (task #17): the search response observer — bounded buffering,
 * transform-or-fail-closed, per-call usage settlement.
 */

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

const PROVIDER_BODY = JSON.stringify({
  id: 'resp_1',
  output: [
    {
      type: 'web_search_call',
      action: {
        type: 'search',
        sources: [
          { url: 'https://a.example.com/1', title: 'A', snippet: 'sa', type: 'url' },
          { url: 'https://b.example.com/2', title: 'B', snippet: 'sb', type: 'url' },
        ],
      },
    },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: '{"results":[{"url":"https://a.example.com/1","title":"Enriched A","snippet":"enriched"}]}',
          annotations: [],
        },
      ],
    },
  ],
});

test('4.3 search observer: a valid envelope transforms into the client search body with one-unit usage', async () => {
  const descriptor = { kind: 'web_search' as const, query: 'q', maxResults: 5 };
  const observed = observeSearchProviderResponse(streamOf([encode(PROVIDER_BODY)]), descriptor);
  const usagePromise = observed.usage;
  const body = await readAll(observed.body);
  const parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  assert.equal(parsed.query, 'q');
  assert.equal(parsed.provider, 'responses-search-emulation');
  assert.equal(parsed.max_results, 5);
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.results[0].title, 'Enriched A');
  assert.equal(parsed.results[1].title, 'B');
  const usage = await usagePromise;
  assert.ok(usage);
  assert.equal(usage.billingMode, 'per_request');
  assert.equal(usage.units, 1);
  assert.equal(usage.source, 'upstream');
  assert.equal(observed.getUsage(), usage);
});

test('4.3 search observer: a multi-chunk envelope transforms identically', async () => {
  const descriptor = { kind: 'web_search' as const, query: 'q', maxResults: 5 };
  const bytes = encode(PROVIDER_BODY);
  const mid = Math.floor(bytes.length / 2);
  const observed = observeSearchProviderResponse(streamOf([bytes.subarray(0, mid), bytes.subarray(mid)]), descriptor);
  const usagePromise = observed.usage;
  const body = await readAll(observed.body);
  assert.equal(JSON.parse(Buffer.from(body).toString('utf8')).results.length, 2);
  assert.equal((await usagePromise)?.units, 1);
});

test('4.3 search observer: invalid provider bodies fail closed (no fake empty results, no billing)', async () => {
  const descriptor = { kind: 'web_search' as const, query: 'q', maxResults: 5 };
  for (const payload of ['not json', '{"error":{"message":"x"}}', '{"id":"resp_1"}']) {
    const observed = observeSearchProviderResponse(streamOf([encode(payload)]), descriptor);
    const usagePromise = observed.usage;
    await assert.rejects(async () => readAll(observed.body), SearchResponseObservationError);
    assert.equal(await usagePromise, null, `usage must stay unknown for ${payload}`);
  }
  // Oversized bodies fail closed the same way.
  const big = new Uint8Array(SEARCH_RESPONSE_MAX_BODY_BYTES + 1);
  const observed = observeSearchProviderResponse(streamOf([big]), descriptor);
  const usagePromise = observed.usage;
  await assert.rejects(async () => readAll(observed.body), SearchResponseObservationError);
  assert.equal(await usagePromise, null);
});

test('4.3 search observer: client cancellation resolves usage as unknown and cancels upstream', async () => {
  let cancelled = false;
  const hanging = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const descriptor = { kind: 'web_search' as const, query: 'q', maxResults: 5 };
  const observed = observeSearchProviderResponse(hanging, descriptor);
  const usagePromise = observed.usage;
  const reader = observed.body.getReader();
  const read = reader.read();
  await reader.cancel();
  await read.catch(() => undefined);
  assert.equal(cancelled, true);
  assert.equal(await usagePromise, null);
});

test('4.3 search dispatch gating: only signed search operations on a round-tripping payload', () => {
  const request = parseSearchClientRequest('x_search', { query: 'launch', max_results: 3 });
  assert.ok(request);
  const body = buildSearchResponsesBody('x_search', request, 'grok-4.5');
  // Signed search operation + verified payload → descriptor.
  assert.deepEqual(searchDescriptorForDispatch(body, 'x_search'), {
    kind: 'x_search',
    query: 'launch',
    maxResults: 3,
  });
  // The operation/body kind must agree.
  assert.equal(searchDescriptorForDispatch(body, 'web_search'), null);
  // Ordinary operations never adapt, even on a search-shaped body.
  assert.equal(searchDescriptorForDispatch(body, 'responses'), null);
  assert.equal(searchDescriptorForDispatch(body, undefined), null);
  // Search operations on a non-emulation payload fail closed (null → caller rejects).
  assert.equal(searchDescriptorForDispatch({ model: 'm', input: 'hi' }, 'web_search'), null);
  assert.equal(searchDescriptorForDispatch(null, 'web_search'), null);
});
