import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { type ProxyHandlerOptions, proxyHandler } from '../../src/server/proxy.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function harness(upstreams: string[], budgets: Partial<ProxyHandlerOptions> = {}) {
  const attempts: AttemptRecord[] = [];
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
    upstreams: upstreams.map((url, i) => ({
      id: `up_${i}`,
      name: `up_${i}`,
      provider: 'custom',
      protocol: 'openai',
      baseUrl: `${url}/v1`,
      endpoint: 'chat/completions',
      authMode: 'none',
      apiKeys: [],
      models: ['real'],
      enabled: true,
    })),
    routes: [
      {
        id: 'route_1',
        name: 'route',
        enabled: true,
        clientProtocols: ['openai'],
        match: { kind: 'exact', value: 'public' },
        order: 0,
        publishedModels: ['public'],
        targets: upstreams.map((_, i) => ({ upstreamId: `up_${i}`, model: 'real' })),
      },
    ],
  };
  const proxy = await listen((req, res) => {
    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, {
      ...budgets,
      maxRetries: 5,
      telemetryStore: {
        upsertRequest: async (record) => {
          requests.push(structuredClone(record));
        },
        upsertAttempt: async (record) => {
          attempts.push(structuredClone(record));
        },
      },
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  const post = (stream = false, signal?: AbortSignal) =>
    fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public', stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
  return { ...proxy, post, attempts, requests };
}

test('headers alone do not satisfy first body byte timeout', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200);
    res.flushHeaders();
  });
  const proxy = await harness([upstream.url], { firstByteTimeoutMs: 75, requestTimeoutMs: 500 });
  try {
    const response = await proxy.post();
    assert.equal(response.status, 504);
    assert.match(await response.text(), /first_byte_timeout/);
    assert.equal(proxy.requests.at(-1)?.firstByteMs, null);
    assert.equal(proxy.attempts.at(-1)?.retryReason, 'first_byte_timeout');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('stream headers alone also time out before client stream starts', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const proxy = await harness([upstream.url], {
    firstByteTimeoutMs: 75,
    streamIdleTimeoutMs: 300,
    requestTimeoutMs: 500,
  });
  try {
    const response = await proxy.post(true);
    assert.equal(response.status, 504);
    assert.equal(proxy.requests.at(-1)?.firstByteMs, null);
    assert.equal(proxy.attempts.at(-1)?.retryReason, 'first_byte_timeout');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('connection phase times out before response headers', async () => {
  const upstream = await listen(() => {});
  const proxy = await harness([upstream.url], { connectTimeoutMs: 75, requestTimeoutMs: 500 });
  try {
    const response = await proxy.post();
    assert.equal(response.status, 504);
    assert.match(await response.text(), /connect_timeout/);
    assert.equal(proxy.attempts.at(-1)?.retryReason, 'connect_timeout');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('first body byte timeout can fail over within the remaining total budget', async () => {
  const first = await listen((_req, res) => {
    res.writeHead(200);
    res.flushHeaders();
  });
  const second = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  const proxy = await harness([first.url, second.url], { firstByteTimeoutMs: 60, requestTimeoutMs: 400 });
  try {
    const response = await proxy.post();
    assert.equal(response.status, 200);
    assert.equal(
      proxy.attempts.filter((record) => record.outcome === 'failed').at(-1)?.retryReason,
      'first_byte_timeout',
    );
    assert.equal(proxy.attempts.at(-1)?.outcome, 'completed');
  } finally {
    await proxy.close();
    await first.close();
    await second.close();
  }
});

test('5xx failover attempts share one total deadline and backoff stays bounded', async () => {
  let secondSeen = false;
  const first = await listen((_req, res) => {
    res.writeHead(503);
    res.end('{"error":{"message":"busy"}}');
  });
  const second = await listen((_req, res) => {
    secondSeen = true;
    res.writeHead(200);
    res.flushHeaders();
  });
  const proxy = await harness([first.url, second.url], {
    firstByteTimeoutMs: 1000,
    requestTimeoutMs: 130,
    retryRandom: () => 1,
    retryBaseDelayMs: 80,
    retryMaxDelayMs: 80,
  });
  try {
    const started = Date.now();
    const response = await proxy.post();
    assert.equal(response.status, 504);
    assert.ok(Date.now() - started < 700);
    assert.equal(secondSeen, true);
    assert.equal(proxy.attempts.at(-1)?.retryReason, 'total_request_timeout');
  } finally {
    await proxy.close();
    await first.close();
    await second.close();
  }
});

test('429 failover immediately reaches a different upstream despite long Retry-After', async () => {
  let secondSeen = false;
  const first = await listen((_req, res) => {
    res.writeHead(429, { 'retry-after': '3600' });
    res.end('{"error":{"message":"busy"}}');
  });
  const second = await listen((_req, res) => {
    secondSeen = true;
    res.writeHead(200);
    res.end('{"choices":[{"message":{"content":"ok"}}]}');
  });
  const proxy = await harness([first.url, second.url], { requestTimeoutMs: 500 });
  try {
    const started = Date.now();
    const response = await proxy.post();
    assert.equal(response.status, 200);
    assert.equal(secondSeen, true);
    assert.ok(Date.now() - started < 450);
  } finally {
    await proxy.close();
    await first.close();
    await second.close();
  }
});

test('client cancellation interrupts retry backoff', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(503);
    res.end('{"error":{"message":"busy"}}');
  });
  const proxy = await harness([upstream.url], {
    requestTimeoutMs: 1000,
    retryRandom: () => 1,
    retryBaseDelayMs: 500,
    retryMaxDelayMs: 500,
  });
  try {
    const controller = new AbortController();
    const pending = proxy.post(false, controller.signal).catch(() => undefined);
    setTimeout(() => controller.abort(), 80);
    const started = Date.now();
    await pending;
    assert.ok(Date.now() - started < 350);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('SSE heartbeat refreshes transport idle budget; silence ends stream', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hi\n\n');
    const beats = setInterval(() => res.write(': hi\n\n'), 25);
    setTimeout(() => clearInterval(beats), 130);
  });
  const proxy = await harness([upstream.url], {
    firstByteTimeoutMs: 80,
    streamIdleTimeoutMs: 65,
    requestTimeoutMs: 500,
  });
  try {
    const response = await proxy.post(true);
    await response.text();
    assert.equal(proxy.attempts.at(-1)?.retryReason, 'stream_idle_timeout');
    assert.ok((proxy.requests.at(-1)?.firstByteMs ?? 999) < 80);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('client cancellation ends upstream request and records cancellation', async () => {
  let closed = false;
  const upstream = await listen((_req, res) => {
    res.on('close', () => {
      closed = true;
    });
    res.writeHead(200);
    res.flushHeaders();
  });
  const proxy = await harness([upstream.url], { firstByteTimeoutMs: 500, requestTimeoutMs: 1000 });
  try {
    const controller = new AbortController();
    const pending = proxy.post(false, controller.signal).catch(() => undefined);
    setTimeout(() => controller.abort(), 50);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(closed, true);
    assert.equal(proxy.attempts.at(-1)?.outcome, 'cancelled');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
