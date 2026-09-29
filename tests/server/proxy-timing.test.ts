import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import type { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { proxyHandler } from '../../src/server/proxy.js';
import type { RequestRecord } from '../../src/telemetry/types.js';

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

async function harness(upstreamUrl: string) {
  const records: RequestRecord[] = [];
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const lifecycle: string[] = [];
  const config: Config = {
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        id: 'key_1',
        name: 'one',
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
        baseUrl: `${upstreamUrl}/v1`,
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
  const proxy = await listen((req, res) => {
    void proxyHandler(req, res, { load: () => config } as ConfigStore, () => {}, {
      telemetryStore: {
        upsertRequest: async (record) => {
          records.push(structuredClone(record));
          lifecycle.push(`persist:${record.state}`);
        },
        upsertAttempt: async () => {},
      },
      publishEvent: (type, data) => {
        lifecycle.push(`event:${type}`);
        events.push({ type, data });
      },
    }).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  const post = (stream = false) =>
    fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public', stream, messages: [{ role: 'user', content: 'hi' }] }),
    });
  return { ...proxy, config, records, events, lifecycle, post };
}

test('x-request-id is returned on success, auth denial and model listing; nonstream first byte is measured from body', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] })), 40);
  });
  const proxy = await harness(upstream.url);
  try {
    const response = await proxy.post();
    assert.equal(response.status, 200);
    await response.text();
    const record = proxy.records.at(-1)!;
    assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-request-id'), record.id);
    assert.ok(record.firstByteMs !== null && record.firstByteMs >= 20);
    assert.equal(record.firstEventMs, null);
    assert.equal(record.firstTextMs, null); // nonstream response has no text delta
    const completed = proxy.events.filter((event) => event.type === 'request.completed');
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].data, {
      requestId: record.id,
      outcome: 'completed',
      status: 200,
      model: 'public',
      protocol: 'openai',
      source: 'production',
      durationMs: completed[0].data.durationMs,
      finalUpstreamId: 'up_1',
    });
    assert.equal(JSON.stringify(completed).includes('sk-test'), false);
    assert.equal(JSON.stringify(completed).includes('"content":"hi"'), false);

    const denied = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST' });
    assert.equal(denied.status, 401);
    assert.equal(proxy.events.filter((event) => event.type === 'request.completed').length, 2);
    assert.equal(denied.headers.get('x-request-id'), proxy.records.at(-1)?.id);
    const models = await fetch(`${proxy.url}/v1/models`, { headers: { authorization: 'Bearer sk-test' } });
    assert.equal(models.status, 200);
    assert.match(models.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('SSE first event ignores heartbeat; first text waits for text delta', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': heartbeat\n\n');
    setTimeout(() => res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'), 20);
    setTimeout(() => res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\n'), 35);
    setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'), 50);
    setTimeout(() => res.end('data: [DONE]\n\n'), 65);
  });
  const proxy = await harness(upstream.url);
  try {
    const response = await proxy.post(true);
    assert.equal(response.status, 200);
    await response.text();
    const record = proxy.records.at(-1)!;
    assert.equal(response.headers.get('x-request-id'), record.id);
    assert.ok(record.firstByteMs !== null);
    assert.ok(record.firstEventMs !== null && record.firstEventMs >= record.firstByteMs);
    assert.ok(record.firstTextMs !== null && record.firstTextMs >= record.firstEventMs);
    assert.ok([record.firstByteMs, record.firstEventMs, record.firstTextMs].every(Number.isSafeInteger));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('request.completed is emitted once after a retried request is finalized with allowlisted metadata', async () => {
  let calls = 0;
  const upstream = await listen((_req, res) => {
    calls++;
    if (calls === 1) {
      res.socket?.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'private response' } }], usage: { total_tokens: 7 } }));
  });
  const proxy = await harness(upstream.url);
  proxy.config.upstreams.push({ ...proxy.config.upstreams[0], id: 'up_2', name: 'up_2' });
  proxy.config.routes?.[0]?.targets.push({ upstreamId: 'up_2', model: 'real' });
  try {
    const response = await proxy.post();
    assert.equal(response.status, 200);
    await response.text();

    assert.equal(calls, 2);
    const completed = proxy.events.filter((event) => event.type === 'request.completed');
    assert.equal(completed.length, 1);
    assert.ok(proxy.lifecycle.indexOf('persist:completed') < proxy.lifecycle.indexOf('event:request.completed'));
    assert.deepEqual(Object.keys(completed[0].data).sort(), [
      'durationMs',
      'finalUpstreamId',
      'model',
      'outcome',
      'protocol',
      'requestId',
      'source',
      'status',
    ]);
    assert.deepEqual(completed[0].data, {
      requestId: proxy.records.at(-1)?.id,
      outcome: 'completed',
      status: 200,
      model: 'public',
      protocol: 'openai',
      source: 'production',
      durationMs: completed[0].data.durationMs,
      finalUpstreamId: 'up_2',
    });
    const serialized = JSON.stringify(completed);
    for (const sensitive of ['sk-test', 'must-not-leak', 'temporary failure', 'private response', 'total_tokens'])
      assert.equal(serialized.includes(sensitive), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('tool-only SSE leaves firstTextMs unknown', async () => {
  const upstream = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\ndata: [DONE]\n\n');
  });
  const proxy = await harness(upstream.url);
  try {
    const response = await proxy.post(true);
    assert.equal(response.status, 200);
    await response.text();
    const record = proxy.records.at(-1)!;
    assert.ok(record.firstByteMs !== null);
    assert.ok(record.firstEventMs !== null);
    assert.equal(record.firstTextMs, null);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('custom-header upstream auth uses configured credential, not client-supplied header', async () => {
  let seenHeader: string | undefined;
  let seenAuthorization: string | undefined;
  let sent = 0;
  const upstream = await listen((req, res) => {
    sent++;
    seenHeader = req.headers['x-vendor-secret'] as string | undefined;
    seenAuthorization = req.headers.authorization;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  const proxy = await harness(upstream.url);
  try {
    proxy.config.upstreams[0].authMode = 'custom-header';
    proxy.config.upstreams[0].authHeaderName = 'X-Vendor-Secret';
    proxy.config.upstreams[0].apiKeys = ['configured-secret'];
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test',
        'x-vendor-secret': 'forged-client-value',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'public', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(seenHeader, 'configured-secret');
    assert.equal(seenAuthorization, undefined);
    assert.equal(sent, 1);

    proxy.config.upstreams[0].authHeaderName = 'Host';
    const invalid = await proxy.post();
    assert.equal(invalid.status, 502);
    assert.equal(sent, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
