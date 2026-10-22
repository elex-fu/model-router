import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAIToAnthBridge } from '../../src/protocol/openai-to-anth.js';

const cached = { input_tokens: 0, output_tokens: 11, cache_read_input_tokens: 25, cache_creation_input_tokens: 0 };

function message(usage: unknown) {
  return {
    id: 'msg-fixture',
    type: 'message',
    role: 'assistant',
    model: 'fixture',
    content: [],
    stop_reason: 'end_turn',
    usage,
  };
}

function event(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function stream(usage: Record<string, unknown> | undefined) {
  const wire =
    event('message_start', { message: message(usage === undefined ? undefined : { ...usage, output_tokens: 0 }) }) +
    event('message_delta', {
      delta: { stop_reason: 'end_turn' },
      ...(usage === undefined ? {} : { usage: { output_tokens: usage.output_tokens } }),
    }) +
    event('message_stop', {});
  const bridge = new OpenAIToAnthBridge();
  bridge.transformRequest({ messages: [], stream_options: { include_usage: true } });
  return bridge.transformStream(new Response(wire).body as ReadableStream<Uint8Array>);
}

async function streamedUsage(usage: Record<string, unknown>) {
  const converted = stream(usage);
  const [text, raw] = await Promise.all([new Response(converted.clientStream).text(), converted.usage]);
  const chunks = text
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)));
  assert.equal(text.endsWith('data: [DONE]\n\n'), true);
  return { client: chunks.find((chunk) => chunk.usage !== undefined)?.usage, raw };
}

test('Anthropic cached-only JSON and SSE input becomes inclusive OpenAI usage without changing raw bridge counters', async () => {
  const expected = {
    prompt_tokens: 25,
    completion_tokens: 11,
    total_tokens: 36,
    prompt_tokens_details: { cached_tokens: 25 },
  };
  assert.deepEqual(new OpenAIToAnthBridge().transformResponse(message(cached)).usage, expected);
  const streamed = await streamedUsage(cached);
  assert.deepEqual(streamed.client, expected);
  assert.deepEqual(streamed.raw, { inputTokens: 0, outputTokens: 11, cacheReadTokens: 25, cacheCreationTokens: 0 });
});

test('cache creation contributes once and its TTL decomposition is never added a second time', async () => {
  const raw = {
    input_tokens: 3,
    output_tokens: 11,
    cache_read_input_tokens: 25,
    cache_creation_input_tokens: 7,
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 2 },
  };
  const expected = {
    prompt_tokens: 35,
    completion_tokens: 11,
    total_tokens: 46,
    prompt_tokens_details: { cached_tokens: 25 },
  };
  assert.deepEqual(new OpenAIToAnthBridge().transformResponse(message(raw)).usage, expected);
  assert.deepEqual((await streamedUsage(raw)).client, expected);
});

test('malformed, overflowing and inconsistent native counters never become successful OpenAI usage', async (t) => {
  for (const [name, raw] of [
    ['negative read', { ...cached, cache_read_input_tokens: -1 }],
    ['fractional input', { ...cached, input_tokens: 0.5 }],
    ['string output', { ...cached, output_tokens: '11' }],
    ['null counter', { ...cached, cache_creation_input_tokens: null }],
    ['unsafe input', { ...cached, input_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['input sum overflow', { ...cached, input_tokens: Number.MAX_SAFE_INTEGER }],
    ['total overflow', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }],
    ['TTL exceeds creation', { ...cached, cache_creation: { ephemeral_5m_input_tokens: 1 } }],
    [
      'TTL sum overflow',
      {
        input_tokens: 0,
        output_tokens: 11,
        cache_creation_input_tokens: Number.MAX_SAFE_INTEGER,
        cache_creation: { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 1 },
      },
    ],
    [
      'TTL sum mismatch',
      {
        ...cached,
        cache_creation_input_tokens: 7,
        cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
      },
    ],
    ['malformed TTL', { ...cached, cache_creation: null }],
    ['negative TTL', { ...cached, cache_creation: { ephemeral_5m_input_tokens: -1 } }],
    ['unknown TTL', { ...cached, cache_creation: { future_tokens: 1 } }],
    ['TTL without aggregate', { input_tokens: 0, output_tokens: 11, cache_creation: { ephemeral_5m_input_tokens: 1 } }],
  ] as const) {
    await t.test(name, async () => {
      assert.throws(() => new OpenAIToAnthBridge().transformResponse(message(raw)), /Anthropic upstream/);
      const converted = stream(raw);
      const results = await Promise.allSettled([new Response(converted.clientStream).text(), converted.usage]);
      assert.equal(results[0]?.status, 'rejected');
      assert.equal(results[1]?.status, 'rejected');
    });
  }
});

test('absent native usage remains absent instead of becoming a guessed zero report', async () => {
  assert.equal(Object.hasOwn(new OpenAIToAnthBridge().transformResponse(message(undefined)), 'usage'), false);
  const converted = stream(undefined);
  const [text, raw] = await Promise.all([new Response(converted.clientStream).text(), converted.usage]);
  assert.doesNotMatch(text, /"usage":/);
  assert.equal(raw.inputTokens, undefined);
  assert.equal(raw.outputTokens, undefined);
});

test('a missing final output report cannot publish the message_start zero as complete client usage', async () => {
  const partial: Record<string, unknown> = { ...cached };
  delete partial.output_tokens;
  assert.throws(() => new OpenAIToAnthBridge().transformResponse(message(partial)), /Anthropic upstream/);
  const converted = stream(partial);
  const [text] = await Promise.all([new Response(converted.clientStream).text(), converted.usage]);
  assert.doesNotMatch(text, /"usage":/);
  assert.match(text, /data: \[DONE\]/);
});
