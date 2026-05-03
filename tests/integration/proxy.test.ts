import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ConfigStore } from '../../src/config/store.js';
import { proxyHandler } from '../../src/server/proxy.js';
import type { Config } from '../../src/config/types.js';
import type { LogEntry } from '../../src/logger/types.js';
import { KeyLimiter } from '../../src/limit/limiter.js';
import { KeyPool } from '../../src/server/keyPool.js';

interface MockCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

interface MockUpstream {
  port: number;
  baseUrl: string;
  calls: MockCall[];
  close(): Promise<void>;
}

type MockResponder = (req: MockCall) =>
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

interface ProxyHarness {
  port: number;
  baseUrl: string;
  logs: LogEntry[];
  close(): Promise<void>;
  configPath: string;
}

async function startProxy(
  config: Config,
  options: { limiter?: KeyLimiter; maxBodyBytes?: number; keyPool?: KeyPool } = {}
): Promise<ProxyHarness> {
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
        })
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
    ])
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
    ])
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
    ])
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
    ])
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
    ])
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
    ])
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
  upstreams: Config['upstreams']
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
    ])
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
    ])
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
    ])
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
  const proxy = await startProxy(
    configWithKey(
      { expiresAt: '2020-01-01T00:00:00Z' },
      []
    )
  );
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
    ])
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
    { limiter }
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
    { limiter }
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
    { limiter }
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
    { maxBodyBytes: 256 }
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
    ])
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
    { keyPool }
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
    { keyPool }
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
    { keyPool }
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
