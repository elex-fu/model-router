import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBridge } from '../../src/protocol/bridge.js';
import { PassthroughAnthropicBridge } from '../../src/protocol/passthrough-anthropic.js';
import { PassthroughOpenAiBridge } from '../../src/protocol/passthrough-openai.js';
import { AnthToOpenAIBridge } from '../../src/protocol/anth-to-openai.js';
import { OpenAIToAnthBridge } from '../../src/protocol/openai-to-anth.js';

test('pickBridge(anthropic, anthropic) returns PassthroughAnthropicBridge', () => {
  const b = pickBridge('anthropic', 'anthropic');
  assert.ok(b instanceof PassthroughAnthropicBridge);
  assert.equal(b.clientProto, 'anthropic');
  assert.equal(b.upstreamProto, 'anthropic');
});

test('pickBridge(openai, openai) returns PassthroughOpenAiBridge', () => {
  const b = pickBridge('openai', 'openai');
  assert.ok(b instanceof PassthroughOpenAiBridge);
  assert.equal(b.clientProto, 'openai');
  assert.equal(b.upstreamProto, 'openai');
});

test('pickBridge(anthropic, openai) returns AnthToOpenAIBridge', () => {
  const b = pickBridge('anthropic', 'openai');
  assert.ok(b instanceof AnthToOpenAIBridge);
  assert.equal(b.clientProto, 'anthropic');
  assert.equal(b.upstreamProto, 'openai');
});

test('pickBridge(openai, anthropic) returns OpenAIToAnthBridge', () => {
  const b = pickBridge('openai', 'anthropic');
  assert.ok(b instanceof OpenAIToAnthBridge);
  assert.equal(b.clientProto, 'openai');
  assert.equal(b.upstreamProto, 'anthropic');
});
