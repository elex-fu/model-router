import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyRequest,
  downgradeWarmupModel,
  injectDeterministicIds,
  mergeToolResults,
  optimizeCopilotBody,
  optimizeCopilotHeaders,
  stripThinkingBlocks,
} from '../../src/server/copilotOptimizer.js';

test('classifyRequest: detects warmup', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  assert.equal(classifyRequest(body).isWarmup, false);
  assert.equal(classifyRequest({ messages: [{ role: 'user', content: '1' }] }).isWarmup, true);
  assert.equal(classifyRequest({ messages: [{ role: 'user', content: 'warmup test' }] }).isWarmup, true);
});

test('classifyRequest: detects compact', () => {
  const body = { messages: Array(25).fill({ role: 'user', content: 'x' }) };
  assert.equal(classifyRequest(body).isCompact, true);
  assert.equal(classifyRequest({ messages: [{ role: 'user', content: 'x' }] }).isCompact, false);
});

test('classifyRequest: detects subagent', () => {
  assert.equal(classifyRequest({ messages: [], system: 'You are a subagent' }).isSubagent, true);
  assert.equal(classifyRequest({ messages: [], system: 'You are helpful' }).isSubagent, false);
});

test('mergeToolResults: merges adjacent tool_result + text', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: 'explain' },
        ],
      },
    ],
  };
  mergeToolResults(body);
  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[0].content[0].type, 'tool_result');
  assert.equal(body.messages[0].content[0].content, 'ok\nexplain');
});

test('mergeToolResults: no change when not adjacent', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'explain' },
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        ],
      },
    ],
  };
  mergeToolResults(body);
  assert.equal(body.messages[0].content.length, 2);
});

test('stripThinkingBlocks: removes thinking from assistant', () => {
  const body = {
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello' },
          { type: 'redacted_thinking', data: 'r' },
        ],
      },
    ],
  };
  stripThinkingBlocks(body);
  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[0].content[0].type, 'text');
});

test('stripThinkingBlocks: leaves user messages alone', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    ],
  };
  stripThinkingBlocks(body);
  assert.equal(body.messages[0].content.length, 1);
});

test('downgradeWarmupModel: changes model when _isWarmup', () => {
  const body = { model: 'gpt-4o', _isWarmup: true };
  downgradeWarmupModel(body, 'gpt-4o-mini');
  assert.equal(body.model, 'gpt-4o-mini');
});

test('downgradeWarmupModel: no change without flag', () => {
  const body = { model: 'gpt-4o' };
  downgradeWarmupModel(body);
  assert.equal(body.model, 'gpt-4o');
});

test('injectDeterministicIds: sets request-id and interaction-id', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  const headers = new Headers();
  headers.set('x-claude-code-session-id', 'sess-123');
  injectDeterministicIds(body, headers);
  assert.ok(headers.get('x-request-id'));
  assert.ok(headers.get('x-interaction-id'));
  assert.ok(headers.get('x-request-id') !== headers.get('x-interaction-id'));
});

test('injectDeterministicIds: deterministic for same input', () => {
  const body = { messages: [{ role: 'user', content: 'hello' }] };
  const h1 = new Headers();
  const h2 = new Headers();
  h1.set('x-claude-code-session-id', 'sess-123');
  h2.set('x-claude-code-session-id', 'sess-123');
  injectDeterministicIds(body, h1);
  injectDeterministicIds(body, h2);
  assert.equal(h1.get('x-request-id'), h2.get('x-request-id'));
  assert.equal(h1.get('x-interaction-id'), h2.get('x-interaction-id'));
});

test('optimizeCopilotBody: full pipeline', () => {
  const body = {
    model: 'gpt-4o',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: 'explain' },
        ],
      },
    ],
  };
  optimizeCopilotBody(body);
  assert.equal(body.messages[0].content.length, 1);
  assert.equal(body.messages[1].content.length, 1);
});
