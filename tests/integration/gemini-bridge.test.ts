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
import { parseSseStream } from '../../src/protocol/sse.js';
import { proxyHandler } from '../../src/server/proxy.js';

// ---------------------------------------------------------------------------
// Gemini native client entry (`/v1beta/models/{model}:generateContent` and
// `:streamGenerateContent?alt=sse`) acceptance matrix.
//
// The classic inbound wiring was fixed as part of C0 (2026-10-30): model and
// streaming intent are derived from the URL path, gemini upstreams are
// addressed through the model/action URL path, gemini-inbound bridges are
// state-initialized from the client URL, and UnsupportedBridgeFeatureError
// maps to 422. Standard Gemini wire-format clients now route correctly.
// ---------------------------------------------------------------------------

const MODEL = 'gemini-2.5-pro';
const PROXY_KEY = 'sk-test-12345';

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
    proxyHandler(req, res, store, enqueue, {}).catch((err) => {
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
        key: PROXY_KEY,
        enabled: true,
        createdAt: '2026-05-02T00:00:00Z',
      },
    ],
    upstreams,
  };
}

function geminiUpstream(baseUrl: string): Config['upstreams'][number] {
  return {
    name: 'gemini-up',
    provider: 'google',
    protocol: 'gemini',
    baseUrl,
    apiKeys: ['g-key-1'],
    models: [MODEL],
    enabled: true,
  };
}

function anthropicUpstream(baseUrl: string): Config['upstreams'][number] {
  return {
    name: 'anthropic-up',
    provider: 'custom',
    protocol: 'anthropic',
    baseUrl,
    apiKeys: ['a-key-1'],
    models: [MODEL],
    enabled: true,
  };
}

function openaiUpstream(
  baseUrl: string,
  authMode?: Config['upstreams'][number]['authMode'],
): Config['upstreams'][number] {
  return {
    name: 'openai-up',
    provider: 'custom',
    protocol: 'openai',
    baseUrl,
    apiKeys: ['g-key-1'],
    models: [MODEL],
    enabled: true,
    ...(authMode ? { authMode } : {}),
  };
}

function responsesUpstream(baseUrl: string): Config['upstreams'][number] {
  return {
    name: 'responses-up',
    provider: 'custom',
    protocol: 'responses',
    baseUrl,
    apiKeys: ['r-key-1'],
    models: [MODEL],
    enabled: true,
  };
}

async function postGemini(proxy: ProxyHarness, clientPath: string, body: unknown): Promise<Response> {
  return fetch(`${proxy.baseUrl}${clientPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${PROXY_KEY}` },
    body: JSON.stringify(body),
  });
}

const GEMINI_JSON_RESPONSE = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
};

const ANTHROPIC_JSON_RESPONSE = {
  id: 'msg_ant_1',
  type: 'message',
  role: 'assistant',
  model: 'ant-model',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 },
};

const OPENAI_JSON_RESPONSE = {
  id: 'chatcmpl_oai_1',
  object: 'chat.completion',
  created: 123,
  model: 'oai-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } },
};

const RESPONSES_JSON_RESPONSE = {
  id: 'resp_oai_1',
  object: 'response',
  created_at: 123,
  model: 'resp-model',
  status: 'completed',
  output: [
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
};

const GEMINI_SSE =
  'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}\n\n' +
  'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n';

const ANTHROPIC_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ant_1","type":"message","role":"assistant","model":"ant-model","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":3,"output_tokens":2}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const OPENAI_SSE =
  'data: {"id":"chunk_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chunk_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

const RESPONSES_SSE =
  'data: {"type":"response.created","response":{"id":"resp_1","model":"resp-model"}}\n\n' +
  'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_0","type":"message","role":"assistant","content":[]}}\n\n' +
  'data: {"type":"response.content_part.added","item_id":"msg_0","output_index":0,"part":{"type":"output_text","text":""}}\n\n' +
  'data: {"type":"response.output_text.delta","item_id":"msg_0","output_index":0,"delta":"hello"}\n\n' +
  'data: {"type":"response.output_text.done","item_id":"msg_0","output_index":0,"text":"hello"}\n\n' +
  'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_0","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}\n\n' +
  'data: {"type":"response.completed","response":{"id":"resp_1","model":"resp-model","status":"completed","output":[{"id":"msg_0","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":3,"output_tokens":2}}}\n\n';

async function readSseJson(response: Response): Promise<any[]> {
  assert.ok(response.body, 'SSE response must have a body');
  const events: any[] = [];
  for await (const frame of parseSseStream(response.body)) {
    assert.ok(frame.data && frame.data !== '[DONE]', 'Gemini SSE frames carry JSON payloads');
    events.push(JSON.parse(frame.data));
  }
  return events;
}

// ---------------------------------------------------------------------------
// gemini client -> gemini upstream (passthrough)
// ---------------------------------------------------------------------------

test('gemini client to gemini upstream: generateContent passthrough + google auth header', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: GEMINI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.candidates[0].content.parts[0].text, 'ok');
    assert.equal(json.candidates[0].finishReason, 'STOP');
    assert.equal(json.usageMetadata.promptTokenCount, 5);
    assert.equal(json.usageMetadata.candidatesTokenCount, 2);
    // Request body passes through in the gemini wire shape.
    assert.equal(upstream.calls[0]?.method, 'POST');
    assert.equal(upstream.calls[0]?.body.contents[0].parts[0].text, 'hi');
    assert.equal(upstream.calls[0]?.body.generationConfig.maxOutputTokens, 64);
    // Google auth: x-goog-api-key with the configured key, no bearer header.
    assert.equal(upstream.calls[0]?.headers['x-goog-api-key'], 'g-key-1');
    assert.equal(upstream.calls[0]?.headers['authorization'], undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client to gemini upstream: streamGenerateContent SSE passthrough', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: GEMINI_SSE,
  }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      model: MODEL,
      stream: true,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /^text\/event-stream/);
    const events = await readSseJson(res);
    assert.equal(events.length, 2);
    assert.equal(events[0].candidates[0].content.parts[0].text, 'hello');
    assert.equal(events[1].candidates[0].finishReason, 'STOP');
    assert.equal(events[1].usageMetadata.candidatesTokenCount, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// FIXED (C0): model and streaming intent are now derived from the /v1beta
// URL path, so standard Gemini wire-format clients route correctly.
test('gemini client with model in URL only (standard Gemini wire format)', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: GEMINI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.candidates[0].content.parts[0].text, 'ok');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// KNOWN-BUG: src/server/proxy.ts:756 + :1214 — the model is never extracted
// from the `/v1beta` URL and streaming is detected only via
// `parsedBody.stream === true`, never via the `:streamGenerateContent` URL
// path. Expected: 200 text/event-stream frames. Actual: 404 not_found_error
// (model missing); with the model duplicated into the body the response is
// still non-streaming JSON (the SSE body then fails to parse as 502
// "Invalid upstream JSON").
test('gemini client streaming via :streamGenerateContent URL only', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: GEMINI_SSE,
  }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /^text\/event-stream/);
    const events = await readSseJson(res);
    assert.equal(events.length, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// KNOWN-BUG: src/server/proxy.ts:2017-2033 builds the upstream URL from
// `upstream.endpoint ?? profile.endpoint` and never calls
// `bridge.rewriteUrlPath()`; src/providers/profiles.ts:125 has no gemini
// branch in the endpoint fallback, so a gemini-protocol upstream defaults to
// the OpenAI path `chat/completions`, and src/providers/url.ts:8-15 rejects
// ':' so `v1beta/models/{model}:generateContent` cannot be configured as an
// explicit endpoint either. Expected upstream path:
// `/v1beta/models/{model}:generateContent`. Actual: `/chat/completions`
// (works only against mocks that ignore the path; a real Google endpoint 404s).
test('gemini upstream receives the v1beta generateContent path', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: GEMINI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    assert.equal(upstream.calls[0]?.url, `/v1beta/models/${MODEL}:generateContent`);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// gemini client -> anthropic upstream (GeminiToAnthBridge)
// ---------------------------------------------------------------------------

test('gemini client to anthropic upstream: request translation, response shape and usage mapping', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: ANTHROPIC_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'sys' }] },
      generationConfig: { maxOutputTokens: 64, temperature: 0.7 },
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    // Gemini client contract.
    assert.equal(json.responseId, 'msg_ant_1');
    assert.equal(json.modelVersion, 'ant-model');
    assert.equal(json.candidates[0].content.role, 'model');
    assert.equal(json.candidates[0].content.parts[0].text, 'ok');
    assert.equal(json.candidates[0].finishReason, 'STOP');
    assert.equal(json.usageMetadata.promptTokenCount, 4);
    assert.equal(json.usageMetadata.candidatesTokenCount, 2);
    // Translated upstream request is a full Anthropic Messages body.
    const sent = upstream.calls[0]?.body;
    assert.equal(upstream.calls[0]?.method, 'POST');
    assert.equal(sent.model, MODEL);
    assert.equal(sent.messages[0].role, 'user');
    assert.equal(sent.messages[0].content[0].type, 'text');
    assert.equal(sent.messages[0].content[0].text, 'hi');
    assert.equal(sent.max_tokens, 64);
    assert.equal(sent.temperature, 0.7);
    assert.equal(sent.system[0].text, 'sys');
    assert.equal(sent.contents, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client to anthropic upstream: tool declaration and tool_use response mapping', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    body: {
      ...ANTHROPIC_JSON_RESPONSE,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SF' } }],
      stop_reason: 'tool_use',
    },
  }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'weather?' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'd', parameters: { type: 'object' } }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    const call = json.candidates[0].content.parts[0].functionCall;
    assert.equal(call.id, 'toolu_1');
    assert.equal(call.name, 'get_weather');
    assert.deepEqual(call.args, { city: 'SF' });
    assert.equal(json.candidates[0].finishReason, 'STOP');
    const sent = upstream.calls[0]?.body;
    assert.equal(sent.tools[0].name, 'get_weather');
    assert.equal(sent.tools[0].input_schema.type, 'object');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client to anthropic upstream: streamGenerateContent SSE translation', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: ANTHROPIC_SSE,
  }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      model: MODEL,
      stream: true,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /^text\/event-stream/);
    const events = await readSseJson(res);
    assert.equal(events.length, 2);
    assert.equal(events[0].candidates[0].content.parts[0].text, 'hello');
    assert.equal(events[1].candidates[0].finishReason, 'STOP');
    assert.equal(events[1].usageMetadata.promptTokenCount, 3);
    assert.equal(events[1].usageMetadata.candidatesTokenCount, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client to anthropic upstream: upstream 404 maps to a gemini error envelope', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 404,
    body: { type: 'error', error: { type: 'not_found_error', message: 'model not found' } },
  }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    assert.equal(res.status, 404);
    const json: any = await res.json();
    // Gemini native error envelope shape.
    assert.equal(json.error.code, 404);
    assert.equal(json.error.status, 'INTERNAL');
    assert.equal(json.error.message, 'model not found');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// KNOWN-BUG: src/server/proxy.ts:1753-1763 — UnsupportedBridgeFeatureError from
// GeminiToAnthBridge.transformRequest (`$.generationConfig.maxOutputTokens` is
// required) escapes as an unhandled 503 internal_error instead of a 422
// unsupported_capability response. Expected: 422. Actual: 503.
test('gemini client to anthropic upstream without maxOutputTokens', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: ANTHROPIC_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([anthropicUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 422);
    const json: any = await res.json();
    // C0: 422 with the gemini envelope; the message names the rejected field.
    assert.match(String(json.error.message), /Unsupported bridge feature/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// gemini client -> openai upstream (GeminiToOpenAIBridge)
// ---------------------------------------------------------------------------

test('gemini client to openai upstream: request translation, response shape and usage mapping', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: OPENAI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'sys' }] },
      generationConfig: { maxOutputTokens: 64, temperature: 0.7 },
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    // Gemini client contract.
    assert.equal(json.responseId, 'chatcmpl_oai_1');
    assert.equal(json.modelVersion, 'oai-model');
    assert.equal(json.candidates[0].content.parts[0].text, 'ok');
    assert.equal(json.candidates[0].finishReason, 'STOP');
    assert.equal(json.usageMetadata.promptTokenCount, 4);
    assert.equal(json.usageMetadata.candidatesTokenCount, 2);
    assert.equal(json.usageMetadata.cachedContentTokenCount, 1);
    // Translated upstream request is a full chat.completions body.
    const sent = upstream.calls[0]?.body;
    assert.equal(upstream.calls[0]?.method, 'POST');
    assert.equal(sent.model, MODEL);
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.messages[0].content, 'sys');
    assert.equal(sent.messages[1].role, 'user');
    assert.equal(sent.messages[1].content, 'hi');
    assert.equal(sent.max_completion_tokens, 64);
    assert.equal(sent.temperature, 0.7);
    assert.equal(sent.contents, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client to openai upstream: streamGenerateContent SSE translation', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: OPENAI_SSE,
  }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      model: MODEL,
      stream: true,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /^text\/event-stream/);
    const events = await readSseJson(res);
    assert.equal(events.length, 2);
    assert.equal(events[0].candidates[0].content.parts[0].text, 'hello');
    assert.equal(events[1].candidates[0].finishReason, 'STOP');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client to openai upstream: authMode google sends x-goog-api-key, not bearer', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: OPENAI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([openaiUpstream(upstream.baseUrl, 'google')]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    await res.json();
    assert.equal(upstream.calls[0]?.headers['x-goog-api-key'], 'g-key-1');
    assert.equal(upstream.calls[0]?.headers['authorization'], undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// gemini client -> responses upstream (GeminiToResponsesBridge)
// ---------------------------------------------------------------------------

// KNOWN-BUG: src/server/proxy.ts:1074 — the routing candidate filter drops
// every `responses`-protocol upstream for non-responses clients *including
// gemini*, so the GeminiToResponsesBridge (src/protocol/responses-gemini.ts:124)
// is unreachable in classic mode. Expected: 200 with the gemini response
// shape. Actual: 422 unsupported_capability.
test('gemini client to responses upstream: generateContent translation', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: RESPONSES_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([responsesUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:generateContent`, {
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.responseId, 'resp_oai_1');
    assert.equal(json.candidates[0].content.parts[0].text, 'ok');
    assert.equal(json.candidates[0].finishReason, 'STOP');
    assert.equal(json.usageMetadata.promptTokenCount, 4);
    assert.equal(json.usageMetadata.candidatesTokenCount, 2);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// KNOWN-BUG: same root cause as the non-streaming case above; additionally
// GeminiToResponsesBridge never reads `stream` from the request body
// (src/protocol/responses-gemini.ts:127 sets it only from the URL path via
// rewriteUrlPath, which the classic proxy never calls).
test('gemini client to responses upstream: streamGenerateContent SSE translation', async () => {
  const upstream = await startMockUpstream(() => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: RESPONSES_SSE,
  }));
  const proxy = await startProxy(baseConfig([responsesUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, {
      model: MODEL,
      stream: true,
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type')), /^text\/event-stream/);
    const events = await readSseJson(res);
    assert.ok(events.length >= 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// ---------------------------------------------------------------------------
// error paths on the gemini client entry
// ---------------------------------------------------------------------------

test('gemini client: unknown model returns 404 not_found_error', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: GEMINI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await postGemini(proxy, '/v1beta/models/not-a-model:generateContent', {
      model: 'not-a-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    assert.equal(res.status, 404);
    const json: any = await res.json();
    // C0: gemini routing errors use the gemini envelope (status, not type).
    assert.equal(json.error.status, 'not_found_error');
    assert.match(json.error.message, /No available upstream for the requested model/);
    assert.equal(upstream.calls.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('gemini client: unauthenticated request is rejected before any upstream call', async () => {
  const upstream = await startMockUpstream(() => ({ status: 200, body: GEMINI_JSON_RESPONSE }));
  const proxy = await startProxy(baseConfig([geminiUpstream(upstream.baseUrl)]));
  try {
    const res = await fetch(`${proxy.baseUrl}/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    assert.equal(res.status, 401);
    assert.equal(upstream.calls.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
