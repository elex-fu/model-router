import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { proxyHandler } from '../../src/server/proxy.js';

test('opt-in live Ollama through V2 proxy, non-stream and stream', {
  skip: process.env.RUN_OLLAMA_SMOKE !== '1' && 'Set RUN_OLLAMA_SMOKE=1 for the local Ollama test',
  timeout: 120_000,
}, async () => {
  const tags = await fetch('http://127.0.0.1:11434/api/tags');
  assert.equal(tags.status, 200);
  const raw = defaultConfigV2('/tmp/ollama-smoke-config.json', 'ollama-smoke');
  raw.admin.enabled = false;
  raw.upstreams.push({
    id: 'ollama',
    name: 'Local Ollama',
    provider: 'custom',
    presetId: 'custom-openai',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'none' },
    credentials: [],
    models: [
      { id: 'qwen2.5-coder:7b', enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'verified' },
    ],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  raw.routes.push({
    id: 'coder',
    name: 'Coder',
    enabled: true,
    clientProtocols: ['openai'],
    match: { kind: 'exact', value: 'coder' },
    order: 0,
    publishedModels: ['coder'],
    targets: [{ upstreamId: 'ollama', model: 'qwen2.5-coder:7b' }],
  });
  const key = 'smoke-test-key';
  raw.proxyKeys.push({
    id: 'key-smoke',
    name: 'Smoke',
    enabled: true,
    createdAt: new Date().toISOString(),
    keyHash: createHash('sha256').update(key).digest('hex'),
    keyPrefix: 'smoke',
  });
  const runtime = await compileRuntimeConfig(raw);
  const store = new RuntimeConfigStore('/tmp/ollama-smoke-config.json', runtime);
  const logs: Array<{ status_code?: number | null }> = [];
  const server = http.createServer((req, res) => {
    void proxyHandler(
      req,
      res,
      store,
      (entry) => {
        logs.push(entry);
      },
      { maxRetries: 1, requestTimeoutMs: 100_000 },
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  try {
    for (const stream of [false, true]) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: 'coder',
          stream,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply exactly: OK' }],
        }),
      });
      if (response.status !== 200) assert.fail(`Proxy returned ${response.status}: ${await response.text()}`);
      if (stream) {
        const body = await response.text();
        assert.match(body, /data:/);
        assert.match(body, /\[DONE\]/);
      } else {
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: unknown;
        };
        assert.ok(body.choices?.[0]?.message?.content);
      }
    }
    assert.equal(logs.length, 2);
    assert.ok(logs.every((entry) => entry.status_code === 200));
  } finally {
    server.close();
    await once(server, 'close');
  }
});
