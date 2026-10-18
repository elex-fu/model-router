import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyThinkingPolicy, extractThinkingIntent, modelCanThink } from '../../src/server/thinking-policy.js';

/**
 * Gap-remediation G-B6 (§7.2 item 4): the three-stage thinking policy —
 * intent extraction (suffix + protocol-native), target-model validation
 * (strip, never error), provider transformation (clamping + downgrading).
 */

test('G-B6 ①: the model-suffix form extracts a budget intent', () => {
  const extracted = extractThinkingIntent({ model: 'claude-sonnet-4-6(8192)' });
  assert.ok(extracted !== null);
  assert.deepEqual(extracted.intent, { enabled: true, budgetTokens: 8192 });
  assert.ok(extracted.diagnostics.includes('thinking.intent.suffix'));
});

test('G-B6 ①: protocol-native shapes extract (anthropic / openai / gemini / kimi)', () => {
  const anthropic = extractThinkingIntent({ model: 'm', thinking: { type: 'enabled', budget_tokens: 1024 } });
  assert.deepEqual(anthropic?.intent, { enabled: true, budgetTokens: 1024, level: 'high' });
  const openai = extractThinkingIntent({ model: 'm', reasoning_effort: 'medium' });
  assert.deepEqual(openai?.intent, { enabled: true, level: 'medium' });
  const gemini = extractThinkingIntent({
    model: 'm',
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
  });
  assert.deepEqual(gemini?.intent, { enabled: true, level: 'high' });
  const kimi = extractThinkingIntent({ model: 'm', thinking: { effort: 'low' } });
  assert.deepEqual(kimi?.intent, { enabled: true, level: 'low' });
  assert.equal(extractThinkingIntent({ model: 'm', temperature: 1 }), null, 'no intent passes through');
});

test('G-B6 ②: a non-thinking model strips the intent instead of erroring', () => {
  const decision = applyThinkingPolicy({
    body: { model: 'claude-haiku-4-5', thinking: { type: 'enabled', budget_tokens: 512 }, max_tokens: 1024 },
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
  });
  assert.ok(decision.diagnostics.includes('thinking.model.cannot-think-stripped'));
  assert.equal(decision.body?.thinking, undefined);
  assert.equal(modelCanThink('claude-haiku-4-5'), false);
  assert.equal(modelCanThink('claude-sonnet-4-6'), true);
});

test('G-B6 ③: anthropic writes the budget clamped below max_tokens', () => {
  const decision = applyThinkingPolicy({
    body: { model: 'claude-sonnet-4-6(4000)', max_tokens: 2048 },
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  });
  assert.ok(decision.diagnostics.includes('thinking.budget.clamped'));
  assert.deepEqual(decision.body?.thinking, { type: 'enabled', budget_tokens: 2047 });
});

test('G-B6 ③: openai maps the effort with xhigh downgraded to high', () => {
  const decision = applyThinkingPolicy({
    body: { model: 'gpt-5.2', reasoning_effort: 'xhigh' },
    model: 'gpt-5.2',
    provider: 'openai',
  });
  assert.ok(decision.diagnostics.includes('thinking.level.downgraded'));
  assert.equal(decision.body?.reasoning_effort, 'high');
});

test('G-B6 ③: gemini writes thinkingLevel (or thinkingBudget) under generationConfig', () => {
  const level = applyThinkingPolicy({
    body: { model: 'gemini-3-pro', reasoning_effort: 'high', generationConfig: {} },
    model: 'gemini-3-pro',
    provider: 'gemini',
  });
  assert.deepEqual((level.body?.generationConfig as Record<string, unknown>)?.thinkingConfig, {
    thinkingLevel: 'high',
  });
  const budget = applyThinkingPolicy({
    body: { model: 'gemini-3-pro(2048)', max_tokens: 4096 },
    model: 'gemini-3-pro',
    provider: 'gemini',
  });
  assert.deepEqual((budget.body?.generationConfig as Record<string, unknown>)?.thinkingConfig, {
    thinkingBudget: 2048,
  });
});

test('G-B6 ③: kimi maps effort with max downgraded to high', () => {
  const decision = applyThinkingPolicy({
    body: { model: 'kimi-for-coding', thinking: { effort: 'max' } },
    model: 'kimi-for-coding',
    provider: 'kimi',
  });
  assert.ok(decision.diagnostics.includes('thinking.level.downgraded'));
  assert.deepEqual(decision.body?.thinking, { effort: 'high' });
});

test('G-B6: an explicit disabled intent strips the provider fields', () => {
  const decision = applyThinkingPolicy({
    body: { model: 'm', thinking: { type: 'disabled' }, reasoning_effort: 'high' },
    model: 'm',
    provider: 'openai',
  });
  assert.equal(decision.body?.thinking, undefined);
  assert.equal(decision.body?.reasoning_effort, undefined);
});

test('G-B6: the input body is never mutated', () => {
  const original = { model: 'claude-sonnet-4-6(4096)', max_tokens: 8192, thinking: undefined };
  const decision = applyThinkingPolicy({
    body: original as Record<string, unknown>,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  });
  assert.deepEqual(original.thinking, undefined);
  assert.notEqual(decision.body, original);
});
