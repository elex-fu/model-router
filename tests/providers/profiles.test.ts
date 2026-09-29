import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_PROFILES, providerProfile } from '../../src/providers/profiles.js';
import { joinApiUrl } from '../../src/providers/url.js';
import { normalizeUsage } from '../../src/providers/usage.js';

test('explicit presets have distinct protocol, endpoint and auth', () => {
  assert.equal(PROVIDER_PROFILES['kimi-platform'].baseUrl, 'https://api.moonshot.cn/v1');
  assert.equal(PROVIDER_PROFILES['kimi-code'].authMode, 'x-api-key');
  assert.equal(PROVIDER_PROFILES['deepseek-chat'].endpoint, 'chat/completions');
  assert.equal(PROVIDER_PROFILES['deepseek-anthropic'].protocol, 'anthropic');
  assert.equal(providerProfile('custom-openai', 'openai').nativeResponses, false);
  assert.equal(providerProfile('custom-responses', 'responses').nativeResponses, true);
});

test('URL joining preserves prefixes and fixed query', () => {
  for (const base of [
    'https://example.test',
    'https://example.test/',
    'https://example.test/v1/',
    'https://example.test/coding/v1',
    'https://example.test/gateway/team-a?region=cn',
  ]) {
    const url = joinApiUrl(base, 'messages');
    assert.equal(url.pathname, `${new URL(base).pathname.replace(/\/+$/, '')}/messages`);
    assert.equal(url.search, new URL(base).search);
  }
  for (const endpoint of ['/messages', '../messages', 'https://evil.test/messages', 'x%2f..', 'messages?to=evil']) {
    assert.throws(() => joinApiUrl('https://example.test/v1', endpoint));
  }
});

test('usage normalizes cache without double counting', () => {
  assert.deepEqual(
    normalizeUsage('anthropic', {
      usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 10, output_tokens: 20 },
    }),
    { inputTokens: 110, outputTokens: 20, cacheReadTokens: 60, cacheCreationTokens: 10 },
  );
  assert.deepEqual(
    normalizeUsage('openai', { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60, completion_tokens: 20 } }),
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
  );
  assert.deepEqual(normalizeUsage('openai', { choices: [] }), {});
});
