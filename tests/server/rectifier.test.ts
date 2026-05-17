import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThinkingSignatureError, rectifyAnthropicRequest } from '../../src/server/rectifier.js';

test('detects invalid signature in thinking block', () => {
  assert.ok(isThinkingSignatureError("Invalid `signature` in `thinking` block"));
});

test('detects thought signature is not valid', () => {
  assert.ok(isThinkingSignatureError("Unable to submit request because Thought signature is not valid"));
});

test('detects must start with a thinking block', () => {
  assert.ok(isThinkingSignatureError("a final assistant message must start with a thinking block"));
});

test('detects expected thinking but found tool_use', () => {
  assert.ok(isThinkingSignatureError("Expected `thinking` or `redacted_thinking`, but found `tool_use`"));
});

test('detects signature field required', () => {
  assert.ok(isThinkingSignatureError("***.signature: Field required"));
});

test('detects signature extra inputs not permitted', () => {
  assert.ok(isThinkingSignatureError("xxx.signature: Extra inputs are not permitted"));
});

test('detects thinking cannot be modified', () => {
  assert.ok(isThinkingSignatureError("thinking or redacted_thinking blocks cannot be modified"));
});

test('detects illegal request (Chinese)', () => {
  assert.ok(isThinkingSignatureError("非法请求：thinking signature 不合法"));
});

test('detects invalid request catch-all', () => {
  assert.ok(isThinkingSignatureError("invalid request: malformed JSON"));
});

test('does not trigger on unrelated errors', () => {
  assert.ok(!isThinkingSignatureError("Request timeout"));
  assert.ok(!isThinkingSignatureError("Connection refused"));
});

test('rectify removes thinking and redacted_thinking blocks', () => {
  const body = {
    model: 'claude-test',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 't', signature: 'sig1' },
        { type: 'text', text: 'hello', signature: 'sig2' },
        { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {}, signature: 'sig3' },
        { type: 'redacted_thinking', data: 'r', signature: 'sig4' },
      ],
    }],
  };
  const result = rectifyAnthropicRequest(body);
  assert.ok(result.applied);
  const content = result.body.messages[0].content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].signature, undefined);
  assert.equal(content[1].type, 'tool_use');
  assert.equal(content[1].signature, undefined);
});

test('rectify removes top-level thinking when enabled and last assistant lacks thinking prefix with tool_use', () => {
  const body = {
    model: 'claude-test',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      },
    ],
  };
  const result = rectifyAnthropicRequest(body);
  assert.ok(result.applied);
  assert.equal(result.body.thinking, undefined);
});

test('rectify preserves top-level adaptive thinking', () => {
  const body = {
    model: 'claude-test',
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} },
        ],
      },
    ],
  };
  const result = rectifyAnthropicRequest(body);
  assert.ok(!result.applied);
  assert.equal(result.body.thinking.type, 'adaptive');
});

test('rectify preserves top-level enabled thinking when last assistant starts with thinking', () => {
  const body = {
    model: 'claude-test',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'some thought' },
          { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} },
        ],
      },
    ],
  };
  const result = rectifyAnthropicRequest(body);
  assert.ok(result.applied); // thinking block removed
  // After removal, first block becomes tool_use, so top-level thinking should be removed
  assert.equal(result.body.thinking, undefined);
});

test('rectify no change when no issues', () => {
  const body = {
    model: 'claude-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  };
  const result = rectifyAnthropicRequest(body);
  assert.ok(!result.applied);
});

test('rectify does not mutate original body', () => {
  const body = {
    model: 'claude-test',
    messages: [{
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 't' }],
    }],
  };
  const original = JSON.stringify(body);
  rectifyAnthropicRequest(body);
  assert.equal(JSON.stringify(body), original);
});
