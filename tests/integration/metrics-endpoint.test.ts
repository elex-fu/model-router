import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { createMetricsRegistry } from '../../src/server/metrics.js';
import { proxyHandler } from '../../src/server/proxy.js';

/*
 * O4 (docs/standalone-relay-capability-plan-2026-10-30.md): end-to-end
 * /metrics coverage — dark when the registry is absent, gated by the optional
 * bearer token, and populated by real request traffic through the proxy.
 */

async function startProxy(
  config: Config,
  options: { metrics?: ReturnType<typeof createMetricsRegistry>; metricsAuthToken?: string } = {},
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const tmpDir = path.join(os.tmpdir(), `mr-metrics-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, () => {}, options).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          err ? reject(err) : resolve();
        }),
      ),
  };
}

function baseConfig(upstreams: Config['upstreams']): Config {
  return {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [{ name: 'test', key: 'sk-test-12345', enabled: true, createdAt: '2026-05-02T00:00:00Z' }],
    upstreams,
  };
}

const UPSTREAM_RES = JSON.stringify({
  id: 'chatcmpl_1',
  object: 'chat.completion',
  created: 123,
  model: 'custom-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

function startChatUpstream(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(UPSTREAM_RES);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const CHAT_REQUEST = {
  method: 'POST' as const,
  headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'custom-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
};

test('/metrics stays 404 when no registry is configured', async () => {
  const proxy = await startProxy(baseConfig([]));
  try {
    const response = await fetch(`${proxy.baseUrl}/metrics`);
    assert.equal(response.status, 404);
  } finally {
    await proxy.close();
  }
});

test('/metrics is gated by the optional bearer token', async () => {
  const proxy = await startProxy(baseConfig([]), {
    metrics: createMetricsRegistry(),
    metricsAuthToken: 'x'.repeat(24),
  });
  try {
    const denied = await fetch(`${proxy.baseUrl}/metrics`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${proxy.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${'x'.repeat(24)}` },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await proxy.close();
  }
});

test('request traffic populates the exposition: counters, tokens, in-flight drains to zero', async () => {
  const upstream = await startChatUpstream();
  const registry = createMetricsRegistry();
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'custom-openai',
        provider: 'custom',
        presetId: 'custom-openai',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        endpoint: 'chat/completions',
        apiKeys: [],
        authMode: 'none',
        models: ['custom-model'],
        enabled: true,
      },
    ]),
    { metrics: registry },
  );
  try {
    // Two successful chat requests + one 401 (no token) + one 404 (bad path).
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, CHAT_REQUEST);
      assert.equal(response.status, 200);
    }
    await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      ...CHAT_REQUEST,
      headers: { ...CHAT_REQUEST.headers, authorization: 'Bearer sk-wrong' },
    });
    await fetch(`${proxy.baseUrl}/v1/nonexistent`, CHAT_REQUEST);

    const exposition = await fetch(`${proxy.baseUrl}/metrics`);
    assert.equal(exposition.status, 200);
    assert.match(exposition.headers.get('content-type') ?? '', /^text\/plain/);
    const text = await exposition.text();

    assert.match(text, /# TYPE model_router_requests_total counter/);
    // 2 success (proto=openai, upstream=custom-openai) + 1 auth rejection (upstream=none).
    assert.match(text, /model_router_requests_total\{proto="openai",status="200",upstream="custom-openai"\} 2/);
    assert.match(text, /model_router_requests_total\{proto="openai",status="401",upstream="none"\} 1/);
    // 4 tokens in + 2 out per successful request, twice.
    assert.match(text, /model_router_tokens_total\{direction="input",upstream="custom-openai"\} 8/);
    assert.match(text, /model_router_tokens_total\{direction="output",upstream="custom-openai"\} 4/);
    // Histogram samples recorded for every completed request.
    assert.match(
      text,
      /model_router_request_duration_ms_bucket\{le="\+Inf",proto="openai",upstream="custom-openai"\} 2/,
    );
    // All requests finalized: in-flight back to zero.
    assert.match(text, /model_router_in_flight 0/);
    // Bucket monotonicity: the +Inf bucket is the largest for its series.
    const inf = Number(/_bucket\{le="\+Inf",proto="openai",upstream="custom-openai"\} (\d+)/.exec(text)?.[1]);
    const first = Number(/_bucket\{le="5",proto="openai",upstream="custom-openai"\} (\d+)/.exec(text)?.[1] ?? '0');
    assert.ok(inf >= first);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
