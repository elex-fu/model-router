import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { proxyHandler } from '../../src/server/proxy.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function harness(first: http.RequestListener) {
  let secondRequests = 0;
  const upstreamA = await listen(first);
  const upstreamB = await listen((_req, res) => {
    secondRequests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"from-b"}}]}\n\ndata: [DONE]\n\n');
  });
  const config: Config = {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10, maxRetries: 4 },
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
    upstreams: [upstreamA, upstreamB].map((server, index) => ({
      id: `up_${index + 1}`,
      name: `up_${index + 1}`,
      provider: 'custom',
      protocol: 'openai' as const,
      baseUrl: `${server.url}/v1`,
      endpoint: 'chat/completions',
      authMode: 'none' as const,
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
        targets: [
          { upstreamId: 'up_1', model: 'real' },
          { upstreamId: 'up_2', model: 'real' },
        ],
      },
    ],
  };
  const requests: RequestRecord[] = [];
  const attempts: AttemptRecord[] = [];
  const proxy = await listen((req, res) => {
    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, {
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
      if (!res.writableEnded) res.end(String(error));
    });
  });
  return {
    requests,
    attempts,
    get secondRequests() {
      return secondRequests;
    },
    post: (stream: boolean) =>
      fetch(`${proxy.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'public', stream, messages: [{ role: 'user', content: 'hi' }] }),
      }),
    close: async () => {
      await proxy.close();
      await upstreamA.close();
      await upstreamB.close();
    },
  };
}

for (const contentType of ['text/event-stream', 'application/octet-stream']) {
  test(`${contentType === 'text/event-stream' ? 'SSE' : 'HTTP streaming'} truncation never falls back to another upstream`, async () => {
    const h = await harness((_req, res) => {
      res.writeHead(200, { 'content-type': contentType });
      res.write(
        contentType === 'text/event-stream'
          ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
          : 'partial-body',
      );
      setImmediate(() => res.socket?.destroy());
    });
    try {
      const response = await h.post(true);
      await response.text().catch(() => '');
      assert.equal(h.secondRequests, 0);
      const terminalAttempts = h.attempts.filter((attempt) => attempt.endedAtMs !== null);
      assert.equal(terminalAttempts.length, 1);
      assert.equal(terminalAttempts[0].outcome, 'failed');
      assert.equal(terminalAttempts[0].retryReason, 'stream_truncated');
      assert.equal(h.requests.filter((record) => record.endedAtMs !== null)[0]?.state, 'failed');
      const terminal = h.requests.filter((record) => record.endedAtMs !== null);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].state, 'failed');
      assert.notEqual(terminal[0].state, 'completed');
    } finally {
      await h.close();
    }
  });
}

test('upstream 5xx before response headers still falls back', async () => {
  const h = await harness((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"try another upstream"}}');
  });
  try {
    const response = await h.post(true);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /from-b/);
    assert.equal(h.secondRequests, 1);
    assert.equal(h.requests.filter((record) => record.endedAtMs !== null).at(-1)?.state, 'completed');
  } finally {
    await h.close();
  }
});
