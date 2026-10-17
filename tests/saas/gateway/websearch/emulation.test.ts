import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSearchClientResponse,
  buildSearchPrompt,
  buildSearchResponsesBody,
  describeSearchResponsesBody,
  normalizeSearchMaxResults,
  normalizeSearchUrl,
  parseSearchClientRequest,
  parseSearchPrompt,
  parseSearchResponsesBody,
  parseStructuredSearchResults,
  transformSearchResponsesBody,
} from '../../../../src/saas/gateway/websearch/emulation.js';

/**
 * §4.3 (task #17): web/x search emulation — the sub2api
 * gateway_web_search.go / openai_x_search.go semantics ported pure.
 */

function providerEnvelope(options: {
  readonly sources?: ReadonlyArray<{ url: string; title?: string; snippet?: string }>;
  readonly messageText?: string;
  readonly annotations?: ReadonlyArray<{ type: string; url: string; title?: string }>;
  readonly kind?: 'web_search_call' | 'x_search_call';
}): Record<string, unknown> {
  const output: unknown[] = [];
  if (options.sources !== undefined) {
    output.push({
      type: options.kind ?? 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'q',
        sources: options.sources.map((source) => ({ ...source, type: 'url' })),
      },
    });
  }
  if (options.messageText !== undefined) {
    output.push({
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: options.messageText,
          annotations: (options.annotations ?? []).map((annotation) => ({ ...annotation })),
        },
      ],
    });
  }
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output,
    usage: { input_tokens: 200, output_tokens: 40 },
  };
}

test('4.3 search: max_results normalization (1-20, default 5, invalid falls back)', () => {
  assert.equal(normalizeSearchMaxResults(undefined), 5);
  assert.equal(normalizeSearchMaxResults(null), 5);
  assert.equal(normalizeSearchMaxResults(0), 5);
  assert.equal(normalizeSearchMaxResults(-3), 5);
  assert.equal(normalizeSearchMaxResults(3.5), 5);
  assert.equal(normalizeSearchMaxResults('7'), 5);
  assert.equal(normalizeSearchMaxResults(1), 1);
  assert.equal(normalizeSearchMaxResults(20), 20);
  assert.equal(normalizeSearchMaxResults(21), 20);
});

test('4.3 search: client request parsing — query required, input alias, x filters', () => {
  assert.equal(parseSearchClientRequest('web_search', null), null);
  assert.equal(parseSearchClientRequest('web_search', {}), null);
  assert.equal(parseSearchClientRequest('web_search', { query: '   ' }), null);
  assert.equal(parseSearchClientRequest('web_search', { query: 'q', max_results: 'nope' }), null);
  assert.deepEqual(parseSearchClientRequest('web_search', { query: 'climate news' }), {
    query: 'climate news',
    maxResults: 5,
  });
  // The sub2api `input` alias.
  assert.deepEqual(parseSearchClientRequest('x_search', { input: 'ai trend', max_results: 10 }), {
    query: 'ai trend',
    maxResults: 10,
  });
  // x filters ride the x_search request; web_search ignores them.
  const xReq = parseSearchClientRequest('x_search', {
    query: 'grok',
    allowed_x_handles: [' xai ', 'elonmusk', 42, ''],
    from_date: ' 2026-10-01 ',
    enable_image_understanding: true,
  });
  assert.equal(xReq?.query, 'grok');
  assert.deepEqual(xReq?.xFilters, {
    allowedXHandles: ['xai', 'elonmusk'],
    excludedXHandles: undefined,
    fromDate: '2026-10-01',
    toDate: undefined,
    enableImageUnderstanding: true,
    enableVideoUnderstanding: undefined,
  });
  // x filters are never admitted onto a web_search request.
  const webReq = parseSearchClientRequest('web_search', { query: 'q', allowed_x_handles: ['xai'] });
  assert.equal(webReq?.xFilters, undefined);
});

test('4.3 search: request construction — web_search and x_search shapes', () => {
  const web = buildSearchResponsesBody('web_search', { query: 'what is rtk', maxResults: 5 }, 'grok-4.5');
  assert.equal(web.model, 'grok-4.5');
  assert.equal(web.store, false);
  assert.equal(web.stream, false);
  assert.deepEqual(web.include, ['web_search_call.action.sources']);
  assert.deepEqual(web.tools, [{ type: 'web_search' }]);
  assert.equal(web.tool_choice, undefined);
  assert.match(web.input as string, /at most 5 unique results/);
  assert.match(web.input as string, /User query:\nwhat is rtk$/);

  const xReq = parseSearchClientRequest('x_search', {
    query: 'launch',
    max_results: 8,
    excluded_x_handles: ['spam'],
    to_date: '2026-12-31',
    enable_video_understanding: false,
  });
  assert.ok(xReq);
  const x = buildSearchResponsesBody('x_search', xReq, 'grok-4.5');
  assert.deepEqual(x.include, ['x_search_call.action.sources']);
  assert.equal(x.tool_choice, 'required');
  assert.deepEqual(x.tools, [
    {
      type: 'x_search',
      excluded_x_handles: ['spam'],
      to_date: '2026-12-31',
      enable_video_understanding: false,
    },
  ]);
  assert.match(x.input as string, /actual x_search source/);
});

test('4.3 search: the construction round-trips through the payload descriptor exactly', () => {
  for (const kind of ['web_search', 'x_search'] as const) {
    const request = parseSearchClientRequest(kind, {
      query: 'multi word\nquery with {braces} & "quotes"',
      max_results: 12,
      ...(kind === 'x_search' ? { allowed_x_handles: ['xai'] } : {}),
    });
    assert.ok(request);
    const body = buildSearchResponsesBody(kind, request, 'grok-4.5');
    const descriptor = describeSearchResponsesBody(body);
    assert.deepEqual(descriptor, { kind, query: request.query, maxResults: 12 });
  }
  // The template's own prompt parse helpers agree.
  const prompt = buildSearchPrompt('web_search', 'q', 5);
  assert.deepEqual(parseSearchPrompt('web_search', prompt), { query: 'q', maxResults: 5 });
  assert.equal(parseSearchPrompt('x_search', prompt), null);

  // Ordinary responses traffic never recognizes as search.
  assert.equal(describeSearchResponsesBody(null), null);
  assert.equal(describeSearchResponsesBody({ input: 'hi' }), null);
  assert.equal(describeSearchResponsesBody({ model: 'm', input: 'hi', tools: [{ type: 'web_search' }] }), null);
  // store/stream drift rejects the round-trip.
  const drifted = buildSearchResponsesBody('web_search', { query: 'q', maxResults: 5 }, 'm');
  assert.equal(describeSearchResponsesBody({ ...drifted, store: true }), null);
  assert.equal(describeSearchResponsesBody({ ...drifted, stream: true }), null);
  assert.equal(describeSearchResponsesBody({ ...drifted, include: ['web_search_call.action.sources', 'other'] }), null);
});

test('4.3 search: URL normalization (lowercase host, fragment dropped, default path)', () => {
  assert.equal(normalizeSearchUrl('HTTPS://Example.COM/A'), 'https://example.com/A');
  assert.equal(normalizeSearchUrl('https://example.com/page#frag'), 'https://example.com/page');
  assert.equal(normalizeSearchUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeSearchUrl('  https://a.example.com/x?y=1  '), 'https://a.example.com/x?y=1');
  assert.equal(normalizeSearchUrl('ftp://example.com/x'), null);
  assert.equal(normalizeSearchUrl('javascript:alert(1)'), null);
  assert.equal(normalizeSearchUrl('not a url'), null);
  assert.equal(normalizeSearchUrl(''), null);
  assert.equal(normalizeSearchUrl(42 as unknown as string), null);
});

test('4.3 search: whitelist gate — model-fabricated URLs are dropped, enrichment only for real sources', () => {
  const body = providerEnvelope({
    sources: [
      { url: 'https://news.example.com/story', title: 'Story', snippet: 'raw snippet' },
      { url: 'https://blog.example.org/post' },
    ],
    messageText: JSON.stringify({
      results: [
        {
          url: 'https://news.example.com/story',
          title: 'Better title',
          snippet: 'Better summary',
        },
        // Hallucinated URL — never visited by the tool; must be dropped.
        { url: 'https://invented.example.net/fake', title: 'Fake', snippet: 'fake' },
      ],
    }),
  });
  const results = parseSearchResponsesBody(body, 5);
  // The fabricated URL is gone; the whitelisted result kept the enrichment;
  // the second raw source pads the shortfall (fallback in source order).
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    url: 'https://news.example.com/story',
    title: 'Better title',
    snippet: 'Better summary',
  });
  assert.deepEqual(results[1], {
    url: 'https://blog.example.org/post',
    title: 'blog.example.org',
    snippet: '',
  });
});

test('4.3 search: empty/absent structured output falls back to raw sources', () => {
  // No message output at all — pure fallback.
  const sourcesOnly = providerEnvelope({
    sources: [{ url: 'https://a.example.com/1', title: 'One', snippet: 's1' }, { url: 'https://b.example.com/2' }],
  });
  const results = parseSearchResponsesBody(sourcesOnly, 5);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { url: 'https://a.example.com/1', title: 'One', snippet: 's1' });
  assert.equal(results[1]?.url, 'https://b.example.com/2');
  assert.equal(results[1]?.title, 'b.example.com');

  // Malformed structured JSON in the message — same fallback.
  const malformed = providerEnvelope({
    sources: [{ url: 'https://a.example.com/1', title: 'One', snippet: '' }],
    messageText: 'here is the JSON: {"results": [',
  });
  assert.equal(parseSearchResponsesBody(malformed, 5).length, 1);

  // No sources at all → empty result set (a legitimate outcome).
  assert.equal(parseSearchResponsesBody(providerEnvelope({ messageText: '{"results": []}' }), 5).length, 0);
  assert.equal(parseSearchResponsesBody(null, 5).length, 0);
  assert.equal(parseSearchResponsesBody({}, 5).length, 0);
});

test('4.3 search: annotations contribute whitelist sources; x_search_call sources parse', () => {
  const body = providerEnvelope({
    kind: 'x_search_call',
    sources: [{ url: 'https://x.com/xai/status/1' }],
    messageText: JSON.stringify({ results: [{ url: 'https://x.com/xai/status/1', title: '', snippet: '' }] }),
    annotations: [{ type: 'url_citation', url: 'https://docs.x.ai/overview' }],
  });
  const results = parseSearchResponsesBody(body, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.url, 'https://x.com/xai/status/1');
  assert.equal(results[1]?.url, 'https://docs.x.ai/overview');

  // max_results caps the output.
  assert.equal(parseSearchResponsesBody(body, 1).length, 1);
});

test('4.3 search: unusable model titles/snippets fall back to the source values', () => {
  const body = providerEnvelope({
    sources: [{ url: 'https://a.example.com/', title: 'Source title', snippet: 'source snippet' }],
    messageText: JSON.stringify({
      results: [
        { url: 'https://a.example.com/', title: 'https://a.example.com/', snippet: '  ' },
        { url: 'https://a.example.com/', title: '42', snippet: 'x' },
      ],
    }),
  });
  const results = parseSearchResponsesBody(body, 5);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    url: 'https://a.example.com/',
    title: 'Source title',
    snippet: 'source snippet',
  });
});

test('4.3 search: full response transform — client body + error envelopes rejected', () => {
  const descriptor = { kind: 'web_search' as const, query: 'q', maxResults: 3 };
  const body = providerEnvelope({
    sources: [{ url: 'https://a.example.com/', title: 'A', snippet: 'sa' }],
    messageText: '{"results": []}',
  });
  const transformed = transformSearchResponsesBody(body, descriptor);
  assert.deepEqual(transformed, {
    query: 'q',
    results: [{ url: 'https://a.example.com/', title: 'A', snippet: 'sa' }],
    provider: 'responses-search-emulation',
    max_results: 3,
  });
  assert.equal(transformSearchResponsesBody(null, descriptor), null);
  assert.equal(transformSearchResponsesBody({ error: { message: 'x' } }, descriptor), null);
  assert.equal(transformSearchResponsesBody({ id: 'resp_1' }, descriptor), null);
  assert.deepEqual(buildSearchClientResponse({ query: 'q', maxResults: 5 }, []), {
    query: 'q',
    results: [],
    provider: 'responses-search-emulation',
    max_results: 5,
  });
});

test('4.3 search: structured result parsing tolerates prose around the JSON block', () => {
  const parsed = parseStructuredSearchResults(
    'Sure! Here you go: {"results":[{"url":"https://a.example.com/","title":"T","snippet":"S","page_age":"2026-10-10"}]} end.',
  );
  assert.deepEqual(parsed, [{ url: 'https://a.example.com/', title: 'T', snippet: 'S', pageAge: '2026-10-10' }]);
  assert.deepEqual(parseStructuredSearchResults('no json here'), []);
  assert.deepEqual(parseStructuredSearchResults('{"results": "nope"}'), []);
  assert.deepEqual(parseStructuredSearchResults('{"results": [{"title": "no url"}]}'), []);
});
