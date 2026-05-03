import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { OpenAIToAnthBridge } from '../../src/protocol/openai-to-anth.js';
import {
  finalizeStream,
  parseSseStream,
  type SseEvent,
} from '../../src/protocol/sse.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX = join(__dirname, '..', 'fixtures', 'openai-to-anth');
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

test('openai-to-anth: identity getters and url rewrite', () => {
  const b = new OpenAIToAnthBridge();
  assert.equal(b.clientProto, 'openai');
  assert.equal(b.upstreamProto, 'anthropic');
  assert.equal(b.rewriteUrlPath('/v1/chat/completions'), '/v1/messages');
  assert.equal(b.rewriteUrlPath('/v1/other'), '/v1/other');
});

test('openai-to-anth: wrapError produces openai envelope', () => {
  const b = new OpenAIToAnthBridge();
  const err = b.wrapError(500, 'boom');
  assert.equal(err.contentType, 'application/json');
  assert.deepEqual(err.body, {
    error: { message: 'boom', type: 'api_error', code: null },
  });
});

test('openai-to-anth: wrapError(429) emits rate_limit_exceeded', () => {
  const b = new OpenAIToAnthBridge();
  const err = b.wrapError(429, 'daily tokens exhausted');
  assert.deepEqual(err.body, {
    error: { message: 'daily tokens exhausted', type: 'rate_limit_exceeded', code: null },
  });
});

// ---------------------------------------------------------------------------
// Group 1: Request transform
// ---------------------------------------------------------------------------

test('request: plain text + system extracted to top-level + metadata', () => {
  const b = new OpenAIToAnthBridge();
  const req = loadFixture('req-plain-text.json');
  const out = b.transformRequest(req);

  assert.equal(out.model, 'gpt-4o-2024');
  assert.equal(out.max_tokens, 512);
  assert.equal(out.temperature, 0.5);
  assert.equal(out.top_p, 0.95);
  assert.deepEqual(out.stop_sequences, ['END']);
  assert.equal(out.stream, false);
  assert.deepEqual(out.metadata, { user_id: 'u_42' });

  // System pulled to top, no longer a message.
  assert.equal(out.system, 'you are helpful');
  assert.deepEqual(out.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there!' },
    { role: 'user', content: 'tell me a joke' },
  ]);
});

test('request: tool_calls + role:tool merge into anthropic blocks', () => {
  const b = new OpenAIToAnthBridge();
  const req = loadFixture('req-tool-calls.json');
  const out = b.transformRequest(req);

  // 1) user text
  assert.deepEqual(out.messages[0], {
    role: 'user',
    content: 'what is the weather?',
  });
  // 2) assistant: text + tool_use blocks
  assert.equal(out.messages[1].role, 'assistant');
  assert(Array.isArray(out.messages[1].content));
  assert.deepEqual(out.messages[1].content[0], {
    type: 'text',
    text: 'let me check',
  });
  assert.deepEqual(out.messages[1].content[1], {
    type: 'tool_use',
    id: 'call_abc',
    name: 'get_weather',
    input: { city: 'Tokyo' },
  });
  // 3) The tool message merges with the next user message as a tool_result block.
  assert.equal(out.messages[2].role, 'user');
  assert(Array.isArray(out.messages[2].content));
  assert.deepEqual(out.messages[2].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_abc',
    content: 'sunny, 72F',
  });
  assert.deepEqual(out.messages[2].content[1], {
    type: 'text',
    text: 'thanks, summarize?',
  });
  assert.equal(out.messages.length, 3);
});

test('request: image_url data URL → image base64 source block', () => {
  const b = new OpenAIToAnthBridge();
  const req = loadFixture('req-image.json');
  const out = b.transformRequest(req);

  assert.equal(out.messages.length, 1);
  const m = out.messages[0];
  assert.equal(m.role, 'user');
  assert(Array.isArray(m.content));
  assert.deepEqual(m.content[0], { type: 'text', text: 'describe this image' });
  assert.deepEqual(m.content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANS',
    },
  });
});

test('request: tools[].function → tools + tool_choice variants', () => {
  const b = new OpenAIToAnthBridge();
  const req = loadFixture('req-tools-required.json');
  const out = b.transformRequest(req);

  assert.deepEqual(out.tools, [
    {
      name: 'get_weather',
      description: 'Get current weather',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ]);
  assert.deepEqual(out.tool_choice, { type: 'any' });

  // tool_choice variants
  const auto = b.transformRequest({
    model: 'm',
    messages: [],
    tool_choice: 'auto',
  });
  assert.deepEqual(auto.tool_choice, { type: 'auto' });

  const none = b.transformRequest({
    model: 'm',
    messages: [],
    tool_choice: 'none',
  });
  assert.deepEqual(none.tool_choice, { type: 'none' });

  const namedTool = b.transformRequest({
    model: 'm',
    messages: [],
    tool_choice: { type: 'function', function: { name: 'foo' } },
  });
  assert.deepEqual(namedTool.tool_choice, { type: 'tool', name: 'foo' });
});

test('request: missing max_tokens defaults to 1024', () => {
  const b = new OpenAIToAnthBridge();
  const out = b.transformRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.max_tokens, 1024);
});

test('request: stop string → stop_sequences array', () => {
  const b = new OpenAIToAnthBridge();
  const out = b.transformRequest({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    stop: 'STOPHERE',
  });
  assert.deepEqual(out.stop_sequences, ['STOPHERE']);
});

// ---------------------------------------------------------------------------
// Group 2: Response transform (non-streaming)
// ---------------------------------------------------------------------------

test('response: text + end_turn → stop + usage rename', () => {
  const b = new OpenAIToAnthBridge();
  const out = b.transformResponse(loadFixture('resp-text.json'));
  assert.equal(out.id, 'msg_01');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.model, 'claude-sonnet-4-5');
  assert.equal(out.choices.length, 1);
  assert.equal(out.choices[0].index, 0);
  assert.equal(out.choices[0].message.role, 'assistant');
  assert.equal(out.choices[0].message.content, 'Hello there!');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.usage.prompt_tokens, 12);
  assert.equal(out.usage.completion_tokens, 4);
  assert.equal(out.usage.total_tokens, 16);
});

test('response: max_tokens → length', () => {
  const b = new OpenAIToAnthBridge();
  const out = b.transformResponse(loadFixture('resp-length.json'));
  assert.equal(out.choices[0].finish_reason, 'length');
  assert.equal(out.choices[0].message.content, 'this got truncated mid sen');
  assert.equal(out.usage.completion_tokens, 100);
});

test('response: tool_use → tool_calls + tool_use stop_reason → tool_calls', () => {
  const b = new OpenAIToAnthBridge();
  const out = b.transformResponse(loadFixture('resp-tool-use.json'));
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  const msg = out.choices[0].message;
  assert.equal(msg.content, null);
  assert.equal(msg.tool_calls.length, 1);
  assert.deepEqual(msg.tool_calls[0], {
    id: 'toolu_xyz',
    type: 'function',
    function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) },
  });
});

test('response: text + tool_use combined → content string + tool_calls array', () => {
  const b = new OpenAIToAnthBridge();
  const out = b.transformResponse({
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'claude',
    content: [
      { type: 'text', text: 'sure thing' },
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'foo',
        input: {},
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  const msg = out.choices[0].message;
  assert.equal(msg.content, 'sure thing');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, 'foo');
  assert.equal(msg.tool_calls[0].function.arguments, '{}');
});

// ---------------------------------------------------------------------------
// Group 3: Stream transform (Anthropic events → OpenAI chunks)
// ---------------------------------------------------------------------------

function makeAnthStream(events: SseEvent[]): ReadableStream<Uint8Array> {
  return streamOf(finalizeStream(events));
}

test('stream: pure text — chunk sequence + [DONE] + usage', async () => {
  const upstream = makeAnthStream([
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_abc',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      }),
    },
    {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' there' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '!' },
      }),
    },
    {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      }),
    },
    {
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' }),
    },
  ]);

  const b = new OpenAIToAnthBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  const events = await collectStream(clientStream);

  // Expect chunks: role, 3 text deltas, finish, [DONE].
  // The role chunk is emitted on message_start.
  // (content_block_start text emits no chunk; content_block_stop emits no chunk.)
  const datas = events.map((e) => e.data);
  // last must be [DONE]
  assert.equal(datas[datas.length - 1], '[DONE]');

  // Parse non-DONE chunks
  const chunks = datas
    .slice(0, -1)
    .map((d) => JSON.parse(d));

  // First chunk: role assistant
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks[0].id, 'msg_abc');
  assert.equal(chunks[0].model, 'claude-sonnet-4-5');
  assert.equal(chunks[0].object, 'chat.completion.chunk');

  // Three text content deltas
  assert.equal(chunks[1].choices[0].delta.content, 'Hello');
  assert.equal(chunks[2].choices[0].delta.content, ' there');
  assert.equal(chunks[3].choices[0].delta.content, '!');

  // Final chunk: empty delta, finish_reason=stop
  const finalChunk = chunks[chunks.length - 1];
  assert.equal(finalChunk.choices[0].finish_reason, 'stop');

  const u = await usage;
  assert.equal(u.inputTokens, 3);
  assert.equal(u.outputTokens, 4);
});

test('stream: tool_use — tool_calls accumulate args via input_json_delta', async () => {
  const upstream = makeAnthStream([
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_t',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 0 },
        },
      }),
    },
    {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_42',
          name: 'get_weather',
          input: {},
        },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
      }),
    },
    {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
    },
    {
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' }),
    },
  ]);

  const b = new OpenAIToAnthBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  const events = await collectStream(clientStream);
  const datas = events.map((e) => e.data);
  assert.equal(datas[datas.length - 1], '[DONE]');

  const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));

  // First: role
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');

  // Second: tool_calls initial frame with id+name+empty arguments
  const tcStart = chunks[1].choices[0].delta.tool_calls;
  assert(Array.isArray(tcStart));
  assert.equal(tcStart[0].index, 0);
  assert.equal(tcStart[0].id, 'toolu_42');
  assert.equal(tcStart[0].type, 'function');
  assert.equal(tcStart[0].function.name, 'get_weather');
  assert.equal(tcStart[0].function.arguments, '');

  // Third + fourth: arguments deltas
  const a1 = chunks[2].choices[0].delta.tool_calls[0];
  assert.equal(a1.index, 0);
  assert.equal(a1.function.arguments, '{"city":');
  const a2 = chunks[3].choices[0].delta.tool_calls[0];
  assert.equal(a2.function.arguments, '"Paris"}');

  // Final: finish_reason tool_calls
  const finalChunk = chunks[chunks.length - 1];
  assert.equal(finalChunk.choices[0].finish_reason, 'tool_calls');

  const u = await usage;
  assert.equal(u.inputTokens, 9);
  assert.equal(u.outputTokens, 5);
});

test('stream: truncated by max_tokens → finish_reason length', async () => {
  const upstream = makeAnthStream([
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_l',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      }),
    },
    {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'a long' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' string' },
      }),
    },
    {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { output_tokens: 50 },
      }),
    },
    {
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' }),
    },
  ]);

  const b = new OpenAIToAnthBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  const events = await collectStream(clientStream);
  const datas = events.map((e) => e.data);
  assert.equal(datas[datas.length - 1], '[DONE]');

  const chunks = datas.slice(0, -1).map((d) => JSON.parse(d));
  const finalChunk = chunks[chunks.length - 1];
  assert.equal(finalChunk.choices[0].finish_reason, 'length');

  const u = await usage;
  assert.equal(u.inputTokens, 2);
  assert.equal(u.outputTokens, 50);
});

test('stream: usage promise resolves even with no usage info', async () => {
  const upstream = makeAnthStream([
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_n',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      }),
    },
    {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      }),
    },
    {
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop', index: 0 }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
      }),
    },
    {
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' }),
    },
  ]);
  const b = new OpenAIToAnthBridge();
  const { clientStream, usage } = b.transformStream(upstream);
  await collectStream(clientStream);
  const u = await usage;
  assert.equal(u.inputTokens, undefined);
  assert.equal(u.outputTokens, undefined);
});
