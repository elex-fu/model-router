import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BufferedResponseAccumulator,
  chatUsageFromResponsesUsage,
  parseResponsesUsage,
  ResponsesEventToChatStream,
  responsesToChatCompletions,
} from '../../../../src/saas/gateway/responses-bridge/reverse-chat.js';

const NOW = () => Date.parse('2099-01-01T00:00:00.000Z');

function pushAll(stream: ResponsesEventToChatStream, events: readonly any[]): any[] {
  const chunks: any[] = [];
  for (const event of events) chunks.push(...stream.push(event));
  return chunks;
}

function deltaOf(chunk: any): any {
  return chunk.choices[0]?.delta;
}

// ---------------------------------------------------------------------------
// usage parsing + mapping
// ---------------------------------------------------------------------------

test('usage: responses → chat mapping puts cached tokens in prompt_tokens_details', () => {
  const usage = chatUsageFromResponsesUsage(
    parseResponsesUsage({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      input_tokens_details: { cached_tokens: 80 },
    }),
  );
  assert.deepEqual(usage, {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 80 },
  });
});

test('usage: reasoning tokens map into completion_tokens_details', () => {
  const usage = chatUsageFromResponsesUsage(
    parseResponsesUsage({
      input_tokens: 10,
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 15 },
    }),
  );
  assert.deepEqual(usage?.completion_tokens_details, { reasoning_tokens: 15 });
  assert.equal(usage?.prompt_tokens_details, undefined);
});

test('usage: alias spellings are accepted (prompt_tokens, cache_write, completion details)', () => {
  const facts = parseResponsesUsage({
    prompt_tokens: 7,
    completion_tokens: 3,
    cache_write_input_tokens: 4,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  });
  assert.equal(facts?.inputTokens, 7);
  assert.equal(facts?.outputTokens, 3);
  assert.equal(facts?.totalTokens, 10);
  assert.equal(facts?.cacheCreationInputTokens, 4);
  assert.deepEqual(facts?.inputTokensDetails, { cached_tokens: 2 });
  assert.deepEqual(facts?.outputTokensDetails, { reasoning_tokens: 1 });

  // Nested cache-write presence overrides the top-level alias.
  const nested = parseResponsesUsage({
    input_tokens: 9,
    output_tokens: 1,
    cache_creation_input_tokens: 99,
    input_tokens_details: { cache_write_tokens: 5 },
  });
  assert.equal(nested?.cacheCreationInputTokens, 5);
  assert.equal(parseResponsesUsage(undefined), null);
  assert.equal(parseResponsesUsage('nope'), null);
});

test('usage: zero details stay clean', () => {
  const usage = chatUsageFromResponsesUsage(parseResponsesUsage({ input_tokens: 5, output_tokens: 6 }));
  assert.deepEqual(usage, { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 });
});

// ---------------------------------------------------------------------------
// non-streaming envelope: Responses → Chat Completions
// ---------------------------------------------------------------------------

test('envelope: basic text with usage', () => {
  const chat = responsesToChatCompletions(
    {
      id: 'resp_123',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello, world!' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    'gpt-4o',
    { nowMs: NOW },
  );
  assert.equal(chat.object, 'chat.completion');
  assert.equal(chat.model, 'gpt-4o');
  assert.equal(chat.choices[0].finish_reason, 'stop');
  assert.equal(chat.choices[0].message.content, 'Hello, world!');
  assert.deepEqual(chat.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('envelope: tool calls and reasoning', () => {
  const chat = responsesToChatCompletions(
    {
      id: 'resp_456',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I thought about it.' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'The answer is 42.' }] },
        { type: 'function_call', call_id: 'call_xyz', name: 'get_weather', arguments: '{"city":"NYC"}' },
        { type: 'web_search_call' },
      ],
    },
    'gpt-4o',
    { nowMs: NOW },
  );
  const message = chat.choices[0].message;
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, 'The answer is 42.');
  assert.equal(message.reasoning_content, 'I thought about it.');
  assert.equal(message.tool_calls[0].id, 'call_xyz');
  assert.equal(message.tool_calls[0].function.name, 'get_weather');
  assert.equal(message.tool_calls[0].function.arguments, '{"city":"NYC"}');
});

test('envelope: incomplete → finish_reason length / content_filter', () => {
  const length = responsesToChatCompletions(
    {
      id: 'resp_inc',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial...' }] }],
    },
    'gpt-4o',
    { nowMs: NOW },
  );
  assert.equal(length.choices[0].finish_reason, 'length');

  const filtered = responsesToChatCompletions(
    {
      id: 'resp_cf',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'nope' }] }],
    },
    'gpt-4o',
    { nowMs: NOW },
  );
  assert.equal(filtered.choices[0].finish_reason, 'content_filter');
});

// ---------------------------------------------------------------------------
// streaming: Responses events → Chat chunks
// ---------------------------------------------------------------------------

test('stream: text deltas become content chunks and completed emits finish', () => {
  const stream = new ResponsesEventToChatStream({ nowMs: NOW, includeUsage: true });
  const chunks = pushAll(stream, [
    { type: 'response.created', response: { id: 'resp_1', model: 'grok-4.7' } },
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ' world' },
    {
      type: 'response.completed',
      response: { id: 'resp_1', model: 'grok-4.7', status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } },
    },
  ]);
  assert.equal(chunks.length, 5);
  assert.deepEqual(deltaOf(chunks[0]), { role: 'assistant' });
  assert.equal(deltaOf(chunks[1]).content, 'Hello');
  assert.equal(deltaOf(chunks[2]).content, ' world');
  assert.equal(chunks[3].choices[0].finish_reason, 'stop');
  assert.equal(chunks[3].id, 'resp_1');
  assert.equal(chunks[3].model, 'grok-4.7');
  // finish chunk delta carries content:""
  assert.deepEqual(deltaOf(chunks[3]), { content: '' });
  // Non-final chunks carry finish_reason null.
  assert.equal(chunks[0].choices[0].finish_reason, null);
  // include_usage appends a terminal usage chunk with empty choices.
  assert.deepEqual(chunks[4].choices, []);
  assert.deepEqual(chunks[4].usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('stream: tool call registration and argument deltas map by output_index', () => {
  const stream = new ResponsesEventToChatStream({ nowMs: NOW });
  const chunks = pushAll(stream, [
    { type: 'response.created', response: { id: 'resp_1', model: 'm' } },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', call_id: 'fc_1', name: 'lookup' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"q"' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: ':"x"}' },
    {
      type: 'response.completed',
      response: { status: 'completed' },
    },
  ]);
  const announce = deltaOf(chunks[1]).tool_calls[0];
  assert.equal(announce.id, 'fc_1');
  assert.equal(announce.function.name, 'lookup');
  assert.deepEqual(
    chunks.slice(2, 4).map((c) => deltaOf(c).tool_calls[0].function.arguments),
    ['{"q"', ':"x"}'],
  );
  assert.equal(chunks[4].choices[0].finish_reason, 'tool_calls');
});

test('stream: custom_tool_call items register and their input deltas map to arguments', () => {
  const stream = new ResponsesEventToChatStream({ nowMs: NOW });
  const chunks = pushAll(stream, [
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch' },
    },
    { type: 'response.custom_tool_call_input.delta', output_index: 1, delta: '*** Begin Patch' },
  ]);
  assert.equal(deltaOf(chunks[0]).tool_calls[0].id, 'call_patch');
  assert.equal(deltaOf(chunks[0]).tool_calls[0].function.name, 'apply_patch');
  const argDelta = deltaOf(chunks[1]).tool_calls[0];
  assert.equal(argDelta.index, 0);
  assert.equal(argDelta.function.arguments, '*** Begin Patch');
});

test('stream: reasoning deltas (summary + raw text alias) become reasoning_content', () => {
  const summary = new ResponsesEventToChatStream({ nowMs: NOW });
  const summaryChunks = pushAll(summary, [{ type: 'response.reasoning_summary_text.delta', delta: 'thinking step' }]);
  assert.deepEqual(deltaOf(summaryChunks[0]), { reasoning_content: 'thinking step' });

  const raw = new ResponsesEventToChatStream({ nowMs: NOW });
  const rawChunks = pushAll(raw, [{ type: 'response.reasoning_text.delta', delta: 'raw step' }]);
  assert.deepEqual(deltaOf(rawChunks[0]), { reasoning_content: 'raw step' });
});

test('stream: *.done contributes only the delta remainder', () => {
  // No deltas at all → the done event delivers the full arguments.
  const noDeltas = new ResponsesEventToChatStream({ nowMs: NOW });
  const full = pushAll(noDeltas, [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'exec' },
    },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"cmd":"ls"}' },
  ]);
  assert.equal(deltaOf(full[1]).tool_calls[0].function.arguments, '{"cmd":"ls"}');

  // Deltas already delivered a prefix → done contributes only the remainder.
  const partial = new ResponsesEventToChatStream({ nowMs: NOW });
  const remainder = pushAll(partial, [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'exec' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd"' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"cmd":"ls"}' },
  ]);
  assert.equal(remainder.length, 3);
  assert.equal(deltaOf(remainder[2]).tool_calls[0].function.arguments, ':"ls"}');

  // Deltas already delivered everything → done contributes nothing.
  const complete = new ResponsesEventToChatStream({ nowMs: NOW });
  const none = pushAll(complete, [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'exec' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"cmd":"ls"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"cmd":"ls"}' },
  ]);
  assert.equal(none.length, 2);

  // custom_tool_call_input.done uses the input field.
  const custom = new ResponsesEventToChatStream({ nowMs: NOW });
  const customChunks = pushAll(custom, [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch' },
    },
    { type: 'response.custom_tool_call_input.delta', output_index: 0, delta: 'patch ' },
    { type: 'response.custom_tool_call_input.done', output_index: 0, input: 'patch body' },
  ]);
  assert.equal(deltaOf(customChunks[2]).tool_calls[0].function.arguments, 'body');
});

test('stream: response.done alias and top-level terminal usage', () => {
  const stream = new ResponsesEventToChatStream({ nowMs: NOW, includeUsage: true });
  const chunks = pushAll(stream, [
    { type: 'response.output_text.delta', delta: 'hi' },
    { type: 'response.done', usage: { input_tokens: 4, output_tokens: 1 }, response: { status: 'completed' } },
  ]);
  assert.equal(chunks[chunks.length - 2].choices[0].finish_reason, 'stop');
  const usageChunk = chunks[chunks.length - 1];
  assert.deepEqual(usageChunk.choices, []);
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
});

test('stream: incomplete terminal maps to finish_reason length', () => {
  const stream = new ResponsesEventToChatStream({ nowMs: NOW });
  const chunks = pushAll(stream, [
    { type: 'response.output_text.delta', delta: 'partial' },
    {
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    },
  ]);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'length');
});

test('stream: finalize after a cut stream is idempotent and stop-terminated', () => {
  const stream = new ResponsesEventToChatStream({ nowMs: NOW });
  const chunks = pushAll(stream, [{ type: 'response.output_text.delta', delta: 'partial' }]);
  assert.equal(chunks.length, 1);
  const finalize = stream.finalize();
  assert.equal(finalize.length, 1);
  assert.equal(finalize[0].choices[0].finish_reason, 'stop');
  assert.deepEqual(stream.finalize(), [], 'finalize after finalize must be a no-op');
  assert.deepEqual(stream.finalize(), []);

  // A tool call seen before the cut finalizes as tool_calls.
  const toolStream = new ResponsesEventToChatStream({ nowMs: NOW });
  pushAll(toolStream, [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'exec' },
    },
  ]);
  assert.equal(toolStream.finalize()[0].choices[0].finish_reason, 'tool_calls');

  // finalize after a real terminal event emits nothing.
  const done = new ResponsesEventToChatStream({ nowMs: NOW });
  pushAll(done, [{ type: 'response.completed', response: { status: 'completed' } }]);
  assert.deepEqual(done.finalize(), []);
});

// ---------------------------------------------------------------------------
// BufferedResponseAccumulator
// ---------------------------------------------------------------------------

test('accumulator: text, tool calls, reasoning, and done replacement', () => {
  const acc = new BufferedResponseAccumulator();
  for (const event of [
    { type: 'response.reasoning_summary_text.delta', delta: 'why' },
    { type: 'response.output_text.delta', delta: 'Hello ' },
    { type: 'response.output_text.delta', delta: 'world' },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: { type: 'function_call', call_id: 'c1', name: 'exec' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"a"' },
    { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"a":1}' },
  ]) {
    acc.processEvent(event);
  }
  assert.equal(acc.hasContent(), true);
  const output = acc.buildOutput();
  assert.deepEqual(
    output.map((item: any) => item.type),
    ['reasoning', 'message', 'function_call'],
  );
  assert.equal(output[1].content[0].text, 'Hello world');
  assert.equal(output[2].arguments, '{"a":1}', 'done replaces the accumulated deltas');
});

test('accumulator: supplements an empty terminal output and backfills arguments', () => {
  const acc = new BufferedResponseAccumulator();
  for (const event of [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'c1', name: 'exec' },
    },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"x":1}' },
    { type: 'response.output_text.delta', delta: 'text' },
  ]) {
    acc.processEvent(event);
  }
  const response: any = { output: [] };
  acc.supplementResponseOutput(response);
  assert.equal(response.output.length, 2);
  assert.deepEqual(
    response.output.map((item: any) => item.type),
    ['message', 'function_call'],
  );
  assert.equal(response.output[0].content[0].text, 'text');

  // Terminal output present but a function_call has empty arguments → backfill.
  const acc2 = new BufferedResponseAccumulator();
  acc2.processEvent({
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'function_call', call_id: 'c9', name: 'exec' },
  });
  acc2.processEvent({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"z":9}' });
  const response2: any = { output: [{ type: 'function_call', call_id: 'c9', name: 'exec', arguments: '' }] };
  acc2.supplementResponseOutput(response2);
  assert.equal(response2.output[0].arguments, '{"z":9}');
});
