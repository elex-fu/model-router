import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogQueue } from '../../src/logger/queue.js';
import type { LogStore } from '../../src/logger/store.js';
import type { LogEntry } from '../../src/logger/types.js';

const row = (name: string) => ({ proxy_key_name: name }) as LogEntry;

test('LogQueue stop waits for an in-flight batch', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inserted: string[] = [];
  const store = {
    insertBatch: async (entries: LogEntry[]) => {
      await held;
      inserted.push(...entries.map((entry) => entry.proxy_key_name));
    },
  } as LogStore;
  const queue = new LogQueue(store, 60_000, 1);
  queue.enqueue(row('first'));
  const stopped = queue.stop();
  let done = false;
  void stopped.then(() => {
    done = true;
  });
  await Promise.resolve();
  assert.equal(done, false);
  release();
  await stopped;
  assert.deepEqual(inserted, ['first']);
  queue.enqueue(row('after-stop'));
  assert.deepEqual(inserted, ['first']);
});

test('LogQueue retries a failed in-flight batch at stop without dropping rows', async () => {
  const inserted: string[] = [];
  let attempt = 0;
  const store = {
    insertBatch: async (entries: LogEntry[]) => {
      if (++attempt === 1) throw new Error('temporary write failure');
      inserted.push(...entries.map((entry) => entry.proxy_key_name));
    },
  } as LogStore;
  const oldError = console.error;
  console.error = () => {};
  try {
    const queue = new LogQueue(store, 60_000, 1);
    queue.enqueue(row('retry-me'));
    await queue.stop();
    assert.equal(attempt, 2);
    assert.deepEqual(inserted, ['retry-me']);
  } finally {
    console.error = oldError;
  }
});

test('LogQueue reports a persistent storage failure during stop', async () => {
  const store = {
    insertBatch: async () => {
      throw new Error('disk unavailable');
    },
  } as unknown as LogStore;
  const oldError = console.error;
  console.error = () => {};
  try {
    const queue = new LogQueue(store, 60_000, 1);
    queue.enqueue(row('unwritten'));
    await assert.rejects(queue.stop(), /could not flush/);
  } finally {
    console.error = oldError;
  }
});
