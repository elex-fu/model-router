/**
 * Batch-5 §5.1 plugin runtime tests: handshake gates (TOCTOU + identity),
 * forward stream framing, session-wrapped credential delivery, request_sent
 * semantics, drain behavior — all against the real mock plugin child
 * (tests/saas/plugins/fixtures/mock-transport-plugin.mjs).
 */

import { createHash } from 'node:crypto';
import { readFile, mkdtemp, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { PluginRuntime, PluginRuntimeError } from '../../../src/saas/plugins/runtime.js';
import type { PluginHostServices } from '../../../src/saas/plugins/protocol.js';
import { PluginTransportError } from '../../../src/saas/plugins/types.js';

const FIXTURE = new URL('./fixtures/mock-transport-plugin.mjs', import.meta.url).pathname;

function inMemoryHostServices(): PluginHostServices {
  const kv = new Map<string, string>();
  return {
    'kv.get': async (params) => {
      const { namespace, key } = params as { namespace: string; key: string };
      const value = kv.get(`${namespace}\0${key}`);
      return { found: value !== undefined, value: value ?? null };
    },
    'kv.set': async (params) => {
      const { namespace, key, value } = params as { namespace: string; key: string; value: string };
      kv.set(`${namespace}\0${key}`, value);
      return {};
    },
    'kv.delete': async (params) => {
      const { namespace, key } = params as { namespace: string; key: string };
      return { deleted: kv.delete(`${namespace}\0${key}`) };
    },
    'kv.list': async (params) => {
      const { namespace, key_prefix: prefix } = params as { namespace: string; key_prefix: string };
      return {
        keys: [...kv.keys()]
          .filter((composite) => composite.startsWith(`${namespace}\0${prefix}`))
          .map((composite) => composite.split('\0')[1])
          .sort(),
      };
    },
    'accounts.list': async () => ({ accounts: [] }),
  };
}

async function stageMockPlugin(): Promise<{ dir: string; entryPath: string; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mr-plugin-runtime-'));
  const entryPath = join(dir, 'plugin.mjs');
  await copyFile(FIXTURE, entryPath);
  await chmod(entryPath, 0o755);
  const sha256 = createHash('sha256').update(await readFile(entryPath)).digest('hex');
  return { dir, entryPath, sha256 };
}

interface MockUpstream {
  server: Server;
  url: string;
  received: {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: string;
  }[];
  close(): Promise<void>;
}

function mockUpstreamServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<MockUpstream> {
  const received: MockUpstream['received'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/v1/messages`,
        received,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function newRuntime(
  entryPath: string,
  sha256: string,
  overrides: Partial<ConstructorParameters<typeof PluginRuntime>[0]> = {},
) {
  return new PluginRuntime({
    pluginKey: 'com.example.mr-mock-transport',
    version: '1.2.3',
    entryPath,
    binarySha256: sha256,
    config: null,
    hostServices: inMemoryHostServices(),
    startTimeoutMs: 5_000,
    ...overrides,
  });
}

test('runtime handshake succeeds and reports alive', async () => {
  const stage = await stageMockPlugin();
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  assert.equal(runtime.alive, true);
  await runtime.drain(1_000);
});

test('runtime refuses to spawn when the entrypoint hash no longer matches (TOCTOU gate)', async () => {
  const stage = await stageMockPlugin();
  const runtime = newRuntime(stage.entryPath, '0'.repeat(64));
  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof PluginRuntimeError);
    assert.equal(error.code, 'BINARY_HASH_MISMATCH');
    return true;
  });
  assert.equal(runtime.alive, false);
});

test('runtime kills a plugin whose identity does not match the manifest', async () => {
  const stage = await stageMockPlugin();
  const runtime = newRuntime(stage.entryPath, stage.sha256, { pluginKey: 'com.example.someone-else' });
  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.ok(error instanceof PluginRuntimeError);
    assert.equal(error.code, 'INFO_MISMATCH');
    return true;
  });
});

test('forward streams request frames in order and returns the response stream', async () => {
  const stage = await stageMockPlugin();
  const upstream = await mockUpstreamServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, marker: 'upstream-body' }));
  });
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const result = await runtime.forward({
    requestId: 'req-1',
    method: 'POST',
    url: upstream.url,
    headers: { 'content-type': ['application/json'], 'x-test': ['a'] },
    body: Buffer.from(JSON.stringify({ hello: 'world' })),
    account: { id: 'acct-1', platform: 'claude', account_type: 'oauth' },
    credentialEnvelope: null,
    signal: new AbortController().signal,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.headers['x-mr-mock-plugin'], ['true']);
  assert.ok(result.body !== null);
  const text = await readStream(result.body);
  assert.equal(JSON.parse(text).marker, 'upstream-body');
  // The mock upstream received exactly one request with our body and headers.
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].method, 'POST');
  assert.equal(upstream.received[0].body, JSON.stringify({ hello: 'world' }));
  assert.equal(upstream.received[0].headers['x-test'], 'a');
  await upstream.close();
  await runtime.drain(1_000);
});

test('forward delivers the session-wrapped credential without ever serializing plaintext', async () => {
  const stage = await stageMockPlugin();
  const upstream = await mockUpstreamServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sawAuthorization: req.headers.authorization ?? null }));
  });
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const envelope = runtime.wrapCredential(Buffer.from('plaintext-test-token', 'utf8'), 'req-cred');
  // The envelope is ciphertext: the token bytes appear nowhere in it.
  assert.ok(!JSON.stringify(envelope).includes('plaintext-test-token'));
  const result = await runtime.forward({
    requestId: 'req-cred',
    method: 'POST',
    url: upstream.url,
    headers: {},
    body: null,
    account: { id: 'acct-1', platform: 'claude', account_type: 'oauth' },
    credentialEnvelope: envelope,
    signal: new AbortController().signal,
  });
  const text = await readStream(result.body as ReadableStream<Uint8Array>);
  assert.equal(JSON.parse(text).sawAuthorization, 'Bearer plaintext-test-token');
  await upstream.close();
  await runtime.drain(1_000);
});

test('a credential envelope bound to another request id fails to decrypt (AAD binding)', async () => {
  const stage = await stageMockPlugin();
  const upstream = await mockUpstreamServer((_req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const envelope = runtime.wrapCredential(Buffer.from('token-x', 'utf8'), 'req-other');
  await assert.rejects(
    runtime.forward({
      requestId: 'req-actual',
      method: 'POST',
      url: upstream.url,
      headers: {},
      body: null,
      account: { id: 'acct-1', platform: 'claude', account_type: 'oauth' },
      credentialEnvelope: envelope,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginTransportError);
      // The plugin PROVED the upstream transport was never invoked (the
      // envelope failed to decrypt before the fetch) — request_sent=false
      // is the honest verdict here.
      assert.equal(error.requestSent, false);
      return true;
    },
  );
  await upstream.close();
  await runtime.drain(1_000);
});

test('plugin crash after begin acceptance fails closed with request_sent=true', async () => {
  const stage = await stageMockPlugin();
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const forwardPromise = runtime.forward({
    requestId: 'req-crash',
    method: 'POST',
    url: 'http://127.0.0.1:1/unreachable',
    headers: {},
    body: null,
    account: { id: 'acct-1', platform: 'claude', account_type: 'oauth' },
    credentialEnvelope: null,
    signal: new AbortController().signal,
  });
  // Kill the child while the forward is in flight: the failure must carry
  // request_sent=true once the begin was accepted (never silently succeed).
  runtime.kill();
  await assert.rejects(forwardPromise, (error: unknown) => {
    assert.ok(error instanceof PluginTransportError);
    assert.equal(error.requestSent, true);
    return true;
  });
});

test('forward on a dead or draining runtime is rejected with request_sent=false', async () => {
  const stage = await stageMockPlugin();
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  runtime.beginDrain();
  await assert.rejects(
    runtime.forward({
      requestId: 'req-stop',
      method: 'POST',
      url: 'http://127.0.0.1:1/x',
      headers: {},
      body: null,
      account: { id: 'a', platform: 'claude', account_type: 'oauth' },
      credentialEnvelope: null,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PluginTransportError);
      assert.equal(error.code, 'PLUGIN_STOPPING');
      assert.equal(error.requestSent, false);
      return true;
    },
  );
  await runtime.drain(1_000);
});

test('drain lets the in-flight forward finish, then kills the child', async () => {
  const stage = await stageMockPlugin();
  const upstream = await mockUpstreamServer((_req, res) => {
    // Slow SSE-ish body: two chunks with a pause between.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    setTimeout(() => {
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n');
      res.end();
    }, 150);
  });
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const result = await runtime.forward({
    requestId: 'req-drain',
    method: 'POST',
    url: upstream.url,
    headers: {},
    body: null,
    account: { id: 'a', platform: 'claude', account_type: 'oauth' },
    credentialEnvelope: null,
    signal: new AbortController().signal,
  });
  const readDone = readStream(result.body as ReadableStream<Uint8Array>);
  runtime.beginDrain();
  // New arrivals are refused while draining.
  await assert.rejects(
    runtime.forward({
      requestId: 'req-drain-2',
      method: 'POST',
      url: upstream.url,
      headers: {},
      body: null,
      account: { id: 'a', platform: 'claude', account_type: 'oauth' },
      credentialEnvelope: null,
      signal: new AbortController().signal,
    }),
  );
  const text = await readDone;
  assert.ok(text.includes('message_start'));
  await runtime.drain(1_000);
  assert.equal(runtime.alive, false);
  await upstream.close();
});

test('client abort propagates to the forward', async () => {
  const stage = await stageMockPlugin();
  const upstream = await mockUpstreamServer((_req, res) => {
    res.writeHead(200);
    res.write('part-1\n');
    // Never end: only the abort can terminate this exchange.
  });
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const controller = new AbortController();
  const result = await runtime.forward({
    requestId: 'req-abort',
    method: 'POST',
    url: upstream.url,
    headers: {},
    body: null,
    account: { id: 'a', platform: 'claude', account_type: 'oauth' },
    credentialEnvelope: null,
    signal: controller.signal,
  });
  assert.ok(result.body !== null);
  const readPromise = readStream(result.body as ReadableStream<Uint8Array>).catch((error: unknown) => {
    assert.ok(error instanceof PluginTransportError);
    return null;
  });
  controller.abort();
  const outcome = await readPromise;
  assert.ok(outcome === null || outcome.includes('part-1'));
  await runtime.drain(1_000);
  await upstream.close();
});

test('the reverse host-service channel answers kv calls from the plugin', async () => {
  const stage = await stageMockPlugin();
  const upstream = await mockUpstreamServer((_req, res) => {
    res.writeHead(200);
    res.end('{}');
  });
  const runtime = newRuntime(stage.entryPath, stage.sha256);
  await runtime.start();
  const result = await runtime.forward({
    requestId: 'req-kv',
    method: 'POST',
    url: upstream.url,
    headers: {},
    body: null,
    account: { id: 'a', platform: 'claude', account_type: 'oauth' },
    credentialEnvelope: null,
    signal: new AbortController().signal,
  });
  // The mock plugin records every forwarded request id through kv.set and
  // echoes the kv.list result in x-mr-mock-kv.
  assert.deepEqual(result.headers['x-mr-mock-kv'], ['last-request']);
  await readStream(result.body as ReadableStream<Uint8Array>);
  await upstream.close();
  await runtime.drain(1_000);
});

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
