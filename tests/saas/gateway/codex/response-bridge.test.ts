import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSseStream } from '../../../../src/protocol/sse.js';
import {
  aggregateResponsesToAnthropicMessage,
  aggregateResponsesToChatCompletion,
  anthropicUsageFields,
  chatCompletionsUsage,
  mapAnthropicStopReason,
  mapChatCompletionsFinishReason,
  parseResponsesUsage,
  ResponsesToAnthropicMessagesStream,
  ResponsesToChatCompletionsStream,
  responsesSseToAnthropicMessagesSse,
  responsesSseToChatCompletionsSse,
} from '../../../../src/saas/gateway/codex/response-bridge.js';

function sseBytes(events: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: response\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

const CREATED = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.3-codex' } };
const TEXT_DELTA_1 = { type: 'response.output_text.delta', delta: 'Hello' };
const TEXT_DELTA_2 = { type: 'response.output_text.delta', delta: ' world' };
const TOOL_ITEM = {
  type: 'response.output_item.added',
  item: { type: 'function_call', call_id: 'fc_1', name: 'python__mr' },
};
const TOOL_ARGS_DELTA = { type: 'response.function_call_arguments.delta', delta: '{"code":"1+1"}' };
const TOOL_ARGS_DONE = { type: 'response.function_call_arguments.done' };
const COMPLETED = {
  type: 'response.completed',
  response: {
    id: 'resp_1',
    model: 'gpt-5.3-codex',
    status: 'completed',
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 3 },
    },
  },
};

const FULL_EVENTS = [
  CREATED,
  TEXT_DELTA_1,
  TEXT_DELTA_2,
  { type: 'response.output_text.done' },
  TOOL_ITEM,
  TOOL_ARGS_DELTA,
  TOOL_ARGS_DONE,
  COMPLETED,
] as const;

test('parseResponsesUsage extracts the normalized usage facts', () => {
  assert.deepEqual(parseResponsesUsage(COMPLETED.response.usage), {
    inputTokens: 100,
    cachedTokens: 40,
    outputTokens: 10,
    reasoningTokens: 3,
  });
  assert.equal(parseResponsesUsage(null), null);
  assert.deepEqual(parseResponsesUsage({}), {
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    reasoningTokens: null,
  });
});

test('finish/stop reason mapping covers length, tool calls and defaults', () => {
  assert.equal(mapChatCompletionsFinishReason('completed', null, false), 'stop');
  assert.equal(mapChatCompletionsFinishReason('completed', null, true), 'tool_calls');
  assert.equal(mapChatCompletionsFinishReason('incomplete', 'max_output_tokens', false), 'length');
  assert.equal(mapAnthropicStopReason('completed', null, false), 'end_turn');
  assert.equal(mapAnthropicStopReason('completed', null, true), 'tool_use');
  assert.equal(mapAnthropicStopReason('incomplete', 'max_output_tokens', false), 'max_tokens');
});

test('chat.completions usage maps prompt/completion/cached tokens', () => {
  const usage = parseResponsesUsage(COMPLETED.response.usage);
  assert.ok(usage);
  assert.deepEqual(chatCompletionsUsage(usage), {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 40 },
  });
  // Anthropic mapping: input_tokens is uncached (100 - 40), cached becomes cache_read.
  assert.deepEqual(anthropicUsageFields(usage), {
    input_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
  });
});

test('chat.completions streaming: deltas, tool calls (alias restored), finish and usage chunk', () => {
  const assembler = new ResponsesToChatCompletionsStream({ includeUsage: true });
  const chunks: Record<string, unknown>[] = [];
  for (const event of FULL_EVENTS) chunks.push(...assembler.push(event));
  chunks.push(...assembler.finish());

  const first = chunks[0] as { choices: Array<{ delta: Record<string, unknown> }> };
  assert.deepEqual(first.choices[0]?.delta, { role: 'assistant', content: '' });
  const contentChunks = chunks.filter(
    (chunk) => (chunk.choices as Array<{ delta: { content?: string } }>)[0]?.delta?.content !== undefined,
  );
  assert.deepEqual(
    contentChunks.map((chunk) => (chunk.choices as Array<{ delta: { content?: string } }>)[0]?.delta?.content),
    ['', 'Hello', ' world'],
  );

  const toolStart = chunks.find((chunk) => {
    const delta = (chunk.choices as Array<{ delta: { tool_calls?: unknown[] } }>)[0]?.delta;
    return (
      Array.isArray(delta?.tool_calls) &&
      (delta.tool_calls[0] as { function: { arguments: string } })?.function?.arguments === ''
    );
  }) as { choices: Array<{ delta: { tool_calls: Array<{ index: number; id: string; function: { name: string } }> } }> };
  assert.ok(toolStart, 'a tool_call start chunk must be emitted');
  const toolCall = toolStart.choices[0]?.delta.tool_calls[0];
  assert.equal(toolCall.id, 'fc_1');
  assert.equal(toolCall.function.name, 'python', 'the python__mr alias must be restored');
  assert.equal(toolCall.index, 0);

  const finishChunk = chunks.find((chunk) => {
    const choice = (chunk.choices as Array<{ finish_reason?: string }>)[0];
    return choice?.finish_reason !== undefined && choice.finish_reason !== null;
  }) as { choices: Array<{ finish_reason: string }> };
  assert.equal(finishChunk.choices[0]?.finish_reason, 'tool_calls');

  const usageChunk = chunks[chunks.length - 1] as { usage: Record<string, unknown>; choices: unknown[] };
  assert.deepEqual(usageChunk.choices, []);
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 40 },
  });
});

test('chat.completions streaming: usage chunk is suppressed without include_usage', () => {
  const assembler = new ResponsesToChatCompletionsStream({ includeUsage: false });
  const chunks: Record<string, unknown>[] = [];
  for (const event of FULL_EVENTS) chunks.push(...assembler.push(event));
  chunks.push(...assembler.finish());
  const last = chunks[chunks.length - 1];
  assert.equal('usage' in last, false);
});

test('chat.completions streaming: a truncated stream still terminates with stop', () => {
  const assembler = new ResponsesToChatCompletionsStream({ includeUsage: false });
  const chunks: Record<string, unknown>[] = [];
  for (const event of [CREATED, TEXT_DELTA_1]) chunks.push(...assembler.push(event));
  const tail = assembler.finish();
  const finishChunk = tail[tail.length - 1] as { choices: Array<{ finish_reason: string }> };
  assert.equal(finishChunk.choices[0]?.finish_reason, 'stop');
  assert.equal(assembler.observedUsage, null);
});

test('responsesSseToChatCompletionsSse produces a well-formed chat.completions SSE body', async () => {
  const observed = responsesSseToChatCompletionsSse(sseBytes(FULL_EVENTS), { includeUsage: true });
  const text = await readAll(observed.clientStream);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const events = [];
  for await (const event of parseSseStream(new Blob([text]).stream() as ReadableStream<Uint8Array>)) {
    if (event.data && event.data !== '[DONE]') events.push(JSON.parse(event.data));
  }
  assert.ok(events.length >= 5);
  assert.deepEqual(await observed.usage, {
    inputTokens: 100,
    cachedTokens: 40,
    outputTokens: 10,
    reasoningTokens: 3,
  });
});

test('chat.completions non-streaming aggregation builds the full envelope', () => {
  const envelope = aggregateResponsesToChatCompletion(FULL_EVENTS, { fallbackModel: 'fallback' });
  assert.equal(envelope.id, 'resp_1');
  assert.equal(envelope.model, 'gpt-5.3-codex');
  assert.equal(envelope.object, 'chat.completion');
  const choice = (envelope.choices as Array<Record<string, unknown>>)[0] as {
    message: { role: string; content: string; tool_calls: Array<{ function: { name: string; arguments: string } }> };
    finish_reason: string;
  };
  assert.equal(choice.message.role, 'assistant');
  assert.equal(choice.message.content, 'Hello world');
  assert.equal(choice.message.tool_calls[0]?.function.name, 'python');
  assert.equal(choice.message.tool_calls[0]?.function.arguments, '{"code":"1+1"}');
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(envelope.usage, {
    prompt_tokens: 100,
    completion_tokens: 10,
    total_tokens: 110,
    prompt_tokens_details: { cached_tokens: 40 },
  });
});

test('anthropic streaming: message lifecycle with the codex usage mapping', async () => {
  const assembler = new ResponsesToAnthropicMessagesStream();
  const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const event of FULL_EVENTS) emitted.push(...assembler.push(event));
  emitted.push(...assembler.finish());
  const byType = (name: string) => emitted.filter((entry) => entry.event === name);

  assert.equal(byType('message_start').length, 1);
  const message = (byType('message_start')[0]?.data.message ?? {}) as {
    usage: Record<string, number>;
  };
  // Streaming-first contract: message_start is emitted at response.created,
  // before the codex stream exposes any usage (usage only arrives in the
  // terminal response.completed), so it starts zeroed. The codex usage mapping
  // (uncached input = 100 - 40, cached → cache_read) is asserted on
  // observedUsage below and on the non-streaming envelope.
  assert.deepEqual(message.usage, {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
  });
  assert.deepEqual(assembler.observedUsage, {
    inputTokens: 100,
    cachedTokens: 40,
    outputTokens: 10,
    reasoningTokens: 3,
  });

  const starts = byType('content_block_start').map(
    (entry) => (entry.data.content_block ?? {}) as { type: string; name?: string },
  );
  assert.deepEqual(
    starts.map((block) => block.type),
    ['text', 'tool_use'],
  );
  assert.equal(starts[1]?.name, 'python', 'the python__mr alias must be restored');

  const deltas = byType('content_block_delta').map((entry) => entry.data.delta as { type: string; text?: string });
  assert.deepEqual(
    deltas.filter((delta) => delta.type === 'text_delta').map((delta) => delta.text),
    ['Hello', ' world'],
  );

  const messageDelta = byType('message_delta')[0]?.data as {
    delta: { stop_reason: string };
    usage: { output_tokens: number };
  };
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  assert.equal(messageDelta.usage.output_tokens, 10);
  assert.equal(byType('message_stop').length, 1);
});

test('responsesSseToAnthropicMessagesSse produces named Anthropic SSE events', async () => {
  const { clientStream, usage } = responsesSseToAnthropicMessagesSse(sseBytes(FULL_EVENTS));
  const text = await readAll(clientStream);
  const events: Array<{ event?: string; data: string }> = [];
  for await (const event of parseSseStream(new Blob([text]).stream() as ReadableStream<Uint8Array>)) {
    events.push(event);
  }
  assert.equal(events[0]?.event, 'message_start');
  assert.equal(events[events.length - 1]?.event, 'message_stop');
  assert.deepEqual(await usage, { inputTokens: 100, cachedTokens: 40, outputTokens: 10, reasoningTokens: 3 });
});

test('anthropic non-streaming aggregation builds the message envelope', () => {
  const envelope = aggregateResponsesToAnthropicMessage(FULL_EVENTS, { fallbackModel: 'fallback' });
  assert.equal(envelope.id, 'resp_1');
  assert.equal(envelope.type, 'message');
  assert.equal(envelope.role, 'assistant');
  assert.equal(envelope.model, 'gpt-5.3-codex');
  assert.equal(envelope.stop_reason, 'tool_use');
  const content = envelope.content as Array<Record<string, unknown>>;
  assert.equal(content[0]?.type, 'text');
  assert.equal(content[0]?.text, 'Hello world');
  assert.equal(content[1]?.type, 'tool_use');
  assert.equal(content[1]?.name, 'python');
  assert.deepEqual(content[1]?.input, { code: '1+1' });
  assert.deepEqual(envelope.usage, {
    input_tokens: 60,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 0,
    output_tokens: 10,
  });
});

test('anthropic aggregation maps a max_output_tokens truncation to max_tokens', () => {
  const events = [
    CREATED,
    TEXT_DELTA_1,
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-5.3-codex',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    },
  ];
  const envelope = aggregateResponsesToAnthropicMessage(events);
  assert.equal(envelope.stop_reason, 'max_tokens');
  const chat = aggregateResponsesToChatCompletion(events);
  assert.equal((chat.choices as Array<{ finish_reason: string }>)[0]?.finish_reason, 'length');
});
