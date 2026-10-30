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
import type { ProxyHandlerOptions } from '../../src/server/proxy.js';
import { proxyHandler } from '../../src/server/proxy.js';

/*
 * C1/C2 media endpoint integration coverage (docs/standalone-relay-capability-plan-2026-10-30.md):
 * rerank, completions, count_tokens, audio speech/transcriptions and images
 * generations ride the classic proxy end-to-end against a mock upstream —
 * same-family gating, opaque multipart forwarding, and verbatim binary
 * responses are the behaviors under test.
 */

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
  return {
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

interface ProxyHarness {
  port: number;
  baseUrl: string;
  logs: LogEntry[];
  close(): Promise<void>;
}

async function startProxy(config: Config, options: ProxyHandlerOptions = {}): Promise<ProxyHarness> {
  const tmpDir = path.join(os.tmpdir(), `mr-media-it-${randomUUID()}`);
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

const openaiUpstream = (mock: MockUpstream, models = ['custom-model']) => ({
  name: 'custom-openai',
  provider: 'custom',
  presetId: 'custom-openai',
  protocol: 'openai' as const,
  baseUrl: mock.baseUrl,
  endpoint: 'chat/completions',
  apiKeys: [],
  authMode: 'none' as const,
  models,
  enabled: true,
});

const anthropicUpstream = (mock: MockUpstream, models = ['custom-model']) => ({
  name: 'custom-anthropic',
  provider: 'custom',
  presetId: 'custom-anthropic',
  protocol: 'anthropic' as const,
  baseUrl: mock.baseUrl,
  endpoint: 'messages',
  apiKeys: [],
  authMode: 'none' as const,
  models,
  enabled: true,
});

const PROXY_HEADERS = {
  authorization: 'Bearer sk-test-12345',
  'content-type': 'application/json',
};

test('rerank proxies to an OpenAI-family upstream with the body passthrough', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: { id: 'rerank-1', results: [{ index: 0, relevance_score: 0.9 }], model: 'custom-model' },
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/rerank`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'custom-model', query: 'hello', documents: ['a', 'b'] }),
    });
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.results[0].relevance_score, 0.9);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]?.url, '/rerank');
    assert.equal(upstream.calls[0]?.body.query, 'hello');
    assert.deepEqual(upstream.calls[0]?.body.documents, ['a', 'b']);
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('rerank fails closed (422) against an Anthropic-family upstream', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {} }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/rerank`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'custom-model', query: 'x', documents: [] }),
    });
    assert.equal(response.status, 422);
    const json: any = await response.json();
    assert.equal(json.error.message, 'unsupported_capability');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('text completions proxy to an OpenAI-family upstream', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: { id: 'cmpl-1', object: 'text_completion', choices: [{ text: 'ok', index: 0, finish_reason: 'stop' }] },
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/completions`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'custom-model', prompt: 'hi', max_tokens: 8 }),
    });
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.object, 'text_completion');
    assert.equal(upstream.calls[0]?.url, '/completions');
    assert.equal(upstream.calls[0]?.body.prompt, 'hi');
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('messages count_tokens proxies to an Anthropic-family upstream', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: { input_tokens: 42 } }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        model: 'custom-model',
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    });
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.input_tokens, 42);
    assert.equal(upstream.calls[0]?.url, '/messages/count_tokens');
    assert.equal(upstream.calls[0]?.body.messages[0].content, 'hello world');
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('messages count_tokens fails closed (422) against an OpenAI-family upstream', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {} }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'custom-model', messages: [] }),
    });
    assert.equal(response.status, 422);
    const json: any = await response.json();
    assert.equal(json.error.message, 'unsupported_capability');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('audio speech forwards a binary upstream response verbatim', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
    body: 'FAKE-AUDIO-BYTES',
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'custom-model', input: 'say hi', voice: 'alloy' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await response.text(), 'FAKE-AUDIO-BYTES');
    assert.equal(upstream.calls[0]?.url, '/audio/speech');
    assert.equal(upstream.calls[0]?.body.input, 'say hi');
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('audio speech surfaces an upstream JSON error through the error path', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 400,
    body: { error: { message: 'voice not supported', type: 'invalid_request_error' } },
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'custom-model', input: 'x', voice: 'nope' }),
    });
    assert.equal(response.status, 400);
    const json: any = await response.json();
    assert.equal(json.error.message, 'voice not supported');
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

function multipartBody(boundary: string, fields: Array<[string, string]>, file: [string, string, string]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, value] of fields) {
    parts.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf-8'),
    );
  }
  const [fileName, fileField, content] = file;
  parts.push(
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="${fileField}"; filename="${fileName}"\r\ncontent-type: application/octet-stream\r\n\r\n${content}\r\n`,
      'utf-8',
    ),
  );
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  return Buffer.concat(parts);
}

test('audio transcriptions forward the multipart body opaquely and route by the form model field', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: { text: 'transcribed words' },
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  const boundary = 'test-boundary-7351';
  const body = multipartBody(boundary, [['model', 'custom-model']], ['audio.mp3', 'file', 'FAKE-AUDIO-CONTENT']);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.text, 'transcribed words');
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]?.url, '/audio/transcriptions');
    // Opaque forwarding: identical bytes and boundary survive the round trip.
    assert.equal(upstream.calls[0]?.rawBody, body.toString('utf-8'));
    assert.match(upstream.calls[0]?.headers['content-type'] ?? '', new RegExp(`boundary=${boundary}`));
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('audio transcriptions without a routable model field return 404 without touching the upstream', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: { text: 'x' } }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream)]));
  const boundary = 'test-boundary-9918';
  const body = multipartBody(boundary, [], ['audio.mp3', 'file', 'FAKE-AUDIO']);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-test-12345',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(response.status, 404);
    assert.equal(upstream.calls.length, 0);
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('images generations proxy the JSON request and response (C2 sync)', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: { created: 1700000000, data: [{ b64_json: 'AAAA', revised_prompt: 'a cat' }] },
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream, ['image-model'])]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'image-model', prompt: 'a cat', n: 1, size: '1024x1024' }),
    });
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.data[0].b64_json, 'AAAA');
    assert.equal(upstream.calls[0]?.url, '/images/generations');
    assert.equal(upstream.calls[0]?.body.prompt, 'a cat');
  } finally {
    await upstream.close();
    await proxy.close();
  }
});

test('images generations fail closed (422) against an Anthropic-family upstream', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: {} }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream, ['image-model'])]));
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ model: 'image-model', prompt: 'a cat' }),
    });
    assert.equal(response.status, 422);
    const json: any = await response.json();
    assert.equal(json.error.message, 'unsupported_capability');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await upstream.close();
    await proxy.close();
  }
});
