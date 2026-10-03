import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  observeProviderJsonUsage, PROVIDER_JSON_USAGE_MAX_BODY_BYTES,
  type ProviderJsonUsageEvidence,
} from '../../../src/saas/gateway/provider-json-usage-observer.js';
import { observeProviderSseUsage } from '../../../src/saas/gateway/provider-sse-usage-observer.js';

const encoder = new TextEncoder();
const openai = { providerProtocol: 'openai', providerOperation: 'chat.completions' } as const;
const anthropic = { providerProtocol: 'anthropic', providerOperation: 'messages' } as const;
const responses = { providerProtocol: 'responses', providerOperation: 'responses' } as const;
const openAiUsage = {
  prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 },
};
const anthropicUsage = {
  input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 3,
  cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 2 },
};
const responseUsage = {
  input_tokens: 10, output_tokens: 4, total_tokens: 14,
  input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
};

function envelope(usage: unknown = openAiUsage) {
  return {
    id: 'local-completion', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage,
  };
}

function source(chunks: readonly Uint8Array[], cancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancel?.(); },
  }, { highWaterMark: 0 });
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
}

async function observe(value: unknown, evidence: ProviderJsonUsageEvidence = openai) {
  const bytes = encoder.encode(JSON.stringify(value));
  const observed = observeProviderJsonUsage(source([bytes]), evidence);
  assert.deepEqual(await drain(observed.body), [bytes], 'JSON observation must preserve the exact provider bytes');
  return observed.observation;
}

test('OpenAI JSON passes through every chunk and publishes normalized usage only after observed EOF', async () => {
  const bytes = encoder.encode(JSON.stringify(envelope()));
  // One-byte chunks split UTF-8 multibyte text as well as JSON tokens.
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  const observed = observeProviderJsonUsage(source(chunks), openai);
  assert.equal(observed.getObservation(), null);
  const reader = observed.body.getReader();
  for (const chunk of chunks) {
    const next = await reader.read();
    assert.equal(next.done, false);
    assert.deepEqual(next.value, chunk);
    assert.equal(observed.getObservation(), null, 'even a complete JSON prefix cannot publish before EOF');
  }
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
  const result = await observed.observation;
  assert.deepEqual(result, {
    state: 'reported', usage: {
      inputTotal: 10, inputUncached: 8, cacheRead: 2, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null,
      outputTotal: 4, reasoningOutput: 1, status: 'reported', source: 'upstream', semanticsVersion: 'v1',
    },
  });
  assert.strictEqual(observed.getObservation(), result);
  if (result.state === 'reported') assert.equal(Object.isFrozen(result.usage), true);
});

test('Anthropic message JSON retains exclusive-input/cache semantics and cache-duration buckets', async () => {
  const result = await observe({
    id: 'local-message', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: anthropicUsage,
  }, anthropic);
  assert.deepEqual(result, {
    state: 'reported', usage: {
      inputTotal: 10, inputUncached: 5, cacheRead: 2, cacheWrite: 3, cacheWrite5m: 1, cacheWrite1h: 2,
      outputTotal: 4, reasoningOutput: null, status: 'reported', source: 'upstream', semanticsVersion: 'v1',
    },
  });
});

test('completed Responses JSON uses the actual responses operation and input/output detail names', async () => {
  const result = await observe({
    id: 'local-response', object: 'response', status: 'completed', output: [], error: null, incomplete_details: null,
    usage: responseUsage,
  }, responses);
  assert.deepEqual(result, {
    state: 'reported', usage: {
      inputTotal: 10, inputUncached: 8, cacheRead: 2, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null,
      outputTotal: 4, reasoningOutput: 1, status: 'reported', source: 'upstream', semanticsVersion: 'v1',
    },
  });
});

test('JSON and existing SSE observation agree on OpenAI and Anthropic normalized semantics', async () => {
  for (const [evidence, json, wire] of [
    [openai, envelope(), `data: ${JSON.stringify({ choices: [], usage: openAiUsage })}\n\ndata: [DONE]\n\n`],
    [anthropic, { type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage: anthropicUsage },
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: anthropicUsage } })}\n\n` +
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 4 } })}\n\n` +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'],
  ] as const) {
    const sse = observeProviderSseUsage(source([encoder.encode(wire)]), evidence);
    await drain(sse.body);
    assert.deepEqual(await observe(json, evidence), await sse.observation);
  }
});

test('missing, partial, negative, fractional, unsafe, inconsistent or unknown counters remain unreported', async (t) => {
  const cases = [
    ['missing', undefined], ['null', null], ['partial', { prompt_tokens: 10 }],
    ['negative', { ...openAiUsage, completion_tokens: -1 }],
    ['fractional', { ...openAiUsage, prompt_tokens: 1.5 }],
    ['string', { ...openAiUsage, prompt_tokens: '10' }],
    ['unsafe', { ...openAiUsage, prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['sum overflow', { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }],
    ['inconsistent total', { ...openAiUsage, total_tokens: 15 }],
    ['cache exceeds input', { ...openAiUsage, prompt_tokens_details: { cached_tokens: 11 } }],
    ['cache aliases conflict', { ...openAiUsage, cached_tokens: 3 }],
    ['reasoning exceeds output', { ...openAiUsage, completion_tokens_details: { reasoning_tokens: 5 } }],
    ['negative detail', { ...openAiUsage, prompt_tokens_details: { cached_tokens: -1 } }],
    ['null detail', { ...openAiUsage, prompt_tokens_details: null }],
    ['unrecognized dimension', { ...openAiUsage, future_billable_tokens: 5 }],
    ['prototype key', { ...openAiUsage, toString: 1 }],
  ] as const;
  for (const [name, usage] of cases) {
    await t.test(name, async () => {
      const value = envelope(usage);
      if (name === 'missing') delete (value as { usage?: unknown }).usage;
      const result = await observe(value);
      assert.deepEqual(result, { state: 'unknown', usage: null, reason: ['missing', 'null'].includes(name) ? 'no_usage' : 'invalid_usage' });
    });
  }
  for (const usage of [
    { ...anthropicUsage, input_tokens: Number.MAX_SAFE_INTEGER },
    { ...anthropicUsage, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } },
    { input_tokens: 5, output_tokens: 4 },
  ]) {
    assert.deepEqual(await observe({ type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn', usage }, anthropic),
      { state: 'unknown', usage: null, reason: 'invalid_usage' });
  }
  assert.deepEqual(await observe({ object: 'response', status: 'completed', output: [], usage: { ...responseUsage, total_tokens: 1 } }, responses),
    { state: 'unknown', usage: null, reason: 'invalid_usage' });
});

test('malformed, truncated, damaged UTF-8, duplicate-key and excessive-depth JSON never reports usage', async () => {
  const valid = JSON.stringify(envelope());
  const chunks = [
    encoder.encode(valid.slice(0, -1)), encoder.encode(`${valid} trailing garbage`),
    encoder.encode(valid.replace('"usage":', '"usage":{},"usage":')),
    encoder.encode(valid.replace('"usage":', '"usage":{},"us\\u0061ge":')),
    encoder.encode('['.repeat(65) + valid + ']'.repeat(65)),
    new Uint8Array([...encoder.encode('{"content":"'), 0xff, ...encoder.encode(`","rest":${valid}}`)]),
  ];
  for (const bytes of chunks) {
    const observed = observeProviderJsonUsage(source([bytes]), openai);
    assert.deepEqual(await drain(observed.body), [bytes]);
    assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'malformed_body' });
  }
  for (const value of [[], { ...envelope(), error: { message: 'provider failed' } }, { ...envelope(), choices: [] }]) {
    assert.deepEqual(await observe(value), { state: 'unknown', usage: null, reason: 'malformed_body' });
  }
  assert.deepEqual(await observe({ object: 'response', status: 'incomplete', output: [], usage: responseUsage }, responses),
    { state: 'unknown', usage: null, reason: 'malformed_body' });
});

test('the exact byte cap reports valid usage, while oversized bodies pass through completely and remain unknown', async () => {
  const template = JSON.stringify({ ...envelope(), padding: '' });
  const bytes = encoder.encode(JSON.stringify({ ...envelope(), padding: 'x'.repeat(PROVIDER_JSON_USAGE_MAX_BODY_BYTES - encoder.encode(template).byteLength) }));
  assert.equal(bytes.byteLength, PROVIDER_JSON_USAGE_MAX_BODY_BYTES);
  const atCap = observeProviderJsonUsage(source([bytes]), openai);
  assert.deepEqual(await drain(atCap.body), [bytes]);
  assert.equal((await atCap.observation).state, 'reported');
  const tail = encoder.encode(' ');
  const tooLarge = observeProviderJsonUsage(source([bytes, tail, tail]), openai);
  assert.deepEqual(await drain(tooLarge.body), [bytes, tail, tail]);
  assert.deepEqual(await tooLarge.observation, { state: 'unknown', usage: null, reason: 'oversized_body' });
});

test('server-owned protocol/operation selects the observer; unsupported pairs pass through without usage', async () => {
  for (const evidence of [{}, { providerProtocol: 'openai', providerOperation: 'responses' },
    { providerProtocol: 'responses', providerOperation: 'responses.compact' },
    { providerProtocol: 'gemini', providerOperation: 'generateContent' }]) {
    assert.deepEqual(await observe(envelope(), evidence), { state: 'unknown', usage: null, reason: 'unsupported_protocol_operation' });
  }
});

test('cancellation after a valid JSON chunk but before EOF cannot report usage', async () => {
  let cancelled = false;
  const observed = observeProviderJsonUsage(source([encoder.encode(JSON.stringify(envelope()))], () => { cancelled = true; }), openai);
  const reader = observed.body.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal(observed.getObservation(), null);
  await reader.cancel('client closed');
  assert.equal(cancelled, true);
  assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'cancelled' });
  reader.releaseLock();
});

test('a cancellation racing a pending EOF read settles unknown and propagates to the source', async () => {
  let pulls = 0;
  let pending!: () => void;
  const reading = new Promise<void>((resolve) => { pending = resolve; });
  let cancelled = false;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ === 0) { controller.enqueue(encoder.encode(JSON.stringify(envelope()))); return; }
      pending();
      return new Promise<void>(() => {});
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const observed = observeProviderJsonUsage(upstream, openai);
  const reader = observed.body.getReader();
  await reader.read();
  const eof = reader.read();
  await reading;
  await reader.cancel();
  assert.equal((await eof).done, true);
  assert.equal(cancelled, true);
  assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'cancelled' });
  reader.releaseLock();
});

test('upstream failure after a complete JSON prefix preserves the stream failure and never reports usage', async () => {
  const failure = new Error('local upstream failed');
  let sent = false;
  const observed = observeProviderJsonUsage(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(encoder.encode(JSON.stringify(envelope()))); }
      else controller.error(failure);
    },
  }, { highWaterMark: 0 }), openai);
  await assert.rejects(drain(observed.body), (error: unknown) => error === failure);
  assert.deepEqual(await observed.observation, { state: 'unknown', usage: null, reason: 'stream_error' });
});
