import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { proxyHandler } from '../../src/server/proxy.js';

const enabled = process.env.RUN_KIMI_SMOKE === '1';
const credential = process.env.KIMI_LIVE_API_KEY;
const model = process.env.KIMI_LIVE_MODEL;

test('explicit opt-in Kimi live smoke through the proxy', {
  skip: !enabled
    ? 'Use npm run test:live:kimi to opt in'
    : !credential || !model
      ? 'Set KIMI_LIVE_API_KEY and KIMI_LIVE_MODEL to run the live smoke'
      : false,
  timeout: 45_000,
}, async () => {
  const maxOutputTokens = Number(process.env.KIMI_LIVE_MAX_OUTPUT_TOKENS ?? 16);
  assert.ok(
    Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 1 && maxOutputTokens <= 32,
    'KIMI_LIVE_MAX_OUTPUT_TOKENS must be an integer from 1 to 32',
  );

  const raw = defaultConfigV2('/tmp/kimi-live-smoke-config.json', 'kimi-live-smoke');
  raw.admin.enabled = false;
  raw.upstreams.push({
    id: 'kimi-live',
    name: 'Kimi live smoke',
    provider: 'kimi',
    protocol: 'openai',
    enabled: true,
    baseUrl: 'https://api.moonshot.cn/v1',
    endpoints: { generate: 'chat/completions' },
    auth: { mode: 'bearer' },
    credentials: [
      { id: 'kimi-live-key', label: 'Live smoke', enabled: true, secret: { type: 'env', name: 'KIMI_LIVE_API_KEY' } },
    ],
    models: [{ id: model!, enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
    priority: 0,
    sortIndex: 0,
    policy: {},
  });
  raw.routes.push({
    id: 'kimi-live-route',
    name: 'Kimi live smoke',
    enabled: true,
    clientProtocols: ['openai'],
    match: { kind: 'exact', value: 'live-smoke' },
    order: 0,
    publishedModels: ['live-smoke'],
    targets: [{ upstreamId: 'kimi-live', model: model! }],
  });
  const proxyKey = 'local-kimi-live-smoke-key';
  raw.proxyKeys.push({
    id: 'kimi-live-proxy-key',
    name: 'Live smoke',
    enabled: true,
    createdAt: new Date().toISOString(),
    keyHash: createHash('sha256').update(proxyKey).digest('hex'),
    keyPrefix: 'local-kimi-live',
  });
  const runtime = await compileRuntimeConfig(raw);
  const store = new RuntimeConfigStore('/tmp/kimi-live-smoke-config.json', runtime);
  const server = http.createServer((req, res) => {
    void proxyHandler(req, res, store, () => {}, { maxRetries: 1, requestTimeoutMs: 30_000 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(35_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${proxyKey}`,
      },
      body: JSON.stringify({
        model: 'live-smoke',
        stream: false,
        max_completion_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      }),
    });
    assert.equal(response.status, 200, `Kimi proxy response status: ${response.status}`);
    const body = (await response.json()) as { choices?: Array<{ message?: unknown }> };
    assert.ok(body.choices?.[0]?.message, 'Expected a Kimi Chat completion choice');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
