import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import type { CodexAccountSelection } from '../../src/server/codex-account-pool.js';
import type { CodexAccountFailureClassification } from '../../src/server/codex-account-transport.js';
import { createCodexAccountTransport } from '../../src/server/codex-account-transport.js';
import { proxyHandler } from '../../src/server/proxy.js';

/*
 * CS3+CS4 (docs/standalone-relay-capability-plan-2026-10-30.md D1): classic
 * codex subscription-account upstreams end-to-end against a local http mock —
 * the REAL codex account transport (canonical identity headers, shared
 * applyCodexOAuthTransform wire body, instructions injection) with a stub
 * account pool + engine. Mirrors tests/integration/provider-transports.test.ts.
 */

interface MockCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

interface MockUpstream {
  baseUrl: string;
  calls: MockCall[];
  respond(handler: (call: MockCall, res: http.ServerResponse) => void): void;
  close(): Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const calls: MockCall[] = [];
  let handler: (call: MockCall, res: http.ServerResponse) => void = (_call, res) => {
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
    const call: MockCall = { url: req.url ?? '/', headers, body: parsed };
    calls.push(call);
    handler(call, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    calls,
    respond(next: (call: MockCall, res: http.ServerResponse) => void) {
      handler = next;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

interface PoolStub {
  selections: string[];
  failures: Array<{ accountId: string; classification: CodexAccountFailureClassification; retryAfterMs?: number }>;
  successes: string[];
  select(): CodexAccountSelection | null;
  availableCount(): number;
  markFailure(
    accountId: string,
    classification: CodexAccountFailureClassification,
    hint?: { retryAfterMs?: number },
  ): void;
  markSuccess(accountId: string): void;
}

/** Sequential stub: hands out accounts in order, records pool feedback. */
function poolStub(accountIds: string[]): PoolStub {
  const stub: PoolStub = {
    selections: [],
    failures: [],
    successes: [],
    select() {
      const accountId = accountIds[stub.selections.length];
      if (accountId === undefined) return null;
      stub.selections.push(accountId);
      return { accountId, chatgptAccountId: `chatgpt-${accountId}` };
    },
    availableCount() {
      return Math.max(1, accountIds.length - stub.selections.length);
    },
    markFailure(accountId, classification, hint) {
      stub.failures.push({ accountId, classification, retryAfterMs: hint?.retryAfterMs });
    },
    markSuccess(accountId) {
      stub.successes.push(accountId);
    },
  };
  return stub;
}

const ACCOUNT_TOKENS: Record<string, string> = { 'acc-1': 'codex-token-a', 'acc-2': 'codex-token-b' };

function engineStub() {
  return {
    async resolveAccessToken(provider: string, accountId?: string) {
      assert.equal(provider, 'codex_oauth');
      const token = ACCOUNT_TOKENS[accountId ?? ''];
      if (token === undefined) throw new Error(`no token for ${accountId}`);
      return token;
    },
  };
}

async function startProxy(config: Config, pool: PoolStub | null): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const tmpDir = path.join(os.tmpdir(), `mr-codex-account-it-${randomUUID()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const store = new ConfigStore(configPath);
  const options: Parameters<typeof proxyHandler>[4] = {
    // Zero-delay retry backoff so 401→account-2 failover is immediate.
    retryRandom: () => 0,
    retryBaseDelayMs: 1,
    ...(pool
      ? {
          codexAccountPool: pool,
          codexAccountTransport: createCodexAccountTransport({ engine: engineStub() }),
        }
      : {}),
  };
  const server = http.createServer((req, res) => {
    proxyHandler(req, res, store, () => {}, options).catch((err) => {
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

/**
 * codexAccount is read structurally by the dispatch (the typed V1 config
 * surface lands with CS2's CLI work); the cast keeps the literal honest.
 */
function codexUpstream(baseUrl: string, extra: Record<string, unknown> = {}): Config['upstreams'][number] {
  return {
    name: 'codex-accounts',
    provider: 'custom',
    presetId: 'custom-responses',
    protocol: 'responses',
    baseUrl,
    apiKeys: [],
    authMode: 'none',
    models: ['gpt-5.1-codex'],
    enabled: true,
    codexAccount: { provider: 'codex_oauth' },
    ...extra,
  } as unknown as Config['upstreams'][number];
}

const RESPONSES_REQUEST = {
  method: 'POST' as const,
  headers: { authorization: 'Bearer sk-test-12345', 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-5.1-codex', input: 'hi' }),
};

const RESPONSES_JSON_REPLY = JSON.stringify({
  id: 'resp_codex_1',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.3-codex',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
  usage: { input_tokens: 4, output_tokens: 2 },
});

test('codex account transport: canonical identity headers, engine token, wire body transform (non-streaming)', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(RESPONSES_JSON_REPLY);
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.id, 'resp_codex_1');
    assert.equal(upstream.calls.length, 1);
    const call = upstream.calls[0]!;
    // The codex wire path: /responses on the (locally overridden) origin.
    assert.equal(call.url, '/responses');
    // Canonical identity + account auth (engine-resolved token).
    assert.equal(call.headers.authorization, 'Bearer codex-token-a');
    assert.equal(call.headers['chatgpt-account-id'], 'chatgpt-acc-1');
    assert.equal(call.headers.originator, 'codex_cli_rs');
    assert.match(call.headers['user-agent'] ?? '', /^codex_cli_rs\/\d+\.\d+\.\d+ /);
    assert.equal(call.headers['openai-beta'], 'responses=experimental');
    assert.equal(call.headers['content-type'], 'application/json');
    // Shared applyCodexOAuthTransform wire rules.
    assert.equal(call.body.store, false);
    assert.equal(call.body.stream, true);
    assert.equal(call.body.model, 'gpt-5.3-codex');
    assert.equal(typeof call.body.instructions, 'string');
    assert.ok(call.body.instructions.length > 0);
    // The responses passthrough keeps the input intact (string input is
    // normalized to a single user message by the shared transform).
    assert.deepEqual(call.body.input, [{ role: 'user', content: 'hi' }]);
    // A served attempt clears the account's failure streak.
    assert.deepEqual(pool.successes, ['acc-1']);
    assert.deepEqual(pool.failures, []);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex account transport: streaming SSE path decodes through', async () => {
  const upstream = await startMockUpstream();
  const sse = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_codex_2"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_codex_2","usage":{"input_tokens":4,"output_tokens":2}}}',
    '',
    '',
  ].join('\n');
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(sse);
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      ...RESPONSES_REQUEST,
      body: JSON.stringify({ model: 'gpt-5.1-codex', input: 'hi', stream: true }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: response.created/);
    assert.match(text, /event: response.output_text.delta/);
    assert.match(text, /event: response.completed/);
    // The wire body still carries the forced streaming/store flags.
    assert.equal(upstream.calls[0]?.body.stream, true);
    assert.equal(upstream.calls[0]?.body.store, false);
    assert.equal(upstream.calls[0]?.headers.accept, 'text/event-stream');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex account transport: 401 marks the account credential-expired and fails over to another account', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((call, res) => {
    if (call.headers.authorization === 'Bearer codex-token-a') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'token expired' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(RESPONSES_JSON_REPLY);
  });
  const pool = poolStub(['acc-1', 'acc-2']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    // The failed account was skipped; the second account served the request.
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.equal(json.id, 'resp_codex_1');
    assert.deepEqual(pool.selections, ['acc-1', 'acc-2']);
    assert.deepEqual(pool.failures, [
      { accountId: 'acc-1', classification: 'credential_expired', retryAfterMs: undefined },
    ]);
    assert.deepEqual(pool.successes, ['acc-2']);
    // Both attempts reached the upstream with their own account tokens.
    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[0]!.headers.authorization, 'Bearer codex-token-a');
    assert.equal(upstream.calls[0]!.headers['chatgpt-account-id'], 'chatgpt-acc-1');
    assert.equal(upstream.calls[1]!.headers.authorization, 'Bearer codex-token-b');
    assert.equal(upstream.calls[1]!.headers['chatgpt-account-id'], 'chatgpt-acc-2');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex account transport: empty pool fails closed with a clear 502', async () => {
  const upstream = await startMockUpstream();
  const pool = poolStub([]); // select() returns null immediately
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(response.status, 502);
    const json: any = await response.json();
    assert.equal(json.error.message, 'No authenticated codex account');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex account transport: no pool/transport wired fails closed with a clear 502', async () => {
  const upstream = await startMockUpstream();
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), null);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(response.status, 502);
    const json: any = await response.json();
    assert.equal(json.error.message, 'Codex account transport is not configured');
    assert.equal(upstream.calls.length, 0);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex account transport: non-responses protocol fails closed (422)', async () => {
  const upstream = await startMockUpstream();
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(
    baseConfig(codexUpstream(upstream.baseUrl, { protocol: 'openai', presetId: 'custom-openai' })),
    pool,
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: RESPONSES_REQUEST.headers,
      body: JSON.stringify({ model: 'gpt-5.1-codex', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
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

test('codex account transport: whitelist strips non-wire fields and lifts model-encoded reasoning effort', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(RESPONSES_JSON_REPLY);
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(
    baseConfig(codexUpstream(upstream.baseUrl, { models: ['gpt-5.1-codex', 'gpt-5.1-codex-medium'] })),
    pool,
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      ...RESPONSES_REQUEST,
      body: JSON.stringify({
        model: 'gpt-5.1-codex-medium',
        input: 'hi',
        metadata: { trace: 'should-be-stripped' },
        parallel_tool_calls: false,
      }),
    });
    assert.equal(response.status, 200);
    const body = upstream.calls[0]!.body;
    // Whitelist: metadata is not a codex wire field.
    assert.equal(body.metadata, undefined);
    assert.equal(body.parallel_tool_calls, false);
    // The -medium suffix is lifted out of the model id into reasoning.effort.
    assert.equal(body.model, 'gpt-5.3-codex');
    assert.deepEqual(body.reasoning, { effort: 'medium' });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
