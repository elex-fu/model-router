import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { drainManagedSaasShutdown } from '../../src/server/managed-saas-shutdown.js';

test('shutdown waits for original completion without forcing a live stream', async () => {
  let complete!: () => void;
  let forced = false;
  const original = new Promise<void>((resolve) => { complete = resolve; });
  const closing = drainManagedSaasShutdown([original], () => { forced = true; }, 1000, 100);
  await Promise.resolve();
  assert.equal(forced, false);
  complete();
  await closing;
  assert.equal(forced, false);
});

test('shutdown aborts sockets only after grace and waits for financial cleanup', async () => {
  let complete!: () => void;
  let forced = 0;
  const original = new Promise<void>((resolve) => { complete = resolve; });
  await drainManagedSaasShutdown([original], () => { forced += 1; setTimeout(complete, 5); }, 5, 1000);
  assert.equal(forced, 1);
});

test('shutdown rejects on cleanup timeout instead of declaring an unresolved handler drained', async () => {
  let forced = 0;
  await assert.rejects(
    drainManagedSaasShutdown([new Promise(() => {})], () => { forced += 1; }, 5, 5),
    /MANAGED_SAAS_SHUTDOWN_TIMEOUT/,
  );
  assert.equal(forced, 1);
});

test('shutdown drain rejection stays a failure', async () => {
  await assert.rejects(drainManagedSaasShutdown([Promise.reject(new Error('private failure'))], () => {}),
    /^Error: MANAGED_SAAS_SHUTDOWN_DRAIN_FAILED$/);
});

test('deadline closes an actual accepted HTTP stream before original cleanup completes', async () => {
  let complete!: () => void;
  let cleanupFinished = false;
  let resourceClosed = false;
  const original = new Promise<void>((resolve) => { complete = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    response.once('close', () => {
      assert.equal(resourceClosed, false, 'handler retains resource ownership after socket abort');
      setTimeout(() => { cleanupFinished = true; complete(); }, 5);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(5000) });
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    const listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    await drainManagedSaasShutdown([listenerClosed, original], () => server.closeAllConnections(), 10, 1000);
    resourceClosed = true;
    assert.equal(cleanupFinished, true);
    await assert.rejects(reader.read());
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
