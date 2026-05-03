import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassthroughAnthropicBridge } from '../../src/protocol/passthrough-anthropic.js';
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

test('passthrough-anthropic: identity getters and request/response', () => {
  const b = new PassthroughAnthropicBridge();
  assert.equal(b.clientProto, 'anthropic');
  assert.equal(b.upstreamProto, 'anthropic');
  assert.equal(b.rewriteUrlPath('/v1/messages'), '/v1/messages');
  const body = { model: 'claude-sonnet-4', messages: [] };
  assert.equal(b.transformRequest(body), body);
  assert.equal(b.transformResponse(body), body);
});

test('passthrough-anthropic: stream tee delivers identical bytes to client', async () => {
  const events: SseEvent[] = [
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { id: 'm1', usage: { input_tokens: 11, output_tokens: 1 } },
      }),
    },
    {
      event: 'content_block_delta',
      data: JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }),
    },
    { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
  ];
  const original = finalizeStream(events);

  const bridge = new PassthroughAnthropicBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(original));
  const got = await readAll(clientStream);
  assert.deepEqual(Array.from(got), Array.from(original));

  const u = await usage;
  assert.deepEqual(u, { inputTokens: 11, outputTokens: 7 });
});

test('passthrough-anthropic: usage from message_start only (no message_delta)', async () => {
  const events: SseEvent[] = [
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { id: 'm2', usage: { input_tokens: 5, output_tokens: 2 } },
      }),
    },
    { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) },
  ];
  const bytes = finalizeStream(events);
  const bridge = new PassthroughAnthropicBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(bytes));
  // Drain client side to allow usage promise to complete.
  await readAll(clientStream);
  const u = await usage;
  assert.equal(u.inputTokens, 5);
  // With no message_delta, output_tokens falls back to message_start's value.
  assert.equal(u.outputTokens, 2);
});

test('passthrough-anthropic: last message_delta wins for output_tokens', async () => {
  const events: SseEvent[] = [
    {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { id: 'm3', usage: { input_tokens: 100, output_tokens: 1 } },
      }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 25 } }),
    },
    {
      event: 'message_delta',
      data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 42 } }),
    },
  ];
  const bytes = finalizeStream(events);
  const bridge = new PassthroughAnthropicBridge();
  const { clientStream, usage } = bridge.transformStream(streamOf(bytes));
  await readAll(clientStream);
  const u = await usage;
  assert.deepEqual(u, { inputTokens: 100, outputTokens: 42 });
});

test('passthrough-anthropic: wrapError produces anthropic envelope', () => {
  const b = new PassthroughAnthropicBridge();
  const err = b.wrapError(500, 'boom');
  assert.equal(err.contentType, 'application/json');
  assert.deepEqual(err.body, {
    type: 'error',
    error: { type: 'api_error', message: 'boom' },
  });
});

test('passthrough-anthropic: wrapError(429) emits rate_limit_error type', () => {
  const b = new PassthroughAnthropicBridge();
  const err = b.wrapError(429, 'rpm exceeded');
  assert.deepEqual(err.body, {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'rpm exceeded' },
  });
});
