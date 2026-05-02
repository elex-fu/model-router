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
