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

async function startProxy(config: Config): Promise<ProxyHarness> {
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
    proxyHandler(req, res, store, enqueue).catch((err) => {
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
        apiKey: 'up-key',
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
        apiKey: 'up-key',
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
        apiKey: 'up-key',
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
        apiKey: 'up-key',
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
        apiKey: 'k1',
        models: ['claude'],
        enabled: true,
      },
      {
        name: 'u2',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKey: 'k2',
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
        apiKey: 'k1',
        models: ['claude'],
        enabled: true,
      },
      {
        name: 'u2',
        provider: 'anthropic',
        protocol: 'anthropic',
        baseUrl: upstream.baseUrl,
        apiKey: 'k2',
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
