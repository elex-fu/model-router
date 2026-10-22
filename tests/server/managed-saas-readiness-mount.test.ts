import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createGatewayHandler } from '../../src/server/managed-saas.js';

test('standard gateway listener delegates GET and HEAD readiness to its mounted authority', async () => {
  const requests: string[] = [];
  const server = createServer(
    createGatewayHandler(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (!request.url?.startsWith('/readyz')) return false;
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(
        request.method === 'HEAD'
          ? undefined
          : JSON.stringify({ status: 'not-ready', providerCapabilities: { configurationValid: false } }),
      );
      return true;
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const get = await fetch(`${origin}/readyz?probe=1`);
    assert.equal(get.status, 503);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await get.json(), { status: 'not-ready', providerCapabilities: { configurationValid: false } });
    const head = await fetch(`${origin}/readyz`, { method: 'HEAD' });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), '');
    assert.deepEqual(requests, ['GET /readyz?probe=1', 'HEAD /readyz']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('readiness fails closed when the commercial gateway is absent', async () => {
  const server = createServer(createGatewayHandler());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'GATEWAY_UNAVAILABLE');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
