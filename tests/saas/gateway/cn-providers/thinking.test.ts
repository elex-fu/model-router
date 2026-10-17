import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMiniMaxMSeriesModel,
  normalizeChineseLlmThinking,
  resolveThinkingProtocol,
  shouldPreFilterThinkingBlocks,
  shouldRectifyThinkingSignatureError,
} from '../../../../src/saas/gateway/cn-providers/thinking.js';

test('resolveThinkingProtocol classifies the vendor prefix table (sub2api parity)', () => {
  const cases: readonly [model: string, expected: ReturnType<typeof resolveThinkingProtocol>][] = [
    // Passback-required: the CN vendor families.
    ['glm-5.3', 'passback-required'],
    ['GLM-4.7', 'passback-required'],
    ['glm-5.3-flash', 'passback-required'],
    ['minimax-m2', 'passback-required'],
    ['MiniMax-M2.7', 'passback-required'],
    ['minimax-m3', 'passback-required'],
    ['deepseek-v4-pro', 'passback-required'],
    ['kimi-k2.6', 'passback-required'],
    ['moonshot-v1-128k', 'passback-required'],
    // Bare Kimi Code aliases (exact match only).
    ['k3', 'passback-required'],
    ['k3-256k', 'passback-required'],
    // Qwen thinking variants (prefix + -thinking).
    ['qwen3-235b-a22b-thinking-2507', 'passback-required'],
    ['qwen-3-72b-thinking', 'passback-required'],
    ['qwen3.8-max', 'unknown'],
    // Anthropic-strict.
    ['claude-sonnet-4-6', 'anthropic-strict'],
    ['opus-4-1', 'anthropic-strict'],
    ['sonnet-4-5', 'anthropic-strict'],
    ['haiku-4-5', 'anthropic-strict'],
    // Unknown: conservative.
    ['gpt-5.6-luna', 'unknown'],
    ['muse-spark-1.3-contributor', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [model, expected] of cases) {
    assert.equal(resolveThinkingProtocol(model), expected, model);
  }
  // Passback-required matches BEFORE strict (a misnamed claude- alias of a
  // CN model cannot win).
  assert.equal(resolveThinkingProtocol('glm-claude-alias'), 'passback-required');
});

test('only anthropic-strict models pre-filter / rectify thinking blocks', () => {
  assert.equal(shouldPreFilterThinkingBlocks('claude-sonnet-4-6'), true);
  assert.equal(shouldRectifyThinkingSignatureError('claude-sonnet-4-6'), true);
  // The CN families: verbatim passback — never pre-filtered, never rectified
  // (a retry variant cannot fix a contract that REQUIRES the block).
  for (const model of ['glm-5.3', 'minimax-m2', 'kimi-k3', 'deepseek-v4-pro', 'qwen3-max-thinking-2507']) {
    assert.equal(shouldPreFilterThinkingBlocks(model), false, model);
    assert.equal(shouldRectifyThinkingSignatureError(model), false, model);
  }
  // Unknown models stay conservative (no filtering).
  assert.equal(shouldPreFilterThinkingBlocks('mystery-model'), false);
});

test('normalizeChineseLlmThinking rewrites MiniMax M-series thinking.type enabled → adaptive', () => {
  assert.equal(isMiniMaxMSeriesModel('MiniMax-M2'), true);
  assert.equal(isMiniMaxMSeriesModel('minimax-m2.7-highspeed'), true);
  assert.equal(isMiniMaxMSeriesModel('glm-5.3'), false);
  assert.equal(isMiniMaxMSeriesModel('minimax-text-01'), false);

  const body = {
    model: 'MiniMax-M2.7',
    thinking: { type: 'enabled', budget_tokens: 32000 },
    max_tokens: 64000,
  };
  const transformed = normalizeChineseLlmThinking(body, 'MiniMax-M2.7');
  assert.deepEqual(transformed, {
    model: 'MiniMax-M2.7',
    thinking: { type: 'adaptive', budget_tokens: 32000 },
    max_tokens: 64000,
  });
});

test('normalizeChineseLlmThinking is copy-on-write and scoped to the rewrite audience', () => {
  const body = { model: 'MiniMax-M2', thinking: { type: 'adaptive' } };
  assert.equal(normalizeChineseLlmThinking(body, 'MiniMax-M2'), body, 'already-adaptive: by reference');
  const disabled = { model: 'MiniMax-M2', thinking: { type: 'disabled' } };
  assert.equal(normalizeChineseLlmThinking(disabled, 'MiniMax-M2'), disabled, 'disabled: by reference');
  const noThinking = { model: 'MiniMax-M2' };
  assert.equal(normalizeChineseLlmThinking(noThinking, 'MiniMax-M2'), noThinking, 'no thinking: by reference');
  // Non-MiniMax models (Kimi/GLM accept 'enabled' as-is): by reference.
  const glm = { model: 'glm-5.3', thinking: { type: 'enabled' } };
  assert.equal(normalizeChineseLlmThinking(glm, 'glm-5.3'), glm);
  // Anthropic-strict models: untouched (strict semantics preserved).
  const claude = { model: 'claude-sonnet-4-6', thinking: { type: 'enabled' } };
  assert.equal(normalizeChineseLlmThinking(claude, 'claude-sonnet-4-6'), claude);
  // Non-record bodies pass through.
  assert.equal(normalizeChineseLlmThinking(null, 'MiniMax-M2'), null);
});
