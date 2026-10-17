import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  EVENTSTREAM_CHUNK_EVENT,
  EVENTSTREAM_EVENT_TYPE_HEADER,
  encodeEventStreamFrame,
} from '../../../../src/saas/gateway/bedrock/eventstream.js';
import {
  type BedrockAccountHealthSink,
  BedrockHttpTransport,
  BedrockHttpTransportError,
  BedrockPreparedEvidenceTransport,
  type BedrockRateLimitSink,
  type BedrockTransportRequest,
  type BedrockUpstreamCredential,
  parseBedrockCredentialMaterial,
} from '../../../../src/saas/gateway/bedrock/transport.js';
import type { PreparedEvidenceTransportRequest } from '../../../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import type { PreparedRequestEvidenceRecord } from '../../../../src/saas/gateway/prepared-request-evidence-service.js';

const LOCAL_BASE = 'http://127.0.0.1:9999';
const CREDENTIAL: BedrockUpstreamCredential = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'IQoJb3JpZ2luX2VxEXAMPLE==',
  region: 'us-west-2',
};
const MODEL = 'us.anthropic.claude-sonnet-4-5-v1:0';

interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** One Bedrock EventStream chunk frame carrying the base64 event JSON. */
function chunkFrame(event: unknown): Uint8Array {
  return encodeEventStreamFrame({
    headers: [[EVENTSTREAM_EVENT_TYPE_HEADER, EVENTSTREAM_CHUNK_EVENT]],
    payload: Buffer.from(
      JSON.stringify({ bytes: Buffer.from(JSON.stringify(event), 'utf8').toString('base64') }),
      'utf8',
    ),
  });
}

function eventStreamResponse(frames: readonly Uint8Array[], headers: Record<string, string> = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(frame);
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'amzn-req-1', ...headers },
  });
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'amzn-req-2', ...headers },
  });
}

function anthropicBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

function baseRequest(overrides: Partial<BedrockTransportRequest> = {}): BedrockTransportRequest {
  return {
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    model: MODEL,
    body: anthropicBody(),
    stream: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

interface Harness {
  readonly seen: SeenRequest[];
  readonly rateLimits: Array<{ accountId: string; resetAtMs: number; fromStatus: number }>;
  readonly health: Array<{ accountId: string; kind: string; failover: boolean }>;
  request(overrides: Partial<BedrockTransportRequest>, response: Response): ReturnType<BedrockHttpTransport['send']>;
}

function harness(options: { credential?: BedrockUpstreamCredential } = {}): Harness {
  const seen: SeenRequest[] = [];
  const rateLimits: Array<{ accountId: string; resetAtMs: number; fromStatus: number }> = [];
  const health: Array<{ accountId: string; kind: string; failover: boolean }> = [];
  let nextResponse: Response = eventStreamResponse([]);
  const transport = new BedrockHttpTransport({
    fetch: async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      seen.push({ url, method: init.method ?? 'POST', headers, body: JSON.parse(String(init.body)) });
      return nextResponse;
    },
    baseUrl: LOCAL_BASE,
    resolveCredential: async (_input, useCredential) => useCredential(options.credential ?? CREDENTIAL),
    writeRateLimit: (async (record) => {
      rateLimits.push({
        accountId: record.accountId,
        resetAtMs: record.classification.resetAtMs,
        fromStatus: record.fromStatus,
      });
    }) as BedrockRateLimitSink,
    recordAccountHealth: (async (signal) => {
      health.push({ accountId: signal.accountId, kind: signal.classification.kind, failover: signal.failover });
    }) as BedrockAccountHealthSink,
    nowMs: () => Date.parse('2026-10-17T12:00:00Z'),
  });
  return {
    seen,
    rateLimits,
    health,
    request(overrides, response) {
      nextResponse = response;
      return transport.send(baseRequest(overrides));
    },
  };
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  assert.ok(stream !== null);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

test('the streaming request signs SigV4 over exactly the AWS header set and the transformed body', async () => {
  const h = harness();
  const result = await h.request({}, eventStreamResponse([chunkFrame({ type: 'message_stop' })]));
  assert.equal(result.ok, true);
  assert.equal(h.seen.length, 1);
  const seen = h.seen[0];
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, `${LOCAL_BASE}/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke-with-response-stream`);
  // The litellm lesson contract: only Content-Type/Accept plus the AWS
  // signed headers ever reach the wire.
  assert.deepEqual(Object.keys(seen.headers).sort(), [
    'accept',
    'authorization',
    'content-type',
    'host',
    'x-amz-content-sha256',
    'x-amz-date',
    'x-amz-security-token',
  ]);
  assert.match(
    seen.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261017\/us-west-2\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
  assert.equal(seen.headers.host, '127.0.0.1:9999');
  assert.equal(seen.headers['x-amz-date'], '20261017T120000Z');
  // Body transform: anthropic_version injected, model/stream removed.
  assert.equal((seen.body as Record<string, unknown>).anthropic_version, 'bedrock-2023-05-31');
  assert.equal('model' in (seen.body as Record<string, unknown>), false);
  assert.equal('stream' in (seen.body as Record<string, unknown>), false);
  // The payload hash matches the sent body.
  const bodyBytes = Buffer.from(JSON.stringify(seen.body), 'utf8');
  assert.equal(seen.headers['x-amz-content-sha256'], createHash('sha256').update(bodyBytes).digest('hex'));
});

test('EventStream chunks decode into Anthropic SSE with usage observed', async () => {
  const h = harness();
  const result = await h.request(
    {},
    eventStreamResponse([
      chunkFrame({
        type: 'message_start',
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 } },
      }),
      chunkFrame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
      chunkFrame({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        'amazon-bedrock-invocationMetrics': { inputTokenCount: 10, outputTokenCount: 30 },
      }),
      chunkFrame({ type: 'message_stop' }),
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = await readStream(result.body);
  const events = text
    .split('\n\n')
    .filter((block) => block !== '')
    .map((block) => {
      const lines = block.split('\n');
      return { event: lines[0].slice('event: '.length), data: JSON.parse(lines[1].slice('data: '.length)) };
    });
  assert.deepEqual(
    events.map((entry) => entry.event),
    ['message_start', 'content_block_delta', 'message_delta', 'message_stop'],
  );
  // The invocationMetrics bridge converted the camelCase metrics and
  // removed the Bedrock-specific field before the SSE re-emit.
  assert.deepEqual(events[2].data, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 10, output_tokens: 30 },
  });
  assert.equal('amazon-bedrock-invocationMetrics' in events[2].data, false);
  const usage = await result.usage;
  assert.deepEqual(usage, {
    inputTokens: 10,
    outputTokens: 30,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
  });
});

test('an exception frame mid-stream errors the relay with the upstream message', async () => {
  const h = harness();
  const result = await h.request(
    {},
    eventStreamResponse([
      chunkFrame({ type: 'message_start' }),
      encodeEventStreamFrame({
        headers: [
          [':message-type', 'exception'],
          [':exception-type', 'ThrottlingException'],
        ],
        payload: Buffer.from('{"message":"Too many invocations"}', 'utf8'),
      }),
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await assert.rejects(() => readStream(result.body), /ThrottlingException.*Too many invocations/);
});

test('the non-streaming path bridges the invocationMetrics in the response body', async () => {
  const h = harness();
  const result = await h.request(
    { stream: false, body: anthropicBody({ stream: false }) },
    jsonResponse({
      type: 'message',
      content: [{ type: 'text', text: '4' }],
      'amazon-bedrock-invocationMetrics': { inputTokenCount: 12, outputTokenCount: 5 },
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.headers['x-request-id'], 'amzn-req-2');
  assert.equal(result.headers['content-type'], 'application/json');
  const text = await readStream(result.body);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed.usage, { input_tokens: 12, output_tokens: 5 });
  assert.equal('amazon-bedrock-invocationMetrics' in parsed, false);
  const usage = await result.usage;
  assert.deepEqual(usage, { inputTokens: 12, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null });
  // The non-stream URL uses the invoke endpoint.
  assert.ok(h.seen[0].url.endsWith('/invoke'));
});

test('a ThrottlingException 429 classifies rate-limited, fails over and writes the cooldown sink', async () => {
  const h = harness();
  const result = await h.request(
    {},
    jsonResponse({ __type: 'ThrottlingException', message: 'Too many invocations' }, 429, { 'retry-after': '30' }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 429);
  assert.equal(result.classification.kind, 'rate-limited');
  assert.equal(result.failover, true);
  assert.equal(result.rateLimitWritten, true);
  assert.equal(h.rateLimits.length, 1);
  assert.equal(h.rateLimits[0].fromStatus, 429);
  assert.equal(h.rateLimits[0].resetAtMs, Date.parse('2026-10-17T12:00:30Z'));
  assert.deepEqual(h.health, [{ accountId: 'account-1', kind: 'rate-limited', failover: true }]);
  // The second throttling observation inside the throttle window is dropped.
  await h.request({ signal: new AbortController().signal }, jsonResponse({ __type: 'ThrottlingException' }, 429));
  assert.equal(h.rateLimits.length, 1);
});

test('a ValidationException 400 never fails over and writes no cooldown', async () => {
  const h = harness();
  const result = await h.request(
    {},
    jsonResponse({ __type: 'ValidationException', message: 'Extra inputs are not permitted' }, 400),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.classification.kind, 'request-error');
  assert.equal(result.failover, false);
  assert.equal(result.rateLimitWritten, false);
  assert.equal(h.rateLimits.length, 0);
  assert.deepEqual(h.health, [{ accountId: 'account-1', kind: 'request-error', failover: false }]);
});

test('a 401 fails over (static AWS keys have no refresh path)', async () => {
  const h = harness();
  const result = await h.request(
    {},
    jsonResponse(
      { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' },
      401,
    ),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.classification.kind, 'auth-revoked');
  assert.equal(result.failover, true);
});

test('bearer api-key credentials skip SigV4 and send the Bearer header', async () => {
  const h = harness({ credential: { apiKey: 'bedrock-bearer-key-000000', region: 'us-east-1' } });
  const result = await h.request(
    { model: 'anthropic.claude-sonnet-4-5-v1:0' },
    eventStreamResponse([chunkFrame({ type: 'message_stop' })]),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(h.seen[0].headers).sort(), ['accept', 'authorization', 'content-type', 'host']);
  assert.equal(h.seen[0].headers.authorization, 'Bearer bedrock-bearer-key-000000');
  assert.ok(h.seen[0].url.startsWith(`${LOCAL_BASE}/model/anthropic.claude-sonnet-4-5-v1%3A0/`));
});

test('a non-bedrock model id fails closed with UNSUPPORTED_MODEL', async () => {
  const h = harness();
  await assert.rejects(
    () => h.request({ model: 'claude-sonnet-4-5' }, eventStreamResponse([])),
    (error: unknown) => {
      assert.ok(error instanceof BedrockHttpTransportError);
      assert.equal(error.code, 'UNSUPPORTED_MODEL');
      return true;
    },
  );
  assert.equal(h.seen.length, 0);
});

test('parseBedrockCredentialMaterial accepts exactly one auth mode per envelope', () => {
  assert.deepEqual(
    parseBedrockCredentialMaterial({
      aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      aws_secret_access_key: 'secret',
      aws_session_token: 'tok',
      aws_region: 'us-west-2',
    }),
    {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'tok',
      region: 'us-west-2',
      forceGlobal: false,
    },
  );
  assert.deepEqual(parseBedrockCredentialMaterial({ api_key: 'bedrock-bearer-key', aws_region: 'us-east-1' }), {
    apiKey: 'bedrock-bearer-key',
    region: 'us-east-1',
    forceGlobal: false,
  });
  assert.equal(parseBedrockCredentialMaterial({ aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE' }), null);
  assert.equal(parseBedrockCredentialMaterial({}), null);
  assert.deepEqual(
    parseBedrockCredentialMaterial({ aws_access_key_id: 'a', aws_secret_access_key: 's', aws_force_global: 'true' }),
    { accessKeyId: 'a', secretAccessKey: 's', sessionToken: null, region: undefined, forceGlobal: true },
  );
});

function evidenceRecord(payloadSha256: string): PreparedRequestEvidenceRecord {
  return {
    evidenceId: 'ev-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    requestId: 'req-1',
    attemptId: 'att-1',
    attemptOrdinal: 1,
    supplyMode: 'platform',
    publicModel: 'bedrock/us.anthropic.claude-sonnet-4-5-v1:0',
    protocol: 'anthropic',
    endpoint: 'bedrock-invoke',
    providerProtocol: 'anthropic',
    upstreamId: 'up-1',
    accountId: 'account-1',
    credentialId: 'credential-1',
    credentialVersion: 'v1',
    routeTargetMode: 'platform-pool',
    payloadSha256,
    statementSha256: 's'.repeat(64),
    status: 'claimed',
    claimedAt: '2026-10-17T00:00:00Z',
    claimedAttemptId: 'att-1',
    expiresAt: '2026-10-17T01:00:00Z',
  } as unknown as PreparedRequestEvidenceRecord;
}

function adapterRequest(body: Record<string, unknown>): PreparedEvidenceTransportRequest {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  return {
    evidence: evidenceRecord(createHash('sha256').update(bytes).digest('hex')),
    attemptId: 'att-1',
    payloadBytes: bytes,
    signal: new AbortController().signal,
  } as unknown as PreparedEvidenceTransportRequest;
}

test('the prepared-evidence adapter resolves context, dispatches and exposes provider usage', async () => {
  const payload = anthropicBody({ stream: true });
  let sawEvidenceEndpoint: string | null = null;
  const adapter = new BedrockPreparedEvidenceTransport({
    fetch: async () =>
      eventStreamResponse([
        chunkFrame({ type: 'message_start', message: { usage: { input_tokens: 3 } } }),
        chunkFrame({ type: 'message_delta', usage: { output_tokens: 7 } }),
        chunkFrame({ type: 'message_stop' }),
      ]),
    baseUrl: LOCAL_BASE,
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: (evidence) => {
      sawEvidenceEndpoint = evidence.endpoint;
      return { model: evidence.publicModel, stream: true, betaHeader: null };
    },
  });
  const response = await adapter.send(adapterRequest(payload));
  assert.equal(response.responseStarted, false);
  assert.equal(response.resultHttpStatus, 200);
  assert.equal(response.upstreamErrorKind, undefined);
  assert.equal(sawEvidenceEndpoint, 'bedrock-invoke');
  // providerUsage settles lazily with the terminal stream usage.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(response.providerUsage !== null && response.providerUsage !== undefined);
  assert.equal(response.providerUsage?.inputTotal, 3);
  assert.equal(response.providerUsage?.outputTotal, 7);
  assert.equal(response.providerUsage?.status, 'reported');
  await readStream(response.body ?? null);
});

test('the prepared-evidence adapter rejects tampered payload bytes', async () => {
  const adapter = new BedrockPreparedEvidenceTransport({
    fetch: async () => eventStreamResponse([]),
    baseUrl: LOCAL_BASE,
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: MODEL, stream: false }),
  });
  const request = adapterRequest(anthropicBody());
  const tampered = {
    ...request,
    payloadBytes: Buffer.from('{"tampered":true}', 'utf8'),
  } as PreparedEvidenceTransportRequest;
  await assert.rejects(
    () => adapter.send(tampered),
    (error: unknown) => {
      assert.ok(error instanceof BedrockHttpTransportError);
      assert.equal(error.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('the prepared-evidence adapter maps upstream failures onto the dispatch result', async () => {
  const adapter = new BedrockPreparedEvidenceTransport({
    fetch: async () => jsonResponse({ __type: 'ThrottlingException' }, 429),
    baseUrl: LOCAL_BASE,
    resolveCredential: async (_input, useCredential) => useCredential(CREDENTIAL),
    resolveRequestContext: () => ({ model: MODEL, stream: true }),
  });
  const response = await adapter.send(adapterRequest(anthropicBody()));
  assert.equal(response.resultHttpStatus, 429);
  assert.equal(response.upstreamErrorKind, 'rate-limited');
  assert.equal(response.body, null);
});
