import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { KeyLimiter } from '../../src/limit/limiter.js';
import type { LogEntry } from '../../src/logger/types.js';
import { KeyPool } from '../../src/server/keyPool.js';
import { OAuthTokenResolver } from '../../src/server/oauth.js';
import { type ProxyHandlerOptions, proxyHandler } from '../../src/server/proxy.js';
import { ResponseOwnershipStore } from '../../src/storage/response-ownership.js';
import { SQLiteTelemetryStore } from '../../src/storage/telemetry-store.js';
import type { AttemptRecord, RequestRecord } from '../../src/telemetry/types.js';

interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
}

interface MockUpstream {
  port: number;
  baseUrl: string;
  calls: MockCall[];
  close(): Promise<void>;
}

type MockResponder = (
  req: MockCall,
) =>
  | { status: number; body: any; headers?: Record<string, string> }
  | Promise<{ status: number; body: any; headers?: Record<string, string> }>;

async function startMockUpstream(responder: MockResponder): Promise<MockUpstream> {
  const calls: MockCall[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    let parsed: any = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {}
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    const call: MockCall = {
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers,
      body: parsed,
      rawBody: raw,
    };
    calls.push(call);
    const out = await responder(call);
    res.writeHead(out.status, {
      'Content-Type': 'application/json',
      ...(out.headers ?? {}),
    });
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('listen failed');
  const port = addr.port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

interface ProxyHarness {
  port: number;
  baseUrl: string;
  logs: LogEntry[];
  close(): Promise<void>;
  configPath: string;
}

async function startProxy(config: Config, options: ProxyHandlerOptions = {}): Promise<ProxyHarness> {
  const tmpDir = path.join(os.tmpdir(), `mr-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const logs: LogEntry[] = [];
  const enqueue = (entry: LogEntry): void => {
    logs.push(entry);
  };
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, enqueue, options).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('proxy listen failed');
  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    logs,
    configPath,
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
    proxyKeys: [
      {
        name: 'test',
        key: 'sk-test-12345',
        enabled: true,
        createdAt: '2026-05-02T00:00:00Z',
      },
    ],
    upstreams,
  };
}

test('configured upstream request policies affect Anthropic and streaming OpenAI requests', async () => {
  const anthropic = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_policy',
      type: 'message',
      role: 'assistant',
      model: 'custom-model',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const anthropicProxy = await startProxy(
    baseConfig([
      {
        name: 'custom-anthropic',
        provider: 'custom',
        presetId: 'custom-anthropic',
        protocol: 'anthropic',
        baseUrl: anthropic.baseUrl,
        endpoint: 'messages',
        apiKeys: [],
        authMode: 'none',
        models: ['custom-model'],
        enabled: true,
        thinkingPolicy: 'force',
        autoCacheControl: true,
        anthropicBetas: ['configured-beta'],
        anthropicVersion: '2025-01-01',
      },
    ]),
  );

  const openai = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: 'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
  }));
  const openaiProxy = await startProxy(
    baseConfig([
      {
        name: 'custom-openai',
        provider: 'custom',
        presetId: 'custom-openai',
        protocol: 'openai',
        baseUrl: openai.baseUrl,
        endpoint: 'chat/completions',
        apiKeys: [],
        authMode: 'none',
        models: ['custom-model'],
        enabled: true,
        requestStreamUsage: true,
      },
    ]),
  );

  try {
    const anthropicResponse = await fetch(`${anthropicProxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'custom-model',
        max_tokens: 64,
        system: 'system',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    assert.equal(anthropicResponse.status, 200);
    await anthropicResponse.json();
    assert.equal(anthropic.calls[0]?.headers['anthropic-version'], '2025-01-01');
    assert.equal(anthropic.calls[0]?.headers['anthropic-beta'], 'configured-beta');
    assert.equal(anthropic.calls[0]?.body.thinking.type, 'enabled');
    assert.deepEqual(anthropic.calls[0]?.body.system[0].cache_control, { type: 'ephemeral' });

    const openaiResponse = await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'custom-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(openaiResponse.status, 200);
    await openaiResponse.text();
    assert.equal(openai.calls[0]?.body.stream_options.include_usage, true);
  } finally {
    await anthropicProxy.close();
    await anthropic.close();
    await openaiProxy.close();
    await openai.close();
  }
});

test('custom OpenAI /v1 prefix supports explicit no-auth, nonstream and optional usage', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'chatcmpl_local',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'ollama',
        provider: 'custom-openai',
        protocol: 'openai',
        baseUrl: `${upstream.baseUrl}/v1`,
        apiKeys: [],
        authMode: 'none',
        models: ['qwen2.5-coder:7b'],
        enabled: true,
      } as Config['upstreams'][number],
    ]),
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.calls[0].url, '/v1/chat/completions');
    assert.equal(upstream.calls[0].headers.authorization, undefined);
    assert.equal(upstream.calls[0].headers['x-api-key'], undefined);
    assert.equal(((await response.json()) as any).choices[0].message.content, 'ok');
    assert.equal(proxy.logs[0].request_tokens, 100);
    assert.equal(proxy.logs[0].response_tokens, 20);
    assert.equal(proxy.logs[0].cache_read_tokens, 60);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('custom OpenAI no-auth stream forwards chunks and leaves missing usage unknown', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'ollama',
        provider: 'custom-openai',
        protocol: 'openai',
        baseUrl: `${upstream.baseUrl}/v1`,
        apiKeys: [],
        authMode: 'none',
        models: ['qwen2.5-coder:7b'],
        enabled: true,
      } as Config['upstreams'][number],
    ]),
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen2.5-coder:7b', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"content":"hi"/);
    assert.equal(upstream.calls[0].headers.authorization, undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(proxy.logs[0].request_tokens, null);
    assert.equal(proxy.logs[0].response_tokens, null);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('native Responses continuation stays bound to its credential and fails closed when unavailable', async () => {
  let responseCount = 0;
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: `resp_test_${++responseCount}`,
      object: 'response',
      output: [],
      usage: { input_tokens: 2, output_tokens: 1 },
    },
  }));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-response-owner-'));
  const telemetry = new SQLiteTelemetryStore(path.join(tempDir, 'logs.sqlite'));
  await telemetry.init();
  const responseOwnership = new ResponseOwnershipStore(telemetry);
  const config = baseConfig([
    {
      name: 'responses',
      id: 'responses',
      provider: 'custom-responses',
      protocol: 'responses',
      baseUrl: `${upstream.baseUrl}/v1`,
      apiKeys: ['secret-a', 'secret-b'],
      credentialIds: ['cred-a', 'cred-b'],
      models: ['rmodel'],
      enabled: true,
    } as Config['upstreams'][number],
  ]);
  config.proxyKeys.push({ name: 'other', key: 'sk-other', enabled: true, createdAt: new Date().toISOString() });
  const keyPool = new KeyPool();
  keyPool.register('responses', [
    { credentialId: 'cred-a', key: 'secret-a' },
    { credentialId: 'cred-b', key: 'secret-b' },
  ]);
  const proxy = await startProxy(config, { responseOwnership, keyPool });
  const send = async (key: string, previous?: string) =>
    fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'rmodel', input: 'hi', ...(previous ? { previous_response_id: previous } : {}) }),
    });
  try {
    const first = await send('sk-test-12345');
    assert.equal(first.status, 200);
    await first.json();
    assert.equal(responseOwnership.get('resp_test_1', 'test')?.upstreamId, 'responses');
    assert.equal(responseOwnership.get('resp_test_1', 'test')?.credentialId, 'cred-a');
    const second = await send('sk-test-12345', 'resp_test_1');
    assert.equal(second.status, 200);
    await second.json();
    assert.equal(responseOwnership.get('resp_test_2', 'test')?.credentialId, 'cred-a');
    keyPool.markCooldown('responses', { credentialId: 'cred-a', key: 'secret-a' }, 60_000);
    const unavailable = await send('sk-test-12345', 'resp_test_2');
    assert.equal(unavailable.status, 409);
    const error = await unavailable.json();
    assert.equal(error.error.type, 'response_credential_unavailable');
    assert.equal(JSON.stringify(error).includes('secret-a'), false);
    assert.equal(JSON.stringify(error).includes('secret-b'), false);
    const other = await send('sk-other', 'resp_test_1');
    assert.equal(other.status, 409);
    assert.equal(upstream.calls.length, 2);
    assert.deepEqual(upstream.calls.map((call) => call.headers.authorization), [
      'Bearer secret-a',
      'Bearer secret-a',
    ]);
  } finally {
    await proxy.close();
    await upstream.close();
    await telemetry.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('quota admission precedes upstream and telemetry records one request and one attempt', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
  }));
  const requests: RequestRecord[] = [];
  const attempts: AttemptRecord[] = [];
  const events: string[] = [];
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u',
        provider: 'custom-openai',
        protocol: 'openai',
        baseUrl: `${upstream.baseUrl}/v1`,
        apiKeys: [],
        authMode: 'none',
        models: ['m'],
        enabled: true,
      } as Config['upstreams'][number],
    ]),
    {
      telemetryStore: {
        upsertRequest: async (r) => {
          requests.push({ ...r });
        },
        upsertAttempt: async (a) => {
          attempts.push({ ...a });
        },
      },
      quotaLedger: {
        admit: async () => {
          events.push('admit');
          assert.equal(upstream.calls.length, 0);
          return { allowed: true };
        },
        markAttemptSent: async () => {
          events.push('sent');
        },
        settle: async (_id, tokens) => {
          events.push(`settle:${tokens}`);
        },
      },
    },
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(requests.at(-1)?.state, 'completed');
    assert.equal(attempts.at(-1)?.usage?.inputTotal, 3);
    assert.equal(attempts.at(-1)?.usage?.outputTotal, 2);
    assert.equal(attempts.at(-1)?.requestId, requests[0].id);
    assert.deepEqual(events, ['admit', 'sent', 'settle:5']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('V2 exact routes beat earlier globs, then use explicit endpoint', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
  }));
  const cfg = baseConfig([
    {
      id: 'up-a',
      name: 'up-a',
      provider: 'custom-openai',
      protocol: 'openai',
      baseUrl: `${upstream.baseUrl}/gateway/team/v1?fixed=1`,
      endpoint: 'chat/completions',
      apiKeys: [],
      authMode: 'none',
      models: ['actual-model'],
      enabled: true,
    },
  ]);
  cfg.routes = [
    {
      id: 'wrong-protocol',
      name: 'wrong',
      enabled: true,
      clientProtocols: ['anthropic'],
      match: { kind: 'glob', value: 'alias*' },
      order: 0,
      publishedModels: ['alias'],
      targets: [{ upstreamId: 'up-a', model: 'wrong' }],
    },
    {
      id: 'selected',
      name: 'selected',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'exact', value: 'alias' },
      order: 1,
      publishedModels: ['alias'],
      targets: [{ upstreamId: 'up-a', model: 'actual-model' }],
    },
  ];
  const proxy = await startProxy(cfg, {
    getRuntimeSnapshot: () => ({
      routes: cfg.routes!,
      upstreams: cfg.upstreams as Array<Config['upstreams'][number] & { id: string }>,
    }),
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.calls[0].url, '/gateway/team/v1/chat/completions?fixed=1');
    assert.equal(upstream.calls[0].body.model, 'actual-model');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('V2 protocol-incompatible exact route returns 422 without falling back to a glob', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: { ok: true } }));
  const cfg = baseConfig([
    {
      id: 'up-a',
      name: 'up-a',
      provider: 'custom-openai',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      apiKeys: [],
      authMode: 'none',
      models: ['actual-model'],
      enabled: true,
    },
  ]);
  cfg.routes = [
    {
      id: 'glob-openai',
      name: 'glob',
      enabled: true,
      clientProtocols: ['openai'],
      match: { kind: 'glob', value: 'alias*' },
      order: 0,
      publishedModels: ['alias'],
      targets: [{ upstreamId: 'up-a', model: 'actual-model' }],
    },
    {
      id: 'exact-anthropic',
      name: 'exact',
      enabled: true,
      clientProtocols: ['anthropic'],
      match: { kind: 'exact', value: 'alias' },
      order: 10,
      publishedModels: ['alias'],
      targets: [{ upstreamId: 'up-a', model: 'actual-model' }],
    },
  ];
  const requests: RequestRecord[] = [];
  const proxy = await startProxy(cfg, {
    getRuntimeSnapshot: () => ({
      routes: cfg.routes!,
      upstreams: cfg.upstreams as Array<Config['upstreams'][number] & { id: string }>,
    }),
    telemetryStore: {
      upsertRequest: async (request) => requests.push({ ...request }),
      upsertAttempt: async (_attempt: AttemptRecord) => {},
    },
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as any).error.type, 'unsupported_client_protocol');
    assert.equal(upstream.calls.length, 0);
    assert.equal(requests.at(-1)?.state, 'rejected');
    assert.equal(requests.at(-1)?.finalHttpStatus, 422);
    assert.equal(requests.at(-1)?.routeId, 'exact-anthropic');
    assert.equal(proxy.logs.at(-1)?.error_message, 'unsupported_client_protocol');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('DeepSeek profile rotates a rejected credential without changing reasoning history', async () => {
  const upstream = await startMockUpstream((call) =>
    call.headers.authorization === 'Bearer stale'
      ? { status: 401, body: { error: { message: 'invalid key' } } }
      : {
          status: 200,
          body: {
            choices: [{ message: { role: 'assistant', content: 'ok', reasoning_content: 'reason' } }],
            usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 4, completion_tokens: 2 },
          },
        },
  );
  const pool = new KeyPool();
  pool.register('deepseek', ['stale', 'good']);
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'deepseek',
        provider: 'deepseek-chat',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeys: ['stale', 'good'],
        models: ['deepseek-reasoner'],
        enabled: true,
      },
    ]),
    { keyPool: pool },
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        messages: [
          { role: 'assistant', content: 'prior', reasoning_content: 'keep me' },
          { role: 'user', content: 'continue' },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[0].body.messages[0].reasoning_content, 'keep me');
    assert.equal(upstream.calls[1].headers.authorization, 'Bearer good');
    assert.equal(proxy.logs.at(-1)?.cache_read_tokens, 6);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Auth + path
// ---------------------------------------------------------------------------

test('integration: 404 for unknown path', async () => {
  const proxy = await startProxy(baseConfig([]));
  try {
    const res = await fetch(`${proxy.baseUrl}/foo`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345' },
      body: '{}',
    });
    assert.equal(res.status, 404);
  } finally {
    await proxy.close();
  }
});

test('integration: 401 anthropic envelope on bad auth (/v1/messages)', async () => {
  const proxy = await startProxy(baseConfig([]));
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    assert.equal(res.status, 401);
    const json: any = await res.json();
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'authentication_error');
  } finally {
    await proxy.close();
  }
});

test('integration: 401 openai envelope on bad auth (/v1/chat/completions)', async () => {
  const proxy = await startProxy(baseConfig([]));
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-key', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt', messages: [] }),
    });
    assert.equal(res.status, 401);
    const json: any = await res.json();
    assert.equal(json.error.type, 'authentication_error');
    assert.equal(json.error.code, null);
  } finally {
    await proxy.close();
  }
});

test('integration: default authMode sends Authorization Bearer header', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: ['claude'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer up-key');
    assert.equal(upstream.calls[0].headers['x-api-key'], undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: authMode x-api-key sends x-api-key header', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: ['claude'],
        enabled: true,
        authMode: 'x-api-key',
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers['x-api-key'], 'up-key');
    assert.equal(upstream.calls[0].headers.authorization, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: 404 with anthropic envelope when no upstream matches model', async () => {
  const proxy = await startProxy(baseConfig([]));
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-unknown', messages: [] }),
    });
    assert.equal(res.status, 404);
    const json: any = await res.json();
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'not_found_error');
    assert.equal(proxy.logs.length, 1);
    assert.equal(proxy.logs[0].client_protocol, 'anthropic');
    assert.equal(proxy.logs[0].upstream_protocol, null);
    assert.equal(proxy.logs[0].status_code, 404);
  } finally {
    await proxy.close();
  }
});

// ---------------------------------------------------------------------------
// Same-protocol pass-through
// ---------------------------------------------------------------------------

test('integration: anth→anth pass-through non-streaming, body.model rewritten', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-actual',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'anth-up',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: [],
        modelMap: { 'claude-3.5': 'claude-actual' },
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-3.5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.id, 'msg_1');
    assert.equal(json.content[0].text, 'hi');

    // Body forwarded with rewritten model
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].url, '/v1/messages');
    assert.equal(upstream.calls[0].body.model, 'claude-actual');

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(proxy.logs.length, 1);
    const log = proxy.logs[0];
    assert.equal(log.client_protocol, 'anthropic');
    assert.equal(log.upstream_protocol, 'anthropic');
    assert.equal(log.actual_model, 'claude-actual');
    assert.equal(log.request_model, 'claude-3.5');
    assert.equal(log.request_tokens, 5);
    assert.equal(log.response_tokens, 3);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: openai→openai pass-through non-streaming', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'cc_1',
      object: 'chat.completion',
      model: 'gpt-actual',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'oai-up',
        provider: 'openai',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: ['gpt-4o'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.id, 'cc_1');
    assert.equal(upstream.calls[0].url, '/v1/chat/completions');
    assert.equal(upstream.calls[0].body.model, 'gpt-4o');

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(proxy.logs[0].client_protocol, 'openai');
    assert.equal(proxy.logs[0].upstream_protocol, 'openai');
    assert.equal(proxy.logs[0].request_tokens, 7);
    assert.equal(proxy.logs[0].response_tokens, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Cross-protocol
// ---------------------------------------------------------------------------

test('integration: anth→openai non-streaming — body shape converted', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'cc_x',
      object: 'chat.completion',
      model: 'gpt-actual',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'translated' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'oai-up',
        provider: 'openai',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: ['claude-3.5'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3.5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    // Response should be in Anthropic shape
    assert.equal(json.type, 'message');
    assert.equal(json.role, 'assistant');
    assert(Array.isArray(json.content));
    assert.equal(json.content[0].type, 'text');
    assert.equal(json.content[0].text, 'translated');
    assert.equal(json.stop_reason, 'end_turn');

    // Upstream should have received OpenAI-shape body
    assert.equal(upstream.calls[0].url, '/v1/chat/completions');
    assert(Array.isArray(upstream.calls[0].body.messages));
    assert.equal(upstream.calls[0].body.messages[0].role, 'user');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: openai→anth non-streaming — body shape converted', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      model: 'claude-actual',
      content: [{ type: 'text', text: 'reverse' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'anth-up',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: ['gpt-4o'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    // Response should be OpenAI shape
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.choices[0].message.content, 'reverse');
    assert.equal(json.choices[0].finish_reason, 'stop');

    // Upstream got Anthropic-shape body at /v1/messages
    assert.equal(upstream.calls[0].url, '/v1/messages');
    assert(Array.isArray(upstream.calls[0].body.messages));
    assert.equal(upstream.calls[0].body.max_tokens, 1024); // default applied
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Failover
// ---------------------------------------------------------------------------

test('integration: failover — first upstream 503, second succeeds', async () => {
  // One mock acts as both upstreams; first call returns 503, second returns
  // 200. This makes the test deterministic regardless of selectUpstreams's
  // shuffle order — whichever candidate the proxy tries first gets the 503,
  // the other gets the 200.
  let callIdx = 0;
  const upstream = await startMockUpstream(() => {
    callIdx++;
    if (callIdx === 1) {
      return { status: 503, body: { error: { message: 'overloaded' } } };
    }
    return {
      status: 200,
      body: {
        id: 'msg_ok',
        type: 'message',
        role: 'assistant',
        model: 'claude-actual',
        content: [{ type: 'text', text: 'fallback' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  });

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k1'],
        models: ['claude'],
        enabled: true,
      },
      {
        name: 'u2',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k2'],
        models: ['claude'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.id, 'msg_ok');
    assert.equal(upstream.calls.length, 2);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(proxy.logs.length, 2);
    const statuses = proxy.logs.map((l) => l.status_code).sort();
    assert.deepEqual(statuses, [200, 503]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// 4xx no-retry
// ---------------------------------------------------------------------------

test('integration: upstream 4xx is forwarded as bridge-wrapped error, no retry', async () => {
  let calls = 0;
  const upstream = await startMockUpstream(() => {
    calls++;
    return {
      status: 400,
      body: { error: { message: 'bad input' } },
    };
  });
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k1'],
        models: ['claude'],
        enabled: true,
      },
      {
        name: 'u2',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k2'],
        models: ['claude'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    // Anthropic envelope
    assert.equal(json.type, 'error');
    assert.equal(json.error.message, 'bad input');
    // 4xx must NOT trigger failover even with two candidates.
    assert.equal(calls, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// ProxyKey whitelist + expiresAt
// ---------------------------------------------------------------------------

function configWithKey(
  key: Partial<import('../../src/config/types.js').ProxyKey>,
  upstreams: Config['upstreams'],
): Config {
  return {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [
      {
        name: 'alice',
        key: 'mrk_alice',
        enabled: true,
        createdAt: '2026-05-03T00:00:00Z',
        ...key,
      },
    ],
    upstreams,
  };
}

test('integration: key with allowedUpstreams blocks non-whitelisted upstream → 404', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {} }));
  const proxy = await startProxy(
    configWithKey({ allowedUpstreams: ['kimi-only'] }, [
      {
        name: 'ds-bridge',
        provider: 'deepseek',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude-sonnet-4-5'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mrk_alice',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    assert.equal(res.status, 404);
    const json: any = await res.json();
    assert.equal(json.error.type, 'not_found_error');
    assert.match(json.error.message, /not allowed for this proxy key/i);
    // Upstream must not have been called.
    assert.equal(upstream.calls.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: key with allowedModels blocks non-whitelisted model → 404', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {} }));
  const proxy = await startProxy(
    configWithKey({ allowedModels: ['claude-haiku-*'] }, [
      {
        name: 'kimi-code',
        provider: 'kimi',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude-sonnet-4-5'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mrk_alice',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }),
    });
    assert.equal(res.status, 404);
    const json: any = await res.json();
    assert.match(json.error.message, /not allowed for this proxy key/i);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: key with allowedModels hit reaches upstream → 200', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_ok',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    configWithKey({ allowedModels: ['claude-sonnet-*'] }, [
      {
        name: 'kimi-code',
        provider: 'kimi',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude-sonnet-4-5'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mrk_alice',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: expired key → 401 authentication_error', async () => {
  const proxy = await startProxy(configWithKey({ expiresAt: '2020-01-01T00:00:00Z' }, []));
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mrk_alice',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });
    assert.equal(res.status, 401);
    const json: any = await res.json();
    assert.equal(json.error.type, 'authentication_error');
  } finally {
    await proxy.close();
  }
});

test('integration: key with future expiresAt still authenticates', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_ok',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    configWithKey({ expiresAt: '2999-12-31T23:59:59Z' }, [
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer mrk_alice',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Slice 2: KeyLimiter + body size + redact
// ---------------------------------------------------------------------------

function alwaysOkAnthroUpstream() {
  return startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_ok',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  }));
}

test('integration: rpm exceeded → 429 rate_limit_error + Retry-After header', async () => {
  const upstream = await alwaysOkAnthroUpstream();
  const limiter = new KeyLimiter();
  const proxy = await startProxy(
    configWithKey({ rpm: 1 }, [
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { limiter },
  );
  try {
    const ok = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer mrk_alice', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(ok.status, 200);

    const blocked = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer mrk_alice', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'again' }] }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    const json: any = await blocked.json();
    assert.equal(json.type, 'error');
    assert.equal(json.error.type, 'rate_limit_error');

    const lastLog = proxy.logs[proxy.logs.length - 1];
    assert.equal(lastLog.status_code, 429);
    assert.equal(lastLog.error_message, 'rpm_exceeded');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: dailyTokens exhausted → 429 rate_limit_error', async () => {
  const upstream = await alwaysOkAnthroUpstream();
  const limiter = new KeyLimiter();
  // pre-seed usage so the very first reserve sees exhausted
  limiter.hydrate([{ keyName: 'alice', tokensUsed: 100 }]);
  const proxy = await startProxy(
    configWithKey({ dailyTokens: 100 }, [
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { limiter },
  );
  try {
    const blocked = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer mrk_alice', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(blocked.status, 429);
    const json: any = await blocked.json();
    assert.equal(json.error.type, 'rate_limit_error');
    const lastLog = proxy.logs[proxy.logs.length - 1];
    assert.equal(lastLog.error_message, 'daily_tokens_exceeded');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: successful request records usage to limiter', async () => {
  const upstream = await alwaysOkAnthroUpstream();
  const limiter = new KeyLimiter();
  const proxy = await startProxy(
    configWithKey({ dailyTokens: 1000 }, [
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { limiter },
  );
  try {
    const ok = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer mrk_alice', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(ok.status, 200);
    // mock returns input_tokens=10 + output_tokens=5
    assert.equal(limiter.getUsage('alice')?.dailyTokensUsed, 15);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: body over max-body-size → 413', async () => {
  const upstream = await alwaysOkAnthroUpstream();
  const proxy = await startProxy(
    configWithKey({}, [
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { maxBodyBytes: 256 },
  );
  try {
    const big = 'x'.repeat(2048);
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer mrk_alice', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: big }] }),
    });
    assert.equal(res.status, 413);
    const json: any = await res.json();
    assert.equal(json.type, 'error');
    const lastLog = proxy.logs[proxy.logs.length - 1];
    assert.equal(lastLog.status_code, 413);
    assert.equal(lastLog.error_message, 'body_too_large');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: error_message redacts upstream sk- key fragments', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 401,
    body: { error: { message: 'Invalid API key sk-leaked-AAA12345 detected', type: 'auth' } },
  }));
  const proxy = await startProxy(
    configWithKey({}, [
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['k'],
        models: ['claude'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer mrk_alice', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(res.status, 401);
    const lastLog = proxy.logs[proxy.logs.length - 1];
    assert.ok(lastLog.error_message);
    assert.ok(!lastLog.error_message!.includes('sk-leaked'));
    assert.ok(lastLog.error_message!.includes('sk-***'));
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Multi-key scheduling
// ---------------------------------------------------------------------------

test('integration: multi-key — first key 500, second key succeeds', async () => {
  const upstream = await startMockUpstream((call) => {
    if (call.headers.authorization === 'Bearer key-a') {
      return { status: 500, body: { error: { message: 'down' } } };
    }
    return {
      status: 200,
      body: {
        id: 'msg_ok',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  });

  const keyPool = new KeyPool({ cooldownMs: 60_000 });
  keyPool.register('u1', ['key-a', 'key-b']);

  const originalRandom = Math.random;
  Math.random = () => 0.99; // no swap in Fisher-Yates → key-a first

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-a', 'key-b'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { keyPool },
  );

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.id, 'msg_ok');

    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer key-a');
    assert.equal(upstream.calls[1].headers.authorization, 'Bearer key-b');

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(proxy.logs.length, 2);
    assert.equal(proxy.logs[0].status_code, 500);
    assert.equal(proxy.logs[1].status_code, 200);
  } finally {
    Math.random = originalRandom;
    await proxy.close();
    await upstream.close();
  }
});

test('integration: stable credential reconciliation preserves cooldown; legacy credentials still work', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_ok',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const keyPool = new KeyPool({ cooldownMs: 60_000 });
  keyPool.register('u1', [
    { credentialId: 'cred-a', key: 'key-a' },
    { credentialId: 'cred-b', key: 'key-b' },
  ]);
  keyPool.markCooldown('u1', 'key-a', 60_000);

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-a', 'key-b'],
        credentialIds: ['cred-a', 'cred-b'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { keyPool },
  );

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.json();
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer key-b');
    assert.deepEqual(keyPool.getAvailableKeys('u1'), ['key-b']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: duplicate credential keys retain exact identity through cooldown and telemetry', async () => {
  const keyPool = new KeyPool({ cooldownMs: 60_000 });
  const entries = [
    { credentialId: 'cred-a', key: 'shared-key' },
    { credentialId: 'cred-b', key: 'shared-key' },
  ];
  keyPool.register('u1', entries);
  const attempts: AttemptRecord[] = [];
  let callNo = 0;
  const responder = (call: MockCall) => {
    callNo++;
    return callNo === 1
      ? { status: 429, headers: { 'retry-after': '60' }, body: { error: { message: 'slow down' } } }
      : { status: 200, body: {
          id: 'msg_shared', type: 'message', role: 'assistant', model: 'claude',
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        } };
  };
  const mock = await startMockUpstream(responder);
  const proxy = await startProxy(baseConfig([{
    name: 'u1', provider: 'anthropic', protocol: 'anthropic', baseUrl: mock.baseUrl,
    apiKeys: ['shared-key', 'shared-key'], credentialIds: ['cred-a', 'cred-b'],
    models: ['claude'], enabled: true,
  }]), {
    keyPool,
    telemetryStore: {
      upsertRequest: async (_request: RequestRecord) => {},
      upsertAttempt: async (attempt) => { attempts.push({ ...attempt }); },
    },
  });
  try {
    for (const expected of [429, 200]) {
      const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: 'POST', headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(response.status, expected);
      await response.text();
    }
    assert.deepEqual(mock.calls.map((call) => call.headers.authorization), ['Bearer shared-key', 'Bearer shared-key']);
    assert.equal(attempts[1]?.credentialId, 'cred-a');
    assert.equal(attempts[3]?.credentialId, 'cred-b');
    assert.deepEqual(keyPool.getAvailableEntries('u1'), [entries[1]]);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('integration: legacy upstream key is never persisted in attempt telemetry', async () => {
  const upstreamSecret = 'legacy-upstream-secret-never-telemetry';
  const attempts: AttemptRecord[] = [];
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'msg_legacy', type: 'message', role: 'assistant', model: 'claude',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const keyPool = new KeyPool();
  const proxy = await startProxy(baseConfig([{
    name: 'legacy-upstream', provider: 'anthropic', protocol: 'anthropic', baseUrl: upstream.baseUrl,
    apiKeys: [upstreamSecret], models: ['claude'], enabled: true,
  }]), {
    keyPool,
    telemetryStore: {
      upsertRequest: async (_request: RequestRecord) => {},
      upsertAttempt: async (attempt) => { attempts.push({ ...attempt }); },
    },
  });
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(attempts.length > 0);
    assert.equal(attempts[0].credentialId, null);
    assert.equal(JSON.stringify(attempts).includes(upstreamSecret), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: multi-key — 4xx does not retry next key', async () => {
  let calls = 0;
  const upstream = await startMockUpstream(() => {
    calls++;
    return { status: 401, body: { error: { message: 'bad key' } } };
  });

  const keyPool = new KeyPool({ cooldownMs: 60_000 });
  keyPool.register('u1', ['key-a', 'key-b']);

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-a', 'key-b'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { keyPool },
  );

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    assert.equal(calls, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: multi-key — both keys 500, upstream-level failover', async () => {
  const upstream = await startMockUpstream((call) => {
    if (call.headers.authorization === 'Bearer key-c') {
      return {
        status: 200,
        body: {
          id: 'msg_ok',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'fallback' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
    }
    return { status: 500, body: { error: { message: 'down' } } };
  });

  const keyPool = new KeyPool({ cooldownMs: 60_000 });
  keyPool.register('u1', ['key-a', 'key-b']);
  keyPool.register('u2', ['key-c']);

  const originalRandom = Math.random;
  Math.random = () => 0.99; // no swap → key-a first for u1

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-a', 'key-b'],
        models: ['claude'],
        enabled: true,
      },
      {
        name: 'u2',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-c'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { keyPool },
  );

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.id, 'msg_ok');

    assert.equal(upstream.calls.length, 3);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer key-a');
    assert.equal(upstream.calls[1].headers.authorization, 'Bearer key-b');
    assert.equal(upstream.calls[2].headers.authorization, 'Bearer key-c');

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(proxy.logs.length, 3);
    const statuses = proxy.logs.map((l) => l.status_code).sort();
    assert.deepEqual(statuses, [200, 500, 500]);
  } finally {
    Math.random = originalRandom;
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// Responses API (Codex CLI)
// ---------------------------------------------------------------------------

test('integration: /v1/responses routes as openai protocol', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'openai',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeys: ['up-key'],
        models: ['gpt-5.4'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].url, '/v1/responses');
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer up-key');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: /v1/responses/compact uses the configured native Responses endpoint', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'custom-responses',
        protocol: 'responses',
        baseUrl: upstream.baseUrl,
        compactEndpoint: 'v1/responses/compact',
        apiKeys: ['up-key'],
        models: ['gpt-5.4'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].url, '/v1/responses/compact');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: passThroughAuth forwards client Authorization header', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const cfg = baseConfig([
    {
      name: 'u1',
      provider: 'openai',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      apiKeys: [],
      models: ['gpt-5.4'],
      enabled: true,
      passThroughAuth: true,
    },
  ]);
  // Proxy key equals the OAuth token so Codex CLI can authenticate
  cfg.proxyKeys[0].key = 'client-oauth-token';
  const proxy = await startProxy(cfg);
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer client-oauth-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer client-oauth-token');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: passThroughAuth with x-api-key authMode strips Bearer prefix', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const cfg = baseConfig([
    {
      name: 'u1',
      provider: 'openai',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      apiKeys: [],
      models: ['gpt-5.4'],
      enabled: true,
      passThroughAuth: true,
      authMode: 'x-api-key',
    },
  ]);
  cfg.proxyKeys[0].key = 'client-oauth-token';
  const proxy = await startProxy(cfg);
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer client-oauth-token', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers['x-api-key'], 'client-oauth-token');
    assert.equal(upstream.calls[0].headers.authorization, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: maxRetries limits total attempts across upstreams and keys', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 500,
    body: { error: { message: 'down' } },
  }));

  const keyPool = new KeyPool({ cooldownMs: 60_000 });
  keyPool.register('u1', ['key-a', 'key-b']);
  keyPool.register('u2', ['key-c']);

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-a', 'key-b'],
        models: ['claude'],
        enabled: true,
      },
      {
        name: 'u2',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-c'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { keyPool, maxRetries: 2 },
  );

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 502);
    assert.equal(upstream.calls.length, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: requestTimeoutMs aborts slow upstreams', async () => {
  const upstream = await startMockUpstream(async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { status: 200, body: { id: 'msg_late', content: [{ type: 'text', text: 'late' }] } };
  });

  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKeys: ['key-a'],
        models: ['claude'],
        enabled: true,
      },
    ]),
    { requestTimeoutMs: 50 },
  );

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 504);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'api_error');
    assert.equal(body.error.message, 'total_request_timeout');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('integration: oauth config resolves token dynamically', async () => {
  const tokenServer = await startMockUpstream((req) => {
    const params = new URLSearchParams(req.rawBody);
    assert.equal(params.get('grant_type'), 'client_credentials');
    assert.equal(params.get('client_id'), 'cid');
    assert.equal(params.get('client_secret'), 'csec');
    return { status: 200, body: { access_token: 'dynamic-tok', expires_in: 3600 } };
  });
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const oauthResolver = new OAuthTokenResolver();
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'u1',
        provider: 'openai',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeys: [],
        models: ['gpt-5.4'],
        enabled: true,
        oauth: {
          tokenUrl: `${tokenServer.baseUrl}/token`,
          clientId: 'cid',
          clientSecret: 'csec',
        },
      },
    ]),
    { oauthResolver },
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.4', input: 'hello' }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer dynamic-tok');
  } finally {
    await proxy.close();
    await upstream.close();
    await tokenServer.close();
  }
});
