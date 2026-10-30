import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  joinProviderUrl,
  PROVIDER_PRESET_IDS,
  PROVIDER_PRESETS,
  presetAuthHeaders,
  providerPreset,
} from '../../../src/server/providers/presets.js';

test('every bundled preset resolves by id and round-trips through providerPreset', () => {
  for (const id of PROVIDER_PRESET_IDS) {
    const preset = providerPreset(id);
    assert.notEqual(preset, null, id);
    assert.equal(preset?.id, id, id);
    assert.equal(PROVIDER_PRESETS[id], preset, id);
    assert.notEqual(preset?.defaultBaseUrl, '', id);
    assert.notEqual(preset?.endpoint, '', id);
    assert.ok((preset?.models.length ?? -1) >= 0, id);
  }
});

test('providerPreset is case-insensitive and returns null for unknown ids', () => {
  assert.notEqual(providerPreset('OpenRouter'), null);
  assert.equal(providerPreset('not-a-preset'), null);
});

test('presets build their default URLs (baseUrl and endpoint omitted)', () => {
  assert.equal(providerPreset('openrouter')?.buildUrl({}), 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(providerPreset('groq')?.buildUrl({}), 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(providerPreset('siliconflow')?.buildUrl({}), 'https://api.siliconflow.cn/v1/chat/completions');
  assert.equal(providerPreset('deepseek-official')?.buildUrl({}), 'https://api.deepseek.com/chat/completions');
});

test('presets keep the model out of the URL and tolerate overrides', () => {
  const openrouter = providerPreset('openrouter');
  assert.ok(openrouter !== null);
  // The model rides the body for this provider family.
  assert.equal(
    openrouter.buildUrl({ model: 'anthropic/claude-sonnet-4.5' }),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  // A custom baseUrl replaces the default origin.
  assert.equal(
    openrouter.buildUrl({ baseUrl: 'https://openrouter.example.test/v1' }),
    'https://openrouter.example.test/v1/chat/completions',
  );
  // A custom endpoint replaces the default path.
  assert.equal(openrouter.buildUrl({ endpoint: 'completions' }), 'https://openrouter.ai/api/v1/completions');
  // Both at once.
  assert.equal(
    openrouter.buildUrl({ baseUrl: 'https://proxy.example.test', endpoint: 'v1/chat/completions' }),
    'https://proxy.example.test/v1/chat/completions',
  );
});

test('joinProviderUrl collapses slashes on both sides', () => {
  assert.equal(joinProviderUrl('https://a.test/v1/', '/chat/completions'), 'https://a.test/v1/chat/completions');
  assert.equal(joinProviderUrl('https://a.test/v1///', 'chat/completions'), 'https://a.test/v1/chat/completions');
  assert.equal(joinProviderUrl('https://a.test', 'chat/completions'), 'https://a.test/chat/completions');
  assert.equal(joinProviderUrl('https://a.test/v1', ''), 'https://a.test/v1');
});

test('presetAuthHeaders renders bearer, x-api-key and custom-header styles', () => {
  assert.deepEqual(presetAuthHeaders('bearer', 'test-key'), { authorization: 'Bearer test-key' });
  assert.deepEqual(presetAuthHeaders('x-api-key', 'test-key'), { 'x-api-key': 'test-key' });
  assert.deepEqual(presetAuthHeaders('custom-header', 'test-key', 'X-My-Provider'), { 'x-my-provider': 'test-key' });
  assert.throws(() => presetAuthHeaders('custom-header', 'test-key'), /authHeaderName/);
});

test('every bundled preset renders its documented auth style', () => {
  for (const id of PROVIDER_PRESET_IDS) {
    const preset = providerPreset(id);
    assert.ok(preset !== null, id);
    assert.equal(preset.authMode, 'bearer', `${id}: the bundled presets are all bearer`);
    assert.deepEqual(preset.authHeaders('test-key'), { authorization: 'Bearer test-key' }, id);
  }
});
