import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickBridge } from '../../src/protocol/bridge.js';
import { AnthToResponsesBridge, OpenAIToResponsesBridge } from '../../src/protocol/responses.js';

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

const CREATED = { type: 'response.created', response: { id: 'resp_1', model: 'grok-4.7' } };
const TEXT_DELTA_1 = { type: 'response.output_text.delta', delta: 'Hello' };
const TEXT_DELTA_2 = { type: 'response.output_text.delta', delta: ' world' };
const TOOL_ITEM = {
  type: 'response.output_item.added',
  item: { type: 'function_call', call_id: 'fc_1', name: 'lookup' },
};
const TOOL_ARGS_DELTA = { type: 'response.function_call_arguments.delta', delta: '{"q":"x"}' };
const TOOL_ARGS_DONE = { type: 'response.function_call_arguments.done' };
const COMPLETED = {
  type: 'response.completed',
  response: {
    id: 'resp_1',
    model: 'grok-4.7',
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

describe('openai → responses bridge (F3 real conversion)', () => {
  it('is selected by pickBridge and rewrites the chat.completions path', () => {
    const bridge = pickBridge('openai', 'responses');
    assert.ok(bridge instanceof OpenAIToResponsesBridge);
    assert.equal(bridge.rewriteUrlPath('/v1/chat/completions'), '/v1/responses');
    assert.equal(bridge.rewriteUrlPath('/v1/chat/completions?x=1'), '/v1/chat/completions?x=1');
  });

  it('converts the request body to the Responses shape', () => {
    const bridge = new OpenAIToResponsesBridge();
    const converted = bridge.transformRequest({
      model: 'grok-4.7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      max_tokens: 128,
      stream: true,
    }) as Record<string, unknown>;
    assert.equal(converted.instructions, 'sys');
    assert.equal(converted.max_output_tokens, 128);
    assert.equal(converted.stream, true);
    assert.deepEqual(converted.input, [{ role: 'user', content: 'hi' }]);
    assert.equal('messages' in converted, false);
  });

  it('converts a Responses envelope to a chat.completion envelope', () => {
    const bridge = new OpenAIToResponsesBridge();
    const completion = bridge.transformResponse({
      id: 'resp_1',
      model: 'grok-4.7',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi there' }] }],
      usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    }) as Record<string, unknown>;
    assert.equal(completion.object, 'chat.completion');
    const choice = (completion.choices as Array<Record<string, unknown>>)[0];
    assert.equal((choice.message as Record<string, unknown>).content, 'hi there');
    assert.equal(choice.finish_reason, 'stop');
    assert.deepEqual(completion.usage, {
      prompt_tokens: 5,
      completion_tokens: 2,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });

  it('leaves absent cached-token details unknown instead of fabricating zero', () => {
    const completion = new OpenAIToResponsesBridge().transformResponse({
      id: 'resp_unknown_cache', model: 'grok-4.7', status: 'completed', output: [],
      usage: { input_tokens: 5, output_tokens: 2 },
    }) as Record<string, unknown>;
    assert.deepEqual(completion.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    assert.equal('prompt_tokens_details' in (completion.usage as Record<string, unknown>), false);
  });

  it('converts Responses SSE to chat.completion.chunk SSE with usage and [DONE]', async () => {
    const bridge = new OpenAIToResponsesBridge();
    const { clientStream, usage } = bridge.transformStream(sseBytes(FULL_EVENTS), { includeUsage: true });
    const text = await readAll(clientStream);
    const frames = text
      .split('\n\n')
      .filter((frame) => frame.length > 0 && frame !== 'data: [DONE]')
      .map((frame) => JSON.parse(frame.replace(/^data: /, '')));
    assert.ok(frames.length >= 4);
    const first = frames[0] as Record<string, unknown>;
    assert.equal(first.object, 'chat.completion.chunk');
    const firstChoice = (first.choices as Array<Record<string, unknown>>)[0];
    assert.deepEqual(firstChoice.delta, { role: 'assistant', content: '' });
    const textDeltas = frames
      .map((frame) => (frame as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content)
      .filter((value) => typeof value === 'string' && value.length > 0);
    assert.deepEqual(textDeltas, ['Hello', ' world']);
    const toolChunk = frames.find((frame) => {
      const choices = (frame as { choices?: Array<{ delta?: { tool_calls?: unknown } }> }).choices;
      return Array.isArray(choices?.[0]?.delta?.tool_calls);
    }) as Record<string, unknown>;
    assert.ok(toolChunk);
    const toolChoices = toolChunk.choices as Array<{ delta: { tool_calls: Array<{ id?: string }> } }>;
    assert.equal(toolChoices[0].delta.tool_calls[0].id, 'fc_1');
    const lastChoiceFrame = frames
      .filter(
        (frame) =>
          Array.isArray((frame as { choices?: unknown[] }).choices) &&
          (frame as { choices: unknown[] }).choices.length > 0,
      )
      .pop() as Record<string, unknown>;
    assert.equal(
      ((lastChoiceFrame.choices as Array<Record<string, unknown>>)[0] as { finish_reason?: string }).finish_reason,
      'tool_calls',
    );
    const usageFrame = frames.find((frame) => 'usage' in (frame as Record<string, unknown>)) as Record<string, unknown>;
    assert.ok(usageFrame);
    assert.deepEqual(usageFrame.usage, {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    assert.ok(text.endsWith('data: [DONE]\n\n'));
    // BridgeUsage: total input (cached included) with the cached share split out.
    assert.deepEqual(await usage, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 });
  });

  it('omits the usage chunk unless the caller opted in', async () => {
    const bridge = new OpenAIToResponsesBridge();
    const { clientStream } = bridge.transformStream(sseBytes(FULL_EVENTS));
    const text = await readAll(clientStream);
    assert.equal(text.includes('"usage"'), false);
  });

  it('terminates a truncated stream with a stop chunk', async () => {
    const bridge = new OpenAIToResponsesBridge();
    const { clientStream } = bridge.transformStream(sseBytes([CREATED, TEXT_DELTA_1]));
    const text = await readAll(clientStream);
    assert.ok(text.includes('"finish_reason":"stop"'));
    assert.ok(text.endsWith('data: [DONE]\n\n'));
  });

  it('wraps errors in the chat.completions envelope', () => {
    const bridge = new OpenAIToResponsesBridge();
    const error = bridge.wrapError(429, 'slow down');
    assert.deepEqual(error.body, { error: { message: 'slow down', type: 'rate_limit_exceeded', code: null } });
    assert.equal(error.contentType, 'application/json');
  });
});

describe('anthropic → responses bridge (F3 real conversion)', () => {
  it('is selected by pickBridge and rewrites the messages path', () => {
    const bridge = pickBridge('anthropic', 'responses');
    assert.ok(bridge instanceof AnthToResponsesBridge);
    assert.equal(bridge.rewriteUrlPath('/v1/messages'), '/v1/responses');
  });

  it('converts the request body to the Responses shape with real tool mapping', () => {
    const bridge = new AnthToResponsesBridge();
    const converted = bridge.transformRequest({
      model: 'grok-4.7',
      system: 'Be concise',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' }] },
      ],
      max_tokens: 64,
    }) as Record<string, unknown>;
    assert.equal(converted.instructions, 'Be concise');
    assert.equal(converted.max_output_tokens, 64);
    const input = converted.input as Array<Record<string, unknown>>;
    assert.deepEqual(input[0], { role: 'user', content: [{ type: 'input_text', text: 'hello' }] });
    assert.deepEqual(input[1], {
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    });
    assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'toolu_1', output: 'found' });
  });

  it('converts a Responses envelope to an Anthropic message envelope', () => {
    const bridge = new AnthToResponsesBridge();
    const message = bridge.transformResponse({
      id: 'resp_1',
      model: 'grok-4.7',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'lookup', arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 90, input_tokens_details: { cached_tokens: 30 }, output_tokens: 7 },
    }) as Record<string, unknown>;
    assert.deepEqual(message.content, [
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'fc_1', name: 'lookup', input: { a: 1 } },
    ]);
    assert.equal(message.stop_reason, 'tool_use');
    assert.deepEqual(message.usage, {
      input_tokens: 60,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
      output_tokens: 7,
    });
  });

  it('converts Responses SSE to the Anthropic event sequence with cached-token usage', async () => {
    const bridge = new AnthToResponsesBridge();
    const { clientStream, usage } = bridge.transformStream(sseBytes(FULL_EVENTS));
    const text = await readAll(clientStream);
    const events = text
      .split('\n\n')
      .filter((frame) => frame.length > 0)
      .map((frame) => {
        const lines = frame.split('\n');
        return {
          event: lines[0].replace(/^event: /, ''),
          data: JSON.parse(lines[1].replace(/^data: /, '')),
        };
      });
    assert.equal(events[0].event, 'message_start');
    const startMessage = (events[0].data as { message: Record<string, unknown> }).message;
    // message_start usage follows the Anthropic convention (uncached input).
    assert.deepEqual(startMessage.usage, {
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    });
    const deltas = events.filter((entry) => entry.event === 'content_block_delta');
    assert.deepEqual(deltas.map((entry) => (entry.data as { delta: { text?: string } }).delta.text).filter(Boolean), [
      'Hello',
      ' world',
    ]);
    const toolStart = events.find(
      (entry) =>
        entry.event === 'content_block_start' &&
        (entry.data as { content_block: { type: string } }).content_block.type === 'tool_use',
    );
    assert.ok(toolStart);
    const toolBlock = (toolStart.data as { content_block: Record<string, unknown>; index: number }).content_block;
    assert.equal(toolBlock.id, 'fc_1');
    assert.equal(toolBlock.name, 'lookup');
    const messageDelta = events.find((entry) => entry.event === 'message_delta');
    assert.ok(messageDelta);
    assert.equal((messageDelta.data as { delta: { stop_reason: string } }).delta.stop_reason, 'tool_use');
    assert.equal((messageDelta.data as { usage: { output_tokens: number } }).usage.output_tokens, 10);
    const stop = events[events.length - 1];
    assert.equal(stop.event, 'message_stop');
    // BridgeUsage keeps the proxy convention: total input with cached split out.
    assert.deepEqual(await usage, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 });
  });

  it('terminates a truncated stream with end_turn', async () => {
    const bridge = new AnthToResponsesBridge();
    const { clientStream } = bridge.transformStream(sseBytes([CREATED, TEXT_DELTA_1]));
    const text = await readAll(clientStream);
    assert.ok(text.includes('message_stop'));
    assert.ok(text.includes('"stop_reason":"end_turn"'));
  });

  it('wraps errors in the Anthropic error envelope', () => {
    const bridge = new AnthToResponsesBridge();
    const error = bridge.wrapError(500, 'boom');
    assert.deepEqual(error.body, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    assert.equal(error.contentType, 'application/json');
  });
});
