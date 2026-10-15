import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeOpenCodeGoModelId,
  OPENCODE_GO_FALLBACK_MODEL_IDS,
  OPENCODE_GO_TEST_MODEL,
} from '../../../../src/saas/gateway/opencode-go/model-catalog.js';

test('fallback model catalog matches the sub2api reference list', () => {
  assert.deepEqual(OPENCODE_GO_FALLBACK_MODEL_IDS, [
    'grok-4.7',
    'grok-4.6',
    'gpt-5.6-luna',
    'glm-5.3-flash',
    'glm-5.3',
    'glm-5.2',
    'glm-5.1',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'longcat-2.0',
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'mimo-v2.5',
    'mimo-v2.5-pro',
    'minimax-m3',
    'minimax-m2.7',
    'minimax-m2.5',
    'muse-spark-1.3-contributor',
    'muse-spark-1.2-contributor',
    'qwen3.8-max',
    'qwen3.8-flash',
    'qwen3.7-max',
    'qwen3.7-plus',
    'qwen3.6-plus',
    'hy4-preview',
    'hy3',
    'omen-alpha',
  ]);
});

test('fallback model catalog ids are unique and non-empty', () => {
  const seen = new Set<string>();
  for (const model of OPENCODE_GO_FALLBACK_MODEL_IDS) {
    assert.ok(model.length > 0, `empty model id in catalog: ${JSON.stringify(OPENCODE_GO_FALLBACK_MODEL_IDS)}`);
    assert.ok(!seen.has(model), `duplicate model id in catalog: ${model}`);
    seen.add(model);
  }
});

test('fallback model catalog is frozen against mutation', () => {
  assert.ok(Object.isFrozen(OPENCODE_GO_FALLBACK_MODEL_IDS));
});

test('default test model is a member of the fallback catalog', () => {
  assert.equal(OPENCODE_GO_TEST_MODEL, 'glm-5.3');
  assert.ok(OPENCODE_GO_FALLBACK_MODEL_IDS.includes(OPENCODE_GO_TEST_MODEL));
});

test('normalizeOpenCodeGoModelId strips each known namespace prefix', () => {
  assert.equal(normalizeOpenCodeGoModelId('opencode-go/glm-5.3'), 'glm-5.3');
  assert.equal(normalizeOpenCodeGoModelId('opencode_go/glm-5.3'), 'glm-5.3');
  assert.equal(normalizeOpenCodeGoModelId('opencode/glm-5.3'), 'glm-5.3');
});

test('normalizeOpenCodeGoModelId is case-insensitive and trims whitespace', () => {
  assert.equal(normalizeOpenCodeGoModelId('  OPENCODE-GO/GLM-5.3  '), 'glm-5.3');
  assert.equal(normalizeOpenCodeGoModelId('\tOpencode_Go/Kimi-K3\n'), 'kimi-k3');
  assert.equal(normalizeOpenCodeGoModelId(' GLM-5.3 '), 'glm-5.3');
});

test('normalizeOpenCodeGoModelId strips each prefix at most once per variant (sub2api semantics)', () => {
  // The reference loops the three prefixes once each; a repeated prefix is
  // not stripped twice.
  assert.equal(normalizeOpenCodeGoModelId('opencode-go/opencode-go/glm-5.3'), 'opencode-go/glm-5.3');
  assert.equal(normalizeOpenCodeGoModelId('opencode/opencode/glm-5.3'), 'opencode/glm-5.3');
  // After stripping one variant, a different remaining variant stays.
  assert.equal(normalizeOpenCodeGoModelId('opencode/opencode-go/glm-5.3'), 'opencode-go/glm-5.3');
});

test('normalizeOpenCodeGoModelId leaves unknown and bare ids untouched', () => {
  assert.equal(normalizeOpenCodeGoModelId('glm-5.3'), 'glm-5.3');
  assert.equal(normalizeOpenCodeGoModelId('vendor/glm-5.3'), 'vendor/glm-5.3');
  // Only a prefix match counts; embedded occurrences stay.
  assert.equal(normalizeOpenCodeGoModelId('my-opencode-go/glm-5.3'), 'my-opencode-go/glm-5.3');
});

test('normalizeOpenCodeGoModelId maps prefix-only input to the empty string', () => {
  assert.equal(normalizeOpenCodeGoModelId('opencode/'), '');
  assert.equal(normalizeOpenCodeGoModelId('  OPENCODE-GO/ '), '');
  assert.equal(normalizeOpenCodeGoModelId(''), '');
});

test('normalized fallback catalog ids are fixed points', () => {
  for (const model of OPENCODE_GO_FALLBACK_MODEL_IDS) {
    assert.equal(normalizeOpenCodeGoModelId(model), model);
    assert.equal(normalizeOpenCodeGoModelId(`opencode-go/${model}`), model);
  }
});
