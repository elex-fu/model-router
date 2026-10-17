import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BedrockEventStreamDecoder,
  crc32Ieee,
  decodeEventStreamFrame,
  EVENTSTREAM_CHUNK_EVENT,
  EVENTSTREAM_EVENT_TYPE_HEADER,
  EventStreamDecoderError,
  encodeEventStreamFrame,
  parseEventStreamHeaders,
} from '../../../../src/saas/gateway/bedrock/eventstream.js';

/** Builds one Bedrock chunk frame carrying the base64 Anthropic event JSON. */
function chunkFrame(eventJson: string): Uint8Array {
  return encodeEventStreamFrame({
    headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, EVENTSTREAM_CHUNK_EVENT]],
    payload: Buffer.from(JSON.stringify({ bytes: Buffer.from(eventJson, 'utf8').toString('base64') }), 'utf8'),
  });
}

test('crc32 matches known CRC-32/IEEE check values', () => {
  // The canonical "123456789" check value for CRC-32/IEEE is 0xCBF43926.
  assert.equal(crc32Ieee(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.equal(crc32Ieee(new Uint8Array(0)), 0);
});

test('a frame round-trips through encode and decode with both CRCs verified', () => {
  const frame = chunkFrame('{"type":"message_start","message":{}}');
  const decoded = decodeEventStreamFrame(frame);
  assert.ok(decoded !== null);
  assert.equal(decoded.consumed, frame.length);
  assert.equal(decoded.frame.headers[':event-type'], 'chunk');
  const payload = JSON.parse(Buffer.from(decoded.frame.payload).toString('utf8'));
  assert.equal(typeof payload.bytes, 'string');
});

test('decode returns null until the full frame has arrived, then consumes exactly its bytes', () => {
  const first = chunkFrame('{"type":"content_block_start"}');
  const second = chunkFrame('{"type":"content_block_delta"}');
  const stream = Buffer.concat([first, second]);
  assert.equal(decodeEventStreamFrame(stream.subarray(0, first.length - 1)), null);
  const decoded = decodeEventStreamFrame(stream);
  assert.ok(decoded !== null);
  assert.equal(decoded.consumed, first.length);
  const next = decodeEventStreamFrame(stream.subarray(decoded.consumed));
  assert.ok(next !== null);
  assert.equal(next.consumed, second.length);
});

test('a corrupted prelude CRC fails closed', () => {
  const frame = Buffer.from(chunkFrame('{}'));
  // Corrupt the prelude CRC field itself (bytes 8-11), not the length, so
  // the CRC check is what trips.
  frame[8] ^= 0xff;
  assert.throws(
    () => decodeEventStreamFrame(frame),
    (error: unknown) => {
      assert.ok(error instanceof EventStreamDecoderError);
      assert.equal(error.code, 'PRELUDE_CRC_MISMATCH');
      return true;
    },
  );
});

test('a corrupted message CRC fails closed', () => {
  const frame = Buffer.from(chunkFrame('{}'));
  frame[frame.length - 1] ^= 0xff;
  assert.throws(
    () => decodeEventStreamFrame(frame),
    (error: unknown) => {
      assert.ok(error instanceof EventStreamDecoderError);
      assert.equal(error.code, 'MESSAGE_CRC_MISMATCH');
      return true;
    },
  );
});

test('an invalid total_length fails closed', () => {
  const frame = new Uint8Array(20);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 4); // below the 16-byte minimum
  view.setUint32(4, 0);
  view.setUint32(8, crc32Ieee(frame.subarray(0, 8)));
  assert.throws(
    () => decodeEventStreamFrame(frame),
    (error: unknown) => {
      assert.ok(error instanceof EventStreamDecoderError);
      assert.equal(error.code, 'INVALID_FRAME_LENGTH');
      assert.match(error.message, /total_length=4/);
      return true;
    },
  );
});

test('the incremental decoder reassembles frames split across arbitrary chunk boundaries', () => {
  const frames = [
    chunkFrame('{"type":"message_start"}'),
    chunkFrame('{"type":"message_delta"}'),
    chunkFrame('{"type":"message_stop"}'),
  ];
  const decoder = new BedrockEventStreamDecoder();
  const whole = Buffer.concat(frames);
  const collected: string[] = [];
  // Feed one byte at a time; only the final byte yields the last frame.
  for (let index = 1; index <= whole.length; index += 1) {
    for (const payload of decoder.feed(whole.subarray(index - 1, index))) {
      const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as { bytes: string };
      collected.push(Buffer.from(parsed.bytes, 'base64').toString('utf8'));
    }
  }
  assert.deepEqual(collected, ['{"type":"message_start"}', '{"type":"message_delta"}', '{"type":"message_stop"}']);
  assert.equal(decoder.feed(new Uint8Array(0)).length, 0);
});

test('non-chunk frames (initial-response) are skipped silently', () => {
  const initial = encodeEventStreamFrame({
    headers: [
      [':message-type', 'event'],
      [':event-type', 'initial-response'],
    ],
    payload: Buffer.from('{"contentType":"application/json"}', 'utf8'),
  });
  const chunk = chunkFrame('{"type":"message_start"}');
  const decoder = new BedrockEventStreamDecoder();
  const payloads = decoder.feed(Buffer.concat([initial, chunk]));
  assert.equal(payloads.length, 1);
  const parsed = JSON.parse(Buffer.from(payloads[0]).toString('utf8')) as { bytes: string };
  assert.equal(Buffer.from(parsed.bytes, 'base64').toString('utf8'), '{"type":"message_start"}');
});

test('an exception frame surfaces the upstream exception type and payload', () => {
  const exception = encodeEventStreamFrame({
    headers: [
      [':message-type', 'exception'],
      [':exception-type', 'ThrottlingException'],
      [':content-type', 'application/json'],
    ],
    payload: Buffer.from('{"message":"Too many invocations"}', 'utf8'),
  });
  const decoder = new BedrockEventStreamDecoder();
  assert.throws(
    () => decoder.feed(exception),
    (error: unknown) => {
      assert.ok(error instanceof EventStreamDecoderError);
      assert.equal(error.code, 'UPSTREAM_EXCEPTION');
      assert.match(error.message, /ThrottlingException.*Too many invocations/);
      return true;
    },
  );
});

test('header records with non-string value types parse without derailing later records', () => {
  // Manually assemble a header block mixing bool/byte/int/timestamp/uuid
  // value types with a trailing string header, then verify the string
  // header is still readable.
  const headerBytes: number[] = [];
  const pushName = (name: string): void => {
    const bytes = Buffer.from(name, 'utf8');
    headerBytes.push(bytes.length, ...bytes);
  };
  pushName('flag');
  headerBytes.push(0); // bool true
  pushName('b');
  headerBytes.push(2, 7); // byte
  pushName('i');
  headerBytes.push(4, 0, 0, 0, 9); // int
  pushName('t');
  headerBytes.push(8, 0, 0, 0, 0, 0, 0, 1, 0); // timestamp
  pushName('u');
  headerBytes.push(9, ...new Array(16).fill(1)); // uuid
  pushName('s');
  const value = Buffer.from('hello', 'utf8');
  headerBytes.push(7, (value.length >> 8) & 0xff, value.length & 0xff, ...value); // string
  const headers = parseEventStreamHeaders(Uint8Array.from(headerBytes));
  assert.equal(headers.flag, 'true');
  assert.equal(headers.s, 'hello');
  assert.equal('b' in headers, false);
  assert.equal('i' in headers, false);
});
