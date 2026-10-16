import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OPENROUTER_ENDPOINT } from '../../../../src/saas/gateway/openrouter/catalog-identity.js';
import {
  createOpenRouterFixedRequestHeaders,
  OPENROUTER_ATTRIBUTION_TITLE_DEFAULT,
} from '../../../../src/saas/gateway/openrouter/transport-headers.js';

test('the default resolver adds only the attribution title for openrouter traffic', () => {
  const resolver = createOpenRouterFixedRequestHeaders();
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT }), { 'x-title': OPENROUTER_ATTRIBUTION_TITLE_DEFAULT });
  // Endpoint-keyed: every provider protocol gets the same headers.
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT, providerProtocol: 'openai' }), {
    'x-title': OPENROUTER_ATTRIBUTION_TITLE_DEFAULT,
  });
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT, providerProtocol: 'anthropic' }), {
    'x-title': OPENROUTER_ATTRIBUTION_TITLE_DEFAULT,
  });
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT, providerProtocol: undefined }), {
    'x-title': OPENROUTER_ATTRIBUTION_TITLE_DEFAULT,
  });
});

test('the resolver adds nothing for any other endpoint scope', () => {
  const resolver = createOpenRouterFixedRequestHeaders({ referer: 'https://example.test/', title: 'Example' });
  assert.equal(resolver({ endpoint: 'opencode-go-zen', providerProtocol: 'anthropic' }), null);
  assert.equal(resolver({ endpoint: 'codex-responses', providerProtocol: 'responses' }), null);
  assert.equal(resolver({ endpoint: 'other-endpoint' }), null);
  assert.equal(resolver({}), null);
});

test('a configured referer and title are carried on every openrouter request', () => {
  const resolver = createOpenRouterFixedRequestHeaders({ referer: 'https://example.test/app', title: 'Example App' });
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT, providerProtocol: 'openai' }), {
    'http-referer': 'https://example.test/app',
    'x-title': 'Example App',
  });
});

test('whitespace-only title falls back to the default and referer values are trimmed', () => {
  const resolver = createOpenRouterFixedRequestHeaders({ referer: '  https://example.test/  ', title: '   ' });
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT }), {
    'http-referer': 'https://example.test/',
    'x-title': OPENROUTER_ATTRIBUTION_TITLE_DEFAULT,
  });
});

test('an empty referer option is omitted rather than sent blank', () => {
  const resolver = createOpenRouterFixedRequestHeaders({ referer: '' });
  assert.deepEqual(resolver({ endpoint: OPENROUTER_ENDPOINT }), { 'x-title': OPENROUTER_ATTRIBUTION_TITLE_DEFAULT });
});

test('control characters in header values are rejected at construction time', () => {
  assert.throws(() => createOpenRouterFixedRequestHeaders({ referer: 'https://example.test/\u0007' }), TypeError);
  assert.throws(() => createOpenRouterFixedRequestHeaders({ title: 'bad\u0007title' }), TypeError);
});

test('the returned header record is frozen', () => {
  const resolver = createOpenRouterFixedRequestHeaders({ referer: 'https://example.test/' });
  const headers = resolver({ endpoint: OPENROUTER_ENDPOINT });
  assert.ok(headers);
  assert.ok(Object.isFrozen(headers));
});
