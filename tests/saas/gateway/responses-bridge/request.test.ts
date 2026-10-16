import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  convertAnthropicMessagesToResponsesRequest,
  convertChatCompletionsToResponsesRequest,
} from '../../../../src/saas/gateway/responses-bridge/request.js';

/* ------------------------------------------------------------------ */
/* chat.completions → Responses                                        */
/* ------------------------------------------------------------------ */

test('chat.completions → responses: system promotion, tool messages, assistant tool calls', () => {
  const converted = convertChatCompletionsToResponsesRequest({
    model: 'grok-4.7',
    messages: [
      { role: 'system', content: 'You are careful.' },
      { role: 'developer', content: 'Prefer tests.' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result text' },
    ],
    max_tokens: 256,
    temperature: 0.2,
  }) as Record<string, unknown>;

  assert.equal(converted.model, 'grok-4.7');
  assert.equal(converted.instructions, 'You are careful.\n\nPrefer tests.');
  assert.equal(converted.max_output_tokens, 256);
  assert.equal(converted.temperature, 0.2);
  assert.equal('messages' in converted, false);

  const input = converted.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], { role: 'user', content: 'hi' });
  assert.deepEqual(input[1], { role: 'assistant', content: [{ type: 'output_text', text: 'let me check' }] });
  assert.deepEqual(input[2], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '{"q":"x"}',
  });
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_1', output: 'result text' });
});

test('chat.completions → responses: tool definitions and tool_choice convert to the responses shape', () => {
  const converted = convertChatCompletionsToResponsesRequest({
    model: 'grok-4.7',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        type: 'function',
        function: { name: 'lookup', description: 'd', parameters: { type: 'object' }, strict: true },
      },
    ],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    stream: true,
  }) as Record<string, unknown>;
  assert.deepEqual(converted.tools, [
    { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' }, strict: true },
  ]);
  assert.equal(converted.tool_choice, 'auto');
  assert.equal(converted.parallel_tool_calls, false);
  assert.equal(converted.stream, true);
});

test('chat.completions → responses: max_completion_tokens wins and absent fields stay absent', () => {
  const converted = convertChatCompletionsToResponsesRequest({
    model: 'grok-4.7',
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 512,
  }) as Record<string, unknown>;
  assert.equal(converted.max_output_tokens, 512);
  assert.equal('instructions' in converted, false);
  assert.equal('temperature' in converted, false);
  assert.equal('tools' in converted, false);
});

test('chat.completions → responses: a body without messages degrades to an empty input array', () => {
  const converted = convertChatCompletionsToResponsesRequest({ model: 'grok-4.7' }) as Record<string, unknown>;
  assert.deepEqual(converted.input, []);
  // Non-record bodies pass through untouched (the caller fails closed).
  assert.equal(convertChatCompletionsToResponsesRequest('nope'), 'nope');
});

/* ------------------------------------------------------------------ */
/* Anthropic Messages → Responses                                      */
/* ------------------------------------------------------------------ */

test('anthropic → responses: system, string content, and max_tokens mapping', () => {
  const converted = convertAnthropicMessagesToResponsesRequest({
    model: 'grok-4.7',
    system: 'Be concise',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    temperature: 0.3,
    top_p: 0.9,
    stream: true,
  }) as Record<string, unknown>;

  assert.equal(converted.model, 'grok-4.7');
  assert.equal(converted.instructions, 'Be concise');
  assert.equal(converted.max_output_tokens, 64);
  assert.equal(converted.temperature, 0.3);
  assert.equal(converted.top_p, 0.9);
  assert.equal(converted.stream, true);
  assert.deepEqual(converted.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
});

test('anthropic → responses: system content blocks join into instructions', () => {
  const converted = convertAnthropicMessagesToResponsesRequest({
    model: 'grok-4.7',
    system: [
      { type: 'text', text: 'First rule.' },
      { type: 'text', text: 'Second rule.' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }) as Record<string, unknown>;
  assert.equal(converted.instructions, 'First rule.\n\nSecond rule.');
});

test('anthropic → responses: tool_use and tool_result map to function_call / function_call_output', () => {
  const converted = convertAnthropicMessagesToResponsesRequest({
    model: 'grok-4.7',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'found' }] }],
      },
    ],
  }) as Record<string, unknown>;

  const input = converted.input as Array<Record<string, unknown>>;
  // Assistant text precedes its function_call item.
  assert.deepEqual(input[0], { role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] });
  assert.deepEqual(input[1], {
    type: 'function_call',
    call_id: 'toolu_1',
    name: 'lookup',
    arguments: '{"q":"x"}',
  });
  assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'toolu_1', output: 'found' });
});

test('anthropic → responses: thinking blocks are dropped, images become input_image parts', () => {
  const converted = convertAnthropicMessagesToResponsesRequest({
    model: 'grok-4.7',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'thinking', thinking: 'internal', signature: 'sig' },
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      },
    ],
  }) as Record<string, unknown>;
  assert.deepEqual(converted.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGk=' },
      ],
    },
  ]);
});

test('anthropic → responses: tools, tool_choice, and thinking mapping', () => {
  const converted = convertAnthropicMessagesToResponsesRequest({
    model: 'grok-4.7',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'lookup' },
    thinking: { type: 'enabled', budget_tokens: 2048 },
  }) as Record<string, unknown>;
  assert.deepEqual(converted.tools, [
    { type: 'function', name: 'lookup', description: 'd', parameters: { type: 'object' } },
  ]);
  assert.deepEqual(converted.tool_choice, { type: 'function', name: 'lookup' });
  assert.deepEqual(converted.reasoning, { effort: 'medium' });

  const auto = convertAnthropicMessagesToResponsesRequest({
    model: 'grok-4.7',
    messages: [{ role: 'user', content: 'hi' }],
    tool_choice: { type: 'any' },
  }) as Record<string, unknown>;
  assert.equal(auto.tool_choice, 'required');
});

test('anthropic → responses: non-record bodies pass through untouched', () => {
  assert.equal(convertAnthropicMessagesToResponsesRequest(42), 42);
});
