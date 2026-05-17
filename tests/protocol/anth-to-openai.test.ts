import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AnthToOpenAIBridge } from '../../src/protocol/anth-to-openai.js';
import {
  finalizeStream,
  parseSseStream,
  type SseEvent,
} from '../../src/protocol/sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX = join(__dirname, '..', 'fixtures', 'anth-to-openai');
const loadFixture = (name: string): any =>
  JSON.parse(readFileSync(join(FIX, name), 'utf8'));

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function collectStream(
  stream: ReadableStream<Uint8Array>
): Promise<SseEvent[]> {
  const bytes = await readAllBytes(stream);
  const reStream = streamOf(bytes);
  const events: SseEvent[] = [];
  for await (const ev of parseSseStream(reStream)) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// URL + identity
// ---------------------------------------------------------------------------

test('anth-to-openai: identity getters and url rewrite', () => {
  const b = new AnthToOpenAIBridge();
  assert.equal(b.clientProto, 'anthropic');
  assert.equal(b.upstreamProto, 'openai');
  assert.equal(b.rewriteUrlPath('/v1/messages'), '/v1/chat/completions');
  assert.equal(b.rewriteUrlPath('/v1/other'), '/v1/other');
});

test('anth-to-openai: wrapError produces anthropic envelope', () => {
  const b = new AnthToOpenAIBridge();
  const err = b.wrapError(500, 'boom');
  assert.equal(err.contentType, 'application/json');
  assert.deepEqual(err.body, {
    type: 'error',
    error: { type: 'api_error', message: 'boom' },
  });
});

test('anth-to-openai: wrapError(429) emits rate_limit_error', () => {
  const b = new AnthToOpenAIBridge();
  const err = b.wrapError(429, 'rpm exceeded');
  assert.deepEqual(err.body, {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'rpm exceeded' },
  });
});

// ---------------------------------------------------------------------------
// Group 1: Request transform
// ---------------------------------------------------------------------------

test('request: plain text user/assistant + system + metadata', () => {
  const b = new AnthToOpenAIBridge();
  const req = loadFixture('req-plain-text.json');
  const out = b.transformRequest(req);

  assert.equal(out.model, 'claude-sonnet-4-5');
  assert.equal(out.max_tokens, 1024);
  assert.equal(out.temperature, 0.7);
  assert.equal(out.top_p, 0.9);
  assert.deepEqual(out.stop, ['END']);
  assert.equal(out.stream, false);
  assert.equal(out.user, 'u_123');

  // First message is system from the system field.
  assert.deepEqual(out.messages[0], {
    role: 'system',
    content: 'you are helpful',
  });
  assert.deepEqual(out.messages[1], { role: 'user', content: 'hello' });
  assert.deepEqual(out.messages[2], { role: 'assistant', content: 'hi there!' });
  assert.deepEqual(out.messages[3], { role: 'user', content: 'tell me a joke' });
  assert.equal(out.messages.length, 4);
});

test('request: assistant tool_use + user tool_result split', () => {
  const b = new AnthToOpenAIBridge();
  const req = loadFixture('req-tool-use.json');
  const out = b.transformRequest(req);

  // 1) user text
  assert.deepEqual(out.messages[0], {
    role: 'user',
    content: 'what is the weather?',
  });
  // 2) assistant with text content + tool_calls
  assert.equal(out.messages[1].role, 'assistant');
  assert.equal(out.messages[1].content, 'let me check');
  assert.deepEqual(out.messages[1].tool_calls, [
    {
      id: 'toolu_abc',
      type: 'function',
      function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Tokyo' }) },
    },
  ]);
  // 3) The mixed user message becomes:
  //    - tool message (because text is AFTER tool_result in the original blocks,
  //      we flush nothing first, emit tool, then emit a follow-up user text msg).
  //    Wait: in our fixture tool_result comes FIRST. So order is:
  //    [tool_result, text]. Implementation flushes pending text/image (empty),
  //    pushes tool message, then collects 'thanks, summarize?' and flushes user.
  assert.equal(out.messages[2].role, 'tool');
  assert.equal(out.messages[2].tool_call_id, 'toolu_abc');
  assert.equal(out.messages[2].content, 'sunny, 72F');
  assert.deepEqual(out.messages[3], {
    role: 'user',
    content: 'thanks, summarize?',
  });
  assert.equal(out.messages.length, 4);
});

test('request: image base64 → image_url data URL with mixed text', () => {
  const b = new AnthToOpenAIBridge();
  const req = loadFixture('req-image.json');
  const out = b.transformRequest(req);

  assert.equal(out.messages.length, 1);
  const m = out.messages[0];
  assert.equal(m.role, 'user');
  assert(Array.isArray(m.content));
  assert.deepEqual(m.content[0], { type: 'text', text: 'describe this image' });
  assert.deepEqual(m.content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANS' },
  });
});

test('request: tools + tool_choice "any" → required, system as TextBlock array', () => {
  const b = new AnthToOpenAIBridge();
  const req = loadFixture('req-tools-any.json');
  const out = b.transformRequest(req);

  assert.deepEqual(out.tools, [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ]);
  assert.equal(out.tool_choice, 'required');

  // also test system as array of TextBlocks via inline body
  const out2 = b.transformRequest({
    model: 'm',
    system: [
      { type: 'text', text: 'first system line' },
      { type: 'text', text: 'second' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(out2.messages[0], {
    role: 'system',
    content: 'first system line\n\nsecond',
  });

  // tool_choice variants
  const auto = b.transformRequest({
    model: 'm',
    messages: [],
    tool_choice: { type: 'auto' },
  });
  assert.equal(auto.tool_choice, 'auto');

  const tool = b.transformRequest({
    model: 'm',
    messages: [],
    tool_choice: { type: 'tool', name: 'foo' },
  });
  assert.deepEqual(tool.tool_choice, {
    type: 'function',
    function: { name: 'foo' },
  });
});

// ---------------------------------------------------------------------------
// Group 2: Response transform (non-streaming)
// ---------------------------------------------------------------------------

test('response: plain text + stop → end_turn + usage rename', () => {
  const b = new AnthToOpenAIBridge();
  const out = b.transformResponse(loadFixture('resp-text.json'));
  assert.equal(out.id, 'chatcmpl-1');
  assert.equal(out.type, 'message');
  assert.equal(out.role, 'assistant');
  assert.equal(out.model, 'gpt-4o-2024');
  assert.deepEqual(out.content, [{ type: 'text', text: 'Hello there!' }]);
  assert.equal(out.stop_reason, 'end_turn');
  assert.equal(out.stop_sequence, null);
  assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 4 });
});

test('response: finish_reason length → max_tokens', () => {
  const b = new AnthToOpenAIBridge();
  const out = b.transformResponse(loadFixture('resp-length.json'));
  assert.equal(out.stop_reason, 'max_tokens');
  assert.deepEqual(out.content, [
    { type: 'text', text: 'this got truncated mid sen' },
  ]);
  assert.deepEqual(out.usage, { input_tokens: 5, output_tokens: 100 });
});

test('response: tool_calls → tool_use blocks + tool_use stop_reason', () => {
  const b = new AnthToOpenAIBridge();
  const out = b.transformResponse(loadFixture('resp-tool-calls.json'));
  assert.equal(out.stop_reason, 'tool_use');
  assert.equal(out.content.length, 1);
  assert.deepEqual(out.content[0], {
    type: 'tool_use',
    id: 'call_xyz',
    name: 'get_weather',
    input: { city: 'Paris' },
  });
  assert.deepEqual(out.usage, { input_tokens: 30, output_tokens: 8 });
});

test('response: malformed tool_call arguments JSON kept as _raw', () => {
  const b = new AnthToOpenAIBridge();
  const out = b.transformResponse({
    id: 'x',
    model: 'gpt',
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'f', arguments: '{not valid json' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  assert.equal(out.content[0].type, 'tool_use');
  assert.deepEqual(out.content[0].input, { _raw: '{not valid json' });
});

test('response: text + tool_calls together → text block first, then tool_use', () => {
  const b = new AnthToOpenAIBridge();
  const out = b.transformResponse({
    id: 'x',
    model: 'gpt',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'sure thing',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'foo', arguments: '{}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, 'sure thing');
  assert.equal(out.content[1].type, 'tool_use');
});

// ---------------------------------------------------------------------------
// Group 3: Stream transform
// ---------------------------------------------------------------------------

function makeOpenAiStream(chunks: any[]): ReadableStream<Uint8Array> {
  const evs: SseEvent[] = [];
  for (const c of chunks) evs.push({ data: JSON.stringify(c) });
  evs.push({ data: '[DONE]' });
  return streamOf(finalizeStream(evs));
}

test('stream: pure text — full anthropic event sequence + usage', async () => {
  const upstream = makeOpenAiStream([
    { id: 'c', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: 'Hello' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: ' there' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: '!' } }] },
    {
      id: 'c',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    },
  ]);

  const b = new AnthToOpenAIBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  const events = await collectStream(clientStream);

  const types = events.map((e) => e.event);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const start = JSON.parse(events[0].data);
  assert.equal(start.type, 'message_start');
  assert.equal(start.message.role, 'assistant');
  assert.equal(start.message.model, 'gpt-4o');

  const cbStart = JSON.parse(events[1].data);
  assert.equal(cbStart.type, 'content_block_start');
  assert.equal(cbStart.index, 0);
  assert.deepEqual(cbStart.content_block, { type: 'text', text: '' });

  const d1 = JSON.parse(events[2].data);
  assert.equal(d1.delta.text, 'Hello');
  const d2 = JSON.parse(events[3].data);
  assert.equal(d2.delta.text, ' there');
  const d3 = JSON.parse(events[4].data);
  assert.equal(d3.delta.text, '!');

  const cbStop = JSON.parse(events[5].data);
  assert.equal(cbStop.index, 0);

  const mDelta = JSON.parse(events[6].data);
  assert.equal(mDelta.delta.stop_reason, 'end_turn');
  assert.equal(mDelta.usage.output_tokens, 4);

  const u = await usage;
  assert.deepEqual(u, { inputTokens: 3, outputTokens: 4, cacheReadTokens: undefined });
});

test('stream: tool_calls — args accumulate across chunks', async () => {
  const upstream = makeOpenAiStream([
    { id: 'c', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    {
      id: 'c',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_42',
                type: 'function',
                function: { name: 'get_weather', arguments: '' },
              },
            ],
          },
        },
      ],
    },
    {
      id: 'c',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"city":' } },
            ],
          },
        },
      ],
    },
    {
      id: 'c',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"Paris"}' } },
            ],
          },
        },
      ],
    },
    {
      id: 'c',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 9, completion_tokens: 5 },
    },
  ]);

  const b = new AnthToOpenAIBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  const events = await collectStream(clientStream);

  const types = events.map((e) => e.event);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const cbStart = JSON.parse(events[1].data);
  assert.equal(cbStart.type, 'content_block_start');
  assert.equal(cbStart.index, 0);
  assert.deepEqual(cbStart.content_block, {
    type: 'tool_use',
    id: 'call_42',
    name: 'get_weather',
    input: {},
  });

  const d1 = JSON.parse(events[2].data);
  assert.equal(d1.delta.type, 'input_json_delta');
  assert.equal(d1.delta.partial_json, '{"city":');
  const d2 = JSON.parse(events[3].data);
  assert.equal(d2.delta.partial_json, '"Paris"}');

  const stop = JSON.parse(events[4].data);
  assert.equal(stop.index, 0);

  const mDelta = JSON.parse(events[5].data);
  assert.equal(mDelta.delta.stop_reason, 'tool_use');
  assert.equal(mDelta.usage.output_tokens, 5);

  const u = await usage;
  assert.deepEqual(u, { inputTokens: 9, outputTokens: 5, cacheReadTokens: undefined });
});

test('stream: text then tool_calls — text block stops before tool_use opens', async () => {
  const upstream = makeOpenAiStream([
    { id: 'c', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: 'sure ' } }] },
    {
      id: 'c',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'tool_a', arguments: '{}' },
              },
            ],
          },
        },
      ],
    },
    {
      id: 'c',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]);

  const b = new AnthToOpenAIBridge();
  const { clientStream } = b.transformStream(upstream);
  const events = await collectStream(clientStream);

  const types = events.map((e) => e.event);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start', // text
    'content_block_delta', // 'sure '
    'content_block_stop', // text closes
    'content_block_start', // tool_use
    'content_block_delta', // input_json_delta '{}'
    'content_block_stop', // tool_use closes
    'message_delta',
    'message_stop',
  ]);

  const textStart = JSON.parse(events[1].data);
  assert.deepEqual(textStart.content_block, { type: 'text', text: '' });
  assert.equal(textStart.index, 0);

  const textStop = JSON.parse(events[3].data);
  assert.equal(textStop.index, 0);

  const toolStart = JSON.parse(events[4].data);
  assert.equal(toolStart.content_block.type, 'tool_use');
  assert.equal(toolStart.content_block.id, 'call_1');
  assert.equal(toolStart.index, 1);

  const toolStop = JSON.parse(events[6].data);
  assert.equal(toolStop.index, 1);
});

test('stream: truncated by length → stop_reason max_tokens', async () => {
  const upstream = makeOpenAiStream([
    { id: 'c', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: 'a long' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: ' string' } }] },
    {
      id: 'c',
      choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      usage: { prompt_tokens: 2, completion_tokens: 50 },
    },
  ]);

  const b = new AnthToOpenAIBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  const events = await collectStream(clientStream);

  const mDelta = JSON.parse(events[events.length - 2].data);
  assert.equal(mDelta.type, 'message_delta');
  assert.equal(mDelta.delta.stop_reason, 'max_tokens');
  assert.equal(mDelta.usage.output_tokens, 50);

  const u = await usage;
  assert.deepEqual(u, { inputTokens: 2, outputTokens: 50, cacheReadTokens: undefined });
});

test('stream: usage promise resolves even with no usage chunk', async () => {
  const upstream = makeOpenAiStream([
    { id: 'c', model: 'gpt-4o', choices: [{ index: 0, delta: { role: 'assistant' } }] },
    { id: 'c', choices: [{ index: 0, delta: { content: 'hi' } }] },
    { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]);
  const b = new AnthToOpenAIBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  await collectStream(clientStream);
  const u = await usage;
  assert.equal(u.inputTokens, undefined);
  assert.equal(u.outputTokens, undefined);
});
