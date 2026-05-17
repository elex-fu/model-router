import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSseStream,
  writeSseEvent,
  finalizeStream,
  type SseEvent,
} from '../../src/protocol/sse.js';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

test('round-trip: events → finalizeStream → parseSseStream → events', async () => {
  const events: SseEvent[] = [
    { event: 'message_start', data: '{"type":"message_start","message":{"id":"abc"}}' },
    { event: 'message_delta', data: '{"type":"message_delta","usage":{"output_tokens":5}}' },
    { event: 'message_stop', data: '{"type":"message_stop"}' },
  ];
  const bytes = finalizeStream(events);
  const parsed = await collect(streamOf(bytes));
  assert.deepEqual(parsed, events);
});

test('comment lines are ignored', async () => {
  const wire =
    ': this is a heartbeat comment\n' +
    'event: ping\n' +
    'data: hello\n' +
    '\n' +
    ': another comment\n' +
    'data: world\n' +
    '\n';
  const parsed = await collect(streamOf(new TextEncoder().encode(wire)));
  assert.deepEqual(parsed, [
    { event: 'ping', data: 'hello' },
    { event: undefined, data: 'world' },
  ]);
});

test('multi-line data concatenated with \\n', async () => {
  const wire = 'data: line1\ndata: line2\ndata: line3\n\n';
  const parsed = await collect(streamOf(new TextEncoder().encode(wire)));
  assert.deepEqual(parsed, [{ event: undefined, data: 'line1\nline2\nline3' }]);
});

test('CRLF line endings are tolerated', async () => {
  const wire = 'event: hi\r\ndata: x\r\n\r\ndata: y\r\n\r\n';
  const parsed = await collect(streamOf(new TextEncoder().encode(wire)));
  assert.deepEqual(parsed, [
    { event: 'hi', data: 'x' },
    { event: undefined, data: 'y' },
  ]);
});

test('writeSseEvent produces canonical wire format', () => {
  const out = writeSseEvent({ event: 'foo', data: 'bar' });
  assert.equal(out, 'event: foo\ndata: bar\n\n');
});

test('writeSseEvent without event field omits event line', () => {
  const out = writeSseEvent({ data: 'just data' });
  assert.equal(out, 'data: just data\n\n');
});

// UTF-8 cross-chunk safety tests

function streamOfChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

test('3-byte CJK char split across two chunks is reassembled correctly', async () => {
  // "你" = E4 BD A0
  const full = new TextEncoder().encode('data: {"text":"你好"}\n\n');
  // Split inside "你" (E4 BD | A0)
  const chunk1 = full.slice(0, 14); // ends mid-character
  const chunk2 = full.slice(14);
  const parsed = await collectEvents(streamOfChunks([chunk1, chunk2]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].data, '{"text":"你好"}');
});

test('4-byte emoji split across multiple chunks is reassembled correctly', async () => {
  // "😀" = F0 9F 98 80
  const full = new TextEncoder().encode('data: {"emoji":"😀"}\n\n');
  // Feed 1 byte at a time
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < full.length; i++) {
    chunks.push(full.slice(i, i + 1));
  }
  const parsed = await collectEvents(streamOfChunks(chunks));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].data, '{"emoji":"😀"}');
});

test('mixed ASCII and CJK across chunk boundaries', async () => {
  const full = new TextEncoder().encode('data: hello你好world\n\n');
  // Split inside "你好"
  const chunk1 = full.slice(0, 13);
  const chunk2 = full.slice(13);
  const parsed = await collectEvents(streamOfChunks([chunk1, chunk2]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].data, 'hello你好world');
});

test('multiple events with split boundaries', async () => {
  const encoder = new TextEncoder();
  const chunk1 = encoder.encode('data: {"a":"你');
  const chunk2 = encoder.encode('好"}\n\ndata: {"b":"世');
  const chunk3 = encoder.encode('界"}\n\n');
  const parsed = await collectEvents(streamOfChunks([chunk1, chunk2, chunk3]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].data, '{"a":"你好"}');
  assert.equal(parsed[1].data, '{"b":"世界"}');
});
