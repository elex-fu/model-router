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
