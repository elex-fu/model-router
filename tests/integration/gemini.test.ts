import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import type { LogEntry } from '../../src/logger/types.js';
import { proxyHandler } from '../../src/server/proxy.js';
import { parseSseStream } from '../../src/protocol/sse.js';

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

async function startProxy(config: Config, options: { maxBodyBytes?: number } = {}): Promise<ProxyHarness> {
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
    server: { port: 0, bindAddress: '127.0.0.1', logFlushIntervalMs: 100, logBatchSize: 10 },
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
// Gemini bridge integration tests
// ---------------------------------------------------------------------------

test('proxies anthropic client to gemini upstream (non-streaming)', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    },
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'gemini',
        provider: 'google',
        protocol: 'gemini',
        baseUrl: upstream.baseUrl,
        apiKeys: ['g-xxx'],
        models: ['gemini-2.5-pro'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-12345' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
      }),
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.content[0].text, 'ok');
    assert.equal(json.role, 'assistant');
    assert.equal(json.type, 'message');
    assert.equal(json.usage.input_tokens, 5);
    assert.equal(json.usage.output_tokens, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('proxies anthropic client to gemini upstream (streaming)', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body:
      'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n' +
      // Gemini terminates with a candidate finishReason, not OpenAI's [DONE].
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n',
  }));
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'gemini',
        provider: 'google',
        protocol: 'gemini',
        baseUrl: upstream.baseUrl,
        apiKeys: ['g-xxx'],
        models: ['gemini-2.5-pro'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-12345' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 100,
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body);
    const events: any[] = [];
    for await (const frame of parseSseStream(res.body)) {
      assert.ok(frame.data && frame.data !== '[DONE]', 'Anthropic frames carry JSON events');
      const event = JSON.parse(frame.data);
      assert.equal(frame.event, event.type, 'SSE event names must match the Anthropic payload type');
      events.push(event);
    }
    assert.deepEqual(events.map(event => event.type), [
      'message_start',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    assert.equal(events[0].message.role, 'assistant');
    const deltas = events.filter(event => event.type === 'content_block_delta');
    assert.equal(deltas[0].delta.text, 'hello');
    assert.equal(deltas.map(event => event.delta.text).join(''), 'hello world');
    assert.deepEqual(events.filter(event => event.type === 'content_block_start').map(event => event.index), [0, 1]);
    assert.deepEqual(events.filter(event => event.type === 'content_block_stop').map(event => event.index), [0, 1]);
    const terminal = events[events.length - 2];
    assert.equal(terminal.delta.stop_reason, 'end_turn');
    assert.deepEqual(terminal.usage, { input_tokens: 3, output_tokens: 2 });

  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('transforms request body to gemini format', async () => {
  let capturedBody: any;
  const upstream = await startMockUpstream((req) => {
    capturedBody = req.body;
    return {
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: 'ack' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      },
    };
  });
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'gemini',
        provider: 'google',
        protocol: 'gemini',
        baseUrl: upstream.baseUrl,
        apiKeys: ['g-xxx'],
        models: ['gemini-2.5-pro'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-12345' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        max_tokens: 50,
        temperature: 0.7,
        top_p: 0.9,
        system: 'be nice',
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(capturedBody);
    assert.equal(capturedBody.contents.length, 2);
    assert.equal(capturedBody.contents[0].role, 'user');
    assert.equal(capturedBody.contents[1].role, 'model');
    assert.equal(capturedBody.generationConfig.maxOutputTokens, 50);
    assert.equal(capturedBody.generationConfig.temperature, 0.7);
    assert.equal(capturedBody.generationConfig.topP, 0.9);
    assert.ok(capturedBody.systemInstruction);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('sends x-goog-api-key header for gemini upstream', async () => {
  let capturedHeaders: Record<string, string> = {};
  const upstream = await startMockUpstream((req) => {
    capturedHeaders = req.headers;
    return {
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: 'ack' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      },
    };
  });
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'gemini',
        provider: 'google',
        protocol: 'gemini',
        baseUrl: upstream.baseUrl,
        apiKeys: ['g-xxx'],
        models: ['gemini-2.5-pro'],
        enabled: true,
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-12345' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedHeaders['x-goog-api-key'], 'g-xxx');
    assert.ok(!capturedHeaders['authorization']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('sends x-goog-api-key header when authMode is google', async () => {
  let capturedHeaders: Record<string, string> = {};
  const upstream = await startMockUpstream((req) => {
    capturedHeaders = req.headers;
    return {
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: 'ack' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      },
    };
  });
  const proxy = await startProxy(
    baseConfig([
      {
        name: 'gemini',
        provider: 'google',
        protocol: 'openai',
        baseUrl: upstream.baseUrl,
        apiKeys: ['g-xxx'],
        models: ['gemini-2.5-pro'],
        enabled: true,
        authMode: 'google',
      },
    ]),
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-12345' },
      body: JSON.stringify({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedHeaders['x-goog-api-key'], 'g-xxx');
    assert.ok(!capturedHeaders['authorization']);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
