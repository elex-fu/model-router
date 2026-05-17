import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassthroughOpenAiBridge } from '../../src/protocol/passthrough-openai.js';
import { finalizeStream, type SseEvent } from '../../src/protocol/sse.js';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

test('passthrough-openai: identity getters and request/response', () => {
  const b = new PassthroughOpenAiBridge();
  assert.equal(b.clientProto, 'openai');
  assert.equal(b.upstreamProto, 'openai');
  assert.equal(b.rewriteUrlPath('/v1/chat/completions'), '/v1/chat/completions');
  const body = { model: 'gpt-4o', messages: [] };
  assert.equal(b.transformRequest(body), body);
  assert.equal(b.transformResponse(body), body);
});

test('passthrough-openai: stream tee delivers identical bytes to client', async () => {
  const events: SseEvent[] = [
    {
      data: JSON.stringify({
        id: 'c1',
        choices: [{ index: 0, delta: { content: 'hi' } }],
      }),
    },
    {
      data: JSON.stringify({
        id: 'c1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
    },
    { data: '[DONE]' },
  ];
  const original = finalizeStream(events);

  const bridge = new PassthroughOpenAiBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(original));
  const got = await readAll(clientStream);
  assert.deepEqual(Array.from(got), Array.from(original));

  const u = await usage;
  assert.deepEqual(u, { inputTokens: 10, outputTokens: 20, cacheReadTokens: undefined });
});

test('passthrough-openai: usage from final chunk', async () => {
  const events: SseEvent[] = [
    {
      data: JSON.stringify({
        choices: [{ delta: { content: 'a' } }],
      }),
    },
    {
      data: JSON.stringify({
        choices: [{ delta: { content: 'b' } }],
      }),
    },
    {
      data: JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 7, completion_tokens: 13 },
      }),
    },
    { data: '[DONE]' },
  ];
  const bridge = new PassthroughOpenAiBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(finalizeStream(events)));
  await readAll(clientStream);
  const u = await usage;
  assert.deepEqual(u, { inputTokens: 7, outputTokens: 13, cacheReadTokens: undefined });
});

test('passthrough-openai: no usage chunk → both undefined', async () => {
  const events: SseEvent[] = [
    {
      data: JSON.stringify({
        choices: [{ delta: { content: 'x' } }],
      }),
    },
    {
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }),
    },
    { data: '[DONE]' },
  ];
  const bridge = new PassthroughOpenAiBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(finalizeStream(events)));
  await readAll(clientStream);
  const u = await usage;
  assert.equal(u.inputTokens, undefined);
  assert.equal(u.outputTokens, undefined);
});

test('passthrough-openai: wrapError produces openai envelope', () => {
  const b = new PassthroughOpenAiBridge();
  const err = b.wrapError(502, 'upstream gone');
  assert.equal(err.contentType, 'application/json');
  assert.deepEqual(err.body, {
    error: { message: 'upstream gone', type: 'server_error', code: null },
  });
});

test('passthrough-openai: stream parses cached_tokens from prompt_tokens_details', async () => {
  const events: SseEvent[] = [
    {
      data: JSON.stringify({
        id: 'c-cache',
        choices: [{ index: 0, delta: { content: 'hi' } }],
      }),
    },
    {
      data: JSON.stringify({
        id: 'c-cache',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    },
    { data: '[DONE]' },
  ];
  const bridge = new PassthroughOpenAiBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(finalizeStream(events)));
  await readAll(clientStream);
  const u = await usage;
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 50);
  assert.equal(u.cacheReadTokens, 80);
});

test('passthrough-openai: wrapError(429) emits rate_limit_exceeded type', () => {
  const b = new PassthroughOpenAiBridge();
  const err = b.wrapError(429, 'daily tokens exhausted');
  assert.deepEqual(err.body, {
    error: { message: 'daily tokens exhausted', type: 'rate_limit_exceeded', code: null },
  });
});
