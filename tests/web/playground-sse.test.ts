import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type PlaygroundFrame, readPlaygroundSse } from '../../web/src/features/playground-sse.ts';

function chunks(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

const bytes = (value: string) => new TextEncoder().encode(value);

test('SSE reader joins CRLF data lines and preserves UTF-8 across byte chunks', async () => {
  const source = bytes(
    ': keepalive\r\nevent: delta\r\ndata: {"delta":\r\ndata: "你好"}\r\n\r\nevent: summary\ndata: {"summary":{"state":"completed"}}\n\ndata: [DONE]',
  );
  const split = source.indexOf(0xe4); // Split inside the first three-byte character.
  const frames: PlaygroundFrame[] = [];
  await readPlaygroundSse(
    chunks([source.slice(0, split + 1), source.slice(split + 1, split + 2), source.slice(split + 2)]),
    (frame) => frames.push(frame),
  );
  assert.deepEqual(frames, [
    { event: 'delta', data: { delta: '你好' } },
    { event: 'summary', data: { summary: { state: 'completed' } } },
  ]);
});

test('SSE reader handles CRLF split across chunks and stops at DONE', async () => {
  const frames: PlaygroundFrame[] = [];
  await readPlaygroundSse(
    chunks([
      bytes('event: started\r'),
      bytes('\ndata: {"runId":"run_1"}\r'),
      bytes('\n\r\ndata: [DONE]\r\n\r\nevent: delta\ndata: {"delta":"fake"}\n\n'),
    ]),
    (frame) => frames.push(frame),
  );
  assert.deepEqual(frames, [{ event: 'started', data: { runId: 'run_1' } }]);
});

test('SSE reader rejects malformed payload without treating it as output', async () => {
  const frames: PlaygroundFrame[] = [];
  await assert.rejects(
    readPlaygroundSse(chunks([bytes('event: delta\ndata: {bad-json}\n\n')]), (frame) => frames.push(frame)),
    /无效 JSON/,
  );
  assert.deepEqual(frames, []);
});

test('SSE reader reports missing DONE while retaining only valid prior frames', async () => {
  const frames: PlaygroundFrame[] = [];
  await assert.rejects(
    readPlaygroundSse(chunks([bytes('event: delta\ndata: {"delta":"partial"}')]), (frame) => frames.push(frame)),
    /完成标记/,
  );
  assert.deepEqual(frames, [{ event: 'delta', data: { delta: 'partial' } }]);
});

test('SSE reader propagates event errors and cancels the stream', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes('event: error\ndata: {"error":{"message":"failed"}}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readPlaygroundSse(body, (frame) => {
      if (frame.event === 'error') throw new Error((frame.data.error as { message: string }).message);
    }),
    /failed/,
  );
  assert.equal(cancelled, true);
});
