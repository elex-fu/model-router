import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  responsesEnvelopeToAnthropicMessage,
  responsesEnvelopeToChatCompletion,
} from '../../../../src/saas/gateway/responses-bridge/response.js';

const NOW = () => Date.parse('2099-01-01T00:00:00.000Z');

const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 3 },
};

const ENVELOPE = {
  id: 'resp_1',
  model: 'grok-4.7',
  status: 'completed',
  usage: USAGE,
  output: [
    {
      type: 'message',
      content: [
        { type: 'output_text', text: 'Hello ' },
        { type: 'output_text', text: 'world' },
      ],
    },
    { type: 'reasoning', summary: [] },
    { type: 'function_call', call_id: 'fc_1', name: 'lookup', arguments: '{"q":"x"}' },
  ],
};

test('responses envelope → chat.completion: text, tool_calls, usage and finish reason', () => {
  const completion = responsesEnvelopeToChatCompletion(ENVELOPE, { nowMs: NOW }) as Record<string, unknown>;
  assert.equal(completion.id, 'resp_1');
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.created, Math.floor(Date.parse('2099-01-01T00:00:00.000Z') / 1000));
  assert.equal(completion.model, 'grok-4.7');
  const choice = (completion.choices as Array<Record<string, unknown>>)[0];
  assert.deepEqual(choice.message, {
    role: 'assistant',
    content: 'Hello world',
    tool_calls: [{ index: 0, id: 'fc_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
  });
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(completion.usage, {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 40 },
  });
});

test('responses envelope → chat.completion: incomplete status maps to length and refusal text is kept', () => {
  const completion = responsesEnvelopeToChatCompletion({
    id: 'resp_2',
    model: 'grok-4.7',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] }],
  }) as Record<string, unknown>;
  const choice = (completion.choices as Array<Record<string, unknown>>)[0];
  assert.equal((choice.message as Record<string, unknown>).content, 'cannot help');
  assert.equal(choice.finish_reason, 'length');
  assert.equal('usage' in completion, false);
});

test('responses envelope → anthropic message: content blocks, tool_use input, cached-token usage', () => {
  const message = responsesEnvelopeToAnthropicMessage(ENVELOPE) as Record<string, unknown>;
  assert.equal(message.id, 'resp_1');
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.model, 'grok-4.7');
  assert.deepEqual(message.content, [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'fc_1', name: 'lookup', input: { q: 'x' } },
  ]);
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.stop_sequence, null);
  // Cached-token mapping: input_tokens excludes cached, cache_read carries it.
  assert.deepEqual(message.usage, {
    input_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
  });
});

test('responses envelope → anthropic message: max_output_tokens incompleteness and malformed arguments', () => {
  const message = responsesEnvelopeToAnthropicMessage({
    id: 'resp_3',
    model: 'grok-4.7',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'function_call', call_id: 'fc_2', name: 'lookup', arguments: 'not json' }],
  }) as Record<string, unknown>;
  assert.equal(message.stop_reason, 'max_tokens');
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'fc_2', name: 'lookup', input: {} }]);
});

test('responses envelope converters tolerate non-record and empty output', () => {
  const completion = responsesEnvelopeToChatCompletion(null, { nowMs: NOW, fallbackModel: 'fallback' });
  assert.equal((completion as Record<string, unknown>).model, 'fallback');
  const message = responsesEnvelopeToAnthropicMessage(undefined, { fallbackModel: 'fallback' });
  assert.deepEqual((message as Record<string, unknown>).content, []);
  assert.equal((message as Record<string, unknown>).stop_reason, 'end_turn');
});
