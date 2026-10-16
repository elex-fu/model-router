import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGeminiUsageMetadata } from '../../../../src/saas/gateway/gemini/quota-usage.js';
import {
  aggregateGeminiToChatCompletion,
  GeminiToAnthropicMessagesStream,
  GeminiToChatCompletionsStream,
  geminiSseToAnthropicMessagesSse,
  geminiSseToChatCompletionsSse,
  geminiUsageFromMetadata,
  mapGeminiFinishReasonToAnthropic,
  mapGeminiFinishReasonToChatCompletions,
  projectGeminiChunk,
} from '../../../../src/saas/gateway/gemini/response-bridge.js';

function sseStream(events: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
}

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

function metadata(overrides: Record<string, unknown> = {}): unknown {
  return { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, ...overrides };
}

test('chunk projection: text parts concatenate, functionCall extracts, wrapped chunks unwrap', () => {
  const projected = projectGeminiChunk({
    candidates: [{ content: { parts: [{ text: '4' }, { text: '2' }] }, finishReason: 'STOP' }],
    usageMetadata: metadata(),
  });
  assert.ok(projected);
  assert.equal(projected.text, '42');
  assert.equal(projected.finishReason, 'STOP');
  assert.deepEqual(projected.usage, { inputTokens: 10, cacheReadTokens: null, outputTokens: 2 });

  const toolCall = projectGeminiChunk({
    candidates: [{ content: { parts: [{ functionCall: { name: 'bash', args: { command: 'ls' } } }] } }],
  });
  assert.ok(toolCall);
  assert.deepEqual(toolCall.functionCall, { name: 'bash', args: { command: 'ls' } });
  assert.equal(toolCall.text, null);

  // The Code Assist {response: {...}} envelope unwraps transparently.
  const wrapped = projectGeminiChunk({
    response: { candidates: [{ content: { parts: [{ text: 'wrapped' }] }, finishReason: 'STOP' }] },
  });
  assert.ok(wrapped);
  assert.equal(wrapped.text, 'wrapped');
  assert.equal(wrapped.finishReason, 'STOP');

  // Non-record and empty chunks carry no signal.
  for (const bad of ['nope', null, 42, [], {}]) {
    assert.equal(projectGeminiChunk(bad), null);
  }
});

test('usage mapping: input subtracts the cache read; output adds the thoughts', () => {
  const usage = geminiUsageFromMetadata(
    parseGeminiUsageMetadata({
      promptTokenCount: 120,
      cachedContentTokenCount: 30,
      candidatesTokenCount: 42,
      thoughtsTokenCount: 7,
    }),
  );
  assert.ok(usage);
  assert.deepEqual(usage, { inputTokens: 90, cacheReadTokens: 30, outputTokens: 49 });

  // No output-side observation at all keeps outputTokens null.
  const partial = geminiUsageFromMetadata(parseGeminiUsageMetadata({ promptTokenCount: 10 }));
  assert.ok(partial);
  assert.deepEqual(partial, { inputTokens: 10, cacheReadTokens: null, outputTokens: null });
  assert.equal(geminiUsageFromMetadata(null), null);
});

test('finish reason mappings for both client protocols', () => {
  assert.equal(mapGeminiFinishReasonToChatCompletions('STOP', false), 'stop');
  assert.equal(mapGeminiFinishReasonToChatCompletions('MAX_TOKENS', false), 'length');
  assert.equal(mapGeminiFinishReasonToChatCompletions('SAFETY', false), 'content_filter');
  assert.equal(mapGeminiFinishReasonToChatCompletions('RECITATION', false), 'content_filter');
  assert.equal(mapGeminiFinishReasonToChatCompletions('STOP', true), 'tool_calls');
  assert.equal(mapGeminiFinishReasonToChatCompletions(null, false), 'stop');

  assert.equal(mapGeminiFinishReasonToAnthropic('STOP', false), 'end_turn');
  assert.equal(mapGeminiFinishReasonToAnthropic('MAX_TOKENS', false), 'max_tokens');
  assert.equal(mapGeminiFinishReasonToAnthropic('SAFETY', false), 'refusal');
  assert.equal(mapGeminiFinishReasonToAnthropic('STOP', true), 'tool_use');
  assert.equal(mapGeminiFinishReasonToAnthropic(null, false), 'end_turn');
});

test('the chat.completions assembler emits the role chunk first and the finish+usage chunks last', () => {
  const assembler = new GeminiToChatCompletionsStream({ includeUsage: true, nowMs: () => 1_700_000_000_000 });
  const first = assembler.push({
    responseId: 'resp-1',
    model: 'gemini-2.5-pro',
    candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
  });
  assert.equal(first.length, 2);
  const roleChunk = first[0] as Record<string, any>;
  assert.equal(roleChunk.choices[0].delta.role, 'assistant');
  assert.equal(roleChunk.object, 'chat.completion.chunk');
  assert.equal(roleChunk.id, 'resp-1');
  assert.equal((first[1] as Record<string, any>).choices[0].delta.content, 'Hel');

  const terminal = assembler.push({
    candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
    usageMetadata: metadata(),
  });
  assert.equal((terminal[0] as Record<string, any>).choices[0].delta.content, 'lo');
  const finishChunks = assembler.finish();
  const finish = finishChunks.find(
    (chunk) => (chunk.choices as Array<Record<string, unknown>>)[0].finish_reason !== undefined,
  ) as Record<string, any>;
  assert.equal(finish.choices[0].finish_reason, 'stop');
  const usageChunk = finishChunks.find((chunk) => chunk.usage) as Record<string, any>;
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  // finish() is idempotent.
  assert.equal(assembler.finish().length, 0);

  // includeUsage: false suppresses the usage chunk (but the usage is still
  // observable for the caller's promise).
  const quiet = new GeminiToChatCompletionsStream({ includeUsage: false });
  quiet.push({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
  quiet.push({ candidates: [{ finishReason: 'STOP' }], usageMetadata: metadata() });
  const quietFinish = quiet.finish();
  assert.equal(
    quietFinish.some((chunk) => chunk.usage),
    false,
  );
  assert.deepEqual(quiet.observedUsage, { inputTokens: 10, cacheReadTokens: null, outputTokens: 2 });
});

test('the Messages assembler produces the full Anthropic event sequence', () => {
  const assembler = new GeminiToAnthropicMessagesStream();
  const events = [
    ...assembler.push({
      responseId: 'resp-2',
      model: 'gemini-2.5-pro',
      candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
    }),
    ...assembler.push({
      candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
      usageMetadata: metadata(),
    }),
    ...assembler.finish(),
  ];
  const names = events.map((event) => event.event);
  assert.deepEqual(names, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const start = events[0].data as Record<string, any>;
  assert.equal(start.type, 'message_start');
  assert.equal(start.message.role, 'assistant');
  const firstDelta = events[2].data as Record<string, any>;
  assert.deepEqual(firstDelta.delta, { type: 'text_delta', text: 'Hel' });
  const delta = events[5].data as Record<string, any>;
  assert.deepEqual(delta.delta, { stop_reason: 'end_turn', stop_sequence: null });
  assert.deepEqual(delta.usage, { input_tokens: 10, output_tokens: 2 });
  assert.equal((events[6].data as Record<string, unknown>).type, 'message_stop');

  // A tool call becomes a tool_use block with the JSON arguments delta.
  const toolAssembler = new GeminiToAnthropicMessagesStream();
  const toolEvents = [
    ...toolAssembler.push({
      candidates: [{ content: { parts: [{ functionCall: { name: 'bash', args: { command: 'ls' } } }] } }],
    }),
    ...toolAssembler.finish(),
  ];
  const toolStart = toolEvents.find((event) => event.event === 'content_block_start')?.data as Record<string, any>;
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.equal(toolStart.content_block.name, 'bash');
  const toolDelta = toolEvents.find((event) => event.event === 'content_block_delta')?.data as Record<string, any>;
  assert.deepEqual(toolDelta.delta, { type: 'input_json_delta', partial_json: '{"command":"ls"}' });
  const toolMessageDelta = toolEvents.find((event) => event.event === 'message_delta')?.data as Record<string, any>;
  assert.equal(toolMessageDelta.delta.stop_reason, 'tool_use');
});

test('Gemini SSE → chat.completions SSE: text, finish, usage chunk and [DONE]', async () => {
  const { clientStream, usage } = geminiSseToChatCompletionsSse(
    sseStream([
      `data: ${JSON.stringify({
        responseId: 'resp-9',
        model: 'gemini-2.5-pro',
        candidates: [{ content: { parts: [{ text: 'Hel' }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'lo' }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
        usageMetadata: metadata(),
      })}\n\n`,
    ]),
    { includeUsage: true, nowMs: () => 1_700_000_000_000 },
  );
  const text = await readAll(clientStream);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const chunks = parseSseText(text).map((entry) => entry.data as Record<string, any>);
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const contentChunks = chunks.filter((chunk) => chunk.choices?.[0]?.delta?.content);
  assert.equal(contentChunks.length, 3);
  const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === 'stop');
  assert.ok(finish);
  const usageChunk = chunks.find((chunk) => chunk.usage);
  assert.deepEqual(usageChunk?.usage, {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  assert.deepEqual(await usage, { inputTokens: 10, cacheReadTokens: null, outputTokens: 2 });
});

test('Gemini SSE → Anthropic Messages SSE: the wrapped event sequence with usage', async () => {
  const { clientStream, usage } = geminiSseToAnthropicMessagesSse(
    sseStream([
      `data: ${JSON.stringify({
        responseId: 'resp-10',
        model: 'gemini-2.5-pro',
        candidates: [{ content: { parts: [{ text: 'Answer' }] } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }],
        usageMetadata: metadata({ cachedContentTokenCount: 4 }),
      })}\n\n`,
    ]),
  );
  const text = await readAll(clientStream);
  const events = parseSseText(text);
  assert.equal(events[0].event, 'message_start');
  const delta = events.find((entry) => entry.event === 'message_delta')?.data as Record<string, any>;
  assert.equal(delta.delta.stop_reason, 'end_turn');
  // promptTokenCount includes the cache read: input_tokens is the difference.
  assert.deepEqual(delta.usage, { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 4 });
  assert.equal(events[events.length - 1].event, 'message_stop');
  assert.deepEqual(await usage, { inputTokens: 6, cacheReadTokens: 4, outputTokens: 2 });
});

test('aggregateGeminiToChatCompletion folds text, tool calls and usage into the envelope', () => {
  const envelope = aggregateGeminiToChatCompletion(
    [
      {
        responseId: 'resp-11',
        model: 'gemini-2.5-pro',
        candidates: [{ content: { parts: [{ text: '4' }, { text: '2' }] } }],
      },
      {
        candidates: [
          { content: { parts: [{ functionCall: { name: 'bash', args: { command: 'ls' } } }] }, finishReason: 'STOP' },
        ],
        usageMetadata: metadata(),
      },
    ],
    { nowMs: () => 1_700_000_000_000 },
  );
  assert.equal(envelope.object, 'chat.completion');
  // The chunk's own model fills the envelope when no fallback is provided.
  assert.equal(envelope.model, 'gemini-2.5-pro');
  const choice = (envelope.choices as Array<Record<string, any>>)[0];
  assert.equal(choice.message.content, '42');
  assert.deepEqual(choice.message.tool_calls, [
    { index: 0, id: 'gemini-call-0', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
  ]);
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.deepEqual(envelope.usage, {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
    prompt_tokens_details: { cached_tokens: 0 },
  });

  // An empty chunk sequence still produces a well-formed envelope.
  const empty = aggregateGeminiToChatCompletion([], { fallbackModel: 'fallback-model', nowMs: () => 0 });
  const emptyChoice = (empty.choices as Array<Record<string, any>>)[0];
  assert.equal(emptyChoice.message.content, '');
  assert.equal(emptyChoice.finish_reason, 'stop');
  assert.equal('usage' in empty, false);
});
