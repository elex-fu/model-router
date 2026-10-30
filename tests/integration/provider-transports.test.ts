import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { encodeEventStreamFrame } from '../../src/server/providers/bedrock.js';
import type { ProviderTransportProfile } from '../../src/server/providers/types.js';
import { createVertexTransportProfile } from '../../src/server/providers/vertex-sa.js';
import { proxyHandler } from '../../src/server/proxy.js';

/*
 * C3b (docs/standalone-relay-capability-plan-2026-10-30.md): Bedrock/Vertex
 * transport wiring in the classic dispatch. Bedrock exercises the REAL
 * transport profile end-to-end against a local http upstream (SigV4 signing,
 * body rewrite, invoke URL). Vertex exercises real SA-token minting with an
 * injected fetch plus a local buildUrl stub — its production URL shape is
 * covered by the providers unit suite; here the wiring (auth merge, body
 * transform, dispatch flow) is what is under test.
 */

interface MockUpstream {
  baseUrl: string;
  calls: Array<{ url: string; headers: Record<string, string>; body: any }>;
  respond(status: number, headers: Record<string, string>, body: string | Buffer): void;
  close(): Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const calls: MockUpstream['calls'] = [];
  let responder: (res: http.ServerResponse) => void = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  };
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
    calls.push({ url: req.url ?? '/', headers, body: parsed });
    responder(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    calls,
    respond(status, headers, body) {
      responder = (res) => {
        res.writeHead(status, headers);
        res.end(typeof body === 'string' ? body : Buffer.from(body));
      };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function startProxy(
  config: Config,
  providerTransports?: { bedrock?: ProviderTransportProfile; vertex?: ProviderTransportProfile },
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const tmpDir = path.join(os.tmpdir(), `mr-transport-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, () => {}, providerTransports ? { providerTransports } : {}).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
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

function baseConfig(upstream: Config['upstreams'][number]): Config {
  return {
    server: { port: 0, logFlushIntervalMs: 100, logBatchSize: 10 },
    proxyKeys: [{ name: 'test', key: 'sk-test-12345', enabled: true, createdAt: '2026-05-02T00:00:00Z' }],
    upstreams: [upstream],
  };
}

const ANTHROPIC_REQUEST = {
  method: 'POST' as const,
  headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'custom-model',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  }),
};

const ANTHROPIC_JSON_RESPONSE = JSON.stringify({
  id: 'msg_bed_1',
  type: 'message',
  role: 'assistant',
  model: 'custom-model',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 },
});

const BEDROCK_CREDS = {
  accessKeyId: 'AKIDLOCALTEST',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};

test('bedrock transport: SigV4-signed invoke, body rewrite, anthropic passthrough (non-streaming)', async () => {
  const upstream = await startMockUpstream();
  upstream.respond(200, { 'Content-Type': 'application/json' }, ANTHROPIC_JSON_RESPONSE);
  const proxy = await startProxy(
    baseConfig({
      name: 'bedrock-up',
      provider: 'custom',
      presetId: 'custom-anthropic',
      protocol: 'anthropic',
      baseUrl: upstream.baseUrl,
      endpoint: 'messages',
      apiKeys: [],
      authMode: 'none',
      models: ['custom-model'],
      enabled: true,
      bedrock: BEDROCK_CREDS,
    }),
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, ANTHROPIC_REQUEST);
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.content[0].text, 'ok');
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    // Bedrock invoke URL shape with the local origin override.
    assert.equal(call.url, '/model/custom-model/invoke');
    // SigV4 material present; nothing else authenticated the request.
    assert.match(call.headers.authorization ?? '', /^AWS4-HMAC-SHA256 /);
    assert.match(call.headers['x-amz-date'] ?? '', /^\d{8}T\d{6}Z$/);
    assert.match(call.headers['x-amz-content-sha256'] ?? '', /^[0-9a-f]{64}$/);
    assert.equal(call.headers.authorization?.includes('us-east-1'), true);
    // Wire body: anthropic_version injected, model dropped.
    assert.equal(call.body.anthropic_version, 'bedrock-2023-05-31');
    assert.equal(call.body.model, undefined);
    assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hi' }]);
    // The normal bearer/x-api-key path must not have fired.
    assert.equal(call.headers.authorization?.startsWith('Bearer'), false);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('bedrock transport: eventstream response decodes to SSE through the streaming path', async () => {
  const upstream = await startMockUpstream();
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_bed_1',
        type: 'message',
        role: 'assistant',
        model: 'custom-model',
        content: [],
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 4, output_tokens: 2 },
    },
    { type: 'message_stop' },
  ];
  const frames = events.map((event) =>
    encodeEventStreamFrame({
      headers: [
        [':message-type', 'event'],
        [':event-type', 'chunk'],
      ],
      payload: Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') }), 'utf-8'),
    }),
  );
  upstream.respond(200, { 'Content-Type': 'application/vnd.amazon.eventstream' }, Buffer.concat(frames));
  const proxy = await startProxy(
    baseConfig({
      name: 'bedrock-up',
      provider: 'custom',
      presetId: 'custom-anthropic',
      protocol: 'anthropic',
      baseUrl: upstream.baseUrl,
      endpoint: 'messages',
      apiKeys: [],
      authMode: 'none',
      models: ['custom-model'],
      enabled: true,
      bedrock: BEDROCK_CREDS,
    }),
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, {
      ...ANTHROPIC_REQUEST,
      body: JSON.stringify({
        model: 'custom-model',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /event: message_stop/);
    // The streaming invoke path carries the eventstream accept header.
    assert.equal(upstream.calls[0]?.headers.accept, 'application/vnd.amazon.eventstream');
    assert.equal(upstream.calls[0]?.url, '/model/custom-model/invoke-with-response-stream');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

function testServiceAccount(): Record<string, string> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: 'proj-1',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: 'test-sa@proj-1.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  };
}

test('vertex transport: SA-token bearer auth, body rewrite, token cached across requests', async () => {
  const upstream = await startMockUpstream();
  upstream.respond(200, { 'Content-Type': 'application/json' }, ANTHROPIC_JSON_RESPONSE);
  let tokenEndpointHits = 0;
  const tokenFetch = async (): Promise<Response> => {
    tokenEndpointHits += 1;
    return new Response(JSON.stringify({ access_token: 'tok-abc-123', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const saJson = JSON.stringify(testServiceAccount());
  const realProfile = createVertexTransportProfile({ fetch: tokenFetch });
  const localVertex: ProviderTransportProfile = {
    ...realProfile,
    // Local origin override: the production URL shape is covered by the
    // providers unit suite; this test exercises the dispatch wiring.
    buildUrl: () =>
      `${upstream.baseUrl}/v1/projects/proj-1/locations/us-central1/publishers/anthropic/models/custom-model:rawPredict`,
  };
  const proxy = await startProxy(
    baseConfig({
      name: 'vertex-up',
      provider: 'custom',
      presetId: 'custom-anthropic',
      protocol: 'anthropic',
      baseUrl: upstream.baseUrl,
      endpoint: 'messages',
      apiKeys: [],
      authMode: 'none',
      models: ['custom-model'],
      enabled: true,
      vertex: { serviceAccountJson: saJson },
    }),
    { vertex: localVertex },
  );
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${proxy.baseUrl}/v1/messages`, ANTHROPIC_REQUEST);
      assert.equal(response.status, 200);
      const json: any = await response.json();
      assert.equal(json.content[0].text, 'ok');
    }
    assert.equal(upstream.calls.length, 2);
    for (const call of upstream.calls) {
      assert.equal(call.headers.authorization, 'Bearer tok-abc-123');
      assert.equal(call.body.anthropic_version, 'vertex-2023-10-16');
      assert.equal(call.body.model, undefined);
      assert.deepEqual(call.body.messages, [{ role: 'user', content: 'hi' }]);
    }
    // The minted token is cached: one token-endpoint hit serves both requests.
    assert.equal(tokenEndpointHits, 1);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('a transport-declaring upstream outside the anthropic protocol fails closed (422)', async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(
    baseConfig({
      name: 'bad-transport',
      provider: 'custom',
      presetId: 'custom-openai',
      protocol: 'openai',
      baseUrl: upstream.baseUrl,
      endpoint: 'chat/completions',
      apiKeys: [],
      authMode: 'none',
      models: ['custom-model'],
      enabled: true,
      bedrock: BEDROCK_CREDS,
    }),
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      ...ANTHROPIC_REQUEST,
      body: JSON.stringify({ model: 'custom-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 422);
    const json: any = await response.json();
    assert.equal(json.error.message, 'unsupported_capability');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
