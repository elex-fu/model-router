import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  crc32Ieee,
  createEventstreamDecoder,
  decodeBedrockEventstreamStream,
  decodeEventStreamFrame,
  EVENTSTREAM_CHUNK_EVENT,
  EVENTSTREAM_EVENT_TYPE_HEADER,
  EVENTSTREAM_EXCEPTION_TYPE_HEADER,
  EVENTSTREAM_MESSAGE_TYPE_HEADER,
  EventStreamDecoderError,
  type EventstreamFrame,
  encodeEventStreamFrame,
  extractBedrockChunkData,
  formatAnthropicSseEvent,
  parseEventStreamHeaders,
} from '../../../src/server/providers/bedrock.js';

/**
 * Frames are built two ways: `encodeEventStreamFrame` (the round-trip
 * helper) and a HAND-ASSEMBLED builder below (raw DataView writes, no
 * module code except the CRC — whose own correctness is anchored by the
 * standard CRC-32 check value test).
 */

function hex(...bytes: number[]): string {
  return Buffer.from(bytes).toString('hex');
}

function text(...bytes: number[]): string {
  return Buffer.from(bytes).toString('utf8');
}

/** CRC-32/IEEE check value: crc32("123456789") = 0xCBF43926. */
test('crc32Ieee matches the standard check value', () => {
  assert.equal(crc32Ieee(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32Ieee(new Uint8Array(0)), 0);
  // Concatenated chunks behave as one buffer.
  assert.equal(crc32Ieee(Buffer.from('1234', 'utf8'), Buffer.from('56789', 'utf8')), 0xcbf43926);
});

/** Hand-assembles one wire frame: [total][headers_len][prelude_crc][headers][payload][message_crc]. */
function handBuiltFrame(headerRecords: ReadonlyArray<readonly [string, string]>, payload: Uint8Array): Uint8Array {
  const headerBytes: number[] = [];
  for (const [name, value] of headerRecords) {
    const nameBytes = Buffer.from(name, 'utf8');
    const valueBytes = Buffer.from(value, 'utf8');
    headerBytes.push(
      nameBytes.length,
      ...nameBytes,
      7,
      (valueBytes.length >> 8) & 0xff,
      valueBytes.length & 0xff,
      ...valueBytes,
    );
  }
  const headers = Uint8Array.from(headerBytes);
  const total = 12 + headers.length + payload.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  view.setUint32(8, crc32Ieee(frame.subarray(0, 8)));
  frame.set(headers, 12);
  frame.set(payload, 12 + headers.length);
  view.setUint32(total - 4, crc32Ieee(frame.subarray(0, total - 4)));
  return frame;
}

function chunkFrame(sseEventJson: string): Uint8Array {
  // Bedrock chunk payloads are {"bytes":"<base64 of the Anthropic SSE event JSON>"}.
  return encodeEventStreamFrame({
    headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, EVENTSTREAM_CHUNK_EVENT]],
    payload: Buffer.from(JSON.stringify({ bytes: Buffer.from(sseEventJson, 'utf8').toString('base64') }), 'utf8'),
  });
}

test('decodeEventStreamFrame parses a hand-built frame', () => {
  const payload = Buffer.from('{"hello":"world"}', 'utf8');
  const frame = handBuiltFrame(
    [
      [EVENTSTREAM_MESSAGE_TYPE_HEADER, 'event'],
      [EVENTSTREAM_EVENT_TYPE_HEADER, 'chunk'],
    ],
    payload,
  );
  const decoded = decodeEventStreamFrame(frame);
  assert.notEqual(decoded, null);
  assert.equal(decoded?.consumed, frame.length);
  assert.deepEqual(decoded?.frame.headers, {
    [EVENTSTREAM_MESSAGE_TYPE_HEADER]: 'event',
    [EVENTSTREAM_EVENT_TYPE_HEADER]: 'chunk',
  });
  assert.equal(Buffer.from(decoded?.frame.payload ?? []).toString('utf8'), '{"hello":"world"}');
});

test('decodeEventStreamFrame returns null while a frame is incomplete', () => {
  const frame = handBuiltFrame([[EVENTSTREAM_EVENT_TYPE_HEADER, 'chunk']], Buffer.from('x'));
  assert.equal(decodeEventStreamFrame(frame.subarray(0, 8)), null);
  assert.equal(decodeEventStreamFrame(frame.subarray(0, frame.length - 1)), null);
  assert.notEqual(decodeEventStreamFrame(frame), null);
});

test('malformed frames fail closed with typed errors', () => {
  const frame = handBuiltFrame([[EVENTSTREAM_EVENT_TYPE_HEADER, 'chunk']], Buffer.from('x'));
  // Corrupt the prelude CRC.
  const badPrelude = new Uint8Array(frame);
  badPrelude[8] ^= 0xff;
  assert.throws(
    () => decodeEventStreamFrame(badPrelude),
    (error: unknown) => error instanceof EventStreamDecoderError && error.code === 'PRELUDE_CRC_MISMATCH',
  );
  // Corrupt the message CRC.
  const badMessage = new Uint8Array(frame);
  badMessage[badMessage.length - 1] ^= 0xff;
  assert.throws(
    () => decodeEventStreamFrame(badMessage),
    (error: unknown) => error instanceof EventStreamDecoderError && error.code === 'MESSAGE_CRC_MISMATCH',
  );
  // An impossible total length.
  const badLength = new Uint8Array(frame);
  new DataView(badLength.buffer).setUint32(0, 8);
  assert.throws(
    () => decodeEventStreamFrame(badLength),
    (error: unknown) => error instanceof EventStreamDecoderError && error.code === 'INVALID_FRAME_LENGTH',
  );
  // A headers length that overruns the frame.
  const badHeadersLength = new Uint8Array(frame);
  new DataView(badHeadersLength.buffer).setUint32(4, 1_000);
  assert.throws(
    () => decodeEventStreamFrame(badHeadersLength),
    (error: unknown) => error instanceof EventStreamDecoderError && error.code === 'INVALID_FRAME_LENGTH',
  );
});

test('the decoder emits every frame of one chunk (multiple frames, mixed types)', () => {
  const decoder = createEventstreamDecoder();
  const frames = [
    encodeEventStreamFrame({
      headers: [
        [EVENTSTREAM_MESSAGE_TYPE_HEADER, 'event'],
        [EVENTSTREAM_EVENT_TYPE_HEADER, 'initial-response'],
      ],
    }),
    chunkFrame('{"type":"message_start"}'),
    chunkFrame('{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}'),
    encodeEventStreamFrame({
      headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, 'metadata']],
      payload: Buffer.from('{"usage":{}}', 'utf8'),
    }),
  ];
  const emitted = decoder.feed(Buffer.concat(frames));
  assert.equal(emitted.length, 4);
  assert.equal(emitted[0].headers[EVENTSTREAM_EVENT_TYPE_HEADER], 'initial-response');
  assert.equal(emitted[1].headers[EVENTSTREAM_EVENT_TYPE_HEADER], 'chunk');
  assert.equal(emitted[3].headers[EVENTSTREAM_EVENT_TYPE_HEADER], 'metadata');
  // Nothing is retained afterwards.
  assert.deepEqual(decoder.feed(new Uint8Array(0)), []);
});

test('the decoder reassembles frames split across chunks (byte-by-byte)', () => {
  const frames = [
    chunkFrame('{"type":"message_start","message":{}}'),
    encodeEventStreamFrame({ headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, 'initial-response']] }),
    chunkFrame('{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}'),
  ];
  const wire = Buffer.concat(frames);
  const oneShot = createEventstreamDecoder().feed(wire);
  const byteByByte = createEventstreamDecoder();
  const collected: EventstreamFrame[] = [];
  for (let index = 0; index < wire.length; index += 1) {
    collected.push(...byteByByte.feed(wire.subarray(index, index + 1)));
  }
  // Identical frame sequences regardless of chunking.
  assert.equal(collected.length, oneShot.length);
  for (let index = 0; index < oneShot.length; index += 1) {
    assert.deepEqual(collected[index].headers, oneShot[index].headers, `frame ${index} headers`);
    assert.deepEqual(
      Buffer.from(collected[index].payload),
      Buffer.from(oneShot[index].payload),
      `frame ${index} payload`,
    );
  }
  // And every split point of a two-frame stream decodes identically.
  const pair = Buffer.concat([chunkFrame('{"type":"a"}'), chunkFrame('{"type":"b"}')]);
  const reference = createEventstreamDecoder().feed(pair);
  for (let split = 0; split <= pair.length; split += 1) {
    const decoder = createEventstreamDecoder();
    const first = decoder.feed(pair.subarray(0, split));
    const second = decoder.feed(pair.subarray(split));
    assert.equal(first.length + second.length, reference.length, `split at ${split}`);
  }
});

test('a decode error drops the buffer (fail closed) and surfaces the typed error', () => {
  const decoder = createEventstreamDecoder();
  const frame = chunkFrame('{"type":"x"}');
  const corrupt = new Uint8Array(frame);
  corrupt[corrupt.length - 2] ^= 0x55;
  assert.throws(
    () => decoder.feed(corrupt),
    (error: unknown) => error instanceof EventStreamDecoderError,
  );
  // The buffer was dropped: the next good frame decodes cleanly.
  const next = decoder.feed(chunkFrame('{"type":"y"}'));
  assert.equal(next.length, 1);
});

test('parseEventStreamHeaders handles non-string value types without values', () => {
  // [name_len=11][':event-type'][type 7][len 5]['chunk'][name_len=1]['b'][type 0 (bool true)][name_len=1]['i'][type 4 (int)][4 bytes]
  const headers = Buffer.from([
    11,
    ...Buffer.from(':event-type', 'utf8'),
    7,
    0,
    5,
    ...Buffer.from('chunk', 'utf8'),
    1,
    ...Buffer.from('b', 'utf8'),
    0,
    1,
    ...Buffer.from('i', 'utf8'),
    4,
    1,
    2,
    3,
    4,
  ]);
  const parsed = parseEventStreamHeaders(headers);
  assert.equal(parsed[':event-type'], 'chunk');
  assert.equal(parsed.b, 'true');
  assert.equal('i' in parsed, false);
});

test('extractBedrockChunkData unwraps the base64 Anthropic SSE event', () => {
  const eventJson = '{"type":"message_start","message":{"usage":{"input_tokens":11}}}';
  const payload = Buffer.from(JSON.stringify({ bytes: Buffer.from(eventJson, 'utf8').toString('base64') }), 'utf8');
  const event = extractBedrockChunkData(payload);
  assert.deepEqual(event, JSON.parse(eventJson));
  assert.equal(extractBedrockChunkData(Buffer.from('{"nope":true}', 'utf8')), null);
  assert.equal(extractBedrockChunkData(Buffer.from('not json', 'utf8')), null);
  assert.equal(extractBedrockChunkData(Buffer.from('{}', 'utf8')), null);
});

test('formatAnthropicSseEvent renders the event/data pair', () => {
  assert.equal(
    formatAnthropicSseEvent({ type: 'message_start' }),
    'event: message_start\ndata: {"type":"message_start"}\n\n',
  );
  assert.equal(formatAnthropicSseEvent({ x: 1 }), 'data: {"x":1}\n\n');
});

test('decodeBedrockEventstreamStream turns a chunked eventstream into Anthropic SSE', async () => {
  const wire = Buffer.concat([
    encodeEventStreamFrame({ headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, 'initial-response']] }),
    chunkFrame('{"type":"message_start","message":{}}'),
    chunkFrame('{"type":"message_delta","delta":{},"usage":{"output_tokens":7}}'),
    encodeEventStreamFrame({ headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, 'metadata']] }),
  ]);
  // Split the wire at awkward boundaries (mid-frame) to prove the pipeline
  // reassembles.
  for (const split of [0, 1, 13, wire.length - 3, wire.length]) {
    const stream = Readable.from([wire.subarray(0, split), wire.subarray(split)]);
    const out = await decodeBedrockEventstreamStream(stream).toArray();
    const text = out.join('');
    assert.equal(
      text,
      'event: message_start\ndata: {"type":"message_start","message":{}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":7}}\n\n',
      `split at ${split}`,
    );
  }
});

test('decodeBedrockEventstreamStream fails the stream on an exception frame', async () => {
  const wire = Buffer.concat([
    chunkFrame('{"type":"message_start","message":{}}'),
    encodeEventStreamFrame({
      headers: [
        [EVENTSTREAM_MESSAGE_TYPE_HEADER, 'exception'],
        [EVENTSTREAM_EXCEPTION_TYPE_HEADER, 'ThrottlingException'],
      ],
      payload: Buffer.from('{"message":"too fast"}', 'utf8'),
    }),
  ]);
  const stream = Readable.from([wire]);
  await assert.rejects(
    decodeBedrockEventstreamStream(stream).toArray(),
    (error: unknown) => error instanceof Error && String(error.message).includes('ThrottlingException'),
  );
});

test('hex/text helpers sanity (wire bytes are big-endian lengths)', () => {
  assert.equal(hex(0, 0, 0, 16), '00000010');
  assert.equal(text(104, 105), 'hi');
});
