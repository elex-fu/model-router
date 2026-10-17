import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GROK_PLACEHOLDER_MODELS } from '../../../../src/saas/gateway/grok/catalog-identity.js';
import {
  applyGrokModelNormalization,
  GROK_MODEL_ID_OVERRIDES,
  isSafeGrokModelId,
  normalizeGrokModelId,
} from '../../../../src/saas/gateway/grok/transform.js';

test('model normalization: namespace strip, alias table and -latest folding', () => {
  assert.equal(normalizeGrokModelId('grok/grok-4.6'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('grok'), GROK_MODEL_ID_OVERRIDES.grok);
  assert.equal(normalizeGrokModelId('grok-latest'), 'grok-4.6');
  assert.equal(normalizeGrokModelId('grok-4.7-latest'), 'grok-4.7');
  assert.equal(normalizeGrokModelId('grok-4.7'), 'grok-4.7');
  assert.equal(normalizeGrokModelId(''), '');
});

test('model id safety gate for path interpolation', () => {
  assert.ok(isSafeGrokModelId('grok-4.6'));
  assert.ok(isSafeGrokModelId('grok-code-fast-1'));
  assert.ok(!isSafeGrokModelId('grok/../../etc'));
  assert.ok(!isSafeGrokModelId('grok model'));
  assert.ok(!isSafeGrokModelId(''));
  assert.ok(!isSafeGrokModelId('x'.repeat(200)));
  for (const model of GROK_PLACEHOLDER_MODELS) {
    assert.ok(isSafeGrokModelId(model), model);
  }
});

test('body normalization is copy-on-write', () => {
  const body = { model: 'grok/grok-4.6', input: [] };
  const normalized = applyGrokModelNormalization(body);
  assert.equal(normalized.model, 'grok-4.6');
  assert.notEqual(normalized, body);
  assert.equal(body.model, 'grok/grok-4.6');
  // An already-normalized body is returned unchanged (same reference).
  const canonical = { model: 'grok-4.6' };
  assert.equal(applyGrokModelNormalization(canonical), canonical);
});
