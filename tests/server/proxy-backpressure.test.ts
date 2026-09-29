import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { proxyHandler } from '../../src/server/proxy.js';
import type { RequestRecord } from '../../src/telemetry/types.js';

const timeout = <T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test('SSE proxy waits for drain before writing the next chunk and completes once released', {
  timeout: 10000,
}, async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"second"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) res.write(chunk);
    res.end();
  });

  const requests: RequestRecord[] = [];
  const config: Config = {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        id: 'key_1',
        name: 'test',
        key: '',
        keyHash: createHash('sha256').update('sk-test').digest('hex'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    upstreams: [
      {
        id: 'up_1',
        name: 'up_1',
        provider: 'custom',
        protocol: 'openai',
        baseUrl: `${upstream.url}/v1`,
        endpoint: 'chat/completions',
        authMode: 'none',
        apiKeys: [],
        models: ['real'],
        enabled: true,
      },
    ],
    routes: [
      {
        id: 'route_1',
        name: 'route',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'public' },
        order: 0,
        publishedModels: ['public'],
        targets: [{ upstreamId: 'up_1', model: 'real' }],
      },
    ],
  };

  let response: http.ServerResponse | undefined;
  let armed = false;
  let intercepted = false;
  let resolveDrainWait!: () => void;
  const drainListenerRegistered = new Promise<void>((resolve) => {
    resolveDrainWait = resolve;
  });
  let endCount = 0;
  let signalFirstWrite!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    signalFirstWrite = resolve;
  });
  let proxyDrainListener: ((...args: any[]) => void) | undefined;
  let continuationReleased = false;
  const server = http.createServer((req, res) => {
    response = res;
    armed = true;
    const originalWrite = res.write;
    const originalEnd = res.end;
    const originalOnce = res.once;
    res.once = function (event: string | symbol, listener: (...args: any[]) => void) {
      if (event === 'drain' && intercepted) {
        proxyDrainListener = listener;
        resolveDrainWait();
        return this;
      }
      return originalOnce.call(this, event, listener);
    } as http.ServerResponse['once'];
    res.write = function (...args: Parameters<http.ServerResponse['write']>) {
      if (armed) {
        if (!intercepted) {
          const accepted = originalWrite.apply(this, args);
          intercepted = true;
          signalFirstWrite();
          return accepted && false;
        }
      }
      return originalWrite.apply(this, args);
    } as http.ServerResponse['write'];
    res.end = function (...args: Parameters<http.ServerResponse['end']>) {
      if (armed) endCount++;
      return originalEnd.apply(this, args);
    } as http.ServerResponse['end'];

    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, {
      telemetryStore: {
        upsertRequest: async (record) => {
          requests.push(structuredClone(record));
        },
        upsertAttempt: async () => {},
      },
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    const responsePromise = fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await timeout(firstWrite, 'first proxy SSE write');
    assert.ok(response, 'request must have a concrete ServerResponse');
    await timeout(drainListenerRegistered, 'proxy drain listener');
    assert.equal(endCount, 0, 'proxy must not end the response while drain is withheld');
    assert.equal(response.writableEnded, false);

    assert.ok(proxyDrainListener, 'proxy drain continuation should be captured');
    continuationReleased = true;
    proxyDrainListener();

    const clientResponse = await timeout(responsePromise, 'client response');
    assert.equal(clientResponse.status, 200);
    const body = await timeout(clientResponse.text(), 'completed SSE response');
    const expected = chunks.join('');
    assert.equal(body, expected);
    assert.equal((body.match(/data: \[DONE\]/g) ?? []).length, 1);
    assert.equal(continuationReleased, true, 'proxy drain wait should be explicitly released');
    assert.equal(endCount, 1, 'response should end once after all chunks');

    const terminal = requests.filter((record) => record.endedAtMs !== null);
    assert.equal(terminal.length, 1, 'request should have exactly one terminal record');
    assert.equal(terminal[0].state, 'completed');
    assert.equal(terminal[0].finalHttpStatus, 200);
  } finally {
    if (response && !response.writableEnded) response.emit('drain');
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await upstream.close();
  }
});
