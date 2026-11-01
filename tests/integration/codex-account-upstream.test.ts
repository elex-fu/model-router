import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ConfigStore } from '../../src/config/store.js';
import type { Config } from '../../src/config/types.js';
import { accountIdentityNamespace, isolateSessionId } from '../../src/saas/gateway/codex/identity.js';
import type { CodexRateLimitSnapshot } from '../../src/saas/gateway/codex/quota-headers.js';
import {
  CodexAccountPool,
  type CodexAccountPoolContract,
  type CodexAccountSelection,
} from '../../src/server/codex-account-pool.js';
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
  quotaSnapshots: Array<{ accountId: string; snapshot: CodexRateLimitSnapshot; observedAtMs: number }>;
  select(): CodexAccountSelection | null;
  availableCount(): number;
  markFailure(
    accountId: string,
    classification: CodexAccountFailureClassification,
    hint?: { retryAfterMs?: number },
  ): void;
  markSuccess(accountId: string): void;
  markQuotaSnapshot(accountId: string, snapshot: CodexRateLimitSnapshot, observedAtMs: number): void;
}

/** Sequential stub: hands out accounts in order, records pool feedback. */
function poolStub(accountIds: string[]): PoolStub {
  const stub: PoolStub = {
    selections: [],
    failures: [],
    successes: [],
    quotaSnapshots: [],
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
    markQuotaSnapshot(accountId, snapshot, observedAtMs) {
      stub.quotaSnapshots.push({ accountId, snapshot, observedAtMs });
    },
  };
  return stub;
}

/** Cycling stub: hands the same accounts out round-robin, records feedback. */
function cyclingPoolStub(accountIds: string[]): PoolStub {
  const stub: PoolStub = {
    selections: [],
    failures: [],
    successes: [],
    quotaSnapshots: [],
    select() {
      if (accountIds.length === 0) return null;
      const accountId = accountIds[stub.selections.length % accountIds.length]!;
      stub.selections.push(accountId);
      return { accountId, chatgptAccountId: `chatgpt-${accountId}` };
    },
    availableCount() {
      return Math.max(1, accountIds.length);
    },
    markFailure(accountId, classification, hint) {
      stub.failures.push({ accountId, classification, retryAfterMs: hint?.retryAfterMs });
    },
    markSuccess(accountId) {
      stub.successes.push(accountId);
    },
    markQuotaSnapshot(accountId, snapshot, observedAtMs) {
      stub.quotaSnapshots.push({ accountId, snapshot, observedAtMs });
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

async function startProxy(
  config: Config,
  pool: CodexAccountPoolContract | null,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
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

/*
 * CS3 fix 1 (已知未闭合项 1): per-account session identity isolation — the
 * same client session_id derives a different outbound id on every account and
 * the SAME id on retries of the same account (deterministic SHA-256 of
 * proxy key + account namespace + raw id).
 */

/** The classic namespace: no persisted user id → the account id for both. */
function expectedNamespace(accountId: string): string {
  return accountIdentityNamespace({
    chatgptAccountId: `chatgpt-${accountId}`,
    chatgptUserId: `chatgpt-${accountId}`,
  });
}

function expectedSessionId(accountId: string, raw: string): string {
  // The classic proxy key name is the keyId coordinate.
  return isolateSessionId('test', expectedNamespace(accountId), raw);
}

test('codex session isolation: failover re-derives the session id per account', async () => {
  const upstream = await startMockUpstream();
  // acc-1's token 401s: the attempt fails over to acc-2 with the SAME client
  // session id — the outbound ids must differ per account.
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
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      ...RESPONSES_REQUEST,
      headers: {
        ...RESPONSES_REQUEST.headers,
        session_id: 'client-session-42',
        conversation_id: 'client-conversation-42',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(upstream.calls.length, 2);
    for (const [index, accountId] of ['acc-1', 'acc-2'].entries()) {
      const call = upstream.calls[index]!;
      assert.equal(call.headers.session_id, expectedSessionId(accountId, 'client-session-42'));
      assert.equal(call.headers.conversation_id, expectedSessionId(accountId, 'client-conversation-42'));
      // 8-hex namespaced derivation, never the verbatim client value.
      assert.match(call.headers.session_id, /^[0-9a-f]{8}$/);
      assert.notEqual(call.headers.session_id, 'client-session-42');
    }
    assert.notEqual(upstream.calls[0]!.headers.session_id, upstream.calls[1]!.headers.session_id);
    assert.notEqual(upstream.calls[0]!.headers.conversation_id, upstream.calls[1]!.headers.conversation_id);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex session isolation: same account retry reuses the same derived id', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(RESPONSES_JSON_REPLY);
  });
  const pool = cyclingPoolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
        ...RESPONSES_REQUEST,
        headers: { ...RESPONSES_REQUEST.headers, session_id: 'client-session-42' },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(upstream.calls.length, 2);
    const expected = expectedSessionId('acc-1', 'client-session-42');
    assert.equal(upstream.calls[0]!.headers.session_id, expected);
    assert.equal(upstream.calls[1]!.headers.session_id, expected);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex session isolation: absent session_id stays absent', async () => {
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
    const call = upstream.calls[0]!;
    // No fabricated ids: nothing was supplied, nothing was derived.
    assert.equal(call.headers.session_id, undefined);
    assert.equal(call.headers.conversation_id, undefined);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex session isolation: body prompt_cache_key is namespaced per account', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(RESPONSES_JSON_REPLY);
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      ...RESPONSES_REQUEST,
      body: JSON.stringify({ model: 'gpt-5.1-codex', input: 'hi', prompt_cache_key: 'client-cache-42' }),
    });
    assert.equal(response.status, 200);
    const body = upstream.calls[0]!.body;
    assert.equal(body.prompt_cache_key, expectedSessionId('acc-1', 'client-cache-42'));
    assert.notEqual(body.prompt_cache_key, 'client-cache-42');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

/*
 * CS3 fix 2 (已知未闭合项 2): passive x-codex-* quota headers feed the pool —
 * a 429 carrying a fully-used 5h window pauses that account for the classified
 * reset window, so the next request selects the other account.
 */

test('codex quota: 429 rate-limit headers pause the account in the pool', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((call, res) => {
    if (call.headers.authorization === 'Bearer codex-token-a') {
      // retry-after 0 keeps the failure cooldown at zero — the skip below is
      // proven to come from the quota snapshot gate, not the cooldown path.
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'retry-after': '0',
        'x-codex-primary-used-percent': '100',
        'x-codex-primary-reset-after-seconds': '3600',
        'x-codex-primary-window-minutes': '300',
      });
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(RESPONSES_JSON_REPLY);
  });
  const pool = new CodexAccountPool({
    listing: () => [
      { id: 'acc-1', accessToken: 'codex-token-a', chatgptAccountId: 'chatgpt-acc-1' },
      { id: 'acc-2', accessToken: 'codex-token-b', chatgptAccountId: 'chatgpt-acc-2' },
    ],
  });
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    // Request 1: acc-1 answers 429 — the client sees the 429 (retry-after
    // semantics move to another upstream), and the response's x-codex-*
    // headers land in the pool as acc-1's quota snapshot.
    const first = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(first.status, 429);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0]!.headers.authorization, 'Bearer codex-token-a');
    // The snapshot paused acc-1 (no failure cooldown is holding it): the
    // next selection and count both skip it.
    assert.equal(pool.select()?.accountId, 'acc-2');
    assert.equal(pool.availableCount(), 1);
    // Request 2 lands on acc-2 directly.
    const second = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(second.status, 200);
    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[1]!.headers.authorization, 'Bearer codex-token-b');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

/*
 * CS3 fix 3 (已知未闭合项 3): non-streaming clients on the codex account wire —
 * the forced SSE reply is aggregated to the terminal event's payload.
 */

const FULL_RESPONSE_OBJECT = {
  id: 'resp_codex_agg',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.3-codex',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] }],
  usage: { input_tokens: 7, output_tokens: 3 },
};

function sseReply(events: string[]): string {
  return `${events.join('\n')}\n\n`;
}

test('codex aggregation: non-streaming client receives the terminal response.completed object as JSON', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      sseReply([
        'event: response.created',
        `data: {"type":"response.created","response":{"id":"resp_codex_agg"}}`,
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"hi"}',
        '',
        'event: response.completed',
        `data: ${JSON.stringify({ type: 'response.completed', response: FULL_RESPONSE_OBJECT })}`,
      ]),
    );
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const json: any = await response.json();
    // The terminal event's .response object, verbatim.
    assert.deepEqual(json, FULL_RESPONSE_OBJECT);
    assert.equal(json.usage.input_tokens, 7);
    assert.equal(json.usage.output_tokens, 3);
    // The upstream still saw the forced streaming wire.
    assert.equal(upstream.calls[0]?.body.stream, true);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex aggregation: response.incomplete is a terminal event too', async () => {
  const upstream = await startMockUpstream();
  const incomplete = {
    ...FULL_RESPONSE_OBJECT,
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
  };
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      sseReply([
        'event: response.incomplete',
        `data: ${JSON.stringify({ type: 'response.incomplete', response: incomplete })}`,
      ]),
    );
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.deepEqual(json, incomplete);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex aggregation: response.failed delivers the error object with the upstream status', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      sseReply([
        'event: response.failed',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            id: 'resp_codex_fail',
            status: 'failed',
            error: { code: 'quota_exceeded', message: 'usage limit' },
          },
        })}`,
      ]),
    );
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    // The upstream status is preserved; the body is the error object.
    assert.equal(response.status, 200);
    const json: any = await response.json();
    assert.deepEqual(json, { code: 'quota_exceeded', message: 'usage limit' });
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex aggregation: a stream that ends without a terminal event fails closed (502)', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Truncated: no response.completed / response.incomplete / error event.
    res.end(
      sseReply([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_codex_trunc"}}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"partial"}',
      ]),
    );
  });
  const pool = poolStub(['acc-1']);
  const proxy = await startProxy(baseConfig(codexUpstream(upstream.baseUrl)), pool);
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/responses`, RESPONSES_REQUEST);
    assert.equal(response.status, 502);
    const json: any = await response.json();
    assert.match(json.error.message, /terminal event/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('codex aggregation: streaming clients still receive the raw SSE passthrough', async () => {
  const upstream = await startMockUpstream();
  upstream.respond((_call, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      sseReply([
        'event: response.created',
        'data: {"type":"response.created","response":{"id":"resp_codex_stream"}}',
        '',
        'event: response.completed',
        `data: ${JSON.stringify({ type: 'response.completed', response: FULL_RESPONSE_OBJECT })}`,
      ]),
    );
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
    assert.match(text, /event: response.completed/);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
