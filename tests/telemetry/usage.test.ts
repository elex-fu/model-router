import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmedTokens, normalizeUsage } from '../../src/telemetry/usage.js';

test('OpenAI cached and reasoning tokens are subdivisions, not extra totals', () => {
  const u = normalizeUsage('openai', {
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 60 },
    completion_tokens_details: { reasoning_tokens: 8 },
  });
  assert.equal(u.inputUncached, 40);
  assert.equal(u.reasoningOutput, 8);
  assert.equal(confirmedTokens(u), 120);
  assert.equal(u.status, 'reported');
});

test('Anthropic input is uncached plus cache read and write, with TTL split', () => {
  const u = normalizeUsage('anthropic', {
    input_tokens: 40,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 10,
    output_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
  });
  assert.equal(u.inputTotal, 110);
  assert.equal(u.inputUncached, 40);
  assert.equal(u.cacheWrite5m, 4);
  assert.equal(u.cacheWrite1h, 6);
  assert.equal(confirmedTokens(u), 130);
  const inclusive = normalizeUsage(
    'anthropic',
    { input_tokens: 110, cache_read_input_tokens: 60, cache_creation_input_tokens: 10, output_tokens: 20 },
    { inputIncludesCache: true },
  );
  assert.equal(confirmedTokens(inclusive), 130);
  assert.equal(inclusive.inputUncached, 40);
});

test('DeepSeek hit/miss cross-check preserves total and rejects inconsistent subdivision', () => {
  const raw = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 };
  const u = normalizeUsage('openai', raw, { provider: 'deepseek' });
  assert.equal(u.cacheRead, 60);
  assert.equal(u.inputUncached, 40);
  assert.equal(confirmedTokens(u), 120);
  const inconsistent = normalizeUsage('openai', { ...raw, prompt_cache_miss_tokens: 30 }, { provider: 'deepseek' });
  assert.equal(inconsistent.inputUncached, null);
  assert.equal(inconsistent.status, 'partial');
});

test('missing usage remains unknown; partial stream usage is not zero', () => {
  assert.equal(normalizeUsage('responses', null).status, 'missing');
  const u = normalizeUsage('responses', { output_tokens: 3 });
  assert.equal(u.status, 'partial');
  assert.equal(u.inputTotal, null);
  assert.equal(confirmedTokens(u), null);
});
