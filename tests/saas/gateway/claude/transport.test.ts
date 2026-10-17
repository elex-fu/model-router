import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CLAUDE_MESSAGES_HOST } from '../../../../src/saas/gateway/claude/catalog-identity.js';
import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_CLIENT_IDENTITY_HEADERS,
  CLAUDE_CODE_MIMICRY_BETA_HEADER,
  CLAUDE_STAINLESS_HEADERS,
} from '../../../../src/saas/gateway/claude/constants.js';
import {
  ClaudeHttpTransport,
  ClaudeHttpTransportError,
  ClaudePreparedEvidenceTransport,
  type ClaudeRateLimitSink,
  type ClaudeTransportRequest,
  type ClaudeUpstreamCredential,
  claudeMetadataUserId,
} from '../../../../src/saas/gateway/claude/transport.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';

const CREDENTIAL: ClaudeUpstreamCredential = {
  accessToken: 'accs-claude-token',
  organizationUuid: 'org-4242',
  accountUuid: 'acct-1717',
};

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function sseResponse(chunks: readonly string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function baseRequest(overrides: Partial<ClaudeTransportRequest> = {}): ClaudeTransportRequest {
  return {
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    body: { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: 'hi' }] },
    proxyKeyId: 'proxy-key-1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Harness {
  readonly seen: SeenRequest[];
  readonly rateLimits: Array<{ accountId: string; resetAtMs: number }>;
  readonly quotaSnapshots: Array<{
    accountId: string;
    fromStatus: number;
    windows: ReadonlyArray<{ window: string; utilization: number | null }>;
  }>;
  readonly health: Array<{ accountId: string; kind: string; failover: boolean }>;
  request(
    body: unknown,
    response: Response,
    overrides?: Partial<ClaudeTransportRequest>,
  ): ReturnType<ClaudeHttpTransport['send']>;
  setResponse(response: Response): void;
}

function harness(options: { baseUrl?: string } = {}): Harness {
  const seen: SeenRequest[] = [];
  const rateLimits: Array<{ accountId: string; resetAtMs: number }> = [];
  const quotaSnapshots: Array<{
    accountId: string;
    fromStatus: number;
    windows: ReadonlyArray<{ window: string; utilization: number | null }>;
  }> = [];
  const health: Array<{ accountId: string; kind: string; failover: boolean }> = [];
  let nextResponse: Response = sseResponse([]);
  const transport = new ClaudeHttpTransport({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      seen.push({ url, method: init.method ?? 'POST', headers, body: JSON.parse(String(init.body)) });
      return nextResponse;
    },
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    writeRateLimit: (async (record) => {
      rateLimits.push({ accountId: record.accountId, resetAtMs: record.classification.resetAtMs });
    }) as ClaudeRateLimitSink,
    writeQuotaSnapshot: async (record) => {
      quotaSnapshots.push({
        accountId: record.accountId,
        fromStatus: record.fromStatus,
        windows: record.snapshot.windows.map((window) => ({ window: window.window, utilization: window.utilization })),
      });
    },
    recordAccountHealth: async (signal) => {
      health.push({ accountId: signal.accountId, kind: signal.classification.kind, failover: signal.failover });
    },
  });
  return {
    seen,
    rateLimits,
    quotaSnapshots,
    health,
    setResponse(response: Response) {
      nextResponse = response;
    },
    request(body, response, overrides = {}) {
      nextResponse = response;
      return transport.send({ ...baseRequest(overrides), body });
    },
  };
}

test('the outbound request pins the host and carries the full mimicry header set', async () => {
  const h = harness();
  const result = await h.request({ model: 'claude-sonnet-4-5', messages: [] }, sseResponse([]));
  assert.equal(result.ok, true);
  assert.equal(h.seen.length, 1);
  const request = h.seen[0];
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers.host, CLAUDE_MESSAGES_HOST);
  assert.equal(request.headers.authorization, 'Bearer accs-claude-token');
  assert.equal(request.headers['anthropic-version'], CLAUDE_ANTHROPIC_VERSION);
  assert.equal(request.headers['anthropic-beta'], CLAUDE_CODE_MIMICRY_BETA_HEADER);
  assert.match(request.headers['user-agent'] ?? '', /^claude-cli\/\d+\.\d+\.\d+$/);
  for (const [name, value] of Object.entries(CLAUDE_STAINLESS_HEADERS)) {
    assert.equal(request.headers[name], value, name);
  }
  for (const [name, value] of Object.entries(CLAUDE_CLIENT_IDENTITY_HEADERS)) {
    assert.equal(request.headers[name], value, name);
  }
  assert.equal(request.headers.accept, 'text/event-stream');
  assert.equal(request.headers['content-type'], 'application/json');
});

test('the outbound body dateline watermark is normalized at the egress chokepoint', async () => {
  const h = harness();
  const body = {
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: 'You are helpful. Today’s date is 2026/07/01.' }],
    messages: [
      {
        role: 'user',
        content:
          '<system-reminder>\nTodayʼs date is 2026/07/01.\n</system-reminder>\nToday’s date is 2026/07/01. (user prose, must survive)',
      },
    ],
  };
  const result = await h.request(body, sseResponse([]));
  assert.equal(result.ok, true);
  const seenBody = h.seen[0]?.body as Record<string, unknown>;
  const system = seenBody.system as Array<{ text: string }>;
  assert.equal(system[0]?.text, "You are helpful. Today's date is 2026-07-01.");
  const content = (seenBody.messages as Array<{ content: string }>)[0]?.content ?? '';
  assert.ok(content.includes("<system-reminder>\nToday's date is 2026-07-01.\n</system-reminder>"));
  // User prose outside the system-reminder block keeps its watermark characters.
  assert.ok(content.includes('Today’s date is 2026/07/01. (user prose, must survive)'));
  // The caller's body object is never mutated.
  assert.equal((body.system as Array<{ text: string }>)[0]?.text.includes('2026/07/01'), true);
});

test('a 429 classification is written through the throttled sink', async () => {
  const h = harness();
  const resetAtMs = Date.now() + 3 * 60 * 60 * 1000;
  const result = await h.request(
    { model: 'm', messages: [] },
    new Response('rate limited', {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(resetAtMs / 1000)),
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(h.rateLimits.length, 1);
  assert.equal(h.rateLimits[0].accountId, 'account-1');
  assert.ok(Math.abs(h.rateLimits[0].resetAtMs - (resetAtMs - (resetAtMs % 1000))) <= 1000);
  // Throttled: an immediate second 429 does not write again.
  await h.request(
    { model: 'm', messages: [] },
    new Response('rate limited', {
      status: 429,
      headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
    }),
  );
  assert.equal(h.rateLimits.length, 1);
  // The shared classifier classified the failure and split the failover signal.
  assert.equal(h.health[0].kind, 'rate-limited');
  assert.equal(h.health[0].failover, true);
});

test('non-429 responses never trigger the rate-limit sink', async () => {
  const h = harness();
  await h.request({ model: 'm', messages: [] }, new Response('nope', { status: 500 }));
  assert.equal(h.rateLimits.length, 0);
  assert.equal(h.health[0].kind, 'transient');
  assert.equal(h.health[0].failover, false);
});

test('the SSE relay settles usage from message_start + message_delta and drains after client cancel', async () => {
  const h = harness();
  const result = await h.request(
    { model: 'm', messages: [] },
    sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]),
  );
  assert.equal(result.ok, true);
  const usage = await result.usage;
  assert.deepEqual(usage, { inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: null, outputTokens: 42 });

  // Client cancels mid-stream: the pump still collects the terminal usage.
  const controller = new AbortController();
  const drainTransport = new ClaudeHttpTransport({
    fetch: async () =>
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":7,"output_tokens":1}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
      ]),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
  });
  const drainResult = await drainTransport.send(baseRequest({ signal: controller.signal }));
  assert.equal(drainResult.ok, true);
  if (drainResult.ok && drainResult.body) {
    const reader = drainResult.body.getReader();
    await reader.read();
    await reader.cancel();
  }
  const drainedUsage = await drainResult.usage;
  assert.deepEqual(drainedUsage, { inputTokens: 7, cacheReadTokens: null, cacheCreationTokens: null, outputTokens: 9 });
});

test('redirects are rejected and local test upstreams are allowed', async () => {
  const h = harness();
  await assert.rejects(
    h.request(
      { model: 'm', messages: [] },
      new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeHttpTransportError);
      assert.equal(error.code, 'REDIRECT_REJECTED');
      return true;
    },
  );
  const local = harness({ baseUrl: 'http://127.0.0.1:9999/v1/messages' });
  const result = await local.request({ model: 'm', messages: [] }, sseResponse([]));
  assert.equal(result.ok, true);
  assert.equal(local.seen[0].url, 'http://127.0.0.1:9999/v1/messages');
  assert.throws(
    () =>
      new ClaudeHttpTransport({
        fetch: async () => sseResponse([]),
        baseUrl: 'http://evil.test/v1/messages',
        resolveCredential: async (_i, u) => u(CREDENTIAL),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ClaudeHttpTransportError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('invalid inputs and credentials fail closed', async () => {
  const transport = new ClaudeHttpTransport({
    fetch: async () => sseResponse([]),
    resolveCredential: async (_input, useCredential) => useCredential({ ...CREDENTIAL, accessToken: '' }),
  });
  await assert.rejects(transport.send(baseRequest()), (error: unknown) => {
    assert.ok(error instanceof ClaudeHttpTransportError);
    assert.equal(error.code, 'CREDENTIAL_INVALID');
    return true;
  });
  await assert.rejects(transport.send(baseRequest({ body: 'not an object' })), (error: unknown) => {
    assert.ok(error instanceof ClaudeHttpTransportError);
    assert.equal(error.code, 'INVALID_INPUT');
    return true;
  });
  await assert.rejects(transport.send(baseRequest({ accountId: '' })), (error: unknown) => {
    assert.ok(error instanceof ClaudeHttpTransportError);
    assert.equal(error.code, 'INVALID_INPUT');
    return true;
  });
});

test('the metadata user id derives stably from (proxy key, account)', () => {
  assert.equal(claudeMetadataUserId('key-1', 'acct-1'), claudeMetadataUserId('key-1', 'acct-1'));
  assert.notEqual(claudeMetadataUserId('key-1', 'acct-1'), claudeMetadataUserId('key-2', 'acct-1'));
  assert.notEqual(claudeMetadataUserId('key-1', 'acct-1'), claudeMetadataUserId('key-1', 'acct-2'));
  assert.match(
    claudeMetadataUserId('key-1', 'acct-1'),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

/* ------------------------------------------------------------------ */
/* Prepared-evidence dispatch adapter (ClaudePreparedEvidenceTransport) */
/* ------------------------------------------------------------------ */

function evidenceRecord(payloadBytes: Uint8Array): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'ev-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'req-1',
    endpoint: 'claude-messages',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    payloadSha256: createHash('sha256').update(payloadBytes).digest('hex'),
    status: 'claimed',
    claimedAttemptId: 'attempt-1',
  } as unknown as PreparedRequestEvidenceRecord;
}

function evidenceTransportRequest(payloadBytes: Uint8Array): PreparedEvidenceTransportRequest {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    requestId: 'req-1',
    attemptId: 'attempt-1',
    fencingToken: 'fence-1',
    signal: new AbortController().signal,
    payloadBytes,
    evidence: evidenceRecord(payloadBytes),
  };
}

const MESSAGE_START_CHUNK =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":1}}}\n\n';
const MESSAGE_DELTA_CHUNK =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n';

test('prepared-evidence adapter rejects payload bytes that do not match the signed digest', async () => {
  const transport = new ClaudePreparedEvidenceTransport({
    fetch: async () => sseResponse([MESSAGE_START_CHUNK, MESSAGE_DELTA_CHUNK]),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ proxyKeyId: 'proxy-key-1' }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }));
  const request = evidenceTransportRequest(payloadBytes);
  (request.evidence as { payloadSha256: string }).payloadSha256 = createHash('sha256').update('tampered').digest('hex');
  await assert.rejects(
    () => transport.send(request),
    (error: unknown) => error instanceof ClaudeHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter rejects evidence that is not bound to the request attempt', async () => {
  const transport = new ClaudePreparedEvidenceTransport({
    fetch: async () => sseResponse([MESSAGE_START_CHUNK, MESSAGE_DELTA_CHUNK]),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ proxyKeyId: 'proxy-key-1' }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }));
  const request = evidenceTransportRequest(payloadBytes);
  (request.evidence as { status: string }).status = 'registered';
  await assert.rejects(
    () => transport.send(request),
    (error: unknown) => error instanceof ClaudeHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter requires a request context resolver', () => {
  assert.throws(
    () =>
      new ClaudePreparedEvidenceTransport({
        fetch: async () => sseResponse([]),
        resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
        resolveRequestContext: undefined as unknown as () => { readonly proxyKeyId: string | null },
      }),
    (error: unknown) => error instanceof ClaudeHttpTransportError && error.code === 'INVALID_INPUT',
  );
});

test('prepared-evidence adapter dispatches a bound request and exposes lazy usage', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const transport = new ClaudePreparedEvidenceTransport({
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return sseResponse([MESSAGE_START_CHUNK, MESSAGE_DELTA_CHUNK]);
    },
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ proxyKeyId: 'proxy-key-1', cliVersionOverride: null }),
  });
  const payload = { model: 'claude-sonnet-4-5-20250929', messages: [{ role: 'user', content: 'hi' }] };
  const response = await transport.send(evidenceTransportRequest(new TextEncoder().encode(JSON.stringify(payload))));
  assert.equal(response.resultHttpStatus, 200);
  assert.equal(response.responseStarted, false);
  assert.ok(response.body instanceof ReadableStream);
  // The signed payload bytes are relayed to the pinned endpoint unchanged.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, payload);
  // Usage is lazy: it resolves once the stream's terminal event is observed.
  const body = response.body;
  assert.ok(body instanceof ReadableStream);
  const reader = body.getReader();
  while (!(await reader.read()).done) {
    // drain
  }
  await new Promise((resolve) => setImmediate(resolve));
  const usage = response.providerUsage;
  assert.ok(usage !== null);
  assert.equal(usage.inputTotal, 150);
  assert.equal(usage.inputUncached, 100);
  assert.equal(usage.cacheRead, 50);
  assert.equal(usage.outputTotal, 42);
});

test('prepared-evidence adapter surfaces non-2xx results without a body stream', async () => {
  const transport = new ClaudePreparedEvidenceTransport({
    fetch: async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      }),
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ proxyKeyId: 'proxy-key-1' }),
  });
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }));
  const response = await transport.send(evidenceTransportRequest(payloadBytes));
  assert.equal(response.resultHttpStatus, 529);
  assert.equal(response.responseStarted, false);
  assert.equal(response.body, null);
});

test('a success response writes its quota snapshot through the throttled sink (R-dormant)', async () => {
  const h = harness();
  const resetAtMs = Date.now() + 2 * 60 * 60 * 1000;
  const result = await h.request(
    { model: 'm', messages: [] },
    sseResponse([], {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(resetAtMs / 1000)),
      'anthropic-ratelimit-unified-7d-utilization': '0.9',
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.quotaSnapshotWritten, true);
  assert.equal(h.quotaSnapshots.length, 1);
  assert.equal(h.quotaSnapshots[0]?.accountId, 'account-1');
  assert.equal(h.quotaSnapshots[0]?.fromStatus, 200);
  const fiveHour = h.quotaSnapshots[0]?.windows.find((window) => window.window === '5h');
  const sevenDay = h.quotaSnapshots[0]?.windows.find((window) => window.window === '7d');
  assert.ok(fiveHour !== undefined && sevenDay !== undefined);
  assert.equal(fiveHour.utilization, 0.42);
  assert.equal(sevenDay.utilization, 0.9);
  // Throttled per account: an immediate second success does not write again.
  await h.request(
    { model: 'm', messages: [] },
    sseResponse([], { 'anthropic-ratelimit-unified-5h-utilization': '0.5' }),
  );
  assert.equal(h.quotaSnapshots.length, 1);
  // A success response never triggers the 429 classification sink.
  assert.equal(h.rateLimits.length, 0);
});

test('a 429 with quota headers writes both sinks and the snapshot never suppresses the classification', async () => {
  const h = harness();
  const resetAtMs = Date.now() + 3 * 60 * 60 * 1000;
  // Prime the snapshot throttle with a success observation...
  await h.request(
    { model: 'm', messages: [] },
    sseResponse([], { 'anthropic-ratelimit-unified-5h-utilization': '0.42' }),
  );
  assert.equal(h.quotaSnapshots.length, 1);
  // ...then an immediate 429 must still reach the classification sink.
  await h.request(
    { model: 'm', messages: [] },
    new Response('rate limited', {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(resetAtMs / 1000)),
      },
    }),
  );
  assert.equal(h.rateLimits.length, 1);
  assert.equal(h.quotaSnapshots.length, 1);
});

test('a response without quota headers writes no snapshot', async () => {
  const h = harness();
  const result = await h.request({ model: 'm', messages: [] }, sseResponse([]));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.quotaSnapshotWritten, false);
  assert.equal(h.quotaSnapshots.length, 0);
});
