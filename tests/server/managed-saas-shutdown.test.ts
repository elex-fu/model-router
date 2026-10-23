import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { closeManagedSaasResources, drainManagedSaasShutdown, ManagedSaasRequestTracker } from '../../src/server/managed-saas-shutdown.js';
import { createGatewayHandler } from '../../src/server/managed-saas.js';

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

for (const ending of ['eof', 'abort'] as const) {
  test(`original public gateway handler survives client ${ending} until application cleanup settles`, async () => {
    const tracker = new ManagedSaasRequestTracker();
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    let resourceClosed = false;
    const handler = createGatewayHandler(undefined, async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: accepted\n\n');
      if (ending === 'eof') response.end();
      await cleanup;
      assert.equal(resourceClosed, false);
      return true;
    });
    const server = createServer((request, response) => tracker.track(handler(request, response)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/settings/public`, { signal: AbortSignal.timeout(5000) });
      if (ending === 'eof') await response.text();
      else await response.body!.cancel();
      const listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      let finished = false;
      const closing = drainManagedSaasShutdown([listenerClosed, tracker.drain()], () => server.closeAllConnections(), 1000, 100)
        .then(() => closeManagedSaasResources([async () => { resourceClosed = true; }]))
        .then(() => { finished = true; });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(finished, false);
      assert.equal(resourceClosed, false);
      release();
      await closing;
      assert.equal(resourceClosed, true);
    } finally {
      release();
      server.closeAllConnections();
      server.close();
    }
  });
}

test('an original handler that never settles prevents dependent resource close after force', async () => {
  const tracker = new ManagedSaasRequestTracker();
  tracker.track(new Promise(() => {}));
  let forced = 0;
  let databaseClosed = false;
  await assert.rejects((async () => {
    await drainManagedSaasShutdown([tracker.drain()], () => { forced += 1; }, 5, 5);
    await closeManagedSaasResources([async () => { databaseClosed = true; }]);
  })(), /MANAGED_SAAS_SHUTDOWN_TIMEOUT/);
  assert.equal(forced, 1);
  assert.equal(databaseClosed, false);
});

test('a settled provider close rejection permits best effort cleanup but remains a sanitized failure', async () => {
  const order: string[] = [];
  await assert.rejects(closeManagedSaasResources([
    async () => { order.push('provider'); throw new Error('synthetic private detail'); },
    async () => { order.push('database'); },
    async () => { order.push('redis'); },
  ]), /^Error: MANAGED_SAAS_SHUTDOWN_RESOURCE_FAILED$/);
  assert.deepEqual(order, ['provider', 'database', 'redis']);
});

test('a hung provider exhausts the shared final budget without starting dependent database close', async () => {
  const order: string[] = [];
  await assert.rejects(closeManagedSaasResources([
    async () => { order.push('first'); await new Promise((resolve) => setTimeout(resolve, 5)); },
    async () => { order.push('provider'); await new Promise(() => {}); },
    async () => { order.push('database'); },
  ], 20), /MANAGED_SAAS_SHUTDOWN_RESOURCE_TIMEOUT/);
  assert.deepEqual(order, ['first', 'provider']);
});

test('successful final resource close preserves dependency order', async () => {
  const order: string[] = [];
  await closeManagedSaasResources([
    async () => { order.push('provider'); },
    async () => { order.push('database'); },
    async () => { order.push('redis'); },
  ]);
  assert.deepEqual(order, ['provider', 'database', 'redis']);
});
