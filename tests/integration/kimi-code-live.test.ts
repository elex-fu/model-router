import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { compileRuntimeConfig, RuntimeConfigStore } from '../../src/config/v2-runtime.js';
import { defaultConfigV2 } from '../../src/config/v2-schema.js';
import { proxyHandler } from '../../src/server/proxy.js';

// Opt-in live smoke for the Kimi for Coding product line
// (https://api.kimi.com/coding/v1, anthropic protocol, x-api-key auth).
// Run with: npm run test:live:kimi-code
// Requires: KIMI_CODE_API_KEY in the environment (same variable the proxy reads).
const enabled = process.env.RUN_KIMI_CODE_SMOKE === '1';
const credential = process.env.KIMI_CODE_API_KEY;
const model = process.env.KIMI_CODE_LIVE_MODEL ?? 'kimi-for-coding';
const skipReason = !enabled
  ? 'Use npm run test:live:kimi-code to opt in'
  : !credential
    ? 'Set KIMI_CODE_API_KEY to run the live smoke'
    : false;

interface UpstreamDefinition {
  id: string;
  name: string;
  provider: string;
  protocol: string;
  enabled: boolean;
  baseUrl: string;
  endpoints: { generate: string };
  auth: { mode: string };
  credentials: Array<{ id: string; label: string; enabled: boolean; secret: { type: 'env'; name: string } }>;
  models: Array<{ id: string; enabled: boolean; capabilities: { text: string }; capabilitiesSource: string }>;
  priority: number;
  sortIndex: number;
  policy: Record<string, never>;
}

const upstream: UpstreamDefinition = {
  id: 'kimi-code-live',
  name: 'Kimi Code live smoke',
  provider: 'kimi',
  protocol: 'anthropic',
  enabled: true,
  baseUrl: 'https://api.kimi.com/coding/v1',
  endpoints: { generate: 'messages' },
  auth: { mode: 'x-api-key' },
  credentials: [
    {
      id: 'kimi-code-live-key',
      label: 'Live smoke',
      enabled: true,
      secret: { type: 'env', name: 'KIMI_CODE_API_KEY' },
    },
  ],
  models: [{ id: model, enabled: true, capabilities: { text: 'supported' }, capabilitiesSource: 'manual' }],
  priority: 0,
  sortIndex: 0,
  policy: {},
};

const PROXY_KEY = 'local-kimi-code-live-smoke-key';

async function startProxy(configPath: string) {
  const raw = defaultConfigV2(configPath, 'kimi-code-live-smoke');
  raw.admin.enabled = false;
  raw.upstreams.push(upstream);
  const route = (id: string, clientProtocols: string[]) => ({
    id,
    name: id,
    enabled: true,
    clientProtocols,
    match: { kind: 'exact' as const, value: id },
    order: 0,
    publishedModels: [id],
    targets: [{ upstreamId: upstream.id, model }],
  });
  raw.routes.push(route('kimi-code-a2a', ['anthropic']), route('kimi-code-o2a', ['openai']));
  raw.proxyKeys.push({
    name: 'Live smoke',
    enabled: true,
    createdAt: new Date().toISOString(),
    keyHash: createHash('sha256').update(PROXY_KEY).digest('hex'),
    keyPrefix: 'local-kimi-code-live',
  });
  const runtime = await compileRuntimeConfig(raw);
  const store = new RuntimeConfigStore(configPath, runtime);
  const server = http.createServer((req, res) => {
    void proxyHandler(req, res, store, () => {}, { maxRetries: 1, requestTimeoutMs: 30_000 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, port: address.port };
}

test('Kimi Code live smoke through the proxy: anthropic same-protocol (non-stream + stream)', {
  skip: skipReason,
  timeout: 90_000,
}, async () => {
  const maxTokens = Number(process.env.KIMI_LIVE_MAX_OUTPUT_TOKENS ?? 16);
  assert.ok(
    Number.isSafeInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 32,
    'KIMI_LIVE_MAX_OUTPUT_TOKENS must be an integer from 1 to 32',
  );

  const configPath = `/tmp/kimi-code-live-smoke-${process.pid}.json`;
  const { server, port } = await startProxy(configPath);
  try {
    // Non-streaming: content blocks + real usage must come back.
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(35_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': PROXY_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'kimi-code-a2a',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      }),
    });
    assert.equal(response.status, 200, `Kimi Code proxy response status: ${response.status}`);
    const body = (await response.json()) as {
      content?: Array<{ type: string }>;
      usage?: { output_tokens?: number };
    };
    assert.ok(Array.isArray(body.content) && body.content.length > 0, 'Expected content blocks');
    assert.ok(typeof body.usage?.output_tokens === 'number', 'Expected usage.output_tokens');

    // Streaming: the SSE event chain must be complete from message_start to message_stop.
    const streamResponse = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(35_000),
      headers: {
        'content-type': 'application/json',
        'x-api-key': PROXY_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'kimi-code-a2a',
        max_tokens: maxTokens,
        stream: true,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      }),
    });
    assert.equal(streamResponse.status, 200, `Kimi Code stream response status: ${streamResponse.status}`);
    const events = [...(await streamResponse.text()).matchAll(/^event:\s*(\S+)$/gm)].map((m) => m[1]);
    assert.ok(events.includes('message_start'), `Expected message_start in SSE events: ${events.join(',')}`);
    assert.ok(events.includes('message_stop'), `Expected message_stop in SSE events: ${events.join(',')}`);
    assert.ok(
      events.includes('content_block_delta'),
      `Expected content_block_delta in SSE events: ${events.join(',')}`,
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Kimi Code live smoke through the proxy: openai cross-protocol bridge', {
  skip: skipReason,
  timeout: 45_000,
}, async () => {
  const maxTokens = Number(process.env.KIMI_LIVE_MAX_OUTPUT_TOKENS ?? 16);
  assert.ok(
    Number.isSafeInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 32,
    'KIMI_LIVE_MAX_OUTPUT_TOKENS must be an integer from 1 to 32',
  );

  const configPath = `/tmp/kimi-code-live-smoke-o2a-${process.pid}.json`;
  const { server, port } = await startProxy(configPath);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(35_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PROXY_KEY}`,
      },
      body: JSON.stringify({
        model: 'kimi-code-o2a',
        max_completion_tokens: maxTokens,
        messages: [{ role: 'user', content: 'Reply OK.' }],
      }),
    });
    assert.equal(response.status, 200, `Kimi Code bridge response status: ${response.status}`);
    const body = (await response.json()) as {
      choices?: Array<{ message?: unknown }>;
      usage?: { total_tokens?: number };
    };
    assert.ok(body.choices?.[0]?.message, 'Expected a Kimi Code chat completion choice');
    assert.ok(typeof body.usage?.total_tokens === 'number', 'Expected usage.total_tokens');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
