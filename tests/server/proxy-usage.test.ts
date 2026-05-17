import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNonStreamUsage } from '../../src/server/proxy.js';

test('extractNonStreamUsage: anthropic basic tokens', () => {
  const body = { usage: { input_tokens: 10, output_tokens: 20 } };
  const u = extractNonStreamUsage('anthropic', body);
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheReadTokens, undefined);
  assert.equal(u.cacheCreationTokens, undefined);
});

test('extractNonStreamUsage: anthropic with cache tokens', () => {
  const body = {
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
    },
  };
  const u = extractNonStreamUsage('anthropic', body);
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.cacheReadTokens, 80);
  assert.equal(u.cacheCreationTokens, 20);
});

test('extractNonStreamUsage: openai basic tokens', () => {
  const body = { usage: { prompt_tokens: 30, completion_tokens: 15 } };
  const u = extractNonStreamUsage('openai', body);
  assert.equal(u.inputTokens, 30);
  assert.equal(u.outputTokens, 15);
  assert.equal(u.cacheReadTokens, undefined);
});

test('extractNonStreamUsage: openai with cached_tokens', () => {
  const body = {
    usage: {
      prompt_tokens: 200,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 150 },
    },
  };
  const u = extractNonStreamUsage('openai', body);
  assert.equal(u.inputTokens, 200);
  assert.equal(u.outputTokens, 100);
  assert.equal(u.cacheReadTokens, 150);
});

test('extractNonStreamUsage: handles null/undefined body', () => {
  assert.deepEqual(extractNonStreamUsage('anthropic', null), {});
  assert.deepEqual(extractNonStreamUsage('anthropic', undefined), {});
  assert.deepEqual(extractNonStreamUsage('openai', 'string'), {});
});

import { injectAnthropicHeaders, stripThinkingBetasFromHeaders } from '../../src/server/proxy.js';

test('injectAnthropicHeaders: adds version and beta for legacy model', () => {
  const h = new Headers();
  injectAnthropicHeaders(h, 'claude-sonnet-4-5');
  assert.equal(h.get('anthropic-version'), '2023-06-01');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('interleaved-thinking-2025-05-14'));
});

test('injectAnthropicHeaders: adds context beta for opus/sonnet-4-6', () => {
  const h = new Headers();
  injectAnthropicHeaders(h, 'claude-opus-4-7');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('context-1m-2025-08-07'));
  assert.ok(!beta.includes('interleaved-thinking-2025-05-14'));
});

test('injectAnthropicHeaders: skips thinking beta for haiku', () => {
  const h = new Headers();
  injectAnthropicHeaders(h, 'claude-haiku-4-5');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(!beta.includes('interleaved-thinking-2025-05-14'));
  assert.ok(!beta.includes('context-1m-2025-08-07'));
});

test('injectAnthropicHeaders: preserves existing client beta and deduplicates', () => {
  const h = new Headers();
  h.set('anthropic-beta', 'claude-code-20250219, custom-beta');
  injectAnthropicHeaders(h, 'claude-sonnet-4-5');
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('custom-beta'));
  assert.ok(beta.includes('interleaved-thinking-2025-05-14'));
  // Should not duplicate claude-code-20250219
  const matches = beta.match(/claude-code-20250219/g);
  assert.equal(matches?.length, 1);
});

test('injectAnthropicHeaders: does not override existing anthropic-version', () => {
  const h = new Headers();
  h.set('anthropic-version', '2025-01-01');
  injectAnthropicHeaders(h, 'claude-test');
  assert.equal(h.get('anthropic-version'), '2025-01-01');
});

test('stripThinkingBetasFromHeaders: removes thinking betas', () => {
  const h = new Headers();
  h.set('anthropic-beta', 'claude-code-20250219, interleaved-thinking-2025-05-14, custom-beta');
  stripThinkingBetasFromHeaders(h);
  const beta = h.get('anthropic-beta') ?? '';
  assert.ok(beta.includes('claude-code-20250219'));
  assert.ok(beta.includes('custom-beta'));
  assert.ok(!beta.includes('interleaved-thinking-2025-05-14'));
});

test('stripThinkingBetasFromHeaders: deletes header when empty', () => {
  const h = new Headers();
  h.set('anthropic-beta', 'interleaved-thinking-2025-05-14');
  stripThinkingBetasFromHeaders(h);
  assert.equal(h.has('anthropic-beta'), false);
});
