import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anthropicSseEventUsage,
  extractBedrockChunkData,
  formatAnthropicSseEvent,
  mergeBedrockObservedUsage,
  transformBedrockInvocationMetrics,
} from '../../../../src/saas/gateway/bedrock/response-bridge.js';
import { bedrockUsageToObservedUsage } from '../../../../src/saas/gateway/bedrock/transport.js';

/** One Bedrock EventStream chunk payload carrying the base64 event JSON. */
function chunkPayload(event: unknown): Uint8Array {
  return Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') }), 'utf8');
}

test('extractBedrockChunkData decodes the base64 Anthropic event', () => {
  const event = { type: 'message_start', message: { usage: { input_tokens: 12 } } };
  assert.deepEqual(extractBedrockChunkData(chunkPayload(event)), event);
  assert.equal(extractBedrockChunkData(Buffer.from('{"bytes":""}', 'utf8')), null);
  assert.equal(extractBedrockChunkData(Buffer.from('not json', 'utf8')), null);
  assert.equal(extractBedrockChunkData(Buffer.from('{"bytes":"!!!"}', 'utf8')), null);
  assert.equal(extractBedrockChunkData(Buffer.from('{"other":1}', 'utf8')), null);
});

test('transformBedrockInvocationMetrics converts camelCase metrics and removes the field', () => {
  const body = {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    'amazon-bedrock-invocationMetrics': {
      inputTokenCount: 150,
      outputTokenCount: 42,
      cacheReadInputTokenCount: 7,
      cacheWriteInputTokenCount: 3,
    },
  };
  const before = structuredClone(body);
  const bridged = transformBedrockInvocationMetrics(body);
  assert.deepEqual(body, before, 'copy-on-write: the input is untouched');
  assert.equal('amazon-bedrock-invocationMetrics' in bridged, false);
  assert.deepEqual(bridged.usage, {
    input_tokens: 150,
    output_tokens: 42,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 3,
  });
});

test('transformBedrockInvocationMetrics never overwrites an existing usage field', () => {
  const bridged = transformBedrockInvocationMetrics({
    type: 'message_delta',
    usage: { output_tokens: 9 },
    'amazon-bedrock-invocationMetrics': { inputTokenCount: 150, outputTokenCount: 42 },
  });
  assert.deepEqual(bridged.usage, { output_tokens: 9 });
});

test('transformBedrockInvocationMetrics is a no-op without the metrics field', () => {
  const body = { type: 'message_start', message: { usage: { input_tokens: 3 } } };
  assert.equal(transformBedrockInvocationMetrics(body), body);
});

test('formatAnthropicSseEvent emits the event line only for typed payloads', () => {
  assert.equal(
    formatAnthropicSseEvent({ type: 'message_stop' }),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  assert.equal(formatAnthropicSseEvent({ x: 1 }), 'data: {"x":1}\n\n');
});

test('anthropic SSE usage extraction merges message_start and message_delta patches', () => {
  const start = anthropicSseEventUsage({
    type: 'message_start',
    message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } },
  });
  assert.deepEqual(start, {
    inputTokens: 10,
    outputTokens: null,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
  });
  const delta = anthropicSseEventUsage({
    type: 'message_delta',
    usage: { output_tokens: 30 },
  });
  const merged = mergeBedrockObservedUsage(start, delta);
  assert.deepEqual(merged, {
    inputTokens: 10,
    outputTokens: 30,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
  });
  assert.equal(anthropicSseEventUsage({ type: 'content_block_delta' }), null);
});

test('bedrockUsageToObservedUsage maps onto the anthropic normalizer', () => {
  const observed = bedrockUsageToObservedUsage({
    inputTokens: 10,
    outputTokens: 30,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
  });
  assert.ok(observed !== null);
  assert.equal(observed.status, 'reported');
  assert.equal(observed.inputTotal, 16);
  assert.equal(observed.inputUncached, 10);
  assert.equal(observed.outputTotal, 30);
  assert.equal(observed.cacheRead, 4);
  assert.equal(observed.cacheWrite, 2);
  assert.equal(observed.source, 'upstream');
  assert.equal(
    bedrockUsageToObservedUsage({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    }),
    null,
  );
});
