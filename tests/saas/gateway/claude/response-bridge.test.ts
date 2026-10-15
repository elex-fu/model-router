import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aggregateMessagesToChatCompletion,
  chatCompletionsUsage,
  MessagesToChatCompletionsStream,
  MessagesToResponsesStream,
  mapClaudeStopReasonToChatCompletions,
  mapClaudeStopReasonToResponsesStatus,
  messagesSseToChatCompletionsSse,
  messagesSseToResponsesSse,
  parseMessagesUsage,
  responsesUsage,
} from '../../../../src/saas/gateway/claude/response-bridge.js';

function encoder(): TextEncoder {
  return new TextEncoder();
}

function sseStream(events: readonly string[]): ReadableStream<Uint8Array> {
  const textEncoder = encoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(textEncoder.encode(event));
      controller.close();
    },
  });
}

const START =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":120,"cache_read_input_tokens":30,"cache_creation_input_tokens":10,"output_tokens":1}}}\n\n';
const TEXT_START =
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
const TEXT_DELTA = (text: string) =>
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}\n\n`;
const TOOL_START =
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash"}}\n\n';
const TOOL_DELTA = (json: string) =>
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(json)}}}\n\n`;
const DELTA = (stopReason: string, outputTokens: number) =>
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":${JSON.stringify(stopReason)},"stop_sequence":null},"usage":{"output_tokens":${outputTokens}}}\n\n`;
const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

function parseSseText(text: string): Array<{ event?: string; data: unknown }> {
  const events: Array<{ event?: string; data: unknown }> = [];
  for (const block of text.split('\n\n')) {
    if (block.trim().length === 0) continue;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    events.push({ event: eventName, data: data === '[DONE]' ? '[DONE]' : JSON.parse(data) });
  }
  return events;
}

test('usage parsing and the two payload mappings', () => {
  const usage = parseMessagesUsage({
    input_tokens: 120,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
    output_tokens: 42,
  });
  assert.ok(usage);
  assert.deepEqual(chatCompletionsUsage(usage), {
    prompt_tokens: 160,
    completion_tokens: 42,
    total_tokens: 202,
    prompt_tokens_details: { cached_tokens: 30 },
  });
  assert.deepEqual(responsesUsage(usage), {
    input_tokens: 160,
    output_tokens: 42,
    input_tokens_details: { cached_tokens: 30 },
  });
  assert.equal(parseMessagesUsage('nope'), null);
  // Negative token counts are dropped to null fields, not guessed.
  assert.deepEqual(parseMessagesUsage({ input_tokens: -1 }), {
    inputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    outputTokens: null,
  });
  // Stop reason mappings.
  assert.equal(mapClaudeStopReasonToChatCompletions('max_tokens'), 'length');
  assert.equal(mapClaudeStopReasonToChatCompletions('tool_use'), 'tool_calls');
  assert.equal(mapClaudeStopReasonToChatCompletions('refusal'), 'content_filter');
  assert.equal(mapClaudeStopReasonToChatCompletions('end_turn'), 'stop');
  assert.equal(mapClaudeStopReasonToChatCompletions(null), 'stop');
  assert.equal(mapClaudeStopReasonToResponsesStatus('max_tokens'), 'incomplete');
  assert.equal(mapClaudeStopReasonToResponsesStatus('end_turn'), 'completed');
});

test('Messages SSE → chat.completions SSE: text stream with usage chunk and [DONE]', async () => {
  const { clientStream, usage } = messagesSseToChatCompletionsSse(
    sseStream([START, TEXT_START, TEXT_DELTA('Hello'), TEXT_DELTA(' world'), DELTA('end_turn', 42), STOP]),
    { includeUsage: true },
  );
  const text = await readAll(clientStream);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const chunks = parseSseText(text).map((entry) => entry.data as Record<string, unknown>);
  const first = chunks[0] as Record<string, any>;
  assert.equal(first.choices[0].delta.role, 'assistant');
  assert.equal(first.object, 'chat.completion.chunk');
  const contentChunks = chunks.filter((chunk) => (chunk.choices?.[0] as any)?.delta?.content);
  assert.equal(contentChunks.length, 2);
  const finish = chunks.find((chunk) => (chunk.choices?.[0] as any)?.finish_reason === 'stop');
  assert.ok(finish);
  const usageChunk = chunks.find((chunk) => chunk.usage) as Record<string, any>;
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 160,
    completion_tokens: 42,
    total_tokens: 202,
    prompt_tokens_details: { cached_tokens: 30 },
  });
  assert.deepEqual(await usage, { inputTokens: 120, cacheReadTokens: 30, cacheCreationTokens: 10, outputTokens: 42 });
});

test('Messages SSE → chat.completions SSE: tool_use becomes tool_calls deltas', async () => {
  const { clientStream, usage } = messagesSseToChatCompletionsSse(
    sseStream([START, TOOL_START, TOOL_DELTA('{"comm'), TOOL_DELTA('and":"ls"}'), DELTA('tool_use', 12), STOP]),
    { includeUsage: false },
  );
  const text = await readAll(clientStream);
  const chunks = parseSseText(text).map((entry) => entry.data as Record<string, unknown>);
  const toolStart = chunks.find(
    (chunk) => (chunk.choices?.[0] as any)?.delta?.tool_calls?.[0]?.function?.name === 'bash',
  ) as any;
  assert.ok(toolStart);
  assert.equal(toolStart.choices[0].delta.tool_calls[0].id, 'toolu_1');
  const argChunks = chunks.filter(
    (chunk) =>
      typeof (chunk.choices?.[0] as any)?.delta?.tool_calls?.[0]?.function?.arguments === 'string' &&
      (chunk.choices[0] as any).delta.tool_calls[0].function.arguments.length > 0,
  );
  assert.equal(argChunks.length, 2);
  const finish = chunks.find((chunk) => (chunk.choices?.[0] as any)?.finish_reason === 'tool_calls');
  assert.ok(finish);
  assert.equal(
    chunks.some((chunk) => chunk.usage),
    false,
  );
  assert.equal((await usage)?.outputTokens, 12);
});

test('a stream that ends without message_stop still terminates well-formed', async () => {
  const assembler = new MessagesToChatCompletionsStream({ includeUsage: false });
  assembler.push(JSON.parse('{"type":"message_start","message":{"id":"m","model":"x"}}'));
  const terminal = assembler.finish();
  assert.equal(terminal.length, 1);
  assert.equal((terminal[0].choices as any[])[0].finish_reason, 'stop');

  const { clientStream } = messagesSseToChatCompletionsSse(sseStream([START]), { includeUsage: false });
  const text = await readAll(clientStream);
  assert.ok(text.includes('data: [DONE]'));
});

test('aggregateMessagesToChatCompletion produces the non-streaming envelope', () => {
  const events = [
    JSON.parse(
      '{"type":"message_start","message":{"id":"msg_9","model":"claude-opus-4-6","usage":{"input_tokens":10,"output_tokens":1}}}',
    ),
    JSON.parse('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'),
    JSON.parse('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}'),
    JSON.parse('{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"read"}}'),
    JSON.parse(
      '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":1}"}}',
    ),
    JSON.parse('{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}'),
  ];
  const envelope = aggregateMessagesToChatCompletion(events);
  assert.equal(envelope.id, 'msg_9');
  assert.equal(envelope.object, 'chat.completion');
  const message = (envelope.choices as any[])[0].message;
  assert.equal(message.content, 'Hi');
  assert.deepEqual(message.tool_calls, [
    { index: 0, id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":1}' } },
  ]);
  assert.equal((envelope.choices as any[])[0].finish_reason, 'tool_calls');
  assert.deepEqual(envelope.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 0 },
  });
});

test('Messages SSE → Responses SSE: created, deltas, tool call, completed with usage', async () => {
  const { clientStream, usage } = messagesSseToResponsesSse(
    sseStream([START, TEXT_START, TEXT_DELTA('Answer'), TOOL_START, TOOL_DELTA('{}'), DELTA('max_tokens', 77), STOP]),
  );
  const text = await readAll(clientStream);
  const events = parseSseText(text);
  assert.equal(events[0].event, 'response.created');
  assert.equal((events[0].data as any).response.status, 'in_progress');
  const textDelta = events.find((entry) => entry.event === 'response.output_text.delta');
  assert.equal((textDelta?.data as Record<string, unknown> | undefined)?.delta, 'Answer');
  const itemAdded = events.find(
    (entry) =>
      entry.event === 'response.output_item.added' &&
      (entry.data as { item?: { type?: string } }).item?.type === 'function_call',
  );
  const itemAddedData = itemAdded?.data as { item: { type: string; name: string } } | undefined;
  assert.equal(itemAddedData?.item.type, 'function_call');
  assert.equal(itemAddedData?.item.name, 'bash');
  const argsDelta = events.find((entry) => entry.event === 'response.function_call_arguments.delta');
  assert.equal((argsDelta?.data as Record<string, unknown> | undefined)?.delta, '{}');
  const completed = events.find((entry) => entry.event === 'response.completed');
  assert.ok(completed);
  const completedData = completed?.data as { response: Record<string, unknown> };
  const completedResponse = completedData.response;
  assert.equal(completedResponse.status, 'incomplete');
  assert.deepEqual(completedResponse.incomplete_details, { reason: 'max_output_tokens' });
  assert.deepEqual(completedResponse.usage, {
    input_tokens: 160,
    output_tokens: 77,
    input_tokens_details: { cached_tokens: 30 },
  });
  assert.deepEqual(await usage, { inputTokens: 120, cacheReadTokens: 30, cacheCreationTokens: 10, outputTokens: 77 });
});

test('the Responses assembler terminates a truncated stream with a completed event', () => {
  const assembler = new MessagesToResponsesStream();
  assembler.push(
    JSON.parse(
      '{"type":"message_start","message":{"id":"m2","model":"y","usage":{"input_tokens":4,"output_tokens":2}}}',
    ),
  );
  const terminal = assembler.finish();
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].event, 'response.completed');
  assert.equal((terminal[0].data as any).response.status, 'completed');
});
